// Phase 91 (computer use CU4b, docs/design/COMPUTER_USE.md §0 decision 3 and §11): password managers the
// owner already has, as extra sources behind the saved-login autofill of Phase 90 (src/hands-logins.ts).
// Everything here happens ON THE COMPUTER: the Windows app (desktop/windows/src/hands.cpp), the Mac app
// (desktop/mac/Sources/Hands.swift) and the reference hands (src/hands-ref.ts, which uses the client at
// the bottom of this file) follow the same rules:
//   - supported managers are found by checking that their documented command-line tool exists and answers
//     `--version` (nothing else is run until the person turns that manager on);
//   - each manager is OFF until the person turns it on in the Sara app on that computer, after the plain
//     warning below (the server can't turn one on: it isn't an op);
//   - the person unlocks it themselves, in the manager's OWN prompt (a console / Terminal window running
//     the manager's own unlock command; 1Password may show its app's own prompt instead). Sara never asks
//     for, types or keeps a master password: she only keeps what the manager prints for this session
//     (Bitwarden's session key, 1Password's session token, or KeePassXC's entries read once), in memory;
//   - she locks it again after the task, after N idle minutes (a setting, default 15), on Stop, when the
//     person turns that manager off, and when the app closes or disconnects;
//   - an entry is used only on a page whose CURRENT origin is exactly the entry's (scheme, host, port:
//     src/hands-logins.ts loginOrigin), first from Sara's own saved logins, then from the managers that are
//     on, in this order: Bitwarden, 1Password, KeePassXC. The device fills the sign-in form itself and tells
//     the server only the outcome: filled / not found / locked (and which manager, by name);
//   - nothing about an entry (title, username, password, address) ever goes back: not in a result, a log
//     line, a picture, an element list or an error message.
//
// The commands used (each manager's documented CLI, run as a client):
//   Bitwarden  bw --version · bw unlock --raw (its own prompt; prints the session key) ·
//              bw list items --url <origin> (BW_SESSION in the environment) · bw lock
//   1Password  op --version · op signin --raw (its own prompt, or the 1Password app's) ·
//              op account list --format json · op item list --categories Login --format json ·
//              op item get <id> --format json --reveal (OP_SESSION_<shorthand> in the environment) · op signout
//   KeePassXC  keepassxc-cli --version · keepassxc-cli export -f csv <database> (its own password prompt;
//              the entries with a web address are kept in memory until it's locked again)
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loginOrigin } from './hands-logins.ts';

export const MANAGERS = [
  { id: 'bitwarden', name: 'Bitwarden', cli: 'bw' },
  { id: '1password', name: '1Password', cli: 'op' },
  { id: 'keepassxc', name: 'KeePassXC', cli: 'keepassxc-cli' },
] as const;
export type ManagerId = (typeof MANAGERS)[number]['id'];
export const MANAGER_IDS: readonly ManagerId[] = MANAGERS.map((m) => m.id);
export const managerName = (id: string): string => MANAGERS.find((m) => m.id === id)?.name ?? id;

/** The warning shown on the computer before a manager is turned on ({manager}, {minutes}). */
export const MANAGER_WARNING =
  'Turning this on lets Sara ask {manager} for the login of the exact site open in her browser on this computer, and fill it in there. You unlock {manager} yourself, in its own window: Sara never sees or keeps your master password, and your passwords never leave this computer. While it is unlocked, Sara can use any of its logins on their own sites (each sign-in still asks you first). She locks it again after the task, after {minutes} idle minutes, on Stop, and when you turn this off.';
/** "Lock again after … idle minutes" choices (the default is 15). */
export const RELOCK_MINUTES = [5, 15, 30, 60] as const;
export const DEFAULT_RELOCK_MINUTES = 15;
/** At most this many unlock prompts per manager in 10 minutes (a server can't fill the screen with them). */
export const UNLOCK_PROMPTS_PER_10_MIN = 3;

export type ManagerState = 'off' | 'missing' | 'locked' | 'unlocked';
/** What may leave the computer about a manager. Never an entry, never a session. */
export interface ManagerView {
  id: ManagerId;
  name: string;
  installed: boolean;
  on: boolean;
  state: ManagerState;
}

/** The server's cut of a device's managers: known ids, booleans and the state word only. */
export function managerViews(raw: unknown): ManagerView[] {
  if (!Array.isArray(raw)) return [];
  const out: ManagerView[] = [];
  for (const x of raw.slice(0, 8)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = MANAGER_IDS.find((m) => m === o.id);
    if (!id || out.some((v) => v.id === id)) continue;
    const installed = o.installed === true;
    const on = o.on === true && installed;
    const st = String(o.state ?? '');
    const state: ManagerState = !installed ? 'missing' : !on ? 'off' : st === 'unlocked' ? 'unlocked' : 'locked';
    out.push({ id, name: managerName(id), installed, on, state });
  }
  return out;
}

export const relockMinutes = (n: unknown): number => {
  const v = Number(n);
  return (RELOCK_MINUTES as readonly number[]).includes(v) ? v : DEFAULT_RELOCK_MINUTES;
};

// ---- entries (memory only, on the computer) ----
export interface ManagerEntry {
  title: string;
  urls: string[];
  username: string;
  password: string;
}

/** An entry's address as an origin; managers store some without a scheme (\"github.com\"): those mean https. */
export function entryOrigin(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return loginOrigin(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
}

/**
 * The entry for the page's CURRENT origin (exactly: scheme, host and port), or undefined. With several,
 * the one whose title is `name` (case does not matter) wins, else the first.
 */
export function pickEntry(entries: ManagerEntry[], pageUrl: string, name = ''): ManagerEntry | undefined {
  const o = loginOrigin(pageUrl);
  if (!o) return undefined;
  const hits = entries.filter((e) => e.password && e.urls.some((u) => entryOrigin(u) === o));
  const want = name.trim().toLowerCase();
  return hits.find((e) => want && e.title.trim().toLowerCase() === want) ?? hits[0];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** `bw list items` output (a JSON array; type 1 = login). */
export function parseBwItems(json: string): ManagerEntry[] {
  let a: unknown;
  try {
    a = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(a)) return [];
  const out: ManagerEntry[] = [];
  for (const it of a.slice(0, 500)) {
    const o = (it ?? {}) as Record<string, any>;
    if (o.type !== 1 || !o.login || typeof o.login !== 'object') continue;
    const uris = Array.isArray(o.login.uris) ? (o.login.uris as Record<string, unknown>[]).map((u) => str(u?.uri)).filter(Boolean) : [];
    out.push({ title: str(o.name), urls: uris, username: str(o.login.username), password: str(o.login.password) });
  }
  return out;
}

/** `op item list --categories Login --format json`: ids, titles and addresses (no secrets in it). */
export function parseOpList(json: string): { id: string; title: string; urls: string[] }[] {
  let a: unknown;
  try {
    a = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(a)) return [];
  return a.slice(0, 1000).map((it) => {
    const o = (it ?? {}) as Record<string, any>;
    const urls = Array.isArray(o.urls) ? (o.urls as Record<string, unknown>[]).map((u) => str(u?.href)).filter(Boolean) : [];
    return { id: str(o.id), title: str(o.title), urls };
  }).filter((x) => /^[A-Za-z0-9]{1,64}$/.test(x.id));
}

/** `op item get <id> --format json --reveal`: the username and password fields (by purpose). */
export function parseOpItem(json: string): { username: string; password: string } {
  let o: Record<string, any>;
  try {
    o = JSON.parse(json) as Record<string, any>;
  } catch {
    return { username: '', password: '' };
  }
  const fields = Array.isArray(o?.fields) ? (o.fields as Record<string, unknown>[]) : [];
  const by = (purpose: string, id: string) => fields.find((f) => f?.purpose === purpose) ?? fields.find((f) => f?.id === id);
  return { username: str(by('USERNAME', 'username')?.value), password: str(by('PASSWORD', 'password')?.value) };
}

/** RFC 4180 CSV (quoted fields, \"\" inside quotes, line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

/** `keepassxc-cli export -f csv`: entries with a web address only (the rest is dropped at once). */
export function parseKpxCsv(text: string): ManagerEntry[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const [t, u, p, w] = [col('title'), col('username'), col('password'), col('url')];
  if (t < 0 || p < 0 || w < 0) return [];
  const out: ManagerEntry[] = [];
  for (const r of rows.slice(0, 5000)) {
    const url = r[w] ?? '';
    if (!entryOrigin(url)) continue;
    out.push({ title: r[t] ?? '', urls: [url], username: u >= 0 ? (r[u] ?? '') : '', password: r[p] ?? '' });
  }
  return out;
}

// ---- the reference client (src/hands-ref.ts; the apps do the same natively) ----

/** The manager's own prompt: shows the person `command args` in a window of its own and gives back what it printed. */
export interface PromptRequest {
  manager: ManagerId;
  /** \"Unlock Bitwarden for Sara: sign in to http://… (close this window to say no)\" */
  title: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
export type ManagerPrompt = (req: PromptRequest) => Promise<{ stdout: string; code: number }>;

export interface ManagerOptions {
  /** Where to look for the CLIs (test runs: only the test doubles' folder). Default: PATH. */
  search?: string[];
  /** Which managers the person turned on (after the warning). */
  on?: ManagerId[];
  /** KeePassXC: the database the person picked. */
  keepassDb?: string;
  /** \"Lock again after … idle minutes\" (default 15). */
  relockMinutes?: number;
  /** Tests: the idle time in milliseconds instead. */
  relockMs?: number;
  /** The manager's own prompt (tests: a stand-in that types as the person). */
  prompt?: ManagerPrompt;
  /** Extra environment for the CLIs (test runs: their config folders in scratch). */
  env?: NodeJS.ProcessEnv;
  /** A state changed (locked, unlocked, on, off): the device tells the server. */
  onChange?: () => void;
  log?: (line: string) => void;
}

interface Session {
  /** Bitwarden: the session key; 1Password: the session token ('' with the app's own integration). */
  key?: string;
  /** 1Password: the account's shorthand (OP_SESSION_<shorthand>). */
  account?: string;
  /** KeePassXC: the entries read at unlock. */
  entries?: ManagerEntry[];
  at: number;
}

export class ManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isWin = process.platform === 'win32';

/** Runs a CLI (no window, no stdin), with a time limit; stdout and the exit code. */
export function runCli(file: string, args: string[], env: NodeJS.ProcessEnv, ms = 20_000, input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const [cmd, argv, verbatim] = commandLine(file, args);
    const child = spawn(cmd, argv, { env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => child.kill(), ms);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (out = (out + d).slice(-8 * 1024 * 1024)));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-64 * 1024)));
    if (input !== undefined) child.stdin!.end(input);
    child.on('error', () => {
      clearTimeout(t);
      resolve({ stdout: '', stderr: 'could not start', code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ stdout: out, stderr: err, code: code ?? -1 });
    });
  });
}

/** A `.cmd` launcher (npm installs `bw.cmd`; the test doubles too) runs through cmd.exe with checked arguments. */
export function commandLine(file: string, args: string[]): [string, string[], boolean] {
  if (isWin && /\.(cmd|bat)$/i.test(file)) {
    for (const a of [file, ...args]) if (/["%&|<>^\r\n]/.test(a)) throw new ManagerError('denied_local', 'That argument can\u2019t be passed safely.');
    const quote = (a: string) => (/[\s]/.test(a) || !a ? `"${a}"` : a);
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], true];
  }
  return [file, args, false];
}

/** Finds a CLI in these folders (Windows: .exe, then .cmd). */
export function findCli(name: string, dirs: string[]): string {
  const names = isWin ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = join(d, n);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* not there */
      }
    }
  }
  return '';
}

/** One computer's password managers: found, on or off, locked or unlocked (memory only). */
export class ManagerSessions {
  readonly opts: ManagerOptions;
  readonly #found = new Map<ManagerId, string>();
  readonly #on = new Set<ManagerId>();
  readonly #sessions = new Map<ManagerId, Session>();
  readonly #prompts = new Map<ManagerId, number[]>();
  #lastUse = 0;
  #timer?: NodeJS.Timeout;
  #detected = false;
  /** Tests: every CLI command line run (no secrets are ever in one). */
  readonly ran: string[] = [];

  constructor(opts: ManagerOptions = {}) {
    this.opts = opts;
    for (const id of opts.on ?? []) this.#on.add(id);
  }

  get relockMs(): number {
    return this.opts.relockMs ?? relockMinutes(this.opts.relockMinutes) * 60_000;
  }

  #env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...(this.opts.env ?? {}), ...extra };
  }

  /** Looks for each CLI and asks it `--version` (nothing else). */
  async detect(): Promise<void> {
    const dirs = this.opts.search ?? String(process.env.PATH ?? '').split(isWin ? ';' : ':');
    for (const m of MANAGERS) {
      const file = findCli(m.cli, dirs);
      if (!file) {
        this.#found.delete(m.id);
        continue;
      }
      this.ran.push(`${m.cli} --version`);
      const r = await runCli(file, ['--version'], this.#env(), 8000);
      if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) this.#found.set(m.id, file);
      else this.#found.delete(m.id);
    }
    this.#detected = true;
  }

  views(): ManagerView[] {
    return MANAGERS.map((m) => {
      const installed = this.#found.has(m.id);
      const on = installed && this.#on.has(m.id);
      return { id: m.id, name: m.name, installed, on, state: !installed ? 'missing' : !on ? 'off' : this.#sessions.has(m.id) ? 'unlocked' : 'locked' };
    });
  }

  get detected(): boolean {
    return this.#detected;
  }

  /** On / off in the app (after the warning). Off forgets (and locks) its session at once. */
  async setOn(id: ManagerId, on: boolean): Promise<void> {
    if (on) this.#on.add(id);
    else {
      this.#on.delete(id);
      await this.lock(id, 'turned off');
    }
    this.opts.onChange?.();
  }

  setKeepassDb(path: string): void {
    this.opts.keepassDb = path;
  }

  isOn(id: ManagerId): boolean {
    return this.#on.has(id) && this.#found.has(id);
  }

  unlocked(id: ManagerId): boolean {
    return this.#sessions.has(id);
  }

  /** The managers that are on, in the lookup order. */
  active(): ManagerId[] {
    return MANAGER_IDS.filter((id) => this.isOn(id));
  }

  /**
   * The person unlocks it in its own prompt (never Sara). Resolves true when it is unlocked for Sara.
   * Throws ManagerError for: off, missing, too many prompts, no window to show the prompt in.
   */
  async unlock(id: ManagerId, site: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.isOn(id)) throw new ManagerError('denied_local', `${managerName(id)} is off for Sara on this computer (the owner turns it on in the Sara app there).`);
    if (this.#sessions.has(id)) return true;
    if (!this.opts.prompt) throw new ManagerError('perm_missing', `This computer has no window to show ${managerName(id)}\u2019s own unlock prompt in.`);
    if (id === 'keepassxc' && !this.opts.keepassDb) throw new ManagerError('not_found', 'No KeePassXC database was chosen for Sara in the Sara app on this computer.');
    const now = Date.now();
    const recent = (this.#prompts.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= UNLOCK_PROMPTS_PER_10_MIN) throw new ManagerError('rate_limited', `${managerName(id)}\u2019s unlock window was shown ${UNLOCK_PROMPTS_PER_10_MIN} times in 10 minutes: wait a little.`);
    this.#prompts.set(id, [...recent, now]);
    const file = this.#found.get(id)!;
    const title = `Unlock ${managerName(id)} for Sara: sign in to ${loginOrigin(site) || 'a site'} (close this window to say no)`;
    const args = id === 'bitwarden' ? ['unlock', '--raw'] : id === '1password' ? ['signin', '--raw'] : ['export', '-f', 'csv', this.opts.keepassDb!];
    this.ran.push(`${managerName(id)}: ${id === 'keepassxc' ? 'keepassxc-cli export -f csv <database>' : `${id === 'bitwarden' ? 'bw' : 'op'} ${args.join(' ')}`} (its own prompt)`);
    const shown = this.opts.prompt({ manager: id, title, command: file, args, env: this.#env() });
    const r = await (signal ? Promise.race([shown, new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new ManagerError('stopped', 'Stopped.')), { once: true }))]) : shown);
    let out = r.stdout;
    try {
      if (r.code !== 0) return false;
      if (id === 'bitwarden') {
        const key = out.trim();
        if (!/^[A-Za-z0-9+/=_-]{16,512}$/.test(key)) return false;
        this.#sessions.set(id, { key, at: Date.now() });
      } else if (id === '1password') {
        const token = out.trim();
        if (token && !/^[A-Za-z0-9_-]{8,512}$/.test(token)) return false;
        this.ran.push('op account list --format json');
        const acc = await runCli(file, ['account', 'list', '--format', 'json'], this.#env(), 15_000);
        let account = '';
        try {
          const list = JSON.parse(acc.stdout) as Record<string, unknown>[];
          account = String(list?.[0]?.shorthand ?? list?.[0]?.user_uuid ?? '');
        } catch {
          /* no accounts */
        }
        if (!/^[A-Za-z0-9_]{1,64}$/.test(account)) return false;
        const s: Session = { key: token, account, at: Date.now() };
        this.ran.push('op whoami --format json');
        const who = await runCli(file, ['whoami', '--format', 'json'], this.#opEnv(s), 15_000);
        if (who.code !== 0) return false;
        this.#sessions.set(id, s);
      } else {
        const entries = parseKpxCsv(out);
        this.#sessions.set(id, { entries, at: Date.now() });
      }
    } finally {
      out = '';
    }
    this.#touch();
    this.opts.log?.(`${managerName(id)} unlocked for Sara by the person at the computer`);
    this.opts.onChange?.();
    return true;
  }

  #opEnv(s: Session): NodeJS.ProcessEnv {
    return this.#env(s.key ? { [`OP_SESSION_${s.account}`]: s.key } : {});
  }

  /**
   * The entry for this page's exact origin from the managers that are on and unlocked, in order.
   * `locked`: managers that are on but locked (asked only when nothing was found in an unlocked one).
   */
  async lookup(pageUrl: string, name = ''): Promise<{ entry?: ManagerEntry; source?: ManagerId; locked: ManagerId[] }> {
    const origin = loginOrigin(pageUrl);
    const locked: ManagerId[] = [];
    if (!origin) return { locked };
    for (const id of this.active()) {
      const s = this.#sessions.get(id);
      if (!s) {
        locked.push(id);
        continue;
      }
      this.#touch();
      const file = this.#found.get(id)!;
      let entries: ManagerEntry[] = [];
      if (id === 'bitwarden') {
        this.ran.push(`bw list items --url ${origin}`);
        const r = await runCli(file, ['list', 'items', '--url', origin], this.#env({ BW_SESSION: s.key }), 30_000);
        if (r.code !== 0) {
          // The session ended on its own (locked elsewhere, timed out): forget it.
          if (/locked|not logged in|session/i.test(r.stderr)) {
            this.#forget(id);
            locked.push(id);
            this.opts.onChange?.();
          }
          continue;
        }
        entries = parseBwItems(r.stdout);
      } else if (id === '1password') {
        this.ran.push('op item list --categories Login --format json');
        const r = await runCli(file, ['item', 'list', '--categories', 'Login', '--format', 'json'], this.#opEnv(s), 30_000);
        if (r.code !== 0) {
          if (/sign ?in|session|authoriz|locked/i.test(r.stderr)) {
            this.#forget(id);
            locked.push(id);
            this.opts.onChange?.();
          }
          continue;
        }
        const want = name.trim().toLowerCase();
        const hits = parseOpList(r.stdout).filter((it) => it.urls.some((u) => entryOrigin(u) === origin));
        const it = hits.find((h) => want && h.title.trim().toLowerCase() === want) ?? hits[0];
        if (!it) continue;
        this.ran.push(`op item get ${it.id} --format json --reveal`);
        const g = await runCli(file, ['item', 'get', it.id, '--format', 'json', '--reveal'], this.#opEnv(s), 30_000);
        if (g.code !== 0) continue;
        const f = parseOpItem(g.stdout);
        entries = [{ title: it.title, urls: it.urls, ...f }];
      } else entries = s.entries ?? [];
      const e = pickEntry(entries, pageUrl, name);
      if (e) return { entry: { ...e, urls: [...e.urls] }, source: id, locked: [] };
    }
    return { locked };
  }

  #touch(): void {
    this.#lastUse = Date.now();
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.#idle(), Math.max(50, Math.min(30_000, Math.floor(this.relockMs / 4))));
      this.#timer.unref?.();
    }
  }

  async #idle(): Promise<void> {
    if (!this.#sessions.size) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      return;
    }
    if (Date.now() - this.#lastUse >= this.relockMs) await this.lockAll('idle');
  }

  #forget(id: ManagerId): void {
    const s = this.#sessions.get(id);
    if (s?.entries) for (const e of s.entries) e.password = '';
    if (s) s.key = '';
    this.#sessions.delete(id);
  }

  /** Locks one manager again (Bitwarden: bw lock; 1Password: op signout; KeePassXC: its entries forgotten). */
  async lock(id: ManagerId, why = ''): Promise<boolean> {
    const s = this.#sessions.get(id);
    if (!s) return false;
    const held: Session = { key: s.key ?? '', ...(s.account ? { account: s.account } : {}), at: s.at };
    this.#forget(id);
    const file = this.#found.get(id);
    if (file && id === 'bitwarden') {
      this.ran.push('bw lock');
      await runCli(file, ['lock'], this.#env({ BW_SESSION: held.key }), 15_000);
    } else if (file && id === '1password') {
      this.ran.push('op signout');
      await runCli(file, ['signout'], this.#opEnv(held), 15_000);
    }
    held.key = '';
    this.opts.log?.(`${managerName(id)} locked again${why ? ` (${why})` : ''}`);
    this.opts.onChange?.();
    return true;
  }

  /** After the task, after N idle minutes, on Stop, on disconnect: every unlocked manager locks again. */
  async lockAll(why = ''): Promise<ManagerId[]> {
    const ids = [...this.#sessions.keys()];
    for (const id of ids) await this.lock(id, why);
    if (!this.#sessions.size && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    return ids;
  }
}
