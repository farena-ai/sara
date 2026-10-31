// Phase 97 (ST2, docs/design/STAPLES.md §5): skills she learns.
//
// She notices when the owner asks for the same kind of thing again and again (ask clusters), or
// when she runs the same chain of steps again and again in coding (chain mining over run_steps),
// and OFFERS to keep it as a skill, with a draft to edit. Never silent: a card in the chat after the
// reply, "Save it / Edit first / Not now / Never for this"; nothing is written to skills/ before
// Save it. A saved learned skill starts on trial (listed only for strong matches, never loaded up
// front) until the skill check (an M9 eval: control vs "with this skill loaded") says it helps.
// After a turn that used a skill she proposes a fix when a step failed and a different one worked,
// or when the owner corrected her: a diff card, "Apply / Edit / Dismiss"; applying keeps a version.
//
// Signals and thresholds (each a constant below, the counts are the owner's settings):
//   asks    cosine ≥ 0.82 to a cluster's centroid (0.6 with the word-vector fallback when no
//           embeddings job is set) and the same coarse kind (coding / mail / planner / web / home /
//           writing, from the tools the turn used); a candidate at 3 asks on ≥ 2 days within 30
//           days whose turns ended well (not stopped, not corrected, replaced or reported)
//   chains  the ordered tool calls of finished coding runs, each reduced to a signature (tool name +
//           argument shape, commands normalized, paths/numbers/quoted text stripped); a common chain
//           of ≥ 3 steps (one extra step allowed) in 3 runs on ≥ 2 days; mined once a night, last
//           500 runs, 50 ms per run
//   covered a turn where she opened a skill, or whose best skill match scores ≥ 0.7, is never a
//           new candidate (it feeds the fixes instead)
//   offers  after the reply of a clean turn only (no approval, budget stop or error), one a day
//           (setting), none in quiet hours, never in partner / group / private / imported / -nsfw /
//           other-app conversations or the demo; Not now = 14 days quiet, a 5th occurrence offers
//           once more; Never sticks
//   fixes   one proposal per skill per day; 3 dismissed → none for 30 days
//
// Candidates hold ids (conversation, message, run, day), never copied text. The draft is written
// by the companion's Writing model route from scrubbed examples (keys, emails, phone numbers and
// street addresses taken out), or plainly from the steps when no model can be used.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveChain, type AppContext } from './chat.ts';
import { cosine, embedTarget, embedTexts } from './embeddings.ts';
import { ALPHA, CORRECTION, evalSchedule, feedbackOf, signTest, similarity, tasksFromRuns, TIE_EPSILON, WEIGHTS, type EvalKind, type EvalResult, type VariantSpec } from './evals.ts';
import { complete, proactiveSettings } from './life.ts';
import { localDate } from './memory-worker.ts';
import { zonedParts } from './planner.ts';
import { sharedWithApps } from './recall.ts';
import type { RunView, StepView, ToolStep } from './runs.ts';
import { jsonIn } from './security/pass.ts';
import type { SkillView } from './skill-store.ts';
import { MAX_DESCRIPTION, serializeSkill, SKILL_NAME_RE, slugify, uniqueName } from './skills.ts';
import type { Conversation } from './store.ts';
import { normalizeCommand, sigOf, stepFailed } from './triggers.ts';

// ------------------------------------------------------------------------------------------------
// Settings (per companion: `skillLearning`; Settings → Abilities → Skills → Skills she learns)
// ------------------------------------------------------------------------------------------------

export interface LearnSettings {
  /** Offer to make skills. */
  offer: boolean;
  /** How many times before she offers (2–6). */
  times: number;
  /** Look back (days). */
  lookBackDays: number;
  /** Offers per day. */
  perDay: number;
  /** Check learned skills before using them (the M9 skill check runs on its own). */
  check: boolean;
  /** Learn from step chains in coding. */
  chains: boolean;
  /** Propose fixes after using a skill. */
  fixes: boolean;
}
export const DEFAULT_LEARN: LearnSettings = { offer: true, times: 3, lookBackDays: 30, perDay: 1, check: true, chains: true, fixes: true };
export const TIMES_CHOICES = [2, 3, 4, 5, 6] as const;
export const LOOKBACK_CHOICES = [14, 30, 60, 90] as const;
export const PER_DAY_CHOICES = [1, 2, 3] as const;

export function learnSettings(s: { skillLearning?: Partial<LearnSettings> } | undefined): LearnSettings {
  const v = (s?.skillLearning ?? {}) as Partial<LearnSettings>;
  const pick = <T extends number>(x: unknown, list: readonly T[], d: T): T => ((list as readonly number[]).includes(Number(x)) ? (Number(x) as T) : d);
  return {
    offer: v.offer !== false,
    times: pick(v.times, TIMES_CHOICES, DEFAULT_LEARN.times as 3),
    lookBackDays: pick(v.lookBackDays, LOOKBACK_CHOICES, DEFAULT_LEARN.lookBackDays as 30),
    perDay: pick(v.perDay, PER_DAY_CHOICES, DEFAULT_LEARN.perDay as 1),
    check: v.check !== false,
    chains: v.chains !== false,
    fixes: v.fixes !== false,
  };
}

/** A settings change from the page, checked against the pick-lists. */
export function mergeLearn(cur: LearnSettings, patch: Record<string, unknown>): LearnSettings {
  const next: Record<string, unknown> = { ...cur };
  for (const k of ['offer', 'check', 'chains', 'fixes'] as const) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  for (const k of ['times', 'lookBackDays', 'perDay'] as const) if (patch[k] !== undefined) next[k] = Number(patch[k]);
  return learnSettings({ skillLearning: next as Partial<LearnSettings> });
}

// ------------------------------------------------------------------------------------------------
// Thresholds
// ------------------------------------------------------------------------------------------------

/** §5.2: an ask joins a cluster at this cosine to its centroid (meaning vectors). */
export const ASK_SIM = 0.82;
/** The same with the word-vector fallback (no embeddings job set). */
export const WORD_SIM = 0.6;
/** One embeddings call at the end of a turn waits at most this long (a cold local model takes seconds to load). */
export const EMBED_TIMEOUT_MS = 8000;
/** At least this many different days. */
export const MIN_DAYS = 2;
/**
 * A request a skill already covers (the best meaning match scores this or more) is not a new
 * candidate. The design said 0.55 (the recipes' floor); measured with nomic-embed-text, unrelated
 * requests score 0.54–0.65 against the built-in how-tos and real matches 0.72–0.77, so 0.7 (the
 * trial skills' "strong match").
 */
export const COVERED_SCORE = 0.7;
/** §5.4: Not now = quiet this long; then an occurrence two past the threshold offers once more. */
export const SNOOZE_DAYS = 14;
export const MAX_DECLINES = 2;
/** §5.2 chains: at least this many steps, from the last 500 runs, 50 ms per run. */
export const CHAIN_MIN = 3;
export const CHAIN_MAX_WINDOW = 8;
export const CHAIN_RUNS = 500;
export const CHAIN_MS = 50;
/** §5.5: one fix proposal per skill per day; 3 dismissed → quiet for 30 days. */
export const FIX_DISMISSALS = 3;
export const FIX_QUIET_DAYS = 30;
/** §5.6: at most this many tasks in a skill check. */
export const CHECK_TASKS = 5;
/** A check is queued when the day's eval budget has less room than this (tokens). */
export const CHECK_MIN_ROOM = 20_000;

const DAY_MS = 86_400_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------------------------------------
// Which conversations and turns count
// ------------------------------------------------------------------------------------------------

const OTHER_APP_CHANNELS = new Set(['api', 'mcp', 'home-assistant', 'alexa', 'a2a', 'webhook', 'plugin']);

/** §5.8: only the owner's own conversations: never private, partner, group, imported, -nsfw or other apps'. */
export function learnable(c: Conversation | undefined): c is Conversation {
  if (!c) return false;
  if (!sharedWithApps(c)) return false;
  if (OTHER_APP_CHANNELS.has(c.channel) || c.channel.startsWith('group')) return false;
  return true;
}

export type AskTopic = 'coding' | 'mail' | 'planner' | 'web' | 'home' | 'writing';
export const ASK_TOPICS: readonly AskTopic[] = ['coding', 'mail', 'planner', 'web', 'home', 'writing'];
const TOPIC_TOOLS: [AskTopic, RegExp][] = [
  ['mail', /^(gmail_|email$)/],
  ['home', /^home_/],
  ['planner', /^(add_task|update_task|complete_task|delete_task|list_tasks|remind|add_note|update_note|delete_note|read_note|list_notes|calendar|calendar_add|calendar_events|calendar_remove|shared_list|todo|tasks|note|get_today|today)$/],
  ['web', /^(web_search|web_fetch|browser_|pc_browser_)/],
  ['coding', /^(shell|read_file|write_file|edit_file|apply_patch|list_dir|git|git_|github_|start_job|job_status|stop_job|code|review_code|preview_|starter_create|work_on_issue|delegate_task|team|ssh_)/],
];
const REQUEST = /^\s*(?:(?:please|pls|hey|ok|okay)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:write|draft|summari[sz]e|translate|rewrite|reword|proofread|compose|make|create|turn|list|plan|outline|put|prepare|format|reply|answer|fix|check|update|add|send|find|look up|sort|clean up|tidy|convert|pull|get|give me|go through)\b/i;

/** The coarse kind of an ask, from the tools the turn used (so "summarise my mail" and "summarise this PR" never merge). */
export function topicOf(tools: string[], text: string, coding = false): AskTopic | undefined {
  const score = new Map<AskTopic, number>();
  for (const t of tools) {
    const hit = TOPIC_TOOLS.find(([, re]) => re.test(t));
    if (hit) score.set(hit[0], (score.get(hit[0]) ?? 0) + 1);
  }
  if (score.size) return [...score.entries()].sort((a, b) => b[1] - a[1] || ASK_TOPICS.indexOf(a[0]) - ASK_TOPICS.indexOf(b[0]))[0][0];
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 4 || !REQUEST.test(text)) return undefined; // small talk is never a skill
  return coding ? 'coding' : 'writing';
}

// ------------------------------------------------------------------------------------------------
// Vectors
// ------------------------------------------------------------------------------------------------

const STOP = new Set('the and for you your with this that from into onto have has had are was were will would could should can please about them they their there here what when where which while then than just also very some more most much many like want need make sure again every each into over under after before ours mine yours'.split(' '));
const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/u, '');

/** The word-vector fallback (no embeddings job): hashed words, unit length. */
export function wordVector(text: string, dims = 512): Float32Array {
  const v = new Float32Array(dims);
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (STOP.has(raw)) continue;
    const w = stem(raw);
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  return unit(v);
}
function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const toBlob = (v: Float32Array) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const fromBlob = (b: Uint8Array | null | undefined) => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : new Float32Array(0));

// ------------------------------------------------------------------------------------------------
// Chains (§5.2 signal 2)
// ------------------------------------------------------------------------------------------------

/** One tool step as a signature: the tool and the shape of what it was given (no names, numbers or text). */
export function stepSignature(t: Pick<ToolStep, 'name' | 'args'>): string {
  if (t.name === 'shell' && typeof t.args.command === 'string') {
    const cmd = t.args.command.replace(/"[^"]*"|'[^']*'/g, '<s>');
    const norm = normalizeCommand(cmd)
      .split(' ')
      .map((tok) => (/^[\w.-]+\.[a-z0-9]{1,6}$/i.test(tok) ? '<file>' : /^[0-9a-f]{7,40}$/.test(tok) ? '<id>' : tok))
      .join(' ');
    return `shell:${norm}`;
  }
  return `${t.name}(${Object.keys(t.args ?? {}).sort().join(',')})`;
}

/** The ordered steps of a run (denied calls left out). */
export function chainOf(steps: StepView[]): string[] {
  const out: string[] = [];
  for (const s of steps) for (const t of s.tools) if (t.status !== 'denied') out.push(stepSignature(t));
  return out.slice(0, 60);
}

/** Every key a chain can match: its windows of 3–8 steps, and each with one inner step left out (\"one extra step\"). */
function chainKeys(chain: string[]): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (let len = CHAIN_MIN; len <= Math.min(CHAIN_MAX_WINDOW + 1, chain.length); len++) {
    for (let i = 0; i + len <= chain.length; i++) {
      const w = chain.slice(i, i + len);
      if (len <= CHAIN_MAX_WINDOW) keys.set(w.join('\u0001'), w);
      if (len > CHAIN_MIN) {
        for (let k = 1; k < len - 1; k++) {
          const p = [...w.slice(0, k), ...w.slice(k + 1)];
          keys.set(p.join('\u0001'), p);
        }
      }
    }
  }
  return keys;
}

const isSubseq = (a: string[], b: string[]) => {
  let i = 0;
  for (const x of b) if (x === a[i]) i++;
  return i === a.length;
};

export interface ChainRun {
  runId: number;
  day: string;
  chain: string[];
}
export interface CommonChain {
  key: string;
  pattern: string[];
  runs: number[];
  days: number;
}

/**
 * Chains of ≥ 3 steps that several runs share (one extra step allowed in a run), seen in at least
 * `minRuns` runs on `minDays` days. Longest first; a chain inside a longer one found is left out.
 */
export function commonChains(items: ChainRun[], opts: { minRuns: number; minDays: number; deadline?: number }): CommonChain[] {
  const seen = new Map<string, { pattern: string[]; runs: Set<number>; days: Set<string> }>();
  for (const it of items) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    for (const [k, p] of chainKeys(it.chain)) {
      let e = seen.get(k);
      if (!e) seen.set(k, (e = { pattern: p, runs: new Set(), days: new Set() }));
      e.runs.add(it.runId);
      e.days.add(it.day);
    }
  }
  const hits = [...seen.entries()].filter(([, e]) => e.runs.size >= opts.minRuns && e.days.size >= opts.minDays && new Set(e.pattern).size > 1);
  hits.sort((a, b) => b[1].pattern.length - a[1].pattern.length || b[1].runs.size - a[1].runs.size);
  const chosen: CommonChain[] = [];
  for (const [key, e] of hits) {
    if (chosen.some((c) => isSubseq(e.pattern, c.pattern) && [...e.runs].every((r) => c.runs.includes(r)))) continue;
    chosen.push({ key, pattern: e.pattern, runs: [...e.runs].sort((a, b) => a - b), days: e.days.size });
    if (chosen.length >= 10) break;
  }
  return chosen;
}

/** A chain step in plain words for the draft and the card. */
export function stepWords(sig: string): string {
  if (sig.startsWith('shell:')) return `run \`${sig.slice(6)}\``;
  const m = /^([\w-]+)\(/.exec(sig);
  return m ? `use ${m[1]}` : sig;
}

// ------------------------------------------------------------------------------------------------
// Scrubbing and diffs
// ------------------------------------------------------------------------------------------------

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const PHONE = /(?<![\w-])\+?\d[\d ().-]{7,}\d(?![\w-])/g;
const ADDRESS = /\b\d{1,5}\s+(?:[A-Z][\p{L}'-]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Calle|Rue|Straße|Strasse|Via|Rua)\b\.?/gu;
const KEYISH = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\b(?:ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA|AIza)[A-Za-z0-9_-]{10,}|\b[A-Za-z0-9+/_-]{40,}\b/g;

/** §5.4: what goes into a draft has secrets, emails, phone numbers and street addresses taken out. */
export function scrubForDraft(text: string, redact: (s: string) => string = (s) => s): string {
  return redact(String(text ?? ''))
    .replace(KEYISH, '[key]')
    .replace(EMAIL, '[email]')
    .replace(ADDRESS, '[address]')
    .replace(PHONE, '[phone]');
}

/** A unified diff of two texts (whole lines, 3 lines of context). */
export function unifiedDiff(a: string, b: string, name = 'SKILL.md'): string {
  const A = a.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const B = b.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return `--- a/${name}\n+++ b/${name}\n@@ -1,${n} +1,${m} @@\n${A.map((l) => `-${l}`).join('\n')}\n${B.map((l) => `+${l}`).join('\n')}\n`;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push({ t: ' ', s: A[i++], ai: i, bi: ++j });
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) ops.push({ t: '-', s: A[i++], ai: i, bi: j });
    else ops.push({ t: '+', s: B[j++], ai: i, bi: j });
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - 3);
    let end = k;
    while (end < ops.length) {
      if (ops[end].t !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === ' ') run++;
      if (end + run >= ops.length || run > 6) {
        end = Math.min(ops.length, end + 3);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk.find((o) => o.t !== '+')?.ai ?? 0;
    const bStart = hunk.find((o) => o.t !== '-')?.bi ?? 0;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen ? aStart : aStart},${aLen} +${bLen ? bStart : bStart},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k = end;
    start = end;
  }
  return `${out.join('\n')}\n`;
}

/** Adds a line under a heading of the body (the heading is made at the end when missing). */
export function addUnder(body: string, heading: string, line: string): string {
  const text = body.replace(/\s+$/, '');
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'mi');
  const m = re.exec(text);
  if (!m) return `${text}\n\n## ${heading}\n\n${line}\n`;
  // The end of that section: the next heading of the same or a higher level.
  const after = text.slice(m.index + m[0].length);
  const next = /\n#{1,2}\s/.exec(after);
  const cut = m.index + m[0].length + (next ? next.index : after.length);
  const head = text.slice(0, cut).replace(/\s+$/, '');
  return `${head}\n${line}\n${text.slice(cut)}`.replace(/\s+$/, '') + '\n';
}

// ------------------------------------------------------------------------------------------------
// The skill check's verdict (§5.6)
// ------------------------------------------------------------------------------------------------

export type Verdict = 'helps' | 'same' | 'hurts' | 'skipped';

/** The parts of a task's score that say how well it was done (not what it cost). */
export const QUALITY_PARTS = ['tests', 'done', 'feedback', 'judge', 'findings'] as const;

/**
 * helps / same / hurts from the eval's result for the \"with skill\" variant, on the quality parts
 * only (tests, done, the owner's reaction, the judge, findings): loading a skill always costs some
 * input tokens, so the cost parts are shown on the eval but don't decide a skill check. The sign
 * test can't reach p < 0.05 on ≤ 5 tasks (5 of 5 wins is p = 0.0625), so a clear lead also counts:
 * at least two more wins than losses is \"helps\", the mirror image \"hurts\".
 */
export function checkVerdict(result: EvalResult | null): Verdict | 'failed' {
  const v = result?.variants.find((x) => x.id !== 'control');
  if (!result || !v || !v.pairs) return 'failed';
  let wins = 0;
  let losses = 0;
  const q = (parts: Partial<Record<string, number>>) => {
    let w = 0;
    let sum = 0;
    for (const k of QUALITY_PARTS) {
      const x = parts[k];
      if (typeof x !== 'number' || !Number.isFinite(x)) continue;
      w += WEIGHTS[k];
      sum += WEIGHTS[k] * x;
    }
    return w ? sum / w : 0;
  };
  for (const t of result.tasks) {
    const x = t.variants[v.id];
    if (!x || x.outcome === 'missing') continue;
    const d = q(x.parts) - q(t.control.parts);
    if (d > TIE_EPSILON) wins++;
    else if (d < -TIE_EPSILON) losses++;
  }
  const p = signTest(wins, losses);
  if ((p < ALPHA && wins > losses) || wins - losses >= 2) return 'helps';
  if ((p < ALPHA && losses > wins) || losses - wins >= 2) return 'hurts';
  return 'same';
}

// ------------------------------------------------------------------------------------------------
// The tables (each companion's database; additive)
// ------------------------------------------------------------------------------------------------

export interface Example {
  conversationId: string;
  messageId: number;
  runId: number | null;
  day: string;
  at: string;
}
export type CandidateStatus = 'watching' | 'offered' | 'accepted' | 'snoozed' | 'never';
export interface Draft {
  name: string;
  description: string;
  body: string;
  /** model: written by her Writing model; plain: from the steps, no model (none could be used). */
  by: 'model' | 'plain';
}
export interface Candidate {
  id: number;
  kind: 'ask' | 'chain';
  signature: string;
  topic: AskTopic | null;
  model: string | null;
  centroid: Float32Array;
  examples: Example[];
  pattern: string[];
  count: number;
  days: number;
  firstSeen: string;
  lastSeen: string;
  status: CandidateStatus;
  snoozeUntil: string | null;
  skillName: string | null;
  offeredAt: string | null;
  declines: number;
  draft: Draft | null;
  drafting: boolean;
  conversationId: string | null;
}
export type FixKind = 'step-failed' | 'corrected' | 'replaced';
export interface Fix {
  id: number;
  scope: string;
  name: string;
  runId: string | null;
  kind: FixKind;
  evidence: Record<string, unknown>;
  diff: string;
  proposed: string;
  baseSha: string;
  why: string;
  status: 'proposed' | 'applied' | 'dismissed';
  at: string;
  decidedAt: string | null;
  conversationId: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  centroid BLOB,
  examples TEXT NOT NULL,
  count INTEGER NOT NULL,
  days INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching',
  snooze_until TEXT,
  skill_name TEXT,
  offered_at TEXT,
  topic TEXT,
  model TEXT,
  pattern TEXT,
  declines INTEGER NOT NULL DEFAULT 0,
  draft TEXT,
  conversation_id TEXT
);
CREATE TABLE IF NOT EXISTS skill_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  at TEXT NOT NULL,
  proposed TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS skill_fixes_skill ON skill_fixes(scope, name, at);
CREATE TABLE IF NOT EXISTS skill_checks (
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  eval_id INTEGER NOT NULL,
  verdict TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (scope, name, eval_id)
);
`;

type Row = Record<string, string | number | null | Uint8Array>;
const parse = <T>(v: unknown, d: T): T => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};

export class LearningStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
  }

  #cand(r: Row): Candidate {
    const draft = parse<(Draft & { drafting?: boolean }) | null>(r.draft, null);
    return {
      id: Number(r.id),
      kind: String(r.kind) as Candidate['kind'],
      signature: String(r.signature),
      topic: (r.topic as AskTopic | null) ?? null,
      model: (r.model as string | null) ?? null,
      centroid: fromBlob(r.centroid as Uint8Array | null),
      examples: parse<Example[]>(r.examples, []),
      pattern: parse<string[]>(r.pattern, []),
      count: Number(r.count),
      days: Number(r.days),
      firstSeen: String(r.first_seen),
      lastSeen: String(r.last_seen),
      status: String(r.status) as CandidateStatus,
      snoozeUntil: (r.snooze_until as string | null) ?? null,
      skillName: (r.skill_name as string | null) ?? null,
      offeredAt: (r.offered_at as string | null) ?? null,
      declines: Number(r.declines ?? 0),
      draft: draft && !draft.drafting && draft.name ? { name: draft.name, description: draft.description, body: draft.body, by: draft.by } : null,
      drafting: Boolean(draft?.drafting),
      conversationId: (r.conversation_id as string | null) ?? null,
    };
  }
  candidate(id: number): Candidate | undefined {
    const r = this.db.prepare('SELECT * FROM skill_candidates WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#cand(r) : undefined;
  }
  bySignature(sig: string): Candidate | undefined {
    const r = this.db.prepare('SELECT * FROM skill_candidates WHERE signature = ?').get(sig) as Row | undefined;
    return r ? this.#cand(r) : undefined;
  }
  candidates(where: { kind?: 'ask' | 'chain'; topic?: string; status?: CandidateStatus[] } = {}): Candidate[] {
    const rows = this.db.prepare('SELECT * FROM skill_candidates ORDER BY id').all() as Row[];
    return rows.map((r) => this.#cand(r)).filter((c) => (!where.kind || c.kind === where.kind) && (!where.topic || c.topic === where.topic) && (!where.status || where.status.includes(c.status)));
  }
  insert(c: { kind: 'ask' | 'chain'; signature: string; topic?: string | null; model?: string | null; centroid?: Float32Array; examples: Example[]; pattern?: string[]; days: number; at: string }): Candidate {
    const r = this.db
      .prepare('INSERT INTO skill_candidates (kind, signature, centroid, examples, count, days, first_seen, last_seen, topic, model, pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.kind, c.signature, c.centroid ? toBlob(c.centroid) : null, JSON.stringify(c.examples), c.examples.length, c.days, c.at, c.at, c.topic ?? null, c.model ?? null, c.pattern ? JSON.stringify(c.pattern) : null);
    return this.candidate(Number(r.lastInsertRowid))!;
  }
  patch(id: number, p: Partial<{ centroid: Float32Array; examples: Example[]; days: number; lastSeen: string; status: CandidateStatus; snoozeUntil: string | null; skillName: string | null; offeredAt: string | null; declines: number; draft: (Draft & { drafting?: boolean; note?: string }) | null; conversationId: string | null }>): void {
    const set: string[] = [];
    const vals: (string | number | null | Uint8Array)[] = [];
    const put = (col: string, v: string | number | null | Uint8Array) => {
      set.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.centroid) put('centroid', toBlob(p.centroid));
    if (p.examples) {
      put('examples', JSON.stringify(p.examples));
      put('count', p.examples.length);
    }
    if (p.days !== undefined) put('days', p.days);
    if (p.lastSeen) put('last_seen', p.lastSeen);
    if (p.status) put('status', p.status);
    if (p.snoozeUntil !== undefined) put('snooze_until', p.snoozeUntil);
    if (p.skillName !== undefined) put('skill_name', p.skillName);
    if (p.offeredAt !== undefined) put('offered_at', p.offeredAt);
    if (p.declines !== undefined) put('declines', p.declines);
    if (p.draft !== undefined) put('draft', p.draft ? JSON.stringify(p.draft) : null);
    if (p.conversationId !== undefined) put('conversation_id', p.conversationId);
    if (!set.length) return;
    this.db.prepare(`UPDATE skill_candidates SET ${set.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  offeredOn(day: string, tz: string | undefined): number {
    const rows = this.db.prepare('SELECT offered_at FROM skill_candidates WHERE offered_at IS NOT NULL').all() as Row[];
    return rows.filter((r) => localDate(String(r.offered_at), tz) === day).length;
  }

  #fix(r: Row): Fix {
    return {
      id: Number(r.id),
      scope: String(r.scope),
      name: String(r.name),
      runId: (r.run_id as string | null) ?? null,
      kind: String(r.kind) as FixKind,
      evidence: parse<Record<string, unknown>>(r.evidence, {}),
      diff: String(r.diff),
      proposed: String(r.proposed ?? ''),
      baseSha: String(r.base_sha ?? ''),
      why: String(r.why ?? ''),
      status: String(r.status) as Fix['status'],
      at: String(r.at),
      decidedAt: (r.decided_at as string | null) ?? null,
      conversationId: (r.conversation_id as string | null) ?? null,
    };
  }
  fix(id: number): Fix | undefined {
    const r = this.db.prepare('SELECT * FROM skill_fixes WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#fix(r) : undefined;
  }
  fixes(where: { scope?: string; name?: string; status?: Fix['status'] } = {}): Fix[] {
    return (this.db.prepare('SELECT * FROM skill_fixes ORDER BY id DESC LIMIT 500').all() as Row[]).map((r) => this.#fix(r)).filter((f) => (!where.scope || f.scope === where.scope) && (!where.name || f.name === where.name) && (!where.status || f.status === where.status));
  }
  addFix(f: Omit<Fix, 'id' | 'status' | 'decidedAt'>): Fix {
    const r = this.db
      .prepare('INSERT INTO skill_fixes (scope, name, run_id, kind, evidence, diff, at, proposed, base_sha, why, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.scope, f.name, f.runId, f.kind, JSON.stringify(f.evidence), f.diff, f.at, f.proposed, f.baseSha, f.why, f.conversationId);
    return this.fix(Number(r.lastInsertRowid))!;
  }
  decideFix(id: number, status: 'applied' | 'dismissed', at: string): void {
    this.db.prepare('UPDATE skill_fixes SET status = ?, decided_at = ? WHERE id = ?').run(status, at, id);
  }

  addCheck(scope: string, name: string, evalId: number, verdict: Verdict | null, at: string): void {
    this.db.prepare('INSERT INTO skill_checks (scope, name, eval_id, verdict, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, name, eval_id) DO UPDATE SET verdict = excluded.verdict, at = excluded.at').run(scope, name, evalId, verdict, at);
  }
  checks(scope?: string, name?: string): { scope: string; name: string; evalId: number; verdict: Verdict | null; at: string }[] {
    const rows = (scope && name ? this.db.prepare('SELECT * FROM skill_checks WHERE scope = ? AND name = ? ORDER BY at DESC').all(scope, name) : this.db.prepare('SELECT * FROM skill_checks ORDER BY at DESC LIMIT 200').all()) as Row[];
    return rows.map((r) => ({ scope: String(r.scope), name: String(r.name), evalId: Number(r.eval_id), verdict: (r.verdict as Verdict | null) ?? null, at: String(r.at) }));
  }
}

// ------------------------------------------------------------------------------------------------
// The learner (one per companion space; the demo has none)
// ------------------------------------------------------------------------------------------------

export interface TurnInfo {
  conversationId: string;
  userText: string;
  runId: number | null;
  replyId: number;
  /** The turn asked the owner something (an approval card): no offer in it. */
  sawApproval: boolean;
  budgetStop: boolean;
  /** Tool names the turn called. */
  tools: string[];
}

export interface OfferView {
  id: number;
  kind: 'ask' | 'chain';
  topic: AskTopic | null;
  status: CandidateStatus;
  count: number;
  days: number;
  since: string;
  /** The steps of a chain in plain words. */
  steps: string[];
  draft: Draft | null;
  drafting: boolean;
  skillName: string | null;
  snoozeUntil: string | null;
  conversationId: string | null;
  /** The skill it became and its standing (trial until checked). */
  skill?: { scope: string; name: string; status: string; checkState: string | null } | undefined;
}

export class SkillLearner {
  readonly store: LearningStore;
  readonly #app: AppContext;
  /** Background work (drafts, checks); tests wait on it. */
  work: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #drafts = new Map<number, Promise<Draft | null>>();

  constructor(app: AppContext, db: DatabaseSync = app.store.db) {
    this.#app = app;
    this.store = new LearningStore(db);
  }

  settings(): LearnSettings {
    return learnSettings(this.#app.settings.get() as { skillLearning?: Partial<LearnSettings> });
  }
  setSettings(patch: Record<string, unknown>): LearnSettings {
    const next = mergeLearn(this.settings(), patch);
    this.#app.settings.update({ skillLearning: next } as Parameters<AppContext['settings']['update']>[0]);
    return this.settings();
  }

  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone;
  }
  #day(at: string | Date = this.#now()): string {
    return localDate(typeof at === 'string' ? at : at.toISOString(), this.#tz());
  }
  #bg<T>(p: Promise<T>): Promise<T> {
    const next = this.work.then(() => p, () => p);
    this.work = next.catch(() => undefined);
    return p;
  }
  #redact = (s: string) => this.#app.redactor.redact(s);

  // -- examples and readiness -------------------------------------------------------------------

  /** Examples whose conversation and message still exist and may be learned from (deleting a conversation removes its examples). */
  #live(c: Candidate): Example[] {
    const store = this.#app.store;
    const cutoff = this.#now().getTime() - this.settings().lookBackDays * DAY_MS;
    const ok = c.examples.filter((e) => {
      if (Date.parse(e.at) < cutoff) return false;
      const conv = store.getConversation(e.conversationId);
      if (!learnable(conv)) return false;
      return Boolean(store.messageById(e.messageId));
    });
    if (ok.length !== c.examples.length) {
      this.store.patch(c.id, { examples: ok, days: new Set(ok.map((e) => e.day)).size });
      // §5.8: a candidate that drops below the count goes back to watching.
      if (c.status === 'offered' && ok.length < this.settings().times) this.store.patch(c.id, { status: 'watching', offeredAt: null });
    }
    return ok;
  }

  /** Examples whose turn ended well: not stopped or failed, and not corrected, replaced or reported afterwards. */
  #good(examples: Example[]): Example[] {
    const runs = this.#app.runs;
    return examples.filter((e) => {
      if (!e.runId || !runs) return true;
      const run = runs.get(e.runId);
      if (!run) return true;
      if (run.status === 'error' || run.status === 'stopped') return false;
      const fb = feedbackOf(this.#app, run);
      return fb.kind !== 'corrected' && fb.kind !== 'replaced' && fb.kind !== 'reported';
    });
  }

  /** Ready to offer now (§5.2 thresholds, §5.4 snooze rule). */
  ready(c: Candidate): boolean {
    const s = this.settings();
    const live = this.#live(c);
    if (c.status !== 'watching' && c.status !== 'snoozed') return false;
    const good = this.#good(live);
    const days = new Set(good.map((e) => e.day)).size;
    if (days < MIN_DAYS) return false;
    if (c.status === 'watching') return good.length >= s.times;
    return Boolean(c.snoozeUntil && this.#now().getTime() >= Date.parse(c.snoozeUntil) && c.declines < MAX_DECLINES && good.length >= s.times + 2);
  }

  #quiet(): boolean {
    const cfg = proactiveSettings(this.#app);
    const h = zonedParts(this.#now(), this.#tz()).h;
    return cfg.quietStart > cfg.quietEnd ? h >= cfg.quietStart || h < cfg.quietEnd : h >= cfg.quietStart && h < cfg.quietEnd;
  }

  // -- the end of a turn --------------------------------------------------------------------------

  /**
   * After the reply of one of the owner's turns (chat.ts runTurn): fixes for skills the turn used,
   * the ask signal, and at most one offer card. Cheap: one embedding call at most, no model call
   * (the draft is written in the background).
   */
  async afterTurn(info: TurnInfo): Promise<{ offer?: number; fixes: number[]; candidate?: number }> {
    const app = this.#app;
    const out: { offer?: number; fixes: number[]; candidate?: number } = { fixes: [] };
    const s = this.settings();
    const conv = app.store.getConversation(info.conversationId);
    if (!learnable(conv) || !app.skills) return out;
    const userMsg = app.store.messages(conv.id).filter((m) => m.role === 'user').at(-1);
    if (!userMsg) return out;
    const clean = !info.sawApproval && !info.budgetStop;
    const used = info.runId ? this.#usedIn(info.runId) : [];
    if (s.fixes) out.fixes.push(...this.#fixesAfter(conv, info, used));
    if (!s.offer) return out;
    // The ask signal (a request already covered by a skill feeds the fixes instead). A skill she
    // opened herself covers it; one only loaded up front covers it when it matches strongly (checked
    // below), since the auto-load floor lets a loosely related how-to in.
    let candidate: Candidate | undefined;
    const opened = info.runId ? (app.store.db.prepare("SELECT COUNT(*) AS n FROM skill_uses WHERE run_id = ? AND how != 'auto'").get(String(info.runId)) as { n: number }).n : 0;
    if (!opened && !info.tools.some((t) => t === 'skill_use')) {
      candidate = await this.#observeAsk(conv, userMsg.id, info).catch((err) => {
        console.warn(`skill learning: ${(err as Error).message}`);
        return undefined;
      });
      if (candidate) out.candidate = candidate.id;
    }
    if (!clean || this.#quiet()) return out;
    if (this.store.offeredOn(this.#day(), this.#tz()) >= s.perDay) return out;
    let pick = candidate && this.ready(candidate) ? candidate : undefined;
    // A chain mined last night is offered at the end of the next clean coding turn.
    if (!pick && conv.mode === 'coding' && s.chains) pick = this.store.candidates({ kind: 'chain', status: ['watching', 'snoozed'] }).find((c) => this.ready(c));
    if (pick) out.offer = this.#offer(pick, conv);
    return out;
  }

  /** The skills a run used: opened or loaded in it, or still loaded from earlier in the conversation (run_steps.skills). */
  #usedIn(runId: number): { scope: string; name: string }[] {
    const rows = this.#app.store.db.prepare('SELECT DISTINCT scope, name FROM skill_uses WHERE run_id = ?').all(String(runId)) as Row[];
    const out = rows.map((r) => ({ scope: String(r.scope), name: String(r.name) }));
    for (const step of this.#app.runs?.steps(runId) ?? []) {
      for (const n of step.skills) {
        const v = this.#app.skills?.resolve(n);
        if (v && !out.some((x) => x.scope === v.scope && x.name === v.name)) out.push({ scope: v.scope, name: v.name });
      }
    }
    return out;
  }

  async #observeAsk(conv: Conversation, messageId: number, info: TurnInfo): Promise<Candidate | undefined> {
    const app = this.#app;
    const text = info.userText.trim();
    const topic = topicOf(info.tools.filter((t) => !t.startsWith('skill_')), text, conv.mode === 'coding');
    if (!topic) return undefined;
    const target = embedTarget(app);
    // Covered by an existing skill (§5.2): not a candidate for a new one.
    if (target) {
      const [best] = await app.skills!.searchMeaning(target, text, EMBED_TIMEOUT_MS);
      if (best && best.score >= COVERED_SCORE) return undefined;
    }
    let vec: Float32Array;
    let model = 'words';
    if (target) {
      // With the embeddings job set, an ask is placed by meaning or not at all: a word vector after a
      // failed call would start a stray cluster beside the right one (seen live while Ollama loaded
      // the embedding model).
      try {
        const prefix = /nomic-embed/i.test(target.model) ? 'clustering: ' : '';
        const [v] = await embedTexts(target, [`${prefix}${text.slice(0, 2000)}`], AbortSignal.timeout(EMBED_TIMEOUT_MS));
        vec = unit(new Float32Array(v));
        model = target.model;
      } catch (err) {
        console.warn(`skill learning: the ask wasn't placed (embeddings: ${(err as Error).message})`);
        return undefined;
      }
    } else vec = wordVector(text);
    const thr = model === 'words' ? WORD_SIM : ASK_SIM;
    const at = this.#now().toISOString();
    const ex: Example = { conversationId: conv.id, messageId, runId: info.runId, day: this.#day(at), at };
    let best: { c: Candidate; sim: number } | undefined;
    for (const c of this.store.candidates({ kind: 'ask', topic })) {
      if ((c.model ?? 'words') !== model || c.centroid.length !== vec.length) continue;
      const sim = cosine(c.centroid, vec);
      if (sim >= thr && (!best || sim > best.sim)) best = { c, sim };
    }
    if (!best) return this.store.insert({ kind: 'ask', signature: `ask:${topic}:${randomBytes(6).toString('hex')}`, topic, model, centroid: vec, examples: [ex], days: 1, at });
    const c = best.c;
    const examples = [...this.#live(c).filter((e) => e.messageId !== messageId), ex].slice(-50);
    const n = Math.max(1, c.examples.length);
    const centroid = unit(Float32Array.from(c.centroid, (x, i) => x * n + vec[i]));
    this.store.patch(c.id, { centroid, examples, days: new Set(examples.map((e) => e.day)).size, lastSeen: at });
    return this.store.candidate(c.id);
  }

  /** The offer card: a notice in the conversation (after the reply), and the draft written in the background. */
  #offer(c: Candidate, conv: Conversation): number {
    const at = this.#now().toISOString();
    const notice = this.#app.store.addMessage(conv.id, 'notice', `skill:${c.id}`, { offer: c.id });
    this.store.patch(c.id, { status: 'offered', offeredAt: at, conversationId: conv.id });
    this.#app.events?.publish({ type: 'skills' });
    void this.#bg(this.draft(c.id)).catch(() => undefined);
    return notice.id;
  }

  // -- the draft (§5.4) --------------------------------------------------------------------------

  /** What a draft is written from: the asks (scrubbed), the steps that worked, the pitfalls (failed steps later fixed). */
  material(c: Candidate): { asks: string[]; steps: string[]; pitfalls: string[] } {
    const app = this.#app;
    const asks: string[] = [];
    const steps: string[] = [];
    const pitfalls: string[] = [];
    const examples = this.#good(this.#live(c)).slice(-5);
    for (const e of examples) {
      const m = app.store.messageById(e.messageId);
      if (m && m.role === 'user') asks.push(clip(scrubForDraft(m.content.replace(/\s+/g, ' ').trim(), this.#redact), 400));
    }
    // The steps of the newest run (the way that worked last), and failed steps of all of them.
    const runIds = examples.map((e) => e.runId).filter((x): x is number => Boolean(x));
    const last = runIds.at(-1);
    for (const id of runIds) {
      const tools = (app.runs?.steps(id) ?? []).flatMap((s) => s.tools);
      tools.forEach((t, i) => {
        if (id === last && t.status === 'ok' && !stepFailed(t.name, t.status, t.output) && !t.name.startsWith('skill_')) steps.push(clip(scrubForDraft(t.summary || stepWords(stepSignature(t)), this.#redact), 200));
        if (stepFailed(t.name, t.status, t.output)) {
          const fixed = tools.slice(i + 1).find((x) => x.name === t.name && x.status === 'ok' && !stepFailed(x.name, x.status, x.output));
          if (fixed) pitfalls.push(clip(scrubForDraft(`${t.summary} failed; ${fixed.summary} worked`, this.#redact), 240));
        }
      });
    }
    if (c.kind === 'chain' && !steps.length) for (const p of c.pattern) steps.push(stepWords(p));
    return { asks: [...new Set(asks)], steps: [...new Set(steps)].slice(0, 15), pitfalls: [...new Set(pitfalls)].slice(0, 6) };
  }

  /** A plain draft from the material (no model): her name for it, what + when, and the steps. */
  plainDraft(c: Candidate): Draft {
    const m = this.material(c);
    const first = m.asks[0] ?? (c.kind === 'chain' ? m.steps.join(', ') : 'this task');
    const words = first.toLowerCase().replace(/\[[a-z]+\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5);
    const base = slugify(words.join(' ')) || (c.kind === 'chain' ? 'repeat-these-steps' : 'repeat-this-task');
    const title = words.length ? words.join(' ') : 'this task';
    const description = clip(c.kind === 'chain' ? `Runs the same steps as before: ${m.steps.slice(0, 4).join(', ')}. Use when this kind of coding job comes up again.` : `Does what the owner asked ${m.asks.length} times, like "${clip(first, 120)}". Use when the owner asks for this again.`, MAX_DESCRIPTION);
    const lines = [`# ${title[0].toUpperCase()}${title.slice(1)}`, '', '## Steps', '', ...(m.steps.length ? m.steps.map((x, i) => `${i + 1}. ${x}`) : ['1. Do it the way it worked last time.']), '', '## Checks', '', '- Look at the result before saying it is done.'];
    if (m.pitfalls.length) lines.push('', '## Pitfalls', '', ...m.pitfalls.map((x) => `- ${x}`));
    return { name: base, description, body: `${lines.join('\n')}\n`, by: 'plain' };
  }

  /** The draft, written once by the Writing model route (scrubbed in and out), or plainly. */
  async draft(id: number): Promise<Draft | null> {
    const c = this.store.candidate(id);
    if (!c) return null;
    if (c.draft) return c.draft;
    const running = this.#drafts.get(id);
    if (running) return running;
    const p = (async () => {
      const plain = this.plainDraft(c);
      this.store.patch(id, { draft: { ...plain, drafting: true } });
      const conv = (c.conversationId ? this.#app.store.getConversation(c.conversationId) : undefined) ?? this.#app.store.getConversation(c.examples.at(-1)?.conversationId ?? '');
      let draft: Draft = plain;
      if (conv) {
        const m = this.material(c);
        const system = [
          'You write a skill: a short how-to an assistant follows the next time the owner asks for this kind of task.',
          'Answer ONLY JSON: {"name": "<name>", "description": "<description>", "body": "<body>"}.',
          '- name: 2 to 5 lower-case words about the task, joined by hyphens.',
          '- description: what it does and when to use it, one or two sentences, ending with "Use when ...".',
          '- body: Markdown with a # title, ## Steps (numbered), ## Checks and ## Pitfalls.',
          'Use only what the examples show. Never include passwords, keys, tokens, email addresses, phone numbers, street addresses or names of people: say "the owner" and keep placeholders like [email]. Do not copy these rules into the skill.',
        ].join('\n');
        const user = [`The owner asked for this ${m.asks.length || c.examples.length} times:`, ...m.asks.map((a) => `- "${a}"`), '', 'The steps that worked last time:', ...(m.steps.length ? m.steps.map((x) => `- ${x}`) : ['- (no tool steps; a written answer)']), ...(m.pitfalls.length ? ['', 'Steps that failed and how they were fixed:', ...m.pitfalls.map((x) => `- ${x}`)] : [])].join('\n');
        try {
          const text = await complete(this.#app, conv, [{ role: 'system', content: system }, { role: 'user', content: user }], 900, 'writing');
          const j = jsonIn(text) as Record<string, unknown> | undefined;
          // A small model sometimes copies the format's own words as the name: then her plain name is kept.
          const raw = slugify(String(j?.name ?? ''));
          const name = /hyphen|lower-case|^name$/.test(raw) ? plain.name : raw;
          const description = scrubForDraft(String(j?.description ?? '').replace(/\s+/g, ' ').trim(), this.#redact);
          const body = scrubForDraft(String(j?.body ?? '').trim(), this.#redact);
          if (j && SKILL_NAME_RE.test(name) && description.length >= 10 && body.length >= 10) draft = { name, description: clip(description, MAX_DESCRIPTION), body: `${clip(body, 12_000)}\n`, by: 'model' };
        } catch (err) {
          console.warn(`skill draft: ${(err as Error).message}`);
        }
      }
      this.store.patch(id, { draft });
      this.#app.events?.publish({ type: 'skills' });
      return draft;
    })().finally(() => this.#drafts.delete(id));
    this.#drafts.set(id, p);
    return p;
  }

  // -- the owner's answer to an offer (§5.4) -----------------------------------------------------

  offerView(id: number): OfferView | undefined {
    const c = this.store.candidate(id);
    if (!c) return undefined;
    const live = c.status === 'accepted' || c.status === 'never' ? c.examples : this.#live(c);
    const sk = c.skillName ? this.#app.skills?.get('companion', c.skillName) : undefined;
    return {
      id: c.id,
      kind: c.kind,
      topic: c.topic,
      status: this.store.candidate(id)!.status,
      count: live.length,
      days: new Set(live.map((e) => e.day)).size,
      since: live[0]?.at ?? c.firstSeen,
      steps: c.kind === 'chain' ? c.pattern.map(stepWords) : [],
      draft: c.draft,
      drafting: c.drafting || this.#drafts.has(id),
      skillName: c.skillName,
      snoozeUntil: c.snoozeUntil,
      conversationId: c.conversationId,
      ...(sk ? { skill: { scope: sk.scope, name: sk.name, status: sk.status, checkState: sk.checkState } } : {}),
    };
  }

  /** Offers waiting for an answer (the Skills page lists them too). */
  pendingOffers(): OfferView[] {
    return this.store.candidates({ status: ['offered'] }).map((c) => this.offerView(c.id)!).filter((v) => v.status === 'offered');
  }

  /**
   * Save it (with the draft, or the owner's edited one) · Not now (14 days) · Never for this.
   * Nothing is written to skills/ before Save it.
   */
  async decideOffer(id: number, action: 'save' | 'later' | 'never', edited?: { name?: unknown; description?: unknown; body?: unknown }): Promise<OfferView> {
    const c = this.store.candidate(id);
    if (!c) throw new Error('No such offer.');
    if (c.status !== 'offered') throw new Error('This offer was answered already.');
    const now = this.#now();
    if (action === 'later') this.store.patch(id, { status: 'snoozed', snoozeUntil: new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString(), declines: c.declines + 1 });
    else if (action === 'never') this.store.patch(id, { status: 'never' });
    else {
      const skills = this.#app.skills;
      if (!skills) throw new Error('Skills are not available here.');
      const d = edited && (edited.body !== undefined || edited.description !== undefined) ? null : (c.draft ?? (await this.draft(id)));
      const draft = {
        name: slugify(String(edited?.name ?? d?.name ?? '')) || 'learned-skill',
        description: String(edited?.description ?? d?.description ?? '').trim(),
        body: String(edited?.body ?? d?.body ?? ''),
      };
      if (!draft.description) throw new Error('Say what the skill does and when to use it.');
      const root = skills.dirOf('companion');
      const name = uniqueName(SKILL_NAME_RE.test(draft.name) ? draft.name : 'learned-skill', (x) => existsSync(join(root, x)));
      const v = skills.save('companion', { name, description: draft.description, body: draft.body, metadata: { 'sara-learned': c.kind, 'sara-candidate': String(c.id) } }, { create: true, source: 'learned', why: 'learned: saved from her offer', origin: `learned:${c.kind}` });
      // §5.6: a learned skill starts on trial (strong matches only, never loaded up front).
      skills.setLearned(v.scope, v.name, { status: 'trial', noAuto: false, checkState: null });
      this.store.patch(id, { status: 'accepted', skillName: v.name });
      this.#app.events?.publish({ type: 'skills' });
      if (this.settings().check) void this.#bg(this.check(v.scope, v.name)).catch((err) => console.warn(`skill check: ${(err as Error).message}`));
    }
    this.#app.events?.publish({ type: 'skills' });
    return this.offerView(id)!;
  }

  // -- the skill check (§5.6) --------------------------------------------------------------------

  /** Past runs to check a skill on: its own examples, then up to four similar ones. */
  #checkRuns(v: SkillView): number[] {
    const app = this.#app;
    const cid = Number(v.metadata['sara-candidate'] ?? 0);
    const c = cid ? this.store.candidate(cid) : undefined;
    const own = (c?.examples ?? []).map((e) => e.runId).filter((x): x is number => Boolean(x));
    const asks = (c?.examples ?? []).map((e) => app.store.messageById(e.messageId)?.content ?? '').filter(Boolean);
    const probe = asks.length ? asks : [`${v.name.replace(/-/g, ' ')} ${v.description}`];
    const similar: number[] = [];
    for (const run of app.runs?.list({ limit: 200 }) ?? []) {
      if (similar.length >= 4) break;
      if (run.kind !== 'turn' || run.parentRunId || own.includes(run.id) || run.status !== 'ok' || !run.conversationId) continue;
      if (!learnable(app.store.getConversation(run.conversationId))) continue;
      const ask = run.userMessageId ? (app.store.messageById(run.userMessageId)?.content ?? run.title) : run.title;
      if (probe.some((p) => similarity(p, ask) >= 0.35)) similar.push(run.id);
    }
    return [...own.reverse(), ...similar];
  }

  /** Tokens the skill checks used today (the day's eval budget is Settings → Evals' schedule budget). */
  #spentToday(): number {
    const evals = this.#app.evals;
    if (!evals) return 0;
    const today = this.#day();
    let n = 0;
    for (const ch of this.store.checks()) {
      if (ch.evalId <= 0 || this.#day(ch.at) !== today) continue;
      n += evals.store.get(ch.evalId)?.progress.tokens ?? 0;
    }
    return n;
  }

  /**
   * Checks a skill with the M9 eval loop: control vs \"with this skill loaded\" on its examples
   * (+ similar past tasks, at most 5), the tight budget, local models allowed. `anyway` skips it
   * (recorded as skipped) and lets a learned skill be used.
   */
  async check(scope: string, name: string, opts: { anyway?: boolean } = {}): Promise<{ state: string; evalId?: number }> {
    const app = this.#app;
    const skills = app.skills;
    const v = skills?.get(scope, name);
    if (!skills || !v) throw new Error('No such skill.');
    const at = this.#now().toISOString();
    if (opts.anyway) {
      this.store.addCheck(scope, name, 0, 'skipped', at);
      skills.setLearned(scope, name, { ...(v.status === 'trial' ? { status: 'ready' } : {}), noAuto: false, checkState: 'skipped' });
      app.events?.publish({ type: 'skills' });
      return { state: 'skipped' };
    }
    const evals = app.evals;
    if (!evals) {
      skills.setLearned(scope, name, { checkState: 'unavailable' });
      return { state: 'unavailable' };
    }
    const room = evalSchedule(app.settings.get()).budgetTokens - this.#spentToday();
    if (room < CHECK_MIN_ROOM) {
      skills.setLearned(scope, name, { checkState: 'queued' });
      app.events?.publish({ type: 'skills' });
      return { state: 'queued' };
    }
    const variants: VariantSpec[] = [{ id: 'control', budget: 'tight' }, { id: 'v1', budget: 'tight', skill: { scope, name } }];
    // Every task is graded by the eval's usual parts; the judge joins when a Reviewing model is set.
    const picked = tasksFromRuns(app, this.#checkRuns(v), { variants, judge: true, max: CHECK_TASKS });
    let judge = false;
    try {
      const conv = picked.tasks[0] ? app.store.getConversation(picked.tasks[0].conversationId) : undefined;
      // The Reviewing job (it falls back to her chat model, local models allowed in private chats).
      judge = Boolean(conv && resolveChain(app, conv, 'review').some((x) => !conv.private || (x.provider.config.local && !/cloud/i.test(x.model))));
    } catch {
      judge = false;
    }
    if (!picked.tasks.length) {
      skills.setLearned(scope, name, { checkState: 'failed' });
      app.events?.publish({ type: 'skills' });
      return { state: 'failed' };
    }
    const kind: EvalKind = picked.tasks.every((t) => t.coding) ? 'coding' : picked.tasks.some((t) => t.coding) ? 'both' : 'everyday';
    const ev = evals.createWith({ title: `Skill check: ${name}`, kind, picked, variants, judge, maxTokens: room });
    this.store.addCheck(scope, name, ev.id, null, at);
    return this.#start(scope, name, ev.id);
  }

  #start(scope: string, name: string, evalId: number): { state: string; evalId: number } {
    const app = this.#app;
    try {
      app.evals!.start(evalId);
    } catch {
      // Another eval is running: it waits (the tick starts it later).
      app.skills!.setLearned(scope, name, { checkState: 'queued' });
      app.events?.publish({ type: 'skills' });
      return { state: 'queued', evalId };
    }
    app.skills!.setLearned(scope, name, { checkState: 'running' });
    app.events?.publish({ type: 'skills' });
    const w = app.evals!.work ?? Promise.resolve();
    void this.#bg(w.then(() => this.finishCheck(scope, name, evalId)));
    return { state: 'running', evalId };
  }

  /** The eval of a check ended: its verdict decides a learned skill's standing. */
  finishCheck(scope: string, name: string, evalId: number): Verdict | 'failed' | undefined {
    const app = this.#app;
    const ev = app.evals?.store.get(evalId);
    if (!ev || app.evals?.running(evalId) || ev.status === 'draft' || ev.status === 'running' || ev.status === 'judging') return undefined;
    const verdict = checkVerdict(ev.result);
    return this.applyVerdict(scope, name, evalId, verdict);
  }

  /** helps → ready (normal catalog, auto-load allowed); same → ready, never auto-loaded; hurts → stays on trial with the note. */
  applyVerdict(scope: string, name: string, evalId: number, verdict: Verdict | 'failed'): Verdict | 'failed' {
    const skills = this.#app.skills!;
    const v = skills.get(scope, name);
    this.store.addCheck(scope, name, evalId, verdict === 'failed' ? null : verdict, this.#now().toISOString());
    if (!v) return verdict;
    const learned = v.source === 'learned';
    if (verdict === 'helps') skills.setLearned(scope, name, { ...(learned ? { status: 'ready' } : {}), noAuto: false, checkState: 'helps' });
    else if (verdict === 'same') skills.setLearned(scope, name, { ...(learned ? { status: 'ready', noAuto: true } : {}), checkState: 'same' });
    else skills.setLearned(scope, name, { checkState: verdict });
    this.#app.events?.publish({ type: 'skills' });
    return verdict;
  }

  // -- fixes after using a skill (§5.5) ----------------------------------------------------------

  #fixesAfter(conv: Conversation, info: TurnInfo, used: { scope: string; name: string }[]): number[] {
    const app = this.#app;
    const out: number[] = [];
    // 1. A step failed and a later step of the same kind worked with other arguments.
    if (info.runId && used.length) {
      const tools = (app.runs?.steps(info.runId) ?? []).flatMap((s) => s.tools);
      const pair = failedThenWorked(tools);
      if (pair) for (const u of used) {
        const id = this.#propose(conv, u, info.runId, 'step-failed', pair);
        if (id) out.push(id);
      }
    }
    // 2. The owner corrected her right after a turn that used a skill.
    const said = info.userText.trim();
    if (CORRECTION.test(said) && app.runs) {
      const prev = app.runs.list({ conversationId: conv.id, limit: 5 }).find((r) => r.id !== info.runId && r.kind === 'turn' && !r.parentRunId && r.status !== 'running');
      if (prev) for (const u of this.#usedIn(prev.id)) {
        const id = this.#propose(conv, u, prev.id, 'corrected', { quote: clip(scrubForDraft(said.replace(/\s+/g, ' '), this.#redact), 300) });
        if (id) out.push(id);
      }
    }
    return out;
  }

  #propose(conv: Conversation, u: { scope: string; name: string }, runId: number, kind: FixKind, ev: { failing?: ToolStep; worked?: ToolStep; error?: string; quote?: string }): number | undefined {
    const app = this.#app;
    const skills = app.skills!;
    if (u.scope !== 'companion' && u.scope !== 'shared') return undefined; // built-in and project skills are read only
    const v = skills.get(u.scope, u.name);
    if (!v || v.status === 'broken' || v.status === 'needs-review') return undefined;
    const today = this.#day();
    const all = this.store.fixes({ scope: u.scope, name: u.name });
    if (all.some((f) => this.#day(f.at) === today)) return undefined;
    const cutoff = this.#now().getTime() - FIX_QUIET_DAYS * DAY_MS;
    if (all.filter((f) => f.status === 'dismissed' && Date.parse(f.decidedAt ?? f.at) >= cutoff).length >= FIX_DISMISSALS) return undefined;
    let cur: { body: string };
    try {
      cur = skills.bodyOf(v);
    } catch {
      return undefined;
    }
    const before = serializeSkill({ name: v.name, description: v.description, body: cur.body, metadata: v.metadata, ...(v.license ? { license: v.license } : {}), ...(v.compatibility ? { compatibility: v.compatibility } : {}), ...(v.allowedTools ? { allowedTools: v.allowedTools } : {}) });
    let body = cur.body;
    let why: string;
    const evidence: Record<string, unknown> = { runId };
    if (kind === 'step-failed' && ev.failing && ev.worked) {
      const bad = textOf(ev.failing);
      const good = textOf(ev.worked);
      const badS = scrubForDraft(bad, this.#redact);
      const goodS = scrubForDraft(good, this.#redact);
      evidence.failing = { callId: ev.failing.id, tool: ev.failing.name, step: clip(badS, 300), error: clip(scrubForDraft(ev.error ?? '', this.#redact), 300) };
      evidence.worked = { callId: ev.worked.id, tool: ev.worked.name, step: clip(goodS, 300) };
      if (bad && body.includes(bad)) body = body.split(bad).join(good);
      else body = addUnder(body, 'Pitfalls', `- \`${clip(badS, 200)}\` failed${ev.error ? ` (${clip(scrubForDraft(ev.error, this.#redact), 160)})` : ''}; \`${clip(goodS, 200)}\` worked instead.`);
      why = `\`${clip(badS, 80)}\` failed; \`${clip(goodS, 80)}\` worked`;
    } else {
      evidence.quote = ev.quote;
      body = addUnder(body, 'Corrections', `- ${this.#day()}: the owner said "${ev.quote}"`);
      why = `the owner said "${clip(ev.quote ?? '', 80)}"`;
    }
    if (body.trim() === cur.body.trim()) return undefined;
    const after = serializeSkill({ name: v.name, description: v.description, body, metadata: v.metadata, ...(v.license ? { license: v.license } : {}), ...(v.compatibility ? { compatibility: v.compatibility } : {}), ...(v.allowedTools ? { allowedTools: v.allowedTools } : {}) });
    const f = this.store.addFix({ scope: v.scope, name: v.name, runId: String(runId), kind, evidence, diff: unifiedDiff(before, after), proposed: body, baseSha: v.sha, why, at: this.#now().toISOString(), conversationId: conv.id });
    app.store.addMessage(conv.id, 'notice', `skillfix:${f.id}`, { fix: f.id });
    app.events?.publish({ type: 'skills' });
    return f.id;
  }

  fixView(id: number): (Fix & { skill?: { status: string; versions: number } }) | undefined {
    const f = this.store.fix(id);
    if (!f) return undefined;
    const d = this.#app.skills?.detail(f.scope, f.name);
    return { ...f, ...(d ? { skill: { status: d.status, versions: d.versions.length } } : {}) };
  }

  /** Apply (the proposed body, or the owner's edit; a new version is kept, undo = restore it) · Dismiss. */
  decideFix(id: number, action: 'apply' | 'dismiss', body?: unknown): Fix {
    const f = this.store.fix(id);
    if (!f) throw new Error('No such fix.');
    if (f.status !== 'proposed') throw new Error('This fix was answered already.');
    const at = this.#now().toISOString();
    if (action === 'dismiss') {
      this.store.decideFix(id, 'dismissed', at);
      return this.store.fix(id)!;
    }
    const skills = this.#app.skills!;
    const v = skills.get(f.scope, f.name);
    if (!v) throw new Error('That skill is gone.');
    if (v.sha !== f.baseSha && typeof body !== 'string') throw new Error('The skill changed since this fix was proposed: open it and change it there.');
    skills.save(f.scope, { name: v.name, description: v.description, body: typeof body === 'string' && body.trim() ? body : f.proposed, metadata: v.metadata, ...(v.license ? { license: v.license } : {}), ...(v.compatibility ? { compatibility: v.compatibility } : {}), ...(v.allowedTools ? { allowedTools: v.allowedTools } : {}) }, { why: clip(`fix: ${f.why}`, 300) });
    this.store.decideFix(id, 'applied', at);
    this.#app.events?.publish({ type: 'skills' });
    return this.store.fix(id)!;
  }

  // -- chain mining (§5.2 signal 2; nightly) -----------------------------------------------------

  /** Mines the last 500 finished coding runs for common chains (bounded: 50 ms per run). */
  mine(): { runs: number; found: number; candidates: number[] } {
    const app = this.#app;
    const s = this.settings();
    if (!s.offer || !s.chains || !app.runs) return { runs: 0, found: 0, candidates: [] };
    const cutoff = this.#now().getTime() - s.lookBackDays * DAY_MS;
    const items: (ChainRun & { run: RunView })[] = [];
    let before: number | undefined;
    for (let page = 0; page < 3 && items.length < CHAIN_RUNS; page++) {
      const list = app.runs.list({ limit: 200, ...(before ? { before } : {}) });
      if (!list.length) break;
      before = list.at(-1)!.id;
      for (const run of list) {
        if (items.length >= CHAIN_RUNS) break;
        if (run.kind !== 'turn' || run.parentRunId || run.status !== 'ok' || !run.conversationId || !run.userMessageId) continue;
        if (Date.parse(run.startedAt) < cutoff) continue;
        const conv = app.store.getConversation(run.conversationId);
        if (!learnable(conv) || conv.mode !== 'coding') continue;
        const t0 = Date.now();
        const steps = app.runs.steps(run.id);
        if (steps.some((x) => x.skills.length)) continue; // covered by a skill: feeds fixes, not a new one
        const chain = chainOf(steps);
        if (Date.now() - t0 > CHAIN_MS || chain.length < CHAIN_MIN) continue;
        items.push({ runId: run.id, day: this.#day(run.startedAt), chain, run });
      }
    }
    const found = commonChains(items, { minRuns: s.times, minDays: MIN_DAYS, deadline: Date.now() + items.length * CHAIN_MS });
    const ids: number[] = [];
    for (const f of found) {
      const signature = `chain:${sigOf('command', f.key)}`;
      const examples: Example[] = f.runs.map((id) => {
        const it = items.find((x) => x.runId === id)!;
        return { conversationId: it.run.conversationId!, messageId: it.run.userMessageId!, runId: id, day: it.day, at: it.run.startedAt };
      });
      const have = this.store.bySignature(signature);
      // A chain inside one already offered, saved or refused is the same thing again.
      const covered = this.store.candidates({ kind: 'chain' }).some((c) => c.signature !== signature && c.status !== 'watching' && isSubseq(f.pattern, c.pattern));
      if (covered && !have) continue;
      if (have) {
        const merged = [...have.examples.filter((e) => !examples.some((x) => x.runId === e.runId)), ...examples];
        this.store.patch(have.id, { examples: merged, days: new Set(merged.map((e) => e.day)).size, lastSeen: this.#now().toISOString() });
        ids.push(have.id);
      } else ids.push(this.store.insert({ kind: 'chain', signature, pattern: f.pattern, examples, days: f.days, at: this.#now().toISOString() }).id);
    }
    app.skills?.kvSet('skill_chains_mined', this.#day());
    return { runs: items.length, found: found.length, candidates: ids };
  }

  /** The background tick: chains once a night (2–5 am local), checks that waited for room. */
  tick(): void {
    const app = this.#app;
    try {
      const h = zonedParts(this.#now(), this.#tz()).h;
      if (h >= 2 && h < 5 && app.skills?.kvGet('skill_chains_mined') !== this.#day()) this.mine();
    } catch (err) {
      console.warn(`skill chains: ${(err as Error).message}`);
    }
    if (!app.evals || !app.skills) return;
    for (const v of app.skills.list()) {
      if (v.checkState === 'queued') {
        const draft = this.store.checks(v.scope, v.name).find((c) => c.evalId > 0 && c.verdict === null && app.evals!.store.get(c.evalId)?.status === 'draft');
        if (draft) this.#start(v.scope, v.name, draft.evalId);
        else void this.check(v.scope, v.name).catch(() => undefined);
        break; // one at a time
      }
      if (v.checkState === 'running') {
        const run = this.store.checks(v.scope, v.name).find((c) => c.evalId > 0 && c.verdict === null);
        if (run && !app.evals.running(run.evalId)) this.finishCheck(v.scope, v.name, run.evalId);
      }
    }
  }

  start(intervalMs = 15 * 60_000): void {
    this.#timer = setInterval(() => this.tick(), intervalMs);
    this.#timer.unref?.();
  }
  stop(): void {
    clearInterval(this.#timer);
  }
}

/** The command (or the call) of a tool step as text. */
function textOf(t: ToolStep): string {
  if (t.name === 'shell' && typeof t.args.command === 'string') return t.args.command.trim();
  return t.summary || `${t.name} ${JSON.stringify(t.args).slice(0, 200)}`;
}

/** §5.5: the first step that failed and a later step of the same tool that worked with other arguments. */
export function failedThenWorked(tools: ToolStep[]): { failing: ToolStep; worked: ToolStep; error: string } | undefined {
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!stepFailed(t.name, t.status, t.output)) continue;
    const w = tools.slice(i + 1).find((x) => x.name === t.name && x.status === 'ok' && !stepFailed(x.name, x.status, x.output) && JSON.stringify(x.args) !== JSON.stringify(t.args));
    if (w) {
      const line = t.output.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[exit code/.test(l)).find((l) => /error|fail|not found|cannot|missing|denied/i.test(l)) ?? '';
      return { failing: t, worked: w, error: line.slice(0, 200) };
    }
  }
  return undefined;
}
