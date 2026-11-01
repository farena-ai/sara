// Phase 44: a document the owner sends in a chat (the 📎 in the app, a file on Telegram or
// Discord). It is saved to her library (kept) or for this conversation only (read once), read in
// the background, and the message that carries it names it, so she knows it arrived.
import type { AppContext } from '../chat.ts';
import type { Conversation } from '../store.ts';
import { detectKind, SUPPORTED } from './read.ts';
import type { LibraryDoc } from './store.ts';

/** What a chat message says about the documents that came with it (stored in its meta). */
export interface SharedDoc {
  id: number;
  name: string;
  keep: boolean;
}

/** "just read it", "don't keep this": a caption that asks her to read it once. */
const READ_ONCE = /\b(read (it |this )?once|just read|don'?t (keep|save)|do not (keep|save)|not (to )?keep)\b/i;

export const readOnceAsked = (caption: string) => READ_ONCE.test(caption);

/** The line the model sees with the message (also for older messages in the history). */
export function docsNote(docs: SharedDoc[]): string {
  if (!docs.length) return '';
  const names = docs.map((d) => `"${d.name}"`).join(', ');
  const kept = docs.every((d) => d.keep) ? 'kept in your library' : docs.some((d) => d.keep) ? 'some kept in your library, some to read only here' : 'to read here, not kept';
  return ` [Note from the app: the owner shared ${docs.length === 1 ? 'a document' : 'documents'} with this message: ${names} (${kept}).]`;
}

/** Waits (a little) until the documents are read, so her answer can use them. */
export async function waitUntilRead(app: AppContext, ids: number[], ms = 45_000): Promise<LibraryDoc[]> {
  const lib = app.library;
  if (!lib) return [];
  const until = Date.now() + ms;
  for (;;) {
    const docs = ids.map((id) => lib.get(id)).filter((d): d is LibraryDoc => Boolean(d));
    if (docs.every((d) => d.status === 'ready' || d.status === 'failed') || Date.now() > until) return docs;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Phase 115 (BR1): where a chat document came from, by the conversation's channel. Before 2.48.0 a
 * plugin bridge's document was labelled Telegram (everything that wasn't Discord was).
 */
export function chatOrigin(channel: string): 'discord' | 'telegram' | 'plugin' {
  return channel.startsWith('discord') ? 'discord' : channel.startsWith('telegram') ? 'telegram' : 'plugin';
}

/**
 * Takes a document sent on Telegram or Discord: saves it (kept unless the caption asks to read
 * it once), starts reading, waits a little. Returns it for the turn, or a reason it couldn't.
 */
export async function takeChatDocument(app: AppContext, conv: Conversation, file: { name: string; bytes: Buffer }, caption: string): Promise<{ doc?: SharedDoc; problem?: string }> {
  const lib = app.library;
  if (!lib) return { problem: "I don't have a library here." };
  if (conv.partner) return { problem: "I only keep documents for the person who runs me." };
  if (!detectKind(file.name, file.bytes)) return { problem: `I can't read that kind of file. I can read ${SUPPORTED.map((k) => k.label).join(', ')}.` };
  const keep = !readOnceAsked(caption);
  const had = keep ? lib.findKept(file.bytes) : undefined;
  const doc = had ?? lib.add({ name: file.name, bytes: file.bytes, keep, conversationId: keep ? null : conv.id, origin: chatOrigin(conv.channel) });
  app.libraryNudge?.();
  app.events?.publish({ type: 'library', id: doc.id });
  await waitUntilRead(app, [doc.id]);
  return { doc: { id: doc.id, name: doc.name, keep: doc.keep } };
}
