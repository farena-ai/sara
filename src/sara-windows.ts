// Phase 46c: the `sara` admin command on Windows (bin\sara.cmd runs this with Sara's own Node).
//
//   sara status              is she running, how she runs, her address, data size, last backup
//   sara doctor              deeper checks (database, model providers, backups)
//   sara backup [file]       back up now (default: <data>\backups\…)
//   sara backups             list backups
//   sara restore <file>      stop her, restore a backup (current data kept aside), start her
//   sara reset-token         a new owner token (signs out every browser), then restarts her
//   sara logs [N]            the last N lines of her log (default 60)
//   sara access [how]        how you reach her; change it: local | tailscale | lan | domain
//                            (domain: --domain sara.example.com), also --port N
//   sara start | stop | restart
//   sara update              opens the download page (run the newer Sara-Setup.exe to update)
//   sara uninstall [--delete-data]   runs the uninstaller
//   sara version
//
// The installer also uses two internal commands: `setup` (writes sara.env and sets up how she's
// reached) and `unconfigure` (takes her out of Tailscale serve and the firewall again).
// Settings live in sara.env next to SaraService.exe; the service reads it at every start.
import { netFetch } from './net-guard.ts';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'service' | 'user';
export type Access = 'local' | 'tailscale' | 'lan' | 'domain';
export const ACCESS: readonly Access[] = ['local', 'tailscale', 'lan', 'domain'];
export const DOWNLOAD_PAGE = 'https://github.com/farena-ai/sara/releases/latest';
export const HTTPS_GUIDE = 'https://github.com/farena-ai/sara/blob/main/docs/INSTALL.md#2-reach-her-securely-https';

// ---- sara.env ----

/** KEY=VALUE lines (# comments, optional quotes) → a map. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/** The file with `patch` applied: changed keys stay where they were, new ones are appended,
 *  `undefined` removes a key. Comments and unknown keys are kept. */
export function updateEnv(text: string, patch: Record<string, string | undefined>): string {
  const left = new Map(Object.entries(patch));
  const lines: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const eq = raw.indexOf('=');
    const key = eq > 0 && !raw.trim().startsWith('#') ? raw.slice(0, eq).trim() : '';
    if (key && left.has(key)) {
      const v = left.get(key);
      left.delete(key);
      if (v !== undefined) lines.push(`${key}=${v}`);
      continue;
    }
    lines.push(raw);
  }
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const [k, v] of left) if (v !== undefined) lines.push(`${k}=${v}`);
  return `${lines.join('\r\n')}\r\n`;
}

export function validPort(p: string | number): boolean {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}
export function validDomain(d: string): boolean {
  return d.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i.test(d);
}
export function cleanDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export interface AccessInput {
  mode: Access;
  port: number;
  lanIp?: string;
  /** Tailscale name of this computer (no trailing dot) and the HTTPS port `tailscale serve` uses. */
  tsName?: string;
  tsPort?: number;
  domain?: string;
}

/** The sara.env values for one way of reaching her. */
export function accessEnv(a: AccessInput): Record<string, string | undefined> {
  const local = `http://127.0.0.1:${a.port}`;
  const base = { SARA_PORT: String(a.port), SARA_ACCESS: a.mode, SARA_TS_HTTPS_PORT: undefined as string | undefined };
  switch (a.mode) {
    case 'local':
      return { ...base, SARA_HOST: '127.0.0.1', SARA_SECURE_COOKIES: '0', SARA_TRUST_PROXY: '0', SARA_PUBLIC_URL: local };
    case 'lan':
      if (!a.lanIp) throw new Error("Couldn't find this computer's address on your home network.");
      // Every address, so this computer's own app keeps using 127.0.0.1.
      return { ...base, SARA_HOST: '0.0.0.0', SARA_SECURE_COOKIES: '0', SARA_TRUST_PROXY: '0', SARA_PUBLIC_URL: `http://${a.lanIp}:${a.port}` };
    case 'tailscale': {
      if (!a.tsName) throw new Error("Couldn't read this computer's Tailscale name.");
      const p = a.tsPort ?? 443;
      return { ...base, SARA_HOST: '127.0.0.1', SARA_SECURE_COOKIES: '1', SARA_TRUST_PROXY: '1', SARA_PUBLIC_URL: `https://${a.tsName}${p === 443 ? '' : `:${p}`}`, SARA_TS_HTTPS_PORT: String(p) };
    }
    case 'domain':
      if (!a.domain || !validDomain(a.domain)) throw new Error(`'${a.domain ?? ''}' doesn't look like a web address (like sara.example.com).`);
      return { ...base, SARA_HOST: '127.0.0.1', SARA_SECURE_COOKIES: '1', SARA_TRUST_PROXY: '1', SARA_PUBLIC_URL: `https://${a.domain}` };
  }
}

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * Which HTTPS port `tailscale serve` should use: 443 when it is free or already Sara's, else the
 * first free one of a few others. Never takes over what the owner serves there already.
 */
export function pickServePort(statusJson: string, dnsName: string, target: string): { port: number; ours: boolean } {
  let st: ServeStatus = {};
  try {
    st = (JSON.parse(statusJson || '{}') ?? {}) as ServeStatus;
  } catch {
    st = {};
  }
  const used = new Set(Object.keys(st.TCP ?? {}).map(Number));
  for (const [hostPort, web] of Object.entries(st.Web ?? {})) {
    const p = Number(hostPort.split(':').at(-1));
    if (hostPort.toLowerCase().startsWith(`${dnsName.toLowerCase()}:`) && Object.values(web.Handlers ?? {}).some((h) => h.Proxy?.replace(/\/$/, '') === target)) return { port: p, ours: true };
  }
  for (const p of [443, 8443, 10443, 4443, 5443, 6443, 7443]) if (!used.has(p)) return { port: p, ours: false };
  return { port: 0, ours: false };
}

/** Is the HTTPS port's handler still pointing at Sara (so turning it off can't break anything else)? */
export function serveIsOurs(statusJson: string, port: number, target: string): boolean {
  try {
    const st = JSON.parse(statusJson || '{}') as ServeStatus;
    return Object.entries(st.Web ?? {}).some(([hp, w]) => Number(hp.split(':').at(-1)) === port && Object.values(w.Handlers ?? {}).some((h) => h.Proxy?.replace(/\/$/, '') === target));
  } catch {
    return false;
  }
}

/** A sara.log line ({t, level, msg}) as plain text. */
export function formatLogLine(line: string): string {
  try {
    const x = JSON.parse(line) as { t?: string; level?: string; msg?: string };
    if (typeof x.msg === 'string') return `${(x.t ?? '').replace('T', ' ').slice(0, 19)} ${(x.level ?? 'info').toUpperCase().padEnd(5)} ${x.msg}`;
  } catch {
    /* not JSON: as it is */
  }
  return line;
}

export function modeLabel(mode: string | undefined): string {
  return mode === 'service' ? 'a Windows service, from when the computer starts' : mode === 'user' ? "only while you're signed in" : 'not set';
}
export function accessLabel(a: string | undefined): string {
  return a === 'tailscale' ? 'Tailscale (private to your own devices, HTTPS)' : a === 'lan' ? 'your home network (plain HTTP)' : a === 'domain' ? 'your own web address (HTTPS set up by you)' : 'just this computer';
}

// ---- running things ----

const here = dirname(fileURLToPath(import.meta.url));
/** <install>\server\src → <install> */
const APP = resolve(here, '..', '..');
const SERVER = resolve(here, '..');
const MAIN = join(SERVER, 'src', 'main.ts');
const ENV_FILE = join(APP, 'sara.env');
const SERVICE_EXE = join(APP, 'SaraService.exe');

function say(s = ''): void {
  process.stdout.write(`${s}\n`);
}
function fail(s: string, code = 1): never {
  process.stderr.write(`${s}\n`);
  process.exit(code);
}

function readConfig(): Record<string, string> {
  try {
    return parseEnv(readFileSync(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(patch: Record<string, string | undefined>): void {
  let old = '';
  try {
    old = readFileSync(ENV_FILE, 'utf8');
  } catch {
    old = '# Sara settings (Windows). Changed by the installer and `sara access`; read at every start.\r\n';
  }
  try {
    writeFileSync(ENV_FILE, updateEnv(old, patch));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EACCES') fail(needAdmin());
    throw err;
  }
}
function needAdmin(): string {
  return 'This needs a terminal opened as administrator (right-click Terminal or Command Prompt → Run as administrator), then run the same sara command again.';
}

function cfgOrFail(): Record<string, string> {
  const c = readConfig();
  if (!c.SARA_DATA) fail(`Sara's settings (${ENV_FILE}) are missing. Run Sara-Setup.exe again to repair her.`);
  return c;
}
/** The data folder is readable (service installs keep it to administrators and the service). */
function checkDataAccess(c: Record<string, string>): void {
  try {
    if (existsSync(c.SARA_DATA)) readdirSync(c.SARA_DATA);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') fail(`Her data folder (${c.SARA_DATA}) is private to the Sara service. ${needAdmin()}`);
  }
}

function serverEnv(c: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...c, SARA_INSTALLED: '1' };
}
/** node src/main.ts --<flag> … with her settings; returns the exit code. */
function runMain(c: Record<string, string>, args: string[], inherit = true): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], { cwd: SERVER, env: serverEnv(c), stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function service(arg: string): { code: number; out: string } {
  const r = spawnSync(SERVICE_EXE, [arg], { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function healthUrl(c: Record<string, string>): string {
  return `http://127.0.0.1:${c.SARA_PORT || '7860'}/api/health`;
}
async function healthy(c: Record<string, string>, seconds = 30): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    const ok = await netFetch(healthUrl(c), { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopHer(c: Record<string, string>): void {
  const r = service('--stop');
  if (r.code === 5) fail(needAdmin());
  if (r.code !== 0) fail(`She didn't stop (${r.out || `code ${r.code}`}).`);
  say(c.SARA_MODE === 'service' ? 'Stopped the Sara service.' : 'Stopped Sara.');
}
async function startHer(c: Record<string, string>): Promise<void> {
  const r = service('--start');
  if (r.code === 5) fail(needAdmin());
  if (r.code !== 0) fail(`She didn't start (${r.out || `code ${r.code}`}). Look at: sara logs`);
  if (await healthy(c)) say(`Sara is running: ${c.SARA_PUBLIC_URL || `http://127.0.0.1:${c.SARA_PORT || 7860}`}`);
  else fail("She started but isn't answering yet. Look at: sara logs");
}

// ---- Tailscale and the firewall ----

function tailscaleCli(): string | null {
  for (const p of [`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'C:\\Program Files\\Tailscale\\tailscale.exe']) if (existsSync(p)) return p;
  return null;
}
function ts(args: string[]): { code: number; out: string } {
  const cli = tailscaleCli();
  if (!cli) return { code: 127, out: 'Tailscale is not installed.' };
  const r = spawnSync(cli, args, { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
/** Checks Tailscale can give her an HTTPS address; returns this computer's Tailscale name. */
function tailscaleReady(): string {
  if (!tailscaleCli()) throw new Error('Tailscale isn\'t installed on this computer. Install it from https://tailscale.com/download, sign in, then choose Tailscale again.');
  const r = ts(['status', '--json']);
  let j: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: unknown } = {};
  try {
    j = JSON.parse(r.out);
  } catch {
    throw new Error("Tailscale didn't answer. Is it running?");
  }
  if (j.BackendState !== 'Running') throw new Error('Tailscale is installed but not signed in or switched off. Open Tailscale, sign in, then try again.');
  if (!Array.isArray(j.CertDomains) || j.CertDomains.length === 0)
    throw new Error('Your Tailscale network has HTTPS certificates off. Turn them on at https://login.tailscale.com/admin/dns (Enable HTTPS), then try again.');
  const name = String(j.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name) throw new Error("Couldn't read this computer's Tailscale name.");
  return name;
}
function serveOn(name: string, port: number): number {
  const target = `http://127.0.0.1:${port}`;
  const pick = pickServePort(ts(['serve', 'status', '--json']).out, name, target);
  if (pick.ours) return pick.port;
  if (!pick.port) throw new Error('Every HTTPS port Sara could use on Tailscale is taken by something else here.');
  const r = ts(['serve', '--bg', `--https=${pick.port}`, target]);
  if (r.code !== 0) throw new Error(`'tailscale serve' didn't work: ${r.out.trim().split('\n')[0]}`);
  return pick.port;
}
function serveOff(c: Record<string, string>): void {
  const p = Number(c.SARA_TS_HTTPS_PORT || 0);
  if (!p || !tailscaleCli()) return;
  // Only when that port still points at her: never take away something the owner set up since.
  if (!serveIsOurs(ts(['serve', 'status', '--json']).out, p, `http://127.0.0.1:${c.SARA_PORT || 7860}`)) return;
  ts(['serve', `--https=${p}`, 'off']);
  say(`Stopped serving Sara through Tailscale (HTTPS port ${p}).`);
}
const FIREWALL_RULE = 'Sara (home network)';
function firewallOn(port: number): void {
  firewallOff();
  const r = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=private'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) say('Note: Windows may ask once whether to let Node.js reach your network: choose Allow on private networks.');
}
function firewallOff(): void {
  spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], { encoding: 'utf8', windowsHide: true });
}
function lanIp(): string {
  return service('--lan-ip').out.split(/\s+/)[0] ?? '';
}

/** Sets up `mode` (Tailscale serve, firewall) and writes it to sara.env. Undoes the old mode. */
function applyAccess(c: Record<string, string>, mode: Access, port: number, domain?: string): Record<string, string | undefined> {
  const input: AccessInput = { mode, port };
  if (mode === 'lan') input.lanIp = lanIp();
  if (mode === 'domain') input.domain = cleanDomain(domain ?? '');
  if (mode === 'tailscale') {
    input.tsName = tailscaleReady();
    input.tsPort = serveOn(input.tsName, port);
  }
  const patch = accessEnv(input); // throws before anything is written when something's missing
  if (c.SARA_ACCESS === 'tailscale' && (mode !== 'tailscale' || Number(c.SARA_PORT) !== port)) serveOff(c);
  if (c.SARA_ACCESS === 'lan' && mode !== 'lan') firewallOff();
  if (mode === 'lan' && c.SARA_MODE === 'service') firewallOn(port);
  writeConfig(patch);
  return patch;
}

function printAccess(c: Record<string, string>): void {
  say(`How you reach her: ${accessLabel(c.SARA_ACCESS)}`);
  say(`Address to open: ${c.SARA_PUBLIC_URL || `http://127.0.0.1:${c.SARA_PORT || 7860}`}`);
  if (c.SARA_ACCESS !== 'local') say(`On this computer: http://127.0.0.1:${c.SARA_PORT || 7860}`);
  if (c.SARA_ACCESS === 'lan') say('Plain HTTP: anyone on the same network could read what you send. Use it only at home on a network you trust.');
  if (c.SARA_ACCESS === 'domain') say(`Your web server must send ${c.SARA_PUBLIC_URL} to http://127.0.0.1:${c.SARA_PORT || 7860} (guide: ${HTTPS_GUIDE}).`);
  say('Change it: sara access local | tailscale | lan | domain --domain sara.example.com');
}

/** Hidden typing for a passphrase. */
async function askHidden(q: string): Promise<string> {
  process.stdout.write(q);
  const stdin = process.stdin;
  if (!stdin.isTTY) return await new Promise((r) => stdin.once('data', (d) => r(String(d).trim())));
  stdin.setRawMode(true);
  stdin.resume();
  let v = '';
  return await new Promise((done) => {
    const on = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', on);
          process.stdout.write('\n');
          return done(v);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\b' || ch === '\u007f') v = v.slice(0, -1);
        else v += ch;
      }
    };
    stdin.on('data', on);
  });
}

function opt(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
}
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (!args[i].includes('=') && ['--port', '--domain', '--mode', '--data', '--access', '--private'].includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * The Windows service install's update task (src/update-service.ts): \Sara\Update runs as SYSTEM, on
 * demand only, the update runner from the program folder; its permissions let the service account
 * (NT SERVICE\Sara) read and start it and nothing else (Full control stays with SYSTEM and
 * Administrators). No NSSM or other helper: Task Scheduler, through PowerShell's ScheduledTasks module.
 */
export function updaterTaskScript(action: 'install' | 'remove', o: { app: string; folder?: string; name?: string; account?: string; command?: string; args?: string; runAs?: string }): string {
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const folder = o.folder ?? 'Sara';
  const name = o.name ?? 'Update';
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (action === 'remove') {
    lines.push(`Unregister-ScheduledTask -TaskPath ${q(`\\${folder}\\`)} -TaskName ${q(name)} -Confirm:$false -ErrorAction SilentlyContinue`);
    lines.push(`try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $svc.GetFolder('\\').DeleteFolder(${q(folder)}, 0) } catch { }`);
    lines.push("'TASK=removed'");
    return lines.join('\n');
  }
  // Windows paths whatever runs this (the tests also run on Linux): win32.join, never the host's.
  const command = o.command ?? win32.join(o.app, 'node', 'node.exe');
  const args = o.args ?? `--disable-warning=ExperimentalWarning "${win32.join(o.app, 'server', 'src', 'update-service.ts')}"`;
  lines.push(
    `$a = New-ScheduledTaskAction -Execute ${q(command)} -Argument ${q(args)} -WorkingDirectory ${q(win32.join(o.app, 'server'))}`,
    // SYSTEM (tests on a PC without administrator rights run it as themselves instead).
    o.runAs ? `$p = New-ScheduledTaskPrincipal -UserId ${q(o.runAs)} -LogonType Interactive -RunLevel Limited` : "$p = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest",
    '$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -TaskPath ${q(`\\${folder}\\`)} -TaskName ${q(name)} -Action $a -Principal $p -Settings $s -Description 'Installs a Sara update that Sara downloaded and the signed update notice vouches for (Settings, Updates, Update now). Started by the Sara service only.' -Force | Out-Null`,
    `$sid = (New-Object System.Security.Principal.NTAccount(${q(o.account ?? 'NT SERVICE\\Sara')})).Translate([System.Security.Principal.SecurityIdentifier]).Value`,
    '$svc = New-Object -ComObject Schedule.Service; $svc.Connect()',
    `$t = $svc.GetFolder(${q(`\\${folder}`)}).GetTask(${q(name)})`,
    '$t.SetSecurityDescriptor("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$sid)", 0)',
    "'TASK=ok'",
  );
  return lines.join('\n');
}

function updaterTask(action: string, print: boolean): void {
  if (action !== 'install' && action !== 'remove' && action !== 'status') fail('updater-task install|remove|status [--print]', 2);
  if (action === 'status') {
    const r = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), ['/query', '/tn', '\\Sara\\Update'], { encoding: 'utf8', windowsHide: true });
    say(r.status === 0 ? 'The Sara Update task is set up: Settings → Updates → Update now installs updates for the service.' : 'The Sara Update task is not set up (run the newest Sara-Setup as administrator).');
    return;
  }
  const script = updaterTaskScript(action, { app: APP });
  if (print) return say(script);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0 || !/TASK=(ok|removed)/.test(out)) fail(`The Sara Update task could not be ${action === 'install' ? 'set up' : 'removed'}: ${out.split(/\r?\n/).find((l) => l.trim()) ?? `exit ${r.status}`}${/denied|0x80070005/i.test(out) ? ` ${needAdmin()}` : ''}`);
  say(action === 'install' ? 'The Sara Update task is set up.' : 'The Sara Update task is removed.');
}

function help(): void {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  for (const l of src.slice(1)) {
    if (!l.startsWith('//')) break;
    if (l.includes('The installer also uses')) break;
    say(l.replace(/^\/\/ ?/, ''));
  }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...args] = argv;
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return help();
    case 'version':
    case '--version': {
      runMain(readConfig(), ['--version']);
      return;
    }
    case 'status': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const st = service('--state').out || 'unknown';
      say(`Sara runs ${modeLabel(c.SARA_MODE)} (${st === 'running' ? 'running' : st}).`);
      printAccess(c);
      say('');
      process.exitCode = runMain(c, ['--status']).code;
      return;
    }
    case 'doctor': {
      const c = cfgOrFail();
      checkDataAccess(c);
      process.exitCode = runMain(c, ['--doctor']).code;
      return;
    }
    case 'backup': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const file = positional(args)[0];
      process.exitCode = runMain(c, file ? ['--backup', resolve(file)] : ['--backup']).code;
      return;
    }
    case 'backups': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const dir = join(c.SARA_DATA, 'backups');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).sort() : [];
      if (!files.length) return say('No backups yet.');
      for (const f of files) say(`${f}  (${Math.max(1, Math.round(statSync(join(dir, f)).size / 1024))} KB)`);
      say(`In ${dir}`);
      return;
    }
    case 'restore': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const file = positional(args)[0];
      if (!file || !existsSync(file)) fail('Usage: sara restore <backup.tar.gz>');
      const full = resolve(file);
      const head = readFileSync(full).subarray(0, 8).toString('latin1');
      const extra: Record<string, string> = {};
      if (head === 'SARAENC1' && !process.env.SARA_BACKUP_PASSPHRASE) extra.SARA_BACKUP_PASSPHRASE = await askHidden('Backup passphrase: ');
      stopHer(c);
      const r = runMain({ ...c, ...extra }, ['--restore', full]);
      await startHer(c);
      if (r.code !== 0) fail('Restore failed; Sara was started again with the data she had.');
      return;
    }
    case 'reset-token': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const r = runMain(c, ['--reset-token']);
      if (r.code !== 0) return void (process.exitCode = r.code);
      stopHer(c);
      await startHer(c);
      return;
    }
    case 'logs': {
      const c = cfgOrFail();
      checkDataAccess(c);
      const n = Math.max(1, Number(positional(args)[0]) || 60);
      for (const name of ['service.log', 'sara.log']) {
        const f = join(c.SARA_DATA, 'logs', name);
        if (!existsSync(f)) continue;
        const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n);
        say(`---- ${f} (last ${lines.length} lines) ----`);
        for (const l of lines) say(formatLogLine(l));
      }
      return;
    }
    case 'start':
      return await startHer(cfgOrFail());
    case 'stop':
      return stopHer(cfgOrFail());
    case 'restart': {
      const c = cfgOrFail();
      stopHer(c);
      return await startHer(c);
    }
    case 'access': {
      const c = cfgOrFail();
      const want = positional(args)[0]?.toLowerCase();
      if (!want) return printAccess(c);
      const mode = (({ 'this-computer': 'local', localhost: 'local', home: 'lan', network: 'lan', web: 'domain' }) as Record<string, string>)[want] ?? want;
      if (!(ACCESS as readonly string[]).includes(mode)) fail(`Unknown way to reach her: '${want}'. Choose one of: local, tailscale, lan, domain.`);
      const port = Number(opt(args, 'port') ?? c.SARA_PORT ?? 7860);
      if (!validPort(port)) fail('The port must be a number from 1024 to 65535.');
      if (String(port) !== (c.SARA_PORT ?? '7860') && spawnSync(SERVICE_EXE, ['--port-free', String(port)], { windowsHide: true }).status !== 0) fail(`Something else is already using port ${port}. Pick another (--port N).`);
      try {
        applyAccess(c, mode as Access, port, opt(args, 'domain') ?? (mode === 'domain' && c.SARA_ACCESS === 'domain' ? c.SARA_PUBLIC_URL : undefined));
      } catch (err) {
        fail(`${(err as Error).message}\nNothing was changed; she's still reached as before (${accessLabel(c.SARA_ACCESS)}).`);
      }
      const now = readConfig();
      say('Restarting her...');
      stopHer(now);
      await startHer(now);
      printAccess(now);
      return;
    }
    case 'update': {
      if (readConfig().SARA_MODE === 'service' && spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), ['/query', '/tn', '\\Sara\\Update'], { windowsHide: true }).status === 0) say('Sara can update herself: Settings → Updates → Update now (Windows installs it for the service with the Sara Update task). Or:');
      say('Updates come as a newer installer. Download Sara-Setup.exe from the release page and run it:');
      say(`  ${DOWNLOAD_PAGE}`);
      say('It makes a backup first and keeps your data, settings and how she runs.');
      if (!args.includes('--no-open')) spawn('explorer.exe', [DOWNLOAD_PAGE], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    case 'uninstall': {
      const unins = join(APP, 'unins000.exe');
      if (!existsSync(unins)) fail('The uninstaller is missing. Use Settings → Apps → Sara.');
      spawn(unins, args.includes('--delete-data') ? ['/DELETEDATA=1'] : [], { detached: true, stdio: 'ignore' }).unref();
      say(args.includes('--delete-data') ? 'The uninstaller is open. Her data will be deleted too (a last backup goes to your Desktop first).' : 'The uninstaller is open. Her data stays unless you tick "Also delete her data".');
      return;
    }
    // ---- used by the installer ----
    case 'setup': {
      // setup --mode service|user --data <folder> --port N --access local|tailscale|lan|domain [--domain D] [--private start|off] [--keep]
      const c = readConfig();
      const keep = args.includes('--keep') && c.SARA_DATA;
      const mode = (keep ? c.SARA_MODE : opt(args, 'mode')) as Mode;
      const data = keep ? c.SARA_DATA : opt(args, 'data');
      if (mode !== 'service' && mode !== 'user') fail('setup: --mode service|user');
      if (!data) fail('setup: --data <folder>');
      mkdirSync(data, { recursive: true });
      writeConfig({ SARA_MODE: mode, SARA_DATA: data, SARA_INSTALLED: '1' });
      // Phase 67: the installer's "Private: everything on this computer" (SARA_PRIVATE_LOCAL=start:
      // on from the first start until the owner turns it off in Settings). Updates keep what's there.
      const priv = keep ? undefined : opt(args, 'private');
      if (priv === 'start' || priv === 'off') writeConfig({ SARA_PRIVATE_LOCAL: priv === 'start' ? 'start' : undefined });
      const cfg = readConfig();
      if (keep) {
        say(`Kept her settings: ${modeLabel(cfg.SARA_MODE)}, ${accessLabel(cfg.SARA_ACCESS)}, port ${cfg.SARA_PORT}.`);
        return;
      }
      const port = Number(opt(args, 'port') ?? 7860);
      if (!validPort(port)) fail('setup: the port must be 1024-65535');
      let access = (opt(args, 'access') ?? 'local') as Access;
      if (!(ACCESS as readonly string[]).includes(access)) access = 'local';
      try {
        applyAccess(cfg, access, port, opt(args, 'domain'));
      } catch (err) {
        say(`${(err as Error).message} She'll be reachable from this computer only for now; change it later with: sara access ${access}`);
        applyAccess(cfg, 'local', port);
      }
      const now = readConfig();
      say(`ACCESS=${now.SARA_ACCESS}`);
      say(`URL=${now.SARA_PUBLIC_URL}`);
      return;
    }
    case 'updater-task': {
      // updater-task install|remove|status [--print]: the service install's update task (Setup runs it).
      return updaterTask(args[0] ?? '', args.includes('--print'));
    }
    case 'unconfigure': {
      const c = readConfig();
      if (c.SARA_ACCESS === 'tailscale') serveOff(c);
      if (c.SARA_ACCESS === 'lan' && c.SARA_MODE === 'service') firewallOff();
      return;
    }
    default:
      fail(`Unknown command: ${cmd} (try: sara help)`, 2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => fail(`sara: ${(err as Error).message}`));
}
