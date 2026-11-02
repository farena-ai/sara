// Phase 127 (2.60.0, docs/design/PACKS.md §4.4): what a pack's pictures are (type and size, read from
// their own bytes) and their metadata stripped. EXIF, XMP, IPTC and comments can name a camera, a
// place or a person, so the builder removes them and the `pictures` check refuses any left over.
// No decoding of pixels: only the headers are read.
import { readPngChunks, writePngChunks } from '../character-cards.ts';
import { imageType } from '../store/checks.ts';

export interface PictureInfo {
  type: 'png' | 'jpeg' | 'webp' | undefined;
  width: number;
  height: number;
  /** The metadata found (\"EXIF\", \"XMP\", \"a comment\", \"text\"). */
  meta: string[];
}

const JPEG_META = new Set([0xe1, 0xed, 0xfe]); // APP1 (EXIF/XMP), APP13 (IPTC), COM
const PNG_META = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/** Walks a JPEG's segments up to the start of the picture data. */
function jpegSegments(b: Buffer): { marker: number; start: number; end: number }[] | undefined {
  const out: { marker: number; start: number; end: number }[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return undefined;
    out.push({ marker, start: i, end: i + 2 + len });
    if (marker === 0xda) break; // the picture data follows
    i += 2 + len;
  }
  return out;
}

export function pictureInfo(b: Buffer): PictureInfo {
  const type = imageType(b);
  const info: PictureInfo = { type, width: 0, height: 0, meta: [] };
  if (type === 'jpeg') {
    for (const s of jpegSegments(b) ?? []) {
      if (s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc && s.end - s.start >= 9) {
        info.height = b.readUInt16BE(s.start + 5);
        info.width = b.readUInt16BE(s.start + 7);
      }
      if (s.marker === 0xe1) info.meta.push(b.subarray(s.start + 4, s.start + 10).toString('latin1').startsWith('Exif') ? 'EXIF' : 'XMP');
      if (s.marker === 0xed) info.meta.push('IPTC');
      if (s.marker === 0xfe) info.meta.push('a comment');
    }
  } else if (type === 'png') {
    try {
      const chunks = readPngChunks(b);
      const ihdr = chunks.find((c) => c.type === 'IHDR');
      if (ihdr && ihdr.data.length >= 8) {
        info.width = ihdr.data.readUInt32BE(0);
        info.height = ihdr.data.readUInt32BE(4);
      }
      if (chunks.some((c) => PNG_META.has(c.type))) info.meta.push('text');
    } catch {
      info.type = undefined;
    }
  }
  info.meta = [...new Set(info.meta)];
  return info;
}

/** The same picture without its metadata (JPEG: APP1, APP13 and comments; PNG: text and EXIF chunks). */
export function stripMeta(b: Buffer): Buffer {
  const type = imageType(b);
  if (type === 'jpeg') {
    const segs = jpegSegments(b);
    if (!segs?.length) return b;
    const parts: Buffer[] = [b.subarray(0, 2)];
    let at = 2;
    for (const s of segs) {
      if (s.start > at) parts.push(b.subarray(at, s.start));
      if (!JPEG_META.has(s.marker)) parts.push(b.subarray(s.start, s.end));
      at = s.end;
    }
    parts.push(b.subarray(at));
    return Buffer.concat(parts);
  }
  if (type === 'png') {
    try {
      return writePngChunks(readPngChunks(b).filter((c) => !PNG_META.has(c.type)));
    } catch {
      return b;
    }
  }
  return b;
}
