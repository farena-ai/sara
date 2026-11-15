// R4 (docs/IPHONE.md): the installed web app on an iPhone. iOS (16.4 and later) gives web push and the
// app badge only to a web app opened from the Home Screen, and it shows no notification buttons and no
// share target: those come from Apple Shortcuts (Settings → Connections → Phone and notifications → iPhone Shortcuts).
// No DOM at import time, so the tests can load it.

/** An iPhone, iPod or iPad (iPads ask for the desktop site and look like a Mac with touch). */
export function isIOS(ua = '', maxTouchPoints = 0) {
  const s = String(ua);
  return /iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1);
}

/** Opened from the Home Screen (the installed web app), not in a Safari tab. */
export function isStandalone(win = globalThis) {
  return Boolean(win?.navigator?.standalone) || Boolean(win?.matchMedia?.('(display-mode: standalone)')?.matches);
}

/** Inside Sara's own iPhone app (built from source; it has its own notifications and share button). */
export const inSaraApp = (ua = '') => /\bSaraPhone\//.test(String(ua));

/** The "Add to Home Screen" guide: an iPhone in a browser tab (not the installed app, not Sara's own app). */
export function needsInstallGuide({ ua = '', maxTouchPoints = 0, standalone = false } = {}) {
  return isIOS(ua, maxTouchPoints) && !standalone && !inSaraApp(ua);
}

/** On an iPhone, notifications work only once installed; elsewhere whenever the browser has push. */
export function pushPossible({ ua = '', maxTouchPoints = 0, standalone = false, hasPush = false } = {}) {
  if (!hasPush) return false;
  return !isIOS(ua, maxTouchPoints) || standalone;
}

/** The badge's number: a whole number from 0 to 99 (anything else counts as 0). */
export function badgeValue(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 99) : 0;
}

/** Sets (or clears, at 0) the app badge where the browser has it. Returns what was shown, or null. */
export async function applyBadge(nav, n) {
  const v = badgeValue(n);
  try {
    if (v > 0 && typeof nav?.setAppBadge === 'function') {
      await nav.setAppBadge(v);
      return v;
    }
    if (v === 0 && typeof nav?.clearAppBadge === 'function') {
      await nav.clearAppBadge();
      return 0;
    }
  } catch {
    /* not allowed here (not installed, or notifications off) */
  }
  return null;
}
