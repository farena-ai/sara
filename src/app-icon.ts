// The companion's app icon, made on the server (docs/desktop.md → Her face as the app's icon).
// One stable address per server and companion: /app-icon.png?s=<size>[&shape=rounded|square|maskable]
// and /app-icon.ico (16…256 px PNG frames). Made from what the page shows as her face (an uploaded
// picture, a custom or he/they default look), Sara's own app icon for Sara with her own look, and
// otherwise a monogram (her initial on the theme's accent gradient): a renamed companion never gets
// Sara's face. The ETag is the version (picture + name + shape + size), so apps poll it cheaply.
// No dependencies: src/jpeg.ts decodes JPEGs, PNGs are read and written here with node:zlib.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { appFaceOf, uploadedAvatar } from './app-face.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from './http.ts';
import { decodeJpeg } from './jpeg.ts';

/** Bump when the drawing changes, so every app fetches the icons again. */
const RENDER = 1;
/** Sizes an app may ask for (others snap to the next bigger one). */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 180, 192, 256, 512] as const;
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
export type IconShape = 'rounded' | 'square' | 'maskable';
/** The theme's accent gradient (web/theme.css --accent-from / --accent-to). */
const ACCENT_FROM = [0xe0, 0x60, 0x7e];
const ACCENT_TO = [0x9b, 0x6b, 0xff];

interface IconSource {
  dataDir: string;
  companionId?: string;
  persona: { name: string };
  look?: { custom: boolean; fileOrDefault(rel: string): string | undefined };
}

interface Rgba {
  w: number;
  h: number;
  /** w × h × 4, straight alpha. */
  px: Uint8Array;
}

export interface AppIconInfo {
  /** 'face' (her picture), 'builtin' (Sara's own app icon) or 'initial' (the monogram). */
  kind: 'face' | 'builtin' | 'initial';
  /** Changes whenever any of her icons would change. */
  version: string;
  /** The letter on the monogram. */
  letter: string;
}

const stamp = (f: string): string => {
  try {
    const s = statSync(f);
    return `${s.size}-${Math.floor(s.mtimeMs)}`;
  } catch {
    return '0';
  }
};

/** Her initial, folded to a letter the monogram can draw (É → E); '' when there is none. */
export function initialOf(name: string): string {
  const first = [...name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')][0] ?? '';
  const up = first.toUpperCase();
  return GLYPHS[up] ? up : '';
}

/** Which picture her icon is made from, and its version. */
export function appIconInfo(app: IconSource): AppIconInfo & { file?: string } {
  const face = appFaceOf(app);
  const name = app.persona.name.trim();
  const letter = initialOf(name);
  const v = (parts: string) => createHash('sha256').update(`${RENDER}|${parts}`).digest('base64url').slice(0, 16);
  if (face.kind === 'custom') {
    const file = uploadedAvatar(app.dataDir)!;
    return { kind: 'face', file, letter, version: v(`c|${stamp(file)}|${name}`) };
  }
  if (face.kind === 'look') {
    const file = app.look?.fileOrDefault('sara-avatar.jpg');
    if (file) return { kind: 'face', file, letter, version: v(`l|${file}|${stamp(file)}|${name}`) };
  }
  if (face.kind === 'builtin') return { kind: 'builtin', letter, version: v('b') };
  return { kind: 'initial', letter, version: v(`i|${name}`) };
}

// ---------------- PNG in and out ----------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 8-bit, non-interlaced PNGs (grey, RGB, palette-less grey+alpha, RGBA), every filter. */
export function decodePng(buf: Buffer): Rgba | undefined {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return undefined;
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const kind = buf.subarray(p + 4, p + 8).toString('latin1');
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!w || !h || w * h > 16_000_000 || depth !== 8 || interlace !== 0 || !ch || (type === 3 && !palette)) return undefined;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) return undefined;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let pr = 0;
      if (f === 1) pr = a;
      else if (f === 2) pr = b;
      else if (f === 3) pr = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (row[i] + pr) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const s = x * ch;
      if (type === 3) {
        const k = cur[s] * 3;
        px[o] = palette![k] ?? 0;
        px[o + 1] = palette![k + 1] ?? 0;
        px[o + 2] = palette![k + 2] ?? 0;
        px[o + 3] = 255;
      } else if (ch <= 2) {
        px[o] = px[o + 1] = px[o + 2] = cur[s];
        px[o + 3] = ch === 2 ? cur[s + 1] : 255;
      } else {
        px[o] = cur[s];
        px[o + 1] = cur[s + 1];
        px[o + 2] = cur[s + 2];
        px[o + 3] = ch === 4 ? cur[s + 3] : 255;
      }
    }
    cur.copy(prev);
  }
  return { w, h, px };
}

/** RGBA → PNG (filter 0, deflated). */
export function encodePngRgba(img: Rgba): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(img.h * (img.w * 4 + 1));
  for (let y = 0; y < img.h; y++) Buffer.from(img.px.buffer, img.px.byteOffset + y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1);
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A .ico whose frames are PNGs (Windows Vista and later read them at every size). */
export function encodeIco(frames: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = f.size >= 256 ? 0 : f.size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(f.png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += f.png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

// ---------------- drawing ----------------

function readPicture(file: string): Rgba | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return undefined;
  }
  if (buf[0] === 0x89) return decodePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = decodeJpeg(buf);
    if (!j) return undefined;
    const px = new Uint8Array(j.width * j.height * 4);
    for (let i = 0, o = 0; i < j.data.length; i += 3, o += 4) {
      px[o] = j.data[i];
      px[o + 1] = j.data[i + 1];
      px[o + 2] = j.data[i + 2];
      px[o + 3] = 255;
    }
    return { w: j.width, h: j.height, px };
  }
  return undefined; // WebP and the rest: the monogram
}

/** A square crop (x, y, side) of the source scaled to size×size: area average down, bilinear up. */
function cropScale(src: Rgba, cx: number, cy: number, side: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const step = side / size;
  const tmp = [0, 0, 0, 0];
  const sample = (x: number, y: number) => {
    // Bilinear at (x, y) in source pixels.
    const fx = Math.min(Math.max(x - 0.5, 0), src.w - 1), fy = Math.min(Math.max(y - 0.5, 0), src.h - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, src.w - 1), y1 = Math.min(y0 + 1, src.h - 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 4; c++) {
      const p = (xx: number, yy: number) => src.px[(yy * src.w + xx) * 4 + c];
      tmp[c] += (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
    }
  };
  const n = Math.max(1, Math.min(8, Math.ceil(step)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tmp[0] = tmp[1] = tmp[2] = tmp[3] = 0;
      const o = (y * size + x) * 4;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) sample(cx + (x + (i + 0.5) / n) * step, cy + (y + (j + 0.5) / n) * step);
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(tmp[c] / (n * n));
    }
  }
  return out;
}

/** Corner radius as a share of the side (the page's rounded square: 40 of 256). */
const radiusOf = (shape: IconShape) => (shape === 'rounded' ? 40 / 256 : 0);

/** Alpha of a rounded square at pixel (x, y): 1 inside, soft on the edge. */
function cornerAlpha(x: number, y: number, size: number, r: number): number {
  if (r <= 0) return 1;
  const px = x + 0.5, py = y + 0.5;
  const qx = Math.max(Math.abs(px - size / 2) - (size / 2 - r), 0);
  const qy = Math.max(Math.abs(py - size / 2) - (size / 2 - r), 0);
  const d = Math.hypot(qx, qy) - r;
  return Math.min(1, Math.max(0, 0.5 - d));
}

function facePixels(src: Rgba, size: number, shape: IconShape): Uint8Array {
  // The page's crop (centred, a quarter of the spare height from the top); small sizes a closer one
  // (as sara.ico) so a face stays a face at 16 px.
  const s = Math.min(src.w, src.h);
  let cx = (src.w - s) / 2, cy = Math.max(0, (src.h - s) / 4), side = s;
  if (size <= 48 && shape === 'rounded') {
    cx += side * 0.12;
    cy += side * 0.06;
    side *= 0.76;
  }
  const px = cropScale(src, cx, cy, side, size);
  const r = radiusOf(shape) * size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[(y * size + x) * 4 + 3] = Math.round(px[(y * size + x) * 4 + 3] * cornerAlpha(x, y, size, r));
  return px;
}

// The monogram's letters as strokes in a 1-high box (x to the right, y down). Arcs: [cx, cy, rx, ry, from°, to°]
// with 0° = right and 90° = down.
type Stroke = number[][] | { arc: [number, number, number, number, number, number] };
const L = (...pts: number[]): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
};
const A = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Stroke => ({ arc: [cx, cy, rx, ry, a0, a1] });
const GLYPHS: Record<string, Stroke[]> = {
  A: [L(0, 1, 0.4, 0, 0.8, 1), L(0.15, 0.64, 0.65, 0.64)],
  B: [L(0.45, 0, 0, 0, 0, 1, 0.5, 1), A(0.45, 0.25, 0.27, 0.25, -90, 90), L(0, 0.5, 0.5, 0.5), A(0.5, 0.75, 0.29, 0.25, -90, 90)],
  C: [A(0.45, 0.5, 0.45, 0.5, 40, 320)],
  D: [L(0.35, 0, 0, 0, 0, 1, 0.35, 1), A(0.35, 0.5, 0.45, 0.5, -90, 90)],
  E: [L(0.7, 0, 0, 0, 0, 1, 0.7, 1), L(0, 0.5, 0.58, 0.5)],
  F: [L(0.7, 0, 0, 0, 0, 1), L(0, 0.5, 0.58, 0.5)],
  G: [A(0.45, 0.5, 0.45, 0.5, 20, 320), L(0.873, 0.67, 0.873, 0.55, 0.5, 0.55)],
  H: [L(0, 0, 0, 1), L(0.75, 0, 0.75, 1), L(0, 0.5, 0.75, 0.5)],
  I: [L(0, 0, 0, 1)],
  J: [L(0.6, 0, 0.6, 0.68), A(0.3, 0.68, 0.3, 0.32, 0, 180)],
  K: [L(0, 0, 0, 1), L(0.7, 0, 0, 0.62), L(0.24, 0.43, 0.74, 1)],
  L: [L(0, 0, 0, 1, 0.65, 1)],
  M: [L(0, 1, 0, 0, 0.45, 0.62, 0.9, 0, 0.9, 1)],
  N: [L(0, 1, 0, 0, 0.75, 1, 0.75, 0)],
  O: [A(0.5, 0.5, 0.5, 0.5, 0, 360)],
  P: [L(0, 1, 0, 0, 0.4, 0), A(0.4, 0.27, 0.3, 0.27, -90, 90), L(0.4, 0.54, 0, 0.54)],
  Q: [A(0.5, 0.5, 0.5, 0.5, 0, 360), L(0.62, 0.72, 0.95, 1.04)],
  R: [L(0, 1, 0, 0, 0.4, 0), A(0.4, 0.27, 0.3, 0.27, -90, 90), L(0.4, 0.54, 0, 0.54), L(0.36, 0.54, 0.72, 1)],
  S: [A(0.38, 0.26, 0.36, 0.26, -30, -270), A(0.38, 0.76, 0.38, 0.24, -90, 150)],
  T: [L(0, 0, 0.8, 0), L(0.4, 0, 0.4, 1)],
  U: [L(0, 0, 0, 0.6), A(0.37, 0.6, 0.37, 0.4, 180, 0), L(0.74, 0.6, 0.74, 0)],
  V: [L(0, 0, 0.4, 1, 0.8, 0)],
  W: [L(0, 0, 0.25, 1, 0.5, 0.35, 0.75, 1, 1, 0)],
  X: [L(0, 0, 0.75, 1), L(0.75, 0, 0, 1)],
  Y: [L(0, 0, 0.4, 0.5, 0.8, 0), L(0.4, 0.5, 0.4, 1)],
  Z: [L(0, 0, 0.75, 0, 0, 1, 0.75, 1)],
  '0': [A(0.38, 0.5, 0.38, 0.5, 0, 360)],
  '1': [L(0.12, 0.2, 0.4, 0, 0.4, 1)],
  '2': [A(0.36, 0.3, 0.36, 0.3, 200, 380), L(0.7, 0.4, 0, 1, 0.74, 1)],
  '3': [A(0.34, 0.26, 0.33, 0.26, 210, 450), A(0.34, 0.75, 0.37, 0.25, 270, 510)],
  '4': [L(0.56, 1, 0.56, 0, 0, 0.68, 0.8, 0.68)],
  '5': [L(0.7, 0, 0.1, 0, 0.06, 0.46), A(0.36, 0.68, 0.37, 0.32, 230, 495)],
  '6': [A(0.38, 0.7, 0.36, 0.3, 0, 360), L(0.62, 0.02, 0.04, 0.66)],
  '7': [L(0, 0, 0.75, 0, 0.25, 1)],
  '8': [A(0.38, 0.26, 0.3, 0.24, 0, 360), A(0.38, 0.75, 0.36, 0.25, 0, 360)],
  '9': [A(0.38, 0.3, 0.36, 0.3, 0, 360), L(0.74, 0.34, 0.36, 1)],
};
/** No drawable letter (an emoji, Japanese…): a small four-point sparkle. */
const SPARKLE: Stroke[] = [L(0.5, 0.1, 0.5, 0.9), L(0.1, 0.5, 0.9, 0.5), L(0.27, 0.27, 0.73, 0.73), L(0.73, 0.27, 0.27, 0.73)];

function strokesToSegments(strokes: Stroke[]): number[][] {
  const segs: number[][] = [];
  for (const s of strokes) {
    let pts: number[][];
    if (Array.isArray(s)) pts = s;
    else {
      const [cx, cy, rx, ry, a0, a1] = s.arc;
      const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 6));
      pts = [];
      for (let i = 0; i <= n; i++) {
        const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
    }
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
  }
  return segs;
}

function monogramPixels(letter: string, size: number, shape: IconShape): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = radiusOf(shape) * size;
  // Glyph box: 46% of the side high (inside the maskable safe zone), centred on its own bounds.
  const segs = strokesToSegments(GLYPHS[letter] ?? SPARKLE);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x0, y0, x1, y1] of segs) {
    minX = Math.min(minX, x0, x1);
    maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxY = Math.max(maxY, y0, y1);
  }
  const k = size * (shape === 'maskable' ? 0.4 : 0.48);
  const ox = size / 2 - ((minX + maxX) / 2) * k, oy = size / 2 - ((minY + maxY) / 2) * k;
  const S = segs.map(([x0, y0, x1, y1]) => [ox + x0 * k, oy + y0 * k, ox + x1 * k, oy + y1 * k]);
  // Thicker at small sizes so 16 px still reads.
  const half = Math.max(0.9, k * (size <= 24 ? 0.13 : size <= 48 ? 0.11 : 0.085));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const t = (x + y) / (2 * size);
      const a = cornerAlpha(x, y, size, r);
      const qx = x + 0.5, qy = y + 0.5;
      let d = Infinity;
      for (const [x0, y0, x1, y1] of S) {
        const dx = x1 - x0, dy = y1 - y0;
        const l2 = dx * dx + dy * dy;
        const u = l2 ? Math.min(1, Math.max(0, ((qx - x0) * dx + (qy - y0) * dy) / l2)) : 0;
        d = Math.min(d, Math.hypot(qx - x0 - u * dx, qy - y0 - u * dy));
      }
      const ink = Math.min(1, Math.max(0, half - d + 0.5));
      for (let c = 0; c < 3; c++) {
        const bg = ACCENT_FROM[c] + (ACCENT_TO[c] - ACCENT_FROM[c]) * t;
        px[o + c] = Math.round(bg * (1 - ink) + 255 * ink);
      }
      px[o + 3] = Math.round(255 * a);
    }
  }
  return px;
}

let builtinArt: Rgba | undefined;
const cache = new Map<string, Buffer>();
const remember = (key: string, make: () => Buffer): Buffer => {
  const hit = cache.get(key);
  if (hit) return hit;
  const b = make();
  if (cache.size > 120) cache.delete(cache.keys().next().value!);
  cache.set(key, b);
  return b;
};

/** The size an app asked for, snapped to one we make. */
export function iconSize(asked: unknown): number {
  const n = Number(asked);
  if (!Number.isFinite(n) || n <= 0) return 256;
  return ICON_SIZES.find((s) => s >= n) ?? 512;
}

/** Sara's own app icon (web/icon-512.png) for Sara with her own look and for anyone signed out. */
function builtinPixels(webRoot: string, size: number, shape: IconShape): Uint8Array {
  builtinArt ??= decodePng(readFileSync(join(webRoot, 'icon-512.png')));
  const px = cropScale(builtinArt!, 0, 0, builtinArt!.w, size);
  const r = radiusOf(shape) * size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[(y * size + x) * 4 + 3] = Math.round(255 * cornerAlpha(x, y, size, r));
  return px;
}

export interface MadeIcon {
  body: Buffer;
  etag: string;
  kind: AppIconInfo['kind'];
}

/** Her icon as a PNG (signed out: Sara's own, so nothing about her shows before sign-in). */
export function appIconPng(app: IconSource | undefined, webRoot: string, size: number, shape: IconShape = 'rounded'): MadeIcon {
  const info = app ? appIconInfo(app) : { kind: 'builtin' as const, letter: '', version: 'public' };
  const key = `${info.version}|${size}|${shape}`;
  let kind = info.kind;
  const body = remember(key, () => {
    let px: Uint8Array | undefined;
    if (info.kind === 'face' && 'file' in info && info.file) {
      const pic = readPicture(info.file);
      if (pic) px = facePixels(pic, size, shape);
      else kind = 'initial';
    }
    if (!px && info.kind === 'builtin') px = builtinPixels(webRoot, size, shape);
    px ??= monogramPixels(info.letter, size, shape);
    return encodePngRgba({ w: size, h: size, px });
  });
  return { body, etag: `"ai-${info.version}-${size}-${shape[0]}"`, kind };
}

/** Her icon as a .ico with the sizes Windows uses (16…256). */
export function appIconIco(app: IconSource | undefined, webRoot: string): MadeIcon {
  const frames = ICO_SIZES.map((s) => ({ size: s, png: appIconPng(app, webRoot, s).body }));
  const first = appIconPng(app, webRoot, 256);
  return { body: encodeIco(frames), etag: first.etag.replace(/-256-r"$/, '-ico"'), kind: first.kind };
}

/**
 * GET/HEAD /app-icon.png?s=<px>&shape=rounded|square|maskable and /app-icon.ico. `app` is the
 * signed-in owner's (or member's) companion; undefined (signed out, the demo) gives Sara's own icon.
 * No-cache + ETag: a client asks again cheaply and gets 304 until her look or name changes.
 */
export function serveAppIcon(req: IncomingMessage, res: ServerResponse, pathname: string, app: IconSource | undefined, webRoot: string): void {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const shapeQ = q.get('shape');
  const shape: IconShape = shapeQ === 'square' || shapeQ === 'maskable' ? shapeQ : 'rounded';
  const made = pathname.endsWith('.ico') ? appIconIco(app, webRoot) : appIconPng(app, webRoot, iconSize(q.get('s') ?? q.get('size')), shape);
  const head = { etag: made.etag, 'cache-control': app ? 'private, no-cache' : 'no-cache', vary: 'Cookie, Authorization', 'x-sara-icon': made.kind, ...SECURITY_HEADERS };
  if (req.headers['if-none-match'] === made.etag) {
    res.writeHead(304, head);
    return void res.end();
  }
  res.writeHead(200, { 'content-type': pathname.endsWith('.ico') ? 'image/x-icon' : 'image/png', 'content-length': made.body.length, ...head });
  res.end(req.method === 'HEAD' ? undefined : made.body);
}

/** The installed web app's icons (the manifest), her own while signed in. */
export const MANIFEST_ICONS = [
  { src: '/app-icon.png?s=192', sizes: '192x192', type: 'image/png' },
  { src: '/app-icon.png?s=512', sizes: '512x512', type: 'image/png' },
  { src: '/app-icon.png?s=512&shape=maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];
