import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.js';
import { run } from '../src/cli/main.js';

export { api };
export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = join(HERE, '..', 'examples', 'store-v1');
export const FIXTURES = join(HERE, 'fixtures');

/** Runs fn(dir) on a temporary store (a copy of a folder, or { schema, files }), then removes it. */
export function withStore(from, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-hidden-'));
  try {
    if (typeof from === 'string') cpSync(from, dir, { recursive: true });
    else {
      writeFileSync(join(dir, 'store.json'), `{"schema":${from.schema}}\n`);
      for (const [rel, text] of Object.entries(from.files ?? {})) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file in the folder: { "records/x.ndjson": text }, folders included as "dir/" entries. */
export function snapshot(dir, base = '') {
  const out = {};
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out[`${rel}/`] = '';
      Object.assign(out, snapshot(dir, rel));
    } else out[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return out;
}

export const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
export const has = (dir, rel) => existsSync(join(dir, rel));
export const lines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const ndjson = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

export function cli(cwd, ...argv) {
  let out = '';
  let err = '';
  const code = run(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), cwd });
  return { code, out, err };
}

export function golden(name) {
  return JSON.parse(readFileSync(join(HERE, 'golden', `${name}.json`), 'utf8'));
}

/** A hook that records every point and fails at the n-th call (counting from 0): throw, or return "torn". */
export function faultAt(n, how = 'throw') {
  const points = [];
  const hook = (point) => {
    points.push(point);
    if (points.length - 1 === n) {
      if (how === 'torn' && point.startsWith('write ')) return 'torn';
      throw new Error(`killed at ${point}`);
    }
    return undefined;
  };
  hook.points = points;
  return hook;
}

/** The points an uninterrupted run passes, for a copy of `from` (to: the target). */
export function allPoints(from, to) {
  return withStore(from, (dir) => {
    const points = [];
    api.migrate(dir, { to, fault: (p) => points.push(p) });
    return points;
  });
}
