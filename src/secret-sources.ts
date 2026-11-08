// EC10 (docs/ops/EC10_DESIGN.md): external secret sources. A vault entry may hold a reference
// (env:NAME, file:/run/secrets/x, vault:mount/path#key, op://vault/item/field, keychain:service/account,
// cmd:program args) that is resolved at use time, cached in memory for a short time, never written
// back and never logged. Errors are plain words without any value or token.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { en, fill } from './i18n.ts';
import { netFetch, PrivateLocalError } from './net-guard.ts';

export type SourceKind = 'env' | 'file' | 'vault' | 'op' | 'keychain' | 'cmd';
export interface SecretRef {
  kind: SourceKind;
  /** The normalized reference text (not a secret; shown in Settings). */
  raw: string;
  name?: string;
  path?: string;
  mount?: string;
  key?: string;
  vault?: string;
  item?: string;
  section?: string;
  field?: string;
  service?: string;
  account?: string;
  argv?: string[];
  jsonPath?: string;
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a program without a shell. Rejects (code ENOENT/ETIMEDOUT) only when it could not run. */
export type CommandRunner = (cmd: string, args: string[], o?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<CommandResult>;

/** A plain-words failure. `key` is the English template and `params` its values (the app translates it). */
export class SecretSourceError extends Error {
  readonly key: string;
  readonly params?: Record<string, string | number>;
  constructor(key: string, params?: Record<string, string | number | undefined>) {
    super(fill(key, params));
    this.name = 'SecretSourceError';
    this.key = key;
    if (params) this.params = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
  }
}
const fail = (key: string, params?: Record<string, string | number | undefined>, from?: { errorKey?: string; params?: Record<string, string | number> }): never => {
  throw new SecretSourceError(from?.errorKey ?? key, from?.errorKey ? from.params : params);
};

export const MAX_KEYS = 8;
const MAX_SECRET = 65_536;
const TIMEOUT_MS = 10_000;

function parseOne(text: string): SecretRef | undefined {
  const raw = text.trim();
  if (!raw || raw.length > 2048 || /[\r\n\0]/.test(raw)) return undefined;
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^env:([A-Za-z_][A-Za-z0-9_]{0,127})$/))) return { kind: 'env', raw, name: m[1] };
  if ((m = raw.match(/^file:((?:\/|[A-Za-z]:[\\/])[^\0]{1,1023})$/))) return { kind: 'file', raw, path: m[1] };
  if ((m = raw.match(/^vault:([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.\/-]{1,512})#([^\s#]{1,256})$/)) && !m[2].split('/').some((s) => s === '' || s === '..' || s === '.'))
    return { kind: 'vault', raw, mount: m[1], path: m[2], key: m[3] };
  if ((m = raw.match(/^op:\/\/([^/]{1,256})\/([^/]{1,256})\/(?:([^/]{1,256})\/)?([^/]{1,256})$/)) && [m[1], m[2], m[3], m[4]].every((s) => s === undefined || s.trim() === s))
    return { kind: 'op', raw, vault: m[1], item: m[2], ...(m[3] ? { section: m[3] } : {}), field: m[4] };
  if ((m = raw.match(/^keychain:([^/\s]{1,256})\/([^/\s]{1,256})$/))) return { kind: 'keychain', raw, service: m[1], account: m[2] };
  if ((m = raw.match(/^cmd:(.+)$/))) {
    const argv = tokenize(m[1]);
    if (!argv?.length) return undefined;
    let jsonPath: string | undefined;
    const last = argv.at(-1)!;
    if (/^#[A-Za-z0-9_.-]{1,128}$/.test(last)) jsonPath = argv.pop()!.slice(1);
    if (!argv.length) return undefined;
    return { kind: 'cmd', raw, argv, ...(jsonPath ? { jsonPath } : {}) };
  }
  return undefined;
}

/** Splits a command line on spaces; double quotes group (no shell, no expansion). */
function tokenize(s: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of s) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (ch === ' ' && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quoted) return undefined;
  if (has) out.push(cur);
  return out;
}

/** The references in a value (several keys separated by `|`), or undefined when it is a plain value. */
export function parseReference(text: unknown): SecretRef[] | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const parts = text.split('|');
  if (parts.length > MAX_KEYS) return undefined;
  const refs: SecretRef[] = [];
  for (const p of parts) {
    const r = parseOne(p);
    if (!r) return undefined;
    refs.push(r);
  }
  return refs;
}
export const isReference = (text: unknown): boolean => parseReference(text) !== undefined;

interface Entry {
  value?: string;
  error?: string;
  errorKey?: string;
  params?: Record<string, string | number>;
  /** When the last attempt finished (ms). */
  at: number;
  /** When the value was last read successfully (ms). */
  okAt?: number;
}
export interface Peek {
  value?: string;
  error?: string;
  errorKey?: string;
  params?: Record<string, string | number>;
  checkedAt?: number;
}
export interface SourcesOptions {
  env?: Record<string, string | undefined>;
  /** The HTTP client (tests); default netFetch, so private local mode applies to remote sources too. */
  fetch?: typeof netFetch;
  run?: CommandRunner;
  platform?: string;
  now?: () => number;
  ttlMs?: number;
  /** Called when a reference starts failing or works again (for the audit trail). */
  onStatus?: (raw: string, ok: boolean, message?: string) => void;
}

export const defaultRunner: CommandRunner = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: o?.timeoutMs ?? TIMEOUT_MS, maxBuffer: MAX_SECRET, windowsHide: true, shell: false, env: { ...process.env, ...o?.env } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (e && typeof e.code === 'string') return reject(e);
      if (e?.killed) return reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

// Windows Credential Manager: a generic credential read with CredRead. The target name comes in
// through the environment (SARA_KC_TARGET), never through the script text.
const WIN_CRED = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;
$s='[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CredRead(string t,int y,int f,out IntPtr c);[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct C{public int Flags;public int Type;public string TargetName;public string Comment;public long LastWritten;public int BlobSize;public IntPtr Blob;public int Persist;public int AttrCount;public IntPtr Attrs;public string Alias;public string UserName;}';
$k=Add-Type -MemberDefinition $s -Name Cred -Namespace SaraKeychain -PassThru;$p=[IntPtr]::Zero;
if(-not $k[0]::CredRead($env:SARA_KC_TARGET,1,0,[ref]$p)){exit 3};
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type]$k[1]);
[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($c.Blob,[int]($c.BlobSize/2)));$k[0]::CredFree($p)`;

const clean = (s: string): string => s.replace(/\r?\n$/, '');

export class SecretSources {
  readonly #o: SourcesOptions;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #extra = new Set<string>();

  constructor(o: SourcesOptions = {}) {
    this.#o = o;
  }
  get #env(): Record<string, string | undefined> {
    return this.#o.env ?? process.env;
  }
  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }
  get ttlMs(): number {
    if (this.#o.ttlMs !== undefined) return this.#o.ttlMs;
    const s = Number(this.#env.SARA_SECRET_TTL);
    return (Number.isFinite(s) && s >= 10 && s <= 86_400 ? s : 300) * 1000;
  }
  set onStatus(fn: SourcesOptions['onStatus']) {
    this.#o.onStatus = fn;
  }

  /** Synchronous view for Vault.get: env live, file read when stale, remote from cache (refreshing in the background). */
  peek(ref: SecretRef): Peek {
    if (ref.kind === 'env') {
      try {
        const v = this.#readEnv(ref);
        this.#ok(ref.raw, v);
        return { value: v, checkedAt: this.#now() };
      } catch (e) {
        this.#failed(ref.raw, e);
        return this.#view(this.#cache.get(ref.raw)!, false);
      }
    }
    const e = this.#cache.get(ref.raw);
    const stale = !e || this.#now() - e.at >= this.ttlMs;
    if (stale && ref.kind === 'file') {
      try {
        this.#ok(ref.raw, this.#readFile(ref));
      } catch (err) {
        this.#failed(ref.raw, err);
      }
      return this.#view(this.#cache.get(ref.raw)!);
    }
    if (stale) void this.resolve(ref, true).catch(() => {});
    return e ? this.#view(e) : {};
  }

  /** Reads the secret now (or from a fresh cache). Throws SecretSourceError in plain words. */
  async resolve(ref: SecretRef, force = false): Promise<string> {
    if (ref.kind === 'env') return this.peek(ref).value ?? fail(this.peek(ref).error!, undefined, this.peek(ref));
    const e = this.#cache.get(ref.raw);
    if (!force && e?.value !== undefined && !e.error && this.#now() - e.at < this.ttlMs) return e.value;
    const running = this.#inflight.get(ref.raw);
    if (running) return running;
    const p = (async () => {
      try {
        const v = await this.#read(ref);
        if (!v) fail(en('The secret is empty.'));
        if (v.length > MAX_SECRET) fail(en('The secret is too long.'));
        this.#ok(ref.raw, v);
        return v;
      } catch (err) {
        const e = err instanceof SecretSourceError ? err : new SecretSourceError(en('The secret could not be read.'));
        this.#failed(ref.raw, e);
        throw e;
      } finally {
        this.#inflight.delete(ref.raw);
      }
    })();
    this.#inflight.set(ref.raw, p);
    return p;
  }

  /** Waits for every background refresh (tests, start-up). */
  async settled(): Promise<void> {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight.values()]);
  }

  /** Every value read so far plus the tokens of the sources themselves (for redaction). */
  values(): string[] {
    const out = [...this.#extra];
    for (const e of this.#cache.values()) if (e.value) out.push(e.value);
    for (const k of ['VAULT_TOKEN', 'OP_CONNECT_TOKEN']) {
      const v = this.#env[k];
      if (v) out.push(v);
    }
    return out;
  }

  status(raw: string): Peek {
    const e = this.#cache.get(raw);
    return e ? this.#view(e) : {};
  }
  #view(e: Entry, withValue = true): Peek {
    return { ...(withValue && e.value !== undefined ? { value: e.value } : {}), ...(e.error ? { error: e.error, errorKey: e.errorKey, ...(e.params ? { params: e.params } : {}) } : {}), checkedAt: e.at };
  }

  forget(raw: string): void {
    this.#cache.delete(raw);
  }

  #store(raw: string, next: Entry): void {
    const prev = this.#cache.get(raw);
    this.#cache.set(raw, next);
    // One status change per transition, and only for a reference that has worked before (one that
    // never worked shows in Settings; it is not news).
    if (prev?.okAt !== undefined && Boolean(prev.error) !== Boolean(next.error)) this.#o.onStatus?.(raw, !next.error, next.error);
  }
  #ok(raw: string, value: string): void {
    const now = this.#now();
    this.#store(raw, { value, at: now, okAt: now });
  }
  #failed(raw: string, err: unknown): void {
    const prev = this.#cache.get(raw);
    const e = err instanceof SecretSourceError ? err : new SecretSourceError(en('The secret could not be read.'));
    this.#store(raw, { value: prev?.value, okAt: prev?.okAt, at: this.#now(), error: e.message, errorKey: e.key, ...(e.params ? { params: e.params } : {}) });
  }

  #readEnv(ref: SecretRef): string {
    const v = this.#env[ref.name!];
    if (!v) fail(en('The environment variable {name} is not set.'), { name: ref.name });
    return v!;
  }

  #readFile(ref: SecretRef): string {
    let text: string;
    try {
      if (statSync(ref.path!).size > MAX_SECRET) fail(en('The file {path} is too big for a secret.'), { path: ref.path });
      text = readFileSync(ref.path!, 'utf8');
    } catch (e) {
      if (e instanceof SecretSourceError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? fail(en('The file {path} does not exist.'), { path: ref.path }) : code === 'EACCES' || code === 'EPERM' ? fail(en("The file {path} can't be read (permission denied)."), { path: ref.path }) : fail(en("The file {path} can't be read ({code})."), { path: ref.path, code: code ?? 'error' });
    }
    const v = clean(text);
    if (!v) fail(en('The file {path} is empty.'), { path: ref.path });
    return v;
  }

  async #read(ref: SecretRef): Promise<string> {
    switch (ref.kind) {
      case 'file':
        return this.#readFile(ref);
      case 'vault':
        return this.#readVault(ref);
      case 'op':
        return this.#readOp(ref);
      case 'keychain':
        return this.#readKeychain(ref);
      case 'cmd':
        return this.#readCmd(ref);
      default:
        return this.#readEnv(ref);
    }
  }

  async #get(service: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const f = this.#o.fetch ?? netFetch;
    let res: Response;
    try {
      res = await f(url, { headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const host = new URL(url).host;
      if (e instanceof PrivateLocalError) return fail(en('{service} at {host} is blocked by private local mode.'), { service, host });
      if ((e as Error).name === 'TimeoutError') return fail(en("{service} can't be reached at {host} (no answer in 10 seconds)."), { service, host });
      return fail(en("{service} can't be reached at {host} ({code})."), { service, host, code: (e as { cause?: { code?: string } }).cause?.code ?? 'connection failed' });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  async #readVault(ref: SecretRef): Promise<string> {
    const env = this.#env;
    const addr = env.VAULT_ADDR?.replace(/\/+$/, '');
    if (!addr) fail(en('VAULT_ADDR is not set on the server, so Vault references cannot be read.'));
    let token = env.VAULT_TOKEN;
    if (!token && env.VAULT_TOKEN_FILE) {
      try {
        token = clean(readFileSync(env.VAULT_TOKEN_FILE, 'utf8')).trim();
        if (token) this.#extra.add(token);
      } catch {
        fail(en("The Vault token file {path} can't be read."), { path: env.VAULT_TOKEN_FILE });
      }
    }
    if (!token) fail(en('VAULT_TOKEN (or VAULT_TOKEN_FILE) is not set on the server, so Vault references cannot be read.'));
    const where = `${ref.mount}/${ref.path}`;
    const path = ref.path!.split('/').map(encodeURIComponent).join('/');
    const headers: Record<string, string> = { 'x-vault-token': token! };
    if (env.VAULT_NAMESPACE) headers['x-vault-namespace'] = env.VAULT_NAMESPACE;
    const { status, body } = await this.#get('Vault', `${addr}/v1/${encodeURIComponent(ref.mount!)}/data/${path}`, headers);
    if (status === 404) fail(en('Vault has no secret at {where} (404).'), { where });
    if (status === 401 || status === 403) {
      const said = (body as { errors?: unknown[] } | undefined)?.errors?.find((x): x is string => typeof x === 'string' && x.length < 120 && !x.includes(token!));
      fail(said ? en('Vault refused {where} ({status}: {said}). Check the token and its policy.') : en('Vault refused {where} ({status}). Check the token and its policy.'), { where, status, said });
    }
    if (status !== 200) fail(en('Vault answered {status} for {where}.'), { status, where });
    const data = (body as { data?: { data?: Record<string, unknown> } } | undefined)?.data?.data;
    if (!data || typeof data !== 'object') fail(en("Vault's answer for {where} is not a KV version 2 secret."), { where });
    const v = data![ref.key!];
    if (v === undefined || v === null) fail(en('Vault has no key "{key}" in {where}.'), { key: ref.key, where });
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  async #readOp(ref: SecretRef): Promise<string> {
    const host = this.#env.OP_CONNECT_HOST?.replace(/\/+$/, '');
    const token = this.#env.OP_CONNECT_TOKEN;
    if (!host || !token) fail(en('OP_CONNECT_HOST and OP_CONNECT_TOKEN are not set on the server, so 1Password references cannot be read.'));
    const h = { authorization: `Bearer ${token}` };
    const get = async (path: string) => {
      const r = await this.#get('1Password Connect', host + path, h);
      if (r.status === 401 || r.status === 403) fail(en('1Password Connect refused the request ({status}). Check OP_CONNECT_TOKEN and its access.'), { status: r.status });
      return r;
    };
    const named = (list: unknown, key: 'name' | 'title', want: string) => (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []).find((x) => x.id === want || x[key] === want);
    const vaults = await get('/v1/vaults');
    if (vaults.status !== 200) fail(en('1Password Connect answered {status} when listing vaults.'), { status: vaults.status });
    const vault = named(vaults.body, 'name', ref.vault!);
    if (!vault) fail(en('1Password Connect has no vault "{vault}".'), { vault: ref.vault });
    const vid = encodeURIComponent(String(vault!.id));
    const items = await get(`/v1/vaults/${vid}/items`);
    const item = items.status === 200 ? named(items.body, 'title', ref.item!) : undefined;
    if (!item) fail(en('1Password Connect has no item "{item}" in vault "{vault}".'), { item: ref.item, vault: ref.vault });
    const full = await get(`/v1/vaults/${vid}/items/${encodeURIComponent(String(item!.id))}`);
    if (full.status !== 200) fail(en('1Password Connect answered {status} for item "{item}".'), { status: full.status, item: ref.item });
    const b = full.body as { fields?: Array<{ id?: string; label?: string; value?: string; section?: { id?: string } }>; sections?: Array<{ id?: string; label?: string }> };
    let fields = (b.fields ?? []).filter((f) => f.id === ref.field || f.label === ref.field);
    if (ref.section) {
      const ids = new Set((b.sections ?? []).filter((s) => s.id === ref.section || s.label === ref.section).map((s) => s.id));
      fields = fields.filter((f) => f.section?.id && ids.has(f.section.id));
    } else fields.sort((x, y) => Number(Boolean(x.section)) - Number(Boolean(y.section)));
    if (!fields.length) fail(en('1Password Connect has no field "{field}" in item "{item}".'), { field: ref.field, item: ref.item });
    const v = fields[0].value;
    if (!v) fail(en('The field "{field}" in item "{item}" is empty.'), { field: ref.field, item: ref.item });
    return v!;
  }

  async #readKeychain(ref: SecretRef): Promise<string> {
    const platform = this.#o.platform ?? process.platform;
    const run = this.#o.run ?? defaultRunner;
    const target = `${ref.service}/${ref.account}`;
    const how: [string, string[], Record<string, string>?] | undefined =
      platform === 'darwin'
        ? ['security', ['find-generic-password', '-s', ref.service!, '-a', ref.account!, '-w']]
        : platform === 'linux' || platform === 'freebsd'
          ? ['secret-tool', ['lookup', 'service', ref.service!, 'account', ref.account!]]
          : platform === 'win32'
            ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_CRED], { SARA_KC_TARGET: target }]
            : undefined;
    if (!how) return fail(en('There is no keychain Sara can read on this system.'));
    let r: CommandResult;
    try {
      r = await run(how[0], how[1], how[2] ? { env: how[2] } : undefined);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? fail(en('{program} is not installed, so the keychain cannot be read.'), { program: how[0] }) : fail(code === 'ETIMEDOUT' ? en('The keychain did not answer in 10 seconds.') : en('The keychain could not be read.'));
    }
    const v = clean(r.stdout);
    if (r.code !== 0 || !v) fail(en('The keychain has no entry for {target}.'), { target });
    return v;
  }

  async #readCmd(ref: SecretRef): Promise<string> {
    if (this.#env.SARA_SECRET_COMMANDS !== '1') fail(en('Commands as secret sources are off. Set SARA_SECRET_COMMANDS=1 on the server to allow them.'));
    const [cmd, ...args] = ref.argv!;
    const run = this.#o.run ?? defaultRunner;
    let r: CommandResult;
    try {
      r = await run(cmd, args);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return fail(code === 'ENOENT' ? en('The command "{cmd}" is not installed or not on the PATH.') : code === 'ETIMEDOUT' ? en('The command "{cmd}" took longer than 10 seconds.') : en('The command "{cmd}" could not run.'), { cmd });
    }
    if (r.code !== 0) fail(en('The command "{cmd}" failed (exit code {code}).'), { cmd, code: r.code });
    const out = clean(r.stdout).trim();
    if (!ref.jsonPath) return out;
    let v: unknown;
    try {
      v = JSON.parse(out);
      for (const part of ref.jsonPath.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    } catch {
      v = undefined;
    }
    if (typeof v !== 'string' || !v) fail(en('The command "{cmd}" did not print JSON with "{path}".'), { cmd, path: ref.jsonPath });
    return v as string;
  }
}

let shared = new SecretSources();
/** The server's one resolver (shared by every Vault instance). */
export function secretSources(): SecretSources {
  return shared;
}
export function setSecretSources(s: SecretSources): void {
  shared = s;
}
