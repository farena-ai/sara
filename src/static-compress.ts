// X2: the web app's text files are sent compressed (Brotli, else gzip). Before, a first load was
// about 6 MB of plain text over ~330 requests; compressed it is roughly a fifth, which is most of
// the wait on a phone, a tunnel or a slow link. Each file is compressed once and kept in memory
// until the file changes (its ETag) or the cache is full. No dependency: node:zlib.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/** Text the browser unpacks; pictures, fonts and sound are compressed already. */
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.map', '.webmanifest', '.xml', '.vtt']);
/** Smaller than this is not worth the header. */
const MIN_BYTES = 1024;
/** One file at most (bigger ones stream as they are). */
const MAX_FILE = 8 * 1024 * 1024;
/** All compressed copies together. */
export const STATIC_CACHE_BYTES = 48 * 1024 * 1024;

export type Encoding = 'br' | 'gzip';

/** What the browser accepts, best first; undefined = send as is. `q=0` means "not this one". */
export function pickEncoding(acceptEncoding: string | string[] | undefined): Encoding | undefined {
  const header = (Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '')).toLowerCase();
  const ok = (name: string) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q=([0-9.]+))?\\s*(?:,|$)`).exec(header);
    return Boolean(m) && (m![1] === undefined || Number(m![1]) > 0);
  };
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : undefined;
}

export const compressible = (file: string, size: number): boolean => TEXT.has(extname(file).toLowerCase()) && size >= MIN_BYTES && size <= MAX_FILE;

const cache = new Map<string, Buffer>();
let cached = 0;

/** The file's bytes in this encoding (compressed once per version of the file). */
export function compressedFile(file: string, etag: string, enc: Encoding): Buffer {
  const key = `${enc}\0${file}\0${etag}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const raw = readFileSync(file);
  const out =
    enc === 'br'
      ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } })
      : gzipSync(raw, { level: 6 });
  // An older version of the same file is of no more use.
  for (const k of cache.keys()) {
    if (k.startsWith(`${enc}\0${file}\0`)) {
      cached -= cache.get(k)!.length;
      cache.delete(k);
    }
  }
  cache.set(key, out);
  cached += out.length;
  while (cached > STATIC_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value!;
    cached -= cache.get(oldest)!.length;
    cache.delete(oldest);
  }
  return out;
}

/** The ETag of an encoded copy (a cache between her and the browser must not mix the two up). */
export const encodedEtag = (etag: string, enc: Encoding | undefined): string => (enc ? `${etag.slice(0, -1)}-${enc}"` : etag);

/** True when the browser's If-None-Match names this file in any encoding it may hold. */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const have = (Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : (ifNoneMatch ?? '')).split(',').map((s) => s.trim().replace(/^W\//, ''));
  return have.some((h) => h === etag || h === encodedEtag(etag, 'br') || h === encodedEtag(etag, 'gzip'));
}

/** Tests: how much is held. */
export function staticCacheStats(): { files: number; bytes: number } {
  return { files: cache.size, bytes: cached };
}
