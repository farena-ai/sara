// F6 (docs/HER_WEEK.md "How I did this week"): the owner's weekly look at how she did, part of her
// weekly check-in. Counts only, read from this space's own database (runs, run steps, the notices
// kept in chats, tool results, the receipt check's flags, the memory worker's state) and, for the
// owner, the last no-model eval page of this version in docs/results. No message text, nothing sent
// anywhere: each line is an en() template with numbers and model or tool names.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';

/** A reply that took longer than this counts as slow (the time from his message to her last word). */
export const SLOW_TURN_MS = 60_000;
const TOP = 3;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Why a reply failed, from the kept error notice (its class and words; the words are never shown). */
export type FailReason = 'slow' | 'unreachable' | 'limit' | 'auth' | 'context' | 'service' | 'other';
export function failReason(errorClass: string, error: string): FailReason {
  const e = error.toLowerCase();
  if (errorClass === 'SlowModelError' || /timed? ?out|timeout|no answer within|too slow/.test(e)) return 'slow';
  if (/context|too long|exceeds|too many tokens|maximum.*tokens/.test(e)) return 'context';
  if (/\b429\b|rate.?limit|quota|budget|insufficient|usage limit|credit/.test(e)) return 'limit';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api key|invalid key|sign(?:ed)? in|not signed|token expired/.test(e)) return 'auth';
  if (/econnrefused|enotfound|econnreset|ehostunreach|fetch failed|cannot reach|can't reach|could not reach|network|socket hang up/.test(e)) return 'unreachable';
  if (/\b5\d\d\b|server error|overloaded|unavailable|model not found|\b404\b|not found/.test(e)) return 'service';
  return 'other';
}
const REASON_LINE: Record<FailReason, string> = {
  slow: en('Replies that failed because the model took too long: {n}.'),
  unreachable: en('Replies that failed because the model server could not be reached: {n}.'),
  limit: en('Replies that failed because a usage limit or budget was reached: {n}.'),
  auth: en('Replies that failed because a key or sign-in was refused: {n}.'),
  context: en('Replies that failed because the conversation was too long for the model: {n}.'),
  service: en('Replies that failed because the model service had an error: {n}.'),
  other: en('Replies that failed for another reason: {n}.'),
};

export const HOW_EMPTY = en('This week nothing failed, nothing was slow and no backup model was needed.');
export const HOW_TITLE = en('How I did this week');

export interface HowLine {
  /** en() key the web and trOwner translate. */
  key: string;
  params: Record<string, string | number>;
}
export interface HowSheDid {
  failed: { n: number; why: Partial<Record<FailReason, number>> };
  tools: { name: string; n: number }[];
  fallbacks: { n: number; models: { name: string; n: number }[] };
  slow: { n: number; seconds: number; models: { name: string; n: number }[] };
  corrections: { claims: number; replies: number };
  memory: { chats: number };
  evals?: { version: string; ok: number; all: number; failed: string[] };
  /** The plain sentences, in order; one sentence for an empty week. */
  lines: HowLine[];
}

type Row = Record<string, unknown>;
const meta = (v: unknown): Record<string, unknown> => {
  try {
    return v ? (JSON.parse(String(v)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const top = (m: Map<string, number>) => [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
const list = (xs: { name: string; n: number }[]) => xs.slice(0, TOP).map((x) => `${x.name} × ${x.n}`).join(', ');
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** The newest `docs/results/<version>-evals.md` of this version (written by `eval:all --save`), read for its counts. */
export function evalPageOf(root: string): HowSheDid['evals'] {
  try {
    const version = String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '');
    const file = join(root, 'docs', 'results', `${version}-evals.md`);
    if (!version || !existsSync(file)) return undefined;
    const page = readFileSync(file, 'utf8');
    const head = /^Sara \S+ · \S+ · (\d+) of (\d+) ended well/m.exec(page);
    if (!head) return undefined;
    const failed = page.split('\n').filter((l) => l.includes('**FAILED**')).map((l) => l.split('|')[1]?.trim() ?? '').filter(Boolean);
    return { version, ok: Number(head[1]), all: Number(head[2]), failed };
  } catch {
    return undefined;
  }
}

/** The week from `from` to `to` (ISO), counted. `root` is where package.json and docs/results are. */
export function howSheDid(app: AppContext, from: string, to: string, opts: { root?: string } = {}): HowSheDid {
  const db = app.store.db;
  const has = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

  // Replies that failed (the error notice kept in the chat) and backup models (the fallback notice).
  const why: Partial<Record<FailReason, number>> = {};
  let failedN = 0;
  const fellFrom = new Map<string, number>();
  let fallbacks = 0;
  for (const r of db.prepare("SELECT content, meta FROM messages WHERE role = 'notice' AND created_at >= ? AND created_at < ? AND (content LIKE 'turnerror:%' OR content LIKE 'fallback:%')").all(from, to) as Row[]) {
    const m = meta(r.meta);
    if (String(r.content).startsWith('turnerror:')) {
      const reason = failReason(String(m.errorClass ?? ''), String(m.error ?? ''));
      why[reason] = (why[reason] ?? 0) + 1;
      failedN++;
    } else {
      fallbacks++;
      const p = (m.params ?? {}) as Record<string, unknown>;
      bump(fellFrom, String(p.was ?? '?'));
    }
  }

  // Tools that failed, and the receipt check's flags (sentences no tool backed up).
  const toolFails = new Map<string, number>();
  let claims = 0;
  let replies = 0;
  for (const r of db.prepare("SELECT role, meta FROM messages WHERE created_at >= ? AND created_at < ? AND role IN ('tool', 'assistant') AND meta IS NOT NULL").all(from, to) as Row[]) {
    const m = meta(r.meta);
    if (r.role === 'tool') {
      if (m.status === 'error') bump(toolFails, String(m.name ?? '?'));
    } else if (Array.isArray(m.unverified) && m.unverified.length) {
      claims += m.unverified.length;
      replies++;
    }
  }

  // Slow replies: chat turns over the mark, by the model of their last step.
  const slowBy = new Map<string, number>();
  let slowN = 0;
  if (has('runs') && has('run_steps')) {
    const rows = db
      .prepare("SELECT r.id, (SELECT s.model FROM run_steps s WHERE s.run_id = r.id AND s.model IS NOT NULL ORDER BY s.idx DESC LIMIT 1) AS model FROM runs r WHERE r.kind = 'turn' AND r.parent_run_id IS NULL AND r.started_at >= ? AND r.started_at < ? AND r.ms > ?")
      .all(from, to, SLOW_TURN_MS) as Row[];
    for (const r of rows) {
      slowN++;
      bump(slowBy, String(r.model ?? '?'));
    }
  }

  // Chats whose memory notes could not be written (the memory worker's last try failed this week).
  let memChats = 0;
  if (has('memory_state')) memChats = Number((db.prepare('SELECT COUNT(*) AS n FROM memory_state WHERE last_error IS NOT NULL AND last_attempt_at >= ? AND last_attempt_at < ?').get(from, to) as Row).n);

  // The owner only: the eval page of the version he runs.
  const evals = app.member ? undefined : evalPageOf(opts.root ?? ROOT);

  const h: Omit<HowSheDid, 'lines'> = {
    failed: { n: failedN, why },
    tools: top(toolFails).slice(0, 5),
    fallbacks: { n: fallbacks, models: top(fellFrom) },
    slow: { n: slowN, seconds: SLOW_TURN_MS / 1000, models: top(slowBy) },
    corrections: { claims, replies },
    memory: { chats: memChats },
    ...(evals ? { evals } : {}),
  };
  return { ...h, lines: howLines(h) };
}

/** The sentences, in order: what failed and why, tools, backups, slow replies, corrections, memory, evals. */
export function howLines(h: Omit<HowSheDid, 'lines'>): HowLine[] {
  const out: HowLine[] = [];
  for (const r of ['slow', 'unreachable', 'limit', 'auth', 'context', 'service', 'other'] as const) {
    const n = h.failed.why[r] ?? 0;
    if (n) out.push({ key: REASON_LINE[r], params: { n } });
  }
  if (h.tools.length) out.push({ key: en('Tools that failed most: {list}.'), params: { list: list(h.tools) } });
  if (h.fallbacks.n) out.push({ key: en('Times a backup model had to take over: {n} (the model that failed or was slow: {list}).'), params: { n: h.fallbacks.n, list: list(h.fallbacks.models) } });
  if (h.slow.n) out.push({ key: en('Replies that took longer than {seconds} seconds: {n} (on {list}).'), params: { n: h.slow.n, seconds: h.slow.seconds, list: list(h.slow.models) } });
  if (h.corrections.claims) out.push({ key: en('Corrections the receipt check added: {n} sentences no tool backed up, in {replies} of my replies.'), params: { n: h.corrections.claims, replies: h.corrections.replies } });
  if (h.memory.chats) out.push({ key: en('Chats whose memory notes could not be written: {n}.'), params: { n: h.memory.chats } });
  if (!out.length) out.push({ key: HOW_EMPTY, params: {} });
  if (h.evals) {
    out.push({ key: en('The checks for this version ({version}) that need no model: {ok} of {all} ended well.'), params: { version: h.evals.version, ok: h.evals.ok, all: h.evals.all } });
    if (h.evals.failed.length) out.push({ key: en('Checks that failed: {list}.'), params: { list: h.evals.failed.join(', ') } });
  }
  return out;
}
