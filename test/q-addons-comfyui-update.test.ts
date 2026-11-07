// Q-ADDONS: the B2 ComfyUI recipe text reaches existing installs only as a higher Store version.
// 1.0.1 must be an update of the signed 1.0.0 (same server name, same command, same field key) so
// the update review keeps the saved ComfyUI address (src/store/install.ts, test/phase125.test.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recipeDiff } from '../src/store/install.ts';
import { recipeProblems } from '../src/store/checks.ts';
import { parseRecipe } from '../src/store/format.ts';
import { ROOT } from './helpers.ts';

const now = JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'comfyui.json'), 'utf8'));
// The recipe as signed in the Store's 1.0.0 (before B2 fix 4), kept here as the update's starting point.
const signed100 = { ...now.mcp, fields: [{ ...now.mcp.fields[0], tip: "Where ComfyUI is running. On the same computer as Sara it's usually http://127.0.0.1:8188." }] };

test('Q-ADDONS: the ComfyUI recipe is 1.0.1, an update of the signed 1.0.0 that keeps the saved address', () => {
  assert.equal(now.version, '1.0.1');
  assert.deepEqual(recipeProblems(now.mcp), []);
  assert.ok(now.changes.some((c: string) => /another computer/.test(c)), 'the change is listed');
  const a = parseRecipe(signed100);
  const b = parseRecipe(now.mcp);
  assert.equal(b.name, a.name, 'same server name, so the update replaces the installed one');
  assert.deepEqual(b.fields.map((f) => f.key), ['COMFYUI_URL'], 'same field key, so the saved address carries over');
  assert.deepEqual(recipeDiff(a, b).filter((x) => /^Now runs|Asks for something new|A new secret|now runs on its own/.test(x)), [], 'nothing new runs, is asked for or becomes automatic');
});

test('Q-ADDONS: the Playwright recipe 1.0.1 says it needs Chrome where Sara runs (it never downloads one)', () => {
  const pw = JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'playwright.json'), 'utf8'));
  assert.equal(pw.version, '1.0.1');
  assert.deepEqual(recipeProblems(pw.mcp), []);
  assert.ok(pw.needs.includes('app:Google Chrome'));
  assert.ok(parseRecipe(pw.mcp).needs?.includes('app:Google Chrome'), 'the install card lists it');
  assert.doesNotMatch(pw.mcp.guide.join(' '), /downloads the browser/);
});
