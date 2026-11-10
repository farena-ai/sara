// Phase 124 (2.57.0, docs/store/SARA_STORE.md §6.1, §6.2, §11.1): the Sara Store, part 1 in the
// app. Settings → Data & health → Privacy gets the *Sara Store* row (on by default; off: no store
// reads at all), when the list was last checked, *Check now*, and a line for each add-on the store
// pulled. Plugins, Skills and Other programs (MCP) get *More in the Sara Store* (a plain link to the
// website). Browsing and installing in Settings (*Get more*) are Phase 125. Everything here comes
// from /api/store on Sara's own server; the page never talks to the store, and every text from the
// store is set with textContent.
import { serverText, t } from './naming.js';
import { reviewCard as pluginCard, permText } from './plugins.js';
import { showStoreImport } from './skills.js';
import { proposalCard } from './proposal-card.js';
import { openCard } from './packs.js';
import { icon as lineIcon } from './icons.js';
import { needsLine } from './prereqs.js';

const $ = (sel) => document.querySelector(sel);
async function api(path, opts = {}) {
  const raw = opts.raw !== undefined;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: raw ? { 'content-type': 'application/zip' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

const st = { demo: false };
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** The freshness line, in words (§6.2). */
export function freshnessLine(s) {
  if (!s.on) return t('The Sara Store is off: Sara doesn’t look for add-ons. Your add-ons keep working.');
  if (s.blocked === 'private') return t('Private local mode is on, so the Sara Store is off. Your add-ons keep working.');
  if (s.freshness === 'none') return t('Sara hasn’t checked the store yet.');
  if (s.freshness === 'unreachable') return t('Sara couldn’t reach the store. Check your internet, then Check now.');
  const parts = [];
  if (s.freshness === 'expired') parts.push(t('The list expired: installs wait until Sara can check again.'));
  else if (s.freshness === 'offline') parts.push(t('You’re offline: showing the list from {when}.', { when: when(s.fetchedAt) }));
  else if (s.checkedAt) parts.push(t('Checked {when}.', { when: when(s.checkedAt) }));
  const n = s.items?.length ?? 0;
  if (n) parts.push(n === 1 ? t('1 add-on in the store.') : t('{n} add-ons in the store.', { n }));
  if (s.failures >= 3) parts.push(t('Sara couldn’t check the store’s list, so she kept the last good one.'));
  if (s.tooOld) parts.push(t('The store needs a newer Sara. Update Sara.'));
  return parts.join(' ');
}

function render(s) {
  $('#store-on').checked = Boolean(s.on);
  $('#store-status').textContent = freshnessLine(s);
  $('#store-check').disabled = !s.on || Boolean(s.blocked && s.blocked !== 'offline');
  for (const a of document.querySelectorAll('a.store-link')) if (s.url) a.href = s.url;
  const box = $('#store-notices');
  box.replaceChildren();
  for (const n of s.notices ?? []) {
    const row = document.createElement('div');
    row.className = 'skl-note store-notice';
    const p = document.createElement('span');
    p.textContent = n.action === 'disable' ? t('{name} was pulled from the Sara Store: {reason} Sara switched it off. Nothing was deleted.', { name: n.name, reason: n.reason }) : t('The Sara Store warns about {name}: {reason}', { name: n.name, reason: n.reason });
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ghost';
    ok.textContent = t('Got it');
    ok.addEventListener('click', async () => {
      try {
        render(await api(`/store/notices/${encodeURIComponent(n.item)}/dismiss`, { method: 'POST', body: {} }));
      } catch (err) {
        $('#store-status').textContent = err.message;
      }
    });
    row.append(p, ok);
    box.append(row);
  }
}

export async function loadStorePrivacy() {
  if (st.demo) return;
  try {
    render(await api('/store'));
  } catch (err) {
    // A household member (403) or an older server: the row stays out of the way.
    $('#store-status').textContent = err.status === 403 ? '' : err.message;
  }
}

export function initStore(o = {}) {
  st.demo = Boolean(o.demo);
  $('#store-on')?.addEventListener('change', async () => {
    try {
      await api('/store/settings', { method: 'PUT', body: { on: $('#store-on').checked } });
      await loadStorePrivacy();
    } catch (err) {
      $('#store-status').textContent = err.message;
    }
  });
  $('#store-check')?.addEventListener('click', async () => {
    const b = $('#store-check');
    b.disabled = true;
    $('#store-status').textContent = t('Checking…');
    try {
      const r = await api('/store/check', { method: 'POST', body: {} });
      render(r.store);
      if (r.result && !r.result.ok && r.result.reason === 'refused') $('#store-status').textContent = t('The store’s list didn’t check out, so Sara kept the last good one.');
    } catch (err) {
      $('#store-status').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Phase 125 (2.58.0, docs/store/SARA_STORE.md §8, §9.4, §10.1, §12.3): Settings → Add-ons → Get
// more. Browse and search (on Sara's own server: nothing is sent while typing), the item page, Get
// through the review cards that exist (a plugin's card with the store strip, the skills import, the
// new tool-server card), My add-ons, Submit yours, My submissions and Report this. Every text from
// the store is set with textContent; the permission lines are the ones Sara computed.
// ---------------------------------------------------------------------------------------------

const g = { shelf: null, q: '', back: [], mcp: null, plugin: null, pack: null, item: null, seg: 'browse', all: new Set() };
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => onClick(b));
  return b;
};
const tipBtn = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const enc = encodeURIComponent;
// EC27: the Qualified badge (src/store/qualified.ts): when and where this version last passed a real install.
const OS_NAME = { windows: () => 'Windows', linux: () => 'Linux', macos: () => 'Mac' };
const CHECK_NAME = { install: () => t('install'), settings: () => t('settings saved'), run: () => t('main action'), write: () => t('approved write'), update: () => t('update'), add: () => t('add her'), retire: () => t('retire her'), remove: () => t('remove'), connect: () => t('connect'), 'signed-hash': () => t('signed download') };
const andList = (xs) => {
  try {
    return new Intl.ListFormat(document.documentElement.lang || 'en', { type: 'conjunction' }).format(xs);
  } catch {
    return xs.join(', ');
  }
};
function qualifiedLine(q) {
  if (!q) return '';
  const base = t('Checked on {systems} · {day} · Sara {version}', { systems: andList(q.pass.map((o) => OS_NAME[o]?.() ?? o)), day: q.at, version: q.sara });
  return q.partial?.length ? `${base} · ${t('partly on {systems}', { systems: andList(q.partial.map((o) => OS_NAME[o]?.() ?? o)) })}` : base;
}
const KIND = { plugin: () => t('Plugin'), skill: () => t('Skill'), mcp: () => t('Tool server'), companion: () => t('Companion') };
// PL2c (N10, N31): a line icon per kind (web/icons.js), on every card, instead of one generic square.
export const KIND_ICON = { plugin: 'plug', skill: 'book', mcp: 'tool', companion: 'heart' };
const kindGlyph = (kind) => {
  const s = el('span', 'sto-icon sto-glyph');
  s.dataset.kind = kind;
  const svg = lineIcon(KIND_ICON[kind] ?? 'package');
  if (svg) s.append(svg);
  return s;
};
export const TRUST = {
  'first-party': () => t('Made by the Sara team'),
  reviewed: () => t('Reviewed by the Sara team'),
  community: () => t('Not reviewed by people yet'),
};
const SHELVES = [
  // Phase 127 (PACKS.md §13.3): Companions is the first shelf (it's what most beginners come for).
  ['companions', () => t('Companions')],
  ['popular', () => t('Popular with beginners')],
  ['everyday', () => t('Everyday')],
  ['coding', () => t('Coding')],
  ['home', () => t('Home')],
  ['creative', () => t('Creative')],
  ['tool-servers', () => t('Tool servers')],
  ['skills', () => t('Skills')],
  ['more', () => t('More')],
  ['community', () => t('Community')],
];
const shelfOf = (i) => (i.kind === 'companion' && i.trust !== 'community' ? 'companions' : i.trust === 'community' ? 'community' : i.kind === 'skill' ? 'skills' : ['everyday', 'coding', 'home', 'creative'].includes(i.category) ? i.category : i.kind === 'mcp' ? 'tool-servers' : 'more');
const pathOf = (l) => t(l.key, Object.fromEntries(Object.entries(l.params ?? {}).map(([k, v]) => [k, String(v)])));
const lineText = (l) => {
  const own = permText(l);
  return own === l.key ? pathOf(l) : own;
};

/** PL2c (N10): the shelves of the first screen; every item id in exactly one shelf (Popular first). */
export function shelfGroups(items, q = '') {
  const groups = new Map();
  const seen = new Set();
  if (!q) {
    const pop = items.filter((i) => i.trust === 'first-party' && i.kind !== 'companion').slice(0, 3);
    groups.set('popular', pop);
    for (const i of pop) seen.add(i.id);
  }
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    const k = shelfOf(i);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  return groups;
}

/** The state lines of Get more (§8.2): off, private local mode, offline, no list yet. */
export function stateLine(s) {
  if (!s.on) return t('The Sara Store is off (Settings → Privacy). Turn it on to see add-ons.');
  if (s.blocked === 'private' || s.freshness === 'private') return t('Private local mode is on, so the Sara Store is off. Your add-ons keep working.');
  if (s.blocked === 'demo') return t('Add-ons aren’t in the demo.');
  if (!s.items?.length && (s.freshness === 'none' || s.freshness === 'unreachable')) return t('Sara couldn’t reach the store. Check your internet, then Check now.');
  if (s.freshness === 'offline') return t('You’re offline: you can look, installing needs the internet.');
  if (s.freshness === 'expired') return t('The list expired: installs wait until Sara can check again.');
  return '';
}

/** Search on this server, in the cached list: name, summary and tags. */
export function matches(item, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.name, item.summary, ...(item.tags ?? []), item.id].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

function actionFor(i) {
  if (i.installHeld) return { label: t('Installation held'), off: true, why: t(i.installHeld) };
  if (i.blockedHere) return { label: t('Pulled'), off: true };
  if (i.held) return { label: t('Being checked'), off: true, why: t('Being checked by the Sara team') };
  if (!i.canRun) return { label: t('Can’t run here'), off: true, why: i.why ? t(i.why.text, i.why.params ?? {}) : '' };
  if (i.updateAvailable) return { label: t('Update'), go: 'update' };
  if (i.installed) return { label: t('Installed'), off: true };
  if (i.kind === 'companion') return { label: t('Add'), go: 'get' };
  return { label: t('Get'), go: 'get' };
}

function icon(i) {
  if (i.icon) {
    const img = el('img', 'sto-icon');
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.src = `/api/store/shots/${enc(i.icon)}`;
    img.addEventListener('error', () => img.replaceWith(kindGlyph(i.kind)), { once: true });
    return img;
  }
  return kindGlyph(i.kind);
}
/** The kind line on a card: its line icon and the word (Plugin, Skill, Tool server, Companion). */
function kindTag(kind) {
  const s = el('span', 'sto-kind muted small');
  s.dataset.kind = kind;
  const svg = lineIcon(KIND_ICON[kind] ?? 'package');
  if (svg) s.append(svg);
  s.append(el('span', '', KIND[kind]?.() ?? kind));
  return s;
}

function card(i) {
  const c = el('article', `sto-card${i.trust === 'community' ? ' community' : ''}${i.kind === 'companion' ? ' sto-companion' : ''}`);
  const open = btn('', 'sto-open', () => openItem(i.id));
  open.setAttribute('aria-label', t('Open {name}', { name: i.name }));
  const head = el('div', 'sto-card-head');
  head.append(icon(i), el('strong', 'sto-name', i.name));
  c.dataset.item = i.id;
  open.append(head, el('span', 'sto-summary small', i.summary), kindTag(i.kind), el('span', `sto-badge small trust-${i.trust}`, TRUST[i.trust]?.() ?? i.trust));
  if (i.qualified) open.append(el('span', 'sto-qualified small', qualifiedLine(i.qualified)));
  const a = actionFor(i);
  const act = btn(a.label, a.go === 'get' ? 'sto-act' : 'ghost sto-act', (b) => (a.go === 'update' ? void update(i.id, b) : void get(i.id, b)));
  act.disabled = Boolean(a.off) || !g.shelf?.installAllowed;
  if (a.why) act.title = a.why;
  c.append(open, act);
  if (i.installedOrigin === 'candidate') c.append(el('span', 'sto-why muted small', t('Local workflow candidate')));
  if (i.blockedHere) c.append(el('span', 'skl-warn small', t('Pulled from the Sara Store: {reason}', { reason: i.blockedHere })));
  if (i.yankedHere) c.append(el('span', 'skl-warn small', t('This version was pulled from the store: {reason}', { reason: i.yankedHere })));
  if (a.why) c.append(el('span', 'sto-why muted small', a.why));
  return c;
}

function renderShelves() {
  const s = g.shelf;
  const box = $('#sto-shelves');
  if (!box || !s) return;
  box.replaceChildren();
  const line = stateLine(s);
  $('#sto-state').textContent = line;
  $('#sto-state').hidden = !line;
  $('#sto-fresh').textContent = freshnessLine(s);
  $('#sto-community').checked = Boolean(s.community);
  const items = (s.items ?? []).filter((i) => matches(i, g.q));
  if (g.q && !items.length) box.append(el('p', 'muted', t('Nothing in the store matches that.')));
  // PL2c (N10, N11): every item once on the screen (Popular takes it out of its own shelf), and each
  // shelf a wrapping grid of 3 (1 on phones) with See all instead of a sideways scroller.
  const groups = shelfGroups(items, g.q);
  for (const [k, label] of SHELVES) {
    const list = groups.get(k) ?? [];
    if (k === 'skills' && !list.length && !g.q) {
      const sec = el('section', 'sto-shelf');
      sec.append(el('h3', '', label()), el('p', 'muted small', t('None yet: be the first. Submit yours.')));
      box.append(sec);
      continue;
    }
    if (!list.length) continue;
    const sec = el('section', 'sto-shelf');
    sec.dataset.shelf = k;
    const row = el('div', 'sto-row');
    const open = g.q || g.all.has(k);
    row.append(...(open ? list : list.slice(0, 3)).map(card));
    const head = el('div', 'sto-shelf-head');
    head.append(el('h3', '', label()));
    if (list.length > 3 && !g.q) {
      head.append(btn(open ? t('Show fewer') : t('See all {n}', { n: list.length }), 'ghost small sto-all', () => {
        if (open) g.all.delete(k);
        else g.all.add(k);
        renderShelves();
      }));
    }
    sec.append(head, row);
    box.append(sec);
  }
  const mine = $('#sto-mine-open');
  if (mine) mine.textContent = s.updates ? (s.updates === 1 ? t('My add-ons (1 update)') : t('My add-ons ({n} updates)', { n: s.updates })) : t('My add-ons');
}

/** PL2c (N9): the segmented control Browse · My add-ons · Submit; exactly one is selected. */
function setSeg(seg) {
  g.seg = seg;
  for (const b of document.querySelectorAll('.sto-seg [data-seg]')) {
    const on = b.dataset.seg === seg;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  if ($('#sto-browse')) $('#sto-browse').hidden = seg !== 'browse';
  if ($('#sto-view')) {
    $('#sto-view').hidden = seg === 'browse';
    $('#sto-view').setAttribute('aria-labelledby', seg === 'mine' ? 'sto-mine-open' : 'sto-submit-open');
    if (seg === 'browse') $('#sto-view').replaceChildren();
  }
}
/** My add-ons and Submit open in the page (under the control); everything after them in the panel. */
function show(title, nodes, o = {}) {
  if (g.seg === 'browse' || $('#store-panel')?.open || o.panel) return panel(title, nodes, o);
  const v = $('#sto-view');
  v.replaceChildren(...nodes);
  g.viewRedo = o.redo ?? null;
}

export async function loadGetMore() {
  if (st.demo) return;
  try {
    g.shelf = await api('/store');
    if (g.shelf.on && g.shelf.stale && !g.shelf.blocked) {
      const r = await api('/store/check', { method: 'POST', body: {} }).catch(() => null);
      if (r?.store) g.shelf = r.store;
    }
    const mine = await api('/store/mine').catch(() => null);
    g.shelf.updates = mine?.updates ?? 0;
    renderShelves();
  } catch (err) {
    if ($('#sto-status')) $('#sto-status').textContent = err.status === 403 ? '' : err.message;
  }
}

// ---- the panel (one window: item page, cards, My add-ons, Submit yours, My submissions, Report) ----

function panel(title, nodes, o = {}) {
  const d = $('#store-panel');
  if (o.push !== false && d.open && g.current) g.back.push(g.current);
  g.current = o.redo ?? null;
  $('#stp-title').textContent = title;
  $('#stp-back').hidden = !g.back.length;
  $('#stp-body').replaceChildren(...nodes);
  $('#stp-status').textContent = '';
  if (!d.open) d.showModal();
  $('#stp-body').scrollTop = 0;
}
const say = (text) => {
  if (!$('#store-panel')?.open && g.seg !== 'browse' && $('#sto-status')) $('#sto-status').textContent = text;
  else $('#stp-status').textContent = text;
};
const section = (head, ...nodes) => {
  const s = el('section', 'stp-sec');
  if (head) s.append(el('h4', '', head));
  s.append(...nodes);
  return s;
};

/** The item page (§8.3): what it does, what it can do (Sara's words), pictures, versions, checks. */
export async function openItem(id, o = {}) {
  let r;
  try {
    r = await api(`/store/items/${enc(id)}`);
  } catch (err) {
    $('#sto-status').textContent = err.message;
    return;
  }
  g.item = r;
  const i = r.item;
  const nodes = [];
  const head = el('div', 'stp-head');
  head.append(icon(i));
  const who = el('div', 'stp-who');
  who.append(el('strong', '', i.name), el('span', 'muted small', t('{kind} · version {version} · {license}', { kind: KIND[i.kind]?.() ?? i.kind, version: r.version, license: r.entry.license ?? '' })), el('span', `sto-badge small trust-${i.trust}`, TRUST[i.trust]?.() ?? ''), el('span', 'muted small', t('By {name}', { name: i.author.name })));
  head.append(who);
  nodes.push(head);
  if (r.qualified) {
    nodes.push(el('p', 'sto-qualified small', qualifiedLine(r.qualified)), el('p', 'muted small', t('Checks that ran: {list}', { list: r.qualified.checks.map((c) => CHECK_NAME[c]?.() ?? c).join(', ') })));
  }
  if (r.held) nodes.push(el('p', 'skl-warn', t('Being checked by the Sara team')));
  if (r.installed?.state === 'blocked') nodes.push(el('p', 'skl-warn', t('{name} was pulled from the Sara Store: {reason} Sara switched it off. Nothing was deleted.', { name: i.name, reason: r.installed.note ?? '' })));
  else if (r.installed?.state === 'yanked') nodes.push(el('p', 'skl-warn', t('This version was pulled from the store: {reason}', { reason: r.installed.note ?? '' })));
  const go = el('div', 'prop-buttons');
  const updatable = r.installed && r.installed.version !== r.version;
  if (r.installHeld) {
    nodes.push(el('p', 'skl-warn small', t(r.installHeld)));
    if (r.installed?.origin === 'candidate') nodes.push(el('p', 'muted small', t('Local workflow candidate')));
    if (r.installHeldCode === 'association') go.append(btn(t('Forget stale store record'), 'ghost', async (b) => {
      if (!window.confirm(t('Forget this stale store record? Any current local plugin and its data stay in place.'))) return;
      b.disabled = true;
      try { await api('/store/remove', { method: 'POST', body: { item: i.id } }); await openItem(i.id, { push: false }); void loadGetMore(); }
      catch (err) { say(err.message); }
      finally { b.disabled = false; }
    }));
    else go.append(btn(t('Open installed plugin card'), 'ghost', () => {
      $('#store-panel').close();
      location.hash = '#view=settings:ab-plugins';
      document.dispatchEvent(new CustomEvent('sara:focus-plugin', { detail: i.id }));
    }));
  } else if (!r.installed || updatable) go.append(btn(updatable ? t('Update') : i.kind === 'companion' ? t('Add') : t('Get'), '', (b) => void (updatable ? update(i.id, b) : get(i.id, b))));
  else go.append(el('span', 'muted', t('Installed ({version})', { version: r.installed.version })));
  if (!r.installHeld) for (const b of go.querySelectorAll('button')) b.disabled = !r.installAllowed;
  nodes.push(go);
  nodes.push(section(t('What it does'), el('p', '', r.entry.description), ...(r.entry.about ?? []).filter((p) => p !== r.entry.description).map((p) => el('p', 'small', p))));
  const can = el('ul', 'prop-can');
  for (const l of r.lines) {
    const li = el('li', `prop-line risk-${l.risk ?? 'low'}`);
    li.append(el('span', 'prop-dot'), el('span', 'prop-text', lineText(l)));
    can.append(li);
  }
  nodes.push(section(t('What it can do'), can));
  if (r.entry.shots?.length) {
    const shots = el('div', 'stp-shots');
    for (const s of r.entry.shots) {
      const img = el('img', 'stp-shot');
      img.alt = s.alt;
      img.loading = 'lazy';
      img.src = `/api/store/shots/${enc(s.sha)}`;
      shots.append(img);
    }
    nodes.push(section(t('Screenshots'), shots));
  }
  if (r.entry.needs?.length) nodes.push(section(t('Needs'), el('p', 'small', r.entry.needs.join(' · '))));
  if (r.entry.works?.length) nodes.push(section(t('Works on'), el('p', 'small', r.entry.works.map((w) => ({ windows: 'Windows', macos: 'Mac', linux: 'Linux' })[w] ?? w).join(' · '))));
  const checks = el('ul', 'stp-checks small');
  for (const c of r.entry.checks?.results ?? []) checks.append(el('li', c.ok ? 'ok' : 'bad', `${c.ok ? '✓' : '✗'} ${c.id}${c.note ? ` · ${c.note}` : ''}`));
  if (r.entry.review?.notes) checks.append(el('li', 'muted', r.entry.review.notes));
  nodes.push(section(t('Checks'), checks));
  const vers = el('ul', 'small');
  for (const v of r.versions) {
    const li = el('li', v.yanked ? 'stp-yanked' : '', v.yanked ? t('{version} ({date}), pulled: {reason}', { version: v.version, date: v.published, reason: v.yanked }) : t('{version} ({date})', { version: v.version, date: v.published }));
    vers.append(li);
  }
  nodes.push(section(t('Versions'), vers));
  // PL2c (N12): the author key is for people who check signatures, under Details.
  const det = el('details', 'stp-details small');
  det.append(el('summary', '', t('Details')), el('p', 'muted small stp-key', t('Author key: {key}', { key: i.author.key })));
  nodes.push(det);
  if (r.entry.source) {
    const a = el('a', 'small', t('Its source'));
    a.href = r.entry.source;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nodes.push(a);
  }
  nodes.push(el('div', 'prop-buttons', null));
  nodes.at(-1).append(btn(t('Report this'), 'ghost', () => openReport(i.id, r.installed?.version ?? r.version)));
  panel(i.name, nodes, { push: o.push, redo: () => openItem(id, { push: false }) });
}

async function startInstall(id, path, b) {
  if (b) b.disabled = true;
  const item = g.shelf?.items?.find((x) => x.id === id);
  let understand = false;
  if (item?.trust === 'community') understand = window.confirm(t('I understand nobody at Sara has read this'));
  if (item?.trust === 'community' && !understand) {
    if (b) b.disabled = false;
    return;
  }
  try {
    const r = await api(path, { method: 'POST', body: path === '/store/install' ? { id, understand } : { item: id } });
    if (r.kind === 'companion') {
      // Phase 127: the pack card; Add her makes a new companion.
      $('#store-panel').close();
      openCard({ ...r.card, face: null }, { done: () => void loadGetMore() });
    } else if (r.kind === 'plugin') showPlugin(r.review);
    else if (r.kind === 'skill') {
      $('#store-panel').close();
      showStoreImport(r.review, () => void loadGetMore());
    } else showMcp(r.review);
  } catch (err) {
    if ($('#store-panel').open) say(err.message);
    else $('#sto-status').textContent = err.message;
  } finally {
    if (b) b.disabled = false;
  }
}
const get = (id, b) => startInstall(id, '/store/install', b);
const update = (id, b) => startInstall(id, '/store/update', b);

/** A plugin: today's card with the store strip; Install is today's approve. */
function showPlugin(r) {
  g.plugin = r;
  const cardEl = pluginCard(r, {
    buttons: [
      { label: r.kind === 'update' ? t('Update') : t('Install'), onClick: (b) => void approvePlugin(b) },
      { label: t('Cancel'), cls: 'ghost', onClick: () => cancelPanel() },
    ],
  });
  // PL2c (N12): the window says what it adds, not just "Get".
  panel(r.kind === 'update' ? t('Update {name}', { name: r.manifest.name }) : t('Add {name}', { name: r.manifest.name }), [cardEl], { panel: true });
}
async function approvePlugin(b) {
  const r = g.plugin;
  const trust = $('#pla-trust')?.checked === true;
  if (r.needsTrust && !trust) return say(t("Tick \"I trust this plugin's author\" first."));
  b.disabled = true;
  try {
    await api(`/plugins/${enc(r.manifest.id)}/approve`, { method: 'POST', body: { review: r.id, trust } });
    const done = el('p', 'skl-note', r.kind === 'update' ? t('{name} was updated.', { name: r.manifest.name }) : t('{name} is installed. Switch it on for a companion on its card.', { name: r.manifest.name }));
    const on = btn(t('Switch it on'), '', () => {
      $('#store-panel').close();
      location.hash = '#view=settings:ab-plugins';
    });
    panel(r.manifest.name, [done, on], { push: false });
    void loadGetMore();
  } catch (err) {
    say(err.message);
  } finally {
    b.disabled = false;
  }
}
function cancelPanel() {
  if (g.mcp) void api(`/store/mcp/${enc(g.mcp.id)}`, { method: 'DELETE' }).catch(() => undefined);
  g.mcp = null;
  g.plugin = null;
  $('#store-panel').close();
}

const FENCE_LINE = {
  bwrap: () => t('Runs fenced in with its own folder'),
  seatbelt: () => t('Runs fenced in with its own folder'),
  user: () => t('Runs fenced in with its own folder'),
  none: () => t('Not fenced in on this computer: it can do what your user can.'),
};

/** The tool-server card (§8.4): the exact command, its Windows form, the fields, the vault, the fence. */
export function mcpCard(r) {
  const body = [];
  if (r.transport === 'stdio') {
    body.push(el('p', 'small', t('It will run this program on this computer:')));
    body.push(el('code', 'stp-cmd', [r.command, ...(r.args ?? [])].join(' ')));
    if (r.windowsForm) body.push(el('p', 'muted small', t('On Windows: {command}', { command: [r.windowsForm.command, ...r.windowsForm.args].join(' ') })));
    const spec = (r.args ?? []).find((a) => /@\d|==\d/.test(a));
    if (spec) body.push(el('p', 'muted small', t('Its code comes from {where}, version {version}. We tested that version.', { where: r.command === 'uvx' ? 'PyPI' : r.command === 'docker' ? 'Docker' : 'npm', version: spec.split(/@|==/).pop() })));
  } else body.push(el('p', 'small', t('It talks to {url}', { url: r.url })));
  // PRQ: a missing program gets *Install it for me*; afterwards the card looks again (Continue install).
  if (r.needs?.length) body.push(needsLine(r.needs, () => void recheckMcp(r)));
  if (r.reaches?.length) body.push(el('p', 'small', t('It reaches: {list}', { list: r.reaches.join(' · ') })));
  body.push(el('p', `small${r.fence === 'none' ? ' skl-warn' : ''}`, t('Fence: {line}', { line: FENCE_LINE[r.fence]?.() ?? r.fence })));
  if (r.renamed) body.push(el('p', 'muted small', t('You already have one with this name, so this one is called {name}.', { name: r.serverName })));
  const form = el('div', 'stp-fields');
  for (const f of [...r.fields, ...r.secrets]) {
    const secret = f.kind === 'secret' || r.secrets.includes(f);
    const lab = el('label', 'stp-field');
    const head = el('span', '', f.optional ? t('{label} (optional)', { label: f.label }) : f.label);
    head.append(' ', tipBtn(f.tip));
    const input = el('input');
    input.dataset.key = f.key;
    input.dataset.secret = secret ? '1' : '';
    input.autocomplete = 'off';
    if (secret) {
      input.type = 'password';
      input.placeholder = r.mode === 'update' ? '••••' : '';
    } else {
      input.type = f.kind === 'number' ? 'number' : f.kind === 'url' ? 'url' : 'text';
      // Q-ADDONS: an update shows the saved value (e.g. the ComfyUI address), not the default.
      const value = r.saved?.[f.key] ?? f.default;
      if (value) input.value = value;
    }
    lab.append(head, input);
    if (secret) {
      const eye = btn(t('Show'), 'ghost small', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        eye.textContent = input.type === 'password' ? t('Show') : t('Hide');
      });
      lab.append(eye);
    }
    form.append(lab);
  }
  if (form.childNodes.length) body.push(form);
  const ro = r.tools?.readOnly?.length;
  const ask = r.tools?.ask?.length;
  if (ro || ask) body.push(el('p', 'small', t('Her tools from it: looking runs on its own; changing things asks you first. You can change this in Tools.')));
  if (r.needsTrust) {
    const row = el('label', 'row plg-trust');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'stp-trust';
    row.append(box, el('span', '', t("I trust this tool server's author")));
    body.push(row);
  }
  return proposalCard({
    title: r.mode === 'update' ? t('Update the {name} tool server to {version}?', { name: r.name, version: r.version }) : t('Add the {name} tool server?', { name: r.name }),
    source: t('Tool server'),
    chips: [{ text: TRUST[r.trust]?.() ?? '' }, ...(r.tested?.length ? [{ text: t('tested on {list}', { list: r.tested.map((x) => ({ windows: 'Windows', macos: 'Mac', linux: 'Linux' })[x.os] ?? x.os).join(', ') }) }] : [])],
    why: [t('From the Sara Store')],
    can: (r.changes ?? []).map((c, i) => ({ id: `c${i}`, text: c, risk: 'medium' })),
    added: (r.changes ?? []).map((_c, i) => `c${i}`),
    warn: r.guide ?? [],
    body,
    buttons: [
      { label: r.continued ? t('Continue install') : r.mode === 'update' ? t('Update and start') : t('Add and start'), onClick: (b) => void approveMcp(b) },
      { label: t('Cancel'), cls: 'ghost', onClick: () => cancelPanel() },
    ],
  });
}
function showMcp(r, o = {}) {
  g.mcp = r;
  panel(r.name, [mcpCard(r)], o);
}
async function recheckMcp(r) {
  try {
    const next = await api(`/store/mcp/${enc(r.id)}/recheck`, { method: 'POST', body: {} });
    showMcp({ ...next, continued: true }, { push: false });
  } catch (err) {
    say(err.message);
  }
}
async function approveMcp(b) {
  const r = g.mcp;
  const trust = $('#stp-trust')?.checked === true;
  if (r.needsTrust && !trust) return say(t("Tick “I trust this tool server's author” first."));
  const values = {};
  const secrets = {};
  for (const i of document.querySelectorAll('#stp-body .stp-fields input')) (i.dataset.secret ? secrets : values)[i.dataset.key] = i.value;
  b.disabled = true;
  say(t('Starting it…'));
  try {
    const out = await api(`/store/mcp/${enc(r.id)}/approve`, { method: 'POST', body: { values, secrets, trust } });
    g.mcp = null;
    const res = el('p', out.test.ok ? 'skl-note' : 'skl-warn', out.test.ok ? t('{name} is added and running. {result}', { name: r.name, result: out.test.text }) : t('{name} is added. {result}', { name: r.name, result: out.test.text }));
    const again = btn(t('Test'), 'ghost', async (x) => {
      x.disabled = true;
      try {
        const tr = await api('/store/test', { method: 'POST', body: { item: r.item } });
        res.textContent = tr.text;
      } catch (err) {
        say(err.message);
      } finally {
        x.disabled = false;
      }
    });
    again.append(' ');
    const row = el('div', 'prop-buttons');
    row.append(again);
    const tip = el('span', 'muted small');
    tip.append(tipBtn(t('Starts the tool server and asks it for its tools. Nothing is sent to anyone else. If it fails, Sara says what to check, like whether ComfyUI is running.')));
    row.append(tip);
    panel(r.name, [res, row], { push: false });
    void loadGetMore();
  } catch (err) {
    say(err.message);
  } finally {
    b.disabled = false;
  }
}

// ---- My add-ons (§8.7) ----

const ORIGIN = { candidate: () => t('Local workflow candidate'), store: () => t('Sara Store'), zip: () => t('A file you chose'), git: () => t('A git address'), folder: () => t('A folder on this server'), typed: () => t('You typed it in') };
const PAGE = { plugin: 'ab-plugins', skill: 'ab-skills', mcp: 'ab-mcp' };

export async function openMine(o = {}) {
  let r;
  try {
    r = await api('/store/mine');
  } catch (err) {
    $('#sto-status').textContent = err.message;
    return;
  }
  const nodes = [];
  if (!r.addons.length) nodes.push(el('p', 'muted', t('Nothing added from outside yet.')));
  // C8: add-on auto-update (off by default): all Store plugins, or one at a time below.
  if (r.addons.some((a) => a.kind === 'plugin' && a.item)) nodes.push(autoUpdateBox(r.autoUpdate));
  for (const a of r.addons) {
    const row = el('article', 'stp-addon');
    const line = el('div', 'stp-addon-head');
    line.append(el('strong', '', a.name), el('span', 'muted small', [KIND[a.kind]?.(), a.version, ORIGIN[a.origin]?.() ?? a.origin, a.trust ? TRUST[a.trust]?.() : ''].filter(Boolean).join(' · ')));
    row.append(line);
    const status = a.state === 'blocked' ? t('{name} was pulled from the Sara Store: {reason} Sara switched it off. Nothing was deleted.', { name: a.name, reason: a.stateNote ?? '' }) : a.state === 'yanked' ? t('This version was pulled from the store: {reason}', { reason: a.stateNote ?? '' }) : a.state === 'removed-from-store' ? t('No longer in the store') : a.kind === 'mcp' ? (a.status === 'ready' ? (a.tools === 1 ? t('Running · 1 tool') : t('Running · {n} tools', { n: a.tools })) : a.status === 'disabled' ? t('Off') : t('Not running')) : a.status === 'installed' ? t('Installed') : a.status === 'disabled' ? t('Off') : String(a.status ?? '');
    row.append(el('p', a.state === 'blocked' || a.state === 'yanked' ? 'skl-warn small' : 'muted small', status));
    const acts = el('div', 'stp-addon-acts');
    if (a.installHeld) row.append(el('p', 'skl-warn small', t(a.installHeld)));
    if (!a.installHeld && a.update) acts.append(btn(t('Update to {version}', { version: a.update }), '', (b) => void update(a.item, b)));
    acts.append(btn(t('Settings and log'), 'ghost', () => {
      $('#store-panel').close();
      location.hash = `#view=settings:${PAGE[a.kind]}`;
      if (a.origin === 'candidate') document.dispatchEvent(new CustomEvent('sara:focus-plugin', { detail: a.ref }));
    }));
    if (!a.installHeld && a.item && a.canGoBack) acts.append(btn(t('Go back'), 'ghost', (b) => void storeAct('goback', a.item, b)));
    if (a.kind === 'plugin' && a.item && a.auto !== undefined) acts.append(autoSwitch(t('Update by itself'), a.auto, (on) => ({ item: a.item, on }), 'au-item'));
    if (a.item) acts.append(btn(t('Report this'), 'ghost', () => openReport(a.item, a.version)));
    if (a.item && a.state === 'blocked') acts.append(btn(t('Switch it on anyway'), 'ghost', (b) => {
      if (window.confirm(t('The Sara team found a serious problem with this add-on. Switch it on anyway?'))) void storeAct('override', a.item, b, { confirm: true });
    }));
    if (a.item && a.origin !== 'candidate' && a.installHeldCode !== 'association') acts.append(btn(t('Remove'), 'ghost danger', (b) => {
      if (window.confirm(t('Remove {name}? Its settings and saved data go too.', { name: a.name }))) void storeAct('remove', a.item, b);
    }));
    if (a.item && a.installHeldCode === 'association') acts.append(btn(t('Forget stale store record'), 'ghost', (b) => {
      if (window.confirm(t('Forget this stale store record? Any current local plugin and its data stay in place.'))) void storeAct('remove', a.item, b);
    }));
    row.append(acts);
    nodes.push(row);
  }
  show(t('My add-ons'), nodes, { push: o.push, redo: () => openMine({ push: false }) });
}
function autoSwitch(label, on, body, cls) {
  const lab = el('label', `row small ${cls}`);
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(on) });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api('/store/auto-update', { method: 'PUT', body: body(box.checked) });
      await openMine({ push: false });
    } catch (err) {
      say(err.message);
      box.checked = !box.checked;
    } finally {
      box.disabled = false;
    }
  });
  lab.append(box, ` ${label}`);
  return lab;
}
const AUTO_OUTCOME = { updated: () => t('updated'), asked: () => t('needs your OK'), 'rolled-back': () => t('went back'), failed: () => t('failed') };
function autoUpdateBox(au = { all: false, last: [] }) {
  const box = el('div', 'au-box');
  const head = autoSwitch(t('Update my Sara Store plugins by themselves'), au.all, (on) => ({ all: on }), 'au-all');
  head.append(' ', tipBtn(t('Off by default. Once a day Sara checks the signed Store list, installs a newer version, checks it starts, and puts the old one back if it does not. An update that asks for more permissions always waits for you.')));
  box.append(head);
  for (const o of au.last ?? []) box.append(el('p', 'muted small', `${o.name} ${o.from} → ${o.to}: ${AUTO_OUTCOME[o.outcome]?.() ?? o.outcome} (${new Date(o.at).toLocaleDateString()})`));
  return box;
}
async function storeAct(what, item, b, extra = {}) {
  b.disabled = true;
  try {
    await api(`/store/${what}`, { method: 'POST', body: { item, ...extra } });
    await openMine({ push: false });
    void loadGetMore();
  } catch (err) {
    say(err.message);
  } finally {
    b.disabled = false;
  }
}

// ---- Report this (§10.1) ----

export function openReport(item, version) {
  const reasons = [['bad', t('It does something bad or sneaky')], ['broken', t("It's broken")], ['spam', t("It's spam or fake")], ['copy', t("It copies someone else's work")], ['other', t('Something else')]];
  const sel = el('select');
  sel.id = 'stp-reason';
  for (const [v, l] of reasons) {
    const o = el('option', '', l);
    o.value = v;
    sel.append(o);
  }
  const what = el('label', 'stp-field');
  const wh = el('span', '', t("What's wrong?"));
  wh.append(' ', tipBtn(t('Pick the closest. The Sara team reads every report; for something bad or sneaky they can hold the add-on at once.')));
  what.append(wh, sel);
  const text = el('textarea');
  text.id = 'stp-text';
  text.rows = 5;
  text.maxLength = 2000;
  const tl = el('label', 'stp-field');
  const th = el('span', '', t('What happened'));
  th.append(' ', tipBtn(t('In your words, up to 2,000 characters. Keys and passwords are taken out before it is sent.')));
  tl.append(th, text);
  const mail = el('input');
  mail.type = 'email';
  mail.id = 'stp-mail';
  mail.autocomplete = 'email';
  const ml = el('label', 'stp-field');
  const mh = el('span', '', t('Email for replies (optional)'));
  mh.append(' ', tipBtn(t('Only if you want an answer by email. It is sent with the report and used for nothing else.')));
  ml.append(mh, mail);
  const logRow = el('label', 'row');
  const logBox = el('input');
  logBox.type = 'checkbox';
  logBox.id = 'stp-log';
  const lh = el('span', '', t('Add my plugin log for this add-on'));
  lh.append(' ', tipBtn(t('Its own log lines from this server, with keys and paths taken out. You see all of it here before anything is sent.')));
  logRow.append(logBox, lh);
  const preview = el('pre', 'stp-log', '');
  preview.hidden = true;
  logBox.addEventListener('change', async () => {
    preview.hidden = !logBox.checked;
    if (!logBox.checked) return;
    try {
      preview.textContent = (await api('/store/report', { method: 'POST', body: { item, preview: true, log: true } })).log || t('Nothing in its log yet.');
    } catch (err) {
      preview.textContent = err.message;
    }
  });
  const sendB = btn(t('Send to the Sara team'), '', async (b) => {
    b.disabled = true;
    try {
      const r = await api('/store/report', { method: 'POST', body: { item, version, reason: sel.value, text: text.value, contact: mail.value, log: logBox.checked } });
      panel(t('Report this'), [el('p', 'skl-note', t('Sent. Report {id}. Thank you: the Sara team reads every report.', { id: r.report }))], { push: false });
    } catch (err) {
      say(err.message);
    } finally {
      b.disabled = false;
    }
  });
  panel(t('Report this'), [el('p', 'muted small', t('Nothing else about you or this server is sent.')), what, tl, ml, logRow, preview, sendB]);
}

// ---- Submit yours and My submissions (§9.4) ----

const MARK = (r) => (r.ok ? (r.warnings?.length ? '⚠' : '✓') : '✗');
export function reportList(report) {
  const ul = el('ul', 'stp-report');
  for (const r of report.results ?? []) {
    const li = el('li', r.ok ? (r.warnings?.length ? 'warn' : 'ok') : 'bad');
    li.append(el('strong', '', `${MARK(r)} ${r.id}`));
    for (const p of [...(r.problems ?? []), ...(r.warnings ?? [])]) li.append(el('span', 'small', p));
    ul.append(li);
  }
  return ul;
}

export async function openSubmit() {
  let key = null;
  try {
    key = (await api('/store/author')).short;
  } catch {
    key = null;
  }
  const kinds = el('p', 'muted small', t('A plugin, a skill or a tool server: Sara tells which by the file at the top of the folder (sara-plugin.json, SKILL.md or sara-mcp.json).'));
  const path = el('input');
  path.id = 'stp-path';
  path.placeholder = '/home/you/my-plugin';
  path.autocomplete = 'off';
  const pl = el('label', 'stp-field');
  const ph = el('span', '', t('Where is it? A folder on this server'));
  ph.append(' ', tipBtn(t('The full path of the folder on the server Sara runs on. Or choose a .zip of the folder below.')));
  pl.append(ph, path);
  const file = el('input');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  file.id = 'stp-zip';
  const fl = el('label', 'stp-field');
  const fh = el('span', '', t('Or a .zip'));
  fh.append(' ', tipBtn(t('A zip of the folder, up to 10 MB.')));
  fl.append(fh, file);
  const out = el('div', 'stp-out');
  const check = btn(t('Check it'), '', async (b) => {
    b.disabled = true;
    say(t('Checking…'));
    try {
      const f = file.files?.[0];
      const r = f ? await api(`/store/pack?name=${enc(f.name)}`, { method: 'POST', raw: await f.arrayBuffer() }) : await api('/store/pack', { method: 'POST', body: { path: path.value.trim() } });
      g.pack = r;
      say('');
      showReport(out, r, key);
    } catch (err) {
      say(err.message);
    } finally {
      b.disabled = false;
    }
  });
  // PL2c (N9): My submissions lives inside Submit.
  const subs = btn(t('My submissions'), 'ghost', () => void openSubs({ panel: true }));
  subs.id = 'sto-subs-open';
  const subsRow = el('div', 'prop-buttons sto-subs-row');
  subsRow.append(subs);
  show(t('Submit yours'), [section(t('1 What is it?'), kinds), section(t('2 Where is it?'), pl, fl, check), out, subsRow]);
}

/** Phase 127: *Send to the Sara Store* from Share her: the companion pack, checked, into Submit yours. */
export async function openSubmitPack(r) {
  let key = null;
  try {
    key = (await api('/store/author')).short;
  } catch {
    key = null;
  }
  const out = el('div', 'stp-out');
  panel(t('Submit yours'), [section(t('1 What is it?'), el('p', 'muted small', t('A companion pack, checked by Share her.'))), out]);
  showReport(out, r, key);
}

function showReport(out, r, key) {
  const rep = r.report;
  const nodes = [el('p', rep.ready ? 'skl-note' : 'skl-warn', rep.ready ? t('{name} {version}: ready to submit.', { name: rep.name || rep.id, version: rep.version }) : t('Not ready yet: fix the ✗ lines, then check it again.')), reportList(rep)];
  if (rep.lines?.length) {
    const ul = el('ul', 'small');
    for (const l of rep.lines) ul.append(el('li', '', lineText(l)));
    nodes.push(el('p', 'small', t('What it can do')), ul);
  }
  if (rep.ready) {
    const name = el('input');
    name.id = 'stp-name';
    name.maxLength = 60;
    name.autocomplete = 'name';
    const nl = el('label', 'stp-field');
    const nh = el('span', '', t('Name shown on the store'));
    nh.append(' ', tipBtn(t('Your name or a nickname, shown on the add-on’s page as its author. Up to 60 characters.')));
    nl.append(nh, name);
    const mail = el('input');
    mail.type = 'email';
    mail.id = 'stp-contact';
    mail.autocomplete = 'email';
    const ml = el('label', 'stp-field');
    const mh = el('span', '', t('Email for replies (optional)'));
    mh.append(' ', tipBtn(t('Only if you want an answer by email. It is sent with the report and used for nothing else.')));
    ml.append(mh, mail);
    const tick = (id, text) => {
      const row = el('label', 'row');
      const b = el('input');
      b.type = 'checkbox';
      b.id = id;
      row.append(b, el('span', '', text));
      return row;
    };
    const keyLine = el('p', 'muted small', key ? t('Your author key: {key}', { key }) : t('Sara makes your author key when you send this.'));
    keyLine.append(' ', tipBtn(t('Signs what you send us, so only you can send updates to your add-ons. It stays in this Sara’s vault and in its backups. Lose it, and write to us to move your add-ons.')));
    const sent = el('ul', 'muted small');
    for (const s of [t('the package and this report'), t('the name shown on the store, and the email if you add one'), t('your author key’s public half'), t('this Sara’s install id, version and system (for the limits and My submissions)')]) sent.append(el('li', '', s));
    const sendB = btn(t('Send to the Sara team'), '', async (b) => {
      if (!$('#stp-rights').checked || !$('#stp-rules').checked) return say(t('Tick both boxes first.'));
      b.disabled = true;
      say(t('Sending…'));
      try {
        const res = await api('/store/submit', { method: 'POST', body: { pack: r.pack, name: name.value, contact: mail.value, rights: true, rules: true } });
        panel(t('Submit yours'), [el('p', 'skl-note', t('Sent. Submission {id}. You’ll see our reply in My submissions.', { id: res.submission })), btn(t('My submissions'), '', () => void openSubs())], { push: false });
      } catch (err) {
        say(err.data?.deskDown ? t('Our desk isn’t answering right now. Try again later: your draft is kept.') : err.message);
      } finally {
        b.disabled = false;
      }
    });
    nodes.push(section(t('3 About you'), nl, ml, keyLine, tick('stp-rights', t('I made this, or I have the right to share it under its license.')), tick('stp-rules', t('I’ve read what the store accepts.')), el('p', 'small', t('What is sent:')), sent, sendB));
  }
  out.replaceChildren(...nodes);
}

export async function openSubs(o = {}) {
  let r;
  try {
    r = await api('/store/submissions');
  } catch (err) {
    $('#sto-status').textContent = err.message;
    return;
  }
  const nodes = [];
  if (r.key) nodes.push(el('p', 'muted small', t('Your author key: {key}', { key: r.key })));
  for (const d of r.drafts ?? []) nodes.push(el('p', 'skl-warn small', t('Not sent yet: {item} {version}. Our desk didn’t answer; check it again and send it later.', { item: d.item, version: d.version })));
  if (!r.submissions.length) nodes.push(el('p', 'muted', t('Nothing sent yet.')));
  for (const s of r.submissions) {
    const row = el('article', 'stp-addon');
    const head = el('div', 'stp-addon-head');
    head.append(el('strong', '', `${s.submission} · ${s.item} ${s.version}`), el('span', 'muted small', STATE_WORDS[s.status]?.() ?? s.status));
    row.append(head, btn(t('Open'), 'ghost', () => void openSub(s.submission)));
    nodes.push(row);
  }
  panel(t('My submissions'), nodes, { push: o.push, redo: () => openSubs({ push: false, panel: true }) });
}
const STATE_WORDS = {
  uploading: () => t('Sending'),
  checking: () => t('Being checked'),
  'needs-review': () => t('Waiting for a person on the team'),
  'checks-failed': () => t('The checks found problems'),
  'changes-asked': () => t('The team asked for changes'),
  approved: () => t('Approved: goes out with the next store list'),
  rejected: () => t('Not listed'),
  published: () => t('In the Sara Store'),
  yanked: () => t('Pulled from the store'),
  blocked: () => t('Blocked'),
  removed: () => t('Removed'),
};
async function openSub(sub) {
  let r;
  try {
    r = await api(`/store/submissions/${enc(sub)}`);
  } catch (err) {
    say(err.message);
    return;
  }
  const nodes = [el('p', r.status === 'published' ? 'skl-note' : 'muted', r.status === 'published' ? t('{item} {version} is in the Sara Store.', { item: r.item, version: r.version }) : STATE_WORDS[r.status]?.() ?? r.status)];
  for (const m of r.messages ?? []) {
    const p = el('div', `stp-msg ${m.from === 'team' ? 'team' : 'you'}`);
    p.append(el('strong', 'small', m.from === 'team' ? (m.name ? t('{name} from the Sara team', { name: m.name }) : t('The Sara team')) : t('You')), el('p', 'small', m.text));
    nodes.push(p);
  }
  const text = el('textarea');
  text.id = 'stp-reply';
  text.rows = 3;
  text.maxLength = 4000;
  const rl = el('label', 'stp-field');
  const rh = el('span', '', t('Reply'));
  rh.append(' ', tipBtn(t('Your answer to the Sara team about this submission. Keys and passwords are taken out before it is sent.')));
  rl.append(rh, text);
  nodes.push(rl, btn(t('Send'), '', async (b) => {
    b.disabled = true;
    try {
      await api(`/store/submissions/${enc(sub)}/reply`, { method: 'POST', body: { text: text.value } });
      await openSub(sub);
    } catch (err) {
      say(err.message);
    } finally {
      b.disabled = false;
    }
  }));
  panel(sub, nodes);
}

export function initGetMore() {
  document.addEventListener('sara:submit-pack', (e) => void openSubmitPack(e.detail));
  $('#sto-q')?.addEventListener('input', () => {
    g.q = $('#sto-q').value;
    if (g.seg !== 'browse') setSeg('browse');
    renderShelves();
  });
  $('#sto-check')?.addEventListener('click', async () => {
    const b = $('#sto-check');
    b.disabled = true;
    $('#sto-fresh').textContent = t('Checking…');
    try {
      const r = await api('/store/check', { method: 'POST', body: {} });
      g.shelf = { ...r.store, updates: g.shelf?.updates ?? 0 };
      renderShelves();
    } catch (err) {
      $('#sto-status').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
  $('#sto-community')?.addEventListener('change', async () => {
    try {
      await api('/store/settings', { method: 'PUT', body: { community: $('#sto-community').checked } });
      await loadGetMore();
    } catch (err) {
      $('#sto-status').textContent = err.message;
    }
  });
  $('#sto-browse-open')?.addEventListener('click', () => setSeg('browse'));
  $('#sto-mine-open')?.addEventListener('click', () => {
    setSeg('mine');
    void openMine();
  });
  $('#sto-submit-open')?.addEventListener('click', () => {
    setSeg('submit');
    void openSubmit();
  });
  // ← → between the three (a tab list).
  document.querySelector('.sto-seg')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.sto-seg [data-seg]')];
    const i = tabs.findIndex((b) => b.dataset.seg === g.seg);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
  $('#stp-close')?.addEventListener('click', () => cancelPanel());
  $('#stp-back')?.addEventListener('click', () => {
    const prev = g.back.pop();
    if (prev) void prev();
    $('#stp-back').hidden = !g.back.length;
  });
  $('#store-panel')?.addEventListener('close', () => {
    g.back = [];
    g.current = null;
  });
}
