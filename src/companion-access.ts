// T62 (owner decision 2026-11-28): which of the server's mailboxes, Google and Spotify another
// companion may use. The first companion uses all of them (unchanged); any other uses none until
// the owner allows them (Settings → Connections → Email / Google: "What {name} may use").
//
// The allow list lives in her own folder (data/companions/<id>/access.json). It is enforced by
// handing her gated views of the server's accounts instead of the accounts themselves: every tool,
// route, Today part, inbox helper and briefing that reads `app.mailAccounts`, `app.google`,
// `app.googleAccounts` or `app.spotify` then sees only what she may use, and the one place each
// account talks to its service (`api()`, `provider()`) refuses the rest. The owner's management
// pages use the real accounts (`realOf`).
//
// Rule: a mailbox (Gmail ones included, by id: 'google', 'google:2', an Outlook or IMAP id) is hers
// when its id is in `mail`; `google` covers Google Calendar, Docs and Sheets (every Google account)
// and the calendars added by link; `spotify` the Spotify account.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoogleAccount, GoogleStatus } from './google.ts';
import type { GoogleAccounts } from './google-accounts.ts';
import { en, enf } from './i18n.ts';
import type { MailAccounts } from './mail/accounts.ts';
import type { MailAccountInfo, MailProvider } from './mail/types.ts';
import type { SpotifyAccount, SpotifyStatus } from './spotify.ts';

export interface CompanionAccess {
  /** Mailbox ids she may use. */
  mail: string[];
  /** Google Calendar, Docs and Sheets, and the calendars added by link. */
  google: boolean;
  spotify: boolean;
}

export const NO_ACCESS: CompanionAccess = Object.freeze({ mail: [], google: false, spotify: false }) as CompanionAccess;
export const ACCESS_FILE = 'access.json';
export const NOT_ALLOWED = 'The owner has not allowed this companion to use that account (Settings → Connections).';

/** Her allow list (one small file in her folder; read once, kept in memory, written on change). */
export class CompanionAccessFile {
  readonly #file: string;
  #cur: CompanionAccess | undefined;
  constructor(dir: string) {
    this.#file = join(dir, ACCESS_FILE);
  }
  get(): CompanionAccess {
    if (this.#cur) return this.#cur;
    let j: Partial<CompanionAccess> = {};
    try {
      if (existsSync(this.#file)) j = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<CompanionAccess>;
    } catch {
      j = {};
    }
    return (this.#cur = clean(j));
  }
  set(patch: Partial<CompanionAccess>): CompanionAccess {
    const next = clean({ ...this.get(), ...patch });
    mkdirSync(join(this.#file, '..'), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
    renameSync(tmp, this.#file);
    return (this.#cur = next);
  }
}

const files = new Map<string, CompanionAccessFile>();
/** The allow list of the companion whose folder is `dir` (one instance per folder). */
export function accessFor(dir: string): CompanionAccessFile {
  let f = files.get(dir);
  if (!f) files.set(dir, (f = new CompanionAccessFile(dir)));
  return f;
}

function clean(j: Partial<CompanionAccess> | undefined): CompanionAccess {
  const mail = Array.isArray(j?.mail) ? [...new Set(j.mail.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, 100) : [];
  return { mail, google: j?.google === true, spotify: j?.spotify === true };
}

const allow = (a: () => CompanionAccess) => ({
  mail: (id: string) => a().mail.includes(id),
  google: () => a().google,
  spotify: () => a().spotify,
});

// ---- gated views ---------------------------------------------------------------------------------

const REAL = new WeakMap<object, object>();
/** The real account behind a gated view (or the object itself). */
export function realOf<T>(x: T): T {
  return (x && typeof x === 'object' ? (REAL.get(x as object) as T | undefined) : undefined) ?? x;
}

/** A view of `target` with `own` in front; everything else goes to the real object (its private fields stay its own). */
function view<T extends object>(target: T, own: Record<string | symbol, unknown>): T {
  const p = new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  });
  REAL.set(p, target);
  return p;
}

const gatedGoogle = new WeakMap<object, WeakMap<GoogleAccount, GoogleAccount>>();
function googleView(g: GoogleAccount, a: ReturnType<typeof allow>, key: object): GoogleAccount {
  let m = gatedGoogle.get(key);
  if (!m) gatedGoogle.set(key, (m = new WeakMap()));
  const hit = m.get(g);
  if (hit) return hit;
  const status = (): GoogleStatus => {
    const s = g.status();
    const gmail = a.mail(g.id);
    const other = a.google();
    const out: GoogleStatus = { ...s, connected: s.connected && (gmail || other), gmail: s.gmail && gmail, canOrganize: s.canOrganize && gmail, calendar: s.calendar && other, docs: s.docs && other };
    if (!out.connected) {
      delete out.email;
      delete out.signedOut;
    }
    return out;
  };
  const okUrl = (url: string) => (/^https:\/\/gmail\.googleapis\.com\//.test(url) ? a.mail(g.id) : a.google());
  const v = view(g, {
    status,
    async api(url: string, init?: Parameters<GoogleAccount['api']>[1]) {
      if (!okUrl(url)) throw new Error(NOT_ALLOWED);
      return g.api(url, init);
    },
    async calendars(signal?: AbortSignal) {
      if (!a.google()) throw new Error(NOT_ALLOWED);
      return g.calendars(signal);
    },
  });
  m.set(g, v);
  return v;
}

/** Her view of one Google account (Gmail as her mail list says; Calendar, Docs and Sheets as `google` says). */
export function gateGoogle(g: GoogleAccount, access: () => CompanionAccess): GoogleAccount {
  return googleView(g, allow(access), access);
}

/** Her view of every Google sign-in. */
export function gateGoogles(gl: GoogleAccounts, access: () => CompanionAccess): GoogleAccounts {
  const a = allow(access);
  const wrap = (g: GoogleAccount) => googleView(g, a, access);
  const visible = (g: GoogleAccount) => wrap(g).status().connected;
  return view(gl, {
    primary: wrap(gl.primary),
    all: () => gl.all().filter(visible).map(wrap),
    list: () => gl.all().filter(visible).map((g) => ({ ...wrap(g).status(), id: g.id })),
    get: (id: string) => {
      const g = gl.get(id);
      return g ? wrap(g) : undefined;
    },
  });
}

/** Her view of the mailboxes: only the allowed ones are listed, picked or opened. */
export function gateMail(m: MailAccounts, access: () => CompanionAccess): MailAccounts {
  const a = allow(access);
  const list = (): MailAccountInfo[] => m.list().filter((x) => a.mail(x.id));
  const def = (): MailAccountInfo | undefined => {
    const all = list();
    const d = m.default()?.id;
    return all.find((x) => x.id === d) ?? all[0];
  };
  const wrapG = (g: GoogleAccount) => googleView(g, a, access);
  return view(m, {
    list,
    default: def,
    resolve(account?: string): MailAccountInfo {
      const all = list();
      if (!all.length) throw new Error(en('No mailbox is connected yet (Settings → Email and calendar).'));
      const want = account?.trim().toLowerCase();
      if (!want) return def()!;
      const hit = all.find((x) => x.id === want || x.address.toLowerCase() === want) ?? all.find((x) => x.provider === want || x.kind === want || (want === 'gmail' && x.kind === 'google') || (want === 'outlook' && x.kind === 'microsoft'));
      if (!hit) throw new Error(enf('There is no mailbox "{account}". Connected: {list}.', { account: account ?? '', list: all.map((x) => x.address).join(', ') }));
      return hit;
    },
    provider(id: string): MailProvider {
      if (!a.mail(id)) throw new Error(en('There is no such account.'));
      return m.provider(id);
    },
    googleAccounts: () => m.googleAccounts().map(wrapG).filter((g) => g.status().connected),
    googleOf(id: string) {
      const g = m.googleOf(id);
      return g ? wrapG(g) : undefined;
    },
    combined: () => m.combined().filter((x) => a.mail(x.id)),
    hasOthers: () => list().some((x) => x.kind !== 'google'),
    calendarLinks: m.calendarLinks ? gateLinks(m.calendarLinks, a) : undefined,
  });
}

function gateLinks<T extends object>(links: T, a: ReturnType<typeof allow>): T {
  const v = new Proxy(links, {
    get(t, prop) {
      const val = Reflect.get(t, prop, t) as unknown;
      if (typeof val !== 'function') return val;
      // Reading her calendars (list, events) follows `google`; nothing of them otherwise.
      return (...args: unknown[]) => {
        if (!a.google()) {
          if (prop === 'list' || prop === 'sources') return [];
          if (prop === 'tick') return undefined;
          throw new Error(NOT_ALLOWED);
        }
        return (val as (...x: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  REAL.set(v, links);
  return v;
}

/** Her view of Spotify (not connected for her until allowed). */
export function gateSpotify(sp: SpotifyAccount, access: () => CompanionAccess): SpotifyAccount {
  const a = allow(access);
  return view(sp, {
    status: (): SpotifyStatus => {
      const s = sp.status();
      if (a.spotify()) return s;
      const { name: _n, ...rest } = s;
      void _n;
      return { ...rest, connected: false, canPlaylists: false, canPlayback: false, needsReconnect: false };
    },
    async api(path: string, init?: Parameters<SpotifyAccount['api']>[1]) {
      if (!a.spotify()) throw new Error(NOT_ALLOWED);
      return sp.api(path, init);
    },
  });
}
