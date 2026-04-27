import { query, tx } from '../db.js';
import { config } from '../config.js';
import { Resend } from 'resend';
import { renderEmail } from './email.js';
import { sendViaMailbox, isMailboxAvailable } from './smtpSender.js';
import { consumeToken } from './credits.js';

const resend = config.email.resendKey ? new Resend(config.email.resendKey) : null;

// Pacing window is interpreted in this timezone. Server is UTC in prod; without
// this, "9-18" meant 4am-1pm Central and evening sends got punted to tomorrow.
const SEND_TZ = process.env.SEND_TZ || 'America/Chicago';

// Round-robin across mailboxes, then spread within each mailbox's daily quota
// across the sender-time window. Returns the array we wrote (so the UI can
// preview projected timestamps before launch).
//
// `immediate=true` bypasses pacing and fires everything within the next minute
// (8s gaps + 4s jitter so SMTP doesn't choke). Used for test sends and small
// admin pushes where pacing would feel broken.
export async function enqueueCampaignSends({ campaign, leadIds, mailboxes, userId, immediate = false }) {
  if (mailboxes.length === 0) throw new Error('no mailboxes available');
  const buckets = mailboxes.map(() => []);
  leadIds.forEach((leadId, i) => {
    buckets[i % mailboxes.length].push(leadId);
  });

  const rows = [];
  for (let mi = 0; mi < mailboxes.length; mi++) {
    const mb = mailboxes[mi];
    const leads = buckets[mi];
    let times;
    if (immediate) {
      const start = Date.now();
      times = leads.map((_, i) => new Date(start + i * 8_000 + Math.random() * 4_000));
    } else {
      times = computeSendTimes({
        n: leads.length,
        perDay: campaign.sends_per_persona_per_day,
        startHour: campaign.send_window_start_hour,
        endHour: campaign.send_window_end_hour,
      });
    }
    for (let li = 0; li < leads.length; li++) {
      rows.push({
        leadId: leads[li],
        mailboxId: mb.id,
        personaId: mb.persona_id,
        scheduledFor: times[li],
      });
    }
  }

  // Bulk insert as 'queued'. No token consumption yet — that happens on dispatch
  // so canceled sends don't burn the user's tokens.
  await tx(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO sends (campaign_id, user_id, lead_id, mailbox_id, persona_id, status, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
        [campaign.id, userId, r.leadId, r.mailboxId, r.personaId, r.scheduledFor]
      );
    }
  });

  return rows;
}

// Returns the UTC Date corresponding to `hour:00:00` on the local-day-of refDate
// in `tz`. Uses Intl to find the tz's UTC offset at that moment (handles DST).
function zonedDateAtHour(refDate, tz, hour) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(refDate); // "YYYY-MM-DD"
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const offsetMin = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60_000);
}

// Minutes east of UTC for `tz` at the given moment (CDT = -300, CST = -360).
function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const asIfUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return (asIfUtc - date.getTime()) / 60_000;
}

function computeSendTimes({ n, perDay, startHour, endHour }) {
  const times = [];
  if (n === 0) return times;
  const now = new Date();

  // Today's window in SEND_TZ. If we're past today's end, advance to tomorrow.
  let dayRef = new Date(now);
  let dayStart = zonedDateAtHour(dayRef, SEND_TZ, startHour);
  let dayEnd   = zonedDateAtHour(dayRef, SEND_TZ, endHour);
  if (now >= dayEnd) {
    dayRef = new Date(now.getTime() + 86_400_000);
    dayStart = zonedDateAtHour(dayRef, SEND_TZ, startHour);
    dayEnd   = zonedDateAtHour(dayRef, SEND_TZ, endHour);
  }
  let cur = now > dayStart ? new Date(now) : new Date(dayStart);

  while (times.length < n) {
    const winMs = dayEnd - dayStart;
    const intervalMs = winMs / perDay;
    let firstSlot = 0;
    if (cur > dayStart) firstSlot = Math.ceil((cur - dayStart) / intervalMs);
    for (let s = firstSlot; s < perDay && times.length < n; s++) {
      const slotTime = new Date(dayStart.getTime() + s * intervalMs);
      const jitter = (Math.random() - 0.5) * 180_000; // ±90s
      times.push(new Date(slotTime.getTime() + jitter));
    }
    dayRef = new Date(dayRef.getTime() + 86_400_000);
    dayStart = zonedDateAtHour(dayRef, SEND_TZ, startHour);
    dayEnd   = zonedDateAtHour(dayRef, SEND_TZ, endHour);
    cur = new Date(dayStart);
  }
  return times.slice(0, n);
}

// Worker tick. Pull queued+due rows whose campaign has been launched, mark them
// 'sending', then dispatch each. SKIP LOCKED keeps multiple instances safe even
// though we only run one today.
let tickInFlight = false;
export async function processQueueTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const { rows } = await query(`
      UPDATE sends
         SET status = 'sending'
       WHERE id IN (
         SELECT s.id
           FROM sends s
           JOIN campaigns c ON c.id = s.campaign_id
           JOIN mailboxes m ON m.id = s.mailbox_id
          WHERE s.status = 'queued'
            AND s.scheduled_for <= NOW()
            AND c.status = 'sending'
            AND m.status = 'active'
          ORDER BY s.scheduled_for ASC
          LIMIT 25
          FOR UPDATE OF s SKIP LOCKED
       )
       RETURNING *
    `);
    for (const sendRow of rows) {
      try {
        await dispatchSend(sendRow);
      } catch (err) {
        console.error(`[queue] send ${sendRow.id} failed:`, err.message || err);
      }
    }

    // Auto-finalize campaigns once every send has resolved.
    await query(`
      UPDATE campaigns SET status = 'sent'
       WHERE status = 'sending'
         AND NOT EXISTS (
           SELECT 1 FROM sends s
            WHERE s.campaign_id = campaigns.id
              AND s.status IN ('queued','sending')
         )
    `);
  } finally {
    tickInFlight = false;
  }
}

async function dispatchSend(sendRow) {
  // Pull all the joined context in one query.
  const { rows: ctx } = await query(
    `SELECT
        s.id          AS send_id,
        s.lead_id,
        s.user_id,
        s.campaign_id,
        c.template_id,
        c.cta_label, c.cta_url,
        l.email, l.first_name, l.last_name, l.address, l.dnc,
        m.id          AS mailbox_id,
        m.smtp_user, m.smtp_pass, m.smtp_host, m.smtp_port, m.smtp_secure,
        m.daily_cap, m.sends_today, m.last_send_at, m.status AS mailbox_status,
        p.display_name AS persona_name,
        p.title        AS persona_title,
        p.signature_html AS persona_signature
       FROM sends s
       JOIN leads l       ON l.id = s.lead_id
       JOIN campaigns c   ON c.id = s.campaign_id
       LEFT JOIN mailboxes m ON m.id = s.mailbox_id
       LEFT JOIN personas p  ON p.id = s.persona_id
      WHERE s.id = $1`,
    [sendRow.id]
  );
  const r = ctx[0];
  if (!r) return;

  if (!r.email || r.dnc) {
    return finalize(sendRow.id, 'skipped', 'no-email-or-dnc');
  }

  const { rows: supp } = await query('SELECT 1 FROM suppressions WHERE email = LOWER($1) LIMIT 1', [r.email]);
  if (supp.length) return finalize(sendRow.id, 'suppressed', 'on suppression list');

  const { rows: tplRows } = await query('SELECT * FROM email_templates WHERE id=$1', [r.template_id]);
  const template = tplRows[0];
  if (!template) return finalize(sendRow.id, 'failed', 'template not found');

  // SMTP path — preferred when a mailbox is wired in.
  if (r.mailbox_id) {
    const mailbox = {
      id: r.mailbox_id,
      smtp_user: r.smtp_user, smtp_pass: r.smtp_pass,
      smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_secure: r.smtp_secure,
      daily_cap: r.daily_cap, sends_today: r.sends_today,
      last_send_at: r.last_send_at, status: r.mailbox_status,
      persona_name: r.persona_name,
    };
    const avail = await isMailboxAvailable(mailbox);
    if (!avail.ok) {
      // Push by 1 hour and re-queue. Don't fail.
      await query(
        `UPDATE sends SET status='queued', scheduled_for = NOW() + interval '1 hour' WHERE id=$1`,
        [sendRow.id]
      );
      return;
    }
    try {
      await tx((client) => consumeToken(r.user_id, `send:${r.campaign_id}`, r.campaign_id, client));
    } catch (err) {
      return finalize(sendRow.id, 'failed', `token: ${err.message || err}`);
    }
    const { subject, html } = await renderEmail({
      template,
      lead: { email: r.email, first_name: r.first_name, last_name: r.last_name, address: r.address },
      sendId: sendRow.id,
      persona: { display_name: r.persona_name, title: r.persona_title, signature_html: r.persona_signature },
      ctaOverride: { label: r.cta_label || null, url: r.cta_url || null },
    });
    try {
      const result = await sendViaMailbox({ mailbox, to: r.email, subject, html });
      await query(
        `UPDATE sends SET status='sent', sent_at=NOW(), provider_id=$1 WHERE id=$2`,
        [result.id || null, sendRow.id]
      );
    } catch (err) {
      await query(`UPDATE sends SET status='failed', error=$1 WHERE id=$2`,
        [String(err.message || err), sendRow.id]);
    }
    return;
  }

  // Fallback — Resend transactional From. Used if no mailboxes provisioned.
  try {
    await tx((client) => consumeToken(r.user_id, `send:${r.campaign_id}`, r.campaign_id, client));
  } catch (err) {
    return finalize(sendRow.id, 'failed', `token: ${err.message || err}`);
  }
  const { subject, html } = await renderEmail({
    template,
    lead: { email: r.email, first_name: r.first_name, last_name: r.last_name, address: r.address },
    sendId: sendRow.id,
    persona: null,
    ctaOverride: { label: r.cta_label || null, url: r.cta_url || null },
  });
  if (!resend) {
    await query(
      `UPDATE sends SET status='sent', sent_at=NOW(), provider_id='dev-mode' WHERE id=$1`,
      [sendRow.id]
    );
    return;
  }
  try {
    const resp = await resend.emails.send({
      from: config.email.from, to: r.email, reply_to: config.email.replyTo, subject, html,
    });
    await query(
      `UPDATE sends SET status='sent', sent_at=NOW(), provider_id=$1 WHERE id=$2`,
      [resp.data?.id || null, sendRow.id]
    );
  } catch (err) {
    await query(`UPDATE sends SET status='failed', error=$1 WHERE id=$2`,
      [String(err.message || err), sendRow.id]);
  }
}

async function finalize(sendId, status, msg) {
  await query(`UPDATE sends SET status=$1, error=$2 WHERE id=$3`, [status, msg, sendId]);
}

let workerTimer = null;
export function startQueueWorker(intervalMs = 30_000) {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processQueueTick().catch((err) => console.error('[queue] tick error:', err));
  }, intervalMs);
  // Run one tick on boot so freshly-due rows fire fast in dev.
  setTimeout(() => processQueueTick().catch(() => {}), 1000);
}
