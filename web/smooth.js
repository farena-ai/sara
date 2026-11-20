// Smooth long sessions (docs/PERFORMANCE.md): small helpers that keep a long chat steady while she
// streams. Pure parts are tested in Node (test/smooth.test.ts); nothing here touches the page at
// import time.

/** How close to the newest line (in px) still counts as "reading along". */
export const NEAR_BOTTOM_PX = 160;

/** True when the reader is at (or close to) the bottom of the scroll box `m`. */
export function nearBottom(m, px = NEAR_BOTTOM_PX) {
  if (!m) return true;
  return m.scrollHeight - m.scrollTop - m.clientHeight < px;
}

/** Wraps `fn` so any number of calls within one frame run it once, in the next frame. */
export function frameBatch(fn, raf = globalThis.requestAnimationFrame) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    raf(() => {
      queued = false;
      fn();
    });
  };
}

/**
 * One streaming frame: read whether the reader is at the bottom (one layout read, while layout is
 * still clean), draw the new text, then follow it only if they were. Never scrolls someone who went
 * up to read, and never reads layout once per token.
 */
export function streamFrame(box, render, at) {
  // LAGFIX: `at` from followTracker means no layout read at all before the draw.
  const follow = typeof at === 'boolean' ? at : nearBottom(box);
  render();
  if (follow && box) {
    if (box._follow) box._follow.self = true;
    box.scrollTop = box.scrollHeight;
  }
}

/**
 * LAGFIX (docs/design/LAGFIX.md): whether the reader is at the newest line, kept up to date by the
 * box's own scroll events instead of a layout read per streamed frame. Our own scroll to the newest
 * line (streamFrame) is not a reader leaving the bottom. One tracker per box.
 */
export function followTracker(box) {
  if (!box) return { at: true };
  if (box._follow) return box._follow;
  const f = { at: true, self: false };
  box._follow = f;
  box.addEventListener?.(
    'scroll',
    () => {
      if (f.self) {
        f.self = false;
        f.at = true;
        return;
      }
      f.at = nearBottom(box);
    },
    { passive: true },
  );
  return f;
}

/** LAGFIX: how often a streamed reply is drawn at most (ms). ~20 times a second reads as live text. */
export const STREAM_EVERY_MS = 50;

/**
 * Wraps `fn` so a burst of calls (one per streamed token) runs it at most once per `every` ms, in an
 * animation frame, and always once more after the last call.
 */
export function paced(fn, { every = STREAM_EVERY_MS, now = () => performance.now(), raf = globalThis.requestAnimationFrame, timer = globalThis.setTimeout } = {}) {
  let queued = false;
  let last = -Infinity;
  return () => {
    if (queued) return;
    queued = true;
    const go = () =>
      raf(() => {
        queued = false;
        last = now();
        fn();
      });
    const wait = last + every - now();
    if (wait > 0) timer(go, wait);
    else go();
  };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const GOES_ON = /^(\s+|[-*+]\s|\d+[.)]\s|>|\|)/;

/**
 * LAGFIX: how many characters of a streamed Markdown reply are finished blocks: up to the last blank
 * line that is outside an open code fence, has text after it, and doesn't sit inside a list, quote or
 * table that goes on. Finished blocks never change while more text streams in.
 */
export function stableCut(raw) {
  const text = String(raw ?? '');
  let fence = null;
  let cut = 0;
  let pos = 0;
  let prev = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const end = pos + line.length + 1;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
    } else {
      const f = FENCE_OPEN.exec(line);
      if (f) fence = f[1];
      else if (!line.trim() && i + 1 < lines.length && lines[i + 1].trim()) {
        const next = lines[i + 1];
        if (!(GOES_ON.test(prev) && GOES_ON.test(next))) cut = end;
      }
    }
    if (line.trim()) prev = line;
    pos = end;
  }
  return Math.min(cut, text.length);
}

/**
 * LAGFIX: draws a streamed reply into `body` block by block: finished blocks (stableCut) are drawn
 * once and kept, only the open tail is drawn again. `render(text)` returns a fragment. A text that
 * doesn't continue what was drawn (a rewrite) starts over. A full draw must clear `body._sb`.
 */
export function streamBlocks(body, raw, render) {
  let st = body._sb;
  if (!st || !raw.startsWith(st.text)) {
    body.replaceChildren();
    st = body._sb = { text: '', tail: [] };
  }
  for (const n of st.tail) n.remove();
  st.tail = [];
  const cut = stableCut(raw);
  if (cut > st.text.length) {
    body.append(render(raw.slice(st.text.length, cut)));
    st.text = raw.slice(0, cut);
  }
  const rest = raw.slice(st.text.length);
  if (rest.trim()) {
    const frag = render(rest);
    st.tail = [...frag.childNodes];
    body.append(frag);
  }
}

/** Firefox (its own engine; on Windows and Linux it often draws the page in software). */
export const isFirefox = (ua = '') => /\bFirefox\/\d/.test(ua) && !/\bSeamonkey\//i.test(ua);

/**
 * Glass blur behind the panels (Settings → Appearance → Glass blur, this device): 'on' or 'off'.
 * Auto (the default) is off in Firefox, where blurring the moving page behind the header, sidebar and
 * composer cost ~60 ms a frame in our measurements (docs/PERFORMANCE.md), and on everywhere else.
 */
export function glassPlan(pref, ua = '') {
  if (pref === 'on' || pref === 'off') return pref;
  return isFirefox(ua) ? 'off' : 'on';
}

/** True while a modal window is open (safe on browsers without :modal). */
export function modalOpen(doc = globalThis.document) {
  try {
    return Boolean(doc?.querySelector('dialog:modal'));
  } catch {
    return false;
  }
}

/**
 * Keeps `html.modal-open` in step with modal windows, so CSS can pause the background while one is
 * open without a page-wide `:has()` (which makes every change anywhere re-check the whole page).
 */
export function watchModal(doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root || typeof MutationObserver === 'undefined') return;
  const sync = frameBatch(() => root.classList.toggle('modal-open', modalOpen(doc)));
  new MutationObserver(sync).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  sync();
}
