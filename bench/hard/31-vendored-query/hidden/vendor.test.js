import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const vendor = join(here, '..', 'vendor');

function files(dir, base = '') {
  const out = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...files(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

const hash = (path) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

test('the vendored library under vendor/ is unchanged', () => {
  const expected = readFileSync(join(here, 'vendor.sha256'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/));
  const listed = expected.map(([, f]) => f).sort();
  assert.deepEqual(files(vendor), listed, 'vendor/ has the same files');
  for (const [sum, f] of expected) assert.equal(hash(join(vendor, f)), sum, `vendor/${f} is unchanged`);
});
