// Phase 96 (ST1): skills in the open Agent Skills format (docs/design/STAPLES.md §3.1, §4.4).
//
// A skill is a folder with a SKILL.md: YAML frontmatter (name, description, and the optional
// license, compatibility, metadata, allowed-tools) and a Markdown body; any other files (scripts/,
// references/, assets/) sit beside it. This file is the format only: a small lenient reader for the
// YAML subset skills use (no dependency), the rules the specification gives for names and
// descriptions, and a writer that always produces a strictly valid SKILL.md, so a skill made or
// edited in Sara exports clean. Sara's own fields live only in `metadata` under a `sara-` prefix.
//
// Lenient reading (the client guide): a missing or empty description, or frontmatter that can't be
// read, skips the skill with a diagnostic; a name that doesn't match its folder, is too long, has
// capitals or `--` loads with a warning (the folder name is the id); an over-long description is cut
// for the catalog with a warning; a value with an unquoted ": " is read as plain text.

/** Name rules from the specification: 1–64 chars, a-z 0-9 and single hyphens, not at either end. */
export const SKILL_NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;
/** The body the specification recommends (lines); the editor warns above it, saving doesn't refuse. */
export const BODY_LINES_ADVISED = 500;
/** Bodies above this many tokens are never loaded up front (still with skill_use). */
export const BODY_TOKENS_ADVISED = 5000;
/** A SKILL.md larger than this is not read at all (a skill is instructions, not a dump). */
export const MAX_SKILL_MD = 256 * 1024;

export type DiagLevel = 'warn' | 'error';
/**
 * One finding of the lenient reader. `key` is the English template (the UI words it with t()),
 * `params` fill it; `message` is the filled English for logs and tools.
 */
export interface Diag {
  level: DiagLevel;
  code: string;
  key: string;
  params?: Record<string, string | number>;
  message: string;
}

const fill = (s: string, p: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));
export function diag(level: DiagLevel, code: string, key: string, params?: Record<string, string | number>): Diag {
  return { level, code, key, ...(params ? { params } : {}), message: fill(key, params) };
}

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** String → string map (the spec); Sara's keys start with `sara-`. */
  metadata: Record<string, string>;
  /** Space-separated in the file; shown on the review card, never trusted (§4.6). */
  allowedTools?: string;
}

export interface ParsedSkill {
  /** Undefined when the skill is skipped (see diagnostics). */
  meta?: SkillMeta;
  body: string;
  diagnostics: Diag[];
}

type Yaml = Record<string, string | Record<string, string> | string[]>;

/** Estimated tokens of a text (about 4 characters each), for the catalog and load caps. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

function unquote(raw: string): { value: string; ok: boolean } {
  const v = raw.trim();
  if (v.startsWith('"')) {
    // Double quotes: the JSON escapes YAML shares (\" \\ \n \t \uXXXX).
    const end = findClosingDouble(v);
    if (end < 0) return { value: v, ok: false };
    try {
      return { value: JSON.parse(v.slice(0, end + 1).replace(/\\'/g, "'")) as string, ok: true };
    } catch {
      return { value: v.slice(1, end), ok: true };
    }
  }
  if (v.startsWith("'")) {
    // Single quotes: '' is a quote, nothing else is special.
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "'") {
        if (v[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, ok: true };
      }
      out += v[i];
    }
    return { value: v, ok: false };
  }
  // Plain: a trailing " # comment" goes.
  return { value: v.replace(/\s+#.*$/, '').trim(), ok: true };
}

function findClosingDouble(v: string): number {
  for (let i = 1; i < v.length; i++) {
    if (v[i] === '\\') {
      i++;
      continue;
    }
    if (v[i] === '"') return i;
  }
  return -1;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** A flow list ("[a, b]") as plain items. */
function flowList(v: string): string[] | undefined {
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return undefined;
  return t
    .slice(1, -1)
    .split(',')
    .map((x) => unquote(x).value)
    .filter(Boolean);
}

/**
 * Reads the YAML subset of skill frontmatter: `key: value`, quoted strings, `|` and `>` block
 * scalars, one-level maps (metadata) and simple lists. Throws on lines it can't place.
 */
export function readYamlSubset(src: string, notes: Diag[] = []): Yaml {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Yaml = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    if (indentOf(line) > 0) throw new Error(`line ${i + 1}: unexpected indentation`);
    const m = /^([A-Za-z0-9_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1}: not a "key: value" line`);
    const key = m[1];
    const rest = (m[2] ?? '').trimEnd();
    i++;
    if (/^[|>][+-]?\d*$/.test(rest.trim())) {
      // A block scalar: the lines indented below it.
      const fold = rest.trim().startsWith('>');
      const keep = rest.includes('+');
      const strip = rest.includes('-');
      const block: string[] = [];
      let ind = -1;
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0)) {
        if (lines[i].trim() && ind < 0) ind = indentOf(lines[i]);
        block.push(lines[i]);
        i++;
      }
      const body = block.map((l) => (l.trim() ? l.slice(Math.max(0, ind)) : ''));
      let text = fold ? foldLines(body) : body.join('\n');
      if (strip) text = text.replace(/\n+$/, '');
      else if (!keep) text = text.replace(/\n+$/, '') + (text.trim() ? '\n' : '');
      out[key] = text;
      continue;
    }
    if (rest.trim() === '') {
      // A nested map or a list below.
      const map: Record<string, string> = {};
      const items: string[] = [];
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0 || lines[i].trimStart().startsWith('#'))) {
        const l = lines[i].trim();
        i++;
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('- ') || l === '-') {
          items.push(unquote(l.slice(1)).value);
          continue;
        }
        const mm = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*)|\s*)$/.exec(l);
        if (!mm) throw new Error(`line ${i}: not a "key: value" line in ${key}`);
        map[unquote(mm[1]).value] = unquote(mm[2] ?? '').value;
      }
      out[key] = items.length && !Object.keys(map).length ? items : map;
      continue;
    }
    const list = flowList(rest);
    if (list) {
      out[key] = list;
      continue;
    }
    const q = unquote(rest);
    if (!q.ok) throw new Error(`line ${i}: a quote is never closed`);
    // The client guide's case: an unquoted ": " inside a plain value (strict YAML refuses it) is
    // read as text, as if it had been quoted.
    if (!/^['"]/.test(rest.trim()) && /:\s/.test(q.value)) notes.push(diag('warn', 'unquoted-colon', 'The {field} has an unquoted ": " in it; it was read as plain text.', { field: key }));
    out[key] = q.value;
  }
  return out;
}

function foldLines(lines: string[]): string {
  let s = '';
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!l) s += '\n';
    else s += (s && !s.endsWith('\n') ? ' ' : '') + l;
  }
  return s;
}

/** Splits a SKILL.md into its frontmatter text and body (undefined when there is no frontmatter). */
export function splitFrontmatter(text: string): { front: string; body: string } | undefined {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return undefined;
  return { front: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

const asText = (v: Yaml[string] | undefined): string | undefined => (v === undefined ? undefined : Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : undefined);

/**
 * Reads one SKILL.md leniently. `folder` is the skill folder's own name (the id). Never throws.
 */
export function parseSkill(folder: string, text: string): ParsedSkill {
  const diagnostics: Diag[] = [];
  if (text.length > MAX_SKILL_MD) return { body: '', diagnostics: [diag('error', 'too-big', 'SKILL.md is larger than {kb} KB, so it was not read.', { kb: MAX_SKILL_MD / 1024 })] };
  const parts = splitFrontmatter(text);
  if (!parts) return { body: text, diagnostics: [diag('error', 'no-frontmatter', 'SKILL.md has no frontmatter (it must start with a line of three dashes).')] };
  let y: Yaml;
  try {
    y = readYamlSubset(parts.front, diagnostics);
  } catch (err) {
    return { body: parts.body, diagnostics: [...diagnostics, diag('error', 'bad-yaml', "The frontmatter couldn't be read ({why}).", { why: (err as Error).message })] };
  }
  const name = (asText(y.name) ?? '').trim();
  let description = (asText(y.description) ?? '').replace(/\s+/g, ' ').trim();
  if (!description) return { body: parts.body, diagnostics: [...diagnostics, diag('error', 'no-description', 'The description is missing, so she would never know when to use it.')] };
  if (!name) diagnostics.push(diag('warn', 'no-name', 'The name is missing; the folder name "{folder}" is used.', { folder }));
  else if (name !== folder) diagnostics.push(diag('warn', 'name-folder', 'The name "{name}" does not match its folder "{folder}"; the folder name is used.', { name: name.slice(0, 80), folder }));
  if (name && name.length > MAX_NAME) diagnostics.push(diag('warn', 'name-long', 'The name is longer than {n} characters.', { n: MAX_NAME }));
  if (name && !SKILL_NAME_RE.test(name) && name.length <= MAX_NAME) diagnostics.push(diag('warn', 'name-chars', 'The name should be lower-case letters, digits and single hyphens.'));
  if (!SKILL_NAME_RE.test(folder)) diagnostics.push(diag('warn', 'folder-chars', 'The folder name "{folder}" is not a valid skill name.', { folder: folder.slice(0, 80) }));
  if (description.length > MAX_DESCRIPTION) {
    diagnostics.push(diag('warn', 'description-long', 'The description is longer than {n} characters; it is cut in her list.', { n: MAX_DESCRIPTION }));
    description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  }
  const metadata: Record<string, string> = {};
  if (y.metadata !== undefined) {
    if (typeof y.metadata === 'object' && !Array.isArray(y.metadata)) for (const [k, v] of Object.entries(y.metadata)) metadata[k] = String(v);
    else diagnostics.push(diag('warn', 'metadata-shape', 'metadata should be a map of names to text; it was left out.'));
  }
  let compatibility = asText(y.compatibility)?.trim();
  if (compatibility && compatibility.length > MAX_COMPATIBILITY) {
    diagnostics.push(diag('warn', 'compat-long', 'compatibility is longer than {n} characters.', { n: MAX_COMPATIBILITY }));
    compatibility = compatibility.slice(0, MAX_COMPATIBILITY);
  }
  const license = asText(y.license)?.trim();
  const allowed = asText(y['allowed-tools'])?.replace(/\s+/g, ' ').trim();
  const lines = parts.body.split('\n').length;
  if (lines > BODY_LINES_ADVISED) diagnostics.push(diag('warn', 'body-long', 'The body has {n} lines; under {max} is advised.', { n: lines, max: BODY_LINES_ADVISED }));
  return {
    meta: { name: folder, description, metadata, ...(license ? { license } : {}), ...(compatibility ? { compatibility } : {}), ...(allowed ? { allowedTools: allowed } : {}) },
    body: parts.body,
    diagnostics,
  };
}

/** A YAML double-quoted scalar (JSON's escapes are valid YAML). */
const dq = (s: string) => JSON.stringify(s);

export interface SkillIn {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

/** Checks what saving needs (throws with a plain reason). Returns the cleaned values. */
export function checkForSave(s: SkillIn): SkillIn {
  const name = String(s.name ?? '').trim();
  if (!name) throw new Error('A skill needs a name.');
  if (name.length > MAX_NAME) throw new Error(`A skill name is at most ${MAX_NAME} characters.`);
  if (!SKILL_NAME_RE.test(name)) throw new Error('A skill name uses lower-case letters, digits and single hyphens (not at the start or end), e.g. "deploy-the-site".');
  // eslint-disable-next-line no-control-regex
  const description = String(s.description ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('A skill needs a description: what it does and when she should use it.');
  if (description.length > MAX_DESCRIPTION) throw new Error(`The description is at most ${MAX_DESCRIPTION} characters.`);
  // eslint-disable-next-line no-control-regex
  const body = String(s.body ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (body.length > MAX_SKILL_MD - 4096) throw new Error('The steps are too long for one skill: split it, or move the details into a file beside it.');
  const compatibility = s.compatibility?.trim();
  if (compatibility && compatibility.length > MAX_COMPATIBILITY) throw new Error(`compatibility is at most ${MAX_COMPATIBILITY} characters.`);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.metadata ?? {})) {
    const kk = String(k).trim().slice(0, 64);
    // eslint-disable-next-line no-control-regex
    if (kk) metadata[kk] = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000);
  }
  const allowed = s.allowedTools?.replace(/\s+/g, ' ').trim();
  return { name, description, body, metadata, ...(s.license?.trim() ? { license: s.license.trim().slice(0, 200) } : {}), ...(compatibility ? { compatibility } : {}), ...(allowed ? { allowedTools: allowed.slice(0, 500) } : {}) };
}

/** A strictly valid SKILL.md (the saving rule of §4.4). */
export function serializeSkill(input: SkillIn): string {
  const s = checkForSave(input);
  const lines = ['---', `name: ${s.name}`, `description: ${dq(s.description)}`];
  if (s.license) lines.push(`license: ${dq(s.license)}`);
  if (s.compatibility) lines.push(`compatibility: ${dq(s.compatibility)}`);
  const meta = Object.entries(s.metadata ?? {});
  if (meta.length) {
    lines.push('metadata:');
    for (const [k, v] of meta) lines.push(`  ${dq(k)}: ${dq(v)}`);
  }
  if (s.allowedTools) lines.push(`allowed-tools: ${dq(s.allowedTools)}`);
  lines.push('---', '', s.body, '');
  return lines.join('\n');
}

/** A skill name from a title ("Deploy the site!" → "deploy-the-site"), ≤ 64 characters. */
export function slugify(title: string): string {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-$/, '');
  return s || 'skill';
}

/** `base`, or `base-2`, `base-3`… when taken (kept ≤ 64 characters). */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, MAX_NAME - suffix.length).replace(/-$/, '')}${suffix}`;
    if (!taken(name)) return name;
  }
  throw new Error('No free name left.');
}

/** A description that says when to use it ("Use when …"), from a recipe's title and when-to-use line. */
export function describeFrom(title: string, whenToUse: string): string {
  const when = whenToUse.replace(/\s+/g, ' ').trim();
  const t0 = title.replace(/\s+/g, ' ').trim();
  const base = when || t0;
  if (/\b(use (it |this )?(when|for|to)|when you|whenever)\b/i.test(base)) return base.slice(0, MAX_DESCRIPTION);
  const lc = t0.charAt(0).toLowerCase() + t0.slice(1);
  const out = when ? `${t0}. Use when ${when.charAt(0).toLowerCase()}${when.slice(1).replace(/\.$/, '')}.` : `How to ${lc.replace(/\.$/, '')}. Use when you need to ${lc.replace(/\.$/, '')}.`;
  return out.slice(0, MAX_DESCRIPTION);
}
