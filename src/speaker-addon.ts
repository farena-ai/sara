// U3.13 (docs/design/U3SPEAK.md): the optional speaker add-on, a hearing add-on downloaded on first
// use. Two pinned, free (Apache-2.0) files: the sherpa-onnx Node add-on for this system (npm package
// sherpa-onnx-<os>-<arch> 2.0.1, ~9-14 MB) and the 3D-Speaker ERes2Net voice-print model trained on
// VoxCeleb (26 MB, from the sherpa-onnx releases; not gated). Each is checked against a SHA-256
// written here, downloaded through netFetch (so "Nothing leaves this computer" refuses it), unpacked
// beside the target and moved into place only when whole. Voice prints are made in a separate Node
// process (src/speaker-worker.ts). Lives in the data folder (writable on Linux too, where
// /opt/sara-voice is root's). Missing or broken: meetings use the pauses-and-pitch way (S2).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPinned, systemTar, VoiceInstallError, type InstallItem } from './voice-install.ts';
import { en, enf } from './i18n.ts';

const NPM = 'https://registry.npmjs.org';
const SHERPA_NODE = '2.0.1';
/** The sherpa-onnx Node add-on per system (SHA-256 measured from the npm tarballs, 2026-11-18). */
export const SPEAKER_RUNTIMES: Record<string, InstallItem> = {
  'win32-x64': { path: 'win-x64', sha256: '217cec234c6026dbfd2b9c06523507180796fe4227c7cc9d11cfe218260a2519', size: 8_779_375 },
  'win32-arm64': { path: 'win-arm64', sha256: '5ea165239cb9ac3ddc3e91b74ea54aeb8a3145e7006e0cba57c5b62b58b9e3dc', size: 8_486_399 },
  'linux-x64': { path: 'linux-x64', sha256: '08c6fe2b65838febbd0c260aaa9991990d2d592e503e758bfd2f5db6cbc79338', size: 11_005_484 },
  'linux-arm64': { path: 'linux-arm64', sha256: 'b8f18ee34c8e14bbafb7f51332361a6ab91f4ddbb4a4eac58f74ec0dafb39e87', size: 13_822_449 },
  'darwin-arm64': { path: 'darwin-arm64', sha256: 'afc9415260e232c4dadc25a29a8645acb0ba06ef989060d32274f4c749a4830e', size: 10_013_200 },
  'darwin-x64': { path: 'darwin-x64', sha256: 'e95e4addd3d02919ae61f311effd6e5349e00b50985c4a8c9a3bcb03dc6d6325', size: 11_167_483 },
};
export const runtimeUrl = (item: InstallItem): string => `${NPM}/sherpa-onnx-${item.path}/-/sherpa-onnx-${item.path}-${SHERPA_NODE}.tgz`;
/** 3D-Speaker ERes2Net (English, VoxCeleb), Apache-2.0. */
export const SPEAKER_MODEL: InstallItem = { path: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx', sha256: 'c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5', size: 26_485_263 };
/** About this many MB in all (shown before it starts). */
export const SPEAKER_MB = 40;

export type SpeakerAddonState = 'missing' | 'installing' | 'ready' | 'failed' | 'unsupported';
export interface SpeakerAddonStatus {
  state: SpeakerAddonState;
  mb: number;
  error?: string;
}
/** What meetings need from the add-on (tests pass a fake). */
export interface SpeakerEngine {
  status(): SpeakerAddonStatus;
  /** Starts the download in the background if it's missing (once at a time). */
  ensure(): void;
  /** Deletes the add-on. */
  remove(): void;
  /** One voice print per window ([start, end) seconds of 16 kHz mono samples). Empty print: too short. */
  prints(samples: Float32Array, windows: [number, number][]): Promise<number[][]>;
}

export function runtimeFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): InstallItem | undefined {
  return SPEAKER_RUNTIMES[`${platform}-${arch}`];
}

const untarGz = (file: string, into: string, tar = systemTar()): Promise<void> =>
  new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xzf', file, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', (e) => reject(new VoiceInstallError('unpack', enf('tar could not start ({why}).', { why: e.message }))));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new VoiceInstallError('unpack', enf('Unpacking failed (tar exit {code}): {detail}', { code: String(code), detail: err.trim().slice(0, 200) })))));
  });

export interface SpeakerAddonOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  untar?: (file: string, into: string) => Promise<void>;
  /** The helper script (tests). */
  worker?: string;
}

export class SpeakerAddon implements SpeakerEngine {
  readonly dir: string;
  readonly #opts: SpeakerAddonOptions;
  #state: SpeakerAddonState;
  #error = '';
  #job?: Promise<void>;

  constructor(dir: string, opts: SpeakerAddonOptions = {}) {
    this.dir = dir;
    this.#opts = opts;
    this.#state = !runtimeFor(opts.platform, opts.arch) ? 'unsupported' : this.#whole() ? 'ready' : 'missing';
  }
  #whole(): boolean {
    return existsSync(join(this.dir, 'addon.json')) && existsSync(join(this.dir, 'runtime', 'sherpa-onnx.node')) && existsSync(join(this.dir, 'voiceprint.onnx'));
  }
  status(): SpeakerAddonStatus {
    return { state: this.#state, mb: SPEAKER_MB, ...(this.#error ? { error: this.#error } : {}) };
  }
  ensure(): void {
    if (this.#state === 'missing' || this.#state === 'failed') void this.install().catch(() => undefined);
  }
  /** Downloads and unpacks both files (skips what is already there); resolves when ready. */
  install(): Promise<void> {
    if (this.#job) return this.#job;
    const runtime = runtimeFor(this.#opts.platform, this.#opts.arch);
    if (!runtime) return Promise.reject(new VoiceInstallError('platform', en('The speaker add-on is not available for this system.')));
    this.#state = 'installing';
    this.#error = '';
    const run = async () => {
      mkdirSync(this.dir, { recursive: true });
      const part = join(this.dir, '.partial');
      rmSync(part, { recursive: true, force: true });
      mkdirSync(part, { recursive: true });
      try {
        if (!existsSync(join(this.dir, 'runtime', 'sherpa-onnx.node'))) {
          const tgz = join(part, 'runtime.tgz');
          await downloadPinned(runtimeUrl(runtime), runtime.sha256, tgz, { fetch: this.#opts.fetch });
          await (this.#opts.untar ?? untarGz)(tgz, part);
          if (!existsSync(join(part, 'package', 'sherpa-onnx.node'))) throw new VoiceInstallError('contents', en('Unexpected contents in the speaker add-on.'));
          rmSync(join(this.dir, 'runtime'), { recursive: true, force: true });
          renameSync(join(part, 'package'), join(this.dir, 'runtime'));
        }
        if (!existsSync(join(this.dir, 'voiceprint.onnx'))) {
          await downloadPinned(SPEAKER_MODEL.path, SPEAKER_MODEL.sha256, join(part, 'voiceprint.onnx'), { fetch: this.#opts.fetch });
          renameSync(join(part, 'voiceprint.onnx'), join(this.dir, 'voiceprint.onnx'));
        }
        writeFileSync(join(this.dir, 'addon.json'), `${JSON.stringify({ runtime: `sherpa-onnx-${runtime.path}@${SHERPA_NODE}`, model: '3dspeaker_speech_eres2net_sv_en_voxceleb_16k', at: new Date().toISOString() }, null, 2)}\n`);
        this.#state = 'ready';
      } finally {
        rmSync(part, { recursive: true, force: true });
      }
    };
    const job = run().catch((err: Error) => {
      this.#state = 'failed';
      this.#error = err.message;
      throw err;
    });
    this.#job = job.finally(() => {
      this.#job = undefined;
    });
    return this.#job;
  }
  /** Deletes the add-on (Settings → Voice → Meetings → Remove). */
  remove(): void {
    if (this.#state === 'installing') return;
    rmSync(this.dir, { recursive: true, force: true });
    this.#state = runtimeFor(this.#opts.platform, this.#opts.arch) ? 'missing' : 'unsupported';
    this.#error = '';
  }
  prints(samples: Float32Array, windows: [number, number][]): Promise<number[][]> {
    if (this.#state !== 'ready') return Promise.reject(new Error('The speaker add-on is not installed.'));
    const runtime = join(this.dir, 'runtime');
    const worker = this.#opts.worker ?? fileURLToPath(new URL('./speaker-worker.ts', import.meta.url));
    const threads = String(Math.max(1, Math.min(4, cpus().length - 1)));
    const lib = process.platform === 'win32' ? { PATH: `${runtime};${process.env.PATH ?? ''}` } : process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: runtime } : { LD_LIBRARY_PATH: runtime };
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, runtime, join(this.dir, 'voiceprint.onnx'), threads], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...lib } });
      const out: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => p.kill(), 60_000 + windows.length * 500);
      p.stdout.on('data', (d: Buffer) => out.push(d));
      p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      p.on('error', (e) => (clearTimeout(timer), reject(e)));
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          this.#error = `The speaker add-on stopped (${err.trim().slice(0, 160) || `exit ${code}`}).`;
          return reject(new Error(this.#error));
        }
        try {
          resolve((JSON.parse(Buffer.concat(out).toString('utf8')) as { prints: number[][] }).prints);
        } catch (e) {
          reject(e as Error);
        }
      });
      const head = Buffer.from(JSON.stringify({ windows }), 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(head.length);
      p.stdin.on('error', () => undefined);
      p.stdin.end(Buffer.concat([len, head, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
    });
  }
}

/** The add-on as written in addon.json (for the doctor and the handoff), or undefined. */
export function speakerAddonInfo(dir: string): Record<string, string> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'addon.json'), 'utf8')) as Record<string, string>;
  } catch {
    return undefined;
  }
}
