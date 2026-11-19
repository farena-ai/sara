// V4.1 test pictures: tiny real JPEGs (an 8x8 blue square) with a made-up EXIF block (date, camera,
// GPS), written here byte by byte so the tests need no image library. Every value is fake.
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCnRRRXsnkn/9k=',
  'base64',
);

export interface FakeExif {
  /** "YYYY:MM:DD HH:MM:SS" like a camera writes it. */
  date?: string;
  lat?: number;
  lon?: number;
  make?: string;
  model?: string;
  /** Big-endian ("MM") instead of little-endian ("II") byte order. */
  bigEndian?: boolean;
  /** Extra bytes so two pictures with the same EXIF still differ (and a reader can tell them apart). */
  tag?: string;
}

type Entry = { tag: number; type: number; count: number; data: Buffer };

/** A TIFF block (the inside of an EXIF APP1 segment) with IFD0, the Exif IFD and the GPS IFD. */
function tiff(x: FakeExif): Buffer {
  const be = Boolean(x.bigEndian);
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    if (be) b.writeUInt16BE(n);
    else b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    if (be) b.writeUInt32BE(n);
    else b.writeUInt32LE(n);
    return b;
  };
  const ascii = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, data: Buffer.from(s + '\0', 'latin1') });
  const long = (tag: number, n: number): Entry => ({ tag, type: 4, count: 1, data: u32(n) });
  const dms = (tag: number, v: number): Entry => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 100);
    return { tag, type: 5, count: 3, data: Buffer.concat([u32(d), u32(1), u32(m), u32(1), u32(s), u32(100)]) };
  };
  // Lays out one IFD at `at`; values over 4 bytes go right after it. Returns the bytes.
  const ifd = (entries: Entry[], at: number): Buffer => {
    entries.sort((p, q) => p.tag - q.tag);
    let extra = at + 2 + entries.length * 12 + 4;
    const head: Buffer[] = [u16(entries.length)];
    const tail: Buffer[] = [];
    for (const e of entries) {
      head.push(u16(e.tag), u16(e.type), u32(e.count));
      if (e.data.length <= 4) head.push(Buffer.concat([e.data, Buffer.alloc(4 - e.data.length)]));
      else {
        head.push(u32(extra));
        tail.push(e.data);
        extra += e.data.length;
        if (e.data.length % 2) {
          tail.push(Buffer.alloc(1));
          extra++;
        }
      }
    }
    head.push(u32(0));
    return Buffer.concat([...head, ...tail]);
  };
  const ifd0: Entry[] = [];
  if (x.make) ifd0.push(ascii(0x010f, x.make));
  if (x.model) ifd0.push(ascii(0x0110, x.model));
  const exifEntries: Entry[] = x.date ? [ascii(0x9003, x.date)] : [];
  const gpsEntries: Entry[] =
    x.lat !== undefined && x.lon !== undefined
      ? [ascii(0x0001, x.lat < 0 ? 'S' : 'N'), dms(0x0002, x.lat), ascii(0x0003, x.lon < 0 ? 'W' : 'E'), dms(0x0004, x.lon)]
      : [];
  // Pointers are filled in once the sizes are known: first pass with placeholders.
  const withPtrs = (exifAt: number, gpsAt: number) => [...ifd0, ...(exifEntries.length ? [long(0x8769, exifAt)] : []), ...(gpsEntries.length ? [long(0x8825, gpsAt)] : [])];
  const size0 = ifd(withPtrs(0, 0), 8).length;
  const exifAt = 8 + size0;
  const exifBuf = exifEntries.length ? ifd([...exifEntries], exifAt) : Buffer.alloc(0);
  const gpsAt = exifAt + exifBuf.length;
  const gpsBuf = gpsEntries.length ? ifd([...gpsEntries], gpsAt) : Buffer.alloc(0);
  const first = ifd(withPtrs(exifAt, gpsAt), 8);
  return Buffer.concat([Buffer.from(be ? 'MM' : 'II', 'latin1'), u16(42), u32(8), first, exifBuf, gpsBuf]);
}

/** A real, viewable JPEG with the given made-up EXIF. */
export function fakeJpeg(x: FakeExif = {}): Buffer {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(x)]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
  const parts = [BASE_JPEG.subarray(0, 2), app1];
  if (x.tag) {
    const c = Buffer.from(x.tag, 'latin1');
    const cl = Buffer.alloc(2);
    cl.writeUInt16BE(c.length + 2);
    parts.push(Buffer.from([0xff, 0xfe]), cl, c);
  }
  parts.push(BASE_JPEG.subarray(2));
  return Buffer.concat(parts);
}

/** A 1x1 PNG with no EXIF (a screenshot, say). */
export function fakePng(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
}
