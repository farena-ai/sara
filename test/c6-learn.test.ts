// C6 (docs/ops/C6_DESIGN.md, docs/LEARN.md): learn a topic. A fake SearXNG and fake web pages (the
// names resolve to a public address; the connection goes to the local fake) and a scripted model.
// Topic mode (web search) and site mode (one site only, robots.txt, page cap, same host, rate
// limit); the knowledge skill (sources with fetched dates, the claim check); a refresh that diffs
// against the last version and keeps versions; the schedule and quiet hours; budgets; the policy
// pin; owner-only routes; delete forgets the skill and its versions; retrieval into an answer.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseCommand, runCommand, type BridgeAdapter } from '../src/bridges/commands.ts';
import { runTurn } from '../src/chat.ts';
import { learnAsk, Learning, learnDeps, parseLearnArgs, robotsAllows, type LearnTopic } from '../src/learn.ts';
import { PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { createLearnRoutes } from '../src/routes/learn.ts';
import { createSkillTools } from '../src/skill-tools.ts';
import { SkillStore } from '../src/skill-store.ts';
import { listen, makeApp, ROOT, tempDir, text } from './helpers.ts';

const filler = (s: string) => ` ${s}`.repeat(12);
type Page = { status?: number; type?: string; body: string };
const PAGES: Record<string, Page> = {
  '/heat-a': { body: `<html><head><title>Cold climate study</title></head><body><p>Modern cold-climate heat pumps keep heating at minus twenty-five degrees. Their efficiency drops as temperatures fall.${filler('Installers and households notes.')}</p></body></html>` },
  '/heat-b': { body: `<html><title>Field report</title><p>A field report from Maine found owners saved money compared with oil furnaces.${filler('Winters and electricity bills.')}</p></html>` },
  '/heat-c': { body: `<html><title>Rebates 2026</title><p>A federal rebate of two thousand dollars started in January 2026 for heat pumps.${filler('Paperwork and contractors.')}</p></html>` },
  // The site: index → docs pages (one disallowed by robots.txt, one external link, one beyond the cap).
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
  '/': { body: `<html><title>Comet docs</title><p>Comet is a scheduler for small teams.${filler('Welcome text about Comet.')}</p><a href="/guide">Guide</a> <a href="/private/keys">Keys</a> <a href="http://other.example:PORT/elsewhere">Other</a> <a href="/guide#top">Guide again</a> <a href="/release">Release</a></html>` },
  '/guide': { body: `<html><title>Comet guide</title><p>Comet runs jobs every minute and retries failed jobs three times.${filler('Guide details about Comet jobs.')}</p><a href="/">Home</a></html>` },
  '/release': { body: `<html><title>Comet 2.0</title><p>Comet version two was released on 2026-10-15 with calendar views.${filler('Release notes for Comet.')}</p></html>` },
  '/private/keys': { body: '<p>secret page that must never be read</p>' },
  '/elsewhere': { body: `<p>${filler('An external page.')}</p>` },
};

async function rig(t: TestContext, opts: { results?: Record<string, string[]> } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
  app.skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), now: () => clock.now });
  for (const tl of createSkillTools(() => app, { member: false })) app.tools.add(tl);
  const hits: { path: string; at: number }[] = [];
  const queries: string[] = [];
  const pages: Record<string, Page> = structuredClone(PAGES);
  let results: Record<string, string[]> = {};
  const web = await listen(async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q')!;
      queries.push(q);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: (results[q] ?? []).map((url, i) => ({ title: `Result ${i}`, url, content: 'snippet' })) }));
      return;
    }
    hits.push({ path: u.pathname, at: Date.now() });
    const p = pages[u.pathname];
    if (!p) return void res.writeHead(404).end();
    res.writeHead(p.status ?? 200, { 'content-type': p.type ?? 'text/html; charset=utf-8' });
    res.end(p.body.replace(/PORT/g, port));
  });
  const port = new URL(web.url).port;
  const url = (host: string, path: string) => `http://${host}.example:${port}${path}`;
  results = Object.fromEntries(Object.entries(opts.results ?? {}).map(([q, list]) => [q, list.map((x) => (x.startsWith('/') ? url('a', x) : x))]));
  app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  learnDeps.seams = { resolve: async (h: string) => (h.endsWith('.example') ? ['93.184.216.34'] : []), connect: () => '127.0.0.1' };
  learnDeps.delayMs = 0;
  const notes: { title: string; text: string }[] = [];
  (app as { push?: unknown }).push = { notifyOwner: async (title: string, body: string) => void notes.push({ title, text: body }) };
  const learning = new Learning(app, app.store.db);
  app.learnTopics = learning;
  t.after(async () => {
    learning.close();
    learnDeps.seams = undefined;
    learnDeps.delayMs = undefined;
    setPolicy(new PolicyStore());
    web.server.closeAllConnections();
    await new Promise<void>((r) => web.server.close(() => r()));
    app.store.close();
    cleanup();
  });
  return { app, learning, queries, hits, url, dir, clock, notes, pages, setResults: (r: Record<string, string[]>) => (results = Object.fromEntries(Object.entries(r).map(([q, list]) => [q, list.map((x) => (x.startsWith('/') ? url('a', x) : x))]))) };
}

const WRITER_1 = [
  '## Summary\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1].\n\n',
  '## Key facts\n\n- Modern cold-climate heat pumps keep heating at minus twenty-five degrees [1].\n- A field report from Maine found owners saved money compared with oil furnaces [2].\n- Heat pumps cure colds [9].\n\n',
  '## Glossary\n\n- Cold-climate heat pump: a model that keeps heating at minus twenty-five degrees [1].\n',
].join('');
const WRITER_2 = [
  '## Summary\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1].\n\n',
  '## Key facts\n\n- Modern cold-climate heat pumps keep heating at minus twenty-five degrees [1].\n- January 2026: a federal rebate of two thousand dollars started for heat pumps [2].\n',
].join('');

async function idle(learning: Learning, id: number, ms = 8000): Promise<LearnTopic> {
  const end = Date.now() + ms;
  for (;;) {
    const r = learning.get(id)!;
    if (r.status !== 'learning' && r.status !== 'queued') return r;
    if (Date.now() > end) throw new Error(`timed out in status ${r.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('c6 learn: topic mode searches, reads, writes a cited knowledge skill with sources and fetched dates', async (t) => {
  const { app, learning, queries } = await rig(t, { results: { 'heat pumps': ['/heat-a', '/heat-b'], 'heat pumps latest news': ['/heat-a', 'http://10.0.0.5/x'] } });
  app.script.push(text(JSON.stringify({ searches: ['heat pumps', 'heat pumps latest news'] })));
  app.script.push(text(WRITER_1));
  const topic = learning.create({ subject: 'heat pumps', depth: 'quick', refresh: 'weekly' });
  assert.equal(topic.kind, 'topic');
  const r = await idle(learning, topic.id);
  assert.equal(r.status, 'ready', r.error ?? '');
  assert.deepEqual(queries, ['heat pumps', 'heat pumps latest news']);
  assert.ok(r.skill);
  const v = app.skills!.get('companion', r.skill!)!;
  assert.equal(v.source, 'topic');
  assert.equal(v.metadata['sara-kind'], 'learned-topic');
  assert.match(v.description, /heat pumps/i);
  const body = app.skills!.bodyOf(v).body;
  assert.match(body, /## Summary[\s\S]*\[1\]\(http:\/\/a\.example:\d+\/heat-a\)/);
  assert.match(body, /## Key facts[\s\S]*Maine[\s\S]*\[2\]\(http:\/\/a\.example:\d+\/heat-b\)/);
  assert.doesNotMatch(body, /cure colds/, 'an unsupported fact is left out');
  assert.match(body, /## How to answer questions on this/);
  assert.match(body, /## Sources\n\n1\. \[Cold climate study\]\(http:\/\/a\.example:\d+\/heat-a\) · fetched 2026-11-08/);
  // The writer saw the sources fenced as text written by others.
  assert.match(app.requests.at(-1)!.messages.map((m) => m.content).join('\n'), /written by others/);
  // Run record: pages read, the blocked one failed, a token estimate.
  assert.equal(r.runs[0].pages, 2);
  assert.ok(r.runs[0].tokens > 0);
  assert.equal(r.nextDueAt, '2026-11-15T12:00:00.000Z');
});

test('c6 learn: site mode stays on the site, follows robots.txt, caps pages and rate-limits', async (t) => {
  const { app, learning, hits, url, queries } = await rig(t);
  learnDeps.delayMs = 40;
  app.script.push(text('## Summary\n\nComet is a scheduler for small teams [1].\n\n## Key facts\n\n- Comet runs jobs every minute and retries failed jobs three times [2].\n- 2026-10-15: Comet version two was released with calendar views [3].\n'));
  const topic = learning.create({ site: url('docs', '/'), scope: 'site', depth: 'quick' });
  assert.equal(topic.kind, 'site');
  const r = await idle(learning, topic.id);
  assert.equal(r.status, 'ready', r.error ?? '');
  assert.deepEqual(queries, [], 'site mode never searches the web');
  const paths = hits.map((h) => h.path);
  assert.equal(paths[0], '/robots.txt');
  assert.ok(!paths.includes('/private/keys'), 'robots.txt Disallow is respected');
  assert.ok(!paths.includes('/elsewhere'), 'another host is never fetched');
  assert.equal(paths.filter((p) => p === '/guide').length, 1, 'a page is read once');
  const pageHits = hits.filter((h) => h.path !== '/robots.txt');
  for (let i = 1; i < pageHits.length; i++) assert.ok(pageHits[i].at - pageHits[i - 1].at >= 30, 'rate limited');
  const body = app.skills!.bodyOf(app.skills!.get('companion', r.skill!)!).body;
  assert.match(body, /Comet version two/);
  assert.match(body, /## Sources[\s\S]*Comet guide/);
  // The page cap: quick reads at most LEARN.depths.quick.sitePages pages.
  assert.ok(r.runs[0].pages <= 10);
  assert.ok(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a/ok\n', '/a/ok/page'));
  assert.ok(!robotsAllows('User-agent: *\nDisallow: /a\n', '/a/x'));
  assert.ok(!robotsAllows('User-agent: Sara\nDisallow: /\n\nUser-agent: *\nAllow: /\n', '/x'));
});

test('c6 learn: a refresh diffs against the last version, keeps versions, notes what changed and tells the owner once outside quiet hours', async (t) => {
  const { app, learning, clock, notes, setResults } = await rig(t, { results: { 'heat pumps': ['/heat-a', '/heat-b'] } });
  app.script.push(text(JSON.stringify({ searches: ['heat pumps'] })));
  app.script.push(text(WRITER_1));
  const topic = learning.create({ subject: 'heat pumps', depth: 'quick', refresh: 'daily', notify: true });
  await idle(learning, topic.id);
  assert.equal(notes.length, 0, 'the first learn is not a change');
  // A day later, inside quiet hours (22–7 default): the refresh runs, the message waits.
  clock.now = new Date('2026-11-09T23:30:00Z');
  setResults({ 'heat pumps': ['/heat-a', '/heat-c'] });
  app.script.push(text(JSON.stringify({ searches: ['heat pumps'] })));
  app.script.push(text(WRITER_2));
  learning.due(clock.now);
  const r = await idle(learning, topic.id);
  assert.equal(r.status, 'ready', r.error ?? '');
  assert.equal(r.runs.length, 2);
  assert.match(r.runs[0].note!, /What changed since 2026-11-08/);
  assert.match(r.runs[0].note!, /federal rebate/);
  assert.match(r.runs[0].note!, /Maine/, 'a fact no longer in the sources is listed');
  const body = app.skills!.bodyOf(app.skills!.get('companion', r.skill!)!).body;
  assert.match(body, /## What changed since 2026-11-08/);
  const detail = app.skills!.detail('companion', r.skill!)!;
  assert.equal(detail.versions.length, 1, 'the previous SKILL.md is kept as a version');
  assert.equal(notes.length, 0, 'quiet hours: no message yet');
  clock.now = new Date('2026-11-10T09:00:00Z');
  learning.due(clock.now);
  learning.due(clock.now);
  assert.equal(notes.length, 1, 'one message after quiet hours');
  assert.match(notes[0].text, /heat pumps/);
  // A failing refresh marks it stale and keeps the last good skill.
  clock.now = new Date('2026-11-11T09:00:00Z');
  app.settings.update({ search: { provider: 'searxng', url: 'http://127.0.0.1:9' } } as never);
  setResults({});
  app.script.push(text(JSON.stringify({ searches: ['heat pumps'] })));
  learning.due(clock.now);
  const s = await idle(learning, topic.id);
  assert.equal(s.status, 'stale');
  assert.ok(app.skills!.get('companion', s.skill!), 'the skill stays');
  // Not due again until tomorrow.
  learning.due(new Date('2026-11-11T10:00:00Z'));
  assert.equal(learning.get(topic.id)!.status, 'stale');
});

test('c6 learn: budgets, content policy, the policy pin and private addresses', async (t) => {
  const { app, learning } = await rig(t, { results: { x: ['/heat-a'] } });
  // Monthly budget used up → refused.
  learning.setSettings({ monthlyTokens: 200_000 });
  assert.throws(() => learning.setSettings({ monthlyTokens: 123 }), /monthly amounts/);
  app.store.db.prepare(`INSERT INTO learn_runs (topic_id, at, pages, failed, tokens, outcome) VALUES (0, ?, 0, 0, 250000, 'ok')`).run('2026-11-02T00:00:00.000Z');
  assert.throws(() => learning.create({ subject: 'heat pumps' }), /month’s learning budget is used up/i);
  learning.setSettings({ monthlyTokens: 5_000_000 });
  assert.equal(learning.budget().used, 250_000);
  // Sexual content involving minors is always refused; explicit topics need Adult mode.
  assert.throws(() => learning.create({ subject: 'explicit sex stories with a 12 year old' }), /can’t learn/i);
  // Private and local addresses are refused for a site.
  assert.throws(() => learning.create({ site: 'http://192.168.1.10/', scope: 'site' }), /private or local/i);
  assert.throws(() => learning.create({ site: 'http://localhost:8080/', scope: 'site' }), /private or local/i);
  // The policy pin.
  assert.deepEqual(validatePolicy({ pins: { learning: false } }).pins, { learning: false });
  assert.throws(() => validatePolicy({ pins: { learning: true } }), /pinned off/);
  const { dir: pdir, cleanup } = tempDir();
  t.after(cleanup);
  const pol = new PolicyStore(pdir);
  pol.set({ pins: { learning: false } });
  setPolicy(pol);
  assert.match(learning.refusal('topic') ?? '', /admin/i);
  assert.throws(() => learning.create({ subject: 'heat pumps' }), /admin/i);
  setPolicy(new PolicyStore());
  // Per-run token cap: the writer prompt is held under the depth's cap.
  assert.ok(learning.caps('quick').tokens < learning.caps('deep').tokens);
});

test('c6 learn: /learn and the natural ask, owner only; delete forgets the skill and its versions', async (t) => {
  const { app, learning } = await rig(t, { results: { 'comet scheduler': ['/heat-a'] } });
  assert.deepEqual(parseLearnArgs('https://docs.example.com weekly deep'), { site: 'https://docs.example.com', scope: 'site', refresh: 'weekly', depth: 'deep' });
  assert.deepEqual(parseLearnArgs('the Artemis program monthly'), { subject: 'the Artemis program', refresh: 'monthly' });
  assert.equal(learnAsk('learn about the Artemis program'), 'the Artemis program');
  assert.equal(learnAsk('Can you keep up with heat pump rebates?'), 'heat pump rebates');
  assert.equal(learnAsk('I learned about it yesterday'), null);
  const conv = app.store.createConversation();
  const adapter: BridgeAdapter = { currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 } as unknown as BridgeAdapter;
  const cmd = parseCommand('/learn comet scheduler', { herName: 'Sara', namePrefix: false })!;
  assert.equal(cmd.name, 'learn');
  app.script.push(text(JSON.stringify({ searches: ['comet scheduler'] })));
  app.script.push(text('## Summary\n\nModern cold-climate heat pumps keep heating at minus twenty-five degrees [1].\n'));
  // 3.0.3: /learn makes and changes its skill without an approval card.
  let approvalsAsked = 0;
  app.approvals.onChange(() => approvalsAsked++);
  const r = await runCommand({ app, bridge: 'web', place: 'owner-dm', who: 'owner', lang: 'en', cmd, adapter });
  assert.match(r.text, /comet scheduler/);
  assert.match(r.text, /What she has learned/);
  const other = await runCommand({ app, bridge: 'telegram', place: 'partner-dm', who: 'person', lang: 'en', cmd, adapter });
  assert.ok(other.refused);
  const topic = learning.list()[0];
  const done = await idle(learning, topic.id);
  assert.equal(done.status, 'ready', done.error ?? '');
  const v = app.skills!.get('companion', done.skill!)!;
  // A manual refresh makes a version; delete forgets it all.
  app.script.push(text(JSON.stringify({ searches: ['comet scheduler'] })));
  app.script.push(text('## Summary\n\nTheir efficiency drops as temperatures fall [1].\n'));
  learning.refresh(topic.id);
  await idle(learning, topic.id);
  assert.equal(app.skills!.detail('companion', v.name)!.versions.length, 1);
  assert.equal(approvalsAsked, 0, 'no approval for the learned skill or its refresh');
  assert.ok(learning.delete(topic.id));
  assert.equal(learning.get(topic.id), undefined);
  assert.equal(app.skills!.get('companion', v.name), undefined);
  assert.ok(!existsSync(v.dir), 'the folder is gone (not in the trash)');
  assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM skill_versions WHERE name = ?').get(v.name) as { n: number }).n, 0);
});

test('c6 learn: a question that matches a learned topic loads it, and her answer is told to cite its sources', async (t) => {
  const { app, learning } = await rig(t, { results: { 'heat pumps': ['/heat-a', '/heat-b'] } });
  app.script.push(text(JSON.stringify({ searches: ['heat pumps'] })));
  app.script.push(text(WRITER_1));
  const topic = learning.create({ subject: 'heat pumps', depth: 'quick' });
  await idle(learning, topic.id);
  assert.equal(await learning.forQuestion('what is the weather like?'), undefined);
  const conv = app.store.createConversation();
  app.script.push(text('They keep heating at minus twenty-five degrees, says the [Cold climate study](http://a.example/heat-a).'));
  const events: { type: string; name?: string }[] = [];
  for await (const ev of runTurn(app, conv.id, 'Do heat pumps still work when it is really cold?')) events.push(ev as never);
  assert.ok(events.some((e) => e.type === 'skill' && /heat-pumps/.test(e.name ?? '')), 'the learned topic was loaded');
  const sent = app.requests.at(-1)!.messages.map((m) => m.content).join('\n');
  assert.match(sent, /## Key facts[\s\S]*minus twenty-five/);
  assert.match(sent, /cite/i);
  assert.match(sent, /learned on 2026-11-08/);
});

test('c6 learn: the routes are the owner\'s only; the Library page, the budget and the policy pin are wired with tips', async (t) => {
  const { app } = await rig(t);
  for (const opts of [{ member: true }, { demo: true }]) {
    const route = createLearnRoutes({ app, opts } as never);
    await assert.rejects(Promise.resolve(route({ method: 'GET', headers: {} } as never, {} as never, 'GET', ['learn'])), (e: { status?: number }) => e.status === 403);
  }
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="lib-topics-open"[^>]*>What she has learned…<\/button> <button type="button" class="tip"/);
  assert.match(html, /<section id="lib-topics" hidden>/);
  assert.match(html, /<h3>Learning a topic <button type="button" class="tip"[\s\S]*id="learn-monthly"/);
  assert.match(html, /id="po-learning" type="checkbox"> Turn off Learn a topic <button type="button" class="tip"/);
  const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(js, /'ab-budgets': \[saveBudgets, saveLearnBudget\]/);
  assert.match(js, /LEARN_ASK\.test\(text\)/);
  assert.match(readFileSync(join(ROOT, 'web', 'policy-pins.js'), 'utf8'), /key: 'learning'.*form: '#po-learning', kind: 'flag', value: false, locks: \['#lib-topics-open'\]/);
  assert.match(readFileSync(join(ROOT, 'web', 'library.js'), 'utf8'), /openLearned\(\)/);
});
