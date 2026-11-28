import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli/main.js';

export const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'store-v1');

/** A temporary store: a copy of `from`, or built from { schema, files: { rel: text } }. */
export function tempStore(from = EXAMPLE) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  if (typeof from === 'string') cpSync(from, dir, { recursive: true });
  else {
    writeFileSync(join(dir, 'store.json'), `{"schema":${from.schema}}\n`);
    for (const [rel, text] of Object.entries(from.files ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
  return { dir, read: (rel) => readFileSync(join(dir, rel), 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const lines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const ndjson = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

export function cli(cwd, ...argv) {
  let out = '';
  let err = '';
  const code = run(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), cwd });
  return { code, out, err };
}
