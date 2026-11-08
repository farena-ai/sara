// 2.18: the update experience's rules, kept free of the page so they can be tested in Node
// (test/update-ux.test.ts). web/app.js does the work: when the app opens (and every 12 hours while
// it is open) it asks the server whether a new version is out and shows "Sara X is available";
// the sidebar footer keeps a small "Update available" link; and after an update every open page
// notices the server's new version and reloads (or offers to, when the owner is in the middle of
// something), then says "Sara was updated to X".
// A plain module with no imports.

/** How long a check's answer stays good before the app asks again. */
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
/** localStorage: the version the owner said not to be reminded about (this device). */
export const DISMISS_KEY = 'sara.updateDismissed';
/** localStorage: the version this device last ran, for "Sara was updated to X" after a reload. */
export const SEEN_KEY = 'sara.seenVersion';

/** Dotted versions ("v2.18.0" vs "2.17.3"): negative, zero or positive (the server's compareVersions). */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * Whether the update UI exists at all for this person here: only the owner, never the public demo,
 * and only where the server can update (GET /api/update says available).
 * @param {{ demo?: boolean, member?: boolean, available?: boolean }} who
 */
export function updatesShown({ demo = false, member = false, available = false } = {}) {
  return !demo && !member && Boolean(available);
}

/**
 * Whether to ask the server to check now (on open, and on the 12-hour tick). Never in the demo, for
 * a household member, in private local mode (nothing may go online) or while a check is running;
 * otherwise only when the last answer is older than 12 hours (or there is none).
 * @param {{ demo?: boolean, member?: boolean, privateLocal?: boolean, available?: boolean, inFlight?: boolean, status?: { state?: string, at?: string, pending?: string } | null, now?: number }} o
 */
export function shouldCheck({ demo = false, member = false, privateLocal = false, available = false, inFlight = false, status = null, now = Date.now() } = {}) {
  if (!updatesShown({ demo, member, available }) || privateLocal || inFlight) return false;
  const s = status ?? {};
  if (s.pending || s.state === 'checking' || s.state === 'updating') return false;
  const at = Date.parse(s.at ?? '');
  if (!Number.isFinite(at)) return true;
  return now - at >= CHECK_EVERY_MS || at > now + 60_000;
}

/**
 * Whether to show the "Sara X is available" window: a newer version is out, the owner didn't say
 * "Don't remind me" for it (a newer one than the dismissed one shows again) and didn't press Later
 * for it in this session.
 * @param {{ status?: { state?: string, latest?: string } | null, version?: string, dismissed?: string | null, later?: string | null }} o
 */
export function shouldRemind({ status = null, version = '', dismissed = null, later = null } = {}) {
  const latest = status?.state === 'available' ? String(status.latest ?? '') : '';
  if (!latest) return false;
  if (version && compareVersions(latest, version) <= 0) return false;
  if (dismissed && compareVersions(latest, dismissed) <= 0) return false;
  if (later && compareVersions(latest, later) <= 0) return false;
  return true;
}

/** True when the server now runs another version than the one this page loaded with. */
export function versionChanged(loaded, now) {
  const a = String(loaded ?? '').trim();
  const b = String(now ?? '').trim();
  return Boolean(a && b && a !== b);
}

/**
 * After the server changed version: reload by itself only when nothing would be lost (the message
 * box is empty and no window is open); otherwise show the "Reload" bar. The page that started the
 * update always reloads.
 * @param {{ composer?: string, dialogOpen?: boolean, startedHere?: boolean }} o
 */
export function reloadNow({ composer = '', dialogOpen = false, startedHere = false } = {}) {
  if (startedHere) return true;
  return !String(composer ?? '').trim() && !dialogOpen;
}

/**
 * The "Sara was updated to X" note after a reload: the device ran an older version before.
 * (The first visit on a device only remembers the version.)
 */
export function updatedNote(seen, version) {
  return Boolean(seen && version && compareVersions(version, seen) > 0);
}

/**
 * C9: the top bar's Update button. Its colour rises with the release's age: grey under 2 days,
 * accent 2 to 4, amber 4 to 7, red after 7; red at once for a security release. Below the
 * notice's minimum supported version it says "Update required" (red). null = no update waiting.
 * @param {{ state?: string, latest?: string, releasedAt?: string, security?: boolean, required?: boolean } | null} status
 * @returns {{ tone: 'grey' | 'accent' | 'amber' | 'red', required: boolean } | null}
 */
export function updateTone(status, now = Date.now()) {
  if (status?.state !== 'available' || !status.latest) return null;
  const required = Boolean(status.required);
  if (required || status.security) return { tone: 'red', required };
  const at = Date.parse(status.releasedAt ?? '');
  const days = Number.isFinite(at) ? (now - at) / 86_400_000 : 0;
  return { tone: days >= 7 ? 'red' : days >= 4 ? 'amber' : days >= 2 ? 'accent' : 'grey', required };
}
