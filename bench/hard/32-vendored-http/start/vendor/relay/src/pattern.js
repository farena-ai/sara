import { fail } from './errors.js';

const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)(?::(int))?\}$/;
const DIGITS = /^\d+$/;

/** Splits a path into segments; a leading and a trailing slash do not make empty segments. */
export function segments(path) {
  const parts = path.split('/');
  if (parts[0] === '') parts.shift();
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Compiles '/items/{id:int}/notes/{slug}' into its parts. A segment is either literal text or a
 * whole-segment placeholder: {name} (any non-empty text) or {name:int} (digits only, as a number).
 */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) fail('bad-pattern', `a pattern must be a string starting with "/", got ${JSON.stringify(pattern)}`);
  const names = new Set();
  const parts = segments(pattern).map((seg) => {
    const m = PARAM.exec(seg);
    if (m) {
      if (names.has(m[1])) fail('bad-pattern', `parameter "${m[1]}" appears twice in ${pattern}`);
      names.add(m[1]);
      return { param: m[1], int: m[2] === 'int' };
    }
    if (seg.includes('{') || seg.includes('}')) fail('bad-pattern', `bad segment "${seg}" in ${pattern}: placeholders take a whole segment, like {id} or {id:int}`);
    return { literal: seg };
  });
  // Literal segments rank above {name:int}, which ranks above {name}; compared left to right.
  const rank = parts.map((p) => (p.literal !== undefined ? 2 : p.int ? 1 : 0));
  return { pattern, parts, rank };
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** The params of a path (already split) for a compiled pattern, or null when it does not match. */
export function matchPattern(compiled, segs) {
  if (segs.length !== compiled.parts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const part = compiled.parts[i];
    if (part.literal !== undefined) {
      if (segs[i] !== part.literal) return null;
      continue;
    }
    const value = decode(segs[i]);
    if (value === null || value === '') return null;
    if (part.int) {
      if (!DIGITS.test(value)) return null;
      params[part.param] = Number(value);
    } else {
      params[part.param] = value;
    }
  }
  return Object.freeze(params);
}

/** Compares two compiled patterns by rank: negative when `a` should be tried first. */
export function compareRank(a, b) {
  for (let i = 0; i < Math.min(a.rank.length, b.rank.length); i++) {
    if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
  }
  return 0;
}
