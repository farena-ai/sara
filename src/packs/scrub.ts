// Phase 127 (2.60.0, docs/design/PACKS.md §4.3, §6.3, §16 Q8): the owner's private parts of her
// sheet, kept out of everything that leaves this server: a companion pack, a character card and a
// character file. His own words about the two of them (relationshipNote), his hard limits and his
// stop word are left out, and his name (and his first name alone) becomes {{user}}, as whole words.
import type { Persona } from '../persona.ts';

/** The persona fields a pack keeps (§4.3); anything else in persona.json fails `persona`. */
export const PERSONA_KEYS = ['name', 'pronouns', 'age', 'appearance', 'summary', 'background', 'personality', 'speech', 'boundaries', 'traits', 'humour', 'life', 'archetype', 'talk', 'relationship', 'away', 'conflict', 'others', 'slowBurn', 'quietFocus', 'intimacy'] as const;
/** Her side of intimacy (yourLimits and stopWord are his). */
export const INTIMACY_KEYS = ['level', 'initiative', 'likes', 'limits', 'turnoffs'] as const;

export interface Replacement {
  where: string;
  before: string;
  after: string;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The owner's name and his first name alone, as whole words (any case). */
export function ownerNames(owner: string | undefined): string[] {
  const full = String(owner ?? '').trim();
  if (full.length < 2) return [];
  const first = full.split(/\s+/)[0];
  return [...new Set([full, ...(first.length >= 2 ? [first] : [])])];
}
function nameRe(names: string[]): RegExp | undefined {
  if (!names.length) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...names].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * A copy of a value with the owner's name swapped for {{user}} in every string, and the lines
 * changed (for *Show me*). Keys and numbers are kept.
 */
export function swapOwner<T>(v: T, names: string[], where = '', out: Replacement[] = []): { value: T; replaced: Replacement[] } {
  const re = nameRe(names);
  const walk = (x: unknown, at: string): unknown => {
    if (typeof x === 'string') {
      if (!re) return x;
      const after = x.replace(re, '{{user}}');
      if (after !== x) out.push({ where: at, before: x, after });
      return after;
    }
    if (Array.isArray(x)) return x.map((y, i) => walk(y, `${at}[${i}]`));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, at ? `${at}.${k}` : k)]));
    return x;
  };
  return { value: walk(v, where) as T, replaced: out };
}

/**
 * §16 Q8 and §4.3: her sheet without the owner's own words (relationshipNote), his hard limits and
 * stop word, and with his name as {{user}}. Used by the pack, the character card and the character file.
 */
export function scrubPersona(p: Persona, owner: string | undefined): { persona: Persona; replaced: Replacement[] } {
  const keep: Record<string, unknown> = {};
  for (const k of PERSONA_KEYS) if ((p as unknown as Record<string, unknown>)[k] !== undefined) keep[k] = (p as unknown as Record<string, unknown>)[k];
  if (p.intimacy) {
    const im: Record<string, unknown> = {};
    for (const k of INTIMACY_KEYS) if (p.intimacy[k] !== undefined) im[k] = p.intimacy[k];
    if (Object.keys(im).length) keep.intimacy = im;
    else delete keep.intimacy;
  }
  const names = ownerNames(owner).filter((n) => n.toLowerCase() !== p.name.toLowerCase());
  const { value, replaced } = swapOwner(keep, names);
  return { persona: value as unknown as Persona, replaced };
}

/** {{user}} back to the owner's name (or "you"), {{char}} to her name, in every string of a sheet. */
export function fillNames<T>(v: T, owner: string | undefined, name?: string): T {
  const who = String(owner ?? '').trim();
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      let out = x.replace(/{{user}}'s\b/gi, who ? `${who}'s` : 'your').replace(/{{user}}/gi, who || 'you');
      if (name) out = out.replace(/{{char}}/gi, name);
      return out;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}
