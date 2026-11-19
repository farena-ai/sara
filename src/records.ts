// W4.6 (docs/design/W4RECORDS.md, docs/RECORDS.md): public-records report, personal use only. The
// owner types a name, address, phone, email or username (+ city/state to tell people apart); she
// searches free public sources with his web search, reads public pages with the guarded reader
// (robots.txt honoured, bot checks and paywalls never worked around), skips paid data brokers and
// never opens sign-in-only sites (only the public preview a search engine showed is cited), matches
// by code with a confidence per match, and writes a cited report (link + date seen per fact, "not
// found" per empty section) and a PDF with the FCRA notice on every page. Children are refused
// (before any search, and when a matched page says the person is under 18). Every search is one
// audit row. A places-to-search list grows from what worked and starts the next report.
// Files (per owner space): <data>/records/places.json, <data>/records/reports/<id>.json.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { makePdf } from './documents/pdf.ts';
import { writeFileAtomic } from './fs-util.ts';
import { en } from './i18n.ts';
import { searchConfig } from './integrations.ts';
import { robotsAllows } from './learn.ts';
import { privateLocalOn } from './net-guard.ts';
import { fetchPageRetrying, searchRetrying, type FetchedPage } from './research.ts';
import { guardedGet } from './tools/builtin.ts';
import type { SearchResult } from './tools/search.ts';
import { freeSearch } from './tools/shopping.ts';
import { ToolError, type Tool } from './tools/types.ts';

/** The exact notice on every PDF page and at the top of every report (owner's words). */
export const RECORDS_HEADER = 'NOT FCRA COMPLIANT - This information can not be used in housing, loan, employment, or other life altering decisions';

/**
 * Paid people-search / data-broker sites: never read, never cited, never added as a place. A result
 * from one is listed as "skipped (paid broker)". Subdomains count (people.intelius.com).
 */
export const PAID_BROKERS: readonly string[] = [
  'spokeo.com', 'beenverified.com', 'intelius.com', 'truthfinder.com', 'instantcheckmate.com', 'peoplefinders.com', 'whitepages.com', 'mylife.com',
  'peoplelooker.com', 'checkpeople.com', 'ussearch.com', 'publicrecordsnow.com', 'radaris.com', 'zabasearch.com', 'pipl.com', 'peoplesmart.com',
  'nuwber.com', 'anywho.com', 'addresses.com', 'archives.com', 'ancestry.com', 'zoominfo.com', 'lexisnexis.com', 'accurint.com', 'tlo.com',
  'checkmate.com', 'goodhire.com', 'peoplewhiz.com', 'privateeye.com', 'information.com', 'searchquarry.com', 'courtrecords.org', 'backgroundcheck.run',
  'verecor.com', 'veripages.com', 'peoplesearchnow.com', 'instantpeoplefinder.com', 'publicdatacheck.com', 'infotracer.com', 'golookup.com',
  'searchpeoplefree.com', 'smartbackgroundchecks.com', 'peopleconnect.us', 'dataveria.com', 'spyfly.com', 'locatepeople.org', 'recordsfinder.com',
];

/** Sites that show people only after a sign-in: never opened; only a search engine's public preview is cited. */
const SIGN_IN_ONLY = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'threads.net', 'tiktok.com'];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const onList = (url: string, list: readonly string[]) => {
  const h = hostOf(url);
  return Boolean(h) && list.some((d) => h === d || h.endsWith(`.${d}`));
};
export const isPaidBroker = (url: string): boolean => onList(url, PAID_BROKERS);
export const isSignInOnly = (url: string): boolean => onList(url, SIGN_IN_ONLY);

export type RecordType = 'social' | 'news' | 'court' | 'property' | 'business' | 'web';
export const RECORD_TYPES: readonly RecordType[] = ['social', 'news', 'court', 'property', 'business', 'web'];
export const TYPE_LABEL: Record<RecordType, string> = {
  social: 'Profiles and social media',
  news: 'News and mentions',
  court: 'Court records',
  property: 'Property records',
  business: 'Business registrations',
  web: 'Other public pages',
};

export class RecordsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// The query and the child refusal.

export interface RecordsQuery {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
  username?: string;
  city?: string;
  state?: string;
  age?: number;
}
const FIELDS = ['name', 'address', 'phone', 'email', 'username', 'city', 'state'] as const;

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Words that say the person searched for is a child (any of the six languages' common forms in English input). */
const CHILD_RE = /(?<![\p{L}])(child|children|kid|kids|minor|minors|teen|teens|teenager|teenage|toddler|baby|infant|preteen|tween|(my|our|his|her|their) (son|daughter|boy|girl)|(elementary|middle|junior high|high) school( student)?|grade school|(\d|1[0-2])(st|nd|rd|th) grade(r)?|niño|niña|menor|enfant|mineur|kind|minderjährig|criança|bambino|bambina)(?![\p{L}])/iu;
const YEARS_OLD_RE = /(?<!\d)(\d{1,2})[\s-]*(year|yr)s?[\s-]*old/i;

/** True when the text says the person is under 18 (child words, or "N year old" with N < 18). */
export function childSignal(text: string): boolean {
  if (CHILD_RE.test(text)) return true;
  const m = YEARS_OLD_RE.exec(text);
  return Boolean(m && Number(m[1]) < 18);
}

const clipField = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The cleaned query; throws (400) without an identifier or with any under-18 signal. */
export function cleanQuery(input: unknown): RecordsQuery {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const q: RecordsQuery = {};
  const name = clipField(o.name, 100);
  if (name) q.name = name;
  const address = clipField(o.address, 160);
  if (address) q.address = address;
  const phone = String(o.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (phone.length >= 7 && phone.length <= 15) q.phone = phone;
  const email = clipField(o.email, 120).toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) q.email = email;
  const username = clipField(o.username, 60).replace(/^@/, '');
  if (/^[\w.-]{2,60}$/.test(username)) q.username = username;
  const city = clipField(o.city, 60);
  if (city) q.city = city;
  const st = clipField(o.state, 40);
  if (st) {
    const up = st.toUpperCase();
    const code = STATES[up] ? up : Object.keys(STATES).find((k) => STATES[k].toLowerCase() === st.toLowerCase());
    q.state = code ?? st;
  }
  const age = Number(String(o.age ?? '').trim());
  if (String(o.age ?? '').trim() && Number.isFinite(age) && age > 0 && age < 130) q.age = Math.floor(age);
  if (!q.name && !q.address && !q.phone && !q.email && !q.username) throw new RecordsError(400, en('Give a name, address, phone, email or username to search for.'));
  const words = FIELDS.map((f) => q[f] ?? '').join(' ') + ` ${clipField(o.about, 300)}`;
  if ((q.age !== undefined && q.age < 18) || childSignal(words)) throw new RecordsError(400, en('I don’t search for people under 18. Public-records reports are only about adults.'));
  return q;
}

const regionOf = (q: RecordsQuery): string => (q.state && STATES[q.state] ? `US-${q.state}` : 'any');
const phoneText = (p: string) => (p.length === 10 ? `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}` : p);
export const subjectOf = (q: RecordsQuery): string => q.name ?? q.username ?? q.email ?? (q.phone ? phoneText(q.phone) : undefined) ?? q.address ?? '';

// ---------------------------------------------------------------------------------------------
// Places to search (the growing skill).

export type PlaceStatus = 'works' | 'new' | 'failing' | 'paid' | 'off';
export interface Place {
  id: string;
  domain: string;
  types: RecordType[];
  /** 'any', 'US' or 'US-XX' (a state). */
  region: string;
  /** What the site holds, in her words. */
  holds: string;
  /** How to search it: a query with {name} {city} {state} {phone} {email} {username} {address}. */
  how: string;
  status: PlaceStatus;
  origin: 'starter' | 'learned' | 'owner';
  hits: number;
  fails: number;
  lastUsed?: string;
  note?: string;
}

const starter = (domain: string, types: RecordType[], region: string, holds: string, how: string): Place => ({ id: `s-${domain}`, domain, types, region, holds, how, status: 'new', origin: 'starter', hits: 0, fails: 0 });
/** Free places she starts with (each free to view without a sign-in). */
export const STARTER_PLACES: readonly Place[] = [
  starter('courtlistener.com', ['court'], 'any', 'Court opinions, oral arguments and federal dockets (Free Law Project)', 'site:courtlistener.com "{name}"'),
  starter('dockets.justia.com', ['court'], 'US', 'Federal court dockets by party name', 'site:dockets.justia.com "{name}"'),
  starter('opencorporates.com', ['business'], 'any', 'Company registrations and officers from public registries', 'site:opencorporates.com "{name}"'),
  starter('sec.gov', ['business'], 'US', 'SEC filings (EDGAR): company officers, directors and insiders', 'site:sec.gov "{name}"'),
  starter('search.sunbiz.org', ['business'], 'US-FL', 'Florida business registrations and officers', 'site:search.sunbiz.org "{name}"'),
  starter('bizfileonline.sos.ca.gov', ['business'], 'US-CA', 'California business entities and agents', 'site:bizfileonline.sos.ca.gov "{name}"'),
  starter('fec.gov', ['web'], 'US', 'Federal political donations (name, city, employer)', 'site:fec.gov "{name}" {city}'),
  starter('legacy.com', ['news'], 'US', 'Obituaries and guest books', 'site:legacy.com "{name}" {city}'),
  starter('patch.com', ['news'], 'US', 'Local news by town', 'site:patch.com "{name}" {city}'),
  starter('qpublic.schneidercorp.com', ['property'], 'US', 'County property and tax records (many US counties)', 'site:qpublic.schneidercorp.com "{name}"'),
  starter('github.com', ['social'], 'any', 'Public developer profiles and projects', 'site:github.com "{username}"'),
  starter('reddit.com', ['social'], 'any', 'Public posts and comments by username', 'site:reddit.com/user "{username}"'),
  starter('keybase.io', ['social'], 'any', 'Public identity proofs linking accounts', 'site:keybase.io "{username}"'),
  starter('linkedin.com', ['social'], 'any', 'Work profiles (sign-in site: only the search preview is used)', 'site:linkedin.com/in "{name}" {city}'),
  starter('facebook.com', ['social'], 'any', 'Profiles (sign-in site: only the search preview is used)', 'site:facebook.com "{name}" {city}'),
];

const fill = (how: string, q: RecordsQuery): string | null => {
  const vals: Record<string, string | undefined> = { name: q.name, city: q.city, state: q.state, phone: q.phone ? phoneText(q.phone) : undefined, email: q.email, username: q.username, address: q.address };
  let missing = false;
  const out = how.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vals[k];
    if (!v) {
      // City and state are helpers: a query may go without them; the identifier it is about may not.
      if (k !== 'city' && k !== 'state') missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out.replace(/""/g, '').replace(/\s+/g, ' ').trim();
};

// ---------------------------------------------------------------------------------------------
// Reports.

export type SourceStatus = 'read' | 'preview' | 'broker' | 'robots' | 'bot-wall' | 'paid' | 'sign-in' | 'failed' | 'not-found' | 'no-match';
export interface RecordSource {
  n: number;
  url: string;
  domain: string;
  title: string;
  seen: string;
  status: SourceStatus;
  detail?: string;
}
export type Confidence = 'high' | 'medium' | 'low';
export interface RecordFact {
  n: number;
  section: RecordType;
  title: string;
  url: string;
  domain: string;
  seen: string;
  quote: string;
  confidence: Confidence;
  /** What matched: name, city, state, phone, email, username, address. */
  why: string[];
  via: 'page' | 'preview';
  /** Other sites that share an identifier with this one (cross-checked). */
  cross: number;
}
export interface RecordsReport {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'done' | 'stopped' | 'refused' | 'failed';
  refusal?: string;
  error?: string;
  query: RecordsQuery;
  subject: string;
  rounds: number;
  facts: RecordFact[];
  sources: RecordSource[];
  searches: { q: string; at: string; results: number; round: number; failed?: boolean }[];
  pending: { q: string; place?: string }[];
  queued: { url: string; title: string; snippet: string; place?: string }[];
}

/** Test seams only: fake search results, pages and robots files. */
export const recordsDeps: {
  search?: (q: string, signal: AbortSignal) => Promise<SearchResult[]>;
  fetch?: (url: string, signal: AbortSignal) => Promise<FetchedPage | 'aborted'>;
  robots?: (origin: string, signal: AbortSignal) => Promise<string>;
} = {};

export const RECORDS = { searchesPerRound: 8, pagesPerRound: 14, resultsPerSearch: 8, keepReports: 30, failLimit: 3, quoteChars: 260 };

const PAYWALL_RE = /subscribe to (view|see|unlock)|unlock (the )?full (report|record|profile)|view (the )?full report|membership required|sign up to (view|see)|\$\d+(\.\d{2})? (to|for) (view|see|unlock)|pay(ment)? required to view|purchase (the |this )?(full )?report/i;
const SIGNIN_WALL_RE = /(sign|log) ?in to (see|view|continue)|create an account to (see|view)|you must be logged in/i;
const SOCIAL_RE = /(^|\.)(github\.com|gitlab\.com|reddit\.com|keybase\.io|mastodon\.social|medium\.com|youtube\.com|pinterest\.com|tumblr\.com|flickr\.com|about\.me|linktr\.ee|bsky\.app|substack\.com)$/;
const NEWS_RE = /news|times|post|tribune|herald|gazette|journal|courier|chronicle|patch\.com|apnews|reuters|legacy\.com|obituar/i;
const COURT_RE = /court|docket|justia|judici|case(law|text)|unicourt|pacer/i;
const PROPERTY_RE = /assessor|parcel|property|deeds?\b|recorder|appraisal|qpublic|tax ?collector|gis\./i;
const BUSINESS_RE = /opencorporates|sec\.gov|sos\.|sunbiz|bizfile|corporation|business ?search|secretary ?of ?state|companies ?house|llc/i;

function sectionFor(url: string, title: string, snippet: string, place?: Place): RecordType {
  if (place?.types[0]) return place.types[0];
  const h = hostOf(url);
  if (SOCIAL_RE.test(h) || onList(url, SIGN_IN_ONLY)) return 'social';
  if (COURT_RE.test(h) || /\b(docket|plaintiff|defendant|case no)\b/i.test(title)) return 'court';
  if (BUSINESS_RE.test(h)) return 'business';
  if (PROPERTY_RE.test(h) || /\b(parcel|assessed value|deed)\b/i.test(title)) return 'property';
  if (NEWS_RE.test(h) || /\bobituar/i.test(`${title} ${snippet}`)) return 'news';
  return 'web';
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameRe(name: string): RegExp {
  const parts = name.split(/\s+/).filter((p) => p.replace(/\./g, '').length > 1);
  const first = parts[0];
  const last = parts.at(-1)!;
  if (parts.length < 2) return new RegExp(`(?<![\\p{L}])${esc(first)}(?![\\p{L}])`, 'iu');
  // "Jordan Testperson", "Jordan Q. Testperson", "Testperson, Jordan".
  return new RegExp(`(?<![\\p{L}])(${esc(first)}(\\s+[\\p{L}]\\.?){0,2}\\s+${esc(last)}|${esc(last)},\\s*${esc(first)})(?![\\p{L}])`, 'iu');
}

interface Match {
  why: string[];
  confidence: Confidence;
  quote: string;
}

/** What a text says about the person searched for; null when the name (or the identifier) is not there. */
export function matchText(q: RecordsQuery, text: string): Match | null {
  const t = text.replace(/\s+/g, ' ');
  const why: string[] = [];
  let at = -1;
  if (q.name) {
    const m = nameRe(q.name).exec(t);
    if (!m) return null;
    why.push('name');
    at = m.index;
  }
  if (q.phone) {
    const digits = q.phone.slice(-10).split('');
    const re = new RegExp(digits.map(esc).join('[\\s().-]{0,2}'));
    const m = re.exec(t);
    if (m) (why.push('phone'), at < 0 && (at = m.index));
  }
  if (q.email) {
    const i = t.toLowerCase().indexOf(q.email);
    if (i >= 0) (why.push('email'), at < 0 && (at = i));
  }
  if (q.username) {
    const m = new RegExp(`(?<![\\w.-])@?${esc(q.username)}(?![\\w-])`, 'i').exec(t);
    if (m) (why.push('username'), at < 0 && (at = m.index));
  }
  if (q.address) {
    const num = /\d+/.exec(q.address)?.[0];
    const word = q.address.replace(/^\s*\d+\s*/, '').split(/\s+/)[0];
    const m = num && word ? new RegExp(`(?<!\\d)${esc(num)}\\s+${esc(word)}`, 'i').exec(t) : null;
    if (m) (why.push('address'), at < 0 && (at = m.index));
  }
  if (q.city && new RegExp(`(?<![\\p{L}])${esc(q.city)}(?![\\p{L}])`, 'iu').test(t)) why.push('city');
  if (q.state) {
    const full = STATES[q.state];
    if (new RegExp(`(?<![A-Za-z])${esc(q.state)}(?![A-Za-z])`).test(t) || (full && new RegExp(`(?<![\\p{L}])${esc(full)}(?![\\p{L}])`, 'iu').test(t))) why.push('state');
  }
  if (at < 0) return null;
  const extra = why.filter((w) => w !== 'name').length;
  const confidence: Confidence = q.name ? (extra >= 2 ? 'high' : extra === 1 ? 'medium' : 'low') : extra >= 3 ? 'high' : extra === 2 ? 'medium' : 'low';
  return { why, confidence, quote: quoteAround(t, at) };
}

function quoteAround(t: string, at: number): string {
  const start = Math.max(t.lastIndexOf('. ', at) + 2, at - 160, 0);
  let end = t.indexOf('. ', at);
  end = end < 0 ? t.length : end + 1;
  const s = t.slice(start === 1 ? 0 : start, Math.min(end, start + RECORDS.quoteChars)).trim();
  return s.length < t.length && end > start + RECORDS.quoteChars ? `${s}…` : s;
}

/** A matched page that says the person is under 18 ("Name, 16,", "16-year-old Name", "age 16" near the name). */
export function minorOnPage(q: RecordsQuery, text: string): boolean {
  if (!q.name) return false;
  const t = text.replace(/\s+/g, ' ');
  const re = new RegExp(nameRe(q.name).source, 'giu');
  for (const m of t.matchAll(re)) {
    const near = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const ageAfter = /^\s*,\s*(\d{1,2})\s*,/.exec(after);
    if (ageAfter && Number(ageAfter[1]) < 18) return true;
    for (const a of near.matchAll(/(?<!\d)(\d{1,2})[\s-]*(year|yr)s?[\s-]*old|\bage[sd]?\s*(\d{1,2})\b/gi)) if (Number(a[1] ?? a[3]) < 18) return true;
    if (/(?<![\p{L}])(middle school|elementary school|high school student|freshman at .{0,30}high|youth league|grade \d|\d(st|nd|rd|th) grade)(?![\p{L}])/iu.test(near)) return true;
  }
  return false;
}

const BUMP: Record<Confidence, Confidence> = { low: 'medium', medium: 'high', high: 'high' };
const STRONG = ['phone', 'email', 'username', 'address'];

// ---------------------------------------------------------------------------------------------

export class Records {
  readonly #app: AppContext;
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #work = new Map<string, { ctl: AbortController; done: Promise<void> }>();
  #places: Place[] | null = null;

  constructor(app: AppContext, dataDir: string, o: { now?: () => Date } = {}) {
    this.#app = app;
    this.#dir = join(dataDir, 'records');
    this.#now = o.now ?? (() => new Date());
  }

  // ---- places ----
  places(): Place[] {
    if (this.#places) return this.#places;
    let saved: Place[] = [];
    try {
      const raw = JSON.parse(readFileSync(join(this.#dir, 'places.json'), 'utf8')) as { places?: Place[] };
      saved = Array.isArray(raw.places) ? raw.places : [];
    } catch {
      /* first use */
    }
    const have = new Set(saved.map((p) => p.id));
    // Starter places the owner removed stay removed (kept as 'off' rows); new starters join.
    this.#places = [...saved, ...STARTER_PLACES.filter((p) => !have.has(p.id)).map((p) => ({ ...p, types: [...p.types] }))];
    return this.#places;
  }
  #savePlaces(): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileAtomic(join(this.#dir, 'places.json'), JSON.stringify({ version: 1, places: this.places() }, null, 1));
  }
  /** Adds or edits a place (the owner's edit); a paid broker is refused. */
  savePlace(input: Partial<Place> & { domain: string }): Place {
    const domain = hostOf(`https://${String(input.domain).replace(/^https?:\/\//, '').split('/')[0]}`);
    if (!domain || !/\./.test(domain)) throw new RecordsError(400, en('Give the site as a web address, like courtlistener.com.'));
    if (isPaidBroker(`https://${domain}/`)) throw new RecordsError(400, en('That site is a paid data broker: it can’t be a place to search.'));
    const types = (Array.isArray(input.types) ? input.types : []).filter((x): x is RecordType => RECORD_TYPES.includes(x as RecordType));
    const how = clipField(input.how, 200) || `site:${domain} "{name}"`;
    if (!/\{(name|phone|email|username|address)\}/.test(how)) throw new RecordsError(400, en('The search needs {name}, {phone}, {email}, {username} or {address} in it.'));
    const region = /^(any|US|US-[A-Z]{2})$/.test(String(input.region ?? '')) ? String(input.region) : 'any';
    const status: PlaceStatus = (['works', 'new', 'failing', 'paid', 'off'] as const).includes(input.status as PlaceStatus) ? (input.status as PlaceStatus) : 'new';
    const list = this.places();
    const old = input.id ? list.find((p) => p.id === input.id) : undefined;
    const row: Place = old
      ? { ...old, domain, types: types.length ? types : old.types, region, holds: clipField(input.holds, 200) || old.holds, how, status, ...(input.note !== undefined ? { note: clipField(input.note, 200) } : {}) }
      : { id: `o-${randomBytes(4).toString('hex')}`, domain, types: types.length ? types : ['web'], region, holds: clipField(input.holds, 200) || domain, how, status, origin: 'owner', hits: 0, fails: 0 };
    if (old) list[list.indexOf(old)] = row;
    else list.push(row);
    this.#savePlaces();
    return row;
  }
  removePlace(id: string): void {
    const list = this.places();
    const p = list.find((x) => x.id === id);
    if (!p) throw new RecordsError(404, en('That place is not on the list.'));
    // A starter place stays as 'off' so it doesn't come back with the next update.
    if (p.origin === 'starter') p.status = 'off';
    else list.splice(list.indexOf(p), 1);
    this.#savePlaces();
  }
  #placeFor(url: string): Place | undefined {
    const h = hostOf(url);
    return this.places().find((p) => h === p.domain || h.endsWith(`.${p.domain}`));
  }

  // ---- reports ----
  #file(id: string) {
    return join(this.#dir, 'reports', `${id}.json`);
  }
  #save(r: RecordsReport): void {
    r.updatedAt = this.#now().toISOString();
    mkdirSync(join(this.#dir, 'reports'), { recursive: true });
    writeFileAtomic(this.#file(r.id), JSON.stringify(r));
  }
  get(id: string): RecordsReport | undefined {
    if (!/^pr-[a-f0-9]{8}$/.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.#file(id), 'utf8')) as RecordsReport;
    } catch {
      return undefined;
    }
  }
  list(): RecordsReport[] {
    const d = join(this.#dir, 'reports');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((r): r is RecordsReport => Boolean(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  remove(id: string): void {
    this.#work.get(id)?.ctl.abort();
    if (!this.get(id)) throw new RecordsError(404, en('That report is gone.'));
    rmSync(this.#file(id), { force: true });
  }
  /** Waits for every running round (tests, the tool). */
  async idle(): Promise<void> {
    while (this.#work.size) await Promise.all([...this.#work.values()].map((w) => w.done));
  }
  async waitFor(id: string, ms: number): Promise<void> {
    const w = this.#work.get(id);
    if (w) await Promise.race([w.done, new Promise((r) => setTimeout(r, ms).unref?.())]);
  }
  stop(id: string): RecordsReport {
    const r = this.get(id);
    if (!r) throw new RecordsError(404, en('That report is gone.'));
    this.#work.get(id)?.ctl.abort();
    return this.get(id)!;
  }
  close(): void {
    for (const w of this.#work.values()) w.ctl.abort();
  }

  /** Starts a report (round 1 runs in the background). Throws on refusals (logged in the audit trail). */
  start(input: unknown, o: { channel?: string } = {}): RecordsReport {
    const channel = o.channel ?? 'web';
    if (privateLocalOn()) throw new RecordsError(409, en('“Nothing leaves this computer” is on, so she can’t search the web for a report.'));
    let q: RecordsQuery;
    try {
      q = cleanQuery(input);
    } catch (err) {
      audit({ action: 'records.refused', who: 'owner', role: 'owner', channel, outcome: 'refused', content: (err as Error).message });
      throw err;
    }
    const now = this.#now().toISOString();
    const r: RecordsReport = { id: `pr-${randomBytes(4).toString('hex')}`, createdAt: now, updatedAt: now, status: 'running', query: q, subject: subjectOf(q), rounds: 0, facts: [], sources: [], searches: [], pending: this.#plan(q), queued: [] };
    audit({ action: 'records.report', who: 'owner', role: 'owner', channel, target: r.id, outcome: 'ok', keys: FIELDS.filter((f) => q[f]) });
    this.#save(r);
    this.#prune();
    this.#round(r, channel);
    return r;
  }

  /** "Find more sources": another round from what is left (untried searches, unread results, places). */
  more(id: string, o: { channel?: string } = {}): RecordsReport {
    const r = this.get(id);
    if (!r) throw new RecordsError(404, en('That report is gone.'));
    if (r.status === 'refused') throw new RecordsError(409, en('This report was refused: the person may be under 18.'));
    if (this.#work.has(id)) return r;
    if (privateLocalOn()) throw new RecordsError(409, en('“Nothing leaves this computer” is on, so she can’t search the web for a report.'));
    const done = new Set(r.searches.map((s) => s.q));
    // New places learned since (or by another report) join the queue.
    for (const p of this.#plan(r.query, true)) if (!done.has(p.q) && !r.pending.some((x) => x.q === p.q)) r.pending.push(p);
    r.status = 'running';
    this.#save(r);
    this.#round(r, o.channel ?? 'web');
    return r;
  }

  /** The searches for a query: the identifiers first, then places that worked, then new ones, then wider searches. */
  #plan(q: RecordsQuery, later = false): { q: string; place?: string }[] {
    const out: { q: string; place?: string }[] = [];
    const add = (s: string | null, place?: string) => {
      if (s && !out.some((x) => x.q === s)) out.push({ q: s, ...(place ? { place } : {}) });
    };
    const where = [q.city, q.state].filter(Boolean).join(' ');
    if (!later) {
      if (q.name) add(`"${q.name}" ${where}`.trim());
      if (q.phone) add(`"${phoneText(q.phone)}"`);
      if (q.email) add(`"${q.email}"`);
      if (q.username) add(`"${q.username}"`);
      if (q.address) add(`"${q.address}" ${q.city ?? ''}`.trim());
    }
    const region = regionOf(q);
    const rank = { owner: 0, learned: 1, starter: 2 } as const;
    const fits = (p: Place) => p.region === 'any' || p.region === region || (p.region === 'US' && (region.startsWith('US') || !q.state));
    const usable = this.places()
      .filter((p) => (p.status === 'works' || p.status === 'new') && fits(p))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'works' ? -1 : 1) || b.hits - a.hits || rank[a.origin] - rank[b.origin]);
    for (const p of usable) add(fill(p.how, q), p.id);
    if (q.name) {
      add(`"${q.name}" ${q.city ?? ''} news OR obituary`.replace(/\s+/g, ' '));
      add(`"${q.name}" ${STATES[q.state ?? ''] ?? q.state ?? ''} court case`.replace(/\s+/g, ' '));
      add(`"${q.name}" ${where} property OR deed OR parcel`.replace(/\s+/g, ' '));
      add(`"${q.name}" ${q.state ?? ''} LLC OR corporation OR "registered agent"`.replace(/\s+/g, ' '));
    }
    return out;
  }

  #round(r: RecordsReport, channel: string): void {
    const ctl = new AbortController();
    const done = this.#runRound(r, channel, ctl.signal)
      .catch((err) => {
        const cur = this.get(r.id) ?? r;
        cur.status = 'failed';
        cur.error = (err as Error).message.slice(0, 300);
        this.#save(cur);
      })
      .finally(() => this.#work.delete(r.id));
    this.#work.set(r.id, { ctl, done });
  }

  async #search(q: string, signal: AbortSignal): Promise<SearchResult[]> {
    if (recordsDeps.search) return recordsDeps.search(q, signal);
    const cfg = searchConfig(this.#app.settings, this.#app.vault);
    return cfg ? searchRetrying(cfg, q, RECORDS.resultsPerSearch, signal) : freeSearch(q, signal);
  }
  async #robots(origin: string, signal: AbortSignal): Promise<string> {
    if (recordsDeps.robots) return recordsDeps.robots(origin, signal);
    try {
      const g = await guardedGet(new URL('/robots.txt', origin), { signal, allowPrivate: false, timeoutMs: 10_000 });
      return g.status >= 200 && g.status < 300 && /text\/plain/i.test(g.contentType) ? g.text.slice(0, 200_000) : '';
    } catch {
      return '';
    }
  }

  async #runRound(r: RecordsReport, channel: string, signal: AbortSignal): Promise<void> {
    r.rounds += 1;
    const round = r.rounds;
    const today = this.#now().toISOString().slice(0, 10);
    const seenUrls = new Set(r.sources.map((s) => s.url));
    const placesTouched = new Set<string>();
    const touch = (p: Place | undefined, hit: boolean, fail: boolean) => {
      if (!p) return;
      placesTouched.add(p.id);
      p.lastUsed = today;
      if (hit) (p.hits += 1, (p.status = p.status === 'off' ? 'off' : 'works'));
      if (fail) {
        p.fails += 1;
        if (p.fails >= RECORDS.failLimit && p.hits === 0 && p.status !== 'off') p.status = 'failing';
      }
    };
    const addSource = (s: Omit<RecordSource, 'n'>): RecordSource => {
      const row = { n: r.sources.length + 1, ...s };
      r.sources.push(row);
      seenUrls.add(s.url);
      return row;
    };
    let refused = false;

    // 1. Searches.
    let searches = 0;
    while (r.pending.length && searches < RECORDS.searchesPerRound && !signal.aborted) {
      const next = r.pending.shift()!;
      if (r.searches.some((s) => s.q === next.q)) continue;
      searches++;
      let results: SearchResult[] = [];
      let failed = false;
      try {
        results = await this.#search(next.q, signal);
      } catch {
        failed = true;
      }
      if (signal.aborted) break;
      audit({ action: 'records.search', who: 'owner', role: 'owner', channel, target: r.id, outcome: failed ? 'failed' : 'ok', content: next.q });
      r.searches.push({ q: next.q, at: this.#now().toISOString(), results: results.length, round, ...(failed ? { failed: true } : {}) });
      const place = next.place ? this.places().find((p) => p.id === next.place) : undefined;
      if (place && (failed || !results.length)) touch(place, false, failed);
      for (const x of results.slice(0, RECORDS.resultsPerSearch)) {
        if (!/^https?:\/\//.test(x.url) || seenUrls.has(x.url) || r.queued.some((y) => y.url === x.url)) continue;
        r.queued.push({ url: x.url, title: clipField(x.title, 200), snippet: clipField(x.snippet, 500), ...(next.place ? { place: next.place } : {}) });
      }
      this.#save(r);
    }

    // 2. Results: skip brokers, cite previews of sign-in sites, read the rest (robots first).
    const robots = new Map<string, string>();
    let pages = 0;
    while (r.queued.length && pages < RECORDS.pagesPerRound && !signal.aborted && !refused) {
      const item = r.queued.shift()!;
      if (seenUrls.has(item.url)) continue;
      const domain = hostOf(item.url);
      const place = this.#placeFor(item.url);
      const base = { url: item.url, domain, title: item.title || domain, seen: today };
      if (isPaidBroker(item.url)) {
        addSource({ ...base, status: 'broker' });
        continue;
      }
      const section = sectionFor(item.url, item.title, item.snippet, place);
      if (isSignInOnly(item.url)) {
        const m = matchText(r.query, `${item.title}. ${item.snippet}`);
        if (m && minorOnPage(r.query, `${item.title}. ${item.snippet}`) && m.confidence !== 'low') {
          refused = true;
          break;
        }
        const src = addSource({ ...base, status: m ? 'preview' : 'no-match' });
        if (m) r.facts.push({ n: src.n, section, title: base.title, url: item.url, domain, seen: today, quote: m.quote, confidence: m.confidence, why: m.why, via: 'preview', cross: 0 });
        touch(place, Boolean(m), false);
        continue;
      }
      const origin = new URL(item.url).origin;
      if (!robots.has(origin)) robots.set(origin, await this.#robots(origin, signal));
      const u = new URL(item.url);
      if (!robotsAllows(robots.get(origin)!, u.pathname + u.search)) {
        addSource({ ...base, status: 'robots' });
        continue;
      }
      pages++;
      const got = recordsDeps.fetch ? await recordsDeps.fetch(item.url, signal) : await fetchPageRetrying(item.url, signal);
      if (got === 'aborted' || signal.aborted) {
        r.queued.unshift(item);
        break;
      }
      if (!got.ok) {
        const status: SourceStatus = got.reason === 'bot-wall' ? 'bot-wall' : got.reason === 'not-found' ? 'not-found' : 'failed';
        addSource({ ...base, status, ...(got.detail ? { detail: got.detail } : {}) });
        touch(place, false, true);
        continue;
      }
      const text = `${got.title}. ${got.text}`;
      if (PAYWALL_RE.test(text)) {
        addSource({ ...base, status: 'paid' });
        if (place) place.status = 'paid';
        else this.places().push({ id: `l-${randomBytes(4).toString('hex')}`, domain, types: [section], region: regionOf(r.query), holds: en('Shows records only after payment'), how: `site:${domain} "{name}"`, status: 'paid', origin: 'learned', hits: 0, fails: 1, lastUsed: today });
        continue;
      }
      if (SIGNIN_WALL_RE.test(text) && text.length < 1500) {
        addSource({ ...base, status: 'sign-in' });
        touch(place, false, true);
        continue;
      }
      const m = matchText(r.query, text);
      if (m && m.confidence !== 'low' && minorOnPage(r.query, text)) {
        refused = true;
        break;
      }
      const src = addSource({ ...base, title: got.title || base.title, status: m ? 'read' : 'no-match' });
      if (!m) {
        touch(place, false, false);
        continue;
      }
      r.facts.push({ n: src.n, section, title: src.title, url: item.url, domain, seen: today, quote: m.quote, confidence: m.confidence, why: m.why, via: 'page', cross: 0 });
      touch(place, true, false);
      // Learn the site: a new place with what it held and how it was found.
      if (!place && m.confidence !== 'low') {
        const key = r.query.name ? 'name' : (['phone', 'email', 'username', 'address'] as const).find((k) => m.why.includes(k)) ?? 'name';
        this.places().push({ id: `l-${randomBytes(4).toString('hex')}`, domain, types: [section], region: regionOf(r.query), holds: `${TYPE_LABEL[section]}: ${clipField(got.title, 100) || domain}`, how: `site:${domain} "{${key}}"`, status: 'works', origin: 'learned', hits: 1, fails: 0, lastUsed: today });
      }
      this.#save(r);
    }

    if (refused) {
      // A child: nothing is kept, and the report can't be continued.
      r.facts = [];
      r.sources = [];
      r.queued = [];
      r.pending = [];
      r.status = 'refused';
      r.refusal = en('A page about this name says the person is under 18, so the report was stopped and nothing was kept. Public-records reports are only about adults.');
      audit({ action: 'records.refused', who: 'owner', role: 'owner', channel, target: r.id, outcome: 'refused', content: 'under-18 signal on a matched page' });
      this.#save(r);
      this.#savePlaces();
      return;
    }

    // 3. Cross-checks: a strong identifier seen on two or more sites raises each match one step.
    for (const f of r.facts) {
      const others = new Set(r.facts.filter((g) => g.domain !== f.domain && g.why.some((w) => STRONG.includes(w) && f.why.includes(w))).map((g) => g.domain));
      const before = f.cross;
      f.cross = others.size;
      if (others.size && !before) f.confidence = BUMP[f.confidence];
    }
    r.status = signal.aborted ? 'stopped' : 'done';
    this.#save(r);
    this.#savePlaces();
  }

  #prune(): void {
    for (const old of this.list().slice(RECORDS.keepReports)) if (!this.#work.has(old.id)) rmSync(this.#file(old.id), { force: true });
  }

  /** The report's sections, in order, with "not found" for empty ones. */
  sections(r: RecordsReport): { type: RecordType; label: string; facts: RecordFact[]; notFound: boolean }[] {
    const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
    return RECORD_TYPES.map((type) => {
      const facts = r.facts.filter((f) => f.section === type).sort((a, b) => order[a.confidence] - order[b.confidence]);
      return { type, label: TYPE_LABEL[type], facts, notFound: facts.length === 0 };
    });
  }

  /** The report as Markdown (the PDF's source): cover, sections, sources appendix, searches. */
  markdown(id: string): string {
    const r = this.get(id);
    if (!r) throw new RecordsError(404, en('That report is gone.'));
    // Underscores stay as they are (addresses like us_il); the PDF reader keeps "\_" literally.
    const md = (s: string) => s.replace(/([\\`*[\]#<>|])/g, '\\$1');
    const many = (k: number, one: string, more: string) => `${k} ${k === 1 ? one : more}`;
    const date = r.updatedAt.slice(0, 10);
    const q = r.query;
    const asked = [q.name && `Name: ${q.name}`, q.address && `Address: ${q.address}`, q.phone && `Phone: ${phoneText(q.phone)}`, q.email && `Email: ${q.email}`, q.username && `Username: ${q.username}`, q.city && `City: ${q.city}`, q.state && `State: ${q.state}`, q.age && `Age: ${q.age}`].filter(Boolean) as string[];
    const count = (c: Confidence) => r.facts.filter((f) => f.confidence === c).length;
    const out: string[] = [
      `# Public records report: ${md(r.subject)}`,
      '',
      `**${RECORDS_HEADER}.**`,
      '',
      `Prepared ${date} for personal use only. Free public sources only: no paid data brokers, no sign-in-only sites, no bypassed site rules.`,
      '',
      '## What was searched',
      '',
      ...asked.map((a) => `- ${md(a)}`),
      '',
      '## Summary',
      '',
      `- ${r.facts.length} matching facts from ${new Set(r.facts.map((f) => f.domain)).size} sites (${count('high')} high, ${count('medium')} medium and ${count('low')} low confidence).`,
      `- ${r.searches.length} searches over ${r.rounds} round${r.rounds === 1 ? '' : 's'}; ${r.sources.length} results looked at.`,
      `- Skipped: ${many(r.sources.filter((s) => s.status === 'broker').length, 'paid broker result', 'paid broker results')}, ${many(r.sources.filter((s) => s.status === 'robots').length, 'page', 'pages')} the site asks robots not to read, ${many(r.sources.filter((s) => s.status === 'bot-wall' || s.status === 'sign-in').length, 'page', 'pages')} behind a bot check or sign-in, ${many(r.sources.filter((s) => s.status === 'paid').length, 'page that wants', 'pages that want')} payment.`,
      '- Confidence: high = the name and two or more other details match; medium = one other detail; low = the name only (could be someone else with the same name). A detail seen on two sites raises a match one step.',
      '',
      '[page break]',
      '',
    ];
    for (const s of this.sections(r)) {
      out.push(`## ${s.label}`, '');
      if (s.notFound) out.push(`Not found: no free public source in this search matched for ${TYPE_LABEL[s.type].toLowerCase()}.`, '');
      for (const f of s.facts) out.push(`- **${md(f.title)}** (${f.confidence} confidence: ${f.why.join(', ')}${f.cross ? `; also on ${f.cross} other site${f.cross === 1 ? '' : 's'}` : ''}${f.via === 'preview' ? '; search preview only' : ''}): “${md(f.quote)}” [${md(f.domain)}](${f.url}), seen ${f.seen} [${f.n}]`);
      out.push('');
    }
    out.push('[page break]', '', '## Sources', '');
    const word: Record<SourceStatus, string> = { read: 'read', preview: 'search preview (sign-in site, not opened)', broker: 'skipped: paid broker', robots: 'skipped: robots.txt', 'bot-wall': 'not read: bot check', paid: 'not used: wants payment', 'sign-in': 'not read: sign-in wall', failed: 'could not be read', 'not-found': 'page not found', 'no-match': 'read, no match' };
    for (const s of r.sources) out.push(`${s.n}. ${md(s.title)}: [${md(s.url)}](${s.url}) (seen ${s.seen}; ${word[s.status]})`);
    if (!r.sources.length) out.push('No sources.');
    out.push('', '## Searches run', '');
    for (const s of r.searches) out.push(`- ${md(s.q)} (${s.results} results${s.failed ? ', search failed' : ''}; round ${s.round})`);
    return out.join('\n');
  }

  pdf(id: string): Buffer {
    const r = this.get(id);
    if (!r) throw new RecordsError(404, en('That report is gone.'));
    return makePdf({ format: 'pdf', title: `Public records report: ${r.subject}`, template: 'report', content: this.markdown(id), pageHeader: RECORDS_HEADER }, () => undefined);
  }
}

const engines = new WeakMap<AppContext, Records>();
/** The owner's records engine; undefined for household members, kids and the demo. */
export function recordsOf(app: AppContext): Records | undefined {
  if (app.member || (app as { demo?: boolean }).demo) return undefined;
  let r = engines.get(app);
  if (!r) engines.set(app, (r = new Records(app, app.dataDir)));
  return r;
}

const opt = (args: Record<string, unknown>, k: string) => (typeof args[k] === 'string' || typeof args[k] === 'number' ? String(args[k]) : '');

/** One line per fact for the chat answer. */
export function factLines(r: RecordsReport, max = 8): string[] {
  const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return [...r.facts]
    .sort((a, b) => order[a.confidence] - order[b.confidence])
    .slice(0, max)
    .map((f) => `- [${f.confidence}] ${TYPE_LABEL[f.section]}: “${f.quote.slice(0, 160)}” (${f.url}, seen ${f.seen})`);
}

export function createRecordsTools(getApp: () => AppContext): Tool[] {
  return [
    {
      defaultPermission: 'ask',
      interruptible: true,
      changes: false,
      isAvailable: () => Boolean(recordsOf(getApp())) && !privateLocalOn(),
      spec: {
        name: 'records_report',
        description:
          'Public-records report (personal use only, the owner only): search free public sources (search engines, public profiles, news, free court, property and business registries) for an ADULT by name, address, phone, email or username, and write a cited report with a confidence per match and a PDF. Never paid data brokers or sign-in sites. Refuses anyone under 18. Give city and state to tell people with the same name apart. When the owner says "find more sources" about a report, call it again with more_of set to that report id. Example: {"name":"Jane Doe","city":"Springfield","state":"IL"}.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Full name of the adult.' },
            address: { type: 'string', description: 'Street address.' },
            phone: { type: 'string' },
            email: { type: 'string' },
            username: { type: 'string', description: 'An online username or handle.' },
            city: { type: 'string', description: 'City, to tell people with the same name apart.' },
            state: { type: 'string', description: 'State (US), e.g. IL.' },
            age: { type: 'number', description: 'Approximate age, if known.' },
            more_of: { type: 'string', description: 'A report id (pr-…): find more sources for that report instead of starting a new one.' },
          },
          additionalProperties: false,
        },
      },
      summarize: (a) => `public records report ${a.more_of ? `(more sources for ${String(a.more_of)})` : `on “${String(a.name ?? a.username ?? a.email ?? a.phone ?? a.address ?? '').slice(0, 80)}”`}`,
      async run(args, ctx) {
        const records = recordsOf(getApp());
        if (!records) throw new ToolError('Public-records reports are the owner’s only.');
        try {
          const more = opt(args, 'more_of');
          const started = more ? records.more(more, { channel: 'chat' }) : records.start({ name: opt(args, 'name'), address: opt(args, 'address'), phone: opt(args, 'phone'), email: opt(args, 'email'), username: opt(args, 'username'), city: opt(args, 'city'), state: opt(args, 'state'), age: opt(args, 'age') }, { channel: 'chat' });
          await Promise.race([records.waitFor(started.id, 120_000), new Promise((res) => ctx.signal?.addEventListener('abort', res, { once: true }))]);
          const r = records.get(started.id)!;
          if (r.status === 'refused') return r.refusal ?? 'Refused.';
          const missing = records.sections(r).filter((s) => s.notFound).map((s) => s.label.toLowerCase());
          return [
            `Public records report ${r.id} on “${r.subject}” (${r.status === 'running' ? 'still searching' : r.status}, round ${r.rounds}): ${r.facts.length} matching facts from ${new Set(r.facts.map((f) => f.domain)).size} sites, ${r.searches.length} searches.`,
            `${RECORDS_HEADER}.`,
            ...factLines(r),
            missing.length ? `Not found: ${missing.join(', ')}.` : '',
            'Cite the links above when you answer. The full report and its PDF are in Library → Public records; say “find more sources” to keep digging (call records_report with more_of).',
          ]
            .filter(Boolean)
            .join('\n');
        } catch (err) {
          if (err instanceof RecordsError) throw new ToolError(err.message);
          throw err;
        }
      },
    },
  ];
}

