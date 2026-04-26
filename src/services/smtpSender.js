import nodemailer from 'nodemailer';
import { query } from '../db.js';

const transports = new Map();

function getTransport(mailbox) {
  const key = `${mailbox.id}:${mailbox.smtp_host}:${mailbox.smtp_port}:${mailbox.smtp_user}`;
  if (transports.has(key)) return transports.get(key);
  const t = nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: !!mailbox.smtp_secure,
    auth: { user: mailbox.smtp_user, pass: mailbox.smtp_pass },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });
  transports.set(key, t);
  return t;
}

export function clearTransport(mailboxId) {
  for (const [k, t] of transports) {
    if (k.startsWith(`${mailboxId}:`)) {
      try { t.close(); } catch {}
      transports.delete(k);
    }
  }
}

function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export async function pickMailbox({ userId, mailboxId } = {}) {
  if (mailboxId) {
    const { rows } = await query(
      `SELECT m.*, p.display_name AS persona_name, p.signature_html AS persona_signature
       FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
       WHERE m.id = $1`,
      [mailboxId]
    );
    return rows[0] || null;
  }
  if (!userId) return null;
  const { rows } = await query(
    `SELECT m.*, p.display_name AS persona_name, p.signature_html AS persona_signature
     FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
     WHERE m.owner_user_id = $1 AND m.status = 'active'
     ORDER BY COALESCE(m.last_send_at, '1970-01-01') ASC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function isMailboxAvailable(mailbox) {
  if (mailbox.status !== 'active') return { ok: false, reason: 'mailbox_inactive' };
  const today = utcDateStr();
  const lastDay = mailbox.last_send_at ? utcDateStr(new Date(mailbox.last_send_at)) : null;
  const sentToday = lastDay === today ? mailbox.sends_today : 0;
  if (sentToday >= mailbox.daily_cap) {
    return { ok: false, reason: 'daily_cap_reached' };
  }
  return { ok: true, sentToday };
}

async function bumpDailyCount(mailboxId) {
  const today = utcDateStr();
  await query(
    `UPDATE mailboxes
       SET sends_today = CASE
             WHEN last_send_at IS NULL OR to_char(last_send_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') <> $2
               THEN 1
             ELSE sends_today + 1
           END,
           last_send_at = NOW()
     WHERE id = $1`,
    [mailboxId, today]
  );
}

export async function sendViaMailbox({ mailbox, to, subject, html, text, replyTo, headers }) {
  const transport = getTransport(mailbox);
  const fromName = mailbox.persona_name || mailbox.label || 'vrtcls';
  const from = `"${fromName.replace(/"/g, '')}" <${mailbox.smtp_user}>`;
  const info = await transport.sendMail({
    from,
    to,
    subject,
    html,
    text: text || undefined,
    replyTo: replyTo || mailbox.smtp_user,
    headers: headers || undefined,
  });
  await bumpDailyCount(mailbox.id);
  return { id: info.messageId };
}

export async function verifyMailbox(mailbox) {
  const transport = getTransport(mailbox);
  await transport.verify();
}
