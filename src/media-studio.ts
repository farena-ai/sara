// U4.28 (docs/PICTURES.md "Editing pictures and short video"): picture editing and short local video
// through the owner's ComfyUI, driven by the same comfyui-mcp tool server Pictures from her uses.
//
// - Edits: inpaint with a mask drawn in the page (or a rough region from chat), extend the edges
//   (outpaint), upscale (an installed upscale model, else a plain resize, said so), background removal
//   (comfyui-mcp's remove_background, which names the node to install when it is missing) and restyle
//   (img2img with a strength).
// - Video: text-to-video and image-to-video only with a recipe whose models are installed
//   (Wan 2.1, LTX-Video 0.9) or the owner's own saved ComfyUI workflow; other video models found are
//   named with that way out. Nothing is ever downloaded.
// - Every result is a new Library item; edits of one picture are versions of one family (the
//   original stays). Jobs show their phase and can be cancelled (the run is stopped in ComfyUI too).
// - Rules: kid mode refuses; never minors; explicit only where adult mode allows it, and never from
//   a real photo; with "Nothing leaves this computer" on, ComfyUI must be on this computer.
// Owner only (members get 403 on /api/media and no tools): ComfyUI and its tool server are the owner's.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { AppContext } from './chat.ts';
import { measure } from './documents/images.ts';
import { comfyReason, readComfyHistory, runTool, type ComfyWorkflow, type EngineDeps, loadComfyWorkflow, promptNodes } from './image-engines.ts';
import { isLoopbackHost, privateLocalOn } from './net-guard.ts';
import { detectExplicit, detectMinorSexualContent } from './safety.ts';
import { adultModeOn } from './settings.ts';
import { mcpToolName } from './tools/mcp.ts';
import { en } from './i18n.ts';
import { ToolError } from './tools/types.ts';

export type EditOp = 'inpaint' | 'outpaint' | 'upscale' | 'background' | 'restyle';
export const EDIT_OPS: readonly EditOp[] = ['inpaint', 'outpaint', 'upscale', 'background', 'restyle'];
export type Region = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'whole';
export const REGIONS: readonly Region[] = ['left', 'right', 'top', 'bottom', 'center', 'whole'];
export const SECONDS = [2, 3, 5] as const;

/** Settings → Pictures from her → Editing and short video (settings.media). */
export interface MediaPrefs {
  /** The picture model (checkpoint) edits draw with; default: the first one found. */
  checkpoint?: string;
  /** A video workflow saved inside ComfyUI to use instead of the built-in recipes. */
  videoWorkflow?: string;
  seconds?: (typeof SECONDS)[number];
}

export interface VideoRecipe {
  family: 'wan' | 'ltxv' | 'own';
  label: string;
  model: string;
  textEncoder?: string;
  vae?: string;
  clipVision?: string;
}

export interface MediaCaps {
  connected: boolean;
  server: string;
  /** Why nothing works (not connected, private local mode). */
  why?: string;
  checkpoints: string[];
  checkpoint?: string;
  upscaler?: string;
  edits: Record<EditOp, { ok: boolean; note?: string }>;
  video: { t2v?: VideoRecipe; i2v?: VideoRecipe; found: string[]; note?: string };
}

const EXPLICIT_NAME = /nsfw|uncensor|porn|pervert|hentai|lewd|xxx|nude|seduct/i;
const VIDEO_NAME = /ltx|wan2|wan_|hunyuan|svd|video|cosmos|mochi|i2v|t2v/i;
/** Safer-named files first, then the list's own order (the owner can pick any in Settings). */
const pick = (xs: string[], re: RegExp, prefer?: RegExp) => {
  const all = xs.filter((x) => re.test(x));
  const tame = all.filter((x) => !EXPLICIT_NAME.test(x));
  const pool = tame.length ? tame : all;
  return (prefer && pool.find((x) => prefer.test(x))) || pool[0];
};

/** comfyui-mcp list_local_models: "## type (n)" headings, "- name (size) — modified …" lines. */
export function readModelList(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const h = /^##\s+([\w.-]+)/.exec(line);
    if (h) {
      cur = h[1].toLowerCase();
      out[cur] ??= [];
      continue;
    }
    const m = /^-\s+(.+?)(?:\s+\([\d.]+\s*[KMG]B\).*)?$/.exec(line);
    if (cur && m && /\.\w{2,12}$/.test(m[1].trim())) out[cur].push(m[1].trim());
  }
  return out;
}

const NO_MODEL = en('No picture model (checkpoint) was found in ComfyUI, so edits that draw new pixels are off.');

/** What can be offered with the models installed (never anything that would need a download). */
export function mediaCaps(models: Record<string, string[]>, prefs: MediaPrefs, server: string): MediaCaps {
  const ck = (models.checkpoints ?? []).filter((x) => !VIDEO_NAME.test(x));
  const checkpoints = [...ck.filter((x) => !EXPLICIT_NAME.test(x)), ...ck.filter((x) => EXPLICIT_NAME.test(x))];
  const checkpoint = prefs.checkpoint && checkpoints.includes(prefs.checkpoint) ? prefs.checkpoint : checkpoints[0];
  const upscaler = (models.upscale_models ?? [])[0];
  const draw = checkpoint ? { ok: true } : { ok: false, note: NO_MODEL };
  const edits: MediaCaps['edits'] = {
    inpaint: draw,
    outpaint: draw,
    restyle: draw,
    upscale: upscaler ? { ok: true } : { ok: true, note: en('No upscale model is installed, so this is a plain resize (no new detail).') },
    background: { ok: true, note: en('Needs the ComfyUI-RMBG node in ComfyUI; if it is missing she says so.') },
  };
  const diff = models.diffusion_models ?? models.unet ?? [];
  const te = models.text_encoders ?? models.clip ?? [];
  const vae = models.vae ?? [];
  const cv = models.clip_vision ?? [];
  const umt5 = pick(te, /umt5/i);
  const wanVae = pick(vae, /wan_?2[._]1_vae|wan2_1_vae/i);
  const video: MediaCaps['video'] = { found: [] };
  const wanT = pick(diff, /wan2[._]?1.*t2v/i, /1\.3b/i);
  const wanI = pick(diff, /wan2[._]?1.*i2v/i, /480p/i);
  const clipH = pick(cv, /clip[_-]?vision[_-]?h/i);
  if (wanT && umt5 && wanVae) video.t2v = { family: 'wan', label: 'Wan 2.1', model: wanT, textEncoder: umt5, vae: wanVae };
  if (wanI && umt5 && wanVae && clipH) video.i2v = { family: 'wan', label: 'Wan 2.1', model: wanI, textEncoder: umt5, vae: wanVae, clipVision: clipH };
  const ltx = pick(models.checkpoints ?? [], /^(?!.*ltx-?2[._-]).*ltx-?v?(ideo)?/i);
  const t5 = pick(te, /^t5xxl|[^m]t5xxl/i);
  if (ltx && t5) {
    const r: VideoRecipe = { family: 'ltxv', label: 'LTX-Video', model: ltx, textEncoder: t5 };
    video.t2v ??= r;
    video.i2v ??= r;
  }
  const all = [...diff, ...(models.checkpoints ?? [])].join('\n');
  if (/hunyuan/i.test(all)) video.found.push('Hunyuan Video');
  if (/wan2[._]?2/i.test(all)) video.found.push('Wan 2.2');
  if (/ltx-?2[._-]/i.test(all)) video.found.push('LTX-2');
  if (/wan2[._]?1/i.test(all) && !video.t2v && !video.i2v) video.found.push('Wan 2.1 (its text encoder, VAE or CLIP vision file is missing)');
  if (prefs.videoWorkflow) {
    const own: VideoRecipe = { family: 'own', label: prefs.videoWorkflow.replace(/\.json$/i, ''), model: prefs.videoWorkflow };
    video.t2v = own;
    video.i2v = own;
  }
  // The web shows the note with t(note, {list}) (found = the video models seen).
  if (!video.t2v && !video.i2v) video.note = video.found.length ? en('No built-in video recipe fits what is installed (found: {list}). Save a working video workflow inside ComfyUI and pick it in Settings → Pictures from her.') : en('No video model is installed in ComfyUI. Nothing is downloaded on its own: add Wan 2.1 or LTX-Video in ComfyUI first.');
  return { connected: true, server, checkpoints, checkpoint, upscaler, edits, video };
}

export interface EditParams {
  checkpoint?: string;
  image: string;
  mask?: string;
  prompt?: string;
  negative?: string;
  strength?: number;
  pad?: { left: number; top: number; right: number; bottom: number };
  upscaler?: string;
  target?: { width: number; height: number };
  seed: number;
  prefix: string;
  width: number;
  height: number;
}

const NEG = 'blurry, low quality, distorted, watermark, text';
const ks = (model: unknown, pos: unknown, neg: unknown, latent: unknown, seed: number, denoise: number) => ({ class_type: 'KSampler', inputs: { model, positive: pos, negative: neg, latent_image: latent, seed, steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise } });

/** A ComfyUI API-format workflow for one edit (inputs are file names already in ComfyUI's input/). */
export function editWorkflow(op: EditOp, p: EditParams): ComfyWorkflow {
  const save = (from: string) => ({ class_type: 'SaveImage', inputs: { images: [from, 0], filename_prefix: p.prefix } });
  if (op === 'upscale') {
    const t = p.target ?? { width: p.width * 2, height: p.height * 2 };
    const wf: ComfyWorkflow = { '1': { class_type: 'LoadImage', inputs: { image: p.image } } };
    let last = '1';
    if (p.upscaler) {
      wf['2'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: p.upscaler } };
      wf['3'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } };
      last = '3';
    }
    wf['4'] = { class_type: 'ImageScale', inputs: { image: [last, 0], upscale_method: 'lanczos', width: t.width, height: t.height, crop: 'disabled' } };
    wf['9'] = save('4');
    return wf;
  }
  if (!p.checkpoint) throw new ToolError(NO_MODEL);
  const wf: ComfyWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '2': { class_type: 'LoadImage', inputs: { image: p.image } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: p.prompt || 'high quality photo' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: p.negative || NEG } },
  };
  if (op === 'inpaint') {
    if (!p.mask) throw new ToolError(en('Paint over the part to change first.'));
    wf['5'] = { class_type: 'LoadImage', inputs: { image: p.mask } };
    wf['6'] = { class_type: 'ImageToMask', inputs: { image: ['5', 0], channel: 'red' } };
    wf['7'] = { class_type: 'GrowMask', inputs: { mask: ['6', 0], expand: 6, tapered_corners: true } };
    wf['8'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['2', 0], vae: ['1', 2], mask: ['7', 0], grow_mask_by: 8 } };
    wf['10'] = ks(['1', 0], ['3', 0], ['4', 0], ['8', 0], p.seed, 1);
    wf['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['1', 2] } };
    // Only the painted part changes: the rest is the original's own pixels.
    wf['12'] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['2', 0], source: ['11', 0], x: 0, y: 0, resize_source: false, mask: ['7', 0] } };
    wf['9'] = save('12');
    return wf;
  }
  if (op === 'outpaint') {
    const pad = p.pad ?? { left: 0, top: 0, right: 0, bottom: 0 };
    wf['5'] = { class_type: 'ImagePadForOutpaint', inputs: { image: ['2', 0], ...pad, feathering: 40 } };
    wf['8'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['5', 0], vae: ['1', 2], mask: ['5', 1], grow_mask_by: 8 } };
    wf['10'] = ks(['1', 0], ['3', 0], ['4', 0], ['8', 0], p.seed, 1);
    wf['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['1', 2] } };
    wf['9'] = save('11');
    return wf;
  }
  // restyle: img2img; strength = how much may change (0.1 a touch, 0.9 nearly new).
  wf['8'] = { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } };
  wf['10'] = ks(['1', 0], ['3', 0], ['4', 0], ['8', 0], p.seed, Math.min(0.95, Math.max(0.05, p.strength ?? 0.5)));
  wf['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['1', 2] } };
  wf['9'] = save('11');
  return wf;
}

export interface VideoParams {
  prompt: string;
  negative?: string;
  seconds: number;
  seed: number;
  prefix: string;
  image?: string;
  width?: number;
  height?: number;
}

/** Clip size: landscape unless the start picture is tall. */
const frame = (p: VideoParams, wide: [number, number]): [number, number] => (p.width && p.height && p.height > p.width ? [wide[1], wide[0]] : wide);

/** A built-in short-video recipe (Wan 2.1 or LTX-Video 0.9), saved as an animated WebP. */
export function videoWorkflow(r: VideoRecipe, p: VideoParams): ComfyWorkflow {
  const neg = p.negative || 'blurry, low quality, still picture, distorted, watermark, text';
  if (r.family === 'wan') {
    const length = 16 * p.seconds + 1;
    const [w, h] = frame(p, [832, 480]);
    const wf: ComfyWorkflow = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: r.model, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: r.textEncoder, type: 'wan', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: r.vae } },
      '4': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: neg } },
    };
    let pos: unknown = ['5', 0];
    let ng: unknown = ['6', 0];
    let latent: unknown;
    if (p.image) {
      wf['7'] = { class_type: 'LoadImage', inputs: { image: p.image } };
      wf['8'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: r.clipVision } };
      wf['9'] = { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['8', 0], image: ['7', 0], crop: 'none' } };
      wf['10'] = { class_type: 'WanImageToVideo', inputs: { positive: pos, negative: ng, vae: ['3', 0], clip_vision_output: ['9', 0], start_image: ['7', 0], width: w, height: h, length, batch_size: 1 } };
      pos = ['10', 0];
      ng = ['10', 1];
      latent = ['10', 2];
    } else {
      wf['10'] = { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: w, height: h, length, batch_size: 1 } };
      latent = ['10', 0];
    }
    wf['11'] = { class_type: 'KSampler', inputs: { model: ['4', 0], positive: pos, negative: ng, latent_image: latent, seed: p.seed, steps: 30, cfg: 6, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 } };
    wf['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } };
    wf['13'] = { class_type: 'SaveAnimatedWEBP', inputs: { images: ['12', 0], filename_prefix: p.prefix, fps: 16, lossless: false, quality: 85, method: 'default' } };
    return wf;
  }
  if (r.family === 'ltxv') {
    const length = 24 * p.seconds + 1;
    const [w, h] = frame(p, [768, 512]);
    const wf: ComfyWorkflow = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: r.model } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: r.textEncoder, type: 'ltxv', device: 'default' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: neg } },
    };
    let pos: unknown = ['5', 0];
    let ng: unknown = ['6', 0];
    let latent: unknown;
    if (p.image) {
      wf['7'] = { class_type: 'LoadImage', inputs: { image: p.image } };
      wf['10'] = { class_type: 'LTXVImgToVideo', inputs: { positive: pos, negative: ng, vae: ['1', 2], image: ['7', 0], width: w, height: h, length, batch_size: 1, strength: 1 } };
      pos = ['10', 0];
      ng = ['10', 1];
      latent = ['10', 2];
    } else {
      wf['10'] = { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w, height: h, length, batch_size: 1 } };
      latent = ['10', 0];
    }
    wf['8'] = { class_type: 'LTXVConditioning', inputs: { positive: pos, negative: ng, frame_rate: 24 } };
    wf['11'] = { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['8', 0], negative: ['8', 1], latent_image: latent, seed: p.seed, steps: 30, cfg: 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } };
    wf['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['1', 2] } };
    wf['13'] = { class_type: 'SaveAnimatedWEBP', inputs: { images: ['12', 0], filename_prefix: p.prefix, fps: 24, lossless: false, quality: 85, method: 'default' } };
    return wf;
  }
  throw new ToolError('That recipe is a saved workflow; it is filled in when it runs.');
}

/** The owner's saved video workflow with the prompt (first non-negative text node) and start picture filled in. */
export function fillOwnVideo(wf: ComfyWorkflow, p: VideoParams): ComfyWorkflow {
  const out = structuredClone(wf);
  const nodes = promptNodes(out).filter((n) => !/neg/i.test(n.label));
  if (!nodes.length) throw new ToolError('The saved video workflow has no text box for the prompt.');
  out[nodes[0].id].inputs![nodes[0].input] = p.prompt;
  const loads = Object.values(out).filter((n) => n.class_type === 'LoadImage');
  if (p.image) {
    if (!loads.length) throw new ToolError('The saved video workflow has no Load Image node, so it makes video from words only.');
    for (const n of loads) n.inputs!.image = p.image;
  }
  for (const n of Object.values(out)) for (const k of ['seed', 'noise_seed']) if (typeof n.inputs?.[k] === 'number') n.inputs[k] = p.seed;
  return out;
}

/** A grayscale PNG (white = change) of a rough region, for chat asks like "the person on the left". */
export function regionMask(w: number, h: number, region: Region): Buffer {
  const W = Math.max(1, Math.min(8192, Math.round(w)));
  const H = Math.max(1, Math.min(8192, Math.round(h)));
  const box = { left: [0, 0.05, 0.45, 0.95], right: [0.55, 0.05, 1, 0.95], top: [0.05, 0, 0.95, 0.45], bottom: [0.05, 0.55, 0.95, 1], center: [0.25, 0.15, 0.75, 0.9], whole: [0, 0, 1, 1] }[region];
  const [x0, y0, x1, y1] = [box[0] * W, box[1] * H, box[2] * W, box[3] * H];
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0;
    if (y < y0 || y >= y1) continue;
    for (let x = Math.floor(x0); x < Math.min(W, Math.ceil(x1)); x++) raw[y * (W + 1) + 1 + x] = 255;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The picture rules, before anything is sent: undefined = fine, else the reason to say. */
export function mediaAskProblem(app: AppContext, text: string, o: { fromPicture: boolean }): string | undefined {
  if (app.member?.child?.()) return en('Picture editing and video are off in kid mode.');
  const t = String(text ?? '');
  if (detectMinorSexualContent(t)) return en("No. I won't make anything sexual involving minors, ever.");
  if (detectExplicit(t)) {
    if (o.fromPicture) return en("I don't make sexual or nude edits of a real photo (it may show a real person), with or without adult mode.");
    if (!adultModeOn(app.settings.get())) return en('Adult mode is off, so pictures and video stay non-explicit.');
  }
  return undefined;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type JobPhase = 'sending' | 'waiting' | 'working' | 'saving';
export interface MediaJob {
  id: string;
  kind: 'edit' | 'video';
  op: EditOp | 't2v' | 'i2v';
  status: JobStatus;
  phase: JobPhase;
  /** The Library picture it starts from. */
  sourceId?: number;
  libraryId?: number;
  error?: string;
  prompt?: string;
  startedAt: string;
  endedAt?: string;
}

export interface MediaVersion {
  libraryId: number;
  version: number;
  op: string;
  note: string;
  createdAt: string;
}

export interface MediaDeps {
  tools?: EngineDeps['tools'];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface EditAsk {
  libraryId: number;
  op: EditOp;
  prompt?: string;
  strength?: number;
  /** The drawn mask (PNG, white = change) for inpaint. */
  mask?: Buffer;
  /** Extend: pixels per side (each 0-1024). */
  pad?: { left?: number; top?: number; right?: number; bottom?: number };
  scale?: '2x' | '4x' | '4k';
  conversationId?: string;
}

export interface VideoAsk {
  prompt: string;
  libraryId?: number;
  seconds?: number;
  conversationId?: string;
}

const MEDIA_FILE = /\.(?:png|jpe?g|webp|gif|mp4|webm)$/i;
const POLL_MS = 2000;
const NOT_CONNECTED = en("ComfyUI isn't connected: add it in Settings → Skills & tools → Tool servers (the comfyui-mcp server), with ComfyUI running on this computer.");

/** One space's picture editing and video jobs (the owner's). */
export class MediaStudio {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #deps: MediaDeps;
  readonly #jobs = new Map<string, MediaJob & { ctl: AbortController; promptId?: string }>();
  #caps?: { at: number; caps: MediaCaps };

  constructor(app: AppContext, db: DatabaseSync, deps: MediaDeps = {}) {
    this.#app = app;
    this.#db = db;
    this.#deps = deps;
    db.exec(`CREATE TABLE IF NOT EXISTS media_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, family INTEGER NOT NULL, library_id INTEGER NOT NULL, parent_id INTEGER,
      op TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS media_versions_family ON media_versions(family, id);`);
  }

  prefs(): MediaPrefs {
    return { seconds: 3, ...((this.#app.settings.get() as { media?: MediaPrefs }).media ?? {}) };
  }

  setPrefs(p: Partial<MediaPrefs>): MediaPrefs {
    const cur = this.prefs();
    const next: MediaPrefs = { ...cur };
    if (p.checkpoint !== undefined) next.checkpoint = String(p.checkpoint).slice(0, 300) || undefined;
    if (p.videoWorkflow !== undefined) next.videoWorkflow = /\.json$/i.test(String(p.videoWorkflow)) ? String(p.videoWorkflow).slice(0, 200) : undefined;
    if (p.seconds !== undefined) next.seconds = (SECONDS as readonly number[]).includes(Number(p.seconds)) ? (Number(p.seconds) as MediaPrefs['seconds']) : cur.seconds;
    this.#app.settings.update({ media: next } as never);
    this.#caps = undefined;
    return next;
  }

  /** The comfyui-mcp server's name (the one Pictures from her uses, else one named like ComfyUI). */
  server(): string {
    const s = this.#app.settings.get();
    const named = (s.mcpServers ?? []).find((m) => /comfy/i.test(`${m.name} ${(m as { args?: string[] }).args?.join(' ') ?? ''}`));
    return s.photos?.comfy?.server || named?.name || 'comfyui';
  }

  #tools(): NonNullable<EngineDeps['tools']> {
    if (this.#deps.tools) return this.#deps.tools;
    const app = this.#app;
    return { get: (n) => app.tools.get(n), permission: (n) => app.tools.permission(n, app.settings.get().toolPermissions) };
  }

  /** The comfyui-mcp tool server is connected (its tools are registered). */
  ready(): boolean {
    return Boolean(this.#tools().get(mcpToolName(this.server(), 'enqueue_workflow')));
  }

  /** Private local mode: ComfyUI must be on this computer. */
  #remote(server: string): boolean {
    if (!privateLocalOn()) return false;
    const m = (this.#app.settings.get().mcpServers ?? []).find((x) => x.name === server) as { transport?: string; url?: string; env?: Record<string, string> } | undefined;
    const url = m?.transport === 'http' ? m.url : m?.env?.COMFYUI_URL;
    if (!url) return false;
    try {
      return !isLoopbackHost(new URL(url).hostname);
    } catch {
      return true;
    }
  }

  async caps(fresh = false): Promise<MediaCaps> {
    if (!fresh && this.#caps && Date.now() - this.#caps.at < 60_000) return this.#caps.caps;
    const server = this.server();
    const off = (why: string): MediaCaps => ({ connected: false, server, why, checkpoints: [], edits: Object.fromEntries(EDIT_OPS.map((o) => [o, { ok: false }])) as MediaCaps['edits'], video: { found: [] } });
    let caps: MediaCaps;
    if (this.#remote(server)) caps = off(en('"Nothing leaves this computer" is on and ComfyUI is on another computer, so picture editing and video are off.'));
    else if (!this.#tools().get(mcpToolName(server, 'enqueue_workflow'))) caps = off(NOT_CONNECTED);
    else {
      try {
        const got = await runTool({ tools: this.#tools() }, mcpToolName(server, 'list_local_models'), { action: 'list' }, {});
        caps = mediaCaps(readModelList(got.text), this.prefs(), server);
      } catch (err) {
        caps = off(`ComfyUI didn't answer: ${comfyReason((err as Error).message)}`);
      }
    }
    this.#caps = { at: Date.now(), caps };
    return caps;
  }

  job(id: string): MediaJob | undefined {
    const j = this.#jobs.get(id);
    if (!j) return undefined;
    const { ctl: _c, promptId: _p, ...rest } = j;
    return rest;
  }

  jobs(): MediaJob[] {
    return [...this.#jobs.keys()].reverse().map((id) => this.job(id)!).slice(0, 20);
  }

  cancel(id: string): MediaJob | undefined {
    const j = this.#jobs.get(id);
    if (j && j.status === 'running') j.ctl.abort();
    return this.job(id);
  }

  /** Waits for a job (chat tools); undefined status = still running after `ms`. */
  async wait(id: string, ms: number, signal?: AbortSignal): Promise<MediaJob> {
    const end = Date.now() + ms;
    for (;;) {
      const j = this.job(id)!;
      if (j.status !== 'running' || Date.now() > end) return j;
      if (signal?.aborted) {
        this.cancel(id);
        return this.job(id)!;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** The versions of a picture's family, oldest first (the original is version 1). */
  versions(libraryId: number): MediaVersion[] {
    const row = this.#db.prepare('SELECT family FROM media_versions WHERE library_id = ? ORDER BY id DESC LIMIT 1').get(libraryId) as { family: number } | undefined;
    const family = row?.family ?? libraryId;
    const lib = this.#app.library;
    const root = lib?.get(family);
    const out: MediaVersion[] = root ? [{ libraryId: family, version: 1, op: 'original', note: '', createdAt: root.addedAt }] : [];
    const rows = this.#db.prepare('SELECT * FROM media_versions WHERE family = ? ORDER BY id').all(family) as Record<string, unknown>[];
    for (const r of rows) if (lib?.get(Number(r.library_id))) out.push({ libraryId: Number(r.library_id), version: out.length + 1, op: String(r.op), note: String(r.note), createdAt: String(r.created_at) });
    return out;
  }

  #source(libraryId: number): { bytes: Buffer; width: number; height: number; name: string } {
    const lib = this.#app.library;
    const doc = lib?.get(Number(libraryId));
    const bytes = doc ? lib!.file(doc) : undefined;
    const pic = bytes ? measure(bytes) : undefined;
    if (!doc || !bytes || !pic || doc.kind === 'video' || !/^image\/(png|jpeg|webp)$/.test(pic.mime)) throw new ToolError(`There is no picture #${libraryId} in the Library (PNG, JPEG or WebP).`);
    return { bytes, width: pic.width, height: pic.height, name: doc.title || doc.name };
  }

  async startEdit(a: EditAsk): Promise<MediaJob> {
    const op = EDIT_OPS.includes(a.op) ? a.op : undefined;
    if (!op) throw new ToolError('Pick what to do: inpaint, outpaint, upscale, background or restyle.');
    const why = mediaAskProblem(this.#app, a.prompt ?? '', { fromPicture: true });
    if (why) throw new ToolError(why);
    const src = this.#source(a.libraryId);
    const caps = await this.caps();
    if (!caps.connected) throw new ToolError(caps.why ?? NOT_CONNECTED);
    if (!caps.edits[op].ok) throw new ToolError(caps.edits[op].note ?? NOT_CONNECTED);
    if (op === 'inpaint' && !a.mask) throw new ToolError(en('Paint over the part to change first.'));
    return this.#start({ kind: 'edit', op, sourceId: a.libraryId, prompt: a.prompt }, async (j, io) => {
      const image = await io.upload(src.bytes, 'png');
      if (op === 'background') {
        let text: string;
        try {
          text = (await io.run('generate_image', { action: 'remove_background', image })).text;
        } catch (err) {
          // Only the first sentence: the rest is the tool server's advice to agents (its own commands).
          const why = comfyReason((err as Error).message).split(/(?<=[.!])\s+/)[0];
          throw new ToolError(`Background removal isn't available in ComfyUI: ${why} Install ComfyUI-RMBG with ComfyUI Manager, then try again.`);
        }
        return { promptId: io.promptId(text), name: `${src.name} (no background)` };
      }
      const pad = a.pad ? { left: clampPad(a.pad.left), top: clampPad(a.pad.top), right: clampPad(a.pad.right), bottom: clampPad(a.pad.bottom) } : { left: 0, top: 0, right: 256, bottom: 0 };
      const target = op === 'upscale' ? upscaleTarget(src.width, src.height, a.scale) : undefined;
      const mask = op === 'inpaint' ? await io.upload(a.mask!, 'png') : undefined;
      const wf = editWorkflow(op, { checkpoint: caps.checkpoint, image, mask, prompt: editPrompt(op, a.prompt), strength: a.strength, pad, upscaler: caps.upscaler, target, seed: io.seed(), prefix: 'sara-media/edit', width: src.width, height: src.height });
      return { promptId: await io.enqueue(wf), name: `${src.name} (${OP_WORD[op]})`, note: j.prompt };
    });
  }

  async startVideo(a: VideoAsk): Promise<MediaJob> {
    const prompt = String(a.prompt ?? '').trim().slice(0, 1200);
    if (!prompt) throw new ToolError(en('Say what the clip should show.'));
    const fromPicture = a.libraryId !== undefined && a.libraryId !== null;
    const why = mediaAskProblem(this.#app, prompt, { fromPicture });
    if (why) throw new ToolError(why);
    const src = fromPicture ? this.#source(Number(a.libraryId)) : undefined;
    const caps = await this.caps();
    if (!caps.connected) throw new ToolError(caps.why ?? NOT_CONNECTED);
    const recipe = src ? caps.video.i2v : caps.video.t2v;
    if (!recipe) throw new ToolError(src && caps.video.t2v ? en('The video models installed make clips from words only; ask without a start picture, or add a picture-to-video model in ComfyUI.') : caps.video.note!.replace('{list}', caps.video.found.join(', ')));
    const seconds = (SECONDS as readonly number[]).includes(Number(a.seconds)) ? Number(a.seconds) : (this.prefs().seconds ?? 3);
    return this.#start({ kind: 'video', op: src ? 'i2v' : 't2v', sourceId: src ? Number(a.libraryId) : undefined, prompt }, async (_j, io) => {
      const image = src ? await io.upload(src.bytes, 'png') : undefined;
      const p: VideoParams = { prompt, seconds, seed: io.seed(), prefix: 'sara-media/clip', image, width: src?.width, height: src?.height };
      const wf = recipe.family === 'own' ? fillOwnVideo(await loadComfyWorkflow({ tools: this.#tools() }, caps.server, recipe.model), p) : videoWorkflow(recipe, p);
      return { promptId: await io.enqueue(wf), name: `${prompt.slice(0, 60)} (clip)` };
    });
  }

  async #start(base: Pick<MediaJob, 'kind' | 'op' | 'sourceId' | 'prompt'>, send: (j: MediaJob, io: RunIO) => Promise<{ promptId: string; name: string; note?: string }>): Promise<MediaJob> {
    if ([...this.#jobs.values()].filter((x) => x.status === 'running').length >= 3) throw new ToolError(en('Three picture jobs are already running; wait for one to finish or cancel one.'));
    const id = randomBytes(6).toString('hex');
    const j = { id, ...base, status: 'running' as JobStatus, phase: 'sending' as JobPhase, startedAt: this.#app.now().toISOString(), ctl: new AbortController(), promptId: undefined as string | undefined };
    this.#jobs.set(id, j);
    while (this.#jobs.size > 40) this.#jobs.delete(this.#jobs.keys().next().value!);
    void this.#run(j, send);
    return this.job(id)!;
  }

  async #run(j: MediaJob & { ctl: AbortController; promptId?: string }, send: (j: MediaJob, io: RunIO) => Promise<{ promptId: string; name: string; note?: string }>): Promise<void> {
    const server = this.server();
    const tools = this.#tools();
    const signal = j.ctl.signal;
    const run = (tool: string, args: Record<string, unknown>) => runTool({ tools }, mcpToolName(server, tool), args, { signal });
    const tmp = join(this.#app.dataDir, 'media-tmp');
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const io: RunIO = {
      run,
      seed: () => Math.floor((this.#deps.random ?? Math.random)() * 2 ** 32),
      upload: async (bytes, ext) => {
        mkdirSync(tmp, { recursive: true, mode: 0o700 });
        const name = `sara-${randomBytes(6).toString('hex')}.${ext}`;
        const path = join(tmp, name);
        writeFileSync(path, bytes, { mode: 0o600 });
        try {
          await run('upload_image', { action: 'image', source_path: path, filename: name });
        } catch (err) {
          throw new ToolError(`ComfyUI didn't take the picture: ${comfyReason((err as Error).message)}`);
        } finally {
          rmSync(path, { force: true });
        }
        return name;
      },
      enqueue: async (wf) => {
        let text: string;
        try {
          text = (await run('enqueue_workflow', { action: 'enqueue', workflow: wf })).text;
        } catch (err) {
          throw new ToolError(`ComfyUI didn't take the workflow: ${comfyReason((err as Error).message)}`);
        }
        return io.promptId(text);
      },
      promptId: (text) => {
        const id = /prompt_id["']?\s*[:=]\s*["']?([\w-]{6,})/i.exec(text)?.[1];
        if (!id) throw new ToolError(`ComfyUI didn't take the workflow: ${comfyReason(text)}`);
        return id;
      },
    };
    try {
      const sent = await send(j, io);
      j.promptId = sent.promptId;
      if (signal.aborted) throw new ToolError('Stopped.');
      j.phase = 'waiting';
      const limit = (j.kind === 'video' ? 30 * 60_000 : 10 * 60_000) / POLL_MS;
      let file: { file: string; type?: string } | undefined;
      for (let i = 0; i < limit && !file; i++) {
        if (signal.aborted) throw new ToolError('Stopped.');
        let done = true;
        try {
          const q = JSON.parse((await run('queue', { action: 'status', prompt_id: sent.promptId })).text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { running?: boolean; pending?: boolean; done?: boolean };
          if (q.running) j.phase = 'working';
          done = !q.running && !q.pending;
        } catch {
          // An older tool server without queue status: read the history every time.
        }
        if (done) {
          const h = readComfyHistory((await run('get_history', { action: 'list', prompt_id: sent.promptId })).text, MEDIA_FILE);
          if (h.state === 'error') throw new ToolError(`ComfyUI couldn't finish: ${h.reason}`);
          if (h.state === 'done') file = h;
        }
        if (!file) await sleep(POLL_MS);
      }
      if (!file) throw new ToolError('ComfyUI took too long; nothing was saved.');
      if (signal.aborted) throw new ToolError('Stopped.');
      j.phase = 'saving';
      const bytes = await this.#fetch(run, file, tmp);
      const ext = (/\.(\w+)$/.exec(file.file)?.[1] ?? 'png').toLowerCase();
      j.libraryId = this.#keep(j, bytes, ext, sent.name);
      j.status = 'done';
    } catch (err) {
      if (signal.aborted) {
        j.status = 'cancelled';
        if (j.promptId) {
          for (const action of ['cancel_queued', 'cancel']) await run('queue', { action, prompt_id: j.promptId }).catch(() => undefined);
        }
      } else {
        j.status = 'failed';
        j.error = (err as Error).message.slice(0, 500);
      }
    } finally {
      j.endedAt = this.#app.now().toISOString();
      this.#app.events?.publish({ type: 'library', id: j.libraryId ?? 0 });
    }
  }

  /** The finished file: from the folder get_image saved it to (inside our own temp folder only), else inline. */
  async #fetch(run: RunIO['run'], f: { file: string; type?: string }, tmp: string): Promise<Buffer> {
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const got = await run('get_image', { action: 'get', filename: f.file, ...(f.type ? { type: f.type } : {}), save_dir: tmp });
    const saved = /Saved to:\s*(.+?\.\w{2,5})(?=[\s(.]|$)/.exec(got.text)?.[1];
    if (saved) {
      const p = resolve(saved);
      if (p.startsWith(resolve(tmp) + sep)) {
        try {
          return readFileSync(p);
        } finally {
          rmSync(p, { force: true });
        }
      }
    }
    if (got.images.length) return got.images[0];
    throw new ToolError("The result was made, but this Sara couldn't fetch it from ComfyUI.");
  }

  #keep(j: MediaJob, bytes: Buffer, ext: string, name: string): number {
    const lib = this.#app.library;
    if (!lib) throw new ToolError('The Library is not available here.');
    const isVideo = j.kind === 'video';
    const base = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'picture';
    const doc = lib.add({ name: `${base}.${ext}`, bytes, keep: true, origin: 'library', learn: false, conversationId: null });
    // Read at once (no picture model reads it as a "photo of a page"): what it is, for search.
    const what = isVideo ? `Short video made in ComfyUI: ${j.prompt ?? ''}` : `Picture edited in ComfyUI (${OP_WORD[j.op as EditOp] ?? j.op})${j.prompt ? `: ${j.prompt}` : ''}`;
    lib.setRead(doc.id, { kind: isVideo ? 'video' : 'image', title: base, parts: [{ text: what.slice(0, 1500), where: isVideo ? 'video' : 'picture' }], warnings: [] });
    if (j.sourceId) {
      const row = this.#db.prepare('SELECT family FROM media_versions WHERE library_id = ? ORDER BY id DESC LIMIT 1').get(j.sourceId) as { family: number } | undefined;
      this.#db.prepare('INSERT INTO media_versions (family, library_id, parent_id, op, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(row?.family ?? j.sourceId, doc.id, j.sourceId, j.op, (j.prompt ?? '').slice(0, 300), this.#app.now().toISOString());
    }
    this.#app.libraryNudge?.();
    return doc.id;
  }
}

interface RunIO {
  run: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; images: Buffer[] }>;
  upload: (bytes: Buffer, ext: string) => Promise<string>;
  enqueue: (wf: ComfyWorkflow) => Promise<string>;
  promptId: (text: string) => string;
  seed: () => number;
}

const OP_WORD: Record<EditOp, string> = { inpaint: 'edited', outpaint: 'extended', upscale: 'upscaled', background: 'no background', restyle: 'restyled' };
const clampPad = (v: unknown) => Math.max(0, Math.min(1024, Math.round(Number(v) || 0) - (Math.round(Number(v) || 0) % 8)));

/** What the model is told to draw: "remove …" asks become a clean fill. */
function editPrompt(op: EditOp, ask?: string): string | undefined {
  const t = String(ask ?? '').trim();
  if (op === 'inpaint' && (!t || /^(remove|erase|delete|get rid of)\b/i.test(t))) return 'empty background, nothing there, seamless continuation of the surroundings, natural lighting';
  if (op === 'outpaint' && !t) return 'seamless continuation of the scene, same style and lighting';
  return t || undefined;
}

/** 2x / 4x, or "4k" = the long side 3840 (never above 8192 per side). */
export function upscaleTarget(w: number, h: number, scale?: string): { width: number; height: number } {
  const f = scale === '4k' ? 3840 / Math.max(w, h) : scale === '4x' ? 4 : 2;
  const k = Math.min(f, 8192 / Math.max(w, h));
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

const studios = new WeakMap<DatabaseSync, MediaStudio>();
/** The owner's studio (undefined for household members and the demo). */
export function mediaFor(app: AppContext): MediaStudio | undefined {
  if (app.member) return undefined;
  if (app.media) return app.media;
  let s = studios.get(app.store.db);
  if (!s) studios.set(app.store.db, (s = new MediaStudio(app, app.store.db)));
  return s;
}
