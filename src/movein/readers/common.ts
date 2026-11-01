// Phase 104 (MI1): pieces both readers share: store rows, skills folders, the "later" list.
import { INSTRUCTION_LIKE } from '../../companion-import/learn.ts';
import { detectMinorSexualContent } from '../../safety.ts';
import { parseSkill } from '../../skills.ts';
import type { Bundle } from '../bundle.ts';
import { categoryOf, unsafeLine } from '../text.ts';
import type { Finding, ReaderContext, SkillData } from '../types.ts';

export type Row = Record<string, unknown>;

/** Store folders in the bundle for one reader ("stores/home-state/"). */
export function storesOf(b: Bundle, reader: string): string[] {
  return b.manifest.items.filter((it) => (it.kind === 'sqlite' || it.kind === 'postgres') && it.reader === reader).map((it) => it.path);
}

/** Every row of one table, streamed from its JSONL parts (rows/<table>.<n>.jsonl). */
export async function* rows(b: Bundle, store: string, table: string, signal?: AbortSignal): AsyncGenerator<Row> {
  const safe = table.replace(/[^A-Za-z0-9_.-]/g, '_');
  const parts = b.list(`${store}rows/${safe}.`).filter((n) => /\.\d+\.jsonl$/.test(n)).sort((x, y) => Number(/\.(\d+)\.jsonl$/.exec(x)![1]) - Number(/\.(\d+)\.jsonl$/.exec(y)![1]));
  for (const p of parts) {
    for await (const line of b.lines(p)) {
      if (signal?.aborted) return;
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { t?: string; r?: Row };
        if (o.r && typeof o.r === 'object') yield o.r;
      } catch {
        /* a damaged line: skipped */
      }
    }
  }
}

export interface StoreSchema {
  tables: { name: string; columns: { name: string; type: string }[]; rows: number; verdict: string; why?: string; written?: number }[];
}

export async function schemaOf(b: Bundle, store: string): Promise<StoreSchema | undefined> {
  try {
    return JSON.parse(await b.text(`${store}schema.json`)) as StoreSchema;
  } catch {
    return undefined;
  }
}

export const cols = (s: StoreSchema | undefined, table: string): Set<string> => new Set(s?.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** A time from a row: epoch seconds (float), epoch ms, or ISO. */
export function when(v: unknown, fallback: string): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return when(Number(v), fallback);
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

const SCRIPT_FILE = /(^|\/)scripts\/|\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const BUNDLED_AUTHOR = /\b(hermes agent|nous research|nousresearch|openclaw)\b/i;

/** Skill folders (SKILL.md + files) under the given bundle prefixes (§6.7). */
export async function readSkills(b: Bundle, prefixes: string[], emit: (f: Finding) => void, ctx: ReaderContext, agent: string): Promise<number> {
  let n = 0;
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    for (const md of b.list(prefix).filter((x) => x.endsWith('/SKILL.md'))) {
      const folder = md.slice(0, -'SKILL.md'.length);
      if (seen.has(folder)) continue;
      seen.add(folder);
      const text = ctx.scrub(await b.text(md, 1024 * 1024).catch(() => ''));
      const dirName = folder.replace(/\/$/, '').split('/').at(-1) ?? 'skill';
      const parsed = parseSkill(dirName, text);
      const files = b.list(folder).map((x) => x.slice(folder.length)).filter((x) => x && !x.includes('/SKILL.md'));
      const author = String((parsed.meta as { metadata?: Record<string, string> } | undefined)?.metadata?.author ?? '') + ' ' + (/^author:\s*(.+)$/m.exec(text)?.[1] ?? '');
      const name = (parsed.meta?.name || dirName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
      const data: SkillData = {
        name,
        description: (parsed.meta?.description ?? '').slice(0, 1024) || `A skill moved in from ${agent}.`,
        folder,
        files: files.filter((f) => f !== 'SKILL.md'),
        scripts: files.some((f) => SCRIPT_FILE.test(f)),
        ...(BUNDLED_AUTHOR.test(author) ? { bundled: true } : {}),
      };
      const itemCats = b.manifest.items.find((it) => it.path === md)?.cats ?? [];
      const held = categoryOf(text) ?? (itemCats.includes('medical') ? 'medical' : itemCats.includes('intimate') ? 'intimate' : undefined);
      emit({ section: 'skills', kind: 'skill', ref: md, title: name, data, ...(held ? { held } : {}) });
      n++;
    }
  }
  return n;
}

/**
 * One memory finding from an old note (§6.4, §11.2, §11.7): secrets scrubbed again, minors-sexual
 * content dropped (counted, never quoted), instruction-like lines kept only as a quoted fact.
 */
export function note(emit: (f: Finding) => void, skipped: Record<string, number>, ctx: Pick<ReaderContext, 'scrub'>, f: { section: 'memories' | 'profile' | 'reflections'; ref: string; text: string; kind: import('../../memory.ts').MemoryKind; happenedOn: string; pinned?: boolean; superseded?: boolean; tag?: string; evidence?: string; archived?: boolean; held?: import('../types.ts').Category; card?: string }): void {
  let text = ctx.scrub(f.text.replace(/\s+/g, ' ').trim()).slice(0, 2000);
  if (text.length < 3) return;
  if (detectMinorSexualContent(text)) {
    skipped['minors-check'] = (skipped['minors-check'] ?? 0) + 1;
    return;
  }
  let kind = f.kind;
  if (INSTRUCTION_LIKE.test(text) || unsafeLine(text)) {
    text = `My old notes said (kept as a quote, not a rule): "${text.slice(0, 600)}"`;
    kind = 'self';
  }
  const held = f.held ?? categoryOf(text);
  emit({ section: f.section, kind: 'memory', ref: f.ref, title: text.slice(0, 120), data: { kind, content: text, happenedOn: f.happenedOn, ...(f.pinned ? { pinned: true } : {}), ...(f.superseded ? { superseded: true } : {}), ...(f.tag ? { tag: f.tag } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.archived ? { archived: true } : {}) }, ...(held ? { held } : {}), ...(f.card ? { card: f.card } : {}) });
}

/**
 * Hooks, plugins and config were "read in a later update" in MI1/MI2. Since MI3 (2.39) they become
 * the translation cards (src/movein/translate.ts) after reading, so nothing is listed here any more;
 * the function stays so the readers keep one call for the parts that need the owner.
 */
export function readLater(_b: Bundle, _emit: (f: Finding) => void, _roots: { hooks: string[]; plugins: string[] }): void {
  /* MI3: see src/movein/translate.ts */
}
