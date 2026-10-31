// Phase 104 (MI1, docs/design/MOVE_IN.md §5, §7.1): reads a .saramove bundle straight from its file.
// Only the central directory is read whole (it sits at the end); every entry is streamed through
// inflate with its own caps, so a bundle of several gigabytes never sits in memory. The checks run
// before anything is trusted: zip caps, clean paths, no links, a known format and version, and every
// entry's hash against hashes.txt.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { createInflateRaw } from 'node:zlib';

export const BUNDLE_FORMAT = 'saramove';
export const BUNDLE_VERSION = 1;

export interface BundleLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** An entry may not unpack to more than this many times its packed size (zip bombs). */
  maxRatio: number;
}
/** §5: total ≤ 20 GB (setting), each entry ≤ 4 GB, ratio ≤ 250 (the IMPORT_ZIP_LIMITS rule), ≤ 500 000 entries. */
export const BUNDLE_LIMITS: BundleLimits = { maxEntries: 500_000, maxEntryBytes: 4 * 1024 ** 3, maxTotalBytes: 20 * 1024 ** 3, maxRatio: 250 };

export class BundleError extends Error {}

export interface BundleEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  attrs: number;
  madeBy: number;
}

export interface Manifest {
  format: string;
  version: number;
  collector?: { version?: string; sha256?: string; python?: string; os?: string };
  createdAt?: string;
  timeZone?: string;
  source: { kind: 'hermes' | 'openclaw' | 'custom'; agentId: string; displayName?: string; detected?: { schemaVersion?: number | null; layout?: string[] } };
  roots?: { id: string; role: string; path: string }[];
  items: { path: string; kind: string; bytes?: number; mtime?: string; history?: string[]; of?: string; cats?: string[]; reader?: string; source?: string; format?: string; redacted?: number; tables?: number; rows?: number }[];
  skipped: { path: string; reason: string; bytes?: number; files?: number; why?: string }[];
  categories?: Record<string, { chosen: boolean; items: number }>;
  redactions?: { config?: number; text?: number };
  postgres?: { id: string; server: string }[];
}

/** A clean bundle path: POSIX, relative, no `..`, no drive letters, no control characters. */
export function cleanPath(name: string): boolean {
  if (!name || name.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((p) => p === '..' || p === '.');
}

const DAMAGED = 'This bundle looks damaged or incomplete. Make it again with the collector.';

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return got === len ? b : b.subarray(0, got);
}

export class Bundle {
  readonly path: string;
  readonly size: number;
  readonly entries = new Map<string, BundleEntry>();
  manifest!: Manifest;
  hashes = new Map<string, { sha: string; bytes: number }>();
  readonly limits: BundleLimits;

  private constructor(path: string, size: number, limits: BundleLimits) {
    this.path = path;
    this.size = size;
    this.limits = limits;
  }

  /** Opens a bundle: reads its central directory and checks the caps (nothing is unpacked yet). */
  static async open(path: string, limits: BundleLimits = BUNDLE_LIMITS): Promise<Bundle> {
    const fd = openSync(path, 'r');
    let b: Bundle;
    try {
      const size = fstatSync(fd).size;
      b = new Bundle(path, size, limits);
      b.#readDirectory(fd);
    } finally {
      closeSync(fd);
    }
    const mtext = await b.text('manifest.json', 64 * 1024 * 1024).catch((err: Error) => {
      throw err instanceof BundleError ? err : new BundleError("This isn't a move-in bundle (it has no manifest.json).");
    });
    let m: Manifest;
    try {
      m = JSON.parse(mtext) as Manifest;
    } catch {
      throw new BundleError("This bundle's manifest isn't valid JSON.");
    }
    if (m.format !== BUNDLE_FORMAT) throw new BundleError("This isn't a move-in bundle (.saramove).");
    if (typeof m.version !== 'number' || m.version > BUNDLE_VERSION) throw new BundleError('This bundle was made by a newer collector. Update Sara first, then import it.');
    if (!m.source || !['hermes', 'openclaw', 'custom'].includes(m.source.kind)) throw new BundleError("This bundle doesn't say which agent it came from.");
    m.items = Array.isArray(m.items) ? m.items : [];
    m.skipped = Array.isArray(m.skipped) ? m.skipped : [];
    b.manifest = m;
    for (const line of (await b.text('hashes.txt', 256 * 1024 * 1024)).split('\n')) {
      const x = /^([0-9a-f]{64}) {2}(\d+) {2}(.+)$/.exec(line.trim());
      if (x) b.hashes.set(x[3], { sha: x[1], bytes: Number(x[2]) });
    }
    if (!b.hashes.size) throw new BundleError('This bundle has no list of hashes, so it can\'t be checked.');
    for (const name of b.entries.keys()) if (name !== 'hashes.txt' && !b.hashes.has(name)) throw new BundleError(`This bundle holds a file that isn't in its list of hashes (${name.slice(0, 80)}).`);
    return b;
  }

  #readDirectory(fd: number): void {
    const tailLen = Math.min(this.size, 66 * 1024);
    const tail = readAt(fd, this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new BundleError(DAMAGED);
    let count = tail.readUInt16LE(eocd + 10);
    let dirSize = tail.readUInt32LE(eocd + 12);
    let dirOffset = tail.readUInt32LE(eocd + 16);
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(tail.readBigUInt64LE(loc + 8));
      const rec = readAt(fd, z64, 56);
      if (rec.length === 56 && rec.readUInt32LE(0) === 0x06064b50) {
        count = Number(rec.readBigUInt64LE(32));
        dirSize = Number(rec.readBigUInt64LE(40));
        dirOffset = Number(rec.readBigUInt64LE(48));
      }
    }
    if (count > this.limits.maxEntries) throw new BundleError('This bundle holds far too many files to read safely.');
    if (dirOffset + dirSize > this.size || dirSize > 512 * 1024 * 1024) throw new BundleError(DAMAGED);
    const dir = readAt(fd, dirOffset, dirSize);
    let p = 0;
    let total = 0;
    for (let k = 0; k < count; k++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new BundleError(DAMAGED);
      const madeBy = dir.readUInt16LE(p + 4);
      const method = dir.readUInt16LE(p + 10);
      let compressedSize = dir.readUInt32LE(p + 20);
      let size = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const attrs = dir.readUInt32LE(p + 38);
      let localOffset = dir.readUInt32LE(p + 42);
      const name = dir.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = dir.readUInt16LE(e);
        const len = dir.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const r64 = () => {
            const v = q + 8 <= e + 4 + len ? Number(dir.readBigUInt64LE(q)) : -1;
            q += 8;
            return v;
          };
          if (size === 0xffffffff) size = r64();
          if (compressedSize === 0xffffffff) compressedSize = r64();
          if (localOffset === 0xffffffff) localOffset = r64();
        }
        e += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (!cleanPath(name)) throw new BundleError(`This bundle holds a file with an unsafe name (${name.slice(0, 80)}).`);
      // Unix links (mode S_IFLNK in the high bits of the external attributes) are never accepted.
      if (madeBy >> 8 === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) throw new BundleError('This bundle holds a link, which a move-in never carries.');
      if (method !== 0 && method !== 8) throw new BundleError('This bundle uses a kind of compression Sara does not read.');
      if (size < 0 || compressedSize < 0 || localOffset < 0) throw new BundleError(DAMAGED);
      if (size > this.limits.maxEntryBytes) throw new BundleError('One file in this bundle is bigger than 4 GB.');
      if (method === 8 && size > 1024 * 1024 && compressedSize > 0 && size / compressedSize > this.limits.maxRatio) throw new BundleError('One file in this bundle unpacks to far more than its size (a zip bomb?), so it is refused.');
      total += size;
      if (total > this.limits.maxTotalBytes) throw new BundleError('This bundle unpacks to more than the move-in limit (20 GB).');
      if (this.entries.has(name)) throw new BundleError('This bundle holds the same file twice.');
      this.entries.set(name, { name, method, compressedSize, size, localOffset, attrs, madeBy });
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Entry names under a prefix (e.g. "files/home/skills/"). */
  list(prefix: string): string[] {
    return [...this.entries.keys()].filter((n) => n.startsWith(prefix)).sort();
  }

  #dataStart(e: BundleEntry): number {
    const fd = openSync(this.path, 'r');
    try {
      const h = readAt(fd, e.localOffset, 30);
      if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new BundleError(DAMAGED);
      return e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    } finally {
      closeSync(fd);
    }
  }

  /** Streams one entry's bytes (inflated), never more than its declared size. */
  async *stream(name: string): AsyncGenerator<Buffer> {
    const e = this.entries.get(name);
    if (!e) throw new BundleError(`The bundle has no ${name}.`);
    if (!e.compressedSize && !e.size) return;
    const start = this.#dataStart(e);
    const raw = createReadStream(this.path, { start, end: start + e.compressedSize - 1, highWaterMark: 1024 * 1024 });
    const src = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
    let out = 0;
    try {
      for await (const chunk of src as AsyncIterable<Buffer>) {
        out += chunk.length;
        if (out > e.size) throw new BundleError(`${name} unpacks to more than it says.`);
        yield chunk;
      }
    } finally {
      raw.destroy();
    }
  }

  /** A whole entry as text (only for small ones: refused over `max`). */
  async text(name: string, max = 16 * 1024 * 1024): Promise<string> {
    const e = this.entries.get(name);
    if (!e) throw new BundleError(`The bundle has no ${name}.`);
    if (e.size > max) throw new BundleError(`${name} is too big to read in one go.`);
    const parts: Buffer[] = [];
    for await (const c of this.stream(name)) parts.push(c);
    return Buffer.concat(parts).toString('utf8');
  }

  /** A whole entry as bytes (small ones only). */
  async bytes(name: string, max = 16 * 1024 * 1024): Promise<Buffer> {
    const e = this.entries.get(name);
    if (!e) throw new BundleError(`The bundle has no ${name}.`);
    if (e.size > max) throw new BundleError(`${name} is too big to read in one go.`);
    const parts: Buffer[] = [];
    for await (const c of this.stream(name)) parts.push(c);
    return Buffer.concat(parts);
  }

  /** Lines of a text entry, streamed (JSONL row parts, session transcripts). Lines over 64 MB are cut. */
  async *lines(name: string): AsyncGenerator<string> {
    let rest = '';
    for await (const c of this.stream(name)) {
      rest += c.toString('utf8');
      let i: number;
      while ((i = rest.indexOf('\n')) >= 0) {
        yield rest.slice(0, i);
        rest = rest.slice(i + 1);
      }
      if (rest.length > 64 * 1024 * 1024) rest = rest.slice(0, 64 * 1024 * 1024);
    }
    if (rest) yield rest;
  }

  /** Re-hashes every entry against hashes.txt (streamed). Calls `progress` with bytes done. */
  async verify(progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const total = [...this.entries.values()].reduce((n, e) => n + e.size, 0);
    let done = 0;
    for (const [name, want] of this.hashes) {
      if (signal?.aborted) throw new BundleError('Stopped.');
      if (!this.entries.has(name)) throw new BundleError(`The bundle is missing ${name.slice(0, 80)}.`);
      const h = createHash('sha256');
      let n = 0;
      for await (const c of this.stream(name)) {
        h.update(c);
        n += c.length;
      }
      if (n !== want.bytes || h.digest('hex') !== want.sha) throw new BundleError(`A file in the bundle doesn't match its hash (${name.slice(0, 80)}). Copy the bundle again.`);
      done += n;
      progress?.(done, total);
    }
  }

  /** The bundle file's own SHA-256 (what a re-run is matched by). */
  static async fileSha(path: string): Promise<string> {
    const h = createHash('sha256');
    for await (const c of createReadStream(path, { highWaterMark: 1024 * 1024 })) h.update(c as Buffer);
    return h.digest('hex');
  }
}
