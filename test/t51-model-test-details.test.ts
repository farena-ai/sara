// T51 item 1: why a model got its score. Every task has a plain title; GET /api/model-tests/details
// returns the job's tasks with pass or fail, a plain reason and the time, and never a prompt or a
// reply. The web side's "Why this score" lines, against canned answers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TASKS, tasksFor } from '../src/model-test-tasks.ts';
import { plainReason } from '../src/model-tests.ts';
import { ROOT } from './helpers.ts';
import { api, models, world } from './t51-model-tests-world.ts';

test('every task has a short plain title, and no two tasks share one', () => {
  for (const t of TASKS) {
    assert.ok(t.title && t.title.length >= 10 && t.title.length <= 60, `${t.id}: "${t.title}"`);
    assert.match(t.title, /^[A-Z]/, `${t.id} starts with a capital`);
    assert.doesNotMatch(t.title, /[.!?]$/, `${t.id} is a title, not a sentence with a full stop`);
    assert.doesNotMatch(t.title, /benchmark/i);
  }
  assert.equal(new Set(TASKS.map((t) => t.title)).size, TASKS.length);
  // The titles are server strings shown to people, so they are en('…') texts the extractor finds.
  for (const f of ['model-test-tasks.ts', 'model-test-hard.ts']) assert.match(readFileSync(join(ROOT, 'src', f), 'utf8'), /title: en\(/);
});

test('plainReason: the fixed reasons become plain sentences; errors and timeouts say what happened; the rest is kept', () => {
  assert.deepEqual(plainReason('empty reply', false), { reason: 'It gave no answer.' });
  assert.deepEqual(plainReason('not the asked JSON', false), { reason: 'It did not answer in the form asked for.' });
  assert.deepEqual(plainReason('no tool call', false), { reason: 'It did not use a tool.' });
  assert.deepEqual(plainReason('error', false, 'No answer within 60 seconds.'), { reason: 'No answer within {s} seconds.', params: { s: 60 } });
  assert.deepEqual(plainReason('not asked', false, 'Skipped after 3 errors in a row.'), { reason: 'Skipped after {n} errors in a row.', params: { n: 3 } });
  assert.deepEqual(plainReason('error', false, '500 model crashed'), { reason: 'It could not be asked: {error}', params: { error: '500 model crashed' } });
  assert.deepEqual(plainReason('also flagged harmless line 7', false), { reason: 'It flagged line {line}, which has no problem.', params: { line: 7 } });
  assert.deepEqual(plainReason('called set_alarm instead of add_reminder', false), { reason: 'It used the wrong tool ({got} instead of {want}).', params: { got: 'set_alarm', want: 'add_reminder' } });
  assert.deepEqual(plainReason('ran and gave [6,0,0,4]', true), { reason: 'Its code ran and gave the right result.' });
  assert.deepEqual(plainReason('ran and gave [1] instead of [2]', false), { reason: 'Its code ran but gave a wrong result.' });
  assert.deepEqual(plainReason('check failed: boom', false), { reason: 'Its answer could not be checked.' });
  assert.deepEqual(plainReason('kept the persona rules', true), { reason: 'kept the persona rules' }, 'no fixed sentence: kept as it is');
});

test('GET /details: the job\'s tasks with title, pass, reason and time; never a prompt or a reply; 400 and 404', async (t) => {
  const w = await world(t);
  await api(w, '/api/model-tests/start', 'POST', models(['good:8b', 'weak:8b', 'blank:8b'], ['quick', 'coding']));
  await w.tests.idle();
  const q = (model: string, job: string) => `/api/model-tests/details?providerId=home&model=${encodeURIComponent(model)}&job=${job}`;
  const good = await api(w, q('good:8b', 'quick'));
  assert.equal(good.status, 200);
  const d = good.json;
  assert.deepEqual(Object.keys(d).sort(), ['job', 'label', 'model', 'passed', 'providerId', 'stale', 'taskSet', 'tasks', 'testedAt', 'total']);
  assert.equal(d.label, 'Home: good:8b');
  assert.equal(d.stale, false);
  const Q = tasksFor('quick');
  assert.deepEqual(d.tasks.map((x: { id: string }) => x.id), Q.map((x) => x.id), 'in the order of the job');
  assert.equal(d.passed, Q.length);
  assert.equal(d.total, Q.length);
  for (const x of d.tasks) {
    for (const k of Object.keys(x)) assert.ok(['id', 'title', 'pass', 'reason', 'params', 'ms'].includes(k), k);
    assert.equal(x.title, Q.find((y) => y.id === x.id)!.title);
    assert.equal(typeof x.ms, 'number');
  }
  // Nothing of a task's prompt or a model's reply is sent.
  const raw = JSON.stringify(d);
  for (const task of Q) if (task.kind === 'chat') assert.ok(!raw.includes(task.prompt.slice(0, 30)), task.id);
  assert.ok(!raw.includes('yellow'), 'the reply to quick-word is not in it');

  const weak = (await api(w, q('weak:8b', 'coding'))).json;
  assert.ok(weak.tasks.some((x: { pass: boolean }) => !x.pass));
  assert.equal(weak.passed, weak.tasks.filter((x: { pass: boolean }) => x.pass).length);
  const blank = (await api(w, q('blank:8b', 'quick'))).json;
  assert.ok(blank.tasks.every((x: { pass: boolean; reason: string }) => !x.pass && x.reason === 'It gave no answer.'));

  assert.equal((await api(w, q('good:8b', 'writing'))).status, 404, 'not tested for that job');
  assert.equal((await api(w, q('nobody:1b', 'quick'))).status, 404);
  assert.equal((await api(w, q('good:8b', 'dancing'))).status, 400);
  assert.equal((await api(w, '/api/model-tests/details?job=quick')).status, 400);
});

/** web/model-tests.js in Node, with a t() that fills {placeholders} (as in test/t49-model-tests-web.test.ts). */
const mod = () => {
  const stub = 'const t = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m));';
  const src = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8').replace(/^import \{ t \} from '\.\/naming\.js';$/m, stub);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
};

test('web: "Why this score" lines from a canned /details answer, a tick or a cross, the reason filled in, the time', async () => {
  const m = await mod();
  const d = {
    providerId: 'ollama',
    model: 'qwen3:8b',
    label: 'Home: qwen3:8b',
    job: 'quick',
    taskSet: 2,
    stale: false,
    testedAt: '2026-11-20T10:00:00Z',
    passed: 1,
    total: 3,
    tasks: [
      { id: 'quick-word', title: 'Answers in one word', pass: true, reason: 'said yellow', ms: 840, prompt: 'SHOULD NOT SHOW', reply: 'SHOULD NOT SHOW' },
      { id: 'quick-math', title: 'Multiplies two numbers', pass: false, reason: 'No answer within {s} seconds.', params: { s: 20 }, ms: 20000 },
      { id: 'quick-sale', title: 'Works out a sale price', pass: false, reason: 'It gave no answer.' },
    ],
  };
  const rows = m.whyRows(d);
  assert.deepEqual(
    rows.map((r: { ok: boolean; title: string; reason: string }) => [r.ok, r.title, r.reason]),
    [
      [true, 'Answers in one word', 'said yellow'],
      [false, 'Multiplies two numbers', 'No answer within 20 seconds.'],
      [false, 'Works out a sale price', 'It gave no answer.'],
    ],
  );
  assert.match(rows[0].time, /0[.,]8/);
  assert.match(rows[1].time, /20/);
  assert.equal(rows[2].time, '', 'no time, no text');
  assert.ok(!JSON.stringify(rows).includes('SHOULD NOT SHOW'), 'a prompt or a reply is never shown');
  assert.match(m.whyHead(d, 'Quick replies'), /^Home: qwen3:8b for Quick replies: passed 1 of 3, tested .+\.$/);
  assert.equal(m.whyHead({ ...d, testedAt: undefined, stale: true }, 'Quick replies'), 'Home: qwen3:8b for Quick replies: passed 1 of 3. Tested before the tests changed.');
  assert.deepEqual(m.whyRows(null), []);
  assert.equal(m.secondsText(undefined), '');
});

test('web wiring: the Why dialog, the Why? button by the best model, score cells as buttons, the details route', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<dialog id="mtest-why" class="small-dialog" aria-labelledby="mtest-why-title">[\s\S]*?id="mtest-why-head"[\s\S]*?id="mtest-why-list"[\s\S]*?<\/dialog>/);
  const js = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8');
  assert.ok(js.includes('`/model-tests/details?${new URLSearchParams({ providerId: m.providerId, model: m.model, job })}`'));
  assert.match(js, /button\(t\('Why\?'\), \(\) => void openWhy\(top, j\.id\)/);
  assert.match(js, /button\('', \(\) => void openWhy\(r\.ref, job\.id\), 'mtest-cell'\)/);
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  for (const c of ['.mtest-cell', '.mtest-why-list', '.mtest-why-mark']) assert.ok(css.includes(c), c);
});
