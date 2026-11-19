// W3.2: Settings → Skills & tools → Other programs (MCP) → Popular free tool servers.
// One card per free server (src/mcp-catalog.ts): what it is, where its code lives, its license.
// Add → an approval card with exactly what it can do (command, folder, internet, abilities) →
// Allow and add. Installed ones list their tools with Allow / Ask / Off (Tools and approvals).
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
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

let onChanged = () => {};
const RUNNER = { npx: () => t('Runs on this computer (Node.js)'), uvx: () => t('Runs on this computer (uv for Python)'), remote: () => t('Runs on the service\'s own servers') };

/** The approval card's lines: exactly what the server will be able to do. */
export function cardLines(card) {
  const lines = card.touches.map((x) => t(x));
  lines.push(card.folder ? t('Only this folder: {folder}', { folder: card.folder }) : card.runner === 'remote' ? t('No files on this computer') : t('No folder of yours'));
  lines.push(card.network ? t('Internet: on (it needs it)') : t('Internet: off'));
  if (card.secret) lines.push(t('Uses: {what} (kept in her vault)', { what: t(card.secret) }));
  return lines;
}

function permRow(tool, perm) {
  const row = el('label', 'mcpc-perm');
  const short = tool.name.replace(/^mcp_[a-z0-9-]+?_/, '');
  const code = el('code', '', short);
  code.title = short;
  row.append(code);
  const sel = el('select');
  sel.setAttribute('aria-label', t('Permission for {tool}', { tool: short }));
  for (const [v, label] of [['auto', t('Allow')], ['ask', t('Ask first')], ['never', t('Off')]]) sel.append(new Option(label, v, false, v === perm));
  sel.addEventListener('change', async () => {
    try {
      await api('/tools', { method: 'PUT', body: { permissions: { [tool.name]: sel.value } } });
      row.classList.add('mcpc-saved');
      setTimeout(() => row.classList.remove('mcpc-saved'), 1200);
    } catch (err) {
      $('#mcpc-status').textContent = err.message;
    }
  });
  row.append(sel);
  return row;
}

async function toolsOf(name) {
  const d = await api('/tools');
  const prefix = `mcp_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_`;
  return (d.tools ?? []).filter((x) => x.name.startsWith(prefix));
}

async function showPerms(box, item) {
  box.replaceChildren(el('p', 'muted small', t('Loading…')));
  try {
    const tools = await toolsOf(item.id);
    box.replaceChildren(
      ...(tools.length
        ? [el('p', 'muted small', t('What each tool may do without asking:')), ...tools.map((x) => permRow(x, x.permission))]
        : [el('p', 'muted small', t('No tools yet: it is still starting, or it could not start. Its status is in the list above.'))]),
    );
  } catch (err) {
    box.replaceChildren(el('p', 'small warn', err.message));
  }
}

function approval(item, box, input) {
  box.replaceChildren();
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const go = async (confirm) => {
    status.textContent = confirm ? t('Adding… (the first time it downloads the program)') : '';
    try {
      const r = await api(`/mcp/catalog/${encodeURIComponent(item.id)}`, { body: { ...input(), ...(confirm ? { confirm: true } : {}) } });
      if (!confirm) return drawCard(r.card);
      status.textContent = r.status === 'ready' ? t('Added and connected.') : r.error ? t('Added, but it did not start: {why}', { why: r.error }) : t('Added.');
      onChanged();
      void loadMcpCatalog();
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const drawCard = (card) => {
    const c = el('div', 'mcpc-card');
    c.setAttribute('role', 'group');
    c.setAttribute('aria-label', t('What {name} can do', { name: t(card.name) }));
    c.append(el('strong', '', t('Before you add it: what it can do')));
    const ul = el('ul', 'small');
    for (const line of cardLines(card)) ul.append(el('li', '', line));
    c.append(ul);
    const cmd = el('code', 'mcpc-cmd', card.command);
    cmd.dataset.raw = '';
    c.append(el('p', 'muted small', RUNNER[card.runner]()), cmd);
    const row = el('div', 'add-row');
    const ok = el('button', '', t('Allow and add'));
    ok.type = 'button';
    ok.addEventListener('click', () => {
      ok.disabled = true;
      void go(true).finally(() => (ok.disabled = false));
    });
    const no = el('button', 'ghost small', t('Cancel'));
    no.type = 'button';
    no.addEventListener('click', () => box.replaceChildren());
    row.append(ok, no);
    c.append(row, status);
    box.replaceChildren(c);
  };
  void go(false);
  box.append(status);
}

function itemCard(item) {
  const li = el('li', 'mcpc-item');
  const head = el('div', 'mcpc-head');
  const name = el('strong', '', t(item.name));
  head.append(name);
  if (item.installed) head.append(el('span', 'mcpc-chip', t('Added')));
  li.append(head, el('p', 'small', t(item.summary)));
  const src = el('p', 'muted small mcpc-src');
  const a = el('a', '', item.repo.replace(/^https:\/\/github\.com\//, ''));
  a.href = item.repo;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.dataset.raw = '';
  src.append(`${t('Source')}: `, a, ` · ${t('License')}: ${item.license} · ${item.network ? t('needs the internet') : t('no internet')}`);
  li.append(src);
  const box = el('div', 'mcpc-box');
  const fields = [];
  if (!item.installed && item.path) {
    const lab = el('label', 'mcpc-field');
    lab.append(el('span', 'small', item.path === 'file' ? t('Database file (full path)') : t('Folder it may use (full path)')));
    const inp = el('input');
    // A path, not words: the same in every language (the computer's own style).
    const win = /win/i.test(navigator.platform ?? '');
    inp.placeholder = item.path === 'file' ? (win ? 'C:\\Users\\you\\notes.db' : '/home/you/notes.db') : win ? 'C:\\Users\\you\\Documents\\Shared' : '/home/you/shared';
    inp.spellcheck = false;
    inp.dataset.k = 'path';
    lab.append(inp);
    fields.push(inp);
    li.append(lab);
  }
  if (!item.installed && item.secret) {
    const lab = el('label', 'mcpc-field');
    lab.append(el('span', 'small', t(item.secret.label)));
    const inp = el('input');
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.dataset.k = 'secret';
    lab.append(inp, el('span', 'muted small', t(item.secret.help)));
    fields.push(inp);
    li.append(lab);
  }
  const row = el('div', 'add-row');
  if (item.installed) {
    const perms = el('button', 'ghost small', t('Tool permissions'));
    perms.type = 'button';
    perms.setAttribute('aria-expanded', 'false');
    perms.addEventListener('click', () => {
      const open = perms.getAttribute('aria-expanded') !== 'true';
      perms.setAttribute('aria-expanded', String(open));
      if (open) void showPerms(box, item);
      else box.replaceChildren();
    });
    row.append(perms);
  } else {
    const add = el('button', '', t('Add'));
    add.type = 'button';
    add.disabled = !item.ready;
    add.addEventListener('click', () => approval(item, box, () => Object.fromEntries(fields.map((f) => [f.dataset.k, f.value.trim()]))));
    row.append(add);
    if (!item.ready) row.append(el('span', 'muted small', item.runner === 'uvx' ? t('Needs uv (free): docs.astral.sh/uv') : t('Not available on this computer')));
  }
  li.append(row, box);
  return li;
}

export async function loadMcpCatalog() {
  const host = $('#mcp-catalog');
  if (!host) return;
  try {
    const d = await api('/mcp/catalog');
    const ul = el('ul', 'mcpc-list');
    ul.append(...d.items.map(itemCard));
    const status = el('p', 'small', '');
    status.id = 'mcpc-status';
    status.setAttribute('role', 'status');
    host.replaceChildren(ul, status);
  } catch (err) {
    host.replaceChildren(el('p', 'muted small', err.status === 404 ? t('Not available on this server.') : err.message));
  }
}

export function initMcpCatalog(h = {}) {
  if (h.onChanged) onChanged = h.onChanged;
}
