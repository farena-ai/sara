// Reading a store folder (docs/STORE.md). Nothing here writes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError } from '../util/errors.js';
import { parseLines } from './ndjson.js';

export const RECORDS = 'records';
export const QUARANTINE = 'quarantine';
export const WORK = '.migrate';

export function readSchema(dir) {
  const file = join(dir, 'store.json');
  if (!existsSync(file)) throw new StoreError(`${dir} is not a store (no store.json)`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new StoreError('store.json is not valid JSON');
  }
  if (!Number.isInteger(data?.schema) || data.schema < 1) throw new StoreError('store.json has no valid "schema"');
  return data.schema;
}

/** The collections in records/: { name: [{ record } | { raw }] }, by file name (without .ndjson). */
export function readCollections(dir) {
  const out = {};
  const folder = join(dir, RECORDS);
  if (!existsSync(folder)) return out;
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith('.ndjson')) continue;
    out[name.slice(0, -'.ndjson'.length)] = parseLines(readFileSync(join(folder, name), 'utf8'));
  }
  return out;
}

/** The text of quarantine/<collection>.ndjson, or "" when there is none. */
export function readQuarantine(dir, collection) {
  const file = join(dir, QUARANTINE, `${collection}.ndjson`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Every file under records/ and quarantine/, as sorted "records/x.ndjson" paths. */
export function dataFiles(dir) {
  const out = [];
  for (const folder of [QUARANTINE, RECORDS]) {
    const abs = join(dir, folder);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) out.push(`${folder}/${name}`);
  }
  return out.sort();
}
