// C23 (docs/RESEARCH.md "More than one run"): two research runs work at once, the others wait
// their turn in order, and each run keeps its own progress, budget, sources, Stop and report.
// A local fake web whose pages wait for the test to let them through, and the default model.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { LibraryStore } from '../src/library/store.ts';
import { RESEARCH, Research, researchDeps, type ResearchRun } from '../src/research.ts';
import { listen, makeApp, tempDir } from './helpers.ts';

const filler = (s: string) => ` ${s}`.repeat(14);

async function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-24T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'big-model', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
  const hits: string[] = [];
  // A page of host <name>.example answers only after open(name).
  const gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  const gate = (name: string) => {
    let g = gates.get(name);
    if (!g) {
      let open = () => {};
      const wait = new Promise<void>((r) => (open = r));
      g = { wait, open };
      gates.set(name, g);
    }
    return g;
  };
  const web = await listen(async (req: IncomingMessage, out: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      const name = u.searchParams.get('q')!.split(' ')[0].toLowerCase();
      out.writeHead(200, { 'content-type': 'application/json' });
      out.end(JSON.stringify({ results: [{ title: `About ${name}`, url: `http://${name}.example:${port}/page/${name}`, content: 'snippet' }] }));
      return;
    }
    const name = u.pathname.split('/').pop()!;
    hits.push(name);
    await gate(name).wait;
    if (!out.destroyed) out.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>About ${name}</title><p>The ${name} page says ${name} things are fine.${filler(`More ${name} text.`)}</p></html>`);
  });
  const port = new URL(web.url).port;
  app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  researchDeps.seams = { resolve: async (h: string) => (h.endsWith('.example') ? ['93.184.216.34'] : []), connect: () => '127.0.0.1' };
  researchDeps.retryMs = 10;
  researchDeps.fetchTimeoutMs = 6000;
  const made: Research[] = [];
  const open = () => {
    const r = new Research(app, app.store.db);
    made.push(r);
    app.research = r;
    return r;
  };
  t.after(async () => {
    for (const g of gates.values()) g.open();
    for (const r of made) r.close();
    researchDeps.seams = undefined;
    researchDeps.retryMs = undefined;
    researchDeps.fetchTimeoutMs = undefined;
    web.server.closeAllConnections();
    await new Promise<void>((r) => web.server.close(() => r()));
    app.store.close();
    cleanup();
  });
  return { app, open, hits, gate };
}

async function until(research: Research, id: number, done: (r: ResearchRun) => boolean, ms = 8000): Promise<ResearchRun> {
  const end = Date.now() + ms;
  for (;;) {
    const r = research.get(id)!;
    if (done(r)) return r;
    if (Date.now() > end) throw new Error(`run ${id} timed out in status ${r.status} (${JSON.stringify(r.progress)})`);
    await new Promise((res) => setTimeout(res, 15));
  }
}
/** A run with its plan ready (the simple plan: one search, the question). */
async function planned(research: Research, question: string): Promise<number> {
  const run = research.create({ question });
  await until(research, run.id, (x) => x.status === 'plan');
  return run.id;
}
const reading = (name: string) => (x: ResearchRun) => x.status === 'running' && x.progress.doing === 'reading' && x.progress.detail.includes(`/page/${name}`);

test('t47 research: two runs work at once, the third and fourth wait in order, and each keeps its own progress, budget and sources', async (t) => {
  const { open, hits, gate } = await rig(t);
  const research = open();
  assert.equal(RESEARCH.atOnce, 2);
  const a = await planned(research, 'alpha question about things');
  const b = await planned(research, 'beta question about things');
  const c = await planned(research, 'gamma question about things');
  const d = await planned(research, 'delta question about things');
  assert.equal(research.start(a).status, 'running');
  assert.equal(research.start(b).status, 'running', 'a second run works beside the first');
  const cq = research.start(c);
  assert.equal(cq.status, 'queued', 'the third waits its turn instead of being refused');
  assert.equal(cq.queuePos, 1);
  assert.equal(research.start(d).queuePos, 2);
  // Both working runs read their own page at the same time; the waiting ones read nothing.
  const ra = await until(research, a, reading('alpha'));
  const rb = await until(research, b, reading('beta'));
  assert.match(ra.progress.detail, /alpha\.example/);
  assert.match(rb.progress.detail, /beta\.example/);
  for (let i = 0; i < 200 && hits.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...hits].sort(), ['alpha', 'beta']);
  assert.deepEqual(research.get(c)!.searched, [], 'a waiting run has searched nothing');
  // A budget is the run's own.
  assert.equal(research.setBudget(a, { pages: 20, minutes: 40 }).budget.pages, 20);
  assert.equal(research.get(b)!.budget.pages, RESEARCH.defaultPages);
  assert.equal(research.setBudget(c, { minutes: 5 }).budget.minutes, 5, 'a waiting run can have its budget changed');
  assert.equal(research.get(a)!.budget.minutes, 40);
  // Stop on one run stops that run only; its place goes to the run that waited longest.
  research.stop(b);
  gate('beta').open();
  const sb = await until(research, b, (x) => x.status === 'stopped');
  assert.match(sb.report!, /stopped before it finished/);
  assert.equal(research.get(a)!.status, 'running', 'the other run goes on');
  await until(research, c, reading('gamma'));
  assert.equal(research.get(d)!.status, 'queued');
  assert.equal(research.get(d)!.queuePos, 1, 'the line moved up');
  assert.ok(!hits.includes('delta'));
  // Each finished run has only its own pages and its own report.
  gate('alpha').open();
  gate('gamma').open();
  gate('delta').open();
  const da = await until(research, a, (x) => x.status === 'done');
  const dc = await until(research, c, (x) => x.status === 'done');
  const dd = await until(research, d, (x) => x.status === 'done');
  for (const [run, name] of [[da, 'alpha'], [dc, 'gamma'], [dd, 'delta']] as const) {
    assert.deepEqual(run.sources.map((s) => new URL(s.url).hostname), [`${name}.example`], `${name}: only its own page`);
    assert.match(run.report!, new RegExp(`About ${name}`));
    for (const other of ['alpha', 'beta', 'gamma', 'delta']) if (other !== name) assert.doesNotMatch(run.report!, new RegExp(`${other}\\.example`), `${name} report has nothing of ${other}`);
    assert.ok(run.tokens > 0, 'tokens are counted per run');
    assert.equal(run.queuePos, null);
  }
  assert.equal(hits.filter((h) => h === 'delta').length, 1);
});

test('t47 research: Pause frees a place, Resume waits when both places are taken, and a waiting run that is stopped never reads', async (t) => {
  const { open, hits, gate } = await rig(t);
  const research = open();
  const a = await planned(research, 'alpha question about things');
  const b = await planned(research, 'beta question about things');
  const c = await planned(research, 'gamma question about things');
  const d = await planned(research, 'delta question about things');
  for (const id of [a, b, c, d]) research.start(id);
  await until(research, a, reading('alpha'));
  await until(research, b, reading('beta'));
  // A waiting run that never read anything is cancelled like a plan: no report, no page.
  const sd = research.stop(d);
  assert.equal(sd.status, 'stopped');
  assert.equal(sd.report, null);
  assert.throws(() => research.writeNow(c), /can’t do this now/, 'a waiting run has nothing to write yet');
  // Pause the first: the run that waited takes its place.
  research.pause(a);
  await until(research, a, (x) => x.status === 'paused');
  await until(research, c, reading('gamma'));
  // Resume while two work: it waits its turn (no error), then goes on from its checkpoint.
  const ra = research.resume(a);
  assert.equal(ra.status, 'queued');
  assert.equal(ra.queuePos, 1);
  assert.equal(ra.pause, null);
  gate('beta').open();
  await until(research, b, (x) => x.status === 'done');
  gate('alpha').open();
  gate('gamma').open();
  const da = await until(research, a, (x) => x.status === 'done');
  await until(research, c, (x) => x.status === 'done');
  assert.deepEqual(da.sources.filter((s) => s.status === 'read').map((s) => new URL(s.url).hostname), ['alpha.example']);
  assert.ok(!hits.includes('delta'), 'the stopped waiting run read nothing');
  // A waiting run can be deleted; a working one can not.
  const e = await planned(research, 'epsilon question about things');
  const f = await planned(research, 'zeta question about things');
  const g = await planned(research, 'eta question about things');
  for (const id of [e, f, g]) research.start(id);
  assert.equal(research.get(g)!.status, 'queued');
  assert.throws(() => research.delete(e), /Stop the run before deleting it/);
  assert.equal(research.delete(g), true);
  for (const n of ['epsilon', 'zeta', 'eta']) gate(n).open();
  await until(research, e, (x) => x.status === 'done');
  await until(research, f, (x) => x.status === 'done');
  assert.ok(!hits.includes('eta'));
});

test('t47 research: after a restart the interrupted runs go on (two at once) and the waiting run still waits its turn', async (t) => {
  const { open, gate } = await rig(t);
  const first = open();
  const a = await planned(first, 'alpha question about things');
  const b = await planned(first, 'beta question about things');
  const c = await planned(first, 'gamma question about things');
  for (const id of [a, b, c]) first.start(id);
  await until(first, a, reading('alpha'));
  await until(first, b, reading('beta'));
  first.close();
  for (const n of ['alpha', 'beta', 'gamma']) gate(n).open();
  const second = open();
  assert.equal(second.get(a)!.pause?.reason, 'restart');
  assert.equal(second.get(b)!.pause?.reason, 'restart');
  assert.equal(second.get(c)!.status, 'queued', 'a waiting run is still waiting after the restart');
  assert.deepEqual(second.resumeInterrupted(), [a, b]);
  assert.deepEqual([a, b, c].map((id) => second.get(id)!.status), ['running', 'running', 'queued']);
  for (const id of [a, b, c]) assert.equal((await until(second, id, (x) => x.status === 'done')).sources.filter((s) => s.status === 'read').length, 1);
  // With nothing interrupted, a waiting run left from before still gets its turn at startup.
  const d = await planned(second, 'delta question about things');
  const e = await planned(second, 'epsilon question about things');
  const f = await planned(second, 'zeta question about things');
  for (const id of [d, e, f]) second.start(id);
  await until(second, d, reading('delta'));
  await until(second, e, reading('epsilon'));
  second.stop(d);
  second.stop(e);
  // Both stopped while the third was moving up: it now works.
  await until(second, f, (x) => x.status === 'running');
  for (const n of ['delta', 'epsilon', 'zeta']) gate(n).open();
  await until(second, f, (x) => x.status === 'done');
});
