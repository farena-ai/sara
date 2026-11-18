// S6 (docs/TRAVEL.md): the travel assistant. Booking emails the inbox helper reads (flights, hotels,
// rental cars, trains, event tickets; src/inbox/classify.ts) become trips: one timeline per trip,
// deduped across mailboxes (the same flight forwarded to a second mailbox is one booking), each time
// with its own time zone (a plain-text itinerary's wall time is read in its airport's zone).
//
// - Rides the reminder tick (no timer): check-in 24 hours before a flight, a leave-by alert through the
//   existing leave-by engine (src/leaveby.ts planFor: home -> airport), and flight status from a
//   source the person turns on (none by default; the AirLabs slot needs their own free key). Delays,
//   gate changes, diversions and cancellations go to the phone; a cancellation or a long delay lists
//   rebooking options (the airline's site, next flights when the source knows them). She never books,
//   changes or pays for anything.
// - Add to calendar and the packing list (a shared list) happen only on the person's tap.
// - Each space has its own tables (a household member's trips stay theirs); private local mode makes no
//   status or forecast requests and sends nothing to the phone. Email text is data, never instructions.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { en, trOwner } from './i18n.ts';
import { senderName, type Finding, type InboxMail } from './inbox/classify.ts';
import { quietNow } from './life.ts';
import { netFetch, privateLocalOn } from './net-guard.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import type { ToolContext } from './tools/types.ts';
import { airlineLink, airportOf } from './travel-places.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type BookingKind = 'flight' | 'hotel' | 'car' | 'train' | 'event';
export const TRAVEL = { joinHours: 36, statusAheadH: 36, checkinH: 24, pollFarMin: 30, pollNearMin: 10, pollsPerTick: 3, urgentH: 6, leaveAheadH: 8, delayAlertMin: 15, rebookDelayMin: 120, forecastDays: 16 } as const;

export interface FlightStatus {
  state: 'scheduled' | 'active' | 'landed' | 'cancelled' | 'diverted' | 'unknown';
  depDelayMin?: number;
  /** Estimated departure: ISO with an offset, or the airport's local wall time. */
  depEstimated?: string;
  depGate?: string;
  depTerminal?: string;
  arrGate?: string;
  /** U3.14: where the plane is (OpenSky: live position, no gate or delay). */
  position?: { lat: number; lon: number; altM?: number; onGround: boolean };
  /** What this source cannot tell (shown next to its status). */
  limits?: string;
  source: string;
  at: string;
}
/** What a source may need besides the flight number: the booking's airports and times (ISO instants). */
export interface FlightContext {
  from?: string;
  to?: string;
  departsAt?: string;
  arrivesAt?: string | null;
}
export interface NextFlight {
  flight: string;
  from: string;
  to: string;
  departs: string;
}
/** A flight status source (free only; the person's own key when it needs one). */
export interface FlightStatusSource {
  id: string;
  label: string;
  status(flight: string, date: string, signal?: AbortSignal, ctx?: FlightContext): Promise<FlightStatus | undefined>;
  nextFlights?(from: string, to: string, after: Date, signal?: AbortSignal): Promise<NextFlight[]>;
}
export interface Forecast {
  hiC: number;
  loC: number;
  rainPct: number;
  snow: boolean;
}
export interface TravelSettings {
  provider: 'off' | 'airlabs' | 'opensky';
  alerts: boolean;
  checkin: boolean;
  leaveBy: boolean;
  hasKey: boolean;
}
export interface TravelOptions {
  /** Tests: the status source (default: the provider in settings, off). */
  source?: FlightStatusSource;
  fetch?: FetchLike;
  weather?: (place: { name: string; lat: number; lon: number }, from: string, to: string) => Promise<Forecast | undefined>;
  notify?: (title: string, body: string, conversationId: string, tag: string) => Promise<void>;
  quiet?: () => boolean;
}
export interface RebookOption {
  label: string;
  url?: string;
  flight?: string;
  departs?: string;
}
export interface BookingView {
  id: number;
  tripId: number;
  kind: BookingKind;
  title: string;
  number?: string;
  airline?: string;
  confirmation?: string;
  from?: string;
  to?: string;
  place?: string;
  /** As written in the mail (wall time or ISO with an offset). */
  start: string;
  end?: string;
  tz: string;
  startsAt: string;
  endsAt: string | null;
  /** "Fri, Nov 20, 8:05 AM CST" in the booking's own zone. */
  when: string;
  accounts: string[];
  status?: FlightStatus;
  rebook?: RebookOption[];
  inCalendar: boolean;
  link?: string;
}
export interface TripView {
  id: number;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  dates: string;
  bookings: BookingView[];
  packing: { boardId?: string; project?: string; name: string; items: string[] } | null;
}

interface BookingData {
  title: string;
  number?: string;
  airline?: string;
  confirmation?: string;
  from?: string;
  to?: string;
  place?: string;
  start: string;
  end?: string;
  tz?: string;
  endTz?: string;
}
interface Sent {
  checkin?: boolean;
  leave?: boolean;
  rebook?: RebookOption[];
}
type Row = Record<string, unknown>;

export class TravelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const HOUR = 3600_000;
const OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** A booking's instant: an ISO time with an offset as is; a wall time in its zone (date only: a default hour). */
export function instantOf(s: string, tz: string | undefined, hour = 12): Date | undefined {
  if (OFFSET.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return undefined;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? hour), Number(m[5] ?? 0), tz);
}
export function fmtWhen(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
const fmtTime = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
const fmtDay = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
const localDay = (d: Date, tz: string | undefined) => {
  const p = zonedParts(d, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};
const wallIn = (d: Date, tz: string | undefined) => {
  const p = zonedParts(d, tz);
  return `${localDay(d, tz)}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};
/** "1200 Larimer St, Denver, CO, 80202" -> "Denver". */
const cityOf = (address: string | undefined): string | undefined => {
  const parts = (address ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[1] : parts.length === 2 && !/\d/.test(parts[0]!) ? parts[0] : undefined;
};
const iataIn = (s: string | undefined) => /\(([A-Z]{3})\)/.exec(s ?? '')?.[1] ?? (/^[A-Z]{3}$/.test(s ?? '') ? s : undefined);

/** AirLabs (free key, airlabs.co): flight status and schedules. Off until the person saves a key. */
export function airlabsSource(key: string, fetchImpl: FetchLike = netFetch): FlightStatusSource {
  const get = async (path: string, q: Record<string, string>, signal?: AbortSignal) => {
    const res = await fetchImpl(`https://airlabs.co/api/v9/${path}?${new URLSearchParams({ ...q, api_key: key })}`, { signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`AirLabs HTTP ${res.status}`);
    const j = (await res.json()) as { response?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`AirLabs: ${clip(j.error.message, 120)}`);
    return j.response;
  };
  const wall = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T').slice(0, 16) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? clip(v, 10) : undefined);
  return {
    id: 'airlabs',
    label: 'AirLabs',
    async status(flight, date, signal) {
      const r = (await get('flight', { flight_iata: flight }, signal)) as Record<string, unknown> | undefined;
      if (!r || typeof r !== 'object') return undefined;
      // Its answer is the flight's current or next run: another day's is not this booking's.
      if (typeof r.dep_time === 'string' && r.dep_time.slice(0, 10) !== date) return undefined;
      const st = String(r.status ?? '').toLowerCase();
      const state: FlightStatus['state'] = st === 'scheduled' ? 'scheduled' : st === 'en-route' || st === 'active' ? 'active' : st === 'landed' ? 'landed' : st === 'cancelled' ? 'cancelled' : st === 'diverted' ? 'diverted' : 'unknown';
      const delay = num(r.dep_delayed) ?? num(r.delayed);
      return { state, ...(delay !== undefined ? { depDelayMin: delay } : {}), ...(wall(r.dep_estimated) ? { depEstimated: wall(r.dep_estimated) } : {}), ...(str(r.dep_gate) ? { depGate: str(r.dep_gate) } : {}), ...(str(r.dep_terminal) ? { depTerminal: str(r.dep_terminal) } : {}), ...(str(r.arr_gate) ? { arrGate: str(r.arr_gate) } : {}), source: 'AirLabs', at: new Date().toISOString() };
    },
    async nextFlights(from, to, after, signal) {
      const rows = (await get('schedules', { dep_iata: from, arr_iata: to }, signal)) as Record<string, unknown>[] | undefined;
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => String(r.status ?? '') !== 'cancelled' && typeof r.flight_iata === 'string' && Date.parse(String(r.dep_time_utc ?? '').replace(' ', 'T') + 'Z') > after.getTime())
        .slice(0, 3)
        .map((r) => ({ flight: String(r.flight_iata), from, to, departs: wall(r.dep_time) ?? '' }));
    },
  };
}

// ------------------------------------------------------------ U3.14: OpenSky Network (free, no key)

/** Airline IATA code → ICAO callsign prefix (OpenSky knows flights by callsign: LH400 → DLH400). */
export const AIRLINE_ICAO: Record<string, string> = {
  AA: 'AAL', UA: 'UAL', DL: 'DAL', WN: 'SWA', B6: 'JBU', AS: 'ASA', NK: 'NKS', F9: 'FFT', HA: 'HAL', G4: 'AAY', SY: 'SCX', AC: 'ACA', WS: 'WJA', PD: 'POE', AM: 'AMX', Y4: 'VOI', VB: 'VIV',
  BA: 'BAW', VS: 'VIR', EI: 'EIN', U2: 'EZY', FR: 'RYR', W6: 'WZZ', LS: 'EXS', LH: 'DLH', EW: 'EWG', DE: 'CFG', LX: 'SWR', OS: 'AUA', SN: 'BEL', AF: 'AFR', KL: 'KLM', HV: 'TRA', TO: 'TVF',
  IB: 'IBE', UX: 'AEA', VY: 'VLG', I2: 'IBS', TP: 'TAP', AZ: 'ITY', SK: 'SAS', AY: 'FIN', DY: 'NOZ', D8: 'IBK', LO: 'LOT', OK: 'CSA', A3: 'AEE', TK: 'THY', PC: 'PGT', LG: 'LGL',
  EK: 'UAE', QR: 'QTR', EY: 'ETD', SV: 'SVA', MS: 'MSR', RJ: 'RJA', ET: 'ETH', KQ: 'KQA', SA: 'SAA', AT: 'RAM', AI: 'AIC', '6E': 'IGO',
  LA: 'LAN', JJ: 'TAM', G3: 'GLO', AD: 'AZU', AV: 'AVA', CM: 'CMP', AR: 'ARG', H2: 'SKU',
  QF: 'QFA', VA: 'VOZ', NZ: 'ANZ', SQ: 'SIA', CX: 'CPA', JL: 'JAL', NH: 'ANA', KE: 'KAL', OZ: 'AAR', CI: 'CAL', BR: 'EVA', TG: 'THA', MH: 'MAS', GA: 'GIA', PR: 'PAL', CA: 'CCA', MU: 'CES', CZ: 'CSN',
};
/** "LH 0400" → "DLH400"; undefined when the airline is not in the list. */
export function callsignOf(flight: string): string | undefined {
  const m = /^\s*([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*0*(\d{1,4})\s*$/i.exec(flight);
  const icao = m ? AIRLINE_ICAO[m[1]!.toUpperCase()] : undefined;
  return icao ? `${icao}${m![2]}` : undefined;
}
export const OPENSKY_LIMITS = 'OpenSky Network shows only whether the plane is in the air or on the ground, from public ADS-B receivers: no gate, delay or cancellation, and not every flight is covered.';

/**
 * OpenSky Network (opensky-network.org): free live aircraft positions, anonymous (no sign-up, no
 * key), for personal and non-profit use (its FAQ; commercial use needs their consent). 400 credits a
 * day per address: one call costs 1-4 by area, so it is asked only from an hour before departure
 * until an hour after arrival, for a box around the two airports.
 */
export function openskySource(fetchImpl: FetchLike = netFetch, now: () => Date = () => new Date()): FlightStatusSource {
  return {
    id: 'opensky',
    label: 'OpenSky Network',
    async status(flight, _date, signal, ctx) {
      const callsign = callsignOf(flight);
      const dep = ctx?.departsAt ? Date.parse(ctx.departsAt) : NaN;
      if (!callsign || Number.isNaN(dep)) return undefined;
      const arr = ctx?.arrivesAt ? Date.parse(ctx.arrivesAt) : dep + 14 * HOUR;
      const t = now().getTime();
      if (t < dep - HOUR || t > arr + HOUR) return undefined;
      const a = airportOf(ctx?.from);
      const b = airportOf(ctx?.to);
      const q = new URLSearchParams();
      const pts = [a, b].filter((x): x is NonNullable<typeof a> => Boolean(x));
      // A box around both airports (fewer credits); none across the date line or without airports.
      if (pts.length && Math.max(...pts.map((p) => p.lon)) - Math.min(...pts.map((p) => p.lon)) < 180) {
        const pad = pts.length === 1 ? 5 : 2;
        q.set('lamin', String(Math.max(-90, Math.min(...pts.map((p) => p.lat)) - pad)));
        q.set('lomin', String(Math.max(-180, Math.min(...pts.map((p) => p.lon)) - pad)));
        q.set('lamax', String(Math.min(90, Math.max(...pts.map((p) => p.lat)) + pad)));
        q.set('lomax', String(Math.min(180, Math.max(...pts.map((p) => p.lon)) + pad)));
      }
      const res = await fetchImpl(`https://opensky-network.org/api/states/all${q.size ? `?${q}` : ''}`, { signal: signal ?? AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
      const j = (await res.json()) as { states?: unknown[][] | null };
      const row = (j.states ?? []).find((s) => Array.isArray(s) && String(s[1] ?? '').trim().toUpperCase() === callsign);
      if (!row) return undefined;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const lon = num(row[5]);
      const lat = num(row[6]);
      if (lat === undefined || lon === undefined) return undefined;
      const onGround = row[8] === true;
      const alt = num(row[13]) ?? num(row[7]);
      const nearDest = b ? Math.hypot(b.lat - lat, b.lon - lon) < 0.5 : false;
      const state: FlightStatus['state'] = !onGround ? 'active' : nearDest && t > dep + 30 * 60_000 ? 'landed' : 'scheduled';
      return { state, position: { lat, lon, ...(alt !== undefined && !onGround ? { altM: Math.round(alt) } : {}), onGround }, limits: OPENSKY_LIMITS, source: 'OpenSky Network', at: new Date(t).toISOString() };
    },
  };
}

/** Today's-or-later forecast for the trip's days (Open-Meteo, free, no key; the briefing's weather source). */
async function openMeteo(place: { lat: number; lon: number }, from: string, to: string, fetchImpl: FetchLike): Promise<Forecast | undefined> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum&timezone=auto&start_date=${from}&end_date=${to}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return undefined;
  const d = (await res.json()) as { daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[]; snowfall_sum?: number[] } };
  const hi = d.daily?.temperature_2m_max ?? [];
  const lo = d.daily?.temperature_2m_min ?? [];
  if (!hi.length || !lo.length) return undefined;
  return { hiC: Math.max(...hi), loC: Math.min(...lo), rainPct: Math.max(0, ...(d.daily?.precipitation_probability_max ?? [])), snow: (d.daily?.snowfall_sum ?? []).some((x) => x > 0) };
}

export class Travel {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: TravelOptions;
  #running: Promise<unknown> | undefined;

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: TravelOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`
CREATE TABLE IF NOT EXISTS travel_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS travel_trips (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, custom_title INTEGER NOT NULL DEFAULT 0, starts_at TEXT, ends_at TEXT, packing_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS travel_bookings (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data_json TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
  accounts_json TEXT NOT NULL DEFAULT '[]', mail_date TEXT, status_json TEXT, checked_at TEXT, sent_json TEXT NOT NULL DEFAULT '{}', event_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS travel_bookings_trip ON travel_bookings(trip_id);`);
  }

  #now(): Date {
    return this.#app.now();
  }
  #tz(): string {
    return this.#app.settings.get().timeZone || 'UTC';
  }
  #T(s: string, p?: Record<string, unknown>): string {
    return trOwner(s, this.#app.settings.get(), p);
  }
  #get(key: string): unknown {
    const r = this.#db.prepare('SELECT value FROM travel_kv WHERE key = ?').get(key) as { value: string } | undefined;
    try {
      return r ? JSON.parse(r.value) : undefined;
    } catch {
      return undefined;
    }
  }
  #put(key: string, v: unknown): void {
    this.#db.prepare('INSERT INTO travel_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v));
  }

  // ------------------------------------------------------------ settings

  settings(): TravelSettings {
    const s = (this.#get('settings') ?? {}) as Partial<TravelSettings>;
    return { provider: s.provider === 'airlabs' || s.provider === 'opensky' ? s.provider : 'off', alerts: s.alerts !== false, checkin: s.checkin !== false, leaveBy: s.leaveBy !== false, hasKey: Boolean(this.#app.vault?.get('data:airlabs')) };
  }
  setSettings(patch: Record<string, unknown>): TravelSettings {
    const cur = this.settings();
    const next = { provider: cur.provider, alerts: cur.alerts, checkin: cur.checkin, leaveBy: cur.leaveBy };
    if (patch.provider === 'off' || patch.provider === 'airlabs' || patch.provider === 'opensky') next.provider = patch.provider;
    for (const k of ['alerts', 'checkin', 'leaveBy'] as const) if (typeof patch[k] === 'boolean') next[k] = patch[k] as boolean;
    if (typeof patch.key === 'string') {
      const k = patch.key.trim();
      if (!k) this.#app.vault.delete('data:airlabs');
      else if (/^[\x21-\x7e]{8,200}$/.test(k)) this.#app.vault.set('data:airlabs', k);
      else throw new TravelError(400, en('That key doesn’t look right.'));
    }
    this.#put('settings', next);
    return this.settings();
  }
  #source(): FlightStatusSource | undefined {
    if (this.#o.source) return this.#o.source;
    if (this.settings().provider === 'opensky') return openskySource(this.#o.fetch ?? netFetch);
    const key = this.settings().provider === 'airlabs' ? this.#app.vault?.get('data:airlabs') : undefined;
    return key ? airlabsSource(key, this.#o.fetch ?? netFetch) : undefined;
  }

  // ------------------------------------------------------------ from the inbox

  /** New mail's findings (from the inbox helper): bookings into trips. Returns how many changed. */
  observe(m: InboxMail, findings: Finding[]): number {
    let n = 0;
    const airline = senderName(m.from);
    for (const f of findings) {
      const conf = f.confirmation ? clip(f.confirmation, 20) : undefined;
      if (f.kind === 'trip') {
        for (const fl of f.flights ?? []) {
          if (!fl.departs) continue;
          n += this.#upsert('flight', `flight:${fl.flight}:${fl.departs.slice(0, 10)}`.toLowerCase(), { title: `${fl.flight}${fl.from && fl.to ? ` ${fl.from} → ${fl.to}` : ''}`, number: fl.flight, airline, ...(conf ? { confirmation: conf } : {}), ...(fl.from ? { from: fl.from } : {}), ...(fl.to ? { to: fl.to } : {}), ...(airportOf(fl.from) ? { place: airportOf(fl.from)!.name } : {}), start: fl.departs, ...(fl.arrives ? { end: fl.arrives } : {}), ...(airportOf(fl.from) ? { tz: airportOf(fl.from)!.tz } : {}), ...(airportOf(fl.to) ? { endTz: airportOf(fl.to)!.tz } : {}) }, m);
        }
        if (f.hotel?.checkIn) n += this.#upsert('hotel', `hotel:${conf ?? f.hotel.name}:${f.hotel.checkIn.slice(0, 10)}`.toLowerCase(), { title: f.hotel.name, ...(conf ? { confirmation: conf } : {}), ...(f.hotel.address ? { place: f.hotel.address } : {}), start: f.hotel.checkIn, ...(f.hotel.checkOut ? { end: f.hotel.checkOut } : {}) }, m);
        if (f.car?.pickupAt) {
          const ap = airportOf(iataIn(f.car.pickup));
          n += this.#upsert('car', `car:${conf ?? f.car.company}:${f.car.pickupAt.slice(0, 10)}`.toLowerCase(), { title: f.car.company, ...(conf ? { confirmation: conf } : {}), ...(f.car.pickup ? { place: f.car.pickup } : {}), start: f.car.pickupAt, ...(f.car.dropoffAt ? { end: f.car.dropoffAt } : {}), ...(ap ? { tz: ap.tz, endTz: airportOf(iataIn(f.car.dropoff))?.tz ?? ap.tz } : {}) }, m);
        }
        for (const tr of f.trains ?? []) {
          if (!tr.departs) continue;
          n += this.#upsert('train', `train:${tr.train}:${tr.departs.slice(0, 10)}`.toLowerCase(), { title: `${tr.train}${tr.from && tr.to ? ` ${tr.from} → ${tr.to}` : ''}`, number: tr.train, ...(conf ? { confirmation: conf } : {}), ...(tr.from ? { from: tr.from, place: tr.from } : {}), ...(tr.to ? { to: tr.to } : {}), start: tr.departs, ...(tr.arrives ? { end: tr.arrives } : {}) }, m);
        }
      } else if (f.kind === 'appointment' && conf && f.start) {
        // Event tickets join a trip they fall in (they never make one).
        n += this.#upsert('event', `event:${conf}:${f.start.slice(0, 10)}`.toLowerCase(), { title: clip(f.title ?? m.subject, 120), confirmation: conf, ...(f.place ? { place: f.place } : {}), start: f.start, ...(f.end ? { end: f.end } : {}) }, m, true);
      }
    }
    if (n) this.#app.events?.publish({ type: 'today', part: 'trips' });
    return n;
  }

  #defaultHour(kind: BookingKind, end: boolean): number {
    return kind === 'hotel' ? (end ? 11 : 15) : 12;
  }
  #upsert(kind: BookingKind, key: string, d: BookingData, m: InboxMail, attachOnly = false): number {
    const account = m.account.toLowerCase();
    const old = this.#db.prepare('SELECT * FROM travel_bookings WHERE key = ?').get(key) as Row | undefined;
    if (old) {
      const accounts = new Set(JSON.parse(String(old.accounts_json)) as string[]);
      const had = accounts.size;
      accounts.add(account);
      const newer = !old.mail_date || Date.parse(m.date) > Date.parse(String(old.mail_date));
      const before = String(old.data_json);
      const data = newer ? { ...(JSON.parse(before) as BookingData), ...d } : (JSON.parse(before) as BookingData);
      this.#db.prepare('UPDATE travel_bookings SET accounts_json = ?, data_json = ?, mail_date = ? WHERE id = ?').run(JSON.stringify([...accounts]), JSON.stringify(data), newer ? m.date : String(old.mail_date), Number(old.id));
      this.#refresh(Number(old.trip_id));
      return accounts.size !== had || JSON.stringify(data) !== before ? 1 : 0;
    }
    const tz = d.tz ?? this.#tz();
    const start = instantOf(d.start, tz, this.#defaultHour(kind, false));
    if (!start) return 0;
    const end = d.end ? instantOf(d.end, d.endTz ?? tz, this.#defaultHour(kind, true)) : undefined;
    const lo = start.getTime() - TRAVEL.joinHours * HOUR;
    const hi = (end ?? start).getTime() + TRAVEL.joinHours * HOUR;
    const near = this.#tripFor(kind, d, start, lo, hi);
    if (!near && attachOnly) return 0;
    const now = this.#now().toISOString();
    const tripId = near ? Number(near.id) : Number(this.#db.prepare('INSERT INTO travel_trips (title, created_at) VALUES (?, ?)').run(d.title, now).lastInsertRowid);
    this.#db
      .prepare('INSERT INTO travel_bookings (trip_id, key, kind, data_json, starts_at, ends_at, accounts_json, mail_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tripId, key, kind, JSON.stringify(d), start.toISOString(), end?.toISOString() ?? null, JSON.stringify([account]), m.date, now);
    this.#refresh(tripId);
    return 1;
  }

  /** The trip a new booking joins: the same confirmation, else one it overlaps (36 h either side), else the trip a return flight closes. */
  #tripFor(kind: BookingKind, d: BookingData, start: Date, lo: number, hi: number): Row | undefined {
    if (d.confirmation) {
      const same = this.#db.prepare("SELECT b.trip_id AS id FROM travel_bookings b WHERE json_extract(b.data_json, '$.confirmation') = ? LIMIT 1").get(d.confirmation) as Row | undefined;
      if (same) return same;
    }
    const trips = this.#db.prepare('SELECT id, starts_at, ends_at FROM travel_trips WHERE starts_at IS NOT NULL ORDER BY starts_at').all() as Row[];
    const near = trips.find((t) => Date.parse(String(t.starts_at)) <= hi && Date.parse(String(t.ends_at ?? t.starts_at)) >= lo);
    if (near || kind !== 'flight' || !d.to) return near;
    // A flight home: it closes the trip whose first flight left from where this one lands (within 30 days).
    return trips.find((t) => {
      const first = this.#db.prepare("SELECT data_json FROM travel_bookings WHERE trip_id = ? AND kind = 'flight' ORDER BY starts_at LIMIT 1").get(Number(t.id)) as { data_json: string } | undefined;
      const f = first ? (JSON.parse(first.data_json) as BookingData) : undefined;
      const ts = Date.parse(String(t.starts_at));
      return f?.from === d.to && ts < start.getTime() && start.getTime() - ts <= 30 * 24 * HOUR;
    });
  }

  /** A trip's destination zone: where its first flight lands (else the car's airport, else the person's). */
  #destTz(rows: Row[]): string {
    const flights = rows.filter((r) => r.kind === 'flight').sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    const d = flights[0] ? (JSON.parse(String(flights[0].data_json)) as BookingData) : undefined;
    if (d?.endTz) return d.endTz;
    const car = rows.find((r) => r.kind === 'car');
    return (car && (JSON.parse(String(car.data_json)) as BookingData).tz) || this.#tz();
  }
  #refresh(tripId: number): void {
    const rows = this.#db.prepare('SELECT * FROM travel_bookings WHERE trip_id = ?').all(tripId) as Row[];
    if (!rows.length) return void this.#db.prepare('DELETE FROM travel_trips WHERE id = ?').run(tripId);
    const dest = this.#destTz(rows);
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      const kind = String(r.kind) as BookingKind;
      const d = JSON.parse(String(r.data_json)) as BookingData;
      const tz = d.tz ?? dest;
      const s = instantOf(d.start, tz, this.#defaultHour(kind, false));
      const e = d.end ? instantOf(d.end, d.endTz ?? tz, this.#defaultHour(kind, true)) : undefined;
      if (!s) continue;
      if (s.toISOString() !== r.starts_at || (e?.toISOString() ?? null) !== r.ends_at) this.#db.prepare('UPDATE travel_bookings SET starts_at = ?, ends_at = ? WHERE id = ?').run(s.toISOString(), e?.toISOString() ?? null, Number(r.id));
      lo = Math.min(lo, s.getTime());
      hi = Math.max(hi, (e ?? s).getTime());
    }
    const t = this.#db.prepare('SELECT custom_title FROM travel_trips WHERE id = ?').get(tripId) as { custom_title: number } | undefined;
    const title = t?.custom_title ? undefined : this.#autoTitle(rows);
    this.#db.prepare(`UPDATE travel_trips SET starts_at = ?, ends_at = ?${title ? ', title = ?' : ''} WHERE id = ?`).run(...([new Date(lo).toISOString(), new Date(hi).toISOString(), ...(title ? [title] : []), tripId] as [string, string, ...(string | number)[]]));
  }
  #autoTitle(rows: Row[]): string {
    const data = (k: BookingKind) => rows.filter((r) => r.kind === k).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))).map((r) => JSON.parse(String(r.data_json)) as BookingData);
    const fl = data('flight')[0];
    const place = airportOf(fl?.to)?.city ?? (fl?.to ? fl.to : undefined) ?? cityOf(data('hotel')[0]?.place) ?? airportOf(iataIn(data('car')[0]?.place))?.city ?? data('train')[0]?.to ?? data('hotel')[0]?.title ?? data('car')[0]?.title;
    return place ? this.#T(en('Trip to {place}'), { place }) : this.#T(en('Trip'));
  }

  // ------------------------------------------------------------ reading

  #booking(r: Row, dest: string): BookingView {
    const kind = String(r.kind) as BookingKind;
    const d = JSON.parse(String(r.data_json)) as BookingData;
    const tz = d.tz ?? dest;
    const sent = JSON.parse(String(r.sent_json ?? '{}')) as Sent;
    const status = r.status_json ? (JSON.parse(String(r.status_json)) as FlightStatus) : undefined;
    const link = kind === 'flight' ? airlineLink(d.number?.slice(0, 2), d.airline).url : undefined;
    return {
      id: Number(r.id),
      tripId: Number(r.trip_id),
      kind,
      title: d.title,
      ...(d.number ? { number: d.number } : {}),
      ...(d.airline ? { airline: d.airline } : {}),
      ...(d.confirmation ? { confirmation: d.confirmation } : {}),
      ...(d.from ? { from: d.from } : {}),
      ...(d.to ? { to: d.to } : {}),
      ...(d.place ? { place: d.place } : {}),
      start: d.start,
      ...(d.end ? { end: d.end } : {}),
      tz,
      startsAt: String(r.starts_at),
      endsAt: (r.ends_at as string | null) ?? null,
      when: fmtWhen(new Date(String(r.starts_at)), tz),
      accounts: JSON.parse(String(r.accounts_json)) as string[],
      ...(status ? { status } : {}),
      ...(sent.rebook ? { rebook: sent.rebook } : {}),
      inCalendar: Boolean(r.event_id),
      ...(link ? { link } : {}),
    };
  }
  #trip(t: Row): TripView {
    const rows = this.#db.prepare('SELECT * FROM travel_bookings WHERE trip_id = ? ORDER BY starts_at, id').all(Number(t.id)) as Row[];
    const dest = this.#destTz(rows);
    const s = t.starts_at ? new Date(String(t.starts_at)) : undefined;
    const e = t.ends_at ? new Date(String(t.ends_at)) : undefined;
    const homeTz = this.#tz();
    return {
      id: Number(t.id),
      title: String(t.title),
      startsAt: (t.starts_at as string | null) ?? null,
      endsAt: (t.ends_at as string | null) ?? null,
      dates: s ? (e && fmtDay(e, homeTz) !== fmtDay(s, homeTz) ? `${fmtDay(s, homeTz)} – ${fmtDay(e, homeTz)}` : fmtDay(s, homeTz)) : '',
      bookings: rows.map((r) => this.#booking(r, dest)),
      packing: t.packing_json ? (JSON.parse(String(t.packing_json)) as TripView['packing']) : null,
    };
  }
  /** Upcoming and current trips (ended more than 2 days ago: only with all). */
  trips(o: { all?: boolean } = {}): TripView[] {
    const cutoff = new Date(this.#now().getTime() - 48 * HOUR).toISOString();
    const rows = o.all ? this.#db.prepare('SELECT * FROM travel_trips ORDER BY starts_at DESC LIMIT 50').all() : this.#db.prepare('SELECT * FROM travel_trips WHERE ends_at >= ? ORDER BY starts_at').all(cutoff);
    return (rows as Row[]).map((t) => this.#trip(t));
  }
  trip(id: number): TripView | undefined {
    const t = this.#db.prepare('SELECT * FROM travel_trips WHERE id = ?').get(id) as Row | undefined;
    return t ? this.#trip(t) : undefined;
  }
  #must(id: number): TripView {
    const t = this.trip(id);
    if (!t) throw new TravelError(404, en('Trip not found.'));
    return t;
  }
  rename(id: number, title: string): TripView {
    this.#must(id);
    const t = clip(title, 120);
    if (!t) this.#db.prepare('UPDATE travel_trips SET custom_title = 0 WHERE id = ?').run(id);
    else this.#db.prepare('UPDATE travel_trips SET title = ?, custom_title = 1 WHERE id = ?').run(t, id);
    this.#refresh(id);
    return this.#must(id);
  }
  /** Forget a trip (its bookings too; a later mail about it makes it again). */
  remove(id: number): boolean {
    this.#db.prepare('DELETE FROM travel_bookings WHERE trip_id = ?').run(id);
    return this.#db.prepare('DELETE FROM travel_trips WHERE id = ?').run(id).changes > 0;
  }
  /** R7-style retention: trips that ended before `iso` go. */
  forgetBefore(iso: string): number {
    const ids = (this.#db.prepare('SELECT id FROM travel_trips WHERE ends_at < ?').all(iso) as Row[]).map((r) => Number(r.id));
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  // ------------------------------------------------------------ the tick

  /** From the reminder tick: never throws, one run at a time. */
  due(now: Date = this.#now()): void {
    if (this.#running) return;
    this.#running = this.tick(now)
      .catch((err: Error) => console.warn(`travel: ${err.message}`))
      .finally(() => (this.#running = undefined));
  }
  async idle(): Promise<void> {
    await this.#running;
  }

  /** Check-in, leave-by and flight status for flights in the next 36 hours. Returns what was said. */
  async tick(now: Date = this.#now()): Promise<string[]> {
    const s = this.settings();
    const out: string[] = [];
    const lo = new Date(now.getTime() - 12 * HOUR).toISOString();
    const hi = new Date(now.getTime() + TRAVEL.statusAheadH * HOUR).toISOString();
    const rows = this.#db.prepare("SELECT * FROM travel_bookings WHERE kind = 'flight' AND starts_at >= ? AND starts_at <= ? ORDER BY starts_at").all(lo, hi) as Row[];
    const source = s.alerts && !privateLocalOn() ? this.#source() : undefined;
    let polls = 0;
    for (const r of rows) {
      const trip = this.trip(Number(r.trip_id));
      const b = trip?.bookings.find((x) => x.id === Number(r.id));
      if (!trip || !b) continue;
      const sent = JSON.parse(String(r.sent_json ?? '{}')) as Sent;
      const dep = new Date(b.startsAt).getTime();
      const t = now.getTime();
      // Check-in opens 24 hours before (most airlines); not when an accepted inbox card already set one.
      if (s.checkin && !sent.checkin && t >= dep - TRAVEL.checkinH * HOUR && t < dep - 2 * HOUR && !this.#inboxReminded(b.confirmation)) {
        const air = airlineLink(b.number?.slice(0, 2), b.airline);
        const text = this.#T(en('Check-in is open for {flight} ({when}). {link}'), { flight: b.title, when: b.when, link: air.known ? this.#T(en('Check in: {url}'), { url: `[${air.name}](${air.url})` }) : this.#T(en('Check in on the airline’s site or app.')) }).trim();
        this.#say(text, false, b, now);
        out.push(text);
        sent.checkin = true;
      }
      // Status (only a source the person turned on; never in private local mode).
      if (source && polls < TRAVEL.pollsPerTick && !['landed', 'cancelled'].includes(b.status?.state ?? '')) {
        const every = (dep - t > TRAVEL.urgentH * HOUR ? TRAVEL.pollFarMin : TRAVEL.pollNearMin) * 60_000;
        const last = r.checked_at ? Date.parse(String(r.checked_at)) : 0;
        const endBy = (b.endsAt ? Date.parse(b.endsAt) : dep + 6 * HOUR) + HOUR;
        if (t - last >= every - 1000 && t <= endBy) {
          polls++;
          const text = await this.#check(b, source, now, sent);
          if (text) out.push(text);
        }
      }
      // Leave-by: the existing engine (home -> the airport) for the time to be there.
      if (s.leaveBy && !sent.leave && dep > t && dep - t <= TRAVEL.leaveAheadH * HOUR && this.#app.leaveBy?.planFor && !this.#inboxReminded(b.confirmation)) {
        const st = this.#statusOf(b.id);
        const est = st?.depEstimated ? instantOf(st.depEstimated, b.tz) : undefined;
        const effective = Math.max(dep, est?.getTime() ?? 0);
        const intl = airportOf(b.from) && airportOf(b.to) && airportOf(b.from)!.country !== airportOf(b.to)!.country;
        const lead = intl ? 3 : 2;
        const place = airportOf(b.from) ? `${airportOf(b.from)!.name} airport (${b.from})` : `${b.from ?? ''} airport`;
        const plan = await this.#app.leaveBy.planFor([{ id: `travel-${b.id}`, start: new Date(effective - lead * HOUR).toISOString(), allDay: false, location: place }]).catch(() => []);
        const p = plan[0];
        if (p && t >= Date.parse(p.leaveAt) - 60_000) {
          const text = this.#T(en('Time to leave for {airport}: about {min} minutes there, to be there {lead} hours before {flight}.'), { airport: airportOf(b.from)?.name ?? b.from ?? '', min: p.minutes, lead, flight: b.title });
          this.#say(text, true, b, now);
          out.push(text);
          sent.leave = true;
        }
      }
      this.#db.prepare('UPDATE travel_bookings SET sent_json = ? WHERE id = ?').run(JSON.stringify(sent), b.id);
    }
    if (out.length) this.#app.events?.publish({ type: 'today', part: 'trips' });
    return out;
  }
  #statusOf(id: number): FlightStatus | undefined {
    const r = this.#db.prepare('SELECT status_json FROM travel_bookings WHERE id = ?').get(id) as { status_json: string | null } | undefined;
    return r?.status_json ? (JSON.parse(r.status_json) as FlightStatus) : undefined;
  }
  /** An accepted inbox trip card with the same confirmation already set check-in/leave-by reminders. */
  #inboxReminded(conf: string | undefined): boolean {
    if (!conf) return false;
    try {
      return (this.#app.inbox?.trips({ all: true }) ?? []).some((t) => t.confirmation === conf && t.reminders.length > 0);
    } catch {
      return false;
    }
  }

  /** One status check: compare with the last one; changes are said (and pushed). */
  async #check(b: BookingView, source: FlightStatusSource, now: Date, sent: Sent): Promise<string | undefined> {
    const st = await source.status(b.number ?? b.title, b.start.slice(0, 10), AbortSignal.timeout(20_000), { from: b.from, to: b.to, departsAt: b.startsAt, arrivesAt: b.endsAt }).catch(() => undefined);
    this.#db.prepare('UPDATE travel_bookings SET checked_at = ? WHERE id = ?').run(now.toISOString(), b.id);
    if (!st) return undefined;
    const prev = this.#statusOf(b.id);
    this.#db.prepare('UPDATE travel_bookings SET status_json = ? WHERE id = ?').run(JSON.stringify(st), b.id);
    const parts: string[] = [];
    let head = '';
    let rebook = false;
    if (st.state === 'cancelled' && prev?.state !== 'cancelled') {
      head = this.#T(en('{flight} is cancelled.'), { flight: b.title });
      rebook = true;
    } else if (st.state === 'diverted' && prev?.state !== 'diverted') {
      head = this.#T(en('{flight} was diverted.'), { flight: b.title });
    } else if (st.state !== 'cancelled') {
      const d = st.depDelayMin ?? 0;
      const pd = prev?.depDelayMin ?? 0;
      if (d >= TRAVEL.delayAlertMin && Math.abs(d - pd) >= TRAVEL.delayAlertMin) {
        const est = st.depEstimated ? instantOf(st.depEstimated, b.tz) : new Date(Date.parse(b.startsAt) + d * 60_000);
        parts.push(this.#T(en('delayed {n} min, now leaves {time}'), { n: d, time: est ? fmtTime(est, b.tz) : '?' }));
        if (d >= TRAVEL.rebookDelayMin && pd < TRAVEL.rebookDelayMin) rebook = true;
      } else if (pd >= TRAVEL.delayAlertMin && d < TRAVEL.delayAlertMin) parts.push(this.#T(en('back on time')));
      if (st.depGate && prev?.depGate && st.depGate !== prev.depGate) parts.push(this.#T(en('gate changed to {gate} (was {old})'), { gate: st.depGate, old: prev.depGate }));
      else if (st.depGate && !prev?.depGate) parts.push(this.#T(en('gate {gate}'), { gate: st.depGate }));
    }
    if (!head && !parts.length) return undefined;
    let text = head || `${b.title}: ${parts.join(' · ')}`;
    if (rebook) {
      const options = await this.#rebookOptions(b, source, now);
      sent.rebook = options;
      this.#db.prepare('UPDATE travel_bookings SET sent_json = ? WHERE id = ?').run(JSON.stringify(sent), b.id);
      text += `\n${this.#T(en('Options:'))}\n${options.map((o) => `- ${o.url ? `[${o.label}](${o.url})` : o.label}`).join('\n')}\n${this.#T(en('I never book or pay: you choose with the airline.'))}`;
    }
    const urgent = Date.parse(b.startsAt) - now.getTime() <= TRAVEL.urgentH * HOUR;
    this.#say(text, urgent, b, now);
    return text;
  }

  async #rebookOptions(b: BookingView, source: FlightStatusSource | undefined, now: Date): Promise<RebookOption[]> {
    const air = airlineLink(b.number?.slice(0, 2), b.airline);
    const out: RebookOption[] = [{ label: this.#T(en('{airline}: change or rebook on its site or app'), { airline: air.name }), url: air.url }];
    if (source?.nextFlights && b.from && b.to && !privateLocalOn()) {
      const next = await source.nextFlights(b.from, b.to, now, AbortSignal.timeout(20_000)).catch(() => []);
      for (const n of next.slice(0, 3)) {
        const at = n.departs ? instantOf(n.departs, b.tz) : undefined;
        out.push({ label: this.#T(en('Next flight: {flight}, {when}'), { flight: `${n.flight} ${n.from} → ${n.to}`, when: at ? fmtWhen(at, b.tz) : '?' }), flight: n.flight, ...(n.departs ? { departs: n.departs } : {}) });
      }
    }
    out.push({ label: this.#T(en('Ask at the airline desk or in its app: after a cancellation, a seat on its next flight is usually free.')) });
    return out;
  }

  /** Check status now (the page's button, trip_status): flights in this trip leaving in the next 48 hours. */
  async checkNow(tripId: number): Promise<TripView> {
    const trip = this.#must(tripId);
    const source = !privateLocalOn() ? this.#source() : undefined;
    if (source) {
      const now = this.#now();
      for (const b of trip.bookings.filter((x) => x.kind === 'flight' && Date.parse(x.startsAt) > now.getTime() - 6 * HOUR && Date.parse(x.startsAt) - now.getTime() <= 48 * HOUR).slice(0, 4)) {
        const r = this.#db.prepare('SELECT sent_json FROM travel_bookings WHERE id = ?').get(b.id) as { sent_json: string };
        const sent = JSON.parse(r.sent_json) as Sent;
        await this.#check(b, source, now, sent);
      }
    }
    return this.#must(tripId);
  }

  // ------------------------------------------------------------ chat + phone

  conversationId(): string {
    const id = this.#get('conversation') as string | undefined;
    if (id && this.#app.store.getConversation(id)) return id;
    const c = this.#app.store.createConversation({ title: this.#T(en('Travel')), channel: 'travel', channelKey: 'travel' });
    this.#put('conversation', c.id);
    return c.id;
  }
  #say(text: string, urgent: boolean, b: BookingView, now: Date): void {
    // ALERTDEST: travel alerts go where the person chose (default: the Travel chat).
    const conversationId = postAlert(this.#app, 'travel', { origin: () => this.conversationId(), role: 'assistant', content: text, meta: { travel: { trip: b.tripId, booking: b.id } }, reason: 'reminder' }) ?? '';
    if (privateLocalOn()) return;
    const quiet = this.#o.quiet ? this.#o.quiet() : quietNow(this.#app, now);
    if (quiet && !urgent) return;
    const n = this.#o.notify ?? ((a: string, body: string, c: string, tag: string) => this.#app.push?.notifyOwner(a, body, c, tag) ?? Promise.resolve());
    void n(this.#T(en('Travel')), clip(text, 200), conversationId, `travel-${b.id}`).catch(() => undefined);
  }

  // ------------------------------------------------------------ calendar (the person's tap)

  async addToCalendar(tripId: number): Promise<{ added: number; text: string }> {
    const trip = this.#must(tripId);
    const tool = this.#app.tools.get('calendar_add');
    if (!tool || tool.isAvailable?.() === false) throw new TravelError(400, en('No calendar is connected.'));
    const over = this.#app.settings.get().toolPermissions;
    if (this.#app.tools.permission('calendar_add', over) === 'never') throw new TravelError(400, en('Adding to the calendar is turned off in your tool settings.'));
    const tz = this.#tz();
    const inboxEvents = new Set((this.#app.inbox?.trips({ all: true }) ?? []).filter((t) => t.events.length).map((t) => t.confirmation));
    let added = 0;
    const lines: string[] = [];
    for (const b of trip.bookings) {
      if (b.inCalendar || (b.confirmation && inboxEvents.has(b.confirmation) && (b.kind === 'flight' || b.kind === 'hotel'))) continue;
      const s = new Date(b.startsAt);
      const e = b.endsAt ? new Date(b.endsAt) : undefined;
      const title = b.kind === 'flight' ? `${this.#T(en('Flight'))} ${b.title}` : b.kind === 'hotel' ? `${this.#T(en('Stay'))}: ${b.title}` : b.kind === 'car' ? `${this.#T(en('Car'))}: ${b.title}` : b.kind === 'train' ? `${this.#T(en('Train'))} ${b.title}` : b.title;
      const allDay = b.kind === 'hotel';
      const args: Record<string, unknown> = {
        title,
        start: allDay ? localDay(s, tz) : wallIn(s, tz),
        ...(e && (allDay || e.getTime() - s.getTime() < 20 * HOUR) ? { end: allDay ? localDay(e, b.tz) : wallIn(e, tz) } : {}),
        ...(b.place ? { location: b.place } : {}),
        notes: `${b.when}${b.confirmation ? ` · ${this.#T(en('Confirmation'))} ${b.confirmation}` : ''}`,
      };
      const ctx: ToolContext = { workspaceDir: this.#app.dataDir, signal: AbortSignal.timeout(60_000), sandbox: this.#app.sandbox, conversationId: this.conversationId() };
      const out = await tool.run(args, ctx).catch((err: Error) => `Could not add: ${err.message}`);
      const ev = /\(event ([^)\s]+)\)/.exec(out)?.[1];
      if (ev) {
        this.#db.prepare('UPDATE travel_bookings SET event_id = ? WHERE id = ?').run(ev, b.id);
        added++;
      } else lines.push(clip(out, 200));
    }
    return { added, text: added ? this.#T(en('Added {n} to your calendar.'), { n: added }) + (lines.length ? `\n${lines.join('\n')}` : '') : lines.join('\n') || this.#T(en('Everything is already in your calendar.')) };
  }

  // ------------------------------------------------------------ packing list (the person's tap)

  async packingList(tripId: number): Promise<NonNullable<TripView['packing']>> {
    const trip = this.#must(tripId);
    const boards = this.#app.sharedBoards;
    if (trip.packing) {
      if (trip.packing.boardId && boards?.store.board(boards.person, trip.packing.boardId)) return trip.packing;
      if (trip.packing.project) return trip.packing;
    }
    const items = await this.packingItems(trip);
    const name = clip(`${this.#T(en('Packing'))}: ${trip.title}`, 80);
    let packing: NonNullable<TripView['packing']>;
    if (boards) {
      const b = boards.store.create(boards.person, name, [], boards.people().map((p) => p.id));
      for (const it of items) boards.store.addCard(boards.person, b.id, { title: it });
      packing = { boardId: b.id, name, items };
    } else if (this.#app.planner) {
      for (const it of items) this.#app.planner.addTask({ title: it, project: name });
      packing = { project: name, name, items };
    } else throw new TravelError(400, en('No lists here.'));
    this.#db.prepare('UPDATE travel_trips SET packing_json = ? WHERE id = ?').run(JSON.stringify(packing), tripId);
    return packing;
  }

  /** What to pack: the basics, clothes for the nights away, what the bookings need, and the forecast. */
  async packingItems(trip: TripView): Promise<string[]> {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const s = trip.startsAt ? new Date(trip.startsAt) : this.#now();
    const e = trip.endsAt ? new Date(trip.endsAt) : s;
    const dz = trip.bookings.find((b) => b.kind === 'flight' && airportOf(b.to))?.to;
    const tz = airportOf(dz)?.tz ?? this.#tz();
    const nights = Math.max(1, Math.round((Date.parse(localDay(e, tz)) - Date.parse(localDay(s, tz))) / (24 * HOUR)));
    const kinds = new Set(trip.bookings.map((b) => b.kind));
    const flights = trip.bookings.filter((b) => b.kind === 'flight');
    const intl = flights.some((b) => airportOf(b.from) && airportOf(b.to) && airportOf(b.from)!.country !== airportOf(b.to)!.country);
    const items = [T(en('Phone charger')), T(en('Photo ID')), T(en('Medications')), T(en('Toiletries')), T(en('Underwear and socks ({n})'), { n: nights + 1 }), T(en('Tops ({n})'), { n: nights + 1 }), T(en('Pants or skirts ({n})'), { n: Math.max(1, Math.ceil(nights / 2)) }), T(en('Sleepwear')), T(en('Comfortable shoes'))];
    if (flights.length) items.push(T(en('Boarding passes (in the airline’s app)')));
    if (intl) items.push(T(en('Passport')), T(en('Power adapter')));
    if (kinds.has('car')) items.push(T(en('Driver’s license')));
    if (kinds.has('event')) items.push(T(en('Event tickets')));
    if (nights >= 5) items.push(T(en('Laundry bag')));
    const fc = await this.#forecast(trip).catch(() => undefined);
    if (fc) {
      if (fc.loC <= 7) items.push(T(en('Warm jacket')));
      if (fc.loC <= 0) items.push(T(en('Hat and gloves')));
      if (fc.hiC >= 27) items.push(T(en('Sunscreen')), T(en('Sunglasses')));
      if (fc.rainPct >= 40) items.push(T(en('Umbrella or rain jacket')));
      if (fc.snow) items.push(T(en('Waterproof boots')));
    }
    return [...new Set(items)];
  }
  async #forecast(trip: TripView): Promise<Forecast | undefined> {
    if (privateLocalOn() || !trip.startsAt) return undefined;
    const fl = trip.bookings.find((b) => b.kind === 'flight');
    const ap = airportOf(fl?.to);
    if (!ap) return undefined;
    const now = this.#now();
    if (Date.parse(trip.startsAt) - now.getTime() > TRAVEL.forecastDays * 24 * HOUR) return undefined;
    const from = localDay(new Date(Math.max(Date.parse(trip.startsAt), now.getTime())), ap.tz);
    const to = localDay(new Date(Date.parse(trip.endsAt ?? trip.startsAt)), ap.tz);
    const place = { name: ap.city, lat: ap.lat, lon: ap.lon };
    return this.#o.weather ? this.#o.weather(place, from, to) : openMeteo(place, from, to, this.#o.fetch ?? netFetch);
  }

  // ------------------------------------------------------------ words for tools and Today

  #statusLine(st: FlightStatus | undefined): string {
    if (!st) return '';
    const bits: string[] = [];
    if (st.state === 'cancelled') bits.push(this.#T(en('cancelled')));
    else if (st.state === 'diverted') bits.push(this.#T(en('diverted')));
    else if (st.state === 'landed') bits.push(this.#T(en('landed')));
    // U3.14: a position-only source says where the plane is, never "on time".
    else if (st.position) bits.push(st.position.onGround ? this.#T(en('on the ground')) : this.#T(en('in the air')));
    else if ((st.depDelayMin ?? 0) >= TRAVEL.delayAlertMin) bits.push(this.#T(en('delayed {n} min'), { n: st.depDelayMin }));
    else bits.push(this.#T(en('on time')));
    if (st.depGate) bits.push(this.#T(en('gate {gate}'), { gate: st.depGate }));
    return `${bits.join(', ')} (${st.source})`;
  }
  listText(all = false): string {
    const trips = this.trips({ all });
    if (!trips.length) return 'No trips found in your email yet. Bookings in new email (flights, hotels, cars, trains, event tickets) appear on the Trips page.';
    return trips.map((t) => `Trip #${t.id} “${t.title}” · ${t.dates} · ${t.bookings.length} booking${t.bookings.length === 1 ? '' : 's'}: ${t.bookings.map((b) => b.title).join('; ')}`).join('\n');
  }
  statusText(t: TripView): string {
    const lines = t.bookings.map((b) => `- ${b.kind}${b.kind === 'flight' && b.airline ? ` (${b.airline})` : ''}: ${b.title} · ${b.when}${b.end && b.endsAt ? ` → ${fmtWhen(new Date(b.endsAt), b.kind === 'flight' && airportOf(b.to) ? airportOf(b.to)!.tz : b.tz)}` : ''}${b.place && b.kind !== 'flight' ? ` · ${b.place}` : ''}${b.confirmation ? ` · confirmation ${b.confirmation}` : ''}${b.status ? ` · ${this.#statusLine(b.status)}` : ''}${b.rebook?.length ? `\n  Rebooking options: ${b.rebook.map((o) => o.label).join('; ')}` : ''}`);
    const src = !this.#source() ? '\n(Flight status is off: the person can turn on a source on the Trips page.)' : this.settings().provider === 'opensky' && !this.#o.source ? `\n(Flight status: ${OPENSKY_LIMITS})` : '';
    return `Trip #${t.id} “${t.title}” · ${t.dates}\n${lines.join('\n')}${t.packing ? `\nPacking list: ${t.packing.name}` : ''}${src}\nShe never books, changes or pays for travel.`;
  }

  /** Today: the next trip (or the one under way) and what comes next in it. */
  todayTile(): { trips: { id: number; title: string; dates: string; next: { kind: BookingKind; title: string; when: string; status?: string }[] }[] } | undefined {
    const now = this.#now().getTime();
    const trips = this.trips()
      .filter((t) => t.startsAt && Date.parse(t.startsAt) - now <= 14 * 24 * HOUR && Date.parse(t.endsAt ?? t.startsAt) >= now)
      .slice(0, 2)
      .map((t) => ({
        id: t.id,
        title: t.title,
        dates: t.dates,
        next: t.bookings
          .filter((b) => Date.parse(b.startsAt) >= now - HOUR)
          .slice(0, 3)
          .map((b) => ({ kind: b.kind, title: b.title, when: b.when, ...(b.status ? { status: this.#statusLine(b.status) } : {}) })),
      }));
    return trips.length ? { trips } : undefined;
  }
}

export function travelFor(app: AppContext): Travel {
  app.travel ??= new Travel(app, app.store.db);
  return app.travel;
}
