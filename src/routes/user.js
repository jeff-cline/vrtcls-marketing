import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { priceForAge, TIERS, TOKENS_PER_LEAD } from '../services/pricing.js';
import { purchaseLead } from '../services/credits.js';
import { sendOne } from '../services/email.js';

export default async function userRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/app', async (req, reply) => {
    const { rows: purchases } = await query(
      'SELECT COUNT(*)::int AS n FROM lead_purchases WHERE user_id = $1',
      [req.user.id]
    );
    const { rows: sends } = await query(
      'SELECT COUNT(*)::int AS n FROM sends WHERE user_id = $1 AND status = $2',
      [req.user.id, 'sent']
    );
    const { rows: clicks } = await query(
      `SELECT COUNT(*)::int AS n FROM click_events c
       JOIN sends s ON s.id = c.send_id
       WHERE s.user_id = $1`,
      [req.user.id]
    );
    return reply.view('user/dashboard', {
      user: req.user,
      stats: { purchases: purchases[0].n, sends: sends[0].n, clicks: clicks[0].n },
      tiers: TIERS,
      tokensPerLead: TOKENS_PER_LEAD,
    });
  });

  app.get('/app/leads', async (req, reply) => {
    const { rows } = await query(
      `SELECT l.*
       FROM leads l
       WHERE l.dnc = FALSE
         AND l.email IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM lead_purchases lp WHERE lp.user_id = $1 AND lp.lead_id = l.id)
       ORDER BY l.first_seen DESC
       LIMIT 50`,
      [req.user.id]
    );
    const priced = rows.map((lead) => ({ lead, tier: priceForAge(lead.first_seen) }));
    return reply.view('user/leads_market', { user: req.user, leads: priced });
  });

  app.post('/app/leads/:id/buy', async (req, reply) => {
    try {
      const result = await purchaseLead(req.user.id, Number(req.params.id));
      return reply.redirect('/app/my-leads?bought=' + req.params.id);
    } catch (err) {
      return reply.redirect('/app/leads?error=' + encodeURIComponent(err.code || err.message));
    }
  });

  app.get('/app/my-leads', async (req, reply) => {
    const { rows } = await query(
      `SELECT lp.*, l.first_name, l.last_name, l.email, l.address
       FROM lead_purchases lp
       JOIN leads l ON l.id = lp.lead_id
       WHERE lp.user_id = $1
       ORDER BY lp.created_at DESC`,
      [req.user.id]
    );
    return reply.view('user/my_leads', { user: req.user, purchases: rows });
  });

  app.get('/app/compose', async (req, reply) => {
    const { rows: templates } = await query(
      'SELECT id, slug, name, subject FROM email_templates ORDER BY id'
    );
    const { rows: leads } = await query(
      `SELECT l.id, l.first_name, l.last_name, l.email, l.address
       FROM lead_purchases lp
       JOIN leads l ON l.id = lp.lead_id
       WHERE lp.user_id = $1
       ORDER BY lp.created_at DESC
       LIMIT 500`,
      [req.user.id]
    );
    return reply.view('user/compose', { user: req.user, templates, leads });
  });

  app.post('/app/send', async (req, reply) => {
    const templateId = Number(req.body.template_id);
    const name = (req.body.campaign_name || 'Untitled').slice(0, 200);
    const leadIds = []
      .concat(req.body.lead_ids || [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!templateId || leadIds.length === 0) {
      return reply.redirect('/app/compose?error=missing');
    }
    if (req.user.email_tokens < leadIds.length) {
      return reply.redirect('/app/compose?error=tokens');
    }

    const { rows: cam } = await query(
      `INSERT INTO campaigns (user_id, template_id, name, status)
       VALUES ($1, $2, $3, 'sending') RETURNING id`,
      [req.user.id, templateId, name]
    );
    const campaignId = cam[0].id;

    const results = { sent: 0, failed: 0 };
    for (const leadId of leadIds) {
      try {
        await sendOne({ userId: req.user.id, campaignId, leadId, templateId });
        results.sent++;
      } catch (err) {
        req.log.warn({ err, leadId }, 'send failed');
        results.failed++;
      }
    }
    await query(`UPDATE campaigns SET status='sent' WHERE id=$1`, [campaignId]);
    return reply.redirect(`/app/campaigns/${campaignId}`);
  });

  app.get('/app/campaigns', async (req, reply) => {
    const { rows } = await query(
      `SELECT c.*, t.name AS template_name,
              (SELECT COUNT(*)::int FROM sends s WHERE s.campaign_id = c.id) AS total,
              (SELECT COUNT(*)::int FROM sends s WHERE s.campaign_id = c.id AND s.status='sent') AS sent,
              (SELECT COUNT(*)::int FROM sends s WHERE s.campaign_id = c.id AND s.opened_at IS NOT NULL) AS opened,
              (SELECT COUNT(*)::int FROM click_events ce JOIN sends s ON s.id=ce.send_id WHERE s.campaign_id = c.id) AS clicks
       FROM campaigns c
       JOIN email_templates t ON t.id = c.template_id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return reply.view('user/campaigns', { user: req.user, campaigns: rows });
  });

  app.get('/app/campaigns/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows: cam } = await query(
      `SELECT c.*, t.name AS template_name FROM campaigns c
       JOIN email_templates t ON t.id = c.template_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, req.user.id]
    );
    if (!cam[0]) return reply.code(404).send('Not found');
    const { rows: sends } = await query(
      `SELECT s.*, l.email, l.first_name, l.last_name,
              (SELECT COUNT(*)::int FROM click_events ce WHERE ce.send_id = s.id) AS click_count
       FROM sends s JOIN leads l ON l.id = s.lead_id
       WHERE s.campaign_id = $1 ORDER BY s.created_at DESC`,
      [id]
    );
    return reply.view('user/campaign_detail', { user: req.user, campaign: cam[0], sends });
  });

  app.get('/app/keywords', async (req, reply) => {
    const { rows } = await query(
      'SELECT * FROM keywords WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    return reply.view('user/keywords', { user: req.user, keywords: rows });
  });

  app.post('/app/keywords', async (req, reply) => {
    const label = (req.body.label || '').trim().slice(0, 200);
    const prompt = (req.body.prompt || '').trim().slice(0, 1000);
    if (!label || !prompt) return reply.redirect('/app/keywords?error=missing');
    await query(
      'INSERT INTO keywords (user_id, label, prompt) VALUES ($1, $2, $3)',
      [req.user.id, label, prompt]
    );
    return reply.redirect('/app/keywords');
  });
}
