// W5.1 (docs/security/W5_REVIEW.md): pictures that leave through a public link (Memory lane share
// links) lose what the camera wrote about them: EXIF (GPS position, camera serial, time), XMP and
// comments. Pixels are copied byte for byte (no re-encode). JPEG keeps JFIF (APP0), the color
// profile (APP2 ICC_PROFILE) and Adobe (APP14); PNG drops eXIf/tEXt/zTXt/iTXt/tIME; WebP drops
// EXIF/XMP chunks and clears their VP8X flags. A picture that can't be read is left out (undefined).

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** JPEG segments that may carry who/where/when: APP1–APP15 (but ICC in APP2 and Adobe APP14) and comments. */
function jpegDrops(marker: number, body: Buffer): boolean {
  if (marker === 0xfe) return true;
  if (marker < 0xe1 || marker > 0xef) return false;
  if (marker === 0xee) return false;
  if (marker === 0xe2 && body.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0') return false;
  return true;
}

function jpeg(buf: Buffer): Buffer | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  const out: Buffer[] = [buf.subarray(0, 2)];
  let at = 2;
  while (at + 2 <= buf.length) {
    if (buf[at] !== 0xff) return undefined;
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd9) return Buffer.concat([...out, buf.subarray(at, at + 2)]);
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > buf.length) return undefined;
    const len = buf.readUInt16BE(at + 2);
    if (len < 2 || at + 2 + len > buf.length) return undefined;
    // Start of scan: the rest is picture data (and any later tables); copied as it is.
    if (marker === 0xda) return Buffer.concat([...out, buf.subarray(at)]);
    const segment = buf.subarray(at, at + 2 + len);
    if (!jpegDrops(marker, segment.subarray(4))) out.push(segment);
    at += 2 + len;
  }
  return undefined;
}

function png(buf: Buffer): Buffer | undefined {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return undefined;
  const out: Buffer[] = [PNG_SIG];
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 12 + len;
    if (end > buf.length) return undefined;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(at, end));
    at = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return undefined;
}

function webp(buf: Buffer): Buffer | undefined {
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined;
  const out: Buffer[] = [];
  let at = 12;
  while (at + 8 <= buf.length) {
    const type = buf.subarray(at, at + 4).toString('latin1');
    const len = buf.readUInt32LE(at + 4);
    if (at + 8 + len > buf.length) return undefined;
    const end = Math.min(buf.length, at + 8 + len + (len & 1));
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = Buffer.from(buf.subarray(at, end));
      if (type === 'VP8X' && len >= 1) c[8] = c[8]! & ~0x0c; // the EXIF and XMP flags
      out.push(c);
    }
    at = end;
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...out]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** The picture without its metadata, or undefined when it can't be read (leave it out). */
export function stripImageMeta(mime: string, buf: Buffer): Buffer | undefined {
  try {
    if (mime === 'image/jpeg') return jpeg(buf);
    if (mime === 'image/png') return png(buf);
    if (mime === 'image/webp') return webp(buf);
    // GIF carries no camera data (no EXIF); kept when it is one.
    if (mime === 'image/gif') return buf.subarray(0, 3).toString('latin1') === 'GIF' ? buf : undefined;
  } catch {
    /* a broken picture is left out */
  }
  return undefined;
}
