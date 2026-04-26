import { Resend } from 'resend';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { substitute, rewriteLinks, injectPixel, canSpamFooter } from './templates.js';
import { consumeToken } from './credits.js';

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

export async function renderEmail({ template, lead, sendId }) {
  const vars = {
    first_name: lead.first_name || 'there',
    last_name: lead.last_name || '',
    city: lead.address?.city || '',
    state: lead.address?.state || '',
    zip: lead.address?.zip || '',
    topic: template.topic_label || 'this',
  };
  const subject = substitute(template.subject, vars);
  let html = substitute(template.body_html, vars);
  const unsub = `${config.baseUrl}/u/${sendId}`;
  html = html + canSpamFooter(config.companyAddress, unsub);
  html = rewriteLinks(html, { sendId, baseUrl: config.baseUrl });
  html = injectPixel(html, { sendId, baseUrl: config.baseUrl });
  return { subject, html };
}

export async function sendOne({ userId, campaignId, leadId, templateId }) {
  const { rows: leadRows } = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead || !lead.email) throw new Error('Lead has no email');

  const { rows: tplRows } = await query('SELECT * FROM email_templates WHERE id = $1', [templateId]);
  const template = tplRows[0];
  if (!template) throw new Error('Template not found');

  const sendRow = await tx(async (client) => {
    await consumeToken(userId, `send:${campaignId}`, campaignId, client);
    const { rows } = await client.query(
      `INSERT INTO sends (campaign_id, user_id, lead_id, status)
       VALUES ($1, $2, $3, 'queued') RETURNING *`,
      [campaignId, userId, leadId]
    );
    return rows[0];
  });

  const { subject, html } = await renderEmail({ template, lead, sendId: sendRow.id });

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
    return { id: sendRow.id, providerId: resp.data?.id };
  } catch (err) {
    await query(
      `UPDATE sends SET status='failed', error=$1 WHERE id=$2`,
      [String(err.message || err), sendRow.id]
    );
    throw err;
  }
}
