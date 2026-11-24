// C6 (docs/ROADMAP_AFTER_3.42.md): "Typed, like a person" (Settings → Appearance, per device; off by
// default). A short pause before she starts that grows with the reply (a few seconds at most), and on
// a long reply a longer pause after a paragraph or two, as if the rest came as a second message. It is
// only how the reply is shown: what is stored is unchanged. Never in coding chats, calls or spoken
// replies; errors and safety replacements show at once (web/app.js).

export const TYPING_KEY = 'sara.typing';
export const PAUSE = { minMs: 400, perChar: 4, maxMs: 2500, longReply: 600, minPart: 250, tail: 120, partMs: 900, parts: 3 };

/** How long "typing…" shows before the first words of a reply that is this long so far. */
export function startPause(chars) {
  return Math.min(PAUSE.maxMs, PAUSE.minMs + Math.max(0, chars) * PAUSE.perChar);
}

/** Replies are typed out here only when chosen, and never in a coding chat, a call or spoken replies, or with reduced motion. */
export function typingOn({ choice, coding = false, voice = false, reducedMotion = false }) {
  return choice === 'human' && !coding && !voice && !reducedMotion;
}

/**
 * Where a long reply pauses as if a new message were coming: just after a blank line outside code,
 * at least PAUSE.minPart characters after the last part began, with some text after it, at most two
 * (so three parts). Read from the start only, so a place found stays put while the reply grows.
 * @param {string} text
 * @returns {number[]}
 */
export function partBreaks(text) {
  const out = [];
  if (text.length < PAUSE.longReply) return out;
  let code = false;
  let last = 0;
  let at = 0;
  for (const line of text.split('\n')) {
    const end = at + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    else if (!code && !line.trim() && at > 0 && text[at - 2] !== '\n' && end - last >= PAUSE.minPart && text.length - end >= PAUSE.tail) {
      out.push(end);
      last = end;
      if (out.length >= PAUSE.parts - 1) break;
    }
    at = end;
  }
  return out;
}
