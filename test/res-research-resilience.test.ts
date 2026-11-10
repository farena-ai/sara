// 3.1.2 (docs/RESEARCH.md "Long runs", "Why chats stopped failing"): research that lasts. Built
// from what failed in real chats: guessed page addresses (dozens of 404s), Cloudflare walls, and a
// fetch loop in the chat until the context had to be compacted. A local fake web (pages that work,
// a 404, a Cloudflare challenge, a slow page, a 429 then 200) and a scripted model.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { cardFor } from '../src/cards.ts';
import { runTurn } from '../src/chat.ts';
import { Learning, learnDeps } from '../src/learn.ts';
import { LibraryStore } from '../src/library/store.ts';
import { isSmallModel, Research, researchDeps, type ResearchRun } from '../src/research.ts';
import { SkillStore } from '../src/skill-store.ts';
import { webFetchDeps, webFetchTool } from '../src/tools/builtin.ts';
import { createResearchTools } from '../src/tools/research-tool.ts';
import { buildSystemPrompt, loadPersona } from '../src/persona.ts';
import { isBotWall, looksLikeBotWall, WEB_TURN, WebTurn } from '../src/web-guard.ts';
import { ROOT } from './helpers.ts';
import { call, listen, makeApp, tempDir, text } from './helpers.ts';

const filler = (s: string) => ` ${s}`.repeat(12);
const CF = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-wrapper">Checking if the site connection is secure. Enable JavaScript and cookies to continue</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

async function rig(t: TestContext, results: (url: (h: string, p: string) => string) => Record<string, string[]>, o: { model?: string } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-10T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: o.model ?? 'big-model', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
  app.skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), now: () => clock.now });
  const hits: Record<string, number> = {};
  let res: Record<string, string[]> = {};
  const web = await listen(async (req: IncomingMessage, out: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q')!;
      out.writeHead(200, { 'content-type': 'application/json' });
      out.end(JSON.stringify({ results: (res[q] ?? []).map((url, i) => ({ title: `Result ${i}`, url, content: url.endsWith('/cf') ? `The walled guide says warriors use two-handed weapons and a rage bar.${filler('Snippet text from the search provider.')}` : 'snippet' })) }));
      return;
    }
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    if (u.pathname === '/cf') return void out.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }).end(CF);
    if (u.pathname === '/slow') {
      await new Promise((r) => setTimeout(r, 400));
      if (!out.destroyed) out.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${filler('Slow page.')}</p>`);
      return;
    }
    if (u.pathname === '/busy' && hits[u.pathname] === 1) return void out.writeHead(429, { 'retry-after': '1', 'content-type': 'text/plain' }).end('slow down');
    if (u.pathname === '/busy') return void out.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>Busy guide</title><p>Warriors build rage when they hit or get hit, and spend it on strikes.${filler('Busy page text.')}</p><a href="/warrior-talents">Talents</a></html>`);
    if (u.pathname === '/ok') return void out.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>Warrior basics</title><p>Warriors are a melee class that wears plate armour and uses rage.${filler('Basics text.')}</p><a href="/warrior-talents">Warrior talents</a><a href="/shop">Shop</a></html>`);
    if (u.pathname === '/warrior-talents') return void out.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>Warrior talents</title><p>Warrior talents include arms, fury and protection trees.${filler('Talent text.')}</p></html>`);
    out.writeHead(404, { 'content-type': 'text/html' }).end('<html><title>Page not found</title><p>Sorry, this page does not exist.</p></html>');
  });
  const port = new URL(web.url).port;
  const url = (h: string, p: string) => `http://${h}.example:${port}${p}`;
  res = results(url);
  app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  const seams = { resolve: async (h: string) => (h.endsWith('.example') ? ['93.184.216.34'] : []), connect: () => '127.0.0.1' };
  researchDeps.seams = seams;
  researchDeps.retryMs = 10;
  researchDeps.fetchTimeoutMs = 150;
  learnDeps.seams = seams;
  learnDeps.retryMs = 10;
  const research = new Research(app, app.store.db);
  app.research = research;
  const learning = new Learning(app, app.store.db);
  app.learnTopics = learning;
  t.after(async () => {
    research.close();
    learning.close();
    researchDeps.seams = undefined;
    researchDeps.retryMs = undefined;
    researchDeps.fetchTimeoutMs = undefined;
    learnDeps.seams = undefined;
    learnDeps.retryMs = undefined;
    web.server.closeAllConnections();
    await new Promise<void>((r) => web.server.close(() => r()));
    app.store.close();
    cleanup();
  });
  return { app, research, learning, url, hits, seams };
}

async function until(research: Research, id: number, done: (r: ResearchRun) => boolean, ms = 8000): Promise<ResearchRun> {
  const end = Date.now() + ms;
  for (;;) {
    const r = research.get(id)!;
    if (done(r)) return r;
    if (Date.now() > end) throw new Error(`timed out in status ${r.status} (${JSON.stringify(r.progress)})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const PLAN = JSON.stringify({ steps: [{ question: 'What do warriors use?', searches: ['warrior guide'] }] });
const REPORT = '## Warriors\n\nWarriors are a melee class that wears plate armour and uses rage [1]. Warriors build rage when they hit or get hit [2].';

test('res web guard: bot walls are recognised, ordinary pages are not', () => {
  assert.ok(isBotWall({ status: 403, text: CF, title: 'Just a moment...' }));
  assert.ok(isBotWall({ status: 200, text: '', headers: { cfMitigated: 'challenge' } }));
  assert.ok(isBotWall({ status: 503, text: '<title>Attention Required! | Cloudflare</title>' }));
  assert.ok(isBotWall({ status: 403, text: 'Please complete the captcha to continue.' }));
  assert.ok(!isBotWall({ status: 200, text: `How to add a captcha to your signup form.${filler('Tutorial text.')}`, title: 'Captcha tutorial' }), 'a page about captchas is a page');
  assert.ok(!isBotWall({ status: 404, text: 'not found' }));
  assert.ok(looksLikeBotWall(`HTTP/2 403\n${CF}`));
  assert.ok(!looksLikeBotWall('total 12\ndrwxr-xr-x  2 alex'));
});

test('res web guard: guessed addresses are refused after 3 not-found pages on a site; found ones still work; a nudge after 8 pages', () => {
  const w = new WebTurn({ canResearch: true });
  const u = (p: string) => new URL(`https://www.icy-veins.example${p}`);
  for (const p of ['/class-warrior-guide', '/class-warrior', '/warrior-guide']) {
    assert.equal(w.before(u(p)), null);
    w.notFoundOn(u(p));
  }
  assert.match(w.before(u('/warrior'))!, /guessed addresses on icy-veins\.example were not found[\s\S]*site:icy-veins\.example/);
  w.noteFound(['https://icy-veins.example/wow/warrior-guide#top']);
  assert.equal(w.before(new URL('https://icy-veins.example/wow/warrior-guide')), null, 'an address a search gave is never refused');
  assert.equal(w.before(new URL('https://other.example/a')), null, 'other sites are not affected');
  for (let i = w.fetches; i < WEB_TURN.nudgeAfter; i++) w.before(new URL(`https://other.example/${i}`));
  assert.equal(w.nudge(), '', 'no nudge up to 8 pages');
  w.before(new URL('https://other.example/nine'));
  assert.match(w.nudge(), /research_start/);
  assert.equal(w.takeOffer(), true);
  assert.equal(w.takeOffer(), false, 'offered once a reply');
  w.blockedOn(new URL('https://walled.example/x'));
  assert.match(w.before(new URL('https://walled.example/y'))!, /blocks automated readers/);
  const quiet = new WebTurn({ canResearch: false });
  for (let i = 0; i < 9; i++) quiet.before(new URL(`https://x.example/${i}`));
  assert.doesNotMatch(quiet.nudge(), /research_start/, 'no research hint where research is not available');
  assert.equal(quiet.takeOffer(), false);
});

test('res web_fetch: a 404 is one short line (not the page), a bot wall says so, a page is a page', async (t) => {
  const { url, seams } = await rig(t, () => ({}));
  webFetchDeps.seams = seams;
  t.after(() => (webFetchDeps.seams = undefined));
  const webTurn = new WebTurn({ canResearch: true });
  const ctx = { workspaceDir: '.', signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: '' }, webTurn } as never;
  await assert.rejects(webFetchTool.run({ url: url('g', '/class-warrior-guide') }, ctx), (e: Error) => /^Not found \(HTTP 404\)[\s\S]*Don’t guess page addresses[\s\S]*site:g\.example/.test(e.message) && !/Sorry, this page/.test(e.message));
  await assert.rejects(webFetchTool.run({ url: url('w', '/cf') }, ctx), /blocks automated readers[\s\S]*Don’t retry it/);
  await assert.rejects(webFetchTool.run({ url: url('w', '/other') }, ctx), /blocks automated readers/, 'the walled site is not asked again');
  const ok = await webFetchTool.run({ url: url('a', '/ok') }, ctx);
  assert.match(ok, /^\[HTTP 200 text\/html[\s\S]*plate armour/);
  assert.ok(webTurn.known.has(url('a', '/warrior-talents')), 'links on a page read count as found');
  for (const p of ['/class-warrior', '/warrior-guide']) await assert.rejects(webFetchTool.run({ url: url('g', p) }, ctx), /Not found/);
  await assert.rejects(webFetchTool.run({ url: url('g', '/warrior') }, ctx), /were not found in this reply, so more guesses there are refused/);
});

test('res research: discovery by search and links; not found and blocked listed apart; snippet stands in; 429 then 200; slow page times out and the run goes on', async (t) => {
  const { app, research, hits } = await rig(t, (url) => ({ 'warrior guide': [url('a', '/ok'), url('a', '/missing'), url('w', '/cf'), url('a', '/slow'), url('b', '/busy')] }));
  app.script.push(text(PLAN));
  app.script.push(text(REPORT));
  const run = research.create({ question: 'How do warriors work?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.setBudget(run.id, { pages: 8 });
  research.start(run.id);
  const r = await until(research, run.id, (x) => x.status === 'done');
  const by = (end: string) => r.sources.filter((s) => s.url.endsWith(end));
  assert.equal(by('/missing')[0].reason, 'not-found');
  assert.equal(by('/cf').find((s) => s.status === 'blocked')?.reason, 'bot-wall', 'a bot wall is blocked, not failed');
  assert.equal(by('/cf').find((s) => s.status === 'read')?.via, 'snippet', "the search result's text stands in");
  assert.equal(hits['/cf'], 1, 'a bot wall is never retried');
  assert.equal(by('/slow')[0].reason, 'timeout');
  assert.equal(hits['/slow'], 3, 'a timeout is retried, then the run goes on');
  assert.equal(by('/busy')[0].status, 'read', '429 then 200: read on the second try');
  assert.equal(hits['/busy'], 2);
  assert.ok(by('/warrior-talents').some((s) => s.status === 'read'), 'a link on a page read is followed when the searches are used up');
  assert.equal(hits['/class-warrior-guide'] ?? 0, 0, 'no address is ever made up');
  const md = r.report!;
  assert.match(md, /## Sites that block automated readers[\s\S]*\/cf/);
  assert.match(md, /## Pages not found[\s\S]*\/missing/);
  assert.match(md, /from the search result: the site blocks automated readers/);
  assert.doesNotMatch(md, /Partial report/, 'a run that finished is not partial');
  assert.ok(r.tokens > 0, 'model tokens are counted');
});

test('res research: Pause and Resume go on from the checkpoint; a model that stops answering pauses the run; Write with what I have', async (t) => {
  const { app, research, hits } = await rig(t, (url) => ({ 'warrior guide': [url('a', '/ok'), url('a', '/slow'), url('b', '/busy'), url('a', '/warrior-talents')] }));
  researchDeps.fetchTimeoutMs = 1000;
  app.script.push(text(PLAN));
  const run = research.create({ question: 'How do warriors work?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  await until(research, run.id, (x) => x.sources.some((s) => s.status === 'read'));
  research.pause(run.id);
  let r = await until(research, run.id, (x) => x.status === 'paused');
  assert.equal(r.pause?.reason, 'owner');
  const readBefore = r.sources.length;
  // The writer fails 3 times (empty answers): the run pauses instead of failing.
  app.script.push(text(''), text(''), text(''));
  research.resume(run.id);
  r = await until(research, run.id, (x) => x.status === 'paused' && x.pause?.reason === 'model');
  assert.ok(r.sources.length > readBefore, 'reading went on after Resume');
  assert.equal(hits['/ok'], 1, 'a page read before the pause is not read again');
  // Resume tries the writer again: this time it answers.
  app.script.push(text(REPORT));
  research.resume(run.id);
  r = await until(research, run.id, (x) => x.status === 'done');
  assert.match(r.report!, /\[1\]\(http:\/\/a\.example:\d+\/ok\)/);
  // Another run whose writer never answers: "Write with what I have" gives a partial report without the model.
  app.script.push(text(PLAN));
  const two = research.create({ question: 'Warrior talents?' });
  await until(research, two.id, (x) => x.status === 'plan');
  research.setBudget(two.id, { pages: 4 });
  app.script.push(text(''), text(''), text(''));
  research.start(two.id);
  await until(research, two.id, (x) => x.status === 'paused' && x.pause?.reason === 'model');
  research.writeNow(two.id);
  const w = await until(research, two.id, (x) => x.status === 'done');
  assert.match(w.report!, /\*\*Partial report\*\*/);
  assert.match(w.report!, /model stopped answering/);
  assert.match(w.report!, /## What was found[\s\S]*Warrior basics/);
});

test('res research: the time budget ends reading and the report is marked partial; budgets can be raised', async (t) => {
  const { app, research } = await rig(t, (url) => ({ 'warrior guide': [url('a', '/ok'), url('b', '/busy'), url('a', '/slow')] }));
  app.script.push(text(PLAN));
  const run = research.create({ question: 'How do warriors work?' });
  let r = await until(research, run.id, (x) => x.status === 'plan');
  assert.deepEqual(r.budget, { pages: 8, minutes: 20, tokens: 120_000 });
  r = research.setBudget(run.id, { pages: 20, minutes: 40, tokens: 250_000 });
  assert.deepEqual(r.budget, { pages: 20, minutes: 40, tokens: 250_000 });
  assert.equal(research.setBudget(run.id, { pages: 999 }).budget.pages, 20, 'only the listed amounts');
  research.setBudget(run.id, { minutes: 5 });
  // Pretend 5 minutes went by (the time already spent is part of the checkpoint).
  app.store.db.prepare('UPDATE research_runs SET elapsed_ms = ? WHERE id = ?').run(5 * 60_000, run.id);
  app.script.push(text(REPORT));
  research.start(run.id);
  r = await until(research, run.id, (x) => x.status === 'done');
  assert.equal(r.cut, 'budget');
  assert.match(r.report!, /\*\*Partial report\*\*[\s\S]*used up its budget/);
});

test('res research: a small model works in short steps with a note per page; a stronger configured model is used instead when there is one', async (t) => {
  assert.equal(isSmallModel('qwen3:8b'), true);
  assert.equal(isSmallModel('gemma4:31b-cloud'), false);
  assert.equal(isSmallModel('gpt-5'), false);
  const { app, research } = await rig(t, (url) => ({ 'warrior guide': [url('a', '/ok'), url('b', '/busy')] }), { model: 'qwen3:8b' });
  assert.equal(research.modelChoice().compact, true);
  app.script.push(text(JSON.stringify({ steps: [1, 2, 3, 4, 5].map((i) => ({ question: `Q${i}`, searches: ['warrior guide', 'b', 'c'] })) })));
  const run = research.create({ question: 'How do warriors work?' });
  let r = await until(research, run.id, (x) => x.status === 'plan');
  assert.equal(r.mode, 'compact');
  assert.equal(r.plan.steps.length, 3, 'a shorter plan');
  assert.ok(r.plan.steps.every((s) => s.searches.length <= 2));
  app.script.push(text('- Warriors wear plate armour and use rage.'), text('- Warriors build rage when they hit.'), text(REPORT));
  research.start(run.id);
  r = await until(research, run.id, (x) => x.status === 'done');
  const writer = app.requests.at(-1)!.messages.map((m) => m.content).join('\n');
  assert.match(writer, /- Warriors wear plate armour and use rage\./, 'the writer gets the notes per page');
  // With a stronger model set for planning, research uses that one (full steps).
  app.settings.update({ routes: { planning: { providerId: 'p', model: 'big-planner' } } } as never);
  assert.deepEqual({ ...research.modelChoice(), model: undefined }, { purpose: 'planning', model: undefined, compact: false });
});

test('res research: Save as a skill learns from the pages read (no second read); a skill run saves itself, partial when cut short', async (t) => {
  const { app, research, learning, url, hits } = await rig(t, (url) => ({ 'warrior guide': [url('a', '/ok'), url('a', '/slow'), url('b', '/busy')] }));
  app.script.push(text(PLAN), text(REPORT));
  const run = research.create({ question: 'How do warriors work?' });
  await until(research, run.id, (x) => x.status === 'plan');
  research.start(run.id);
  await until(research, run.id, (x) => x.status === 'done');
  const fetched = { ...hits };
  app.script.push(text('## Summary\n\nWarriors are a melee class that wears plate armour [1].\n\n## Key facts\n\n- Warriors build rage when they hit or get hit [2].\n\n## Glossary\n\n- rage: what warriors spend on strikes [2].'));
  const r = research.saveAsSkill(run.id, 'weekly');
  assert.ok(r.topicId);
  const end = Date.now() + 5000;
  while (learning.get(r.topicId!)?.status !== 'ready' && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
  const topic = learning.get(r.topicId!)!;
  assert.equal(topic.status, 'ready', JSON.stringify(topic));
  assert.equal(topic.refresh, 'weekly', 'Keep it fresh');
  assert.deepEqual(hits, fetched, 'nothing was read again');
  const skill = app.skills!.get('companion', topic.skill!)!;
  assert.match(app.skills!.bodyOf(skill).body, /plate armour[\s\S]*## Sources[\s\S]*\/ok/);
  assert.equal(topic.seedRun, null, 'later refreshes search as usual');
  // A run started to make a skill, cut short with "write now": saved as a partial skill by itself.
  app.script.push(text(PLAN));
  const two = research.create({ question: 'Warrior rage?', goal: 'skill' });
  await until(research, two.id, (x) => x.status === 'plan');
  researchDeps.fetchTimeoutMs = 2000;
  research.start(two.id);
  void url;
  await until(research, two.id, (x) => x.sources.some((s) => s.status === 'read'));
  app.script.push(text(REPORT), text('## Summary\n\nWarriors are a melee class that wears plate armour [1].\n\n## Key facts\n\n- Warriors use rage [1].'));
  research.writeNow(two.id);
  const w = await until(research, two.id, (x) => x.status === 'done' && x.topicId !== null);
  const end2 = Date.now() + 5000;
  while (learning.get(w.topicId!)?.status !== 'ready' && Date.now() < end2) await new Promise((x) => setTimeout(x, 20));
  const t2 = learning.get(w.topicId!)!;
  assert.equal(t2.partial, true);
  assert.match(app.skills!.bodyOf(app.skills!.get('companion', t2.skill!)!).body, /\*\*Partial\*\*/);
});

test('res learn: the writer that stops answering still leaves partial notes (quotes, linked) for a new topic', async (t) => {
  const { app, learning, url } = await rig(t, (u) => ({ warriors: [u('a', '/ok'), u('w', '/cf'), u('b', '/busy')] }));
  void url;
  app.script.push(text(JSON.stringify({ searches: ['warriors'] })), text(''), text(''), text(''));
  const topic = learning.create({ subject: 'warriors', depth: 'quick' });
  const end = Date.now() + 6000;
  while (!['ready', 'failed'].includes(learning.get(topic.id)!.status) && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
  const got = learning.get(topic.id)!;
  assert.equal(got.status, 'ready', JSON.stringify(got));
  assert.equal(got.partial, true);
  const body = app.skills!.bodyOf(app.skills!.get('companion', got.skill!)!).body;
  assert.match(body, /Partial notes: the writer stopped answering/);
  assert.match(body, /walled guide says warriors use two-handed weapons/, 'a walled page: the search result text stood in');
});

test('res chat: research_start hands the question to a run with a plan card; many fetches in one reply get the nudge and the offer card', async (t) => {
  const { app, url, seams } = await rig(t, () => ({}));
  webFetchDeps.seams = seams;
  t.after(() => (webFetchDeps.seams = undefined));
  for (const tl of createResearchTools(() => app)) app.tools.add(tl);
  app.tools.add(webFetchTool);
  const conv = app.store.createConversation({ title: 'Game guide research' });
  // 1) She hands the work to a research run.
  app.script.push([call('c1', 'research_start', { question: 'Make me a guide for every WoW class', goal: 'skill' })], text(JSON.stringify({ steps: [{ question: 'Classes', searches: ['wow classes'] }] })), text('The plan is on the card: press Start when it looks right.'));
  const events: { type: string; card?: { kind: string }; output?: string; name?: string }[] = [];
  for await (const ev of runTurn(app, conv.id, 'Research every WoW class and make a guide skill', new AbortController().signal)) events.push(ev as never);
  const started = events.find((e) => e.type === 'tool_result' && e.name === 'research_start')!;
  assert.equal(started.card?.kind, 'research');
  const runs = app.research!.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].goal, 'skill');
  assert.equal(runs[0].conversationId, conv.id);
  assert.deepEqual(cardFor({ name: 'research_start', args: {}, status: 'ok', output: `Research run #7 is drafting a plan for “x y” (skill). …` }), { kind: 'research', id: 7, question: 'x y', goal: 'skill' });
  // 2) A reply that fetches page after page: from the 9th on the result says to start a research run, and the offer card shows once.
  const steps = Array.from({ length: 10 }, (_, i) => [call(`f${i}`, 'web_fetch', { url: url(`s${i}`, '/ok') })]);
  app.script.push(...steps, text('Here is what I found.'));
  const evs: typeof events = [];
  for await (const ev of runTurn(app, conv.id, 'Look up warrior basics on these sites', new AbortController().signal)) evs.push(ev as never);
  const results = evs.filter((e) => e.type === 'tool_result' && e.name === 'web_fetch');
  assert.equal(results.length, 10);
  assert.doesNotMatch(results[7].output!, /research_start/);
  assert.match(results[8].output!, /You have read 9 pages in this reply[\s\S]*research_start/);
  const offers = results.filter((e) => e.card?.kind === 'research-offer');
  assert.equal(offers.length, 1);
  assert.equal((offers[0].card as unknown as { question: string }).question, 'Look up warrior basics on these sites');
});

test('res persona: her instructions say to search instead of guessing, and to hand deep work to research_start', () => {
  const p = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const base = { now: new Date('2026-11-10T12:00:00Z'), timeZone: 'UTC', ownerName: 'Alex' } as never;
  const withRun = buildSystemPrompt(p, { ...(base as object), tools: ['web_search', 'web_fetch', 'research_start'] } as never);
  assert.match(withRun, /## Looking things up on the web[\s\S]*Never guess or build page addresses[\s\S]*blocks automated readers[\s\S]*call research_start/);
  const without = buildSystemPrompt(p, { ...(base as object), tools: ['web_search', 'web_fetch'] } as never);
  assert.match(without, /Never guess or build page addresses/);
  assert.doesNotMatch(without, /research_start/);
  assert.doesNotMatch(buildSystemPrompt(p, { ...(base as object), tools: ['todo'] } as never), /Looking things up on the web/);
});
