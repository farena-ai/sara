// U5.32 (docs/WHATS_NEW.md): "What's new in 3.x", a plain-words page after each update.
// Build time: scripts/whats-new.ts reads the CHANGELOG's `## x.y.z (date): title` sections, keeps the
// first sentence of each `New:` / `Fixed:` line of the newest releases, gives each a link to the place
// it lives (a `#view=` hash or a Settings page), marks owner-only items and the matching Try these
// items, and writes the compact web/whats-new.json the web app ships with. Every highlight and release
// title is an i18n key (scripts/i18n-extract.ts reads that file), so a missing translation fails the
// gates like any other string.
// Run time: the server remembers per person (<data>/whats-new.json) the newest version they saw;
// after an update the page shows the releases since then, once. Members get the members' subset (no
// owner-only items), and kid mode never sees it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHECKS, type OwnerCheck } from './owner-checks.ts';

export const WHATS_NEW_FORMAT = 'sara-whats-new/1';
/** How many releases the shipped file keeps, and how many highlights per release. */
export const KEEP_RELEASES = 8;
export const PER_RELEASE = 6;
/** Fixes are many and small: at most this many per release. */
export const MAX_FIXED = 3;
/** A highlight's length at most (one or two lines on a phone card). */
export const MAX_TEXT = 170;

export type HighlightKind = 'new' | 'fixed';

export interface Highlight {
  id: string;
  kind: HighlightKind;
  /** English, plain words: the i18n key. */
  text: string;
  /** Where it lives: `#view=<place>` or `#view=settings:<page>`. */
  link?: string;
  /** Only the owner can use it (members never see it). */
  owner?: boolean;
  /** Matching Try these items (src/owner-checks.ts ids). */
  try?: string[];
}

export interface WhatsNewRelease {
  version: string;
  date: string;
  title: string;
  items: Highlight[];
}

export interface WhatsNewData {
  format: string;
  releases: WhatsNewRelease[];
}

/** Dotted versions: negative, zero or positive. */
export function cmpVersion(a: string, b: string): number {
  const p = (v: string) => String(v ?? '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

interface RawRelease {
  version: string;
  date: string;
  title: string;
  lines: { kind: HighlightKind; body: string }[];
}

/** The released sections (not Unreleased) with their New:/Fixed: lines, in file order (newest first). */
export function parseChangelog(md: string): RawRelease[] {
  const out: RawRelease[] = [];
  let cur: RawRelease | null = null;
  let item: { kind: HighlightKind; body: string } | null = null;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)(?::\s*(.*))?$/.exec(line);
    if (line.startsWith('## ')) {
      cur = h ? { version: h[1], date: h[2], title: (h[3] ?? '').trim(), lines: [] } : null;
      if (cur) out.push(cur);
      item = null;
      continue;
    }
    if (!cur) continue;
    const b = /^- (New|Added|Fixed)(?: \([^)]*\))?:\s*(.*)$/.exec(line);
    if (b) {
      item = { kind: b[1] === 'Fixed' ? 'fixed' : 'new', body: b[2] };
      cur.lines.push(item);
    } else if (item && /^\s{2,}\S/.test(line)) item.body += ` ${line.trim()}`;
    else item = null;
  }
  return out;
}

/** Plain words from a CHANGELOG line: no markdown, no roadmap/doc references, the first sentence only. */
export function firstSentence(body: string): string {
  let s = body
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*\((?=[^()]*(?:\b[A-Z]{1,6}\d+(?:\.\d+)?[a-z]?\b|docs\/|\.md\b|Phase \d))[^()]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = s.match(/.+?[.!?](?=\s+["“(]?[A-Z0-9]|$)|.+$/g) ?? [s];
  s = sentences[0].trim();
  // "Team recipes." says too little: add the next sentence when it fits.
  if (s.length < 45 && sentences[1]) s = `${s} ${sentences[1].trim()}`;
  if (s.length > MAX_TEXT) {
    const head = s.slice(0, MAX_TEXT);
    const cut = Math.max(...[' (', ': ', '; ', ', '].map((x) => head.lastIndexOf(x)));
    s = cut >= 40 ? `${s.slice(0, cut)}.` : `${s.slice(0, s.lastIndexOf(' ', MAX_TEXT - 4))}…`;
  }
  // A sentence cut inside a parenthesis or a quote loses the open part.
  for (let i = 0; i < 3; i++) {
    const open = (s.match(/\(/g) ?? []).length > (s.match(/\)/g) ?? []).length ? s.lastIndexOf('(') : (s.match(/"/g) ?? []).length % 2 ? s.lastIndexOf('"') : -1;
    if (open < 0) break;
    s = `${s.slice(0, open).trim().replace(/[.,;:]$/, '')}.`;
  }
  s = s.replace(/\s+([.,;:])/g, '$1').replace(/:\.$/, '.');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Where a highlight lives, by its words (first rule wins). `owner`: members can't use it. */
export const LINK_RULES: { re: RegExp; link: string; owner?: boolean }[] = [
  { re: /\bBusiness\b/, link: '#view=business', owner: true },
  { re: /\bMoney\b|\bbank\b/i, link: '#view=money' },
  { re: /\bself-repair\b|\bfixes that worked\b|\bfix(?:es)? (?:itself|herself)\b|\bfix yourself\b/i, link: '#view=settings:dh-health', owner: true },
  { re: /\bhealth log\b|\bHealth\b(?! check)/, link: '#view=health' },
  { re: /\bfamily planner\b|\bmeal|\bchores?\b|\bschool\b/i, link: '#view=family' },
  { re: /\bstudy\b|\bflash ?cards?\b|\bquiz/i, link: '#view=study' },
  { re: /\bbrowser extension\b|\bin your browser\b|\bextension for\b/i, link: '#view=settings:dh-devices' },
  { re: /\bshared projects?\b/i, link: '#view=shared', owner: true },
  { re: /\bmarketplace\b|\bShared by friends\b/i, link: '#view=addons', owner: true },
  { re: /\bTalk with\b|\bhands-free\b/i, link: '#view=settings:her-voice' },
  { re: /\bComfyUI\b|\bpicture editing\b|\bshort video\b/i, link: '#view=library', owner: true },
  { re: /\bmeetings?\b|\bspeakers?\b/i, link: '#view=meetings' },
  { re: /\btrips?\b|\bflight\b/i, link: '#view=trips' },
  { re: /\bteam recipes?\b|\bagent teams?\b/i, link: '#view=team', owner: true },
  { re: /\bWord\b|\btracked changes\b|\bcomments\b|\bdocuments?\b/, link: '#view=library' },
  { re: /\bAsk everything\b|\bAsk about anything\b/i, link: '#view=today' },
  { re: /\bTry these\b/i, link: '#view=try', owner: true },
  { re: /\bhelp pass\b|\blinked friend|\bMessages\b|\bcommunit/i, link: '#view=msgs', owner: true },
  { re: /\bcode changes?\b|\bcode fix/i, link: '#view=settings:dh-updates', owner: true },
  { re: /\bGoogle accounts?\b|\bmailbox|\bmail pages?\b/i, link: '#view=settings:ab-mail', owner: true },
  { re: /\btaskbar\b|\bDock\b|\bWindows app\b|\bMac app\b|\bdesktop app/i, link: '#view=settings:desktop-app', owner: true },
  { re: /\bAndroid\b|\biPhone\b|\bphone app\b/i, link: '#view=settings:co-phone', owner: true },
];

/** Words of an owner-only item whatever its link (the CHANGELOG says so). */
const OWNER_WORDS = /\bOwner only\b|\bowner only\b|\bfor the owner\b|\bthe owner's\b/;

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 5).join('-').slice(0, 40);
const WORD = /[A-Za-z][a-z]{4,}/g;
const STOP = new Set(['about', 'after', 'again', 'their', 'there', 'these', 'thing', 'things', 'where', 'which', 'while', 'every', 'other', 'first', 'second', 'shows', 'opens', 'never', 'still', 'with', 'without', 'friend', 'friends', 'message']);
const words = (s: string) => new Set([...s.matchAll(WORD)].map((m) => m[0].toLowerCase()).filter((w) => !STOP.has(w)));

/** Try these items for a highlight: same release and same place, or same release and two shared words. */
export function matchChecks(release: string, text: string, link: string | undefined, checks: readonly OwnerCheck[] = CHECKS): string[] {
  const mine = words(text);
  return checks
    .filter((c) => c.release === release)
    .map((c) => ({ id: c.id, place: Boolean(link && c.view === link), shared: [...words(`${c.title} ${c.expect}`)].filter((w) => mine.has(w)).length }))
    .filter((c) => c.place || c.shared >= 3)
    .sort((a, b) => Number(b.place) - Number(a.place) || b.shared - a.shared)
    .map((c) => c.id)
    .slice(0, 2);
}

/** The compact file the web app ships (web/whats-new.json). */
export function buildWhatsNew(md: string, o: { keep?: number; perRelease?: number; checks?: readonly OwnerCheck[] } = {}): WhatsNewData {
  const releases = parseChangelog(md).slice(0, o.keep ?? KEEP_RELEASES).map((r) => {
    const seen = new Set<string>();
    // New before Fixed, and one item per place first, so a release with five Family lines still
    // shows its other features.
    const all = [...r.lines.filter((l) => l.kind === 'new'), ...r.lines.filter((l) => l.kind === 'fixed')].map((l) => {
      const text = firstSentence(l.body);
      const head = `${text} ${l.body.slice(0, 300)}`;
      return { ...l, text, rule: LINK_RULES.find((x) => x.re.test(head)) };
    });
    const places = new Set<string>();
    const first = all.filter((l) => !l.rule || !places.has(l.rule.link) && Boolean(places.add(l.rule.link)));
    const pick = [...first, ...all.filter((l) => !first.includes(l))].filter((l, i, a) => l.kind === 'new' || a.slice(0, i).filter((x) => x.kind === 'fixed').length < MAX_FIXED);
    const lines = pick.slice(0, o.perRelease ?? PER_RELEASE).sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const items: Highlight[] = lines.map((l) => {
      const { text, rule } = l;
      let id = `${r.version.replace(/\./g, '-')}-${slug(text)}`;
      while (seen.has(id)) id += '-x';
      seen.add(id);
      const link = rule?.link;
      const owner = Boolean(rule?.owner) || OWNER_WORDS.test(l.body);
      const tries = matchChecks(r.version, `${text} ${l.body.slice(0, 300)}`, link, o.checks);
      return { id, kind: l.kind, text, ...(link ? { link } : {}), ...(owner ? { owner: true } : {}), ...(tries.length ? { try: tries } : {}) };
    });
    return { version: r.version, date: r.date, title: r.title, items };
  });
  return { format: WHATS_NEW_FORMAT, releases: releases.filter((r) => r.items.length) };
}

/** Every English string of the file (the i18n keys). */
export function whatsNewStrings(data: WhatsNewData): string[] {
  return [...new Set(data.releases.flatMap((r) => [r.title, ...r.items.map((i) => i.text)]).filter(Boolean))];
}

export interface WhatsNewState {
  /** The newest version this person was shown (or had when this started). */
  seen: string | null;
  /** Show the page by itself after an update (Help → What's new always works). */
  auto: boolean;
}

/** Per person: <data>/whats-new.json. */
export class WhatsNewSeen {
  readonly #file: string;
  constructor(dataDir: string) {
    this.#file = join(dataDir, 'whats-new.json');
  }
  get(): WhatsNewState {
    try {
      const j = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<WhatsNewState>) : {};
      return { seen: typeof j.seen === 'string' && /^\d+\.\d+\.\d+$/.test(j.seen) ? j.seen : null, auto: j.auto !== false };
    } catch {
      return { seen: null, auto: true };
    }
  }
  set(p: Partial<WhatsNewState>): WhatsNewState {
    const next = { ...this.get(), ...p };
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(`${this.#file}.tmp`, JSON.stringify(next));
    renameSync(`${this.#file}.tmp`, this.#file);
    return next;
  }
}

export interface WhatsNewView {
  version: string;
  seen: string | null;
  auto: boolean;
  /** Open the page by itself now (after an update, once). */
  show: boolean;
  /** The releases to show (newest first): after an update the ones since `seen`, else all kept. */
  releases: WhatsNewRelease[];
  kid?: boolean;
}

/** What one person sees. `all`: Help → What's new (every kept release, not only the unseen ones). */
export function whatsNewView(data: WhatsNewData, o: { version: string; state: WhatsNewState; member?: boolean; kid?: boolean; all?: boolean }): WhatsNewView {
  const base = { version: o.version, seen: o.state.seen, auto: o.state.auto };
  if (o.kid) return { ...base, show: false, releases: [], kid: true };
  const fit = data.releases
    .filter((r) => cmpVersion(r.version, o.version) <= 0)
    .map((r) => ({ ...r, items: r.items.filter((i) => !(o.member && i.owner)).map((i) => (o.member ? { ...i, try: undefined } : i)) }))
    .filter((r) => r.items.length);
  const fresh = o.state.seen ? fit.filter((r) => cmpVersion(r.version, o.state.seen!) > 0) : [];
  const show = Boolean(o.state.auto && o.state.seen && cmpVersion(o.version, o.state.seen) > 0 && fresh.length);
  return { ...base, show, releases: o.all || !show ? fit : fresh };
}

/** The shipped file, read once per path. */
const cache = new Map<string, WhatsNewData>();
export function loadWhatsNew(webDir: string): WhatsNewData {
  const p = join(webDir, 'whats-new.json');
  let d = cache.get(p);
  if (!d) {
    try {
      d = JSON.parse(readFileSync(p, 'utf8')) as WhatsNewData;
    } catch {
      d = { format: WHATS_NEW_FORMAT, releases: [] };
    }
    cache.set(p, d);
  }
  return d;
}
