import type { AppContext, TurnOptions } from './chat.ts';
import type { Conversation, StoredMessage } from './store.ts';
import type { Memory } from './memory.ts';
import { attributableClauses, eventAnchorsIn, outcomesIn } from './attunement.ts';
import { dayStartUtc } from './planner.ts';

export type OwnerEvidenceTurn = Pick<TurnOptions,
  'externalApp' | 'outside' | 'clientHistory' | 'clientNote' | 'group' | 'untrusted' |
  'roomNote' | 'roomNow' | 'roomId' | 'roomCrisis' | 'replay' | 'recorder' | 'resume' |
  'voiceRoom' | 'persist'>;
const DENIED = ['externalApp', 'outside', 'clientHistory', 'clientNote', 'group', 'untrusted',
  'roomNote', 'roomNow', 'roomId', 'roomCrisis', 'replay', 'recorder', 'voiceRoom', 'persist'] as const;

function trustedConversation(app: AppContext, id: string, turn: OwnerEvidenceTurn | undefined, legacy: boolean): Conversation | undefined {
  if (app.member || app.demo || app.offRecord || (turn && DENIED.some((key) => Object.hasOwn(turn, key))) || (!legacy && turn && Object.hasOwn(turn, 'resume'))) return undefined;
  const c = app.store.getConversation(id);
  if (!c || (!legacy && c.private) || c.partner || c.archivedAt || !['chat', 'coding'].includes(c.mode)) return undefined;
  if (!/^(?:web|telegram(?:-nsfw)?|discord(?:-nsfw)?|plugin-[a-z0-9-]+)$/.test(c.channel)) return undefined;
  if (c.channelKey?.startsWith('room:') || (c.channel.startsWith('telegram') && c.channelKey?.startsWith('-'))) return undefined;
  if (app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get()) {
    const bridge = c.channel.startsWith('telegram') ? 'telegram' : c.channel.startsWith('discord') ? 'discord' : c.channel;
    if (app.store.db.prepare("SELECT 1 FROM rooms WHERE bridge=? AND key=? AND kind<>'dm'").get(bridge, c.channelKey)) return undefined;
  }
  return c;
}

export function ownerEvidenceConversation(app: AppContext, id: string, turn?: OwnerEvidenceTurn): Conversation | undefined {
  return trustedConversation(app, id, turn, false);
}

/** Same trusted identity gate, allowing private ordinary chat and read-only resume compatibility. */
export function legacyInnerConversation(app: AppContext, id: string, turn?: OwnerEvidenceTurn): Conversation | undefined {
  return trustedConversation(app, id, turn, true);
}

export function ownerEvidenceSince(app: AppContext, destinationId: string, since: string, turn?: OwnerEvidenceTurn): StoredMessage[] {
  const c = ownerEvidenceConversation(app, destinationId, turn);
  if (!c) return [];
  return app.store.followUpEvidenceSince(since, { workspace: c.workspace, until: app.now().toISOString() });
}

export function ownerEvidenceMessage(app: AppContext, destinationId: string, messageId: number, turn?: OwnerEvidenceTurn): StoredMessage | undefined {
  const c = ownerEvidenceConversation(app, destinationId, turn);
  if (!c) return undefined;
  return app.store.followUpEvidenceSince('0001-01-01T00:00:00Z', { workspace: c.workspace, until: app.now().toISOString(), messageId }).find((m) => m.id === messageId);
}

/** Text-only reconciliation; callers must separately authenticate the source row. */
export function attributedQuoteMatches(content: string, quote: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const evidence = normalize(quote);
  if (!evidence) return false;
  return attributableClauses(content).some((clause) => {
    // Clause parsing omits sentence terminators. Extend only through the original
    // adjacent terminator without crossing an opaque or attribution boundary.
    const end = clause.offset + clause.text.length;
    const terminal = /^[ \t]*[.!;]/.exec(content.slice(end))?.[0] ?? '';
    return normalize(content.slice(clause.offset, end + terminal.length)).includes(evidence);
  });
}

/** Reconcile against current database rows; callers cannot authenticate stale memory snapshots. */
export function ownerEventMemory(app: AppContext, destinationId: string, memory: Memory, turn?: OwnerEvidenceTurn): boolean {
  if (!ownerEvidenceConversation(app, destinationId, turn)) return false;
  const m = app.memory?.get(memory.id);
  if (!m || m.archived || m.resolvedAt || m.supersededBy || !Object.entries(m).every(([key, value]) => memory[key as keyof Memory] === value)) return false;
  if (m.origin === 'owner') return m.conversationId === null && m.sourceMessageId === null && m.sourceFromId === null && m.sourceDocId === null;
  if (m.origin !== 'derived' || m.sourceDocId !== null || !m.conversationId || !m.sourceMessageId || (m.sourceFromId !== null && m.sourceFromId !== m.sourceMessageId) || !m.evidence?.trim()) return false;
  const source = ownerEvidenceMessage(app, destinationId, m.sourceMessageId, turn);
  if (!source || source.conversationId !== m.conversationId) return false;
  if (!attributedQuoteMatches(source.content, m.evidence)) return false;
  const anchors = eventAnchorsIn(m.content);
  const evidenceAnchors = eventAnchorsIn(m.evidence);
  const currentAnchors = eventAnchorsIn(source.content);
  return anchors.some((anchor) => evidenceAnchors.includes(anchor) && currentAnchors.includes(anchor));
}

/** Match all eligible competing dates before applying each event's chronology. */
export function pendingOwnerEvents<T extends { memory: Memory; date: string }>(app: AppContext, conversationId: string, candidates: readonly T[], turn?: OwnerEvidenceTurn): T[] {
  if (!ownerEvidenceConversation(app, conversationId, turn) || app.settings.get().memory?.enabled === false) return [];
  const eligible = candidates.filter((p) => ownerEventMemory(app, conversationId, p.memory, turn));
  if (!eligible.length) return [];
  const events = eligible.map((p) => ({ id: String(p.memory.id), text: p.memory.content }));
  const creation = (m: Memory): string => m.sourceMessageId ? app.store.messageById(m.sourceMessageId)?.createdAt ?? m.createdAt : m.createdAt;
  const since = eligible.map((p) => creation(p.memory)).sort()[0];
  const answered = new Set<string>();
  const evidence = new Map(ownerEvidenceSince(app, conversationId, since, turn).map((message) => [message.id, message]));
  // Current event sources remain authoritative beyond the bounded recent-answer window.
  for (const p of eligible) {
    if (!p.memory.sourceMessageId) continue;
    const source = ownerEvidenceMessage(app, conversationId, p.memory.sourceMessageId, turn);
    if (source) evidence.set(source.id, source);
  }
  for (const message of evidence.values()) {
    for (const outcome of outcomesIn(message.content, events, { ownerName: app.settings.get().ownerName ?? '' })) {
      const p = eligible.find((p) => String(p.memory.id) === outcome.eventId)!;
      if (outcome.kind === 'reported') {
        if (Date.parse(message.createdAt) >= dayStartUtc(p.date, app.settings.get().timeZone).getTime()) answered.add(outcome.eventId);
      } else if (Date.parse(message.createdAt) >= Date.parse(creation(p.memory)) && (!p.memory.sourceMessageId || message.id >= p.memory.sourceMessageId)) {
        answered.add(outcome.eventId);
      }
    }
  }
  return eligible.filter((p) => !answered.has(String(p.memory.id)));
}
