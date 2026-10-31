// Phase 99 (ST4, docs/design/STAPLES.md §7.5 and §7.9, docs/BOARD.md): Planner → Board.
// Columns of cards over the planner's to-dos. One drag implementation for mouse, pen and touch
// (pointer events; a long press picks a card up on touch, the screen edge scrolls to the next
// column), the same moves from the keyboard (Space picks up, arrows move, Space drops, Escape
// cancels) with an aria-live line, the phone's one-column-per-screen strip with snap and a column
// tab strip, the card's detail (a side panel on desktop, a sheet on the phone), and her work on a
// card: the live line, the question when it waits on you, and the receipts when it's done.
// Everything the server sends is set as text: no card text ever becomes markup.
import { serverText, t } from './naming.js';
import { icon } from './icons.js';
import { proposalCard } from './proposal-card.js';
import { emptyState } from './tidy.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    void onClick(b, e);
  });
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const VIEW_KEY = 'sara.plannerView';
const BOARD_KEY = 'sara.board';
/** Built-in column names the server stores in English, in the app's language. */
const COLUMN_WORDS = { 'To do': () => t('To do'), Doing: () => t('Doing'), 'Waiting on you': () => t('Waiting on you'), Done: () => t('Done') };
const colName = (c) => (COLUMN_WORDS[c.name] ? COLUMN_WORDS[c.name]() : c.name);
const boardName = (b) => (b.kind === 'everything' ? t('Everything') : b.kind === 'general' ? t('To-dos without a project') : b.name);
const LONG_PRESS_MS = 350;

let ctx = null;
const st = { boards: [], invites: [], people: [], workers: [], settings: { concurrent: 2 }, colors: [], demo: false, boardId: null, view: null, detail: null, drag: null, lift: null, pending: false, loading: null, poll: 0 };

// ---------------- pure helpers (tested in Node) ----------------

/** Where a dropped card lands: the cards above and below it in the column (ids or refs), from the list order. */
export function neighbours(order, ref) {
  const i = order.indexOf(ref);
  if (i < 0) return { after: null, before: null };
  return { after: i > 0 ? order[i - 1] : null, before: i < order.length - 1 ? order[i + 1] : null };
}
/** The index in a column a pointer at y points to, from the cards' vertical middles. */
export function dropIndex(mids, y) {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}
/** "Queued (2nd)" for a place in the queue. */
export function ordinal(n) {
  return n === 1 ? t('1st') : n === 2 ? t('2nd') : n === 3 ? t('3rd') : t('{n}th', { n });
}
/** The aria-live line after a move. */
export function movedLine(title, column, index, of) {
  return t('Moved {title} to {column}, position {index} of {of}', { title, column, index, of });
}

// ---------------- loading ----------------

export function plannerView() {
  return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'tasks';
}
export function rememberView(tab) {
  if (tab === 'board' || tab === 'tasks') localStorage.setItem(VIEW_KEY, tab);
  const wide = tab === 'board';
  $('#planner')?.classList.toggle('bd-wide', wide);
  if (wide) void loadBoard();
}

export async function loadBoard() {
  if (st.loading) return st.loading;
  st.loading = (async () => {
    try {
      const list = await api('/boards');
      st.boards = list.boards;
      st.invites = list.invites ?? [];
      st.people = list.people ?? [];
      st.workers = list.workers ?? [];
      st.settings = list.settings ?? st.settings;
      st.colors = list.labelColors ?? [];
      st.demo = list.demo === true;
      const saved = localStorage.getItem(BOARD_KEY);
      const want = st.boardId !== null && st.boards.some((b) => String(b.id) === String(st.boardId)) ? st.boardId : saved !== null && st.boards.some((b) => String(b.id) === saved) ? saved : st.demo ? st.boards[1]?.id ?? 0 : 0;
      st.boardId = want;
      st.view = await api(`/boards/${encodeURIComponent(String(want))}`);
      render();
    } catch (err) {
      $('#planner-error').textContent = err.message;
    } finally {
      st.loading = null;
    }
  })();
  return st.loading;
}

let refreshTimer = 0;
/** A board event (another tab, her work, a task added in chat): refresh soon, never mid-drag. */
export function boardEvent() {
  if (!$('#planner')?.open || $('#planner .tab-panel[data-panel="board"]')?.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (st.drag || st.lift) st.pending = true;
    else void loadBoard();
  }, 200);
}

// ---------------- rendering ----------------

function isShared() {
  return st.view?.board?.kind === 'shared';
}
function sharedLine(b) {
  const others = (b.members ?? []).filter((m) => m.person !== st.view?.me && m.status === 'member').map((m) => m.name || t('someone'));
  const invited = (b.members ?? []).filter((m) => m.status === 'invited').length;
  if (!others.length) return invited ? t('Shared: waiting for {n} to accept', { n: invited }) : t('Shared board');
  return t('Shared with {names}', { names: others.join(others.length === 2 ? ` ${t('and')} ` : ', ') });
}

function render() {
  const v = st.view;
  if (!v) return;
  const pick = $('#bd-board');
  pick.replaceChildren(
    ...st.boards.map((b) => {
      const o = new Option(`${boardName(b)}${b.kind === 'shared' ? ` · ${t('shared')}` : ''}${b.open ? ` (${b.open})` : ''}`, String(b.id));
      o.selected = String(b.id) === String(st.boardId);
      return o;
    }),
  );
  $('#bd-shared').textContent = isShared() ? sharedLine(v.board) : '';
  $('#bd-gear').hidden = v.board.kind === 'everything';
  renderInvites();
  renderColumns();
  renderTabs();
  if (!$('#bd-settings').hidden) renderSettings();
  if (st.detail) {
    const c = v.cards.find((x) => x.ref === st.detail);
    if (c) fillDetail(c, false);
    else closeDetail();
  }
}

function renderInvites() {
  $('#bd-invites').replaceChildren(
    ...st.invites.map((inv) =>
      proposalCard({
        title: t('Join the board {name}?', { name: inv.name }),
        source: inv.fromName ? t('From {name}', { name: inv.fromName }) : '',
        why: [t('Everyone on a shared board sees its cards and their activity. What Sara does for you stays in your space.')],
        buttons: [
          { label: t('Join'), onClick: async (b) => ((b.disabled = true), await api(`/boards/invites/${encodeURIComponent(inv.boardId)}/accept`, { method: 'POST', body: {} }).catch(showErr), (st.boardId = inv.boardId), await loadBoard()) },
          { label: t('Not now'), cls: 'ghost', onClick: async (b) => ((b.disabled = true), await api(`/boards/invites/${encodeURIComponent(inv.boardId)}/decline`, { method: 'POST', body: {} }).catch(showErr), await loadBoard()) },
        ],
      }),
    ),
  );
}

function cardsIn(col) {
  return st.view.cards.filter((c) => c.columnId === col.id);
}
function queuePlaces() {
  const q = st.view.cards.filter((c) => c.work?.state === 'queued');
  return new Map(q.map((c, i) => [c.ref, i + 1]));
}

function renderColumns() {
  const box = $('#bd-cols');
  const v = st.view;
  const places = queuePlaces();
  box.replaceChildren(
    ...v.columns.map((col, ci) => {
      const cards = cardsIn(col);
      const sec = el('section', `bd-col role-${col.role}`);
      sec.dataset.col = String(col.id);
      sec.dataset.role = col.role;
      sec.setAttribute('aria-labelledby', `bd-col-h-${ci}`);
      const head = el('header', 'bd-col-head');
      const h = el('h4', 'bd-col-name', colName(col));
      h.id = `bd-col-h-${ci}`;
      const count = el('span', 'bd-count', col.wipLimit ? t('{n} of {limit}', { n: cards.length, limit: col.wipLimit }) : String(cards.length));
      if (col.wipLimit && cards.length > col.wipLimit) {
        sec.classList.add('over-wip');
        count.title = t('More cards than the limit of {limit}', { limit: col.wipLimit });
      }
      head.append(h, count);
      const list = el('ol', 'bd-list');
      list.setAttribute('aria-label', colName(col));
      for (const c of cards) list.append(cardEl(c, places));
      if (!cards.length) {
        const empty = el('li', 'bd-col-empty');
        empty.append(el('span', '', col.role === 'done' ? t('Done cards land here.') : col.role === 'waiting' ? t('Nothing waits on you.') : col.role === 'doing' ? t('Nothing in progress.') : t('No cards yet.')));
        list.append(empty);
      }
      sec.append(head, list);
      if (v.board.kind !== 'everything' && col.role !== 'done') sec.append(addCardRow(col));
      return sec;
    }),
  );
  document.querySelector('#planner .bd-empty')?.remove();
  if (!v.cards.length && v.board.kind !== 'everything') box.before(boardEmpty());
}

function boardEmpty() {
  const e = emptyState('🗂️', t('This board is empty.'), 'div', t('Add a card below, or ask her: “put the trip planning on my board”.'));
  e.classList.add('bd-empty');
  return e;
}

function addCardRow(col) {
  const wrap = el('div', 'bd-add');
  const open = btn(t('Add a card'), 'ghost bd-add-open', () => {
    open.hidden = true;
    form.hidden = false;
    input.focus();
  });
  open.prepend(icon('plus') ?? '');
  const form = el('div', 'bd-add-form');
  form.hidden = true;
  const input = el('input', 'bd-add-input');
  input.placeholder = t('What needs doing?');
  input.maxLength = 300;
  input.setAttribute('aria-label', t('New card in {column}', { column: colName(col) }));
  const save = async () => {
    const title = input.value.trim();
    if (!title) return input.focus();
    input.disabled = true;
    try {
      await api(`/boards/${encodeURIComponent(String(st.boardId))}/cards`, { method: 'POST', body: { title, columnId: col.id } });
      input.value = '';
      await loadBoard();
      announce(t('Added {title} to {column}', { title, column: colName(col) }));
      document.querySelector(`.bd-col[data-col="${col.id}"] .bd-add-open`)?.click();
    } catch (err) {
      showErr(err);
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), void save());
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      form.hidden = true;
      open.hidden = false;
      open.focus();
    }
  });
  form.append(input, btn(t('Add'), 'small', save));
  wrap.append(open, form);
  return wrap;
}

function faceSrc() {
  return document.querySelector('#sidebar img.avatar')?.getAttribute('src') || '/sara-avatar.jpg';
}
function assigneeChip(c) {
  const a = c.assignee;
  if (!a) return null;
  const chip = el('span', 'bd-who');
  if (a === 'sara') {
    const img = el('img', 'bd-face');
    img.src = faceSrc();
    img.alt = '';
    chip.append(img);
    chip.title = t('{name} works on it', { name: st.workers.find((w) => w.id === 'sara')?.name ?? 'Sara' });
  } else if (a.startsWith('helper:') || a === 'team') {
    chip.append(icon('team') ?? el('span', '', '👥'));
    chip.title = st.workers.find((w) => w.id === a)?.name ?? t('A helper');
  } else {
    const name = a === 'me' ? t('You') : (st.people.find((p) => `member:${p.id}` === a)?.name ?? st.view.board.members?.find((m) => `member:${m.person}` === a)?.name ?? '?');
    chip.append(el('span', 'bd-initial', name.slice(0, 1).toUpperCase()));
    chip.title = name;
  }
  chip.setAttribute('aria-label', chip.title);
  return chip;
}

function fmtDay(iso) {
  return ctx?.fmtDue ? ctx.fmtDue(iso) : new Date(iso).toLocaleDateString();
}

function cardEl(c, places) {
  const li = el('li', 'bd-card');
  li.tabIndex = 0;
  li.dataset.ref = c.ref;
  li.setAttribute('aria-roledescription', t('card'));
  const w = c.work;
  if (w?.state) li.classList.add(`work-${w.state}`);
  if (c.status === 'done') li.classList.add('is-done');
  if (c.labels.length) {
    const row = el('div', 'bd-labels');
    for (const name of c.labels) {
      const color = st.view.labels.find((l) => l.name === name)?.color ?? 'gray';
      row.append(el('span', `bd-label lbl-${color}`, name));
    }
    li.append(row);
  }
  li.append(el('div', 'bd-title', c.title));
  const meta = el('div', 'bd-meta');
  if (c.project && st.view.board.kind === 'everything') meta.append(el('span', 'bd-chip', c.project));
  if (c.dueAt) {
    const over = c.status === 'open' && Date.parse(c.dueAt) < Date.now();
    const due = el('span', `bd-chip bd-due${over ? ' overdue' : ''}`);
    due.append(icon('calendar') ?? '', el('span', '', over ? t('Overdue: {date}', { date: fmtDay(c.dueAt) }) : fmtDay(c.dueAt)));
    meta.append(due);
  }
  if (c.repeat && c.repeat !== 'none') meta.append(el('span', 'bd-chip', `↻ ${c.repeat === 'daily' ? t('Daily') : c.repeat === 'weekdays' ? t('Weekdays') : c.repeat === 'weekly' ? t('Weekly') : t('Monthly')}`));
  if (c.checklist?.total) meta.append(el('span', `bd-chip${c.checklist.done === c.checklist.total ? ' all-done' : ''}`, `☑ ${c.checklist.done}/${c.checklist.total}`));
  const ok = (w?.receipts ?? []).filter((r) => r.status === 'ok').length;
  if (w?.state === 'done' && ok) meta.append(el('span', 'bd-chip bd-receipts', ok === 1 ? t('1 receipt') : t('{n} receipts', { n: ok })));
  const who = assigneeChip(c);
  if (who) meta.append(who);
  if (meta.childNodes.length) li.append(meta);
  if (w?.state === 'running') {
    const live = el('div', 'bd-live');
    live.append(el('span', 'bd-progress'), el('span', 'bd-line', w.line || t('Working on it')));
    li.append(live);
  } else if (w?.state === 'queued') li.append(el('div', 'bd-line muted', t('Queued ({place})', { place: ordinal(places.get(c.ref) ?? 1) })));
  else if (w?.state === 'waiting') li.append(askEl(c));
  if (w?.suggest === 'done' && c.status === 'open') {
    const row = el('div', 'bd-suggest');
    row.append(el('span', '', t('Move to Done?')), btn(t('Yes'), 'small', () => answerSuggest(c, 'yes')), btn(t('No'), 'ghost small', () => answerSuggest(c, 'no')));
    li.append(row);
  }
  const parts = [c.title, ...c.labels, c.dueAt ? t('due {date}', { date: fmtDay(c.dueAt) }) : '', w?.state === 'waiting' ? t('waiting on you') : w?.state === 'running' ? t('she is working on it') : ''].filter(Boolean);
  li.setAttribute('aria-label', parts.join(', '));
  li.addEventListener('click', () => {
    if (li.dataset.justDragged) return;
    openDetail(c.ref);
  });
  li.addEventListener('keydown', (e) => onCardKey(e, li));
  li.addEventListener('pointerdown', (e) => onPointerDown(e, li));
  return li;
}

function askEl(c) {
  const box = el('div', 'bd-ask');
  const ask = c.work?.ask;
  if (!ask && c.work?.by && c.work.by !== st.view.me) {
    box.append(el('span', '', t('Waiting on the person who asked her')));
    return box;
  }
  box.append(el('p', 'bd-ask-text', ask ? askWords(ask) : t('Waiting on you')));
  const row = el('div', 'bd-ask-buttons');
  if (ask?.approvalId) {
    row.append(btn(t('Allow'), 'small', () => answer(c, { approval: 'allow' })), btn(t('Deny'), 'ghost small', () => answer(c, { approval: 'deny' })));
  } else if (ask?.kind === 'budget') row.append(btn(t('Continue with more budget'), 'small', () => answer(c, { more: true })));
  else if (ask?.kind === 'interrupted' || ask?.kind === 'failed' || ask?.kind === 'unproven') row.append(btn(t('Answer'), 'ghost small', () => openDetail(c.ref, true)), btn(t('Continue'), 'small', () => answer(c, { resume: true })));
  else row.append(btn(t('Answer'), 'small', () => openDetail(c.ref, true)));
  box.append(row);
  return box;
}
/** Her question, in the app's language where the words are the app's own. */
function askWords(ask) {
  const own = {
    'The server restarted while I was working on this. Continue?': () => t('The server restarted while I was working on this. Continue?'),
    'The team stopped at its limit. Continue with more budget?': () => t('The team stopped at its limit. Continue with more budget?'),
    'Helpers work for the owner only (Settings → Team).': () => t('Helpers work for the owner only (Settings → Team).'),
  };
  if (own[ask.text]) return own[ask.text]();
  if (ask.kind === 'approval') return t('She needs your OK: {what}', { what: ask.text });
  if (ask.kind === 'unproven') return ask.text.replace("I think it's done, but I couldn't prove:", t("I think it's done, but I couldn't prove:"));
  return ask.text;
}

async function answer(c, body) {
  try {
    await api(`/tasks/${encodeURIComponent(c.ref)}/answer`, { method: 'POST', body });
    announce(t('Answered. She carries on.'));
    await loadBoard();
  } catch (err) {
    showErr(err);
  }
}
async function answerSuggest(c, yes) {
  try {
    await api(`/tasks/${encodeURIComponent(c.ref)}/answer`, { method: 'POST', body: { suggest: yes } });
    await loadBoard();
  } catch (err) {
    showErr(err);
  }
}

function renderTabs() {
  const nav = $('#bd-tabs');
  const cols = st.view.columns;
  nav.replaceChildren(
    ...cols.map((col, i) => {
      const b = btn(`${colName(col)} ${cardsIn(col).length}`, 'bd-tab', () => {
        const sec = document.querySelectorAll('#bd-cols .bd-col')[i];
        sec?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', inline: 'start', block: 'nearest' });
      });
      b.dataset.i = String(i);
      return b;
    }),
  );
  markTab();
}
function markTab() {
  const box = $('#bd-cols');
  const secs = [...box.querySelectorAll('.bd-col')];
  if (!secs.length) return;
  const left = box.getBoundingClientRect().left;
  let best = 0;
  let bestDist = Infinity;
  secs.forEach((s, i) => {
    const d = Math.abs(s.getBoundingClientRect().left - left);
    if (d < bestDist) (bestDist = d), (best = i);
  });
  for (const b of document.querySelectorAll('#bd-tabs .bd-tab')) b.setAttribute('aria-current', b.dataset.i === String(best) ? 'true' : 'false');
}

function announce(text) {
  const live = $('#bd-live');
  live.textContent = '';
  // A fresh text node each time so screen readers read repeats too.
  setTimeout(() => (live.textContent = text), 30);
}
function showErr(err) {
  $('#planner-error').textContent = err?.message ?? String(err);
}

// ---------------- moving: the shared commit ----------------

function colOf(li) {
  return li.closest('.bd-col');
}
function orderIn(sec) {
  return [...sec.querySelectorAll('.bd-card')].map((x) => x.dataset.ref);
}
async function commitMove(li, quiet = false) {
  const sec = colOf(li);
  const ref = li.dataset.ref;
  const card = st.view.cards.find((c) => c.ref === ref);
  const { after, before } = neighbours(orderIn(sec), ref);
  const columnId = Number(sec.dataset.col);
  try {
    const r = await api(`/tasks/${encodeURIComponent(ref)}/move`, { method: 'POST', body: { columnId, after, before, boardId: st.boardId } });
    const order = orderIn(sec);
    const index = r.place?.index ?? order.indexOf(ref) + 1;
    const of = r.place?.of ?? order.length;
    const col = st.view.columns.find((c) => c.id === columnId);
    if (!quiet) announce(movedLine(card?.title ?? '', col ? colName(col) : '', index, of));
  } catch (err) {
    showErr(err);
  }
  await loadBoard();
  document.querySelector(`.bd-card[data-ref="${CSS.escape(ref)}"]`)?.focus();
}

// ---------------- keyboard ----------------

function onCardKey(e, li) {
  const lifted = st.lift?.ref === li.dataset.ref;
  const cols = [...document.querySelectorAll('#bd-cols .bd-col')];
  const sec = colOf(li);
  const ci = cols.indexOf(sec);
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (!lifted) {
      st.lift = { ref: li.dataset.ref, home: sec, next: li.nextElementSibling };
      li.classList.add('bd-lifted');
      li.setAttribute('aria-grabbed', 'true');
      announce(t('Picked up {title}. Arrow keys move it, Space drops it, Escape cancels.', { title: li.querySelector('.bd-title')?.textContent ?? '' }));
    } else {
      st.lift = null;
      li.classList.remove('bd-lifted');
      li.removeAttribute('aria-grabbed');
      void commitMove(li);
    }
    return;
  }
  if (e.key === 'Escape' && lifted) {
    e.preventDefault();
    e.stopPropagation();
    const { home, next } = st.lift;
    const list = home.querySelector('.bd-list');
    if (next && next.parentNode === list) list.insertBefore(li, next);
    else list.append(li);
    st.lift = null;
    li.classList.remove('bd-lifted');
    li.removeAttribute('aria-grabbed');
    li.focus();
    announce(t('Move cancelled. {title} is back in {column}.', { title: li.querySelector('.bd-title')?.textContent ?? '', column: home.querySelector('.bd-col-name')?.textContent ?? '' }));
    if (st.pending) (st.pending = false), void loadBoard();
    return;
  }
  if (e.key === 'Enter' && !lifted) {
    e.preventDefault();
    openDetail(li.dataset.ref);
    return;
  }
  const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const d = arrows[e.key];
  if (!d) return;
  e.preventDefault();
  const where = () => {
    const s = colOf(li);
    const order = orderIn(s);
    return t('{column}, position {index} of {of}', { column: s.querySelector('.bd-col-name')?.textContent ?? '', index: order.indexOf(li.dataset.ref) + 1, of: order.length });
  };
  if (lifted) {
    const list = sec.querySelector('.bd-list');
    if (d[1] === -1) {
      const prev = li.previousElementSibling;
      if (prev?.classList.contains('bd-card')) list.insertBefore(li, prev);
    } else if (d[1] === 1) {
      const next = li.nextElementSibling;
      if (next?.classList.contains('bd-card')) list.insertBefore(next, li);
    } else {
      const target = cols[ci + d[0]];
      if (!target) return announce(where());
      const tl = target.querySelector('.bd-list');
      const index = [...sec.querySelectorAll('.bd-card')].indexOf(li);
      const cards = [...tl.querySelectorAll('.bd-card')];
      tl.querySelector('.bd-col-empty')?.remove();
      if (cards[index]) tl.insertBefore(li, cards[index]);
      else tl.append(li);
      target.scrollIntoView({ behavior: 'auto', inline: 'nearest', block: 'nearest' });
    }
    li.focus();
    announce(where());
    return;
  }
  // Not lifted: the arrows walk between cards.
  if (d[1]) {
    const cards = [...sec.querySelectorAll('.bd-card')];
    cards[cards.indexOf(li) + d[1]]?.focus();
  } else {
    for (let i = ci + d[0]; i >= 0 && i < cols.length; i += d[0]) {
      const first = cols[i].querySelector('.bd-card');
      if (first) {
        first.focus();
        first.scrollIntoView({ behavior: 'auto', inline: 'nearest', block: 'nearest' });
        break;
      }
    }
  }
}

// ---------------- pointer drag (mouse, pen and touch) ----------------

function onPointerDown(e, li) {
  if (e.button !== 0 || st.lift || e.target.closest('button, a, input, select, textarea')) return;
  const touch = e.pointerType === 'touch';
  const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  let timer = 0;
  const cleanup = () => {
    clearTimeout(timer);
    li.removeEventListener('pointermove', early);
    li.removeEventListener('pointerup', cleanup);
    li.removeEventListener('pointercancel', cleanup);
  };
  const begin = (ev) => {
    cleanup();
    startDrag(li, ev ?? e, start);
  };
  const early = (ev) => {
    const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    if (touch && dist > 8) cleanup(); // it's a scroll, not a pick-up
    else if (!touch && dist > 5) begin(ev);
  };
  li.addEventListener('pointermove', early);
  li.addEventListener('pointerup', cleanup);
  li.addEventListener('pointercancel', cleanup);
  if (touch) timer = setTimeout(() => begin(null), LONG_PRESS_MS);
}

function startDrag(li, e, start) {
  const rect = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('bd-ghost');
  ghost.removeAttribute('tabindex');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.setProperty('--w', `${rect.width}px`);
  const ph = el('li', 'bd-ph');
  ph.style.setProperty('--h', `${rect.height}px`);
  li.after(ph);
  li.classList.add('bd-dragging-src');
  const root = $('#planner');
  root.append(ghost);
  root.classList.add('bd-is-dragging');
  st.drag = { li, ghost, ph, dx: start.x - rect.left, dy: start.y - rect.top, x: e.clientX, y: e.clientY, pointer: e.pointerId, raf: 0, home: colOf(li), next: ph.nextElementSibling, touch: e.pointerType === 'touch', edge: undefined };
  try {
    // The window holds the pointer (not the card: it scrolls out of view with its column).
    root.setPointerCapture(e.pointerId);
  } catch {
    /* the pointer is gone already */
  }
  if (e.pointerType === 'touch') navigator.vibrate?.(12);
  window.SaraPhone?.haptic?.('pickup');
  place(e.clientX, e.clientY);
  // On the document, not the card: the card is out of the flow while it's carried.
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
  document.addEventListener('keydown', onDragKey, true);
  tickScroll();
  announce(t('Picked up {title}.', { title: li.querySelector('.bd-title')?.textContent ?? '' }));
}

function place(x, y) {
  const d = st.drag;
  d.x = x;
  d.y = y;
  d.ghost.style.setProperty('--x', `${x - d.dx}px`);
  d.ghost.style.setProperty('--y', `${y - d.dy}px`);
  const under = document.elementFromPoint(x, y);
  // Below a short column (an empty one on the phone) still means that column.
  const sec = under?.closest?.('#bd-cols .bd-col') ?? [...document.querySelectorAll('#bd-cols .bd-col')].find((s) => {
    const r = s.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top;
  });
  if (!sec) return;
  const list = sec.querySelector('.bd-list');
  const cards = [...list.querySelectorAll('.bd-card')].filter((c) => c !== d.li);
  const i = dropIndex(cards.map((c) => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2;
  }), y);
  list.querySelector('.bd-col-empty')?.classList.add('bd-hide');
  if (cards[i]) list.insertBefore(d.ph, cards[i]);
  else list.append(d.ph);
  for (const s of document.querySelectorAll('#bd-cols .bd-col')) s.classList.toggle('bd-target', s === sec);
}

function onDragMove(e) {
  if (!st.drag || e.pointerId !== st.drag.pointer) return;
  e.preventDefault();
  place(e.clientX, e.clientY);
}
/** Near the edge of the columns strip it scrolls (on the phone that's the next column). */
function tickScroll() {
  const d = st.drag;
  if (!d) return;
  const box = $('#bd-cols');
  const r = box.getBoundingClientRect();
  const edge = Math.min(48, r.width / 6);
  let dx = 0;
  if (d.x < r.left + edge) dx = -Math.ceil((r.left + edge - d.x) / 4);
  else if (d.x > r.right - edge) dx = Math.ceil((d.x - (r.right - edge)) / 4);
  // Never push past either end (that reads as an overscroll and the browser cancels the touch).
  if (dx < 0 && box.scrollLeft <= 0) dx = 0;
  if (dx > 0 && box.scrollLeft >= box.scrollWidth - box.clientWidth - 1) dx = 0;
  if (d.touch) {
    // On the phone the strip never scrolls under a held finger (browsers cancel the touch then):
    // a finger at the screen edge targets the next column instead, and the drop lands there.
    const secs = [...box.querySelectorAll('.bd-col')];
    const at = secs.findIndex((s) => Math.abs(s.getBoundingClientRect().left - r.left) < s.offsetWidth / 2);
    const target = dx ? secs[(at < 0 ? 0 : at) + Math.sign(dx)] : undefined;
    if (target !== d.edge) {
      d.edge = target;
      edgeHint(target, Math.sign(dx));
      if (target) window.SaraPhone?.haptic?.('tick');
    }
    dx = 0;
  }
  if (dx) {
    box.scrollLeft += dx;
    place(d.x, d.y);
  }
  d.raf = requestAnimationFrame(tickScroll);
}
/** The phone's edge target: "Move to Done →" at the side the finger rests on. */
function edgeHint(col, side) {
  let hint = document.querySelector('#bd-edge');
  if (!col) return hint?.remove();
  if (!hint) {
    hint = el('div', 'bd-edge');
    hint.id = 'bd-edge';
    hint.setAttribute('aria-hidden', 'true');
    $('#planner').append(hint);
  }
  hint.classList.toggle('left', side < 0);
  hint.textContent = side < 0 ? `← ${col.querySelector('.bd-col-name')?.textContent ?? ''}` : `${col.querySelector('.bd-col-name')?.textContent ?? ''} →`;
}

function endDrag() {
  const d = st.drag;
  edgeHint(null);
  cancelAnimationFrame(d.raf);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
  document.removeEventListener('keydown', onDragKey, true);
  d.ghost.remove();
  $('#planner').classList.remove('bd-is-dragging');
  d.li.classList.remove('bd-dragging-src');
  for (const s of document.querySelectorAll('#bd-cols .bd-col')) s.classList.remove('bd-target');
  // A click right after a drag is the drop, not "open the card".
  d.li.dataset.justDragged = '1';
  setTimeout(() => delete d.li.dataset.justDragged, 300);
  st.drag = null;
}
function onDragEnd(e) {
  const d = st.drag;
  if (!d || (e && e.pointerId !== d.pointer)) return;
  // Dropped on the phone's edge target: the bottom of that column, which then slides into view.
  const edge = d.edge;
  if (edge) {
    edge.querySelector('.bd-list').append(d.ph);
    setTimeout(() => edge.scrollIntoView({ behavior: 'auto', inline: 'start', block: 'nearest' }), 0);
  }
  const moved = d.ph.parentNode && (colOf(d.ph) !== d.home || d.ph.nextElementSibling !== d.next);
  d.ph.replaceWith(d.li);
  endDrag();
  window.SaraPhone?.haptic?.('drop');
  if (moved) void commitMove(d.li);
  else if (st.pending) (st.pending = false), void loadBoard();
}
function onDragCancel(e) {
  const d = st.drag;
  if (!d || (e?.pointerId !== undefined && e.pointerId !== d.pointer)) return;
  d.ph.remove();
  endDrag();
  announce(t('Move cancelled.'));
  if (st.pending) (st.pending = false), void loadBoard();
}
function onDragKey(e) {
  if (e.key === 'Escape' && st.drag) {
    e.preventDefault();
    e.stopPropagation();
    onDragCancel();
  }
}

// ---------------- the card's detail ----------------

function openDetail(ref, focusAnswer = false) {
  const c = st.view?.cards.find((x) => x.ref === ref);
  if (!c) return;
  st.detail = ref;
  fillDetail(c, true);
  const panel = $('#bd-detail');
  panel.hidden = false;
  $('#planner').classList.add('bd-detail-open');
  (focusAnswer ? $('#cd-answer') : $('#cd-title'))?.focus();
  void loadActivity(c);
}
function closeDetail() {
  st.detail = null;
  $('#bd-detail').hidden = true;
  $('#planner').classList.remove('bd-detail-open');
}

function fillDetail(c, fresh) {
  $('#cd-head').textContent = isShared() ? t('Card on a shared board') : t('Card');
  if (fresh || document.activeElement !== $('#cd-title')) $('#cd-title').value = c.title;
  if (fresh || document.activeElement !== $('#cd-notes')) $('#cd-notes').value = c.notes;
  $('#cd-due').value = c.dueAt ? new Date(c.dueAt).toLocaleDateString('en-CA') : '';
  $('#cd-repeat').value = c.repeat ?? 'none';
  $('#cd-repeat').disabled = isShared();
  // Move to…: the board's columns, this card's selected.
  const pick = $('#cd-column');
  pick.replaceChildren(
    ...st.view.columns.map((col) => {
      const o = el('option', '', colName(col));
      o.value = String(col.id);
      return o;
    }),
  );
  pick.value = String(c.columnId);
  // Checklist from the notes' "- [ ]" lines, ticked here.
  const lines = c.notes.split('\n').filter((l) => /^\s*[-*] \[( |x|X)\]\s/.test(l));
  $('#cd-checklist').replaceChildren(
    ...lines.map((l, i) => {
      const row = el('label', 'cd-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !/\[ \]/.test(l);
      box.addEventListener('change', async () => {
        try {
          await api(`/tasks/${encodeURIComponent(c.ref)}/check`, { method: 'POST', body: { index: i, done: box.checked } });
          await loadBoard();
        } catch (err) {
          showErr(err);
        }
      });
      row.append(box, el('span', '', l.replace(/^\s*[-*] \[( |x|X)\]\s*/, '')));
      return row;
    }),
  );
  // Labels: toggles from the board's labels.
  $('#cd-labels').replaceChildren(
    ...(st.view.labels.length
      ? st.view.labels.map((l) => {
          const on = c.labels.includes(l.name);
          const b = btn(l.name, `bd-label lbl-${l.color} cd-label${on ? ' on' : ''}`, async () => {
            const next = on ? c.labels.filter((x) => x !== l.name) : [...c.labels, l.name];
            try {
              await api(`/tasks/${encodeURIComponent(c.ref)}/card`, { method: 'PUT', body: { labels: next } });
              await loadBoard();
            } catch (err) {
              showErr(err);
            }
          });
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          return b;
        })
      : [el('span', 'muted small', st.view.board.kind === 'everything' ? t('Labels are set on each project’s board.') : t('No labels yet: add some in Board settings.'))]),
  );
  // Who works on it.
  const sel = $('#cd-assignee');
  const opts = [new Option(t('Nobody yet'), ''), new Option(t('Me'), 'me')];
  for (const w of st.workers) opts.push(new Option(w.id === 'sara' ? t('{name} (works on it now)', { name: w.name }) : w.id === 'team' ? t('A team of helpers') : t('Helper: {name}', { name: w.name }), w.id));
  if (isShared()) for (const m of st.view.board.members ?? []) if (m.person !== st.view.me && m.status === 'member') opts.push(new Option(m.name || m.person, `member:${m.person}`));
  sel.replaceChildren(...opts);
  sel.value = c.assignee ?? '';
  sel.disabled = c.work?.state === 'running' || c.work?.state === 'queued';
  const l = c.limits ?? {};
  $('#cd-lim-minutes').value = l.minutes && [10, 30, 60, 120].includes(l.minutes) ? String(l.minutes) : '';
  $('#cd-lim-tokens').value = l.tokens && [50000, 100000, 400000, 1000000].includes(l.tokens) ? String(l.tokens) : '';
  $('#cd-lim-steps').value = l.steps && [5, 14, 25, 40].includes(l.steps) ? String(l.steps) : '';
  renderWork(c);
}

function renderWork(c) {
  const box = $('#cd-work');
  const w = c.work;
  const out = [];
  if (w?.state) {
    const words = { queued: t('Queued'), running: t('Working on it'), waiting: t('Waiting on you'), done: t('Done'), stopped: t('Stopped'), failed: t('Stopped with a problem'), interrupted: t('Stopped by a restart') };
    const head = el('div', `cd-state state-${w.state}`);
    head.append(el('span', 'cd-dot'), el('strong', '', words[w.state] ?? w.state));
    if (w.used?.tokens) head.append(el('span', 'muted small', t('{tokens} tokens, {steps} steps', { tokens: w.used.tokens.toLocaleString(), steps: w.used.steps })));
    out.push(head);
    if (w.line) out.push(el('p', 'cd-line', w.line));
    if (w.state === 'waiting') {
      out.push(askEl(c));
      if (!w.ask?.approvalId && w.ask?.kind !== 'budget') {
        const ta = el('textarea', 'cd-answer');
        ta.id = 'cd-answer';
        ta.rows = 2;
        ta.placeholder = t('Your answer');
        ta.setAttribute('aria-label', t('Your answer'));
        out.push(ta, btn(t('Send the answer'), 'small', async () => {
          if (!ta.value.trim()) return ta.focus();
          await answer(c, { text: ta.value.trim() });
        }));
      }
    }
    const rec = (w.receipts ?? []).filter((r) => r.status === 'ok');
    if (rec.length) {
      out.push(el('h4', 'cd-sub', t('Receipts')));
      const ul = el('ul', 'cd-receipts');
      for (const r of rec.slice(-12)) {
        const li = el('li');
        li.append(el('span', 'cd-tool', r.tool), el('span', '', r.summary));
        ul.append(li);
      }
      out.push(ul);
    }
    const row = el('div', 'cd-work-buttons');
    if (w.conversationId && ctx?.openConversation) row.append(btn(t('Open her work'), 'ghost small', () => {
      $('#planner').close();
      ctx.openConversation(w.conversationId);
    }));
    if (['running', 'queued', 'waiting'].includes(w.state) && (!w.by || w.by === st.view.me)) row.append(btn(t('Stop'), 'ghost small danger', async () => {
      try {
        await api(`/tasks/${encodeURIComponent(c.ref)}/work/stop`, { method: 'POST', body: {} });
        announce(t('Stopped.'));
        await loadBoard();
      } catch (err) {
        showErr(err);
      }
    }));
    if (row.childNodes.length) out.push(row);
  } else if (st.workers.some((x) => x.id === 'sara') && c.status === 'open') {
    out.push(btn(t('Ask {name} to work on it', { name: st.workers.find((x) => x.id === 'sara').name }), 'small cd-assign-her', () => assign(c, 'sara')));
  }
  box.replaceChildren(...out);
}

async function assign(c, to) {
  try {
    await api(`/tasks/${encodeURIComponent(c.ref)}/assign`, { method: 'POST', body: { assignee: to || null } });
    if (to === 'sara' || to?.startsWith('helper:') || to === 'team') announce(t('She starts on {title}.', { title: c.title }));
    await loadBoard();
  } catch (err) {
    showErr(err);
  }
}

const WHAT = {
  created: () => t('added it'), moved: () => t('moved it'), edited: () => t('changed it'), assigned: () => t('assigned it'), started: () => t('started on it'),
  asked: () => t('asked'), answered: () => t('answered'), receipt: () => t('finished, with receipts'), done: () => t('marked it done'), failed: () => t('stopped'), comment: () => t('commented'),
};
async function loadActivity(c) {
  try {
    const { activity } = await api(`/tasks/${encodeURIComponent(c.ref)}/activity`);
    const who = (w) => (w === 'me' ? t('You') : w === 'sara' ? (st.workers.find((x) => x.id === 'sara')?.name ?? 'Sara') : w.startsWith('member:') ? (w.slice(7) === st.view.me ? t('You') : (st.view.board.members?.find((m) => m.person === w.slice(7))?.name ?? t('Someone'))) : w.startsWith('helper:') ? (st.workers.find((x) => x.id === w)?.name ?? t('A helper')) : w);
    $('#cd-activity').replaceChildren(
      ...(activity.length
        ? activity.slice(-40).reverse().map((a) => {
            const li = el('li');
            const extra = a.what === 'moved' && a.detail.to ? ` → ${COLUMN_WORDS[a.detail.to] ? COLUMN_WORDS[a.detail.to]() : a.detail.to}` : a.what === 'comment' || a.what === 'answered' ? `: ${a.detail.text ?? (a.detail.approval === 'allow' ? t('Allow') : a.detail.approval === 'deny' ? t('Deny') : '')}` : a.what === 'asked' ? `: ${a.detail.question ?? a.detail.approval ?? a.detail.budget ?? ''}` : '';
            li.append(el('strong', '', who(a.who)), el('span', '', ` ${(WHAT[a.what] ?? (() => a.what))()}${extra}`), el('time', 'muted small', new Date(a.at).toLocaleString()));
            return li;
          })
        : [el('li', 'muted small', t('Nothing yet.'))]),
    );
  } catch {
    /* the card went away */
  }
}

async function saveDetail() {
  const c = st.view?.cards.find((x) => x.ref === st.detail);
  if (!c) return;
  const status = $('#cd-status');
  status.textContent = t('Saving…');
  try {
    const lim = { minutes: $('#cd-lim-minutes').value, tokens: $('#cd-lim-tokens').value, steps: $('#cd-lim-steps').value };
    const anyLim = lim.minutes || lim.tokens || lim.steps;
    await api(`/tasks/${encodeURIComponent(c.ref)}/card`, {
      method: 'PUT',
      body: { title: $('#cd-title').value, notes: $('#cd-notes').value, due: $('#cd-due').value || null, ...(isShared() ? {} : { repeat: $('#cd-repeat').value }), limits: anyLim ? Object.fromEntries(Object.entries(lim).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])) : null },
    });
    const to = $('#cd-assignee').value;
    if ((c.assignee ?? '') !== to) await assign(c, to);
    status.textContent = t('Saved');
    await loadBoard();
  } catch (err) {
    status.textContent = err.message;
  }
}

// ---------------- board settings ----------------

function renderSettings() {
  const v = st.view;
  $('#bd-concurrent').value = String(st.settings.concurrent ?? 2);
  $('#bd-concurrent').disabled = st.demo;
  $('#bd-col-list').replaceChildren(
    ...v.columns.map((col) => {
      const row = el('div', 'bd-col-row');
      const name = el('input');
      name.value = colName(col);
      name.maxLength = 40;
      name.setAttribute('aria-label', t('Column name'));
      const wip = el('select');
      wip.setAttribute('aria-label', t('Limit for {column}', { column: colName(col) }));
      wip.title = t('A limit warns when the column holds more cards (work in progress).');
      for (const n of ['', '1', '2', '3', '4', '5', '8', '10']) wip.append(new Option(n ? n : t('No limit'), n));
      wip.value = col.wipLimit ? String(col.wipLimit) : '';
      const save = async () => {
        try {
          await api(`/columns/${col.id}`, { method: 'PUT', body: { ...(name.value.trim() && name.value.trim() !== colName(col) ? { name: name.value.trim() } : {}), wipLimit: wip.value ? Number(wip.value) : null, ...(isShared() ? { shared: true } : {}) } });
          await loadBoard();
        } catch (err) {
          showErr(err);
        }
      };
      name.addEventListener('change', save);
      wip.addEventListener('change', save);
      row.append(el('span', `bd-role-dot role-${col.role}`), name, wip);
      return row;
    }),
  );
  $('#bd-label-color').replaceChildren(...st.colors.map((c) => new Option(COLOR_WORDS[c]?.() ?? c, c)));
  $('#bd-label-list').replaceChildren(
    ...(v.labels.length
      ? v.labels.map((l) => {
          const chip = el('span', `bd-label lbl-${l.color}`, l.name);
          const x = btn('×', 'ghost small icon-only', async () => saveLabels(v.labels.filter((y) => y.name !== l.name)));
          x.setAttribute('aria-label', t('Remove the label {name}', { name: l.name }));
          const wrap = el('span', 'bd-label-edit');
          wrap.append(chip, x);
          return wrap;
        })
      : [el('span', 'muted small', t('No labels yet.'))]),
  );
  const shared = isShared();
  $('#bd-leave').hidden = !shared || v.board.members?.find((m) => m.person === v.me)?.role === 'owner';
  $('#bd-delete').hidden = !(shared ? v.board.members?.find((m) => m.person === v.me)?.role === 'owner' : v.board.kind === 'custom');
  $('#bd-share-h').hidden = !shared;
  $('#bd-share-save').hidden = !shared || !st.people.length;
  $('#bd-share-list').hidden = !shared;
  if (shared) {
    const on = new Set((v.board.members ?? []).map((m) => m.person));
    $('#bd-share-list').replaceChildren(
      ...(st.people.length
        ? st.people.map((p) => {
            const row = el('label', 'row');
            const box = el('input');
            box.type = 'checkbox';
            box.value = p.id;
            box.checked = on.has(p.id);
            box.disabled = on.has(p.id);
            const m = v.board.members?.find((x) => x.person === p.id);
            row.append(box, el('span', '', `${p.name}${m?.status === 'invited' ? ` · ${t('invited')}` : m ? ` · ${t('on the board')}` : ''}`));
            return row;
          })
        : [el('p', 'muted small', t('Nobody else is in your household yet.'))]),
    );
  }
}
const COLOR_WORDS = { red: () => t('Red'), orange: () => t('Orange'), yellow: () => t('Yellow'), green: () => t('Green'), teal: () => t('Teal'), blue: () => t('Blue'), purple: () => t('Purple'), pink: () => t('Pink'), gray: () => t('Gray') };

async function saveLabels(labels) {
  try {
    await api(`/boards/${encodeURIComponent(String(st.boardId))}`, { method: 'PUT', body: { labels } });
    await loadBoard();
  } catch (err) {
    showErr(err);
  }
}

async function newBoard() {
  const name = prompt(t('Name the new board'));
  if (!name?.trim()) return;
  let people = [];
  if (st.people.length && confirm(t('Share it with people in your household? They each accept an invitation first.'))) people = st.people.map((p) => p.id);
  try {
    const b = await api('/boards', { method: 'POST', body: people.length ? { name: name.trim(), shared: true, people } : { name: name.trim() } });
    st.boardId = b.id;
    localStorage.setItem(BOARD_KEY, String(b.id));
    await loadBoard();
  } catch (err) {
    showErr(err);
  }
}

/** Opens Planner → Board on a card (Today's Needs you / Doing). */
export async function openCardOnBoard(boardId, ref) {
  st.boardId = boardId;
  await ctx.openPlanner('board');
  await loadBoard();
  openDetail(String(ref), true);
}

export function initBoard(c) {
  ctx = c;
  if (!$('#bd-cols')) return;
  $('#bd-board').addEventListener('change', async () => {
    st.boardId = $('#bd-board').value;
    localStorage.setItem(BOARD_KEY, String(st.boardId));
    closeDetail();
    await loadBoard();
  });
  $('#bd-new').addEventListener('click', newBoard);
  $('#bd-gear').addEventListener('click', () => {
    const s = $('#bd-settings');
    s.hidden = !s.hidden;
    $('#bd-gear').setAttribute('aria-expanded', s.hidden ? 'false' : 'true');
    if (!s.hidden) renderSettings();
  });
  $('#bd-concurrent').addEventListener('change', async () => {
    try {
      st.settings = await api('/boards/settings', { method: 'PUT', body: { concurrent: Number($('#bd-concurrent').value) } });
      $('#bd-settings-status').textContent = t('Saved');
    } catch (err) {
      showErr(err);
    }
  });
  $('#bd-col-add').addEventListener('click', async () => {
    const name = $('#bd-col-name').value.trim();
    if (!name) return $('#bd-col-name').focus();
    try {
      await api(`/boards/${encodeURIComponent(String(st.boardId))}/columns`, { method: 'POST', body: { name, role: 'other', wipLimit: $('#bd-col-wip').value ? Number($('#bd-col-wip').value) : null } });
      $('#bd-col-name').value = '';
      await loadBoard();
    } catch (err) {
      showErr(err);
    }
  });
  $('#bd-label-add').addEventListener('click', async () => {
    const name = $('#bd-label-name').value.trim();
    if (!name) return $('#bd-label-name').focus();
    await saveLabels([...st.view.labels, { name, color: $('#bd-label-color').value }]);
    $('#bd-label-name').value = '';
  });
  $('#bd-share-save').addEventListener('click', async () => {
    const people = [...document.querySelectorAll('#bd-share-list input:checked:not(:disabled)')].map((x) => x.value);
    if (!people.length) return;
    try {
      await api(`/boards/${encodeURIComponent(String(st.boardId))}/share`, { method: 'POST', body: { people } });
      $('#bd-settings-status').textContent = t('Invited. They see an invitation to accept.');
      await loadBoard();
    } catch (err) {
      showErr(err);
    }
  });
  $('#bd-leave').addEventListener('click', async () => {
    if (!confirm(t('Leave this board? You no longer see its cards.'))) return;
    await api(`/boards/${encodeURIComponent(String(st.boardId))}/leave`, { method: 'POST', body: {} }).catch(showErr);
    st.boardId = null;
    await loadBoard();
  });
  $('#bd-delete').addEventListener('click', async () => {
    if (!confirm(isShared() ? t('Delete this shared board for everyone? People assigned to a card keep a copy in their own planner.') : t('Delete this board? Its cards go back to their project’s board.'))) return;
    await api(`/boards/${encodeURIComponent(String(st.boardId))}`, { method: 'DELETE' }).catch(showErr);
    st.boardId = null;
    localStorage.removeItem(BOARD_KEY);
    await loadBoard();
  });
  $('#cd-column').addEventListener('change', async () => {
    const ref = st.detail;
    const columnId = Number($('#cd-column').value);
    const card = st.view?.cards.find((c) => c.ref === ref);
    if (!ref || !card || card.columnId === columnId) return;
    const last = st.view.cards.filter((c) => c.columnId === columnId && c.ref !== ref).at(-1);
    try {
      const r = await api(`/tasks/${encodeURIComponent(ref)}/move`, { method: 'POST', body: { columnId, after: last?.ref ?? null, before: null, boardId: st.boardId } });
      const col = st.view.columns.find((x) => x.id === columnId);
      announce(movedLine(card.title, col ? colName(col) : '', r.place?.index ?? 1, r.place?.of ?? 1));
    } catch (err) {
      showErr(err);
    }
    await loadBoard();
  });
  $('#cd-close').addEventListener('click', closeDetail);
  $('#cd-save').addEventListener('click', saveDetail);
  $('#cd-delete').addEventListener('click', async () => {
    const c = st.view?.cards.find((x) => x.ref === st.detail);
    if (!c || !confirm(t('Delete "{title}"?', { title: c.title }))) return;
    try {
      await api(`/tasks/${encodeURIComponent(c.ref)}${isShared() ? '/card' : ''}`, { method: 'DELETE' });
      closeDetail();
      await loadBoard();
    } catch (err) {
      showErr(err);
    }
  });
  $('#cd-comment-add').addEventListener('click', async () => {
    const c = st.view?.cards.find((x) => x.ref === st.detail);
    const text = $('#cd-comment').value.trim();
    if (!c || !text) return;
    try {
      await api(`/tasks/${encodeURIComponent(c.ref)}/comment`, { method: 'POST', body: { text } });
      $('#cd-comment').value = '';
      await loadActivity(c);
    } catch (err) {
      showErr(err);
    }
  });
  $('#bd-detail').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const ref = st.detail;
      closeDetail();
      document.querySelector(`.bd-card[data-ref="${CSS.escape(ref ?? '')}"]`)?.focus();
    }
  });
  $('#bd-cols').addEventListener('scroll', () => requestAnimationFrame(markTab), { passive: true });
  // While a card is picked up by touch the page must not scroll under the finger.
  $('#bd-cols').addEventListener('touchmove', (e) => {
    if (st.drag) e.preventDefault();
  }, { passive: false });
  // While her work runs on the demo, the scripted run moves on by itself.
  setInterval(() => {
    if (!st.demo || !st.view || !$('#planner')?.open) return;
    if (st.view.cards.some((c) => c.work?.state === 'running')) void loadBoard();
  }, 1200);
}
