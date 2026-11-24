// Phase 11: on Telegram/Discord she can reply at a person's typing pace instead of instantly.
// C6: the wait is a few seconds at most, a long reply goes as two or three messages split at
// paragraph ends (what is stored stays one message), and errors, safety replies and coding
// chats are never paced or split.
import type { AppContext } from '../chat.ts';
import { CRISIS_RESOURCES, isWorkChannel, MINOR_BLOCK_REPLY } from '../safety.ts';
import { partBreaks } from '../../web/human-typing.js';

export const TYPING = { baseMs: 900, perChar: 45, maxMs: 4000 };

/** About how long a quick typist takes for this message (capped at a few seconds). */
export function typingMs(text: string): number {
  return Math.min(TYPING.maxMs, TYPING.baseMs + text.length * TYPING.perChar);
}

/** Human typing is on for this conversation: chosen in Settings, and not a coding or work chat. */
export function typingPaced(app: AppContext, conv: { mode?: string | null; channel: string }): boolean {
  return app.settings.get().persona?.typing === 'human' && conv.mode !== 'coding' && !isWorkChannel(conv.channel);
}

/** A safety reply (the minors block, crisis resources) goes at once and whole. */
export function isSafetyText(text: string): boolean {
  const t = text.trim();
  return t === MINOR_BLOCK_REPLY || t.includes(CRISIS_RESOURCES);
}

/**
 * The messages one reply goes out as with human typing on: a long reply in two or three parts at
 * paragraph ends (never inside code), the same split the web chat pauses at.
 */
export function typedParts(text: string): string[] {
  const at = partBreaks(text);
  if (!at.length) return [text];
  return [0, ...at].map((from, i) => text.slice(from, at[i] ?? text.length).trim()).filter(Boolean);
}

/**
 * Waits before sending `text` so it arrives like typed, counting time already spent (thinking,
 * the previous message). `typing()` keeps the "typing…" indicator up meanwhile.
 */
export async function paceLikeTyping(app: AppContext, text: string, since: number, typing: () => void): Promise<void> {
  if (app.settings.get().persona?.typing !== 'human') return;
  let wait = typingMs(text) - (Date.now() - since);
  while (wait > 0) {
    typing();
    const step = Math.min(wait, 4000);
    await new Promise((r) => setTimeout(r, step));
    wait -= step;
  }
}
