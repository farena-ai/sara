// C3 (MCP Apps): an MCP tool's app in the chat. The page comes from /api/mcp-apps/<id>/frame in an
// iframe with sandbox="allow-scripts" only (the server adds the same CSP sandbox and a strict
// default-src 'none'): an opaque origin, so it can't read Sara's cookies, storage, API or this page.
// It talks to Sara only through postMessage (JSON-RPC, the MCP Apps dialect). What it may ask:
// ui/initialize, its size, ping, and tools/call on its own server's app tools; every call goes to
// the server, where the tool's permission decides (Off, Ask: an approval card here, or on its own).
import { t } from './naming.js';

const MIN_H = 80;
const MAX_H = 720;
const START_H = 320;
const CALLS_PER_MINUTE = 30;
const ID_RE = /^[0-9a-f-]{36}$/i;
const frames = new Set();
let listening = false;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

async function post(path, body) {
  const res = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** The card: a title line and the sandboxed frame. */
export function mcpAppCard(c) {
  const title = t('App from {server}', { server: String(c.server ?? '') });
  const card = el('div', 'rcard rcard-mcp-app');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', title);
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', title));
  if (c.title) head.append(el('span', 'rcard-meta muted small', String(c.title)));
  card.append(head);
  if (!ID_RE.test(String(c.id ?? ''))) return card;
  const frame = document.createElement('iframe');
  frame.className = 'mcp-app-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.title = title;
  frame.style.height = `${START_H}px`;
  const st = { frame, id: c.id, loads: 0, dead: false, calls: [], conversationId: null };
  // A frame that navigates away is no longer the app: the bridge stops answering it.
  frame.addEventListener('load', () => {
    st.loads++;
    if (st.loads > 1) st.dead = true;
  });
  frame.src = `/api/mcp-apps/${encodeURIComponent(c.id)}/frame`;
  frames.add(st);
  if (!listening) {
    listening = true;
    window.addEventListener('message', onMessage);
  }
  card.append(frame, el('p', 'muted small mcp-app-note', t('Runs apart from Sara: it can only ask, and changes wait for your OK.')));
  return card;
}

function onMessage(e) {
  let st;
  for (const s of frames) {
    if (!s.frame.isConnected) frames.delete(s);
    else if (s.frame.contentWindow === e.source) st = s;
  }
  if (!st || st.dead || e.origin !== 'null') return;
  const m = e.data;
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
  const reply = (result) => m.id !== undefined && e.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  const fail = (code, message) => m.id !== undefined && e.source.postMessage({ jsonrpc: '2.0', id: m.id, error: { code, message } }, '*');
  const notify = (method, params) => e.source.postMessage({ jsonrpc: '2.0', method, params }, '*');
  switch (m.method) {
    case 'ui/initialize':
      return reply({
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'Sara', version: '1' },
        hostCapabilities: { serverTools: {}, logging: {} },
        hostContext: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { maxHeight: MAX_H }, locale: document.documentElement.lang || 'en' },
      });
    case 'ui/notifications/initialized':
      return void post(`/mcp-apps/${st.id}`).then((info) => {
        if (st.dead) return;
        notify('ui/notifications/tool-input', { arguments: info.input ?? {} });
        notify('ui/notifications/tool-result', info.result ?? {});
      }, () => {});
    case 'ui/notifications/size-changed': {
      const h = Number(m.params?.height);
      if (Number.isFinite(h)) st.frame.style.height = `${Math.round(Math.min(MAX_H, Math.max(MIN_H, h)))}px`;
      return;
    }
    case 'ping':
      return reply({});
    case 'notifications/message':
      return;
    case 'tools/call': {
      const now = Date.now();
      st.calls = st.calls.filter((x) => now - x < 60_000);
      if (st.calls.length >= CALLS_PER_MINUTE) return fail(-32000, t('Too many requests from this app. Wait a minute.'));
      st.calls.push(now);
      const name = String(m.params?.name ?? '');
      const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
      // A call that asks shows its approval card in the chat (Sara's normal card).
      const asked = setTimeout(() => window.dispatchEvent(new CustomEvent('sara-mcp-app-asked')), 400);
      return void post(`/mcp-apps/${st.id}/call`, { name, arguments: args }).then(
        (r) => { clearTimeout(asked); if (!st.dead) reply(r.result ?? {}); },
        (err) => { clearTimeout(asked); if (!st.dead) fail(-32000, err.message); },
      );
    }
    default:
      return fail(-32601, t('Sara does not offer this to apps.'));
  }
}
