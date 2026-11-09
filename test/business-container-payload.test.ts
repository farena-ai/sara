import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('container COPY recipe delivers the complete MIT license beside the runtime package', () => {
  const checkout = resolve(import.meta.dirname, '..');
  const payload = mkdtempSync(join(tmpdir(), 'sara-container-payload-'));
  try {
    const recipe = readFileSync(join(checkout, 'Dockerfile'), 'utf8').replace(/\\\r?\n\s*/g, ' ');
    // Materialize the actual local COPY instructions without building/installing an image.
    // Unsupported syntax fails explicitly rather than silently skipping payload instructions.
    for (const line of recipe.split(/\r?\n/).filter(line => /^COPY\s/.test(line))) {
      const words = line.trim().split(/\s+/).slice(1);
      assert.ok(words.length >= 2 && words.every(word => /^[\w./-]+$/.test(word)), `Unsupported COPY: ${line}`);
      const destination = words.pop()!;
      for (const source of words) {
        const target = join(payload, destination, ...(destination.endsWith('/') ? [source.split('/').at(-1)!] : []));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(checkout, source), target, { recursive: true });
      }
    }
    assert.equal(existsSync(join(payload, 'LICENSE')), true, 'The shipped runtime needs physical LICENSE, not only an OCI label');
    assert.deepEqual(readFileSync(join(payload, 'LICENSE')), readFileSync(join(checkout, 'LICENSE')));
    assert.equal(JSON.parse(readFileSync(join(payload, 'package.json'), 'utf8')).license, 'MIT');
  } finally { rmSync(payload, { recursive: true, force: true }); }
});
