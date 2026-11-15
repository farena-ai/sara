// Phase 57: Settings → Connections → Apps and services → Other apps. Her OpenAI-compatible address (/v1) and MCP
// address (/mcp) with copyable set-up snippets, API keys (made here, shown once, listed with a
// Remove), and the three switches: her tools for other apps, changes from other apps, and the
// browser apps on other addresses that may call her. Saves by itself.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

let helpers = { copyText: async () => {}, confirmProof: async () => ({}) };
let shownKey = '';

const origin = () => location.origin;
const KEY = () => shownKey || '<your API key>';

/** The set-up snippets, with this server's address (and the new key, right after making one). */
export function snippets(base = origin(), key = KEY()) {
  return {
    curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "sara", "messages": [{"role": "user", "content": "Hi!"}]}'`,
    powershell: `Invoke-RestMethod -Method Post -Uri "${base}/v1/chat/completions" \`\n  -Headers @{ Authorization = "Bearer ${key}" } -ContentType "application/json" \`\n  -Body '{"model": "sara", "messages": [{"role": "user", "content": "Hi!"}]}' |\n  ForEach-Object { $_.choices[0].message.content }`,
    python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${key}")\nreply = client.chat.completions.create(model="sara", messages=[{"role": "user", "content": "Hi!"}])\nprint(reply.choices[0].message.content)`,
    js: `import OpenAI from 'openai';\n\nconst client = new OpenAI({ baseURL: '${base}/v1', apiKey: '${key}' });\nconst reply = await client.chat.completions.create({ model: 'sara', messages: [{ role: 'user', content: 'Hi!' }] });\nconsole.log(reply.choices[0].message.content);`,
    claudeCode: `claude mcp add --transport http sara ${base}/mcp --header "Authorization: Bearer $SARA_API_KEY"`,
    desktop: JSON.stringify({ mcpServers: { sara: { command: 'node', args: ['C:/Users/you/sara-mcp.ts', '--server', base], env: { SARA_API_KEY: key } } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { sara: { url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  };
}

function renderSnippets() {
  const s = snippets();
  $('#oa-v1').textContent = `${origin()}/v1`;
  $('#oa-mcp').textContent = `${origin()}/mcp`;
  for (const [id, text] of Object.entries(s)) {
    const pre = $(`#oa-snip-${id}`);
    if (pre) pre.textContent = text;
  }
}

function render(v) {
  keyLabels = v.keys.map((k) => k.label);
  $('#oa-tools').checked = v.tools;
  $('#oa-changes').checked = v.changes;
  if (document.activeElement !== $('#oa-origins')) $('#oa-origins').value = v.origins.join(', ');
  $('#oa-keys').replaceChildren(
    ...(v.keys.length
      ? v.keys.map((k) => {
          const li = el('li');
          const name = el('strong', '', k.label === 'Another app' ? t('Another app') : k.label);
          name.dataset.raw = '';
          li.append(name, el('span', 'muted small', ` · ${t('made {date}', { date: new Date(k.createdAt).toLocaleDateString() })} · ${keyUse(k)} `));
          const rm = el('button', 'ghost small', t('Remove'));
          rm.type = 'button';
          rm.addEventListener('click', async () => {
            if (!confirm(t('Remove this key? The app using it stops working until you give it a new one.'))) return;
            await api(`/devices/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).catch((err) => ($('#oa-key-status').textContent = err.message));
            void loadOtherApps();
          });
          li.append(rm);
          return li;
        })
      : [el('li', 'muted small', t('No API keys yet.'))]),
  );
}

/**
 * When an API key was last used, in coarse words: the server only notes it about once an hour, and
 * a new key's "last seen" is the moment it was made, so that reads "not used yet".
 */
export function keyUse(k, now = Date.now()) {
  const made = Date.parse(k.createdAt);
  const seen = Date.parse(k.lastSeen);
  if (!Number.isFinite(seen) || seen - made < 1000) return t('not used yet');
  if (now - seen < 3_600_000) return t('used within the last hour');
  if (new Date(seen).toDateString() === new Date(now).toDateString()) return t('used today');
  return t('last used {date}', { date: new Date(seen).toLocaleDateString() });
}

/** "App 2", "App 3"…: a name for a new key that no other key has yet. */
export function suggestKeyName(labels) {
  const taken = new Set(labels.map((l) => String(l).toLowerCase()));
  for (let n = labels.length + 1; ; n++) {
    const name = t('App {n}', { n });
    if (!taken.has(name.toLowerCase())) return name;
  }
}
let keyLabels = [];

export async function loadOtherApps() {
  renderSnippets();
  try {
    render(await api('/other-apps'));
  } catch (err) {
    $('#oa-status').textContent = err.message;
  }
}

async function save(body) {
  $('#oa-status').textContent = '';
  try {
    render(await api('/other-apps', { method: 'PUT', body }));
    $('#oa-status').textContent = t('Saved.');
  } catch (err) {
    $('#oa-status').textContent = err.message;
  }
}

export function initOtherApps(h) {
  helpers = { ...helpers, ...h };
  $('#oa-tools').addEventListener('change', () => save({ tools: $('#oa-tools').checked }));
  $('#oa-changes').addEventListener('change', () => save({ changes: $('#oa-changes').checked }));
  $('#oa-origins').addEventListener('change', () => save({ origins: $('#oa-origins').value }));
  $('#oa-key-new').addEventListener('click', async () => {
    const b = $('#oa-key-new');
    $('#oa-key-status').textContent = '';
    if (!$('#oa-key-label').value.trim()) {
      // Every key needs a name, or several apps all look like "Another app": suggest one.
      $('#oa-key-label').value = suggestKeyName(keyLabels);
      $('#oa-key-label').focus();
      $('#oa-key-label').select();
      $('#oa-key-status').textContent = t('Give the key the name of the app that will use it (here is a suggestion), then press the button again.');
      return;
    }
    b.disabled = true;
    try {
      // Like letting in an app: proof it's you (passkey, owner token or two-step code).
      const proof = await helpers.confirmProof();
      const r = await api('/devices/api-key', { method: 'POST', body: { label: $('#oa-key-label').value.trim(), ...proof } });
      shownKey = r.key;
      $('#oa-key-value').textContent = r.key;
      $('#oa-key-show').hidden = false;
      $('#oa-key-label').value = '';
      $('#oa-key-status').textContent = t('Copy it now: it is shown only once. The snippets below have it filled in until you close Settings.');
      renderSnippets();
      void loadOtherApps();
    } catch (err) {
      if (err.name !== t('Cancelled')) $('#oa-key-status').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
  $('#oa-key-copy').addEventListener('click', () => helpers.copyText($('#oa-key-value').textContent, $('#oa-key-copy')));
  $('#oa-v1-copy').addEventListener('click', () => helpers.copyText($('#oa-v1').textContent, $('#oa-v1-copy')));
  $('#oa-mcp-copy').addEventListener('click', () => helpers.copyText($('#oa-mcp').textContent, $('#oa-mcp-copy')));
  for (const b of document.querySelectorAll('[data-copy-snip]')) b.addEventListener('click', () => helpers.copyText($(`#oa-snip-${b.dataset.copySnip}`).textContent, b));
  // The key is shown once: forget it when Settings closes.
  $('#settings').addEventListener('close', () => {
    shownKey = '';
    $('#oa-key-show').hidden = true;
    $('#oa-key-value').textContent = '';
    renderSnippets();
  });
}
