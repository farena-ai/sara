// P1 polish (2026-11-20): one rule for every box where you type to her (chat, project chats, Messages,
// the workspace's Ask box, the website receptionist). Enter sends, Shift+Enter makes a new line,
// Ctrl/Cmd+Enter keeps its meaning for the box (the main chat: Interrupt now). Settings → You →
// Appearance → Chat behavior → "Enter sends the message" (per device, on by default, phones too):
// off = Enter makes a new line and Ctrl/Cmd+Enter sends.
// IME-safe: Enter that picks a word in an input method (isComposing / keyCode 229) never sends.
// Phones: some keyboards (Android) report Enter as keyCode 229 or while a word is still underlined,
// so the keydown above can't see it; the line break it would insert (beforeinput insertLineBreak)
// sends instead. Composing Enter on a computer confirms the word and inserts no line break.
// web/offline-view.js and desktop/shared/quick-ask.html can't import this file (offline cache /
// a page of the desktop app): they keep a copy of enterAction, and test/p1-enter.test.ts keeps all equal.

export const ENTER_KEY = 'sara.enterSends';

const local = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** True unless this device turned "Enter sends the message" off. */
export function enterSendsOn(store = local()) {
  try {
    return store?.getItem(ENTER_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setEnterSends(on, store = local()) {
  try {
    store?.setItem(ENTER_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the default stays */
  }
  globalThis.dispatchEvent?.(new Event('sara-enter-sends'));
}

/** 'send' when this key press sends, else null (the box does what it normally does). */
export function enterAction(e, on) {
  if (!e || e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return null;
  if (on) return e.shiftKey ? null : 'send';
  return (e.ctrlKey || e.metaKey) && !e.shiftKey ? 'send' : null;
}

/**
 * Wires a text box: send(event) runs when the key press sends (read e.ctrlKey/e.metaKey/e.altKey
 * for the box's own meanings). opts.multiline: a box for longer text (notes, emails) where Enter
 * always makes a line and Ctrl/Cmd+Enter sends. opts.store: tests.
 */
export function enterSend(box, send, opts = {}) {
  if (!box) return;
  const on = () => (opts.multiline ? false : enterSendsOn(opts.store ?? local()));
  const hint = () => box.setAttribute?.('enterkeyhint', on() ? 'send' : 'enter');
  hint();
  globalThis.addEventListener?.('sara-enter-sends', hint);
  let shiftAt = 0;
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) shiftAt = Date.now();
    if (enterAction(e, on()) !== 'send') return;
    e.preventDefault();
    send(e);
  });
  box.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    if (!on() || Date.now() - shiftAt < 1000) return;
    e.preventDefault();
    send(e);
  });
}
