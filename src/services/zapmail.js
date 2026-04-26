import { config } from '../config.js';

function authHeaders() {
  if (!config.zapmail.apiKey) throw new Error('ZAPMAIL_API_KEY not configured');
  return {
    'x-auth-zapmail': config.zapmail.apiKey,
    'content-type': 'application/json',
    'user-agent': 'vrtcls-marketing/1.0',
  };
}

async function call(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${config.zapmail.apiBase}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = data?.message || data?.error || text || `HTTP ${resp.status}`;
    const e = new Error(`Zapmail ${method} ${path} ${resp.status}: ${msg}`);
    e.status = resp.status; e.data = data;
    throw e;
  }
  return data;
}

export function isConfigured() {
  return !!config.zapmail.apiKey;
}

export async function listMailboxes(query = {}) {
  return call('/v2/mailboxes', { query });
}

export async function getMailbox(id) {
  return call(`/v2/mailboxes/${encodeURIComponent(id)}`);
}

export async function listDomains() {
  return call('/v2/domains');
}

export async function getWalletBalance() {
  return call('/v2/wallet/balance');
}

export async function listWorkspaces() {
  return call('/v2/workspaces');
}

export async function triggerManualExport({ ids, status = 'ACTIVE', contains } = {}) {
  const body = { apps: ['MANUAL'], status };
  if (ids?.length) body.ids = ids;
  if (contains) body.contains = contains;
  return call('/v2/exports/mailboxes', { method: 'POST', body });
}

export async function createMailboxes({ domainId, count, mailboxData } = {}) {
  const body = {};
  if (mailboxData) body.mailboxData = mailboxData;
  if (domainId) body.domainId = domainId;
  if (count) body.count = count;
  return call('/v2/mailboxes', { method: 'POST', body });
}

// Legacy shims (older code referenced these stubs).
export function createZapmailClient(apiKey) {
  return { send: async () => { throw new Error('Use SMTP via mailbox transport, not Zapmail HTTP send.'); } };
}
export async function sendViaZapmail() {
  throw new Error('Zapmail does not expose an HTTP send endpoint. Send via SMTP using mailbox creds.');
}
