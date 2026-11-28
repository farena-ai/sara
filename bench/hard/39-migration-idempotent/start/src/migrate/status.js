// What state a store is in, for `migrate status`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCollections, readSchema, WORK } from '../store/layout.js';

export function status(dir) {
  const schema = readSchema(dir);
  const collections = readCollections(dir);
  const counts = {};
  for (const [name, lines] of Object.entries(collections)) counts[name] = lines.length;
  return { schema, interrupted: existsSync(join(dir, WORK)), manifest: existsSync(join(dir, 'manifest.json')), counts };
}
