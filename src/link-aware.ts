// LINKAWARE (docs/MESSAGES.md, Isolation): "who is linked and who wrote (never what)". Sara still
// cannot read or send Messages; she sees, in the owner's own chats only, a compact line per direct
// link: the friend's name, how long they have been linked, how many unread messages are from them,
// when their last message arrived, and which of their requests wait for the owner (help pass, fix
// request, find a time, shared project) by kind. Built from Messenger.awareness() (names, counts and
// times; it never selects a message body or a file) and the request engines' own status rows (no
// note, problem, title or community post). Off with Messages settings → "Let Sara know who wrote".
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { foldName as fold, matchFriend } from './friend-match.ts';
import { friendTimeOf } from './friend-time.ts';
import { remoteRepairOf } from './remote-repair.ts';
import { sharedProjectsOf } from './shared-projects.ts';
import { supportOf } from './support.ts';
import { ageShort } from './time-sense.ts';

export type LinkPending = 'help' | 'fix' | 'time' | 'project';
export const PENDING_WORDS: Record<LinkPending, string> = { help: 'a help-pass suggestion', fix: 'a fix request', time: 'a find-a-time request', project: 'a shared-project invite' };

export interface LinkedFriend {
  /** Their Messages name (the person). */
  name: string;
  /** Their companion's name when they sent it ("Jarvis"). */
  companion: string | null;
  /** The name before a rename, for 30 days. */
  formerly: string | null;
  /** Every other name they answer to (for matchFriend). */
  aliases: string[];
  since: string;
  unread: number;
  lastInAt: string | null;
  pending: { kind: LinkPending; n: number }[];
  chat: string | null;
}

type Owner = Pick<AppContext, 'messages' | 'dataDir' | 'now' | 'member' | 'demo' | 'offRecord'>;

/** On for the owner (who has Messages) unless switched off in Messages settings. */
export function linkAwareOn(app: Owner): boolean {
  if (!app.messages || app.member || app.demo || app.offRecord) return false;
  try {
    return app.messages.settings().aware !== false;
  } catch {
    return false;
  }
}

export { matchFriend };

/** What waits for the owner from each link (counts by kind; every engine only if it was ever used). */
function pendingByLink(app: Owner, names: Map<string, string>): Map<string, Map<LinkPending, number>> {
  const out = new Map<string, Map<LinkPending, number>>();
  const add = (link: string | undefined, kind: LinkPending) => {
    if (!link) return;
    const k = out.get(link) ?? new Map<LinkPending, number>();
    k.set(kind, (k.get(kind) ?? 0) + 1);
    out.set(link, k);
  };
  const has = (f: string) => existsSync(join(app.dataDir, f));
  const a = app as AppContext;
  try {
    if (has('support.db')) for (const p of supportOf(a)?.proposals({} as never) ?? []) if (p.side === 'in' && p.status === 'pending') add(p.link, 'help');
  } catch { /* a request engine that can't open answers nothing */ }
  try {
    if (has('remote-repair.db')) for (const p of remoteRepairOf(a)?.passes('held') ?? []) if (p.status === 'asked') add(p.link, 'fix');
  } catch { /* as above */ }
  try {
    if (has('friend-time.db')) for (const r of friendTimeOf(a)?.list() ?? []) if ((r.side === 'friend' && r.status === 'asked') || (r.status === 'proposed' && !r.myPick)) add(r.link, 'time');
  } catch { /* as above */ }
  try {
    if (has('shared-projects.db')) {
      const byName = new Map([...names].map(([id, n]) => [fold(n), id]));
      for (const s of sharedProjectsOf(a as never)?.list() ?? []) if (s.side === 'guest' && s.status === 'invited') add(byName.get(fold(s.from)), 'project');
    }
  } catch { /* as above */ }
  return out;
}

/** Every direct link with metadata only (undefined when off or not the owner). */
export function linkedFriends(app: Owner): LinkedFriend[] | undefined {
  if (!linkAwareOn(app)) return undefined;
  const rows = app.messages!.awareness();
  const pend = pendingByLink(app, new Map(rows.map((r) => [r.link, r.name])));
  return rows.map((r) => ({ name: r.name, companion: r.companion, formerly: r.formerly, aliases: [r.companion, r.formerly].filter((x): x is string => Boolean(x)), since: r.since, unread: r.unread, lastInAt: r.lastInAt, chat: r.chat, pending: [...(pend.get(r.link) ?? new Map())].map(([kind, n]) => ({ kind, n })) }));
}

const ago = (at: string, now: Date) => ageShort(Math.max(0, now.getTime() - Date.parse(at)));
const pendingText = (p: LinkedFriend['pending']) => p.map((x) => (x.n > 1 ? `${x.n}× ${PENDING_WORDS[x.kind]}` : PENDING_WORDS[x.kind])).join(', ');

function friendLine(f: LinkedFriend, now: Date): string {
  const her = f.companion && f.companion.toLowerCase() !== f.name.toLowerCase() ? f.companion : null;
  const bits = [...(her ? [`${f.name}’s Sara`] : []), ...(f.formerly ? [`formerly ${f.formerly}`] : []), `linked ${ago(f.since, now)}`, f.unread ? `${f.unread} unread from them` : 'nothing unread'];
  if (f.lastInAt) bits.push(`their last message ${ago(f.lastInAt, now)}`);
  else bits.push('no message from them yet');
  if (f.pending.length) bits.push(`waiting for the owner: ${pendingText(f.pending)}`);
  return `${her ?? f.name} (${bits.join('; ')})`;
}

/** The one compact system line for the owner's own chats (undefined with no links or when off). */
export function linkedFriendsNote(app: Owner): string | undefined {
  const list = linkedFriends(app);
  if (!list?.length) return undefined;
  const now = app.now();
  return `Linked Saras (Messages, metadata only: you can't read or send their messages, so never guess what they wrote; he reads them in Messages): ${list.slice(0, 12).map((f) => friendLine(f, now)).join('. ')}.`;
}

/** The linked_friends tool's answer. */
export function linkedFriendsReport(app: Owner, friend?: unknown): string {
  const list = linkedFriends(app);
  if (!list) return 'Linked Saras are not shown to me (Messages settings → Let Sara know who wrote is off, or this is not the owner).';
  if (!list.length) return 'No linked Saras yet. Link one under Messages → Link a server.';
  const now = app.now();
  let shown = list;
  if (friend !== undefined && String(friend).trim()) {
    const m = matchFriend(list, friend);
    if (m.many) return `Which one: ${m.many.map((f) => f.name).join(', ')}?`;
    if (!m.hit) return `No linked Sara called "${String(friend).slice(0, 60)}". Linked: ${list.map((f) => f.name).join(', ')}.`;
    shown = [m.hit];
  }
  return [
    ...shown.map((f) => `- ${friendLine(f, now)}`),
    `Only names, counts and times: I can’t read or send these messages. To read them: Messages in the sidebar (under More; or /#view=msgs), then ${shown.length === 1 ? `the chat with ${shown[0]!.companion || shown[0]!.name}` : 'the friend’s chat'}.`,
  ].join('\n');
}
