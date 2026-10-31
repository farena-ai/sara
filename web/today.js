// Phase 75 (stage 3, 2.7): Today as the home screen (docs/design/NEW_LOOK.md → Stage 3).
// The greeting with her face and mood, then tiles in a grid (three or four columns on wide
// screens, two on tablets, one on phones): the weather, your day (reminders and calendar), the
// Planner, what she remembered, moments, background work, your home, and a small "set it up" tile.
// Every tile is built from data the app already has (GET /api/today and the existing routes for
// memories, moments, jobs, the team and Home Assistant; the weather from GET /api/today/weather).
// A tile with nothing in it stays away, so nothing is invented and nothing clutters.
//
// Today is a view over the chat column (a non-modal <dialog id="today">), not a window: the
// sidebar, her panel and the phone's bottom bar stay usable beside it. It keeps its old ids and
// deep link (/#view=today, Alt+T). Since 2.7.1 the app opens on Today (web/start-view.js).
import { locale, t } from './naming.js';
import { icon } from './icons.js';
import { ring, share, sparkline, weatherArt } from './viz.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (cls, text, onClick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
};

let ctx = null;

// ---------- pure helpers (tested in Node) ----------

/** The weather code (WMO, as Open-Meteo sends it) as an icon and a key for the words. */
export function weatherKind(code, day = true) {
  const c = Number(code);
  if (code === null || code === undefined || !Number.isFinite(c)) return { icon: '🌡️', kind: 'unknown' };
  if (c === 0) return { icon: day ? '☀️' : '🌙', kind: 'clear' };
  if (c === 1 || c === 2) return { icon: day ? '⛅' : '☁️', kind: 'partly' };
  if (c === 3) return { icon: '☁️', kind: 'cloudy' };
  if (c === 45 || c === 48) return { icon: '🌫️', kind: 'fog' };
  if (c >= 51 && c <= 57) return { icon: '🌦️', kind: 'drizzle' };
  if (c >= 61 && c <= 67) return { icon: '🌧️', kind: 'rain' };
  if (c >= 71 && c <= 77) return { icon: '❄️', kind: 'snow' };
  if (c >= 80 && c <= 82) return { icon: '🌦️', kind: 'showers' };
  if (c === 85 || c === 86) return { icon: '🌨️', kind: 'snow-showers' };
  if (c >= 95) return { icon: '⛈️', kind: 'thunder' };
  return { icon: '🌡️', kind: 'unknown' };
}

/** The words for a weather kind, in the app's language. */
export function weatherWords(kind) {
  switch (kind) {
    case 'clear': return t('Clear');
    case 'partly': return t('Partly cloudy');
    case 'cloudy': return t('Cloudy');
    case 'fog': return t('Fog');
    case 'drizzle': return t('Light drizzle');
    case 'rain': return t('Rain');
    case 'snow': return t('Snow');
    case 'showers': return t('Showers');
    case 'snow-showers': return t('Snow showers');
    case 'thunder': return t('Thunderstorms');
    default: return '';
  }
}

/**
 * "Your day": reminders and calendar events in time order, all-day events first, with which are
 * already past. Undated things are not on a timeline (they live in the Planner tile).
 */
export function dayTimeline(d, now = Date.now()) {
  const out = [];
  for (const e of d?.calendar?.events ?? []) {
    const start = e.allDay ? null : Date.parse(e.start);
    const end = Date.parse(e.end ?? e.start);
    out.push({ kind: 'event', title: e.title, at: start, allDay: Boolean(e.allDay), end: e.allDay ? null : Number.isFinite(end) ? end : null, where: e.location ?? '', past: !e.allDay && Number.isFinite(end) && end < now });
  }
  for (const r of d?.agenda?.reminders ?? []) {
    const at = Date.parse(r.dueAt);
    out.push({ kind: 'reminder', title: r.text, at: Number.isFinite(at) ? at : null, allDay: false, end: null, where: '', past: Number.isFinite(at) && at < now });
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? (a.at ?? 0) - (b.at ?? 0) : a.allDay ? -1 : 1));
}

/** Newest notes first (by when they were learned), facts and milestones only, at most `n`. */
export function recentMemories(list, n = 3) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.content === 'string' && !m.supersededBy && (m.kind === 'fact' || m.kind === 'milestone' || m.kind === 'decision' || !m.kind))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || (b.id ?? 0) - (a.id ?? 0))
    .slice(0, n);
}

/** The newest photos of the album (items with a picture), at most `n`. */
export const latestPhotos = (items, n = 4) => (Array.isArray(items) ? items : []).filter((m) => m && m.image).slice(0, n);

/** Background work worth a tile: running jobs first, else the latest one that ended in the last 12 hours. */
export function workItems(jobs, team, now = Date.now()) {
  const running = (Array.isArray(jobs) ? jobs : []).filter((j) => j.status === 'running');
  const tasks = (team?.tasks ?? []).filter((x) => x.status === 'running' || x.status === 'waiting');
  if (running.length || tasks.length) return { jobs: running.slice(0, 3), tasks: tasks.slice(0, 2), recent: null };
  const ended = (Array.isArray(jobs) ? jobs : []).filter((j) => j.endedAt && now - Date.parse(j.endedAt) < 12 * 3600_000);
  return { jobs: [], tasks: [], recent: ended[0] ?? null };
}

/** Home Assistant domains the tile shows, in this order. */
export const HOME_DOMAINS = ['light', 'switch', 'climate', 'lock', 'cover', 'fan'];
/** The entities to show: the ones picked on this device (in that order), else the first four by domain. */
export function pickHome(entities, saved = []) {
  const list = (Array.isArray(entities) ? entities : []).filter((e) => e && typeof e.id === 'string' && HOME_DOMAINS.includes(e.id.split('.')[0]));
  const ids = Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : [];
  if (ids.length) return ids.map((id) => list.find((e) => e.id === id)).filter(Boolean).slice(0, 6);
  const rank = (e) => HOME_DOMAINS.indexOf(e.id.split('.')[0]);
  return [...list].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/** Things not set up yet that Today could show, as Settings pages to open (owner only). */
export function setupItems({ weather, calendar, home, member = false, demo = false }) {
  if (member || demo) return [];
  const out = [];
  if (weather && weather.setUp === false) out.push({ key: 'weather', page: 'you-briefing' });
  if (!calendar) out.push({ key: 'calendar', page: 'ab-google' });
  if (home === 'not-connected') out.push({ key: 'home', page: 'ab-home' });
  return out;
}

// ---------- the view ----------

export const todayOpen = () => Boolean($('#today')?.open);

/** Shows Today over the chat column (not a window: the sidebar, her panel and the bottom bar stay). */
export function showToday() {
  const d = $('#today');
  if (!d) return;
  if (!d.open) d.show();
  document.documentElement.classList.add('today-open');
  for (const n of $('#chat').children) if (n !== d) n.inert = true;
  d.querySelector('.td-scroll')?.scrollTo?.({ top: 0 });
  $('#td-greeting')?.focus({ preventScroll: true });
}

/** Back to the chat. */
export function closeToday({ focus = true } = {}) {
  const d = $('#today');
  if (!d) return;
  if (d.open) d.close();
  afterClose(focus);
}
function afterClose(focus) {
  document.documentElement.classList.remove('today-open');
  for (const n of $('#chat').children) n.inert = false;
  if (focus && !matchMedia('(pointer: coarse)').matches) $('#input')?.focus({ preventScroll: true });
}

// ---------- tiles ----------

const time = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
const hourOf = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric' });

/** 2.8: each tile's small line icon (web/icons.js), beside its title. */
const TILE_ICON = { 'td-board': 'todo', 'td-weather': 'weather', 'td-calendar': 'calendar', 'td-agenda': 'planner', 'td-memories': 'memory', 'td-otd': 'moments', 'td-jobs': 'job', 'td-home': 'home', 'td-mail': 'mail', 'td-dates': 'heart', 'td-models': 'sparkle', 'td-setup': 'plus' };
function tileIcon(id) {
  const svg = icon(TILE_ICON[id] ?? '');
  if (!svg) return [];
  const span = el('span', 'td-tile-ic');
  span.setAttribute('aria-hidden', 'true');
  span.append(svg);
  return [span];
}

function tileHead(tile, title, extra) {
  const h = tile.querySelector('.td-tile-head') ?? el('div', 'td-tile-head');
  const h3 = h.querySelector('h3') ?? el('h3');
  h3.textContent = title;
  h.replaceChildren(...tileIcon(tile.id), h3, ...(Array.isArray(extra) ? extra : extra ? [extra] : []));
  if (!h.parentNode) tile.prepend(h);
  return h;
}

/** Weather: only when a place is set for the morning briefing; an honest line when the lookup failed. */
export function renderWeather(w) {
  const tile = $('#td-weather');
  if (!tile) return;
  tile.hidden = !w || w.setUp === false;
  if (tile.hidden) return;
  const body = tile.querySelector('.td-body');
  const place = el('span', 'td-count', w.place ?? '');
  place.dataset.raw = '';
  tileHead(tile, t('Weather'), place);
  if (w.error) {
    body.replaceChildren(el('p', 'muted small', t('Couldn’t get the weather right now. It tries again when you open Today.')));
    return;
  }
  const k = weatherKind(w.code, w.day !== false);
  const unit = w.units === 'C' ? '°C' : '°F';
  const main = el('div', 'td-wx-main');
  // 2.8: a small illustration of the sky instead of an emoji (decorative: the words say it).
  const art = weatherArt(k.kind, w.day !== false, 'td-wx-art');
  const temp = el('span', 'td-wx-temp', w.now === null ? '–' : `${w.now}°`);
  const words = el('span', 'td-wx-words', weatherWords(k.kind));
  main.append(art, temp, words);
  const meta = el('p', 'td-wx-meta', [w.high !== null && w.low !== null ? t('High {hi}, low {lo}', { hi: `${w.high}°`, lo: `${w.low}°` }) : '', w.rain !== null ? t('Rain: {n}%', { n: w.rain }) : ''].filter(Boolean).join(' · '));
  const hours = el('ol', 'td-wx-hours');
  hours.setAttribute('aria-label', t('The next hours'));
  for (const h of w.hours ?? []) {
    const li = el('li', 'td-wx-hour');
    li.append(el('span', 'td-wx-h', hourOf(h.time)), weatherArt(weatherKind(h.code, h.day !== false).kind, h.day !== false), el('span', 'td-wx-ht', h.temp === null ? '–' : `${h.temp}°`));
    hours.append(li);
  }
  // The temperatures from now through the next hours as a tiny line (only the numbers we have).
  const spark = sparkline([w.now, ...(w.hours ?? []).map((h) => h.temp)], { w: 200, h: 30, cls: 'td-wx-spark' });
  body.replaceChildren(main, meta, ...(spark ? [spark] : []), ...(w.hours?.length ? [hours] : []));
  temp.title = `${w.now ?? '–'}${unit}`;
}

/** Your day: reminders and calendar on one timeline (the calendar's own errors stay visible). */
export function renderDay(d) {
  const tile = $('#td-calendar');
  if (!tile) return;
  tile.hidden = false;
  const list = tile.querySelector('.today-list');
  const items = dayTimeline(d);
  tileHead(tile, t('Your day'), items.length ? el('span', 'td-count', String(items.length)) : null);
  const rows = items.map((x) => {
    const li = el('li', `td-time-row ${x.kind}${x.past ? ' past' : ''}`);
    const when = el('span', 'td-when', x.allDay ? t('all day') : x.at === null ? '' : time(x.at));
    const dot = el('span', 'td-dot');
    dot.setAttribute('aria-hidden', 'true');
    const what = el('span', 'td-what');
    const title = el('span', 'td-what-title', x.title);
    const bell = x.kind === 'reminder' ? icon('reminder') : null;
    if (bell) title.prepend(bell);
    title.dataset.raw = '';
    title.title = x.title;
    what.append(title);
    if (x.where) {
      const w = el('span', 'td-what-where', x.where);
      w.dataset.raw = '';
      what.append(w);
    }
    li.append(when, dot, what);
    return li;
  });
  const ol = el('ol', 'td-timeline');
  ol.append(...rows);
  list.replaceChildren(
    ...(d.calendar?.error ? [el('p', 'error small', d.calendar.error)] : []),
    ...(rows.length ? [ol] : [el('p', 'muted small', d.calendar ? t('Nothing on the calendar today.') : t('No reminders for today.'))]),
  );
}

/** Planner: what's due today (and important undated ones); a tick marks a to-do done. */
export function renderPlanner(d, fmtDue) {
  const tile = $('#td-agenda');
  if (!tile) return;
  const tasks = d.agenda?.tasks ?? [];
  const list = tile.querySelector('.today-list');
  tileHead(tile, t('Planner'), [el('span', 'td-count', tasks.length === 1 ? t('1 to-do') : t('To-dos: {n}', { n: tasks.length })), ...doneRing(tasks.length)]);
  const ul = el('ul', 'td-tasks');
  for (const x of tasks.slice(0, 6)) {
    const li = el('li', `td-task${x.overdue ? ' overdue' : ''}`);
    const tick = btn('td-tick', '');
    tick.setAttribute('aria-label', t('Mark “{title}” done', { title: x.title }));
    tick.setAttribute('aria-pressed', 'false');
    tick.addEventListener('click', async () => {
      tick.disabled = true;
      try {
        await ctx.api(`/tasks/${x.id}`, { method: 'PATCH', body: { status: 'done' } });
        li.classList.add('done');
        tick.setAttribute('aria-pressed', 'true');
      } catch (err) {
        tick.disabled = false;
        ctx.status(err.message);
      }
    });
    const title = el('span', 'td-task-title', x.title);
    title.dataset.raw = '';
    title.title = x.title;
    const side = el('span', 'td-task-side', x.dueAt ? (x.overdue ? `${t('overdue')} · ${fmtDue(x.dueAt)}` : time(Date.parse(x.dueAt))) : t('important'));
    li.append(tick, title, side);
    ul.append(li);
  }
  const open = btn('td-link', t('Open the Planner'), () => {
    closeToday({ focus: false });
    $('#open-planner')?.click();
  });
  list.replaceChildren(...(tasks.length ? [ul] : [el('p', 'muted small', t('Nothing due today.'))]), ...(tasks.length > 6 ? [el('p', 'muted small', t('And {n} more in the Planner.', { n: tasks.length - 6 }))] : []), open);
}

/** To-dos ticked off today (from the Planner's own list), set by loadDoneToday. */
let doneToday = null;
/** How many to-dos have `doneAt` on the same local day as `now` (null without a list). */
export function countDoneToday(tasks, now = Date.now()) {
  if (!Array.isArray(tasks)) return null;
  const day = new Date(now).toDateString();
  return tasks.filter((x) => x && x.status === 'done' && x.doneAt && new Date(x.doneAt).toDateString() === day).length;
}
/** The Planner tile's ring: done today out of done today + still due today. Nothing done and nothing due: no ring. */
function doneRing(open) {
  if (doneToday === null || doneToday + open === 0) return [];
  const f = share(doneToday, doneToday + open);
  return [ring(f, { size: 34, stroke: 3.5, text: String(doneToday), label: t('Done today: {done} of {total}', { done: doneToday, total: doneToday + open }), cls: 'td-done-ring' })];
}
async function loadDoneToday() {
  const p = await ctx.api('/planner').catch(() => null);
  doneToday = countDoneToday(p?.tasks);
}

/** She remembered: the newest notes she learned (memory off or empty: the tile stays away). */
async function renderMemories() {
  const tile = $('#td-memories');
  if (!tile) return;
  const list = await ctx.api('/memories?kind=fact').catch(() => null);
  const mems = recentMemories(list, 3);
  tile.hidden = !mems.length;
  if (!mems.length) return;
  tileHead(tile, t('She remembered'));
  const ul = el('ul', 'td-mems');
  for (const m of mems) {
    const li = el('li', 'td-mem');
    const p = el('p', 'td-mem-text', m.content);
    p.dataset.raw = '';
    li.append(p);
    if (m.source?.title) {
      const from = el('span', 'td-mem-from', m.source.title);
      from.dataset.raw = '';
      li.append(from);
    }
    ul.append(li);
  }
  tile.querySelector('.td-body').replaceChildren(
    ul,
    btn('td-link', t('Open Memory'), () => {
      closeToday({ focus: false });
      $('#open-memory')?.click();
    }),
  );
}

/** Moments: "On this day" when there is one (moments.js fills it), else the newest photos. */
async function renderMoments() {
  const tile = $('#td-otd');
  if (!tile || !tile.hidden) return;
  const d = await ctx.api('/moments').catch(() => null);
  const photos = latestPhotos(d?.items, 4);
  if (!photos.length) return;
  ctx.renderPhotos(photos, t('Moments'));
}

/** Background work: running jobs and team tasks (or the last one that ended), with what they last said. */
async function renderWork() {
  const tile = $('#td-jobs');
  if (!tile) return;
  const [jobs, team] = await Promise.all([ctx.api('/jobs').catch(() => []), ctx.member() ? null : ctx.api('/team').catch(() => null)]);
  const w = workItems(jobs, team);
  const any = w.jobs.length + w.tasks.length;
  tile.hidden = !any && !w.recent;
  if (tile.hidden) return;
  tileHead(tile, any ? t('Working on it') : t('Background work'), any ? el('span', 'td-live', t('Running')) : null);
  const box = tile.querySelector('.today-list');
  const card = (label, sub, tail, j, progress) => {
    const c = el('div', 'td-job');
    // 2.8: a ring beside each job: a moving arc while it runs (jobs report no percentage), full when it
    // finished, the share of steps done for a team task.
    if (progress !== undefined) c.append(ring(progress, { size: 30, stroke: 3, cls: progress === 1 ? 'pring-done' : '' }));
    const name = el('p', 'td-job-name', label);
    name.dataset.raw = '';
    name.title = label;
    c.append(name, el('p', 'td-job-sub', sub));
    if (tail) {
      const out = el('p', 'td-job-out', tail);
      out.dataset.raw = '';
      c.append(out);
    }
    if (j) {
      const row = el('div', 'td-job-actions');
      row.append(btn('ghost small', t('Open the chat'), async () => {
        closeToday({ focus: false });
        await ctx.openConversation(j.conversationId);
      }));
      if (j.status === 'running') {
        const stop = btn('ghost small', t('Stop'), async () => {
          stop.disabled = true;
          await ctx.api(`/jobs/${j.id}/stop`, { method: 'POST', body: {} }).catch(() => (stop.disabled = false));
          void renderWork();
        });
        row.append(stop);
      }
      c.append(row);
    }
    return c;
  };
  const lastLine = (s) => String(s ?? '').trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 140) ?? '';
  const since = (iso) => t('Running since {time}', { time: time(Date.parse(iso)) });
  const ended = (j) => (j.status === 'ok' ? t('Finished at {time}', { time: time(Date.parse(j.endedAt)) }) : t('Stopped at {time}', { time: time(Date.parse(j.endedAt)) }));
  box.replaceChildren(
    ...w.jobs.map((j) => card(j.label, since(j.startedAt), lastLine(j.tail), j, null)),
    ...w.tasks.map((x) => {
      const done = (x.steps ?? []).filter((s) => s.endedAt).length;
      const total = (x.steps ?? []).length;
      const c = card(t('Team: {goal}', { goal: x.goal }), x.status === 'waiting' ? t('Waiting for your OK') : total ? t('Steps done: {done} of {total}', { done, total }) : t('Planning'), '', null, total ? share(done, total) : null);
      if (total) {
        const bar = el('progress', 'td-progress');
        bar.max = total;
        bar.value = done;
        bar.setAttribute('aria-label', t('Steps done: {done} of {total}', { done, total }));
        c.append(bar);
      }
      c.append(btn('ghost small', t('Open the team'), () => {
        closeToday({ focus: false });
        $('#open-team')?.click();
      }));
      return c;
    }),
    ...(w.recent ? [card(w.recent.label, ended(w.recent), lastLine(w.recent.tail), w.recent, w.recent.status === 'ok' ? 1 : undefined)] : []),
  );
}

/**
 * Your home: a few Home Assistant devices and their state. 2.7.1 (owner decision): lights, switches,
 * fans and blinds get a real switch (the owner pressing it is the owner acting, so no approval card;
 * the server decides what may switch here: canSwitch, src/home-switch.ts). Everything else (locks,
 * alarms, garage doors, thermostats…) keeps Ask Sara, which goes through her approval rule for
 * smart-home actions. Owner only, never on the demo.
 */
async function renderHome() {
  const tile = $('#td-home');
  if (!tile) return 'hidden';
  if (ctx.demo() || ctx.member()) {
    tile.hidden = true;
    return 'hidden';
  }
  let r;
  try {
    r = await ctx.api(`/home/entities?domains=${HOME_DOMAINS.join(',')}`);
  } catch (err) {
    tile.hidden = true;
    return err.status === 400 ? 'not-connected' : 'hidden';
  }
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('sara.today.home') ?? '[]');
    } catch {
      return [];
    }
  })();
  const all = (r.entities ?? []).filter((e) => HOME_DOMAINS.includes(e.id.split('.')[0]));
  const shown = pickHome(all, saved);
  tile.hidden = !all.length;
  if (!all.length) return 'empty';
  tileHead(tile, t('Home'));
  const grid = el('div', 'td-home-grid');
  for (const e of shown) {
    const card = el('div', `td-dev${e.state === 'on' || e.state === 'unlocked' || e.state === 'open' ? ' on' : ''}`);
    const name = el('p', 'td-dev-name', e.name);
    name.dataset.raw = '';
    name.title = e.name;
    const st = el('p', 'td-dev-state', stateWords(e));
    st.setAttribute('aria-live', 'polite');
    if (e.canSwitch) {
      card.classList.add('has-switch');
      card.append(homeSwitch(e, card, st), name, st);
    } else card.append(name, st, btn('td-dev-ask ghost small', t('Ask Sara'), () => askAbout(e)));
    grid.append(card);
  }
  const choose = el('details', 'td-home-choose');
  choose.append(el('summary', '', t('Choose what shows here')));
  const picks = el('div', 'td-home-picks');
  for (const e of all.slice(0, 60)) {
    const lab = el('label', 'row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = shown.some((s) => s.id === e.id);
    cb.dataset.nodirty = '';
    cb.addEventListener('change', () => {
      const ids = [...picks.querySelectorAll('input:checked')].map((x) => x.value).slice(0, 6);
      localStorage.setItem('sara.today.home', JSON.stringify(ids));
      void renderHome();
    });
    cb.value = e.id;
    const span = el('span', '', e.name);
    span.dataset.raw = '';
    lab.append(cb, span);
    picks.append(lab);
  }
  choose.append(picks, el('p', 'muted small', t('Up to six, saved on this device.')));
  tile.querySelector('.td-body').replaceChildren(grid, el('p', 'td-foot muted small', t('The switches work right away. Locks, alarms, doors and the rest go through her, so your approval settings still apply.')), choose);
  return 'shown';
}
/** On, open or unlocked: the lit look and a switch that is on. */
const isOnState = (state) => ['on', 'open', 'opening', 'unlocked'].includes(String(state ?? ''));
const unreachable = (state) => ['unavailable', 'unknown', ''].includes(String(state ?? ''));
/**
 * A real on/off switch for one device: no confirm, the result shows under the name (the state the
 * server read back from Home Assistant after the change), or the reason it didn't work.
 */
function homeSwitch(e, card, st) {
  const sw = btn('td-dev-switch');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', e.name);
  const show = (state) => {
    e.state = state;
    sw.setAttribute('aria-checked', String(isOnState(state)));
    sw.disabled = unreachable(state);
    card.classList.toggle('on', isOnState(state));
    st.textContent = stateWords(e);
  };
  show(e.state);
  sw.addEventListener('click', async () => {
    const to = isOnState(e.state) ? 'off' : 'on';
    sw.disabled = true;
    card.classList.remove('failed');
    st.textContent = t('Switching…');
    try {
      const r = await ctx.api(`/home/entities/${encodeURIComponent(e.id)}/toggle`, { method: 'POST', body: { to } });
      show(r.state);
      if (isOnState(r.state) !== (to === 'on')) {
        card.classList.add('failed');
        st.textContent = t('It still says: {state}', { state: stateWords(e) });
      }
    } catch (err) {
      show(e.state);
      card.classList.add('failed');
      st.textContent = err.message;
    }
  });
  return sw;
}
function stateWords(e) {
  const s = String(e.state ?? '');
  const words = { on: t('Switched on'), off: t('Switched off'), locked: t('Locked'), unlocked: t('Unlocked'), open: t('Opened'), closed: t('Closed'), unavailable: t('Not reachable'), heat: t('Heating'), cool: t('Cooling') };
  return words[s] ?? s;
}
function askAbout(e) {
  const d = e.id.split('.')[0];
  const s = String(e.state ?? '');
  let text;
  if (d === 'lock') text = s === 'locked' ? t('Please unlock {name}.', { name: e.name }) : t('Please lock {name}.', { name: e.name });
  else if (d === 'cover') text = s === 'open' ? t('Please close {name}.', { name: e.name }) : t('Please open {name}.', { name: e.name });
  else if (d === 'climate') text = t('What is {name} set to? I may want to change it.', { name: e.name });
  else text = s === 'on' ? t('Please turn off {name}.', { name: e.name }) : t('Please turn on {name}.', { name: e.name });
  closeToday({ focus: false });
  void ctx.ask(text);
}

/** One line per thing that isn't set up yet, each opening its Settings page. Hidden when all set. */
function renderSetup(items) {
  const tile = $('#td-setup');
  if (!tile) return;
  const hide = localStorage.getItem('sara.today.setup') === 'hidden';
  tile.hidden = hide || !items.length;
  if (tile.hidden) return;
  const words = { weather: [t('Weather'), t('Add your town for the weather here and in the morning briefing.')], calendar: [t('Calendar'), t('Connect Google Calendar to see your events here.')], home: [t('Home'), t('Connect Home Assistant to see your lights and switches here.')] };
  tileHead(tile, t('Add to your day'), btn('ghost small td-hide', t('Hide'), () => {
    localStorage.setItem('sara.today.setup', 'hidden');
    tile.hidden = true;
  }));
  tile.querySelector('.td-body').replaceChildren(
    ...items.map((x) => {
      const b = btn('td-setup-item', '');
      b.append(el('strong', '', words[x.key][0]), el('span', 'muted small', words[x.key][1]));
      b.addEventListener('click', () => {
        closeToday({ focus: false });
        void ctx.openSettings(x.page);
      });
      return b;
    }),
  );
}

/**
 * After GET /api/today has filled the first tiles (app.js loadToday): the greeting's face and mood,
 * your day, the Planner, then the tiles that need their own requests (in parallel).
 */
export async function renderTodayTiles(d, { fmtDue }) {
  const face = $('#td-face');
  if (face) face.src = $('#hp-portrait')?.getAttribute('src') || $('#sidebar img.avatar')?.getAttribute('src') || '/sara-portrait.jpg';
  // 2.8: her halo here takes the colours of her mood, like her panel's.
  const mood = $('#hp-open-her')?.dataset.mood;
  if (mood) $('#td-face-btn')?.setAttribute('data-mood', mood);
  renderDay(d);
  await loadDoneToday();
  renderPlanner(d, fmtDue);
  renderBoardTile(d.board);
  const [weather, home] = await Promise.all([
    ctx.demo() ? Promise.resolve({ setUp: false }) : ctx.api('/today/weather').catch(() => null),
    renderHome(),
    renderMemories(),
    renderMoments(),
    renderWork(),
  ]);
  renderWeather(weather);
  renderSetup(setupItems({ weather, calendar: d.calendar, home, member: ctx.member(), demo: ctx.demo() }));
}

/** Phase 99 (ST4): the board on Today: Needs you (cards waiting on you, with the question) and Doing (her work). */
export function renderBoardTile(b) {
  const tile = $('#td-board');
  if (!tile) return;
  const waiting = b?.waiting ?? [];
  const doing = b?.doing ?? [];
  tile.hidden = !waiting.length && !doing.length;
  if (tile.hidden) return;
  tileHead(tile, t('On the board'), waiting.length ? el('span', 'td-count td-needs', t('{n} need you', { n: waiting.length })) : null);
  const body = tile.querySelector('.td-body');
  const row = (c, sub, cls) => {
    const b2 = btn(`today-item td-bd-item ${cls}`, '', () => ctx.openCard?.(c.boardId, c.id));
    const title = el('span', 'td-bd-title', c.title);
    title.dataset.raw = '';
    const line = el('span', 'muted small td-bd-sub', sub);
    line.dataset.raw = '';
    b2.append(title, line);
    return b2;
  };
  const out = [];
  if (waiting.length) out.push(el('h4', 'td-bd-h', t('Needs you')), ...waiting.map((c) => row(c, c.question || t('Waiting on you'), 'needs')));
  if (doing.length) out.push(el('h4', 'td-bd-h', t('Doing')), ...doing.map((c) => row(c, c.line === 'Queued' ? t('Queued') : c.line || t('Working on it'), 'doing')));
  body.replaceChildren(...out);
}

export function initToday(c) {
  ctx = c;
  const d = $('#today');
  if (!d) return;
  // Esc (or the browser's back on Android, which arrives as Esc in the apps) goes back to the chat,
  // unless something on top of Today has it (a window, her panel over it, the open sidebar, a tour).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !d.open || e.defaultPrevented) return;
    if (document.querySelector('dialog[open]:not(#today)') || document.querySelector('.her-panel.is-open:is(.mode-overlay, .mode-sheet)')) return;
    if ($('#main').classList.contains('show-sidebar') || document.querySelector('.tour-card')) return;
    closeToday();
  });
  d.addEventListener('close', () => afterClose(false));
  $('#td-back')?.addEventListener('click', () => closeToday());
  $('#td-ask-any')?.addEventListener('click', () => {
    closeToday();
    $('#input')?.focus();
  });
  $('#td-face-btn')?.addEventListener('click', () => {
    closeToday({ focus: false });
    $('#open-sara')?.click();
  });
}
