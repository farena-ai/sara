import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Timing-sensitive tests are named test/*.serial.ts: the parallel glob (test/**/*.test.ts) skips
// them and `npm test` / the server suite run them alone afterwards, so a busy parallel batch can't
// starve the process that measures.
test('serial tests stay out of the parallel batch and still run in every check', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.test, /test:parallel/);
  assert.match(pkg.scripts.test, /test:serial/);
  assert.match(pkg.scripts['test:parallel'], /"test\/\*\*\/\*\.test\.ts"/);
  assert.match(pkg.scripts['test:serial'], /\.serial\.ts/);
  assert.doesNotMatch(pkg.scripts['test:serial'], /concurrency/);
  const serial = readdirSync('test').filter(f => f.endsWith('.serial.ts'));
  assert.ok(serial.includes('developer-performance-regression-lab.serial.ts'));
  assert.ok(!readdirSync('test').includes('developer-performance-regression-lab.test.ts'));
  const suite = readFileSync('docs/ops/server-suite.sh', 'utf8');
  assert.match(suite, /--test "test\/\*\*\/\*\.serial\.ts" >> "\$LOG"/);
  assert.match(readFileSync('docs/ops/DEPLOYMENT.md', 'utf8'), /cp \/opt\/sara-src\/docs\/ops\/server-suite\.sh \/root\/sara-server-suite\.sh/);
});
