import { query, tx } from '../db.js';
import { requireAdmin, findUserById } from '../auth.js';
import { grantCredits, grantTokens } from '../services/credits.js';
import { sendOne } from '../services/email.js';

// Admin gate that ALSO permits sessions where the active user is impersonated
// (we keep the original admin id in session.realAdminId).
function adminOrImpersonating(req, reply, done) {
  if (req.session.realAdminId) return done();
  return requireAdmin(req, reply, done);
}

export default async function adminRoutes(app) {
  app.addHook('preHandler', adminOrImpersonating);

  app.get('/admin', async (req, reply) => {
    const { rows: stats } = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE role='user') AS users,
        (SELECT COUNT(*)::int FROM leads) AS leads,
        (SELECT COUNT(*)::int FROM lead_purchases) AS purchases,
        (SELECT COUNT(*)::int FROM sends WHERE status='sent') AS sends,
        (SELECT COUNT(*)::int FROM click_events) AS clicks
    `);
    return reply.view('admin/dashboard', { user: req.user, stats: stats[0] });
  });

  app.get('/admin/users', async (req, reply) => {
    const { rows } = await query(
      `SELECT id, email, role, credits_cents, email_tokens, created_at
       FROM users ORDER BY created_at DESC`
    );
    return reply.view('admin/users', { user: req.user, users: rows });
  });

  app.post('/admin/users/:id/credits', async (req, reply) => {
    const userId = Number(req.params.id);
    const dollars = Number(req.body.amount || 0);
    const reason = (req.body.reason || 'admin_grant').slice(0, 200);
    if (!Number.isFinite(dollars) || dollars === 0) {
      return reply.redirect('/admin/users');
    }
    await grantCredits(userId, Math.round(dollars * 100), reason, req.user.id);
    return reply.redirect('/admin/users');
  });

  app.get('/admin/import', async (req, reply) => {
    return reply.view('admin/import', { user: req.user, result: null });
  });

  // Ingest a raw HighIntentTargets find_persons export (JSON list).
  // Accepts either a JSON body { persons: [...] } or a form post with a JSON string in `persons`.
  app.post('/admin/import', async (req, reply) => {
    let body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    let persons = body.persons;
    if (typeof persons === 'string') {
      try {
        const parsed = JSON.parse(persons);
        persons = Array.isArray(parsed) ? parsed : parsed.persons;
      } catch {
        return reply.view('admin/import', { user: req.user, result: { error: 'Could not parse JSON.' } });
      }
    }
    if (!Array.isArray(persons)) persons = [];
    const keywordId = body.keyword_id ? Number(body.keyword_id) : null;
    const workflowId = body.workflow_id || null;
    const toolTraceId = body.tool_trace_id || null;
    const keywordTag = (body.tag || '').trim();

    const result = await tx(async (client) => {
      const { rows: audRows } = await client.query(
        `INSERT INTO audiences (keyword_id, workflow_id, tool_trace_id, total_count, imported_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [keywordId, workflowId, toolTraceId, persons.length, req.user.id]
      );
      const audienceId = audRows[0].id;

      let inserted = 0;
      let updated = 0;

      for (const p of persons) {
        const personId = p.person_id || p.id;
        if (!personId) continue;
        const email = p.email || (Array.isArray(p.emails) ? p.emails[0] : null);
        const { rows: existing } = await client.query(
          'SELECT id FROM leads WHERE person_id = $1',
          [personId]
        );
        let leadId;
        if (existing[0]) {
          leadId = existing[0].id;
          await client.query(
            `UPDATE leads SET
               email = COALESCE($2, email),
               phone = COALESCE($3, phone),
               first_name = COALESCE($4, first_name),
               last_name = COALESCE($5, last_name),
               address = COALESCE($6, address),
               dnc = COALESCE($7, dnc),
               last_seen = NOW()
             WHERE id = $1`,
            [
              leadId,
              email,
              p.phone || null,
              p.first_name || null,
              p.last_name || null,
              p.address ? JSON.stringify(p.address) : null,
              p.dnc ?? null,
            ]
          );
          updated++;
        } else {
          const { rows } = await client.query(
            `INSERT INTO leads (person_id, email, phone, first_name, last_name, address, dnc)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              personId,
              email,
              p.phone || null,
              p.first_name || null,
              p.last_name || null,
              p.address ? JSON.stringify(p.address) : null,
              !!p.dnc,
            ]
          );
          leadId = rows[0].id;
          inserted++;
        }
        await client.query(
          'INSERT INTO audience_leads (audience_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [audienceId, leadId]
        );
        if (keywordTag) {
          await client.query(
            `INSERT INTO lead_tags (lead_id, tag, source) VALUES ($1, $2, $3)
             ON CONFLICT (lead_id, tag) DO NOTHING`,
            [leadId, keywordTag, `audience:${audienceId}`]
          );
        }
      }

      return { audienceId, inserted, updated, total: persons.length };
    });

    return reply.view('admin/import', { user: req.user, result });
  });

  app.get('/admin/templates', async (req, reply) => {
    const { rows } = await query('SELECT * FROM email_templates ORDER BY id');
    return reply.view('admin/templates', { user: req.user, templates: rows });
  });

  app.post('/admin/templates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { name, subject, body_html } = req.body;
    await query(
      'UPDATE email_templates SET name=$1, subject=$2, body_html=$3 WHERE id=$4',
      [name, subject, body_html, id]
    );
    return reply.redirect('/admin/templates');
  });

  // ==========================================================================
  // HITT queue — admin sees pending HITT requests and fulfills them
  // ==========================================================================

  app.get('/admin/hitt', async (req, reply) => {
    const { rows } = await query(
      `SELECT h.*, u.email AS user_email,
              (SELECT COUNT(*)::int FROM audience_leads al WHERE al.audience_id = h.audience_id) AS lead_count
       FROM hitt_requests h
       JOIN users u ON u.id = h.user_id
       ORDER BY
         CASE h.status WHEN 'baking' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
         h.created_at DESC
       LIMIT 200`
    );
    return reply.view('admin/hitt', { user: req.user, hitts: rows });
  });

  // Fulfill: admin pastes the MCP find_persons JSON for a specific HITT request
  app.post('/admin/hitt/:id/fulfill', async (req, reply) => {
    const hittId = Number(req.params.id);
    let body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    let persons = body.persons;
    if (typeof persons === 'string') {
      try {
        const parsed = JSON.parse(persons);
        persons = Array.isArray(parsed) ? parsed : parsed.persons;
      } catch {
        return reply.redirect(`/admin/hitt?error=parse&id=${hittId}`);
      }
    }
    if (!Array.isArray(persons)) persons = [];

    const { rows: hRows } = await query('SELECT * FROM hitt_requests WHERE id = $1', [hittId]);
    const hitt = hRows[0];
    if (!hitt) return reply.code(404).send('Not found');

    const result = await tx(async (client) => {
      const { rows: aud } = await client.query(
        `INSERT INTO audiences (workflow_id, tool_trace_id, total_count, imported_by, hitt_request_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.workflow_id || null, body.tool_trace_id || null, persons.length, req.user.id, hittId]
      );
      const audienceId = aud[0].id;

      let inserted = 0;
      for (const p of persons) {
        const personId = p.person_id || p.id;
        if (!personId) continue;
        const email = p.email || (Array.isArray(p.emails) ? p.emails[0] : null);
        const { rows: existing } = await client.query(
          'SELECT id FROM leads WHERE person_id = $1', [personId]
        );
        let leadId;
        if (existing[0]) {
          leadId = existing[0].id;
          await client.query(
            `UPDATE leads SET email=COALESCE($2,email), phone=COALESCE($3,phone),
              first_name=COALESCE($4,first_name), last_name=COALESCE($5,last_name),
              address=COALESCE($6,address), last_seen=NOW() WHERE id=$1`,
            [leadId, email, p.phone || null, p.first_name || null, p.last_name || null,
             p.address ? JSON.stringify(p.address) : null]
          );
        } else {
          const { rows: ins } = await client.query(
            `INSERT INTO leads (person_id, email, phone, first_name, last_name, address, dnc)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [personId, email, p.phone || null, p.first_name || null, p.last_name || null,
             p.address ? JSON.stringify(p.address) : null, !!p.dnc]
          );
          leadId = ins[0].id;
          inserted++;
        }
        await client.query(
          'INSERT INTO audience_leads (audience_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [audienceId, leadId]
        );
        await client.query(
          `INSERT INTO lead_tags (lead_id, tag, source) VALUES ($1, $2, $3)
           ON CONFLICT (lead_id, tag) DO NOTHING`,
          [leadId, hitt.label.toLowerCase().replace(/\s+/g, '_'), `hitt:${hittId}`]
        );
      }

      await client.query(
        `UPDATE hitt_requests SET status='complete', audience_id=$1, result_count=$2, completed_at=NOW()
         WHERE id=$3`,
        [audienceId, persons.length, hittId]
      );

      return { audienceId, total: persons.length, inserted };
    });

    return reply.redirect(`/admin/hitt?fulfilled=${hittId}&n=${result.total}`);
  });

  app.post('/admin/hitt/:id/fail', async (req, reply) => {
    const hittId = Number(req.params.id);
    const note = (req.body.note || '').slice(0, 500);
    await query(
      `UPDATE hitt_requests SET status='failed', notes=$1, completed_at=NOW() WHERE id=$2`,
      [note, hittId]
    );
    return reply.redirect('/admin/hitt');
  });

  // ==========================================================================
  // Impersonation — log in as a user
  // ==========================================================================

  app.post('/admin/users/:id/impersonate', async (req, reply) => {
    if (req.session.realAdminId) return reply.redirect('/admin/users');
    const targetId = Number(req.params.id);
    const target = await findUserById(targetId);
    if (!target) return reply.code(404).send('Not found');
    await query(
      'INSERT INTO impersonations (admin_id, target_user_id) VALUES ($1, $2)',
      [req.user.id, targetId]
    );
    req.session.realAdminId = req.user.id;
    req.session.userId = targetId;
    req.session.role = 'user';
    return reply.redirect('/app');
  });

  app.post('/admin/end-impersonation', async (req, reply) => {
    if (!req.session.realAdminId) return reply.redirect('/admin');
    await query(
      `UPDATE impersonations SET ended_at = NOW()
       WHERE admin_id = $1 AND target_user_id = $2 AND ended_at IS NULL`,
      [req.session.realAdminId, req.session.userId]
    );
    req.session.userId = req.session.realAdminId;
    req.session.role = 'admin';
    delete req.session.realAdminId;
    return reply.redirect('/admin');
  });

  // ==========================================================================
  // Reports — global business view
  // ==========================================================================

  app.get('/admin/reports', async (req, reply) => {
    const { rows: rev } = await query(`
      SELECT
        COUNT(*)::int AS purchase_count,
        COALESCE(SUM(price_cents), 0)::int AS revenue_cents
      FROM lead_purchases
    `);
    const { rows: byTier } = await query(`
      SELECT tier_days, COUNT(*)::int AS n, SUM(price_cents)::int AS rev
      FROM lead_purchases GROUP BY tier_days ORDER BY tier_days
    `);
    const { rows: deliv } = await query(`
      SELECT
        COUNT(*)::int AS sent,
        COUNT(opened_at)::int AS opened,
        (SELECT COUNT(*)::int FROM click_events) AS clicks
      FROM sends WHERE status = 'sent'
    `);
    const { rows: hittStats } = await query(`
      SELECT status, COUNT(*)::int AS n FROM hitt_requests GROUP BY status
    `);
    const { rows: dailyRev } = await query(`
      SELECT DATE_TRUNC('day', created_at) AS day,
             COUNT(*)::int AS purchases,
             SUM(price_cents)::int AS rev_cents
      FROM lead_purchases
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `);
    return reply.view('admin/reports', {
      user: req.user,
      revenue: rev[0],
      byTier,
      delivery: deliv[0],
      hittStats,
      dailyRev,
    });
  });

  app.get('/admin/leaderboard', async (req, reply) => {
    const { rows } = await query(`
      SELECT u.id, u.email, u.created_at,
        u.credits_cents, u.email_tokens,
        (SELECT COUNT(*)::int FROM lead_purchases lp WHERE lp.user_id = u.id) AS leads_bought,
        (SELECT COALESCE(SUM(price_cents),0)::int FROM lead_purchases lp WHERE lp.user_id = u.id) AS spent_cents,
        (SELECT COUNT(*)::int FROM sends s WHERE s.user_id = u.id AND s.status='sent') AS emails_sent,
        (SELECT COUNT(*)::int FROM click_events ce JOIN sends s ON s.id = ce.send_id WHERE s.user_id = u.id) AS clicks,
        (SELECT COUNT(*)::int FROM hitt_requests h WHERE h.user_id = u.id) AS hitts
      FROM users u
      WHERE u.role = 'user'
      ORDER BY spent_cents DESC, leads_bought DESC
      LIMIT 100
    `);
    return reply.view('admin/leaderboard', { user: req.user, users: rows });
  });

  app.get('/admin/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const target = await findUserById(id);
    if (!target) return reply.code(404).send('Not found');
    const { rows: leads } = await query(
      `SELECT lp.*, l.first_name, l.last_name, l.email AS lead_email, l.address
       FROM lead_purchases lp JOIN leads l ON l.id = lp.lead_id
       WHERE lp.user_id = $1 ORDER BY lp.created_at DESC LIMIT 200`,
      [id]
    );
    const { rows: campaigns } = await query(
      `SELECT c.*, t.name AS template_name,
              (SELECT COUNT(*)::int FROM sends s WHERE s.campaign_id=c.id) AS total,
              (SELECT COUNT(*)::int FROM sends s WHERE s.campaign_id=c.id AND s.status='sent') AS sent,
              (SELECT COUNT(*)::int FROM click_events ce JOIN sends s ON s.id=ce.send_id WHERE s.campaign_id=c.id) AS clicks
       FROM campaigns c JOIN email_templates t ON t.id=c.template_id
       WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
      [id]
    );
    return reply.view('admin/user_detail', { user: req.user, target, leads, campaigns });
  });

  // ==========================================================================
  // Send on behalf — admin sends to any user's leads (or by tag)
  // ==========================================================================

  app.get('/admin/send', async (req, reply) => {
    const { rows: users } = await query(
      `SELECT u.id, u.email,
        (SELECT COUNT(*)::int FROM lead_purchases lp WHERE lp.user_id = u.id) AS lead_count
       FROM users u WHERE u.role = 'user'
       ORDER BY u.created_at DESC`
    );
    const { rows: templates } = await query('SELECT id, name, subject FROM email_templates ORDER BY id');
    const { rows: tags } = await query(
      `SELECT tag, COUNT(*)::int AS n FROM lead_tags GROUP BY tag ORDER BY n DESC LIMIT 50`
    );
    return reply.view('admin/send', { user: req.user, users, templates, tags });
  });

  app.post('/admin/send', async (req, reply) => {
    const targetUserId = Number(req.body.target_user_id);
    const templateId = Number(req.body.template_id);
    const tag = (req.body.tag || '').trim();
    const name = (req.body.campaign_name || 'Admin send').slice(0, 200);
    const useUserCredits = req.body.use_user_credits === 'on';

    let leadIds = [];
    if (tag) {
      const params = [tag];
      let join = '';
      if (targetUserId) {
        params.push(targetUserId);
        join = `JOIN lead_purchases lp ON lp.lead_id = l.id AND lp.user_id = $${params.length}`;
      }
      const { rows } = await query(
        `SELECT DISTINCT l.id FROM leads l
         JOIN lead_tags lt ON lt.lead_id = l.id
         ${join}
         WHERE lt.tag = $1 AND l.dnc = FALSE AND l.email IS NOT NULL LIMIT 5000`,
        params
      );
      leadIds = rows.map((r) => r.id);
    } else if (targetUserId) {
      const { rows } = await query(
        `SELECT lp.lead_id AS id FROM lead_purchases lp
         JOIN leads l ON l.id = lp.lead_id
         WHERE lp.user_id = $1 AND l.dnc = FALSE AND l.email IS NOT NULL`,
        [targetUserId]
      );
      leadIds = rows.map((r) => r.id);
    }

    if (!templateId || !leadIds.length) {
      return reply.redirect('/admin/send?error=missing');
    }

    // The admin "sends as" — campaign is owned by the admin or the target user.
    const senderUserId = useUserCredits && targetUserId ? targetUserId : req.user.id;

    const { rows: cam } = await query(
      `INSERT INTO campaigns (user_id, template_id, name, status)
       VALUES ($1, $2, $3, 'sending') RETURNING id`,
      [senderUserId, templateId, name]
    );
    const campaignId = cam[0].id;

    let sent = 0, failed = 0;
    for (const leadId of leadIds) {
      try {
        await sendOne({ userId: senderUserId, campaignId, leadId, templateId });
        sent++;
      } catch (err) {
        req.log.warn({ err, leadId }, 'admin send failed');
        failed++;
      }
    }
    await query(`UPDATE campaigns SET status='sent' WHERE id=$1`, [campaignId]);
    return reply.redirect(`/admin/reports?sent=${sent}&failed=${failed}`);
  });
}
