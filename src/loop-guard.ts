// Phase 116 (BR2 B7, docs/design/BRIDGES2.md §5.8): the tool-loop guard. Per turn: after the exact
// same call has failed the same way 3 times, it is blocked for the rest of the turn. It can only
// stop a call, never run one.
//
// - *The same call*: the tool name and the canonical JSON of the scrubbed arguments (keys sorted,
//   strings trimmed, whitespace in a shell command collapsed). Exact, not "similar".
// - *Failing*: `stepFailed` from src/triggers.ts (an error status, a shell exit ≠ 0 or a time-out),
//   the M10 rule, so recall and the guard never disagree.
// - *The same way*: M10's failure key, `name|class|normalizeMessage(errorLine(output))`.
// A failure the same way as the last one adds 1, a different failure starts again at 1, a success
// removes the key. Two smaller rules: a call the owner declined twice isn't asked a third time, and
// a model that keeps trying blocked calls gets its tools paused for the rest of the turn.
import { errorLine, normalizeMessage, sigOf, stepFailed } from './triggers.ts';

/** Fixed in v1 (shown read-only in Settings → Abilities → Coding). */
export const LOOP_REPEATS = 3;
/** Blocked tries after the first block before tools pause for the turn. */
export const IGNORE_LIMIT = 3;

export interface GuardHit {
  kind: 'loop' | 'declined';
  key: string;
  /** The error line (scrubbed, ≤ 200 characters); '' for declined. */
  quote: string;
  count: number;
}

/** Canonical JSON: keys sorted, strings trimmed; a shell command's runs of whitespace collapsed. */
export function canonicalArgs(name: string, args: unknown): string {
  const norm = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return name === 'shell' && key === 'command' ? v.replace(/\s+/g, ' ').trim() : v.trim();
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k], k)]));
    return v;
  };
  return JSON.stringify(norm(args ?? {}));
}

/** The key of a call: `sigOf('command', name + '\n' + canonical)`. */
export const callKey = (name: string, args: unknown): string => sigOf('command', `${name}\n${canonicalArgs(name, args)}`);

/** M10's "the same way": the tool, the error class and the normalised error line. */
export function failureOf(name: string, output: string): { key: string; quote: string } {
  const body = output.replace(/^\[[^\]]*\]\n?/, '');
  const e = errorLine(body);
  if (e) return { key: `${name}|${e.cls}|${normalizeMessage(e.line)}`, quote: e.line.slice(0, 200) };
  const first = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return { key: `${name}|other|${normalizeMessage(first.slice(0, 300))}`, quote: first.slice(0, 200) };
}

export class LoopGuard {
  readonly #fails = new Map<string, { failure: string; count: number; quote: string }>();
  readonly #blocked = new Map<string, { quote: string; count: number }>();
  readonly #declined = new Map<string, number>();
  /** Blocked tries this turn (the first block included). */
  blockedTries = 0;
  readonly #redact: (v: unknown) => unknown;

  constructor(redact: (v: unknown) => unknown = (v) => v) {
    this.#redact = redact;
  }

  keyOf(name: string, args: unknown): string {
    return callKey(name, this.#redact(args));
  }

  /** Before a call runs (and before any card): blocked, or undefined. */
  check(name: string, args: unknown): GuardHit | undefined {
    const key = this.keyOf(name, args);
    const b = this.#blocked.get(key);
    if (b) return { kind: 'loop', key, quote: b.quote, count: b.count };
    if ((this.#declined.get(key) ?? 0) >= 2) return { kind: 'declined', key, quote: '', count: 2 };
    return undefined;
  }

  /** After a call really ran (not refused by a rule, not cancelled by Stop). */
  record(name: string, args: unknown, status: string, output: string): GuardHit | undefined {
    const key = this.keyOf(name, args);
    if (!stepFailed(name, status, output)) {
      this.#fails.delete(key);
      return undefined;
    }
    const f = failureOf(name, output);
    const prev = this.#fails.get(key);
    const count = prev && prev.failure === f.key ? prev.count + 1 : 1;
    this.#fails.set(key, { failure: f.key, count, quote: f.quote });
    if (count >= LOOP_REPEATS) {
      this.#blocked.set(key, { quote: f.quote, count });
      return { kind: 'loop', key, quote: f.quote, count };
    }
    return undefined;
  }

  /** The owner said no on the card. */
  declined(name: string, args: unknown): void {
    const key = this.keyOf(name, args);
    this.#declined.set(key, (this.#declined.get(key) ?? 0) + 1);
  }

  /** A blocked call was tried: true once she has ignored the block IGNORE_LIMIT more times (tools pause). */
  triedBlocked(): boolean {
    this.blockedTries++;
    return this.blockedTries > IGNORE_LIMIT;
  }

  /** An owner steer: what he says may have changed the situation; the guard starts again. */
  clear(): void {
    this.#fails.clear();
    this.#blocked.clear();
    this.#declined.clear();
    this.blockedTries = 0;
  }

  /** Replays: the turn's recorded tool steps so far (the branch decides again from them). */
  seed(steps: { name: string; args: unknown; status: string; output: string; approval?: string }[]): void {
    for (const s of steps) {
      if (s.approval === 'denied') this.declined(s.name, s.args);
      else if (s.status === 'denied') continue;
      else this.record(s.name, s.args, s.status, s.output);
    }
  }

  get blockedKeys(): number {
    return this.#blocked.size;
  }
}

/** What a blocked call gets back (status `denied`). */
export function blockedOutput(hit: GuardHit, owner: string): string {
  if (hit.kind === 'declined') return `${owner === 'the owner' ? 'The owner' : owner} declined this twice in this turn. Don't ask again in this turn: do something else, or ask ${owner} what to do.`;
  return `Blocked by Sara's loop guard: this exact call has failed ${hit.count} times in this turn with the same error: "${hit.quote.replace(/\s+/g, ' ').slice(0, 200)}". It won't run again in this turn. Change your approach (a different command, different arguments or another tool), or ask ${owner} what to do.`;
}

/** The one-time note for the next step after a block. */
export const LOOP_NOTE = "[Note from the app: the loop guard blocked a call that kept failing. Don't try it again. Say in one line what you'll try instead, then do that.]";
export const toolsPausedNote = (owner: string): string => `[Note from the app: tools are paused for this turn. Tell ${owner} what went wrong and what you'd try next.]`;
