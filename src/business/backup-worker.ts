import { workerData, parentPort } from 'node:worker_threads';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeTar, readTar } from '../backup.ts';
import { encryptBackup, decryptBackup } from '../offsite.ts';
import { BUSINESS_ARCHIVE_MAGIC, BUSINESS_BACKUP_MAX, checkedFiles, validateBusinessGeneration, closeRestoredAccess } from './backup.ts';

function archiveEntries(bytes: Buffer) {
  let offset = 0; let count = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid archive trailer.'); break; }
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid archive size.');
    const size = Number.parseInt(sizeText, 8); const type = header[156];
    if (!Number.isSafeInteger(size) || size < 0 || size > BUSINESS_BACKUP_MAX || ![0, 48, 120].includes(type) || ++count > 20002 || type === 120 && size > 4096) throw new Error('Invalid archive entry.');
    const end = offset + 512 + size + ((512 - size % 512) % 512);
    if (end > bytes.length) throw new Error('Truncated archive.');
    offset = end;
  }
  return readTar(bytes);
}

let scratch: string | undefined;
let partial: string | undefined;
try {
  if (workerData.operation === 'seal') {
    const manifest = { ...workerData.manifest, files: checkedFiles(workerData.stage).map(path => {
      const bytes = readFileSync(join(workerData.stage, ...path.split('/')));
      return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }) };
    writeFileSync(join(workerData.stage, 'BUSINESS_BACKUP.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    validateBusinessGeneration(workerData.stage);
    parentPort!.postMessage({ ok: true, manifest });
  } else if (workerData.operation === 'pack') {
    const manifest = validateBusinessGeneration(workerData.stage);
    const entries = checkedFiles(workerData.stage).map(path => ({ path, data: readFileSync(join(workerData.stage, ...path.split('/'))), mode: 0o600 }));
    const bytes = Buffer.concat([Buffer.from(BUSINESS_ARCHIVE_MAGIC), encryptBackup(gzipSync(writeTar(entries)), workerData.passphrase)]);
    partial = workerData.file + '.partial-' + randomUUID();
    const fd = openSync(partial, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Link publication is exclusive and atomic; never replace an existing archive.
    linkSync(partial, workerData.file); rmSync(partial); partial = undefined;
    parentPort!.postMessage({ ok: true, manifest });
  } else if (workerData.operation === 'restore') {
    const stat = lstatSync(workerData.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > BUSINESS_BACKUP_MAX) throw new Error('Invalid archive.');
    const bytes = readFileSync(workerData.file);
    if (bytes.length > BUSINESS_BACKUP_MAX || bytes.subarray(0, 8).toString() !== BUSINESS_ARCHIVE_MAGIC) throw new Error('Invalid archive.');
    const entries = archiveEntries(gunzipSync(decryptBackup(bytes.subarray(8), workerData.passphrase), { maxOutputLength: BUSINESS_BACKUP_MAX }));
    if (!entries.length || entries.length > 10001 || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Invalid file set.');
    if (existsSync(workerData.target)) throw new Error('Target exists.');
    // A sibling stage allows final rename without exposing partially restored access.
    scratch = mkdtempSync(join(dirname(workerData.target), '.business-restore-'));
    for (const entry of entries) {
      if (entry.path.length > 512 || !/^[\w./-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').some((part: string) => !part || part === '.' || part === '..')) throw new Error('Invalid path.');
      const path = join(scratch, ...entry.path.split('/')); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, entry.data, { flag: 'wx', mode: 0o600 });
    }
    const manifest = validateBusinessGeneration(scratch);
    closeRestoredAccess(scratch);
    renameSync(join(scratch, 'BUSINESS_BACKUP.json'), join(scratch, 'business', 'recovery-generation.json'));
    // Retain the immutable manifest as provenance; restored DBs now contain explicit recovery mutations.
    if (existsSync(workerData.target)) throw new Error('Target exists.');
    mkdirSync(workerData.target, { mode: 0o700 });
    renameSync(join(scratch, 'business'), join(workerData.target, 'business'));
    // Publish the profile marker last; interrupted promotion remains fail closed.
    renameSync(join(scratch, 'profile.json'), join(workerData.target, 'profile.json'));
    rmSync(scratch, { recursive: true, force: true }); scratch = undefined;
    parentPort!.postMessage({ ok: true, manifest });
  } else throw new Error('Unknown archive operation.');
} catch { parentPort!.postMessage({ ok: false }); }
finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); if (partial) rmSync(partial, { force: true }); }
