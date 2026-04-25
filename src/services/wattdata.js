import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = process.env.WATTDATA_ENDPOINT || 'https://api.wattdata.ai/v1/mcp/m2m';
const API_KEY = process.env.WATTDATA_API_KEY;

let _client = null;
let _connecting = null;

async function getClient() {
  if (_client) return _client;
  if (_connecting) return _connecting;
  if (!API_KEY) throw new Error('WATTDATA_API_KEY not set');
  _connecting = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { 'x-api-key': API_KEY } }
    });
    const client = new Client(
      { name: 'vrtcls.marketing', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    _client = client;
    return client;
  })();
  try { return await _connecting; }
  finally { _connecting = null; }
}

export async function resetClient() {
  if (_client) {
    try { await _client.close(); } catch {}
  }
  _client = null;
}

async function callTool(name, args, attempt = 0) {
  const client = await getClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    const txt = result?.content?.[0]?.text;
    if (typeof txt === 'string') {
      try { return JSON.parse(txt); } catch { return txt; }
    }
    return result;
  } catch (err) {
    if (attempt === 0) {
      await resetClient();
      return callTool(name, args, attempt + 1);
    }
    throw err;
  }
}

export async function buildClusterExpression(prompt, opts = {}) {
  return callTool('build_cluster_expression', {
    audience_context: { base_prompt: prompt, refinements: opts.refinements || [] },
    max_criteria: opts.maxCriteria || 5
  });
}

export async function findPersons(args) {
  return callTool('find_persons', args);
}
