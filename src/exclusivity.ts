// Owner decision 2026-11-28: a companion with Adult mode on can be romantically and sexually
// exclusive. In a partner chat (Discord, Telegram) adult content is allowed only where it is today
// (an age-restricted channel) AND the person writing is allowed by her setting; in an in-app group
// only when every other companion in the room is on her list. Decided by the server before the model
// runs (src/chat.ts scopeAdult), plain code, no model call. The minors block, the AI disclosure and
// crisis help are not touched here and are never relaxed by it.
//
// Declined explicit attempts are counted in her own database (exclusivity_attempts); 3 or more from
// the same person within 24 hours make one short note to the owner in her home chat, once per person
// per day. No message text is kept or copied.
import type { AppContext, TurnOptions } from './chat.ts';
import { ownChat } from './home-chat.ts';
import { en, trOwner } from './i18n.ts';
import { detectExplicit } from './safety.ts';
import type { Settings } from './settings.ts';
import { adultModeOn } from './settings.ts';
import type { Conversation } from './store.ts';

export type ExclusivityMode = 'owner' | 'allowed' | 'anyone';
export interface Exclusivity {
  mode: ExclusivityMode;
  /** Companion ids on this server she may be adult with in an in-app group. */
  companions: string[];
  /** Discord user or bot ids. */
  discord: string[];
  /** Telegram user ids (as strings). */
  telegram: string[];
}
export const DEFAULT_EXCLUSIVITY: Exclusivity = { mode: 'owner', companions: [], discord: [], telegram: [] };
export const EXCLUSIVITY_MODES: readonly ExclusivityMode[] = ['owner', 'allowed', 'anyone'];
const MAX_IDS = 50;

/** Who wrote the message in a partner chat (set by the bridges). */
export interface PartnerAuthor {
  platform: 'discord' | 'telegram';
  id: string;
  name?: string;
  /** One of the owner's own ids, in a chat that is not his work room (the owner is always allowed). */
  owner?: boolean;
}

const idList = (v: unknown, ok: (s: string) => boolean): string[] => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(ok))].slice(0, MAX_IDS) : []);
export const validDiscordId = (s: string) => /^\d{5,25}$/.test(s);
export const validTelegramId = (s: string) => /^-?\d{3,20}$/.test(s);
export const validCompanionId = (s: string) => /^[\w-]{1,64}$/.test(s);

/** Her setting, checked (missing or broken parts are the default: only the owner). */
export function exclusivityOf(s: Pick<Settings, 'exclusivity'>): Exclusivity {
  const x = (s.exclusivity ?? {}) as Partial<Exclusivity>;
  return {
    mode: EXCLUSIVITY_MODES.includes(x.mode as ExclusivityMode) ? (x.mode as ExclusivityMode) : 'owner',
    companions: idList(x.companions, validCompanionId),
    discord: idList(x.discord, validDiscordId),
    telegram: idList(x.telegram, validTelegramId),
  };
}

/** True when this person may have adult content with her (mode and her allow list only). */
export function partnerAllowed(ex: Exclusivity, who: PartnerAuthor | undefined): boolean {
  if (ex.mode === 'anyone' || who?.owner) return true;
  if (ex.mode !== 'allowed' || !who?.id) return false;
  return (who.platform === 'discord' ? ex.discord : ex.telegram).includes(String(who.id));
}

/** True when every other companion in the room is allowed (the owner always is). */
export function groupAllowed(ex: Exclusivity, otherIds: readonly string[]): boolean {
  if (ex.mode === 'anyone' || !otherIds.length) return true;
  if (ex.mode !== 'allowed') return false;
  return otherIds.every((id) => ex.companions.includes(id));
}

export interface DecisionInput {
  /** Adult mode is on for her. */
  adultMode: boolean;
  /** The place allows adult content today (an age-restricted channel; a group room with adult on). */
  placeAdult: boolean;
  kind: 'owner' | 'partner' | 'group';
  author?: PartnerAuthor;
  otherIds?: readonly string[];
  ex: Exclusivity;
}

/**
 * The decision: adult content only with Adult mode on, where the place allows it today, and (in a
 * partner chat or a group) when her exclusivity setting allows this person or these companions.
 * `declined`: adult content would be allowed here today, and only her exclusivity says no.
 */
export function exclusivityDecision(i: DecisionInput): { adult: boolean; declined: boolean } {
  const today = i.adultMode && i.placeAdult;
  if (!today) return { adult: false, declined: false };
  const ok = i.kind === 'owner' ? true : i.kind === 'partner' ? partnerAllowed(i.ex, i.author) : groupAllowed(i.ex, i.otherIds ?? []);
  return { adult: ok, declined: !ok };
}

/**
 * For scopeAdult: `base` is today's adult rule for this turn. Returns whether the turn stays adult
 * and whether her exclusivity is why it does not. Her owner's own chats are never touched.
 */
export function exclusivityGate(app: Pick<AppContext, 'settings'>, conv: Pick<Conversation, 'partner' | 'channel'>, opts: Pick<TurnOptions, 'group' | 'partnerAuthor'>, base: boolean): { allow: boolean; declined: boolean } {
  if (!base) return { allow: true, declined: false };
  const ex = exclusivityOf(app.settings.get());
  if (conv.partner) {
    // Not an age-restricted channel: strict today already, nothing changes.
    if (!conv.channel.endsWith('-nsfw')) return { allow: true, declined: false };
    const d = exclusivityDecision({ adultMode: true, placeAdult: true, kind: 'partner', ...(opts.partnerAuthor ? { author: opts.partnerAuthor } : {}), ex });
    return { allow: d.adult, declined: d.declined };
  }
  if (opts.group) {
    const d = exclusivityDecision({ adultMode: true, placeAdult: true, kind: 'group', otherIds: opts.group.otherIds ?? [], ex });
    return { allow: d.adult, declined: d.declined };
  }
  return { allow: true, declined: false };
}

/** Her note when her exclusivity keeps a turn non-sexual (after the partner or group note). */
export function committedNote(owner: string, where: 'partner' | 'group'): string {
  const who = where === 'partner' ? 'the people here' : 'the other companions in this room';
  const rest = where === 'partner' ? 'Keep it friendly and strictly non-romantic and non-sexual with them, even though this place allows adult content.' : 'Keep everything non-explicit here: no sexual content or explicit descriptions with or about them.';
  return `You are romantically and sexually committed to ${owner}, and ${who} are not part of that. ${rest} If someone flirts sexually or asks for sexual content, decline warmly in your own voice (you can say you're with ${owner}), never with a dry refusal or a lecture, and stay friendly.`;
}

// ------------------------------------------------------------------ the count (her own database)

const ready = new WeakSet<object>();
type Db = AppContext['store']['db'];
function db(app: Pick<AppContext, 'store'>): Db {
  const d = app.store.db;
  if (ready.has(d)) return d;
  d.exec(`CREATE TABLE IF NOT EXISTS exclusivity_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT,
  conversation_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exclusivity_attempts_person ON exclusivity_attempts(platform, person_id, at);
CREATE TABLE IF NOT EXISTS exclusivity_notes (
  platform TEXT NOT NULL,
  person_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (platform, person_id, day)
);`);
  ready.add(d);
  return d;
}

const DAY_MS = 24 * 3_600_000;
const KEEP_DAYS = 30;
export const NOTE_AFTER = 3;

function localDay(now: Date, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

type CountApp = Pick<AppContext, 'store' | 'settings' | 'persona' | 'now'> & { demo?: boolean };

/**
 * Counts one declined explicit attempt (a partner chat, Adult mode on, a person her setting does not
 * allow, explicit words in the message) and posts the owner's note when it is the third in 24 hours.
 * Returns whether it was counted. Only ids, a display name and the time are kept.
 */
export function countDeclinedAttempt(app: CountApp, conv: Pick<Conversation, 'id' | 'partner' | 'title' | 'channel'>, author: PartnerAuthor | undefined, text: string): boolean {
  if (!conv.partner || !author?.id) return false;
  const s = app.settings.get();
  if (!adultModeOn(s) || partnerAllowed(exclusivityOf(s), author) || !detectExplicit(text)) return false;
  try {
    recordAttempt(app, conv, author, s);
  } catch (err) {
    console.warn(`exclusivity count: ${(err as Error).message}`);
  }
  return true;
}

function recordAttempt(app: CountApp, conv: Pick<Conversation, 'id' | 'title' | 'channel'>, author: PartnerAuthor, s: Settings): void {
  const d = db(app);
  const now = app.now();
  const name = (author.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  d.prepare('DELETE FROM exclusivity_attempts WHERE at < ?').run(new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString());
  d.prepare('INSERT INTO exclusivity_attempts (platform, person_id, name, conversation_id, at) VALUES (?, ?, ?, ?, ?)').run(author.platform, String(author.id), name || null, conv.id, now.toISOString());
  const n = (d.prepare('SELECT COUNT(*) AS n FROM exclusivity_attempts WHERE platform = ? AND person_id = ? AND at >= ?').get(author.platform, String(author.id), new Date(now.getTime() - DAY_MS).toISOString()) as { n: number }).n;
  if (n >= NOTE_AFTER) {
    const day = localDay(now, s.timeZone);
    const fresh = d.prepare('INSERT OR IGNORE INTO exclusivity_notes (platform, person_id, day) VALUES (?, ?, ?)').run(author.platform, String(author.id), day).changes > 0;
    if (fresh) postNote(app, conv, author, name, n);
  }
}

function postNote(app: CountApp, conv: Pick<Conversation, 'title' | 'channel'>, author: PartnerAuthor, name: string, n: number): void {
  const home = ownChat(app);
  if (!home) return;
  const s = app.settings.get();
  const platform = author.platform === 'discord' ? 'Discord' : 'Telegram';
  const who = name ? `${name} (${platform} ${author.id})` : `${platform} ${author.id}`;
  const content = trOwner(en('{who} tried to make things sexual with me {n} times in the last day, in {place}. I kept it friendly and told them I’m with you.'), s, { who, n, place: conv.title || platform });
  app.store.addMessage(home.id, 'assistant', content, { exclusivity: { platform: author.platform, id: String(author.id) } });
}

/** How many explicit attempts she declined in the last `days` days (for Settings). */
export function declinedCount(app: Pick<AppContext, 'store' | 'now'>, days = 7): number {
  const since = new Date(app.now().getTime() - days * DAY_MS).toISOString();
  return (db(app).prepare('SELECT COUNT(*) AS n FROM exclusivity_attempts WHERE at >= ?').get(since) as { n: number }).n;
}
