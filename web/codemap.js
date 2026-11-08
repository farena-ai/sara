// Phase 50: the Map tab on the project page: her code map of the workspace. A folder tree (sizes
// and how many functions/classes each file has), a file's names with line numbers and what it
// imports / what imports it, and a search box (names, words, or meaning). Read only.
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
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const KIND = { function: 'fn', method: 'method', class: 'class', interface: 'interface', type: 'type', const: 'const', struct: 'struct', enum: 'enum', trait: 'trait', impl: 'impl', heading: '#', constructor: 'new', macro: 'macro' };

let cur = { ws: null, files: [] };
let getWs = () => null;
let poll = null;

/** Wires the tabs, search and refresh once; `ws` returns the open project's workspace. */
export function initProjectMap(ws) {
  getWs = ws;
  for (const b of document.querySelectorAll('[data-pp-tab]')) b.addEventListener('click', () => selectTab(b.dataset.ppTab));
  $('#pm-find').addEventListener('click', () => void find());
  $('#pm-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void find();
    }
  });
  $('#pm-refresh').addEventListener('click', () => void load(true));
}

/** The project page opened (again): back to Overview; the Map tab only with a workspace. */
export function resetProjectMap(ws) {
  $('#pp-map-tab').hidden = !ws;
  const workTab = $('#pp-work-tab');
  if (workTab) workTab.hidden = !ws || document.body.classList.contains('member') || document.body.classList.contains('demo');
  if (cur.ws !== ws) {
    cur = { ws: null, files: [] };
    $('#pm-results').hidden = true;
    $('#pm-q').value = '';
  }
  selectTab('overview');
}

function selectTab(name) {
  for (const b of document.querySelectorAll('[data-pp-tab]')) {
    b.classList.toggle('active', b.dataset.ppTab === name);
    b.setAttribute('aria-selected', String(b.dataset.ppTab === name));
  }
  $('#pp-overview').hidden = name !== 'overview';
  $('#pp-map').hidden = name !== 'map';
  // C13: the Workspace tab (web/workspace-view.js) loads when shown.
  const work = $('#pp-work');
  if (work) work.hidden = name !== 'workspace';
  if (name !== 'overview') document.dispatchEvent(new CustomEvent('pp-tab', { detail: name }));
  const ws = getWs();
  if (name === 'map' && ws && cur.ws !== ws) void load(false);
}

async function load(refresh) {
  const ws = getWs();
  if (!ws) return;
  clearTimeout(poll);
  $('#pm-status').textContent = refresh ? t('Looking at the files again…') : t('Mapping the code…');
  let d;
  try {
    if (refresh) await api(`/codemap/${encodeURIComponent(ws)}/refresh`, { method: 'POST' });
    d = await api(`/codemap/${encodeURIComponent(ws)}`);
  } catch (err) {
    $('#pm-status').textContent = err.message;
    return;
  }
  if (getWs() !== ws) return;
  cur = { ws, files: d.files };
  const s = d.status;
  $('#pm-status').textContent = s.files ? `${s.files} ${t('files')} · ${s.symbols} ${t('functions, classes and other names')}${d.done ? '' : ` · ${t('still mapping…')}`}${s.truncated ? ` · ${t('first 20,000 files')}` : ''}` : t('No source files here yet.');
  renderTree(d.files);
  // A big first map finishes in the background: look again in a moment.
  if (!d.done) poll = setTimeout(() => !$('#pp-map').hidden && getWs() === ws && void load(false), 3000);
}

function renderTree(files) {
  const root = { dirs: new Map(), files: [], count: 0, symbols: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.count++;
    node.symbols += f.symbols;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [], count: 0, symbols: 0 });
      node = node.dirs.get(p);
      node.count++;
      node.symbols += f.symbols;
    }
    node.files.push(f);
  }
  const box = $('#pm-tree');
  box.replaceChildren(...children(root, '', 0));
  if (!files.length) box.append(el('p', 'muted small', t('Nothing mapped yet.')));
}

/** A folder's rows; subfolders are filled in when opened (big workspaces stay quick). */
function children(node, prefix, depth) {
  const out = [];
  for (const [name, sub] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const det = document.createElement('details');
    det.className = 'pm-dir';
    const sum = el('summary', '', `${name}/`);
    sum.append(el('small', 'muted', ` ${sub.count} · ${sub.symbols}`));
    det.append(sum);
    let filled = false;
    det.addEventListener('toggle', () => {
      if (!det.open || filled) return;
      filled = true;
      det.append(...children(sub, `${prefix}${name}/`, depth + 1));
    });
    out.push(det);
    if (depth === 0 && node.dirs.size <= 3) det.open = true;
  }
  for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
    const b = el('button', 'pm-file', f.path.slice(prefix.length));
    b.type = 'button';
    b.title = f.path;
    b.append(el('small', 'muted', ` ${fmtSize(f.size)} · ${f.symbols}`));
    b.addEventListener('click', () => void showFile(f.path));
    out.push(b);
  }
  return out;
}

async function showFile(path, line) {
  const ws = getWs();
  const box = $('#pm-detail');
  box.replaceChildren(el('p', 'muted small', t('Loading…')));
  let f;
  try {
    f = await api(`/codemap/${encodeURIComponent(ws)}/file?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return box.replaceChildren(el('p', 'muted small', err.message));
  }
  const head = el('h4', 'pm-path', f.path);
  const meta = el('p', 'muted small', `${f.lang} · ${f.lines} ${t('lines')} · ${fmtSize(f.size ?? 0)}`);
  const syms = el('ul', 'pm-syms');
  for (const s of f.symbols) {
    const li = el('li', s.line === line ? 'hit' : '');
    li.append(el('span', 'pm-line', `L${s.line}`), el('span', 'pm-kind', KIND[s.kind] ?? s.kind), el('span', 'pm-name', `${s.parent ? `${s.parent}.` : ''}${s.name}`));
    li.title = s.signature;
    syms.append(li);
  }
  if (!f.symbols.length) syms.append(el('li', 'muted small', t('No functions or classes found in this file.')));
  const link = (p, label) => {
    const a = el('button', 'pm-link', label ?? p);
    a.type = 'button';
    a.addEventListener('click', () => void showFile(p));
    return a;
  };
  const imp = el('div', 'pm-deps');
  imp.append(el('strong', 'small', `${t('Imports')} (${f.imports.length})`));
  const il = el('div', 'pm-deplist');
  for (const i of f.imports) il.append(i.resolved ? link(i.resolved.replace(/\/$/, ''), i.resolved) : el('span', 'muted', i.spec));
  if (!f.imports.length) il.append(el('span', 'muted small', t('nothing')));
  imp.append(il);
  const by = el('div', 'pm-deps');
  by.append(el('strong', 'small', `${t('Imported by')} (${f.importedBy.length})`));
  const bl = el('div', 'pm-deplist');
  for (const i of f.importedBy) bl.append(link(i.path));
  if (!f.importedBy.length) bl.append(el('span', 'muted small', t('nothing in this workspace')));
  by.append(bl);
  box.replaceChildren(head, meta, syms, imp, by);
  box.querySelector('li.hit')?.scrollIntoView({ block: 'nearest' });
}

async function find() {
  const ws = getWs();
  const q = $('#pm-q').value.trim();
  const box = $('#pm-results');
  if (!ws || !q) return void (box.hidden = true);
  box.hidden = false;
  box.replaceChildren(el('p', 'muted small', t('Looking…')));
  let r;
  try {
    r = await api(`/codemap/${encodeURIComponent(ws)}/find?q=${encodeURIComponent(q)}&kind=${encodeURIComponent($('#pm-kind').value)}`);
  } catch (err) {
    return box.replaceChildren(el('p', 'muted small', err.message));
  }
  const rows = r.hits.map((h) => {
    const b = el('button', 'pm-hit');
    b.type = 'button';
    b.append(el('span', 'pm-where', `${h.path}:${h.line}`));
    if (h.name) b.append(el('span', 'pm-name', h.name));
    b.append(el('span', 'pm-snip muted', h.snippet ?? ''));
    b.addEventListener('click', () => void showFile(h.path, h.line));
    return b;
  });
  box.replaceChildren(...(r.note ? [el('p', 'muted small', t(r.note))] : []), ...(rows.length ? rows : [el('p', 'muted small', t('Nothing found. Try other words, or Names for a function name.'))]));
}
