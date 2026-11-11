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
export function streamFrame(box, render) {
  const follow = nearBottom(box);
  render();
  if (follow && box) box.scrollTop = box.scrollHeight;
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
