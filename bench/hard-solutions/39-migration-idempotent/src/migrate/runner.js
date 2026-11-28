// Runs the steps from the store's schema up to the target, so that a run stopped anywhere can be finished
// by running again (docs/RESUME.md).
//
// Each step is first computed into .migrate/step-<n>/ (its output files, FILES, then COMPLETE), and only then
// copied over the store; store.json is replaced last, by a rename. A run that finds .migrate/ carries on: a
// step with COMPLETE is copied again, a step without it is computed again from the store.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../store/canonical.js';
import { createFsx } from '../store/fsx.js';
import { readCollections, readQuarantine, readSchema, WORK } from '../store/layout.js';
import { buildManifest, manifestMismatches } from '../store/manifest.js';
import { formatLines } from '../store/ndjson.js';
import { ManifestError, StoreError } from '../util/errors.js';
import { LATEST, stepFrom } from './registry.js';

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');

function stepOutput(dir, step) {
  const result = step.run(readCollections(dir));
  const files = {};
  for (const [collection, records] of Object.entries(result.collections)) files[`records/${collection}.ndjson`] = formatLines(records);
  for (const [collection, entries] of Object.entries(result.quarantine)) {
    if (entries.length > 0) files[`quarantine/${collection}.ndjson`] = readQuarantine(dir, collection) + formatLines(entries);
  }
  return files;
}

function runStep(dir, fs, schema) {
  const step = stepFrom(schema);
  const stage = `${WORK}/step-${schema}`;
  if (!existsSync(join(dir, WORK, `step-${schema}`, 'COMPLETE'))) {
    if (existsSync(join(dir, WORK, `step-${schema}`))) fs.remove(stage);
    const files = stepOutput(dir, step);
    const names = Object.keys(files).sort();
    fs.mkdir(stage);
    for (const rel of names) fs.writeFile(`${stage}/${rel}`, files[rel]);
    fs.writeFile(`${stage}/FILES`, `${JSON.stringify(names)}\n`);
    fs.writeFile(`${stage}/COMPLETE`, '');
  }
  for (const rel of JSON.parse(read(dir, `${stage}/FILES`))) fs.writeFile(rel, read(dir, `${stage}/${rel}`));
  fs.writeFile(`${WORK}/store.json`, `${canonical({ schema: schema + 1 })}\n`);
  fs.rename(`${WORK}/store.json`, 'store.json');
  fs.remove(stage);
  return step.name;
}

/**
 * migrate(dir, { to, fault }) -> { from, to, steps }
 *   to     the schema to reach (default: the latest)
 *   fault  the fault hook (docs/RESUME.md)
 */
export function migrate(dir, { to = LATEST, fault } = {}) {
  if (!Number.isInteger(to) || to < 1 || to > LATEST) throw new StoreError(`no migration to schema ${to} (the latest is ${LATEST})`);
  const fs = createFsx(dir, fault);
  const start = readSchema(dir);
  const resuming = existsSync(join(dir, WORK));
  if (!resuming) {
    if (start > to) throw new StoreError(`the store is at schema ${start}, after ${to}`);
    if (start === to) {
      const mismatches = manifestMismatches(dir);
      if (mismatches !== null && mismatches.length === 0) return { from: start, to, steps: [] };
      if (mismatches !== null) throw new ManifestError(`manifest does not match ${mismatches[0]}`);
    }
    fs.mkdir(WORK);
  }
  const target = Math.max(to, start);
  const steps = [];
  for (let schema = readSchema(dir); schema < target; schema = readSchema(dir)) steps.push(runStep(dir, fs, schema));
  fs.writeFile(`${WORK}/manifest.json`, buildManifest(dir));
  fs.rename(`${WORK}/manifest.json`, 'manifest.json');
  fs.remove(WORK);
  return { from: start, to: target, steps };
}
