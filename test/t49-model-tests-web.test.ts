// T49: Test my models, the web side (web/model-tests.js). The plan, progress and score sentences,
// the best list with ties, the score table, which models are "not tested yet", the request bodies and
// Undo, against canned answers shaped like the contract's /api/model-tests/* routes. Also the wiring
// in index.html, app.js and tips.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

/** web/model-tests.js in Node: its naming.js import becomes a small t() that fills {placeholders}. */
const mod = () => {
  const stub = 'const t = (s, p) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m));';
  const src = readFileSync(join(ROOT, 'web', 'model-tests.js'), 'utf8').replace(/^import \{ t \} from '\.\/naming\.js';$/m, stub);
  assert.ok(src.includes(stub), 'model-tests.js imports t from naming.js');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
};

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

// A /scores answer as the contract describes it.
const SCORES = {
  taskSet: 2,
  jobs: [
    { id: 'chat', label: 'Talking', tasks: 12 },
    { id: 'coding', label: 'Coding and long tasks', tasks: 10 },
    { id: 'quick', label: 'Quick replies', tasks: 8 },
  ],
  models: [
    { providerId: 'ollama', model: 'qwen3:8b', label: 'qwen3:8b', billing: 'local', local: true, testedAt: '2026-11-20T10:00:00Z', stale: false, scores: { chat: { score: 92, passed: 11, total: 12, firstMs: 900 }, coding: { score: 70, passed: 7, total: 10 }, quick: { score: 88, passed: 7, total: 8 } } },
    { providerId: 'openai', model: 'gpt-5-mini', label: 'gpt-5-mini', billing: 'api', local: false, testedAt: '2026-11-18T10:00:00Z', stale: true, scores: { chat: { score: 90, passed: 11, total: 12 }, coding: { score: 0, passed: 0, total: 0, error: 'timed out' } } },
    { providerId: 'claude', model: 'sonnet', label: 'Claude (sonnet)', billing: 'subscription', local: false, testedAt: '2026-11-20T11:00:00Z', stale: false, scores: { coding: { score: 100, passed: 10, total: 10 } } },
    { providerId: 'ollama', model: 'llama3.2:3b', label: 'llama3.2:3b', billing: 'local', local: true, stale: false, scores: {} },
  ],
  best: {
    chat: [
      { providerId: 'ollama', model: 'qwen3:8b', score: 92, tie: true, why: 'Tied with gpt-5-mini; runs on this computer' },
      { providerId: 'openai', model: 'gpt-5-mini', score: 90, tie: true, why: 'Tied with qwen3:8b' },
    ],
    coding: [
      { providerId: 'claude', model: 'sonnet', score: 100, tie: false, why: 'Highest score (10 of 10)' },
      { providerId: 'ollama', model: 'qwen3:8b', score: 70, tie: false, why: '' },
    ],
  },
  untested: [{ providerId: 'ollama', model: 'mistral:7b', label: 'mistral:7b' }],
};

test('T49 plan: models, calls, paid calls, subscription, about how long, and what is left out and why', async () => {
  const m = await mod();
  const v = m.planView({
    models: [
      { providerId: 'ollama', model: 'qwen3:8b', label: 'qwen3:8b', billing: 'local', included: true },
      { providerId: 'claude', model: 'sonnet', label: 'Claude (sonnet)', billing: 'subscription', included: true },
      { providerId: 'openai', model: 'gpt-5', label: 'gpt-5', billing: 'api', included: false, why: 'Paid by use and not ticked' },
    ],
    jobs: ['chat', 'coding', 'quick'],
    calls: 60,
    paidCalls: 0,
    minutes: 7.6,
  });
  assert.equal(v.empty, false);
  assert.deepEqual(v.lines, ['Tests 2 models on 3 jobs: 60 calls in all.', 'None of them are paid by use.', 'These count toward your subscription: Claude (sonnet).', 'About 8 minutes.']);
  assert.deepEqual(v.leftOut, [{ label: 'gpt-5', why: 'Paid by use and not ticked' }]);
  // Singular forms, paid calls, a long run.
  const one = m.planView({ models: [{ providerId: 'a', model: 'x', label: 'x', billing: 'api', included: true }], jobs: ['chat'], calls: 1, paidCalls: 1, minutes: 0.2 });
  assert.deepEqual(one.lines, ['Tests 1 model on 1 job: 1 call in all.', '1 of them is paid by use (your API key).', 'About a minute.']);
  assert.equal(m.planView({ models: [{ included: true, billing: 'api' }], jobs: ['a'], calls: 9, paidCalls: 9, minutes: 150 }).lines[1], '9 of them are paid by use (your API key).');
  assert.equal(m.aboutTime(150), 'About 3 hours.');
});

test('T49 plan: nothing to test, and no models connected, say so plainly', async () => {
  const m = await mod();
  const none = m.planView({ models: [{ providerId: 'openai', model: 'gpt-5', label: 'gpt-5', billing: 'api', included: false, why: 'Paid by use and not ticked' }], jobs: ['chat'], calls: 0, paidCalls: 0, minutes: 0 });
  assert.equal(none.empty, true);
  assert.deepEqual(none.lines, ['Nothing to test with these choices.']);
  assert.equal(none.leftOut.length, 1, 'the reason is still shown');
  const empty = m.planView({ models: [], jobs: [], calls: 0, paidCalls: 0, minutes: 0 });
  assert.equal(empty.empty, true);
  assert.match(empty.lines[0], /No models are connected yet/);
});

test('T49 request bodies follow the contract: all, one provider, compare 2 or 3 for one job, chosen models', async () => {
  const m = await mod();
  assert.deepEqual(m.requestBody({ kind: 'all', jobs: [], includePaid: false }).body, { scope: { kind: 'all' }, includePaid: false });
  assert.deepEqual(m.requestBody({ kind: 'all', jobs: ['chat', 'quick'], includePaid: true }).body, { scope: { kind: 'all' }, jobs: ['chat', 'quick'], includePaid: true });
  assert.equal(m.requestBody({ kind: 'provider', jobs: [] }).problem, 'Pick a provider.');
  assert.deepEqual(m.requestBody({ kind: 'provider', providerId: 'ollama', jobs: [] }).body, { scope: { kind: 'provider', providerId: 'ollama' }, includePaid: false });
  const a = { providerId: 'ollama', model: 'qwen3:8b' };
  const b = { providerId: 'openai', model: 'gpt-5-mini' };
  const c = { providerId: 'claude', model: 'sonnet' };
  assert.equal(m.requestBody({ kind: 'compare', models: [a, b] }).problem, 'Pick a job.');
  assert.equal(m.requestBody({ kind: 'compare', job: 'chat', models: [a, null, null] }).problem, 'Pick two or three models.');
  assert.equal(m.requestBody({ kind: 'compare', job: 'chat', models: [a, { ...a }] }).problem, 'Pick two or three models.', 'the same model twice is one');
  assert.deepEqual(m.requestBody({ kind: 'compare', job: 'coding', models: [a, null, b] }).body, { scope: { kind: 'models', models: [a, b] }, jobs: ['coding'], includePaid: false });
  assert.equal(m.requestBody({ kind: 'compare', job: 'coding', models: [a, b, c, { providerId: 'x', model: 'y' }] }).body.scope.models.length, 3);
  const many = Array.from({ length: 25 }, (_, i) => ({ providerId: 'p', model: `m${i}`, label: `m${i}` }));
  const body = m.requestBody({ kind: 'models', models: many, jobs: [] }).body;
  assert.equal(body.scope.kind, 'models');
  assert.equal(body.scope.models.length, 20, 'up to 20');
  assert.deepEqual(body.scope.models[0], { providerId: 'p', model: 'm0' }, 'only providerId and model are sent');
});

test('T49 progress: "Testing <model> for <job>, 14 of 96", the page line, stopped, done and failed', async () => {
  const m = await mod();
  const names = { model: (x: { model: string }) => `[${x.model}]`, job: (id: string) => ({ chat: 'Talking' })[id] ?? id };
  const run = { id: 'r1', state: 'running', done: 14, total: 96, current: { providerId: 'ollama', model: 'qwen3:8b', job: 'chat' }, startedAt: '2026-11-24T10:00:00Z' };
  assert.equal(m.progressText(run, names), 'Testing [qwen3:8b] for Talking, 14 of 96');
  assert.equal(m.pageLine(run, names), 'Testing models… 14 of 96');
  assert.equal(m.progressText({ ...run, current: undefined }, names), 'Testing models… 14 of 96');
  assert.equal(m.progressText({ ...run, state: 'done', done: 96 }, names), 'Model tests finished: 96 of 96.');
  assert.equal(m.progressText({ ...run, state: 'stopped' }, names), 'Stopped after 14 of 96. What finished is kept.');
  assert.equal(m.progressText({ ...run, state: 'failed', error: 'Ollama is not running' }, names), 'The model tests failed: Ollama is not running');
  assert.equal(m.progressText({ ...run, state: 'failed' }, names), 'The model tests failed.');
  assert.equal(m.progressText(null, names), '');
});

test('T49 scores are written honestly: "11 of 12 (92)", an error is "could not be tested", never 0', async () => {
  const m = await mod();
  assert.equal(m.scoreText({ score: 92, passed: 11, total: 12 }), '11 of 12 (92)');
  assert.equal(m.scoreText({ score: 0, passed: 0, total: 0, error: 'timed out' }), 'could not be tested');
  assert.equal(m.scoreText(undefined), '');
  const qwen = m.findModel(SCORES, { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(m.rowScoreText(qwen, 'chat'), 'Score 92, 11 of 12');
  assert.equal(m.rowScoreText(qwen, 'vision'), '', 'no score, no line');
  const gpt = m.findModel(SCORES, { providerId: 'openai', model: 'gpt-5-mini' });
  assert.equal(m.rowScoreText(gpt, 'chat'), 'Score 90, 11 of 12 · tested before the tests changed');
  assert.equal(m.rowScoreText(gpt, 'coding'), 'Model tests: could not be tested · tested before the tests changed');
  assert.equal(m.rowScoreText(null, 'chat'), '');
});

test('T49 best per job: the server order, labels and passed/total filled in, ties marked with the why sentence', async () => {
  const m = await mod();
  const chat = m.bestFor(SCORES, 'chat');
  assert.deepEqual(chat.map((b: { model: string }) => b.model), ['qwen3:8b', 'gpt-5-mini']);
  assert.equal(chat[0].tie, true);
  assert.equal(chat[0].why, 'Tied with gpt-5-mini; runs on this computer');
  assert.equal(m.entryText(chat[0]), 'qwen3:8b · 11 of 12 (92) · tied');
  assert.equal(chat[1].stale, true);
  const coding = m.bestFor(SCORES, 'coding');
  assert.equal(coding[0].label, 'Claude (sonnet)');
  assert.equal(m.entryText(coding[0]), 'Claude (sonnet) · 10 of 10 (100)');
  assert.deepEqual(m.bestFor(SCORES, 'vision'), [], 'no scores, nothing suggested');
  // No best list from the server: highest first, errors left out, within 3 points is a tie.
  const quick = m.bestFor({ ...SCORES, best: {} }, 'coding');
  assert.deepEqual(quick.map((b: { model: string }) => b.model), ['sonnet', 'qwen3:8b'], 'gpt-5-mini errored and is not ranked');
  assert.equal(quick[0].tie, false);
  const tied = m.rankJob({ models: [{ providerId: 'a', model: 'x', scores: { chat: { score: 82, passed: 8, total: 10 } } }, { providerId: 'b', model: 'y', scores: { chat: { score: 84, passed: 8, total: 10 } } }, { providerId: 'c', model: 'z', scores: { chat: { score: 50, passed: 5, total: 10 } } }] }, 'chat');
  assert.deepEqual(tied.map((r: { model: string; tie: boolean }) => [r.model, r.tie]), [['y', true], ['x', true], ['z', false]]);
  const apart = m.rankJob({ models: [{ providerId: 'a', model: 'x', scores: { chat: { score: 80, passed: 8, total: 10 } } }, { providerId: 'b', model: 'y', scores: { chat: { score: 84, passed: 8, total: 10 } } }] }, 'chat');
  assert.deepEqual(apart.map((r: { tie: boolean }) => r.tie), [false, false], 'four points apart is not a tie');
});

test('T49 the score table: every tested model × every job with a score, errors, stale marks, dates, the best cell', async () => {
  const m = await mod();
  const tbl = m.tableModel(SCORES);
  assert.deepEqual(tbl.jobs.map((j: { id: string }) => j.id), ['chat', 'coding', 'quick']);
  assert.deepEqual(tbl.rows.map((r: { label: string }) => r.label), ['qwen3:8b', 'gpt-5-mini', 'Claude (sonnet)'], 'a model with no scores is not a row');
  const [qwen, gpt, claude] = tbl.rows;
  assert.deepEqual(qwen.cells[0], { kind: 'score', text: '92', detail: '11 of 12', best: true, tie: true });
  assert.equal(qwen.cells[1].best, false);
  assert.equal(qwen.testedAt, '2026-11-20T10:00:00Z');
  assert.equal(gpt.stale, true);
  assert.deepEqual(gpt.cells[0], { kind: 'score', text: '90', detail: '11 of 12', best: false, tie: true }, 'both sides of a tie are marked');
  assert.deepEqual(gpt.cells[1], { kind: 'error', text: 'could not be tested', detail: 'timed out' });
  assert.deepEqual(gpt.cells[2], { kind: 'none', text: '' });
  assert.equal(claude.cells[1].best, true);
  assert.equal(claude.cells[1].tie, false);
  assert.deepEqual(m.tableModel({ jobs: SCORES.jobs, models: [], best: {} }), { jobs: [], rows: [] });
  assert.equal(m.noScores({ models: [{ scores: {} }] }), true);
  assert.equal(m.noScores(SCORES), false);
});

test('T49 not tested yet: the server list plus listed models with no scores, and the line for it', async () => {
  const m = await mod();
  const list = m.notTestedYet(SCORES);
  assert.deepEqual(list, [
    { providerId: 'ollama', model: 'mistral:7b', label: 'mistral:7b' },
    { providerId: 'ollama', model: 'llama3.2:3b', label: 'llama3.2:3b' },
  ]);
  assert.equal(m.untestedLine(list.length), '2 models not tested yet.');
  assert.equal(m.untestedLine(1), '1 model not tested yet.');
  assert.equal(m.untestedLine(0), '');
  assert.deepEqual(m.notTestedYet({ models: [], untested: [] }), []);
});

test('T49 Undo after Use the best for every job puts the previous models back', async () => {
  const m = await mod();
  const changed = [
    { job: 'chat', providerId: 'ollama', model: 'qwen3:8b', backups: [{ providerId: 'openai', model: 'gpt-5-mini' }] },
    { job: 'coding', providerId: 'claude', model: 'sonnet', backups: [] },
  ];
  const before = { chat: { providerId: 'openai', model: 'gpt-5-mini' }, writing: { providerId: 'openai', model: 'gpt-5' } };
  // No `previous` from the server: the snapshot taken before.
  const prev = m.previousRoutes({ changed }, before);
  assert.deepEqual(prev, { chat: { providerId: 'openai', model: 'gpt-5-mini' }, coding: null });
  // The server's `previous` wins, as a list or a map.
  assert.deepEqual(m.previousRoutes({ changed, previous: [{ job: 'chat', providerId: 'ollama', model: 'old', fallbacks: [{ providerId: 'a', model: 'b' }] }, { job: 'coding', route: null }] }, before), { chat: { providerId: 'ollama', model: 'old', fallbacks: [{ providerId: 'a', model: 'b' }] }, coding: null });
  assert.deepEqual(m.previousRoutes({ changed, previous: { chat: { providerId: 'x', model: 'y' } } }, before), { chat: { providerId: 'x', model: 'y' }, coding: null });
  const now = { chat: { providerId: 'ollama', model: 'qwen3:8b' }, coding: { providerId: 'claude', model: 'sonnet' }, writing: { providerId: 'openai', model: 'gpt-5' } };
  assert.deepEqual(m.undoRoutes(now, prev), { chat: { providerId: 'openai', model: 'gpt-5-mini' }, writing: { providerId: 'openai', model: 'gpt-5' } }, 'a job without its own model before goes back to the default');
});

test('T49 wiring: the button, dialog, live line, results, the setting with its tip, the event and the settings body', () => {
  const html = web('index.html');
  const page = /<section class="settings-page" data-page="models-routes"[\s\S]*?<\/section>/.exec(html)![0];
  assert.match(page, /id="jobs-recommend"[^>]*>[^<]*<\/button>\s*<button id="mtest-open" type="button" class="ghost" data-mtest hidden>Test my models…<\/button>/, 'next to Use recommended');
  for (const id of ['mtest-live', 'mtest-results', 'mtest-auto-new']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(html, /<dialog id="model-tests-dialog" aria-label="Test my models">/);
  for (const id of ['mtest-setup', 'mtest-plan', 'mtest-start', 'mtest-status', 'mtest-progress', 'mtest-done']) assert.match(html, new RegExp(`<dialog id="model-tests-dialog"[\\s\\S]*?id="${id}"[\\s\\S]*?</dialog>`), id);
  const tips = JSON.parse(web('tips.json')).tips;
  assert.ok(tips['mtest-auto-new'], 'the setting has a ? tip');
  assert.match(tips['mtest-auto-new'][0], /own computer/);
  assert.match(tips['mtest-auto-new'][0], /costs nothing/);
  assert.ok(tips['mtest-auto-new'][0].length <= 260);
  const app = web('app.js');
  assert.match(app, /import \{ initModelTests, modelTestsRoutes, modelTestsSettings, onModelTestsEvent \} from '\.\/model-tests\.js';/);
  assert.match(app, /es\.addEventListener\('model-tests', \(e\) => onModelTestsEvent\(JSON\.parse\(e\.data\)\)\)/, 'the live event');
  assert.match(app, /\.\.\.modelTestsSettings\(\),\n {2}\};\n {2}await api\('\/settings', \{ method: 'PUT', body \}\);/, 'the tick saves with the page');
  const js = web('model-tests.js');
  for (const route of ['/model-tests/plan', '/model-tests/start', '/model-tests/status', '/model-tests/stop', '/model-tests/scores', '/model-tests/apply']) assert.ok(js.includes(`'${route}'`), route);
  assert.match(js, /err\?\.status === 404/, 'an older server hides the feature');
  assert.doesNotMatch(js + page, /benchmark/i, 'the word is "model tests"');
});
