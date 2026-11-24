// Model tests: pictures drawn in code, so what they show is known exactly (colours, shapes, bars,
// tables, small text, a settings screen). Nothing is read from disk but her portrait.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rgbPng } from './model-recheck.ts';
import type { ImageData } from './providers/types.ts';

type RGB = readonly [number, number, number];
export const WHITE: RGB = [255, 255, 255];
export const BLACK: RGB = [0, 0, 0];
const RED: RGB = [220, 30, 30];
const BLUE: RGB = [30, 60, 220];
const GREEN: RGB = [30, 160, 60];
const GREY: RGB = [170, 170, 170];
const LIGHT: RGB = [235, 235, 235];

const png = (b: Buffer): ImageData => ({ mime: 'image/png', data: b.toString('base64') });

let portrait: string | undefined;
/** Her happy portrait (shipped with the app): a smiling woman in a knitted sweater, plants, a small keyboard on the right. */
export const portraitPicture = (): ImageData => ({ mime: 'image/jpeg', data: (portrait ??= readFileSync(join(import.meta.dirname, '..', 'web', 'sara', 'portrait-happy.jpg')).toString('base64')) });
export const redPicture = () => png(rgbPng(96, 96, () => RED));
/** Left half blue, right half yellow. */
export const splitPicture = () => png(rgbPng(160, 96, (x) => (x < 80 ? BLUE : [240, 210, 30])));

/** The first glyphs (large block digits and letters of the easy tier), kept as they were drawn. */
const GLYPHS: Record<string, string[]> = {
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
};

/** A plain 5×7 font: five columns per glyph, bit 0 the top row. */
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0],
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
  '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  '.': [0x00, 0x60, 0x60, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
};
/** Is cell (col, row) of a glyph on? The first glyphs win for their characters. */
function glyphOn(ch: string, col: number, row: number, big: boolean): boolean {
  if (big && GLYPHS[ch]) return GLYPHS[ch][row]?.[col] === '#';
  const g = FONT[ch];
  return Boolean(g && ((g[col] ?? 0) >> row) & 1);
}

/** A small drawing surface that becomes a PNG. */
export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly #px: Uint8Array;
  constructor(w: number, h: number, bg: RGB = WHITE) {
    this.w = w;
    this.h = h;
    this.#px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  dot(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (Math.floor(y) * this.w + Math.floor(x)) * 3;
    this.#px[i] = c[0];
    this.#px[i + 1] = c[1];
    this.#px[i + 2] = c[2];
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.dot(i, j, c);
  }
  /** An outline `t` pixels thick. */
  frame(x: number, y: number, w: number, h: number, t: number, c: RGB): void {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }
  circle(cx: number, cy: number, r: number, c: RGB): void {
    for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) this.dot(i, j, c);
  }
  /** Text in the 5×7 font, `cell` pixels a dot; returns the width drawn. */
  text(s: string, x: number, y: number, cell: number, c: RGB = BLACK, big = false): number {
    [...s].forEach((ch, k) => {
      for (let col = 0; col < 5; col++) for (let row = 0; row < 7; row++) if (glyphOn(ch, col, row, big)) this.rect(x + (k * 6 + col) * cell, y + row * cell, cell, cell, c);
    });
    return s.length * 6 * cell - cell;
  }
  png(): ImageData {
    return png(rgbPng(this.w, this.h, (x, y) => {
      const i = (y * this.w + x) * 3;
      return [this.#px[i], this.#px[i + 1], this.#px[i + 2]];
    }));
  }
}
/** Width of a text in the 5×7 font. */
const textWidth = (s: string, cell: number): number => s.length * 6 * cell - cell;

/** Black block letters on white (5×7 cells, 10 pixels each), as the easy tier draws them. */
export function textPicture(text: string): ImageData {
  const cell = 10;
  const margin = 20;
  const c = new Canvas(textWidth(text, cell) + margin * 2, 7 * cell + margin * 2);
  c.text(text, margin, margin, cell, BLACK, true);
  return c.png();
}

// ---------- the hard tier's pictures ----------

/** Shapes on a 6×4 grid: 4 red circles, 3 red squares, 3 blue circles, 1 blue square, 2 green circles. */
export const SHAPES: [number, number, 'circle' | 'square', 'red' | 'blue' | 'green'][] = [
  [0, 0, 'circle', 'red'], [1, 0, 'square', 'red'], [2, 0, 'circle', 'blue'], [4, 0, 'circle', 'red'], [5, 0, 'circle', 'green'],
  [0, 1, 'circle', 'blue'], [2, 1, 'square', 'red'], [3, 1, 'circle', 'red'],
  [1, 2, 'circle', 'green'], [3, 2, 'circle', 'blue'], [5, 2, 'square', 'red'],
  [2, 3, 'circle', 'red'], [4, 3, 'square', 'blue'],
];
export function shapesPicture(): ImageData {
  const c = new Canvas(360, 240);
  const colours = { red: RED, blue: BLUE, green: GREEN };
  for (const [col, row, shape, name] of SHAPES) {
    const colour = colours[name];
    const cx = col * 60 + 30;
    const cy = row * 60 + 30;
    if (shape === 'circle') c.circle(cx, cy, 20, colour);
    else c.rect(cx - 19, cy - 19, 38, 38, colour);
  }
  return c.png();
}

/** A bar chart: five labelled bars; THU is the tallest, FRI close behind. */
export const BARS: [string, number][] = [
  ['MON', 80],
  ['TUE', 120],
  ['WED', 95],
  ['THU', 150],
  ['FRI', 135],
];
export function barsPicture(): ImageData {
  const c = new Canvas(420, 240);
  const base = 190;
  c.rect(30, base, 370, 3, BLACK);
  c.rect(30, 20, 3, base - 17, BLACK);
  BARS.forEach(([label, h], i) => {
    const x = 50 + i * 72;
    c.rect(x, base - h, 48, h, BLUE);
    c.text(label, x + 24 - textWidth(label, 3) / 2, base + 12, 3);
  });
  return c.png();
}

/** Four quarters of nine blue circles; one circle in the bottom left quarter is a square. */
export function oddPicture(): ImageData {
  const c = new Canvas(400, 400);
  c.rect(198, 0, 4, 400, GREY);
  c.rect(0, 198, 400, 4, GREY);
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * 200;
    const oy = Math.floor(q / 2) * 200;
    for (let i = 0; i < 9; i++) {
      const cx = ox + 40 + (i % 3) * 60;
      const cy = oy + 40 + Math.floor(i / 3) * 60;
      if (q === 2 && i === 5) c.rect(cx - 17, cy - 17, 34, 34, BLUE);
      else c.circle(cx, cy, 18, BLUE);
    }
  }
  return c.png();
}

/** A table with a header row: ITEM, QTY, PRICE. */
export const TABLE = [
  ['ITEM', 'QTY', 'PRICE'],
  ['APPLE', '4', '1.20'],
  ['PEAR', '7', '2.40'],
  ['PLUM', '2', '0.90'],
];
export function tablePicture(): ImageData {
  const cell = 4;
  const colW = [160, 100, 140];
  const rowH = 50;
  const c = new Canvas(colW.reduce((a, b) => a + b, 0) + 40, rowH * TABLE.length + 40);
  c.rect(20, 20, c.w - 40, rowH, LIGHT);
  TABLE.forEach((row, r) => {
    let x = 20;
    row.forEach((v, k) => {
      c.text(v, x + 12, 20 + r * rowH + (rowH - 7 * cell) / 2, cell);
      x += colW[k];
    });
  });
  // Grid lines.
  let x = 20;
  for (const w of [0, ...colW]) c.rect((x += w), 20, 2, rowH * TABLE.length + 2, BLACK);
  for (let r = 0; r <= TABLE.length; r++) c.rect(20, 20 + r * rowH, c.w - 40 + 2, 2, BLACK);
  return c.png();
}

/** Three lines of small text. */
export const NOTE_LINES = ['MEET AT 4:15', 'ROOM B12', 'BRING BADGE 7'];
export function notePicture(): ImageData {
  const cell = 3;
  const c = new Canvas(textWidth(NOTE_LINES[0], cell) + 120, NOTE_LINES.length * 36 + 30);
  NOTE_LINES.forEach((l, i) => c.text(l, 20, 20 + i * 36, cell));
  return c.png();
}

/** A settings screen: four switches, two on (green, knob right) and two off (grey, knob left). */
export const SWITCHES: [string, boolean][] = [
  ['WIFI', true],
  ['BLUETOOTH', false],
  ['LOCATION', true],
  ['ALARMS', false],
];
export function switchesPicture(): ImageData {
  const c = new Canvas(420, SWITCHES.length * 64 + 40, [248, 248, 248]);
  SWITCHES.forEach(([label, on], i) => {
    const y = 20 + i * 64;
    c.rect(10, y + 54, 400, 2, LIGHT);
    c.text(label, 24, y + 16, 4);
    const x = 320;
    // The pill: two round ends and a body.
    const colour = on ? GREEN : GREY;
    c.circle(x + 15, y + 30, 15, colour);
    c.circle(x + 55, y + 30, 15, colour);
    c.rect(x + 15, y + 15, 40, 31, colour);
    c.circle(on ? x + 55 : x + 15, y + 30, 12, WHITE);
  });
  return c.png();
}
