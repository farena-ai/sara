// W5.3 (docs/design/W5BACKUP.md): the recovery key and sealed backup copies (.sara files).
// The key is 16 random bytes shown as 18 words (16 + 2 checksum bytes, one word per byte from
// WORDS), so it can be printed, read out and typed back. A sealed copy is
//   SARACRY1 | key fingerprint (8) | salt (16) | IV (12) | AES-256-GCM body | tag (16)
// with the 44-byte header as additional data. The data key is HKDF-SHA256(recovery key, salt).
// The fingerprint tells a wrong key apart from a changed file; any changed byte fails the tag.
// Files are sealed and opened as streams; an opened file is only kept when the tag checked out.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { en } from './i18n.ts';

export const CARRY_MAGIC = Buffer.from('SARACRY1');
export const CARRY_EXT = '.sara';
const HEADER = 8 + 8 + 16 + 12;
const TAG = 16;
export const QR_PREFIX = 'sara-recovery:1:';

/** 256 short everyday words, one per byte value (index = byte). Never reorder: printed sheets depend on it. */
export const WORDS: readonly string[] = [
  'acorn', 'actor', 'adult', 'agent', 'alarm', 'album', 'alley', 'amber', 'angle', 'ankle', 'apple', 'apron',
  'arena', 'arrow', 'aspen', 'atlas', 'attic', 'autumn', 'avocado', 'bacon', 'badge', 'bagel', 'baker',
  'bamboo', 'banana', 'banjo', 'barn', 'basil', 'basket', 'beach', 'beard', 'beaver', 'bell', 'bench',
  'berry', 'bike', 'bingo', 'birch', 'bison', 'blanket', 'bloom', 'blue', 'board', 'boat', 'bone', 'bonus',
  'book', 'boot', 'bottle', 'bread', 'brick', 'bridge', 'broom', 'brush', 'bubble', 'bucket', 'buffalo',
  'bunny', 'butter', 'cabin', 'cactus', 'cake', 'camel', 'candle', 'canoe', 'canyon', 'carpet', 'carrot',
  'castle', 'cedar', 'cello', 'chair', 'chalk', 'cheese', 'cherry', 'chess', 'chicken', 'cider', 'cinema',
  'circle', 'city', 'clock', 'cloud', 'clover', 'coast', 'cobalt', 'cocoa', 'coffee', 'comet', 'cookie',
  'copper', 'coral', 'cotton', 'cougar', 'cowboy', 'crayon', 'daisy', 'dance', 'delta', 'denim', 'desert',
  'diamond', 'dinner', 'dolphin', 'donkey', 'door', 'dragon', 'dream', 'drum', 'duck', 'dune', 'eagle',
  'earth', 'easel', 'echo', 'elbow', 'falcon', 'farm', 'feather', 'fence', 'fern', 'ferry', 'fiddle',
  'field', 'fig', 'finch', 'flame', 'flute', 'forest', 'fossil', 'fox', 'frog', 'garden', 'garlic', 'gecko',
  'giant', 'ginger', 'glove', 'goat', 'gold', 'grape', 'gravel', 'guitar', 'hammer', 'harbor', 'hazel',
  'helmet', 'heron', 'hill', 'honey', 'horse', 'hotel', 'island', 'ivory', 'jacket', 'jaguar', 'jelly',
  'jungle', 'kayak', 'kettle', 'kitten', 'koala', 'ladder', 'lake', 'lamp', 'lantern', 'lemon', 'lily',
  'lime', 'lion', 'lizard', 'lobster', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon',
  'mirror', 'mitten', 'monkey', 'moon', 'moose', 'muffin', 'napkin', 'needle', 'nest', 'noodle', 'north',
  'oak', 'ocean', 'olive', 'onion', 'orange', 'orbit', 'otter', 'owl', 'paddle', 'palace', 'panda', 'paper',
  'parrot', 'peach', 'peanut', 'pebble', 'pencil', 'pepper', 'piano', 'pillow', 'pine', 'pirate', 'pizza',
  'planet', 'plum', 'pocket', 'pony', 'potato', 'pumpkin', 'puzzle', 'quartz', 'quilt', 'rabbit', 'radio',
  'rain', 'raven', 'ribbon', 'river', 'robin', 'rocket', 'rose', 'ruby', 'saddle', 'salmon', 'sand', 'scarf',
  'school', 'shell', 'silver', 'sketch', 'sled', 'snail', 'socks', 'spoon', 'squid', 'star', 'stone',
  'summer', 'sunset', 'swan', 'table', 'tiger', 'toast', 'tomato', 'torch', 'tower',
];

export type CarryErrorCode = 'count' | 'word' | 'checksum' | 'not' | 'key' | 'changed';
export class CarryError extends Error {
  readonly code: CarryErrorCode;
  readonly params?: Record<string, unknown>;
  constructor(code: CarryErrorCode, message: string, params?: Record<string, unknown>) {
    super(params ? message.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? '')) : message);
    this.code = code;
    this.key = message;
    if (params) this.params = params;
  }
  /** The untranslated text (an i18n key) for the web. */
  readonly key: string;
}

const INDEX = new Map(WORDS.map((w, i) => [w, i]));
const check = (k: Buffer) => createHash('sha256').update(Buffer.concat([Buffer.from('sara-recovery-check'), k])).digest().subarray(0, 2);

export function makeRecoveryKey(): Buffer {
  return randomBytes(16);
}

/** The 18 words of a key (16 key bytes, then 2 checksum bytes). */
export function wordsOf(key: Buffer): string[] {
  if (key.length !== 16) throw new Error('A recovery key has 16 bytes.');
  return [...Buffer.concat([key, check(key)])].map((b) => WORDS[b]!);
}

/** What the sheet's QR code holds. */
export function qrTextOf(key: Buffer): string {
  return `${QR_PREFIX}${wordsOf(key).join('-')}`;
}

/** The key from typed words (any case, commas, dashes, numbering) or the QR text. */
export function keyFromWords(text: string): Buffer {
  const s = String(text ?? '').trim().toLowerCase().replace(new RegExp(`^${QR_PREFIX.replace(/[:]/g, '\\:')}`), '');
  const list = s.split(/[^a-z]+/).filter(Boolean);
  if (list.length !== 18) throw new CarryError('count', en('The sheet has 18 words; you typed {n}.'), { n: list.length });
  const bytes: number[] = [];
  for (const w of list) {
    const i = INDEX.get(w);
    if (i === undefined) throw new CarryError('word', en('"{word}" is not one of the sheet words. Check its spelling.'), { word: w.slice(0, 20) });
    bytes.push(i);
  }
  const all = Buffer.from(bytes);
  const key = all.subarray(0, 16);
  if (!check(key).equals(all.subarray(16))) throw new CarryError('checksum', en('One of the words is wrong. Check each word against the sheet.'));
  return Buffer.from(key);
}

/** The key's fingerprint (stored in every sealed copy; it tells which sheet opens it). */
export function fingerprint(key: Buffer): Buffer {
  return createHmac('sha256', key).update('sara-carry-id').digest().subarray(0, 8);
}
export const fingerprintHex = (key: Buffer) => fingerprint(key).toString('hex');

export function isCarry(head: Buffer): boolean {
  return head.subarray(0, CARRY_MAGIC.length).equals(CARRY_MAGIC);
}

function readHead(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const h = Buffer.alloc(HEADER);
    const n = readSync(fd, h, 0, HEADER, 0);
    return h.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** The fingerprint hex of a sealed copy, or throws CarryError 'not'. */
export function carryFingerprint(file: string): string {
  const h = readHead(file);
  if (!isCarry(h)) throw new CarryError('not', en('This file is not a sealed Sara backup (.sara).'));
  return h.subarray(8, 16).toString('hex');
}

const dataKey = (key: Buffer, salt: Buffer) => Buffer.from(hkdfSync('sha256', key, salt, 'sara-carry-v1', 32));

/** Seals a backup file into a .sara copy (written to `<out>.partial` first, then renamed). */
export async function sealCarryFile(file: string, out: string, key: Buffer): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([CARRY_MAGIC, fingerprint(key), salt, iv]);
  const c = createCipheriv('aes-256-gcm', dataKey(key, salt), iv);
  c.setAAD(header);
  const tmp = `${out}.partial`;
  const ws = createWriteStream(tmp, { mode: 0o600 });
  try {
    ws.write(header);
    await pipeline(createReadStream(file), c, ws, { end: false });
    await new Promise<void>((ok, fail) => ws.end(c.getAuthTag(), (err?: Error | null) => (err ? fail(err) : ok())));
    renameSync(tmp, out);
  } catch (err) {
    ws.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Opens a .sara copy into `out`. Wrong key → CarryError 'key' (nothing written); a changed, cut or
 * damaged file → 'changed' (the half-written output is deleted).
 */
export async function openCarryFile(file: string, out: string, key: Buffer): Promise<void> {
  const size = statSync(file).size;
  const header = readHead(file);
  if (!isCarry(header)) throw new CarryError('not', en('This file is not a sealed Sara backup (.sara).'));
  if (!header.subarray(8, 16).equals(fingerprint(key))) throw new CarryError('key', en("This recovery sheet doesn't fit this backup. It was sealed with another sheet."));
  const changed = () => new CarryError('changed', en("This backup was changed or damaged after it was made, so it can't be trusted. Try another copy."));
  if (size < HEADER + TAG) throw changed();
  const fd = openSync(file, 'r');
  const tag = Buffer.alloc(TAG);
  try {
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  const d = createDecipheriv('aes-256-gcm', dataKey(key, header.subarray(16, 32)), header.subarray(32, HEADER));
  d.setAAD(header);
  d.setAuthTag(tag);
  const tmp = `${out}.partial`;
  try {
    const body = size - TAG > HEADER ? createReadStream(file, { start: HEADER, end: size - TAG - 1 }) : (await import('node:stream')).Readable.from([]);
    await pipeline(body, d, createWriteStream(tmp, { mode: 0o600 }));
    renameSync(tmp, out);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (err instanceof CarryError) throw err;
    if (/auth|unable to authenticate/i.test(String((err as Error).message))) throw changed();
    throw err;
  }
}
