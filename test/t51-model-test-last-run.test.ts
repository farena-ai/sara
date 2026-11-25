// T51 item 3: a run that ended while the page was closed is shown when the page opens. The runs
// table keeps how far a run got and why it ended; after a restart /status returns the last finished
// run for a day ("The last run stopped: …" / "The last run finished 2 hours ago.").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tasksFor } from '../src/model-test-tasks.ts';
import { LAST_RUN_MS, ModelTests, RESTARTED } from '../src/model-tests.ts';
import { ROOT, tempDir } from './helpers.ts';
import { api, models, world } from './t51-model-tests-world.ts';

test('after a restart /status returns the last finished run, with how far it got, for a day', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const first = await world(t, { dir, keep: true });
  assert.deepEqual((await api(first, '/api/model-tests/status')).json, { run: null }, 'nothing ran yet');
  const { runId } = (await api(first, '/api/model-tests/start', 'POST', models(['good:8b', 'weak:8b'], ['quick']))).json;
  await first.tests.idle();
  await first.close();

  // A new server on the same data: the run it finished is still there.
  const again = await world(t, { dir, keep: true, token: first.token });
  const st = (await api(again, '/api/model-tests/status')).json;
  const Q = tasksFor('quick').length;
  assert.deepEqual(Object.keys(st.run).sort(), ['done', 'endedAt', 'id', 'startedAt', 'state', 'total']);
  assert.equal(st.run.id, runId);
  assert.equal(st.run.state, 'done');
  assert.equal(st.run.done, 2 * Q);
  assert.equal(st.run.total, 2 * Q);
  // A day later it is no longer shown.
  again.clock.now = new Date(Date.parse(st.run.endedAt) + LAST_RUN_MS + 60_000);
  assert.equal((await api(again, '/api/model-tests/status')).json.run, null);
});

test('a run the server stopped in the middle, and a failed run, come back with their reason', async (t) => {
  const w = await world(t);
  const db = w.app.store.db;
  db.prepare("INSERT INTO model_test_runs (id, lineage, background, state, started_at, done, total) VALUES ('mt-a', 'mt-a', 0, 'running', '2026-11-24T09:00:00.000Z', 14, 96)").run();
  // As at start-up after a crash or restart.
  const after = new ModelTests(w.app);
  assert.deepEqual(after.status().run, { id: 'mt-a', state: 'stopped', done: 14, total: 96, startedAt: '2026-11-24T09:00:00.000Z', endedAt: w.clock.now.toISOString(), error: RESTARTED });
  db.prepare("INSERT INTO model_test_runs (id, lineage, background, state, started_at, ended_at, done, total, error) VALUES ('mt-b', 'mt-b', 0, 'failed', '2026-11-24T09:30:00.000Z', '2026-11-24T09:40:00.000Z', 3, 40, 'Ollama is not running')").run();
  assert.equal(after.status().run?.state, 'failed');
  assert.equal(after.status().run?.error, 'Ollama is not running');
});

test('a run that finished keeps its counts and no reason', async (t) => {
  const w = await world(t);
  await api(w, '/api/model-tests/start', 'POST', models(['good:8b', 'weak:8b'], ['quick']));
  await w.tests.idle();
  const row = w.app.store.db.prepare('SELECT state, done, total, error FROM model_test_runs').get() as { state: string; done: number; total: number; error: string | null };
  assert.deepEqual({ ...row }, { state: 'done', done: row.total, total: row.total, error: null });
});

const mod = () => {
  const stub = 'const t = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m));';
  const src = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8').replace(/^import \{ t \} from '\.\/naming\.js';$/m, stub);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
};

test('web: the line for the last run when the page opens', async () => {
  const m = await mod();
  const now = Date.parse('2026-11-24T12:00:00Z');
  const run = { id: 'mt-a', state: 'done', done: 96, total: 96, startedAt: '2026-11-24T09:00:00Z', endedAt: '2026-11-24T10:00:00Z' };
  assert.equal(m.lastRunText(run, now), 'The last run finished 2 hours ago.');
  assert.equal(m.lastRunText({ ...run, endedAt: '2026-11-24T11:59:40Z' }, now), 'The last run finished just now.');
  assert.equal(m.lastRunText({ ...run, endedAt: '2026-11-24T11:59:00Z' }, now), 'The last run finished 1 minute ago.');
  assert.equal(m.lastRunText({ ...run, endedAt: '2026-11-24T11:35:00Z' }, now), 'The last run finished 25 minutes ago.');
  assert.equal(m.lastRunText({ ...run, endedAt: '2026-11-24T10:30:00Z' }, now), 'The last run finished 1 hour ago.');
  assert.equal(m.lastRunText({ ...run, state: 'stopped', done: 14, error: 'The server restarted during the run.' }, now), 'The last run stopped: The server restarted during the run.');
  assert.equal(m.lastRunText({ ...run, state: 'failed', error: 'Ollama is not running' }, now), 'The last run stopped: Ollama is not running');
  assert.equal(m.lastRunText({ ...run, state: 'failed' }, now), 'The last run stopped because of an error.');
  assert.equal(m.lastRunText({ ...run, state: 'stopped', done: 14 }, now), 'The last run was stopped after 14 of 96. What finished is kept.');
  assert.equal(m.lastRunText({ ...run, state: 'running' }, now), '');
  assert.equal(m.lastRunText(null, now), '');
  const js = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8');
  assert.match(js, /mt\.before = true;/, 'a run from /status that was not seen live is marked');
  assert.match(js, /before \? lastRunText\(run\) : pageLine\(run, names\)/);
});
