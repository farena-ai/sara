// Phase 120 (docs/design/PRECISE.md §4.11, §4.14, §5.7): @-references in the composer and the
// checks after her edits.
//
// Typing @ at the start of a word opens a small listbox above the box (↑ ↓, Enter or Tab to pick,
// Escape to close): A file, A folder, My changes, This branch, Problems, A web page. After @file: or
// @folder: (or @ and letters) it lists matching paths from the code map; after @branch: the local
// branches. Each finished reference becomes a chip under the box (its size from the server, or why it
// can't be attached); ✕ on a chip takes the token out of the text. The server reads every reference
// itself when the message is saved: this file only helps type them. The sent message shows the chips
// with "What she got"; her reply shows the checks chip; a first edit in a project shows the card.
import { t } from './naming.js';
import { fold, score } from './command-bar.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, state: any, el: (tag: string, cls?: string, text?: string) => HTMLElement, place: () => { workspace: boolean, url: boolean } | null, openSettings: (page: string) => void } | null} */
let ctx = null;
let items = [];
let active = 0;
let token = null;
let reqId = 0;
let previewTimer = 0;
let completeTimer = 0;
let inflight = false;

const KIND_WORDS = { file: 'A file', folder: 'A folder', diff: 'My changes', branch: 'This branch', problem: 'Problems', url: 'A web page' };
const KINDS = [
  { kind: 'file', icon: '📄', insert: '@file:', need: 'workspace' },
  { kind: 'folder', icon: '📁', insert: '@folder:', need: 'workspace' },
  { kind: 'diff', icon: '±', insert: '@diff ', need: 'workspace' },
  { kind: 'branch', icon: '⑂', insert: '@branch ', need: 'workspace' },
  { kind: 'problem', icon: '⚠', insert: '@problem ', need: 'workspace' },
  { kind: 'url', icon: '🌐', insert: '@url:', need: 'url' },
];

export function initRefs(c) {
  ctx = c;
  const input = $('#input');
  const menu = $('#ref-menu');
  if (!input || !menu) return;
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'ref-menu');
  input.addEventListener('input', () => {
    void onType();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void preview(), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (menu.hidden || !items.length) return;
    if (items[0].note) return void (e.key === 'Escape' && close());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, true);
  input.addEventListener('blur', () => setTimeout(close, 150));
}

/** The reference being typed at the caret: { start, end, text } or null. */
function current() {
  const input = $('#input');
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const m = /(^|[\s(["'])(@[^\s]*)$/.exec(before);
  if (!m) return null;
  return { start: pos - m[2].length, end: pos, text: m[2] };
}

async function onType() {
  const place = ctx.place();
  token = current();
  if (token && (!place || (!place.workspace && !place.url))) {
    // Phase 128 (PL2b, N20): where @ can't be used, one line says so (instead of nothing).
    const why = token.text === '@' ? ctx.hint?.() : '';
    if (!why) return close();
    return open([{ insert: '', label: why, detail: '', note: true }]);
  }
  if (!place || !token) return close();
  const raw = token.text.slice(1);
  const m = /^(file|folder|branch):(.*)$/i.exec(raw);
  if (m) {
    if (!place.workspace) return close();
    clearTimeout(completeTimer);
    completeTimer = setTimeout(() => void complete(m[1].toLowerCase(), m[2]), 150);
    return;
  }
  if (/^url:/i.test(raw) || /:/.test(raw)) return close();
  // A pasted address right after @ becomes @url:.
  if (/^https?:\/\//i.test(raw) && place.url) {
    replaceToken(`@url:${raw}`, false);
    return close();
  }
  const kinds = KINDS.filter((k) => (k.need === 'url' ? place.url : place.workspace)).map((k) => ({ ...k, words: t(KIND_WORDS[k.kind]) }));
  const q = fold(raw);
  let list = kinds.filter((k) => !q || fold(k.kind).startsWith(q) || score(q, k.words) > 0).map((k) => ({ insert: k.insert, label: `${k.icon} ${k.words}`, detail: k.insert.trim(), more: k.kind === 'file' || k.kind === 'folder' || k.kind === 'url' }));
  // "@app" searches files directly.
  if (q.length >= 2 && place.workspace && !list.length) return void complete('file', raw);
  if (!list.length) return close();
  if (place.workspace && list.some((x) => x.insert === '@problem ')) void problemsCount(list);
  open(list);
}

async function problemsCount(list) {
  const ws = ctx.state.conv?.workspace;
  if (!ws) return;
  try {
    const p = await ctx.api(`/workspaces/${encodeURIComponent(ws)}/problems`);
    const it = list.find((x) => x.insert === '@problem ');
    if (it) it.detail = p.checked ? t('{n} errors', { n: p.problems.filter((d) => d.severity === 'error').length }) : t('not checked yet');
    paint();
  } catch {
    /* members and the demo: no problems route */
  }
}

async function complete(kind, q) {
  // Phase 128 (PL2b, N20): a new chat gets its conversation when a reference needs one.
  if (!ctx.state.currentId && ctx.ensure) await ctx.ensure().catch(() => null);
  if (inflight || !ctx.state.currentId) return;
  inflight = true;
  const id = ++reqId;
  try {
    const r = await ctx.api(`/conversations/${ctx.state.currentId}/refs/complete?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`);
    if (id !== reqId) return;
    const list = (r.items ?? []).map((x) => ({ insert: x.insert, label: x.label, detail: x.detail, more: kind === 'folder' }));
    if (list.length) open(list);
    else close();
  } catch {
    close();
  } finally {
    inflight = false;
  }
}

function open(list) {
  items = list.slice(0, 20);
  active = 0;
  paint();
  $('#ref-menu').hidden = false;
  $('#input').setAttribute('aria-expanded', 'true');
}
function close() {
  const menu = $('#ref-menu');
  if (!menu) return;
  menu.hidden = true;
  items = [];
  $('#input')?.setAttribute('aria-expanded', 'false');
  $('#input')?.removeAttribute('aria-activedescendant');
}
function paint() {
  const menu = $('#ref-menu');
  menu.replaceChildren(...items.map((it, i) => {
    if (it.note) {
      const note = ctx.el('li', 'ref-note muted small', it.label);
      note.setAttribute('role', 'presentation');
      return note;
    }
    const li = ctx.el('li', `ref-item${i === active ? ' active' : ''}`);
    li.id = `ref-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === active ? 'true' : 'false');
    li.append(ctx.el('span', 'ref-label', it.label), ctx.el('span', 'ref-detail muted small', it.detail ?? ''));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(it);
    });
    return li;
  }));
  if (items[active]?.note) $('#input').removeAttribute('aria-activedescendant');
  else $('#input').setAttribute('aria-activedescendant', `ref-opt-${active}`);
}

function replaceToken(text, keepOpen) {
  const input = $('#input');
  const tk = current() ?? token;
  if (!tk) return;
  input.value = input.value.slice(0, tk.start) + text + input.value.slice(tk.end);
  const caret = tk.start + text.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (!keepOpen) close();
}

function pick(it) {
  if (!it || it.note) return void (it?.note && close());
  // A kind that takes a value keeps the menu going (@file: lists files; a folder goes into it).
  const isFolder = /^@folder:/.test(it.insert) && it.more;
  replaceToken(isFolder ? it.insert.trimEnd() + '/' : it.insert, it.more);
  if (!it.more) void preview();
}

/** The chips under the box for the references in the text (sizes from the server; nothing is read yet). */
async function preview() {
  const box = $('#ref-chips');
  const input = $('#input');
  if (!box || !input) return;
  const place = ctx.place();
  if (!place || !/(^|[\s(["'])@(file|folder|url|diff|branch|problems?)\b/i.test(input.value) || !ctx.state.currentId) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  let r;
  try {
    r = await ctx.api(`/conversations/${ctx.state.currentId}/refs/preview`, { method: 'POST', body: { content: input.value } });
  } catch {
    return;
  }
  box.replaceChildren(...(r.items ?? []).map((x) => chip(x, true)));
  box.hidden = !box.children.length;
}

const ICON = { file: '📄', folder: '📁', url: '🌐', diff: '±', branch: '⑂', problem: '⚠' };

function chip(x, removable) {
  const w = ctx.el('span', `ref-chip${x.ok ? '' : ' refused'}${x.large ? ' large' : ''}`);
  w.setAttribute('role', 'listitem');
  w.append(ctx.el('span', 'ref-chip-text', `${ICON[x.kind] ?? '@'} ${x.label}`));
  if (!x.ok) w.append(ctx.el('span', 'ref-chip-why small', t(x.reason ?? x.why ?? 'Not attached')));
  else if (x.large) w.append(ctx.el('span', 'ref-chip-why small', t('Large: uses a quarter of her memory for this chat')));
  if (removable) {
    const b = ctx.el('button', 'ghost icon ref-x');
    b.type = 'button';
    b.setAttribute('aria-label', t('Remove {name}', { name: x.token }));
    b.textContent = '✕';
    b.addEventListener('click', () => {
      const input = $('#input');
      input.value = input.value.replace(x.token, '').replace(/ {2,}/g, ' ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    w.append(b);
  }
  return w;
}

/** The chips under a sent message, with "What she got" (the stored text, one click away). */
export function refChipsSent(refs, messageId) {
  const row = ctx.el('div', 'ref-sent');
  row.setAttribute('role', 'list');
  row.setAttribute('aria-label', t('Attached with @'));
  for (const x of refs) row.append(chip({ ...x, reason: x.why }, false));
  if (messageId && refs.some((x) => x.ok)) {
    const d = ctx.el('details', 'ref-got');
    d.append(ctx.el('summary', 'small', t('What she got')));
    d.addEventListener('toggle', async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      try {
        const r = await ctx.api(`/conversations/${ctx.state.currentId}/refs?message=${messageId}`);
        for (const row of r.refs ?? []) {
          const pre = ctx.el('pre', 'ref-got-text', `${row.header}\n${row.text ?? ''}`);
          pre.dataset.raw = '';
          d.append(pre);
        }
      } catch (err) {
        d.append(ctx.el('p', 'muted small', err.message));
      }
    });
    row.append(d);
  }
  return row;
}

/** The reply chip: types clean, or what is left (the list one click away). */
export function checksChip(chip) {
  const w = ctx.el('details', `checks-chip ${chip.state}`);
  const words = chip.state === 'clean'
    ? (chip.fixed ? t('✓ types clean ({checker}) · fixed {n}', { checker: chip.checker, n: chip.fixed }) : t('✓ types clean ({checker})', { checker: chip.checker }))
    : t('⚠ {n} type errors left ({checker})', { n: chip.left, checker: chip.checker });
  w.append(ctx.el('summary', 'small', words));
  if (chip.lines?.length) {
    const pre = ctx.el('pre', 'checks-list', chip.lines.join('\n'));
    pre.dataset.raw = '';
    w.append(pre);
  } else w.append(ctx.el('p', 'muted small', t('No errors in the files she changed.')));
  return w;
}

/** The first-time card of a project: Check her edits here / Not now / Never in this project. */
export function checksCard(card, conversationId) {
  const w = ctx.el('div', 'checks-card');
  w.setAttribute('role', 'group');
  w.setAttribute('aria-label', t('Check her edits'));
  w.append(ctx.el('p', 'checks-card-head', `🔎 ${t('This project can check her edits with its own tools:')}`));
  const ul = ctx.el('ul', 'checks-card-list small');
  for (const c of card.checkers) {
    const li = ctx.el('li');
    const code = ctx.el('code', '', c.argv);
    li.append(code, ctx.el('span', 'muted', ` · ${c.runsProjectCode ? t('runs code from your project (its config)') : t('runs nothing from the project')}`));
    ul.append(li);
  }
  w.append(ul);
  w.append(ctx.el('p', 'muted small', card.direct ? t('They run directly on this computer (no sandbox here), without network, for at most {s} s.', { s: card.timeoutS }) : t('They run in the workspace sandbox, without network, for at most {s} s.', { s: card.timeoutS })));
  const row = ctx.el('div', 'checks-card-buttons');
  const say = ctx.el('p', 'muted small');
  say.setAttribute('role', 'status');
  for (const [answer, label, cls] of [['on', t('Check her edits here'), 'primary'], ['later', t('Not now'), 'ghost'], ['never', t('Never in this project'), 'ghost']]) {
    const b = ctx.el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      for (const x of row.querySelectorAll('button')) x.disabled = true;
      try {
        await ctx.api(`/conversations/${conversationId}/checks/answer`, { method: 'POST', body: { project: card.project, answer } });
        say.textContent = answer === 'on' ? t('On: her next edit here is checked.') : answer === 'never' ? t('Off in this project. You can change it in Settings → Check her edits.') : t('I will ask again another day.');
      } catch (err) {
        say.textContent = err.message;
        for (const x of row.querySelectorAll('button')) x.disabled = false;
      }
    });
    row.append(b);
  }
  w.append(row, say);
  return w;
}

// ------------------------------------------------------------------ Settings → Abilities → Check her edits

const IDS = { 'pc-on': ['checks', 'on'], 'pc-wait': ['checks', 'waitS'], 'pc-timeout': ['checks', 'timeoutS'], 'pc-shown': ['checks', 'shown'], 'pc-warnings': ['checks', 'warnings'], 'pc-nudges': ['checks', 'nudges'], 'pref-on': ['refs', 'on'], 'pref-chars': ['refs', 'perRefChars'], 'pref-urls': ['refs', 'urls'], 'pref-older': ['refs', 'olderAs'] };
const CHOICE = { 'pc-wait': 'waitS', 'pc-timeout': 'timeoutS', 'pc-shown': 'shown', 'pc-nudges': 'nudges', 'pref-chars': 'perRefChars' };

export async function loadPreciseSettings() {
  const form = $('#pc-form');
  if (!form || !ctx) return;
  let v;
  try {
    v = await ctx.api('/precise');
  } catch {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  for (const [id, key] of Object.entries(CHOICE)) {
    const s = $(`#${id}`);
    if (!s || s.options.length) continue;
    for (const n of v.choices[key]) s.append(new Option(key === 'perRefChars' ? n.toLocaleString() : String(n), String(n)));
  }
  for (const [id, [part, key]] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    const val = v.settings[part][key];
    if (c.type === 'checkbox') c.checked = Boolean(val);
    else c.value = String(val);
  }
  form.dataset.loaded = '1';
  await loadProjects();
}

export async function savePreciseSettings() {
  const form = $('#pc-form');
  if (!form?.dataset.loaded || !ctx) return;
  const body = { checks: {}, refs: {} };
  for (const [id, [part, key]] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    body[part][key] = c.type === 'checkbox' ? c.checked : /^(stub|full)$/.test(c.value) ? c.value : Number(c.value);
  }
  await ctx.api('/precise', { method: 'PUT', body });
}

async function loadProjects() {
  const sel = $('#pc-ws');
  const list = $('#pc-projects');
  if (!sel || !list) return;
  if (!sel.options.length) {
    try {
      const r = await ctx.api('/workspaces');
      for (const w of r.workspaces ?? r ?? []) sel.append(new Option(w.name ?? w, w.name ?? w));
    } catch {
      return;
    }
    sel.addEventListener('change', () => void loadProjects());
  }
  const ws = sel.value;
  if (!ws) return;
  let r;
  try {
    r = await ctx.api(`/workspaces/${encodeURIComponent(ws)}/checks`);
  } catch (err) {
    list.replaceChildren(ctx.el('p', 'muted small', err.message));
    return;
  }
  list.replaceChildren(...(r.projects ?? []).map((p) => projectRow(ws, p)));
  if (!r.projects?.length) list.append(ctx.el('p', 'muted small', t('No project in this workspace yet.')));
}

function projectRow(ws, p) {
  const box = ctx.el('div', 'pc-project');
  box.append(ctx.el('h4', '', p.name));
  if (!p.checkers.length) {
    box.append(ctx.el('p', 'muted small', t('No type checker or linter found in this project.')));
    return box;
  }
  const state = document.createElement('select');
  state.setAttribute('aria-label', t('Checks after her edits in {name}', { name: p.name }));
  for (const [v, l] of [['ask', t('Ask the first time')], ['on', t('On')], ['off', t('Off')]]) state.append(new Option(l, v, false, v === p.state));
  const head = ctx.el('div', 'pc-row');
  head.append(ctx.el('span', '', t('Checks after her edits')), state);
  box.append(head);
  const ticks = [];
  for (const c of p.checkers) {
    const row = ctx.el('label', 'pc-checker');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.allowed.includes(c.id) || (!p.allowed.length && c.installed);
    cb.disabled = !c.installed;
    cb.value = c.id;
    ticks.push(cb);
    const code = ctx.el('code', '', c.command);
    row.append(cb, ctx.el('span', '', ` ${c.label} `), code);
    if (c.runsProjectCode) row.append(ctx.el('span', 'muted small', ` · ${t('runs code from your project (its config)')}`));
    if (!c.installed) row.append(ctx.el('span', 'muted small', ` · ${t('Not installed in this project')}: `), ctx.el('code', '', c.install ?? ''));
    if (c.script) row.append(ctx.el('span', 'muted small', ` · ${t('your project’s own script runs the same check')}: `), ctx.el('code', '', c.script));
    const last = p.runs.find((x) => x.checker === c.id);
    if (last) row.append(ctx.el('span', 'muted small', ` · ${t('last run: {state}, {n} errors', { state: t(last.state), n: last.errors + last.otherErrors })}`));
    box.append(row);
  }
  const say = ctx.el('p', 'muted small');
  say.setAttribute('role', 'status');
  const save = async () => {
    const checkers = ticks.filter((x) => x.checked).map((x) => x.value);
    const risky = p.checkers.some((c) => checkers.includes(c.id) && c.runsProjectCode);
    if (state.value === 'on' && risky && !confirm(t('One of these runs code from your project. Confirm to switch it on.'))) {
      state.value = p.state;
      return;
    }
    try {
      await ctx.api(`/workspaces/${encodeURIComponent(ws)}/checks`, { method: 'PUT', body: { project: p.project, state: state.value, checkers, confirm: true } });
      say.textContent = t('Saved.');
    } catch (err) {
      say.textContent = err.message;
    }
  };
  state.addEventListener('change', save);
  for (const x of ticks) x.addEventListener('change', save);
  const actions = ctx.el('div', 'pc-row');
  const run = ctx.el('button', 'ghost small', t('Run now'));
  run.type = 'button';
  run.addEventListener('click', async () => {
    run.disabled = true;
    say.textContent = t('Checking…');
    try {
      const r = await ctx.api(`/workspaces/${encodeURIComponent(ws)}/checks/run`, { method: 'POST', body: { project: p.project } });
      say.textContent = r.runs.map((x) => `${x.checker}: ${t(x.state)} · ${t('{n} errors', { n: x.errors })}`).join(' · ') || t('Nothing to run.');
      await loadProjects();
    } catch (err) {
      say.textContent = err.message;
    } finally {
      run.disabled = false;
    }
  });
  const probs = ctx.el('details', 'pc-problems');
  probs.append(ctx.el('summary', 'small', t('Problems ({n})', { n: p.problems })));
  probs.addEventListener('toggle', async () => {
    if (!probs.open || probs.dataset.loaded) return;
    probs.dataset.loaded = '1';
    const r = await ctx.api(`/workspaces/${encodeURIComponent(ws)}/problems?project=${encodeURIComponent(p.project)}`).catch(() => null);
    const pre = ctx.el('pre', 'checks-list', (r?.problems ?? []).map((d) => `${d.file}:${d.line}:${d.col} ${d.severity}${d.code ? ` ${d.code}` : ''}: ${d.message}`).join('\n') || t('No problems.'));
    pre.dataset.raw = '';
    probs.append(pre);
  });
  actions.append(run, probs);
  box.append(actions, say);
  return box;
}
