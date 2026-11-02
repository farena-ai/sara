// Phase 57: character cards (the format SillyTavern, Chub and others share): import Character Card
// V2 ('chara_card_v2') and V3 ('chara_card_v3') from JSON or from a PNG (a tEXt / zTXt / iTXt chunk
// named 'chara' or 'ccv3' holding base64 JSON; V1 flat cards too), and export a companion as a V3
// card (PNG with both chunks, or JSON). Own PNG chunk reader/writer; node:zlib for compression.
//
// Mapping: name, description → summary (+ background), personality → personality lines, scenario
// and the card's own instructions → background lines, first_mes / mes_example → how they talk,
// character_book entries → her own memory notes (capped), the PNG itself → her picture. Imported
// characters ALWAYS keep Sara's safety layer and AI disclosure: those are added by the turn engine
// whatever the character says, so a card's system_prompt can't remove them. Cards that describe
// minors sexually, or give a character an age under 18 together with romance or sexual content,
// are refused; a character stated to be under 18 is refused too (companions are adults). Explicit
// lines are left out unless Adult mode is on.
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { detectExplicit, minorSexualMatch } from './safety.ts';
import { validatePersona, type Persona } from './persona.ts';
import { decodeJpeg, shrinkRgb } from './jpeg.ts';

export const MAX_CARD_PNG = 20 * 1024 * 1024;
export const MAX_CARD_JSON = 2 * 1024 * 1024;
/** Lorebook entries kept as her notes, and the size of each. */
export const MAX_LORE = 50;
const MAX_LORE_CHARS = 1000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class CardError extends Error {}

// ---------- PNG chunks ----------

export interface PngChunk {
  type: string;
  data: Buffer;
}

export const isPng = (b: Buffer): boolean => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG);

/** Every chunk of a PNG, checked (signature, lengths, CRCs, IHDR first, IEND last). */
export function readPngChunks(buf: Buffer): PngChunk[] {
  if (!isPng(buf)) throw new CardError("This isn't a PNG picture.");
  if (buf.length > MAX_CARD_PNG) throw new CardError('The picture is too big (up to 20 MB).');
  const out: PngChunk[] = [];
  let at = 8;
  while (at < buf.length) {
    if (at + 12 > buf.length) throw new CardError('The PNG is cut off.');
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new CardError('The PNG is damaged (a chunk has a bad name).');
    if (len > buf.length - at - 12) throw new CardError('The PNG is damaged (a chunk runs past the end).');
    const data = buf.subarray(at + 8, at + 8 + len);
    const crc = buf.readUInt32BE(at + 8 + len);
    if (crc32(buf.subarray(at + 4, at + 8 + len)) !== crc) throw new CardError(`The PNG is damaged (bad checksum in ${type}).`);
    out.push({ type, data });
    at += 12 + len;
    if (type === 'IEND') break;
    if (out.length > 20_000) throw new CardError('The PNG has too many chunks.');
  }
  if (out[0]?.type !== 'IHDR' || out.at(-1)?.type !== 'IEND') throw new CardError('The PNG is damaged (missing header or end).');
  return out;
}

/** A PNG from chunks (CRCs computed). */
export function writePngChunks(chunks: PngChunk[]): Buffer {
  const parts: Buffer[] = [PNG_SIG];
  for (const c of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(c.data.length, 0);
    head.write(c.type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), c.data])), 0);
    parts.push(head, c.data, crc);
  }
  return Buffer.concat(parts);
}

const INFLATE_LIMIT = 4 * 1024 * 1024;
/** Inflated bytes allowed across a whole file (zip bombs: many small chunks that each inflate big). */
export const INFLATE_BUDGET = 8 * 1024 * 1024;
/** The only text chunks a card lives in; nothing else is ever decompressed. */
export const CARD_KEYS = new Set(['ccv3', 'chara']);
/** Marks the plain gradient picture the server makes when she has no portrait (re-import keeps her own picture). */
export const PLACEHOLDER_KEY = 'sara-placeholder';

/** A text chunk's keyword (read before anything is decompressed), or undefined. */
function chunkKey(c: PngChunk): { key: string; z: number } | undefined {
  if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') return undefined;
  const z = c.data.indexOf(0);
  if (z < 1 || z > 79) return undefined;
  return { key: c.data.subarray(0, z).toString('latin1'), z };
}

/** One text chunk's text; compressed text only within `budget.left` bytes (taken from it). */
function chunkText(c: PngChunk, z: number, budget: { left: number }): string | undefined {
  const inflate = (b: Buffer) => {
    const max = Math.min(INFLATE_LIMIT, budget.left);
    if (max <= 0) return undefined;
    const out = inflateSync(b, { maxOutputLength: max });
    budget.left -= out.length;
    return out;
  };
  try {
    if (c.type === 'tEXt') return c.data.subarray(z + 1).toString('latin1');
    if (c.type === 'zTXt') return c.data[z + 1] !== 0 ? undefined : inflate(c.data.subarray(z + 2))?.toString('latin1');
    // iTXt: keyword \0 flag method language \0 translated keyword \0 text (UTF-8)
    const flag = c.data[z + 1];
    const method = c.data[z + 2];
    const l1 = c.data.indexOf(0, z + 3);
    const l2 = l1 < 0 ? -1 : c.data.indexOf(0, l1 + 1);
    if (l2 < 0) return undefined;
    const body = c.data.subarray(l2 + 1);
    if (flag === 1 && method !== 0) return undefined;
    return (flag === 1 ? inflate(body) : body)?.toString('utf8');
  } catch {
    return undefined; // damaged, or over the limit: skipped
  }
}

/**
 * The text chunks of a PNG (tEXt, zTXt, iTXt), keyword → text. Compressed chunks are only
 * decompressed for the card keywords ('ccv3', 'chara'), within one budget for the whole file.
 */
export function pngTexts(chunks: PngChunk[]): Map<string, string> {
  const out = new Map<string, string>();
  const budget = { left: INFLATE_BUDGET };
  for (const c of chunks) {
    const k = chunkKey(c);
    if (!k) continue;
    if (c.type !== 'tEXt' && !CARD_KEYS.has(k.key) && !(c.type === 'iTXt' && c.data[k.z + 1] === 0)) continue;
    const text = chunkText(c, k.z, budget);
    if (text !== undefined) out.set(k.key, text);
  }
  return out;
}

/**
 * The card inside a PNG: the 'ccv3' chunk (preferred; reading stops there) or else the first
 * 'chara' one. Other keywords are never decompressed; one inflate budget covers the whole file.
 */
export function pngCardText(chunks: PngChunk[]): { text: string | undefined; placeholder: boolean } {
  const budget = { left: INFLATE_BUDGET };
  const placeholder = chunks.some((c) => c.type === 'tEXt' && chunkKey(c)?.key === PLACEHOLDER_KEY);
  let chara: string | undefined;
  for (const c of chunks) {
    const k = chunkKey(c);
    if (!k || !CARD_KEYS.has(k.key) || (k.key === 'chara' && chara !== undefined)) continue;
    const text = chunkText(c, k.z, budget);
    if (text === undefined) continue;
    if (k.key === 'ccv3') return { text, placeholder };
    chara = text;
  }
  return { text: chara, placeholder };
}

/** A text chunk: tEXt (Latin-1, how SillyTavern writes base64 cards) or iTXt (UTF-8, optionally compressed). */
export function textChunk(keyword: string, text: string, opts: { itxt?: boolean; compress?: boolean } = {}): PngChunk {
  if (!opts.itxt) return { type: 'tEXt', data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]) };
  const body = opts.compress ? deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return { type: 'iTXt', data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, opts.compress ? 1 : 0, 0, 0, 0]), body]) };
}

/** The same picture with these text chunks (earlier 'chara' / 'ccv3' chunks are replaced). */
export function withPngTexts(png: Buffer, texts: { keyword: string; text: string; itxt?: boolean; compress?: boolean }[]): Buffer {
  const keys = new Set(texts.map((t) => t.keyword));
  const chunks = readPngChunks(png).filter((c) => {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') return true;
    const z = c.data.indexOf(0);
    return !keys.has(c.data.subarray(0, Math.max(0, z)).toString('latin1'));
  });
  const end = chunks.pop()!; // IEND
  return writePngChunks([...chunks, ...texts.map((t) => textChunk(t.keyword, t.text, t)), end]);
}

/** A plain 512×512 picture (soft gradient) when a companion has no PNG picture. */
export function plainPicture(seed: string, size = 512): Buffer {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) % 360;
  const hsl = (hue: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const [c1, c2] = [hsl(h, 0.55, 0.72), hsl((h + 40) % 360, 0.5, 0.52)];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      for (let k = 0; k < 3; k++) raw[row + 1 + x * 3 + k] = Math.round(c1[k] + (c2[k] - c1[k]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return writePngChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: deflateSync(raw) }, { type: 'IEND', data: Buffer.alloc(0) }]);
}

/** The plain picture, marked as a placeholder (a card made from it doesn't replace a real picture on import). */
export function placeholderPicture(seed: string): Buffer {
  return withPngTexts(plainPicture(seed), [{ keyword: PLACEHOLDER_KEY, text: '1' }]);
}

/** An RGB picture as a PNG (truecolour, 8 bit). */
export function rgbToPng(img: { width: number; height: number; data: Uint8Array }): Buffer {
  const row = img.width * 3 + 1;
  const raw = Buffer.alloc(row * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * row] = 0;
    raw.set(img.data.subarray(y * img.width * 3, (y + 1) * img.width * 3), y * row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return writePngChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: deflateSync(raw) }, { type: 'IEND', data: Buffer.alloc(0) }]);
}

/** Her portrait (PNG as is, a baseline JPEG converted, at most 1024 px) for a card, or undefined. */
export function portraitPng(file: Buffer | undefined): Buffer | undefined {
  if (!file?.length) return undefined;
  if (isPng(file)) return file.length <= MAX_CARD_PNG ? file : undefined;
  const img = decodeJpeg(file);
  return img ? rgbToPng(shrinkRgb(img, 1024)) : undefined;
}

// ---------- the card itself ----------

export interface LoreEntry {
  keys: string[];
  content: string;
  name?: string;
}

/** The fields Sara reads from a card (all plain strings and lists, cleaned and capped). */
export interface CardData {
  spec: 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3';
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  character_book: { name: string; entries: LoreEntry[] } | null;
  /** A Sara character sheet carried in data.extensions.sara (cards exported from Sara). */
  saraPersona?: unknown;
  /** Every string in data.extensions.sara (sheet and anything else there), for the checks. */
  saraText?: string;
}

/** Every string (and number) inside a value, depth- and size-capped, for the safety checks. */
export function allStrings(v: unknown, max = 400_000): string[] {
  const out: string[] = [];
  let size = 0;
  const walk = (x: unknown, depth: number) => {
    if (size > max || depth > 12) return;
    if (typeof x === 'string') {
      out.push(x);
      size += x.length;
    } else if (typeof x === 'number') out.push(String(x));
    else if (Array.isArray(x)) for (const y of x.slice(0, 5000)) walk(y, depth + 1);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x).slice(0, 5000)) {
      out.push(k);
      walk(y, depth + 1);
    }
  };
  walk(v, 0);
  return out;
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON.parse that never builds prototype keys (each object is plain; those keys are dropped). */
export function safeJson(text: string): unknown {
  return JSON.parse(text, (k, v) => (BAD_KEYS.has(k) ? undefined : v));
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const list = (v: unknown, maxItems: number, maxLen: number): string[] => (Array.isArray(v) ? v.map((x) => s(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);

/** Reads a card object (V1 flat, V2, V3), picking known fields only. Throws a plain-words CardError. */
export function readCard(raw: unknown): CardData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CardError("This isn't a character card.");
  const spec = own(raw, 'spec');
  let data: unknown;
  let kind: CardData['spec'];
  if (spec === 'chara_card_v3' || spec === 'chara_card_v2') {
    data = own(raw, 'data');
    kind = spec;
    if (!data || typeof data !== 'object') throw new CardError('This character card has no data.');
  } else if (spec === undefined && typeof own(raw, 'name') === 'string' && (own(raw, 'description') !== undefined || own(raw, 'personality') !== undefined || own(raw, 'first_mes') !== undefined)) {
    data = raw;
    kind = 'chara_card_v1';
  } else throw new CardError(typeof spec === 'string' ? `Sara reads character cards V1, V2 and V3, not "${spec.slice(0, 40)}".` : "This isn't a character card.");
  const name = s(own(data, 'name'), 200).replace(/\s+/g, ' ');
  if (!name) throw new CardError('This character card has no name.');
  const book = own(data, 'character_book');
  let character_book: CardData['character_book'] = null;
  if (book && typeof book === 'object') {
    const entries = own(book, 'entries');
    const out: LoreEntry[] = [];
    if (Array.isArray(entries)) {
      for (const e of entries.slice(0, 2000)) {
        if (!e || typeof e !== 'object' || own(e, 'enabled') === false) continue;
        const content = s(own(e, 'content'), 20_000);
        if (!content) continue;
        out.push({ keys: list(own(e, 'keys'), 20, 80), content, ...(s(own(e, 'name') ?? own(e, 'comment'), 100) ? { name: s(own(e, 'name') ?? own(e, 'comment'), 100) } : {}) });
      }
    }
    character_book = { name: s(own(book, 'name'), 100), entries: out };
  }
  const ext = own(data, 'extensions');
  const sara = ext && typeof ext === 'object' ? own(ext, 'sara') : undefined;
  return {
    spec: kind,
    name,
    description: s(own(data, 'description'), 50_000),
    personality: s(own(data, 'personality'), 20_000),
    scenario: s(own(data, 'scenario'), 20_000),
    first_mes: s(own(data, 'first_mes'), 20_000),
    mes_example: s(own(data, 'mes_example'), 50_000),
    creator_notes: s(own(data, 'creator_notes'), 20_000),
    system_prompt: s(own(data, 'system_prompt'), 20_000),
    post_history_instructions: s(own(data, 'post_history_instructions'), 20_000),
    alternate_greetings: list(own(data, 'alternate_greetings'), 20, 5000),
    tags: list(own(data, 'tags'), 40, 60),
    creator: s(own(data, 'creator'), 200),
    character_version: s(own(data, 'character_version'), 60),
    character_book,
    ...(sara && typeof sara === 'object' && own(sara, 'persona') ? { saraPersona: own(sara, 'persona') } : {}),
    ...(sara && typeof sara === 'object' ? { saraText: allStrings(sara).join('\n') } : {}),
  };
}

/** A card file: a PNG with a 'ccv3' (preferred) or 'chara' chunk, or JSON. Returns the card and the PNG (its picture). */
export function parseCardFile(buf: Buffer): { card: CardData; png?: Buffer; placeholder?: boolean } {
  if (isPng(buf)) {
    if (buf.length > MAX_CARD_PNG) throw new CardError('The picture is too big (up to 20 MB).');
    const found = pngCardText(readPngChunks(buf));
    const b64 = found.text;
    if (!b64) throw new CardError("This picture doesn't have a character card inside.");
    let json: string;
    try {
      const clean = b64.trim();
      // Some writers put the JSON in as is; the standard is base64.
      json = clean.startsWith('{') ? clean : Buffer.from(clean, 'base64').toString('utf8');
    } catch {
      throw new CardError('The character card in this picture is damaged.');
    }
    if (json.length > MAX_CARD_JSON) throw new CardError('The character card is too big (up to 2 MB).');
    let raw: unknown;
    try {
      raw = safeJson(json);
    } catch {
      throw new CardError('The character card in this picture is damaged.');
    }
    return { card: readCard(raw), png: buf, ...(found.placeholder ? { placeholder: true } : {}) };
  }
  if (buf.length > MAX_CARD_JSON) throw new CardError('The character card is too big (up to 2 MB).');
  let raw: unknown;
  try {
    raw = safeJson(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new CardError("This file isn't a character card (not JSON or a PNG).");
  }
  return { card: readCard(raw) };
}

// ---------- the safety checks ----------

export const ROMANCE = /\b(romance|romantic|romantically|love interest|lover|lovers|girlfriend|boyfriend|waifu|husbando|dating|date night|(?:wants? to|going to|go on a|on a|asks? (?:you|{{user}}) (?:out )?on a) date|kiss(es|ing|ed)?|flirt\w*|seduc\w*|intimate|intimacy|in love|make out|making out|crush on|cuddl\w*|wife|husband|sweetheart|erp)\b/i;
export const MINOR_TAGS = /^(loli|lolicon|shota|shotacon|child|children|kid|kids|minor|underage|teen|teens|teenager|young teen|schoolgirl|schoolboy|preteen|cub)$/i;
const PAST = /\b(when|since|at|as|until|till|from|ago|once|was|were|by the age of|age of)\s*(?:she|he|they|i|{{char}})?\s*(?:was|were)?\s*(?:only|just)?\s*$/i;

/** Ages a card states (number + where), with a flag for past mentions ("when she was 12"). */
export function statedAges(text: string): { age: number; past: boolean }[] {
  const out: { age: number; past: boolean }[] = [];
  const res = [
    /\b(?:age|aged)\s*[:=-]?\s*(\d{1,3})\b/gi,
    /\b(\d{1,3})\s*(?:-|\s)?(?:years?|yrs?|year)\s*(?:-|\s)?old\b/gi,
    /\b(\d{1,3})\s*(?:yo|y\/o|y\.o\.)\b/gi,
    /\b(?:is|i'm|i am|she's|he's|they're)\s+(?:only\s+|just\s+|a\s+)?(\d{1,2})(?![\d:,/%]|\.\d)(?=\s*[.,;!)]|\s+(?:and|but|with|who|year))/gi,
  ];
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      const age = Number(m[1]);
      if (!Number.isFinite(age) || age > 200) continue;
      const before = text.slice(Math.max(0, m.index! - 40), m.index!);
      out.push({ age, past: PAST.test(before) || /\b(years? ago|ago)\b/i.test(text.slice(m.index!, m.index! + m[0].length + 12)) });
    }
  }
  return out;
}

export interface CardCheck {
  /** Why it can't be imported (plain words), or undefined. */
  refused?: string;
  /** The character's own age, when the card says it. */
  age: number | null;
  /** The card has explicit (adult) content. */
  nsfw: boolean;
}

/** The whole card as one text, for the checks. */
export function cardText(c: CardData): string {
  return [c.name, c.description, c.personality, c.scenario, c.first_mes, c.mes_example, c.system_prompt, c.post_history_instructions, c.creator_notes, ...c.alternate_greetings, ...c.tags, ...(c.character_book?.entries ?? []).flatMap((e) => [e.content, ...e.keys]), c.saraText ?? ''].join('\n');
}

export function checkCard(c: CardData): CardCheck {
  const text = cardText(c).replace(/{{char}}/gi, c.name);
  const nsfw = detectExplicit(text) || c.tags.some((t) => /^(nsfw|explicit|smut|lewd|18\+)$/i.test(t));
  const romance = ROMANCE.test(text) || nsfw;
  const no = (why: string): CardCheck => ({ refused: why, age: null, nsfw });
  if (minorSexualMatch(text)) return no('This card describes a minor in a sexual way. Sara never imports that.');
  const minorTag = c.tags.find((t) => MINOR_TAGS.test(t.trim()));
  if (minorTag && romance) return no(`This card is tagged “${minorTag}” and has romance or sexual content. Sara never imports that.`);
  const ages = statedAges(text);
  if (ages.some((a) => a.age < 18 && !a.past) && romance) return no('This card gives an age under 18 and has romance or sexual content. Sara never imports that.');
  // The character's own age: the first age that isn't a past mention, in the main fields.
  const main = statedAges([c.description, c.personality, c.scenario].join('\n').replace(/{{char}}/gi, c.name)).filter((a) => !a.past);
  const age = main[0]?.age ?? null;
  if (age !== null && age < 18) return no(`This character is ${age}. Companions in Sara are always adults (18 or older).`);
  if (minorTag) return no(`This card is tagged “${minorTag}”. Companions in Sara are always adults (18 or older).`);
  return { age: age !== null && age <= 120 ? age : null, nsfw };
}

// ---------- card → Sara character ----------

export interface CardImport {
  persona: Persona;
  lore: LoreEntry[];
  /** The card's own fields Sara keeps beside her character (for export and a later look). */
  extras: Record<string, unknown>;
  /** Plain-words notes for the preview ("Explicit parts left out: Adult mode is off"). */
  notes: string[];
  check: CardCheck;
  /** Her first message from the card (shown in the preview). */
  greeting: string;
}

/**
 * {{char}} → her name, {{user}} → the owner; other macros removed. With no owner name yet, a
 * vocative ", {{user}}" (or "{{user}}, " at the start) is dropped and the rest becomes "you"
 * ("Come in, {{user}}." → "Come in."), and "{{user}}'s" becomes "your".
 */
function macros(t: string, name: string, owner: string | undefined): string {
  let out = t.replace(/{{char}}|<BOT>|<CHAR>/gi, name);
  const U = '(?:\\{\\{user\\}\\}|<USER>)';
  if (owner) out = out.replace(new RegExp(U, 'gi'), owner);
  else {
    out = out
      // "…, {{user}}." / "…, {{user}}!" / "…, {{user}}?" → "…." (a name in passing, at the end of a clause)
      .replace(new RegExp(`,\\s*${U}(?=\\s*(?:[.!?…,;:)*"”]|$))`, 'gim'), '')
      // "{{user}}, come here" (at the start of a line or sentence) → "Come here"
      .replace(new RegExp(`(^|[.!?…]\\s+|[*"“]\\s*)${U},\\s*(\\p{L})`, 'gimu'), (_m, pre: string, c: string) => pre + c.toUpperCase())
      .replace(new RegExp(`${U}'s\\b`, 'gi'), 'your')
      .replace(new RegExp(`(^|[.!?…]\\s+|[*"“]\\s*)${U}`, 'gim'), (_m, pre: string) => `${pre}You`)
      .replace(new RegExp(U, 'gi'), 'you');
  }
  return out
    .replace(/{{[^}]{0,40}}}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Text cut into lines of at most `max` characters at sentence ends. */
function lines(text: string, max = 400): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    let cur = '';
    for (const sent of para.split(/(?<=[.!?…])\s+/)) {
      for (let piece = sent; piece; ) {
        const room = max - (cur ? cur.length + 1 : 0);
        if (piece.length <= room) {
          cur = cur ? `${cur} ${piece}` : piece;
          piece = '';
        } else if (cur) {
          out.push(cur);
          cur = '';
        } else {
          out.push(piece.slice(0, max));
          piece = piece.slice(max);
        }
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** A copy of a value with `f` applied to every string in it (keys and numbers kept). */
function keepAll(v: unknown, f: (t: string) => string, depth = 0): unknown {
  if (typeof v === 'string') return f(v);
  if (depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => keepAll(x, f, depth + 1)).filter((x) => x !== '');
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keepAll(x, f, depth + 1)]));
  return v;
}

export function cardToCharacter(c: CardData, opts: { adultOn: boolean; ownerName?: string }): CardImport {
  const check = checkCard(c);
  if (check.refused) throw new CardError(check.refused);
  const notes: string[] = [];
  const name = c.name.slice(0, 40).trim();
  if (c.name.length > 40) notes.push('The name was shortened to 40 characters.');
  const owner = opts.ownerName?.trim() || undefined;
  const m = (t: string) => macros(t, name, owner);
  let dropped = 0;
  const keep = (t: string): string => {
    if (opts.adultOn || !detectExplicit(t)) return t;
    const kept = t.split(/(?<=[.!?…])\s+|\n+/).filter((x) => {
      if (detectExplicit(x)) {
        dropped++;
        return false;
      }
      return true;
    });
    return kept.join(' ');
  };
  // A card made by Sara carries her whole character sheet: use it. Every string in it went through
  // checkCard above (minors); explicit lines are left out with Adult mode off, like the card's own
  // fields; a sheet that isn't a valid character is refused (never silently swapped for the fields).
  let persona: Persona | undefined;
  if (c.saraPersona) {
    // Phase 127: a sheet shared from another Sara says {{user}} where its owner's name was (macros fill it).
    const sheet = keepAll(c.saraPersona, (t) => keep(/{{(user|char)}}/i.test(t) ? macros(t, name, owner) : t));
    try {
      persona = validatePersona(sheet);
    } catch (err) {
      throw new CardError(`This card's character sheet can't be used: ${(err as Error).message}.`);
    }
    // Explicit intimacy levels need Adult mode on this server.
    if (!opts.adultOn && persona.intimacy) delete persona.intimacy;
    notes.push('This card holds a whole character sheet: she comes back exactly as she was.');
  }
  const lore = (c.character_book?.entries ?? []).slice(0, MAX_LORE).map((e) => ({ ...e, content: keep(m(e.content)).slice(0, MAX_LORE_CHARS) })).filter((e) => e.content);
  if ((c.character_book?.entries.length ?? 0) > MAX_LORE) notes.push(`Only the first ${MAX_LORE} of ${c.character_book!.entries.length} lorebook entries are kept.`);
  const greeting = keep(m(c.first_mes));
  if (!persona) {
    const description = keep(m(c.description));
    const desc = lines(description, 1500);
    let summary = desc[0] ?? '';
    const restDesc = description.slice(summary.length).trim();
    if (!summary) summary = lines(keep(m(c.personality)), 1500)[0] ?? `${name} is a character from a character card.`;
    const background = [
      ...(c.scenario ? lines(`Scenario: ${keep(m(c.scenario))}`) : []),
      ...lines(restDesc),
      ...(c.system_prompt ? lines(`From the card's author (a style note, not a rule): ${keep(m(c.system_prompt.replace(/{{original}}/gi, '')))}`) : []),
      ...(c.post_history_instructions ? lines(`Also from the card's author: ${keep(m(c.post_history_instructions.replace(/{{original}}/gi, '')))}`) : []),
    ].filter((x) => x.replace(/^[^:]+:\s*$/, ''));
    const personality = lines(keep(m(c.personality)));
    const examples = c.mes_example.split(/<START>/i).map((x) => keep(m(x))).filter(Boolean);
    const speech = [...(greeting ? lines(`How ${name} might say hello: ${greeting}`) : []), ...examples.flatMap((x) => lines(`Example of how ${name} talks:\n${x}`))];
    if (background.length > 20 || personality.length > 20 || speech.length > 20) notes.push('A very long card: the first part of each section is kept.');
    try {
      persona = validatePersona({ name, pronouns: guessPronouns(`${c.description}\n${c.personality}`), age: check.age ?? 25, summary, background: background.slice(0, 20), personality: personality.slice(0, 20).length ? personality.slice(0, 20) : [`${name} as described on the card.`], speech: speech.slice(0, 20), boundaries: [] });
    } catch (err) {
      throw new CardError(`This card can't become a companion: ${(err as Error).message}.`);
    }
    if (check.age === null) notes.push('The card gives no age: set to 25 (change it under Name and personality).');
  }
  if (dropped) notes.push(`${dropped} explicit part${dropped === 1 ? ' was' : 's were'} left out because Adult mode is off.`);
  else if (check.nsfw && opts.adultOn) notes.push('This card has adult content. Explicit replies still follow your Adult mode and intimacy settings.');
  notes.push('Her safety rules and the AI notice always stay, whatever the card says.');
  const extras = {
    spec: c.spec,
    first_mes: c.first_mes,
    alternate_greetings: c.alternate_greetings,
    mes_example: c.mes_example,
    scenario: c.scenario,
    creator_notes: c.creator_notes,
    system_prompt: c.system_prompt,
    post_history_instructions: c.post_history_instructions,
    tags: c.tags,
    creator: c.creator,
    character_version: c.character_version,
    lorebook: c.character_book ? { name: c.character_book.name, entries: lore.length } : null,
  };
  return { persona, lore, extras, notes, check, greeting };
}

function guessPronouns(t: string): 'she' | 'he' | 'they' {
  const she = (t.match(/\b(she|her|hers|herself)\b/gi) ?? []).length;
  const he = (t.match(/\b(he|him|his|himself)\b/gi) ?? []).length;
  return she === 0 && he === 0 ? 'she' : she >= he ? 'she' : 'he';
}

// ---------- Sara character → card ----------

/** A V3 card for a companion (the whole Sara sheet rides along in extensions.sara). */
export function personaToCard(p: Persona, extras: Record<string, unknown> = {}, now = new Date()): Record<string, unknown> {
  const ex = (k: string) => (typeof extras[k] === 'string' ? (extras[k] as string) : '');
  const arr = (k: string) => (Array.isArray(extras[k]) ? (extras[k] as unknown[]).filter((x) => typeof x === 'string') : []);
  const speech = p.speech.filter((x) => !/^How .* might say hello:/.test(x));
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: p.name,
      description: [p.summary, ...(p.appearance ? [`Looks: ${p.appearance}`] : []), ...p.background].join('\n\n'),
      personality: p.personality.join('\n'),
      scenario: ex('scenario'),
      first_mes: ex('first_mes') || `Hi, I'm ${p.name}.`,
      mes_example: ex('mes_example') || speech.map((x) => `<START>\n${x}`).join('\n'),
      creator_notes: ex('creator_notes') || `${p.name}, exported from Sara (a self-hosted AI companion). Age ${p.age}.`,
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: arr('alternate_greetings'),
      tags: arr('tags'),
      creator: ex('creator'),
      character_version: ex('character_version'),
      extensions: { sara: { format: 'sara-character', version: 1, persona: p } },
      group_only_greetings: [],
      creation_date: Math.floor(now.getTime() / 1000),
      modification_date: Math.floor(now.getTime() / 1000),
    },
  };
}

/** The V2 version of a V3 card (for the 'chara' chunk older apps read). */
export function v2Of(card: Record<string, unknown>): Record<string, unknown> {
  const d = { ...(card.data as Record<string, unknown>) };
  delete d.group_only_greetings;
  delete d.creation_date;
  delete d.modification_date;
  return { spec: 'chara_card_v2', spec_version: '2.0', data: d };
}

/** A card PNG: the picture with 'chara' (V2) and 'ccv3' (V3) chunks, base64 JSON in tEXt. */
export function cardPng(picture: Buffer, card: Record<string, unknown>): Buffer {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  return withPngTexts(picture, [
    { keyword: 'chara', text: b64(v2Of(card)) },
    { keyword: 'ccv3', text: b64(card) },
  ]);
}
