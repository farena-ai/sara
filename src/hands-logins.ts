// Phase 90 (computer use CU4, docs/design/COMPUTER_USE.md §8.2): saved logins for the Sara browser.
// The logins live ONLY on the computer (Windows: a DPAPI CurrentUser file %LOCALAPPDATA%\Sara\logins.dat;
// macOS: Keychain generic-password items, service "Sara logins", this device only). The server and the
// model only ever learn a login's name and the sites it is for; the password never crosses the hands
// channel. This file holds the rules every device follows (the Windows and Mac apps implement the same
// in C++ and Swift) and the test vault the reference hands (src/hands-ref.ts) uses:
//   - a login is used only on a page whose CURRENT origin exactly equals one of its saved origins
//     (scheme, host and port: https://github.com is not http://github.com, github.com:8443 or
//     github.com.evil.test);
//   - a login is saved only through the device's own consent window, after the person ticked
//     "I understand" under the warning below (the device refuses otherwise, whatever the server says);
//   - each login belongs to the Sara server it was saved through (another server paired on the same
//     computer can't use it);
//   - what goes back to the server: names, sites, when saved and last used. Never a username or password.

/** The warning in the consent window (the design's words; {site} is the page's origin). */
export const SAVE_LOGIN_WARNING =
  "Saving this password lets Sara sign in to {site} for you on this computer. It's stored encrypted here, never on Sara's server, and she never sees it. Anyone who can use your account on this computer could use it too. Save it only if you're comfortable; signing in yourself once and letting the Sara browser remember you is safer.";
/** The box under the warning (unticked until the person ticks it). */
export const SAVE_LOGIN_TICK = 'I understand';
/** At most this many logins per server on one computer. */
export const MAX_LOGINS = 100;
/** "Use what I just typed": a sign-in the person typed is kept in memory this long, never on disk. */
export const CAUGHT_KEEP_MS = 10 * 60_000;

export interface SavedLogin {
  name: string;
  /** Exact origins (\"https://github.com\"). */
  sites: string[];
  username: string;
  password: string;
  /** The Sara server it was saved through (its origin). */
  server: string;
  created: string;
  lastUsed?: string;
}
/** What may leave the computer about a login. */
export interface LoginView {
  name: string;
  sites: string[];
  created?: string;
  lastUsed?: string;
}

/**
 * The origin of an http(s) address as browsers write it (lower-case scheme and host, default ports
 * left out), or '' when it isn't one. Addresses with a user name or password get ''.
 */
export function loginOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password || !u.hostname) return '';
  return u.origin.toLowerCase();
}

/** True only when the page's current origin is exactly one of the login's sites. */
export function siteMatches(login: Pick<SavedLogin, 'sites'>, pageUrl: string): boolean {
  const o = loginOrigin(pageUrl);
  return Boolean(o) && login.sites.some((s) => loginOrigin(s) === o);
}

/** A login name as people write it: trimmed, no control characters, at most 60 characters. */
export function cleanLoginName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** A default name for a site's login (\"github.com\"). */
export function defaultLoginName(site: string): string {
  try {
    return cleanLoginName(new URL(site).hostname.replace(/^www\./, ''));
  } catch {
    return 'Login';
  }
}

export const viewOf = (l: SavedLogin): LoginView => ({ name: l.name, sites: [...l.sites], created: l.created, ...(l.lastUsed ? { lastUsed: l.lastUsed } : {}) });

export class LoginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the person did in the consent window (the reference hands' stand-in for the native dialog). */
export interface ConsentAnswer {
  /** Pressed Save (false: Cancel or closed). */
  save: boolean;
  /** Ticked "I understand". */
  understood: boolean;
  name?: string;
  username?: string;
  password?: string;
  /** Pressed "Use what I just typed". */
  useTyped?: boolean;
}
export interface ConsentRequest {
  site: string;
  name: string;
  warning: string;
  /** A sign-in typed on this site is there for "Use what I just typed". */
  canUseTyped: boolean;
}

/**
 * The reference hands' vault (tests, evals, the conformance script, the Linux hands later). Memory
 * only unless a file is given; a real device keeps it encrypted with the OS (DPAPI / Keychain).
 */
export class TestVault {
  #logins: SavedLogin[] = [];
  /** Every write, for tests (what the device stored; never sent anywhere). */
  writes = 0;

  constructor(seed: SavedLogin[] = []) {
    this.#logins = seed.map((l) => ({ ...l, sites: [...l.sites] }));
  }

  list(server: string): LoginView[] {
    return this.#logins.filter((l) => l.server === server).map(viewOf);
  }

  /** The login with this name for this server (case does not matter), or undefined. */
  find(server: string, name: string): SavedLogin | undefined {
    const want = cleanLoginName(name).toLowerCase();
    return this.#logins.find((l) => l.server === server && l.name.toLowerCase() === want);
  }

  /** Phase 91: the first of this server's logins saved for the page's exact origin (before the password managers). */
  findBySite(server: string, pageUrl: string): SavedLogin | undefined {
    return this.#logins.find((l) => l.server === server && siteMatches(l, pageUrl));
  }

  /**
   * Saves what the consent window gave (the device's own rule: only with the box ticked, a name, a
   * site, a password). A login with the same name for the same server is replaced.
   */
  save(server: string, site: string, answer: ConsentAnswer, now = new Date()): LoginView {
    if (!answer.save) throw new LoginError('cancelled', 'Not saved: the owner pressed Cancel on the computer.');
    if (answer.understood !== true) throw new LoginError('cancelled', 'Not saved: the box "I understand" under the warning was not ticked.');
    const origin = loginOrigin(site);
    if (!origin) throw new LoginError('denied_local', 'Logins are saved only for web pages (http or https).');
    const name = cleanLoginName(answer.name) || defaultLoginName(origin);
    if (!answer.password) throw new LoginError('cancelled', 'Not saved: no password was given.');
    const others = this.#logins.filter((l) => !(l.server === server && l.name.toLowerCase() === name.toLowerCase()));
    if (others.filter((l) => l.server === server).length >= MAX_LOGINS) throw new LoginError('denied_local', `At most ${MAX_LOGINS} saved logins per Sara on one computer.`);
    const entry: SavedLogin = { name, sites: [origin], username: String(answer.username ?? ''), password: String(answer.password), server, created: now.toISOString() };
    this.#logins = [...others, entry];
    this.writes++;
    return viewOf(entry);
  }

  touch(server: string, name: string, now = new Date()): void {
    const l = this.find(server, name);
    if (l) {
      l.lastUsed = now.toISOString();
      this.writes++;
    }
  }

  /** Removes one login (by name) or all of this server's; returns how many went. */
  remove(server: string, name: string | { all: true }): number {
    const before = this.#logins.length;
    const want = typeof name === 'string' ? cleanLoginName(name).toLowerCase() : '';
    this.#logins = this.#logins.filter((l) => l.server !== server || (typeof name === 'string' && l.name.toLowerCase() !== want));
    const n = before - this.#logins.length;
    if (n) this.writes++;
    return n;
  }

  /** Tests only: is any stored password equal to this? (Never used by the device's ops.) */
  hasPassword(p: string): boolean {
    return this.#logins.some((l) => l.password === p);
  }
}
