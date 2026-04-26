import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { priceForAge, TIERS, TOKENS_PER_LEAD, MISSING_OPP_PER_LEAD_CENTS } from '../services/pricing.js';
import { purchaseLead } from '../services/credits.js';
import { sendOne, sendTestToSelf } from '../services/email.js';
import { enqueueCampaignSends } from '../services/queue.js';

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
    const { rows: recentHitts } = await query(
      `SELECT h.id, h.label, h.prompt, h.status, h.result_count, h.created_at, u.email
       FROM hitt_requests h
       JOIN users u ON u.id = h.user_id
       ORDER BY h.created_at DESC LIMIT 8`
    );
    const { rows: myHitts } = await query(
      `SELECT id, label, status, result_count, created_at FROM hitt_requests
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.user.id]
    );
    return reply.view('user/dashboard', {
      user: req.user,
      stats: { purchases: purchases[0].n, sends: sends[0].n, clicks: clicks[0].n },
      tiers: TIERS,
      tokensPerLead: TOKENS_PER_LEAD,
      recentHitts,
      myHitts,
      hittError: req.query.hitt_error || null,
    });
  });

  // Lead marketplace — only show leads from this user's HITT audiences.
  // Locked leads = lead they can see but can't afford with current credit.
  app.get('/app/leads', async (req, reply) => {
    const hittId = req.query.hitt_id ? Number(req.query.hitt_id) : null;

    const params = [req.user.id];
    let hittFilter = '';
    if (hittId) {
      params.push(hittId);
      hittFilter = `AND h.id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT DISTINCT l.*
       FROM leads l
       JOIN audience_leads al ON al.lead_id = l.id
       JOIN audiences a ON a.id = al.audience_id
       JOIN hitt_requests h ON h.id = a.hitt_request_id
       WHERE h.user_id = $1
         AND l.dnc = FALSE
         AND l.email IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM lead_purchases lp
           WHERE lp.user_id = $1 AND lp.lead_id = l.id
         )
         ${hittFilter}
       ORDER BY l.first_seen DESC
       LIMIT 500`,
      params
    );

    const priced = rows.map((lead) => {
      const tier = priceForAge(lead.first_seen);
      const locked = req.user.credits_cents < tier.priceCents;
      return { lead, tier, locked };
    });

    const totalLeads = priced.length;
    const lockedCount = priced.filter((x) => x.locked).length;
    const unlockedCount = totalLeads - lockedCount;
    const missingOppCents = lockedCount * MISSING_OPP_PER_LEAD_CENTS;

    let activeHitt = null;
    if (hittId) {
      const { rows: hRows } = await query(
        'SELECT * FROM hitt_requests WHERE id=$1 AND user_id=$2',
        [hittId, req.user.id]
      );
      activeHitt = hRows[0] || null;
    }

    return reply.view('user/leads_market', {
      user: req.user,
      leads: priced,
      totalLeads,
      lockedCount,
      unlockedCount,
      missingOppCents,
      activeHitt,
    });
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
    // User sees their own templates first, then global library.
    const { rows: templates } = await query(
      `SELECT id, slug, name, subject, owner_user_id
         FROM email_templates
         WHERE owner_user_id = $1 OR owner_user_id IS NULL
         ORDER BY (owner_user_id IS NULL), name`,
      [req.user.id]
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
    const { rows: mailboxes } = await query(
      `SELECT m.id, m.label, m.smtp_user, m.daily_cap, m.sends_today, m.status,
              p.display_name AS persona_name
         FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
         WHERE m.owner_user_id = $1 AND m.status = 'active'
         ORDER BY m.label`,
      [req.user.id]
    );
    return reply.view('user/compose', { user: req.user, templates, leads, mailboxes });
  });

  // Schedule a campaign — creates the campaign in 'draft' and pre-builds every
  // send row with status='queued' and a projected scheduled_for. Nothing
  // dispatches until the user clicks Launch on the schedule preview page.
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

    const ctaLabel = (req.body.cta_label || '').trim().slice(0, 80) || null;
    const ctaUrl   = (req.body.cta_url   || '').trim().slice(0, 500) || null;
    const ltvCents = Math.max(0, Math.round(Number(req.body.customer_ltv || 0) * 100));
    const valuePct = Math.max(0, Math.min(100, Number(req.body.value_multiplier_pct || 5)));
    const perDay   = Math.max(1, Math.min(500, Number(req.body.sends_per_persona_per_day || 50)));
    const startHr  = Math.max(0, Math.min(23, Number(req.body.send_window_start_hour || 9)));
    const endHr    = Math.max(startHr + 1, Math.min(24, Number(req.body.send_window_end_hour || 18)));

    const { rows: mboxes } = await query(
      `SELECT m.id, m.persona_id, m.label, p.display_name AS persona_name
         FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
        WHERE m.owner_user_id = $1 AND m.status='active'
        ORDER BY m.id`,
      [req.user.id]
    );
    if (!mboxes.length) {
      return reply.redirect('/app/compose?error=no_mailboxes');
    }

    const { rows: cam } = await query(
      `INSERT INTO campaigns
         (user_id, template_id, name, status,
          cta_label, cta_url, customer_ltv_cents, value_multiplier_pct,
          sends_per_persona_per_day, send_window_start_hour, send_window_end_hour)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, templateId, name, ctaLabel, ctaUrl, ltvCents, valuePct, perDay, startHr, endHr]
    );
    const campaign = cam[0];

    await enqueueCampaignSends({
      campaign,
      leadIds,
      mailboxes: mboxes,
      userId: req.user.id,
    });

    return reply.redirect(`/app/campaigns/${campaign.id}`);
  });

  app.post('/app/campaigns/:id/launch', async (req, reply) => {
    const id = Number(req.params.id);
    await query(
      `UPDATE campaigns SET status='sending'
         WHERE id=$1 AND user_id=$2 AND status IN ('draft','paused')`,
      [id, req.user.id]
    );
    return reply.redirect(`/app/campaigns/${id}`);
  });

  app.post('/app/campaigns/:id/cancel', async (req, reply) => {
    const id = Number(req.params.id);
    await query(
      `UPDATE sends SET status='canceled'
         WHERE campaign_id=$1 AND status='queued'`,
      [id]
    );
    await query(
      `UPDATE campaigns SET status='canceled' WHERE id=$1 AND user_id=$2`,
      [id, req.user.id]
    );
    return reply.redirect(`/app/campaigns/${id}`);
  });

  // ==========================================================================
  // User templates — fork-to-edit + send-test
  // ==========================================================================

  app.get('/app/templates', async (req, reply) => {
    const { rows: mine } = await query(
      `SELECT * FROM email_templates WHERE owner_user_id = $1 ORDER BY name`,
      [req.user.id]
    );
    const { rows: globals } = await query(
      `SELECT * FROM email_templates WHERE owner_user_id IS NULL ORDER BY name`
    );
    const { rows: mailboxes } = await query(
      `SELECT m.id, m.label, p.display_name AS persona_name
       FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
       WHERE m.owner_user_id = $1 AND m.status='active' ORDER BY m.label`,
      [req.user.id]
    );
    return reply.view('user/templates', {
      user: req.user,
      mine,
      globals,
      mailboxes,
      flash: req.query.flash || null,
      flashErr: req.query.err || null,
    });
  });

  app.post('/app/templates/fork/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT * FROM email_templates WHERE id = $1 AND owner_user_id IS NULL`, [id]
    );
    const src = rows[0];
    if (!src) return reply.redirect('/app/templates?flash=missing');
    let slug = src.slug;
    let attempt = 1;
    while (true) {
      const { rows: dupe } = await query(
        `SELECT 1 FROM email_templates WHERE owner_user_id=$1 AND slug=$2`,
        [req.user.id, slug]
      );
      if (dupe.length === 0) break;
      attempt++;
      slug = `${src.slug}_${attempt}`;
    }
    const { rows: ins } = await query(
      `INSERT INTO email_templates (slug, name, subject, body_html, links, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [slug, src.name + ' (mine)', src.subject, src.body_html, src.links, req.user.id]
    );
    return reply.redirect(`/app/templates?flash=forked_${ins[0].id}`);
  });

  app.post('/app/templates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { name, subject, body_html } = req.body;
    // Authorization: only the owner can edit. Globals are not editable here.
    const result = await query(
      `UPDATE email_templates SET name=$1, subject=$2, body_html=$3, updated_at=NOW()
       WHERE id=$4 AND owner_user_id=$5`,
      [name, subject, body_html, id, req.user.id]
    );
    if (result.rowCount === 0) return reply.redirect('/app/templates?flash=forbidden');
    return reply.redirect('/app/templates?flash=saved');
  });

  app.post('/app/templates/:id/delete', async (req, reply) => {
    const id = Number(req.params.id);
    await query(
      `DELETE FROM email_templates WHERE id=$1 AND owner_user_id=$2`,
      [id, req.user.id]
    );
    return reply.redirect('/app/templates?flash=deleted');
  });

  app.post('/app/templates/:id/send-test', async (req, reply) => {
    const id = Number(req.params.id);
    const recipient = (req.body.recipient || req.user.email || '').trim();
    const mailboxId = req.body.mailbox_id ? Number(req.body.mailbox_id) : null;
    // Authorization: must be a global or one I own.
    const { rows } = await query(
      `SELECT id FROM email_templates WHERE id=$1 AND (owner_user_id IS NULL OR owner_user_id=$2)`,
      [id, req.user.id]
    );
    if (rows.length === 0) return reply.redirect('/app/templates?flash=forbidden');
    try {
      await sendTestToSelf({ userId: req.user.id, templateId: id, mailboxId, recipient });
      return reply.redirect('/app/templates?flash=test_sent');
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/app/templates?flash=test_failed&err=${msg}`);
    }
  });

  // ==========================================================================
  // User mailboxes — read-only list of theirs (admin manages)
  // ==========================================================================

  app.get('/app/mailboxes', async (req, reply) => {
    const { rows } = await query(
      `SELECT m.id, m.label, m.smtp_user, m.daily_cap, m.sends_today,
              m.last_send_at, m.status, p.display_name AS persona_name
       FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
       WHERE m.owner_user_id = $1 ORDER BY m.label`,
      [req.user.id]
    );
    return reply.view('user/mailboxes', { user: req.user, mailboxes: rows });
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
    const enriched = rows.map((c) => {
      const valuePerClickCents = Math.round((c.customer_ltv_cents || 0) * (c.value_multiplier_pct || 0) / 100);
      return { ...c, est_value_cents: c.clicks * valuePerClickCents };
    });
    return reply.view('user/campaigns', { user: req.user, campaigns: enriched });
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
    const campaign = cam[0];
    const { rows: sends } = await query(
      `SELECT s.id, s.status, s.scheduled_for, s.sent_at, s.opened_at,
              l.email, l.first_name, l.last_name,
              p.display_name AS persona_name,
              m.label        AS mailbox_label,
              (SELECT COUNT(*)::int FROM click_events ce WHERE ce.send_id = s.id) AS click_count
       FROM sends s
       JOIN leads l         ON l.id = s.lead_id
       LEFT JOIN personas p ON p.id = s.persona_id
       LEFT JOIN mailboxes m ON m.id = s.mailbox_id
       WHERE s.campaign_id = $1
       ORDER BY s.scheduled_for ASC NULLS LAST, s.created_at ASC`,
      [id]
    );
    const { rows: byPersona } = await query(
      `SELECT COALESCE(p.display_name, '— no persona —') AS persona,
              COUNT(*)::int AS total,
              SUM((s.status='sent')::int)::int     AS sent,
              SUM((s.status='queued')::int)::int   AS queued
         FROM sends s LEFT JOIN personas p ON p.id = s.persona_id
        WHERE s.campaign_id = $1
        GROUP BY p.display_name ORDER BY persona`,
      [id]
    );
    const { rows: byDay } = await query(
      `SELECT DATE(s.scheduled_for) AS day,
              COUNT(*)::int AS total
         FROM sends s WHERE s.campaign_id = $1 AND s.scheduled_for IS NOT NULL
         GROUP BY day ORDER BY day`,
      [id]
    );
    const { rows: clicksRow } = await query(
      `SELECT COUNT(*)::int AS clicks FROM click_events ce
         JOIN sends s ON s.id=ce.send_id WHERE s.campaign_id = $1`,
      [id]
    );
    const clicks = clicksRow[0].clicks;
    const valuePerClickCents = Math.round((campaign.customer_ltv_cents || 0) * (campaign.value_multiplier_pct || 0) / 100);
    const estValueCents = clicks * valuePerClickCents;

    return reply.view('user/campaign_detail', {
      user: req.user, campaign, sends, byPersona, byDay,
      clicks, valuePerClickCents, estValueCents,
    });
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
