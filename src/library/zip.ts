// Reads zip archives (the container behind .docx, .xlsx, .pptx and .epub files). It reads the
// central directory at the end of the file, then unpacks single entries on demand. Only the
// two methods real documents use are supported: "stored" (no compression) and "deflate".
// Zip bombs are guarded against with caps on entry count, per-entry size and total size.

import { inflateRawSync } from 'node:zlib';
import { ReadError } from './read.ts';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Phase 96: the central directory's "version made by" and external attributes (Unix mode in the high 16 bits). */
  madeBy?: number;
  attrs?: number;
}

export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  /** Phase 65: refuse an entry that unpacks to more than this many times its packed size (zip bombs). */
  maxRatio?: number;
}

const DAMAGED = 'This file looks damaged or incomplete, so she can\'t open it.';

export class Zip {
  readonly entries = new Map<string, ZipEntry>();
  /** Phase 96: every central-directory record in order, folders and duplicate names included. */
  readonly all: ZipEntry[] = [];
  readonly #lower = new Map<string, ZipEntry>();
  readonly #buf: Buffer;
  readonly #maxEntryBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxRatio: number;
  #used = 0;

  constructor(buf: Buffer, limits: ZipLimits = {}) {
    this.#buf = buf;
    this.#maxEntryBytes = limits.maxEntryBytes ?? 100 * 1024 * 1024;
    this.#maxTotalBytes = limits.maxTotalBytes ?? 300 * 1024 * 1024;
    this.#maxRatio = limits.maxRatio ?? 0;
    const maxEntries = limits.maxEntries ?? 20_000;
    const eocd = findEndRecord(buf);
    if (eocd < 0) throw new ReadError(DAMAGED);
    let count = buf.readUInt16LE(eocd + 10);
    let dirSize = buf.readUInt32LE(eocd + 12);
    let dirOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      // ZIP64: a locator just before the normal end record points at the bigger one.
      const loc = eocd - 20;
      if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(loc + 8));
        if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
          count = Number(buf.readBigUInt64LE(z64 + 32));
          dirSize = Number(buf.readBigUInt64LE(z64 + 40));
          dirOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
      }
    }
    if (count > maxEntries) throw new ReadError('This file holds far too many pieces to read safely.');
    if (dirOffset + dirSize > buf.length) {
      // Some writers get the offset wrong when the zip is glued onto something else; try to
      // find the directory by measuring back from the end record.
      dirOffset = eocd - dirSize;
      if (dirOffset < 0) throw new ReadError(DAMAGED);
    }
    let p = dirOffset;
    for (let k = 0; k < count; k++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ReadError(DAMAGED);
      const madeBy = buf.readUInt16LE(p + 4);
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      let compressedSize = buf.readUInt32LE(p + 20);
      let size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const attrs = buf.readUInt32LE(p + 38);
      let localOffset = buf.readUInt32LE(p + 42);
      const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x800 ? nameBytes.toString('utf8') : decodeCp437(nameBytes)).replace(/\\/g, '/').replace(/^\/+/, '');
      // ZIP64 extra field: the real sizes and offset, in that order, only for the maxed-out ones.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd && e + 4 <= buf.length) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const read64 = (): number => {
            const v = q + 8 <= e + 4 + len && q + 8 <= buf.length ? Number(buf.readBigUInt64LE(q)) : -1;
            q += 8;
            return v;
          };
          if (size === 0xffffffff) size = read64();
          if (compressedSize === 0xffffffff) compressedSize = read64();
          if (localOffset === 0xffffffff) localOffset = read64();
        }
        e += 4 + len;
      }
      const entry: ZipEntry = { name, method, flags, compressedSize, size, localOffset, madeBy, attrs };
      this.all.push(entry);
      if (!name.endsWith('/')) {
        this.entries.set(name, entry);
        this.#lower.set(name.toLowerCase(), entry);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get(name: string): ZipEntry | undefined {
    const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
    return this.entries.get(clean) ?? this.#lower.get(clean.toLowerCase());
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Unpacks one entry. Throws ReadError for encrypted, unsupported or oversized entries. */
  read(name: string): Buffer {
    const entry = this.get(name);
    if (!entry) throw new ReadError(DAMAGED);
    if (entry.flags & 0x1) throw new ReadError('This file is locked with a password, so she can\'t read it.');
    const buf = this.#buf;
    const lo = entry.localOffset;
    if (lo < 0 || lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new ReadError(DAMAGED);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length || entry.compressedSize < 0) throw new ReadError(DAMAGED);
    const raw = buf.subarray(start, end);
    const room = Math.min(this.#maxEntryBytes, this.#maxTotalBytes - this.#used);
    if (entry.size > room) throw new ReadError(tooBig());
    // Phase 65: a small entry that claims (or turns out) to unpack hugely is a bomb, whatever its size.
    const ratioOk = (n: number) => !this.#maxRatio || n <= 64 * 1024 || n <= Math.max(1, entry.compressedSize) * this.#maxRatio;
    if (!ratioOk(entry.size)) throw new ReadError(tooBig());
    let out: Buffer;
    if (entry.method === 0) out = Buffer.from(raw);
    else if (entry.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, this.#maxRatio ? Math.min(room, Math.max(64 * 1024, entry.compressedSize * this.#maxRatio)) : room) });
      } catch (err) {
        if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ReadError(tooBig());
        throw new ReadError(DAMAGED);
      }
    } else if (entry.method === 99) {
      throw new ReadError('This file is locked with a password, so she can\'t read it.');
    } else {
      throw new ReadError('This file uses a kind of compression she doesn\'t understand. Try saving it again from the program that made it.');
    }
    if (!ratioOk(out.length)) throw new ReadError(tooBig());
    this.#used += out.length;
    return out;
  }

  /** Unpacks an entry as text (UTF-8, or UTF-16 when it starts with a byte order mark). */
  text(name: string): string | undefined {
    if (!this.has(name)) return undefined;
    return decodeXmlBytes(this.read(name));
  }
}

function tooBig(): string {
  return 'This file unpacks to something far too big to read safely.';
}

function findEndRecord(buf: Buffer): number {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

// The original IBM PC code page, used by old zip tools for names. Only the top half differs from ASCII.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function decodeCp437(b: Buffer): string {
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  return s;
}

/** XML files are UTF-8 unless they start with a UTF-16 byte order mark. */
export function decodeXmlBytes(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const even = b.subarray(2, 2 + ((b.length - 2) & ~1));
    return Buffer.from(even).swap16().toString('utf16le');
  }
  let s = b.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/** Opens a zip, turning any low-level failure into a friendly ReadError. */
export function openZip(buf: Buffer, limits?: ZipLimits): Zip {
  try {
    return new Zip(buf, limits);
  } catch (err) {
    if (err instanceof ReadError) throw err;
    throw new ReadError(DAMAGED);
  }
}
