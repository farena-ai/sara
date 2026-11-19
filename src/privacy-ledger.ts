// V5.2 (docs/design/V5LEDGER.md): the privacy ledger. The net guard (src/net-guard.ts) is the one
// way out of the server; it tells this ledger the address of every request that leaves (and every
// one private local mode stopped). The ledger keeps, per local day, one row per destination host:
// the purpose (model, search, mail...), how many requests, the request sizes it could tell, the
// first and last time. Never bodies, paths, queries, headers or who asked. Requests to this
// computer (loopback) are not "leaving" and are not counted, so private local mode shows zero.
// Kept for LEDGER_DAYS days in <owner data>/privacy-ledger.json (one small file, owner only).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isLanHost, isLoopbackHost, setOutboundRecorder, type OutboundNote } from './net-guard.ts';

export type LedgerPurpose = 'model' | 'search' | 'web' | 'mail' | 'notifications' | 'chat-apps' | 'voice' | 'makers' | 'github' | 'add-ons' | 'home-network' | 'other';
export const LEDGER_PURPOSES: readonly LedgerPurpose[] = ['model', 'search', 'web', 'mail', 'notifications', 'chat-apps', 'voice', 'makers', 'github', 'add-ons', 'home-network', 'other'];
/** Days kept. */
export const LEDGER_DAYS = 30;
/** Hosts kept per day; the rest is added up under one row. */
export const LEDGER_HOSTS = 300;
const MORE = '(other places)';

export interface LedgerHint { host: string; purpose: LedgerPurpose }

/** Labels the net guard's callers pass (`checkOutbound(url, what)`, `noteOutbound(url, what)`). */
const BY_LABEL: Record<string, LedgerPurpose> = {
  'your mail server': 'mail',
  'iPhone notifications': 'notifications',
  'git clone': 'add-ons',
  'a plugin connection': 'add-ons',
  'web page': 'web',
  feed: 'web',
  'outgoing webhook': 'web',
  agent: 'home-network',
};

/** Well-known services by host suffix (the owner's own providers come as hints). */
const KNOWN: [string, LedgerPurpose][] = [
  ...['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'api.x.ai', 'openrouter.ai', 'api.groq.com', 'api.mistral.ai', 'api.deepseek.com', 'api.together.xyz', 'api.fireworks.ai', 'api.perplexity.ai', 'api.cohere.com', 'api.cerebras.ai', 'api.moonshot.ai', 'ollama.com', 'registry.ollama.ai', 'huggingface.co', 'hf.co'].map((h) => [h, 'model'] as [string, LedgerPurpose]),
  ...['api.search.brave.com', 'api.tavily.com', 'api.exa.ai', 'serpapi.com', 'google.serper.dev'].map((h) => [h, 'search'] as [string, LedgerPurpose]),
  ...['gmail.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'graph.microsoft.com', 'login.microsoftonline.com', 'outlook.office365.com', 'outlook.office.com', 'caldav.icloud.com', 'imap.gmail.com', 'smtp.gmail.com'].map((h) => [h, 'mail'] as [string, LedgerPurpose]),
  ...['fcm.googleapis.com', 'android.googleapis.com', 'api.push.apple.com', 'api.sandbox.push.apple.com', 'web.push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'].map((h) => [h, 'notifications'] as [string, LedgerPurpose]),
  ...['api.telegram.org', 'discord.com', 'discordapp.com', 'discord.gg', 'slack.com', 'graph.facebook.com', 'botframework.com', 'matrix.org'].map((h) => [h, 'chat-apps'] as [string, LedgerPurpose]),
  ...['api.elevenlabs.io', 'api.deepgram.com', 'api.cartesia.ai'].map((h) => [h, 'voice'] as [string, LedgerPurpose]),
  ['backstagecoding.com', 'makers'],
  ...['github.com', 'api.github.com', 'githubusercontent.com', 'codeload.github.com'].map((h) => [h, 'github'] as [string, LedgerPurpose]),
  ...['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'].map((h) => [h, 'add-ons'] as [string, LedgerPurpose]),
];

const suffix = (host: string, of: string) => host === of || host.endsWith(`.${of}`);

/** Why a request to `host` left: the caller's label, the owner's hints, known services, the home network. */
export function purposeOf(host: string, what: string | undefined, hints: readonly LedgerHint[]): LedgerPurpose {
  if (what && BY_LABEL[what]) return BY_LABEL[what];
  for (const h of hints) if (suffix(host, h.host)) return h.purpose;
  for (const [k, p] of KNOWN) if (suffix(host, k)) return p;
  if (isLanHost(host)) return 'home-network';
  return 'other';
}

const hostOf = (u: string | undefined): string | undefined => {
  if (!u) return undefined;
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h || undefined;
  } catch {
    return undefined;
  }
};

/** The owner's own destinations from settings: model providers, the search address, the hub. */
export function ledgerHints(s: { providers?: { baseUrl?: string }[]; search?: { url?: string } }, hub?: string): LedgerHint[] {
  const out: LedgerHint[] = [];
  const add = (u: string | undefined, purpose: LedgerPurpose) => {
    const host = hostOf(u);
    if (host && !isLoopbackHost(host) && !out.some((h) => h.host === host)) out.push({ host, purpose });
  };
  for (const p of s.providers ?? []) add(p.baseUrl, 'model');
  add(s.search?.url, 'search');
  add(hub, 'makers');
  return out;
}

interface Row { p: LedgerPurpose; n: number; b: number; u: number; f: string; l: string }
interface Day { rows: Record<string, Row>; stopped: Record<string, number> }
interface Saved { v: 1; days: Record<string, Day> }

export interface LedgerHost { host: string; count: number; bytes: number; unsized: number; first: string; last: string }
export interface LedgerGroup { purpose: LedgerPurpose; count: number; bytes: number; hosts: LedgerHost[] }
export interface LedgerDayView {
  day: string;
  total: { count: number; bytes: number; places: number; unsized: number };
  groups: LedgerGroup[];
  stopped: { host: string; count: number }[];
}

export interface LedgerOptions {
  file?: string;
  timeZone?: () => string | undefined;
  hints?: () => LedgerHint[];
  now?: () => Date;
}

export const isLedgerDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

export class PrivacyLedger {
  #o: LedgerOptions;
  #data: Saved = { v: 1, days: {} };
  #dirty = false;
  #savedAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #hints: { at: number; list: LedgerHint[] } = { at: 0, list: [] };
  constructor(o: LedgerOptions = {}) {
    this.#o = o;
    if (o.file && existsSync(o.file)) {
      try {
        const d = JSON.parse(readFileSync(o.file, 'utf8')) as Saved;
        if (d && d.v === 1 && d.days && typeof d.days === 'object') this.#data = d;
      } catch {
        /* a damaged file starts a new list */
      }
    }
  }
  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }
  /** The owner's local day for a moment (YYYY-MM-DD). */
  dayOf(at: Date = this.#now()): string {
    const tz = this.#o.timeZone?.();
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    } catch {
      return at.toISOString().slice(0, 10);
    }
  }
  #hintList(): LedgerHint[] {
    const t = Date.now();
    if (t - this.#hints.at > 5000) {
      try {
        this.#hints = { at: t, list: this.#o.hints?.() ?? [] };
      } catch {
        this.#hints = { at: t, list: [] };
      }
    }
    return this.#hints.list;
  }
  #day(key: string): Day {
    let d = this.#data.days[key];
    if (!d) {
      d = this.#data.days[key] = { rows: {}, stopped: {} };
      this.#prune(key);
    }
    return d;
  }
  #prune(today: string): void {
    const cut = new Date(`${today}T12:00:00Z`).getTime() - LEDGER_DAYS * 86_400_000;
    for (const k of Object.keys(this.#data.days)) if (new Date(`${k}T12:00:00Z`).getTime() < cut) delete this.#data.days[k];
  }
  /** One request that left (or was stopped). Called by the net guard; never given a body. */
  take(e: OutboundNote): void {
    const host = hostOf(e.target);
    if (!host || isLoopbackHost(host)) return;
    const d = this.#day(this.dayOf());
    if (e.blocked) {
      d.stopped[host] = (d.stopped[host] ?? 0) + 1;
    } else {
      const at = this.#now().toISOString();
      let key = host;
      if (!d.rows[key] && Object.keys(d.rows).length >= LEDGER_HOSTS) key = MORE;
      const r = (d.rows[key] ??= { p: key === MORE ? 'other' : purposeOf(host, e.what, this.#hintList()), n: 0, b: 0, u: 0, f: at, l: at });
      r.n++;
      if (typeof e.bytes === 'number' && Number.isFinite(e.bytes)) r.b += Math.max(0, e.bytes);
      else r.u++;
      r.l = at;
    }
    this.#changed();
  }
  /** Same as take() for a plain address (tests, callers without the guard). */
  note(target: string, what?: string, bytes?: number): void {
    this.take({ target, ...(what ? { what } : {}), ...(bytes !== undefined ? { bytes } : {}) });
  }
  #changed(): void {
    this.#dirty = true;
    if (!this.#o.file) return;
    if (Date.now() - this.#savedAt > 15_000) return this.flush();
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.flush();
      }, 15_000);
      this.#timer.unref?.();
    }
  }
  /** Writes the file now (if anything changed). */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#dirty || !this.#o.file) return;
    try {
      const tmp = `${this.#o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#data), { mode: 0o600 });
      renameSync(tmp, this.#o.file);
      this.#dirty = false;
      this.#savedAt = Date.now();
    } catch {
      /* a full disk never breaks a request; the next write tries again */
    }
  }
  /** Forgets every day (the owner's Clear). */
  clear(): void {
    this.#data = { v: 1, days: {} };
    this.#dirty = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#o.file) rmSync(this.#o.file, { force: true });
  }
  /** Days with anything in them, newest first. */
  days(): { day: string; count: number; stopped: number }[] {
    return Object.entries(this.#data.days)
      .map(([day, d]) => ({ day, count: Object.values(d.rows).reduce((n, r) => n + r.n, 0), stopped: Object.values(d.stopped).reduce((n, x) => n + x, 0) }))
      .filter((d) => d.count || d.stopped)
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  /** One day, grouped by purpose (most requests first). Defaults to today. */
  day(key: string = this.dayOf()): LedgerDayView {
    const d = this.#data.days[key];
    const groups = new Map<LedgerPurpose, LedgerGroup>();
    let unsized = 0;
    for (const [host, r] of Object.entries(d?.rows ?? {})) {
      const g = groups.get(r.p) ?? { purpose: r.p, count: 0, bytes: 0, hosts: [] };
      g.count += r.n;
      g.bytes += r.b;
      unsized += r.u;
      g.hosts.push({ host, count: r.n, bytes: r.b, unsized: r.u, first: r.f, last: r.l });
      groups.set(r.p, g);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count || LEDGER_PURPOSES.indexOf(a.purpose) - LEDGER_PURPOSES.indexOf(b.purpose));
    for (const g of list) g.hosts.sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : 1));
    return {
      day: key,
      total: { count: list.reduce((n, g) => n + g.count, 0), bytes: list.reduce((n, g) => n + g.bytes, 0), places: list.reduce((n, g) => n + g.hosts.length, 0), unsized },
      groups: list,
      stopped: Object.entries(d?.stopped ?? {})
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

let current: PrivacyLedger | undefined;
/** Installs the server's ledger (main.ts) and connects it to the net guard; undefined disconnects. */
export function setPrivacyLedger(l: PrivacyLedger | undefined): void {
  current?.flush();
  current = l;
  setOutboundRecorder(l ? (e) => l.take(e) : undefined);
}
export const privacyLedger = (): PrivacyLedger | undefined => current;
