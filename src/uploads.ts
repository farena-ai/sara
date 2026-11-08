// Photos the owner sends in chat. Stored once by content hash under <data>/uploads, served only to
// the signed-in owner, and passed to vision models as base64. Only real JPEG/PNG/WebP/GIF files
// are accepted (checked by their first bytes, not by what the browser claims).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertDirNotHeld, heldDir } from './legal-hold.ts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

const KINDS: { mime: string; ext: string; magic: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
];

export class UploadError extends Error {}

export interface Upload {
  id: string;
  mime: string;
}

export class UploadStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'uploads');
  }

  /** Saves a `data:image/...;base64,...` URL (or raw base64 with a mime); returns its id. */
  save(dataUrl: string): Upload {
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw new UploadError('A photo must be sent as a data URL.');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) throw new UploadError('That photo is empty.');
    if (bytes.length > MAX_IMAGE_BYTES) throw new UploadError(`Photos can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    const kind = KINDS.find((k) => k.magic(bytes));
    if (!kind) throw new UploadError('Only JPEG, PNG, WebP or GIF photos can be sent.');
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${kind.ext}`;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
    return { id, mime: kind.mime };
  }

  /**
   * Phase 115 (BR1 B1): raw bytes from a chat app (a Telegram photo, a Discord attachment, a plugin
   * bridge's chunks). The same checks as save(): size, and the first bytes must be a real picture.
   */
  saveBytes(bytes: Buffer): Upload {
    if (!bytes.length) throw new UploadError('That photo is empty.');
    if (bytes.length > MAX_IMAGE_BYTES) throw new UploadError(`Photos can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    const kind = KINDS.find((k) => k.magic(bytes));
    if (!kind) throw new UploadError('Only JPEG, PNG, WebP or GIF photos can be sent.');
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${kind.ext}`;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
    return { id, mime: kind.mime };
  }

  /** Phase 115: deletes one stored photo now (a refused picture from someone else, an expired one). */
  remove(id: string): boolean {
    assertDirNotHeld(dirname(this.dir));
    const f = this.get(id);
    if (!f) return false;
    rmSync(f.path, { force: true });
    return true;
  }

  /** Path and type of a stored photo, or undefined for unknown/invalid ids. */
  get(id: string): { path: string; mime: string } | undefined {
    if (!/^[0-9a-f]{32}\.(jpg|png|webp|gif)$/.test(id)) return undefined;
    const path = join(this.dir, id);
    if (!existsSync(path)) return undefined;
    const ext = id.split('.')[1];
    return { path, mime: KINDS.find((k) => k.ext === ext)!.mime };
  }

  /** Base64 data for a model request. */
  load(id: string): { mime: string; data: string } | undefined {
    const f = this.get(id);
    return f ? { mime: f.mime, data: readFileSync(f.path).toString('base64') } : undefined;
  }

  /** Removes photos no message refers to any more. */
  prune(inUse: Set<string>): number {
    if (!existsSync(this.dir) || heldDir(dirname(this.dir))) return 0;
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      if (!inUse.has(name)) {
        rmSync(join(this.dir, name), { force: true });
        n++;
      }
    }
    return n;
  }
}
