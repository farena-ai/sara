// Phase 75 (stage 2, "her presence"): the panel beside the chat (docs/design/NEW_LOOK.md → Stage 2).
// Her portrait with a glow that follows her mood (breathing while she works, pulsing while she
// writes), her mood and status in words, then:
//   Now: what she is doing this second (the activity line / live step line), approvals waiting
//        (the chat's own approval cards, mirrored: Allow / Deny press the same buttons, so the
//        "ask first" rules are untouched), background jobs with their progress.
//   Today: the next events, reminders and to-dos (GET /api/today), top 3, with a link to the Planner.
//   She remembered: the notes she used for the last reply (meta.memoryIds → GET /api/memories?ids=),
//        each opens to its details. Never in off-the-record or private conversations. Phase 76:
//        each row has a sureness chip and a "why" line from the reply's meta.memoryPicks (no extra
//        request) and a Pin button (PATCH pinned: never fades). Phase 85: below them, "Remembered on
//        her own" (the recall triggers' notes of the last turn, from meta.recall) with Not useful.
//   This conversation: model, workspace, privacy and how full it is (the context ring).
// Wide screens (1100 px and up): a fold-away column on the right, open or closed remembered on this
// device. Narrower: an overlay over the chat, closed until asked for. Phones (720 px and less): the
// same panel as a bottom sheet pulled up from her face in the header: peek (face, mood, Now), full,
// drag to close, Escape / Back close. Group chats: the companion who spoke last, with a switcher.
// Everything comes from routes the signed-in person may use; a 403 (household members, the demo)
// quietly hides that part.
import { currentIdentity, locale, t } from './naming.js';
import { icon as lineIcon } from './icons.js';
import { ring } from './viz.js';

/** A row's small line icon (web/icons.js); decorative, the words beside it say what it is. */
const rowIcon = (cls, name) => {
  const span = el('span', cls);
  span.setAttribute('aria-hidden', 'true');
  const svg = lineIcon(name);
  if (svg) span.append(svg);
  return span;
};

const $ = (s) => document.querySelector(s);
const KEY = 'sara.herPanel';
const WIDE = matchMedia('(min-width: 1100px)');
const PHONE = matchMedia('(max-width: 720px)');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Which form the panel takes at this width: a column, an overlay or a bottom sheet. */
export const panelMode = () => (PHONE.matches ? 'sheet' : WIDE.matches ? 'side' : 'overlay');
/** Remembered per device: open unless folded away (only for the column on wide screens). */
export const savedOpen = (raw) => raw !== 'closed';

const ui = {
  ctx: null,
  open: false,
  sheet: 'closed', // closed | peek | full (phones)
  opener: null,
  pushed: false,
  activity: { status: '', text: '', startedAt: 0 },
  jobs: [],
  today: null,
  todayAt: 0,
  memKey: '',
  convId: null,
  shown: null, // group chats: the companion shown ({ id, name }), null = the current one
  face: { avatar: '/sara-avatar.jpg', portrait: '/sara-portrait.jpg', expression: 'default' },
  mood: null, // { enabled, mood, energy }
};

// ---------- open, close, modes ----------
function panel() {
  return $('#her-panel');
}

function syncButtons() {
  const open = ui.open;
  for (const b of [$('#her-face'), $('#panel-toggle')]) b?.setAttribute('aria-expanded', String(open));
  $('#panel-toggle')?.classList.toggle('on', open && panelMode() === 'side');
}

function apply() {
  const p = panel();
  if (!p) return;
  const mode = panelMode();
  p.hidden = false;
  p.classList.toggle('mode-side', mode === 'side');
  p.classList.toggle('mode-overlay', mode === 'overlay');
  p.classList.toggle('mode-sheet', mode === 'sheet');
  p.classList.toggle('is-open', ui.open);
  p.classList.toggle('sheet-peek', mode === 'sheet' && ui.open && ui.sheet === 'peek');
  p.classList.toggle('sheet-full', mode === 'sheet' && ui.open && ui.sheet === 'full');
  // Closed overlays and sheets stay out of the keyboard and screen-reader order.
  p.inert = !ui.open;
  p.setAttribute('aria-hidden', String(!ui.open));
  if (mode === 'sheet' || mode === 'overlay') {
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', String(ui.open && (mode === 'overlay' || ui.sheet === 'full')));
  } else {
    p.removeAttribute('role');
    p.removeAttribute('aria-modal');
  }
  $('#main')?.classList.toggle('panel-open', ui.open && mode === 'side');
  const scrim = $('#her-scrim');
  if (scrim) scrim.hidden = !(ui.open && (mode === 'overlay' || (mode === 'sheet' && ui.sheet === 'full')));
  if (mode === 'sheet') placeSheet();
  syncButtons();
}

/** Opens the panel (on phones: the sheet at peek height, or `full`). */
export function openPanel({ full = false, focus = false } = {}) {
  const mode = panelMode();
  if (!ui.open) ui.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ui.open = true;
  if (mode === 'sheet') {
    ui.sheet = full ? 'full' : ui.sheet === 'full' ? 'full' : 'peek';
    // Back (Android, the browser) closes the sheet instead of leaving the app.
    if (!ui.pushed) {
      history.pushState({ ...(history.state ?? {}), herSheet: 1 }, '');
      ui.pushed = true;
    }
  }
  if (mode === 'side') localStorage.setItem(KEY, 'open');
  apply();
  void refreshAll();
  if (focus || mode !== 'side') setTimeout(() => (mode === 'sheet' ? $('#hp-handle') : $('#hp-close'))?.focus({ preventScroll: true }), 30);
}

/** Folds the panel away (`fromBack`: the Back button already went back). */
export function closePanel({ fromBack = false, restoreFocus = true } = {}) {
  if (!ui.open) return;
  const mode = panelMode();
  ui.open = false;
  ui.sheet = 'closed';
  if (mode === 'side') localStorage.setItem(KEY, 'closed');
  if (ui.pushed) {
    ui.pushed = false;
    if (!fromBack && history.state?.herSheet) history.back();
  }
  apply();
  if (restoreFocus && ui.opener?.isConnected) ui.opener.focus({ preventScroll: true });
  ui.opener = null;
}

export function togglePanel() {
  if (ui.open) closePanel();
  else openPanel({ focus: true });
}
export const panelOpen = () => ui.open;

// ---------- the bottom sheet (phones) ----------
function peekHeight() {
  const p = panel();
  const line = $('#hp-now-line');
  if (!p || !line) return 160;
  const top = p.getBoundingClientRect().top;
  // Measured with the sheet's own layout: the whole Now card, or down to its first approval / job.
  const first = $('#hp-approvals .hp-appr') ?? $('#hp-jobs .hp-job');
  const bottom = first ? first.getBoundingClientRect().bottom + 18 : ($('#hp-now')?.getBoundingClientRect().bottom ?? line.getBoundingClientRect().bottom) + 14;
  return Math.round(bottom - top);
}

function placeSheet(dragY) {
  const p = panel();
  if (!p) return;
  const h = p.offsetHeight;
  let y = h;
  if (ui.open) y = ui.sheet === 'full' ? 0 : Math.max(0, h - peekHeight());
  if (dragY !== undefined) y = dragY;
  p.style.setProperty('--sheet-y', `${Math.round(y)}px`);
}

function initSheetDrag() {
  const p = panel();
  const handle = $('#hp-handle');
  if (!p || !handle) return;
  let drag = null;
  const startDrag = (e) => {
    if (panelMode() !== 'sheet' || !ui.open) return;
    const cur = new DOMMatrixReadOnly(getComputedStyle(p).transform).m42 || 0;
    drag = { id: e.pointerId, y0: e.clientY, base: cur, moved: false, t0: performance.now(), last: e.clientY, lastT: performance.now(), v: 0 };
    p.classList.add('dragging');
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 6) drag.moved = true;
    const now = performance.now();
    drag.v = (e.clientY - drag.last) / Math.max(1, now - drag.lastT);
    drag.last = e.clientY;
    drag.lastT = now;
    placeSheet(Math.min(p.offsetHeight, Math.max(0, drag.base + dy)));
  };
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    p.classList.remove('dragging');
    if (!d.moved) {
      // A tap on the handle: peek ↔ full.
      ui.sheet = ui.sheet === 'full' ? 'peek' : 'full';
      return apply();
    }
    const y = new DOMMatrixReadOnly(getComputedStyle(p).transform).m42 || 0;
    const h = p.offsetHeight;
    const peekY = Math.max(0, h - peekHeight());
    // A quick flick decides; otherwise the nearest resting place.
    if (d.v > 0.6 || y > peekY + (h - peekY) / 2) return closePanel();
    ui.sheet = d.v < -0.6 || y < peekY / 2 ? 'full' : 'peek';
    apply();
  };
  for (const target of [handle, $('#her-panel .hp-top'), $('#her-panel .hp-her')]) {
    target?.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (target !== handle && (e.target.closest('button, a, input') || ui.sheet !== 'peek')) return;
      startDrag(e);
      target.setPointerCapture?.(e.pointerId);
    });
    target?.addEventListener('pointermove', move);
    target?.addEventListener('pointerup', end);
    target?.addEventListener('pointercancel', end);
  }
  // Keyboard on the handle: Enter/Space toggles (a click without movement does the same).
  handle.addEventListener('click', (e) => {
    if (e.detail !== 0) return; // pointer taps are handled above
    ui.sheet = ui.sheet === 'full' ? 'peek' : 'full';
    apply();
  });
}

// ---------- what she is doing ----------
const statusWords = (s) => ({ thinking: t('Thinking…'), writing: t('Writing…'), running: t('Working…'), waiting: t('Waiting for your OK'), listening: t('Listening…'), hearing: t('Hearing you…'), answering: t('Answering…') })[s] ?? t('Working…');
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Called by the chat (app.js setActivity / renderActivity): her status this second. */
export function panelNow(status, text = '', startedAt = 0) {
  ui.activity = { status: status ?? '', text, startedAt: startedAt || ui.activity.startedAt || Date.now() };
  if (!status) ui.activity.startedAt = 0;
  renderNow();
}

function renderNow() {
  const line = $('#hp-now-line');
  if (!line) return;
  const { status, text, startedAt } = ui.activity;
  const approvals = document.querySelectorAll('#messages .approval:not(.approval-resolved)').length;
  // The live step line has the friendliest words ("Checking the weather…").
  const live = [...document.querySelectorAll('#messages .steps.live .steps-text')].pop()?.textContent?.trim();
  let words;
  // 3.3.0 (ezplain): no "steps" in her words.
  if (approvals) words = approvals === 1 ? t('Waiting for your OK') : t('Waiting for your OK on {n} things', { n: approvals });
  else if (status) words = `${live && (status === 'running' || status === 'thinking') ? live : status === 'answering' && text ? t('{name} is answering…', { name: text }) : statusWords(status)}${startedAt ? ` · ${elapsed(Date.now() - startedAt)}` : ''}`;
  else if (ui.jobs.length) words = ui.jobs.length === 1 ? t('One task is running in the background.') : t('Background tasks running: {n}', { n: ui.jobs.length });
  else words = t('Here with you. Nothing running.');
  if (line.textContent !== words) line.textContent = words;
  line.classList.toggle('busy', Boolean(status));
  line.classList.toggle('waiting', approvals > 0 || status === 'waiting');
  renderStatus();
}

function renderStatus() {
  const box = $('#hp-status');
  if (!box) return;
  const { status } = ui.activity;
  const approvals = document.querySelectorAll('#messages .approval:not(.approval-resolved)').length;
  const words = approvals || status === 'waiting' ? t('Waiting for your OK') : status ? statusWords(status) : t('Here with you');
  box.textContent = words;
  box.dataset.state = approvals || status === 'waiting' ? 'waiting' : status ? 'busy' : 'idle';
}

// ---------- approvals: the chat's own cards, pointed to ----------
// 3.3.0 (ezplain): one approval in view at a time. Her panel says what waits and has Show me (it
// scrolls the chat to the card, where Allow and Deny are); it no longer has its own copy of them.
function renderApprovals() {
  const box = $('#hp-approvals');
  if (!box) return;
  const cards = [...document.querySelectorAll('#messages .approval:not(.approval-resolved)')];
  box.replaceChildren(
    ...cards.map((card) => {
      const row = el('div', 'hp-appr');
      row.dataset.call = card.dataset.call ?? '';
      const what = (card.querySelector('.approval-what') ?? card.querySelector('p'))?.textContent?.trim() || t('She asks before a step.');
      const words = el('p', 'hp-appr-what', what);
      words.dataset.raw = '';
      row.append(words);
      // Phase 77: a card that goes against a decision says so here too.
      const against = card.querySelector('.contradict-note')?.textContent?.trim();
      if (against) {
        const warn = el('p', 'hp-appr-against', `${t('This goes against something you decided')}: ${against}`);
        warn.dataset.raw = '';
        row.append(warn);
      }
      const show = el('button', 'ghost small hp-appr-show', t('Show me'));
      show.type = 'button';
      show.addEventListener('click', () => {
        if (panelMode() !== 'side') closePanel({ restoreFocus: false });
        for (let d = card.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.querySelector('button')?.focus({ preventScroll: true });
      });
      row.append(show);
      return row;
    }),
  );
  renderNow();
  if (panelMode() === 'sheet' && ui.open) placeSheet();
}

// ---------- background jobs ----------
/** Called by app.js with every running background job (job events from /api/events). */
export function panelJobs(list) {
  ui.jobs = [...(list ?? [])].filter((j) => j && j.status === 'running');
  renderJobs();
  renderNow();
}

function renderJobs() {
  const box = $('#hp-jobs');
  if (!box) return;
  box.replaceChildren(
    ...ui.jobs.map((j) => {
      const row = el('div', 'hp-job');
      const head = el('div', 'hp-job-head');
      const label = el('span', 'hp-job-label', String(j.label ?? t('Background task')));
      label.dataset.raw = '';
      const time = el('span', 'hp-job-time', elapsed(Date.now() - Date.parse(j.startedAt)));
      time.dataset.started = String(Date.parse(j.startedAt));
      // 2.8: a moving ring (jobs report no percentage; a known one fills the ring).
      head.append(ring(Number.isFinite(j.progress) ? Math.max(0, Math.min(1, j.progress / 100)) : null, { size: 20, stroke: 2.5 }), label, time);
      const bar = el('div', 'hp-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('Job #{id}', { id: j.id }));
      // Jobs report no percentage: the bar shows that it is moving, the last line what it says.
      const pct = Number.isFinite(j.progress) ? Math.max(0, Math.min(100, Math.round(j.progress))) : null;
      if (pct === null) bar.classList.add('moving');
      else {
        bar.setAttribute('aria-valuenow', String(pct));
        bar.style.setProperty('--pct', `${pct}%`);
      }
      bar.append(el('span', 'hp-bar-fill'));
      const last = String(j.tail ?? '').trim().split('\n').at(-1) ?? '';
      row.append(head, bar);
      if (last) {
        const l = el('p', 'hp-job-last', last.slice(0, 140));
        l.dataset.raw = '';
        row.append(l);
      }
      const stop = el('button', 'ghost small hp-job-stop', t('Stop'));
      stop.type = 'button';
      stop.addEventListener('click', () => {
        stop.disabled = true;
        void ui.ctx.api(`/jobs/${j.id}/stop`, { method: 'POST', body: {} }).catch(() => (stop.disabled = false));
      });
      row.append(stop);
      return row;
    }),
  );
}

// ---------- today ----------
async function loadToday(force = false) {
  const sec = $('#hp-today');
  if (!sec || (!force && Date.now() - ui.todayAt < 60_000 && ui.today)) return renderToday();
  ui.todayAt = Date.now();
  try {
    ui.today = await ui.ctx.api('/today');
    sec.hidden = false;
  } catch (err) {
    // Not allowed here (403) or not available: the section quietly leaves.
    ui.today = null;
    ui.todayAt = 0;
    sec.hidden = true;
    if (err?.status && err.status !== 403 && err.status !== 404) sec.hidden = false;
  }
  renderToday();
}

/** The next three things today: events still to come, reminders, to-dos (overdue first). */
export function nextThings(d, now = Date.now()) {
  if (!d) return [];
  const items = [];
  for (const e of d.calendar?.events ?? []) {
    const end = Date.parse(e.end ?? e.start);
    if (!e.allDay && end < now) continue;
    items.push({ kind: 'event', title: e.title, at: e.allDay ? null : Date.parse(e.start), allDay: Boolean(e.allDay), where: e.location ?? '' });
  }
  for (const r of d.agenda?.reminders ?? []) items.push({ kind: 'reminder', title: r.text, at: Date.parse(r.dueAt) });
  for (const x of d.agenda?.tasks ?? []) items.push({ kind: 'task', title: x.title, at: x.dueAt ? Date.parse(x.dueAt) : null, overdue: Boolean(x.overdue) });
  const rank = (x) => (x.overdue ? -2 : x.allDay ? -1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || (a.at ?? Infinity) - (b.at ?? Infinity));
  return items.slice(0, 3);
}

function renderToday() {
  const list = $('#hp-today-list');
  if (!list) return;
  const items = nextThings(ui.today);
  const time = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  if (!ui.today) return void list.replaceChildren(el('li', 'hp-empty', t('Loading…')));
  if (!items.length) return void list.replaceChildren(el('li', 'hp-empty', t('Nothing else on today.')));
  list.replaceChildren(
    ...items.map((x) => {
      const li = el('li', `hp-item hp-${x.kind}${x.overdue ? ' overdue' : ''}`);
      const b = el('button', 'hp-row');
      b.type = 'button';
      const icon = { event: 'calendar', reminder: 'reminder', task: 'todo' }[x.kind];
      const when = x.overdue ? t('overdue') : x.allDay ? t('all day') : x.at ? time(x.at) : t('today');
      const title = el('span', 'hp-row-main', x.title);
      title.dataset.raw = '';
      b.append(rowIcon('hp-row-icon', icon), title, el('span', 'hp-row-side', when));
      b.addEventListener('click', () => {
        if (panelMode() !== 'side') closePanel({ restoreFocus: false });
        if (x.kind === 'event') ui.ctx.openToday();
        else ui.ctx.openPlanner(x.kind === 'reminder' ? 'reminders' : 'tasks');
      });
      li.append(b);
      return li;
    }),
  );
}

// ---------- she remembered ----------
async function loadMemories() {
  const sec = $('#hp-mem');
  const list = $('#hp-mem-list');
  if (!sec || !list) return;
  const conv = ui.ctx.conv();
  // Off the record and private conversations show nothing from her memory here.
  if (!conv || conv.offRecord || conv.private) {
    sec.hidden = true;
    ui.memKey = '';
    return;
  }
  sec.hidden = false;
  const msgs = ui.ctx.messages() ?? [];
  const last = msgs.findLast((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  // The notes of the whole last turn (a turn with tools has several of her messages).
  const ids = memoryIdsOfLastTurn(msgs);
  // Phase 85: what she remembered on her own in the last turn (the notes' text rides on the reply).
  const rec = recallOfLastTurn(msgs);
  const count = $('#hp-mem-count');
  if (count) count.textContent = ids.length + rec.length ? String(ids.length + rec.length) : '';
  const recBox = $('#hp-recall');
  const recList = $('#hp-recall-list');
  // Folded (the default, for privacy when someone else can see the screen): only the count shows,
  // and her notes aren't even fetched until the owner opens the section.
  if (!memOpen()) {
    list.replaceChildren();
    if (recBox) recBox.hidden = true;
    recList?.replaceChildren();
    ui.memKey = '';
    return;
  }
  if (recBox && recList) {
    recBox.hidden = !rec.length;
    // The chip comes from app.js (web/recall-view.js), like the other parts it hands the panel.
    recList.replaceChildren(...rec.map((it) => ui.ctx.recallChip?.(it, { compact: true })).filter(Boolean));
  }
  const key = `${conv.id}:${last?.id ?? ''}:${ids.join(',')}`;
  if (key === ui.memKey) return;
  ui.memKey = key;
  // (Only notes she remembered on her own: they show below, so no "used nothing" line above them.)
  if (!ids.length) return void list.replaceChildren(...(rec.length ? [] : [el('li', 'hp-empty', last ? t('Her last reply used nothing from her memory.') : t('Nothing yet in this conversation.'))]));
  let mems;
  try {
    mems = await ui.ctx.api(`/memories?ids=${ids.join(',')}`);
  } catch (err) {
    if (err?.status === 403) sec.hidden = true;
    return void list.replaceChildren(el('li', 'hp-empty', err.message));
  }
  if (ui.memKey !== key) return;
  if (!mems.length) return void list.replaceChildren(el('li', 'hp-empty', t('Her last reply used nothing from her memory.')));
  const picks = memoryPicksOfLastTurn(msgs);
  list.replaceChildren(...mems.map((m) => memoryItem(m, picks.get(m.id))));
}

/** "She remembered" starts folded on every page load and in every conversation (privacy); never saved. */
function memOpen() {
  return $('#hp-mem-h')?.getAttribute('aria-expanded') === 'true';
}
function setMemOpen(open) {
  const b = $('#hp-mem-h');
  const list = $('#hp-mem-list');
  if (!b || !list) return;
  b.setAttribute('aria-expanded', String(open));
  list.hidden = !open;
  ui.memKey = '';
  void loadMemories();
}

/** Phase 85: the recall notes of the last turn (meta.recall on her replies after your last message), once each. */
export function recallOfLastTurn(msgs) {
  const from = msgs.findLastIndex((m) => m.role === 'user') + 1;
  const out = [];
  for (const m of msgs.slice(from)) if (m.role === 'assistant' && Array.isArray(m.meta?.recall)) for (const it of m.meta.recall) if (it?.ref && !out.some((x) => x.ref === it.ref && x.kind === it.kind)) out.push({ ...it, messageId: m.id });
  return out;
}

/** The memory ids she used in the last turn: every reply of hers after your last message. */
export function memoryIdsOfLastTurn(msgs) {
  const from = msgs.findLastIndex((m) => m.role === 'user') + 1;
  const ids = [];
  for (const m of msgs.slice(from)) if (m.role === 'assistant' && Array.isArray(m.meta?.memoryIds)) for (const id of m.meta.memoryIds) if (Number.isInteger(id) && !ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * Phase 76: why and how sure, per note, from the last turn's replies (meta.memoryPicks; the first
 * reply that has a note wins). Older replies have none: the rows then show no chip.
 */
export function memoryPicksOfLastTurn(msgs) {
  const from = msgs.findLastIndex((m) => m.role === 'user') + 1;
  const out = new Map();
  for (const m of msgs.slice(from)) {
    if (m.role !== 'assistant' || !Array.isArray(m.meta?.memoryPicks)) continue;
    for (const p of m.meta.memoryPicks) if (p && Number.isInteger(p.id) && !out.has(p.id) && ['high', 'medium', 'low'].includes(p.sure)) out.set(p.id, p);
  }
  return out;
}

const SURE_WORDS = { high: () => t('Sure: high'), medium: () => t('Sure: medium'), low: () => t('Sure: low') };

/** The "why" line of a pick in plain words (the app language). */
export function whyWords(p, kindName = (k) => k) {
  const parts = [];
  if (p.words?.length) parts.push(t('matched {words}', { words: p.words.map((w) => `“${w}”`).join(', ') }));
  if (p.fuzzy) parts.push(t('similar words'));
  if (p.meaning) parts.push(t('close in meaning'));
  if (p.included) parts.push(t('added by hand for this reply'));
  else if (p.standing && p.pinned) parts.push(t('pinned'));
  else if (p.standing) parts.push(t('came to mind on its own ({kind})', { kind: kindName(p.standing) }));
  else if (p.pinned) parts.push(t('pinned'));
  if (p.old) parts.push(t('older, may be out of date'));
  return parts.join(' · ');
}

function memoryItem(m, pick) {
  const li = el('li', 'hp-item');
  const d = el('details', 'hp-memo');
  const s = el('summary', 'hp-row');
  const text = el('span', 'hp-row-main hp-memo-text', m.content);
  text.dataset.raw = '';
  s.append(rowIcon('hp-row-icon', m.kind === 'date' ? 'calendar' : m.kind === 'promise' ? 'promise' : m.kind === 'summary' ? 'memo' : 'memory'), text);
  if (pick) s.append(el('span', `hp-sure hp-sure-${pick.sure}`, SURE_WORDS[pick.sure]()));
  d.append(s);
  const body = el('div', 'hp-memo-body');
  const kind = ui.ctx.memKind(m.kind);
  const when = m.happenedOn ? new Date(`${m.happenedOn}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  if (pick) body.append(el('p', 'hp-memo-why', `${t('Why:')} ${whyWords(pick, (k) => ui.ctx.memKind(k))}`));
  body.append(el('p', 'hp-memo-meta', [kind, when].filter(Boolean).join(' · ')));
  const actions = el('div', 'hp-memo-actions');
  // Pin: never fades, always a candidate (Settings → Memory explains fading).
  const pin = el('button', 'ghost small hp-pin');
  pin.type = 'button';
  const drawPin = (on) => {
    pin.replaceChildren(rowIcon('hp-pin-icon', 'pin'), document.createTextNode(on ? t('Unpin') : t('Pin')));
    pin.setAttribute('aria-pressed', String(on));
    pin.title = on ? t('Pinned: this note never fades. Press to let it fade like the others.') : t('Pin this note so it never fades.');
  };
  drawPin(Boolean(m.pinned));
  pin.addEventListener('click', async () => {
    const next = pin.getAttribute('aria-pressed') !== 'true';
    pin.disabled = true;
    try {
      const r = await ui.ctx.api(`/memories/${m.id}`, { method: 'PATCH', body: { pinned: next } });
      m.pinned = Boolean(r?.pinned);
      drawPin(m.pinned);
    } catch {
      drawPin(Boolean(m.pinned));
    } finally {
      pin.disabled = false;
    }
  });
  actions.append(pin);
  if (m.source?.conversationId && m.source?.messageId) {
    const from = el('button', 'ghost small', t('Where she learned it'));
    from.type = 'button';
    from.addEventListener('click', () => {
      if (panelMode() !== 'side') closePanel({ restoreFocus: false });
      void ui.ctx.jumpTo(m.source.conversationId, m.source.messageId);
    });
    actions.append(from);
  }
  const open = el('button', 'ghost small', t('Show in Memory'));
  open.type = 'button';
  open.addEventListener('click', () => {
    if (panelMode() !== 'side') closePanel({ restoreFocus: false });
    ui.ctx.openMemory(m.content);
  });
  actions.append(open);
  body.append(actions);
  d.append(body);
  li.append(d);
  return li;
}

// ---------- this conversation ----------
function renderConv() {
  const dl = $('#hp-conv-list');
  const sec = $('#hp-conv');
  if (!dl || !sec) return;
  const facts = ui.ctx.convFacts();
  sec.hidden = !facts.length;
  dl.replaceChildren(
    ...facts.flatMap(([label, value, cls]) => {
      const dd = el('dd', cls ?? '', value);
      dd.dataset.raw = '';
      return [el('dt', '', label), dd];
    }),
  );
  renderRing();
}

function renderRing() {
  const ring = $('#ctx-ring');
  const box = $('#hp-ctx');
  if (!ring || !box) return;
  box.hidden = ring.hidden;
  if (ring.hidden) return;
  const pct = ring.style.getPropertyValue('--ctx') || '0';
  const mine = $('#hp-ctx-ring');
  mine.style.setProperty('--ctx', pct);
  mine.classList.toggle('full', ring.classList.contains('full'));
  mine.classList.toggle('high', ring.classList.contains('high'));
  mine.classList.toggle('warm', ring.classList.contains('warm'));
  $('#hp-ctx-pct').textContent = $('#ctx-pct')?.textContent ?? '';
  const words = [$('#ctx-full')?.textContent, $('#ctx-how')?.textContent, $('#conv-usage')?.hidden ? '' : $('#conv-usage')?.textContent].filter(Boolean);
  const p = $('#hp-ctx-text');
  p.replaceChildren(...words.map((w, i) => el('span', i ? 'hp-ctx-more' : 'hp-ctx-main', w)));
  // Phase 128 (PL2b, N25): from 70% full, Tidy this chat right on the panel line (the same call as
  // /compact and the ring's own button; Show summary and Undo are on the divider afterwards).
  const tidy = $('#hp-ctx-tidy');
  const src = $('#ctx-tidy');
  if (tidy && src) {
    tidy.hidden = !tidyOffered(pct) || src.hidden;
    tidy.disabled = src.disabled;
    if (!tidy.dataset.wired) {
      tidy.dataset.wired = '1';
      tidy.addEventListener('click', () => src.click());
    }
  }
}
/** Phase 128 (PL2b, N25): the panel offers Tidy this chat from 70% full. */
export const tidyOffered = (pct) => Number(String(pct).replace('%', '')) >= 70;

// ---------- her face, mood, group chats ----------
const MOOD_OF = { happy: 'happy', caring: 'caring', sleepy: 'sleepy', hurt: 'hurt', playful: 'playful' };

/** Called by app.js setFace(): her current picture (portrait size) and expression. */
export function panelFace(face) {
  ui.face = { ...ui.face, ...face };
  renderHer();
}
/** Called after /api/sara/state: her mood and energy in words. */
export function panelMood(st) {
  ui.mood = st ?? null;
  renderHer();
}

function groupMembers() {
  const c = ui.ctx?.conv();
  return ui.ctx?.isGroup(c) ? (c.group?.members ?? []) : [];
}
function lastSpeaker() {
  const msgs = ui.ctx?.messages() ?? [];
  return msgs.findLast((m) => m.role === 'assistant' && m.meta?.speaker)?.meta.speaker ?? null;
}

// V4a: a rename shows in the panel's title at once (web/naming.js setIdentity).
globalThis.document?.addEventListener('sara-identity', () => renderHer());
function renderHer() {
  const name = $('#hp-name');
  if (!name || !ui.ctx) return;
  const members = groupMembers();
  const me = ui.ctx.currentCompanion();
  const shown = members.length ? (ui.shown && members.some((m) => m.id === ui.shown.id) ? ui.shown : lastSpeaker() ?? members[0]) : null;
  const isMe = !shown || shown.id === me;
  const img = $('#hp-portrait');
  const want = isMe ? ui.face.portrait : ui.ctx.faceUrl(shown.id);
  if (img.getAttribute('src') !== want) img.src = want;
  name.textContent = shown?.name ?? (currentIdentity().name || t('Sara'));
  const glow = $('#hp-open-her');
  glow.dataset.mood = isMe ? (MOOD_OF[ui.face.expression] ?? 'default') : 'default';
  // 2.8: her halo in the chat header and on Today follows the same mood colours.
  for (const n of [$('#her-face'), $('#td-face-btn')]) n?.setAttribute('data-mood', glow.dataset.mood);
  glow.disabled = !isMe;
  const mood = $('#hp-mood-text');
  const st = ui.mood;
  mood.textContent = isMe && st?.enabled ? `${t(st.mood)} · ${t(st.energy)}` : isMe ? t('Inner life is off.') : t('In this group chat');
  // The switcher: everyone in the group, the one shown marked.
  const who = $('#hp-who');
  who.hidden = members.length < 2;
  if (members.length >= 2)
    who.replaceChildren(
      ...members.map((m) => {
        const b = el('button', 'hp-who-btn');
        b.type = 'button';
        const f = el('img', 'hp-who-face');
        f.src = m.id === me ? ui.face.avatar : ui.ctx.faceUrl(m.id);
        f.alt = '';
        b.append(f, el('span', 'hp-who-name', m.name));
        b.setAttribute('aria-pressed', String(m.id === shown?.id));
        b.title = t('Show {name}', { name: m.name });
        b.addEventListener('click', () => {
          ui.shown = { id: m.id, name: m.name };
          renderHer();
        });
        return b;
      }),
    );
}

// ---------- refresh ----------
async function refreshAll() {
  if (!ui.ctx) return;
  renderHer();
  renderNow();
  renderApprovals();
  renderJobs();
  renderConv();
  await Promise.all([loadToday(), loadMemories()]);
  if (panelMode() === 'sheet' && ui.open) placeSheet();
}

/** Called by app.js when a conversation opens or its settings change. */
export function panelConv() {
  const id = ui.ctx?.conv()?.id ?? null;
  if (id !== ui.convId) {
    ui.convId = id;
    ui.shown = null;
    ui.memKey = '';
    // A new conversation folds "She remembered" again.
    $('#hp-mem-h')?.setAttribute('aria-expanded', 'false');
    const ml = $('#hp-mem-list');
    if (ml) ml.hidden = true;
  }
  if (!ui.ctx) return;
  renderHer();
  renderConv();
  void loadMemories();
  if (ui.open && !ui.today) void loadToday();
}
/** Called by app.js after the messages are drawn (memories used, who spoke last). */
export function panelMessages() {
  if (!ui.ctx) return;
  renderHer();
  void loadMemories();
  renderRing();
}

export function initHerPanel(ctx) {
  ui.ctx = ctx;
  const p = panel();
  if (!p) return;
  $('#hp-mem-h')?.addEventListener('click', () => setMemOpen(!memOpen()));
  ui.open = panelMode() === 'side' ? savedOpen(localStorage.getItem(KEY)) : false;
  apply();
  $('#panel-toggle')?.addEventListener('click', togglePanel);
  $('#her-face')?.addEventListener('click', () => (ui.open && (panelMode() !== 'sheet' || ui.sheet === 'peek') ? closePanel() : openPanel()));
  $('#hp-close')?.addEventListener('click', () => closePanel());
  $('#her-scrim')?.addEventListener('click', () => closePanel());
  $('#hp-open-her')?.addEventListener('click', () => {
    if (panelMode() !== 'side') closePanel({ restoreFocus: false });
    ctx.openSara();
  });
  $('#hp-planner')?.addEventListener('click', () => {
    if (panelMode() !== 'side') closePanel({ restoreFocus: false });
    ctx.openPlanner();
  });
  $('#hp-conv-edit')?.addEventListener('click', () => {
    if (panelMode() !== 'side') closePanel({ restoreFocus: false });
    ctx.openConvSettings();
  });
  // Mac keyboards: the shortcut reads ⌘ instead of Ctrl.
  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    for (const b of [$('#panel-toggle'), $('#cmd-open')]) {
      if (!b) continue;
      b.title = b.title.replace('Ctrl+', '⌘');
      b.setAttribute('aria-label', b.title);
    }
  }
  initSheetDrag();
  for (const q of [WIDE, PHONE])
    q.addEventListener('change', () => {
      // A new form: the column follows the saved choice; overlays and sheets start closed.
      if (ui.pushed && history.state?.herSheet) history.back();
      ui.pushed = false;
      ui.open = panelMode() === 'side' ? savedOpen(localStorage.getItem(KEY)) : false;
      ui.sheet = 'closed';
      apply();
      if (ui.open) void refreshAll();
    });
  window.addEventListener('resize', () => panelMode() === 'sheet' && ui.open && placeSheet());
  // Content that grows after opening (the group switcher, a job, an approval) keeps the peek right.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => panelMode() === 'sheet' && ui.open && !p.classList.contains('dragging') && placeSheet());
    for (const n of [p, $('#her-panel .hp-her'), $('#hp-now')]) if (n) ro.observe(n);
  }
  window.addEventListener('popstate', () => {
    if (ui.pushed && !history.state?.herSheet) {
      ui.pushed = false;
      closePanel({ fromBack: true });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.open && panelMode() !== 'side' && !document.querySelector('dialog[open]')) {
      e.stopPropagation();
      closePanel();
    }
  });
  // The keyboard comes up for the message box: the sheet steps aside.
  $('#input')?.addEventListener('focus', () => panelMode() === 'sheet' && ui.open && closePanel({ restoreFocus: false }));
  // Approvals and the live step line come and go in the chat: follow them.
  const box = $('#messages');
  if (box) {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const n = document.querySelectorAll('#messages .approval:not(.approval-resolved)').length;
        if (n !== ($('#hp-approvals')?.children.length ?? 0) || [...document.querySelectorAll('#hp-approvals .hp-appr')].some((r) => !document.querySelector(`#messages .approval:not(.approval-resolved)[data-call="${CSS.escape(r.dataset.call)}"]`))) renderApprovals();
        else renderNow();
      });
    }).observe(box, { childList: true, subtree: true, characterData: true });
  }
  // The context ring and its sheet change with every reply.
  const sheet = $('#ctx-sheet');
  if (sheet) new MutationObserver(renderRing).observe(sheet, { childList: true, subtree: true, characterData: true, attributes: true });
  const ring = $('#ctx-ring');
  if (ring) new MutationObserver(renderRing).observe(ring, { attributes: true, childList: true, subtree: true });
  window.addEventListener('sara:planner', () => {
    ui.todayAt = 0;
    if (ui.open) void loadToday(true);
  });
  // Times in Now and the jobs tick while the panel is open.
  setInterval(() => {
    if (!ui.open || document.hidden) return;
    if (ui.activity.status) renderNow();
    for (const s of document.querySelectorAll('#hp-jobs .hp-job-time')) s.textContent = elapsed(Date.now() - Number(s.dataset.started));
  }, 1000);
  setInterval(() => ui.open && !document.hidden && void loadToday(true), 5 * 60_000);
  if (ui.open) void refreshAll();
}
