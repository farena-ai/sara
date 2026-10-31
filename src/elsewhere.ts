// What was just said in her other conversations (the owner's other chats, Telegram, Discord), so
// she keeps track of them like one person would. Each conversation only sees its own messages, and
// memory notes come later (after a conversation has been quiet for a while, and never for chats
// with other people), so without this she has no idea what happened in Discord ten minutes ago.
import { isForgotten } from './memory-worker.ts';
import { adultModeOn } from './settings.ts';
import { isWorkChannel } from './safety.ts';
import type { AppContext } from './chat.ts';
import type { Conversation } from './store.ts';

const WITHIN_MS = 24 * 3600_000;
const MAX_CONVERSATIONS = 5;
const LINES_EACH = 6;
const LINE_CHARS = 220;
const MAX_CHARS = 2400;

function where(c: Conversation): string {
  const place = c.channel.startsWith('discord') ? 'Discord' : c.channel.startsWith('telegram') ? 'Telegram' : 'the app';
  if (c.partner) return `${place}, with other people (${c.title})`;
  if (c.channel === 'group') return `a group chat in the app with other AI companions ("${c.title}")`;
  if (isWorkChannel(c.channel)) return `${place}, working with you in a shared channel (${c.title})`;
  return place === 'the app' ? `another chat in the app ("${c.title}")` : `${place}, just the two of you`;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

/** A few lines from each of her other recent conversations, newest first, for her instructions. */
export function elsewhereNote(app: AppContext, current: Conversation, now: Date, ownerName: string): string | undefined {
  if (current.partner) return undefined; // other people never hear about the owner's other chats
  const s = app.settings.get();
  // Adult channels only reach her own chats with the owner, and only with Adult mode on.
  const adultOk = adultModeOn(s) && !isWorkChannel(current.channel) && !current.private;
  const others = app.store
    .listConversations()
    .filter((c) => c.id !== current.id && !c.archivedAt && !c.private && now.getTime() - Date.parse(c.updatedAt) < WITHIN_MS)
    .filter((c) => adultOk || !c.channel.endsWith('-nsfw'))
    // Phase 100: conversations with other agents (A2A) are untrusted text: never quoted into her chats.
    .filter((c) => c.channel !== 'a2a')
    // Chats with other people only when they're shared rooms the owner is in too (a Discord
    // server channel, a Telegram group: negative chat ids); a one-to-one chat stays theirs.
    .filter((c) => !c.partner || c.channel.startsWith('discord') || (c.channel.startsWith('telegram') && String(c.channelKey ?? '').startsWith('-')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
  const blocks: string[] = [];
  let total = 0;
  for (const c of others) {
    // Something was forgotten in this conversation: its other lines may still echo it in words the
    // forget couldn't match (her "the beagle who howls" with no name), so it stays out entirely.
    if (app.store.messages(c.id).some((m) => isForgotten(m))) continue;
    const lines = app.store
      .messagesPage(c.id, { limit: 20 })
      .messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !isForgotten(m) && m.content.trim())
      .slice(-LINES_EACH)
      .map((m) => {
        const text = m.content.replace(/\s+/g, ' ').trim();
        const clipped = text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}…` : text;
        // Lines from other people already carry their name ("[Bob]: …").
        // Phase 66: another companion's line in a group chat carries her name.
        const from = m.role === 'assistant' && m.meta?.groupFrom && typeof m.meta.groupFrom === 'object' ? String((m.meta.groupFrom as { name?: unknown }).name ?? '') : '';
        const who = from ? `${from} (another AI companion)` : m.role === 'assistant' ? 'You' : c.partner ? '' : ownerName;
        return `  ${who ? `${who}: ` : ''}${clipped}`;
      });
    if (!lines.length) continue;
    const block = `- ${where(c)}, ${ago(now.getTime() - Date.parse(c.updatedAt))}:\n${lines.join('\n')}`;
    if (total + block.length > MAX_CHARS) break;
    blocks.push(block);
    total += block.length;
  }
  return blocks.length ? blocks.join('\n') : undefined;
}
