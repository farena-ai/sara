// X3: scripts/test-affected.ts picks the tests close to a change (a helper for quick turns, not the gate).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { affectedTests, importsOf, namedFiles } from '../scripts/test-affected.ts';

test('X3 affected tests: a leaf file reaches the tests that import or name it; an untraceable file reaches everything', () => {
  const leaf = affectedTests(['src/static-compress.ts']);
  assert.equal(leaf.all, false);
  assert.ok(leaf.tests.includes('test/x2-static-compress.test.ts'));
  assert.ok(leaf.tests.length < 400, `${leaf.tests.length} files for one leaf module`);
  const self = affectedTests(['test/x0-taint.test.ts']);
  assert.deepEqual(self.tests, ['test/x0-taint.test.ts'], 'a changed test runs itself');
  const web = affectedTests(['web/enter-send.js']);
  assert.ok(web.tests.length > 0 && web.tests.length < 200, 'tests that read a web file as text are found by its name');
  const pkg = affectedTests(['package.json']);
  assert.equal(pkg.all, true);
  assert.ok(pkg.tests.length > 800);
  assert.deepEqual(affectedTests(['docs/FAQ.md']).all, false);
});

test('X3 affected tests: imports and named files are read from the text', () => {
  const known = new Set(['web/app.js', 'src/chat.ts', 'web/style.css']);
  assert.deepEqual(namedFiles("readFileSync(join(ROOT, 'web', 'style.css')); read('web/app.js'); x = `src/chat.ts`; y = 'web/nope.js'", known).sort(), ['src/chat.ts', 'web/app.js', 'web/style.css']);
  assert.deepEqual(importsOf(fileURLToPath(import.meta.url),"import a from '../scripts/test-affected.ts';\nconst b = await import('./helpers.ts');"), ['scripts/test-affected.ts', 'test/helpers.ts']);
});
