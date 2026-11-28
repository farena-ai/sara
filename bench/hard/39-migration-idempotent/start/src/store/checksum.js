import { createHash } from 'node:crypto';

/** sha256 of a file's bytes, as lowercase hex. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
