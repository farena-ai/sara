// Phase 115 (BR1 B4): the live progress message (docs/design/BRIDGES2.md §4.8). One message per
// long turn in a chat app, posted once the turn passes `afterMs` and then edited in place:
//
//   ⏳ Working on it · 0:42
//   ✅ Read a file ×3
//   ▸ Running the tests…
//   [ ⏹ Stop ]
//
// It is fed the turn's ChatEvents but only ever looks at event types, tool names, statuses and the
// web step line's verbs (web/step-words.js): never tool output, arguments, commands, URLs, model
// text or approval details. Every line is scrubbed by the redactor and dropped if it trips the
// minors check. Edits go through the send pacer (B2) at the lowest priority, at most one every
// `intervalMs`, never with unchanged text; three failed edits in a row switch it off for the turn.
// When the turn ends, one last edit turns it into a summary line (or it is deleted).
import { en, tr } from '../i18n.ts';
import { minorSexualMatch } from '../safety.ts';
import type { ChatEvent } from '../chat.ts';
import { stepWordsWith } from '../../web/step-words.js';
import { PRIO_EDIT, realClock, sleepOn, type Clock, type SendQueue } from './sendq.ts';

/** How a bridge posts and edits the one message (Telegram, Discord, a plugin with `edit`). */
export interface ProgressPort {
  /** Posts the message; returns its id (undefined: it couldn't be posted). */
  create(text: string, stop: boolean): Promise<string | undefined>;
  edit(ref: string, text: string, stop: boolean): Promise<void>;
  /** For `final: 'delete'`. */
  remove?(ref: string): Promise<void>;
}

export type Outcome = { kind: 'done' } | { kind: 'stopped' } | { kind: 'error'; reason?: string } | { kind: 'budget' } | { kind: 'restart' };

export interface ProgressOptions {
  port: ProgressPort;
  queue: SendQueue;
  /** The pacer's lane (one per bridge chat). */
  key: string;
  clock?: Clock;
  /** Shown once the turn is still running after this long. */
  afterMs: number;
  /** At most one edit per this many ms (3 s Telegram DM, 6 s Telegram group, 2.5 s Discord). */
  intervalMs: number;
  /**
   * Phase 117 (BRIDGES3 P5): edits the platform allows on one message (Signal: 9, its 10 minus a
   * spare). One is kept for the final line and one spare, so at most `editLimit - 2` live edits;
   * the last live one says "… and more steps" and then it stops updating. Unset: no limit.
   */
  editLimit?: number;
  final: 'summary' | 'delete';
  /** The reader's language (the owner's app language). */
  lang: string;
  /** The owner reads it: a Stop button and the error's reason. */
  owner: boolean;
  scrub: (s: string) => string;
  /** The message was posted (the bridge records its `bridge_progress` row). */
  onOpen?: (ref: string) => void;
  /** It reached its final state (the row is removed). */
  onClose?: () => void;
}

interface Step {
  id: string;
  name: string;
  now: string;
  done: string;
  /** Phase 116: 'note' = a steer taken, 'guard' = the loop guard stopped a repeat (lines, not steps). */
  status: 'running' | 'waiting' | 'ok' | 'error' | 'denied' | 'note' | 'guard';
}

const MAX_LINES = 6;

/** m:ss (h:mm:ss over an hour). */
export function clockTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The final line of a progress message (also written at start-up for one a restart left open). */
export function finalLine(o: Outcome, steps: number, elapsedMs: number, lang: string, owner: boolean, notes = 0): string {
  const t = (s: string, p?: Record<string, unknown>) => tr(s, lang, p);
  // Phase 116: "· 1 note from you" when he steered.
  const more = notes === 1 ? ` · ${t(en('1 note from you'))}` : notes > 1 ? ` · ${t(en('{n} notes from you'), { n: notes })}` : '';
  switch (o.kind) {
    case 'done':
      if (steps === 0) return `✅ ${t(en('Done · {time}'), { time: clockTime(elapsedMs) })}${more}`;
      return `✅ ${steps === 1 ? t(en('Done · 1 step · {time}'), { time: clockTime(elapsedMs) }) : t(en('Done · {n} steps · {time}'), { n: steps, time: clockTime(elapsedMs) })}${more}`;
    case 'stopped':
      return `⏹ ${steps === 1 ? t(en('Stopped after 1 step')) : t(en('Stopped after {n} steps'), { n: steps })}`;
    case 'budget':
      return `💰 ${t(en('Budget reached after {n} steps'), { n: steps })}`;
    case 'restart':
      return `⏹ ${t(en('Interrupted (Sara restarted)'))}`;
    case 'error':
      return `⚠️ ${owner && o.reason ? t(en("Couldn't finish: {reason}"), { reason: o.reason.replace(/\s+/g, ' ').slice(0, 200) }) : t(en("Couldn't finish"))}`;
  }
}

export class ProgressMessage {
  readonly #o: ProgressOptions;
  readonly #clock: Clock;
  readonly #steps: Step[] = [];
  readonly #startedAt: number;
  #state: 'idle' | 'shown' | 'final' | 'off' = 'idle';
  #header: 'thinking' | 'running' | 'waiting' | 'writing' = 'thinking';
  #ref: string | undefined;
  #showTimer: unknown;
  #editTimer: unknown;
  #lastText = '';
  /** What the last sent text said apart from the elapsed time (a new edit only when this changes). */
  #lastBody = '';
  #lastEditAt = 0;
  #failures = 0;
  #opening: Promise<void> | undefined;
  #editing: Promise<void> = Promise.resolve();
  #stopped = false;
  #error: string | undefined;
  #budget = false;
  /** Phase 116: steers taken in this turn ("· 1 note from you" on the final line). */
  #notes = 0;
  /** Phase 117: live edits sent (the final one is not counted). */
  #edits = 0;
  /** Every text sent (create and edits, in order), for tests and the run view. */
  readonly texts: string[] = [];

  constructor(o: ProgressOptions) {
    this.#o = o;
    this.#clock = o.clock ?? realClock;
    this.#startedAt = this.#clock.now();
  }

  get state(): string {
    return this.#state;
  }
  get ref(): string | undefined {
    return this.#ref;
  }
  get steps(): number {
    return this.#steps.filter((s) => s.status !== 'note').length;
  }

  /** Starts the wait (nothing is posted before `afterMs`). */
  start(): this {
    this.#showTimer = this.#clock.setTimeout(() => {
      this.#showTimer = undefined;
      this.#opening = this.#show();
    }, this.#o.afterMs);
    return this;
  }

  /** One event of the turn (only its type, the tool name and the status are used). */
  event(ev: ChatEvent): void {
    if (this.#state === 'final' || this.#state === 'off') return;
    let changed = true;
    if (ev.type === 'tool_call') {
      const [now, done] = this.#words(ev.name, ev.args);
      this.#steps.push({ id: ev.id, name: ev.name, now, done, status: 'running' });
      this.#header = 'running';
    } else if (ev.type === 'approval') {
      const s = this.#find(ev.id);
      if (s) s.status = 'waiting';
      this.#header = 'waiting';
    } else if (ev.type === 'tool_running') {
      const s = this.#find(ev.id);
      if (s) s.status = 'running';
      this.#header = 'running';
    } else if (ev.type === 'tool_result') {
      const s = this.#find(ev.id);
      // Phase 116 (§5.8): the guard's refusal arrives as a denied result after loop_guard; its line stays.
      if (s && s.status !== 'guard') s.status = ev.status;
      this.#header = 'thinking';
    } else if (ev.type === 'steer') {
      // Phase 116 (BR2 §5.4): his note was taken at the safe point.
      this.#steps.push({ id: `steer-${ev.messageId}`, name: 'steer', now: '', done: '', status: 'note' });
      this.#notes++;
    } else if (ev.type === 'loop_guard') {
      // Phase 116 (§5.8): the step it replaces is shown as the guard's line, once per block.
      const s = this.#find(ev.id);
      if (s) s.status = 'guard';
    } else if (ev.type === 'token') {
      changed = this.#header !== 'writing';
      this.#header = 'writing';
    } else if (ev.type === 'error') {
      if (ev.message === 'Stopped.') this.#stopped = true;
      else this.#error = ev.message;
      changed = false;
    } else if (ev.type === 'budget') {
      if (ev.state.stage === 'reached' || ev.state.reached) this.#budget = true;
      changed = false;
    } else changed = false;
    if (changed) this.#dirty();
  }

  /** The text as it would be sent now (header with the elapsed time, at most 6 step lines). */
  render(): string {
    const [head, ...lines] = this.#body().split('\n');
    return [`${head} · ${clockTime(this.#clock.now() - this.#startedAt)}`, ...lines].join('\n');
  }

  #body(): string {
    const t = (s: string, p?: Record<string, unknown>) => tr(s, this.#o.lang, p);
    const head = this.#header === 'waiting' ? `⏸ ${t(en('Waiting for your OK'))}` : this.#header === 'writing' ? `✍️ ${t(en('Writing her answer'))}` : `⏳ ${t(en('Working on it'))}`;
    // Finished steps with the same words fold into one line ("Read a file ×3").
    const groups: { s: Step; n: number }[] = [];
    for (const s of this.#steps) {
      const g = groups.at(-1);
      if (g && ((g.s.status === 'ok' && s.status === 'ok' && g.s.done === s.done) || (g.s.status === 'guard' && s.status === 'guard'))) g.n++;
      else groups.push({ s, n: 1 });
    }
    const lineOf = ({ s, n }: { s: Step; n: number }): string => {
      const x = n > 1 ? ` ×${n}` : '';
      if (s.status === 'note') return `📝 ${t(en('Got your note'))}`;
      if (s.status === 'guard') return `🔁 ${t(en('Stopped repeating a step that kept failing'))}`;
      if (s.status === 'running') return `▸ ${s.now}`;
      if (s.status === 'waiting') return `⏸ ${t(en('Waiting for your OK (above)'))}`;
      if (s.status === 'error') return `⚠️ ${t(en("Didn't work: {what}"), { what: s.done })}${x}`;
      if (s.status === 'denied') return `⛔ ${t(en('Not allowed: {what}'), { what: s.done })}${x}`;
      return `✅ ${s.done}${x}`;
    };
    let lines = groups.map(lineOf);
    if (lines.length > MAX_LINES) {
      const hidden = lines.length - (MAX_LINES - 1);
      lines = [`… ${t(en('and {n} earlier steps'), { n: hidden })}`, ...lines.slice(-(MAX_LINES - 1))];
    }
    if (this.#lastLive()) lines.push(`… ${t(en('and more steps'))}`);
    const safe = lines.map((l) => this.#o.scrub(l)).filter((l) => !minorSexualMatch(l, { others: true }));
    return [head, ...safe].join('\n');
  }

  /**
   * The turn ended: one last edit (the summary line, no Stop button) or the message is removed.
   * Nothing at all when it was never shown (a quick turn).
   */
  async finish(o?: Outcome): Promise<void> {
    if (this.#showTimer !== undefined) this.#clock.clearTimeout(this.#showTimer);
    this.#showTimer = undefined;
    if (this.#editTimer !== undefined) this.#clock.clearTimeout(this.#editTimer);
    this.#editTimer = undefined;
    const outcome: Outcome = o ?? (this.#stopped ? { kind: 'stopped' } : this.#budget ? { kind: 'budget' } : this.#error ? { kind: 'error', reason: this.#error } : { kind: 'done' });
    const elapsed = this.#clock.now() - this.#startedAt;
    const was = this.#state;
    this.#state = 'final';
    if (was === 'idle') return;
    await this.#opening;
    await this.#editing;
    if (!this.#ref) return;
    const ref = this.#ref;
    const text = finalLine(outcome, this.steps, elapsed, this.#o.lang, this.#o.owner, this.#notes);
    const wait = this.#lastEditAt + this.#o.intervalMs - this.#clock.now();
    if (wait > 0) await sleepOn(this.#clock, wait);
    try {
      if (this.#o.final === 'delete' && this.#o.port.remove) await this.#o.queue.send(this.#o.key, PRIO_EDIT, () => this.#o.port.remove!(ref));
      else {
        await this.#o.queue.send(this.#o.key, PRIO_EDIT, () => this.#o.port.edit(ref, text, false));
        this.texts.push(text);
      }
    } catch {
      /* best effort: the answer still comes */
    }
    this.#o.onClose?.();
  }

  #words(name: string, args: Record<string, unknown>): [string, string] {
    const t = (s: string, p?: Record<string, unknown>) => tr(s, this.#o.lang, p);
    try {
      // The plain fallback never names arguments; tool names of plugins and MCP stay as they are.
      const [now, done] = stepWordsWith(t, name, args ?? {}, '');
      return [now, done];
    } catch {
      return [t(en('Working…')), t(en('Did a step'))];
    }
  }

  /** The next live edit is the last one the edit budget allows. */
  #lastLive(): boolean {
    const max = this.#liveMax();
    return max !== undefined && this.#edits === max - 1;
  }
  #liveMax(): number | undefined {
    return this.#o.editLimit ? Math.max(0, this.#o.editLimit - 2) : undefined;
  }

  #find(id: string): Step | undefined {
    return this.#steps.find((s) => s.id === id) ?? this.#steps.findLast((s) => s.status === 'running' || s.status === 'waiting');
  }

  async #show(): Promise<void> {
    if (this.#state !== 'idle') return;
    this.#state = 'shown';
    const text = this.render();
    try {
      const ref = await this.#o.queue.send(this.#o.key, PRIO_EDIT, () => this.#o.port.create(text, this.#o.owner));
      if (!ref) {
        this.#state = 'off';
        return;
      }
      this.#ref = ref;
      this.#lastText = text;
      this.#lastBody = this.#bodyOf(text);
      this.#lastEditAt = this.#clock.now();
      this.texts.push(text);
      this.#o.onOpen?.(ref);
      // Something changed while it was being posted.
      if (this.#body() !== this.#lastBody) this.#dirty();
    } catch {
      this.#state = 'off';
    }
  }

  /** A sent text without the elapsed time on its first line. */
  #bodyOf(text: string): string {
    const [head, ...lines] = text.split('\n');
    return [head.replace(/ · [\d:]+$/, ''), ...lines].join('\n');
  }

  #dirty(): void {
    if (this.#state !== 'shown' || !this.#ref || this.#editTimer !== undefined) return;
    const wait = Math.max(0, this.#lastEditAt + this.#o.intervalMs - this.#clock.now());
    this.#editTimer = this.#clock.setTimeout(() => {
      this.#editTimer = undefined;
      this.#editing = this.#flush();
    }, wait);
  }

  async #flush(): Promise<void> {
    if (this.#state !== 'shown' || !this.#ref) return;
    const max = this.#liveMax();
    if (max !== undefined && this.#edits >= max) return;
    const body = this.#body();
    if (body === this.#lastBody) return;
    const text = this.render();
    if (text === this.#lastText) return;
    const ref = this.#ref;
    try {
      await this.#o.queue.send(this.#o.key, PRIO_EDIT, () => this.#o.port.edit(ref, text, this.#o.owner), `progress:${ref}`);
      this.#lastText = text;
      this.#lastBody = body;
      this.#lastEditAt = this.#clock.now();
      this.#failures = 0;
      this.#edits++;
      this.texts.push(text);
      // More happened while the edit was on its way.
      if (this.#body() !== body) this.#dirty();
    } catch {
      // Three failed edits in a row: no more progress in this turn (her reply still comes).
      if (++this.#failures >= 3) this.#state = 'off';
      this.#lastEditAt = this.#clock.now();
    }
  }
}
