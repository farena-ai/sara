// T51 item 4: the time estimate learns. A model tested before is counted at the median time of its
// earlier answers (errors left out); a model never tested keeps the fixed guess; the plan says which.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TASK_SET, tasksFor } from '../src/model-test-tasks.ts';
import { ROOT } from './helpers.ts';
import { api, models, world } from './t51-model-tests-world.ts';

test('plan minutes: the median of earlier answers per model, the fixed guess for a model never tested', async (t) => {
  const w = await world(t);
  const body = models(['good:8b', 'weak:8b'], ['quick']);
  const calls = tasksFor('quick').length + 1; // and one warm-up each, on the owner's hardware
  // Nothing tested yet: about 10 s a call on the owner's hardware, one provider.
  let p = (await api(w, '/api/model-tests/plan', 'POST', body)).json;
  assert.equal(p.calls, 2 * calls);
  assert.equal(p.estimate, 'guess');
  assert.equal(p.minutes, Math.ceil((2 * calls * 10) / 60));

  // good:8b answered in 30 s each time before (one quick answer and one error do not move the median).
  const ins = w.app.store.db.prepare('INSERT INTO model_test_results (provider_id, model, task_id, task_set, pass, reason, error, first_ms, total_ms, at, run) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?)');
  const ids = tasksFor('chat').map((x) => x.id);
  ins.run('home', 'good:8b', ids[0], TASK_SET, 'ok', null, 1_000, '2026-11-20T00:00:00Z', 'old');
  ins.run('home', 'good:8b', ids[1], TASK_SET, 'ok', null, 30_000, '2026-11-20T00:00:00Z', 'old');
  ins.run('home', 'good:8b', ids[2], TASK_SET, 'ok', null, 30_000, '2026-11-20T00:00:00Z', 'old');
  ins.run('home', 'good:8b', ids[3], TASK_SET, 'error', 'No answer within 60 seconds.', 600_000, '2026-11-20T00:00:00Z', 'old');
  p = (await api(w, '/api/model-tests/plan', 'POST', body)).json;
  assert.equal(p.estimate, 'mixed');
  assert.equal(p.minutes, Math.ceil((calls * 30 + calls * 10) / 60));

  // Both known: from earlier tests only (an older task set counts too: it is the same model).
  ins.run('home', 'weak:8b', ids[0], TASK_SET - 1, 'ok', null, 3_000, '2026-10-01T00:00:00Z', 'old');
  p = (await api(w, '/api/model-tests/plan', 'POST', body)).json;
  assert.equal(p.estimate, 'measured');
  assert.equal(p.minutes, Math.ceil((calls * 30 + calls * 3) / 60));
  // Planning asked no model.
  assert.deepEqual(w.calls, {});
});

const mod = () => {
  const stub = 'const t = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m));';
  const src = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8').replace(/^import \{ t \} from '\.\/naming\.js';$/m, stub);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
};

test('web: the plan says "about" and how the time was worked out', async () => {
  const m = await mod();
  const base = { models: [{ providerId: 'a', model: 'x', label: 'x', billing: 'local', included: true }], jobs: ['chat'], calls: 742, paidCalls: 0, minutes: 41 };
  assert.deepEqual(m.planView({ ...base, estimate: 'measured' }).lines.slice(-2), ['About 41 minutes.', 'Worked out from how long these models took in earlier tests.']);
  assert.equal(m.planView({ ...base, estimate: 'mixed' }).lines.at(-1), 'Worked out from earlier tests where there are any, and a rough guess for models never tested.');
  assert.equal(m.planView({ ...base, estimate: 'guess' }).lines.at(-1), 'A rough guess: these models were not tested before.');
  assert.equal(m.planView(base).lines.at(-1), 'About 41 minutes.', 'an older server without `estimate`: no extra line');
});
