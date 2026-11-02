// Phase 127 (2.60.0, docs/design/PACKS.md §4, C1): a companion pack's files and its manifest.
// A pack is a folder (or a zip of one) with `sara-companion.json` at the top; nothing outside the
// §4.1 layout is allowed. The manifest is strict: unknown fields refuse it, `v` must be 1. Pure: no
// I/O here (checks.ts runs every rule over the files; build.ts and card.ts make them).
import { MINOR_TAGS } from '../character-cards.ts';
import type { PackageFile, PackageLimits } from '../packages.ts';
import { compareSemver, ID_RE, parseSemver } from '../plugins/manifest.ts';

export const PACK_FILE = 'sara-companion.json';
export const PACK_FORMAT = 'sara-companion';
export const PACK_EXT = '.sara-companion.zip';
/** §4.10: the zip, 120 files, depth 6. */
export const STORE_COMPANION_LIMITS: PackageLimits = { maxZipBytes: 25 * 1024 * 1024, maxFiles: 120, maxTotalBytes: 25 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxDepth: 6 };
export const CAPS = {
  persona: 64 * 1024,
  picture: 700 * 1024,
  look: 18 * 1024 * 1024,
  closet: 6,
  closetBytes: 3 * 1024 * 1024,
  reference: 3,
  skills: 5,
  skillsBytes: 2 * 1024 * 1024,
  greetings: 6,
  greetingBytes: 8 * 1024,
  greetingChars: 1200,
  cover: 1024 * 1024,
  manifestSkills: 8,
  routines: 5,
  suggests: 5,
  tags: 8,
} as const;
export const RATINGS = ['general', 'mature', 'explicit'] as const;
export type PackRating = (typeof RATINGS)[number];
export const REMIX = ['yes', 'ask', 'no'] as const;
export type PackRemix = (typeof REMIX)[number];
export const LOOK_KINDS = ['none', 'portrait', 'full'] as const;
export type LookKind = (typeof LOOK_KINDS)[number];
/** §16 Q6: the licences the store accepts (any SPDX id works for a file). */
export const STORE_LICENSES = ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC0-1.0', 'MIT'] as const;
/** The words the card and the store page use for each licence. */
export const LICENSE_WORDS: Record<string, string> = {
  'CC-BY-4.0': 'Share with credit (CC BY 4.0)',
  'CC-BY-SA-4.0': 'Share alike (CC BY-SA 4.0)',
  'CC-BY-NC-4.0': 'Not for money (CC BY-NC 4.0)',
  'CC-BY-NC-SA-4.0': 'Not for money, share alike (CC BY-NC-SA 4.0)',
  'CC0-1.0': 'No rights kept (CC0)',
  MIT: 'MIT',
};
/** Tags that mean a minor: the card reader's own list, applied to packs too. */
export const MINOR_TAG_RE = MINOR_TAGS;

export class PackFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackFormatError';
  }
}

export interface PackSkillRef {
  store?: string;
  version?: string;
  bundled?: string;
  why?: string;
}
export interface PackRoutine {
  id: string;
  answers?: Record<string, string | number>;
  why?: string;
}
export interface PackSuggest {
  store: string;
  why?: string;
}
export interface PackManifest {
  format: typeof PACK_FORMAT;
  v: 1;
  id: string;
  version: string;
  sara: string;
  name: string;
  summary: string;
  author: { name: string };
  license: string;
  remix: PackRemix;
  rating: PackRating;
  romance: boolean;
  language: string;
  tags: string[];
  includes: { persona: true; dials: boolean; look: LookKind; closet: number; reference: number; voice: boolean; greeting: boolean };
  skills: PackSkillRef[];
  routines: PackRoutine[];
  suggests: PackSuggest[];
  needs: { pictures: boolean; voices: string[] };
  made?: { with?: string; at?: string };
}

const bad = (m: string): never => {
  throw new PackFormatError(m);
};
function obj(v: unknown, what: string, keys: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${what} must be an object.`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${what} has an unknown field “${k}”.`);
  for (const k of required) if (o[k] === undefined) bad(`${what} is missing “${k}”.`);
  return o;
}
function text(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== 'string') return bad(`${what} must be text.`);
  if (v.trim().length < min) bad(min > 1 ? `${what} must be at least ${min} characters.` : `${what} is empty.`);
  if (v.length > max) bad(`${what} is longer than ${max} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) bad(`${what} has control characters.`);
  return v;
}
const list = (v: unknown, what: string, max: number): unknown[] => {
  if (!Array.isArray(v)) return bad(`${what} must be a list.`);
  if (v.length > max) bad(`${what} has more than ${max} entries.`);
  return v;
};
const SPDX = /^(?:[A-Za-z0-9.+-]{2,40}|unknown)$/;
const RANGE = /^[\d.<>=^~| xX*-]{1,60}$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SKILL_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROUTINE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** True when `range` (like ">=2.60.0" or "^1.0.0") is a range Sara can read. */
export const isRange = (r: unknown): r is string => typeof r === 'string' && RANGE.test(r) && /\d/.test(r);

/**
 * The manifest from its JSON text or object, strictly (§4.2). `personaName` (when given) must equal
 * the manifest's name. Throws PackFormatError with the reason in plain words.
 */
export function parsePackManifest(raw: unknown, o: { personaName?: string } = {}): PackManifest {
  let v = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      v = JSON.parse(String(raw));
    } catch {
      bad(`${PACK_FILE} isn't valid JSON.`);
    }
  }
  const m = obj(v, PACK_FILE, ['format', 'v', 'id', 'version', 'sara', 'name', 'summary', 'author', 'license', 'remix', 'rating', 'romance', 'language', 'tags', 'includes', 'skills', 'routines', 'suggests', 'needs', 'made'], ['format', 'v', 'id', 'version', 'sara', 'name', 'summary', 'author', 'license', 'remix', 'rating', 'romance', 'language', 'tags', 'includes']);
  if (m.format !== PACK_FORMAT) bad("This isn't a Sara companion pack.");
  if (m.v !== 1) bad('This companion pack is from a newer Sara. Update Sara first.');
  const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : bad('id must be lowercase letters, digits and dashes (at most 48).');
  const version = typeof m.version === 'string' && m.version.length <= 40 && parseSemver(m.version) ? m.version : bad('version must be a version like 1.2.0.');
  const sara = isRange(m.sara) ? m.sara : bad('sara must be a version range like >=2.60.0.');
  const name = text(m.name, 'name', 40);
  if (o.personaName !== undefined && o.personaName.trim() !== name.trim()) bad(`The pack's name (${name}) and her character's name (${o.personaName}) must be the same.`);
  const summary = text(m.summary, 'summary', 160, 20);
  const author = obj(m.author, 'author', ['name'], ['name']);
  const authorName = text(author.name, 'author.name', 60);
  if (/@|https?:\/\/|www\./i.test(authorName)) bad('author.name is a name only: no email or link in the pack.');
  const license = typeof m.license === 'string' && SPDX.test(m.license) ? m.license : bad('license must be an SPDX licence id (like CC-BY-4.0).');
  const remix = (REMIX as readonly unknown[]).includes(m.remix) ? (m.remix as PackRemix) : bad('remix must be yes, ask or no.');
  const rating = (RATINGS as readonly unknown[]).includes(m.rating) ? (m.rating as PackRating) : bad('rating must be general, mature or explicit.');
  if (typeof m.romance !== 'boolean') bad('romance must be true or false.');
  if (rating === 'explicit' && m.romance !== true) bad('An explicit pack is romantic too: set romance to true.');
  const language = typeof m.language === 'string' && LANG.test(m.language) ? m.language : bad('language must be a language tag like en.');
  const tags = list(m.tags, 'tags', CAPS.tags).map((t, i) => text(t, `tags[${i}]`, 24));
  const minor = tags.find((t) => MINOR_TAG_RE.test(t.trim()));
  if (minor) bad(`The tag “${minor}” can't be used: companions are always adults.`);
  const inc = obj(m.includes, 'includes', ['persona', 'dials', 'look', 'closet', 'reference', 'voice', 'greeting'], ['persona', 'look']);
  if (inc.persona !== true) bad('includes.persona must be true (every pack has her character).');
  const look = (LOOK_KINDS as readonly unknown[]).includes(inc.look) ? (inc.look as LookKind) : bad('includes.look must be none, portrait or full.');
  const count = (x: unknown, what: string, max: number): number => (x === undefined ? 0 : Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max ? (x as number) : bad(`${what} must be a number from 0 to ${max}.`));
  const flag = (x: unknown, what: string): boolean => (x === undefined ? false : typeof x === 'boolean' ? x : bad(`${what} must be true or false.`));
  const includes = { persona: true as const, dials: flag(inc.dials, 'includes.dials'), look, closet: count(inc.closet, 'includes.closet', CAPS.closet), reference: count(inc.reference, 'includes.reference', CAPS.reference), voice: flag(inc.voice, 'includes.voice'), greeting: flag(inc.greeting, 'includes.greeting') };
  const skills = list(m.skills ?? [], 'skills', CAPS.manifestSkills).map((x, i): PackSkillRef => {
    const s = obj(x, `skills[${i}]`, ['store', 'version', 'bundled', 'why']);
    const why = s.why === undefined ? undefined : text(s.why, `skills[${i}].why`, 120);
    if (s.store !== undefined) {
      if (s.bundled !== undefined) bad(`skills[${i}] is either from the store or bundled, not both.`);
      const store = typeof s.store === 'string' && ID_RE.test(s.store) ? s.store : bad(`skills[${i}].store must be a store id.`);
      const range = isRange(s.version) ? s.version : bad(`skills[${i}].version must be a version range like ^1.0.0.`);
      return { store, version: range, ...(why ? { why } : {}) };
    }
    const bundled = typeof s.bundled === 'string' && SKILL_DIR.test(s.bundled) ? s.bundled : bad(`skills[${i}] needs a store id or a bundled folder name.`);
    if (s.version !== undefined) bad(`skills[${i}]: a bundled skill has no version range.`);
    return { bundled, ...(why ? { why } : {}) };
  });
  if (skills.filter((s) => s.bundled).length > CAPS.skills) bad(`At most ${CAPS.skills} bundled skills.`);
  const routines = list(m.routines ?? [], 'routines', CAPS.routines).map((x, i) => {
    const r = obj(x, `routines[${i}]`, ['id', 'answers', 'why'], ['id']);
    const rid = typeof r.id === 'string' && ROUTINE_ID.test(r.id) ? r.id : bad(`routines[${i}].id must be a routine id.`);
    let answers: Record<string, string | number> | undefined;
    if (r.answers !== undefined) {
      const a = obj(r.answers, `routines[${i}].answers`, Object.keys((r.answers ?? {}) as object));
      answers = {};
      for (const [k, val] of Object.entries(a)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(k)) bad(`routines[${i}].answers: “${k}” isn't a field name.`);
        if (typeof val === 'number' && Number.isFinite(val)) answers[k] = val;
        else answers[k] = text(val, `routines[${i}].answers.${k}`, 300);
      }
    }
    return { id: rid, ...(answers ? { answers } : {}), ...(r.why !== undefined ? { why: text(r.why, `routines[${i}].why`, 120) } : {}) };
  });
  const suggests = list(m.suggests ?? [], 'suggests', CAPS.suggests).map((x, i) => {
    const s = obj(x, `suggests[${i}]`, ['store', 'why'], ['store']);
    return { store: typeof s.store === 'string' && ID_RE.test(s.store) ? s.store : bad(`suggests[${i}].store must be a store id.`), ...(s.why !== undefined ? { why: text(s.why, `suggests[${i}].why`, 120) } : {}) };
  });
  const n = m.needs === undefined ? {} : obj(m.needs, 'needs', ['pictures', 'voices']);
  const needs = { pictures: flag(n.pictures, 'needs.pictures'), voices: list(n.voices ?? [], 'needs.voices', 4).map((x, i) => text(x, `needs.voices[${i}]`, 40)) };
  const out: PackManifest = { format: PACK_FORMAT, v: 1, id, version, sara, name, summary, author: { name: authorName }, license, remix, rating, romance: m.romance as boolean, language, tags, includes, skills, routines, suggests, needs };
  if (m.made !== undefined) {
    const md = obj(m.made, 'made', ['with', 'at']);
    out.made = { ...(md.with !== undefined ? { with: text(md.with, 'made.with', 60) } : {}), ...(md.at !== undefined ? { at: text(md.at, 'made.at', 30) } : {}) };
  }
  return out;
}

/** The §4.1 layout: is this path part of a pack? (Skill folders are checked by name in checks.ts.) */
export function layoutOk(path: string): boolean {
  if (['sara-companion.json', 'persona.json', 'voice.json', 'greeting.json', 'look.json', 'rights.json', 'cover.png', 'CHANGES.md', 'LICENSE'].includes(path)) return true;
  if (/^look\/(sara-portrait\.jpg|sara-avatar\.jpg|sara\/portrait-(happy|caring|sleepy|hurt|playful)\.jpg|sara\/frames\/(default|happy|caring|sleepy|hurt|playful)-(blink|talk|oo|ee|half)\.jpg)$/.test(path)) return true;
  if (/^closet\/[a-z0-9-]{1,40}\/(sara-portrait\.jpg|look\.json)$/.test(path)) return true;
  if (/^reference\/face-[1-3]\.jpg$/.test(path)) return true;
  if (/^skills\/[a-z0-9][a-z0-9-]{0,63}\/[^/]/.test(path) && !path.split('/').some((p) => p.startsWith('.'))) return true;
  return false;
}

export const textOf = (f: PackageFile | undefined): string => (f ? f.data.toString('utf8') : '');
export const jsonOf = <T = unknown>(f: PackageFile | undefined): T | undefined => {
  if (!f) return undefined;
  try {
    return JSON.parse(f.data.toString('utf8')) as T;
  } catch {
    return undefined;
  }
};
/** A newer pack version (for the update card), by semver. */
export const isNewer = (a: string, b: string): boolean => compareSemver(a, b) > 0;
/** A pack id from a name (“Juniper Lee” → “juniper-lee”). */
export const idFrom = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'companion';
