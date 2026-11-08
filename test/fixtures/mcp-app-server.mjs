// C3 test server (stdio): speaks MCP 2026-07-28 (stateless, per-request _meta) and/or the legacy
// handshake, and serves an MCP App (ui:// resource). MCP_ERA=modern|legacy|dual (default dual).
// MCP_BIG_HTML=1 serves an oversized app page. Tools:
// - show_counter: model + app, opens ui://counter/app; returns {count}.
// - bump: app only (visibility ["app"]), changes the count (asks first).
// - peek: app only, read-only (runs without asking).
// - whoami: the era and the _meta the server saw on this request.
import { createInterface } from 'node:readline';

const ERA = process.env.MCP_ERA ?? 'dual';
const MODERN = '2026-07-28';
const META = 'io.modelcontextprotocol/protocolVersion';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let count = 0;
let legacy = false;

const APP = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Counter</title>
<style>body{font:15px system-ui,sans-serif;margin:12px}button{font:inherit;padding:6px 12px}</style></head>
<body><h1 id="n">Count: ?</h1><button id="bump">Bump</button><p id="status"></p><pre id="probe"></pre>
<script>
let next = 1; const waits = new Map();
function rpc(method, params) { const id = next++; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); return new Promise((ok, no) => waits.set(id, { ok, no })); }
const show = (r) => { const c = r && r.structuredContent && r.structuredContent.count; if (c !== undefined) document.getElementById('n').textContent = 'Count: ' + c; };
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.id !== undefined && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.no(m.error) : w.ok(m.result); return; }
  if (m.method === 'ui/notifications/tool-result') show(m.params);
});
const probe = {};
try { probe.cookie = document.cookie; } catch (e) { probe.cookie = 'blocked: ' + e.name; }
try { probe.parent = String(parent.document.title); } catch (e) { probe.parent = 'blocked: ' + e.name; }
try { probe.storage = String(localStorage.length); } catch (e) { probe.storage = 'blocked: ' + e.name; }
probe.origin = String(self.origin);
fetch('/api/settings').then(() => { probe.fetch = 'reached'; }, (e) => { probe.fetch = 'blocked: ' + e.name; }).finally(() => { document.getElementById('probe').textContent = JSON.stringify(probe); });
document.getElementById('bump').onclick = async () => {
  document.getElementById('status').textContent = 'Waiting for OK';
  try { const r = await rpc('tools/call', { name: 'bump', arguments: { by: 1 } }); show(r); document.getElementById('status').textContent = 'Done'; }
  catch (err) { document.getElementById('status').textContent = 'Refused: ' + (err.message || err); }
};
rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'counter', version: '1' }, appCapabilities: {} }).then(() => {
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
});
</script></body></html>`;

const html = () => (process.env.MCP_BIG_HTML === '1' ? APP.replace('</body>', `<p>${'x'.repeat(700 * 1024)}</p></body>`) : APP);
const tools = [
  { name: 'show_counter', description: 'Show the counter app', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://counter/app' } } },
  { name: 'bump', description: 'Add to the counter', inputSchema: { type: 'object', properties: { by: { type: 'number' } } }, _meta: { ui: { resourceUri: 'ui://counter/app', visibility: ['app'] } } },
  { name: 'peek', description: 'Read the counter', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'whoami', description: 'What the server saw', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['model'] } } },
];

function handle(msg) {
  const meta = msg.params?._meta ?? {};
  const modernReq = typeof meta[META] === 'string';
  const done = (result) => send({ jsonrpc: '2.0', id: msg.id, result: modernReq ? { resultType: 'complete', ...result } : result });
  const fail = (code, message, data) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data ? { data } : {}) } });
  if (msg.method === 'initialize') {
    if (ERA === 'modern') return fail(-32601, `This server speaks MCP ${MODERN} only.`);
    legacy = true;
    return done({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'counter', version: '1' } });
  }
  if (modernReq) {
    if (ERA === 'legacy') return fail(-32601, 'Method not found');
    if (meta[META] !== MODERN) return fail(-32022, 'Unsupported protocol version', { supported: [MODERN], requested: meta[META] });
  } else if (!legacy) {
    return fail(-32600, 'Missing protocol version');
  }
  switch (msg.method) {
    case 'server/discover':
      return done({ supportedVersions: [MODERN], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'counter', version: '1' } }, ttlMs: 0, cacheScope: 'private' });
    case 'tools/list':
      return done({ tools, ...(modernReq ? { ttlMs: 0, cacheScope: 'private' } : {}) });
    case 'resources/read':
      if (msg.params.uri !== 'ui://counter/app') return fail(-32602, 'Resource not found');
      return done({ contents: [{ uri: 'ui://counter/app', mimeType: 'text/html;profile=mcp-app', text: html(), _meta: { ui: { csp: { connectDomains: ['https://api.example.com', 'javascript:alert(1)'], resourceDomains: ["https://cdn.example.com; script-src *"] } } } }], ...(modernReq ? { ttlMs: 0, cacheScope: 'private' } : {}) });
    case 'tools/call': {
      const name = msg.params.name;
      if (name === 'bump') count += Number(msg.params.arguments?.by ?? 1);
      if (name === 'whoami') return done({ content: [{ type: 'text', text: JSON.stringify({ era: modernReq ? 'modern' : 'legacy', meta }) }] });
      if (name === 'show_counter' || name === 'bump' || name === 'peek') return done({ content: [{ type: 'text', text: `count=${count}` }], structuredContent: { count } });
      return fail(-32602, 'Unknown tool');
    }
    default:
      return fail(-32601, 'Method not found');
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  handle(msg);
});
