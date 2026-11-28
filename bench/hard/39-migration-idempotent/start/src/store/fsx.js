// Every change the migration makes to a store folder goes through here (docs/RESUME.md, "The fault hook").
//
//   const fs = createFsx(dir, fault)
//   fs.writeFile(rel, text)   fs.rename(fromRel, toRel)   fs.remove(rel)   fs.mkdir(rel)
//
// Paths are relative to the store folder, with "/". Before each operation the hook is called with a point
// such as "write records/orders.ndjson" or "rename .migrate/store.json -> store.json". If it throws, the
// operation does not happen and the error goes up. If it returns "torn" for a write, the first half of the
// bytes are written and an Interrupted error is thrown: a process that died in the middle of a write.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Interrupted } from '../util/errors.js';

export function createFsx(dir, fault = () => {}) {
  const abs = (rel) => join(dir, ...rel.split('/'));
  return {
    writeFile(rel, text) {
      const how = fault(`write ${rel}`);
      mkdirSync(dirname(abs(rel)), { recursive: true });
      if (how === 'torn') {
        const bytes = Buffer.from(text, 'utf8');
        writeFileSync(abs(rel), bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw new Interrupted(`torn write of ${rel}`);
      }
      writeFileSync(abs(rel), text);
    },
    rename(from, to) {
      fault(`rename ${from} -> ${to}`);
      mkdirSync(dirname(abs(to)), { recursive: true });
      renameSync(abs(from), abs(to));
    },
    remove(rel) {
      fault(`remove ${rel}`);
      rmSync(abs(rel), { recursive: true, force: true });
    },
    mkdir(rel) {
      fault(`mkdir ${rel}`);
      mkdirSync(abs(rel), { recursive: true });
    },
  };
}
