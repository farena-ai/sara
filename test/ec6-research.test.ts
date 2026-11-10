// EC6 slice 2 (docs/ops/EC6_DESIGN.md): research runs. A fake SearXNG and fake web pages (the
// names resolve to a public address; the connection goes to the local fake) and a scripted model.
// Acceptance: a plan that is approved or edited; sources read and failed with the reason; every
// body sentence links a page fetched in this run (unsupported sentences are left out and counted);
// Write the report now; Stop mid-run still saves a report that lists what is missing; a restart
// turns a working run into a stopped report; the report is kept in the Library.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { LibraryStore } from '../src/library/store.ts';
import { Research, researchDeps, checkClaims, type ResearchRun } from '../src/research.ts';
import { listen, makeApp, tempDir, text } from './helpers.ts';

const PAGES: Record<string, { status?: number; type?: string; body: string; slowMs?: number }> = {
  '/heat-a': { body: '<html><head><title>Cold climate study</title></head><body><p>Modern cold-climate heat pumps keep heating at minus twenty-five degrees. Their efficiency drops as temperatures fall, but stays above resistance heating. ' + 'Filler words about installers and households. '.repeat(10) + '</p></body></html>' },
  '/heat-b': { body: '<html><title>Field report</title><p>Ducted and ductless models exist. A field report from Maine found owners saved money compared with oil furnaces. ' + 'More notes on winters and electricity bills. '.repeat(10) + '</p></html>' },
  '/gone': { status: 404, body: 'not here' },
  '/tiny': { body: '<p>Hi.</p>' },
  '/binary': { type: 'application/octet-stream', body: 'PK\u0003\u0004 binary' },
  '/slow-1': { body: '<p>' + 'Slow page about heat pump noise levels and outdoor units. '.repeat(10) + '</p>', slowMs: 400 },
  '/slow-2': { body: '<p>' + 'Another slow page on defrost cycles of outdoor units. '.repeat(10) + '</p>', slowMs: 400 },
  '/slow-3': { body: '<p>' + 'Third slow page on refrigerants. '.repeat(10) + '</p>', slowMs: 400 },
};

type Url = (host: string, path: string) => string;
async function rig(t: TestContext, makeResults: (url: Url) => Record<string, string[]>) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  let results: Record<string, string[]> = {};
  const queries: string[] = [];
  const web = await listen(async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q')!;
      queries.push(q);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: (results[q] ?? []).map((url, i) => ({ title: `Result ${i}`, url, content: 'snippet' })) }));
      return;
    }
    const p = PAGES[u.pathname];
    if (!p) return void res.writeHead(404).end();
    if (p.slowMs) await new Promise((r) => setTimeout(r, p.slowMs));
    res.writeHead(p.status ?? 200, { 'content-type': p.type ?? 'text/html; charset=utf-8' });
    res.end(p.body);
  });
  const port = new URL(web.url).port;
  const url: Url = (host, path) => `http://${host}.example:${port}${path}`;
  results = makeResults(url);
  app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  researchDeps.seams = { resolve: async (h: string) => (h.endsWith('.example') ? ['93.184.216.34'] : []), connect: () => '127.0.0.1' };
  const research = new Research(app, app.store.db);
  t.after(async () => {
    research.close();
    researchDeps.seams = undefined;
    web.server.closeAllConnections();
    await new Promise<void>((r) => web.server.close(() => r()));
    app.store.close();
    cleanup();
  });
  return { app, research, queries, url, dir, clock };
}

async function until(research: Research, id: number, done: (r: ResearchRun) => boolean, ms = 8000): Promise<ResearchRun> {
  const end = Date.now() + ms;
  for (;;) {
    const r = research.get(id)!;
    if (done(r)) return r;
    if (Date.now() > end) throw new Error(`timed out in status ${r.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const PLAN = JSON.stringify({ steps: [{ question: 'Do they heat when it is very cold?', searches: ['heat pump cold'] }, { question: 'What do owners report?', searches: ['heat pump owners'] }] });

test('ec6 research: plan → edit → read (with failures and reasons) → a cited report in the Library', async (t) => {
  const { app, research, queries } = await rig(t, (url) => ({
    'heat pump cold': [], // the edited plan uses other searches
    'cold climate heat pumps': [url('a', '/heat-a'), url('a', '/gone'), url('a', '/tiny'), 'http://10.0.0.5/secret'],
    'heat pump owners maine': [url('b', '/heat-b'), url('b', '/binary'), url('a', '/heat-a')],
  }));
  app.script.push(text('```json\n', PLAN, '\n```'));
  // The writer: three supported sentences, one with no citation, one citing a page that failed,
  // one citing a number that does not exist, one that cites a page that doesn't say it.
  app.script.push(
    text(
      '## Cold weather\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1]. Their efficiency drops as temperatures fall [1].\n\nHeat pumps are the best choice for everyone.\n\n',
      '## Owners\n\n- A field report from Maine found owners saved money compared with oil furnaces [2].\n- The 404 page proves nothing [3].\n- Some claim a 9000% saving [7].\n- Penguins prefer geothermal [2].\n',
    ),
  );
  const run = research.create({ question: 'Do heat pumps work in cold climates?' });
  let r = await until(research, run.id, (x) => x.status === 'plan');
  assert.equal(r.plan.steps.length, 2);
  assert.match(app.requests[0].messages.map((m) => m.content).join('\n'), /Do heat pumps work in cold climates\?/);
  // He edits the plan before anything is read.
  r = research.editPlan(run.id, { steps: [{ question: 'Cold performance', searches: ['cold climate heat pumps'] }, { question: 'Owner reports', searches: ['heat pump owners maine'] }, { question: 'Cost of running one', searches: ['heat pump running cost'] }], pages: 8 });
  assert.equal(r.plan.steps.length, 3);
  assert.deepEqual(queries, [], 'nothing is searched before he approves');
  research.start(run.id);
  r = await until(research, run.id, (x) => x.status === 'done');
  assert.deepEqual(queries, ['cold climate heat pumps', 'heat pump owners maine', 'heat pump running cost']);
  const read = r.sources.filter((s) => s.status === 'read');
  const failed = r.sources.filter((s) => s.status === 'failed');
  assert.deepEqual(read.map((s) => s.n), [1, 2]);
  assert.equal(read[0].title, 'Cold climate study');
  assert.equal(r.sources.filter((s) => s.url.endsWith('/heat-a')).length, 1, 'a page found twice is read once');
  const reason = (end: string) => failed.find((s) => s.url.endsWith(end))?.reason;
  assert.equal(reason('/gone'), 'not-found', '3.1.2: a page that does not exist is listed apart');
  assert.equal(failed.find((s) => s.url.endsWith('/gone'))?.detail, 'HTTP 404');
  assert.equal(reason('/tiny'), 'too-short');
  assert.equal(reason('/binary'), 'not-text');
  assert.equal(reason('/secret'), 'blocked');
  // The report: every body sentence links a page read in this run.
  const md = r.report!;
  const body = md.slice(0, md.indexOf('## What is missing'));
  for (const line of body.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^Research report/.test(l))) {
    assert.match(line, /\[[12]\]\(http:\/\/[ab]\.example:\d+\/heat-[ab]\)/, `uncited line kept: ${line}`);
  }
  assert.doesNotMatch(md, /best choice for everyone|404 page proves|9000%|Penguins/);
  assert.match(md, /## What is missing[\s\S]*Cost of running one[\s\S]*4 sentences were left out/);
  assert.match(md, /## Sources\n\n1\. \[Cold climate study\]\(http:\/\/a\.example:\d+\/heat-a\)/);
  assert.match(md, /## Pages not found[\s\S]*\/gone[^\n]*not found \(HTTP 404\)/);
  assert.match(md, /\/binary[^\n]*not a text page/i);
  // The sources are fenced as text written by others.
  const writer = app.requests.at(-1)!.messages.map((m) => m.content).join('\n');
  assert.match(writer, /written by others/);
  assert.match(writer, /\[1\] Cold climate study/);
  // Kept in her Library.
  const doc = app.library!.get(r.reportDocId!)!;
  assert.ok(doc.keep);
  assert.match(doc.name, /^Research - Do heat pumps work in cold climates\.md$/);
  assert.equal(app.library!.file(doc)!.toString('utf8'), md);
});

test('ec6 research: claim check keeps only sentences backed by a read page', () => {
  const sources = [
    { n: 1, url: 'https://a.example/x', text: 'Solar panels lose about half a percent of output per year.' },
    { n: 2, url: 'https://b.example/y', text: 'Inverters usually last ten to fifteen years.' },
  ];
  const out = checkClaims('Panels lose output every year [1]. Inverters usually last a decade or more.[2] Bananas are yellow [2]. Unsourced sentence here.', sources);
  assert.equal(out.kept, 2);
  assert.equal(out.dropped, 2);
  assert.match(out.text, /^Panels lose output every year \[1\]\(https:\/\/a\.example\/x\)\. Inverters usually last a decade or more \[2\]\(https:\/\/b\.example\/y\)\.$/);
  assert.deepEqual([...out.cited].sort(), [1, 2]);
});

test('ec6 research: Write the report now stops reading and writes with what was read', async (t) => {
  const { app, research } = await rig(t, (url) => ({ q: [url('a', '/heat-a'), url('a', '/slow-1'), url('a', '/slow-2'), url('a', '/slow-3')] }));
  app.script.push(text(JSON.stringify({ steps: [{ question: 'Q', searches: ['q'] }] })));
  app.script.push(text('## Answer\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1].'));
  const run = research.create({ question: 'Cold heat pumps?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  await until(research, run.id, (x) => x.sources.some((s) => s.status === 'read'));
  research.writeNow(run.id);
  const r = await until(research, run.id, (x) => x.status === 'done');
  assert.ok(r.sources.filter((s) => s.status === 'read').length < 4);
  assert.match(r.report!, /\[1\]\(http:\/\/a\.example:\d+\/heat-a\)/);
  assert.match(r.report!, /## What is missing[\s\S]*not read because the report was written early/);
  assert.ok(r.reportDocId);
});

test('ec6 research: Stop mid-run still saves a report listing what is missing (no model call)', async (t) => {
  const { app, research } = await rig(t, (url) => ({ q1: [url('a', '/heat-a'), url('a', '/slow-1'), url('a', '/slow-2')], q2: [url('b', '/heat-b')] }));
  app.script.push(text(JSON.stringify({ steps: [{ question: 'First', searches: ['q1'] }, { question: 'Second', searches: ['q2'] }] })));
  const run = research.create({ question: 'Cold heat pumps?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  await until(research, run.id, (x) => x.sources.some((s) => s.status === 'read'));
  const calls = app.requests.length;
  research.stop(run.id);
  const r = await until(research, run.id, (x) => x.status === 'stopped' && Boolean(x.report));
  assert.equal(app.requests.length, calls, 'Stop never calls the model again');
  const md = r.report!;
  assert.match(md, /stopped before it finished/i);
  assert.match(md, /## What was found[\s\S]*\[Cold climate study\]\(http:\/\/a\.example:\d+\/heat-a\)/);
  assert.match(md, /## What is missing[\s\S]*Second[\s\S]*q2/);
  assert.ok(r.reportDocId, 'kept in the Library too');
});

test('ec6 research: a restart pauses a working run at its checkpoint and it resumes; no search setup refuses', async (t) => {
  const { app, research } = await rig(t, (url) => ({ q: [url('a', '/heat-a'), url('a', '/slow-1'), url('a', '/slow-2'), url('a', '/slow-3')] }));
  app.script.push(text(JSON.stringify({ steps: [{ question: 'Q', searches: ['q'] }] })));
  const run = research.create({ question: 'Cold heat pumps?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  await until(research, run.id, (x) => x.sources.some((s) => s.status === 'read'));
  research.close();
  const again = new Research(app, app.store.db);
  t.after(() => again.close());
  // 3.1.2: paused where it stopped (not a stopped report), then it goes on from there.
  let r = again.get(run.id)!;
  assert.equal(r.status, 'paused');
  assert.equal(r.pause?.reason, 'restart');
  const before = r.sources.length;
  app.script.push(text('## Answer\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1].'));
  assert.deepEqual(again.resumeInterrupted(), [run.id]);
  r = await until(again, run.id, (x) => x.status === 'done');
  assert.ok(r.sources.length >= before, 'what was read before the restart is kept');
  assert.equal(r.sources.filter((s) => s.url.endsWith('/heat-a')).length, 1, 'a page read before the restart is not read again');
  assert.match(r.report!, /\[1\]\(http:\/\/a\.example:\d+\/heat-a\)/);
  app.settings.update({ search: undefined } as never);
  assert.throws(() => again.create({ question: 'Anything?' }), /web search/i);
  app.settings.update({ search: { provider: 'searxng', url: 'http://127.0.0.1:9' }, toolPermissions: { web_fetch: 'never' } } as never);
  assert.throws(() => again.create({ question: 'Anything?' }), /web pages are switched off/i);
});
