import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { sendTransactional } from '../services/email.js';

async function pingAdminOnNewHitt(hitt, userEmail) {
  if (!config.hitt.notifyAdminOnNew) return;
  if (!config.hitt.adminNotifyEmail) return;
  const subject = `New HITT request from ${userEmail} — "${hitt.label}"`;
  const html = `
    <h2>New customer request</h2>
    <p><strong>Customer:</strong> ${userEmail}</p>
    <p><strong>Label:</strong> ${hitt.label}</p>
    <p><strong>Prompt:</strong> ${hitt.prompt}</p>
    <p><strong>Geo:</strong> ${hitt.city || 'national'}${hitt.state ? ', ' + hitt.state : ''} · ${hitt.radius_miles} mi · up to ${hitt.audience_limit} people</p>
    <p>
      <a href="${config.baseUrl}/admin/hitt"
         style="display:inline-block;padding:10px 18px;background:#ffc107;color:#000;text-decoration:none;border-radius:4px;font-weight:bold">
        Open Customer Requests
      </a>
    </p>
  `;
  await sendTransactional({ to: config.hitt.adminNotifyEmail, subject, html });
}

export default async function hittRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // Submit a new HITT request. With auto-bake disabled (default), this stays
  // in 'queued' until an admin fulfills via /admin/hitt. With auto-bake
  // enabled and WATTDATA_API_KEY set, the worker picks it up.
  app.post('/app/hitt', async (req, reply) => {
    const label = (req.body.label || '').trim().slice(0, 200);
    const prompt = (req.body.prompt || '').trim().slice(0, 1000);
    const city = (req.body.city || '').trim().slice(0, 100);
    const state = (req.body.state || '').trim().slice(0, 50);
    const zip = (req.body.zip || '').trim().slice(0, 20);
    const radiusMiles = Math.max(1, Math.min(500, Number(req.body.radius_miles) || 25));
    const audienceLimit = Math.max(50, Math.min(15000, Number(req.body.audience_limit) || 500));

    if (!label || !prompt) return reply.redirect('/app?hitt_error=missing');

    const initialStatus = config.hitt.autoBakeEnabled ? 'baking' : 'queued';
    const { rows } = await query(
      `INSERT INTO hitt_requests
         (user_id, label, prompt, city, state, zip, radius_miles, audience_limit, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9='baking' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [req.user.id, label, prompt, city, state, zip, radiusMiles, audienceLimit, initialStatus]
    );

    pingAdminOnNewHitt(rows[0], req.user.email).catch((err) =>
      req.log.warn({ err }, 'admin notify failed')
    );

    return reply.redirect(`/app/hitt/${rows[0].id}`);
  });

  // The "BAKING" page — animated, polls /status every few seconds.
  app.get('/app/hitt/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      'SELECT * FROM hitt_requests WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    const hitt = rows[0];
    if (!hitt) return reply.code(404).send('Not found');
    if (hitt.status === 'complete') {
      return reply.redirect(`/app/hitt/${id}/results`);
    }
    return reply.view('user/hitt_baking', { user: req.user, hitt });
  });

  app.get('/app/hitt/:id/status', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      'SELECT id, status, result_count, completed_at FROM hitt_requests WHERE id=$1 AND user_id=$2',
      [id, req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // The HITT results page — locked + unlocked leads from this HITT's audience.
  app.get('/app/hitt/:id/results', async (req, reply) => {
    const id = Number(req.params.id);
    const { rows: hRows } = await query(
      'SELECT * FROM hitt_requests WHERE id=$1 AND user_id=$2',
      [id, req.user.id]
    );
    const hitt = hRows[0];
    if (!hitt) return reply.code(404).send('Not found');
    return reply.redirect(`/app/leads?hitt_id=${id}`);
  });

  // List all this user's HITT requests
  app.get('/app/hitts', async (req, reply) => {
    const { rows } = await query(
      `SELECT h.*,
              (SELECT COUNT(*)::int FROM audience_leads al WHERE al.audience_id = h.audience_id) AS lead_count
       FROM hitt_requests h
       WHERE h.user_id = $1
       ORDER BY h.created_at DESC`,
      [req.user.id]
    );
    return reply.view('user/hitts', { user: req.user, hitts: rows });
  });
}
