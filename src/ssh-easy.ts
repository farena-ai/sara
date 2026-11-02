// 2.52.1 (docs/design/SSH_EASY.md): the easy "Connect a server" flow on top of src/ssh.ts.
//
// Everything here is read-only and sends no secret, except the four allow-listed cPanel calls,
// which carry the owner's one-time cPanel API token in a header over verified HTTPS:
// - parseAddress: what people paste (user@host:port, `ssh -p 2222 user@host`, a cPanel link).
// - readGreeting: one short TCP connect to a port, reading the first line (SSH-2.0-…).
// - peekCpanel: one TLS connect to port 2083, reading the certificate and the `Server: cpsrvd`
//   header of an anonymous GET / (no token).
// - cpanelCall: the token path (Tokens::list, SSH::importkey, SSH::authkey, Tokens::revoke).
// - diagnoseRun / diagnosis: the plain-language codes the page, the tools and the chat all use.
import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { en, fill } from './i18n.ts';
import { checkOutbound, netFetch } from './net-guard.ts';
import type { RunResult } from './ssh.ts';

/** Q1 (owner default): the ports "Sara finds it" tries, one at a time, at most 7 connects. */
export const PORT_LIST: readonly number[] = [22, 2222, 21098, 18765, 65002, 7822];
export const MAX_PORT_TRIES = 7;
/** cPanel's own HTTPS port (SARA_CPANEL_PORT for a live test against a host that moved it). */
export const cpanelPort = (): number => {
  const p = Number(process.env.SARA_CPANEL_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 2083;
};

export interface ParsedAddress {
  host: string;
  user?: string;
  port?: number;
  /** The owner pasted a cPanel link (https://host:2083/…). */
  cpanel?: boolean;
}

/**
 * What the owner pasted into "Server address": example.com, 203.0.113.5, user@example.com,
 * user@example.com:2222, `ssh -p 2222 user@example.com` (or `ssh user@host -p 2222`),
 * https://example.com:2083/…, sftp://user@host:22. Returns the parts; validation is the caller's
 * (cleanHost / cleanUser / cleanPort keep today's BAD_HOST / BAD_USER words).
 */
export function parseAddress(input: unknown): ParsedAddress {
  let s = String(input ?? '').trim().replace(/\s+/g, ' ');
  const out: ParsedAddress = { host: '' };
  // A pasted ssh command.
  if (/^ssh\s/i.test(s)) {
    const words = s.split(' ').slice(1);
    let target = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === '-p' && words[i + 1]) out.port = Number(words[++i]);
      else if (/^-p\d+$/.test(w)) out.port = Number(w.slice(2));
      else if (w === '-l' && words[i + 1]) out.user = words[++i];
      else if (/^-[a-zA-Z]$/.test(w) && words[i + 1] && /^-[oiJFEBcDLRWw]$/.test(w)) i++;
      else if (!w.startsWith('-') && !target) target = w;
    }
    s = target;
  }
  // A link (cPanel, sftp, ssh).
  const link = /^(https?|sftp|ssh):\/\/(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^/:?#\s]+)(?::(\d+))?/i.exec(s);
  if (link) {
    const scheme = link[1].toLowerCase();
    if (link[2]) out.user = decodeURIComponent(link[2]);
    out.host = link[3].replace(/^\[|\]$/g, '');
    const port = link[4] ? Number(link[4]) : undefined;
    if (scheme.startsWith('http')) {
      out.cpanel = port === 2083 || port === 2082 || /cpanel|cpsess/i.test(s) || port === undefined && /^cpanel\./i.test(out.host);
    } else if (port) out.port = port;
    return out;
  }
  const at = s.lastIndexOf('@');
  if (at > 0) {
    out.user = s.slice(0, at);
    s = s.slice(at + 1);
  }
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    out.host = v6[1];
    if (v6[2]) out.port = Number(v6[2]);
  } else if (/^[^:]+:\d+$/.test(s)) {
    const i = s.lastIndexOf(':');
    out.host = s.slice(0, i);
    out.port = Number(s.slice(i + 1));
  } else out.host = s;
  return out;
}

/** The host's first label, for a default name ("example" for example.com). */
export function defaultName(host: string): string {
  if (isIP(host)) return host;
  const first = host.split('.')[0];
  return first && first.length >= 2 && host.includes('.') ? first : host;
}

export type GreetKind = 'ssh' | 'other' | 'silent' | 'refused' | 'timeout' | 'dns' | 'error';
export interface Greeting {
  kind: GreetKind;
  /** The first line it sent (≤ 120 characters), e.g. SSH-2.0-OpenSSH_9.6 or HTTP/1.1 400. */
  banner?: string;
}
export type GreetFn = (host: string, port: number, timeoutMs: number) => Promise<Greeting>;

/**
 * One short connect: read the first line (≤ 255 bytes). An SSH server speaks first; if nothing
 * comes within a moment, send an SSH identification line (what any SSH client sends) so a web
 * server answers with its error ("HTTP/1.1 400"), then close. Sara does not speak SSH beyond that.
 */
/** The net guard for a raw socket: private local mode allows only this computer (throws PrivateLocalError). */
const guardSocket = (host: string, port: number, what: string) => checkOutbound(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`, what);

export const readGreeting: GreetFn = async (host, port, timeoutMs) => {
  guardSocket(host, port, 'SSH port check');
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    let nudged: NodeJS.Timeout | undefined;
    const sock = netConnect({ host, port });
    const finish = (g: Greeting) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(nudged);
      sock.destroy();
      resolve(g);
    };
    const timer = setTimeout(() => finish(buf.length ? classify(buf) : { kind: sock.connecting ? 'timeout' : 'silent' }), timeoutMs);
    sock.on('connect', () => {
      nudged = setTimeout(() => {
        if (!done && !buf.length) sock.write('SSH-2.0-Sara_probe\r\n');
      }, Math.min(1500, Math.floor(timeoutMs / 2)));
    });
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]).subarray(0, 255);
      if (buf.includes(0x0a) || buf.length >= 255) finish(classify(buf));
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      const c = e.code ?? '';
      finish(c === 'ECONNREFUSED' ? { kind: 'refused' } : c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? { kind: 'dns' } : c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' ? { kind: 'timeout' } : buf.length ? classify(buf) : { kind: 'error', banner: c });
    });
    sock.on('close', () => finish(buf.length ? classify(buf) : { kind: 'silent' }));
  });
};

function classify(buf: Buffer): Greeting {
  const line = buf.toString('latin1').split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '').slice(0, 120);
  return { kind: /^SSH-\d\.\d+-/.test(line) ? 'ssh' : 'other', banner: line };
}

export type LookupFn = (host: string) => Promise<string>;
export const defaultLookup: LookupFn = async (host) => (await dnsLookup(host)).address;

export interface CpanelPeek {
  /** Something answered TLS on that port. */
  reachable: boolean;
  /** It looks like cPanel (Server: cpsrvd, a /cpsess redirect or the cPanel login page). */
  cpanel: boolean;
  /** The certificate is valid AND for this name. */
  certOk: boolean;
  /** The names the certificate is for (when it isn't for this one). */
  certNames: string[];
  error?: string;
}
export type PeekFn = (host: string, port: number, timeoutMs: number) => Promise<CpanelPeek>;

function certNamesOf(cert: PeerCertificate | undefined): string[] {
  if (!cert) return [];
  const alt = String(cert.subjectaltname ?? '')
    .split(/,\s*/)
    .filter((x) => x.startsWith('DNS:'))
    .map((x) => x.slice(4));
  const cn = typeof cert.subject?.CN === 'string' ? [cert.subject.CN] : [];
  return [...new Set([...alt, ...cn])].filter((n) => /^[A-Za-z0-9*][A-Za-z0-9.*-]{0,252}$/.test(n)).slice(0, 10);
}

/** One anonymous TLS look at cPanel's port: the certificate, and whether cpsrvd answers. No token. */
export const peekCpanel: PeekFn = async (host, port, timeoutMs) => {
  guardSocket(host, port, 'cPanel check');
  return new Promise((resolve) => {
    let done = false;
    let head = '';
    const out: CpanelPeek = { reachable: false, cpanel: false, certOk: false, certNames: [] };
    const sock = tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false });
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      out.cpanel = out.cpanel || /^server:\s*cpsrvd/im.test(head) || /\/cpsess\d|<title>[^<]*cpanel/i.test(head);
      resolve(error && !out.reachable ? { ...out, error } : out);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('secureConnect', () => {
      out.reachable = true;
      const cert = sock.getPeerCertificate();
      const nameErr = cert && Object.keys(cert).length ? checkServerIdentity(host, cert) : new Error('no certificate');
      out.certOk = sock.authorized && !nameErr;
      if (!out.certOk) out.certNames = certNamesOf(cert).filter((n) => n.toLowerCase() !== host.toLowerCase());
      sock.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: Sara\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d: Buffer) => {
      head += d.toString('latin1');
      if (head.length > 16_000 || /<\/title>/i.test(head)) finish();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => finish(e.code ?? e.message));
    sock.on('close', () => finish());
  });
};

// ---------------------------------------------------------------------------------------------
// The cPanel token path: a fixed allow-list, the token only in a header.
// ---------------------------------------------------------------------------------------------

/** cPanel's API token format (cPanel » Security » Manage API Tokens): 32 upper-case letters and digits. */
export const CPANEL_TOKEN = /^[A-Z0-9]{32}$/;

/** The only cPanel functions Sara calls with a token (design §8). Anything else throws before a request. */
export const CPANEL_ALLOWED = ['Tokens::list', 'SSH::importkey', 'SSH::authkey', 'Tokens::revoke'] as const;
export type CpanelFn = (typeof CPANEL_ALLOWED)[number];

export interface CpanelHttp {
  /** Tests only: where the calls go instead of https://<host>:2083 (a fake cPanel). */
  baseUrl?: (apiHost: string) => string;
  /** Tests only: the TLS look (certificate + cpsrvd) without a real cPanel. */
  peek?: PeekFn;
  /** Tests only: the fetch the calls use (default netFetch: private local mode applies, certificate checked). */
  fetch?: typeof fetch;
}

export interface CpanelReply {
  status: number;
  ok: boolean;
  /** cPanel's own error text (scrubbed of the token). */
  error?: string;
  data?: unknown;
}

/** The request path for one allow-listed function. Exported for the test. */
export function cpanelPath(fn: string, user: string, params: Record<string, string>): string {
  if (!(CPANEL_ALLOWED as readonly string[]).includes(fn)) throw new Error(`cPanel function ${fn} is not on Sara's allow-list.`);
  const [mod, func] = fn.split('::');
  if (mod === 'Tokens') return `/execute/Tokens/${func}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  // API 2 (SSH has no UAPI equivalent): /json-api/cpanel with the module and function.
  const q = new URLSearchParams({ cpanel_jsonapi_user: user, cpanel_jsonapi_apiversion: '2', cpanel_jsonapi_module: mod, cpanel_jsonapi_func: func, ...params });
  return `/json-api/cpanel?${q}`;
}

/** One cPanel call. The token goes in the Authorization header and nowhere else. */
export async function cpanelCall(fn: CpanelFn, o: { apiHost: string; port: number; user: string; token: Buffer; params?: Record<string, string>; http?: CpanelHttp; timeoutMs?: number }): Promise<CpanelReply> {
  const path = cpanelPath(fn, o.user, o.params ?? {});
  const base = o.http?.baseUrl ? o.http.baseUrl(o.apiHost) : `https://${isIP(o.apiHost) === 6 ? `[${o.apiHost}]` : o.apiHost}:${o.port}`;
  const tokenText = o.token.toString('utf8');
  const scrub = (x: string) => x.split(tokenText).join('[REDACTED]');
  let res: Response;
  try {
    res = await (o.http?.fetch ?? netFetch)(`${base}${path}`, { method: 'GET', headers: { authorization: `cpanel ${o.user}:${tokenText}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  } catch (err) {
    return { status: 0, ok: false, error: scrub(String((err as Error)?.message ?? err)).slice(0, 200) };
  }
  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return { status: res.status, ok: false, error: 'unauthorized' };
  if (!res.ok) return { status: res.status, ok: false, error: scrub(`HTTP ${res.status}`) };
  // UAPI: { status: 1, errors, data }. API 2: { cpanelresult: { event: { result }, error, data } }.
  const api2 = json.cpanelresult as Record<string, unknown> | undefined;
  if (api2) {
    const event = api2.event as { result?: number } | undefined;
    const err = typeof api2.error === 'string' ? api2.error : '';
    const data = api2.data;
    const rowErr = Array.isArray(data) ? (data as { reason?: string; result?: number }[]).find((d) => d && d.result === 0)?.reason : undefined;
    if ((event && event.result === 0) || err || rowErr) return { status: res.status, ok: false, error: scrub(String(err || rowErr || 'failed')).slice(0, 200), data };
    return { status: res.status, ok: true, data };
  }
  if (json.status === 1) return { status: res.status, ok: true, data: json.data };
  const errs = Array.isArray(json.errors) ? (json.errors as unknown[]).map(String).join(' ') : 'failed';
  return { status: res.status, ok: false, error: scrub(errs).slice(0, 200), data: json.data };
}

// ---------------------------------------------------------------------------------------------
// The paste path: her one line, and the click-by-click steps per host.
// ---------------------------------------------------------------------------------------------

export const HOST_KINDS = ['cpanel', 'siteground', 'hostinger', 'console', 'home'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Diagnoses (design §4.1): one code, a title and a fix in plain words, and the buttons.
// ---------------------------------------------------------------------------------------------

export type DiagCode =
  | 'DNS' | 'PORT_CLOSED' | 'TIMEOUT' | 'NOT_SSH' | 'HOSTKEY_CHANGED' | 'PASSWORD_OFF' | 'WRONG_PASSWORD' | 'KEY_NOT_ACCEPTED' | 'WRONG_USER' | 'NO_SHELL'
  | 'JAILED' | 'TWO_STEP' | 'TOO_MANY' | 'PRIVATE_LOCAL' | 'NO_SSH_PROGRAM' | 'CERT_NAME' | 'CERT_BAD' | 'NO_CPANEL' | 'BAD_TOKEN' | 'CPANEL_FAILED' | 'CONNECTED' | 'UNKNOWN';

/** Buttons a diagnosis offers (web/ssh.js maps each to a handler). */
export type DiagAction = 'edit-address' | 'find-port' | 'set-port' | 'retry' | 'trust-new' | 'leave' | 'cpanel' | 'paste' | 'password' | 'steps' | 'check' | 'edit-user' | 'test' | 'use-cert-name' | 'details';

export const DIAG: Record<DiagCode, { title: string; fix: string; actions: DiagAction[] }> = {
  DNS: { title: en('I can’t find “{host}”.'), fix: en('Check the spelling. If it’s your website’s name, try the server name from your host’s welcome email.'), actions: ['edit-address'] },
  PORT_CLOSED: { title: en('Nothing answers SSH on {host} (ports tried: {ports}).'), fix: en('Shared hosts often use another port (2222, 21098, 18765, 65002). Or SSH may be switched off for your account: in cPanel look under Security → SSH Access, or ask your host.'), actions: ['find-port', 'set-port'] },
  TIMEOUT: { title: en('{host} didn’t answer (ports tried: {ports}).'), fix: en('The address may be wrong, a firewall may block SSH, or your host may have blocked this computer after failed sign-ins (cPanel’s cPHulk does this). Wait 15 minutes, or ask your host to unblock this computer’s address.'), actions: ['retry', 'set-port'] },
  NOT_SSH: { title: en('Port {port} answers, but it isn’t SSH (it looks like a web server).'), fix: en('Let Sara look for the SSH port, or set it yourself.'), actions: ['find-port', 'set-port'] },
  HOSTKEY_CHANGED: { title: en('Stop: {host} is showing a different ID card.'), fix: en('It was {old} and now it is {new}. This happens when a server is reinstalled or moved to a new machine, and also when someone is in between you and it. Sara stopped and didn’t sign in.'), actions: ['trust-new', 'leave'] },
  PASSWORD_OFF: { title: en('This server doesn’t accept passwords at all (it only takes keys).'), fix: en('That’s normal and safer. Let Sara add her key another way.'), actions: ['cpanel', 'paste'] },
  WRONG_PASSWORD: { title: en('The server said no to that password.'), fix: en('Check it (cPanel and SSH use the cPanel password on most hosts). Several wrong tries can get this computer blocked for a while.'), actions: ['retry'] },
  KEY_NOT_ACCEPTED: { title: en('The server doesn’t accept Sara’s key yet.'), fix: en('On cPanel: Manage SSH Keys → find sara → Manage → Authorize. Otherwise check the line is in ~/.ssh/authorized_keys of user {user}. (It can also mean the user name is wrong: SSH servers don’t say which.)'), actions: ['steps', 'check', 'edit-user'] },
  WRONG_USER: { title: en('There is no cPanel user “{user}” on this server, or that token isn’t for it.'), fix: en('Your cPanel user name is at the top right of cPanel. If the token was deleted or has expired, make a new one.'), actions: ['edit-user'] },
  NO_SHELL: { title: en('Sara’s key works, but this account isn’t allowed to run commands (shell access is off).'), fix: en('In WHM: Account Functions → Manage Shell Access → choose Jailed Shell (or Normal Shell) for {user}. On shared hosting: switch on SSH in your host’s panel or ask support.'), actions: ['test'] },
  JAILED: { title: en('Connected, with a limited shell (jailshell).'), fix: en('Most file and website commands work; system commands (sudo, services) don’t.'), actions: [] },
  TWO_STEP: { title: en('The server wants a second step (a code) after the key.'), fix: en('Sara can’t type codes. Ask your host to allow key-only sign-in for this user.'), actions: [] },
  TOO_MANY: { title: en('The server cut the connection.'), fix: en('It may be limiting sign-ins; wait a few minutes.'), actions: ['retry'] },
  PRIVATE_LOCAL: { title: en('Private local mode is on.'), fix: en('While “Nothing leaves this computer” is on, Sara only connects to this computer.'), actions: [] },
  NO_SSH_PROGRAM: { title: en('The ssh program isn’t on the Sara computer.'), fix: en('It comes with OpenSSH: openssh-client on Linux, built into macOS and Windows 10/11.'), actions: [] },
  CERT_NAME: { title: en('cPanel’s certificate is for {other}, not {host}.'), fix: en('Use that name for cPanel? Your SSH address stays the same. Sara doesn’t send the token until the certificate matches.'), actions: ['use-cert-name', 'paste'] },
  CERT_BAD: { title: en('cPanel’s certificate on {host} can’t be checked.'), fix: en('Sara doesn’t send a token over a connection she can’t verify. Add her key by copy and paste instead.'), actions: ['paste'] },
  NO_CPANEL: { title: en('cPanel doesn’t answer on {host}.'), fix: en('Check the address, or add Sara’s key by copy and paste instead.'), actions: ['paste'] },
  BAD_TOKEN: { title: en('That doesn’t look like a cPanel token.'), fix: en('A cPanel token is 32 capital letters and digits. Press Copy next to the new token in cPanel and paste it here.'), actions: [] },
  CPANEL_FAILED: { title: en('cPanel didn’t install the key.'), fix: en('Add the key by copy and paste instead: the steps are below.'), actions: ['paste'] },
  CONNECTED: { title: en('Connected. Sara can work on {name}.'), fix: '', actions: [] },
  UNKNOWN: { title: en('Something else went wrong.'), fix: en('Press Details to see what ssh said, or try again.'), actions: ['details', 'retry'] },
};

export interface Diagnosis {
  code: DiagCode;
  /** English, filled (for the tools and the chat). */
  title: string;
  fix: string;
  /** The templates and their values, so the page shows them in the owner's language. */
  titleKey: string;
  fixKey: string;
  params: Record<string, string>;
  actions: DiagAction[];
  /** Raw (scrubbed) ssh text, behind "Details". */
  details?: string;
}

export function diagnosis(code: DiagCode, params: Record<string, string | number | undefined> = {}, details?: string, actions?: DiagAction[]): Diagnosis {
  const d = DIAG[code];
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p[k] = String(v);
  return { code, title: fill(d.title, p), fix: fill(d.fix, p), titleKey: d.title, fixKey: d.fix, params: p, actions: actions ?? d.actions, ...(details ? { details } : {}) };
}

/** The list in "Permission denied (publickey,password)." — the methods the server still allows. */
export function deniedMethods(stderr: string): string[] | undefined {
  const all = [...stderr.matchAll(/Permission denied \(([^)]*)\)/g)];
  const m = all.at(-1);
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : undefined;
}

export const passwordsAllowed = (methods: string[]): boolean => methods.includes('password') || methods.includes('keyboard-interactive');

const HOSTKEY_FAIL = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed|No (?:ED25519|ECDSA|RSA)? ?host key is known/i;

/** Last few lines of ssh's stderr, scrubbed of secrets, for "Details". */
export function scrubbed(text: string, secrets: (string | undefined)[] = []): string {
  let t = String(text ?? '');
  for (const x of secrets) if (x) t = t.split(x).join('[REDACTED]');
  return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join('\n').slice(0, 600);
}

/**
 * Reads one ssh run (exit code, stderr, stdout) and says what happened in plain words.
 * mode: what the run was (a password try, a key try, the methods check, or the test).
 */
export function diagnoseRun(
  r: RunResult,
  ctx: { mode: 'password' | 'key' | 'methods' | 'test'; host: string; port: number; user: string; name: string; secrets?: string[]; fingerprint?: string; pending?: string },
): Diagnosis | undefined {
  const err = String(r.stderr ?? '');
  const out = String(r.stdout ?? '');
  const details = scrubbed(`${err}`, ctx.secrets);
  const p = { host: ctx.host, port: ctx.port, ports: ctx.port, user: ctx.user, name: ctx.name };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No such host is known|Temporary failure in name resolution/i.test(err)) return diagnosis('DNS', p, details);
  if (HOSTKEY_FAIL.test(err)) return diagnosis('HOSTKEY_CHANGED', { ...p, old: ctx.fingerprint ?? '?', new: ctx.pending ?? '?' }, details);
  if (/Connection refused/i.test(err)) return diagnosis('PORT_CLOSED', p, details);
  if (/timed out|Operation timed out|Network is unreachable|No route to host/i.test(err) || r.timedOut) return diagnosis('TIMEOUT', p, details);
  if (/Too many authentication failures/i.test(err)) return diagnosis('TOO_MANY', p, details);
  if (/Shell access is not enabled|This account is currently not available|This service allows sftp connections only/i.test(err + out)) return diagnosis('NO_SHELL', p, details);
  if (/partial success/i.test(err)) return diagnosis('TWO_STEP', p, details);
  const methods = deniedMethods(err);
  if (methods) {
    if (ctx.mode === 'password') return diagnosis(passwordsAllowed(methods) ? 'WRONG_PASSWORD' : 'PASSWORD_OFF', p, details);
    if ((ctx.mode === 'key' || ctx.mode === 'test') && !methods.includes('publickey') && methods.length) return diagnosis('TWO_STEP', p, details);
    if (ctx.mode === 'key' || ctx.mode === 'test') return diagnosis('KEY_NOT_ACCEPTED', p, details);
    return undefined;
  }
  if (/Connection (closed|reset) by|kex_exchange_identification|banner exchange/i.test(err)) return diagnosis('TOO_MANY', p, details);
  if (/(^|\s)ssh(\.exe)?: (not found|command not found)|ENOENT|is not recognized as an internal/i.test(err) || r.code === null && /spawn/i.test(err)) return diagnosis('NO_SSH_PROGRAM', p, details);
  if (ctx.mode === 'test' && (r.code === 0 || r.code === 1) && !/sara-ok/.test(out)) return diagnosis('NO_SHELL', p, details);
  if (r.code === 0) return undefined;
  return diagnosis('UNKNOWN', p, details || `exit code ${r.code ?? 'none'}`);
}

/** A Diagnosis as one English sentence (tools, chat, lastError). */
export const diagText = (d: Diagnosis): string => [d.title, d.fix].filter(Boolean).join(' ');
