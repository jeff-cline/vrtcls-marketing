import { query, tx } from '../db.js';
import { requireAdmin } from '../auth.js';
import { grantCredits } from '../services/credits.js';

export default async function adminRoutes(app) {
  app.addHook('preHandler', requireAdmin);

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
}
