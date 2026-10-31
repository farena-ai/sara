// Phase 76 (harness track M1, docs/design/HARNESS_TRACK.md §4): ranked memory injection.
// Every note that could come to mind this turn gets a score, a sureness and a plain reason
// ("matched dog, biscuit + meaning; sure: high"). Code only: no model call, deterministic, the
// same answer for the same inputs. Old notes fade in WEIGHT by a half-life (tunable) instead of
// hitting a wall; pinned notes never fade; being used before lifts a note a little (capped).
//
// Hooks left for later milestones (§5): rankMemories takes any query text (M2: a planned tool
// call, M10: a task signature); every pick carries policyId (M3/M9); `override` puts a note in or
// out (M8); KIND_PRIOR is the one table of standing weights (M2 marks decisions binding); the
// bracket note format `[why: …; sure: …]` is shared by M2 cards and M10 trigger lines.
import { createHash } from 'node:crypto';
import type { Memory, MemoryKind } from './memory.ts';

/** How notes fade (Settings → Memory). */
export interface DecayPolicy {
  /** Days for an un-pinned, un-used note's weight to halve. 0 = no decay. */
  halfLifeDays: number;
  /** How much being used before lifts a note (0–0.3). */
  reuseWeight: number;
  /**
   * Below this a note that didn't match the message stays out (0–1). Compared with the note's
   * freshness (+ its reuse lift), so 0.5 means "out once it is older than one half-life", the
   * same line as the old hard cut-off.
   */
  minStanding: number;
}
export type FadePreset = 'never' | 'slow' | 'normal' | 'custom';
export const FADE_PRESETS: FadePreset[] = ['never', 'slow', 'normal', 'custom'];
/** Half-life per preset: the same numbers as the old FADE_DAYS, so nobody's behaviour jumps. */
export const PRESET_HALF_LIFE = { never: 0, slow: 365, normal: 120 } as const;
export const DEFAULT_DECAY: DecayPolicy = { halfLifeDays: 0, reuseWeight: 0.1, minStanding: 0.5 };
export type PolicyWithId = DecayPolicy & { id: string; preset: FadePreset };

/** Standing weight of a note that didn't match the message, by kind (one table; M2 reads it too). */
export const KIND_PRIOR: Record<MemoryKind, number> = { promise: 0.5, decision: 0.35, fact: 0.25, self: 0.2, summary: 0.2, milestone: 0.2, reflection: 0.15, date: 0.2, lesson: 0.1 };
/** Plain words for a standing note's kind in the "why". */
const KIND_WORD: Record<MemoryKind, string> = { promise: 'open promise', decision: 'decision', fact: 'fact', self: 'about yourself', summary: 'other conversation', milestone: 'your story', reflection: 'reflection', date: 'date', lesson: 'lesson' };

/** The meaning score floor (same as MIN_SCORE in embeddings.ts; repeated so this module stays import-free). */
const MEANING_FLOOR = 0.5;
/** A note that matched never weighs less than this before freshness (above every standing prior but promises). */
const MATCH_FLOOR = 0.55;
const AGREE_BONUS = 0.15;
/** A pinned note that matched (design §4.2). */
const PINNED_FLOOR = 0.9;
/**
 * A pinned note that did NOT match: at the top of the standing notes (like an open promise), but
 * below real matches. Deviation from §4.2 ("pinned floored at 0.9" for every pinned note): the
 * --rank golden set showed that floor putting every pinned note above the note the message is
 * about (0/20 first with two pinned notes).
 */
const PINNED_STANDING_FLOOR = 0.5;

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Clamp a decay policy from settings or a request (half-life 0 or 7–3650, reuse 0–0.3, minStanding 0–1). */
export function clampDecay(v: Partial<DecayPolicy> | undefined, base: DecayPolicy = DEFAULT_DECAY): DecayPolicy {
  const num = (x: unknown, d: number) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? d : Number(x));
  const hl = Math.round(num(v?.halfLifeDays, base.halfLifeDays));
  return {
    halfLifeDays: hl <= 0 ? 0 : clamp(hl, 7, 3650),
    reuseWeight: round(clamp(num(v?.reuseWeight, base.reuseWeight), 0, 0.3), 3),
    minStanding: round(clamp(num(v?.minStanding, base.minStanding), 0, 1), 3),
  };
}

/** The decay policy of the memory settings: the fade preset sets the half-life; "custom" uses the slider. */
export function decayPolicy(s: { fade?: string; decay?: Partial<DecayPolicy> } | undefined): PolicyWithId {
  const preset: FadePreset = FADE_PRESETS.includes(s?.fade as FadePreset) ? (s!.fade as FadePreset) : 'never';
  const saved = clampDecay(s?.decay);
  const halfLifeDays = preset === 'custom' ? (s?.decay?.halfLifeDays === undefined ? PRESET_HALF_LIFE.normal : saved.halfLifeDays) : PRESET_HALF_LIFE[preset];
  const p: DecayPolicy = { halfLifeDays, reuseWeight: saved.reuseWeight, minStanding: saved.minStanding };
  return { ...p, preset, id: policyId(p) };
}

/** A short stable id of a policy (M3 records it per step; M9 compares policies as variants). */
export function policyId(p: DecayPolicy): string {
  return `d${createHash('sha256').update(`${p.halfLifeDays}|${p.reuseWeight}|${p.minStanding}`).digest('hex').slice(0, 8)}`;
}

/** The policy in words (Settings → Memory, "How fading works"). */
export function explainPolicy(p: DecayPolicy): string {
  if (!p.halfLifeDays) return "Nothing fades: every note weighs the same however old it is. Notes that match what you say come first; pinned notes, promises and dates always count.";
  return `A note's weight halves every ${p.halfLifeDays} days since it happened or was last used. Notes that match what you say always come to mind, just ranked lower when old; others stay out once they are older than about ${Math.round(p.halfLifeDays * Math.log2(1 / Math.max(0.001, p.minStanding)))} days. Pinned notes, open promises and dates never fade.`;
}

// ---- words ----

const STOP = new Set(
  'the and for are but not you your yours with this that what when where which who whom why how was were have has had did does do can could would should will shall about from into onto over under than then them they their there these those his her hers him she he its it’s it\'s our ours out just like also very really some any all each more most much many such only own same too again once here been being because while during before after above below off between both few nor other yes no okay ok hey hi hello please thanks thank tell me my mine myself i im i\'m you\'re youre we us remember know think'.split(
    /\s+/,
  ),
);

/** The meaningful words of a text (lower case, no stop words, at most 24, in order). */
export function queryWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [])
    .map((w) => w.replace(/'s$/, '').replace(/['"-]/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24);
}

/** A light stem (enough to line up with FTS5's porter matches for the "why"). */
export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ['ingly', 'edly', 'ing', 'ies', 'ed', 'es', 's']) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length) + (suf === 'ies' ? 'y' : '');
      break;
    }
  }
  // "name" / "named", "save" / "saving" line up (as porter does).
  return s.length > 3 && s.endsWith('e') ? s.slice(0, -1) : s;
}

/** Which of the query words are in the note's text (by light stem), in query order. */
export function matchedWords(words: string[], content: string): string[] {
  const have = new Set((content.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).map((w) => stem(w.replace(/'s$/, '').replace(/['"-]/g, ''))));
  return words.filter((w) => have.has(stem(w)));
}

// ---- ranking ----

export type Confidence = 'high' | 'medium' | 'low';

/** A note that could come to mind, with what found it. */
export interface Candidate {
  memory: Memory;
  /** Found by the word search (FTS5); the query words it contains. */
  words?: string[];
  /** Found by meaning (cosine from MemoryVectors.related). */
  meaning?: number;
  /** One of the standing pools (latest facts, open promises…). */
  standing?: boolean;
  /** Put in by `override.include` (M8). */
  included?: boolean;
  /** The latest weekly reflection: never faded out (today's rule kept). */
  keep?: boolean;
}

export interface RankedPick {
  memoryId: number;
  memory: Memory;
  score: number;
  confidence: Confidence;
  /** Plain reasons, joined with " + " in the bracket note. */
  why: string[];
  policyId: string;
  words: string[];
  meaning: number | null;
  /** Came to mind without matching the message. */
  standing: boolean;
  pinned: boolean;
  /** Only FTS5 found it (no query word by our reading): a weak match. */
  fuzzy: boolean;
  /** Freshness below one half ("older, may be out of date"). */
  old: boolean;
  freshness: number;
  /** Put in by `override.include`. */
  included: boolean;
}

/** What the reply's meta keeps per note (`meta.memoryPicks`), for the panel and M3. */
export interface PickNote {
  id: number;
  sure: Confidence;
  score: number;
  words?: string[];
  meaning?: true;
  /** Only a loose word match (FTS5 stemming). */
  fuzzy?: true;
  standing?: MemoryKind;
  pinned?: true;
  old?: true;
  included?: true;
  policy: string;
}

export interface RankContext {
  /** Any text: the owner's message (M1), a planned tool call (M2), a task signature (M10). */
  query: string;
  conversationId: string;
  oldestHistoryId: number;
  /** Notes close in meaning, with their cosine score (Memory[] from older callers counts as a weak meaning match). */
  related?: ({ memory: Memory; score: number } | Memory)[];
  policy?: PolicyWithId | DecayPolicy;
  /** Local day (YYYY-MM-DD); without it nothing fades. */
  today?: string;
  /** Hardening M3: only notes this allows (another app's turn). */
  allow?: (m: Memory) => boolean;
  /** M8 "change one input": notes forced in or out. */
  override?: { include?: number[]; exclude?: number[] };
  /** Standing pools on (default) or off (M2/M10 want matches only). */
  standing?: boolean;
  /** Only these kinds (M2: decisions and facts). */
  kinds?: MemoryKind[];
}

/** The store calls ranking needs (MemoryStore has them all). */
export interface RankSource {
  search(q: string, limit?: number): { memory: Memory; matched: string[] }[];
  list(opts: { kind?: MemoryKind; limit?: number }): Memory[];
  openPromises(limit?: number): Memory[];
  pinnedNotes(limit?: number): Memory[];
  recentlyUsed(limit?: number): Memory[];
  get(id: number): Memory | undefined;
}

const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);

/** Freshness 0–1: 0.5 ^ (age / half-life), age from the later of when it happened and when it was last used. */
export function freshness(m: Memory, policy: DecayPolicy, today: string | undefined): number {
  if (!policy.halfLifeDays || !today) return 1;
  if (m.pinned || m.kind === 'date' || (m.kind === 'promise' && !m.resolvedAt)) return 1;
  const from = m.lastUsedOn && m.lastUsedOn > m.happenedOn ? m.lastUsedOn : m.happenedOn;
  const age = Math.max(0, (dayMs(today) - dayMs(from)) / 86_400_000);
  if (!Number.isFinite(age)) return 1;
  return 0.5 ** (age / policy.halfLifeDays);
}

/** Reuse lift 0–1: log2(1 + uses) / 4, capped (rich-get-richer stays bounded). */
export const reuse = (useCount: number) => Math.min(1, Math.log2(1 + Math.max(0, useCount)) / 4);

/** Score, sureness and reasons for candidates (pure; no store). Leaves out faded standing notes. */
export function scoreCandidates(cands: Candidate[], policyIn: PolicyWithId | DecayPolicy | undefined, today: string | undefined, queryWordCount: number): RankedPick[] {
  const policy = policyIn ?? DEFAULT_DECAY;
  const pid = 'id' in policy ? (policy as PolicyWithId).id : policyId(policy);
  const out: RankedPick[] = [];
  for (const c of cands) {
    const m = c.memory;
    const words = c.words ?? [];
    // FTS5 (porter) found it but no query word is in the note by our own reading ("one" ~ "on"):
    // still a match, but a weak one, said plainly ("similar words", sure: low).
    const fuzzy = c.words !== undefined && !words.length;
    const byWords = c.words !== undefined && words.length > 0;
    const byMeaning = c.meaning !== undefined && c.meaning !== null;
    const matched = byWords || byMeaning || fuzzy;
    const f = freshness(m, policy, today);
    const u = reuse(m.useCount ?? 0);
    const pinned = Boolean(m.pinned);
    if (!matched && !pinned && !c.included && !c.keep && policy.halfLifeDays > 0 && f + policy.reuseWeight * u < policy.minStanding) continue;
    const rWord = byWords ? MATCH_FLOOR + (1 - MATCH_FLOOR) * (queryWordCount ? Math.min(1, words.length / queryWordCount) : 0) : fuzzy ? MATCH_FLOOR - 0.15 : 0;
    const rMean = byMeaning ? MATCH_FLOOR + (1 - MATCH_FLOOR) * clamp(((c.meaning as number) - MEANING_FLOOR) / (1 - MEANING_FLOOR), 0, 1) : 0;
    const r = matched ? Math.min(1, Math.max(rWord, rMean) + (byWords && byMeaning ? AGREE_BONUS : 0)) : 0;
    // Standing notes: prior × (0.6 + 0.4 f) as designed. Matched notes: freshness counts less
    // (0.75 + 0.25 f), or a fresher weak match beats an older exact one (--rank: "what's my dog's
    // name" picked "wants a second dog" over "dog … named Biscuit").
    let score = matched ? r * (0.75 + 0.25 * f) + policy.reuseWeight * u : (KIND_PRIOR[m.kind] || 0.2) * (0.6 + 0.4 * f) + policy.reuseWeight * u;
    if (pinned) score = Math.max(score, matched ? PINNED_FLOOR : PINNED_STANDING_FLOOR);
    if (c.included) score = Math.max(score, 1);
    const why: string[] = [];
    if (byWords) why.push(`words ${words.slice(0, 4).map((w) => `"${w}"`).join(', ')}`);
    else if (fuzzy && !byMeaning) why.push('similar words');
    if (byMeaning) why.push('meaning');
    if (!matched) why.push(c.included ? 'added for this run' : pinned ? 'pinned' : `standing ${KIND_WORD[m.kind] ?? m.kind}`);
    else if (pinned) why.push('pinned');
    const confidence: Confidence = (byWords && byMeaning) || (pinned && (byWords || byMeaning)) ? 'high' : byWords || byMeaning ? 'medium' : 'low';
    out.push({ memoryId: m.id, memory: m, score: round(score, 4), confidence, why, policyId: pid, words, meaning: byMeaning ? round(c.meaning as number, 3) : null, standing: !matched, pinned, old: f < 0.5, freshness: round(f, 4), included: Boolean(c.included), fuzzy: fuzzy && !byMeaning });
  }
  // Notes that matched the message come before standing ones (as before Phase 76), then best
  // first; ties: newest happenedOn, then the higher id (deterministic).
  const tier = (p: RankedPick) => (p.standing && !p.included ? 1 : 0);
  return out.sort((a, b) => tier(a) - tier(b) || b.score - a.score || (a.memory.happenedOn < b.memory.happenedOn ? 1 : a.memory.happenedOn > b.memory.happenedOn ? -1 : 0) || b.memoryId - a.memoryId);
}

/**
 * Every note that could come to mind for `query`, ranked (best first). Matched notes always
 * stay in; standing ones only while fresh enough. Budget filling is the caller's job.
 */
export function rankMemories(mem: RankSource, ctx: RankContext): RankedPick[] {
  const policy = ctx.policy ?? DEFAULT_DECAY;
  const exclude = new Set(ctx.override?.exclude ?? []);
  const inHistory = (m: Memory) => (m.conversationId === ctx.conversationId && (m.sourceMessageId ?? 0) >= ctx.oldestHistoryId) || m.supersededBy !== null || m.archived || m.kind === 'date' || (m.kind === 'promise' && m.resolvedAt !== null);
  // Phase 85: lessons come back through the recall triggers (src/triggers.ts), only when asked for by kind.
  const ok = (m: Memory) => !exclude.has(m.id) && !inHistory(m) && (!ctx.allow || ctx.allow(m)) && (ctx.kinds ? ctx.kinds.includes(m.kind) : m.kind !== 'lesson');
  const byId = new Map<number, Candidate>();
  const add = (m: Memory, patch: Partial<Candidate>) => {
    if (!ok(m)) return;
    const cur = byId.get(m.id) ?? { memory: m };
    byId.set(m.id, { ...cur, ...patch, words: patch.words ?? cur.words, meaning: patch.meaning ?? cur.meaning, standing: cur.standing || patch.standing });
  };
  const qWords = queryWords(ctx.query);
  if (qWords.length) for (const r of mem.search(ctx.query, 12)) add(r.memory, { words: r.matched });
  for (const r of ctx.related ?? []) {
    if ('memory' in r) add(r.memory, { meaning: r.score });
    else add(r, { meaning: 0.6 });
  }
  if (ctx.standing !== false) {
    for (const m of mem.pinnedNotes(20)) add(m, { standing: true });
    for (const m of mem.list({ kind: 'fact', limit: 5 })) add(m, { standing: true });
    for (const m of mem.list({ kind: 'self', limit: 3 })) add(m, { standing: true });
    for (const m of mem.openPromises(4)) add(m, { standing: true });
    for (const m of mem.list({ kind: 'decision', limit: 4 })) add(m, { standing: true });
    for (const m of mem.list({ kind: 'reflection', limit: 1 })) add(m, { standing: true, keep: true });
    // Notes used lately count as fresh again (age from last use), so they get a seat too.
    if (policy.halfLifeDays > 0) for (const m of mem.recentlyUsed(4)) add(m, { standing: true });
    // The latest summaries of up to three other conversations.
    const convs = new Set<string>();
    for (const m of mem.list({ kind: 'summary', limit: 12 })) {
      if (m.conversationId === ctx.conversationId || convs.has(m.conversationId ?? '') || convs.size >= 3 || !ok(m)) continue;
      if (policy.halfLifeDays > 0 && freshness(m, policy, ctx.today) < policy.minStanding) continue;
      convs.add(m.conversationId ?? '');
      add(m, { standing: true });
    }
  }
  for (const id of ctx.override?.include ?? []) {
    const m = mem.get(id);
    if (m && !exclude.has(id) && (!ctx.allow || ctx.allow(m))) byId.set(id, { ...(byId.get(id) ?? { memory: m }), included: true });
  }
  return scoreCandidates([...byId.values()], policy, ctx.today, qWords.length);
}

/** The bracket note after a note's text: `[why: words "dog" + meaning; sure: high]`. */
export function bracketNote(p: RankedPick): string {
  return `[why: ${p.why.join(' + ')}; sure: ${p.confidence}${p.old ? '; older, may be out of date' : ''}]`;
}

/** The compact form kept on the reply (`meta.memoryPicks`). */
export function pickNote(p: RankedPick): PickNote {
  return {
    id: p.memoryId,
    sure: p.confidence,
    score: round(p.score, 3),
    ...(p.words.length ? { words: p.words.slice(0, 6) } : {}),
    ...(p.meaning !== null ? { meaning: true as const } : {}),
    ...(p.fuzzy ? { fuzzy: true as const } : {}),
    ...(p.standing ? { standing: p.memory.kind } : {}),
    ...(p.pinned ? { pinned: true as const } : {}),
    ...(p.old ? { old: true as const } : {}),
    ...(p.included ? { included: true as const } : {}),
    policy: p.policyId,
  };
}
