// Leftover 13: the guide's generated parts (help.html index and dials, HOW_DO_I.md, START_HERE's
// answer count, the / menu tables) are checked against their sources in every `npm run check`, with
// the fix in the message, so the counts no longer drift between phases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

test('Leftover 13: gen-guide --check passes (else: npm run guide)', () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.guide, 'node scripts/gen-guide.ts');
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-guide.ts'), '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    assert.fail(String((err as { stderr?: string }).stderr || err));
  }
  assert.equal(out, '', '--check writes nothing');
});
