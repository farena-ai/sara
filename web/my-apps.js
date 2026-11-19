// V3.1 My apps (docs/MY_APPS.md): Library → My apps. The small web apps she built and kept
// (src/my-apps.ts): open, look at it here, Undo the last change, go back to any version, share a
// read-only link, rename or delete. Apps run sandboxed, never with the Sara session.
import { locale, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const OTHERS = ['#lib-home', '#lib-doc', '#lib-research', '#lib-topics', '#lib-meetings', '#lib-study', '#lib-media', '#lib-scan', '#lib-journal'];
let state = { apps: [], expiries: ['1d', '7d', '30d', 'never'] };
let openId = null; // the app whose versions are unfolded
let looking = null; // the app shown in the frame
const EXPIRY = { '1h': () => t('for an hour'), '1d': () => t('for a day'), '7d': () => t('for a week'), '30d': () => t('for a month'), never: () => t('until I stop it') };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? t(data.error) : res.statusText);
  return data;
}
function status(text) {
  const s = $('#myap-status');
  if (s) s.textContent = text;
}
const when = (at) => new Date(at).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
const size = (b) => (b < 1024 ? t('{n} bytes', { n: b }) : t('{n} KB', { n: Math.max(1, Math.round(b / 1024)) }));
const full = (path) => new URL(path, location.origin).href;

async function copy(text, b) {
  try {
    await navigator.clipboard.writeText(text);
    const was = b.textContent;
    b.textContent = t('Copied');
    setTimeout(() => (b.textContent = was), 1500);
  } catch {
    prompt(t('Copy this link:'), text);
  }
}

async function act(f, done) {
  try {
    const d = await f();
    if (done) status(done(d));
    await load();
  } catch (err) {
    status(err.message);
  }
}

function shareRow(a) {
  const row = el('div', 'myap-share');
  if (a.sharePath) {
    const link = el('input', 'myap-link');
    link.readOnly = true;
    link.value = full(a.sharePath);
    link.setAttribute('aria-label', t('Share link'));
    row.append(
      el('span', 'small', a.shareUntil ? t('Shared until {date}', { date: when(a.shareUntil) }) : t('Shared until you stop it')),
      link,
      btn(t('Copy'), 'ghost small', (e) => void copy(link.value, e.currentTarget)),
      btn(t('Stop sharing'), 'ghost small', () => void act(() => api(`/library/apps/${a.id}/share`, { method: 'DELETE' }), () => t('The link stopped working.'))),
    );
    return row;
  }
  const pick = el('select', 'myap-expiry');
  pick.setAttribute('aria-label', t('How long the link works'));
  for (const x of state.expiries) {
    const o = el('option', '', (EXPIRY[x] ?? (() => x))());
    o.value = x;
    if (x === '7d') o.selected = true;
    pick.append(o);
  }
  row.append(
    tip(t('Anyone with the link can open the app and see its saved data, but not change it. It is served by this server only; stop sharing to end it at once.')),
    btn(t('Share a link'), 'ghost small', () => void act(() => api(`/library/apps/${a.id}/share`, { body: { expiry: pick.value } }), () => t('Link ready: copy it below.'))),
    pick,
  );
  return row;
}

async function versionsBox(a, box) {
  box.replaceChildren(el('p', 'muted small', t('Loading…')));
  try {
    const d = await api(`/library/apps/${a.id}`);
    const ol = el('ol', 'myap-versions');
    ol.setAttribute('aria-label', t('Versions'));
    for (const v of d.versions) {
      const li = el('li', v.current ? 'current' : '');
      const what = el('span', '', `${t('Version {n}', { n: v.n })} · ${when(v.at)} · ${v.note}`);
      li.append(what);
      if (v.current) li.append(el('span', 'chip small', t('Shown now')));
      else li.append(btn(t('Go back to this'), 'ghost small', () => void act(() => api(`/library/apps/${a.id}/restore`, { body: { n: v.n } }), () => t('Showing version {n}.', { n: v.n }))));
      ol.append(li);
    }
    const files = el('p', 'muted small', t('Files: {list}', { list: d.files.join(', ') }));
    box.replaceChildren(ol, files);
  } catch (err) {
    box.replaceChildren(el('p', 'small', err.message));
  }
}

function card(a) {
  const c = el('article', 'myap-card');
  c.dataset.id = a.id;
  const head = el('div', 'myap-head');
  head.append(el('strong', '', a.name));
  const meta = [t('Version {n} of {all}', { n: a.version, all: a.versions }), t('changed {date}', { date: when(a.updatedAt) }), size(a.bytes)];
  if (a.dataKeys) meta.push(t('Saved data: {n}', { n: a.dataKeys }));
  head.append(el('span', 'muted small', meta.join(' · ')));
  c.append(head);

  const acts = el('div', 'myap-acts');
  const open = el('a', 'button ghost small', t('Open'));
  open.href = a.openPath;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  const undo = btn(t('Undo last change'), 'ghost small', () => void act(() => api(`/library/apps/${a.id}/undo`, { body: {} }), (d) => t('Back to version {n}. Its saved data was not changed.', { n: d.app.version })));
  undo.hidden = !a.canUndo;
  acts.append(
    open,
    btn(looking === a.id ? t('Hide') : t('Look here'), 'ghost small', () => {
      looking = looking === a.id ? null : a.id;
      render();
    }),
    undo,
    btn(openId === a.id ? t('Hide versions') : t('Versions…'), 'ghost small', () => {
      openId = openId === a.id ? null : a.id;
      render();
    }),
    btn(t('Rename'), 'ghost small', () => {
      const name = prompt(t('New name for this app:'), a.name);
      if (name && name.trim() && name.trim() !== a.name) void act(() => api(`/library/apps/${a.id}`, { method: 'PATCH', body: { name: name.trim() } }));
    }),
    btn(t('Delete'), 'ghost small danger', () => {
      if (confirm(t('Delete "{name}", every version and its saved data?', { name: a.name }))) void act(() => api(`/library/apps/${a.id}`, { method: 'DELETE' }), () => t('Deleted.'));
    }),
  );
  c.append(acts, shareRow(a));
  if (looking === a.id) {
    const f = el('iframe', 'myap-frame');
    // The server adds the same sandbox (CSP); no allow-same-origin, so the app never gets the Sara session.
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.title = a.name;
    f.src = a.openPath;
    c.append(f);
  }
  if (openId === a.id) {
    const box = el('div', 'myap-vbox');
    c.append(box);
    void versionsBox(a, box);
  }
  return c;
}

function render() {
  const list = $('#myap-list');
  if (!list) return;
  if (!state.apps.length) {
    list.replaceChildren(el('p', 'muted', t('No apps kept yet. In a chat, ask her for one ("make me an app to track my plants"), try it, then say "keep it".')));
    return;
  }
  list.replaceChildren(...state.apps.map(card));
}

// D3 (src/canvas.ts): the live views she posted in chats: where they live, open the chat, remove.
const CV_KIND = { checklist: () => t('Live checklist'), table: () => t('Live table'), chart: () => t('Live chart'), html: () => t('Live view') };
function canvasFrom(v) {
  if (v.source?.type === 'tasks') return v.source.project ? t('From Planner to-dos in {project}', { project: v.source.project }) : t('From your Planner to-dos');
  if (v.source?.type === 'app') return t('From the app {name}', { name: v.source.app });
  return t('Its own data');
}
function renderCanvases(list) {
  const host = $('#myap-canvases');
  if (!host) return;
  if (!list.length) {
    host.replaceChildren(el('p', 'muted small', t('None yet. Ask her in a chat for a checklist, table or chart that keeps itself up to date.')));
    return;
  }
  host.replaceChildren(
    ...list.map((v) => {
      const row = el('div', 'myap-cv');
      const what = el('div', 'myap-cv-what');
      what.append(el('strong', '', v.title), el('span', 'muted small', `${(CV_KIND[v.kind] ?? CV_KIND.html)()} · ${canvasFrom(v)} · ${when(v.updatedAt)}`));
      const acts = el('div', 'myap-cv-acts');
      if (v.conversationId)
        acts.append(
          btn(t('Open the chat'), 'ghost small', () => {
            $('#library')?.close();
            location.hash = `#c=${encodeURIComponent(v.conversationId)}`;
          }),
        );
      acts.append(
        btn(t('Remove'), 'ghost small', () => {
          if (confirm(t('Remove the live view "{name}"? It stops updating in every chat.', { name: v.title }))) void act(() => api(`/library/canvases/${v.id}`, { method: 'DELETE' }), () => t('Removed.'));
        }),
      );
      row.append(what, acts);
      return row;
    }),
  );
}

async function load() {
  try {
    state = await api('/library/apps');
  } catch (err) {
    status(err.message);
  }
  render();
  try {
    renderCanvases((await api('/library/canvases')).canvases ?? []);
  } catch {
    renderCanvases([]);
  }
}

export function openMyApps() {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const id of OTHERS) {
    const n = $(id);
    if (n) n.hidden = true;
  }
  $('#lib-apps').hidden = false;
  status('');
  void load();
}

export function initMyApps() {
  const sec = $('#lib-apps');
  if (!sec) return;
  $('#lib-apps-open')?.addEventListener('click', openMyApps);
  $('#myap-back').addEventListener('click', () => {
    sec.hidden = true;
    $('#lib-home').hidden = false;
  });
  // Another Library view opened (a #view= link): step aside. Only acts on a hidden → shown change
  // of another view, and never touches that view, so it can't loop.
  const seen = new Map(OTHERS.map((id) => [id, $(id)?.hidden ?? true]));
  new MutationObserver(() => {
    for (const id of OTHERS) {
      const n = $(id);
      const was = seen.get(id);
      const now = n?.hidden ?? true;
      seen.set(id, now);
      if (was && !now && !sec.hidden) {
        sec.hidden = true;
        looking = null;
      }
    }
  }).observe($('#library') ?? document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
