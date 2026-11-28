// Runs the steps from the store's schema up to the target.
import { canonical } from '../store/canonical.js';
import { createFsx } from '../store/fsx.js';
import { readCollections, readQuarantine, readSchema } from '../store/layout.js';
import { formatLines } from '../store/ndjson.js';
import { StoreError } from '../util/errors.js';
import { LATEST, stepFrom } from './registry.js';

/**
 * migrate(dir, { to, fault }) -> { from, to, steps }
 *   to     the schema to reach (default: the latest)
 *   fault  the fault hook (docs/RESUME.md)
 */
export function migrate(dir, { to = LATEST, fault } = {}) {
  const fs = createFsx(dir, fault);
  const start = readSchema(dir);
  if (to > LATEST) throw new StoreError(`no migration to schema ${to} (the latest is ${LATEST})`);
  if (start > to) throw new StoreError(`the store is at schema ${start}, after ${to}`);
  const steps = [];
  for (let schema = start; schema < to; schema++) {
    const step = stepFrom(schema);
    const result = step.run(readCollections(dir));
    for (const [collection, records] of Object.entries(result.collections)) {
      fs.writeFile(`records/${collection}.ndjson`, formatLines(records));
    }
    for (const [collection, entries] of Object.entries(result.quarantine)) {
      fs.writeFile(`quarantine/${collection}.ndjson`, readQuarantine(dir, collection) + formatLines(entries));
    }
    fs.writeFile('store.json', `${canonical({ schema: schema + 1 })}\n`);
    steps.push(step.name);
  }
  return { from: start, to, steps };
}
