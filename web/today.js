// Phase 75 (stage 3, 2.7): Today as the home screen (docs/design/NEW_LOOK.md → Stage 3).
// Phase 111 (TD1, 2.44, docs/design/TODAY.md): a designed home screen on big screens. Five named
// sections in a fixed order (Your day, Needs you, With her, Work, Home & more), each its own
// 12-column grid; tiles are S, M or L (3, 4 or 6 columns at 1440) and the fill rule grows them so
// every row is full; empty tiles collapse; the owner reorders, resizes and hides tiles (and
// sections) and it is saved for this companion on the server (web/today-layout.js). Everything
// comes from one batched GET /api/today; live parts reload on SSE `today {part}` (Mail after a
// Gmail clean-up, Needs you after an approval, Running now after a job). Every tile that reads an
// outside source says how fresh it is.
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
const raw = (n) => {
  n.dataset.raw = '';
  return n;
};

let ctx = null;

// ---------- the registry (B2) and the grid (B4) ----------

/** The sections, in the designed order (§3.2). */
export const SECTIONS = ['day', 'needs', 'her', 'work', 'more'];
/**
 * One record per tile: its section, the sizes it reads well at, the designed size, whether it
 * starts hidden (folded or opt-in tiles), owner-only. The same list as src/today-layout.ts.
 */
export const TILES = [
  { id: 'td-calendar', section: 'day', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-weather', section: 'day', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-dates', section: 'day', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-needs', section: 'needs', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-mail', section: 'needs', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-memories', section: 'her', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-otd', section: 'her', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-plans', section: 'her', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-rooms', section: 'her', sizes: ['S', 'M', 'L'], size: 'M', hidden: true, ownerOnly: true },
  { id: 'td-jobs', section: 'work', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-board', section: 'work', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-projects', section: 'work', sizes: ['S', 'M'], size: 'S', ownerOnly: true },
  { id: 'td-usage', section: 'work', sizes: ['S', 'M'], size: 'S', ownerOnly: true },
  { id: 'td-home', section: 'more', sizes: ['M', 'L'], size: 'L', ownerOnly: true },
  { id: 'td-models', section: 'more', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-hooks', section: 'more', sizes: ['S', 'M'], size: 'M', hidden: true, ownerOnly: true },
  { id: 'td-agenda', section: 'more', sizes: ['S', 'M'], size: 'M', hidden: true },
  { id: 'td-setup', section: 'more', sizes: ['S', 'M', 'L'], size: 'S', ownerOnly: true },
];
export const tileById = (id) => TILES.find((x) => x.id === id);

/** Columns each size takes, per grid (web/today.css picks one by Today's width: 12 wide, 12 with bigger tiles, 2 tracks). */
export const SPANS = {
  xl: { cols: 12, span: { S: 3, M: 4, L: 6 }, unit: 1 },
  lg: { cols: 12, span: { S: 4, M: 6, L: 12 }, unit: 1 },
  md: { cols: 2, span: { S: 1, M: 1, L: 2 }, unit: 6 },
};

/**
 * The fill rule (§3.3): tiles go into rows in order; a row that adds up to less than the column
 * count grows its tiles, last first, to their next allowed size while that fits; what is still
 * left goes to the row's widest tile (the main one: a timeline, a photo strip), so every row is
 * full. A tile is never made narrower than its smallest size: any span from that size up to the
 * whole row is one it allows. Returns id → span. `tiles`: [{ id, size, sizes }] (visible ones, in
 * order); `span`: size → columns.
 */
export function fillRow(tiles, cols, span) {
  const out = {};
  const base = (x) => Math.min(span[x.size] ?? span[x.sizes[0]], cols);
  const ladder = (x) => [...new Set(x.sizes.map((z) => Math.min(span[z], cols)))].sort((a, b) => a - b);
  const sum = (r) => r.reduce((a, x) => a + x.span, 0);
  let i = 0;
  while (i < tiles.length) {
    const row = [];
    while (i < tiles.length && (!row.length || sum(row) + base(tiles[i]) <= cols)) {
      row.push({ t: tiles[i], span: base(tiles[i]) });
      i++;
    }
    // Grow, last first, one allowed size at a time while it fits.
    let grew = true;
    while (sum(row) < cols && grew) {
      grew = false;
      for (let k = row.length - 1; k >= 0 && sum(row) < cols; k--) {
        const next = ladder(row[k].t).find((n) => n > row[k].span && n - row[k].span <= cols - sum(row));
        if (next) {
          row[k].span = next;
          grew = true;
        }
      }
    }
    // The rest goes to the widest tile (the first of equals).
    if (sum(row) < cols) {
      const wide = row.reduce((a, x) => (x.span > a.span ? x : a), row[0]);
      wide.span += cols - sum(row);
    }
    for (const x of row) out[x.t.id] = x.span;
  }
  return out;
}
/** The narrowest span a tile allows at this grid (its smallest size). */
export const minSpan = (x, cols, span) => Math.min(...x.sizes.map((z) => Math.min(span[z], cols)));

/** The span classes for every width (container queries pick one; no inline style). */
export function spanClasses(visible) {
  const out = {};
  for (const x of visible) out[x.id] = [];
  for (const [bp, g] of Object.entries(SPANS)) {
    const spans = fillRow(visible, g.cols, g.span);
    for (const x of visible) out[x.id].push(bp === 'xl' ? `td-span-${spans[x.id] * g.unit}` : `td-${bp}-${spans[x.id] * g.unit}`);
  }
  return out;
}

/** The layout as rows: the owner's prefs over the designed one → sections, each with its tiles (id, size, shown). */
export function layoutModel(prefs, { member = false } = {}) {
  const p = prefs ?? {};
  const secs = [...(p.sections ?? []).filter((s) => SECTIONS.includes(s)), ...SECTIONS.filter((s) => !(p.sections ?? []).includes(s))];
  return secs.map((sec) => {
    const all = TILES.filter((x) => x.section === sec && !(member && x.ownerOnly));
    const order = (p.order?.[sec] ?? []).filter((id) => all.some((x) => x.id === id));
    const ids = [...order, ...all.map((x) => x.id).filter((id) => !order.includes(id))];
    return {
      id: sec,
      tiles: ids.map((id) => {
        const def = tileById(id);
        const own = p.tiles?.[id] ?? {};
        const size = def.sizes.includes(own.size) ? own.size : def.size;
        const shown = id === 'td-rooms' ? Boolean(p.rooms?.on) && own.hidden !== true : own.hidden === undefined ? !def.hidden : !own.hidden;
        return { id, size, sizes: def.sizes, shown };
      }),
    };
  });
}

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
 * already past. Kept for older callers (her panel); Today uses dayItems.
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

/** Local midnight of `day` (YYYY-MM-DD) in this browser, and the next one. */
const dayRange = (day, now) => {
  const base = day ? new Date(`${day}T00:00:00`) : new Date(new Date(now).toDateString());
  const start = base.getTime();
  return { start, end: new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1).getTime() };
};

/**
 * B1 · Your day as one timeline (§4.1): calendar events, reminders, to-dos with a time today and
 * leave-by times, in time order, all-day first; past items flagged (not removed). Phase 114 (B1):
 * a leave-by row sits at its own time, so it comes BEFORE its event (you act on it first).
 * Undated to-dos stay off (Needs you or the Planner).
 */
export function dayItems(d, now = Date.now()) {
  const { start, end } = dayRange(d?.day, now);
  const items = [];
  for (const e of d?.calendar?.events ?? []) {
    const at = e.allDay ? null : Date.parse(e.start);
    const fin = Date.parse(e.end ?? e.start);
    items.push({ kind: 'event', id: e.id, title: e.title, at, allDay: Boolean(e.allDay), where: e.location ?? '', past: !e.allDay && Number.isFinite(fin) && fin < now });
    const lb = e.allDay ? undefined : (d?.calendar?.leaveBy ?? []).find((l) => l.eventId === e.id);
    if (lb) {
      const la = Date.parse(lb.leaveAt);
      if (Number.isFinite(la)) items.push({ kind: 'leave', id: `leave:${e.id}`, title: e.title, at: la, allDay: false, where: '', minutes: lb.minutes, mode: lb.mode ?? '', past: la < now, of: e.id });
    }
  }
  for (const r of d?.agenda?.reminders ?? []) {
    const at = Date.parse(r.dueAt);
    if (!Number.isFinite(at) || at >= end) continue;
    items.push({ kind: 'reminder', id: r.id, title: r.text, at, allDay: false, where: '', past: at < now });
  }
  for (const x of d?.agenda?.tasks ?? []) {
    const at = x.dueAt ? Date.parse(x.dueAt) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    items.push({ kind: 'todo', id: x.id, title: x.title, at, allDay: false, where: '', past: at < now });
  }
  // All-day first, then by time; at the same minute a leave-by goes before anything else.
  const rank = (x) => (x.kind === 'leave' ? 0 : 1);
  return items.sort((a, b) => (a.allDay === b.allDay ? (a.at ?? 0) - (b.at ?? 0) || rank(a) - rank(b) : a.allDay ? -1 : 1));
}

/**
 * Phase 114 (B1, R3): during the hour a clock repeats when summer time ends, the same wall time
 * happens twice; '1st' / '2nd' tells them apart ('' the rest of the year). `offset(ms)` is the
 * zone's offset in minutes (Date#getTimezoneOffset by default; tests pass their own).
 */
export function repeatedHour(at, offset = (ms) => new Date(ms).getTimezoneOffset()) {
  if (!Number.isFinite(at)) return '';
  const HOUR = 3_600_000;
  const o = offset(at);
  if (offset(at + HOUR) > o) return '1st';
  if (offset(at - HOUR) < o) return '2nd';
  return '';
}

const NEEDS_RANK = ['approval', 'failed', 'overdue', 'board', 'mail', 'hook', 'plan', 'model'];
/**
 * B3 · Needs you (§4.4): one ranked list: approvals → failed → overdue (oldest first) → board →
 * mail → hooks → her reach-outs she couldn't send → models. Keys put off with "Not today" are left
 * out. A member's answer has no owner-only sources, so those kinds never appear for them.
 */
export function needsItems(d, now = Date.now()) {
  const n = d?.needs ?? {};
  const skip = new Set(n.notToday ?? []);
  const { start } = dayRange(d?.day, now);
  const out = [];
  for (const a of n.approvals ?? []) out.push({ kind: 'approval', key: `approval:${a.approvalId}`, title: a.title || a.summary || a.name, why: a.conversation ?? '', at: a.since ?? null, ref: a });
  for (const j of n.failedJobs ?? []) out.push({ kind: 'failed', key: `job:${j.id}`, title: j.label, why: j.status, at: j.at, ref: { ...j, job: true } });
  for (const r of n.failedRuns ?? []) out.push({ kind: 'failed', key: `run:${r.id}`, title: r.title, why: 'error', at: r.at, ref: r });
  const overdue = (d?.agenda?.tasks ?? []).filter((x) => x.overdue && x.dueAt && Date.parse(x.dueAt) < start).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  for (const x of overdue) out.push({ kind: 'overdue', key: `task:${x.id}`, title: x.title, why: '', at: x.dueAt, ref: x });
  for (const c of d?.board?.waiting ?? []) out.push({ kind: 'board', key: `card:${c.id}`, title: c.title, why: c.question ?? '', at: null, ref: c });
  if (n.includeMail !== false) for (const m of d?.mail?.important ?? []) out.push({ kind: 'mail', key: `mail:${m.id}`, title: m.subject, why: m.from, at: m.at ?? null, ref: m });
  for (const h of d?.hooks ?? []) out.push({ kind: 'hook', key: `hook:${h.id}`, title: h.kind === 'limit' ? '' : h.text, why: h.name, at: h.at, ref: h });
  for (const p of d?.plans?.expired ?? []) out.push({ kind: 'plan', key: `plan:${p.id}`, title: p.what, why: '', at: null, ref: p });
  for (const m of n.models ?? []) out.push({ kind: 'model', key: m.key, title: m.text, why: '', at: null, ref: m });
  return out.filter((x) => !skip.has(x.key)).sort((a, b) => NEEDS_RANK.indexOf(a.kind) - NEEDS_RANK.indexOf(b.kind));
}

/**
 * B6 · freshness: "Updated just now", "Updated 3 minutes ago" (relative, in the app's language);
 * past the part's own limit, "May be out of date".
 */
export function freshWords(at, now = Date.now(), limitMs = 0) {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  if (limitMs && ms > limitMs) return t('May be out of date');
  if (ms < 60_000) return t('Updated just now');
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const when = ms < 3600_000 ? rtf.format(-Math.floor(ms / 60_000), 'minute') : ms < 86_400_000 ? rtf.format(-Math.floor(ms / 3600_000), 'hour') : rtf.format(-Math.floor(ms / 86_400_000), 'day');
  return t('Updated {when}', { when });
}

/** Since you were away (§6.5): one short line per thing the stores recorded (no model call). */
export function awayLines(away) {
  if (!away?.lines?.length) return [];
  return away.lines.map((l) => {
    switch (l.kind) {
      case 'messages': return t('Messages from her: {n}', { n: l.n });
      case 'jobs': return l.failed ? t('Background jobs finished: {n} ({f} failed)', { n: l.n, f: l.failed }) : t('Background jobs finished: {n}', { n: l.n });
      case 'memories': return t('New things she learned: {n}', { n: l.n });
      case 'moments': return t('New moments: {n}', { n: l.n });
      case 'mail': return t('Emails she organised: {n}', { n: l.n });
      // Phase 112 (TD2): only with Include rooms on: a count and the room titles, nothing else.
      case 'rooms': return l.titles?.length ? t('Rooms she answered in: {n} ({rooms})', { n: l.n, rooms: l.titles.join(', ') }) : t('Rooms she answered in: {n}', { n: l.n });
      default: return '';
    }
  }).filter(Boolean);
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
  const tasks = (Array.isArray(team) ? team : (team?.tasks ?? [])).filter((x) => x.status === 'running' || x.status === 'waiting');
  if (running.length || tasks.length) return { jobs: running.slice(0, 3), tasks: tasks.slice(0, 2), recent: null };
  const ended = (Array.isArray(jobs) ? jobs : []).filter((j) => j.endedAt && now - Date.parse(j.endedAt) < 12 * 3600_000);
  return { jobs: [], tasks: [], recent: ended[0] ?? null };
}

/** Home Assistant domains the tile shows, in this order. */
export const HOME_DOMAINS = ['light', 'switch', 'climate', 'lock', 'cover', 'fan'];
/** The entities to show: the ones picked (in that order), else the first four by domain. */
export function pickHome(entities, saved = []) {
  const list = (Array.isArray(entities) ? entities : []).filter((e) => e && typeof e.id === 'string' && HOME_DOMAINS.includes(e.id.split('.')[0]));
  const ids = Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : [];
  if (ids.length) return ids.map((id) => list.find((e) => e.id === id)).filter(Boolean).slice(0, 6);
  const rank = (e) => HOME_DOMAINS.indexOf(e.id.split('.')[0]);
  return [...list].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/** Things not set up yet that Today could show, as Settings pages to open (owner only; each can be hidden). */
export function setupItems({ weather, calendar, mail, home, projects, member = false, demo = false, hidden = [] }) {
  if (member || demo) return [];
  const out = [];
  if (weather && weather.setUp === false) out.push({ key: 'weather', page: 'you-briefing' });
  if (!calendar) out.push({ key: 'calendar', page: 'ab-google' });
  if (mail === null) out.push({ key: 'mail', page: 'ab-google' });
  if (home === 'not-connected') out.push({ key: 'home', page: 'ab-home' });
  if (projects?.items?.length && !projects.github) out.push({ key: 'github', page: 'ab-github' });
  return out.filter((x) => !hidden.includes(x.key));
}

/**
 * The old per-device keys (sara.today.home, sara.today.setup) become this companion's prefs once
 * (B5); the keys are then removed. Returns the patch to save, or null when there is nothing to do.
 */
export function migrateDeviceKeys(prefs, storage) {
  if (!storage || prefs?.migrated) return null;
  const patch = { migrated: true };
  try {
    const home = JSON.parse(storage.getItem('sara.today.home') ?? 'null');
    if (Array.isArray(home) && home.length) patch.home = { entities: home.filter((x) => typeof x === 'string').slice(0, 6), scenes: prefs?.home?.scenes ?? [] };
  } catch {
    /* an old, broken value */
  }
  if (storage.getItem('sara.today.setup') === 'hidden') patch.tiles = { ...(prefs?.tiles ?? {}), 'td-setup': { ...(prefs?.tiles?.['td-setup'] ?? {}), hidden: true } };
  storage.removeItem('sara.today.home');
  storage.removeItem('sara.today.setup');
  return patch;
}

/** To-dos ticked off today (the server counts them with the day part). */
export function countDoneToday(tasks, now = Date.now()) {
  if (!Array.isArray(tasks)) return null;
  const day = new Date(now).toDateString();
  return tasks.filter((x) => x && x.status === 'done' && x.doneAt && new Date(x.doneAt).toDateString() === day).length;
}


// ---------- phones and tablets (Phase 112, TD2: docs/design/TODAY.md §7) ----------

/**
 * Which Today to draw: a phone (one column in priority order, the Now card, collapsible groups,
 * swipe rows), a tablet (two tracks, the Now card, collapsible sections in the desktop order) or
 * the desktop one (TD1). Phones by the screen (a narrow window gets the phone view too); tablets
 * are touch screens whose Today is narrower than the 12-column grid (840 px of content).
 */
export function formFactor({ viewport = 1440, container = 1200, coarse = false } = {}) {
  if (viewport <= 600) return 'phone';
  if (coarse && container < 840) return 'tablet';
  return 'desktop';
}

/** The phone's first groups, in priority order (§7.1): each holds one tile and has its own heading. */
export const PHONE_HEAD = [['needs', 'td-needs'], ['day', 'td-calendar'], ['weather', 'td-weather'], ['mail', 'td-mail']];
/** Groups on a phone that become swipe rows when they hold more than one card (§7.2). */
export const SWIPE_GROUPS = ['her', 'work'];
/** Everything that can be collapsed on a phone or a tablet (the server keeps the same list). */
export const COLLAPSIBLE = ['day', 'needs', 'her', 'work', 'more', 'weather', 'mail'];

/**
 * The phone order (§7.1): Now first (always; it can't be hidden), then Needs you, Your day,
 * Weather and Mail, then the owner's section order for the rest (With her and Work as swipe rows;
 * Coming up and whatever else Your day or Needs you hold go with Home & more). Hidden tiles stay
 * hidden (`shown: false`). The page is built in this order, so DOM order is the visual order.
 */
export function phoneOrder(prefs, { member = false } = {}) {
  const model = layoutModel(prefs, { member });
  const byId = new Map(model.flatMap((s) => s.tiles).map((x) => [x.id, x]));
  const groups = [{ id: 'now', tiles: [{ id: 'td-now', size: 'L', sizes: ['L'], shown: true }], single: true, swipe: false }];
  const head = new Set(PHONE_HEAD.map(([, id]) => id));
  for (const [g, id] of PHONE_HEAD) if (byId.has(id)) groups.push({ id: g, tiles: [byId.get(id)], single: true, swipe: false });
  const left = model.filter((s) => s.id === 'day' || s.id === 'needs').flatMap((s) => s.tiles).filter((x) => !head.has(x.id));
  for (const sec of model) {
    if (sec.id === 'day' || sec.id === 'needs') continue;
    const tiles = sec.id === 'more' ? [...left, ...sec.tiles] : sec.tiles;
    groups.push({ id: sec.id, tiles, single: false, swipe: SWIPE_GROUPS.includes(sec.id) });
  }
  return groups;
}

/**
 * Which groups start collapsed (§7.3): saved per companion AND per form factor (phone, tablet;
 * the desktop never collapses). On a phone the "when Today opens" setting overrides it: everything
 * open, or only Now open (Needs you never collapses by itself).
 */
export function collapsedAtOpen(prefs, form) {
  if (form !== 'phone' && form !== 'tablet') return [];
  const saved = (prefs?.collapsed?.[form] ?? []).filter((x) => COLLAPSIBLE.includes(x));
  if (form === 'phone' && prefs?.phoneOpen === 'all') return [];
  if (form === 'phone' && prefs?.phoneOpen === 'now') return COLLAPSIBLE.filter((x) => x !== 'needs');
  return saved;
}

/**
 * Pull to refresh (§7.4) as a small state machine, fed by touch events on Today's scroll area
 * (the same gesture in mobile browsers, the installed web app and both phone apps' web views):
 * it arms only when the touch starts at the top (scrollTop 0), lets go when the page scrolls or
 * the finger moves sideways (a swipe row), and past `threshold` px a release refreshes once.
 * `step` (0–8) drives the spinner's travel through classes; with reduced motion it stays 0 and
 * only the spinner shows.
 */
export function pullTracker({ threshold = 64, onRefresh, reduced = () => false } = {}) {
  let s = null;
  let busy = false;
  const idle = { pull: 0, step: 0, ready: false, active: false };
  const view = () => (s ? { pull: s.dy, step: reduced() ? 0 : Math.min(8, Math.floor(s.dy / 16)), ready: s.dy >= threshold, active: s.dy > 4 } : idle);
  return {
    start(x, y, scrollTop) {
      s = !busy && scrollTop <= 0 ? { x, y, dy: 0 } : null;
      return view();
    },
    move(x, y, scrollTop) {
      if (!s) return idle;
      const dx = x - s.x;
      const dy = y - s.y;
      if (scrollTop > 0 || (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy))) {
        s = null;
        return idle;
      }
      s.dy = Math.max(0, dy);
      return view();
    },
    end() {
      const fire = Boolean(s && s.dy >= threshold);
      s = null;
      if (fire) {
        busy = true;
        Promise.resolve()
          .then(() => onRefresh?.())
          .finally(() => (busy = false));
      }
      return { ...idle, fired: fire };
    },
    cancel() {
      s = null;
      return idle;
    },
    busy: () => busy,
  };
}

/** How old each part may get before a return to Today reloads it (§7.4, §8.2). */
export const PART_LIMIT = { day: 120_000, coming: 120_000, mail: 120_000, home: 30_000, weather: 15 * 60_000, projects: 10 * 60_000, needs: 5 * 60_000, work: 5 * 60_000, usage: 5 * 60_000, board: 5 * 60_000, plans: 5 * 60_000, memories: 5 * 60_000, moments: 5 * 60_000, her: 5 * 60_000, models: 5 * 60_000, hooks: 5 * 60_000, rooms: 5 * 60_000, away: 5 * 60_000 };
/**
 * Back to a visible Today (§7.4): after more than 2 minutes away, the parts older than their
 * limits (not a full refresh, no spinner); a short look away reloads nothing.
 */
export function returnParts({ hiddenAt, now = Date.now(), parts = {}, limits = PART_LIMIT } = {}) {
  if (!hiddenAt || now - hiddenAt <= 120_000) return [];
  return Object.entries(parts).filter(([k, v]) => limits[k] && v?.at && now - Date.parse(v.at) > limits[k]).map(([k]) => k);
}

/**
 * What Esc (and Android's back, which arrives as Esc in the app) does on Today: an open ⋯ menu or
 * the Customise sheet closes first; anything else on top keeps it; otherwise back to the chat.
 */
export function escAction({ menu = false, sheet = false, other = false } = {}) {
  if (menu) return 'menu';
  if (sheet) return 'sheet';
  if (other) return 'none';
  return 'leave';
}

/** The Now card's next things (§7.1): at most two that are not over, each with how soon. */
export function nowItems(d, now = Date.now()) {
  return dayItems(d, now)
    .filter((x) => !x.allDay && !x.past && Number.isFinite(x.at))
    // By time here (the timeline keeps a leave-by under its event; Now wants the next thing to do).
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((x) => ({ ...x, mins: Math.round((x.at - now) / 60_000) }));
}

/** The first coming hour with rain, snow or a storm (the Now card's "rain from 4 pm"). */
export function rainFrom(w) {
  const wet = ['drizzle', 'rain', 'showers', 'snow', 'snow-showers', 'thunder'];
  return (w?.hours ?? []).find((h) => wet.includes(weatherKind(h.code, h.day !== false).kind)) ?? null;
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
  // The next open starts from the saved open/closed sections (and the phone's setting) again.
  shutNow.phone = null;
  shutNow.tablet = null;
  for (const n of $('#chat').children) n.inert = false;
  if (focus && !matchMedia('(pointer: coarse)').matches) $('#input')?.focus({ preventScroll: true });
}

// ---------- tiles ----------

const time = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
const hourOf = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric' });
const num = (n) => Number(n ?? 0).toLocaleString(locale());
const kTok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** 2.8: each tile's small line icon (web/icons.js), beside its title. */
const TILE_ICON = { 'td-plans': 'calendar', 'td-board': 'todo', 'td-hooks': 'reminder', 'td-weather': 'weather', 'td-calendar': 'calendar', 'td-agenda': 'planner', 'td-memories': 'memory', 'td-otd': 'moments', 'td-jobs': 'job', 'td-home': 'home', 'td-mail': 'mail', 'td-dates': 'heart', 'td-models': 'sparkle', 'td-setup': 'plus', 'td-needs': 'warn', 'td-projects': 'terminal', 'td-usage': 'gauge', 'td-rooms': 'group' };
function tileIcon(id) {
  const svg = icon(TILE_ICON[id] ?? '');
  if (!svg) return [];
  const span = el('span', 'td-tile-ic');
  span.setAttribute('aria-hidden', 'true');
  span.append(svg);
  return [span];
}

/** The tile's head: icon, title, its extras, and the ⋯ menu (web/today-layout.js). */
export function tileHead(tile, title, extra) {
  const h = tile.querySelector('.td-tile-head') ?? el('div', 'td-tile-head');
  const h3 = h.querySelector('h3') ?? el('h3');
  h3.textContent = title;
  const more = h.querySelector('.td-more') ?? ctx?.tileMenu?.(tile);
  h.replaceChildren(...tileIcon(tile.id), h3, ...(Array.isArray(extra) ? extra.filter(Boolean) : extra ? [extra] : []), ...(more ? [more] : []));
  if (!h.parentNode) tile.prepend(h);
  return h;
}

/** A tile's foot line: how fresh it is (B6), in a <time>, re-worded each minute. */
function freshFoot(at, limitMs, extra = []) {
  const p = el('p', 'td-foot muted small');
  let n = 0;
  if (at) {
    n++;
    const tm = el('time', 'td-fresh-at', freshWords(at, Date.now(), limitMs));
    tm.setAttribute('datetime', at);
    tm.dataset.at = at;
    if (limitMs) tm.dataset.limit = String(limitMs);
    p.append(tm);
  }
  for (const x of extra) {
    // td-sep, not td-dot (that is the timeline's circle): a plain middle dot between the foot's parts.
    if (n++) p.append(el('span', 'td-sep', ' · '));
    p.append(x);
  }
  return p;
}
/** How many rows a list shows at each size (rows stay even: the rest is behind See all). */
const ROWS = { S: 3, M: 4, L: 6 };
const sizeOf = (id) => currentSizes[id] ?? tileById(id)?.size ?? 'M';
let currentSizes = {};

function seeAll(list, n, render) {
  if (list.length <= n) return [];
  const b = btn('td-link td-see-all', t('See all ({n})', { n: list.length }));
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? t('Show fewer') : t('See all ({n})', { n: list.length });
    render(open ? list.length : n);
  });
  return [b];
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
  // At S size the next-hours row shows three hours (§4.2).
  // A phone's Weather is a full-width card: five hours in a row (§7.1).
  for (const h of (w.hours ?? []).slice(0, form === 'phone' ? 5 : sizeOf('td-weather') === 'S' ? 3 : 4)) {
    const li = el('li', 'td-wx-hour');
    li.append(el('span', 'td-wx-h', hourOf(h.time)), weatherArt(weatherKind(h.code, h.day !== false).kind, h.day !== false), el('span', 'td-wx-ht', h.temp === null ? '–' : `${h.temp}°`));
    hours.append(li);
  }
  // The temperatures from now through the next hours as a tiny line (only the numbers we have).
  const spark = sparkline([w.now, ...(w.hours ?? []).map((h) => h.temp)], { w: 200, h: 30, cls: 'td-wx-spark' });
  body.replaceChildren(main, meta, ...(spark ? [spark] : []), ...(w.hours?.length ? [hours] : []), ...(w.at ? [freshFoot(w.at, 30 * 60_000)] : []));
  temp.title = `${w.now ?? '–'}${unit}`;
}

/** Your day (§4.1): one timeline (events, reminders, timed to-dos, leave-by) with a Now marker. */
export function renderDay(d, fmtDue) {
  const tile = $('#td-calendar');
  if (!tile) return;
  tile.hidden = false;
  const list = tile.querySelector('.today-list');
  const now = Date.now();
  const items = dayItems(d, now);
  const done = d.agenda?.doneToday ?? null;
  const open = (d.agenda?.tasks ?? []).length;
  tileHead(tile, t('Your day'), doneRing(done, open));
  const ol = el('ol', 'td-timeline');
  let nowPlaced = false;
  const draw = (n) => {
    ol.replaceChildren();
    nowPlaced = false;
    const shown = items.length > n ? items.filter((x) => !x.past || x.allDay).slice(0, n) : items;
    for (const x of shown) {
      if (!nowPlaced && !x.allDay && !x.past && shown.some((y) => y.past)) {
        const mark = el('li', 'td-now');
        mark.append(el('span', 'td-now-label', t('Now')));
        ol.append(mark);
        nowPlaced = true;
      }
      ol.append(dayRow(x, fmtDue));
    }
  };
  draw(ROWS[sizeOf('td-calendar')] + 2);
  const later = (d.agenda?.tasks ?? []).filter((x) => !x.dueAt && !x.overdue).length;
  const foot = [];
  if (later) foot.push(btn('td-link', t('More to-dos today: {n}', { n: later }), openPlanner));
  foot.push(btn('td-link', t('Open the Planner'), openPlanner));
  const at = d.parts?.day?.at;
  // Phase 114 (PL1c, M4): on a phone the Now card already says the day is empty; this tile then folds away.
  (list.closest?.('.today-card') ?? list).classList?.toggle('td-day-empty', !items.length && !d.calendar?.error);
  list.replaceChildren(
    ...(d.calendar?.error ? [el('p', 'error small', d.calendar.error)] : []),
    ...(items.length ? [ol, ...seeAll(items, ROWS[sizeOf('td-calendar')] + 2, draw)] : [el('p', 'td-empty muted small', t('Nothing planned. Enjoy the space.'))]),
    freshFoot(d.calendar ? at : null, 10 * 60_000, foot),
  );
}
function openPlanner() {
  closeToday({ focus: false });
  $('#open-planner')?.click();
}
function dayRow(x, fmtDue) {
  const li = el('li', `td-time-row ${x.kind}${x.past ? ' past' : ''}`);
  // Phase 114 (B1): the repeated hour when summer time ends reads "1:30 (1st)" and "1:30 (2nd)".
  const rep = x.allDay || x.at === null ? '' : repeatedHour(x.at);
  const at = x.allDay ? t('all day') : x.at === null ? '' : rep ? `${time(x.at)} ${rep === '1st' ? t('(1st)') : t('(2nd)')}` : time(x.at);
  const when = el('span', 'td-when', at);
  const dot = el('span', 'td-dot');
  dot.setAttribute('aria-hidden', 'true');
  const what = el('span', 'td-what');
  if (x.kind === 'leave') {
    const how = { car: t('({n} min by car)', { n: x.minutes }), bike: t('({n} min by bike)', { n: x.minutes }), walk: t('({n} min on foot)', { n: x.minutes }) }[x.mode] ?? t('({n} min)', { n: x.minutes });
    const title = el('span', 'td-what-title', `${t('Leave by {time} for {what}', { time: time(x.at), what: x.title })} ${how}`);
    title.dataset.raw = '';
    const car = icon('car');
    if (car) title.prepend(car);
    what.append(title);
    li.append(when, dot, what);
    return li;
  }
  const title = raw(el('span', 'td-what-title', x.title));
  const ic = x.kind === 'reminder' ? icon('reminder') : null;
  if (ic) title.prepend(ic);
  title.title = x.title;
  what.append(title);
  if (x.where) what.append(raw(el('span', 'td-what-where', x.where)));
  li.append(when, dot, what);
  if (x.kind === 'todo') li.append(tickButton({ id: x.id, title: x.title }, li));
  return li;
}
/** A to-do's tick (one verb per row): marks it done in the Planner. */
function tickButton(x, row) {
  const tick = btn('td-tick', '');
  tick.setAttribute('aria-label', t('Mark “{title}” done', { title: x.title }));
  tick.setAttribute('aria-pressed', 'false');
  tick.addEventListener('click', async () => {
    tick.disabled = true;
    try {
      await ctx.api(`/tasks/${x.id}`, { method: 'PATCH', body: { status: 'done' } });
      row.classList.add('done');
      tick.setAttribute('aria-pressed', 'true');
    } catch (err) {
      tick.disabled = false;
      ctx.status(err.message);
    }
  });
  return tick;
}

/** Planner (folded into Your day, §15 Q2; shown again from Customise): what's due today, with ticks. */
export function renderPlanner(d, fmtDue) {
  const tile = $('#td-agenda');
  if (!tile) return;
  const tasks = d.agenda?.tasks ?? [];
  const list = tile.querySelector('.today-list');
  tileHead(tile, t('Planner'), [el('span', 'td-count', tasks.length === 1 ? t('1 to-do') : t('To-dos: {n}', { n: tasks.length })), ...doneRing(d.agenda?.doneToday ?? null, tasks.length)]);
  const ul = el('ul', 'td-tasks');
  for (const x of tasks.slice(0, 6)) {
    const li = el('li', `td-task${x.overdue ? ' overdue' : ''}`);
    const title = raw(el('span', 'td-task-title', x.title));
    title.title = x.title;
    const side = el('span', 'td-task-side', x.dueAt ? (x.overdue ? `${t('overdue')} · ${fmtDue(x.dueAt)}` : time(Date.parse(x.dueAt))) : t('important'));
    li.append(tickButton(x, li), title, side);
    ul.append(li);
  }
  const open = btn('td-link', t('Open the Planner'), openPlanner);
  list.replaceChildren(...(tasks.length ? [ul] : [el('p', 'muted small', t('Nothing due today.'))]), ...(tasks.length > 6 ? [el('p', 'muted small', t('And {n} more in the Planner.', { n: tasks.length - 6 }))] : []), open);
}

/** The done-today ring: done today out of done today + still due today. Nothing done and nothing due: no ring. */
function doneRing(done, open) {
  // Nothing ticked off yet: no ring (an empty "0" reads as a warning).
  if (!done) return [];
  const f = share(done, done + open);
  return [ring(f, { size: 34, stroke: 3.5, text: String(done), label: t('Done today: {done} of {total}', { done, total: done + open }), cls: 'td-done-ring' })];
}

/** Coming up (§4.3): the next days' events, memory dates and People birthdays, in one list. */
export function renderDates(d, inDaysWords) {
  const tile = $('#td-dates');
  if (!tile) return;
  const day0 = dayRange(d.day, Date.now()).start;
  const rows = [
    ...(d.dates ?? []).map((x) => ({ inDays: x.inDays, what: x.what, at: null, personId: x.personId, person: x.person })),
    ...(d.coming?.events ?? []).map((e) => {
      const at = Date.parse(e.start);
      const dd = e.allDay ? new Date(`${e.start}T00:00:00`) : new Date(at);
      return { inDays: Math.round((new Date(dd.toDateString()).getTime() - day0) / 86_400_000), what: e.title, at: e.allDay ? null : at };
    }),
  ].filter((x) => x.inDays >= 0).sort((a, b) => a.inDays - b.inDays || (a.at ?? 0) - (b.at ?? 0));
  tile.hidden = !rows.length;
  if (!rows.length) return;
  tileHead(tile, t('Coming up'));
  const box = tile.querySelector('.today-list');
  const ul = el('div', 'td-rows');
  const draw = (n) => ul.replaceChildren(...rows.slice(0, n).map((x) => comingRow(x, d.day, inDaysWords)));
  const n = ROWS[sizeOf('td-dates')] + 1;
  draw(n);
  box.replaceChildren(ul, ...seeAll(rows, n, draw), freshFoot(null, 0, [el('span', '', t('Next {n} days', { n: d.coming?.days ?? d.layout?.comingDays ?? 7 }))]));
}
function comingRow(x, day, inDaysWords) {
  const row = el('div', `today-row td-coming${x.inDays === 0 ? ' overdue' : ''}`);
  const when = x.inDays <= 1 ? inDaysWords(x.inDays) : new Date(dayRange(day, Date.now()).start + x.inDays * 86_400_000 + 3600_000).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric' });
  row.append(el('span', 'td-coming-when', when), raw(el('span', 'today-main', x.what)));
  if (x.at) row.append(el('span', 'today-side muted small', time(x.at)));
  // Phase 101 (ST6): a date about someone on a people card opens their card.
  if (x.personId) {
    row.classList.add('td-person');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', t('Open {name}', { name: x.person }));
    const open = (e) => {
      e.stopPropagation();
      closeToday({ focus: false });
      void ctx.showPerson?.(x.personId);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(e)));
  }
  return row;
}

const NEEDS_ICON = { approval: 'shield', failed: 'warn', overdue: 'reminder', board: 'todo', mail: 'mail', hook: 'plug', plan: 'calendar', model: 'sparkle' };
let lastNeeds = null;
let lastNeedsSaid = 0;
/** Needs you (§4.4): one ranked list, one verb per row; "Not today" puts an item off until midnight. */
export function renderNeeds(d) {
  const tile = $('#td-needs');
  if (!tile) return;
  const items = needsItems(d);
  // A phone hides an empty Needs you (the Now card says "Nothing needs you" instead, §7.1).
  tile.hidden = form === 'phone' && !items.length;
  tileHead(tile, t('Needs you'), items.length ? el('span', 'td-count td-needs', String(items.length)) : null);
  const body = tile.querySelector('.td-body');
  // Only a count that grows is announced, at most once every 30 seconds.
  if (lastNeeds !== null && items.length > lastNeeds && Date.now() - lastNeedsSaid > 30_000) {
    lastNeedsSaid = Date.now();
    const live = $('#td-live');
    if (live) live.textContent = t('New items need you: {n}', { n: items.length - lastNeeds });
  }
  lastNeeds = items.length;
  if (!items.length) {
    const p = el('p', 'td-empty td-all-clear');
    const ok = icon('check');
    if (ok) p.append(ok);
    p.append(el('span', '', t('Nothing needs you right now.')));
    body.replaceChildren(p);
    return;
  }
  const ul = el('ul', 'td-needs-list');
  const draw = (n) => ul.replaceChildren(...items.slice(0, n).map((x) => needsRow(x, d)));
  // A phone shows the top three (§7.1); See all opens the rest in place.
  const n = form === 'phone' ? 3 : ROWS[sizeOf('td-needs')];
  draw(n);
  body.replaceChildren(ul, ...seeAll(items, n, draw));
}
function needsRow(x, d) {
  const li = el('li', `td-need ${x.kind}`);
  const ic = icon(NEEDS_ICON[x.kind] ?? 'dot');
  const mark = el('span', 'td-need-ic');
  mark.setAttribute('aria-hidden', 'true');
  if (ic) mark.append(ic);
  const text = el('div', 'td-need-text');
  const title = x.kind === 'hook' && !x.title ? t('{name} is sending too much: paused for 10 minutes', { name: x.why }) : x.title;
  text.append(raw(el('span', 'td-need-title', title)));
  const why = needsWhy(x);
  if (why) text.append(raw(el('span', 'td-need-why muted small', why)));
  const acts = el('div', 'td-need-acts');
  const go = (fn) => async () => {
    try {
      await fn();
    } catch (err) {
      ctx.status(err.message);
    }
  };
  switch (x.kind) {
    case 'approval':
      acts.append(
        btn('small', t('Approve'), go(async () => {
          await ctx.api(`/approvals/${x.ref.approvalId}`, { method: 'POST', body: { approved: true } });
          li.remove();
        })),
        btn('ghost small', t('Deny'), go(async () => {
          await ctx.api(`/approvals/${x.ref.approvalId}`, { method: 'POST', body: { approved: false } });
          li.remove();
        })),
      );
      break;
    case 'failed':
      if (x.ref.conversationId) acts.append(btn('ghost small', t('Open'), () => (closeToday({ focus: false }), void ctx.openConversation(x.ref.conversationId))));
      break;
    case 'overdue':
      li.append(tickButton({ id: x.ref.id, title: x.title }, li));
      break;
    case 'board':
      acts.append(btn('ghost small', t('Answer'), () => ctx.openCard?.(x.ref.boardId, x.ref.id)));
      break;
    case 'mail':
      acts.append(gmailLink(x.ref.threadId ? `https://mail.google.com/mail/u/0/#inbox/${x.ref.threadId}` : 'https://mail.google.com/mail/u/0/#inbox', t('Open in Gmail')));
      break;
    case 'hook':
      acts.append(btn('ghost small', t('Open'), () => (x.ref.conversationId ? ctx.openConversation(x.ref.conversationId) : ctx.openSettings('co-hooks'))));
      break;
    case 'plan':
      acts.append(btn('ghost small', t('Open her plans'), () => ctx.openHerPlans?.()));
      break;
    case 'model':
      acts.append(btn('ghost small', t('Pick a model'), () => (closeToday({ focus: false }), void ctx.openSettings('models'))));
      break;
  }
  const later = btn('ghost icon small td-later', '');
  later.append(icon('close') ?? document.createTextNode('×'));
  later.setAttribute('aria-label', t('Not today: {title}', { title }));
  later.title = t('Not today');
  later.addEventListener('click', go(async () => {
    await ctx.api(`/today/needs/${encodeURIComponent(x.key)}/not-today`, { method: 'POST', body: {} });
    (d.needs.notToday ??= []).push(x.key);
    renderNeeds(d);
    ctx.afterRender?.();
  }));
  acts.append(later);
  li.prepend(mark, text);
  li.append(acts);
  return li;
}
function needsWhy(x) {
  const at = x.at && Number.isFinite(Date.parse(x.at)) ? time(Date.parse(x.at)) : '';
  switch (x.kind) {
    case 'approval': return [at ? t('Waiting since {time}', { time: at }) : '', x.why].filter(Boolean).join(' · ');
    case 'failed': return at ? t('Failed at {time}', { time: at }) : t('Failed');
    case 'overdue': return x.at ? t('Overdue since {date}', { date: new Date(x.at).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }) }) : '';
    case 'board': return x.why || t('Waiting on you');
    case 'mail': return [x.why, at].filter(Boolean).join(' · ');
    case 'hook': return x.why;
    case 'plan': return t('She couldn’t send it in time');
    default: return '';
  }
}
function gmailLink(href, text) {
  const a = el('a', 'td-link td-ext', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** The organiser's words for one kind of change ("Labelled 3,312 as Receipts"). */
function organisedWords(g) {
  const n = num(g.count);
  switch (g.action) {
    case 'label': return t('Labelled {n} as {label}', { n, label: g.label ?? '' });
    case 'unlabel': return t('Took {label} off {n}', { n, label: g.label ?? '' });
    case 'archive': return t('Archived {n}', { n });
    case 'read': return t('Marked {n} as read', { n });
    case 'unread': return t('Marked {n} as unread', { n });
    case 'star': return t('Starred {n}', { n });
    case 'unstar': return t('Unstarred {n}', { n });
    case 'important': return t('Marked {n} as important', { n });
    case 'not_important': return t('Marked {n} as not important', { n });
    case 'trash': return t('Moved {n} to trash (emptied by Gmail after 30 days)', { n });
    case 'untrash': return t('Took {n} out of trash', { n });
    case 'spam': return t('Marked {n} as spam (deleted by Gmail after 30 days)', { n });
    case 'not_spam': return t('Marked {n} as not spam', { n });
    default: return `${g.action} ${n}`;
  }
}

/** Mail 2.0 (§5.3): inbox total and unread, the change since yesterday, what looks important, what she organised (with Undo). */
export function renderMail(m) {
  const tile = $('#td-mail');
  if (!tile) return;
  tile.hidden = !m;
  if (!m) return;
  const body = tile.querySelector('.td-body');
  const counts = typeof m.total === 'number' ? t('{total} in inbox · {unread} unread', { total: num(m.total), unread: num(m.unread) }) : t('Unread: {n}', { n: num(m.unread) });
  tileHead(tile, t('Mail'), m.error ? null : el('span', 'td-count td-mail-counts', counts));
  const out = [];
  if (m.error) {
    out.push(el('p', 'error small', m.error));
    if (m.reconnect) out.push(btn('ghost small', t('Reconnect Google'), () => (closeToday({ focus: false }), void ctx.openSettings('ab-google'))));
  } else {
    if (m.change) {
      const line = el('p', 'td-mail-change small');
      const arrow = (v) => (v < 0 ? '▼' : v > 0 ? '▲' : '＝');
      line.append(
        el('span', '', `${arrow(m.change.total)} ${t('Inbox since yesterday: {n}', { n: `${m.change.total > 0 ? '+' : ''}${num(m.change.total)}` })}`),
        el('span', '', `${arrow(m.change.unread)} ${t('Unread since yesterday: {n}', { n: `${m.change.unread > 0 ? '+' : ''}${num(m.change.unread)}` })}`),
      );
      out.push(line);
    }
    const big = sizeOf('td-mail') === 'L';
    if (m.important?.length) {
      out.push(el('h4', 'td-bd-h', t('Looks important')));
      const ul = el('ul', 'td-mail-list');
      for (const x of m.important.slice(0, big ? 4 : 3)) {
        const li = el('li', 'td-mail-row');
        const a = el('a', 'td-mail-link');
        a.href = x.threadId ? `https://mail.google.com/mail/u/0/#inbox/${x.threadId}` : 'https://mail.google.com/mail/u/0/#inbox';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.append(raw(el('span', 'td-mail-from', x.from)), raw(el('span', 'td-mail-subj', x.subject)));
        li.append(a, el('span', 'td-mail-at muted small', x.at ? time(Date.parse(x.at)) : ''));
        ul.append(li);
      }
      out.push(ul);
    }
    const org = m.organised ?? [];
    if (org.length) {
      out.push(el('h4', 'td-bd-h', t('She organised today')));
      if (big) {
        const ul = el('ul', 'td-org-list');
        for (const g of org.slice(0, 3)) {
          const li = el('li', 'td-org-row');
          li.append(raw(el('span', 'td-org-what', organisedWords(g))));
          const undo = btn('ghost small td-org-undo', t('Undo'));
          undo.setAttribute('aria-label', t('Undo: {what}', { what: organisedWords(g) }));
          undo.addEventListener('click', async () => {
            undo.disabled = true;
            try {
              // The organizer's own Undo (the same as the chat card's), one recorded change at a time.
              for (const id of g.ids) await ctx.api(`/google/undo/${encodeURIComponent(id)}`, { method: 'POST', body: {} });
              li.classList.add('done');
              undo.textContent = t('Undone');
            } catch (err) {
              undo.disabled = false;
              ctx.status(err.message);
            }
          });
          li.append(undo);
          ul.append(li);
        }
        out.push(ul);
      } else out.push(el('p', 'small', t('She organised today: {n}', { n: num(org.reduce((a, g) => a + g.count, 0)) })));
    }
    if (!m.important?.length && !org.length && !m.change) out.push(el('p', 'muted small', t('Nothing important waiting.')));
  }
  out.push(freshFoot(m.at, 10 * 60_000, [gmailLink('https://mail.google.com/mail/u/0/#inbox', t('Open Gmail'))]));
  body.replaceChildren(...out);
}

/** She remembered: the newest notes she learned (memory off or empty: the tile stays away). */
export function renderMemories(part) {
  const tile = $('#td-memories');
  if (!tile) return;
  const mems = part?.items ?? [];
  tile.hidden = !mems.length;
  if (!mems.length) return;
  tileHead(tile, t('She remembered'));
  const ul = el('ul', 'td-mems');
  for (const m of mems.slice(0, sizeOf('td-memories') === 'S' ? 2 : 3)) {
    const li = el('li', 'td-mem');
    li.append(raw(el('p', 'td-mem-text', m.content)));
    if (m.source?.title) li.append(raw(el('span', 'td-mem-from', m.source.title)));
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

/** Moments: "On this day" when there is one (moments.js), else the newest photos (L shows four, M two). */
function renderMomentsTile(d) {
  const tile = $('#td-otd');
  if (!tile) return;
  const n = sizeOf('td-otd') === 'L' ? 4 : 2;
  if (d.onThisDay?.items?.length) {
    ctx.renderMoments?.({ ...d, onThisDay: { ...d.onThisDay, items: d.onThisDay.items.slice(0, n) } });
    return;
  }
  const photos = latestPhotos(d.moments?.items, n);
  if (!photos.length) {
    tile.hidden = true;
    return;
  }
  ctx.renderPhotos?.(photos, t('Moments'));
}

/** Running now (§4.8): running jobs and team tasks (or the last one that ended), and today's runs as a count. */
export function renderWork(part) {
  const tile = $('#td-jobs');
  if (!tile) return;
  const w = workItems(part?.jobs, part?.team);
  const any = w.jobs.length + w.tasks.length;
  const runs = part?.runs ?? { total: 0, failed: 0 };
  tile.hidden = !any && !w.recent && !runs.total;
  if (tile.hidden) return;
  tileHead(tile, any ? t('Running now') : t('Last job'), any ? el('span', 'td-live', t('Running')) : null);
  const box = tile.querySelector('.today-list');
  const card = (label, sub, tail, j, progress) => {
    const c = el('div', 'td-job');
    // 2.8: a ring beside each job: a moving arc while it runs (jobs report no percentage), full when it
    // finished, the share of steps done for a team task.
    if (progress !== undefined) c.append(ring(progress, { size: 30, stroke: 3, cls: progress === 1 ? 'pring-done' : '' }));
    const name = raw(el('p', 'td-job-name', label));
    name.title = label;
    c.append(name, el('p', 'td-job-sub', sub));
    if (tail) c.append(raw(el('p', 'td-job-out', tail)));
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
          ctx.reloadParts?.(['work', 'needs']);
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
  const small = sizeOf('td-jobs') === 'S';
  box.replaceChildren(
    ...w.jobs.slice(0, small ? 1 : 3).map((j) => card(j.label, since(j.startedAt), small ? '' : lastLine(j.tail), j, null)),
    ...w.tasks.slice(0, small ? 1 : 2).map((x) => {
      const done = (x.steps ?? []).filter((s) => s.endedAt).length;
      const total = (x.steps ?? []).length;
      const c = card(t('Team: {goal}', { goal: x.goal }), x.status === 'waiting' ? t('Waiting for your OK') : total ? t('Steps done: {done} of {total}', { done, total }) : t('Planning'), '', null, total ? share(done, total) : null);
      c.append(btn('ghost small', t('Open the team'), () => {
        closeToday({ focus: false });
        $('#open-team')?.click();
      }));
      return c;
    }),
    ...(w.recent ? [card(w.recent.label, ended(w.recent), small ? '' : lastLine(w.recent.tail), w.recent, w.recent.status === 'ok' ? 1 : undefined)] : []),
    ...(runs.total ? [btn('td-link td-runs', runs.failed ? t('Runs today: {n} · failed: {f}', { n: runs.total, f: runs.failed }) : t('Runs today: {n}', { n: runs.total }), () => (closeToday({ focus: false }), void ctx.openSettings('dh-runs')))] : []),
  );
}

/** On the board (§4.8): what she is doing (cards waiting on you are in Needs you). */
export function renderBoardTile(b) {
  const tile = $('#td-board');
  if (!tile) return;
  const doing = b?.doing ?? [];
  tile.hidden = !doing.length;
  if (tile.hidden) return;
  tileHead(tile, t('On the board'));
  const body = tile.querySelector('.td-body');
  body.replaceChildren(
    ...doing.slice(0, ROWS[sizeOf('td-board')]).map((c) => {
      const b2 = btn('today-item td-bd-item doing', '', () => ctx.openCard?.(c.boardId, c.id));
      b2.append(raw(el('span', 'td-bd-title', c.title)), raw(el('span', 'muted small td-bd-sub', c.line === 'Queued' ? t('Queued') : c.line || t('Working on it'))));
      return b2;
    }),
  );
}

/** Phase 102 (ST7): from your webhooks (folded into Needs you; shown again from Customise). */
export function renderHooksTile(items) {
  const tile = $('#td-hooks');
  if (!tile) return;
  const list = items ?? [];
  tile.hidden = !list.length;
  if (tile.hidden) return;
  tileHead(tile, t('From your webhooks'), el('span', 'td-count td-needs', t('{n} need you', { n: list.length })));
  tile.querySelector('.td-body').replaceChildren(
    ...list.map((x) => {
      const b2 = btn('today-item td-bd-item needs', '', () => (x.conversationId ? ctx.openConversation(x.conversationId) : ctx.openSettings('co-hooks')));
      b2.append(raw(el('span', 'td-bd-title', x.kind === 'limit' ? t('{name} is sending too much: paused for 10 minutes', { name: x.name }) : x.text)), raw(el('span', 'muted small td-bd-sub', x.name)));
      return b2;
    }),
  );
}

/** Coding projects (§4.9): last change from git, the last tests, open pull requests when GitHub is connected. */
export function renderProjects(part) {
  const tile = $('#td-projects');
  if (!tile) return;
  const items = part?.items ?? [];
  tile.hidden = !items.length;
  if (!items.length) return;
  tileHead(tile, t('Coding projects'));
  tile.querySelector('.td-body').replaceChildren(
    ...items.slice(0, sizeOf('td-projects') === 'S' ? 2 : 3).map((x) => {
      const b = btn('today-item td-proj', '', async () => {
        closeToday({ focus: false });
        await ctx.openConversation(x.conversationId);
      });
      const facts = [x.last ? freshAgo(x.last.at) : '', x.tests === 'ok' ? t('tests passed') : x.tests === 'failed' ? t('tests failed') : '', typeof x.prs === 'number' ? t('Open PRs: {n}', { n: x.prs }) : ''].filter(Boolean).join(' · ');
      b.append(raw(el('span', 'td-proj-name', x.workspace)), el('span', `muted small td-proj-facts${x.tests === 'failed' ? ' bad' : ''}`, facts));
      if (x.last?.subject && sizeOf('td-projects') !== 'S') b.append(raw(el('span', 'td-proj-subj muted small', x.last.subject)));
      return b;
    }),
  );
}
const freshAgo = (at) => {
  const ms = Date.now() - Date.parse(at);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  return ms < 3600_000 ? rtf.format(-Math.max(1, Math.floor(ms / 60_000)), 'minute') : ms < 86_400_000 ? rtf.format(-Math.floor(ms / 3600_000), 'hour') : rtf.format(-Math.floor(ms / 86_400_000), 'day');
};

/** Usage today (§6.3): tokens and estimated cost since local midnight; a ring against a budget, else the last 7 days. */
export function renderUsage(u) {
  const tile = $('#td-usage');
  if (!tile) return;
  tile.hidden = !u;
  if (!u) return;
  tileHead(tile, t('Usage today'));
  const paid = (u.billing ?? []).includes('api');
  const cost = !u.showCost ? '' : paid ? `$${u.usd.toFixed(2)}${u.budget ? ` ${t('of {b}', { b: `$${u.budget.toFixed(2)}` })}` : ''}` : (u.billing ?? []).includes('subscription') ? t('$0 (subscription)') : t('$0 (local)');
  const main = el('div', 'td-usage-main');
  if (u.budget && paid && u.showCost) main.append(ring(Math.min(1, u.usd / u.budget), { size: 54, stroke: 5, text: `${Math.round((u.usd / u.budget) * 100)}%`, label: t('Spent today: {a} of {b}', { a: `$${u.usd.toFixed(2)}`, b: `$${u.budget.toFixed(2)}` }), cls: 'td-usage-ring' }));
  else {
    const sp = sparkline(u.days ?? [], { w: 96, h: 34, cls: 'td-usage-spark' });
    if (sp) {
      sp.setAttribute('aria-label', t('Tokens on each of the last 7 days'));
      main.append(sp);
    }
  }
  const nums = el('div', 'td-usage-nums');
  nums.append(el('span', 'td-usage-tok', t('{n} tokens', { n: kTok(u.tokens) })), ...(cost ? [el('span', 'muted small', cost)] : []));
  main.append(nums);
  const bars = el('ul', 'td-usage-split');
  const top = Math.max(1, ...(u.byPurpose ?? []).map((p) => p.tokens));
  for (const p of (u.byPurpose ?? []).slice(0, 3)) {
    const li = el('li', '');
    const bar = el('meter', 'td-usage-bar');
    bar.min = 0;
    bar.max = top;
    bar.value = p.tokens;
    bar.setAttribute('aria-label', `${purposeWords(p.purpose)}: ${kTok(p.tokens)}`);
    li.append(el('span', 'td-usage-p small', purposeWords(p.purpose)), bar);
    bars.append(li);
  }
  tile.querySelector('.td-body').replaceChildren(main, ...(u.byPurpose?.length ? [bars] : []), ...(!u.budget && paid && u.showCost ? [freshFoot(null, 0, [btn('td-link', t('Set a daily budget'), () => (closeToday({ focus: false }), void ctx.openSettings('dh-usage')))])] : []));
}
function purposeWords(p) {
  const words = { chat: t('Chat'), coding: t('Coding'), job: t('Jobs'), jobs: t('Jobs'), team: t('Team'), memory: t('Memory'), background: t('Background'), life: t('Her life'), quick: t('Small tasks'), titles: t('Titles'), safety: t('Safety check') };
  return words[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Phase 114 (B2): a room's line on Today: her summary's topic, else what was said lately in plain
 * words ("Lately: flat, alfama · last from Ana: “found a flat in alfama!”"), else "Quiet lately".
 * No model call; the server sends the parts (and an English line for older answers).
 */
export function roomTopicLine(r) {
  const p = r?.topicParts;
  if (!p) return r?.topic ?? '';
  if (p.summary) return p.summary;
  if (p.quiet) return t('Quiet lately');
  const parts = [];
  if (p.words?.length) parts.push(t('Lately: {words}', { words: p.words.join(', ') }));
  if (p.last) parts.push(t('last from {who}: “{text}”', { who: p.last.who, text: p.last.text }));
  return parts.join(' · ');
}

/**
 * Rooms (owner decision 2026-11-01): the keep-up rooms in a few words each: topic, who spoke
 * lately, the last activity, and Peek (the room window). Off until the owner switches it on.
 */
export function renderRooms(part) {
  const tile = $('#td-rooms');
  if (!tile) return;
  const items = part?.items ?? [];
  tile.hidden = !items.length;
  if (!items.length) return;
  tileHead(tile, t('Rooms'));
  const n = ROWS[sizeOf('td-rooms')];
  tile.querySelector('.td-body').replaceChildren(
    ...items.slice(0, n).map((r) => {
      const row = el('div', 'td-room');
      const head = el('div', 'td-room-head');
      const ic = icon(r.bridge === 'discord' ? 'discord' : r.bridge === 'telegram' ? 'telegram' : 'group');
      if (ic) head.append(ic);
      head.append(raw(el('span', 'td-room-name', r.name)), el('span', 'muted small td-room-at', r.last ? freshAgo(r.last) : ''));
      row.append(head);
      const topic = roomTopicLine(r);
      if (topic) row.append(raw(el('p', 'td-room-topic small', topic)));
      if (r.who?.length) row.append(raw(el('p', 'td-room-who muted small', r.who.join(', '))));
      const peek = btn('ghost small td-room-peek', t('Peek'), () => ctx.openRoom?.(r.id));
      peek.setAttribute('aria-label', t('Peek into {room}', { room: r.name }));
      row.append(peek);
      return row;
    }),
  );
}

/**
 * Your home (§4.10): who's home, the scenes he picked (pill buttons), and a few devices. Lights,
 * switches, fans and blinds switch here (2.7.1; the server decides: canSwitch); locks, alarms,
 * doors and the rest keep Ask Sara. Owner only, never on the demo. Picks are saved for this companion.
 */
export function renderHome(h, prefs) {
  const tile = $('#td-home');
  if (!tile) return 'hidden';
  if (!h || ctx.demo() || ctx.member()) {
    tile.hidden = true;
    return 'hidden';
  }
  if (h.connected === false) {
    tile.hidden = true;
    return 'not-connected';
  }
  const all = (h.entities ?? []).filter((e) => HOME_DOMAINS.includes(e.id.split('.')[0]));
  const shown = pickHome(all, prefs?.home?.entities ?? []);
  const scenes = (h.scenes ?? []).filter((s) => s.picked);
  tile.hidden = !all.length && !(h.people ?? []).length && !scenes.length;
  if (tile.hidden) return 'empty';
  const who = (h.people ?? []).map((p) => `${p.name}: ${p.home ? t('home') : t('away')}`).join(' · ');
  tileHead(tile, t('Home'), who ? raw(el('span', 'td-count td-who', who)) : null);
  const out = [];
  if (scenes.length) {
    const row = el('div', 'td-scenes');
    for (const sc of scenes.slice(0, 4)) {
      const b = btn('ghost small td-scene', sc.name, async () => {
        b.disabled = true;
        try {
          await ctx.api(`/home/entities/${encodeURIComponent(sc.id)}/toggle`, { method: 'POST', body: { to: 'on' } });
          b.classList.add('ran');
        } catch (err) {
          ctx.status(err.message);
        } finally {
          b.disabled = false;
        }
      });
      b.dataset.raw = '';
      row.append(b);
    }
    out.push(row);
  }
  const grid = el('div', 'td-home-grid');
  for (const e of shown) {
    const card = el('div', `td-dev${isOnState(e.state) ? ' on' : ''}`);
    const name = raw(el('p', 'td-dev-name', e.name));
    name.title = e.name;
    const st = el('p', 'td-dev-state', stateWords(e));
    st.setAttribute('aria-live', 'polite');
    if (e.canSwitch) {
      card.classList.add('has-switch');
      card.append(homeSwitch(e, card, st), name, st);
    } else card.append(name, st, btn('td-dev-ask ghost small', t('Ask Sara'), () => askAbout(e)));
    grid.append(card);
  }
  if (shown.length) out.push(grid);
  const choose = el('details', 'td-home-choose');
  choose.append(el('summary', '', t('Choose what shows here')));
  const picks = el('div', 'td-home-picks');
  const save = (patch) => ctx.savePrefs?.(patch);
  for (const e of all.slice(0, 60)) picks.append(pickBox(e.id, e.name, shown.some((s) => s.id === e.id), 'dev'));
  for (const s of (h.scenes ?? []).slice(0, 20)) picks.append(pickBox(s.id, t('Scene: {name}', { name: s.name }), s.picked, 'scene'));
  picks.addEventListener('change', () => {
    const ids = [...picks.querySelectorAll('input[data-kind="dev"]:checked')].map((x) => x.value).slice(0, 6);
    const sc = [...picks.querySelectorAll('input[data-kind="scene"]:checked')].map((x) => x.value).slice(0, 4);
    save({ home: { entities: ids, scenes: sc } });
  });
  choose.append(picks, el('p', 'muted small', t('Up to six devices and four scenes, saved for this companion. A scene runs right away, so pick only ones that never unlock or open anything.')));
  out.push(el('p', 'td-foot muted small', t('The switches work right away. Locks, alarms, doors and the rest go through her, so your approval settings still apply.')), choose);
  tile.querySelector('.td-body').replaceChildren(...out);
  return 'shown';
}
function pickBox(id, name, on, kind) {
  const lab = el('label', 'row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = on;
  cb.value = id;
  cb.dataset.kind = kind;
  cb.dataset.nodirty = '';
  lab.append(cb, raw(el('span', '', name)));
  return lab;
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

/** Model changes (Phase 56): retired models and what now uses their replacement. */
function renderModels(d) {
  const tile = $('#td-models');
  if (!tile) return;
  const lines = d.modelItems?.length ? d.modelItems.map((x) => ctx.modelText?.(x) ?? x.text) : (d.models ?? []);
  tile.hidden = !lines.length;
  if (!lines.length) return;
  tileHead(tile, t('Model changes'));
  tile.querySelector('.today-list').replaceChildren(...lines.map((line) => {
    const row = el('div', 'today-row wrap');
    row.append(raw(el('span', 'today-main', line)));
    return row;
  }));
}

/** Add to your day (§3.4): one line per thing not set up yet, each with its own Hide. */
function renderSetup(items, prefs) {
  const tile = $('#td-setup');
  if (!tile) return;
  tile.hidden = !items.length;
  if (tile.hidden) return;
  const words = {
    weather: [t('Weather'), t('Add your town for the weather here and in the morning briefing.')],
    calendar: [t('Calendar'), t('Connect Google Calendar to see your events here.')],
    mail: [t('Mail'), t('Connect Gmail to see your inbox and what she organised here.')],
    home: [t('Home'), t('Connect Home Assistant to see your lights and switches here.')],
    github: ['GitHub', t('Connect GitHub to see open pull requests on Coding projects.')],
  };
  tileHead(tile, t('Add to your day'));
  tile.querySelector('.td-body').replaceChildren(
    ...items.map((x) => {
      const row = el('div', 'td-setup-row');
      const b = btn('td-setup-item', '');
      b.append(el('strong', '', words[x.key][0]), el('span', 'muted small', words[x.key][1]));
      b.addEventListener('click', () => {
        closeToday({ focus: false });
        void ctx.openSettings(x.page);
      });
      const hide = btn('ghost small td-hide', t('Hide'), () => {
        row.remove();
        ctx.savePrefs?.({ setupHidden: [...(prefs?.setupHidden ?? []), x.key] });
      });
      hide.setAttribute('aria-label', t('Hide: {what}', { what: words[x.key][0] }));
      row.append(b, hide);
      return row;
    }),
  );
}

/** Since you were away (§6.5): a strip above the sections, until dismissed. */
function renderAway(away) {
  const box = $('#td-away');
  if (!box) return;
  const lines = awayLines(away);
  box.hidden = !lines.length || awayDismissed === away?.since;
  if (box.hidden) return;
  // Her sentence (off by default, §15 Q4) comes first when there is one; the counted lines stay.
  $('#td-away-text').textContent = `${away.voice ? `${away.voice} ` : ''}${t('While you were away ({n} h):', { n: away.hours })} ${lines.join(' · ')}`;
}
let awayDismissed = null;

// ---------- the layout: sections, slots, spans (B4, B5) ----------

let state = { d: null, prefs: null };
export const todayData = () => state.d;

/**
 * Puts every tile in its section and slot (DOM order = visual order), hides the owner's hidden
 * tiles and the empty ones, runs the fill rule over what is left and sets the span classes. A
 * section with nothing in it hides its heading. `pending`: before the batch has answered, slots
 * of tiles that were visible last time stay as skeletons (no layout shift).
 */
export function applyLayout(prefs, { empty = {}, pending = false, keep = [] } = {}) {
  const root = $('#td-tiles');
  if (!root) return [];
  form = measureForm() ?? form;
  const view = $('#today');
  view?.classList.toggle('td-ff-phone', form === 'phone');
  view?.classList.toggle('td-ff-tablet', form === 'tablet');
  const model = layoutModel(prefs, { member: ctx?.member?.() });
  const isOn = (x) => x.shown && (pending ? keep.includes(x.id) : !empty[x.id]);
  const place = (grid, x) => {
    const tile = $(`#${x.id}`);
    if (!tile) return false;
    grid.append(tile);
    const on = isOn(x);
    tile.hidden = !on;
    tile.classList.toggle('td-skel', pending && on);
    tile.dataset.size = x.size;
    tile.className = tile.className.split(' ').filter((c) => !/^td-(span|lg|md)-\d+$/.test(c)).join(' ');
    return on;
  };
  const visible = [];
  const shut = collapsedNow(prefs);
  if (form === 'phone') {
    // One column in priority order: the tiles move into the phone's groups (DOM order = visual order).
    for (const sec of model) {
      const node = $(`#td-sec-${sec.id}`);
      if (node) node.hidden = true;
    }
    for (const g of phoneOrder(prefs, { member: ctx?.member?.() })) {
      if (g.id === 'now') continue;
      const node = phoneGroup(g.id);
      root.append(node);
      const grid = node.querySelector('.td-grid');
      const here = g.tiles.filter((x) => place(grid, x));
      node.hidden = !here.length;
      node.classList.toggle('td-pg-single', g.single);
      // A swipe row only with two cards or more (one card is just a card).
      node.classList.toggle('td-swipe', g.swipe && here.length > 1);
      if (g.swipe && here.length > 1) {
        grid.setAttribute('role', 'region');
        grid.setAttribute('aria-label', groupTitle(g.id));
      } else {
        grid.removeAttribute('role');
        grid.removeAttribute('aria-label');
      }
      setCollapsed(node, g.id, shut.includes(g.id));
      swipeNav(node, g.swipe ? here.length : 0);
      visible.push(...here.map((x) => x.id));
    }
  } else {
    for (const node of document.querySelectorAll('#td-tiles > .td-pg')) node.hidden = true;
    for (const sec of model) {
      const node = $(`#td-sec-${sec.id}`);
      if (!node) continue;
      root.append(node);
      const grid = node.querySelector('.td-grid');
      const shownHere = sec.tiles.filter((x) => place(grid, x));
      const spans = spanClasses(shownHere);
      for (const x of shownHere) $(`#${x.id}`)?.classList.add(...spans[x.id]);
      node.hidden = !shownHere.length;
      // Tablets: the section headings open and close (remembered for tablets only).
      sectionToggle(node, sec.id, form === 'tablet');
      if (form === 'tablet') setCollapsed(node, sec.id, shut.includes(sec.id));
      else grid.hidden = false;
      visible.push(...shownHere.map((x) => x.id));
    }
  }
  // Hidden tiles' sizes are remembered for the renderers (rows per size).
  currentSizes = Object.fromEntries(model.flatMap((s) => s.tiles.map((x) => [x.id, x.size])));
  root.append($('#td-live') ?? document.createComment(''));
  placeNow();
  summarise();
  return visible;
}

// ---------- the form factor, the phone's groups, collapsing, swipe rows (TD2) ----------

let form = 'desktop';
export const currentForm = () => form;
/** Today's own width (its content box) and the screen: phone, tablet or desktop. Null while Today is closed. */
function measureForm() {
  const sc = $('#today .td-scroll');
  if (!sc || !sc.clientWidth) return null;
  const cs = getComputedStyle(sc);
  const container = sc.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
  return formFactor({ viewport: innerWidth, container, coarse: matchMedia('(pointer: coarse)').matches });
}

/** The words for a group's heading on a phone (the sections' own words, plus Weather and Mail). */
function groupTitle(id) {
  return { day: t('Your day'), needs: t('Needs you'), her: t('With her'), work: t('Work'), more: t('Home & more'), weather: t('Weather'), mail: t('Mail') }[id] ?? id;
}

/** A phone group: a section with a disclosure heading, its grid, and (for swipe rows) the dots and buttons. */
function phoneGroup(id) {
  let node = $(`#td-pg-${id}`);
  if (node) return node;
  node = el('section', 'td-sec td-pg');
  node.id = `td-pg-${id}`;
  node.dataset.sec = id;
  const h = el('h2', 'td-sec-h');
  h.id = `td-pg-${id}-h`;
  node.setAttribute('aria-labelledby', h.id);
  const grid = el('div', 'td-grid');
  grid.id = `td-pg-${id}-grid`;
  node.append(h, grid);
  sectionToggle(node, id, true);
  return node;
}

/**
 * The heading as a disclosure button (44 px, a chevron, aria-expanded) on phones and tablets; a
 * plain heading on the desktop. Collapsed, it shows a one-line summary.
 */
function sectionToggle(node, id, on) {
  const h = node.querySelector('.td-sec-h');
  const grid = node.querySelector('.td-grid');
  if (!h || !grid) return;
  const has = h.querySelector('.td-sec-toggle');
  const name = node.classList.contains('td-pg') ? groupTitle(id) : (has?.querySelector('.td-sec-name')?.textContent ?? h.textContent);
  if (!on) {
    if (has) h.replaceChildren(name);
    return;
  }
  if (has) return;
  if (!grid.id) grid.id = `${node.id}-grid`;
  const b = btn('td-sec-toggle', '');
  b.setAttribute('aria-expanded', 'true');
  b.setAttribute('aria-controls', grid.id);
  const chev = el('span', 'td-chev');
  chev.setAttribute('aria-hidden', 'true');
  b.append(chev, el('span', 'td-sec-name', name), el('span', 'td-sec-sum'));
  b.addEventListener('click', () => toggleGroup(id));
  h.replaceChildren(b);
}

/** Open or shut one group; saved for this companion and this form factor only (§7.3). */
function toggleGroup(id) {
  const now = collapsedNow(state.prefs);
  const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
  shutNow[form] = next;
  const node = form === 'phone' ? $(`#td-pg-${id}`) : $(`#td-sec-${id}`);
  if (node) setCollapsed(node, id, next.includes(id));
  summarise();
  ctx.saveCollapsed?.(form, next);
}
/** This visit's collapsed groups (set when Today opens, from the saved state and the phone setting). */
const shutNow = { phone: null, tablet: null };
function collapsedNow(prefs) {
  if (form === 'desktop') return [];
  shutNow[form] ??= collapsedAtOpen(prefs, form);
  return shutNow[form];
}
function setCollapsed(node, id, shut) {
  const grid = node.querySelector('.td-grid');
  const b = node.querySelector('.td-sec-toggle');
  if (grid) grid.hidden = shut;
  node.classList.toggle('td-shut', shut);
  b?.setAttribute('aria-expanded', String(!shut));
  const nav = node.querySelector('.td-swipe-nav');
  if (nav) nav.hidden = shut || !node.classList.contains('td-swipe');
}

/** Each heading's short summary: Needs you's count always; the rest only while collapsed. */
function summarise() {
  const d = state.d;
  for (const b of document.querySelectorAll('#td-tiles .td-sec-toggle')) {
    const node = b.closest('.td-sec');
    const id = node?.dataset.sec;
    const sum = b.querySelector('.td-sec-sum');
    if (!id || !sum) continue;
    const shut = node.classList.contains('td-shut');
    let words = '';
    if (d && id === 'needs') {
      const n = needsItems(d).length;
      words = n ? String(n) : '';
    } else if (d && shut) words = groupSummary(id, d, node);
    sum.textContent = words;
    sum.hidden = !words;
  }
}
function groupSummary(id, d, node) {
  const names = () => [...node.querySelectorAll('.td-tile:not([hidden])')].map((x) => ctx.tileTitle?.(x.id) ?? x.querySelector('h3')?.textContent ?? '').filter(Boolean).join(' · ');
  if (id === 'weather' && d.weather && d.weather.now !== null && d.weather.now !== undefined) return [`${d.weather.now}°`, weatherWords(weatherKind(d.weather.code, d.weather.day !== false).kind)].filter(Boolean).join(' · ');
  if (id === 'mail' && d.mail && !d.mail.error) return typeof d.mail.total === 'number' ? t('{total} in inbox · {unread} unread', { total: num(d.mail.total), unread: num(d.mail.unread) }) : t('Unread: {n}', { n: num(d.mail.unread) });
  if (id === 'day' && form === 'phone') {
    const next = nowItems(d)[0];
    return next ? `${time(next.at)} ${next.kind === 'leave' ? t('Leave by {time} · {n} min', { time: time(next.at), n: next.minutes }) : next.title}` : '';
  }
  return names();
}

/** A swipe row's dots (decorative) and its Previous/Next buttons: the visible way to move without swiping. */
function swipeNav(node, n) {
  let nav = node.querySelector('.td-swipe-nav');
  const on = node.classList.contains('td-swipe');
  if (!on) {
    if (nav) nav.hidden = true;
    return;
  }
  const grid = node.querySelector('.td-grid');
  if (!nav) {
    nav = el('div', 'td-swipe-nav');
    const prev = btn('ghost icon td-swipe-prev', '‹', () => step(-1));
    prev.setAttribute('aria-label', t('Previous card'));
    const next = btn('ghost icon td-swipe-next', '›', () => step(1));
    next.setAttribute('aria-label', t('Next card'));
    const dots = el('span', 'td-dots');
    dots.setAttribute('aria-hidden', 'true');
    nav.append(prev, dots, next);
    node.append(nav);
    const cards = () => [...grid.querySelectorAll(':scope > .td-tile:not([hidden])')];
    const at = () => {
      const list = cards();
      const left = grid.scrollLeft;
      let best = 0;
      list.forEach((c, i) => {
        if (Math.abs(c.offsetLeft - grid.offsetLeft - left) < Math.abs(list[best].offsetLeft - grid.offsetLeft - left)) best = i;
      });
      return best;
    };
    const step = (dir) => {
      const list = cards();
      const to = list[Math.max(0, Math.min(list.length - 1, at() + dir))];
      if (!to) return;
      grid.scrollTo({ left: to.offsetLeft - grid.offsetLeft, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    };
    const mark = () => {
      const i = at();
      const list = cards();
      [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
      prev.disabled = i <= 0;
      next.disabled = i >= list.length - 1;
    };
    grid.addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
    nav.mark = mark;
  }
  nav.hidden = node.classList.contains('td-shut');
  const dots = nav.querySelector('.td-dots');
  dots.replaceChildren(...Array.from({ length: n }, () => el('span', 'td-dot-i')));
  nav.mark?.();
}

/**
 * The Now card (phones and tablets): its place is first, before Getting started; on a phone the
 * date and Plan my day move into it (the compact header keeps only her face, the greeting,
 * Refresh and Customise).
 */
function placeNow() {
  const card = $('#td-now');
  if (!card) return;
  card.hidden = form === 'desktop';
  const ask = $('#td-ask');
  const acts = $('#td-now-acts');
  if (!ask || !acts) return;
  if (form === 'phone' && ask.parentNode !== acts) acts.append(ask);
  if (form !== 'phone' && ask.parentNode === acts) $('#today .td-actions')?.prepend(ask);
}

/** Fills the Now card from the batched answer: the next things with a countdown, the weather in one line, her mood. */
export function renderNow(d) {
  const card = $('#td-now');
  if (!card || !d) return;
  const now = Date.now();
  $('#td-now-date').textContent = new Date(now).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
  const rows = [];
  const row = (iconName, text, cls = '') => {
    const li = el('li', `td-now-row ${cls}`.trim());
    const ic = icon(iconName);
    const mark = el('span', 'td-now-ic');
    mark.setAttribute('aria-hidden', 'true');
    if (ic) mark.append(ic);
    li.append(mark, raw(el('span', 'td-now-text', text)));
    return li;
  };
  for (const x of nowItems(d, now)) {
    if (x.kind === 'leave') rows.push(row('car', t('Leave by {time} for {what}', { time: time(x.at), what: x.title }), 'leave'));
    else if (x.mins <= 0) rows.push(row(x.kind === 'reminder' ? 'reminder' : 'calendar', t('Now: {what}', { what: x.title }), 'soon'));
    else if (x.mins < 60) rows.push(row(x.kind === 'reminder' ? 'reminder' : 'calendar', t('{what} in {n} min', { what: x.title, n: x.mins }), 'soon'));
    else rows.push(row(x.kind === 'reminder' ? 'reminder' : 'calendar', t('{what} at {time}', { what: x.title, time: time(x.at) })));
  }
  if (!rows.length) rows.push(row('calendar', dayItems(d, now).length ? t('Nothing else planned today.') : t('Nothing planned. Enjoy the space.'), 'quiet'));
  const w = d.weather;
  if (w && w.setUp !== false && !w.error && w.now !== null && w.now !== undefined) {
    const wet = rainFrom(w);
    const words = [`${w.now}°`, weatherWords(weatherKind(w.code, w.day !== false).kind), wet ? t('rain from {time}', { time: hourOf(wet.time) }) : ''].filter(Boolean).join(' · ');
    rows.push(row('weather', words, 'weather'));
  }
  const mood = $('#td-mood-text')?.textContent?.trim();
  if (d.her && mood) rows.push(row('heart', `${$('#td-her-name')?.textContent ?? ''}: ${mood}`, 'mood'));
  if (!needsItems(d).length) rows.push(row('check', t('Nothing needs you right now.'), 'clear'));
  $('#td-now-list').replaceChildren(...rows);
  card.classList.remove('td-skel');
}

const SKEL_KEY = 'sara.today.slots';
/** The visible tiles of the last open (this session), so the next open draws the same slots at once. */
function rememberSlots(prefs, visible) {
  try {
    sessionStorage.setItem(SKEL_KEY, JSON.stringify({ prefs, visible }));
  } catch {
    /* private mode */
  }
}
/** Draws the skeleton from the last layout before any data arrives (§8.3). */
export function drawSkeleton() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SKEL_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;
  applyLayout(saved.prefs, { pending: true, keep: saved.visible ?? [] });
}

/** Draws every tile from one batched answer, then lays them out (collapse after, not during). */
export function renderToday(d, { fmtDue, inDaysWords }) {
  state.d = d;
  state.prefs = d.layout ?? state.prefs;
  const prefs = state.prefs;
  const face = $('#td-face');
  if (face) face.src = $('#hp-portrait')?.getAttribute('src') || $('#sidebar img.avatar')?.getAttribute('src') || '/sara-portrait.jpg';
  // 2.8: her halo here takes the colours of her mood, like her panel's.
  const mood = $('#hp-open-her')?.dataset.mood;
  if (mood) $('#td-face-btn')?.setAttribute('data-mood', mood);
  // Sizes first (the renderers show more or less), from the saved layout.
  applyLayout(prefs, { pending: true, keep: [] });
  const parts = d.parts ?? {};
  // A full answer (it has the layout) draws every tile, so a part that isn't there collapses its tile.
  const full = 'layout' in parts;
  const has = (p) => full || p in parts;
  const empty = {};
  const mark = (id) => (empty[id] = Boolean($(`#${id}`)?.hidden));
  const draw = (id, fn) => {
    const tile = $(`#${id}`);
    if (!tile) return;
    tile.classList.remove('td-skel');
    fn();
    mark(id);
  };
  if (has('day')) {
    draw('td-calendar', () => renderDay(d, fmtDue));
    draw('td-agenda', () => renderPlanner(d, fmtDue));
  }
  if (has('weather')) draw('td-weather', () => renderWeather(d.weather));
  if (has('coming')) draw('td-dates', () => renderDates(d, inDaysWords));
  if (has('needs')) draw('td-needs', () => renderNeeds(d));
  if (has('mail')) draw('td-mail', () => renderMail(d.mail));
  if (has('memories')) draw('td-memories', () => renderMemories(d.memories));
  if (has('moments')) draw('td-otd', () => renderMomentsTile(d));
  if (has('plans')) draw('td-plans', () => ctx.renderPlans?.(d.plans, tileHead));
  if (has('rooms')) draw('td-rooms', () => renderRooms(d.rooms));
  if (has('work')) draw('td-jobs', () => renderWork(d.work));
  if (has('board')) draw('td-board', () => renderBoardTile(d.board));
  if (has('projects')) draw('td-projects', () => renderProjects(d.projects));
  if (has('usage')) draw('td-usage', () => renderUsage(d.usage));
  let home = 'hidden';
  if (has('home')) draw('td-home', () => (home = renderHome(d.home, prefs)));
  if (has('models')) draw('td-models', () => renderModels(d));
  if (has('hooks')) draw('td-hooks', () => renderHooksTile(d.hooks));
  draw('td-setup', () => renderSetup(setupItems({ weather: d.weather ?? (has('weather') ? { setUp: false } : undefined), calendar: d.calendar, mail: d.mail === undefined && has('mail') && !ctx.member() ? null : d.mail, home: d.home?.connected === false ? 'not-connected' : home, projects: d.projects, member: ctx.member(), demo: ctx.demo(), hidden: prefs?.setupHidden ?? [] }), prefs));
  if (has('away')) renderAway(d.away);
  Object.assign(lastEmpty, empty);
  const visible = applyLayout(prefs, { empty: lastEmpty });
  rememberSlots(prefs, visible);
  freshHeader(d);
  renderNow(d);
  summarise();
}
const lastEmpty = {};

/** Re-lays the page from the current data (after a Customise change: live preview). */
export function relayout(prefs) {
  state.prefs = prefs;
  if (state.d) state.d.layout = prefs;
  const visible = applyLayout(prefs, { empty: lastEmpty });
  rememberSlots(prefs, visible);
  return visible;
}
export const currentPrefs = () => state.prefs;

/** The header's freshness: when the oldest outside part was read. */
function freshHeader(d) {
  const at = d.parts?.layout?.at ?? new Date().toISOString();
  const box = $('#td-fresh');
  if (!box) return;
  box.replaceChildren();
  const tm = el('time', 'td-fresh-at', freshWords(at));
  tm.setAttribute('datetime', at);
  tm.dataset.at = at;
  box.append(tm);
}
/** Each minute: every "Updated …" line is worded again (not announced). */
function rewordFreshness() {
  for (const tm of document.querySelectorAll('#today time.td-fresh-at[data-at]')) tm.textContent = freshWords(tm.dataset.at, Date.now(), Number(tm.dataset.limit) || 0);
}

// ---------- live parts (B7) ----------

const RELOAD_WITH = { mail: ['mail', 'needs'], needs: ['needs'], work: ['work', 'needs'], home: ['home'], day: ['day', 'needs'], coming: ['coming'], layout: ['layout'], board: ['board', 'needs'], plans: ['plans', 'needs'] };
let pendingParts = new Set();
let partTimer = 0;
/** SSE `today {part}` (or a planner/board change): reload just those parts after 1.5 s. */
export function todayPartChanged(part) {
  if (!todayOpen()) return;
  for (const p of RELOAD_WITH[part] ?? [part]) pendingParts.add(p);
  clearTimeout(partTimer);
  partTimer = setTimeout(() => void reloadParts([...pendingParts]), 1500);
}
export async function reloadParts(parts) {
  pendingParts = new Set();
  if (!state.d || !parts.length) return;
  let r;
  try {
    r = await ctx.api(`/today?parts=${parts.join(',')}`);
  } catch {
    return;
  }
  // A layout change from another device while the sheet is open waits until it closes.
  if (parts.includes('layout') && ctx.editing?.()) delete r.layout;
  const merged = { ...state.d, ...r, parts: { ...(state.d.parts ?? {}), ...(r.parts ?? {}) } };
  // Only the parts that came back are drawn again; the rest keep what they show.
  renderToday({ ...merged, parts: r.parts ?? {} }, ctx.fmt);
  state.d = merged;
}

/**
 * Phase 112 (TD2): the phone and tablet wiring. The layout follows Today's width (a turned tablet,
 * her panel opening); pull to refresh on the scroll area; back to a visible Today after more than
 * two minutes reloads the parts that are past their limits.
 */
function initTouch(d) {
  const sc = d.querySelector('.td-scroll');
  if (!sc) return;
  let frame = 0;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!todayOpen() || !state.prefs) return;
        const was = form;
        // Another form factor: every tile is drawn again (rows per size, the phone's empty Needs you).
        if ((measureForm() ?? form) !== was && state.d) renderToday(state.d, ctx.fmt);
      });
    }).observe(sc);
  }
  const pull = $('#td-pull');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = (v) => {
    if (!pull) return;
    pull.dataset.step = String(v.step ?? 0);
    pull.classList.toggle('on', Boolean(v.active) || tracker.busy());
    pull.classList.toggle('ready', Boolean(v.ready));
  };
  const tracker = pullTracker({
    threshold: 64,
    reduced,
    onRefresh: async () => {
      pull?.classList.add('busy', 'on');
      try {
        await ctx.refresh?.();
      } finally {
        pull?.classList.remove('busy', 'on', 'ready');
        if (pull) pull.dataset.step = '0';
      }
    },
  });
  const pt = (e) => e.touches?.[0] ?? e.changedTouches?.[0];
  sc.addEventListener('touchstart', (e) => {
    const p = pt(e);
    if (!p || e.touches.length > 1) return void show(tracker.cancel());
    show(tracker.start(p.clientX, p.clientY, sc.scrollTop));
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    const p = pt(e);
    if (p) show(tracker.move(p.clientX, p.clientY, sc.scrollTop));
  }, { passive: true });
  sc.addEventListener('touchend', () => show(tracker.end()), { passive: true });
  sc.addEventListener('touchcancel', () => show(tracker.cancel()), { passive: true });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const parts = todayOpen() && state.d ? returnParts({ hiddenAt, parts: state.d.parts ?? {} }) : [];
    hiddenAt = 0;
    if (parts.length) void reloadParts(parts);
  });
}

export function initToday(c) {
  ctx = c;
  const d = $('#today');
  if (!d) return;
  // Esc (or the browser's back on Android, which arrives as Esc in the apps) goes back to the chat,
  // unless something on top of Today has it (a window, her panel over it, the open sidebar, a tour,
  // the Customise sheet).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !d.open || e.defaultPrevented) return;
    const other = Boolean(document.querySelector('dialog[open]:not(#today)') || document.querySelector('.her-panel.is-open:is(.mode-overlay, .mode-sheet)') || $('#main').classList.contains('show-sidebar') || document.querySelector('.tour-card'));
    // An open ⋯ menu or the Customise sheet closes first (web/today-layout.js handles both).
    if (escAction({ menu: Boolean(document.querySelector('#today .td-menu')), sheet: !$('#td-custom')?.hidden, other }) !== 'leave') return;
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
  $('#td-away-x')?.addEventListener('click', () => {
    awayDismissed = state.d?.away?.since ?? null;
    $('#td-away').hidden = true;
    void ctx.api('/today/seen', { method: 'PUT', body: {} }).catch(() => {});
  });
  setInterval(() => {
    if (!todayOpen()) return;
    rewordFreshness();
  }, 60_000);
  initTouch(d);
  // Today (or a chat) open and visible: "seen" for Since you were away, at most every 5 minutes.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !ctx.demo()) void ctx.api('/today/seen', { method: 'PUT', body: {} }).catch(() => {});
  }, 5 * 60_000);
}
