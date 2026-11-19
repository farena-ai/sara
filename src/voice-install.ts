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
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * V0.2 (docs/VOICE_FIRST.md "Words as you speak"): the optional streaming hearing model, NVIDIA's
 * NeMo FastConformer transducer (CC-BY-4.0, English, 80 ms look-ahead, int8), the same pin as
 * deploy/install-voice.sh. SHA-256 = GitHub's asset digest, matched by the downloaded file 2026-11-18.
 */
export const STREAM_MODEL: InstallItem = { path: 'asr-models/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8.tar.bz2', sha256: '7bd33a914e93370a1ba9c2066d9e841bdcad8613fa2a00537c1ae15d851a14d8', size: 102_813_625 };
export const STREAM_MB = 105;
const STREAM_DIR = 'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8';

/**
 * W0.3 (docs/VOICE_FIRST.md "Words as you speak in six languages"): the optional multilingual
 * streaming model, NVIDIA Nemotron 3.5 ASR Streaming 0.6B (NVIDIA Open Model License; 40 locales incl.
 * es/fr/de/pt/it; int8, 560 ms chunks), exported by sherpa-onnx. One model for every language: the
 * language is set per stream. SHA-256 = GitHub's asset digest, matched by the downloaded file 2026-11-19.
 */
export const MULTI_MODEL: InstallItem = { path: 'asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2', sha256: 'c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a', size: 475_271_763 };
export const MULTI_MB = 480;
const MULTI_DIR = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';
/** W0.3: what the multilingual model is used for (Sara's six app languages; English keeps the small model when it's there). */
const MULTI_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'];

// ---- V0.1: the loaded-engine helper, prebuilt by the release (Windows and Mac have no compiler) ----

/** The repo / installed server folder (…/server on Windows, Contents/Resources/server on a Mac). */
export const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which prebuilt helper fits this system (undefined: none is shipped; Linux builds its own). */
export function workerTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : undefined;
  if (platform === 'darwin') return 'darwin-universal';
  return undefined;
}

/**
 * The shipped helper for this sherpa bundle: `<root>/voice-helper/sherpa-onnx-<version>/<target>/`,
 * built by desktop/windows/build-voice-helper.sh or desktop/mac/build.sh against that release (the
 * C config structs change between releases, so another version never uses it).
 */
export function shippedWorker(root: string, sherpa: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const version = /^sherpa-onnx-(v\d+\.\d+\.\d+)-/.exec(basename(sherpa))?.[1];
  const target = workerTarget(platform, arch);
  if (!version || !target) return undefined;
  const file = join(root, 'voice-helper', `sherpa-onnx-${version}`, target, platform === 'win32' ? 'sara-voice-worker.exe' : 'sara-voice-worker');
  return existsSync(file) ? file : undefined;
}

/**
 * Copies the shipped helper next to the sherpa tools (`<sherpa>/bin`), where it finds the bundle's own
 * libraries: on Windows the exe's folder is searched before System32, which has an older
 * onnxruntime.dll; on a Mac its rpath is @executable_path/../lib. 'current' when it's already there.
 */
export function placeWorker(voiceDir: string, sherpa: string, opts: { root?: string; platform?: NodeJS.Platform; arch?: string } = {}): 'placed' | 'current' | 'none' {
  const platform = opts.platform ?? process.platform;
  const src = shippedWorker(opts.root ?? SERVER_ROOT, sherpa, platform, opts.arch);
  // voice.json names the bundle folder (installs) or gives an absolute path (hand-made setups).
  const bin = join(isAbsolute(sherpa) || /^[A-Za-z]:/.test(sherpa) ? sherpa : join(voiceDir, sherpa), 'bin');
  if (!src || !existsSync(bin)) return 'none';
  const dest = join(bin, platform === 'win32' ? 'sara-voice-worker.exe' : 'sara-voice-worker');
  const same = existsSync(dest) && statSync(dest).size === statSync(src).size && readFileSync(dest).equals(readFileSync(src));
  if (same) return 'current';
  copyFileSync(src, `${dest}.part`);
  renameSync(`${dest}.part`, dest);
  return 'placed';
}

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
export function installItems(platform: NodeJS.Platform = process.platform, arch: string = process.arch, opts: { streaming?: Streaming } = {}): InstallItem[] | undefined {
  const bundle = platform === 'win32' ? SHERPA_BUNDLES[`win32-${arch === 'arm64' ? 'arm64' : 'x64'}`] : platform === 'darwin' ? SHERPA_BUNDLES['darwin-any'] : undefined;
  if (!bundle) return undefined;
  // V0.2: 'only' = just the streaming model (the rest is installed); 'add' = everything plus it.
  if (opts.streaming === 'only') return [STREAM_MODEL];
  // W0.3: 'languages-only' = just the multilingual streaming model; 'languages' = everything plus it.
  if (opts.streaming === 'languages-only') return [MULTI_MODEL];
  if (opts.streaming === 'languages') return [bundle, ...VOICE_MODELS, MULTI_MODEL];
  return opts.streaming === 'add' ? [bundle, ...VOICE_MODELS, STREAM_MODEL] : [bundle, ...VOICE_MODELS];
}

/** V0.2 + W0.3: which streaming model an install adds ('-only' forms: the rest is installed already). */
export type Streaming = 'add' | 'only' | 'languages' | 'languages-only';

/** voice.json exactly as deploy/install-voice.sh writes it (the bundle folder name is the only difference). */
export function voiceManifest(sherpa: string, opts: { online?: boolean; multi?: boolean } = {}): VoiceManifest {
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
    // V0.2: the streaming hearing model, when it's installed.
    ...(opts.online ? { online: { kind: 'transducer' as const, encoder: `${STREAM_DIR}/encoder.int8.onnx`, decoder: `${STREAM_DIR}/decoder.int8.onnx`, joiner: `${STREAM_DIR}/joiner.int8.onnx`, tokens: `${STREAM_DIR}/tokens.txt` } } : {}),
    // W0.3: the multilingual streaming model, when it's installed.
    ...(opts.multi ? { multi: { kind: 'transducer' as const, encoder: `${MULTI_DIR}/encoder.int8.onnx`, decoder: `${MULTI_DIR}/decoder.int8.onnx`, joiner: `${MULTI_DIR}/joiner.int8.onnx`, tokens: `${MULTI_DIR}/tokens.txt`, languages: [...MULTI_LANGS] } } : {}),
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
export async function installVoice(
  voiceDir: string,
  opts: { platform?: NodeJS.Platform; arch?: string; fetch?: typeof fetch; untar?: Untar; signal?: AbortSignal; onProgress?: (p: Progress) => void; streaming?: Streaming; items?: InstallItem[]; helperRoot?: string } = {},
): Promise<{ installed: string[]; manifest: VoiceManifest }> {
  const all = installItems(opts.platform, opts.arch);
  // V0.2: 'only' needs the rest to be there already; otherwise everything is installed with it.
  const haveRest = Boolean(all?.every((i) => existsSync(join(voiceDir, dirOf(i)))));
  const lang = opts.streaming === 'languages' || opts.streaming === 'languages-only';
  const items = opts.items ?? installItems(opts.platform, opts.arch, opts.streaming ? { streaming: lang ? (haveRest ? 'languages-only' : 'languages') : opts.streaming === 'only' && haveRest ? 'only' : 'add' } : {});
  if (!all || !items) throw new VoiceInstallError('platform', 'On Linux use: sudo ./deploy/install-voice.sh');
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
  const sherpa = dirOf(all[0]);
  const manifest = voiceManifest(sherpa, { online: existsSync(join(voiceDir, STREAM_DIR)), multi: existsSync(join(voiceDir, MULTI_DIR)) });
  writeFileSync(join(voiceDir, 'voice.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // V0.1: the prebuilt loaded-engine helper goes next to the sherpa tools (never fatal).
  try {
    placeWorker(voiceDir, sherpa, { root: opts.helperRoot, platform: opts.platform, arch: opts.arch });
  } catch {
    // voice still works, one model load per call
  }
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
  const streaming = args.includes('--streaming');
  const languages = args.includes('--languages');
  if (args[0] !== 'install' || args.slice(1).some((a) => a !== '--streaming' && a !== '--languages')) {
    log(`Usage: sara voice install [--streaming] [--languages]   (her own hearing and voices on this computer, about 650 MB; --streaming adds words-as-you-speak hearing, about ${STREAM_MB} MB; --languages adds it for Spanish, French, German, Portuguese and Italian, about ${MULTI_MB} MB)`);
    return args.length ? 2 : 0;
  }
  if (platform === 'linux') {
    log(`Use: sudo ./deploy/install-voice.sh${streaming ? ' --streaming' : ''}${languages ? ' --languages' : ''}`);
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
      ...(languages ? { streaming: 'languages' as const } : streaming ? { streaming: 'add' as const } : {}),
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
