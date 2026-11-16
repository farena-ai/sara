// S1 (docs/RESEARCH.md, "Deep research reports"): research runs that also read the person's own
// files (Library), a report with Summary / Findings / Open questions / What I couldn't verify, a
// source list with quotes, a cost cap shown up front, a notification when done, and private runs
// (a private chat, "Nothing leaves this computer") that use local models only and no web unless
// allowed. A fake SearXNG + fake pages (names resolve to a public address; the connection goes to
// the local fake) and a scripted model.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { markdownToDocx, markdownToPdf } from '../src/doc-write.ts';
import { LibraryStore } from '../src/library/store.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { bestQuote, checkClaims, Research, researchDeps, stepMatches, type ResearchRun } from '../src/research.ts';
import { listen, makeApp, tempDir, text } from './helpers.ts';

const PAGE = '<html><head><title>Cold climate study</title></head><body><p>Modern cold-climate heat pumps keep heating at minus twenty-five degrees. Their efficiency drops as temperatures fall. ' + 'Filler words about installers and households. '.repeat(10) + '</p></body></html>';

async function rig(t: TestContext, o: { search?: boolean; local?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  const provider = o.local ? { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true } : { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' };
  app.settings.update({ providers: [provider], defaultProviderId: 'p', defaultModel: 'm-big-70b', ownerName: 'Alex' } as never);
  const queries: string[] = [];
  const web = await listen(async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      queries.push(u.searchParams.get('q')!);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'Study', url: `http://a.example:${port}/heat-a`, content: 'snippet' }] }));
      return;
    }
    if (u.pathname !== '/heat-a') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const port = new URL(web.url).port;
  if (o.search !== false) app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  researchDeps.seams = { resolve: async (h: string) => (h.endsWith('.example') ? ['93.184.216.34'] : []), connect: () => '127.0.0.1' };
  researchDeps.retryMs = 5;
  const notes: { title: string; body: string; conv: string; tag: string }[] = [];
  app.push = { notifyOwner: async (title: string, body: string, conv: string, tag: string) => void notes.push({ title, body, conv, tag }) } as never;
  const research = new Research(app, app.store.db);
  t.after(async () => {
    research.close();
    setPrivateLocal(false);
    researchDeps.seams = undefined;
    researchDeps.retryMs = undefined;
    web.server.closeAllConnections();
    await new Promise<void>((r) => web.server.close(() => r()));
    app.store.close();
    cleanup();
  });
  // His own file: a note about the heat pump installed at home.
  const doc = app.library.add({ name: 'Heat pump invoice.pdf', bytes: Buffer.from('invoice heat pump'), keep: true });
  app.library.setRead(doc.id, { kind: 'pdf', parts: [{ where: 'page 2', text: 'The installer quoted 9400 dollars for the cold-climate heat pump, including the outdoor unit and two years of service visits. The warranty on the compressor runs ten years.' }], warnings: [] } as never);
  return { app, research, queries, notes, docId: doc.id };
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

const PLAN = JSON.stringify({ steps: [{ question: 'Do they heat when it is very cold?', searches: ['heat pump cold'] }, { question: 'What did my installer quote?', searches: ['installer quoted heat pump'] }] });

test('s1 claim check: unsupported sentences are returned as unverified, questions need no source', () => {
  const sources = [{ n: 1, url: 'https://a.example/x', text: 'Solar panels lose about half a percent of output per year.' }];
  const c = checkClaims('## Summary\n\nSolar panels lose half a percent per year [1]. Panels last forever. Is that true for every brand?', sources);
  assert.equal(c.kept, 2);
  assert.equal(c.dropped, 1);
  assert.deepEqual(c.unverified, ['Panels last forever.']);
  assert.match(c.text, /Is that true for every brand\?/);
  assert.deepEqual([...c.cited], [1]);
  assert.deepEqual(c.claims.get(1), ['Solar panels lose half a percent per year.']);
  // The quote for a source is its sentence closest to the claims that cite it.
  assert.equal(bestQuote('Intro text here. Solar panels lose about half a percent of output per year. Other words.', ['Solar panels lose half a percent per year.']), 'Solar panels lose about half a percent of output per year.');
});

test('s1 claim check: a section heading over sub-headings stays; a step is answered by a source another search found', () => {
  const sources = [{ n: 1, url: 'https://a.example/x', text: 'Owners saved 400 dollars a year on heating.' }];
  const c = checkClaims('## Findings\n\n### Costs\n\n- Owners saved 400 dollars a year [1].\n\n### Noise\n\n- Nobody measured it.\n', sources);
  assert.match(c.text, /^## Findings\n\n### Costs\n\n- Owners saved 400 dollars a year/);
  assert.doesNotMatch(c.text, /### Noise/, 'a sub-heading left empty goes');
  assert.equal(stepMatches('What does one cost to run compared with oil?', 'Was a heat pump a good buy?', 'What a heat pump costs to run'), true);
  assert.equal(stepMatches('How loud is the outdoor unit?', 'Was a heat pump a good buy?', 'What a heat pump costs to run'), false);
});

test('s1 research: web + his Library → a report with Summary, Findings, Open questions, unverified claims marked, quotes; notifies when done', async (t) => {
  const { app, research, queries, notes, docId } = await rig(t);
  app.script.push(text(PLAN));
  app.script.push(
    text(
      // His own file is read first (it is source 1); the web page is source 2.
      '## Summary\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [2]. The installer quoted 9400 dollars [1].\n\n',
      '## Findings\n\n- Their efficiency drops as temperatures fall [2].\n- The compressor warranty runs ten years [1].\n- Heat pumps pay for themselves in two winters.\n\n',
      '## Open questions\n\n- How loud is the outdoor unit at night?\n',
    ),
  );
  const run = research.create({ question: 'Was my heat pump a good buy for cold winters?' });
  assert.deepEqual(run.reach, { web: true, library: true, localOnly: false });
  let r = await until(research, run.id, (x) => x.status === 'plan');
  // The budget and its cost cap are shown before he starts.
  assert.equal(research.costCap(r).local, false);
  research.start(run.id);
  r = await until(research, run.id, (x) => x.status === 'done');
  assert.ok(queries.length >= 1, 'the web was searched');
  const read = r.sources.filter((s) => s.status === 'read');
  const lib = read.find((s) => s.url === `library:${docId}`);
  assert.ok(lib, 'his own file is a source');
  assert.equal(lib!.title, 'Heat pump invoice.pdf · page 2');
  assert.ok(read.some((s) => s.url.endsWith('/heat-a')));
  const md = r.report!;
  if (process.env.S1_DEBUG) console.log(md);
  for (const h of ['## Summary', '## Findings', '## Open questions', '## What I couldn’t verify', '## Sources']) assert.ok(md.includes(h), `missing ${h}`);
  const body = md.slice(0, md.indexOf('## What I couldn’t verify'));
  assert.doesNotMatch(body, /two winters/, 'an unsupported claim is not in the findings');
  assert.match(md, /## What I couldn’t verify\n\n- Heat pumps pay for themselves in two winters\. \(unverified\)/);
  assert.match(md, /How loud is the outdoor unit at night\?/);
  // Sources list with a quote from each, his file labelled as his.
  assert.match(md, /\[Cold climate study\]\([^)]*heat-a\)[^\n]*“Modern cold-climate heat pumps keep heating at minus twenty-five degrees\.”/);
  assert.match(md, /Heat pump invoice\.pdf · page 2[^\n]*\(your Library\)[^\n]*“[^”]*9400 dollars/);
  assert.match(md, /\n1\. Heat pump invoice\.pdf · page 2 \(your Library\)/, 'his file is named, not linked to a made-up address');
  assert.match(md, /The installer quoted 9400 dollars \[1\]\./);
  assert.doesNotMatch(md, /\]\(library:/);
  // Kept in the Library; Word and PDF from the same report.
  assert.ok(app.library!.get(r.reportDocId!)?.keep);
  assert.equal(markdownToDocx(md, r.question).subarray(0, 2).toString(), 'PK');
  assert.equal(markdownToPdf(md, r.question).subarray(0, 4).toString(), '%PDF');
  // He hears when it is done.
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tag, `research-${run.id}`);
  assert.match(notes[0].body, /good buy/);
});

test('s1 research: without web search a Library-only run still works', async (t) => {
  const { app, research, queries } = await rig(t, { search: false });
  app.script.push(text(PLAN), text('## Summary\n\nThe installer quoted 9400 dollars for the heat pump [1].\n'));
  const run = research.create({ question: 'What did my installer quote for the heat pump?' });
  assert.deepEqual(run.reach, { web: false, library: true, localOnly: false });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  const r = await until(research, run.id, (x) => x.status === 'done');
  assert.deepEqual(queries, []);
  assert.match(r.report!, /9400 dollars/);
});

test('s1 research: "Nothing leaves this computer" → Library only, models on this computer only', async (t) => {
  const { app, research, queries } = await rig(t, { local: true });
  setPrivateLocal(true);
  app.script.push(text(PLAN), text('## Summary\n\nThe installer quoted 9400 dollars for the heat pump [1].\n'));
  const run = research.create({ question: 'What did my installer quote for the heat pump?', web: true });
  assert.deepEqual(run.reach, { web: false, library: true, localOnly: true }, 'web can’t be allowed in this mode');
  assert.equal(research.costCap(run).local, true);
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  const r = await until(research, run.id, (x) => x.status === 'done');
  assert.deepEqual(queries, [], 'nothing was searched on the web');
  assert.match(r.report!, /9400 dollars/);
});

test('s1 research: a run from a private chat uses local models only and no web unless he allows it', async (t) => {
  const { app, research } = await rig(t);
  const priv = app.store.createConversation({ title: 'secret', private: true } as never);
  const before = app.requests.length;
  const run = research.create({ question: 'What did my installer quote for the heat pump?', conversationId: priv.id });
  assert.deepEqual(run.reach, { web: false, library: true, localOnly: true });
  // The only model is not local: no model is ever called; the simple plan is used.
  let r = await until(research, run.id, (x) => x.status === 'plan');
  assert.equal(app.requests.length, before, 'a cloud model was never called');
  // He may allow the web for this run (still local models only).
  r = research.editPlan(run.id, { ...r.plan, reach: { web: true, library: true } });
  assert.deepEqual(r.reach, { web: true, library: true, localOnly: true });
  research.start(run.id);
  r = await until(research, run.id, (x) => x.status === 'paused' || x.status === 'done');
  assert.equal(app.requests.length, before, 'the writer did not use the cloud model either');
  if (r.status === 'paused') assert.equal(r.pause?.reason, 'model');
});
