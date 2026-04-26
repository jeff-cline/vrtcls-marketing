import { ImapFlow } from 'imapflow';
import { query } from '../db.js';

// Pull the most-recent N messages from a mailbox's INBOX over IMAP and upsert
// each into inbox_messages. Idempotent — UNIQUE(mailbox_id, uid) blocks dupes.
// Returns { fetched, inserted }.
export async function syncMailboxInbox(mailbox, limit = 50) {
  const client = new ImapFlow({
    host: mailbox.imap_host || 'imap.gmail.com',
    port: mailbox.imap_port || 993,
    secure: mailbox.imap_secure !== false,
    auth: { user: mailbox.smtp_user, pass: mailbox.smtp_pass },
    logger: false,
  });

  let fetched = 0;
  let inserted = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, uidNext: true });
      const total = status.messages || 0;
      if (total === 0) return { fetched: 0, inserted: 0 };

      // Fetch the last `limit` messages by sequence range.
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
        source: true,
        flags: true,
      })) {
        fetched++;
        const env = msg.envelope || {};
        const fromAddr = env.from?.[0]?.address || null;
        const fromName = env.from?.[0]?.name || null;
        const toAddrs  = (env.to || []).map((t) => t.address).filter(Boolean).join(', ') || null;
        const subject  = env.subject || null;
        const messageId = env.messageId || null;
        const inReplyTo = env.inReplyTo || null;
        const received  = msg.internalDate ? new Date(msg.internalDate) : new Date();

        const { bodyText, bodyHtml } = await extractBody(client, msg.uid);
        const snippet = (bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const isRead  = (msg.flags || new Set()).has('\\Seen');

        const result = await query(
          `INSERT INTO inbox_messages
             (mailbox_id, uid, message_id, in_reply_to, thread_id,
              from_address, from_name, to_addresses, subject, snippet,
              body_text, body_html, received_at, read_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (mailbox_id, uid) DO NOTHING`,
          [
            mailbox.id, msg.uid, messageId, inReplyTo, inReplyTo || messageId,
            fromAddr, fromName, toAddrs, subject, snippet,
            bodyText, bodyHtml, received,
            isRead ? new Date() : null,
          ]
        );
        if (result.rowCount > 0) inserted++;
      }

      await query(
        `UPDATE mailboxes SET inbox_last_synced = NOW(), inbox_last_uid = $1 WHERE id = $2`,
        [status.uidNext - 1, mailbox.id]
      );
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { fetched, inserted };
}

async function extractBody(client, uid) {
  // Pull the first text/plain and text/html parts. Cheap heuristic that works
  // for almost every real email.
  let bodyText = null;
  let bodyHtml = null;
  try {
    const textRes = await client.fetchOne(uid, { bodyParts: ['1'], source: true }, { uid: true });
    if (textRes?.source) {
      const raw = textRes.source.toString('utf-8');
      const match = raw.match(/\r?\n\r?\n([\s\S]+)$/);
      if (match) bodyText = match[1].slice(0, 50000);
    }
  } catch {}
  try {
    const part = await client.download(uid, undefined, { uid: true });
    if (part?.content) {
      const chunks = [];
      for await (const chunk of part.content) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf-8');
      // crude split on first blank line
      const i = raw.indexOf('\r\n\r\n');
      if (i > -1) {
        const body = raw.slice(i + 4);
        if (/<html|<body|<p[ >]/i.test(body)) bodyHtml = body.slice(0, 100000);
        if (!bodyText) bodyText = body.replace(/<[^>]+>/g, '').slice(0, 50000);
      }
    }
  } catch {}
  return { bodyText, bodyHtml };
}

// Mark a message read both in our DB and on the IMAP server.
export async function markMessageRead(mailbox, messageId) {
  const { rows } = await query(
    `SELECT uid FROM inbox_messages WHERE id=$1 AND mailbox_id=$2`,
    [messageId, mailbox.id]
  );
  if (!rows[0]) return;
  await query(`UPDATE inbox_messages SET read_at = COALESCE(read_at, NOW()) WHERE id = $1`, [messageId]);

  const client = new ImapFlow({
    host: mailbox.imap_host || 'imap.gmail.com',
    port: mailbox.imap_port || 993,
    secure: mailbox.imap_secure !== false,
    auth: { user: mailbox.smtp_user, pass: mailbox.smtp_pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(rows[0].uid, ['\\Seen'], { uid: true });
    } finally { lock.release(); }
  } catch (err) {
    console.warn(`[imap] markRead failed:`, err.message);
  } finally {
    await client.logout().catch(() => {});
  }
}
