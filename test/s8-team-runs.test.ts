// S8 (docs/AGENT_TEAMS.md): agent teams. A scripted model plays the lead (the plan), the helpers
// and the checker by their system prompts. Covers: the plan up front (roles, models, tools, budgets;
// no hard-limit tools; computer use only when ticked; private = local models only), one plan
// approval, parallel helpers with dependency order, the shared scratchpad with sources, the checker
// loop (max 2 rounds), the budget stop, one final approval card for every outside action, pause and
// stop, the document deliverable and the run log.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { madeDocs } from '../src/documents/make.ts';
import { RunStore } from '../src/runs.ts';
import type { ChatRequest, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { cleanRunPlan, HARD_LIMIT_TOOL, TeamRunError, TeamRuns } from '../src/team-runs.ts';
import { listDir, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir } from './helpers.ts';

type Reply = StreamEvent[] | Promise<StreamEvent[]>;
type Handler = (who: string, req: ChatRequest, nth: number) => Reply;

const say = (s: string): StreamEvent[] => [{ type: 'text', text: s }];
const use = (id: string, name: string, args: Record<string, unknown>): StreamEvent[] => [{ type: 'tool_call', call: { id, name, arguments: args } }];
/** Who the request is for: "lead" (the plan), or the helper's name from its system prompt. */
function whoOf(req: ChatRequest): string {
  const all = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (all.includes('You plan a team run')) return 'lead';
  return /You are ([^,]+), the /.exec(all)?.[1] ?? 'other';
}
/** After the last user message, has this helper already had a tool result? */
const answered = (req: ChatRequest) => {
  const i = req.messages.map((m) => m.role).lastIndexOf('user');
  return req.messages.slice(i + 1).some((m) => m.role === 'tool');
};

function rig(t: TestContext, handler: Handler) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  for (const tool of [listDir, readFileTool, writeFileTool]) app.tools.add(tool);
  const ran: string[] = [];
  const action = (name: string, extra: Partial<Tool> = {}): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: (a) => `${name} ${JSON.stringify(a)}`, run: async (a) => (ran.push(`${name}:${JSON.stringify(a)}`), `${name} done`), ...extra });
  app.tools.add(action('web_fetch', { interruptible: true }));
  app.tools.add(action('email'));
  app.tools.add(action('pc_look'));
  app.tools.add(action('shell', { runsCommands: true }));
  app.tools.add(action('change_setting'));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }, { id: 'here', label: 'Here', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { list_dir: 'auto', read_file: 'auto', write_file: 'ask', web_search: 'ask', email: 'ask' } });
  const counts = new Map<string, number>();
  const seen: { who: string; req: ChatRequest }[] = [];
  app.providerFactory = (config: ProviderConfig) => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest) {
      const who = whoOf(req);
      const n = (counts.get(who) ?? 0) + 1;
      counts.set(who, n);
      seen.push({ who, req });
      for (const ev of await handler(who, req, n)) yield ev;
    },
  });
  app.runs = new RunStore(app.store.db, () => clock.now);
  const runs = new TeamRuns(app, app.store.db);
  app.teamRuns = runs;
  const conv = app.store.createConversation({ title: 'Big job' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, runs, conv, ran, counts, seen };
}

/** A lead that proposes: two researchers in parallel, a drafter after both, a checker after it. */
const PLAN = {
  roles: [
    { id: 'r', name: 'Researcher', kind: 'researcher', tools: ['web_fetch', 'read_file', 'shell', 'change_setting', 'pc_look'] },
    { id: 'd', name: 'Drafter', kind: 'drafter', tools: ['write_file', 'email'] },
    { id: 'c', name: 'Checker', kind: 'checker', tools: ['read_file'] },
  ],
  steps: [
    { id: 's1', role: 'r', title: 'Prices', instructions: 'Find the prices.' },
    { id: 's2', role: 'r', title: 'Reviews', instructions: 'Find the reviews.' },
    { id: 's3', role: 'd', title: 'Draft', instructions: 'Write the comparison.', after: ['s1', 's2'] },
    { id: 's4', role: 'c', title: 'Check', instructions: 'Check every claim against the sources.', after: ['s3'] },
  ],
  deliver: { kind: 'message' },
};
const lead = (plan: unknown = PLAN): Reply => say(JSON.stringify(plan));

test('S8: the plan comes up front with roles, models, tools and budgets; hard-limit tools never get in', async (t) => {
  const r = rig(t, (who) => (who === 'lead' ? lead() : say('ok')));
  const run = await r.runs.propose(r.conv.id, 'Compare three e-bikes for Alex and write it up');
  assert.equal(run.status, 'proposed');
  assert.deepEqual(run.plan.roles.map((x) => x.kind), ['researcher', 'drafter', 'checker']);
  const researcher = run.plan.roles[0];
  assert.equal(researcher.model, 'auto', 'Auto by default');
  assert.ok(researcher.tools.includes('web_fetch'));
  for (const bad of ['shell', 'change_setting']) assert.ok(!researcher.tools.includes(bad), `${bad} is a hard-limit tool`);
  assert.ok(!researcher.tools.includes('pc_look'), 'computer use only when the person ticks it');
  assert.ok(researcher.budget.tokens > 0 && researcher.budget.minutes > 0, 'each role has a budget');
  assert.ok(run.plan.limits.tokens >= run.plan.roles.reduce((n, x) => n + x.budget.tokens, 0) - 1, 'the whole budget is shown up front');
  assert.ok(HARD_LIMIT_TOOL('shell', r.app.tools.get('shell')) && HARD_LIMIT_TOOL('change_setting') && !HARD_LIMIT_TOOL('web_search'));
  // The person edits the plan: ticks computer use for the researcher (allowed then), adds a custom role.
  const edited = r.runs.edit(run.id, { ...run.plan, roles: [...run.plan.roles.map((x) => (x.id === 'r' ? { ...x, computer: true, tools: [...x.tools, 'pc_look', 'shell'] } : x)), { id: 'x', name: 'Translator', kind: 'custom', instructions: 'Translate it to Spanish.', tools: ['read_file'] }] });
  const rr = edited.plan.roles.find((x) => x.id === 'r')!;
  assert.ok(rr.tools.includes('pc_look'), 'ticked: computer use allowed');
  assert.ok(!rr.tools.includes('shell'), 'never a hard-limit tool, even by hand');
  assert.equal(edited.plan.roles.at(-1)!.kind, 'custom');
  // A dependency cycle or an unknown step is refused.
  assert.throws(() => r.runs.edit(run.id, { ...edited.plan, steps: [{ id: 'a', role: 'r', title: 'A', instructions: 'a', after: ['b'] }, { id: 'b', role: 'r', title: 'B', instructions: 'b', after: ['a'] }] }), TeamRunError);
});

test('S8: private chats get local models only and no outside tools', async (t) => {
  const r = rig(t, (who) => (who === 'lead' ? lead() : say('ok')));
  const plan = cleanRunPlan(r.app, { ...PLAN, roles: PLAN.roles.map((x) => ({ ...x, model: { providerId: 'p', model: 'm' } })) }, { private: true });
  assert.equal(plan.roles[0].model, 'auto', 'a cloud model is refused in private: Auto picks a local one');
  assert.ok(!plan.roles[0].tools.includes('web_fetch'), 'fetching pages leaves the computer');
  assert.ok(plan.roles[0].tools.includes('read_file'));
  const local = cleanRunPlan(r.app, { ...PLAN, roles: PLAN.roles.map((x) => ({ ...x, model: { providerId: 'here', model: 'llama' } })) }, { private: true });
  assert.deepEqual(local.roles[0].model, { providerId: 'here', model: 'llama' }, 'a model on this computer stays');
});

test('S8: one plan approval, helpers in parallel, dependency order, scratchpad with sources, one deliverable', async (t) => {
  let inFlight = 0;
  let most = 0;
  const order: string[] = [];
  let release!: () => void;
  const both = new Promise<void>((res) => (release = res));
  let researchers = 0;
  const r = rig(t, async (who, req) => {
    if (who === 'lead') return lead();
    if (who === 'Researcher') {
      const mine = req.messages.some((m) => typeof m.content === 'string' && m.content.includes('Prices')) ? 'prices' : 'reviews';
      if (!answered(req)) {
        inFlight++;
        most = Math.max(most, inFlight);
        order.push(`start:${mine}`);
        if (++researchers === 2) release();
        await both; // both researchers are working at the same time
        inFlight--;
        return use(`n-${mine}`, 'note_finding', { text: mine === 'prices' ? 'The Aventon costs $1,799.' : 'Reviewers like the Rad battery.', source: mine === 'prices' ? 'https://example.test/aventon' : 'https://example.test/rad' });
      }
      order.push(`end:${mine}`);
      return say(`Found the ${mine}.`);
    }
    if (who === 'Drafter') {
      order.push('draft');
      const pad = req.messages.map((m) => String(m.content)).join('\n');
      assert.match(pad, /\$1,799.*example\.test\/aventon/s, 'the drafter sees the scratchpad with sources');
      return say('The Aventon costs $1,799 [1]. Reviewers like the Rad battery [2].');
    }
    if (who === 'Checker') return say('All claims match the sources.\nVERDICT: OK');
    return say('ok');
  });
  const run = await r.runs.propose(r.conv.id, 'Compare e-bikes for Alex');
  assert.equal(r.counts.get('Researcher') ?? 0, 0, 'nothing runs before the plan is approved');
  r.runs.approve(run.id);
  assert.throws(() => r.runs.approve(run.id), TeamRunError, 'the plan is approved once');
  const done = await r.runs.finished(run.id);
  assert.equal(done.status, 'done', JSON.stringify(done.log.slice(-5)));
  assert.equal(most, 2, 'the two independent researchers ran in parallel');
  assert.ok(order.indexOf('draft') > order.lastIndexOf('end:prices') && order.indexOf('draft') > order.lastIndexOf('end:reviews'), `the drafter waited for both: ${order.join(' ')}`);
  assert.equal(done.notes.length, 2);
  assert.ok(done.notes.every((n) => n.source.startsWith('https://')), 'every finding has its source');
  assert.equal(done.checks.length, 1);
  assert.ok(done.checks[0].ok);
  assert.equal(done.result?.kind, 'message');
  const msgs = r.app.store.messages(r.conv.id);
  const final = msgs.find((m) => m.id === (done.result as { messageId: number }).messageId)!;
  assert.match(final.content, /Aventon costs \$1,799/);
  assert.match(final.content, /example\.test\/aventon/, 'the sources go with the deliverable');
  assert.ok(done.steps.every((s) => s.status === 'done'));
  assert.ok(done.log.some((l) => /approved/i.test(l.text)), 'the run log keeps what happened');
  assert.ok(done.runId, 'saved with a run record');
});

test('S8: the checker sends fixes back, at most two rounds', async (t) => {
  let fixAlways = false;
  const r = rig(t, (who, req, n) => {
    if (who === 'lead') return lead({ ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[2], after: ['s1'] }, PLAN.steps[3]] });
    if (who === 'Researcher') return answered(req) ? say('Noted.') : use('n1', 'note_finding', { text: 'It costs $1,799.', source: 'https://example.test/a' });
    if (who === 'Drafter') return say(n === 1 ? 'It costs $2,000.' : 'It costs $1,799 [1].');
    if (who === 'Checker') return say(fixAlways || n === 1 ? 'VERDICT: FIX: the price must be $1,799 as the source says' : 'VERDICT: OK');
    return say('ok');
  });
  const run = await r.runs.propose(r.conv.id, 'Price check for Alex');
  r.runs.approve(run.id);
  const done = await r.runs.finished(run.id);
  assert.equal(done.status, 'done');
  assert.equal(r.counts.get('Drafter'), 2, 'one fix round');
  assert.equal(done.checks.length, 2);
  assert.deepEqual(done.checks.map((c) => c.ok), [false, true]);
  const draftStep = done.steps.find((s) => s.id === 's3')!;
  assert.match(draftStep.report ?? '', /\$1,799/);
  assert.ok(r.seen.filter((s) => s.who === 'Drafter')[1].req.messages.some((m) => String(m.content).includes('price must be $1,799')), 'the fixes reach the drafter');

  fixAlways = true;
  r.counts.clear();
  const run2 = await r.runs.propose(r.conv.id, 'Price check again for Alex');
  r.runs.approve(run2.id);
  const done2 = await r.runs.finished(run2.id);
  assert.equal(done2.status, 'done');
  assert.equal(r.counts.get('Drafter'), 3, 'first draft plus two fix rounds, no more');
  assert.equal(done2.checks.length, 3);
  assert.ok(done2.checks.at(-1)!.open, 'what is still open after two rounds is said, not hidden');
  const final = r.app.store.messages(r.conv.id).find((m) => m.id === (done2.result as { messageId: number }).messageId)!;
  assert.match(final.content, /still open/i);
});

test('S8: actions outside reading and drafts wait for ONE final approval listing every action', async (t) => {
  const r = rig(t, (who, req) => {
    if (who === 'lead') return lead({ ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[2], after: ['s1'] }] });
    if (who === 'Researcher') return answered(req) ? say('Looked.') : use('x1', 'shell', { command: 'rm -rf /' });
    if (who === 'Drafter') {
      const i = req.messages.map((m) => m.role).lastIndexOf('user');
      const tools = req.messages.slice(i + 1).filter((m) => m.role === 'tool').length;
      if (tools === 0) return use('w1', 'write_file', { path: 'draft.md', content: '# Draft\n' });
      if (tools === 1) return use('e1', 'email', { to: 'sam@example.test', subject: 'The comparison' });
      if (tools === 2) return use('e2', 'email', { to: 'kim@example.test', subject: 'The comparison' });
      return say('Wrote draft.md; two emails are waiting for the final approval.');
    }
    return say('ok');
  });
  const run = await r.runs.propose(r.conv.id, 'Compare and send it to Sam and Kim');
  r.runs.edit(run.id, { ...run.plan, roles: run.plan.roles.map((x) => (x.id === 'd' ? { ...x, tools: ['write_file', 'email'] } : x)) });
  r.runs.approve(run.id);
  const waiting = await r.runs.finished(run.id);
  assert.equal(waiting.status, 'waiting', 'it waits for the final approval');
  assert.deepEqual(r.ran, [], 'nothing outside was done during the run');
  const shell = waiting.steps.find((s) => s.id === 's1')!.receipts.find((x) => x.name === 'shell')!;
  assert.equal(shell.status, 'denied', 'a hard-limit tool is refused');
  assert.equal(waiting.actions.length, 2, 'one card with every action');
  assert.deepEqual(waiting.actions.map((a) => a.tool), ['email', 'email']);
  assert.ok(waiting.steps.find((s) => s.id === 's3')!.receipts.some((x) => x.name === 'write_file' && x.status === 'ok'), 'drafts are written without asking again');
  const after = await r.runs.decide(waiting.id, { approved: true, skip: [2] });
  assert.equal(after.status, 'done');
  assert.deepEqual(r.ran, ['email:{"to":"sam@example.test","subject":"The comparison"}'], 'the approved action ran; the unticked one did not');
  assert.deepEqual(after.actions.map((a) => a.status), ['done', 'skipped']);
  await assert.rejects(() => r.runs.decide(waiting.id, { approved: true }), TeamRunError, 'one final approval');
});

test('S8: the budget stops the run and keeps what was done', async (t) => {
  const r = rig(t, (who) => {
    if (who === 'lead') return lead();
    if (who === 'Researcher') return use(`n${Math.random()}`, 'note_finding', { text: 'x'.repeat(40_000), source: 'https://example.test/long' });
    return say('ok');
  });
  const run = await r.runs.propose(r.conv.id, 'A big comparison for Alex');
  r.runs.edit(run.id, { ...run.plan, roles: run.plan.roles.map((x) => (x.id === 'r' ? { ...x, budget: { ...x.budget, tokens: 5_000 } } : x)) });
  r.runs.approve(run.id);
  const done = await r.runs.finished(run.id);
  assert.equal(done.status, 'limit');
  assert.ok(done.log.some((l) => /budget/i.test(l.text)));
  assert.equal(done.steps.find((s) => s.id === 's3')!.status, 'waiting', 'later parts never started');
  assert.ok(done.notes.length >= 1, 'findings so far are kept');
  assert.equal(r.counts.get('Drafter') ?? 0, 0);
});

test('S8: pause holds new helpers, stop ends the run; a document deliverable via make_document', async (t) => {
  let gate!: () => void;
  const hold = new Promise<void>((res) => (gate = res));
  const r = rig(t, async (who) => {
    if (who === 'lead') return lead({ ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[2], after: ['s1'] }], deliver: { kind: 'document', format: 'md', title: 'E-bikes' } });
    if (who === 'Researcher') {
      await hold;
      return say('Found it.');
    }
    if (who === 'Drafter') return say('# E-bikes\n\nThe comparison.');
    return say('ok');
  });
  const run = await r.runs.propose(r.conv.id, 'Make a document comparing e-bikes');
  r.runs.approve(run.id);
  assert.ok(r.runs.pause(run.id));
  assert.equal(r.runs.get(run.id)!.status, 'paused');
  gate();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.counts.get('Drafter') ?? 0, 0, 'paused: the next helper does not start');
  assert.ok(r.runs.resume(run.id));
  const done = await r.runs.finished(run.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result?.kind, 'document');
  const doc = madeDocs(r.app).get(Number(done.result?.docId));
  assert.ok(doc, 'the deliverable is a made document');
  assert.equal(doc!.format, 'md');

  const r2 = await r.runs.propose(r.conv.id, 'Another document comparing e-bikes');
  r.runs.approve(r2.id);
  assert.ok(r.runs.stop(r2.id));
  const stopped = await r.runs.finished(r2.id);
  assert.equal(stopped.status, 'stopped');
});
