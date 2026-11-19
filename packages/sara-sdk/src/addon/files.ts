// W3.1: reading an add-on folder and writing its store bundle. The zip (stored, UTF-8 names, fixed
// dates) and the content hash are the same formats Sara uses (src/zip-write.ts, src/packages.ts
// hashFiles), so a bundle made here installs and verifies there byte for byte. Node only.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AddonFile {
  path: string;
  data: Buffer;
}

/** Never in the bundle: tests, build output, editor and VCS files. */
export const NOT_PACKED = new Set(['tests', 'test', 'out', 'node_modules', '.git', '.github', '.vscode', '.idea', 'jsconfig.json', 'tsconfig.json', '.gitignore', '.DS_Store', 'Thumbs.db']);
/** Sara's store limits (src/store/checks.ts STORE_PLUGIN_LIMITS). */
export const STORE_LIMITS = { maxZipBytes: 10 * 1024 * 1024, maxFiles: 500, maxTotalBytes: 10 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxDepth: 10 };

/** Every packed file of an add-on folder (sorted, forward slashes). Links are refused, as Sara refuses them. */
export function readAddonFiles(dir: string): AddonFile[] {
  const out: AddonFile[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > STORE_LIMITS.maxDepth) throw new Error(`${rel} is more than ${STORE_LIMITS.maxDepth} folders deep.`);
    for (const name of readdirSync(abs).sort()) {
      if (depth === 0 ? NOT_PACKED.has(name) : name === '.DS_Store' || name === 'Thumbs.db') continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${r} is a link; Sara refuses links in an add-on.`);
      if (st.isDirectory()) walk(p, r, depth + 1);
      else if (st.isFile()) out.push({ path: r, data: readFileSync(p) });
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** sha256 over the sorted paths and bytes: the fingerprint Sara pins at install (src/packages.ts). */
export function hashFiles(files: readonly AddonFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path, 'utf8');
    h.update('\0');
    h.update(String(f.data.length));
    h.update('\0');
    h.update(f.data);
  }
  return h.digest('hex');
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip with UTF-8 names and the 1980-01-01 date: the same bytes for the same files. */
export function zipStored(files: readonly AddonFile[]): Buffer {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** png / jpeg / webp by magic bytes (the store's screenshot types). */
export function imageType(b: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}
