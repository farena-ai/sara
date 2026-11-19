// ROADMAP_W W0.1: real-model qualification round 2. The U1 real-model suite (scripts/eval-real.ts) gets one
// task per ROADMAP_V feature; its runs are published as sanitized summaries (docs/results/real-runs-*.json)
// and shown on the benchmark page (docs/results/index.html) next to the coding benchmark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPage } from '../scripts/bench-compare.ts';
import { normLean, planFor } from '../src/lean.ts';
import { renewalsOf } from '../src/renewals.ts';
import { createFactsTools } from '../src/tools/facts.ts';
import { createLibraryTool } from '../src/library/use.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { makeApp, tempDir } from './helpers.ts';
import { realSummary, type RealSummary } from '../scripts/real-runs-publish.ts';

const ROOT = join(import.meta.dirname, '..');

const fakeResults = () => ({
  version: '9.9.9', model: 'local-model:9b', judge: 'judge:4b', started: '2026-11-19T12:00:00.000Z',
  tasks: {
    'v-canvas': { id: 'v-canvas', feature: 'D3 live checklist', goal: 'g', status: 'pass', ms: 12_000, tokens: { input: 900, output: 90, calls: 2 }, judge: { model: 'judge:4b', score: 5, reason: 'fine', ms: 1 }, checks: [{ name: 'a', ok: true }], turns: [{ user: 'my secret question', reply: 'C:\\Users\\someone\\private reply', tools: [{ name: 'canvas_post', status: 'ok', output: 'private output' }], cards: [], claims: [], errors: [], ms: 1 }], at: '', model: 'local-model:9b' },
    'v-waiting': { id: 'v-waiting', feature: 'V1.2 waiting on you', goal: 'g', status: 'fail', ms: 8_000, tokens: { input: 800, output: 80, calls: 1 }, judge: { model: 'judge:4b', score: 2, reason: 'missed it', ms: 1 }, checks: [{ name: 'reply mentions the overdue registration reminder', ok: false, detail: 'private detail' }], turns: [], at: '', model: 'local-model:9b' },
  },
});

test('W0.1 the published real-run summary keeps scores, features and failed check names; no replies, prompts or paths', () => {
  const s = realSummary(fakeResults() as never, 'after', ['v-canvas', 'v-waiting']);
  assert.equal(s.label, 'after');
  assert.equal(s.model, 'local-model:9b');
  assert.equal(s.passed, 1);
  assert.equal(s.of, 2);
  assert.equal(s.judgeAvg, 3.5);
  assert.deepEqual(s.runs.map((r) => [r.task, r.pass]), [['v-canvas', true], ['v-waiting', false]]);
  assert.deepEqual(s.runs[1]!.failed, ['reply mentions the overdue registration reminder']);
  assert.match(s.command, /node scripts\/eval-real\.ts --model local-model:9b/);
  const text = JSON.stringify(s);
  assert.ok(!/secret|Users|someone|private|missed it/.test(text), text);
});

test('W0.1 the benchmark page shows every real-model run, task by task, escaped and offline', () => {
  const before: RealSummary = realSummary(fakeResults() as never, 'before');
  const after: RealSummary = { ...realSummary(fakeResults() as never, 'after'), passed: 2, runs: before.runs.map((r) => ({ ...r, pass: true, failed: [] })) };
  const html = buildPage({ sara: [], others: [], real: [before, { ...after, model: 'm<x>' }], built: '2026-11-19' });
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(plain, /Everyday tasks with a real local model/);
  assert.match(plain, /1\/2/);
  assert.match(plain, /2\/2/);
  assert.match(html, /m&lt;x&gt;/, 'model names are escaped');
  assert.match(plain, /v-waiting/);
  assert.match(plain, /V1\.2 waiting on you/);
  assert.match(plain, /node scripts\/eval-real\.ts/);
  assert.ok(!/<script|<link|@import/i.test(html));
  // No real runs: the page is the coding benchmark only (older pages stay byte-identical).
  assert.ok(!/Everyday tasks/.test(buildPage({ sara: [], others: [], built: '2026-11-19' })));
});

test('W0.1 the real-model suite has one task per ROADMAP_V feature plus W0.6 and W0.7', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'eval-real.ts'), 'utf8');
  for (const id of ['v-canvas', 'v-second-opinion', 'v-receipts', 'v-renewals', 'v-purchases', 'v-interpreter', 'v-movein', 'v-waiting', 'v-friend-time', 'v-myapps', 'v-timeline', 'v-time', 'v-always']) {
    assert.ok(src.includes(`id: '${id}'`), id);
  }
  assert.match(src, /'publish':|publish: \{ type: 'string'/, 'eval-real.ts can publish its summary');
});

// ---- fixes from the before run (docs/RESULTS.md "Real-model qualification, round 2")

function rig(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  t.after(() => { app.store.close(); cleanup(); });
  return app;
}

test('W0.1 renewal_add: a date he tells her lands in Renewals with a reminder before it (v-renewals)', async (t) => {
  const app = rig(t);
  const tool = createFactsTools(() => app).find((x) => x.spec.name === 'renewal_add')!;
  assert.ok(tool, 'renewal_add exists');
  const conv = app.store.createConversation({ title: 'x' });
  const out = String(await tool.run({ title: 'Passport', date: '2027-03-31' }, { conversationId: conv.id, workspaceDir: '', signal: AbortSignal.timeout(5000) } as never));
  const row = renewalsOf(app).find((r) => /passport/i.test(r.title));
  assert.ok(row, out);
  assert.equal(row!.date, '2027-03-31');
  assert.equal(row!.what, 'passport');
  assert.ok(row!.reminder && row!.reminder.dueAt < '2027-03-31', JSON.stringify(row));
  assert.match(out, /Renewals/);
  assert.match(out, /reminder/i);
  // No reminder when he says so; a made-up date is refused with the page's own words.
  await tool.run({ title: 'Car insurance', date: '2027-06-01', remind: false }, { conversationId: conv.id } as never);
  assert.equal(renewalsOf(app).find((r) => /insurance/i.test(r.title))?.reminder, null);
  await assert.rejects(() => tool.run({ title: 'Passport', date: 'next spring' }, { conversationId: conv.id } as never) as Promise<unknown>, /2027-03-31/);
});

test('W0.1 "keep track of that renewal" offers renewal_add (lean words: renewal, expires)', (t) => {
  const app = rig(t);
  for (const x of createFactsTools(() => app)) app.tools.add(x);
  app.settings.update({ lean: normLean({ tools: { mode: 'always' } }) } as never);
  const conv = app.store.createConversation({ title: 'x' });
  const plan = planFor(app, conv, 'My passport expires on March 31, 2027. Keep track of that renewal for me and remind me in time.');
  assert.ok(plan.offered.has('renewal_add'), [...plan.offered.keys()].join(','));
});

test('W0.1 her prompt sends "bring everything over from ChatGPT" to the settings guide (Move in) and renewals to renewal_add (v-movein)', (t) => {
  const app = rig(t);
  const p = buildSystemPrompt(app.persona, { now: new Date(), ownerName: 'Alex', tools: ['settings_guide', 'facts_list', 'fact_forget', 'renewal_add'] } as never);
  assert.match(p, /ChatGPT/);
  assert.match(p, /settings_guide/);
  assert.match(p, /renewal_add/);
  // s5-ask (both runs): "check everything you have, mail, documents and notes" went to library + note and missed the mail.
  assert.doesNotMatch(p, /ask_everything/);
  const q = buildSystemPrompt(app.persona, { now: new Date(), ownerName: 'Alex', tools: ['facts_list', 'library', 'ask_everything'] } as never);
  assert.match(q, /check everything \(mail, documents, notes, chats\)[^.]*ask_everything/);
});

test('W0.1 the library tool hands "check everything, mail too" to ask_everything (s5-ask)', (t) => {
  const app = rig(t);
  assert.match(createLibraryTool(() => app).spec.description, /check everything[^.;)]*ask_everything/);
});
