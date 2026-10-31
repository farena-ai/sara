#!/usr/bin/env node
// Invoked directly by `sara hands`, in the desktop user's session. Never run as a service/root.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagerSessions, MANAGER_IDS, MANAGER_WARNING, type ManagerId, type PromptRequest } from '../../src/hands-managers.ts';
import { maskSecrets } from '../../src/hands-ref.ts';
import type { ConsentAnswer, ConsentRequest } from '../../src/hands-logins.ts';
import { DBus } from './dbus.ts';
import { LinuxHands, normalizeServer, linuxBrowser } from './hands.ts';
import { KeyringStore, PrivateStore, type SecretStore } from './secrets.ts';

const localText = (s: string) => maskSecrets(s).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');

export const HELP = `Usage: sara hands --server https://sara.example.com [--checks] [--local-only]
Run as your desktop user, without sudo, in a visible terminal. Requires Node 24 and Chrome/Chromium.
First run: approve the displayed device code in Sara, then confirm your identity to pair hands.
Browser use is explicitly confirmed locally. --checks separately offers read-only system check-ups.
--manager bitwarden|1password|keepassxc opts in locally (repeat for several).
--keepass-db /path/to/database.kdbx selects your database; you unlock it yourself.
Local commands: pause, resume, continue, stop. Ctrl+C stops and disconnects.
Pictures go to your chosen model; --local-only requests local models only.
Linux desktop pictures, mouse/keyboard, global hotkey and keep-awake are unavailable in this build.
`;
class Terminal {
  #muted = false; busy = false; #queue: Promise<unknown> = Promise.resolve();
  #pending?: (s: string) => void; #closed = false; #child?: ChildProcess;
  #rl = createInterface({ input: process.stdin, output: new Writable({ write: (chunk, _enc, cb) => { if (!this.#muted) process.stdout.write(chunk); cb(); } }), terminal: true });
  onCommand?: (line: string) => void; onStop?: () => void;
  constructor() {
    this.#rl.on('line', (line) => { if (this.#pending) { const done = this.#pending; this.#pending = undefined; done(line); } else if (!this.busy) this.onCommand?.(line.trim().toLowerCase()); });
    this.#rl.on('SIGINT', () => this.onStop?.());
    this.#rl.on('close', () => { this.#pending?.(''); this.#pending = undefined; this.onStop?.(); });
  }
  ask(prompt: string, secret = false): Promise<string> {
    const run = async () => {
      if (this.#closed) throw new Error('Local terminal closed');
      this.busy = true; process.stdout.write(prompt); this.#muted = secret;
      try { return await new Promise<string>((done) => { this.#pending = done; }); }
      finally { this.#muted = false; this.busy = false; if (secret) process.stdout.write('\n'); }
    };
    const answer = this.#queue.then(run); this.#queue = answer.catch(() => {}); return answer;
  }
  close(): void { this.#closed = true; this.#child?.kill(); this.#pending?.(''); this.#pending = undefined; this.#rl.close(); }
  async manager(req: PromptRequest): Promise<{ stdout: string; code: number }> {
    if ((await this.ask(`${req.title}\nRun the manager's own unlock prompt here? Type yes: `)).trim() !== 'yes') return { stdout: '', code: 1 };
    this.busy = true; this.#rl.pause(); process.stdin.setRawMode(false);
    try {
      return await new Promise((done) => {
        const child = spawn(req.command, req.args, { env: req.env, stdio: ['inherit', 'pipe', 'inherit'] });
        this.#child = child;
        let out = ''; const timer = setTimeout(() => child.kill(), 5 * 60_000);
        child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); if (out.length > 8 * 1024 * 1024) { out = ''; child.kill(); } });
        child.once('error', () => { clearTimeout(timer); done({ stdout: '', code: 1 }); });
        child.once('close', (code) => { clearTimeout(timer); done({ stdout: out, code: code ?? 1 }); out = ''; });
      });
    } finally { this.#child = undefined; if (!this.#closed) { process.stdin.setRawMode(true); this.#rl.resume(); } this.busy = false; }
  }
  async consent(req: ConsentRequest, fallback: boolean): Promise<ConsentAnswer> {
    const warning = fallback ? req.warning.replace("It's stored encrypted here", "It's stored unencrypted in a user-only 0600 file here") : req.warning;
    process.stdout.write(`\nSave login for ${req.site}\n${fallback ? 'WARNING: stored unencrypted in a user-only 0600 file. ' : ''}${warning}\n`);
    if ((await this.ask('Type I understand to accept, or Enter to cancel: ')) !== 'I understand') return { save: false, understood: false };
    const name = (await this.ask(`Login name [${req.name}]: `)) || req.name;
    if (req.canUseTyped && (await this.ask('Use the sign-in you just typed? Type yes: ')) === 'yes') return { save: true, understood: true, useTyped: true, name };
    const username = await this.ask('Username (hidden): ', true);
    const password = await this.ask('Password (hidden): ', true);
    return { save: true, understood: true, name, username, password };
  }
}
async function api(server: string, path: string, body: unknown, token = '', signal?: AbortSignal): Promise<Record<string, any>> {
  // Device-side network, outside src/: exact server origin only, no redirect following.
  const r = await fetch(new URL(path, server), { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = await r.json() as Record<string, any>;
  if (!r.ok) throw new Error(`Sara ${path}: HTTP ${r.status}. ${String(data.error ?? '').slice(0, 200)}`);
  return data;
}
export async function pair(server: string, name: string, out: (s: string) => void, signal?: AbortSignal): Promise<{ token: string; expiresAt: string }> {
  signal?.throwIfAborted();
  const start = await api(server, '/api/device/start', { name, scope: 'hands' }, '', signal);
  out(`Open ${server}/device in your normal browser, sign in, and approve code ${String(start.code)}. Do not share this code. Confirm your identity there to pair computer control.`);
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end) {
    await delay(2000, undefined, { signal });
    const poll = await api(server, '/api/device/poll', { pollToken: start.pollToken }, '', signal);
    if (poll.status === 'approved') {
      if (!/^sara_hands\.[\w-]+\.[\w-]+$/.test(String(poll.token))) throw new Error('Server did not return a hands token');
      return { token: String(poll.token), expiresAt: String(poll.expiresAt ?? '') };
    }
    if (poll.status !== 'pending') throw new Error('Pairing was denied or expired; run sara hands again');
  }
  throw new Error('Pairing expired');
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (process.platform !== 'linux') throw new Error('sara hands runs on a Linux desktop. Use the Windows or Mac app here.');
  if (process.getuid!() === 0) throw new Error('Run sara hands as your desktop user, without sudo');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Keep sara hands in a visible interactive terminal so local Stop and consent stay available');
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('No Linux desktop session is available');
  const values = new Set(['--server', '--manager', '--keepass-db']); const flags = new Set(['--checks', '--local-only']);
  for (let i = 0; i < args.length; i++) { if (values.has(args[i])) { if (!args[++i] || args[i].startsWith('--')) throw new Error('Missing option value'); } else if (!flags.has(args[i])) throw new Error(`Unknown option: ${args[i]}`); }
  const option = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes('--server')) throw new Error(HELP);
  const server = normalizeServer(option('--server')); const info = linuxBrowser(); if (!info.found) throw new Error(info.how);
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'sara-hands', createHash('sha256').update(server).digest('hex').slice(0, 24));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'running.lock'); const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); writeFileSync(lock, String(process.pid)); closeSync(lock);
  const terminal = new Terminal(); let bus: DBus | undefined; let device: LinuxHands | undefined; let store: SecretStore | undefined; let closing = false; const abort = new AbortController();
  const stop = async () => { if (closing) return; closing = true; abort.abort(); device?.pressStop(); terminal.close(); await device?.stop(); await store?.flush().catch(() => {}); bus?.close(); if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath); };
  terminal.onStop = () => { void stop(); }; process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
  try {
    if ((await terminal.ask(`Sara will use a visible browser with its own profile. Pictures go to your chosen model. Local commands: pause, resume, continue, stop; Ctrl+C stops. Allow browser use on ${new URL(server).host}? Type yes: `)) !== 'yes') return;
    const checks = args.includes('--checks') && (await terminal.ask('Allow read-only startup, disk, folders, battery, cached updates, extensions and cache checks? Type yes: ')) === 'yes';
    try { bus = new DBus(); await bus.connect(); const keyring = new KeyringStore(bus, server); await keyring.open(); store = keyring; }
    catch { bus?.close(); bus = undefined; store = new PrivateStore(dir, (s) => console.error(s)); }
    let token = store.get('token');
    if (!token) { const paired = await pair(server, 'Linux computer', console.log, abort.signal); token = paired.token; store.set('token', token); store.set('expiresAt', paired.expiresAt); await store.flush(); }
    if (closing) return;
    const managers = new ManagerSessions({ search: String(process.env.PATH ?? '').split(delimiter), keepassDb: args.includes('--keepass-db') ? resolve(option('--keepass-db')) : undefined, prompt: (req) => terminal.manager(req) });
    await managers.detect();
    for (let i = 0; i < args.length; i++) if (args[i] === '--manager') {
      const id = args[++i] as ManagerId; if (!MANAGER_IDS.includes(id)) throw new Error('Unknown password manager');
      console.log(MANAGER_WARNING);
      if ((await terminal.ask(`Allow ${id} for Sara on this server? You unlock it; she fills only exact sites. Type yes: `)) === 'yes') await managers.setOn(id, true);
    }
    abort.signal.throwIfAborted();
    device = new LinuxHands({ server, token, dir, store, info, checks, managers, localOnly: args.includes('--local-only'), consent: (r) => terminal.consent(r, store!.kind === 'file-0600'), log: (s) => console.log(localText(s)),
      onToken: (newToken, expires) => { store!.set('token', newToken); store!.set('expiresAt', expires); void store!.flush().catch(() => { console.error('Could not save the renewed hands token; stopping.'); void stop(); }); },
    });
    device.opts.renewBefore = store.get('expiresAt');
    terminal.onCommand = (line) => {
      if (line === 'stop') void stop(); else if (line === 'pause') device!.userInput(); else if (line === 'resume') device!.resume(); else if (line === 'continue') { device!.resume(); device!.continueTurn(); }
      else console.log('Local commands: pause, resume, continue, stop.');
    };
    await device.start();
    let status = '';
    const indicator = setInterval(() => { const now = device!.paused ? 'Paused: you are in control · resume / stop' : device!.badge || 'Connected · pause / stop'; if (now !== status) { status = now; console.log(localText(now)); } }, 150);
    await new Promise<void>((done) => { const timer = setInterval(() => { if (closing) { clearInterval(timer); clearInterval(indicator); done(); } }, 100); });
  } finally { await stop(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err: Error) => { console.error(localText(err.message)); process.exitCode = 1; });
