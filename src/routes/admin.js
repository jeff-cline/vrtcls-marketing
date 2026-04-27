import { query, tx } from '../db.js';
import { requireAdmin, findUserById } from '../auth.js';
import { grantCredits, grantTokens } from '../services/credits.js';
import { sendOne, sendTransactional, sendTestToSelf } from '../services/email.js';
import { enqueueCampaignSends } from '../services/queue.js';
import { ingestPersons } from '../services/personImport.js';
import { verifyMailbox, sendViaMailbox, clearTransport } from '../services/smtpSender.js';
import { syncMailboxInbox, markMessageRead } from '../services/imapReader.js';
import { parseLeadsXlsx, ingestXlsxPersons } from '../services/xlsxImport.js';
import * as zapmail from '../services/zapmail.js';
import { config } from '../config.js';
import { ImapFlow } from 'imapflow';

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

  // Drag-and-drop xlsx import — parses the first sheet that has contact-shaped
  // columns and upserts leads. Tag/audience-label come from form fields.
  app.post('/admin/import/xlsx', async (req, reply) => {
    let buf = null;
    let tagField = null;
    let labelField = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'file') {
        const chunks = [];
        for await (const c of part.file) chunks.push(c);
        buf = Buffer.concat(chunks);
      } else if (part.type === 'field') {
        if (part.fieldname === 'tag') tagField = String(part.value || '').trim();
        if (part.fieldname === 'label') labelField = String(part.value || '').trim();
      }
    }
    if (!buf) {
      return reply.view('admin/import', { user: req.user, result: { error: 'No file uploaded.' } });
    }
    try {
      const persons = parseLeadsXlsx(buf);
      if (!persons.length) {
        return reply.view('admin/import', {
          user: req.user,
          result: { error: 'No contact rows found. Expected columns include Full Name, Email/Emails, City, State, ZIP.' },
        });
      }
      const result = await ingestXlsxPersons({
        persons,
        importedBy: req.user.id,
        audienceLabel: labelField || null,
        extraTag: tagField || null,
      });
      return reply.view('admin/import', {
        user: req.user,
        result: { ...result, sourceRows: persons.length, mode: 'xlsx' },
      });
    } catch (err) {
      return reply.view('admin/import', {
        user: req.user,
        result: { error: `Parse failed: ${String(err.message || err).slice(0, 200)}` },
      });
    }
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
    const { rows: mailboxes } = await query(
      `SELECT id, label, smtp_user, status FROM mailboxes WHERE status='active' ORDER BY label`
    );
    return reply.view('admin/send', {
      user: req.user, users, templates, tags, mailboxes,
      flashErr: req.query.err || null,
      preserved: {
        target_user_id: req.query.target_user_id || '',
        template_id: req.query.template_id || '',
        tag: req.query.tag || '',
        campaign_name: req.query.campaign_name || '',
        pacing: req.query.pacing || 'auto',
      },
    });
  });

  // POST /admin/send — Pre-flight, enqueue, redirect to live campaign page.
  // Three big behavior changes from the old route:
  //   1. We never block the request on SMTP. Sends are queued with proper pacing
  //      (sends-per-persona-per-day across active mailboxes) and the queue worker
  //      drains them in the background.
  //   2. Validation errors round-trip to the form with a visible message + the
  //      admin's previous selections preserved, so they can fix and resubmit.
  //   3. On success we redirect to /admin/campaigns/:id which shows live counters
  //      (queued / sending / sent / failed / skipped) plus the pre-flight
  //      breakdown of which leads were excluded and why.
  app.post('/admin/send', async (req, reply) => {
    const targetUserId = Number(req.body.target_user_id) || null;
    const templateId   = Number(req.body.template_id) || null;
    const tag          = (req.body.tag || '').trim();
    const name         = (req.body.campaign_name || 'Admin send').slice(0, 200);
    const useUserCredits = req.body.use_user_credits === 'on';
    // Pacing toggle: 'auto' = bypass when audience is small, 'force' = always
    // bypass, 'paced' = always pace through the daily window.
    const pacing = (req.body.pacing || 'auto').toString();

    function bounceBack(err) {
      const params = new URLSearchParams({
        err,
        target_user_id: String(targetUserId || ''),
        template_id: String(templateId || ''),
        tag,
        campaign_name: name,
        pacing,
      });
      return reply.redirect('/admin/send?' + params.toString());
    }

    if (!templateId)               return bounceBack('Pick a template before sending.');
    if (!targetUserId && !tag)     return bounceBack('Pick a target user OR enter a tag — otherwise there is no audience.');

    const { rows: tplCheck } = await query('SELECT id FROM email_templates WHERE id=$1', [templateId]);
    if (!tplCheck.length) return bounceBack('That template no longer exists.');

    // Pre-flight: count what matched, what we'd skip, and why. Same JOIN strategy
    // as the actual lead lookup so the numbers reconcile exactly.
    const params = [];
    let baseFrom;
    if (tag) {
      params.push(tag);
      const tagIdx = params.length;
      let userJoin = '';
      if (targetUserId) {
        params.push(targetUserId);
        userJoin = `JOIN lead_purchases lp ON lp.lead_id = l.id AND lp.user_id = $${params.length}`;
      }
      baseFrom = `FROM leads l JOIN lead_tags lt ON lt.lead_id = l.id ${userJoin} WHERE lt.tag = $${tagIdx}`;
    } else {
      params.push(targetUserId);
      baseFrom = `FROM leads l JOIN lead_purchases lp ON lp.lead_id = l.id AND lp.user_id = $${params.length}`;
    }
    const { rows: pre } = await query(
      `SELECT
         COUNT(*)::int                                                          AS matched,
         SUM((l.email IS NULL)::int)::int                                        AS no_email,
         SUM((l.dnc)::int)::int                                                  AS dnc,
         SUM((LOWER(l.email) IN (SELECT email FROM suppressions))::int)::int     AS suppressed,
         COUNT(*) FILTER (WHERE l.email IS NOT NULL AND NOT l.dnc
                            AND LOWER(l.email) NOT IN (SELECT email FROM suppressions))::int AS deliverable
         ${baseFrom}`,
      params
    );
    const counts = pre[0] || { matched: 0, no_email: 0, dnc: 0, suppressed: 0, deliverable: 0 };

    if (counts.matched === 0) return bounceBack('No leads matched those filters. Check the tag or pick a different user.');
    if (counts.deliverable === 0) {
      return bounceBack(`Matched ${counts.matched} lead(s), but every one was excluded (no email / DNC / suppressed). Nothing to send.`);
    }

    const { rows: leadRows } = await query(
      `SELECT DISTINCT l.id ${baseFrom}
         AND l.email IS NOT NULL AND NOT l.dnc
         AND LOWER(l.email) NOT IN (SELECT email FROM suppressions)
         LIMIT 5000`,
      params
    );
    const leadIds = leadRows.map((r) => r.id);

    const { rows: activeMb } = await query(
      `SELECT id, persona_id FROM mailboxes WHERE status='active' ORDER BY id`
    );
    if (!activeMb.length) {
      return bounceBack('No active mailboxes — provision at least one in Mailboxes before sending.');
    }

    const senderUserId = useUserCredits && targetUserId ? targetUserId : req.user.id;
    const { rows: cam } = await query(
      `INSERT INTO campaigns (user_id, template_id, name, status, sends_per_persona_per_day, send_window_start_hour, send_window_end_hour)
       VALUES ($1, $2, $3, 'sending', 50, 9, 18) RETURNING *`,
      [senderUserId, templateId, name]
    );
    const campaign = cam[0];

    const immediate = pacing === 'force' || (pacing === 'auto' && leadIds.length <= 25);
    try {
      await enqueueCampaignSends({
        campaign, leadIds, mailboxes: activeMb, userId: senderUserId, immediate,
      });
    } catch (err) {
      req.log.error({ err }, 'enqueue failed');
      await query(`UPDATE campaigns SET status='draft' WHERE id=$1`, [campaign.id]);
      return bounceBack(`Could not queue: ${err.message || err}`);
    }

    const preflight = {
      matched: counts.matched, queued: leadIds.length,
      no_email: counts.no_email || 0, dnc: counts.dnc || 0,
      suppressed: counts.suppressed || 0,
      mailboxes: activeMb.length,
      immediate,
    };
    const enc = encodeURIComponent(JSON.stringify(preflight));
    return reply.redirect(`/admin/campaigns/${campaign.id}?preflight=${enc}`);
  });

  // ==========================================================================
  // Campaign status — live view of an enqueued send. Auto-refreshes every 5s
  // while there are queued/sending rows so admins watch progress in real time.
  // ==========================================================================

  app.get('/admin/campaigns/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(404).send('Not found');
    const { rows: cRows } = await query(
      `SELECT c.*, t.name AS template_name, t.subject AS template_subject,
              u.email AS owner_email
         FROM campaigns c
         LEFT JOIN email_templates t ON t.id = c.template_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [id]
    );
    const campaign = cRows[0];
    if (!campaign) return reply.code(404).send('Campaign not found');

    const { rows: stats } = await query(
      `SELECT
         COUNT(*)                                          AS total,
         COUNT(*) FILTER (WHERE status='queued')           AS queued,
         COUNT(*) FILTER (WHERE status='sending')          AS sending,
         COUNT(*) FILTER (WHERE status='sent')             AS sent,
         COUNT(*) FILTER (WHERE status='failed')           AS failed,
         COUNT(*) FILTER (WHERE status='skipped')          AS skipped,
         COUNT(*) FILTER (WHERE status='suppressed')       AS suppressed,
         MIN(scheduled_for) FILTER (WHERE status='queued') AS next_send_at,
         MAX(scheduled_for) FILTER (WHERE status='queued') AS last_send_at,
         MIN(sent_at)                                      AS first_sent_at,
         MAX(sent_at)                                      AS last_sent_at,
         (SELECT COUNT(*)::int FROM click_events ce JOIN sends s ON s.id = ce.send_id WHERE s.campaign_id = $1) AS clicks
         FROM sends WHERE campaign_id = $1`,
      [id]
    );
    const s = stats[0] || {};
    const pending = Number(s.queued || 0) + Number(s.sending || 0);

    const { rows: recent } = await query(
      `SELECT s.id, s.status, s.scheduled_for, s.sent_at, s.error,
              l.email, l.first_name, l.last_name,
              p.display_name AS persona_name,
              (SELECT COUNT(*)::int FROM click_events ce WHERE ce.send_id = s.id) AS clicks
         FROM sends s
         LEFT JOIN leads l ON l.id = s.lead_id
         LEFT JOIN personas p ON p.id = s.persona_id
        WHERE s.campaign_id = $1
        ORDER BY s.scheduled_for ASC NULLS LAST, s.id ASC
        LIMIT 200`,
      [id]
    );

    let preflight = null;
    if (req.query.preflight) {
      try { preflight = JSON.parse(decodeURIComponent(req.query.preflight)); } catch (_) {}
    }

    return reply.view('admin/campaign_detail', {
      user: req.user, campaign, stats: s, recent, preflight, pending,
    });
  });

  app.post('/admin/campaigns/:id/pause', async (req, reply) => {
    const id = Number(req.params.id);
    await query(`UPDATE campaigns SET status='paused' WHERE id=$1 AND status IN ('sending','scheduled')`, [id]);
    return reply.redirect(`/admin/campaigns/${id}`);
  });
  app.post('/admin/campaigns/:id/resume', async (req, reply) => {
    const id = Number(req.params.id);
    await query(`UPDATE campaigns SET status='sending' WHERE id=$1 AND status='paused'`, [id]);
    return reply.redirect(`/admin/campaigns/${id}`);
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

    // Default tab is "all" — combined view across every persona's mailbox.
    const raw = req.query.mailbox_id;
    const isAll = !raw || raw === 'all';
    const activeId = isAll ? null : String(raw);

    let messages = [];
    let activeMailbox = null;

    if (isAll) {
      const { rows } = await query(`
        SELECT im.id, im.from_address, im.from_name, im.subject, im.snippet,
               im.received_at, im.read_at, im.replied_at,
               im.mailbox_id, m.smtp_user AS mailbox_email,
               p.display_name AS persona_name
          FROM inbox_messages im
          JOIN mailboxes m ON m.id = im.mailbox_id
          LEFT JOIN personas p ON p.id = m.persona_id
         ORDER BY im.received_at DESC
         LIMIT 300
      `);
      messages = rows;
    } else {
      activeMailbox = mailboxes.find((m) => String(m.id) === activeId) || null;
      if (activeMailbox) {
        const { rows } = await query(`
          SELECT id, from_address, from_name, subject, snippet,
                 received_at, read_at, replied_at
            FROM inbox_messages
           WHERE mailbox_id = $1
           ORDER BY received_at DESC
           LIMIT 200
        `, [activeMailbox.id]);
        messages = rows;
      }
    }

    return reply.view('admin/inbox', {
      user: req.user,
      mailboxes,
      activeMailbox,
      isAll,
      messages,
      flash: req.query.flash || null,
      flashErr: req.query.err || null,
    });
  });

  // Test every active mailbox end-to-end (SMTP login + IMAP login). Returns
  // a JSON report so the inbox page can render OK/FAIL per mailbox.
  app.post('/admin/inbox/test-all', async (req, reply) => {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE status='active' ORDER BY id`);
    const results = [];
    for (const m of rows) {
      const out = { id: m.id, smtp_user: m.smtp_user, smtp: 'pending', imap: 'pending' };
      try {
        await verifyMailbox(m);
        out.smtp = 'ok';
      } catch (e) {
        out.smtp = 'fail';
        out.smtp_err = String(e.message || e).slice(0, 160);
      }
      try {
        const c = new ImapFlow({
          host: m.imap_host || 'imap.gmail.com',
          port: m.imap_port || 993,
          secure: m.imap_secure !== false,
          auth: { user: m.smtp_user, pass: m.smtp_pass },
          logger: false,
          connectionTimeout: 20000,
          greetingTimeout: 15000,
          socketTimeout: 25000,
        });
        await c.connect();
        const lock = await c.getMailboxLock('INBOX');
        try {
          const status = await c.status('INBOX', { messages: true });
          out.imap = 'ok';
          out.imap_count = status.messages || 0;
        } finally { lock.release(); }
        await c.logout().catch(() => {});
      } catch (e) {
        out.imap = 'fail';
        out.imap_err = String(e.message || e).slice(0, 160);
      }
      results.push(out);
    }
    return reply.send({ results });
  });

  app.post('/admin/inbox/refresh-all', async (req, reply) => {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE status = 'active' ORDER BY id`);
    let totalFetched = 0, totalInserted = 0, failures = [];
    for (const mailbox of rows) {
      try {
        const { fetched, inserted } = await syncMailboxInbox(mailbox);
        totalFetched += fetched; totalInserted += inserted;
      } catch (err) {
        failures.push(`${mailbox.smtp_user}: ${String(err.message || err).slice(0, 80)}`);
      }
    }
    const flash = `synced_all_${totalFetched}_${totalInserted}`;
    if (failures.length) {
      const e = encodeURIComponent(failures.join(' | ').slice(0, 400));
      return reply.redirect(`/admin/inbox?flash=${flash}&err=${e}`);
    }
    return reply.redirect(`/admin/inbox?flash=${flash}`);
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

  // ==========================================================================
  // Customers — every lead is a customer record. The person_id (stable hash of
  // email + name + zip) is the customer number; xlsx re-uploads upsert against
  // it so duplicate signal accumulates (tags, sends, clicks) instead of forking.
  // ==========================================================================

  app.get('/admin/customers', async (req, reply) => {
    const q = (req.query.q || '').trim();
    const tagFilter = (req.query.tag || '').trim();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const params = [];
    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(l.email ILIKE $${params.length} OR l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.person_id ILIKE $${params.length})`);
    }
    if (tagFilter) {
      params.push(tagFilter);
      where.push(`EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag = $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await query(
      `SELECT l.id, l.person_id, l.email, l.phone, l.first_name, l.last_name,
              l.address, l.dnc, l.first_seen, l.last_seen,
              (SELECT COUNT(*)::int FROM lead_tags lt WHERE lt.lead_id = l.id) AS tag_count,
              (SELECT COUNT(*)::int FROM sends s WHERE s.lead_id = l.id) AS send_count,
              (SELECT COUNT(*)::int FROM click_events ce JOIN sends s ON s.id = ce.send_id WHERE s.lead_id = l.id) AS click_count,
              (SELECT MAX(ce.created_at) FROM click_events ce JOIN sends s ON s.id = ce.send_id WHERE s.lead_id = l.id) AS last_click_at
         FROM leads l
         ${whereSql}
         ORDER BY l.last_seen DESC
         LIMIT $${params.length}`,
      params
    );
    const { rows: stats } = await query(
      `SELECT
         (SELECT COUNT(*)::bigint FROM leads) AS total_customers,
         (SELECT COUNT(*)::bigint FROM lead_tags) AS total_tags,
         (SELECT COUNT(*)::bigint FROM sends) AS total_sends,
         (SELECT COUNT(*)::bigint FROM click_events) AS total_clicks`
    );
    const { rows: topTags } = await query(
      `SELECT tag, COUNT(*)::int AS lead_count
         FROM lead_tags GROUP BY tag ORDER BY lead_count DESC LIMIT 30`
    );
    return reply.view('admin/customers', {
      user: req.user, customers: rows, stats: stats[0] || {},
      topTags, q, tagFilter, limit,
    });
  });

  app.get('/admin/customers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(404).send('Not found');
    const { rows: leadRows } = await query('SELECT * FROM leads WHERE id = $1', [id]);
    const lead = leadRows[0];
    if (!lead) return reply.code(404).send('Customer not found');

    const { rows: tags } = await query(
      `SELECT tag, source, created_at FROM lead_tags WHERE lead_id = $1 ORDER BY created_at DESC`, [id]
    );
    const { rows: audiences } = await query(
      `SELECT a.id, a.workflow_id, a.total_count, a.created_at
         FROM audience_leads al JOIN audiences a ON a.id = al.audience_id
        WHERE al.lead_id = $1 ORDER BY a.created_at DESC`, [id]
    );
    const { rows: sends } = await query(
      `SELECT s.id, s.status, s.sent_at, s.opened_at, s.error,
              c.name AS campaign_name, et.name AS template_name,
              p.display_name AS persona_name, m.smtp_user AS mailbox_email,
              (SELECT COUNT(*)::int FROM click_events ce WHERE ce.send_id = s.id) AS clicks
         FROM sends s
         LEFT JOIN campaigns c ON c.id = s.campaign_id
         LEFT JOIN email_templates et ON et.id = c.template_id
         LEFT JOIN personas p ON p.id = s.persona_id
         LEFT JOIN mailboxes m ON m.id = s.mailbox_id
        WHERE s.lead_id = $1 ORDER BY s.created_at DESC LIMIT 100`, [id]
    );
    const { rows: clicks } = await query(
      `SELECT ce.link_key, ce.destination, ce.created_at, s.id AS send_id
         FROM click_events ce JOIN sends s ON s.id = ce.send_id
        WHERE s.lead_id = $1 ORDER BY ce.created_at DESC LIMIT 200`, [id]
    );
    const { rows: keywordIntent } = await query(
      `SELECT ce.link_key, COUNT(*)::int AS clicks, MAX(ce.created_at) AS last_clicked
         FROM click_events ce JOIN sends s ON s.id = ce.send_id
        WHERE s.lead_id = $1
        GROUP BY ce.link_key ORDER BY clicks DESC, last_clicked DESC`, [id]
    );

    return reply.view('admin/customer_detail', {
      user: req.user, lead, tags, audiences, sends, clicks, keywordIntent,
    });
  });

  // ==========================================================================
  // Keyword cloud — every tag + every link_key, weighted by clicks. The richer
  // the click history, the bigger the keyword renders.
  // ==========================================================================

  app.get('/admin/keywords', async (req, reply) => {
    const { rows: tagCloud } = await query(
      `SELECT lt.tag AS keyword,
              COUNT(DISTINCT lt.lead_id)::int AS leads,
              COALESCE((
                SELECT COUNT(*)::int FROM click_events ce
                  JOIN sends s ON s.id = ce.send_id
                  JOIN lead_tags lt2 ON lt2.lead_id = s.lead_id
                 WHERE lt2.tag = lt.tag
              ), 0) AS clicks
         FROM lead_tags lt
         GROUP BY lt.tag
         ORDER BY clicks DESC, leads DESC
         LIMIT 200`
    );
    const { rows: linkCloud } = await query(
      `SELECT link_key AS keyword, COUNT(*)::int AS clicks,
              COUNT(DISTINCT s.lead_id)::int AS leads
         FROM click_events ce JOIN sends s ON s.id = ce.send_id
         GROUP BY link_key
         ORDER BY clicks DESC LIMIT 200`
    );
    const { rows: cooccur } = await query(
      `SELECT a.tag AS tag_a, b.tag AS tag_b, COUNT(*)::int AS shared
         FROM lead_tags a JOIN lead_tags b ON a.lead_id = b.lead_id AND a.tag < b.tag
         GROUP BY a.tag, b.tag
         HAVING COUNT(*) > 1
         ORDER BY shared DESC LIMIT 50`
    );
    return reply.view('admin/keywords', {
      user: req.user, tagCloud, linkCloud, cooccur,
    });
  });

  // ==========================================================================
  // Cross-market engine — keywords with click momentum: today / 7d / 30d, with
  // the network-wide leaderboard so "what's heating up" stays visible.
  // ==========================================================================

  app.get('/admin/cross-market', async (req, reply) => {
    async function trending(interval) {
      const { rows } = await query(
        `SELECT ce.link_key AS keyword, COUNT(*)::int AS clicks,
                COUNT(DISTINCT s.lead_id)::int AS leads
           FROM click_events ce JOIN sends s ON s.id = ce.send_id
          WHERE ce.created_at >= NOW() - $1::interval
          GROUP BY ce.link_key
          ORDER BY clicks DESC LIMIT 50`,
        [interval]
      );
      return rows;
    }
    const today = await trending('1 day');
    const week = await trending('7 days');
    const month = await trending('30 days');
    const { rows: top100 } = await query(
      `SELECT ce.link_key AS keyword, COUNT(*)::int AS clicks,
              COUNT(DISTINCT s.lead_id)::int AS leads,
              MIN(ce.created_at) AS first_click,
              MAX(ce.created_at) AS last_click
         FROM click_events ce JOIN sends s ON s.id = ce.send_id
         GROUP BY ce.link_key
         ORDER BY clicks DESC LIMIT 100`
    );
    const { rows: traffic } = await query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS clicks
         FROM click_events
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1`
    );
    return reply.view('admin/cross_market', {
      user: req.user, today, week, month, top100, traffic,
    });
  });

  // ==========================================================================
  // Value report — admin-only $ estimate. Click ≈ qualified lead. Conservative
  // dollar value per click is configurable; defaults assume $25 EPC.
  // ==========================================================================

  app.get('/admin/value-report', async (req, reply) => {
    const valuePerClick = Number(req.query.epc || 25);
    const { rows: byKeyword } = await query(
      `SELECT ce.link_key AS keyword, COUNT(*)::int AS clicks,
              COUNT(DISTINCT s.lead_id)::int AS leads
         FROM click_events ce JOIN sends s ON s.id = ce.send_id
         GROUP BY ce.link_key ORDER BY clicks DESC LIMIT 100`
    );
    const { rows: byCustomer } = await query(
      `SELECT l.id, l.person_id, l.email, l.first_name, l.last_name,
              COUNT(ce.id)::int AS clicks
         FROM leads l
         JOIN sends s ON s.lead_id = l.id
         JOIN click_events ce ON ce.send_id = s.id
        GROUP BY l.id ORDER BY clicks DESC LIMIT 100`
    );
    const { rows: totals } = await query(
      `SELECT
         (SELECT COUNT(*)::bigint FROM click_events) AS clicks,
         (SELECT COUNT(*)::bigint FROM sends) AS sends,
         (SELECT COUNT(*)::bigint FROM leads) AS customers`
    );
    return reply.view('admin/value_report', {
      user: req.user, valuePerClick, byKeyword, byCustomer, totals: totals[0] || {},
    });
  });
}
