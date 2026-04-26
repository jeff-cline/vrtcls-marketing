import { Resend } from 'resend';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { substitute, rewriteLinks, injectPixel, canSpamFooter } from './templates.js';
import { consumeToken } from './credits.js';
import { pickMailbox, isMailboxAvailable, sendViaMailbox } from './smtpSender.js';

const resend = config.email.resendKey ? new Resend(config.email.resendKey) : null;

// Plain transactional send — for admin pings and customer "your leads are ready"
// notifications. No tracking pixels, no link rewriting, no CAN-SPAM footer
// (these are 1:1 service emails, not marketing).
export async function sendTransactional({ to, subject, html, text }) {
  if (!to) return { skipped: 'no_recipient' };
  if (!resend) {
    console.log(`[email:dev] would send "${subject}" to ${to}`);
    return { dev: true };
  }
  try {
    const resp = await resend.emails.send({
      from: config.email.from,
      to,
      reply_to: config.email.replyTo,
      subject,
      html: html || `<pre>${text || ''}</pre>`,
      text: text || undefined,
    });
    return { id: resp.data?.id || null };
  } catch (err) {
    console.warn(`[email] transactional send failed for ${to}: ${err.message || err}`);
    return { error: String(err.message || err) };
  }
}

export function buildPersonaVars(persona) {
  if (!persona) return { persona_name: '', persona_signature: '', persona_title: '' };
  return {
    persona_name: persona.display_name || persona.persona_name || '',
    persona_title: persona.title || '',
    persona_signature: persona.signature_html || persona.persona_signature || '',
  };
}

export async function renderEmail({ template, lead, sendId, persona, sampleMode = false }) {
  const personaVars = buildPersonaVars(persona);
  const vars = {
    first_name: lead.first_name || 'there',
    last_name: lead.last_name || '',
    city: lead.address?.city || '',
    state: lead.address?.state || '',
    zip: lead.address?.zip || '',
    topic: template.topic_label || 'this',
    ...personaVars,
  };
  const subject = substitute(template.subject, vars);
  let html = substitute(template.body_html, vars);

  if (sampleMode) {
    const previewBanner = `
      <div style="background:#fff7d6;border:1px solid #f0c000;color:#5a4500;padding:8px 12px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12px;border-radius:4px;margin-bottom:12px;">
        Test send — link tracking and unsubscribe footer disabled. Recipient was you.
      </div>`;
    return { subject: `[TEST] ${subject}`, html: previewBanner + html };
  }

  const unsub = `${config.baseUrl}/u/${sendId}`;
  html = html + canSpamFooter(config.companyAddress, unsub);
  html = rewriteLinks(html, { sendId, baseUrl: config.baseUrl });
  html = injectPixel(html, { sendId, baseUrl: config.baseUrl });
  return { subject, html };
}

async function isSuppressed(emailAddr) {
  if (!emailAddr) return false;
  const { rows } = await query(
    'SELECT 1 FROM suppressions WHERE email = LOWER($1) LIMIT 1',
    [emailAddr]
  );
  return rows.length > 0;
}

export async function sendOne({ userId, campaignId, leadId, templateId, mailboxId }) {
  const { rows: leadRows } = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead || !lead.email) throw new Error('Lead has no email');
  if (lead.dnc) throw new Error('Lead is DNC');
  if (await isSuppressed(lead.email)) throw new Error('Recipient suppressed');

  const { rows: tplRows } = await query('SELECT * FROM email_templates WHERE id = $1', [templateId]);
  const template = tplRows[0];
  if (!template) throw new Error('Template not found');

  let mailbox = null;
  if (mailboxId) {
    mailbox = await pickMailbox({ mailboxId });
    if (!mailbox) throw new Error('Mailbox not found');
  } else {
    mailbox = await pickMailbox({ userId });
  }

  if (mailbox) {
    const avail = await isMailboxAvailable(mailbox);
    if (!avail.ok) {
      const err = new Error(avail.reason);
      err.code = avail.reason;
      throw err;
    }
  }

  const sendRow = await tx(async (client) => {
    await consumeToken(userId, `send:${campaignId}`, campaignId, client);
    const { rows } = await client.query(
      `INSERT INTO sends (campaign_id, user_id, lead_id, status, mailbox_id, persona_id)
       VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING *`,
      [campaignId, userId, leadId, mailbox?.id || null, mailbox?.persona_id || null]
    );
    return rows[0];
  });

  const { subject, html } = await renderEmail({
    template,
    lead,
    sendId: sendRow.id,
    persona: mailbox ? { display_name: mailbox.persona_name, signature_html: mailbox.persona_signature } : null,
  });

  // SMTP path — preferred when a mailbox is configured.
  if (mailbox) {
    try {
      const result = await sendViaMailbox({
        mailbox,
        to: lead.email,
        subject,
        html,
      });
      await query(
        `UPDATE sends SET status='sent', sent_at=NOW(), provider_id=$1 WHERE id=$2`,
        [result.id || null, sendRow.id]
      );
      return { id: sendRow.id, providerId: result.id, channel: 'smtp' };
    } catch (err) {
      await query(
        `UPDATE sends SET status='failed', error=$1 WHERE id=$2`,
        [String(err.message || err), sendRow.id]
      );
      throw err;
    }
  }

  // Fallback — Resend with global From. Used if no mailboxes configured.
  if (!resend) {
    await query(
      `UPDATE sends SET status='sent', sent_at=NOW(), provider_id='dev-mode' WHERE id=$1`,
      [sendRow.id]
    );
    return { id: sendRow.id, dev: true, subject };
  }

  try {
    const resp = await resend.emails.send({
      from: config.email.from,
      to: lead.email,
      reply_to: config.email.replyTo,
      subject,
      html,
    });
    await query(
      `UPDATE sends SET status='sent', sent_at=NOW(), provider_id=$1 WHERE id=$2`,
      [resp.data?.id || null, sendRow.id]
    );
    return { id: sendRow.id, providerId: resp.data?.id, channel: 'resend' };
  } catch (err) {
    await query(
      `UPDATE sends SET status='failed', error=$1 WHERE id=$2`,
      [String(err.message || err), sendRow.id]
    );
    throw err;
  }
}

// Send a non-tracked test render to a single recipient — used by /app/templates/:id/send-test.
export async function sendTestToSelf({ userId, templateId, mailboxId, recipient }) {
  const { rows: tplRows } = await query('SELECT * FROM email_templates WHERE id = $1', [templateId]);
  const template = tplRows[0];
  if (!template) throw new Error('Template not found');

  const fakeLead = {
    first_name: 'there',
    last_name: '',
    address: { city: 'Austin', state: 'TX', zip: '78701' },
    email: recipient,
  };

  const mailbox = mailboxId
    ? await pickMailbox({ mailboxId })
    : await pickMailbox({ userId });

  const { subject, html } = await renderEmail({
    template,
    lead: fakeLead,
    sendId: 0,
    persona: mailbox ? { display_name: mailbox.persona_name, signature_html: mailbox.persona_signature } : null,
    sampleMode: true,
  });

  if (mailbox) {
    return await sendViaMailbox({ mailbox, to: recipient, subject, html });
  }
  if (!resend) {
    console.log(`[email:dev] test send "${subject}" to ${recipient}`);
    return { dev: true };
  }
  const resp = await resend.emails.send({
    from: config.email.from,
    to: recipient,
    reply_to: config.email.replyTo,
    subject,
    html,
  });
  return { id: resp.data?.id || null };
}
