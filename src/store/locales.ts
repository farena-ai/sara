// Store listing translations (docs/store/SARA_STORE.md §4.7). The signed index and entries refuse
// unknown fields, so translations can't go in them without breaking older Saras. They live in a
// sidecar instead, v1/locales.json, signed with the same Store key (v1/locales.sig) and tied to the
// index's seq. Older Saras never fetch it; a missing or bad sidecar only means the English text.
import { StoreRefused } from './verify.ts';

export const LOCALE_LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;
export type LocaleLang = (typeof LOCALE_LANGS)[number];
/** The tagline (item summary) and the longer description, in characters. */
export const LOCALE_LIMITS = { summary: 200, description: 900, items: 500, bytes: 1_048_576 } as const;
export interface ListingText { summary: string; description?: string }
export interface StoreLocales { format: 'sara-store-locales'; v: 1; seq: number; items: Record<string, Partial<Record<LocaleLang, ListingText>>> }

const bad = (why: string): never => {
  throw new StoreRefused('locales', `The store's translations were not used: ${why}.`);
};
const obj = (v: unknown, what: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`));
const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim()) bad(`${what} is not text`);
  if ((v as string).length > max) bad(`${what} is too long`);
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v as string)) bad(`${what} has markup or control characters`);
  return v as string;
};

/** Parses a sidecar for the index with this seq (anything else is refused, never partly used). */
export function parseLocales(json: string, seq: number): StoreLocales {
  if (json.length > LOCALE_LIMITS.bytes) bad('the file is too big');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    bad('the file is not JSON');
  }
  const o = obj(raw, 'the file');
  for (const k of Object.keys(o)) if (!['format', 'v', 'seq', 'items'].includes(k)) bad(`unknown field ${k.slice(0, 30)}`);
  if (o.format !== 'sara-store-locales' || o.v !== 1) bad('not a translations file');
  if (o.seq !== seq) bad('they belong to another list');
  const items = obj(o.items, 'items');
  if (Object.keys(items).length > LOCALE_LIMITS.items) bad('too many items');
  const out: StoreLocales['items'] = {};
  for (const [id, langs] of Object.entries(items)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) bad('an item id is not valid');
    const per: Partial<Record<LocaleLang, ListingText>> = {};
    for (const [lang, t] of Object.entries(obj(langs, id))) {
      if (!(LOCALE_LANGS as readonly string[]).includes(lang)) bad(`${id}: language ${lang.slice(0, 10)} is not one Sara speaks`);
      const x = obj(t, `${id} ${lang}`);
      for (const k of Object.keys(x)) if (k !== 'summary' && k !== 'description') bad(`${id} ${lang}: unknown field ${k.slice(0, 30)}`);
      per[lang as LocaleLang] = { summary: str(x.summary, `${id} ${lang} summary`, LOCALE_LIMITS.summary), ...(x.description !== undefined ? { description: str(x.description, `${id} ${lang} description`, LOCALE_LIMITS.description) } : {}) };
    }
    out[id] = per;
  }
  return { format: 'sara-store-locales', v: 1, seq, items: out };
}

/** The listing text for one language (pt-BR exact; others by their first part), or undefined. */
export function listingFor(l: StoreLocales | undefined, id: string, lang: string | undefined): ListingText | undefined {
  if (!l || !lang) return undefined;
  return l.items[id]?.[langCode(lang) as LocaleLang];
}
const langCode = (lang: string) => ((LOCALE_LANGS as readonly string[]).includes(lang) ? lang : lang.split('-')[0]);

// Store sequence 8 (SARA_STORE.md §4.7.1): the rest of a plugin or tool-server listing, which the v1
// sidecar has no room for (Saras 2.83 to 3.0.2 refuse an unknown field there and would drop every
// translation). A second signed sidecar, v1/locales-extra.json + .sig, tied to the same seq; only
// Sara 3.0.3+ asks for it. about = every about paragraph in order (used only when the count matches
// the entry's), tags = search words, terms = the English words a listing puts into its permission
// lines (setting and field labels, what a tool server reaches) and their translation.
export const LOCALE_EXTRA_LIMITS = { about: 8, tags: 12, tag: 40, terms: 40, term: 200 } as const;
export interface ListingExtra { about?: string[]; tags?: string[]; terms?: Record<string, string> }
export interface StoreLocalesExtra { format: 'sara-store-locales-extra'; v: 1; seq: number; items: Record<string, Partial<Record<LocaleLang, ListingExtra>>> }

const list = (v: unknown, what: string, n: number, max: number): string[] => {
  if (!Array.isArray(v) || !v.length || v.length > n) bad(`${what} is not a short list`);
  return (v as unknown[]).map((x, i) => str(x, `${what} ${i + 1}`, max));
};

/** Parses the extra sidecar for the index with this seq (anything else is refused, never partly used). */
export function parseLocalesExtra(json: string, seq: number): StoreLocalesExtra {
  if (json.length > LOCALE_LIMITS.bytes) bad('the file is too big');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    bad('the file is not JSON');
  }
  const o = obj(raw, 'the file');
  for (const k of Object.keys(o)) if (!['format', 'v', 'seq', 'items'].includes(k)) bad(`unknown field ${k.slice(0, 30)}`);
  if (o.format !== 'sara-store-locales-extra' || o.v !== 1) bad('not a translations file');
  if (o.seq !== seq) bad('they belong to another list');
  const items = obj(o.items, 'items');
  if (Object.keys(items).length > LOCALE_LIMITS.items) bad('too many items');
  const out: StoreLocalesExtra['items'] = {};
  for (const [id, langs] of Object.entries(items)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) bad('an item id is not valid');
    const per: Partial<Record<LocaleLang, ListingExtra>> = {};
    for (const [lang, t] of Object.entries(obj(langs, id))) {
      if (!(LOCALE_LANGS as readonly string[]).includes(lang)) bad(`${id}: language ${lang.slice(0, 10)} is not one Sara speaks`);
      const x = obj(t, `${id} ${lang}`);
      const e: ListingExtra = {};
      for (const k of Object.keys(x)) {
        if (k === 'about') e.about = list(x.about, `${id} ${lang} about`, LOCALE_EXTRA_LIMITS.about, LOCALE_LIMITS.description);
        else if (k === 'tags') e.tags = list(x.tags, `${id} ${lang} tags`, LOCALE_EXTRA_LIMITS.tags, LOCALE_EXTRA_LIMITS.tag);
        else if (k === 'terms') {
          const m = obj(x.terms, `${id} ${lang} terms`);
          if (Object.keys(m).length > LOCALE_EXTRA_LIMITS.terms) bad(`${id} ${lang}: too many terms`);
          e.terms = Object.fromEntries(Object.entries(m).map(([en, tr]) => [str(en, `${id} ${lang} term`, LOCALE_EXTRA_LIMITS.term), str(tr, `${id} ${lang} term`, LOCALE_EXTRA_LIMITS.term)]));
        } else bad(`${id} ${lang}: unknown field ${k.slice(0, 30)}`);
      }
      per[lang as LocaleLang] = e;
    }
    out[id] = per;
  }
  return { format: 'sara-store-locales-extra', v: 1, seq, items: out };
}

/** The extra listing parts for one language, or undefined. */
export function extraFor(l: StoreLocalesExtra | undefined, id: string, lang: string | undefined): ListingExtra | undefined {
  if (!l || !lang) return undefined;
  return l.items[id]?.[langCode(lang) as LocaleLang];
}

/**
 * A permission line's words in the owner's language: every text parameter that is a known English
 * term (a label, a list of labels joined with ", ", what a tool server reaches) is swapped for its
 * translation. Commands, hosts, numbers and anything unknown stay exactly as they are.
 */
export function translateLineParams<T extends { params?: Record<string, unknown> }>(line: T, terms: Record<string, string> | undefined): T {
  if (!terms || !line.params) return line;
  const swap = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    if (terms[v]) return terms[v];
    return v.includes(', ') ? v.split(', ').map((x) => terms[x] ?? x).join(', ') : v;
  };
  return { ...line, params: Object.fromEntries(Object.entries(line.params).map(([k, v]) => [k, swap(v)])) };
}
