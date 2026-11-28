import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonical, createFsx, Interrupted, pretty } from '../src/index.js';
import { tempStore } from './helpers.js';

test('fsx calls the hook before every change', () => {
  const s = tempStore({ schema: 1 });
  try {
    const points = [];
    const fs = createFsx(s.dir, (p) => points.push(p));
    fs.mkdir('a');
    fs.writeFile('a/x.txt', 'hello');
    fs.rename('a/x.txt', 'b/y.txt');
    fs.remove('a');
    assert.deepEqual(points, ['mkdir a', 'write a/x.txt', 'rename a/x.txt -> b/y.txt', 'remove a']);
    assert.equal(s.read('b/y.txt'), 'hello');
    assert.equal(existsSync(join(s.dir, 'a')), false);
  } finally {
    s.cleanup();
  }
});

test('a hook that throws stops the operation; "torn" writes half the file', () => {
  const s = tempStore({ schema: 1 });
  try {
    const fs = createFsx(s.dir, (p) => {
      if (p === 'write stop.txt') throw new Error('killed');
      if (p === 'write torn.txt') return 'torn';
      return undefined;
    });
    assert.throws(() => fs.writeFile('stop.txt', 'abc'), /killed/);
    assert.equal(existsSync(join(s.dir, 'stop.txt')), false);
    assert.throws(() => fs.writeFile('torn.txt', 'abcdef'), Interrupted);
    assert.equal(s.read('torn.txt'), 'abc');
  } finally {
    s.cleanup();
  }
});

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonical({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'é' } }), '{"a":{"c":"é","d":[{"y":2,"z":1}]},"b":1}');
  assert.equal(pretty({ b: 1, a: 2 }), '{\n  "a": 2,\n  "b": 1\n}\n');
});
