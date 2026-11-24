// C23 (docs/RESEARCH.md "The PDF and other scripts"): fonts already on this computer, for the PDF
// text the built-in Helvetica can't write (Greek, Cyrillic, Chinese, Japanese, Korean, Hebrew, Thai,
// symbols…). Nothing is downloaded and there is no package: this finds TrueType fonts in the
// system's font folders by name (a fixed order per kind of text), reads their tables (cmap, hmtx,
// head, hhea, maxp, loca, glyf) and writes a small copy holding only the glyphs a document uses,
// for embedding. A font is skipped, never guessed at, when it is not TrueType outlines (CFF/.otf,
// bitmap emoji), is damaged, or its own licence bits forbid embedding or subsetting.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Test seams only (never set by the app): the folders to look in instead of the system's. */
export const pdfFontDeps: { dirs?: string[] } = {};

export interface Face {
  path: string;
  /** A name for the PDF (letters, digits and "-"). */
  name: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  bbox: [number, number, number, number];
  numGlyphs: number;
  /** The glyph for a character, 0 when the font has none. */
  glyph(cp: number): number;
  /** A glyph's advance width in font units. */
  advance(gid: number): number;
  /** The font file's bytes (read again when it is embedded). */
  source(): Buffer;
  index: number;
}

interface Table {
  off: number;
  len: number;
}

function tablesOf(buf: Buffer, index: number): Map<string, Table> | null {
  let at = 0;
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) === 'ttcf') {
    if (index >= buf.readUInt32BE(8)) return null;
    at = buf.readUInt32BE(12 + 4 * index);
  } else if (index > 0) return null;
  if (at + 12 > buf.length) return null;
  const ver = buf.readUInt32BE(at);
  // TrueType outlines only ('OTTO' is CFF: not read here).
  if (ver !== 0x00010000 && ver !== 0x74727565) return null;
  const n = buf.readUInt16BE(at + 4);
  const out = new Map<string, Table>();
  for (let i = 0; i < n; i++) {
    const r = at + 12 + 16 * i;
    if (r + 16 > buf.length) return null;
    const t = { off: buf.readUInt32BE(r + 8), len: buf.readUInt32BE(r + 12) };
    if (t.off + t.len > buf.length) return null;
    out.set(buf.toString('latin1', r, r + 4), t);
  }
  return out;
}

/** A cmap subtable (format 4 or 12) as a lookup; its bytes are copied so the file can be let go. */
function cmapLookup(buf: Buffer, cmap: Table): ((cp: number) => number) | null {
  const n = buf.readUInt16BE(cmap.off + 2);
  let best: { off: number; rank: number } | null = null;
  for (let i = 0; i < n; i++) {
    const r = cmap.off + 4 + 8 * i;
    const platform = buf.readUInt16BE(r);
    const enc = buf.readUInt16BE(r + 2);
    const off = cmap.off + buf.readUInt32BE(r + 4);
    if (off + 4 > buf.length) continue;
    const format = buf.readUInt16BE(off);
    const unicode = platform === 0 || (platform === 3 && (enc === 1 || enc === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    const rank = format === 12 ? 2 : 1;
    if (!best || rank > best.rank) best = { off, rank };
  }
  if (!best) return null;
  if (best.rank === 2) {
    const groups = buf.readUInt32BE(best.off + 12);
    if (best.off + 16 + 12 * groups > buf.length) return null;
    const g = new Uint32Array(groups * 3);
    for (let i = 0; i < groups * 3; i++) g[i] = buf.readUInt32BE(best.off + 16 + 4 * i);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cp < g[mid * 3]) hi = mid - 1;
        else if (cp > g[mid * 3 + 1]) lo = mid + 1;
        else return g[mid * 3 + 2] + (cp - g[mid * 3]);
      }
      return 0;
    };
  }
  const len = buf.readUInt16BE(best.off + 2);
  if (best.off + len > buf.length || len < 16) return null;
  const t = Buffer.from(buf.subarray(best.off, best.off + len));
  const segs = t.readUInt16BE(6) / 2;
  const ends = 14;
  const starts = ends + 2 * segs + 2;
  const deltas = starts + 2 * segs;
  const ranges = deltas + 2 * segs;
  if (ranges + 2 * segs > t.length) return null;
  return (cp) => {
    if (cp > 0xffff) return 0;
    let lo = 0;
    let hi = segs - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.readUInt16BE(ends + 2 * mid) < cp) lo = mid + 1;
      else hi = mid;
    }
    const start = t.readUInt16BE(starts + 2 * lo);
    if (cp < start || cp > t.readUInt16BE(ends + 2 * lo)) return 0;
    const delta = t.readUInt16BE(deltas + 2 * lo);
    const ro = t.readUInt16BE(ranges + 2 * lo);
    if (!ro) return (cp + delta) & 0xffff;
    const at = ranges + 2 * lo + ro + 2 * (cp - start);
    if (at + 2 > t.length) return 0;
    const g = t.readUInt16BE(at);
    return g ? (g + delta) & 0xffff : 0;
  };
}

/** Reads one font of a file (a .ttc holds several; `index` picks one). Null when it can't be used. */
export function parseFace(buf: Buffer, o: { index?: number; path?: string; source?: () => Buffer } = {}): Face | null {
  try {
    const index = o.index ?? 0;
    const t = tablesOf(buf, index);
    if (!t) return null;
    const need = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'loca', 'glyf'].map((k) => t.get(k));
    if (need.some((x) => !x)) return null;
    const [cmap, head, hhea, hmtx, maxp] = need as Table[];
    // The font's own licence bits: no embedding, no subsetting or bitmaps only means it is left alone.
    const os2 = t.get('OS/2');
    if (os2 && os2.len >= 10) {
      const fsType = buf.readUInt16BE(os2.off + 8);
      if ((fsType & 0x000e) === 0x0002 || fsType & 0x0100 || fsType & 0x0200) return null;
    }
    const unitsPerEm = buf.readUInt16BE(head.off + 18);
    const numGlyphs = buf.readUInt16BE(maxp.off + 4);
    const nH = buf.readUInt16BE(hhea.off + 34);
    if (!unitsPerEm || !numGlyphs || !nH || hmtx.len < nH * 4) return null;
    const glyph = cmapLookup(buf, cmap);
    if (!glyph) return null;
    const adv = new Uint16Array(nH);
    for (let i = 0; i < nH; i++) adv[i] = buf.readUInt16BE(hmtx.off + 4 * i);
    const path = o.path ?? '';
    const name = (basename(path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '') || 'Font').slice(0, 40);
    const kept = o.source ? null : Buffer.from(buf);
    return {
      path,
      index,
      name,
      unitsPerEm,
      ascent: buf.readInt16BE(hhea.off + 4),
      descent: buf.readInt16BE(hhea.off + 6),
      bbox: [buf.readInt16BE(head.off + 36), buf.readInt16BE(head.off + 38), buf.readInt16BE(head.off + 40), buf.readInt16BE(head.off + 42)],
      numGlyphs,
      glyph: (cp) => {
        const g = glyph(cp);
        return g < numGlyphs ? g : 0;
      },
      advance: (gid) => adv[Math.min(gid, nH - 1)],
      source: o.source ?? (() => kept!),
    };
  } catch {
    return null;
  }
}

const pad4 = (n: number) => (n + 3) & ~3;
function checksum(b: Buffer): number {
  let sum = 0;
  const n = b.length & ~3;
  for (let i = 0; i < n; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0;
  if (n < b.length) {
    const tail = Buffer.alloc(4);
    b.copy(tail, 0, n);
    sum = (sum + tail.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

/**
 * A TrueType file with only these glyphs drawn (and the parts composite glyphs are built from).
 * Glyph numbers stay the same, so the PDF addresses glyphs directly; every other glyph is empty.
 */
export function subsetFace(face: Face, gids: Iterable<number>): Buffer {
  const buf = face.source();
  const t = tablesOf(buf, face.index)!;
  const head = t.get('head')!;
  const glyf = t.get('glyf')!;
  const locaT = t.get('loca')!;
  const long = buf.readInt16BE(head.off + 50) === 1;
  const n = face.numGlyphs;
  const loca = (g: number) => (long ? buf.readUInt32BE(locaT.off + 4 * g) : buf.readUInt16BE(locaT.off + 2 * g) * 2);
  const keep = new Set<number>([0]);
  for (const g of gids) if (g >= 0 && g < n) keep.add(g);
  const todo = [...keep];
  while (todo.length) {
    const g = todo.pop()!;
    const a = loca(g);
    const b = loca(g + 1);
    if (b <= a || b > glyf.len) continue;
    const p = glyf.off + a;
    if (b - a < 10 || buf.readInt16BE(p) >= 0) continue;
    // A composite glyph: keep the glyphs it is made of.
    let q = p + 10;
    const end = glyf.off + b;
    while (q + 4 <= end) {
      const flags = buf.readUInt16BE(q);
      const part = buf.readUInt16BE(q + 2);
      if (part < n && !keep.has(part)) {
        keep.add(part);
        todo.push(part);
      }
      q += 4 + (flags & 0x0001 ? 4 : 2) + (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0);
      if (!(flags & 0x0020)) break;
    }
  }
  const newLoca = Buffer.alloc(4 * (n + 1));
  const parts: Buffer[] = [];
  let at = 0;
  for (let g = 0; g < n; g++) {
    newLoca.writeUInt32BE(at, 4 * g);
    if (!keep.has(g)) continue;
    const a = loca(g);
    const b = loca(g + 1);
    if (b <= a || b > glyf.len) continue;
    const data = Buffer.alloc(pad4(b - a));
    buf.copy(data, 0, glyf.off + a, glyf.off + b);
    parts.push(data);
    at += data.length;
  }
  newLoca.writeUInt32BE(at, 4 * n);
  const newHead = Buffer.from(buf.subarray(head.off, head.off + head.len));
  newHead.writeUInt32BE(0, 8);
  newHead.writeInt16BE(1, 50);
  const copy = (tag: string) => {
    const x = t.get(tag);
    return x ? Buffer.from(buf.subarray(x.off, x.off + x.len)) : null;
  };
  const tables: [string, Buffer][] = [];
  for (const tag of ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep']) {
    const data = tag === 'glyf' ? Buffer.concat(parts) : tag === 'head' ? newHead : tag === 'loca' ? newLoca : copy(tag);
    if (data) tables.push([tag, data]);
  }
  const count = tables.length;
  const pow = 2 ** Math.floor(Math.log2(count));
  const header = Buffer.alloc(12 + 16 * count);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(count * 16 - pow * 16, 10);
  let off = header.length;
  const body: Buffer[] = [];
  let headAt = 0;
  tables.forEach(([tag, data], i) => {
    const r = 12 + 16 * i;
    header.write(tag, r, 'latin1');
    header.writeUInt32BE(checksum(data), r + 4);
    header.writeUInt32BE(off, r + 8);
    header.writeUInt32BE(data.length, r + 12);
    if (tag === 'head') headAt = off;
    const padded = Buffer.alloc(pad4(data.length));
    data.copy(padded);
    body.push(padded);
    off += padded.length;
  });
  const out = Buffer.concat([header, ...body]);
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headAt + 8);
  return out;
}

// ---------- the fonts on this computer ----------

type Kind = 'text' | 'zh' | 'ja' | 'ko' | 'symbols';
interface Pick {
  kind: Kind;
  /** The file's name, lower case. */
  file: RegExp;
  bold?: RegExp;
}
/**
 * The fallback order (file names, lower case). Text fonts first (Windows, then macOS, then Linux
 * names; a name that is not on this computer is passed over), then Chinese / Japanese / Korean,
 * then symbols and one-colour emoji. A character is drawn with the first font that has it.
 */
export const FONT_ORDER: readonly Pick[] = [
  { kind: 'text', file: /^segoeui\.ttf$/, bold: /^segoeuib\.ttf$/ },
  { kind: 'text', file: /^arial\.ttf$/, bold: /^(arialbd|arial bold)\.ttf$/ },
  { kind: 'text', file: /^dejavusans\.ttf$/, bold: /^dejavusans-bold\.ttf$/ },
  { kind: 'text', file: /^liberationsans-regular\.ttf$/, bold: /^liberationsans-bold\.ttf$/ },
  { kind: 'text', file: /^notosans-regular\.ttf$/, bold: /^notosans-bold\.ttf$/ },
  { kind: 'text', file: /^freesans\.ttf$/, bold: /^freesansbold\.ttf$/ },
  { kind: 'text', file: /^tahoma\.ttf$/, bold: /^(tahomabd|tahoma bold)\.ttf$/ },
  { kind: 'text', file: /^(arial unicode|arialuni)\.ttf$/ },
  { kind: 'text', file: /^sfns\.ttf$/ },
  { kind: 'text', file: /^geneva\.ttf$/ },
  { kind: 'text', file: /^sylfaen\.ttf$/ },
  { kind: 'text', file: /^notosans(armenian|georgian|hebrew|thai|lao|ethiopic)-regular\.ttf$/ },
  { kind: 'text', file: /^arial hebrew\.ttc$/ },
  { kind: 'text', file: /^leelawui\.ttf$/, bold: /^leelauib\.ttf$/ },
  { kind: 'text', file: /^thonburi\.tt[cf]$/ },
  { kind: 'text', file: /^(loma|garuda|norasi)\.ttf$/ },
  { kind: 'text', file: /^ebrima\.ttf$/, bold: /^ebrimabd\.ttf$/ },
  { kind: 'text', file: /^gadugi\.ttf$/, bold: /^gadugib\.ttf$/ },
  { kind: 'zh', file: /^msyh\.tt[cf]$/, bold: /^msyhbd\.tt[cf]$/ },
  { kind: 'zh', file: /^msjh\.tt[cf]$/, bold: /^msjhbd\.tt[cf]$/ },
  { kind: 'zh', file: /^simsun\.ttc$/ },
  { kind: 'zh', file: /^pingfang\.ttc$/ },
  { kind: 'zh', file: /^stheiti (medium|light)\.ttc$/ },
  { kind: 'zh', file: /^notosans(sc|tc)(-regular|\[wght\])\.ttf$/ },
  { kind: 'zh', file: /^wqy-(zenhei|microhei)\.tt[cf]$/ },
  { kind: 'zh', file: /^droidsansfallback(full)?\.ttf$/ },
  { kind: 'ja', file: /^yugoth[rm]\.ttc$/, bold: /^yugothb\.ttc$/ },
  { kind: 'ja', file: /^meiryo\.ttc$/, bold: /^meiryob\.ttc$/ },
  { kind: 'ja', file: /^msgothic\.ttc$/ },
  { kind: 'ja', file: /^notosansjp(-regular|\[wght\])\.ttf$/ },
  { kind: 'ja', file: /^(osaka|ipagp?|ipaexg|vl-gothic-regular|takaopgothic)\.ttf$/ },
  { kind: 'ko', file: /^malgun\.ttf$/, bold: /^malgunbd\.ttf$/ },
  { kind: 'ko', file: /^applesdgothicneo\.ttc$/ },
  { kind: 'ko', file: /^applegothic\.ttf$/ },
  { kind: 'ko', file: /^notosanskr(-regular|\[wght\])\.ttf$/ },
  { kind: 'ko', file: /^(nanumgothic|unbatang|undotum|baekmuk-gulim)\.ttf$/ },
  { kind: 'symbols', file: /^seguisym\.ttf$/ },
  { kind: 'symbols', file: /^apple symbols\.ttf$/ },
  { kind: 'symbols', file: /^(symbola|notosanssymbols-regular|notosanssymbols2-regular|unifont)\.ttf$/ },
  { kind: 'symbols', file: /^seguiemj\.ttf$/ },
  { kind: 'symbols', file: /^notoemoji(-regular|\[wght\])\.ttf$/ },
];

/** Where fonts live on this system. */
export function fontDirs(): string[] {
  if (pdfFontDeps.dirs) return pdfFontDeps.dirs;
  const home = homedir();
  if (process.platform === 'win32') return [join(process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local', 'share', 'fonts'), join(home, '.fonts')];
}

const SCANS = new Map<string, Map<string, string>>();
/** Font files by lower-case name (the first folder that has a name wins). Looked up once per set of folders. */
function scan(dirs: string[]): Map<string, string> {
  const key = dirs.join('\n');
  const hit = SCANS.get(key);
  if (hit) return hit;
  const out = new Map<string, string>();
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 20_000) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 5) walk(p, depth + 1);
      } else if (/\.(ttf|ttc|otf)$/i.test(e.name) && !out.has(e.name.toLowerCase())) out.set(e.name.toLowerCase(), p);
    }
  };
  for (const d of dirs) walk(d, 0);
  if (SCANS.size > 8) SCANS.clear();
  SCANS.set(key, out);
  return out;
}

const FACES = new Map<string, Face | null>();
function faceAt(path: string): Face | null {
  if (FACES.has(path)) return FACES.get(path)!;
  let face: Face | null = null;
  try {
    face = parseFace(readFileSync(path), { path, source: () => readFileSync(path) });
  } catch {
    face = null;
  }
  if (FACES.size > 200) FACES.clear();
  FACES.set(path, face);
  return face;
}

/** The fonts of this computer in fallback order, opened only when a character needs them. */
export class SystemFonts {
  readonly #picks: { regular: string; bold?: string }[] = [];

  /** `cjk`: which of Chinese, Japanese and Korean fonts is tried first for shared characters. */
  constructor(cjk: 'zh' | 'ja' | 'ko' = 'zh') {
    const files = scan(fontDirs());
    const names = [...files.keys()];
    const rank = (k: Kind) => (k === 'text' ? 0 : k === cjk ? 1 : k === 'symbols' ? 3 : 2);
    const order = FONT_ORDER.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.kind) - rank(b.p.kind) || a.i - b.i);
    for (const { p } of order) {
      for (const n of names.filter((x) => p.file.test(x)).sort()) {
        const b = p.bold ? names.find((x) => p.bold!.test(x)) : undefined;
        this.#picks.push({ regular: files.get(n)!, ...(b ? { bold: files.get(b)! } : {}) });
      }
    }
  }

  /** The first font that has the character (its bold file when asked and it has it too). */
  find(cp: number, bold = false): { face: Face; gid: number } | null {
    for (const p of this.#picks) {
      const regular = faceAt(p.regular);
      const gid = regular?.glyph(cp) ?? 0;
      if (!regular || !gid) continue;
      if (bold && p.bold) {
        const b = faceAt(p.bold);
        const bg = b?.glyph(cp) ?? 0;
        if (b && bg) return { face: b, gid: bg };
      }
      return { face: regular, gid };
    }
    return null;
  }
}
