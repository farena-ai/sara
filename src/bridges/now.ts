// Phase 110 (CH4, docs/design/CHATS.md §3.1 B5 and §7.5): "the room right now".
//
// The short note her turn gets in a room she keeps up with: the current topic, who's active, what
// changed since she last spoke and how long ago, whether her old topic has gone stale, what the
// calling message replies to, a little room memory and "People here", then the last lines verbatim.
// Order of truth: the last lines, then the summary's topic and threads, then the code fallback.
// It holds only that room's own lines, summary and room-people notes: never the owner's memory,
// cards or private notes, so the partner side can have it too. ≤ 3,000 characters, fenced by the
// caller (roomNoteSection / roomNowSection), never stored in a conversation.
import type { AppContext } from '../chat.ts';
import { topicWords } from '../titles.ts';
import { agoWords, codeTopic, crisisPending, hhmm, keepDb, keepRoomByKey, latestSummary, lineByPlatformId, lineText, linesAfter, reading, recentLines, refreshSummary, roomMemory, roomName, roomPerson, summaryRunning, SUMMARY_MIN_LINES, PRE_TURN_TIMEOUT_MS, takeCrisis, type KeepRoom, type RoomLine } from './keepup.ts';

export const NOW_CHARS = 3000;
export const LAST_LINES = 12;
export const LAST_CHARS = 1800;
export const STALE_MINUTES = 20;
export const STALE_LINES = 15;
export const ACTIVE_MINUTES = 15;

export interface NowOptions {
  /** Platform id of the line the calling message replies to (Discord message_reference, Telegram reply_to_message). */
  replyTo?: string | null;
  /** Texts already in the turn's history (their lines are dropped from "Last lines"). */
  history?: string[];
  /** The calling line's own platform id (it is the turn's message: not repeated). */
  callerId?: string | null;
}

export interface NowBlock {
  text: string;
  topic: string;
  fromSummary: boolean;
  stale: boolean;
  repliesToHer: boolean;
  active: string[];
  sinceLines: number;
  sinceAgo: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Share of the old topic's words still in the current topic and last lines (1 when nothing to compare). */
export function topicOverlap(old: string, now: string): number {
  const a = topicWords(old);
  if (!a.size) return 1;
  const b = topicWords(now);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

/** Builds the block (no model call; the summary is whatever is stored). */
export function nowBlock(app: AppContext, room: KeepRoom, opts: NowOptions = {}): NowBlock {
  const tz = app.settings.get().timeZone;
  const now = app.now();
  const lines = recentLines(app, room.id, 60).filter((l) => !l.flags.removed);
  const summary = latestSummary(app, room.id);
  const sinceSummary = summary ? lines.filter((l) => l.id > summary.throughLine).length : lines.length;
  const fromSummary = Boolean(summary && sinceSummary < SUMMARY_MIN_LINES);
  const topic = (fromSummary ? summary!.topic : codeTopic(lines)) || 'nothing in particular yet';
  // Who's active: authors in the last 15 minutes (her excluded), newest first.
  const recent = new Map<string, number>();
  for (const l of [...lines].reverse()) {
    if (l.who === 'her') continue;
    const age = now.getTime() - Date.parse(l.at);
    if (!recent.has(l.author) && (age <= ACTIVE_MINUTES * 60_000 || recent.size < 1)) recent.set(l.author, age);
  }
  const active = [...recent.entries()].slice(0, 6);
  const whoTopic = fromSummary && summary!.threads[0]?.who.length ? summary!.threads[0].who : active.map(([n]) => n);
  const parts: string[] = [];
  parts.push(`In ${roomName(room)}, now (${hhmm(now, tz)}): talking about ${topic}${whoTopic.length ? ` (${whoTopic.slice(0, 4).join(', ')})` : ''}${fromSummary ? '' : ' (from the last lines)'}.`);
  if (fromSummary && summary!.threads.length > 1) parts.push(`Earlier: ${summary!.threads.slice(1, 4).map((t) => `${t.topic} (${t.open ? 'open' : 'done'})`).join(', ')}.`);
  // Since she last spoke.
  let stale = false;
  let sinceLines = lines.length;
  let sinceAgo: string | null = null;
  const herId = room.herLastLineId;
  const her = herId ? (keepDb(app).prepare('SELECT at, text FROM room_lines WHERE id = ?').get(herId) as { at: string; text: string } | undefined) : undefined;
  if (herId && her) {
    sinceLines = linesAfter(app, room.id, herId, 5000).filter((l) => !l.flags.removed && l.platformId !== opts.callerId).length;
    const ms = now.getTime() - Date.parse(her.at);
    sinceAgo = agoWords(ms);
    const old = room.herLastTopic?.trim();
    const nowText = `${topic} ${lines.slice(-LAST_LINES).map((l) => l.text).join(' ')}`;
    stale = Boolean(old) && ms > STALE_MINUTES * 60_000 && sinceLines > STALE_LINES && topicOverlap(old!, nowText) < 0.25;
    parts.push(`Since you last spoke (${hhmm(her.at, tz)}, ${sinceAgo} ago): ${sinceLines} lines${old ? `; your topic then (${old}) ${stale ? 'has moved on' : 'is still going'}` : ''}.`);
  } else parts.push(`You haven't spoken here since you started keeping up (${sinceLines} lines so far).`);
  parts.push(`Open for you: ${fromSummary && summary!.forHer ? summary!.forHer : 'none'}.`);
  // What the calling message replies to.
  let repliesToHer = false;
  let replyPart = 'none';
  if (opts.replyTo) {
    const r = lineByPlatformId(app, room.id, opts.replyTo);
    if (r && r.who === 'her') {
      repliesToHer = true;
      replyPart = `your line at ${hhmm(r.at, tz)} ("${r.text.replace(/\s+/g, ' ').slice(0, 120)}"): here the old topic is the right one`;
    } else if (r && !r.flags.removed) replyPart = `a line by ${r.author} at ${hhmm(r.at, tz)}`;
  }
  parts.push(`This message replies to: ${replyPart}.  |  Active now: ${active.length ? active.map(([n, ms]) => `${n} (${agoWords(ms)})`).join(', ') : 'nobody'}.`);
  // Room memory: up to 3 lines (the latest week, and weeks whose topics match the current one).
  const mem = roomMemory(app, room.id);
  if (mem.length) {
    const tw = topicWords(`${topic} ${lines.slice(-LAST_LINES).map((l) => l.text).join(' ')}`);
    const picks = [mem[0], ...mem.slice(1).filter((m) => m.topics.some((t) => [...topicWords(t)].some((w) => tw.has(w))))].slice(0, 3);
    parts.push(`Room memory: ${picks.map((m) => `${m.week}: ${m.summary.slice(0, 220)}${m.topics.length ? ` (topics: ${m.topics.slice(0, 4).join(', ')})` : ''}`).join(' / ')}`);
  }
  // People here: for each person active now, up to 2 notes from this room (and, with "Share between rooms", from others).
  const here: string[] = [];
  for (const [name] of active) {
    const line = [...lines].reverse().find((l) => l.author === name && l.who === 'person');
    if (!line) continue;
    const rp = roomPerson(app, room.id, line.authorId);
    const notes = [...(rp?.notes ?? [])].reverse().slice(0, 2).map((n) => `${n.note} (week ${n.week.slice(-2)})`);
    if (notes.length < 2 && app.people && rp?.personId) {
      for (const link of app.people.rooms(rp.personId)) {
        if (link.roomId === room.id || !link.shareRooms || link.platformUserId !== line.authorId) continue;
        for (const n of [...(roomPerson(app, link.roomId, link.platformUserId)?.notes ?? [])].reverse()) if (notes.length < 2) notes.push(`${n.note} (another room, week ${n.week.slice(-2)})`);
      }
    }
    if (notes.length) here.push(`${name}: ${notes.join('; ')}`);
  }
  if (here.length) parts.push(`People here: ${here.join(' · ')}`);
  // Last lines: newest 12, ≤ 1,800 characters, without lines already in the turn's history.
  const seen = new Set((opts.history ?? []).map(norm));
  const inHistory = (l: RoomLine) => {
    const t = norm(l.text);
    if (t.length < 4) return false;
    for (const h of seen) if (h.endsWith(t) || h.includes(`]: ${t}`)) return true;
    return false;
  };
  const last: string[] = [];
  let size = 0;
  for (const l of [...lines].reverse()) {
    if (last.length >= LAST_LINES) break;
    if (l.platformId && l.platformId === opts.callerId) continue;
    if (inHistory(l)) continue;
    const t = lineText(l, tz);
    if (size + t.length > LAST_CHARS && last.length) break;
    last.unshift(t);
    size += t.length;
  }
  const head = parts.join('\n');
  const body = last.length ? `\nLast lines:\n${last.join('\n')}` : '';
  let text = `${head}${body}`;
  if (text.length > NOW_CHARS) text = `${head.slice(0, NOW_CHARS - Math.min(body.length, LAST_CHARS + 20))}${body}`.slice(0, NOW_CHARS);
  return { text, topic, fromSummary, stale, repliesToHer, active: active.map(([n]) => n), sinceLines, sinceAgo };
}

/**
 * What a bridge passes to the turn in a room that keeps up: the block, the room id (room facts
 * may be used here) and the crisis flag (taken once). Before the turn, a summary runs when ≥ 10
 * lines arrived since the last one, capped at 4 seconds; on timeout the code fallback is used and
 * the summary keeps running after the turn.
 */
export async function roomTurn(app: AppContext, bridge: string, key: string, opts: NowOptions & { conversationId?: string } = {}): Promise<{ roomNow?: string; roomId?: number; roomCrisis?: boolean; block?: NowBlock }> {
  const found = keepRoomByKey(app, bridge, key);
  if (!found || !reading(found)) return found && found.kind === 'room' && crisisPending(app, found.id) ? { roomId: found.id, roomCrisis: takeCrisis(app, found.id) } : {};
  const room = found;
  const s = latestSummary(app, room.id);
  if (room.model !== 'off' && linesAfter(app, room.id, s?.throughLine ?? 0, SUMMARY_MIN_LINES + 1).length >= SUMMARY_MIN_LINES) {
    const running = summaryRunning(app, room.id) ?? refreshSummary(app, room.id, { timeoutMs: 120_000 }).catch(() => undefined);
    await Promise.race([running, new Promise((r) => setTimeout(r, PRE_TURN_TIMEOUT_MS).unref())]);
  }
  const history = opts.conversationId ? app.store.messages(opts.conversationId).slice(-30).map((m) => m.content) : [];
  const block = nowBlock(app, keepRoomByKey(app, bridge, key)!, { ...opts, history });
  return { roomNow: block.text, roomId: room.id, roomCrisis: takeCrisis(app, room.id), block };
}
