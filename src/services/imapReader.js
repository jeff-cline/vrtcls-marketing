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
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
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

      // Collect raw envelopes/sources first — running nested IMAP calls
      // (fetchOne/download) inside the for-await below would deadlock on
      // the same connection.
      const collected = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        internalDate: true,
        source: true,
        flags: true,
      })) {
        collected.push({
          uid: msg.uid,
          envelope: msg.envelope || {},
          internalDate: msg.internalDate,
          flags: msg.flags || new Set(),
          source: msg.source ? Buffer.from(msg.source).toString('utf-8') : '',
        });
      }

      for (const msg of collected) {
        fetched++;
        const env = msg.envelope;
        const fromAddr = env.from?.[0]?.address || null;
        const fromName = env.from?.[0]?.name || null;
        const toAddrs  = (env.to || []).map((t) => t.address).filter(Boolean).join(', ') || null;
        const subject  = env.subject || null;
        const messageId = env.messageId || null;
        const inReplyTo = env.inReplyTo || null;
        const received  = msg.internalDate ? new Date(msg.internalDate) : new Date();

        const { bodyText: rawText, bodyHtml: rawHtml } = parseBody(msg.source);
        const bodyText = stripNul(rawText);
        const bodyHtml = stripNul(rawHtml);
        const snippet = (bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const isRead  = msg.flags.has('\\Seen');

        const result = await query(
          `INSERT INTO inbox_messages
             (mailbox_id, uid, message_id, in_reply_to, thread_id,
              from_address, from_name, to_addresses, subject, snippet,
              body_text, body_html, received_at, read_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (mailbox_id, uid) DO NOTHING`,
          [
            mailbox.id, msg.uid,
            stripNul(messageId), stripNul(inReplyTo), stripNul(inReplyTo || messageId),
            stripNul(fromAddr), stripNul(fromName), stripNul(toAddrs),
            stripNul(subject), stripNul(snippet),
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

function stripNul(s) {
  if (s == null) return s;
  return String(s).replace(/\u0000/g, '');
}

// Parse the RFC822 source already retrieved in the outer fetch. No IMAP
// roundtrips here, so this can't deadlock the connection.
function parseBody(raw) {
  if (!raw) return { bodyText: null, bodyHtml: null };
  const splitIdx = raw.indexOf('\r\n\r\n');
  if (splitIdx < 0) return { bodyText: null, bodyHtml: null };
  const headers = raw.slice(0, splitIdx);
  const body = raw.slice(splitIdx + 4);

  const ct = (headers.match(/^content-type:\s*([^\r\n]+)/im) || [])[1] || '';
  const boundaryMatch = ct.match(/boundary="?([^";\r\n]+)"?/i);

  let bodyText = null, bodyHtml = null;

  if (boundaryMatch) {
    const boundary = '--' + boundaryMatch[1];
    const parts = body.split(boundary);
    for (const part of parts) {
      const i = part.indexOf('\r\n\r\n');
      if (i < 0) continue;
      const partHeaders = part.slice(0, i);
      const partBody = part.slice(i + 4);
      const partCt = (partHeaders.match(/^content-type:\s*([^\r\n;]+)/im) || [])[1] || '';
      const enc = (partHeaders.match(/^content-transfer-encoding:\s*([^\r\n]+)/im) || [])[1] || '';
      const decoded = decodePart(partBody, enc.toLowerCase().trim());
      if (/^text\/html/i.test(partCt) && !bodyHtml) bodyHtml = decoded.slice(0, 100000);
      else if (/^text\/plain/i.test(partCt) && !bodyText) bodyText = decoded.slice(0, 50000);
    }
  } else {
    const enc = (headers.match(/^content-transfer-encoding:\s*([^\r\n]+)/im) || [])[1] || '';
    const decoded = decodePart(body, enc.toLowerCase().trim());
    if (/text\/html/i.test(ct)) bodyHtml = decoded.slice(0, 100000);
    bodyText = decoded.replace(/<[^>]+>/g, '').slice(0, 50000);
  }

  if (!bodyText && bodyHtml) bodyText = bodyHtml.replace(/<[^>]+>/g, '').slice(0, 50000);
  return { bodyText, bodyHtml };
}

function decodePart(body, enc) {
  if (enc === 'base64') {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8'); }
    catch { return body; }
  }
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
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
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
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
