import { query } from '../db.js';

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export default async function trackingRoutes(app) {
  // Click tracker: /c/:sendId/:linkKey?u=<urlencoded-destination>
  app.get('/c/:sendId/:linkKey', async (req, reply) => {
    const sendId = Number(req.params.sendId);
    const linkKey = String(req.params.linkKey).slice(0, 100);
    const destination = String(req.query.u || '');
    if (!sendId || !destination) return reply.code(400).send('bad request');

    try {
      const { rows } = await query('SELECT lead_id FROM sends WHERE id = $1', [sendId]);
      if (rows[0]) {
        await query(
          `INSERT INTO click_events (send_id, link_key, destination, user_agent, ip)
           VALUES ($1, $2, $3, $4, $5)`,
          [sendId, linkKey, destination, req.headers['user-agent'] || null, req.ip]
        );
        await query(
          `INSERT INTO lead_tags (lead_id, tag, source)
           VALUES ($1, $2, $3) ON CONFLICT (lead_id, tag) DO NOTHING`,
          [rows[0].lead_id, `clicked:${linkKey}`, `send:${sendId}`]
        );
      }
    } catch (err) {
      req.log.warn({ err }, 'click log failed');
    }
    return reply.redirect(destination);
  });

  // Open pixel: /p/:sendId.gif
  app.get('/p/:sendId.gif', async (req, reply) => {
    const sendId = Number(req.params.sendId);
    if (sendId) {
      try {
        await query(
          `UPDATE sends SET opened_at = COALESCE(opened_at, NOW()), delivered_at = COALESCE(delivered_at, NOW())
           WHERE id = $1`,
          [sendId]
        );
      } catch (_) {}
    }
    reply.header('Content-Type', 'image/gif');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return reply.send(PIXEL);
  });

  // One-click unsubscribe (minimal — sets lead to DNC)
  app.get('/u/:sendId', async (req, reply) => {
    const sendId = Number(req.params.sendId);
    if (sendId) {
      try {
        await query(
          `UPDATE leads SET dnc = TRUE
           WHERE id = (SELECT lead_id FROM sends WHERE id = $1)`,
          [sendId]
        );
      } catch (_) {}
    }
    return reply.view('public/unsubscribed', { user: null });
  });

  // RFC 8058 one-click POST handler. Mailbox providers (Gmail, Yahoo) hit this
  // when the recipient clicks the inbox-level "Unsubscribe" link — the body is
  // List-Unsubscribe=One-Click. We must accept it without confirmation and
  // return 200, otherwise providers count it against our reputation.
  app.post('/u/:sendId', async (req, reply) => {
    const sendId = Number(req.params.sendId);
    if (sendId) {
      try {
        await query(
          `UPDATE leads SET dnc = TRUE
           WHERE id = (SELECT lead_id FROM sends WHERE id = $1)`,
          [sendId]
        );
      } catch (_) {}
    }
    reply.header('Content-Type', 'text/plain');
    return reply.send('OK');
  });
}
