// Phase 99 (ST4, docs/design/STAPLES.md §7.3–7.4): cards she works. *Assign → Sara* starts
// background work in the card's own conversation (channel `board`, key `card:<ref>`, in the project
// and its workspace) through the server's runTracked (Stop, activity, run snapshot, approvals,
// budgets); a helper or a team card runs through TeamManager with the card as the goal. At most N
// cards are worked at once (Settings: 2 by default), the rest queue in board order.
//
// Done means receipts: when the work ends, the turn's claim check (src/receipts.ts checkClaims and
// the judge) must have found nothing unproven; then the card goes to Done with what really happened
// (files, commands, messages…). Otherwise it waits on you with "I think it's done, but I couldn't
// prove: …". An approval card, a question (card_ask), a budget ceiling or a failure moves the card
// to Waiting on you; answering on the card answers the same ApprovalBroker entry / the same run.
import type { AppContext, ChatEvent } from './chat.ts';
import { boardFor, type BoardStore, type CardWork, type ColumnRole, type Who } from './board.ts';
import type { SharedBoardsAccess } from './shared-boards.ts';
import { receiptLines, teamBudget, cleanLimits, teamHelpers, type TeamLimits, type TeamTask } from './team.ts';
import type { Tool } from './tools/types.ts';
import { ToolError } from './tools/types.ts';
import { formatLocal } from './planner.ts';

/** Tools that move or describe cards don't count as receipts of the work itself. */
const BOARD_TOOLS = new Set(['board_list', 'card_add', 'card_move', 'card_comment', 'card_ask', 'card_assign']);
export const CONCURRENT_CHOICES = [1, 2, 3, 4] as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The board settings a person keeps (Settings → the board's ⋯ → Board settings). */
export interface BoardSettings {
  /** Cards she works at once; the rest queue in board order. */
  concurrent: number;
}
export function boardSettings(app: AppContext): BoardSettings {
  const b = app.settings.get().board ?? {};
  const n = Number(b.concurrent);
  return { concurrent: CONCURRENT_CHOICES.includes(n as 1) ? n : 2 };
}

/** What the worker needs of a card, wherever it lives (this planner, or a shared board). */
export interface WorkCard {
  ref: string;
  title: string;
  notes: string;
  labels: string[];
  project: string | null;
  projectId: number | null;
  dueAt: string | null;
  assignee: string | null;
  work: CardWork | null;
  limits: TeamLimits | null;
  /** Board order (the queue): board id, column position, card position. */
  order: [number, number, number];
}
export interface CardSource {
  /** 'l' this planner, 's' a shared board. */
  prefix: 'l' | 's';
  get(id: number): WorkCard | undefined;
  setWork(id: number, work: CardWork | null): void;
  setAssignee(id: number, assignee: string | null, who: Who): void;
  toRole(id: number, role: ColumnRole, who: Who): void;
  log(id: number, who: Who, what: 'started' | 'asked' | 'answered' | 'receipt' | 'done' | 'failed' | 'comment' | 'moved', detail: Record<string, unknown>): void;
  /** Cards with work in these states (queue and restarts). */
  withWork(states: CardWork['state'][]): WorkCard[];
}

/** The local source: this person's planner tasks (src/board.ts). */
export function localSource(board: BoardStore): CardSource {
  const wc = (id: number): WorkCard | undefined => {
    const c = board.card(id);
    if (!c) return undefined;
    const col = board.column(c.columnId);
    return { ref: String(c.id), title: c.title, notes: c.notes, labels: c.labels, project: c.project, projectId: c.projectId, dueAt: c.dueAt, assignee: c.assignee, work: c.work, limits: c.limits, order: [c.boardId, col?.position ?? 0, c.position] };
  };
  return {
    prefix: 'l',
    get: wc,
    setWork: (id, w) => board.setWork(id, w),
    setAssignee: (id, a, who) => board.setAssignee(id, a, who),
    toRole: (id, role, who) => void board.moveToRole(id, role, who),
    log: (id, who, what, detail) => board.log(id, who, what, detail),
    withWork: (states) => board.withWork(states).map((c) => wc(c.id)!).filter(Boolean),
  };
}

interface Live {
  key: string;
  /** Stop was pressed: nothing the ending turn reports changes the card any more. */
  stopped?: boolean;
  src: CardSource;
  id: number;
  conversationId: string;
  stop: () => void;
  /** card_ask waiting for the owner's words. */
  ask?: (text: string) => void;
}

export class CardWorker {
  readonly app: AppContext;
  /** Who this space is (the shared board's person id; 'owner' for the owner). */
  readonly person: string;
  readonly #sources: CardSource[] = [];
  readonly #live = new Map<string, Live>();
  #pumping = false;
  /** Tests: resolves when the work on a card ends. */
  readonly #done = new Map<string, Promise<void>>();

  constructor(app: AppContext, sources: CardSource[], person = 'owner') {
    this.app = app;
    this.person = person;
    this.#sources.push(...sources);
  }

  addSource(src: CardSource): void {
    this.#sources.push(src);
  }

  #src(ref: string): { src: CardSource; id: number } | undefined {
    const m = /^(s?)(\d+)$/.exec(ref);
    if (!m) return undefined;
    const src = this.#sources.find((s) => s.prefix === (m[1] ? 's' : 'l'));
    return src ? { src, id: Number(m[2]) } : undefined;
  }
  #key(src: CardSource, id: number): string {
    return `${src.prefix === 's' ? 's' : ''}${id}`;
  }

  /** After a restart: work that was running waits on you (Continue); queued work starts again. */
  start(): void {
    for (const src of this.#sources) {
      for (const c of src.withWork(['running'])) {
        if (!this.#mine(c.work)) continue;
        const id = Number(c.ref.replace(/^s/, ''));
        src.setWork(id, { ...c.work!, state: 'waiting', ask: { kind: 'interrupted', text: 'The server restarted while I was working on this. Continue?' } });
        src.toRole(id, 'waiting', 'sara');
      }
    }
    void this.#pump();
  }

  #mine(w: CardWork | null): boolean {
    return Boolean(w && (w.by ?? this.person) === this.person);
  }

  /** Waits until the work on a card ends (tests). */
  async finished(ref: string): Promise<void> {
    for (let i = 0; i < 3000; i++) {
      await this.#done.get(ref);
      const s = this.#src(ref);
      const w = s?.src.get(s.id)?.work;
      if (!this.#live.has(ref) && w?.state !== 'queued') return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  running(): string[] {
    return [...this.#live.keys()];
  }

  /** Who may work cards here: 'sara', a helper (owner only: members have no team) or 'team'. */
  workers(): { id: string; name: string }[] {
    const out = [{ id: 'sara', name: this.app.persona.name }];
    if (this.app.team) {
      for (const h of teamHelpers(this.app)) out.push({ id: `helper:${h.id}`, name: h.name });
      out.push({ id: 'team', name: 'A team' });
    }
    return out;
  }

  /** Assigns a card. 'sara', 'helper:<id>' and 'team' start background work (queued if busy); others just set it. */
  assign(ref: string, assignee: string | null, who: Who): WorkCard {
    const s = this.#src(ref);
    const c = s?.src.get(s.id);
    if (!s || !c) throw new Error('Task not found');
    const a = assignee === null || assignee === '' ? null : String(assignee);
    const works = a === 'sara' || a === 'team' || Boolean(a?.startsWith('helper:'));
    if (works && !this.workers().some((w) => w.id === a)) throw new Error(a?.startsWith('helper:') || a === 'team' ? 'Helpers work for the owner only (Settings → Team).' : 'No such helper.');
    if (a !== null && !works && !/^(me|member:[\w-]{1,64}|peer:[\w-]{1,64})$/.test(a)) throw new Error('Pick who works on it.');
    if (c.work && ['running', 'queued'].includes(c.work.state)) {
      if (c.assignee === a) return c;
      throw new Error('She is working on this card. Stop it first.');
    }
    if (c.assignee !== a) s.src.setAssignee(s.id, a, who);
    if (works) {
      s.src.setWork(s.id, { kind: a === 'sara' ? 'turn' : 'team', conversationId: '', startedAt: this.app.now().toISOString(), state: 'queued', by: this.person });
      void this.#pump();
    } else if (c.work && c.work.state !== 'done') s.src.setWork(s.id, null);
    return s.src.get(s.id)!;
  }

  /** The queue in board order, and "Queued (2nd)" places. */
  queue(): string[] {
    const all: { key: string; order: [number, number, number] }[] = [];
    for (const src of this.#sources) for (const c of src.withWork(['queued'])) if (this.#mine(c.work)) all.push({ key: this.#key(src, Number(c.ref.replace(/^s/, ''))), order: c.order });
    all.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
    return all.map((x) => x.key);
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      const max = boardSettings(this.app).concurrent;
      for (const key of this.queue()) {
        if (this.#live.size >= max) break;
        if (this.#live.has(key)) continue;
        const s = this.#src(key)!;
        const c = s.src.get(s.id);
        if (!c?.work || c.work.state !== 'queued') continue;
        const run = c.assignee === 'sara' || c.work.kind === 'turn' ? this.#turn(s.src, s.id, c) : this.#team(s.src, s.id, c);
        this.#done.set(key, run.catch(() => undefined));
      }
    } finally {
      this.#pumping = false;
    }
  }

  #conversation(src: CardSource, id: number, c: WorkCard): string {
    const key = `card:${this.#key(src, id)}`;
    const store = this.app.store;
    const found = store.findChannelConversation('board', key, 'owner');
    if (found) return found.id;
    const project = c.projectId !== null && src.prefix === 'l' ? this.app.planner?.projects(true).find((p) => p.id === c.projectId) : undefined;
    return store.createConversation({ title: clip(`Card: ${c.title}`, 120), channel: 'board', channelKey: key, projectId: project?.id ?? null, ...(project?.workspace ? { workspace: project.workspace, mode: 'coding' } : {}) }).id;
  }

  /** What she reads: the card itself (title, notes, labels, project, due) and how card work goes. */
  #prompt(c: WorkCard): string {
    const tz = this.app.settings.get().timeZone;
    return [
      `Work on this card from my board, on your own, in the background. Do the work with your tools; when it is done, reply with a short report of what you did.`,
      `If you need something only I can answer, call card_ask with one clear question (it waits for my answer). Don't claim anything you didn't do: the card only moves to Done when your receipts back your report.`,
      '',
      `Card: ${c.title}`,
      ...(c.project ? [`Project: ${c.project}`] : []),
      ...(c.labels.length ? [`Labels: ${c.labels.join(', ')}`] : []),
      ...(c.dueAt ? [`Due: ${formatLocal(c.dueAt, tz)}`] : []),
      ...(c.notes.trim() ? ['Notes:', c.notes.trim().slice(0, 6000)] : []),
    ].join('\n');
  }

  #set(src: CardSource, id: number, patch: Partial<CardWork>): CardWork {
    const cur = src.get(id)?.work;
    const next = { ...(cur ?? { kind: 'turn', conversationId: '', startedAt: this.app.now().toISOString(), state: 'running' }), ...patch } as CardWork;
    for (const k of Object.keys(patch) as (keyof CardWork)[]) if (patch[k] === undefined) delete next[k];
    src.setWork(id, next);
    return next;
  }

  async #turn(src: CardSource, id: number, c: WorkCard, resume?: { text?: string; more?: Record<string, number> }): Promise<void> {
    const key = this.#key(src, id);
    const runTracked = this.app.runTracked;
    if (!runTracked) {
      this.#set(src, id, { state: 'waiting', ask: { kind: 'failed', text: 'Background work is not available on this server.' } });
      src.toRole(id, 'waiting', 'sara');
      return;
    }
    const conversationId = this.#conversation(src, id, c);
    const live: Live = { key, src, id, conversationId, stop: () => void this.app.stopTurn?.(conversationId) };
    this.#live.set(key, live);
    const limits = c.limits ?? cleanLimits(this.app.settings.get().teamLimits);
    const prevReceipts = resume ? (c.work?.receipts ?? []) : [];
    this.#set(src, id, { kind: 'turn', conversationId, state: 'running', startedAt: c.work?.startedAt && resume ? c.work.startedAt : this.app.now().toISOString(), line: resume ? 'Picking it up again' : 'Reading the card', ask: undefined, receipts: prevReceipts, by: this.person, endedAt: undefined });
    src.toRole(id, 'doing', 'sara');
    src.log(id, 'sara', 'started', { conversationId: src.prefix === 'l' ? conversationId : undefined });
    const receipts = [...prevReceipts];
    let claims: { sentence: string }[] = [];
    let reached: string | undefined;
    let more: Record<string, number> | undefined;
    let error: string | undefined;
    let stopped = false;
    let reply = '';
    const onEvent = (ev: ChatEvent) => {
      if (live.stopped) return;
      if (ev.type === 'tool_call' || ev.type === 'tool_running') {
        // Text written next to tool calls isn't her final answer.
        if (ev.type === 'tool_call') reply = '';
        this.#set(src, id, { line: clip(ev.summary, 140) });
      }
      else if (ev.type === 'approval') {
        this.#set(src, id, { state: 'waiting', line: clip(ev.summary, 140), ask: { kind: 'approval', text: ev.summary, approvalId: ev.approvalId, tool: ev.name } });
        src.toRole(id, 'waiting', 'sara');
        src.log(id, 'sara', 'asked', { approval: ev.summary });
      } else if (ev.type === 'tool_result') {
        const w = src.get(id)?.work;
        if (w?.ask?.kind === 'approval') {
          this.#set(src, id, { state: 'running', ask: undefined });
          src.toRole(id, 'doing', 'sara');
          src.log(id, 'me', 'answered', { approval: ev.status === 'denied' ? 'deny' : 'allow' });
        }
        if (!BOARD_TOOLS.has(ev.name)) {
          receipts.push({ tool: ev.name, summary: clip(ev.output.split('\n')[0] ?? '', 160), status: ev.status });
          this.#set(src, id, { receipts: receipts.slice(-40) });
        }
      } else if (ev.type === 'budget') {
        this.#set(src, id, { used: { tokens: ev.state.used.tokens, steps: ev.state.used.steps } });
        if (ev.state.stage === 'reached') {
          reached = ev.state.reason ?? 'the budget';
          more = ev.state.more as Record<string, number> | undefined;
        }
      } else if (ev.type === 'claim_check') claims = ev.claims;
      else if (ev.type === 'token') reply += ev.text;
      else if (ev.type === 'replace') reply = ev.text;
      else if (ev.type === 'error') error = ev.message;
    };
    try {
      const opts = { budget: teamBudget(limits, ['tokens', 'usd', 'steps', 'minutes']), ...(resume?.more ? { resume: true, budgetMore: resume.more } : {}) };
      const content = resume?.more ? (this.app.store.messages(conversationId).filter((m) => m.role === 'user').at(-1)?.content ?? this.#prompt(c)) : resume?.text ? `My answer: ${resume.text}` : this.#prompt(c);
      await runTracked(conversationId, content, onEvent, opts);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      this.#live.delete(key);
    }
    if (live.stopped || src.get(id)?.work?.state === 'stopped') stopped = true;
    const ended = { endedAt: this.app.now().toISOString() };
    if (stopped) {
      this.#set(src, id, { ...ended, state: 'stopped', line: undefined, ask: undefined });
      src.toRole(id, 'todo', 'me');
    } else if (reached) {
      this.#set(src, id, { ...ended, state: 'waiting', ask: { kind: 'budget', text: `I stopped at ${reached}. Continue with more budget?`, ...(more ? { more } : {}) } });
      src.toRole(id, 'waiting', 'sara');
      src.log(id, 'sara', 'asked', { budget: reached });
    } else if (error) {
      this.#set(src, id, { ...ended, state: 'waiting', ask: { kind: 'failed', text: `I got stuck: ${clip(error, 300)}` } });
      src.toRole(id, 'waiting', 'sara');
      src.log(id, 'sara', 'failed', { error: clip(error, 300) });
    } else if (claims.length) {
      const line = `I think it's done, but I couldn't prove: ${claims.map((x) => clip(x.sentence, 160)).join(' · ')}`;
      this.#set(src, id, { ...ended, state: 'waiting', line: undefined, ask: { kind: 'unproven', text: line } });
      src.toRole(id, 'waiting', 'sara');
      src.log(id, 'sara', 'asked', { unproven: claims.map((x) => clip(x.sentence, 200)) });
    } else if (!receipts.some((r) => r.status === 'ok')) {
      // Done means receipts: a run that did nothing (only words, often a question she didn't ask
      // with card_ask) waits on you with what she said. Answer it, or move the card yourself.
      this.#set(src, id, { ...ended, state: 'waiting', line: undefined, ask: { kind: 'question', text: clip(reply.trim() || 'I stopped without doing anything on this card.', 600) } });
      src.toRole(id, 'waiting', 'sara');
      src.log(id, 'sara', 'asked', { question: clip(reply.trim(), 400) });
    } else {
      this.#set(src, id, { ...ended, state: 'done', line: clip(reply.trim().split('\n')[0] ?? '', 160) || undefined, ask: undefined });
      src.log(id, 'sara', 'receipt', { receipts: receipts.filter((r) => r.status === 'ok').map((r) => `${r.tool}: ${r.summary}`).slice(0, 20) });
      src.toRole(id, 'done', 'sara');
    }
    void this.#pump();
  }

  async #team(src: CardSource, id: number, c: WorkCard, cont?: boolean): Promise<void> {
    const key = this.#key(src, id);
    const team = this.app.team;
    if (!team) {
      this.#set(src, id, { state: 'waiting', ask: { kind: 'failed', text: 'Helpers work for the owner only (Settings → Team).' } });
      src.toRole(id, 'waiting', 'sara');
      return;
    }
    const conversationId = this.#conversation(src, id, c);
    let task: TeamTask;
    try {
      if (cont && c.work?.id) task = team.continueWithMore(c.work.id);
      else {
        const helper = c.assignee?.startsWith('helper:') ? c.assignee.slice(7) : undefined;
        const goal = this.#prompt(c);
        task = team.start(conversationId, goal, { ...(c.limits ? { limits: c.limits } : {}), ...(helper ? { plan: [{ helper, title: clip(c.title, 150), instructions: goal }] } : {}) });
      }
    } catch (err) {
      // TeamManager runs two tasks at a time: stay queued and try again when one ends.
      if (/already running/.test((err as Error).message)) {
        setTimeout(() => void this.#pump(), 5_000).unref?.();
        return;
      }
      this.#set(src, id, { state: 'waiting', ask: { kind: 'failed', text: `I couldn't start it: ${clip((err as Error).message, 300)}` } });
      src.toRole(id, 'waiting', 'sara');
      return;
    }
    const live: Live = { key, src, id, conversationId, stop: () => void team.stop(task.id) };
    this.#live.set(key, live);
    this.#set(src, id, { kind: 'team', id: task.id, conversationId, state: 'running', startedAt: cont ? (c.work?.startedAt ?? this.app.now().toISOString()) : this.app.now().toISOString(), line: 'Planning the work', ask: undefined, by: this.person, endedAt: undefined });
    src.toRole(id, 'doing', 'sara');
    src.log(id, c.assignee ?? 'sara', 'started', { team: task.id });
    const sync = () => {
      const t = team.get(task.id);
      if (!t) return;
      const ap = team.approvals(t.id)[0];
      const step = t.steps.find((s) => s.status === 'running');
      if (ap) {
        if (src.get(id)?.work?.ask?.approvalId !== ap.id) {
          this.#set(src, id, { state: 'waiting', ask: { kind: 'team', text: `${ap.helper}: ${ap.summary}`, approvalId: ap.id, tool: ap.tool } });
          src.toRole(id, 'waiting', 'sara');
          src.log(id, 'sara', 'asked', { approval: ap.summary });
        }
      } else if (t.status === 'waiting' && t.checkpoint) {
        this.#set(src, id, { state: 'waiting', ask: { kind: 'team', text: t.checkpoint.text.slice(0, 600) } });
        src.toRole(id, 'waiting', 'sara');
      } else if (t.status === 'running' || t.status === 'planning') {
        const w = src.get(id)?.work;
        if (w?.state === 'waiting') {
          this.#set(src, id, { state: 'running', ask: undefined });
          src.toRole(id, 'doing', 'sara');
        }
        if (step) this.#set(src, id, { line: clip(`${step.helper}: ${step.title}`, 140), used: { tokens: t.tokens, steps: t.steps.filter((s) => s.status !== 'waiting').length } });
      }
    };
    const unsub = this.app.events?.subscribe((ev) => {
      if (ev.type === 'team' && ev.task.id === task.id) sync();
    });
    let t: TeamTask;
    try {
      t = await team.finished(task.id);
    } finally {
      unsub?.();
      this.#live.delete(key);
    }
    const ended = { endedAt: this.app.now().toISOString() };
    const names = new Map(teamHelpers(this.app).map((h) => [h.id, h.name]));
    const lines = receiptLines(t.steps, names);
    const unverified = t.steps.flatMap((s) => s.unverified);
    const receipts = lines.map((l) => ({ tool: 'team', summary: clip(l, 160), status: 'ok' }));
    if (t.status === 'done' && !unverified.length) {
      this.#set(src, id, { ...ended, state: 'done', receipts, line: clip((t.report ?? '').split('\n')[0] ?? '', 160) || undefined, ask: undefined });
      src.log(id, 'sara', 'receipt', { receipts: lines.slice(0, 20) });
      src.toRole(id, 'done', 'sara');
    } else if (t.status === 'done') {
      this.#set(src, id, { ...ended, state: 'waiting', receipts, ask: { kind: 'unproven', text: `I think it's done, but I couldn't prove: ${unverified.map((x) => clip(x, 160)).join(' · ')}` } });
      src.toRole(id, 'waiting', 'sara');
    } else if (t.status === 'limit') {
      this.#set(src, id, { ...ended, state: 'waiting', receipts, ask: { kind: 'budget', text: 'The team stopped at its limit. Continue with more budget?' } });
      src.toRole(id, 'waiting', 'sara');
    } else if (t.status === 'stopped') {
      this.#set(src, id, { ...ended, state: 'stopped', receipts, line: undefined, ask: undefined });
      src.toRole(id, 'todo', 'me');
    } else {
      this.#set(src, id, { ...ended, state: 'waiting', receipts, ask: { kind: 'failed', text: `The team couldn't finish: ${clip(t.report ?? t.status, 300)}` } });
      src.toRole(id, 'waiting', 'sara');
      src.log(id, 'sara', 'failed', { status: t.status });
    }
    void this.#pump();
  }

  /** Stops the work on a card (a queued card just leaves the queue). */
  stop(ref: string): boolean {
    const s = this.#src(ref);
    const c = s?.src.get(s.id);
    if (!s || !c?.work || !this.#mine(c.work)) return false;
    if (c.work.state === 'queued') {
      s.src.setWork(s.id, null);
      return true;
    }
    const live = this.#live.get(ref);
    if (!live) {
      if (c.work.state === 'waiting') {
        this.#set(s.src, s.id, { state: 'stopped', ask: undefined, line: undefined });
        s.src.toRole(s.id, 'todo', 'me');
        return true;
      }
      return false;
    }
    live.stopped = true;
    this.#set(s.src, s.id, { state: 'stopped' });
    s.src.log(s.id, 'me', 'failed', { stopped: true });
    // A pending approval or question is answered "no" by the stop.
    if (c.work.ask?.approvalId) this.app.approvals.decide(c.work.ask.approvalId, false);
    live.ask?.('');
    live.stop();
    return true;
  }

  /**
   * Answers a waiting card: Allow / Deny on its approval (the same broker entry, so a phone or the
   * tray could answer it too), words for its question, or Continue with more budget.
   */
  answer(ref: string, a: { text?: string; approval?: 'allow' | 'deny'; more?: boolean; resume?: boolean }): boolean {
    const s = this.#src(ref);
    const c = s?.src.get(s.id);
    if (!s || !c?.work || !this.#mine(c.work) || c.work.state !== 'waiting') return false;
    const ask = c.work.ask;
    if (a.approval && ask?.approvalId) {
      const ok = this.app.approvals.decide(ask.approvalId, a.approval === 'allow');
      if (ok) s.src.log(s.id, 'me', 'answered', { approval: a.approval });
      if (ok && c.work.kind === 'team') this.#set(s.src, s.id, { state: 'running', ask: undefined });
      return ok;
    }
    const live = this.#live.get(ref);
    if (a.text !== undefined && live?.ask) {
      const text = a.text.trim().slice(0, 4000);
      if (!text) return false;
      s.src.log(s.id, 'me', 'answered', { text: clip(text, 400) });
      this.#set(s.src, s.id, { state: 'running', ask: undefined });
      s.src.toRole(s.id, 'doing', 'me');
      live.ask(text);
      return true;
    }
    if (this.#live.has(ref)) return false;
    if (a.more && ask?.kind === 'budget') {
      s.src.log(s.id, 'me', 'answered', { more: true });
      const run = c.work.kind === 'team' ? this.#team(s.src, s.id, c, true) : this.#turn(s.src, s.id, c, { more: ask.more ?? {} });
      this.#done.set(ref, run.catch(() => undefined));
      return true;
    }
    // Words for a card that isn't running any more (her question after a restart, "I couldn't prove",
    // a failure): she picks it up again in the same conversation with the answer.
    if ((a.text?.trim() || a.resume) && c.work.kind === 'turn') {
      s.src.log(s.id, 'me', 'answered', { text: clip(a.text?.trim() || 'Continue', 400) });
      const run = this.#turn(s.src, s.id, c, { text: a.text?.trim() || 'Please continue where you left off.' });
      this.#done.set(ref, run.catch(() => undefined));
      return true;
    }
    if (a.resume && c.work.kind === 'team' && c.work.id) {
      const run = this.#team(s.src, s.id, c, false);
      this.#done.set(ref, run.catch(() => undefined));
      return true;
    }
    return false;
  }

  /** card_ask: the card waits on you with the question; resolves with your answer (or '' on stop). */
  async ask(conversationId: string, question: string, signal: AbortSignal): Promise<string> {
    const live = [...this.#live.values()].find((l) => l.conversationId === conversationId);
    if (!live) throw new ToolError('card_ask only works inside the work on a card.');
    const q = question.replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!q) throw new ToolError('Ask one clear question.');
    this.#set(live.src, live.id, { state: 'waiting', ask: { kind: 'question', text: q } });
    live.src.toRole(live.id, 'waiting', 'sara');
    live.src.log(live.id, 'sara', 'asked', { question: q });
    return await new Promise<string>((resolve) => {
      const done = (t: string) => {
        live.ask = undefined;
        signal.removeEventListener('abort', onAbort);
        resolve(t);
      };
      const onAbort = () => done('');
      signal.addEventListener('abort', onAbort, { once: true });
      live.ask = done;
    });
  }

  /** The live work in a conversation (card_move: auto for her own card). */
  cardIn(conversationId: string): string | undefined {
    return [...this.#live.values()].find((l) => l.conversationId === conversationId)?.key;
  }
}

// ---------------------------------------------------------------------------------------------
// her tools
// ---------------------------------------------------------------------------------------------

/** board_list, card_add, card_move, card_comment, card_ask, card_assign (docs/design/STAPLES.md §7.8). */
export function createBoardTools(app: () => AppContext): Tool[] {
  const board = () => {
    const b = app().board;
    if (!b) throw new ToolError('The board is not available here.');
    return b;
  };
  const taskArg = (args: Record<string, unknown>): number => {
    const n = Number(String(args.task ?? '').replace(/^#/, ''));
    if (!Number.isInteger(n) || n <= 0) throw new ToolError('Give the card\'s "task" (its number, e.g. 12).');
    return n;
  };
  const columnFor = (taskId: number, name: string) => {
    const b = board();
    const c = b.card(taskId);
    if (!c) throw new ToolError(`No card #${taskId}.`);
    const cols = b.columns(c.boardId);
    const want = name.trim().toLowerCase();
    const roleWords: Record<string, ColumnRole> = { todo: 'todo', 'to do': 'todo', doing: 'doing', 'in progress': 'doing', waiting: 'waiting', 'waiting on you': 'waiting', blocked: 'waiting', done: 'done' };
    const col = cols.find((x) => x.name.toLowerCase() === want) ?? cols.find((x) => x.role === roleWords[want]);
    if (!col) throw new ToolError(`No column "${name}" on that board. Columns: ${cols.map((x) => x.name).join(', ')}.`);
    return { b, c, col };
  };
  const herOwn = (taskId: number, conversationId?: string) => {
    const c = app().board?.card(taskId);
    const w = app().cardWork;
    return Boolean(c && (c.assignee === 'sara' || (conversationId && w?.cardIn(conversationId) === String(taskId))));
  };
  const list: Tool = {
    spec: {
      name: 'board_list',
      description: "The owner's boards and their cards (the to-dos as columns: To do, Doing, Waiting on you, Done). Without board: every open card by column, with what's blocked (waiting on the owner) and what you're working on.",
      parameters: { type: 'object', properties: { board: { type: 'string', description: 'A board name (a project) to list only that one' } } },
    },
    defaultPermission: 'auto',
    summarize: (a) => `board${a.board ? `: ${String(a.board)}` : ''}`,
    async run(args) {
      const b = board();
      const tz = app().settings.get().timeZone;
      const want = String(args.board ?? '').trim().toLowerCase();
      const boards = want ? b.boards().filter((x) => x.name.toLowerCase() === want) : [b.board(0)!];
      if (!boards.length) return `No board called "${String(args.board)}". Boards: ${b.boards().map((x) => x.name).join(', ')}.`;
      const out: string[] = [];
      for (const bd of boards) {
        const v = b.view(bd.id)!;
        out.push(`Board: ${bd.kind === 'everything' ? 'Everything' : bd.name}`);
        for (const col of v.columns) {
          const cards = v.cards.filter((c) => c.columnId === col.id && (col.role !== 'done' || c.doneAt));
          out.push(`${col.name} (${cards.length}${col.wipLimit ? ` of ${col.wipLimit}` : ''}):`);
          for (const c of (col.role === 'done' ? cards.slice(0, 5) : cards).slice(0, 40)) {
            const bits = [c.project && bd.kind === 'everything' ? c.project : '', c.labels.join(', '), c.dueAt ? `due ${formatLocal(c.dueAt, tz)}` : '', c.assignee ? `assigned: ${c.assignee}` : '', c.work?.state === 'waiting' && c.work.ask ? (c.work.ask.approvalId ? `BLOCKED, waiting for the owner's OK to: ${c.work.ask.text}` : `BLOCKED, waiting on the owner: ${c.work.ask.text}`) : c.work?.state === 'running' ? `working: ${c.work.line ?? ''}` : c.work?.state === 'queued' ? 'queued' : ''].filter(Boolean);
            out.push(`  #${c.id} ${c.title}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
          }
        }
      }
      return out.join('\n');
    },
  };
  const add: Tool = {
    spec: {
      name: 'card_add',
      description: "Put a card (a to-do) on the owner's board. board = a project's board by name (default: the to-dos without a project); column = To do (default), Doing, Waiting on you or Done; labels from the board's labels; due in the owner's time like friday 5pm.",
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, board: { type: 'string' }, column: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, due: { type: 'string' }, notes: { type: 'string' } },
        required: ['title'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `card: ${String(a.title ?? '')}${a.board ? ` (${String(a.board)})` : ''}`,
    async run(args, ctx) {
      const b = board();
      const want = String(args.board ?? '').trim().toLowerCase();
      let bd = want ? b.boards().find((x) => x.name.toLowerCase() === want) : b.general();
      if (want && !bd) {
        // A board for a new project, the way "todo add" makes the project.
        const pid = b.planner.projectId(String(args.board).trim());
        bd = pid ? b.forProject(pid) : b.general();
      }
      const tz = app().settings.get().timeZone;
      let dueAt: string | null = null;
      if (args.due) {
        const { parseWhen } = await import('./planner.ts');
        const d = parseWhen(String(args.due), app().now(), tz, { dateOnlyHour: 17 });
        if (!d) throw new ToolError(`Couldn't understand the time "${String(args.due)}". Use "YYYY-MM-DD HH:MM", "tomorrow 9am" or "friday".`);
        dueAt = d.toISOString();
      }
      const cols = b.columns(bd!.id);
      const colName = String(args.column ?? '').trim().toLowerCase();
      const col = colName ? (cols.find((x) => x.name.toLowerCase() === colName) ?? cols.find((x) => x.role === ({ todo: 'todo', 'to do': 'todo', doing: 'doing', waiting: 'waiting', done: 'done' } as Record<string, ColumnRole>)[colName])) : undefined;
      try {
        const c = b.addCard(bd!.id, { title: String(args.title ?? ''), notes: args.notes ? String(args.notes) : '', dueAt, labels: Array.isArray(args.labels) ? (args.labels as string[]) : [], conversationId: ctx.conversationId ?? null, ...(col ? { columnId: col.id } : {}) }, 'sara');
        return `Added card #${c.id} "${c.title}" to ${bd!.kind === 'general' ? 'the to-dos board' : `the ${bd!.name} board`}, in ${b.column(c.columnId)?.name ?? 'To do'}${c.labels.length ? ` with ${c.labels.join(', ')}` : ''}${c.dueAt ? `, due ${formatLocal(c.dueAt, tz)}` : ''}.`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  };
  const move: Tool = {
    spec: {
      name: 'card_move',
      description: 'Move a card to a column (To do, Doing, Waiting on you, Done, or another column by name). Moving to Done completes the to-do. Cards that are not assigned to you ask the owner first.',
      parameters: { type: 'object', properties: { task: { type: 'number', description: 'The card number' }, column: { type: 'string' } }, required: ['task', 'column'] },
    },
    defaultPermission: 'auto',
    // Never moved silently when it isn't hers (§7.3): her own cards move on their own, others ask.
    asksFirst: (a) => !herOwn(Number(String(a.task ?? '').replace(/^#/, ''))),
    summarize: (a) => `move card #${String(a.task ?? '')} to ${String(a.column ?? '')}`,
    // The card shows the card's name, its board and where it goes (not the arguments).
    async prepare(args) {
      const c = app().board?.card(Number(String(args.task ?? '').replace(/^#/, '')));
      if (!c) return {};
      const b = app().board!;
      const bd = b.board(c.boardId);
      return { summary: `Move “${clip(c.title, 80)}”${bd && bd.kind === 'project' ? ` (${bd.name})` : ''} from ${b.column(c.columnId)?.name ?? '?'} to ${String(args.column ?? '')}` };
    },
    async run(args) {
      const id = taskArg(args);
      const { b, col } = columnFor(id, String(args.column ?? ''));
      try {
        const c = b.move(id, col.id, { who: 'sara' });
        const p = b.place(id);
        return `Moved card #${id} "${c.title}" to ${col.name}${p ? `, position ${p.index} of ${p.of}` : ''}.`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  };
  const comment: Tool = {
    spec: {
      name: 'card_comment',
      description: 'Add a comment to a card (what you found, a link, progress). With done=true on a card that is not yours, the card shows "Move to Done?" for the owner (you did the work in chat): say what you did in the text.',
      parameters: { type: 'object', properties: { task: { type: 'number' }, text: { type: 'string' }, done: { type: 'boolean' } }, required: ['task', 'text'] },
    },
    defaultPermission: 'auto',
    summarize: (a) => `comment on card #${String(a.task ?? '')}`,
    async run(args) {
      const id = taskArg(args);
      const b = board();
      const c = b.card(id);
      if (!c) throw new ToolError(`No card #${id}.`);
      try {
        b.comment(id, 'sara', String(args.text ?? ''));
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      if (args.done === true && c.status === 'open') {
        b.setWork(id, { ...(c.work ?? { kind: 'turn', conversationId: '', startedAt: app().now().toISOString(), state: 'done' }), suggest: 'done' });
        return `Commented on card #${id}. The card asks the owner "Move to Done?".`;
      }
      return `Commented on card #${id}.`;
    },
  };
  const ask: Tool = {
    spec: {
      name: 'card_ask',
      description: "Only while you work on a card: ask the owner one question you can't answer from the card. The card moves to Waiting on you with the question and this call waits for the answer.",
      parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    },
    defaultPermission: 'auto',
    summarize: (a) => `ask: ${clip(String(a.question ?? ''), 80)}`,
    async run(args, ctx) {
      const w = app().cardWork;
      if (!w || !ctx.conversationId) throw new ToolError('card_ask only works inside the work on a card.');
      const answer = await w.ask(ctx.conversationId, String(args.question ?? ''), ctx.signal);
      return answer ? `The owner answered: ${answer}` : 'No answer (the work was stopped). Stop here.';
    },
  };
  const assign: Tool = {
    spec: {
      name: 'card_assign',
      description: "Assign a card: to=sara (you work it in the background in the card's own conversation), helper:<id> (a helper from the Team page), team, me (the owner), or none. Starting background work spends budget, so the owner approves it.",
      parameters: { type: 'object', properties: { task: { type: 'number' }, to: { type: 'string' } }, required: ['task', 'to'] },
    },
    defaultPermission: 'ask',
    summarize: (a) => `assign card #${String(a.task ?? '')} to ${String(a.to ?? '')}`,
    async prepare(args) {
      const c = app().board?.card(Number(String(args.task ?? '').replace(/^#/, '')));
      const to = String(args.to ?? '');
      if (!c) return {};
      return { summary: `${to === 'sara' ? 'Work on' : 'Assign'} “${clip(c.title, 80)}”${to === 'sara' ? ' in the background (it spends budget within the card\'s limits)' : ` to ${to}`}` };
    },
    async run(args) {
      const id = taskArg(args);
      const w = app().cardWork;
      if (!w) throw new ToolError('Card work is not available here.');
      const to = String(args.to ?? '').trim();
      try {
        const c = w.assign(String(id), to === 'none' || !to ? null : to, 'sara');
        return c.work?.state === 'queued' ? `Assigned card #${id} to ${to}; the work starts now (or when a slot frees up).` : `Assigned card #${id} to ${to || 'nobody'}.`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  };
  return [list, add, move, comment, ask, assign];
}

/**
 * Gives an app its board (one per planner), and — for the space that owns the planner — the live
 * pushes and the card worker. A space with shared boards also works the shared cards its person
 * assigned. Companions sharing a planner get the board and use the main companion's worker.
 */
export function setUpBoard(app: AppContext, opts: { person?: string; shared?: SharedBoardsAccess; worker?: boolean } = {}): void {
  if (!app.planner) return;
  app.planner.timeZone = () => app.settings.get().timeZone;
  app.board = boardFor(app.planner);
  if (opts.shared) app.sharedBoards = opts.shared;
  if (opts.worker === false) return;
  const board = app.board;
  board.listeners.add((ev) => app.events?.publish({ type: 'board', boardId: ev.boardId, ...(ev.taskId !== undefined ? { taskId: ev.taskId } : {}), what: ev.what }));
  app.cardWork = new CardWorker(app, [localSource(board), ...(opts.shared ? [opts.shared.store.source(opts.shared.person)] : [])], opts.person ?? 'owner');
}
