#!/usr/bin/env node
// C17 (docs/ops/C17_DESIGN.md, docs/design/WAKE.md §6.3): `sara wake`, Hey Sara on a Linux desktop.
// Run by the desktop user in a visible terminal (never root, never a service). It pairs once with a
// device code (an app token, kept in a 0600 file under ~/.config/sara), gets the pinned engine
// (upstream sherpa-onnx's ALSA keyword spotter + onnxruntime, Apache-2.0) and the checked model from
// her server, and listens through ALSA's "default" device, which PipeWire and PulseAudio serve. The
// spotter's audio stays in that process; only after it prints her label does this record the
// question (pw-record / parecord / arecord), send it to /api/wake/turn and play her pieces in order.
// The terminal line and a desktop notification say when it listens; Ctrl+C switches it off.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MODEL_FILES, packFor, type PackFile } from '../../src/wake-pack.ts';

export const HELP = `Usage: sara wake --server https://sara.example.com [--device default]
Listens for "Hey Sara" on this computer, in your desktop session (no sudo). First run: approve the
displayed device code in Sara. Needs ALSA (libasound2) and one of pw-record, parecord or arecord.
The microphone is used on this computer only; nothing is sent until she hears her phrase.
Ctrl+C stops and switches Hey Sara off on this computer.
`;

export interface WakeArgs { server: string; device: string }
export function parseArgs(argv: string[]): WakeArgs {
  const at = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const server = at('--server');
  if (!server || argv.includes('--help')) throw new Error(HELP);
  const u = new URL(server);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Use the server origin, like https://sara.example.com');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw new Error('Use HTTPS for a remote server; HTTP is allowed only on this computer');
  const device = at('--device') ?? 'default';
  if (!/^[\w:,.=-]{1,64}$/.test(device)) throw new Error('That ALSA device name looks wrong (try default).');
  return { server: u.origin, device };
}

/** ~/.local/share/sara/wake/1 (per user, versioned so an update never half-replaces a pack). */
export const packDir = (home = homedir(), env = process.env) => join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'sara', 'wake', '1');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The pack files that are missing or don't match their pins (checked before every start). */
export function badFiles(dir: string, files: PackFile[]): string[] {
  return files.filter((f) => {
    const p = join(dir, f.name);
    if (!existsSync(p)) return true;
    const b = readFileSync(p);
    return b.length !== f.size || sha(b) !== f.sha256;
  }).map((f) => f.name);
}

/** The keyword spotter's command line (the same settings as the Windows and Android apps). */
export function spotterArgs(dir: string, keywordsFile: string, device: string): string[] {
  return [`--tokens=${join(dir, 'tokens.txt')}`, `--encoder=${join(dir, 'encoder.int8.onnx')}`, `--decoder=${join(dir, 'decoder.onnx')}`, `--joiner=${join(dir, 'joiner.int8.onnx')}`, '--provider=cpu', '--num-threads=1', '--max-active-paths=4', '--num-trailing-blanks=1', '--keywords-score=1.5', '--keywords-threshold=0.25', `--keywords-file=${keywordsFile}`, device];
}

/** A label in one line of the spotter's output ({"keyword": "W1", …} or a bare label), else undefined. */
export function parseDetection(line: string): string | undefined {
  const j = /"keyword"\s*:\s*"([^"]+)"/.exec(line);
  const word = (j ? j[1] : line).trim();
  const m = /(?:^|[\s:@])(W[1-4]|STOP)(?:$|[\s,}])/.exec(` ${word} `);
  return m?.[1];
}

/** The first recorder / player this desktop has (PipeWire, then PulseAudio, then ALSA). */
export function pickTool(names: string[], has: (n: string) => boolean): string | undefined {
  return names.find(has);
}
export const RECORDERS = ['pw-record', 'parecord', 'arecord'];
export const PLAYERS = ['pw-play', 'paplay', 'aplay'];
/** 16 kHz mono signed 16-bit little-endian raw audio on stdout. */
export function recorderArgs(tool: string): string[] {
  if (tool === 'pw-record') return ['--rate=16000', '--channels=1', '--format=s16', '-'];
  if (tool === 'parecord') return ['--raw', '--rate=16000', '--channels=1', '--format=s16le'];
  return ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '1'];
}

/** The end of a question: 0.8 s of quiet after speech, 15 s at most, 5 s with nothing said (as on Android). */
export class Silence {
  floor = 0.006; spoke = false; quietMs = 0; totalMs = 0;
  /** Feeds 16-bit samples; true when the recording is done. */
  feed(pcm: Int16Array): boolean {
    let sum = 0;
    for (const x of pcm) sum += (x / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    const ms = pcm.length / 16;
    this.totalMs += ms;
    if (rms > this.floor * 3) { this.spoke = true; this.quietMs = 0; }
    else { this.floor = this.floor * 0.98 + rms * 0.02; if (this.spoke) this.quietMs += ms; }
    return (this.spoke && this.quietMs > 800) || this.totalMs > 15_000 || (!this.spoke && this.totalMs > 5_000);
  }
}

export function wavOf(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------------- the running helper ----------------

const which = (n: string) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, n)));

async function http(server: string, token: string, method: string, path: string, body?: Buffer | object, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; raw: Buffer }> {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(new URL(path, server), { method, redirect: 'error', signal: AbortSignal.timeout(90_000), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !isBuf ? { 'content-type': 'application/json' } : {}), 'user-agent': 'SaraWakeLinux/1', ...headers }, ...(body ? { body: isBuf ? new Uint8Array(body) : JSON.stringify(body) } : {}) });
  const raw = Buffer.from(await r.arrayBuffer());
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { /* audio or empty */ }
  return { status: r.status, json, raw };
}

async function pair(server: string): Promise<string> {
  const name = `sara wake on Linux (${hostname().slice(0, 30)})`;
  const s = await http(server, '', 'POST', '/api/device/start', { name });
  if (s.status !== 200) throw new Error(String(s.json.error ?? `HTTP ${s.status}`));
  console.log(`Open ${server}/device where you're signed in and approve code ${String(s.json.code)}. Waiting…`);
  for (let i = 0; i < 120; i++) {
    await delay(Math.max(1, Number(s.json.interval ?? 5)) * 1000);
    const p = await http(server, '', 'POST', '/api/device/poll', { pollToken: s.json.pollToken });
    if (p.json.status === 'approved' && /^sara_dev\.[\w-]+\.[\w-]+$/.test(String(p.json.token))) return String(p.json.token);
    if (p.json.status !== 'pending') throw new Error('The sign-in was denied or expired. Run sara wake again.');
  }
  throw new Error('The code expired. Run sara wake again.');
}

/** The engine from the pinned upstream tarball (unpacked from stdin), the model from her server; each file checked. */
async function installPack(server: string, token: string, dir: string): Promise<void> {
  const pack = packFor('linux', process.arch === 'x64' ? 'x64' : process.arch)!;
  if (!pack) throw new Error('Hey Sara on Linux needs an x86-64 computer in this version.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const engine = pack.files.filter((f) => f.tar === 'engine');
  if (badFiles(dir, engine).length) {
    const t = pack.tars.engine!;
    console.log(`Downloading the speech engine (${Math.round(t.size / 1e6)} MB, sherpa-onnx, Apache-2.0)…`);
    const buf = Buffer.from(await (await fetch(t.url, { signal: AbortSignal.timeout(600_000) })).arrayBuffer());
    if (buf.length !== t.size || sha(buf) !== t.sha256) throw new Error("The engine download didn't match its fingerprint, so it wasn't used.");
    const tmp = join(dir, '.unpack');
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    const r = spawnSync('tar', ['-xjf', '-', '-C', tmp, ...engine.map((f) => f.inTar)], { input: buf, maxBuffer: 1 << 20 });
    if (r.status !== 0) throw new Error('Unpacking the engine failed (needs tar and bzip2).');
    for (const f of engine) renameSync(join(tmp, f.inTar), join(dir, f.name));
    rmSync(tmp, { recursive: true, force: true });
  }
  if (badFiles(dir, MODEL_FILES).length) {
    await http(server, token, 'POST', '/api/wake/model', {});
    for (let i = 0; i < 60 && badFiles(dir, MODEL_FILES).length; i++) {
      for (const f of MODEL_FILES.filter((m) => badFiles(dir, [m]).length)) {
        const r = await http(server, token, 'GET', `/api/wake/model/${f.name}`);
        if (r.status === 200 && r.raw.length === f.size && sha(r.raw) === f.sha256) writeFileSync(join(dir, f.name), r.raw, { mode: 0o600 });
      }
      if (badFiles(dir, MODEL_FILES).length) await delay(5000);
    }
  }
  const bad = badFiles(dir, pack.files);
  if (bad.length) throw new Error(`These files are missing or don't match: ${bad.join(', ')}.`);
  chmodSync(join(dir, 'sherpa-onnx-keyword-spotter-alsa'), 0o700);
}

function notify(title: string, body: string): void {
  // Best effort: the desktop's own notification (org.freedesktop.Notifications through notify-send when present).
  if (which('notify-send')) spawn('notify-send', ['--app-name=Sara', title, body], { stdio: 'ignore' }).on('error', () => {});
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (process.getuid?.() === 0) throw new Error('Run sara wake as your desktop user, without sudo.');
  const rec = pickTool(RECORDERS, which);
  const play = pickTool(PLAYERS, which);
  if (!rec || !play) throw new Error('Install PipeWire (pw-record, pw-play), PulseAudio (parecord, paplay) or alsa-utils (arecord, aplay).');
  const cfgDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sara');
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const tokFile = join(cfgDir, `wake-${sha(Buffer.from(args.server)).slice(0, 16)}.token`);
  let token = existsSync(tokFile) ? readFileSync(tokFile, 'utf8').trim() : '';
  if (!token) { token = await pair(args.server); writeFileSync(tokFile, `${token}\n`, { mode: 0o600 }); }
  const dir = packDir();
  await installPack(args.server, token, dir);
  const label = `Linux (${hostname().slice(0, 40)})`;
  const on = await http(args.server, token, 'PUT', '/api/wake/device', { on: true, platform: 'linux', label, pack: 'wake-pack-1' });
  if (on.status !== 200) throw new Error(String(on.json.error ?? `HTTP ${on.status}`));
  let child: ChildProcess | undefined;
  let stopping = false;
  let lines = '';
  let paused = '';
  const kwFile = join(dir, 'keywords.txt');
  const stop = () => { child?.kill(); child = undefined; };
  const config = async () => {
    const c = await http(args.server, token, 'GET', '/api/wake/config?platform=linux&arch=x64');
    if (c.status === 401) throw new Error('This computer was signed out of Sara. Run sara wake again to pair it.');
    if (c.status !== 200) return;
    const ph = (c.json.phrases as { lines: string[] }[] | undefined) ?? [];
    lines = ph.flatMap((p) => p.lines).join('\n');
    if (!c.json.on && c.json.offBy) { console.log('Hey Sara was switched off from another of your devices.'); stopping = true; }
    const next = String(c.json.paused ?? '');
    if (next !== paused) console.log(next ? `Paused (${next}): the microphone is closed.` : 'Listening for “Hey Sara” (Ctrl+C stops).');
    paused = next;
  };
  process.on('SIGINT', () => { stopping = true; stop(); });
  await config();
  notify('Sara is listening for “Hey Sara”', 'On this computer only. Ctrl+C in the terminal stops it.');
  let last = 0;
  while (!stopping) {
    if (Date.now() - last > 60_000) { last = Date.now(); await config().catch((e: Error) => { if (/signed out/.test(e.message)) throw e; }); }
    if (paused || !lines) { stop(); await delay(2000); continue; }
    if (!child) {
      writeFileSync(kwFile, `${lines}\n`, { mode: 0o600 });
      const c = spawn(join(dir, 'sherpa-onnx-keyword-spotter-alsa'), spotterArgs(dir, kwFile, args.device), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LD_LIBRARY_PATH: dir } });
      child = c;
      c.on('exit', () => { if (child === c) child = undefined; });
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
          const heard = parseDetection(buf.slice(0, i));
          if (heard && heard !== 'STOP' && child === c) { stop(); void exchange(heard).finally(() => { last = 0; }); }
        }
      };
      c.stdout.on('data', onData);
      c.stderr.on('data', onData);
    }
    await delay(500);
  }
  stop();
  await http(args.server, token, 'PUT', '/api/wake/device', { on: false }).catch(() => undefined);
  console.log('Hey Sara is off on this computer.');
  return 0;

  async function exchange(heard: string): Promise<void> {
    const claim = await http(args.server, token, 'POST', '/api/wake/claim', { label: heard });
    if (!claim.json.ok) { if (claim.json.by) console.log(`Answered on ${String(claim.json.by)}.`); return; }
    console.log('Listening…');
    const pcm = await new Promise<Buffer>((done) => {
      const r = spawn(rec!, recorderArgs(rec!), { stdio: ['ignore', 'pipe', 'ignore'] });
      const parts: Buffer[] = []; const s = new Silence(); let left = Buffer.alloc(0);
      r.stdout.on('data', (d: Buffer) => {
        parts.push(d);
        const all = Buffer.concat([left, d]); const n = all.length - (all.length % 2);
        left = all.subarray(n);
        if (s.feed(new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + n)))) r.kill();
      });
      r.on('exit', () => done(s.spoke ? Buffer.concat(parts) : Buffer.alloc(0)));
    });
    if (!pcm.length) { console.log('I didn’t catch that.'); return; }
    const t = await http(args.server, token, 'POST', '/api/wake/turn', wavOf(pcm.subarray(0, 15 * 32000)), { 'content-type': 'audio/wav', 'x-sara-wake-claim': String(claim.json.claim), 'x-sara-wake-label': heard });
    if (t.status !== 200) { console.log(String(t.json.error ?? `HTTP ${t.status}`)); return; }
    if (t.json.heard) console.log(`You: ${String(t.json.heard)}`);
    for (const piece of (t.json.spoken as { text: string }[] | undefined) ?? []) {
      console.log(`Sara: ${piece.text}`);
      const a = await http(args.server, token, 'POST', '/api/voice/speak', { text: piece.text });
      if (a.status !== 200) continue;
      const f = join(dir, `.say-${process.pid}`);
      writeFileSync(f, a.raw, { mode: 0o600 });
      await new Promise<void>((done) => spawn(play!, [f], { stdio: 'ignore' }).on('exit', () => done()).on('error', () => done()));
      rmSync(f, { force: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => { console.error(e.message); process.exit(1); });
}
