// Fred fix C (shelton, 2026-11-12T08:06:29Z, 502 in 2.5 s): "Report a problem" said "The support
// desk didn't answer" although the hub answered. The hub validates strictly (sara-hub
// src/validate.ts TICKET_SCHEMA) and refused 3.6.x reports twice over: `diagnostics.system` is not
// an allowed field, and a "Report this" report has an empty body (body needs ≥ 1 character).
// The fake hub below enforces that same contract.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { HubState, scrubText, TicketStore, ticketWire, type HubFacts, type HubSpace } from '../src/hub.ts';
import { ticketError } from '../src/routes/hub.ts';
import { createReportProblemTool } from '../src/tools/report-problem.ts';
import { createSaraServer } from '../src/server.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { call, makeApp, readBody, ROOT, tempDir, text } from './helpers.ts';

const FACTS: HubFacts = { version: '3.6.1', channel: 'desktop-app', os: 'linux', arch: 'x64', lang: 'en', companions: 1, members: 0, bridges: [], features: [], model: 'local' };

/** The hub's TICKET_SCHEMA keys (sara-hub/src/validate.ts, deployed /opt/sara-hub). */
const TOP = new Set(['v', 'id', 'kind', 'title', 'body', 'contact', 'lang', 'version', 'os', 'diagnostics', 'pow']);
const DIAG = new Set(['log', 'error', 'settingsShape', 'steps']);
function hubCheck(b: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(b)) if (!TOP.has(k)) return `body.${k} is not an allowed field`;
  for (const k of ['v', 'id', 'kind', 'title', 'body', 'pow']) if (!(k in b)) return `body.${k} is required`;
  if (typeof b.body !== 'string' || !b.body.length) return 'body.body is empty';
  if (typeof b.title !== 'string' || !b.title.length || b.title.length > 120) return 'body.title is not valid';
  if (b.body.length > 8000) return 'body.body is too long';
  const d = b.diagnostics as Record<string, unknown> | undefined;
  if (d) for (const k of Object.keys(d)) if (!DIAG.has(k)) return `body.diagnostics.${k} is not an allowed field`;
  if (d && typeof d.log === 'string' && d.log.length > 65536) return 'body.diagnostics.log is too long';
  return undefined;
}

async function strictHub(t: TestContext, o: { down?: boolean } = {}) {
  const seen: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const b = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    seen.push(b);
    if (o.down) return req.socket.destroy();
    const bad = hubCheck(b);
    res.writeHead(bad ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bad ? { ok: false, error: 'invalid', message: bad } : { ok: true, ticket: 'SARA-42', token: 'f'.repeat(32) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sara/hub` };
}

function setup(t: TestContext, base: string) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-12T08:06:00Z') });
  const state = new HubState(dir);
  state.update({ noticeShownAt: '2026-11-12T07:00:00Z', powBits: 8 });
  const db = new DatabaseSync(join(dir, 'hub-test.db'));
  t.after(() => {
    db.close();
    app.store.close();
    setPrivateLocal(false);
    cleanup();
  });
  const hub: HubSpace = {
    state,
    base,
    member: false,
    demo: false,
    tickets: new TicketStore(db),
    facts: () => FACTS,
    blocked: () => undefined,
    scrub: (s) => scrubText(s, (x) => app.redactor.redact(x), { homes: [homedir()], dirs: [dir] }),
    logLines: () => 'Sara is listening',
  };
  app.hub = hub;
  return { app, dir, hub };
}

async function serve(t: TestContext, app: ReturnType<typeof makeApp>, dir: string) {
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = w;
  }
}

test('C: a "Report this" report (empty body, every diagnostics part ticked) passes the hub’s strict schema', async (t) => {
  const hubSrv = await strictHub(t);
  const { app, dir } = setup(t, hubSrv.base);
  const api = await serve(t, app, dir);
  const d = (await api('POST', '/hub/diagnostics', { error: 'The model returned an empty reply.' })).json.diagnostics;
  assert.match(d.system, /^Sara 3\.6\.1/, 'the page still shows the system line');
  const r = await api('POST', '/hub/tickets', { kind: 'bug', title: 'The model returned an empty reply.', body: '', contact: '', diagnostics: d });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const sent = hubSrv.seen.at(-1)!;
  assert.ok(String(sent.body).length > 0, 'a body always goes');
  const diag = sent.diagnostics as Record<string, unknown>;
  assert.deepEqual(Object.keys(diag).filter((k) => !DIAG.has(k)), [], 'only fields the hub accepts');
  assert.match(String(diag.log), /Sara 3\.6\.1/, 'the system line rides in the log instead');
});

test('C: ticketWire keeps exactly the hub’s fields', () => {
  const w = ticketWire({ kind: 'bug', title: 'x', body: '', lang: 'en', version: '3.6.1', os: 'windows', diagnostics: { system: 'Sara 3.6.1', error: 'e', frame: 'app', steps: [{ tool: 'a', status: 'ok' }] } as never, extra: 1 } as never);
  assert.deepEqual(Object.keys(w).sort(), ['body', 'diagnostics', 'kind', 'lang', 'os', 'title', 'version']);
  assert.equal(w.body, 'x', 'an empty body becomes the title');
  assert.deepEqual(Object.keys(w.diagnostics!).sort(), ['error', 'log', 'steps']);
});

test('C: ticketError says what the hub said (refused) apart from no answer at all', () => {
  const e = ticketError('refused', 'body.diagnostics.frame is not an allowed field');
  assert.equal(e.status, 502);
  assert.equal(e.message, 'The support desk refused the report: body.diagnostics.frame is not an allowed field');
  assert.match(ticketError('down').message, /didn't answer/);
});

test('C: a hub that does not answer: "didn’t answer", and the server logs why', async (t) => {
  const dead = await strictHub(t, { down: true });
  const { app, dir } = setup(t, dead.base);
  const api = await serve(t, app, dir);
  const { value: r, lines } = await quiet(() => api('POST', '/hub/tickets', { kind: 'bug', title: 'ok', body: 'b' }));
  assert.equal(r.status, 502);
  assert.match(String(r.json.error), /didn.t answer/);
  assert.ok(lines.some((l) => /hub: .*ticket/i.test(l)), lines.join(' | '));
});

test('C: a refusing hub: 502 with the hub’s reason, logged', async (t) => {
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    seen.push(await readBody(req));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid', message: 'body.install is not an allowed field' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const { app, dir } = setup(t, `http://127.0.0.1:${(server.address() as AddressInfo).port}/sara/hub`);
  const api = await serve(t, app, dir);
  const { value: r, lines } = await quiet(() => api('POST', '/hub/tickets', { kind: 'bug', title: 'ok', body: 'b' }));
  assert.equal(r.status, 502);
  assert.match(String(r.json.error), /The support desk refused the report: body\.install is not an allowed field/);
  assert.ok(lines.some((l) => /refused.*body\.install/.test(l)), lines.join(' | '));
});

test('C: report_problem drafts the report with the last error, asks first, and sends only after the OK', async (t) => {
  const hubSrv = await strictHub(t);
  const { app } = setup(t, hubSrv.base);
  app.tools.add(createReportProblemTool(() => app));
  app.settings.update({ providers: [{ id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'm' }], defaultProviderId: 'c', defaultModel: 'm', disclosureAcceptedAt: '2026-11-12T00:00:00Z' } as never);
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'notice', 'turnerror:Ollama on this computer (beam:cloud) wrote only its private reasoning and no answer (twice).', { error: 'Ollama on this computer (beam:cloud) wrote only its private reasoning and no answer (twice).', errorClass: 'EmptyReply' });
  const run = async (yes: boolean) => {
    app.script.push([call(`r${yes}`, 'report_problem', { title: 'Replies fail with beam:cloud', what_happened: 'My question got no answer twice.' })], text('Done.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(app, conv.id, 'please tell the support desk')) {
      evs.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, yes);
    }
    return evs;
  };
  const before = hubSrv.seen.length;
  const no = await run(false);
  const card = no.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }> | undefined;
  assert.ok(card, 'she asks first');
  assert.match(card.summary, /Replies fail with beam:cloud/);
  assert.match(card.summary, /private reasoning/, 'the last error is in the draft');
  assert.equal(hubSrv.seen.length, before, 'nothing sent without the OK');
  const yes = await run(true);
  const res = yes.find((e) => e.type === 'tool_result' && e.name === 'report_problem') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.equal(res.status, 'ok', res.output);
  assert.match(res.output, /SARA-42/);
  const sent = hubSrv.seen.at(-1)!;
  assert.match(String((sent.diagnostics as { error?: string }).error), /private reasoning/);
  assert.equal(app.hub!.tickets.list().length, 1, 'in My reports');
});
