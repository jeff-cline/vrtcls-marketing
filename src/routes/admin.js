import { query, tx } from '../db.js';
import { requireAdmin, findUserById } from '../auth.js';
import { grantCredits, grantTokens } from '../services/credits.js';
import { sendOne, sendTransactional, sendTestToSelf } from '../services/email.js';
import { ingestPersons } from '../services/personImport.js';
import { verifyMailbox, sendViaMailbox, clearTransport } from '../services/smtpSender.js';
import { syncMailboxInbox, markMessageRead } from '../services/imapReader.js';
import * as zapmail from '../services/zapmail.js';
import { config } from '../config.js';

function parseCsv(text) {
  const out = [];
  const rows = [];
  let cur = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return out;
  const headers = rows[0].map(h => h.trim().toLowerCase());
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].every(v => v === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (rows[r][c] || '').trim();
    out.push(obj);
  }
  return out;
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k.toLowerCase()];
    if (v !== undefined && v !== '') return v;
  }
  return null;
}

async function notifyCustomerOnFulfill(hitt, leadCount) {
  if (!config.hitt.notifyCustomerOnFulfill) return;
  const { rows } = await query('SELECT email FROM users WHERE id = $1', [hitt.user_id]);
  const to = rows[0]?.email;
  if (!to) return;
  const subject = `Your HITT is ready — ${leadCount} leads`;
  const html = `
    <h2>Your leads are ready</h2>
    <p>"<strong>${hitt.label}</strong>" — we found <strong>${leadCount}</strong> people that matched.</p>
    <p>
      <a href="${config.baseUrl}/app/leads?hitt_id=${hitt.id}"
         style="display:inline-block;padding:12px 22px;background:#ffc107;color:#000;text-decoration:none;border-radius:4px;font-weight:bold">
        Open my leads
      </a>
    </p>
    <p style="color:#666;font-size:12px">
      Leads are tiered by intent freshness — the fresher the more you can charge.
      Compose a campaign and start sending while the intent is hot.
    </p>
  `;
  await sendTransactional({ to, subject, html });
}

async function notifyCustomerOnFail(hitt, note) {
  if (!config.hitt.notifyCustomerOnFulfill) return;
  const { rows } = await query('SELECT email FROM users WHERE id = $1', [hitt.user_id]);
  const to = rows[0]?.email;
  if (!to) return;
  const subject = `Your HITT request couldn't be fulfilled`;
  const html = `
    <h2>We couldn't fulfill your HITT</h2>
    <p>"<strong>${hitt.label}</strong>"</p>
    ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
    <p>You haven't been charged. Please reply to this email or submit a new request and we'll dig in.</p>
  `;
  await sendTransactional({ to, subject, html });
}

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
    const { rows } = await query(
      'SELECT * FROM email_templates WHERE owner_user_id IS NULL ORDER BY id'
    );
    const { rows: mailboxes } = await query(
      `SELECT m.id, m.label, p.display_name AS persona_name
       FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
       WHERE m.status='active' ORDER BY m.label`
    );
    return reply.view('admin/templates', {
      user: req.user,
      templates: rows,
      mailboxes,
      flash: req.query.flash || null,
      flashErr: req.query.err || null,
    });
  });

  app.post('/admin/templates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { name, subject, body_html } = req.body;
    await query(
      'UPDATE email_templates SET name=$1, subject=$2, body_html=$3, updated_at=NOW() WHERE id=$4',
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

    const addToAdminPool = body.add_to_admin === '1' || body.add_to_admin === 'on' || body.add_to_admin === true;

    const result = await ingestPersons({
      hittId,
      persons,
      workflowId: body.workflow_id,
      toolTraceId: body.tool_trace_id,
      label: hitt.label,
      importedBy: req.user.id,
      addToAdminPool,
    });

    notifyCustomerOnFulfill(hitt, result.total).catch((err) =>
      req.log.warn({ err }, 'customer notify failed')
    );

    return reply.redirect(`/admin/hitt?fulfilled=${hittId}&n=${result.total}`);
  });

  app.post('/admin/hitt/:id/fail', async (req, reply) => {
    const hittId = Number(req.params.id);
    const note = (req.body.note || '').slice(0, 500);
    const { rows } = await query(
      `UPDATE hitt_requests SET status='failed', notes=$1, completed_at=NOW() WHERE id=$2 RETURNING *`,
      [note, hittId]
    );
    if (rows[0]) {
      notifyCustomerOnFail(rows[0], note).catch((err) =>
        req.log.warn({ err }, 'customer fail notify failed')
      );
    }
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
        COUNT(bounced_at)::int AS bounced,
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
    const { rows: byPersona } = await query(`
      SELECT COALESCE(p.display_name, '— no persona —') AS persona,
             COUNT(s.*)::int AS sent,
             COUNT(s.opened_at)::int AS opened,
             COUNT(s.bounced_at)::int AS bounced,
             COALESCE(SUM(c.cnt),0)::int AS clicks
      FROM sends s
      LEFT JOIN personas p ON p.id = s.persona_id
      LEFT JOIN (
        SELECT send_id, COUNT(*)::int AS cnt FROM click_events GROUP BY send_id
      ) c ON c.send_id = s.id
      WHERE s.status = 'sent'
      GROUP BY p.display_name
      ORDER BY sent DESC
    `);
    const { rows: byMailbox } = await query(`
      SELECT COALESCE(m.label, '— Resend fallback —') AS mailbox,
             m.smtp_user,
             COUNT(s.*)::int AS sent,
             COUNT(s.opened_at)::int AS opened,
             COUNT(s.bounced_at)::int AS bounced,
             COALESCE(SUM(c.cnt),0)::int AS clicks
      FROM sends s
      LEFT JOIN mailboxes m ON m.id = s.mailbox_id
      LEFT JOIN (
        SELECT send_id, COUNT(*)::int AS cnt FROM click_events GROUP BY send_id
      ) c ON c.send_id = s.id
      WHERE s.status = 'sent'
      GROUP BY m.label, m.smtp_user
      ORDER BY sent DESC
    `);
    const { rows: valueRows } = await query(`
      SELECT
        COALESCE(SUM(
          (SELECT COUNT(*) FROM click_events ce
             JOIN sends s ON s.id=ce.send_id WHERE s.campaign_id=c.id)
          * c.customer_ltv_cents * c.value_multiplier_pct / 100
        ), 0)::bigint AS est_value_cents
      FROM campaigns c
    `);
    const estValueCents = Number(valueRows[0].est_value_cents || 0);

    return reply.view('admin/reports', {
      user: req.user,
      revenue: rev[0],
      byTier,
      delivery: deliv[0],
      hittStats,
      dailyRev,
      byPersona,
      byMailbox,
      estValueCents,
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

  // ==========================================================================
  // Personas — writer voice / display identity for outbound mail
  // ==========================================================================

  app.get('/admin/personas', async (req, reply) => {
    const { rows } = await query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM mailboxes m WHERE m.persona_id = p.id) AS mailbox_count
       FROM personas p ORDER BY p.created_at DESC`
    );
    return reply.view('admin/personas', {
      user: req.user,
      personas: rows,
      flash: req.query.flash || null,
    });
  });

  app.post('/admin/personas', async (req, reply) => {
    const display_name = (req.body.display_name || '').trim().slice(0, 200);
    const title = (req.body.title || '').trim().slice(0, 200);
    const bio = (req.body.bio || '').trim().slice(0, 2000);
    const signature_html = (req.body.signature_html || '').slice(0, 4000);
    const avatar_url = (req.body.avatar_url || '').trim().slice(0, 500);
    if (!display_name) return reply.redirect('/admin/personas?flash=missing_name');
    await query(
      `INSERT INTO personas (display_name, title, bio, signature_html, avatar_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [display_name, title, bio, signature_html, avatar_url, req.user.id]
    );
    return reply.redirect('/admin/personas?flash=created');
  });

  app.post('/admin/personas/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const display_name = (req.body.display_name || '').trim().slice(0, 200);
    const title = (req.body.title || '').trim().slice(0, 200);
    const bio = (req.body.bio || '').trim().slice(0, 2000);
    const signature_html = (req.body.signature_html || '').slice(0, 4000);
    const avatar_url = (req.body.avatar_url || '').trim().slice(0, 500);
    await query(
      `UPDATE personas SET display_name=$1, title=$2, bio=$3, signature_html=$4, avatar_url=$5
       WHERE id=$6`,
      [display_name, title, bio, signature_html, avatar_url, id]
    );
    return reply.redirect('/admin/personas?flash=saved');
  });

  app.post('/admin/personas/:id/delete', async (req, reply) => {
    const id = Number(req.params.id);
    await query('DELETE FROM personas WHERE id=$1', [id]);
    return reply.redirect('/admin/personas?flash=deleted');
  });

  // ==========================================================================
  // Mailboxes — SMTP-authed sender accounts
  // ==========================================================================

  app.get('/admin/mailboxes', async (req, reply) => {
    const { rows } = await query(
      `SELECT m.*, p.display_name AS persona_name, u.email AS owner_email
       FROM mailboxes m
       LEFT JOIN personas p ON p.id = m.persona_id
       LEFT JOIN users u ON u.id = m.owner_user_id
       ORDER BY m.created_at DESC`
    );
    const { rows: personas } = await query('SELECT id, display_name FROM personas ORDER BY display_name');
    const { rows: users } = await query("SELECT id, email FROM users ORDER BY email");
    return reply.view('admin/mailboxes', {
      user: req.user,
      mailboxes: rows,
      personas,
      users,
      flash: req.query.flash || null,
    });
  });

  app.post('/admin/mailboxes', async (req, reply) => {
    const label = (req.body.label || '').trim().slice(0, 200);
    const smtp_host = (req.body.smtp_host || 'smtp.gmail.com').trim();
    const smtp_port = Number(req.body.smtp_port || 587);
    const smtp_secure = req.body.smtp_secure === 'on';
    const smtp_user = (req.body.smtp_user || '').trim().toLowerCase();
    const smtp_pass = req.body.smtp_pass || '';
    const persona_id = req.body.persona_id ? Number(req.body.persona_id) : null;
    const owner_user_id = req.body.owner_user_id ? Number(req.body.owner_user_id) : null;
    const daily_cap = Math.max(1, Math.min(500, Number(req.body.daily_cap || 50)));
    if (!label || !smtp_user || !smtp_pass) {
      return reply.redirect('/admin/mailboxes?flash=missing');
    }
    await query(
      `INSERT INTO mailboxes
         (label, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
          persona_id, owner_user_id, daily_cap)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [label, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
       persona_id, owner_user_id, daily_cap]
    );
    return reply.redirect('/admin/mailboxes?flash=created');
  });

  app.post('/admin/mailboxes/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const label = (req.body.label || '').trim().slice(0, 200);
    const smtp_host = (req.body.smtp_host || 'smtp.gmail.com').trim();
    const smtp_port = Number(req.body.smtp_port || 587);
    const smtp_secure = req.body.smtp_secure === 'on';
    const smtp_user = (req.body.smtp_user || '').trim().toLowerCase();
    const smtp_pass = req.body.smtp_pass || '';
    const persona_id = req.body.persona_id ? Number(req.body.persona_id) : null;
    const owner_user_id = req.body.owner_user_id ? Number(req.body.owner_user_id) : null;
    const daily_cap = Math.max(1, Math.min(500, Number(req.body.daily_cap || 50)));
    const status = ['active','paused','warming','disabled'].includes(req.body.status) ? req.body.status : 'active';

    // Empty smtp_pass means "don't change" — keep existing.
    if (smtp_pass) {
      await query(
        `UPDATE mailboxes SET label=$1, smtp_host=$2, smtp_port=$3, smtp_secure=$4,
                              smtp_user=$5, smtp_pass=$6, persona_id=$7, owner_user_id=$8,
                              daily_cap=$9, status=$10
         WHERE id=$11`,
        [label, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
         persona_id, owner_user_id, daily_cap, status, id]
      );
    } else {
      await query(
        `UPDATE mailboxes SET label=$1, smtp_host=$2, smtp_port=$3, smtp_secure=$4,
                              smtp_user=$5, persona_id=$6, owner_user_id=$7,
                              daily_cap=$8, status=$9
         WHERE id=$10`,
        [label, smtp_host, smtp_port, smtp_secure, smtp_user,
         persona_id, owner_user_id, daily_cap, status, id]
      );
    }
    clearTransport(id);
    return reply.redirect('/admin/mailboxes?flash=saved');
  });

  app.post('/admin/mailboxes/:id/delete', async (req, reply) => {
    const id = Number(req.params.id);
    clearTransport(id);
    await query('DELETE FROM mailboxes WHERE id=$1', [id]);
    return reply.redirect('/admin/mailboxes?flash=deleted');
  });

  app.post('/admin/mailboxes/:id/verify', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT m.*, p.display_name AS persona_name FROM mailboxes m
       LEFT JOIN personas p ON p.id = m.persona_id WHERE m.id = $1`, [id]);
    const mailbox = rows[0];
    if (!mailbox) return reply.redirect('/admin/mailboxes?flash=missing');
    try {
      await verifyMailbox(mailbox);
      return reply.redirect(`/admin/mailboxes?flash=verified_${id}`);
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/admin/mailboxes?flash=verify_failed_${id}&err=${msg}`);
    }
  });

  app.post('/admin/mailboxes/:id/test-send', async (req, reply) => {
    const id = Number(req.params.id);
    const recipient = (req.body.recipient || req.user.email || '').trim();
    if (!recipient) return reply.redirect('/admin/mailboxes?flash=missing_recipient');

    const { rows } = await query(
      `SELECT m.*, p.display_name AS persona_name, p.signature_html AS persona_signature
       FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id WHERE m.id = $1`, [id]);
    const mailbox = rows[0];
    if (!mailbox) return reply.redirect('/admin/mailboxes?flash=missing');

    const html = `
      <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
        <p>This is a deliverability test from vrtcls.marketing.</p>
        <p>Mailbox: <strong>${mailbox.label}</strong> (<code>${mailbox.smtp_user}</code>)</p>
        <p>Persona: <strong>${mailbox.persona_name || '(none)'}</strong></p>
        ${mailbox.persona_signature || ''}
      </div>`;
    try {
      await sendViaMailbox({
        mailbox,
        to: recipient,
        subject: `vrtcls test send — ${mailbox.label}`,
        html,
      });
      return reply.redirect(`/admin/mailboxes?flash=test_sent_${id}`);
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/admin/mailboxes?flash=test_failed_${id}&err=${msg}`);
    }
  });

  // ==========================================================================
  // Send-test for admin templates
  // ==========================================================================
  app.post('/admin/templates/:id/send-test', async (req, reply) => {
    const id = Number(req.params.id);
    const recipient = (req.body.recipient || req.user.email || '').trim();
    const mailboxId = req.body.mailbox_id ? Number(req.body.mailbox_id) : null;
    try {
      await sendTestToSelf({ userId: req.user.id, templateId: id, mailboxId, recipient });
      return reply.redirect('/admin/templates?flash=test_sent');
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/admin/templates?flash=test_failed&err=${msg}`);
    }
  });

  // ==========================================================================
  // Inbox — unified read + reply across every persona's Gmail seat (IMAP).
  // ==========================================================================

  app.get('/admin/inbox', async (req, reply) => {
    const { rows: mailboxes } = await query(`
      SELECT m.id, m.label, m.smtp_user, m.inbox_last_synced, m.status,
             p.display_name AS persona_name, p.avatar_url,
             (SELECT COUNT(*)::int FROM inbox_messages im WHERE im.mailbox_id=m.id) AS total,
             (SELECT COUNT(*)::int FROM inbox_messages im WHERE im.mailbox_id=m.id AND im.read_at IS NULL) AS unread
        FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
       ORDER BY p.display_name NULLS LAST, m.label
    `);
    const activeId = req.query.mailbox_id ? Number(req.query.mailbox_id) : (mailboxes[0]?.id || null);
    let messages = [];
    let activeMailbox = null;
    if (activeId) {
      activeMailbox = mailboxes.find((m) => m.id === activeId) || null;
      const { rows } = await query(`
        SELECT id, from_address, from_name, subject, snippet,
               received_at, read_at, replied_at
          FROM inbox_messages
         WHERE mailbox_id = $1
         ORDER BY received_at DESC
         LIMIT 200
      `, [activeId]);
      messages = rows;
    }
    return reply.view('admin/inbox', {
      user: req.user,
      mailboxes,
      activeMailbox,
      messages,
      flash: req.query.flash || null,
      flashErr: req.query.err || null,
    });
  });

  app.post('/admin/inbox/:mailboxId/refresh', async (req, reply) => {
    const id = Number(req.params.mailboxId);
    const { rows } = await query('SELECT * FROM mailboxes WHERE id=$1', [id]);
    const mailbox = rows[0];
    if (!mailbox) return reply.redirect('/admin/inbox?flash=missing');
    try {
      const { fetched, inserted } = await syncMailboxInbox(mailbox);
      return reply.redirect(`/admin/inbox?mailbox_id=${id}&flash=synced_${fetched}_${inserted}`);
    } catch (err) {
      const msg = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/admin/inbox?mailbox_id=${id}&flash=sync_failed&err=${msg}`);
    }
  });

  app.get('/admin/inbox/messages/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(`
      SELECT im.*, m.label AS mailbox_label, m.smtp_user, m.id AS mailbox_id,
             p.display_name AS persona_name, p.signature_html AS persona_signature
        FROM inbox_messages im
        JOIN mailboxes m ON m.id = im.mailbox_id
        LEFT JOIN personas p ON p.id = m.persona_id
       WHERE im.id = $1
    `, [id]);
    const message = rows[0];
    if (!message) return reply.code(404).send('Not found');
    if (!message.read_at) {
      const { rows: mb } = await query('SELECT * FROM mailboxes WHERE id=$1', [message.mailbox_id]);
      markMessageRead(mb[0], id).catch(() => {});
    }
    return reply.view('admin/inbox_message', {
      user: req.user,
      message,
      flash: req.query.flash || null,
      flashErr: req.query.err || null,
    });
  });

  app.post('/admin/inbox/messages/:id/reply', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows: msgRows } = await query(`
      SELECT im.*, m.* , m.id AS mailbox_id_real
        FROM inbox_messages im JOIN mailboxes m ON m.id = im.mailbox_id
       WHERE im.id = $1
    `, [id]);
    const r = msgRows[0];
    if (!r) return reply.code(404).send('Not found');

    const subject = (req.body.subject || `Re: ${r.subject || ''}`).slice(0, 400);
    const bodyHtml = String(req.body.body_html || '').slice(0, 200000);
    const to = r.from_address;
    if (!to) return reply.redirect(`/admin/inbox/messages/${id}?flash=no_from`);

    const mailbox = {
      id: r.mailbox_id_real, smtp_user: r.smtp_user, smtp_pass: r.smtp_pass,
      smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_secure: r.smtp_secure,
      daily_cap: r.daily_cap, sends_today: r.sends_today, last_send_at: r.last_send_at,
      status: r.status,
      // For the From-name on the reply, the sendViaMailbox helper looks at persona_name.
      persona_name: (await query('SELECT display_name FROM personas WHERE id=$1', [r.persona_id])).rows[0]?.display_name || null,
    };

    const headers = {};
    if (r.message_id) {
      headers['In-Reply-To'] = r.message_id;
      headers['References'] = r.message_id;
    }

    try {
      await sendViaMailbox({ mailbox, to, subject, html: bodyHtml, headers });
      await query(`UPDATE inbox_messages SET replied_at = NOW() WHERE id=$1`, [id]);
      return reply.redirect(`/admin/inbox/messages/${id}?flash=replied`);
    } catch (err) {
      const m = encodeURIComponent(String(err.message || err).slice(0, 200));
      return reply.redirect(`/admin/inbox/messages/${id}?flash=reply_failed&err=${m}`);
    }
  });

  app.post('/admin/inbox/messages/:id/read', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(`
      SELECT im.id, im.mailbox_id, m.* FROM inbox_messages im
        JOIN mailboxes m ON m.id = im.mailbox_id WHERE im.id = $1
    `, [id]);
    if (!rows[0]) return reply.redirect('/admin/inbox?flash=missing');
    await markMessageRead(rows[0], id);
    return reply.redirect(`/admin/inbox?mailbox_id=${rows[0].mailbox_id}`);
  });

  // ---- Zapmail integration ---------------------------------------------------
  app.get('/admin/zapmail', async (req, reply) => {
    const configured = zapmail.isConfigured();
    let remote = null, wallet = null, domains = null, err = null;
    if (configured) {
      try { remote = await zapmail.listMailboxes(); } catch (e) { err = e.message; }
      try { wallet = await zapmail.getWalletBalance(); } catch {}
      try { domains = await zapmail.listDomains(); } catch {}
    }
    const { rows: local } = await query(`
      SELECT m.id, m.label, m.smtp_user, m.status, m.persona_id, m.zapmail_id,
             p.display_name AS persona_name
      FROM mailboxes m LEFT JOIN personas p ON p.id = m.persona_id
      ORDER BY m.id
    `);
    return reply.view('admin/zapmail', {
      user: req.user, configured, remote, wallet, domains, local,
      flash: req.query.flash || null, flashErr: req.query.err || err || null,
    });
  });

  app.post('/admin/zapmail/sync', async (req, reply) => {
    if (!zapmail.isConfigured()) return reply.redirect('/admin/zapmail?flash=not_configured');
    try {
      const remote = await zapmail.listMailboxes();
      const list = Array.isArray(remote) ? remote : (remote?.data || remote?.mailboxes || []);
      let upserted = 0;
      for (const mb of list) {
        const email = mb.email || mb.username || mb.smtpUser;
        if (!email) continue;
        const zid = String(mb.id || mb._id || '');
        const status = (mb.status || '').toLowerCase() === 'active' ? 'active' : 'paused';
        // Match by email (smtp_user); update zapmail_id + remote status. Don't overwrite smtp_pass here.
        const r = await query(
          `UPDATE mailboxes SET zapmail_id = $1, label = COALESCE(NULLIF($2,''), label)
             WHERE smtp_user = $3 RETURNING id`,
          [zid, mb.label || `${email} (Zapmail)`, email]
        );
        if (r.rowCount === 0) {
          await query(
            `INSERT INTO mailboxes (owner_user_id, label, smtp_user, smtp_pass, daily_cap, status, zapmail_id)
             VALUES ($1, $2, $3, 'PASTE_APP_PASSWORD', 50, 'paused', $4)`,
            [req.session.userId, `${email} (Zapmail)`, email, zid]
          );
        }
        upserted++;
      }
      return reply.redirect(`/admin/zapmail?flash=synced&n=${upserted}`);
    } catch (e) {
      const m = encodeURIComponent(String(e.message || e).slice(0, 240));
      return reply.redirect(`/admin/zapmail?flash=sync_failed&err=${m}`);
    }
  });

  app.post('/admin/zapmail/upload-csv', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send('multipart required');
    let csvText = null;
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'csv') {
        const chunks = [];
        for await (const c of part.file) chunks.push(c);
        csvText = Buffer.concat(chunks).toString('utf8');
      }
    }
    if (!csvText) return reply.redirect('/admin/zapmail?flash=no_csv');

    const rows = parseCsv(csvText);
    let updated = 0, inserted = 0, skipped = 0;
    for (const r of rows) {
      const email = pick(r, 'email', 'smtp username', 'smtp_user', 'username');
      const pass  = pick(r, 'app password', 'smtp password', 'password', 'smtp_pass');
      const smtpHost = pick(r, 'smtp host', 'smtp_host') || 'smtp.gmail.com';
      const smtpPort = Number(pick(r, 'smtp port', 'smtp_port') || 587);
      const imapHost = pick(r, 'imap host', 'imap_host') || 'imap.gmail.com';
      const imapPort = Number(pick(r, 'imap port', 'imap_port') || 993);
      if (!email || !pass) { skipped++; continue; }
      const cleanPass = pass.replace(/\s+/g, '');
      const u = await query(
        `UPDATE mailboxes
           SET smtp_pass = $1, smtp_host = $2, smtp_port = $3,
               imap_host = $4, imap_port = $5, status = 'active'
           WHERE smtp_user = $6 RETURNING id`,
        [cleanPass, smtpHost, smtpPort, imapHost, imapPort, email]
      );
      if (u.rowCount > 0) { updated++; clearTransport(u.rows[0].id); }
      else {
        await query(
          `INSERT INTO mailboxes (owner_user_id, label, smtp_user, smtp_pass,
                                  smtp_host, smtp_port, imap_host, imap_port, daily_cap, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 50, 'active')`,
          [req.session.userId, `${email} (Zapmail)`, email, cleanPass, smtpHost, smtpPort, imapHost, imapPort]
        );
        inserted++;
      }
    }
    return reply.redirect(`/admin/zapmail?flash=csv_imported&u=${updated}&i=${inserted}&s=${skipped}`);
  });

  app.post('/admin/zapmail/trigger-export', async (req, reply) => {
    if (!zapmail.isConfigured()) return reply.redirect('/admin/zapmail?flash=not_configured');
    try {
      const r = await zapmail.triggerManualExport({ status: 'ACTIVE' });
      const note = encodeURIComponent(JSON.stringify(r).slice(0, 240));
      return reply.redirect(`/admin/zapmail?flash=export_triggered&err=${note}`);
    } catch (e) {
      const m = encodeURIComponent(String(e.message || e).slice(0, 240));
      return reply.redirect(`/admin/zapmail?flash=export_failed&err=${m}`);
    }
  });
}
