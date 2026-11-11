// Phase 73: work on the owner's other servers over SSH.
//
// Sara does not speak the SSH protocol herself (zero dependencies, and a home-made SSH client would
// be a security liability). She drives the system OpenSSH client (`ssh`, `ssh-keygen`,
// `ssh-keyscan`; present on Linux, macOS and Windows 10/11) as child processes with an ARGUMENT
// ARRAY, never a shell string, and with a fixed set of safe options (sshOptions below):
//
// - Host keys: trust on first use, shown to the owner as a SHA256 fingerprint to approve. The
//   approved key goes into a per-server known_hosts file in the data folder, bound to the server's
//   id (HostKeyAlias), and every connection runs with StrictHostKeyChecking=yes. A changed host key
//   stops her: the new fingerprint waits for the owner's explicit approval.
// - Her own key per server (ed25519, no passphrase, <data>/ssh/keys/<id>_ed25519, 0600), used with
//   IdentitiesOnly=yes and no agent. Nothing forwarded (agent, X11, ports), no control sockets, no
//   local commands, the owner's ~/.ssh/config is ignored (-F none).
// - Passwords: typed by the owner in Settings (a password box, never the chat), used ONCE through
//   SSH_ASKPASS (a tiny helper that prints a 0600 file it deletes as it reads it; never on the
//   command line, never in the environment, never in logs). Right after that first login she makes
//   her own key, installs it in ~/.ssh/authorized_keys on that server (no duplicates, 700/600) and
//   checks that it works; the password is dropped. It is saved (encrypted in the vault) only when the
//   owner ticks "Save the password" AND confirms the warning.
// - Owner-only: never in household members' spaces, the demo, the OpenAI-compatible API, MCP or any
//   other app's turn (src/chat.ts filters ssh_* tools out of those). Private local mode: only
//   servers on this computer (loopback), like every other connection (src/net-guard.ts).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { writeFileAtomic } from './fs-util.ts';
import { isAbsolute, join } from 'node:path';
import { isLoopbackHost, isPrivateAddress, privateLocalOn } from './net-guard.ts';
import {
  CPANEL_TOKEN, cpanelCall, cpanelPort, defaultLookup, defaultName, deniedMethods, diagnoseRun, diagnosis, diagText, MAX_PORT_TRIES, parseAddress, passwordsAllowed, peekCpanel, PORT_LIST, readGreeting, scrubbed,
  type CpanelHttp, type Diagnosis, type GreetFn, type LookupFn,
} from './ssh-easy.ts';
import { en } from './i18n.ts';
import type { Vault } from './vault.ts';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunOptions {
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stop collecting output past this many bytes per stream (the process keeps running). */
  maxBytes?: number;
}

/** Runs one program with an argument array. Tests inject a fake one. */
export type CommandRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/** The real runner: spawn without a shell, stdin closed (ssh never reads a password from it). */
export const spawnRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 1_000_000;
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: opts.env });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: out, stderr: err, ...(timedOut ? { timedOut } : {}) });
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    };
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    let grace: NodeJS.Timeout | undefined;
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < max) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < max) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      err += e.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // A grandchild holding the pipes open must not keep the call waiting forever.
    child.on('exit', (code) => {
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 3000);
    });
  });

export interface SshServer {
  id: string;
  /** The owner's name for it ("web box"). */
  name: string;
  host: string;
  port: number;
  user: string;
  createdAt: string;
  /** The approved host key (SHA256 fingerprint and the known_hosts key type). */
  fingerprint?: string;
  keyType?: string;
  trustedAt?: string;
  /** A host key seen but not approved yet (first use, or a changed key). */
  pending?: { fingerprint: string; keyType: string; line: string; changed: boolean; seenAt: string };
  /** Her key for this server: made by her (installed by her) or one the owner gave her. */
  key?: { path: string; publicLine: string; source: 'made' | 'imported'; createdAt: string; installedAt?: string };
  /** Whether the owner asked her to keep the password (encrypted in the vault). */
  passwordSaved?: boolean;
  /** How the owner said to sign in when adding it. */
  auth: 'password' | 'key';
  /** The owner asked (in chat, after the warning) to keep the password: the form starts ticked. */
  askedToSavePassword?: boolean;
  /**
   * PL2a (POLISH2 N7): added by *Connect* and not reached yet. It is not listed under Your servers
   * until Sara reached its SSH port (it shows *Not connected yet · Remove* from then on); a draft that
   * never got there is dropped by the next Connect to the same address or by *Cancel*.
   */
  draft?: boolean;
  /** Where to tell the owner about her new key (the conversation that added the server). */
  conversationId?: string;
  lastUsedAt?: string;
  lastError?: string;
  /** 2.52.1: the owner left the port to Sara ("Sara finds it"). */
  portAuto?: boolean;
  /** 2.52.1: what the last look at the server found (nothing secret). */
  probe?: SshProbe;
  /** 2.52.1: how her key got onto the server. */
  connectedVia?: 'cpanel' | 'password' | 'paste' | 'imported';
  /** 3.4.1: `id -u` said 0 on the last test (root under another name): no cPanel token path. */
  uid0?: boolean;
  /** 2.52.1: the cPanel host name the owner accepted for the API (the certificate's name). */
  cpanelHost?: string;
  /** 2.52.1: the last test's diagnosis code and when it ran. */
  lastCheck?: { at: string; code: string; ok: boolean; shell?: string; extraLines?: number };
  /** 2.52.1: what she did with her key there, newest last (receipt lines; never a key or token). */
  history?: { at: string; text: string }[];
}

/** What "Connect" found, kept on the server record (design §2.2, §7). */
export interface SshProbe {
  at: string;
  /** The ports tried, in order, and the one that answered with an SSH greeting. */
  ports: number[];
  port?: number;
  /** The diagnosis when no SSH port was found (DNS, PORT_CLOSED, TIMEOUT, NOT_SSH, PRIVATE_LOCAL). */
  code?: string;
  params?: Record<string, string>;
  /** The sign-in methods the server lists (from "Permission denied (…)"). */
  methods?: string[];
  passwords?: boolean;
  /** cPanel on 2083. */
  cpanel?: { found: boolean; port: number; certOk: boolean; certNames?: string[]; hint?: boolean };
  /** The path Sara recommends: a cPanel token, the password once, copy and paste, or the fix-it screen. */
  recommended: 'cpanel' | 'password' | 'paste' | 'fix';
}

export interface ServerView extends Omit<SshServer, 'pending' | 'key'> {
  pendingFingerprint?: string;
  hostKeyChanged?: boolean;
  keyPath?: string;
  publicKey?: string;
  keySource?: 'made' | 'imported';
  keyInstalledAt?: string;
  keyCreatedAt?: string;
  /** 2.52.1: the one line to paste on the server (her public key into authorized_keys). */
  pasteCommand?: string;
  /** 3.4.1: user root, or uid 0 seen on a test: WHM, not cPanel (no token path). */
  root?: boolean;
  ready: boolean;
}

/** 3.4.1: root signs in to WHM, not cPanel: cPanel API tokens belong to cPanel accounts. */
export const isRootUser = (s: Pick<SshServer, 'user' | 'uid0'>): boolean => s.user === 'root' || s.uid0 === true;

/** The easiest way in (design §2.2): the cPanel token for a cPanel account, else the password once, else copy and paste. */
export function recommendPath(s: Pick<SshServer, 'user' | 'uid0'>, cpanelFound: boolean, passwords: boolean | undefined): SshProbe['recommended'] {
  if (cpanelFound && !isRootUser(s)) return 'cpanel';
  return passwords ? 'password' : 'paste';
}

/** PL2a (N7): a Connect that never reached the server's SSH port (not listed; Cancel removes it). */
const unreached = (s: SshServer): boolean => s.draft === true && !s.fingerprint && !s.pending;

export class SshError extends Error {
  readonly code: string;
  /** 2.52.1: the plain-language diagnosis behind it (web/ssh.js shows it next to the button). */
  readonly diagnosis?: Diagnosis;
  constructor(message: string, code = 'SSH', diagnosis?: Diagnosis) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    if (diagnosis) this.diagnosis = diagnosis;
  }
}

/** A diagnosis as an error (message = title + fix in English). */
const diagError = (d: Diagnosis): SshError => new SshError(diagText(d), d.code, d);

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9A-Fa-f:]+(?:%[\w.-]+)?\]?)$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[^\n\r\t<>]{1,60}$/;
const ID = /^[a-z0-9]{10}$/;
/** A public key line Sara will put between single quotes in a remote command: nothing a shell treats specially. */
// Built from parts so the release scan (scripts/public-export.ts) doesn't take the pattern for a key.
const PK = ['PRIVATE', 'KEY'].join(' ');
const PEM_KEY = new RegExp(`^-----BEGIN (OPENSSH|RSA|EC) ${PK}-----\\n[\\s\\S]+\\n-----END (OPENSSH|RSA|EC) ${PK}-----\\n$`);
const PUBLIC_LINE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9@._:-]{1,120})?$/;
export const VAULT_PREFIX = 'ssh:password:';
export const vaultKeyOf = (id: string) => `${VAULT_PREFIX}${id}`;

/** The warning she gives before keeping a password (also shown next to the checkbox). */
export const SAVE_PASSWORD_WARNING = en(
  'Keeping the password is a security risk: anyone who gets into Sara (or a copy of her data and master key) could sign in to that server with it, everywhere that password works. A key is safer: it only opens this one server for her and you can revoke it any time. Save the password only if you really need it.',
);

export function cleanHost(input: unknown): string {
  const h = String(input ?? '').trim();
  if (!h || h.startsWith('-') || !HOST.test(h)) throw new SshError('Give the server’s name or IP address, like server.example.com or 192.168.1.20.', 'BAD_HOST');
  return h.replace(/^\[|\]$/g, '');
}
export function cleanUser(input: unknown): string {
  const u = String(input ?? '').trim();
  if (!USER.test(u)) throw new SshError('Give the user name to sign in as (letters, digits, . _ -), like deploy or root.', 'BAD_USER');
  return u;
}
export function cleanPort(input: unknown): number {
  const p = input === undefined || input === null || input === '' ? 22 : Number(input);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new SshError('The port is a number from 1 to 65535 (usually 22).', 'BAD_PORT');
  return p;
}

/** The known_hosts key type → the host key algorithms ssh may accept for it (only that key). */
export function hostKeyAlgorithms(keyType: string): string {
  if (keyType === 'ssh-rsa') return 'rsa-sha2-512,rsa-sha2-256';
  if (/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521))$/.test(keyType)) return keyType;
  throw new SshError(`Unsupported host key type ${keyType}.`, 'BAD_HOSTKEY');
}

/** The comment on her keys: sara@<instance>-<date>. */
export function keyComment(instance: string, now: Date): string {
  const safe = instance.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'sara';
  return `sara@${safe}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

/** Single-quoted for a POSIX shell (only used for public key lines that PUBLIC_LINE allows). */
function q(line: string): string {
  if (!PUBLIC_LINE.test(line)) throw new SshError('That public key line has unexpected characters.', 'BAD_KEY');
  return `'${line}'`;
}

/** The remote command that adds her public key to ~/.ssh/authorized_keys: once, with 700/600. */
export function installScript(line: string): string {
  const L = q(line);
  return [
    'umask 077',
    'd="$HOME/.ssh"; f="$d/authorized_keys"',
    'mkdir -p "$d" && chmod 700 "$d" && touch "$f" && chmod 600 "$f" || { echo sara-key-failed; exit 3; }',
    `if grep -qxF ${L} "$f"; then echo sara-key-present; else if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi; echo ${L} >> "$f" && echo sara-key-added; fi`,
  ].join('; ');
}

/** The remote command that removes exactly her line (and nothing else) from authorized_keys. */
export function revokeScript(line: string): string {
  const L = q(line);
  return [
    'umask 077',
    'f="$HOME/.ssh/authorized_keys"',
    '[ -f "$f" ] || { echo sara-key-gone; exit 0; }',
    `if grep -qxF ${L} "$f"; then t="$f.sara-$$"; grep -vxF ${L} "$f" > "$t"; cat "$t" > "$f" && rm -f "$t" && echo sara-key-removed; else echo sara-key-gone; fi`,
  ].join('; ');
}

/** Parses `ssh-keygen -lf` output: "256 SHA256:abc… host (ED25519)". */
export function parseFingerprint(out: string): string | undefined {
  return /\bSHA256:[A-Za-z0-9+/]{43}=?/.exec(out)?.[0];
}

/** Picks the best host key line from `ssh-keyscan` output (ed25519, then ecdsa, then rsa). */
export function pickHostKey(out: string): { keyType: string; key: string } | undefined {
  const keys = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 3 && /^[A-Za-z0-9+/]+={0,3}$/.test(p[2]))
    .map((p) => ({ keyType: p[1], key: p[2] }));
  const rank = (t: string) => (t === 'ssh-ed25519' ? 0 : t.startsWith('ecdsa-') ? 1 : t === 'ssh-rsa' ? 2 : 9);
  return keys.filter((k) => rank(k.keyType) < 9).sort((a, b) => rank(a.keyType) - rank(b.keyType))[0];
}

const HOSTKEY_FAIL = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed|No (?:ED25519|ECDSA|RSA)? ?host key is known/i;
const AUTH_FAIL = /Permission denied|Too many authentication failures|no supported authentication methods/i;

export interface SshDeps {
  /** The owner's space folder (<data>); everything lives in <data>/ssh. */
  dir: string;
  vault: Vault;
  run?: CommandRunner;
  now?: () => Date;
  /** Instance name for key comments (SARA_INSTANCE, default "sara"). */
  instance?: string;
  /** Program names or paths (default: ssh, ssh-keygen, ssh-keyscan from PATH). */
  bins?: { ssh?: string; keygen?: string; keyscan?: string };
  platform?: NodeJS.Platform;
  /** Private local mode (defaults to the process-wide switch). */
  privateLocal?: () => boolean;
  /** 2.52.1, tests: the port greeting read, the DNS lookup and the cPanel HTTPS calls. */
  greet?: GreetFn;
  lookup?: LookupFn;
  cpanel?: CpanelHttp;
  /** Per-port connect limit for the greeting read (default 4 s). */
  greetTimeoutMs?: number;
}

/** The owner's SSH servers, her keys and host keys. One per owner space. */
export class SshManager {
  readonly #dir: string;
  readonly #vault: Vault;
  readonly #run: CommandRunner;
  readonly #now: () => Date;
  readonly #instance: string;
  readonly #bins: { ssh: string; keygen: string; keyscan: string };
  readonly #platform: NodeJS.Platform;
  readonly #privateLocal: () => boolean;
  readonly #greet: GreetFn;
  readonly #lookup: LookupFn;
  readonly #cpanel: CpanelHttp;
  readonly #greetMs: number;
  #servers: SshServer[];

  constructor(deps: SshDeps) {
    this.#dir = join(deps.dir, 'ssh');
    this.#vault = deps.vault;
    this.#run = deps.run ?? spawnRunner;
    this.#now = deps.now ?? (() => new Date());
    this.#instance = deps.instance ?? (process.env.SARA_INSTANCE?.trim() || 'sara');
    this.#bins = { ssh: deps.bins?.ssh ?? 'ssh', keygen: deps.bins?.keygen ?? 'ssh-keygen', keyscan: deps.bins?.keyscan ?? 'ssh-keyscan' };
    this.#platform = deps.platform ?? process.platform;
    this.#privateLocal = deps.privateLocal ?? privateLocalOn;
    this.#greet = deps.greet ?? readGreeting;
    this.#lookup = deps.lookup ?? defaultLookup;
    this.#cpanel = deps.cpanel ?? {};
    this.#greetMs = deps.greetTimeoutMs ?? 4000;
    this.#servers = this.#load();
  }

  get dir(): string {
    return this.#dir;
  }

  #file(): string {
    return join(this.#dir, 'servers.json');
  }
  #load(): SshServer[] {
    try {
      const raw = JSON.parse(readFileSync(this.#file(), 'utf8')) as { servers?: SshServer[] };
      return Array.isArray(raw.servers) ? raw.servers.filter((s) => s && ID.test(s.id)) : [];
    } catch {
      return [];
    }
  }
  #mk(sub = ''): string {
    const d = sub ? join(this.#dir, sub) : this.#dir;
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
    return d;
  }
  #save(): void {
    this.#mk();
    writeFileAtomic(this.#file(), JSON.stringify({ servers: this.#servers }, null, 2), 0o600);
  }
  knownHostsFile(id: string): string {
    return join(this.#dir, 'known_hosts', id);
  }
  keyFile(id: string, source: 'made' | 'imported' = 'made'): string {
    return join(this.#dir, 'keys', source === 'made' ? `${id}_ed25519` : `${id}_imported`);
  }

  list(): SshServer[] {
    return this.#servers.map((s) => ({ ...s }));
  }
  view(s: SshServer): ServerView {
    const { pending, key, ...rest } = s;
    return {
      ...rest,
      passwordSaved: this.#vault.has(vaultKeyOf(s.id)),
      ...(pending ? { pendingFingerprint: pending.fingerprint, hostKeyChanged: pending.changed } : {}),
      ...(isRootUser(s) ? { root: true } : {}),
      ...(key ? { keyPath: key.path, publicKey: key.publicLine, keySource: key.source, keyCreatedAt: key.createdAt, ...(key.installedAt ? { keyInstalledAt: key.installedAt } : {}), ...(key.source === 'made' && PUBLIC_LINE.test(key.publicLine) ? { pasteCommand: pasteCommand(key.publicLine) } : {}) } : {}),
      // Her key counts once it is on the server (made keys are made before any sign-in now).
      ready: Boolean(s.fingerprint && !pending && ((key && (key.source === 'imported' || key.installedAt)) || this.#vault.has(vaultKeyOf(s.id)))),
    };
  }
  views(): ServerView[] {
    return this.#servers.filter((s) => !unreached(s)).map((s) => this.view(s));
  }

  /** A server by id or by the owner's name for it (case-insensitive), or host / user@host. */
  find(ref: string): SshServer | undefined {
    const r = String(ref ?? '').trim().toLowerCase();
    if (!r) return undefined;
    return (
      this.#servers.find((s) => s.id === r) ??
      this.#servers.find((s) => s.name.toLowerCase() === r) ??
      this.#servers.find((s) => `${s.user}@${s.host}`.toLowerCase() === r || `${s.user}@${s.host}:${s.port}`.toLowerCase() === r) ??
      (this.#servers.filter((s) => s.host.toLowerCase() === r).length === 1 ? this.#servers.find((s) => s.host.toLowerCase() === r) : undefined)
    );
  }
  get(id: string): SshServer {
    const s = this.#servers.find((x) => x.id === id);
    if (!s) throw new SshError('There is no such server.', 'NOT_FOUND');
    return s;
  }
  #update(id: string, patch: Partial<SshServer>): SshServer {
    const s = this.get(id);
    Object.assign(s, patch);
    for (const k of Object.keys(patch) as (keyof SshServer)[]) if (patch[k] === undefined) delete s[k];
    this.#save();
    return s;
  }

  /** Private local mode lets her reach only this computer. */
  #checkReach(host: string): void {
    if (this.#privateLocal() && !isLoopbackHost(host)) {
      throw new SshError(`Blocked by private local mode: ${host} is not on this computer. While "Nothing leaves this computer" is on, Sara only connects to this computer.`, 'PRIVATE_LOCAL');
    }
  }

  #baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    // A small, known environment: no SSH_AUTH_SOCK (no agent), no DISPLAY tricks, nothing secret.
    const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER', 'LOGNAME', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramData', 'ALLUSERSPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'ComSpec', 'PATHEXT'];
    const env: Record<string, string> = {};
    for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
    return { ...env, ...extra };
  }

  /** The options every ssh call gets (see the top of this file). */
  sshOptions(s: SshServer, mode: 'key' | 'password', keyPath?: string, logLevel: 'ERROR' | 'VERBOSE' = 'ERROR'): string[] {
    if (!s.fingerprint || !s.keyType) throw new SshError('Approve this server’s host key first.', 'NO_HOSTKEY');
    const o = (k: string, v: string) => ['-o', `${k}=${v}`];
    return [
      '-F', 'none',
      '-T',
      ...o('BatchMode', mode === 'key' ? 'yes' : 'no'),
      ...o('StrictHostKeyChecking', 'yes'),
      ...o('UserKnownHostsFile', this.knownHostsFile(s.id)),
      ...o('GlobalKnownHostsFile', this.knownHostsFile(s.id)),
      ...o('HostKeyAlias', `sara-${s.id}`),
      ...o('HostKeyAlgorithms', hostKeyAlgorithms(s.keyType)),
      ...o('UpdateHostKeys', 'no'),
      ...o('CheckHostIP', 'no'),
      ...o('IdentitiesOnly', 'yes'),
      ...o('IdentityAgent', 'none'),
      ...(mode === 'key' && keyPath
        ? ['-i', keyPath, ...o('PubkeyAuthentication', 'yes'), ...o('PasswordAuthentication', 'no'), ...o('KbdInteractiveAuthentication', 'no'), ...o('PreferredAuthentications', 'publickey')]
        : [...o('IdentityFile', 'none'), ...o('PubkeyAuthentication', 'no'), ...o('PasswordAuthentication', 'yes'), ...o('KbdInteractiveAuthentication', 'yes'), ...o('PreferredAuthentications', 'password,keyboard-interactive'), ...o('NumberOfPasswordPrompts', '1')]),
      ...o('ConnectTimeout', '15'),
      ...o('ServerAliveInterval', '15'),
      ...o('ServerAliveCountMax', '3'),
      ...o('ForwardAgent', 'no'),
      ...o('ForwardX11', 'no'),
      ...o('ClearAllForwardings', 'yes'),
      ...o('ControlMaster', 'no'),
      ...o('ControlPath', 'none'),
      ...o('PermitLocalCommand', 'no'),
      ...o('LogLevel', logLevel),
      '-p', String(s.port),
      '-l', s.user,
      '--',
      s.host,
    ];
  }

  /** Adds a server (or returns the same one again) and reads its host key for the owner to approve. */
  async add(input: { name?: unknown; host: unknown; port?: unknown; user: unknown; auth?: unknown; conversationId?: string; askedToSavePassword?: boolean; scan?: boolean }): Promise<SshServer> {
    const host = cleanHost(input.host);
    const user = cleanUser(input.user);
    const portAuto = input.scan === false && (input.port === undefined || input.port === null || input.port === '');
    const port = cleanPort(input.port);
    let name = String(input.name ?? '').trim() || (input.scan === false ? defaultName(host) : host);
    if (!NAME.test(name)) throw new SshError('Give the server a short name (up to 60 characters).', 'BAD_NAME');
    this.#checkReach(host);
    const same = this.#servers.find((s) => s.host.toLowerCase() === host.toLowerCase() && s.user === user && (s.port === port || portAuto));
    if (same) {
      if (input.conversationId) same.conversationId = input.conversationId;
      if (input.askedToSavePassword) same.askedToSavePassword = true;
      this.#save();
      if (input.scan !== false && (!same.fingerprint || same.pending)) await this.scan(same.id);
      return this.get(same.id);
    }
    // "Connect": the default name may be taken already (two servers at example.com): add a number.
    if (input.scan === false && !String(input.name ?? '').trim()) {
      const base = name;
      for (let i = 2; this.#servers.some((s) => s.name.toLowerCase() === name.toLowerCase()) && i < 60; i++) name = `${base} ${i}`;
    }
    if (this.#servers.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new SshError(`There is already a server called "${name}". Pick another name.`, 'DUPLICATE');
    if (this.#servers.length >= 50) throw new SshError('That is a lot of servers: remove one first (up to 50).', 'TOO_MANY');
    const s: SshServer = {
      id: randomBytes(8).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, '0'),
      name,
      host,
      port,
      user,
      auth: input.auth === 'key' ? 'key' : 'password',
      createdAt: this.#now().toISOString(),
      ...(portAuto ? { portAuto: true } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.askedToSavePassword ? { askedToSavePassword: true } : {}),
    };
    this.#servers.push(s);
    this.#save();
    if (input.scan === false) return this.get(s.id);
    try {
      await this.scan(s.id);
    } catch (err) {
      this.#update(s.id, { lastError: (err as Error).message });
    }
    return this.get(s.id);
  }

  /** Reads the server's host key now (ssh-keyscan), with its SHA256 fingerprint (ssh-keygen -lf). */
  async scan(id: string): Promise<SshServer> {
    const s = this.get(id);
    this.#checkReach(s.host);
    const r = await this.#run(this.#bins.keyscan, ['-T', '10', '-p', String(s.port), '-t', 'ed25519,ecdsa,rsa', '--', s.host], { env: this.#baseEnv(), timeoutMs: 20_000 });
    const picked = pickHostKey(r.stdout);
    if (!picked) throw new SshError(`Couldn’t read the host key of ${s.host}:${s.port}. Is the server on, and is SSH running on that port?${r.stderr.trim() ? ` (${r.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 200)})` : ''}`, 'SCAN_FAILED');
    const fp = await this.fingerprintOf(`sara-${s.id} ${picked.keyType} ${picked.key}`);
    if (s.fingerprint && s.fingerprint === fp && s.keyType === picked.keyType) {
      return this.#update(id, { pending: undefined, lastError: undefined });
    }
    return this.#update(id, { pending: { fingerprint: fp, keyType: picked.keyType, line: `sara-${s.id} ${picked.keyType} ${picked.key}`, changed: Boolean(s.fingerprint), seenAt: this.#now().toISOString() }, lastError: undefined });
  }

  async fingerprintOf(knownHostsLine: string): Promise<string> {
    const tmp = this.#tempDir();
    try {
      const f = join(tmp, 'k');
      writeFileSync(f, `${knownHostsLine}\n`, { mode: 0o600 });
      const r = await this.#run(this.#bins.keygen, ['-l', '-E', 'sha256', '-f', f], { env: this.#baseEnv(), timeoutMs: 15_000 });
      const fp = parseFingerprint(r.stdout);
      if (!fp) throw new SshError('Couldn’t work out the host key’s fingerprint (is ssh-keygen installed?).', 'NO_KEYGEN');
      return fp;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The owner approved the fingerprint he saw: remember exactly that key. */
  trust(id: string, fingerprint: string): SshServer {
    const s = this.get(id);
    if (!s.pending) throw new SshError('There is no new host key waiting for approval. Check it again first.', 'NO_PENDING');
    if (String(fingerprint ?? '').trim() !== s.pending.fingerprint) throw new SshError('That fingerprint doesn’t match the one waiting for approval. Check the host key again.', 'FP_MISMATCH');
    this.#mk('known_hosts');
    writeFileSync(this.knownHostsFile(id), `${s.pending.line}\n`, { mode: 0o600 });
    return this.#update(id, { fingerprint: s.pending.fingerprint, keyType: s.pending.keyType, trustedAt: this.#now().toISOString(), pending: undefined, lastError: undefined });
  }

  #tempDir(): string {
    const base = this.#mk('tmp');
    const d = mkdtempSync(join(base, 'r-'));
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
    return d;
  }

  /** Windows: ssh refuses private keys others can read; take the inherited permissions away. */
  async #lockDown(file: string): Promise<void> {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    if (this.#platform !== 'win32') return;
    const who = process.env.USERNAME;
    if (!who) return;
    await this.#run('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], { env: this.#baseEnv(), timeoutMs: 15_000 }).catch(() => undefined);
  }

  /**
   * Makes the SSH_ASKPASS helper for one login: a 0700 folder holding the password in a 0600 file
   * and a script that prints it and deletes it. Returns the env for ssh and a cleanup.
   */
  #askpass(password: Buffer): { env: Record<string, string>; cleanup: () => void } {
    const d = this.#tempDir();
    const pw = join(d, 'p');
    writeFileSync(pw, password, { mode: 0o600 });
    let helper: string;
    if (this.#platform === 'win32') {
      helper = join(d, 'askpass.cmd');
      writeFileSync(helper, `@type "${pw}"\r\n@del /q "${pw}" >nul 2>&1\r\n`, { mode: 0o700 });
    } else {
      helper = join(d, 'askpass.sh');
      writeFileSync(helper, `#!/bin/sh\ncat '${pw.replace(/'/g, `'\\''`)}'\nrm -f '${pw.replace(/'/g, `'\\''`)}'\n`, { mode: 0o700 });
      chmodSync(helper, 0o700);
    }
    return {
      env: { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'sara:0' },
      cleanup: () => rmSync(d, { recursive: true, force: true, maxRetries: 3 }),
    };
  }

  #explain(s: SshServer, r: RunResult, scrub: string[] = [], mode: 'password' | 'key' | 'test' = 'key'): string {
    let text = `${r.stderr}`.trim();
    for (const x of scrub) if (x) text = text.split(x).join('[REDACTED]');
    if (HOSTKEY_FAIL.test(text)) return `The host key of ${s.name} (${s.host}) is not the one you approved. I stopped and didn’t sign in. Check it in Settings → Coding → Servers over SSH before trusting a new one.`;
    const d = this.diagnose(s, r, { mode, secrets: scrub });
    if (d && d.code !== 'UNKNOWN') return diagText(d);
    if (AUTH_FAIL.test(text)) return `${s.name} refused the sign-in for ${s.user}.`;
    if (r.timedOut) return `${s.name} didn’t answer in time.`;
    return text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400) || `ssh ended with exit code ${r.code ?? 'none'}.`;
  }

  /** design §4.1: one ssh run → a plain-language diagnosis (undefined when nothing went wrong). */
  diagnose(s: SshServer, r: RunResult, o: { mode: 'password' | 'key' | 'methods' | 'test'; secrets?: string[] }): Diagnosis | undefined {
    const pw = this.#vault.get(vaultKeyOf(s.id));
    return diagnoseRun(r, { mode: o.mode, host: s.host, port: s.port, user: s.user, name: s.name, secrets: [...(o.secrets ?? []), ...(pw ? [pw] : [])], ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}), ...(s.pending ? { pending: s.pending.fingerprint } : {}) });
  }

  /** A receipt line on the card ("Installed Sara's key on example.com through cPanel"): never a key or token. */
  #note(id: string, text: string): void {
    const s = this.get(id);
    this.#update(id, { history: [...(s.history ?? []), { at: this.#now().toISOString(), text }].slice(-10) });
  }

  async #hostKeyChanged(s: SshServer): Promise<void> {
    // Read what the server shows now, for the owner to compare; never trust it on her own.
    await this.scan(s.id).catch(() => undefined);
    this.#update(s.id, { lastError: 'The host key changed.' });
  }

  /**
   * The first sign-in with a password: makes her own key, installs it on the server, checks that it
   * works, and keeps the password only when the owner asked AND confirmed the warning.
   */
  async loginWithPassword(id: string, password: string | Buffer, opts: { savePassword?: boolean; confirmRisk?: boolean } = {}): Promise<{ server: SshServer; announcement: string; keyPath: string; publicLine: string; passwordSaved: boolean }> {
    const s = this.get(id);
    this.#checkReach(s.host);
    const pwBuf = Buffer.isBuffer(password) ? Buffer.from(password) : Buffer.from(String(password ?? ''), 'utf8');
    try {
      if (!pwBuf.length || pwBuf.length > 1024 || pwBuf.includes(0x0a) || pwBuf.includes(0x0d) || pwBuf.includes(0)) throw new SshError('Type the password (one line).', 'BAD_PASSWORD');
      if (opts.savePassword && !opts.confirmRisk) throw new SshError('To keep the password, confirm that you understand the risk.', 'CONFIRM_RISK');
      this.sshOptions(s, 'password'); // the host key must be approved before anything else
      // Her own key for this server: made once (at Connect, or now) and kept until the owner replaces it.
      const { path, publicLine } = await this.ensureKey(id);
      const ask = this.#askpass(pwBuf);
      let r: RunResult;
      const pwText = pwBuf.toString('utf8');
      try {
        r = await this.#run(this.#bins.ssh, [...this.sshOptions(s, 'password'), installScript(publicLine)], { env: this.#baseEnv(ask.env), timeoutMs: 60_000 });
      } finally {
        ask.cleanup();
      }
      if (r.code !== 0 || !/sara-key-(added|present)/.test(r.stdout)) {
        if (HOSTKEY_FAIL.test(r.stderr)) await this.#hostKeyChanged(s);
        // A failed try keeps her key (design §2.2 step 6): the next try installs the same line.
        if (/sara-key-failed/.test(r.stdout)) {
          const why = `I signed in but couldn’t write ~/.ssh/authorized_keys on ${s.name}.`;
          this.#update(id, { lastError: why });
          throw new SshError(why, 'LOGIN_FAILED');
        }
        const d = this.diagnose(this.get(id), r, { mode: 'password', secrets: [pwText] }) ?? diagnosis('UNKNOWN', { host: s.host }, scrubbed(r.stderr, [pwText]));
        if (d.code === 'PASSWORD_OFF' && s.probe) this.#update(id, { probe: { ...s.probe, passwords: false, recommended: recommendPath(s, s.probe.cpanel?.found === true, false) } });
        this.#update(id, { lastError: diagText(d) });
        throw diagError(d);
      }
      const now = this.#now().toISOString();
      const k = this.get(id).key!;
      this.#update(id, { key: { ...k, path, publicLine, source: 'made', installedAt: now }, lastError: undefined, lastUsedAt: now, askedToSavePassword: undefined, connectedVia: 'password' });
      this.#note(id, `Installed Sara’s key on ${s.host} with the password, once.`);
      // From now on: the key. Check it really works before saying so.
      const check = await this.#run(this.#bins.ssh, [...this.sshOptions(this.get(id), 'key', path), 'echo sara-key-ok'], { env: this.#baseEnv(), timeoutMs: 30_000 });
      const works = check.code === 0 && /sara-key-ok/.test(check.stdout);
      let saved = false;
      if (opts.savePassword && opts.confirmRisk) {
        this.#vault.set(vaultKeyOf(id), pwText);
        saved = true;
      } else {
        this.#vault.delete(vaultKeyOf(id));
      }
      this.#update(id, { passwordSaved: saved || undefined, ...(works ? {} : { lastError: `The key was installed, but signing in with it failed: ${this.#explain(s, check)}` }) });
      const announcement = keyAnnouncement({ name: s.name, host: s.host, user: s.user, keyPath: path, publicLine, works, passwordSaved: saved });
      return { server: this.get(id), announcement, keyPath: path, publicLine, passwordSaved: saved };
    } finally {
      pwBuf.fill(0);
    }
  }

  async #makeKey(path: string): Promise<{ path: string; publicLine: string }> {
    this.#mk('keys');
    this.#dropKeyFiles(path);
    const r = await this.#run(this.#bins.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', keyComment(this.#instance, this.#now()), '-f', path], { env: this.#baseEnv(), timeoutMs: 30_000 });
    if (r.code !== 0 || !existsSync(path) || !existsSync(`${path}.pub`)) throw new SshError(`Couldn’t make a key (is ssh-keygen installed?). ${r.stderr.trim().slice(0, 200)}`, 'KEYGEN_FAILED');
    await this.#lockDown(path);
    const publicLine = readFileSync(`${path}.pub`, 'utf8').trim();
    if (!PUBLIC_LINE.test(publicLine)) throw new SshError('The new public key looks wrong.', 'KEYGEN_FAILED');
    return { path, publicLine };
  }

  #dropKeyFiles(path: string): void {
    for (const f of [path, `${path}.pub`]) rmSync(f, { force: true });
  }

  /** The owner gives her a key: pasted text, or the path of a key file on this server (copied). */
  async importKey(id: string, input: { privateKey?: string; keyPath?: string }): Promise<SshServer> {
    const s = this.get(id);
    this.#checkReach(s.host);
    let text = '';
    if (input.privateKey?.trim()) text = input.privateKey.replace(/\r\n/g, '\n').trim() + '\n';
    else if (input.keyPath?.trim()) {
      const p = input.keyPath.trim();
      if (!isAbsolute(p)) throw new SshError('Give the full path of the key file on the Sara server, like /home/alex/.ssh/id_ed25519.', 'BAD_PATH');
      let st;
      try {
        st = statSync(p);
      } catch {
        throw new SshError('There is no file at that path on the Sara server.', 'BAD_PATH');
      }
      if (!st.isFile() || st.size > 20_000) throw new SshError('That isn’t a private key file.', 'BAD_KEY');
      text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim() + '\n';
    } else throw new SshError('Paste the private key, or give the path of the key file on the Sara server.', 'BAD_KEY');
    if (!PEM_KEY.test(text) || text.length > 20_000) throw new SshError('That doesn’t look like an SSH private key (it starts with -----BEGIN OPENSSH and a few more words).', 'BAD_KEY');
    this.#mk('keys');
    const path = this.keyFile(id, 'imported');
    this.#dropKeyFiles(path);
    writeFileSync(path, text, { mode: 0o600 });
    await this.#lockDown(path);
    // The public half (also proves it isn't protected by a passphrase she can't type).
    const pub = await this.#run(this.#bins.keygen, ['-y', '-P', '', '-f', path], { env: this.#baseEnv(), timeoutMs: 15_000 });
    const publicLine = pub.stdout.trim().split(/\r?\n/)[0] ?? '';
    if (pub.code !== 0 || !PUBLIC_LINE.test(publicLine)) {
      this.#dropKeyFiles(path);
      throw new SshError('I can’t use that key: it is protected by a passphrase, or it isn’t a key ssh understands. Use a key without a passphrase, or sign in with the password once so I make my own.', 'BAD_KEY');
    }
    writeFileSync(`${path}.pub`, `${publicLine}\n`, { mode: 0o600 });
    const now = this.#now().toISOString();
    this.#update(id, { key: { path, publicLine, source: 'imported', createdAt: now }, lastError: undefined });
    const t = await this.test(id);
    if (!t.ok) throw new SshError(`I saved the key, but ${s.name} didn’t accept it: ${t.message}`, 'AUTH');
    return this.get(id);
  }

  /**
   * Test connection (design §4.2): signs in with her key and runs a tiny shell check. Returns the
   * old shape ({ ok, message }) plus the diagnosis code, title and fix, and the shell kind.
   */
  async test(id: string): Promise<TestResult> {
    const s = this.get(id);
    const inst = keyComment(this.#instance, this.#now()).replace(/-\d{8}$/, '-');
    const cmd = `echo sara-ok; echo "sara-shell:$0:$SHELL"; echo "sara-own:$(grep -c '${inst}' "$HOME/.ssh/authorized_keys" 2>/dev/null)"; echo "sara-uid:$(id -u 2>/dev/null)"`;
    let d: Diagnosis | undefined;
    let shell: string | undefined;
    let own: number | undefined;
    let uid: number | undefined;
    try {
      const r = await this.exec(id, cmd, { timeoutMs: 30_000, verbose: true });
      if (r.code === 0 && /sara-ok/.test(r.stdout)) {
        shell = /sara-shell:([^\r\n]*)/.exec(r.stdout)?.[1]?.slice(0, 120);
        const n = Number(/sara-own:(\d+)/.exec(r.stdout)?.[1]);
        if (Number.isFinite(n)) own = n;
        const u = /sara-uid:(\d+)/.exec(r.stdout)?.[1];
        if (u !== undefined) uid = Number(u);
        d = /jailshell/.test(shell ?? '') ? diagnosis('JAILED', { name: s.name, host: s.host }) : diagnosis('CONNECTED', { name: s.name, host: s.host });
      } else d = this.diagnose(this.get(id), r, { mode: 'test' }) ?? diagnosis('UNKNOWN', { host: s.host }, scrubbed(r.stderr));
    } catch (err) {
      const e = err as SshError;
      if (e.diagnosis) d = e.diagnosis;
      else if (e.code === 'HOSTKEY_CHANGED') d = diagnosis('HOSTKEY_CHANGED', { host: s.host, old: s.fingerprint, new: this.get(id).pending?.fingerprint });
      else if (e.code === 'PRIVATE_LOCAL') d = diagnosis('PRIVATE_LOCAL', { host: s.host });
      else return { ok: false, message: e.message, code: e.code ?? 'UNKNOWN', title: e.message, fix: '' };
    }
    const ok = d.code === 'CONNECTED' || d.code === 'JAILED';
    const now = this.#now().toISOString();
    const cur = this.get(id);
    this.#update(id, {
      lastCheck: { at: now, code: d.code, ok, ...(shell ? { shell } : {}), ...(own !== undefined ? { extraLines: Math.max(0, own - 1) } : {}) },
      ...(ok && cur.key && !cur.key.installedAt && cur.key.source === 'made' ? { key: { ...cur.key, installedAt: now } } : {}),
      ...(ok && !cur.connectedVia ? { connectedVia: cur.key?.source === 'imported' ? 'imported' : 'paste' } : {}),
      ...(ok ? { lastError: undefined } : { lastError: diagText(d) }),
      ...(uid !== undefined ? { uid0: uid === 0 || undefined } : {}),
    });
    return { ok, message: ok ? 'Signed in.' : diagText(d), code: d.code, title: d.title, fix: d.fix, diagnosis: d, ...(shell ? { shell } : {}) };
  }

  /**
   * 3.4.1: her own key first, quietly (after the ID card is approved, on reopening a server that
   * isn't connected yet, and every few seconds while "Add Sara's key yourself" is open). Same
   * BatchMode run and strict options as Test connection; a miss records nothing (no failed check,
   * no error, no history line), so the page can ask as often as it likes.
   */
  async tryOwnKey(id: string): Promise<TestResult & { tried: boolean }> {
    const s = this.get(id);
    const view = this.view(s);
    if (view.ready) return { ok: true, message: 'Signed in.', code: 'CONNECTED', title: '', fix: '', tried: false };
    if (!s.fingerprint || s.pending || !s.key || s.key.source !== 'made' || !existsSync(s.key.path)) return { ok: false, message: 'Not yet.', code: 'NOT_TRIED', title: '', fix: '', tried: false };
    const keep = { lastCheck: s.lastCheck, lastError: s.lastError, lastUsedAt: s.lastUsedAt, history: s.history, connectedVia: s.connectedVia, uid0: s.uid0 };
    const t = await this.test(id);
    if (t.ok) {
      this.#note(id, `Sara’s key already worked on ${s.host}.`);
      return { ...t, tried: true };
    }
    // A changed host key is not a quiet miss: Test connection's record (and the pending key) stay.
    if (t.code !== 'HOSTKEY_CHANGED') this.#update(id, keep);
    return { ...t, tried: true };
  }

  /** "I've added it — check now" (the paste path): signs in with her key and says what happened. */
  async checkKey(id: string): Promise<TestResult> {
    const t = await this.test(id);
    if (t.ok && this.get(id).connectedVia === 'paste') this.#note(id, `Sara’s key works on ${this.get(id).host} (added by copy and paste).`);
    return t;
  }

  /** Runs one command on a server with her key (or the saved password). */
  async exec(id: string, command: string, opts: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number; verbose?: boolean } = {}): Promise<RunResult> {
    const s = this.get(id);
    this.#checkReach(s.host);
    if (s.pending?.changed) throw new SshError(`The host key of ${s.name} changed since you approved it (now ${s.pending.fingerprint}). I won’t sign in until you check it: Settings → Coding → Servers over SSH.`, 'HOSTKEY_CHANGED');
    if (!s.fingerprint) throw new SshError(`Approve the host key of ${s.name} first (Settings → Coding → Servers over SSH).`, 'NO_HOSTKEY');
    if (!command.trim() || command.length > 20_000) throw new SshError('Give the command to run (up to 20,000 characters).', 'BAD_COMMAND');
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let r: RunResult;
    if (s.key && existsSync(s.key.path)) {
      r = await this.#run(this.#bins.ssh, [...this.sshOptions(s, 'key', s.key.path, opts.verbose ? 'VERBOSE' : 'ERROR'), command], { env: this.#baseEnv(), timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
    } else {
      const pw = this.#vault.get(vaultKeyOf(id));
      if (!pw) throw new SshError(`I have no key for ${s.name} yet. Sign in once with the password in Settings → Coding → Servers over SSH (I’ll make my own key), or give me a key there.`, 'NO_KEY');
      const buf = Buffer.from(pw, 'utf8');
      const ask = this.#askpass(buf);
      try {
        r = await this.#run(this.#bins.ssh, [...this.sshOptions(s, 'password'), command], { env: this.#baseEnv(ask.env), timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
      } finally {
        ask.cleanup();
        buf.fill(0);
      }
      r = { ...r, stderr: r.stderr.split(pw).join('[REDACTED]') };
    }
    if (r.code === 255 && HOSTKEY_FAIL.test(r.stderr)) {
      await this.#hostKeyChanged(s);
      throw new SshError(this.#explain(s, r), 'HOSTKEY_CHANGED');
    }
    this.#update(id, { lastUsedAt: this.#now().toISOString(), ...(r.code === 255 ? { lastError: this.#explain(s, r) } : { lastError: undefined }) });
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // 2.52.1: "Connect a server" (docs/design/SSH_EASY.md §2): address + user, then Sara looks.
  // -------------------------------------------------------------------------------------------

  /** Connect: understands a pasted address (user@host:port, `ssh -p`, a cPanel link), adds the server and looks at it. */
  async connectServer(input: { address: unknown; user?: unknown; port?: unknown; name?: unknown; conversationId?: string; askedToSavePassword?: boolean }): Promise<SshServer> {
    const parsed = parseAddress(input.address);
    const user = String(input.user ?? '').trim() || parsed.user;
    const port = input.port !== undefined && input.port !== null && input.port !== '' ? input.port : parsed.port;
    // PL2a (N7): an earlier try at this address that never reached it goes first (no second draft).
    for (const old of this.#servers.filter((x) => unreached(x) && x.host === cleanHost(parsed.host))) this.remove(old.id);
    const s = await this.add({ name: input.name, host: parsed.host, user, port, scan: false, ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.askedToSavePassword ? { askedToSavePassword: true } : {}) });
    this.#update(s.id, { draft: true });
    const out = await this.probe(s.id, { cpanelHint: parsed.cpanel === true });
    return out.probe && !out.probe.code ? this.#update(s.id, { draft: undefined }) : out;
  }

  /**
   * Looks at the server (design §2.2): the name, the SSH port (at most 7 short connects), the host
   * key (pending until the owner says yes), which sign-in methods it allows, cPanel on 2083, and
   * her own key, made now. Read-only: no secret is sent. Saves the result as `probe`.
   */
  async probe(id: string, opts: { findPort?: boolean; cpanelHint?: boolean } = {}): Promise<SshServer> {
    let s = this.get(id);
    const at = this.#now().toISOString();
    const fail = (code: Diagnosis['code'], ports: number[], params: Record<string, string | number | undefined>, details?: string): SshServer => {
      const d = diagnosis(code, { host: s.host, ports: ports.join(', ') || String(s.port), port: params.port ?? s.port, ...params }, details);
      return this.#update(id, { probe: { at, ports, code, params: d.params, recommended: 'fix', ...(s.probe?.cpanel ? { cpanel: s.probe.cpanel } : {}) }, lastError: diagText(d) });
    };
    try {
      this.#checkReach(s.host);
    } catch {
      return fail('PRIVATE_LOCAL', [], {});
    }
    // 1. The name.
    if (!isIP(s.host)) {
      try {
        await this.#lookup(s.host);
      } catch {
        return fail('DNS', [], {});
      }
    }
    // 2. The SSH port: the owner's, else the list (Q1). One short connect each, one at a time.
    const auto = s.portAuto || opts.findPort;
    const candidates = [...new Set(auto ? (s.portAuto ? [...PORT_LIST] : [s.port, ...PORT_LIST]) : [s.port])].slice(0, MAX_PORT_TRIES);
    const tried: number[] = [];
    const kinds: { port: number; kind: string }[] = [];
    let found: number | undefined;
    for (const port of candidates) {
      tried.push(port);
      const g = await this.#greet(s.host, port, this.#greetMs).catch(() => ({ kind: 'error' as const }));
      kinds.push({ port, kind: g.kind });
      if (g.kind === 'ssh') {
        found = port;
        break;
      }
      if (g.kind === 'dns') return fail('DNS', tried, {});
    }
    if (found === undefined) {
      const other = kinds.find((k) => k.kind === 'other' || k.kind === 'silent');
      if (other) return fail('NOT_SSH', tried, { port: other.port });
      return fail(kinds.some((k) => k.kind === 'refused') ? 'PORT_CLOSED' : 'TIMEOUT', tried, {});
    }
    if (found !== s.port) s = this.#update(id, { port: found });
    if (s.portAuto && found) s = this.#update(id, { portAuto: undefined });
    // 3. The host key (pending until the owner says yes; a changed one stops here).
    try {
      s = await this.scan(id);
    } catch (err) {
      return fail('TIMEOUT', tried, { port: found }, scrubbed((err as Error).message));
    }
    if (s.pending?.changed) {
      const d = diagnosis('HOSTKEY_CHANGED', { host: s.host, old: s.fingerprint, new: s.pending.fingerprint });
      return this.#update(id, { probe: { at, ports: tried, port: found, code: 'HOSTKEY_CHANGED', params: d.params, recommended: 'fix' }, lastError: 'The host key changed.' });
    }
    // 4. Which sign-in methods it allows (the `none` request; nothing typed, no key offered).
    const methods = await this.#methods(s);
    // 5. cPanel on 2083 (anonymous TLS look: the certificate and `Server: cpsrvd`).
    let cpanel: SshProbe['cpanel'];
    const lanOnly = isLoopbackHost(s.host) || (isIP(s.host) > 0 && isPrivateAddress(s.host));
    if (opts.cpanelHint || !lanOnly || this.#cpanel.peek) {
      const port = cpanelPort();
      const apiHost = s.cpanelHost ?? s.host;
      try {
        this.#checkReach(apiHost);
        const peek = await (this.#cpanel.peek ?? peekCpanel)(apiHost, port, 4000);
        cpanel = { found: peek.cpanel || (peek.reachable && opts.cpanelHint === true), port, certOk: peek.certOk, ...(peek.certNames.length ? { certNames: peek.certNames } : {}), ...(opts.cpanelHint ? { hint: true } : {}) };
      } catch {
        cpanel = { found: Boolean(opts.cpanelHint), port, certOk: false, ...(opts.cpanelHint ? { hint: true } : {}) };
      }
    }
    // 6. Her own key, made now (before any sign-in), so every path has her public line.
    if (!s.key) await this.ensureKey(id);
    const passwords = methods ? passwordsAllowed(methods) : undefined;
    const recommended = recommendPath(s, cpanel?.found === true, passwords);
    const out = this.#update(id, { probe: { at, ports: tried, port: found, ...(methods ? { methods } : {}), ...(passwords !== undefined ? { passwords } : {}), ...(cpanel ? { cpanel } : {}), recommended }, lastError: undefined });
    // 3.4.1: an ID card approved earlier (Reconnect, Look again): her key may already be there.
    if (out.fingerprint && !out.pending) await this.tryOwnKey(id).catch(() => undefined);
    return this.get(id);
  }

  /**
   * The methods check (design §2.2 step 4): one ssh run with every client method switched off and
   * BatchMode, against the pending (or approved) host key in a throw-away known_hosts. The server's
   * "Permission denied (publickey,password)." lists what it allows. No password, no key.
   */
  async #methods(s: SshServer): Promise<string[] | undefined> {
    const line = s.pending?.line ?? (existsSync(this.knownHostsFile(s.id)) ? readFileSync(this.knownHostsFile(s.id), 'utf8').trim().split('\n')[0] : undefined);
    const keyType = s.pending?.keyType ?? s.keyType;
    if (!line || !keyType) return undefined;
    const tmp = this.#tempDir();
    try {
      const kh = join(tmp, 'known_hosts');
      writeFileSync(kh, `${line}\n`, { mode: 0o600 });
      const o = (k: string, v: string) => ['-o', `${k}=${v}`];
      const args = [
        '-F', 'none', '-T',
        ...o('BatchMode', 'yes'),
        ...o('StrictHostKeyChecking', 'yes'),
        ...o('UserKnownHostsFile', kh),
        ...o('GlobalKnownHostsFile', kh),
        ...o('HostKeyAlias', `sara-${s.id}`),
        ...o('HostKeyAlgorithms', hostKeyAlgorithms(keyType)),
        ...o('UpdateHostKeys', 'no'),
        ...o('CheckHostIP', 'no'),
        ...o('IdentitiesOnly', 'yes'),
        ...o('IdentityAgent', 'none'),
        ...o('IdentityFile', 'none'),
        ...o('PubkeyAuthentication', 'no'),
        ...o('PasswordAuthentication', 'no'),
        ...o('KbdInteractiveAuthentication', 'no'),
        ...o('GSSAPIAuthentication', 'no'),
        ...o('HostbasedAuthentication', 'no'),
        ...o('ConnectTimeout', '10'),
        ...o('ForwardAgent', 'no'),
        ...o('ForwardX11', 'no'),
        ...o('ClearAllForwardings', 'yes'),
        ...o('ControlMaster', 'no'),
        ...o('ControlPath', 'none'),
        ...o('PermitLocalCommand', 'no'),
        ...o('LogLevel', 'ERROR'),
        '-p', String(s.port),
        '-l', s.user,
        '--',
        s.host,
        'true',
      ];
      const r = await this.#run(this.#bins.ssh, args, { env: this.#baseEnv(), timeoutMs: 20_000 });
      return deniedMethods(r.stderr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Her own key for this server: made once and kept (a failed sign-in no longer deletes it). */
  async ensureKey(id: string): Promise<{ path: string; publicLine: string }> {
    const s = this.get(id);
    if (s.key?.source === 'made' && existsSync(s.key.path) && existsSync(`${s.key.path}.pub`)) return { path: s.key.path, publicLine: s.key.publicLine };
    if (s.key?.source === 'imported') this.#dropKeyFiles(s.key.path);
    const k = await this.#makeKey(this.keyFile(id, 'made'));
    this.#update(id, { key: { path: k.path, publicLine: k.publicLine, source: 'made', createdAt: this.#now().toISOString() } });
    return k;
  }

  /**
   * The cPanel token path (design §2.4 a): with the owner's one-time API token, in a header over
   * verified HTTPS, she imports her public key (SSH::importkey, name sara-<id>), authorizes it
   * (SSH::authkey), revokes the token (Tokens::revoke, Q2) and checks the key. The token is never
   * written anywhere and the buffer is zeroed.
   */
  async installViaCpanel(id: string, token: string | Buffer, opts: { apiHost?: string; revokeToken?: boolean } = {}): Promise<{ server: SshServer; tokenRevoked: boolean | undefined; test: TestResult }> {
    const s = this.get(id);
    const tok = Buffer.isBuffer(token) ? Buffer.from(token) : Buffer.from(String(token ?? '').trim(), 'utf8');
    try {
      this.#checkReach(s.host);
      if (isRootUser(s)) throw diagError(diagnosis('ROOT_CPANEL', { host: s.host, user: s.user }));
      if (!CPANEL_TOKEN.test(tok.toString('utf8'))) throw diagError(diagnosis('BAD_TOKEN', { host: s.host }));
      if (!s.fingerprint || s.pending) throw new SshError('Say yes to the server’s ID card (its host key) first.', 'NO_HOSTKEY');
      // The API host: the SSH address, or a name the certificate showed and the owner accepted.
      let apiHost = s.cpanelHost ?? s.host;
      if (opts.apiHost && opts.apiHost.trim().toLowerCase() !== apiHost.toLowerCase()) {
        const want = cleanHost(opts.apiHost).toLowerCase();
        const offered = (s.probe?.cpanel?.certNames ?? []).map((n) => n.toLowerCase());
        if (!offered.includes(want) && want !== s.host.toLowerCase()) throw new SshError('Use a name the cPanel certificate showed.', 'BAD_HOST');
        apiHost = want;
      }
      this.#checkReach(apiHost);
      const port = s.probe?.cpanel?.port ?? cpanelPort();
      // Before the token goes anywhere: the certificate must be valid and for this name.
      const peek = await (this.#cpanel.peek ?? peekCpanel)(apiHost, port, 6000);
      if (!peek.reachable) throw diagError(diagnosis('NO_CPANEL', { host: apiHost }, peek.error));
      if (!peek.certOk) {
        const other = peek.certNames.find((n) => !n.startsWith('*')) ?? peek.certNames[0];
        if (s.probe) this.#update(id, { probe: { ...s.probe, cpanel: { found: true, port, certOk: false, certNames: peek.certNames } } });
        throw diagError(other ? diagnosis('CERT_NAME', { host: apiHost, other }) : diagnosis('CERT_BAD', { host: apiHost }));
      }
      if (apiHost !== s.host.toLowerCase() && apiHost !== s.host) this.#update(id, { cpanelHost: apiHost });
      const { publicLine } = await this.ensureKey(id);
      const call = (fn: Parameters<typeof cpanelCall>[0], params: Record<string, string> = {}) => cpanelCall(fn, { apiHost, port, user: s.user, token: tok, params, ...(this.#cpanel.baseUrl || this.#cpanel.fetch ? { http: this.#cpanel } : {}) });
      const failed = (r: { status: number; error?: string }) => {
        if (r.error === 'unauthorized' || /invalid user|not a cpanel user|access denied/i.test(r.error ?? '')) return diagnosis('WRONG_USER', { user: s.user, host: apiHost });
        if (r.status === 0) return diagnosis('NO_CPANEL', { host: apiHost }, r.error);
        return diagnosis('CPANEL_FAILED', { host: apiHost }, r.error);
      };
      // 1. Does the token belong to this user? (changes nothing)
      const list = await call('Tokens::list');
      if (!list.ok) throw diagError(failed(list));
      // 2. Her public key into the account's key list, 3. authorized (written to authorized_keys).
      const keyName = `sara-${id}`;
      const imp = await call('SSH::importkey', { name: keyName, key: publicLine });
      if (!imp.ok && !/already exists/i.test(imp.error ?? '')) throw diagError(failed(imp));
      const auth = await call('SSH::authkey', { key: keyName, action: 'authorize' });
      if (!auth.ok) throw diagError(failed(auth));
      // 4. Q2: she deletes the token herself (it must be called "sara", as the steps say).
      let tokenRevoked: boolean | undefined;
      if (opts.revokeToken !== false) {
        const names = Array.isArray(list.data) ? (list.data as { name?: unknown }[]).map((t) => String(t?.name ?? '')) : [];
        if (names.includes('sara')) tokenRevoked = (await call('Tokens::revoke', { name: 'sara' })).ok;
        else tokenRevoked = false;
      }
      const now = this.#now().toISOString();
      const k = this.get(id).key!;
      this.#update(id, { key: { ...k, installedAt: now }, connectedVia: 'cpanel', lastError: undefined });
      this.#note(id, `Installed Sara’s key on ${s.host} through cPanel.${tokenRevoked ? ' Deleted the token.' : ''}`);
      tok.fill(0);
      // 5. Sign in with her key and run the shell check.
      const test = await this.test(id);
      return { server: this.get(id), tokenRevoked, test };
    } finally {
      tok.fill(0);
    }
  }

  /** Edit (design §5): name, user, port without removing. A new port keeps the host key only if a new keyscan matches it. */
  async updateServer(id: string, patch: { name?: unknown; user?: unknown; port?: unknown }): Promise<SshServer> {
    const s = this.get(id);
    const out: Partial<SshServer> = {};
    if (patch.name !== undefined && String(patch.name).trim() !== s.name) {
      const name = String(patch.name).trim();
      if (!NAME.test(name)) throw new SshError('Give the server a short name (up to 60 characters).', 'BAD_NAME');
      if (this.#servers.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new SshError(`There is already a server called "${name}". Pick another name.`, 'DUPLICATE');
      out.name = name;
    }
    if (patch.user !== undefined && String(patch.user).trim() !== s.user) {
      out.user = cleanUser(patch.user);
      // Her line is in the old user's authorized_keys: she needs to connect again for the new one.
      if (s.key?.installedAt) {
        const { installedAt: _was, ...rest } = s.key;
        void _was;
        out.key = rest;
      }
      out.connectedVia = undefined;
      out.lastCheck = undefined;
    }
    let portChanged = false;
    if (patch.port !== undefined && patch.port !== '' && cleanPort(patch.port) !== s.port) {
      out.port = cleanPort(patch.port);
      out.portAuto = undefined;
      portChanged = true;
    }
    this.#update(id, out);
    if (portChanged) {
      try {
        await this.scan(id);
      } catch (err) {
        this.#update(id, { lastError: (err as Error).message });
      }
    }
    return this.get(id);
  }

  /**
   * Replace Sara's key (design §5): a new key, installed with the current one, checked, then the
   * old line removed. No password or token needed. If the old key doesn't work any more the new
   * one is kept (not installed) and the owner reconnects.
   */
  async replaceKey(id: string): Promise<{ server: SshServer; message: string; reconnect?: boolean; diagnosis?: Diagnosis }> {
    const s = this.get(id);
    this.#checkReach(s.host);
    if (!s.key || s.key.source !== 'made') {
      const k = await this.ensureKey(id);
      void k;
      return { server: this.get(id), message: 'I made a new key. Connect again to put it on the server.', reconnect: true };
    }
    const old = s.key;
    const main = this.keyFile(id, 'made');
    const fresh = `${main}.new`;
    const k = await this.#makeKey(fresh);
    const swap = (installedAt?: string) => {
      this.#dropKeyFiles(main);
      renameSync(fresh, main);
      renameSync(`${fresh}.pub`, `${main}.pub`);
      return this.#update(id, { key: { path: main, publicLine: k.publicLine, source: 'made', createdAt: this.#now().toISOString(), ...(installedAt ? { installedAt } : {}) } });
    };
    let r: RunResult;
    try {
      r = await this.exec(id, installScript(k.publicLine), { timeoutMs: 60_000 });
    } catch (err) {
      this.#dropKeyFiles(fresh);
      throw err;
    }
    if (r.code !== 0 || !/sara-key-(added|present)/.test(r.stdout)) {
      const d = this.diagnose(this.get(id), r, { mode: 'key' }) ?? diagnosis('UNKNOWN', { host: s.host }, scrubbed(r.stderr));
      if (d.code === 'KEY_NOT_ACCEPTED') {
        swap();
        this.#update(id, { connectedVia: undefined });
        return { server: this.get(id), message: 'Her old key doesn’t work there any more. I made a new one: connect again to put it on the server.', reconnect: true, diagnosis: d };
      }
      this.#dropKeyFiles(fresh);
      throw diagError(d);
    }
    // The new key must work before the old line goes.
    const check = await this.#run(this.#bins.ssh, [...this.sshOptions(this.get(id), 'key', fresh), 'echo sara-key-ok'], { env: this.#baseEnv(), timeoutMs: 30_000 });
    if (check.code !== 0 || !/sara-key-ok/.test(check.stdout)) {
      await this.exec(id, revokeScript(k.publicLine), { timeoutMs: 60_000 }).catch(() => undefined);
      this.#dropKeyFiles(fresh);
      throw diagError(this.diagnose(this.get(id), check, { mode: 'key' }) ?? diagnosis('UNKNOWN', { host: s.host }, scrubbed(check.stderr)));
    }
    const rm = await this.#run(this.#bins.ssh, [...this.sshOptions(this.get(id), 'key', fresh), `${revokeScript(old.publicLine)}${s.connectedVia === 'cpanel' ? `; rm -f "$HOME/.ssh/sara-${id}.pub"` : ''}`], { env: this.#baseEnv(), timeoutMs: 60_000 });
    swap(this.#now().toISOString());
    const message = rm.code === 0 && /sara-key-(removed|gone)/.test(rm.stdout) ? `Replaced my key on ${s.name}: the new one works and the old line is gone.` : `Replaced my key on ${s.name}: the new one works, but I couldn’t remove the old line. Use Clean up old Sara keys.`;
    this.#note(id, `Replaced Sara’s key on ${s.host}.`);
    return { server: this.get(id), message };
  }

  /** Her lines in authorized_keys on the server (sara@<instance>-…), the current one marked. Comments only leave this function for the page. */
  async listOwnLines(id: string): Promise<{ current?: string; lines: string[] }> {
    const s = this.get(id);
    const inst = keyComment(this.#instance, this.#now()).replace(/-\d{8}$/, '-');
    const r = await this.exec(id, `echo sara-list-begin; f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] && grep -F ' ${inst}' "$f"; echo sara-list-end`, { timeoutMs: 30_000 });
    if (r.code !== 0 || !/sara-list-end/.test(r.stdout)) throw diagError(this.diagnose(this.get(id), r, { mode: 'key' }) ?? diagnosis('UNKNOWN', { host: s.host }, scrubbed(r.stderr)));
    const body = r.stdout.split('sara-list-begin')[1]?.split('sara-list-end')[0] ?? '';
    const lines = [...new Set(body.split(/\r?\n/).map((l) => l.trim()).filter((l) => PUBLIC_LINE.test(l) && l.split(' ')[2]?.startsWith(inst)))];
    return { ...(s.key?.publicLine ? { current: s.key.publicLine } : {}), lines };
  }

  /** Clean up old Sara keys: removes her lines that aren't her current key (exact lines only), and cPanel's matching sara-*.pub files. */
  async cleanupOwnLines(id: string): Promise<{ server: SshServer; removed: number; comments: string[] }> {
    const s = this.get(id);
    const { current, lines } = await this.listOwnLines(id);
    const old = lines.filter((l) => l !== current);
    const comments: string[] = [];
    for (const l of old) {
      const L = q(l);
      const r = await this.exec(id, `${revokeScript(l)}; for p in "$HOME"/.ssh/sara-*.pub; do [ -f "$p" ] && grep -qxF ${L} "$p" && rm -f "$p"; done; true`, { timeoutMs: 60_000 });
      if (r.code === 0 && /sara-key-(removed|gone)/.test(r.stdout)) comments.push(l.split(' ')[2] ?? '');
    }
    if (comments.length) this.#note(id, `Cleaned up ${comments.length} old Sara key line(s) on ${s.host}.`);
    const lc = this.get(id).lastCheck;
    if (lc) this.#update(id, { lastCheck: { ...lc, extraLines: 0 } });
    return { server: this.get(id), removed: comments.length, comments };
  }

  /** Forgets a saved password (one click in Settings). */
  forgetPassword(id: string): SshServer {
    this.get(id);
    this.#vault.delete(vaultKeyOf(id));
    return this.#update(id, { passwordSaved: undefined, askedToSavePassword: undefined });
  }

  /**
   * Revokes her key: removes exactly her line from authorized_keys on the server (signing in with
   * that key one last time), then deletes the key files here. Keys the owner gave her are only
   * deleted here (they're his to remove from the server).
   */
  async revokeKey(id: string, opts: { localOnly?: boolean } = {}): Promise<{ server: SshServer; removedFromServer: boolean; message: string }> {
    const s = this.get(id);
    if (!s.key) throw new SshError(`I have no key for ${s.name}.`, 'NO_KEY');
    const key = s.key;
    let removed = false;
    let message = '';
    if (key.source === 'made' && !opts.localOnly && key.installedAt) {
      // cPanel's import left ~/.ssh/sara-<id>.pub (its key list): removed too, by exact name.
      const r = await this.exec(id, `${revokeScript(key.publicLine)}${s.connectedVia === 'cpanel' ? `; rm -f "$HOME/.ssh/sara-${id}.pub"` : ''}`, { timeoutMs: 60_000 });
      if (r.code !== 0 || !/sara-key-(removed|gone)/.test(r.stdout)) throw new SshError(`I couldn’t remove my key from ${s.name}: ${this.#explain(s, r)} Nothing was deleted here. Try again, or choose to delete it here only.`, 'REVOKE_FAILED');
      removed = true;
      message = /sara-key-removed/.test(r.stdout) ? `Removed my key from ~/.ssh/authorized_keys on ${s.name} and deleted it here.` : `My key wasn’t in ~/.ssh/authorized_keys on ${s.name} any more; deleted it here.`;
    } else if (key.source === 'made' && !key.installedAt) {
      message = `Deleted my key for ${s.name} here. It was never installed there.`;
    } else {
      message = key.source === 'imported' ? `Deleted my copy of the key you gave me for ${s.name}. It is still on the server: remove it from ~/.ssh/authorized_keys there if you want it gone.` : `Deleted my key for ${s.name} here only. Its line is still in ~/.ssh/authorized_keys on the server: ${key.publicLine}`;
    }
    this.#dropKeyFiles(key.path);
    if (removed) this.#note(id, `Removed Sara’s key from ${s.host}.`);
    return { server: this.#update(id, { key: undefined, connectedVia: undefined, lastCheck: undefined }), removedFromServer: removed, message };
  }

  /** Removes a server: its key files, known host key and any saved password. */
  remove(id: string): void {
    const s = this.get(id);
    if (s.key) this.#dropKeyFiles(s.key.path);
    rmSync(this.knownHostsFile(id), { force: true });
    this.#vault.delete(vaultKeyOf(id));
    this.#servers = this.#servers.filter((x) => x.id !== id);
    this.#save();
  }

  /** Whether the ssh programs are here (for the settings page). */
  async available(): Promise<boolean> {
    const r = await this.#run(this.#bins.ssh, ['-V'], { env: this.#baseEnv(), timeoutMs: 10_000 }).catch(() => ({ code: null, stdout: '', stderr: '' }) as RunResult);
    return r.code === 0 || /OpenSSH/i.test(r.stderr + r.stdout);
  }
}

export interface TestResult {
  ok: boolean;
  message: string;
  code: string;
  title: string;
  fix: string;
  diagnosis?: Diagnosis;
  shell?: string;
}

/**
 * The paste path's one line (design §2.4 c), built from her validated public line with the same
 * quoting as installScript: the owner pastes it into a terminal or web console on the server.
 */
export function pasteCommand(publicLine: string): string {
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${q(publicLine)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/** What she tells the owner after making a key (tool results and the settings card use it). */
export function keyAnnouncement(a: { name: string; host: string; user: string; keyPath: string; publicLine: string; works: boolean; passwordSaved: boolean }): string {
  return [
    `I made my own SSH key for ${a.name} (${a.user}@${a.host}) and added it to ~/.ssh/authorized_keys there.`,
    `The private key is on the Sara server at ${a.keyPath} (the public half next to it, ${a.keyPath}.pub). The line I installed is: ${a.publicLine}`,
    a.works ? 'I checked it: signing in with the key works, so I’ll use the key from now on.' : 'But signing in with the key didn’t work when I checked, so look at the server’s SSH settings (PubkeyAuthentication).',
    a.passwordSaved ? 'You asked me to keep the password, so it is saved encrypted with my other secrets; you can forget it with one click in Settings → Coding → Servers over SSH.' : 'I did NOT keep the password.',
  ].join(' ');
}

/**
 * A password typed into the chat by mistake ("the password is Hunter2!x"): the value is replaced
 * before the message is stored or sent to a model. Only values that look like passwords (6+
 * characters with a digit or symbol) after a password word, so "the password is too long" stays.
 */
const PW_WORDS = 'password|passwd|passphrase|passcode|pass|pw|pwd|contraseña|clave|mot de passe|passwort|kennwort|senha|parola d[’\']ordine';
const PW_RE = new RegExp(`\\b((?:${PW_WORDS})\\b(?:\\s+(?:for|of|on|para|pour|für|per|de|di|do|da|en|auf|su)(?:\\s+[\\w.@-]{1,60}){1,3}?)?\\s*(?:is|=|:|es|est|ist|é|è|was|será)?\\s*[:=]?\\s*)(["'\`]?)(\\S{6,128})\\2`, 'giu');
/**
 * 2.52.1: a cPanel API token pasted into the chat (32 upper-case letters and digits after "token",
 * "api token", "cpanel token", in any of the app's languages) is replaced the same way.
 */
const TOKEN_RE = /\b((?:cpanel\s+|api\s+)?(?:token|jeton|clé|chave|chiave|schlüssel)\b[^A-Z0-9\n]{0,40}?)([A-Z0-9]{32})(?![A-Za-z0-9])/giu;
export function redactTypedPassword(text: string): { text: string; changed: boolean } {
  let changed = false;
  text = text.replace(TOKEN_RE, (m: string, lead: string, value: string) => {
    if (!/^[A-Z0-9]{32}$/.test(value) || !/\d/.test(value) || !/[A-Z]/.test(value)) return m;
    changed = true;
    return `${lead}[REDACTED]`;
  });
  const out = text.replace(PW_RE, (m: string, lead: string, quote: string, value: string) => {
    const v = value.replace(/[.,;!?)]+$/, '');
    if (v.length < 6 || !/[\d\W_]/u.test(v) || /^\[REDACTED/.test(v)) return m;
    changed = true;
    return `${lead}${quote}[REDACTED]${quote}${value.slice(v.length)}`;
  });
  return { text: out, changed };
}
