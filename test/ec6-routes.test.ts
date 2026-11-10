// EC6 slice 3: the research routes. Owner only (household members and the demo get 403); the plan
// is edited and approved over HTTP; the finished report downloads as Markdown, Word and PDF (the
// files open: a docx zip with document.xml, a PDF with its header and %%EOF); the policy pin to
// "never" on web_fetch refuses a new run server side.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { Research, researchDeps } from '../src/research.ts';
import { createSaraServer } from '../src/server.ts';
import { listen, makeApp, ROOT, tempDir, text } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => new Date('2026-11-07T12:00:00Z'));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  const web = await listen((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ results: [{ title: 'Page', url: `http://a.example:${port}/page`, content: '' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Tide tables</title><p>${'Spring tides happen twice a month near the new and full moon. '.repeat(8)}</p>`);
  });
  const port = new URL(web.url).port;
  app.settings.update({ search: { provider: 'searxng', url: web.url } } as never);
  researchDeps.seams = { resolve: async () => ['93.184.216.34'], connect: () => '127.0.0.1' };
  app.research = new Research(app, app.store.db);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    app.research?.close();
    researchDeps.seams = undefined;
    server.closeAllConnections();
    web.server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(auth.newToken ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, disposition: res.headers.get('content-disposition') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  }
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const r = await api(path, method, body);
    return { status: r.status, body: JSON.parse(r.bytes.toString('utf8') || '{}') };
  };
  return { app, api, json };
}

async function waitFor(json: (p: string) => Promise<{ body: any }>, id: number, status: string) {
  for (let i = 0; i < 400; i++) {
    const r = await json(`/api/research/${id}`);
    if (r.body.run?.status === status) return r.body.run;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`never reached ${status}`);
}

test('ec6 routes: ask, edit the plan, approve, and download the report as Markdown, Word and PDF', async (t) => {
  const { app, api, json } = await rig(t);
  app.script.push(text(JSON.stringify({ steps: [{ question: 'When are spring tides?', searches: ['spring tides'] }] })));
  app.script.push(text('## Spring tides\n\nSpring tides happen twice a month near the new and full moon [1].'));
  const list = await json('/api/research');
  assert.equal(list.status, 200);
  assert.equal(list.body.ready, true);
  assert.deepEqual(list.body.limits.pageChoices, [4, 8, 12, 20]);
  const made = await json('/api/research', 'POST', { question: 'When are spring tides?' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.run.id;
  await waitFor(json, id, 'plan');
  const edited = await json(`/api/research/${id}/plan`, 'PUT', { steps: [{ question: 'Spring tides timing', searches: ['spring tides'] }], pages: 4 });
  assert.equal(edited.body.run.plan.pages, 4);
  assert.equal((await json(`/api/research/${id}/start`, 'POST', {})).status, 200);
  const run = await waitFor(json, id, 'done');
  assert.equal(run.sources[0].status, 'read');
  assert.equal(run.sources[0].text, undefined, 'page text stays on the server');
  assert.match(run.sources[0].reasonText ?? '', /^$/);
  const md = await api(`/api/research/${id}/export?format=md`);
  assert.match(md.type, /text\/markdown/);
  assert.match(md.bytes.toString('utf8'), /\[1\]\(http:\/\/a\.example:\d+\/page\)/);
  const docx = await api(`/api/research/${id}/export?format=docx`);
  assert.equal(docx.status, 200);
  assert.match(docx.type, /wordprocessingml/);
  assert.match(docx.disposition, /attachment; filename="Research - When are spring tides.docx"/);
  assert.match(new Zip(docx.bytes).read('word/document.xml').toString('utf8'), /Spring tides happen twice a month/);
  const pdf = await api(`/api/research/${id}/export?format=pdf`);
  assert.equal(pdf.type, 'application/pdf');
  assert.ok(pdf.bytes.subarray(0, 8).toString('latin1') === '%PDF-1.4');
  assert.ok(pdf.bytes.toString('latin1').trimEnd().endsWith('%%EOF'));
  assert.equal((await api(`/api/research/${id}/export?format=exe`)).status, 400);
  // Stop on a finished run is refused; delete works.
  assert.equal((await json(`/api/research/${id}/stop`, 'POST', {})).status, 409);
  assert.equal((await json(`/api/research/${id}`, 'DELETE')).status, 200);
  assert.equal((await json(`/api/research/${id}`)).status, 404);
});

test('ec6 routes: a policy of never on web pages refuses a run; bad input is refused', async (t) => {
  const { app, json } = await rig(t);
  assert.equal((await json('/api/research', 'POST', { question: '' })).status, 400);
  app.settings.update({ toolPermissions: { web_fetch: 'never' } } as never);
  const r = await json('/api/research', 'POST', { question: 'When are spring tides?' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Web pages are switched off/);
  assert.equal((await json('/api/research')).body.ready, false);
});

for (const mode of ['member', 'demo'] as const) {
  test(`ec6 routes: research is the owner's (${mode} gets 403)`, async (t) => {
    const { json } = await rig(t, mode);
    assert.equal((await json('/api/research')).status, 403);
    assert.equal((await json('/api/research', 'POST', { question: 'When are spring tides?' })).status, 403);
  });
}

test('ec6 routes (3.1.2): budget, pause and resume over HTTP; the run view carries counts and partial', async (t) => {
  const { app, json } = await rig(t);
  app.script.push(text(JSON.stringify({ steps: [{ question: 'Tides', searches: ['tides'] }] })));
  const made = await json('/api/research', 'POST', { question: 'When are spring tides?' });
  const id = made.body.run.id;
  await waitFor(json, id, 'plan');
  const list = await json('/api/research');
  assert.deepEqual(list.body.limits.budgetMinutes, [5, 10, 20, 40, 60]);
  assert.equal(typeof list.body.model.compact, 'boolean');
  let r = await json(`/api/research/${id}/budget`, 'PUT', { pages: 12, minutes: 40 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.run.budget.pages, r.body.run.budget.minutes], [12, 40]);
  assert.equal((await json(`/api/research/${id}/pause`, 'POST', {})).status, 409, 'only a working run pauses');
  assert.equal((await json(`/api/research/${id}/resume`, 'POST', {})).status, 409, 'only a paused run resumes');
  app.script.push(text('## Tides\n\nSpring tides happen twice a month near the new and full moon [1].'));
  await json(`/api/research/${id}/start`, 'POST', {});
  r = await waitFor(json, id, 'done');
  const run = (await json(`/api/research/${id}`)).body.run;
  assert.deepEqual(run.counts, { read: 1, blocked: 0, notFound: 0, failed: 0 });
  assert.equal(run.partial, false);
  assert.equal((await json(`/api/research/${id}/skill`, 'POST', {})).status, 409, 'Save as a skill needs skills (none in this fixture), and says so');
});
