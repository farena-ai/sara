// Planner: tasks, projects, places, reminders, notes, Today, briefing, review, leave-by, story.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { briefingSettings, defaultUnits, geocode } from '../briefing.ts';
import { as400, fromPhoneApp, HttpError, readJson, send, validWorkspace } from '../http.ts';
import { findAddress, leaveBySettings } from '../leaveby.ts';
import { localDate } from '../memory-worker.ts';
import { netFetch } from '../net-guard.ts';
import { parseWhen, PLACE_DUE, type PlannerStore, type Priority, type Project, type Repeat, REPEATS } from '../planner.ts';
import { channelName, channelOfBuiltin, channelOn, filedCount, roomChip, roomOfConversation, roomsByKey, unfileChannelChats } from '../bridges/rooms.ts';
import type { Conversation } from '../store.ts';
import { ReminderScheduler } from '../reminders.ts';
import { reviewSettings } from '../review.ts';
import { adultModeOn } from '../settings.ts';
import { gatherStory, lookbacks, STORY_FILTERS, type StoryFilter } from '../story.ts';
import { buildToday } from '../today.ts';
import { workspaceDir } from '../tools/workspace.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.cache', 'dist', 'build', '.next']);
/** Files in a folder (newest first), skipping dependency/VCS folders. */
function listFiles(root: string, max: number): { files: { path: string; size: number; modifiedAt: string }[]; truncated: boolean } {
  const out: { path: string; size: number; modifiedAt: string; ms: number }[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max * 4) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name), r, depth + 1);
      } else if (d.isFile()) {
        const st = statSync(join(dir, d.name));
        out.push({ path: r, size: st.size, modifiedAt: st.mtime.toISOString(), ms: st.mtimeMs });
      }
    }
  };
  if (existsSync(root)) walk(root, '', 0);
  out.sort((x, y) => y.ms - x.ms);
  if (out.length > max) truncated = true;
  return { files: out.slice(0, max).map(({ ms: _ms, ...f }) => f), truncated };
}

/** The weather tile's facts: now, today's high/low and rain chance, the next few hours (WMO codes). */
export interface TodayWeather {
  place: string;
  units: 'F' | 'C';
  now: number | null;
  code: number | null;
  high: number | null;
  low: number | null;
  rain: number | null;
  /** Daylight now (false at night: the tile shows a moon for a clear sky). */
  day: boolean;
  hours: { time: string; temp: number | null; code: number | null; day: boolean }[];
}
const WEATHER_MS = 15 * 60_000;
let weatherCache: { key: string; at: number; data: TodayWeather } | undefined;
/** Tests: forget the cached weather. */
export const clearWeatherCache = (): void => void (weatherCache = undefined);

async function todayWeather(place: { name: string; lat: number; lon: number }, units: 'F' | 'C'): Promise<TodayWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    '&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    `&timezone=auto&forecast_days=2${units === 'F' ? '&temperature_unit=fahrenheit' : ''}`;
  const res = await netFetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const d = (await res.json()) as {
    current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number };
    hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[]; is_day?: number[] };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[]; weather_code?: number[] };
  };
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
  // The next four hours on the hour after the current reading (local times as Open-Meteo gives them).
  const times = d.hourly?.time ?? [];
  const from = Math.max(0, times.findIndex((x) => x > String(d.current?.time ?? '')));
  const hours = times.slice(from, from + 4).map((time, i) => ({ time, temp: num(d.hourly?.temperature_2m?.[from + i]), code: num(d.hourly?.weather_code?.[from + i]), day: d.hourly?.is_day?.[from + i] !== 0 }));
  return {
    place: place.name.split(',')[0],
    units,
    now: num(d.current?.temperature_2m),
    code: num(d.current?.weather_code ?? d.daily?.weather_code?.[0]),
    high: num(d.daily?.temperature_2m_max?.[0]),
    low: num(d.daily?.temperature_2m_min?.[0]),
    rain: num(d.daily?.precipitation_probability_max?.[0]),
    day: d.current?.is_day !== 0,
    hours,
  };
}

export function createPlannerRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, rootDir } = ctx;
  // Phase 108 (CH2): a channel project says which channel it holds, whether that channel is on (then
  // it can't be deleted) and how many chats the one-time filing moved in (its Undo).
  const projectView = (p: Project) => {
    const ch = channelOfBuiltin(p.builtin);
    return ch ? { ...p, channel: { kind: ch.kind, bridge: ch.bridge, name: channelName(app, p.builtin), on: channelOn(app, p.builtin) }, filed: filedCount(app, p.id) } : p;
  };
  function needPlanner(): PlannerStore {
    if (!app.planner) throw new HttpError(404, 'Planner is not available');
    return app.planner;
  }
  function whenOrNull(v: unknown, dateOnlyHour?: number): string | null {
    if (v === undefined || v === null || v === '') return null;
    const d = parseWhen(String(v), app.now(), app.settings.get().timeZone, { dateOnlyHour });
    if (!d) throw new HttpError(400, 'Couldn\'t understand the time "{time}"', { params: { time: String(v) } });
    return d.toISOString();
  }
  function validPriority(v: unknown): Priority | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (!['low', 'normal', 'high'].includes(String(v))) throw new HttpError(400, 'priority must be low, normal or high');
    return v as Priority;
  }
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    // Phase 14: the phone app's home-screen widget (her face, mood, last message) and its
    // notification check (her messages that arrived on their own, after a given id).
    if (a === 'today' && !b && method === 'GET') {
      const today = await buildToday(app, { fresh: new URL(req.url ?? '/', 'http://x').searchParams.has('fresh') });
      // Phase 70: "On this day" from the album (never on the demo; adults-only photos only with Adult mode, never in the phone apps).
      const otd = opts.demo ? undefined : app.moments?.onThisDay(app.now(), app.settings.get().timeZone, { adultOk: adultModeOn(app.settings.get()) && !fromPhoneApp(req) });
      return send(res, 200, otd ? { ...today, onThisDay: { kind: otd.kind, ...(otd.years ? { years: otd.years } : {}), items: otd.items.map((m) => ({ id: m.id, image: m.image, caption: m.caption, text: m.text.slice(0, 200), takenAt: m.takenAt, from: m.from })) } } : today);
    }

    // Phase 75 (stage 3): the Today page's weather tile. Read-only, from the place set for the morning
    // briefing (Open-Meteo, free, no key); nothing set up → { setUp: false } and the tile stays away.
    // Never on the demo. Cached for 15 minutes; a failed lookup says so instead of guessing.
    if (a === 'today' && b === 'weather' && !c && method === 'GET') {
      const cfg = briefingSettings(app);
      if (opts.demo || !cfg.place) return send(res, 200, { setUp: false });
      const units = cfg.units ?? defaultUnits(app.settings.get().timeZone);
      const key = `${cfg.place.lat},${cfg.place.lon},${units}`;
      if (!weatherCache || weatherCache.key !== key || Date.now() - weatherCache.at > WEATHER_MS) {
        try {
          weatherCache = { key, at: Date.now(), data: await todayWeather(cfg.place, units) };
        } catch {
          return send(res, 200, { setUp: true, place: cfg.place.name.split(',')[0], units, error: true });
        }
      }
      return send(res, 200, { setUp: true, ...weatherCache.data });
    }

    if (a === 'planner' && !b && method === 'GET') {
      const pl = needPlanner();
      return send(res, 200, { projects: pl.projects(true), tasks: pl.tasks({ status: 'all' }), reminders: pl.reminders({ status: 'pending' }), recentReminders: pl.reminders({ status: 'sent', limit: 20 }), places: pl.places(), timeZone: app.settings.get().timeZone ?? null });
    }
    if (a === 'tasks') {
      const pl = needPlanner();
      if (!b && method === 'POST') {
        const body = await readJson(req);
        const title = String(body.title ?? '').trim();
        if (!title || title.length > 300) throw new HttpError(400, 'Task title must be 1-300 characters');
        const t = pl.addTask({ title, project: body.project ? String(body.project) : null, notes: body.notes ? String(body.notes) : '', priority: validPriority(body.priority), dueAt: whenOrNull(body.due, 17) });
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 201, t);
      }
      const id = Number(b);
      if (b && method === 'PATCH') {
        const body = await readJson(req);
        const t = pl.updateTask(id, {
          ...(body.title !== undefined ? { title: String(body.title) } : {}),
          ...(body.project !== undefined ? { project: body.project ? String(body.project) : null } : {}),
          ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
          ...(body.priority !== undefined ? { priority: validPriority(body.priority) } : {}),
          ...(body.due !== undefined ? { dueAt: whenOrNull(body.due, 17) } : {}),
          ...(body.status !== undefined ? { status: body.status === 'done' ? 'done' : 'open' } : {}),
        });
        if (!t) throw new HttpError(404, 'Task not found');
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 200, t);
      }
      if (b && method === 'DELETE') {
        if (!pl.deleteTask(id)) throw new HttpError(404, 'Task not found');
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 200, { ok: true });
      }
    }
    if (a === 'projects' && !b) {
      const pl = needPlanner();
      if (method === 'GET') {
        const counts = new Map<number, number>();
        for (const c of app.store.listConversations()) if (c.projectId !== null) counts.set(c.projectId, (counts.get(c.projectId) ?? 0) + 1);
        return send(res, 200, pl.projects(true).map((p) => ({ ...projectView(p), conversations: counts.get(p.id) ?? 0 })));
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'Give the project a name.');
        let id: number;
        try {
          id = pl.projectId(name)!;
        } catch (err) {
          throw as400(err);
        }
        const p = pl.updateProject(id, { ...(body.workspace ? { workspace: validWorkspace(body.workspace) } : {}), status: 'active' });
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 201, p && projectView(p));
      }
    }
    if (a === 'projects' && b) {
      const pl = needPlanner();
      const id = Number(b);
      // Project page: everything that belongs to one project.
      if (method === 'GET' && !c) {
        const p = pl.projects(true).find((x) => x.id === id);
        if (!p) throw new HttpError(404, 'Project not found');
        // Phase 108 (CH2): ?limit= gives the newest sessions and how many more there are (See more pages
        // through GET /api/conversations?project=…); without it, every one (older apps).
        const lim = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? '');
        const page = lim > 0 ? app.store.conversationPage({ project: id, limit: lim }) : undefined;
        const roomMap = roomsByKey(app);
        const withRoom = (cv: Conversation) => {
          const chip = roomChip(roomOfConversation(app, cv, roomMap));
          return chip ? { ...cv, room: chip } : cv;
        };
        const conversations = (page ? page.conversations : app.store.listConversations().filter((cv) => cv.projectId === id)).map(withRoom);
        const tasks = pl.tasks({ status: 'all', projectId: id });
        const notes = pl.notes().filter((n) => n.projectId === id);
        let files: { path: string; size: number; modifiedAt: string }[] = [];
        let truncated = false;
        if (p.workspace) {
          try {
            ({ files, truncated } = listFiles(workspaceDir(rootDir, p.workspace), 300));
          } catch {
            files = [];
          }
        }
        return send(res, 200, { project: projectView(p), conversations, ...(page ? { more: page.more } : {}), tasks, notes, files, filesTruncated: truncated });
      }
      // Phase 108: Undo of the one-time filing: the chats it moved here (and still here) go back to No project.
      if (c === 'unfile' && method === 'POST') {
        const p = pl.projects(true).find((x) => x.id === id);
        if (!p) throw new HttpError(404, 'Project not found');
        const moved = unfileChannelChats(app, id);
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 200, { ok: true, moved });
      }
      if (method === 'PATCH' && !c) {
        const body = await readJson(req);
        const cur = pl.projects(true).find((x) => x.id === id);
        if (!cur) throw new HttpError(404, 'Project not found');
        // Phase 108 (CH2): a channel project takes a new name and Hide only (§5.3); it can't be
        // archived, because archiving would hide the new sessions the channel files into it.
        if (cur.builtin) {
          if (body.status === 'archived') throw new HttpError(409, "A channel project can't be archived. Hide it instead.");
          if (body.workspace || (body.description !== undefined && String(body.description) !== cur.description)) throw new HttpError(400, 'A channel project only takes a new name or Hide.');
        } else if (body.hidden !== undefined && Boolean(body.hidden) !== cur.hidden) throw new HttpError(400, 'Only channel projects can be hidden. Archive this one instead.');
        if (body.name !== undefined) {
          const name = String(body.name).trim().slice(0, 80);
          const clash = name && pl.projects(true).find((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
          if (clash) throw new HttpError(409, 'There is already a project called "{name}".', { params: { name } });
        }
        const p = pl.updateProject(id, {
          ...(body.workspace !== undefined && !cur.builtin ? { workspace: body.workspace ? validWorkspace(body.workspace) : null } : {}),
          ...(body.name !== undefined ? { name: String(body.name).slice(0, 80) } : {}),
          ...(body.description !== undefined && !cur.builtin ? { description: String(body.description).slice(0, 2000) } : {}),
          ...(body.status !== undefined ? { status: body.status === 'archived' ? 'archived' : 'active' } : {}),
          ...(body.hidden !== undefined && cur.builtin ? { hidden: Boolean(body.hidden) } : {}),
        });
        if (!p) throw new HttpError(404, 'Project not found');
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 200, projectView(p));
      }
      if (method === 'DELETE' && !c) {
        const cur = pl.projects(true).find((x) => x.id === id);
        if (!cur) throw new HttpError(404, 'Project not found');
        // Phase 108: not while its channel is on (new sessions would have nowhere to go).
        if (cur.builtin && channelOn(app, cur.builtin)) {
          const channel = channelName(app, cur.builtin);
          throw new HttpError(409, 'This project holds the {channel} chats. Turn {channel} off first, or hide it.', { params: { channel } });
        }
        // Its conversations and to-dos stay; they just lose the project.
        const moved = app.store.clearProject(id);
        if (!pl.deleteProject(id)) throw new HttpError(404, 'Project not found');
        app.events?.publish({ type: 'planner', what: 'tasks' });
        return send(res, 200, { ok: true, moved });
      }
    }
    // Phase 29: saved places and place reminders. The phone watches the places and reports only
    // "arrived at / left place N", never where it is.
    if (a === 'places') {
      const pl = needPlanner();
      if (!b && method === 'GET') return send(res, 200, { places: pl.places() });
      if (b === 'watch' && method === 'GET') return send(res, 200, { places: pl.watchedPlaces().map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius, events: p.events })) });
      if (!b && method === 'POST') {
        const body = await readJson(req);
        let place;
        try {
          place = pl.savePlace({ name: String(body.name ?? ''), lat: Number(body.lat), lon: Number(body.lon), radius: body.radius === undefined ? undefined : Number(body.radius) });
        } catch (err) {
          throw as400(err);
        }
        app.events?.publish({ type: 'planner', what: 'reminders' });
        return send(res, 201, place);
      }
      if (b === 'lookup' && method === 'POST') {
        // An address typed by the owner, looked up on OpenStreetMap (only when they ask).
        const body = await readJson(req);
        const q = String(body.address ?? '').trim();
        if (!q || q.length > 200) throw new HttpError(400, 'Type an address or place name (up to 200 characters).');
        const r = await netFetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: 'jsonv2', limit: '5', q })}`, { headers: { 'user-agent': 'Sara self-hosted companion (place reminders)', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
        if (!r?.ok) throw new HttpError(502, 'Could not reach OpenStreetMap to look that up. Try again, or save the place from the phone app.');
        const found = ((await r.json()) as { display_name?: string; lat?: string; lon?: string }[]).map((x) => ({ label: String(x.display_name ?? '').slice(0, 160), lat: Number(x.lat), lon: Number(x.lon) })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
        return send(res, 200, { found });
      }
      const id = Number(b);
      if (b && Number.isInteger(id) && !c && method === 'DELETE') {
        if (!pl.deletePlace(id)) throw new HttpError(404, 'No such place.');
        app.events?.publish({ type: 'planner', what: 'reminders' });
        return send(res, 200, { ok: true });
      }
      if (b && Number.isInteger(id) && c === 'event' && method === 'POST') {
        const body = await readJson(req);
        const event = body.event === 'leave' ? 'leave' : 'arrive';
        if (!pl.place(id)) throw new HttpError(404, 'No such place.');
        const delivered = (app.reminders ?? new ReminderScheduler(app, pl)).atPlace(id, event);
        return send(res, 200, { delivered });
      }
    }
    if (a === 'reminders') {
      const pl = needPlanner();
      if (!b && method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text ?? '').trim();
        if (!text || text.length > 500) throw new HttpError(400, 'Reminder text must be 1-500 characters');
        const byPlace = body.placeId !== undefined && body.placeId !== null && body.placeId !== '';
        const due = byPlace ? PLACE_DUE : whenOrNull(body.when);
        if (!due) throw new HttpError(400, 'When should the reminder go off?');
        const repeat = String(body.repeat ?? 'none') as Repeat;
        if (!REPEATS.includes(repeat)) throw new HttpError(400, 'repeat must be one of {list}', { params: { list: REPEATS.join(', ') } });
        const convId = body.conversationId ? String(body.conversationId) : null;
        const placeId = body.placeId === undefined || body.placeId === null || body.placeId === '' ? undefined : Number(body.placeId);
        if (placeId !== undefined && !pl.place(placeId)) throw new HttpError(400, 'That place no longer exists.');
        const r = pl.addReminder({ text, dueAt: due, repeat, conversationId: convId && app.store.getConversation(convId) ? convId : null, call: body.call === true, ...(placeId !== undefined ? { place: { id: placeId, event: body.placeEvent === 'leave' ? 'leave' : 'arrive' } } : {}) });
        app.events?.publish({ type: 'planner', what: 'reminders' });
        return send(res, 201, r);
      }
      if (b && method === 'DELETE') {
        if (!pl.cancelReminder(Number(b))) throw new HttpError(404, 'No upcoming reminder with that id');
        app.events?.publish({ type: 'planner', what: 'reminders' });
        return send(res, 200, { ok: true });
      }
    }
    if (a === 'notes') {
      const pl = needPlanner();
      if (!b && method === 'GET') return send(res, 200, pl.notes(new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? undefined));
      if ((!b && method === 'POST') || (b && method === 'PATCH')) {
        const body = await readJson(req);
        const text = String(body.body ?? '');
        if (!text.trim() || text.length > 50_000) throw new HttpError(400, 'Note must be 1-50,000 characters');
        const title = String(body.title ?? '').trim().slice(0, 120) || text.split('\n')[0].slice(0, 120);
        if (b && !pl.note(Number(b))) throw new HttpError(404, 'Note not found');
        const n = pl.saveNote({ ...(b ? { id: Number(b) } : {}), title, body: text, ...(body.project !== undefined ? { project: body.project ? String(body.project) : null } : {}) });
        app.events?.publish({ type: 'planner', what: 'notes' });
        return send(res, b ? 200 : 201, n);
      }
      if (b && method === 'DELETE') {
        if (!pl.deleteNote(Number(b))) throw new HttpError(404, 'Note not found');
        app.events?.publish({ type: 'planner', what: 'notes' });
        return send(res, 200, { ok: true });
      }
    }
    // Phase 22: weekly review.
    // Phase 53: your story together: the merged timeline, look backs she wrote, write a new one.
    if (a === 'story') {
      const dateOk = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) ? x : undefined);
      if (!b && method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        const filter = STORY_FILTERS.includes(q.get('filter') as StoryFilter) ? (q.get('filter') as StoryFilter) : 'all';
        const first = app.store.firstOwnerMessageAt();
        return send(res, 200, {
          items: gatherStory(app, { filter, from: dateOk(q.get('from')), to: dateOk(q.get('to')) }),
          lookbacks: lookbacks(app),
          running: Boolean(app.story?.pending),
          error: app.story?.lastError ?? null,
          firstDay: first ? localDate(first.toISOString(), app.settings.get().timeZone) : null,
          today: localDate(app.now().toISOString(), app.settings.get().timeZone),
          yearly: app.settings.get().story?.yearly === true,
        });
      }
      if (b === 'lookback' && !c && method === 'POST') {
        const body = await readJson(req);
        const from = dateOk(body.from);
        const to = dateOk(body.to);
        if (!from || !to || from > to) throw new HttpError(400, 'Pick a start and an end date (start first).');
        if (!app.story) throw new HttpError(404, 'Look backs are not available on this server.');
        void app.story.request({ from, to }).catch((err: Error) => console.warn(`look back failed: ${err.message}`));
        return send(res, 202, { running: true });
      }
      if (b === 'lookback' && c && method === 'DELETE') {
        const m = app.memory?.get(Number(c));
        if (!m || m.kind !== 'reflection' || !m.evidence?.startsWith('lookback:')) throw new HttpError(404, 'Look back not found');
        app.memory!.delete(m.id);
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'review') {
      const view = () => {
        const { lastDay, ...cfg } = reviewSettings(app);
        return { ...cfg, lastDay: lastDay ?? null };
      };
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const next = { ...reviewSettings(app) };
        if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
        if (body.day !== undefined) {
          const d = Number(body.day);
          if (!Number.isInteger(d) || d < 0 || d > 6) throw new HttpError(400, 'Pick a day of the week.');
          next.day = d;
        }
        if (body.time !== undefined) {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) throw new HttpError(400, 'Time must look like 18:00.');
          next.time = String(body.time);
        }
        app.settings.update({ weeklyReview: next });
        return send(res, 200, await view());
      }
      if (b === 'now' && method === 'POST') {
        if (!app.review) throw new HttpError(404, 'Not available');
        if (opts.demo) throw new HttpError(403, 'Not in the demo.');
        return send(res, 200, await app.review.send());
      }
    }
    // Phase 20: leave-by reminders.
    if (a === 'leave-by') {
      const view = () => {
        const { sent: _sent, ...cfg } = leaveBySettings(app);
        return { ...cfg, calendar: Boolean(app.google?.status().calendar) };
      };
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const next = { ...leaveBySettings(app) };
        if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
        if (body.mode !== undefined) next.mode = body.mode === 'bike' ? 'bike' : body.mode === 'foot' ? 'foot' : 'car';
        if (body.bufferMin !== undefined) next.bufferMin = Math.min(60, Math.max(0, Math.round(Number(body.bufferMin) || 0)));
        if (body.home !== undefined) {
          const q = String(body.home ?? '').trim();
          if (!q) delete next.home;
          else if (q !== next.home?.label) {
            const place = await findAddress(q).catch((err: Error) => {
              throw new HttpError(502, 'Couldn\'t look up that address: {error}', { params: { error: err.message } });
            });
            if (!place) throw new HttpError(400, "Couldn't find that address. Try the street, number and town.");
            next.home = place;
          }
        }
        if (next.enabled && !next.home) throw new HttpError(400, 'Add your home address first.');
        app.settings.update({ leaveBy: next });
        return send(res, 200, await view());
      }
    }
    if (a === 'briefing') {
      const tz = app.settings.get().timeZone;
      const view = () => {
        const cfg = briefingSettings(app);
        return { ...cfg, units: cfg.units ?? defaultUnits(tz) };
      };
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const cur = briefingSettings(app);
        const next = { ...cur };
        let timeChanged = false;
        if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
        if (body.time !== undefined) {
          const t = String(body.time);
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, 'Time must look like 07:30.');
          if (t !== cur.time) {
            delete next.lastDay;
            timeChanged = true;
          }
          next.time = t;
        }
        if (body.units !== undefined) next.units = body.units === 'C' ? 'C' : 'F';
        if (body.place !== undefined) {
          const name = String(body.place ?? '').trim();
          if (!name) delete next.place;
          else if (name !== cur.place?.name) {
            try {
              next.place = await geocode(name);
            } catch (err) {
              throw as400(err);
            }
          }
        }
        // Merge onto the settings as they are NOW: the place lookup above can take seconds, and a
        // briefing sent meanwhile writes its "sent today" mark, which a stale copy would wipe.
        const fresh = briefingSettings(app);
        const merged = { ...fresh, enabled: next.enabled, time: next.time, ...(next.units ? { units: next.units } : {}) };
        if (next.place) merged.place = next.place;
        else delete merged.place;
        if (timeChanged) delete merged.lastDay;
        app.settings.update({ briefing: merged });
        return send(res, 200, await view());
      }
      if (b === 'send' && method === 'POST') {
        if (!app.briefing) throw new HttpError(400, 'Briefings are not available.');
        try {
          return send(res, 200, { text: await app.briefing.send() });
        } catch (err) {
          throw new HttpError(502, (err as Error).message);
        }
      }
    }
    return NEXT;
  };
}
