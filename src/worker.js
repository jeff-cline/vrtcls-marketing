import 'dotenv/config';
import { query, pool } from './db.js';
import { buildClusterExpression, findPersons } from './services/wattdata.js';
import { ingestPersons } from './services/personImport.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS || 12000);
const STALE_MIN = Number(process.env.WORKER_STALE_MIN || 5);
const FETCH_TIMEOUT_MS = Number(process.env.WORKER_FETCH_TIMEOUT_MS || 30000);

async function geocode(city, state) {
  if (!city) return null;
  const q = encodeURIComponent(`${city}${state ? ', ' + state : ''}, USA`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=1`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'vrtcls.marketing/1.0 (admin@vrtcls.marketing)' },
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows[0]) return null;
    return { latitude: Number(rows[0].lat), longitude: Number(rows[0].lon) };
  } catch (err) {
    console.warn(`[worker] geocode failed for "${city}": ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function downloadExport(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const data = await r.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.persons)) return data.persons;
    if (Array.isArray(data?.sample)) return data.sample;
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function processOne(hitt) {
  console.log(`[worker] processing HITT ${hitt.id}: "${hitt.prompt}" (limit=${hitt.audience_limit})`);
  await query(
    `UPDATE hitt_requests SET status='baking', started_at = COALESCE(started_at, NOW()) WHERE id=$1`,
    [hitt.id]
  );

  const cluster = await buildClusterExpression(hitt.prompt);
  if (!cluster || !cluster.expression) {
    throw new Error('build_cluster_expression returned no expression');
  }
  console.log(`[worker] HITT ${hitt.id} cluster: estimated_size=${cluster.estimated_size}`);

  let location = null;
  if (hitt.city) {
    const geo = await geocode(hitt.city, hitt.state);
    if (geo) {
      location = {
        latitude: geo.latitude,
        longitude: geo.longitude,
        radius: hitt.radius_miles,
        unit: 'miles'
      };
    } else {
      console.warn(`[worker] HITT ${hitt.id} geocode miss for "${hitt.city}, ${hitt.state || ''}" — running national`);
    }
  }

  const result = await findPersons({
    expression: cluster.expression,
    location: location || undefined,
    audience_limit: hitt.audience_limit,
    format: 'json',
    identifier_types: ['email', 'phone', 'name', 'address'],
    workflow_id: cluster.workflow_id
  });

  let persons = Array.isArray(result.sample) ? result.sample : [];
  if (result?.export?.url) {
    try {
      const full = await downloadExport(result.export.url);
      if (full.length > persons.length) persons = full;
      console.log(`[worker] HITT ${hitt.id} export rows=${full.length}, total=${result.total}`);
    } catch (err) {
      console.warn(`[worker] HITT ${hitt.id} export download failed (${err.message}), using sample (${persons.length})`);
    }
  }

  await ingestPersons({
    hittId: hitt.id,
    persons,
    workflowId: result.workflow_id || cluster.workflow_id,
    toolTraceId: result.tool_trace_id,
    label: hitt.label,
    importedBy: hitt.user_id
  });

  console.log(`[worker] HITT ${hitt.id} complete: ${persons.length} persons ingested`);
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const { rows } = await query(
      `SELECT * FROM hitt_requests
       WHERE status IN ('queued','baking')
         AND (started_at IS NULL OR started_at < NOW() - INTERVAL '${STALE_MIN} minutes')
       ORDER BY id ASC
       LIMIT 1`
    );
    const hitt = rows[0];
    if (!hitt) return;
    try {
      await processOne(hitt);
    } catch (err) {
      console.error(`[worker] HITT ${hitt.id} FAILED:`, err);
      await query(
        `UPDATE hitt_requests SET status='failed', notes=$1, completed_at=NOW() WHERE id=$2`,
        [String(err && err.message ? err.message : err).slice(0, 500), hitt.id]
      );
    }
  } catch (err) {
    console.error('[worker] tick error:', err);
  } finally {
    running = false;
  }
}

const AUTO_BAKE_ENABLED = process.env.AUTO_BAKE_ENABLED === 'true';
const HAS_WATTDATA_KEY = !!process.env.WATTDATA_API_KEY;

console.log(`[worker] starting · poll=${POLL_MS}ms · stale=${STALE_MIN}min`);
console.log(`[worker] AUTO_BAKE_ENABLED=${AUTO_BAKE_ENABLED} · WATTDATA_API_KEY=${HAS_WATTDATA_KEY ? 'set' : 'MISSING'}`);

if (!AUTO_BAKE_ENABLED) {
  console.log('[worker] auto-bake is OFF — HITTs will be fulfilled manually via /admin/hitt. Process staying alive idle (set AUTO_BAKE_ENABLED=true + WATTDATA_API_KEY=watt_... to enable).');
} else if (!HAS_WATTDATA_KEY) {
  console.warn('[worker] AUTO_BAKE_ENABLED=true but WATTDATA_API_KEY is missing — refusing to claim HITTs (would fail every one). Add the key or flip AUTO_BAKE_ENABLED=false.');
}

const shouldRun = AUTO_BAKE_ENABLED && HAS_WATTDATA_KEY;
const handle = shouldRun ? setInterval(tick, POLL_MS) : null;
if (shouldRun) tick();

function shutdown(sig) {
  console.log(`[worker] ${sig} received, shutting down`);
  if (handle) clearInterval(handle);
  pool.end().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
