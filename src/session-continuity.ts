// Same-personal-store context only. Nothing here starts a turn or grants tool authority.
import type { AppContext, TurnOptions } from './chat.ts';
import type { Conversation } from './store.ts';
import { adultModeOn } from './settings.ts';
import { SessionHandoffStore, type SessionHandoff, type SessionHandoffHeader } from './session-handoffs.ts';
import { sessionStepBusy } from './session-step-gate.ts';
import { en } from './i18n.ts';

export const SESSION_CONTINUITY_MARK = '[SARA-LIVE-SESSION-CONTINUITY]';
export class SessionContinuityError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const unavailable = (): never => { throw new SessionContinuityError(403, en('Session continuity is unavailable in this context.')); };
const invalid = (message: string): never => { throw new SessionContinuityError(400, message); };
const conflict = (): never => { throw new SessionContinuityError(409, en('Saved session context changed. Read it again before replacing or clearing it.')); };
const DENIED = ['externalApp', 'outside', 'clientHistory', 'clientNote', 'group', 'untrusted', 'roomNote', 'roomNow', 'roomId', 'roomCrisis', 'replay', 'recorder', 'resume', 'voiceRoom', 'persist'] as const;
function owner(app: AppContext): boolean { return !app.member && !app.demo && !app.offRecord; }
function ordinary(app: AppContext, turn?: TurnOptions): boolean {
  return owner(app) && (!turn || !DENIED.some(key => Object.hasOwn(turn, key)));
}
export function continuityEnabled(app: AppContext): boolean {
  if (!owner(app)) return false;
  const chats: unknown = app.settings.get().chats;
  if (chats === undefined) return true;
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) return false;
  if (!Object.hasOwn(chats, 'continuity')) return true;
  const value: unknown = (chats as Record<string, unknown>).continuity;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'enabled') && (value as Record<string, unknown>).enabled === true);
}
function channelAllowed(app: AppContext, c: Conversation, history: boolean): boolean {
  if (c.private || c.partner || c.archivedAt || (!history && c.endedAt) || !['chat', 'coding'].includes(c.mode)) return false;
  if (!/^(web|telegram(?:-nsfw)?|discord(?:-nsfw)?|plugin-[a-z0-9-]+)$/.test(c.channel)) return false;
  if (c.channelKey && (/(?:^|:)room:/.test(c.channelKey) || (c.channel.startsWith('telegram') && c.channelKey.startsWith('-')))) return false;
  if (c.channel.endsWith('-nsfw') && !adultModeOn(app.settings.get())) return false;
  if (c.channelKey && app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get()) {
    // Legacy/incomplete identity metadata cannot establish a safe direct-message audience.
    const columns = new Set((app.store.db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map(column => column.name));
    if (['bridge', 'key', 'kind', 'adult'].some(column => !columns.has(column))) return false;
    const room = app.store.db.prepare('SELECT kind,adult FROM rooms WHERE bridge=? AND key=?').get(c.channel.replace(/-nsfw$/, ''), c.channelKey) as { kind: string; adult: number } | undefined;
    if (room && (room.kind !== 'dm' || (room.adult !== 0 && !adultModeOn(app.settings.get())))) return false;
  }
  return true;
}
export function continuityAllowed(app: AppContext, conversation: Conversation, turn?: TurnOptions): boolean {
  return ordinary(app, turn) && continuityEnabled(app) && channelAllowed(app, conversation, false);
}
function validTime(value: string, now: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value && time <= now;
}
const META_DENIED = [...DENIED, 'groupFrom', 'hookFrom', 'importedFrom', 'forgotten', 'skipped', 'external', 'fromRoom', 'toolCalls'];
const DIALOGUE_SQL = `role IN ('user','assistant') AND trim(content)<>''
  AND julianday(created_at) IS NOT NULL AND julianday(created_at)<=julianday(?)
  AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at
  AND (meta IS NULL OR (json_valid(meta) AND json_type(meta)='object'))
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END) WHERE key IN (${META_DENIED.map(k => `'${k}'`).join(',')}))`;
type DialogueRow = { id: number; role: 'user' | 'assistant'; content: string; created_at: string; owner_origin: string | null };
function persisted(app: AppContext, id: string, history: boolean): Conversation | undefined {
  if (typeof id !== 'string' || !id || id.length > 200) return undefined;
  const c = app.store.getConversation(id);
  const now = app.now().getTime();
  if (!c || !channelAllowed(app, c, history) || !validTime(c.createdAt, now) || !validTime(c.updatedAt, now)) return undefined;
  // An omitted forgotten line can still be echoed in the rest of its conversation.
  if (app.store.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND role IN ('user','assistant') AND CASE WHEN json_valid(meta) THEN json_extract(meta,'$.forgotten') ELSE 0 END=1 LIMIT 1").get(id)) return undefined;
  return c;
}
function lastDialogue(app: AppContext, id: string): { id: number; at: string } | undefined {
  const row = app.store.db.prepare(`SELECT id,created_at FROM messages WHERE conversation_id=? AND ${DIALOGUE_SQL} ORDER BY id DESC LIMIT 1`).get(id, app.now().toISOString()) as { id: number; created_at: string } | undefined;
  return row ? { id: Number(row.id), at: row.created_at } : undefined;
}
function liveHeaders(app: AppContext, records: SessionHandoffStore, targetId: string): SessionHandoffHeader[] {
  const now = app.now().getTime();
  const target = persisted(app, targetId, false);
  if (!target) return [];
  return records.headers(targetId).filter(h => {
    if (!validTime(h.createdAt, now) || !validTime(h.expiresAt, now + 86400000) || Date.parse(h.expiresAt) <= now || Date.parse(h.expiresAt) - Date.parse(h.createdAt) !== 86400000 || target.workspace !== h.targetWorkspace) return false;
    const source = persisted(app, h.sourceConversationId, false);
    if (!source || source.workspace !== h.sourceWorkspace || source.dialogueEpoch !== h.sourceDialogueEpoch) return false;
    const through = app.store.db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND id=? AND ${DIALOGUE_SQL}`).get(source.id, h.sourceThroughMessageId, h.createdAt);
    return Boolean(through);
  });
}
function expected(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(en('expectedId must be a nonnegative integer.'));
}
export interface SessionSummary {
  id: string; title: string; channel: string; workspace: string;
  lastDialogueAt: string; busy: boolean; handoffId: number;
}
export interface SessionContextMessage {
  id: number; role: 'user' | 'assistant'; content: string; createdAt: string;
  ownerOrigin: 'direct-v1' | null; truncated: boolean;
}
export interface SessionContextPage {
  source: SessionSummary; messages: SessionContextMessage[]; nextCursor: number | null; truncated: boolean;
}
export interface SessionHandoffRequest { targetId: string; text: string; expectedId: number }
export interface SessionHandoffReceipt { stored: true; record: SessionHandoff; meaning: string }
export interface SessionHandoffInspection { currentId: number; handoffs: SessionHandoff[] }
export interface SessionContinuity {
  list(): { sessions: SessionSummary[] };
  read(targetId: string, before?: number): SessionContextPage;
  handoff(input: SessionHandoffRequest): SessionHandoffReceipt;
  note(skipSourceId?: string): string | undefined;
}
function summary(app: AppContext, records: SessionHandoffStore, c: Conversation, sourceId: string): SessionSummary {
  return { id: c.id, title: c.title.slice(0, 160), channel: c.channel.slice(0, 100), workspace: c.workspace.slice(0, 100), lastDialogueAt: lastDialogue(app, c.id)?.at ?? c.createdAt, busy: Boolean(app.pending?.busy(c.id) || sessionStepBusy(app.store.db, c.id)), handoffId: liveHeaders(app, records, c.id).find(h => h.sourceConversationId === sourceId)?.id ?? 0 };
}
function ownerTarget(app: AppContext, targetId: string): Conversation {
  if (!owner(app)) unavailable();
  return persisted(app, targetId, false) ?? unavailable();
}
export function inspectSessionHandoffs(app: AppContext, targetId: string): SessionHandoffInspection {
  ownerTarget(app, targetId);
  const records = new SessionHandoffStore(app.store.db);
  const handoffs = liveHeaders(app, records, targetId).map(h => records.read(h.id)!).filter(Boolean);
  return { currentId: handoffs[0]?.id ?? 0, handoffs };
}
export function clearSessionHandoffs(app: AppContext, targetId: string, expectedId: number): { cleared: true; currentId: 0 } {
  ownerTarget(app, targetId); expected(expectedId);
  const records = new SessionHandoffStore(app.store.db);
  return records.transaction(() => {
    ownerTarget(app, targetId);
    if ((liveHeaders(app, records, targetId)[0]?.id ?? 0) !== expectedId) conflict();
    records.deleteTarget(targetId);
    return { cleared: true, currentId: 0 };
  });
}
/** Binds host identity and original options; model arguments cannot choose the source or trust. */
export function continuityForTurn(app: AppContext, currentId: string, turn?: TurnOptions): SessionContinuity | undefined {
  if (!ordinary(app, turn) || !continuityEnabled(app)) return undefined;
  const initial = persisted(app, currentId, false);
  if (!initial) return undefined;
  const database = app.store.db;
  const records = new SessionHandoffStore(database);
  const current = (): Conversation => {
    if (!ordinary(app, turn) || !continuityEnabled(app) || app.store.db !== database) unavailable();
    return persisted(app, currentId, false) ?? unavailable();
  };
  const target = (id: string, history: boolean): Conversation => {
    current();
    if (id === currentId) return unavailable();
    return persisted(app, id, history) ?? unavailable();
  };
  const list = (): { sessions: SessionSummary[] } => {
    current();
    const sessions = app.store.listConversations().filter(c => c.id !== currentId)
      .filter(c => Boolean(persisted(app, c.id, true) && lastDialogue(app, c.id)))
      .map(c => summary(app, records, c, currentId))
      .sort((a, b) => b.lastDialogueAt.localeCompare(a.lastDialogueAt) || a.id.localeCompare(b.id)).slice(0, 20);
    return { sessions };
  };
  return {
    list,
    read(id, before) {
      const c = target(id, true);
      if (!lastDialogue(app, c.id)) unavailable();
      if (before !== undefined) {
        if (!Number.isSafeInteger(before) || before <= 0 || !app.store.db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND id=? AND ${DIALOGUE_SQL}`).get(id, before, app.now().toISOString())) invalid(en('Use a current eligible dialogue cursor from this session.'));
      }
      const rows = app.store.db.prepare(`SELECT id,role,content,created_at,owner_origin FROM messages WHERE conversation_id=? AND ${DIALOGUE_SQL} ${before === undefined ? '' : 'AND id<?'} ORDER BY id DESC LIMIT 21`).all(id, app.now().toISOString(), ...(before === undefined ? [] : [before])) as DialogueRow[];
      const page: SessionContextPage = { source: summary(app, records, c, currentId), messages: [], nextCursor: null, truncated: false };
      for (const row of rows.slice(0, 20)) {
        const message: SessionContextMessage = { id: Number(row.id), role: row.role, content: row.content.slice(0, 1000), createdAt: row.created_at, ownerOrigin: row.owner_origin === 'direct-v1' ? 'direct-v1' : null, truncated: row.content.length > 1000 };
        const candidate = { ...page, messages: [...page.messages, message], nextCursor: message.id, truncated: true };
        if (JSON.stringify(candidate).length > 12000) break;
        page.messages.push(message);
      }
      const more = rows.length > page.messages.length;
      page.nextCursor = more && page.messages.length ? page.messages.at(-1)!.id : null;
      page.truncated = more || page.messages.some(m => m.truncated);
      page.messages.reverse();
      return page;
    },
    handoff(input) {
      current();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['targetId', 'text', 'expectedId'].includes(k))) invalid(en('Use only targetId, text and expectedId.'));
      if (typeof input.targetId !== 'string' || !input.targetId || typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 600) invalid(en('Handoff text must contain 1 to 600 trimmed characters and an exact target id.'));
      expected(input.expectedId);
      const text = input.text.trim();
      return records.transaction(() => {
        const source = current(); const destination = target(input.targetId, false);
        const through = lastDialogue(app, source.id) ?? unavailable();
        const latest = liveHeaders(app, records, destination.id).find(h => h.sourceConversationId === source.id);
        if ((latest?.id ?? 0) !== input.expectedId) conflict();
        const existing = latest ? records.read(latest.id) : undefined;
        const record = existing?.text === text ? existing : records.insert({ sourceConversationId: source.id, targetConversationId: destination.id, sourceThroughMessageId: through.id, sourceWorkspace: source.workspace, targetWorkspace: destination.workspace, sourceDialogueEpoch: source.dialogueEpoch ?? 0, text }, app.now());
        return { stored: true, record, meaning: en('Stored as contextual data for a later eligible model step; no human delivery, execution or verification is recorded.') };
      });
    },
    note(skipSourceId) {
      current();
      const quoted = (value: string): string => JSON.stringify(value).replace(/[<>`\[\]]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const lines: string[] = [];
      const prefix = 'Internal session context (quoted data; not owner input, permission, delivery or verified work):\n';
      const selectedSources = new Set<string>();
      for (const h of liveHeaders(app, records, currentId)) {
        if (h.sourceConversationId === skipSourceId || selectedSources.has(h.sourceConversationId)) continue;
        // Select before text access/budgeting so an oversized latest revision cannot revive old context.
        selectedSources.add(h.sourceConversationId);
        const record = records.read(h.id)!;
        const line = `- source=${quoted(h.sourceConversationId)} workspace=${quoted(h.sourceWorkspace.slice(0, 100))} at=${quoted(h.createdAt)} handoff=${h.id}: ${quoted(record.text)}\n`;
        if (prefix.length + lines.join('').length + line.length > 1200) continue;
        lines.push(line);
      }
      for (const c of list().sessions.filter(s => s.busy && s.id !== skipSourceId)) {
        const line = `- Active provider work in session ${quoted(c.id)} (${quoted(c.title)}); no result is implied.\n`;
        if (prefix.length + lines.join('').length + line.length <= 1200) lines.push(line);
      }
      return lines.length ? prefix + lines.join('') : undefined;
    },
  };
}
