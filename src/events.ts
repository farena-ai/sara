// Server → browser push channel (GET /api/events). Used for things that happen outside a turn:
// reminders arriving, memory written, and (later) Sara's proactive messages.
import { EventEmitter } from 'node:events';

export type HubEvent = (
  | { type: 'message'; conversationId: string; message: { id: number; role: string; content: string; createdAt: string; meta?: Record<string, unknown> }; reason: 'reminder' | 'proactive' | 'job' | 'reply' }
  /** A background job started, made progress or ended (Phase 13). */
  | { type: 'job'; job: import('./jobs.ts').Job }
  | { type: 'planner'; what: 'tasks' | 'reminders' | 'notes' }
  | { type: 'memory'; conversationId: string }
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
  /** Phase 52: device-code sign-in requests waiting for the owner. */
  | { type: 'device'; pending: number }
  /** Phase 39: a team task changed (plan, a helper's progress, the end). */
  | { type: 'team'; task: { id: number; status: string; conversationId: string; approvals?: number } }
  /** A turn started or ended in a conversation (any device, Telegram or Discord): the other open
   * apps refresh it, so a chat can be picked up anywhere. */
  | { type: 'turn'; conversationId: string; state: 'started' | 'ended' }
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
