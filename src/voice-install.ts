// Phase 126 part C (docs/design/WAKE.md §7): `sara voice install`, her own hearing and voices on a
// Windows or Mac server, so "Nothing leaves this computer" keeps her hearing (and Hey Sara) working.
// A Node port of deploy/install-voice.sh's rules: the same pinned items (Parakeet 110M, Kokoro v0.19,
// Piper hfc_female) plus the platform's sherpa-onnx v1.13.8 bundle, each checked against a SHA-256
// written here; downloaded through netFetch (so private local mode refuses it); unpacked with the
// system tar (Windows' own C:\Windows\System32\tar.exe reads .tar.bz2) beside the target in
// `.partial` and moved into place only when whole; then voice.json in the shell script's shape.
// Linux keeps the shell script (one Linux path): `sara voice install` there only says so.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { netFetch, privateLocalOn } from './net-guard.ts';
import type { VoiceManifest } from './voice.ts';

const R = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export interface InstallItem {
  /** Path under the upstream releases URL. */
  path: string;
  sha256: string;
  /** Bytes (shown before it starts; 0 when unknown). */
  size: number;
}

/** The voice models, the same pins as deploy/install-voice.sh. */
export const VOICE_MODELS: InstallItem[] = [
  { path: 'asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2', sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b', size: 0 },
  { path: 'tts-models/kokoro-en-v0_19.tar.bz2', sha256: '912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7', size: 0 },
  { path: 'tts-models/vits-piper-en_US-hfc_female-medium.tar.bz2', sha256: '3fffdceb0c65bd9415a085d09c3cb88cc82f9d74a6ca453f8ce7fc5eaee81ff8', size: 0 },
];

/** The sherpa-onnx v1.13.8 bundle per system (SHA-256 measured from the downloaded assets, 2026-11-02; they match GitHub's digests). */
export const SHERPA_BUNDLES: Record<string, InstallItem> = {
  'win32-x64': { path: 'v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2', sha256: '3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22', size: 20_494_724 },
  'win32-arm64': { path: 'v1.13.8/sherpa-onnx-v1.13.8-win-arm64-shared-MD-Release.tar.bz2', sha256: '40fd749779c41e357c4a1382b071970999d4828ceb50b133b1643878ca08ead8', size: 19_715_599 },
  // From GitHub's asset digest (the Mac build machine was asleep; owner check §13 #9).
  'darwin-any': { path: 'v1.13.8/sherpa-onnx-v1.13.8-osx-universal2-shared.tar.bz2', sha256: '2249f97f10df7d828af1b0d10e3d1eeaa2198b60b9a999a7ed853c150181ccfd', size: 43_567_145 },
};

/** About 650 MB in all (shown before the install starts). */
export const INSTALL_MB = 650;

export class VoiceInstallError extends Error {
  readonly code: 'private' | 'checksum' | 'contents' | 'download' | 'unpack' | 'platform' | 'cancelled';
  constructor(code: VoiceInstallError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const nameOf = (item: InstallItem) => item.path.split('/').at(-1)!;
const dirOf = (item: InstallItem) => nameOf(item).replace(/\.tar\.bz2$/, '');

/** What this system installs (undefined: not this way; Linux has the shell script). */
export function installItems(platform: NodeJS.Platform = process.platform, arch: string = process.arch): InstallItem[] | undefined {
  const bundle = platform === 'win32' ? SHERPA_BUNDLES[`win32-${arch === 'arm64' ? 'arm64' : 'x64'}`] : platform === 'darwin' ? SHERPA_BUNDLES['darwin-any'] : undefined;
  return bundle ? [bundle, ...VOICE_MODELS] : undefined;
}

/** voice.json exactly as deploy/install-voice.sh writes it (the bundle folder name is the only difference). */
export function voiceManifest(sherpa: string): VoiceManifest {
  const P = 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8';
  const K = 'kokoro-en-v0_19';
  const V = 'vits-piper-en_US-hfc_female-medium';
  const kokoro: [number, string][] = [[1, 'Bella (US)'], [3, 'Sarah (US)'], [2, 'Nicole (US)'], [4, 'Sky (US)'], [0, 'Default (US)'], [7, 'Emma (UK)'], [8, 'Isabella (UK)']];
  return {
    sherpa,
    stt: { kind: 'nemo-ctc', model: `${P}/model.int8.onnx`, tokens: `${P}/tokens.txt` },
    voices: [
      ...kokoro.map(([sid, label]) => ({ id: `kokoro:${sid}`, label: `${label}, natural`, kind: 'kokoro' as const, model: `${K}/model.onnx`, voices: `${K}/voices.bin`, tokens: `${K}/tokens.txt`, dataDir: `${K}/espeak-ng-data`, sid })),
      { id: 'piper:hfc_female', label: 'Piper (US), fast', kind: 'vits' as const, model: `${V}/en_US-hfc_female-medium.onnx`, tokens: `${V}/tokens.txt`, dataDir: `${V}/espeak-ng-data` },
    ],
  };
}

/** The system tar (Windows' own one by full path, so a tar from Git or MSYS on the PATH isn't used). */
export function systemTar(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return platform === 'darwin' ? '/usr/bin/tar' : 'tar';
}

export type Untar = (file: string, into: string, members?: string[]) => Promise<void>;
export const runTar =
  (bin: string = systemTar()): Untar =>
  (file, into, members = []) =>
    new Promise((resolve, reject) => {
      const p = spawn(bin, ['-xjf', file, '-C', into, ...members], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      p.on('error', (e) => reject(new VoiceInstallError('unpack', `tar could not start (${e.message}).`)));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new VoiceInstallError('unpack', `Unpacking failed (tar exit ${code}): ${err.trim().slice(0, 200)}`))));
    });

export interface Progress {
  item: string;
  index: number;
  of: number;
  bytes: number;
  total: number;
}

/**
 * Downloads one pinned file to `dest` (through netFetch), hashing as it goes. A file whose SHA-256
 * differs is deleted and refused; nothing is kept that doesn't match.
 */
export async function downloadPinned(url: string, sha256: string, dest: string, opts: { fetch?: typeof fetch; signal?: AbortSignal; onBytes?: (n: number, total: number) => void } = {}): Promise<void> {
  if (privateLocalOn()) throw new VoiceInstallError('private', 'Nothing leaves this computer is on, so nothing is downloaded. Switch it off for the download (Settings → Privacy).');
  const res = await (opts.fetch ?? netFetch)(url, { signal: opts.signal });
  if (!res.ok || !res.body) throw new VoiceInstallError('download', `Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  let n = 0;
  const src = Readable.fromWeb(res.body as never);
  src.on('data', (c: Buffer) => {
    hash.update(c);
    n += c.length;
    opts.onBytes?.(n, total);
  });
  try {
    await pipeline(src, createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    rmSync(dest, { force: true });
    if (opts.signal?.aborted) throw new VoiceInstallError('cancelled', 'Cancelled.');
    throw new VoiceInstallError('download', `Download failed (${(err as Error).message}).`);
  }
  if (hash.digest('hex') !== sha256) {
    rmSync(dest, { force: true });
    throw new VoiceInstallError('checksum', "The download didn't match what Sara expects, so it wasn't kept. Try again later.");
  }
}

/**
 * Installs her hearing and voices into `voiceDir`. Items already there are skipped (as the shell
 * script does). Returns what was installed.
 */
export async function installVoice(voiceDir: string, opts: { platform?: NodeJS.Platform; arch?: string; fetch?: typeof fetch; untar?: Untar; signal?: AbortSignal; onProgress?: (p: Progress) => void } = {}): Promise<{ installed: string[]; manifest: VoiceManifest }> {
  const items = installItems(opts.platform, opts.arch);
  if (!items) throw new VoiceInstallError('platform', 'On Linux use: sudo ./deploy/install-voice.sh');
  if (privateLocalOn()) throw new VoiceInstallError('private', 'Nothing leaves this computer is on, so nothing is downloaded. Switch it off for the download (Settings → Privacy).');
  const untar = opts.untar ?? runTar(systemTar(opts.platform));
  mkdirSync(voiceDir, { recursive: true });
  const dl = join(voiceDir, '.download');
  const part = join(voiceDir, '.partial');
  const installed: string[] = [];
  try {
    for (const [i, item] of items.entries()) {
      if (opts.signal?.aborted) throw new VoiceInstallError('cancelled', 'Cancelled.');
      const name = nameOf(item);
      const dir = dirOf(item);
      if (existsSync(join(voiceDir, dir))) continue;
      mkdirSync(dl, { recursive: true });
      const file = join(dl, name);
      await downloadPinned(`${R}/${item.path}`, item.sha256, file, { fetch: opts.fetch, signal: opts.signal, onBytes: (bytes, total) => opts.onProgress?.({ item: dir, index: i, of: items.length, bytes, total: total || item.size }) });
      // Unpack next to the target; move into place only when whole (never a half folder taken as installed).
      rmSync(part, { recursive: true, force: true });
      mkdirSync(part, { recursive: true });
      try {
        await untar(file, part);
      } finally {
        rmSync(file, { force: true });
      }
      if (!existsSync(join(part, dir))) throw new VoiceInstallError('contents', `Unexpected contents in ${name} (no ${dir} folder).`);
      rmSync(join(voiceDir, dir), { recursive: true, force: true });
      renameSync(join(part, dir), join(voiceDir, dir));
      rmSync(part, { recursive: true, force: true });
      installed.push(dir);
    }
  } finally {
    rmSync(part, { recursive: true, force: true });
    rmSync(dl, { recursive: true, force: true });
  }
  const manifest = voiceManifest(dirOf(items[0]));
  writeFileSync(join(voiceDir, 'voice.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { installed, manifest };
}

/** After an install: hearing and her voice go to "on this computer" only where they were off. */
export function engineAfterInstall(v: { stt: string; tts: string }): { stt?: 'local'; tts?: 'local' } {
  return { ...(v.stt === 'off' ? { stt: 'local' as const } : {}), ...(v.tts === 'off' ? { tts: 'local' as const } : {}) };
}

/** `sara voice install` (src/main.ts). Exit code. */
export async function runVoiceCli(args: string[], opts: { platform?: NodeJS.Platform; voiceDir: string; log?: (s: string) => void; install?: typeof installVoice; afterInstall?: () => void }): Promise<number> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const platform = opts.platform ?? process.platform;
  if (args[0] !== 'install') {
    log('Usage: sara voice install   (her own hearing and voices on this computer, about 650 MB)');
    return args.length ? 2 : 0;
  }
  if (platform === 'linux') {
    log('Use: sudo ./deploy/install-voice.sh');
    return 0;
  }
  if (privateLocalOn()) {
    log('Nothing leaves this computer is on, so nothing is downloaded. Switch it off for the download (Settings → Privacy), then run this again.');
    return 1;
  }
  log(`Installing her hearing and voices into ${opts.voiceDir} (about ${INSTALL_MB} MB; every file is checked before use)…`);
  let last = '';
  try {
    const r = await (opts.install ?? installVoice)(opts.voiceDir, {
      platform,
      onProgress: (p) => {
        const line = `${p.index + 1}/${p.of} ${p.item}${p.total ? ` ${Math.floor((p.bytes / p.total) * 100)} %` : ''}`;
        if (line !== last && (p.bytes === p.total || /0 %$/.test(line))) log(line);
        last = line;
      },
    });
    opts.afterInstall?.();
    log(r.installed.length ? `Done: ${r.installed.join(', ')}. Pick her voice in Settings → Voice.` : 'Already installed. Pick her voice in Settings → Voice.');
    return 0;
  } catch (err) {
    log(`Not installed: ${(err as Error).message}`);
    return 1;
  }
}

/** The one install job on this server (Settings → Voice; the jobs list shows its progress). */
export interface InstallJob {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  progress?: Progress;
  error?: string;
  controller?: AbortController;
}
let job: InstallJob | undefined;
export const installJob = (): Omit<InstallJob, 'controller'> | null => (job ? { state: job.state, ...(job.progress ? { progress: job.progress } : {}), ...(job.error ? { error: job.error } : {}) } : null);
/** Starts the install in the background (once at a time); `done` runs after a whole install. */
export function startInstall(voiceDir: string, done: () => void, opts: Parameters<typeof installVoice>[1] = {}): Omit<InstallJob, 'controller'> {
  if (job?.state === 'running') return installJob()!;
  const controller = new AbortController();
  const j: InstallJob = { state: 'running', controller };
  job = j;
  void installVoice(voiceDir, { ...opts, signal: controller.signal, onProgress: (p) => (j.progress = p) }).then(
    () => {
      j.state = 'done';
      done();
    },
    (err: Error) => {
      j.state = controller.signal.aborted ? 'cancelled' : 'failed';
      j.error = err.message;
    },
  );
  return installJob()!;
}
export function cancelInstall(): void {
  job?.controller?.abort();
}
