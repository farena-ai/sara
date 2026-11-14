// Leftover 7: a clone or worktree without the developer tools' own packages gets a clear message
// (and `npm run hydrate:tools`) instead of seven unexplained "Cannot find module" typecheck errors.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { missingToolPackages } from '../scripts/hydrate-tools.ts';
import { ROOT, tempDir } from './helpers.ts';

test('Leftover 7: missing tool packages are named, present ones are not', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'test'));
  // (Split so this file's own text isn't read as an import by the real check.)
  const tools = ['..', 'tools'].join('/');
  writeFileSync(join(dir, 'test', 'a.test.ts'), `import Ajv from '${tools}/tool-a/node_modules/ajv/dist/ajv.js';\nconst p = await import('${tools}/tool-b/node_modules/x/index.js');\n`);
  writeFileSync(join(dir, 'test', 'b.test.ts'), `import Ajv from '${tools}/tool-a/node_modules/ajv/dist/ajv.js';\nimport { y } from '../src/y.ts';\n`);
  assert.deepEqual([...missingToolPackages(dir)], [['tool-a', ['ajv/dist/ajv.js']], ['tool-b', ['x/index.js']]]);
  mkdirSync(join(dir, 'tools', 'tool-a', 'node_modules', 'ajv', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'tool-a', 'node_modules', 'ajv', 'dist', 'ajv.js'), '');
  assert.deepEqual([...missingToolPackages(dir)], [['tool-b', ['x/index.js']]]);
});

test('Leftover 7: typecheck checks the tool packages first; hydrate:tools installs them', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['hydrate:tools'], 'node scripts/hydrate-tools.ts');
  assert.match(pkg.scripts.typecheck, /^node scripts\/hydrate-tools\.ts --check && tsc -p tsconfig\.json$/);
  // This checkout (the tests ran) has them; --check is quiet and succeeds.
  assert.equal(execFileSync(process.execPath, [join(ROOT, 'scripts', 'hydrate-tools.ts'), '--check'], { encoding: 'utf8' }), '');
});
