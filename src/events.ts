// Server → browser push channel (GET /api/events). Used for things that happen outside a turn:
// reminders arriving, memory written, and (later) Sara's proactive messages.
import { EventEmitter } from 'node:events';

export type HubEvent = (
  | { type: 'message'; conversationId: string; message: { id: number; role: string; content: string; createdAt: string; meta?: Record<string, unknown> }; reason: 'reminder' | 'proactive' | 'job' | 'reply' }
  /** A background job started, made progress or ended (Phase 13). */
  | { type: 'job'; job: import('./jobs.ts').Job }
  | { type: 'planner'; what: 'tasks' | 'reminders' | 'notes' }
  /** 3.0.3: `saved` = new notes the memory worker put on this chat's replies (the open chat redraws). */
  | { type: 'memory'; conversationId: string; saved?: number }
  /** Phase 101 (ST6): people cards changed (proposed, facts added, edited, forgotten). Never names or facts. */
  | { type: 'people'; what?: string }
  /** Phase 26: she is calling (or the ring ended: answered, missed, declined, cancelled). */
  | { type: 'ring'; ring: import('./calls.ts').Ring }
  /** Phase 36: her look changed (closet, outfit for the scenario). */
  | { type: 'look' }
  /** Phase 44: a library document was added, read, learned from or removed. */
  | { type: 'library'; id: number }
  /** Phase 51: "Bring your history": an import or its learning made progress. */
  | { type: 'history-import'; status: import('./history-import/index.ts').HistoryStatus }
  /** Phase 50: a recipe was saved, changed or deleted. */
  | { type: 'recipes' }
  /** Phase 96: a skill was added, changed, switched or removed. */
  | { type: 'skills' }
  /** Phase 98: a plugin was added, switched, changed, crashed or asks to use a tool. */
  | { type: 'plugins' }
  /** Phase 99 (ST4): a board changed (a card added, moved, assigned, its work moved on): open boards refresh. Ids only, never what cards say. */
  | { type: 'board'; boardId: number | string; taskId?: number | string; what?: string }
  /** Phase 102 (ST7): a webhook got a delivery or changed: the Webhooks page refreshes. Ids only, never what was sent. */
  | { type: 'hooks'; hookId?: string }
  | { type: 'triggers' }
  /** Phase 103 (ST8): her plans changed (planned, sent, edited, switched). Nothing of what they say. */
  | { type: 'agenda' }
  /** Phase 111 (TD1): a part of Today changed (mail organised, a switch pressed…): open pages reload that part. */
  | { type: 'today'; part: string }
  // Phase 104 (move-in): a bundle's upload, check, read or import moved on (src/movein/index.ts).
  | { type: 'movein'; id: string; state: string; line: string }
  /** Phase 52: device-code sign-in requests waiting for the owner. */
  | { type: 'device'; pending: number }
  /** Phase 126: a Hey Sara device of this person switched on, off or paused (never text or audio). */
  | { type: 'wake'; device: string; state: 'on' | 'off' | 'paused'; reason?: string }
  /** Phase 39: a team task changed (plan, a helper's progress, the end). */
  | { type: 'team'; task: { id: number; status: string; conversationId: string; approvals?: number } }
  /** A turn started or ended in a conversation (any device, Telegram or Discord): the other open
   * apps refresh it, so a chat can be picked up anywhere. */
  | { type: 'turn'; conversationId: string; state: 'started' | 'ended' }
  /** Phase 116 (BR2 §5.10): a steer or queued message changed (null: the conversation's waiting items were cleared). */
  | { type: 'pending'; conversationId: string; item: import('./pending.ts').PendingItem | null; line?: string }
  /** Phase 109 (CH3): a session's title changed (she renamed it, or he did): the row updates in place. */
  | { type: 'title'; conversationId: string; title: string; source: 'placeholder' | 'auto' | 'owner' }
  /** Phase 49: a preview link opened (or closed: null) in a conversation. */
  | { type: 'preview'; conversationId: string; preview: { url: string; port: number; workspace: string; jobId: number } | null }
  /** Phase 70: the album "Our moments" changed (photos added, captions written). */
  | { type: 'moments'; added: number; captioned: number }
  /** Phase 53: a look back was written (or failed). */
  | { type: 'story'; what: 'lookback'; id?: number; error?: string }
  /** Phase 81: findings changed (a security pass ended, a fix branch moved on, a finding was dismissed). */
  | { type: 'findings'; conversationId: string | null; workspace: string | null; summary?: unknown; findingId?: number }
  /** Phase 84: an eval moved on (a run finished, the judge, the result). */
  | { type: 'eval'; id: number; status: string; progress?: unknown }
  /** Phase 87: Sara's hands on a computer: online/offline, a new live-view frame, Stop pressed there. */
  | { type: 'computer'; deviceId: string; state?: 'online' | 'offline'; frame?: number; conversationId?: string; stopped?: boolean; by?: string; ev?: string }
  /** Phase 118 (PERSIST §4.16): a chat goal changed state (the chip, Today, the board). */
  | { type: 'goal'; conversationId: string; goal: import('./goals.ts').GoalView | null }
  /** Phase 118: a goal's check finished (the step line, the progress message). */
  | { type: 'goal_check'; conversationId: string; goalId: number; round: number; ok: boolean; passed?: number; failed?: number; quote?: string }
  /** EC24: Sara asks a helper device (camera, location, screen), or the ask ended. Sent only to opted-in devices. */
  | { type: 'helper'; id: string; kind: import('./phone-helper.ts').HelperKind; state: 'asking' | 'done' | 'expired' | 'cancelled'; reason?: string; precise?: boolean; facing?: 'back' | 'front'; expiresAt?: string }
  /** Phase 118 (§5.13): a loop changed state or its next tick moved. */
  | { type: 'loop'; conversationId: string; loop: import('./loops.ts').LoopView | null }
  /** 3.0.3: what needs the person in a conversation changed (an approval waits or ended, it was opened): the sidebar reloads. */
  | { type: 'needs'; conversationId: string }
) & {
  /** Phase 31: which companion it came from (set by her CompanionHub). */
  companion?: string;
};

export class EventHub {
  readonly #em = new EventEmitter();

  constructor() {
    this.#em.setMaxListeners(100);
  }

  publish(ev: HubEvent): void {
    this.#em.emit('event', ev);
  }

  subscribe(fn: (ev: HubEvent) => void): () => void {
    this.#em.on('event', fn);
    return () => this.#em.off('event', fn);
  }

  /** Every companion's events (the app's live stream); on a plain hub, the same as subscribe. */
  subscribeAll(fn: (ev: HubEvent) => void): () => void {
    return this.subscribe(fn);
  }
}

/** Phase 31: a companion's view of the shared hub; what she publishes carries her id. */
export class CompanionHub extends EventHub {
  readonly #base: EventHub;
  readonly #id: string;
  constructor(base: EventHub, id: string) {
    super();
    this.#base = base;
    this.#id = id;
  }
  override publish(ev: HubEvent): void {
    this.#base.publish({ ...ev, companion: this.#id });
  }
  /** Only her own events (bridges, workers). */
  override subscribe(fn: (ev: HubEvent) => void): () => void {
    return this.#base.subscribe((ev) => {
      if (!ev.companion || ev.companion === this.#id) fn(ev);
    });
  }
  override subscribeAll(fn: (ev: HubEvent) => void): () => void {
    return this.#base.subscribe(fn);
  }
}
