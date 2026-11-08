// EC27 (docs/ops/EC2527_DESIGN.md, docs/store/SARA_STORE.md §4.8): the Qualified badge. Where and when
// each Store entry last passed a real install, and which checks ran. Like the listing translations
// (src/store/locales.ts) it is a signed sidecar, v1/qualified.json + v1/qualified.sig, tied to the
// index's seq, because older Saras refuse unknown fields in the index and entries. A missing or bad
// sidecar only means no badges. The source is store/qualified.json in the Sara checkout, curated
// from the Q-ADDONS records; `sara addons requalify` folds new qualify-addons-native results in.
import { StoreRefused } from './verify.ts';

export const QUALIFIED_OS = ['windows', 'linux', 'macos'] as const;
export type QualifiedOs = (typeof QUALIFIED_OS)[number];
export const QUALIFIED_CHECKS = ['install', 'settings', 'run', 'write', 'update', 'add', 'retire', 'remove', 'connect', 'signed-hash'] as const;
export type QualifiedCheck = (typeof QUALIFIED_CHECKS)[number];
export const QUALIFIED_LIMITS = { items: 500, bytes: 262_144 } as const;
export interface QualifiedRecord { version: string; at: string; sara: string; os: Partial<Record<QualifiedOs, 'pass' | 'partial'>>; checks: QualifiedCheck[] }
export interface StoreQualified { format: 'sara-store-qualified'; v: 1; seq: number; items: Record<string, QualifiedRecord> }
/** What Get more shows: the systems that passed and partly passed, the date, the Sara version, the checks. */
export interface QualifiedView { at: string; sara: string; pass: QualifiedOs[]; partial: QualifiedOs[]; checks: QualifiedCheck[] }

const bad = (why: string): never => {
  throw new StoreRefused('qualified', `The store's qualification records were not used: ${why}.`);
};
const obj = (v: unknown, what: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`));
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function record(id: string, raw: unknown): QualifiedRecord {
  const x = obj(raw, id);
  for (const k of Object.keys(x)) if (!['version', 'at', 'sara', 'os', 'checks'].includes(k)) bad(`${id}: unknown field ${k.slice(0, 30)}`);
  if (typeof x.version !== 'string' || !VERSION.test(x.version)) bad(`${id}: the version is not valid`);
  if (typeof x.sara !== 'string' || !VERSION.test(x.sara)) bad(`${id}: the Sara version is not valid`);
  if (typeof x.at !== 'string' || !DAY.test(x.at) || Number.isNaN(Date.parse(x.at))) bad(`${id}: the date is not valid`);
  const os: QualifiedRecord['os'] = {};
  for (const [k, v] of Object.entries(obj(x.os, `${id} os`))) {
    if (!(QUALIFIED_OS as readonly string[]).includes(k)) bad(`${id}: ${k.slice(0, 20)} is not a system Sara runs on`);
    if (v !== 'pass' && v !== 'partial') bad(`${id}: the result for ${k} is not pass or partial`);
    os[k as QualifiedOs] = v as 'pass' | 'partial';
  }
  if (!Array.isArray(x.checks) || x.checks.length > QUALIFIED_CHECKS.length) bad(`${id}: the checks are not a list`);
  const checks = (x.checks as unknown[]).map((c) => ((QUALIFIED_CHECKS as readonly unknown[]).includes(c) ? (c as QualifiedCheck) : bad(`${id}: ${String(c).slice(0, 20)} is not a check Sara knows`)));
  return { version: x.version as string, at: x.at as string, sara: x.sara as string, os, checks };
}

/** Parses a sidecar for the index with this seq (anything else is refused, never partly used). */
export function parseQualified(json: string, seq: number): StoreQualified {
  if (json.length > QUALIFIED_LIMITS.bytes) bad('the file is too big');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    bad('the file is not JSON');
  }
  const o = obj(raw, 'the file');
  for (const k of Object.keys(o)) if (!['format', 'v', 'seq', 'items'].includes(k)) bad(`unknown field ${k.slice(0, 30)}`);
  if (o.format !== 'sara-store-qualified' || o.v !== 1) bad('not a qualification file');
  if (o.seq !== seq) bad('they belong to another list');
  const items = obj(o.items, 'items');
  if (Object.keys(items).length > QUALIFIED_LIMITS.items) bad('too many items');
  const out: StoreQualified['items'] = {};
  for (const [id, r] of Object.entries(items)) {
    if (!ID.test(id)) bad('an item id is not valid');
    out[id] = record(id, r);
  }
  return { format: 'sara-store-qualified', v: 1, seq, items: out };
}

/** The badge for an item's latest version (undefined: none, or nothing passed fully). */
export function qualifiedFor(q: StoreQualified | undefined, id: string, latest: string): QualifiedView | undefined {
  const r = q?.items[id];
  if (!r || r.version !== latest) return undefined;
  const pass = QUALIFIED_OS.filter((o) => r.os[o] === 'pass').sort();
  if (!pass.length) return undefined;
  return { at: r.at, sara: r.sara, pass, partial: QUALIFIED_OS.filter((o) => r.os[o] === 'partial').sort(), checks: [...r.checks] };
}

/** The source records (store/qualified.json) as sidecar items: only these ids, `record` left out. */
export function sidecarItems(src: Record<string, QualifiedRecord & { record?: string }>, ids: Iterable<string>): Record<string, QualifiedRecord> {
  const out: Record<string, QualifiedRecord> = {};
  for (const id of ids) {
    const r = src[id];
    if (r) out[id] = { version: r.version, at: r.at, sara: r.sara, os: r.os, checks: r.checks };
  }
  return out;
}

// ---- `sara addons requalify` ----

/** One row of scripts/qualify-addons-native.mjs output. */
export interface QualifyRun { id: string; os: string; source?: string; result: string; steps?: Record<string, { ok?: boolean }> }
const STEP_CHECK: [RegExp, QualifiedCheck][] = [
  [/^(?:store-)?(?:install|add)(?:-\d+)?$/, 'install'],
  [/^add-her/, 'add'],
  [/^(?:store-)?retire/, 'retire'],
  [/^settings/, 'settings'],
  [/^(?:read|run|action|main|call)/, 'run'],
  [/^(?:write|job)/, 'write'],
  [/^update/, 'update'],
  [/^(?:remove|delete)/, 'remove'],
  [/^connect/, 'connect'],
  [/^(?:download|signed|hash)/, 'signed-hash'],
];
const checkOf = (step: string): QualifiedCheck | undefined => STEP_CHECK.find(([re]) => re.test(step))?.[1];

/**
 * Folds qualification runs into the records. For each id with a listed version: a passing run sets
 * that system to pass, a lifecycle-only run to partial, anything else drops that system. Systems not
 * re-run keep their result when the version is the same; a new version starts a fresh record.
 * Held / preview rows and ids without a version are skipped.
 */
export function foldRuns(records: Record<string, QualifiedRecord & { record?: string }>, runs: readonly QualifyRun[], o: { at: string; sara: string; versions: Record<string, string> }): Record<string, QualifiedRecord & { record?: string }> {
  const out = { ...records };
  const byId = new Map<string, QualifyRun[]>();
  for (const r of runs) {
    if (!ID.test(r.id) || r.source === 'held' || !o.versions[r.id] || !(QUALIFIED_OS as readonly string[]).includes(r.os)) continue;
    byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  }
  for (const [id, rows] of byId) {
    const version = o.versions[id]!;
    const prev = out[id]?.version === version ? out[id] : undefined;
    const os: QualifiedRecord['os'] = { ...(prev?.os ?? {}) };
    const checks = new Set<QualifiedCheck>(prev?.checks ?? []);
    for (const r of rows) {
      const k = r.os as QualifiedOs;
      if (r.result === 'pass') os[k] = 'pass';
      else if (r.result === 'pass-lifecycle-only' || r.result === 'partial') os[k] = 'partial';
      else delete os[k];
      if (r.result.startsWith('pass')) for (const [step, s] of Object.entries(r.steps ?? {})) if (s?.ok) {
        const c = checkOf(step);
        if (c) checks.add(c);
      }
    }
    if (!Object.keys(os).length) {
      delete out[id];
      continue;
    }
    const sorted: QualifiedRecord['os'] = {};
    for (const k of Object.keys(os).sort() as QualifiedOs[]) sorted[k] = os[k];
    out[id] = { version, at: o.at, sara: o.sara, os: sorted, checks: [...checks].sort(), record: 'sara addons requalify' };
  }
  return out;
}
