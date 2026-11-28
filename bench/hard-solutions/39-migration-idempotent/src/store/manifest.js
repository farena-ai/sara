// manifest.json (docs/STORE.md, "The manifest"): what every data file held after the last finished run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pretty } from './canonical.js';
import { sha256 } from './checksum.js';
import { dataFiles, readSchema } from './layout.js';

export function describeFile(bytes) {
  const text = bytes.toString('utf8');
  return { bytes: bytes.length, records: text.split('\n').filter((l) => l.trim() !== '').length, sha256: sha256(bytes) };
}

export function buildManifest(dir) {
  const files = {};
  for (const rel of dataFiles(dir)) files[rel] = describeFile(readFileSync(join(dir, ...rel.split('/'))));
  return pretty({ files, schema: readSchema(dir) });
}

/** The paths that do not match the manifest, sorted; null when there is no manifest. */
export function manifestMismatches(dir) {
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return ['manifest.json'];
  }
  if (!manifest || typeof manifest.files !== 'object' || manifest.schema !== readSchema(dir)) return ['manifest.json'];
  const listed = manifest.files ?? {};
  const actual = dataFiles(dir);
  const bad = new Set();
  for (const rel of actual) {
    const want = listed[rel];
    const got = describeFile(readFileSync(join(dir, ...rel.split('/'))));
    if (!want || want.sha256 !== got.sha256 || want.bytes !== got.bytes || want.records !== got.records) bad.add(rel);
  }
  for (const rel of Object.keys(listed)) if (!actual.includes(rel)) bad.add(rel);
  return [...bad].sort();
}

export function verify(dir) {
  const mismatches = manifestMismatches(dir);
  if (mismatches === null) return { ok: false, manifest: false, mismatches: [] };
  return { ok: mismatches.length === 0, manifest: true, mismatches, files: dataFiles(dir).length };
}
