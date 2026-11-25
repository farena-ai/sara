// T51 item 2: in the results each backup model has its own "Use", not only the best one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const mod = () => {
  const stub = 'const t = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m));';
  const src = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8').replace(/^import \{ t \} from '\.\/naming\.js';$/m, stub);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
};

test('the backups of a job carry what Use needs: provider, model and a label', async () => {
  const m = await mod();
  const data = {
    jobs: [{ id: 'chat', label: 'Talking', tasks: 12 }],
    models: [
      { providerId: 'home', model: 'a', label: 'Home: a', scores: { chat: { score: 92, passed: 11, total: 12 } } },
      { providerId: 'home', model: 'b', label: 'Home: b', scores: { chat: { score: 83, passed: 10, total: 12 } } },
      { providerId: 'plan', model: 'c', label: 'Plan: c', scores: { chat: { score: 75, passed: 9, total: 12 } } },
    ],
    best: { chat: [{ providerId: 'home', model: 'a', score: 92, tie: false, why: '' }, { providerId: 'home', model: 'b', score: 83, tie: false, why: '' }, { providerId: 'plan', model: 'c', score: 75, tie: false, why: '' }] },
  };
  const backups = m.bestFor(data, 'chat').slice(1);
  assert.deepEqual(backups.map((b: { providerId: string; model: string; label: string }) => [b.providerId, b.model, b.label]), [['home', 'b', 'Home: b'], ['plan', 'c', 'Plan: c']]);
  assert.equal(m.entryText(backups[0]), 'Home: b · 10 of 12 (83)');
});

test('each backup line has a Use button that sets the job to that model, with its own name for screen readers', () => {
  const js = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8');
  const block = /\/\/ Each backup can be used too[\s\S]*?main\.append\(backs\);/.exec(js)?.[0] ?? '';
  assert.match(block, /for \(const b of best\.slice\(1\)\)/);
  assert.match(block, /button\(t\('Use'\), \(\) => void useOne\(j\.id, b\), 'ghost small'\)/);
  assert.match(block, /t\('Use \{model\} for \{job\}'/);
  assert.doesNotMatch(js, /best\.slice\(1\)\.map\(entryText\)\.join/, 'no longer one line of text without buttons');
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(css, /\.mtest-backup \{ display: flex; flex-wrap: wrap;/, 'wraps at 390 px');
});
