// Phase 20: leave-by reminders. For today's Google Calendar events that have a street address,
// Sara works out the travel time from home (OpenStreetMap: Nominatim to find the address, the
// public OSRM routers for the time, both free, no key) and texts the owner when it's time to go:
// travel time + a buffer before the start. Online meetings and events without an address are
// skipped. Travel times don't include traffic, so the buffer matters.
import { netFetch } from './net-guard.ts';
import type { AppContext } from './chat.ts';
import { appLanguage } from './i18n.ts';
import { targetConversation } from './life.ts';
import { localDate } from './memory-worker.ts';
import { disclosureDue, disclosureText } from './safety.ts';

export type TravelMode = 'car' | 'bike' | 'foot';
export interface LeaveBySettings {
  enabled: boolean;
  home?: { label: string; lat: number; lon: number };
  mode: TravelMode;
  /** Extra minutes before the start (parking, traffic, finding the door). */
  bufferMin: number;
  /** Events already reminded about today. */
  sent?: { day: string; ids: string[] };
}
export const DEFAULT_LEAVE_BY: LeaveBySettings = { enabled: false, mode: 'car', bufferMin: 10 };
const ONLINE = /https?:\/\/|\bzoom\b|meet\.google|teams\.microsoft|\bteams\b|webex|\bonline\b|\bvirtual\b|\bphone\b|\bcall\b|^\s*$/i;
const UA = 'Sara/1 (self-hosted AI companion; leave-by reminders)';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface Place {
  label: string;
  lat: number;
  lon: number;
}

export function leaveBySettings(app: AppContext): LeaveBySettings {
  return { ...DEFAULT_LEAVE_BY, ...app.settings.get().leaveBy };
}

/** Finds a street address (OpenStreetMap Nominatim; at most one lookup a second, per their rules). */
let lastLookup = 0;
export async function findAddress(q: string, fetchImpl: FetchLike = netFetch): Promise<Place | undefined> {
  const wait = lastLookup + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLookup = Date.now();
  const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '1' })}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`address lookup failed (HTTP ${res.status})`);
  const r = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  return r[0] ? { label: r[0].display_name, lat: Number(r[0].lat), lon: Number(r[0].lon) } : undefined;
}

/** Travel minutes between two places (no traffic). */
export async function travelMinutes(from: Place, to: Place, mode: TravelMode, fetchImpl: FetchLike = netFetch): Promise<number | undefined> {
  const res = await fetchImpl(`https://routing.openstreetmap.de/routed-${mode}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`route lookup failed (HTTP ${res.status})`);
  const r = (await res.json()) as { code?: string; routes?: { duration: number }[] };
  const s = r.routes?.[0]?.duration;
  return r.code === 'Ok' && s !== undefined ? Math.max(1, Math.round(s / 60)) : undefined;
}

interface CalItem {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string };
  status?: string;
}

export class LeaveByWorker {
  readonly #app: AppContext;
  readonly #fetch: FetchLike;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  /** Address → place (or null when it couldn't be found), for the life of the process. */
  readonly #places = new Map<string, Place | null>();
  /** Event id → travel minutes, refreshed when the location changes. */
  readonly #routes = new Map<string, { location: string; minutes: number | null }>();

  constructor(app: AppContext, fetchImpl: FetchLike = netFetch) {
    this.#app = app;
    this.#fetch = fetchImpl;
  }

  start(intervalMs = 3 * 60_000): void {
    this.#timer = setInterval(() => void this.tick().catch((err: Error) => console.warn(`leave-by: ${err.message}`)), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /**
   * Phase 111 (TD1, §4.1): today's leave-by times for Today's timeline, from the same address and
   * route caches the reminders use (no new hosts; nothing when leave-by is off or has no home).
   */
  async planFor(events: { id: string; start: string; allDay: boolean; location?: string }[]): Promise<{ eventId: string; leaveAt: string; minutes: number; mode: TravelMode }[]> {
    const cfg = leaveBySettings(this.#app);
    if (!cfg.enabled || !cfg.home) return [];
    const now = this.#app.now().getTime();
    const out: { eventId: string; leaveAt: string; minutes: number; mode: TravelMode }[] = [];
    for (const e of events.slice(0, 8)) {
      const loc = e.location?.trim() ?? '';
      if (e.allDay || !loc || ONLINE.test(loc)) continue;
      const start = Date.parse(e.start);
      if (!Number.isFinite(start) || start < now) continue;
      let route = this.#routes.get(e.id);
      if (!route || route.location !== loc) {
        let place = this.#places.get(loc);
        if (place === undefined) {
          place = (await findAddress(loc, this.#fetch).catch(() => undefined)) ?? null;
          this.#places.set(loc, place);
        }
        const minutes = place ? ((await travelMinutes(cfg.home, place, cfg.mode, this.#fetch).catch(() => undefined)) ?? null) : null;
        route = { location: loc, minutes };
        this.#routes.set(e.id, route);
      }
      if (route.minutes === null || route.minutes < 3) continue;
      out.push({ eventId: e.id, leaveAt: new Date(start - (route.minutes + cfg.bufferMin) * 60_000).toISOString(), minutes: route.minutes, mode: cfg.mode });
    }
    return out;
  }

  /** Checks the next few hours of the calendar; sends any reminder that is due. Returns what was sent. */
  async tick(): Promise<string[]> {
    const app = this.#app;
    const cfg = leaveBySettings(app);
    if (!cfg.enabled || !cfg.home || this.#running || !app.google?.status().calendar) return [];
    this.#running = true;
    try {
      const now = app.now();
      const tz = app.settings.get().timeZone;
      const day = localDate(now.toISOString(), tz);
      const sentIds = cfg.sent?.day === day ? cfg.sent.ids : [];
      const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 4 * 3600_000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '20' });
      const r = (await app.google.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { signal: AbortSignal.timeout(15_000) })) as { items?: CalItem[] };
      const out: string[] = [];
      for (const e of r.items ?? []) {
        const loc = e.location?.trim() ?? '';
        if (!e.start?.dateTime || e.status === 'cancelled' || sentIds.includes(e.id) || ONLINE.test(loc)) continue;
        const start = Date.parse(e.start.dateTime);
        if (start <= now.getTime()) continue;
        let route = this.#routes.get(e.id);
        if (!route || route.location !== loc) {
          let place = this.#places.get(loc);
          if (place === undefined) {
            place = (await findAddress(loc, this.#fetch).catch(() => undefined)) ?? null;
            this.#places.set(loc, place);
          }
          const minutes = place ? ((await travelMinutes(cfg.home, place, cfg.mode, this.#fetch).catch(() => undefined)) ?? null) : null;
          route = { location: loc, minutes };
          this.#routes.set(e.id, route);
        }
        if (route.minutes === null || route.minutes < 3) continue; // not found, or basically next door
        const leaveAt = start - (route.minutes + cfg.bufferMin) * 60_000;
        if (now.getTime() < leaveAt - 60_000) continue;
        const text = this.#message(e, start, route.minutes, cfg, tz, now.getTime() > leaveAt + 5 * 60_000);
        this.#deliver(text, e.id);
        sentIds.push(e.id);
        app.settings.update({ leaveBy: { ...leaveBySettings(app), sent: { day, ids: [...sentIds] } } });
        out.push(text);
      }
      return out;
    } finally {
      this.#running = false;
    }
  }

  #message(e: CalItem, start: number, minutes: number, cfg: LeaveBySettings, tz: string | undefined, late: boolean): string {
    const at = new Date(start).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const how = cfg.mode === 'car' ? 'drive' : cfg.mode === 'bike' ? 'bike ride' : 'walk';
    const icon = cfg.mode === 'car' ? '🚗' : cfg.mode === 'bike' ? '🚲' : '🚶';
    const title = (e.summary ?? 'your event').slice(0, 120);
    return `${icon} ${late ? 'Leave now' : 'Time to leave'} for “${title}” at ${at}: it's about a ${minutes}-minute ${how} to ${(e.location ?? '').split(',')[0].slice(0, 120)}${cfg.mode === 'car' ? ' without traffic' : ''}.`;
  }

  #deliver(text: string, eventId: string): void {
    const app = this.#app;
    const now = app.now();
    const conv = targetConversation(app) ?? app.store.listConversations().find((c) => !c.partner) ?? app.store.createConversation({ title: 'Reminders' });
    if (disclosureDue(app.store.lastDisclosureAt(), now)) {
      const n = app.store.addMessage(conv.id, 'notice', `disclosure:${disclosureText(app.persona.name, appLanguage(app.settings.get()))}`);
      app.events?.publish({ type: 'message', conversationId: conv.id, message: { ...n, content: disclosureText(app.persona.name, appLanguage(app.settings.get())), meta: { kind: 'disclosure' } }, reason: 'proactive' });
    }
    const msg = app.store.addMessage(conv.id, 'assistant', text, { reminder: true, leaveBy: { eventId } });
    app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'reminder' });
  }
}
