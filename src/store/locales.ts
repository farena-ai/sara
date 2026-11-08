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
  const code = (LOCALE_LANGS as readonly string[]).includes(lang) ? lang : lang.split('-')[0];
  return l.items[id]?.[code as LocaleLang];
}
