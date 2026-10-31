// Phase 71: household isolation, end to end. Starts the real server (src/main.ts) on a scratch data
// folder with a fake OpenAI-compatible model, signs in the owner and two members, gives each private
// data with a unique marker, then tries EVERY route family found in src/server.ts (and /v1, /mcp, the
// events stream, uploads, library files, companion faces, exports, search) as each person with the
// others' ids. Nothing of another person may come back, and nothing may be changed.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from './helpers.ts';

const mark = (who: string) => `MARK-${who}-${randomBytes(6).toString('hex')}`;
const M = { owner: mark('OWNER'), a: mark('ANA'), b: mark('BEN') };
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A tiny PNG that differs per person (trailing bytes), so each photo has its own content hash. */
const png = (who: string) => `data:image/png;base64,${Buffer.concat([PNG_BASE, Buffer.from(who)]).toString('base64')}`;

// ---- the fake model: records every request (to check no prompt mixes two people) ----
const llmRequests: { model: string; text: string; tools: string[] }[] = [];
let llm: Server;
let llmPort = 0;

// ---- the real server ----
let child: ChildProcess;
let dataDir = '';
let base = '';
let log = '';

interface Person {
  name: string;
  cookie: string;
  token: string;
  marker: string;
  conv: string;
  convs: string[];
  upload?: string;
  doc?: number;
  memberId?: string;
}
const owner: Person = { name: 'owner', cookie: '', token: '', marker: M.owner, conv: '', convs: [] };
const ana: Person = { name: 'ana', cookie: '', token: '', marker: M.a, conv: '', convs: [] };
const ben: Person = { name: 'ben', cookie: '', token: '', marker: M.b, conv: '', convs: [] };
let ownerSecondCompanion = '';

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

interface Res {
  status: number;
  text: string;
  json: Record<string, unknown> & { error?: string };
  cookie?: string;
}
async function call(who: Person | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 120_000): Promise<Res> {
  // 120 s: this file runs a real server beside the rest of the suite; on a loaded 8-core server single
  // requests took over 30 s while all test files ran at once (alone the whole file takes ~100 s).
  const h: Record<string, string> = { ...headers };
  if (who?.cookie) h.cookie = `sara_session=${who.cookie}`;
  let payload: string | Uint8Array | undefined;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) payload = new Uint8Array(body);
    else {
      h['content-type'] ??= 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const r = await fetch(`${base}${path}`, { method, headers: h, ...(payload !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: payload as RequestInit['body'] } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json: Res['json'] = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const set = r.headers.get('set-cookie') ?? '';
  const m = /sara_session=([^;]*)/.exec(set);
  return { status: r.status, text, json, ...(m ? { cookie: decodeURIComponent(m[1]) } : {}) };
}
const say = async (who: Person, conv: string, content: string, extra: Record<string, unknown> = {}) => call(who, 'POST', `/api/conversations/${conv}/messages`, { content, ...extra });

before(async () => {
  llm = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }, { id: 'fake-2', object: 'model' }] }));
      }
      let body: { model?: string; stream?: boolean; messages?: unknown; tools?: { function?: { name?: string } }[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* ignore */
      }
      llmRequests.push({ model: String(body.model), text: JSON.stringify(body.messages ?? ''), tools: (body.tools ?? []).map((t) => String(t.function?.name)) });
      const reply = 'Noted, thanks.';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  llmPort = (llm.address() as AddressInfo).port;

  dataDir = mkdtempSync(join(tmpdir(), 'sara-household-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: dataDir, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_VOICE_DIR: join(dataDir, 'novoice') };
  delete env.NODE_TEST_CONTEXT;
  delete env.SARA_DEMO;
  delete env.SARA_PRIVATE_LOCAL;
  child = spawn(process.execPath, [join(ROOT, 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  // Generous: on a busy shared server (load 10+) a cold start has taken over 60 s.
  const until = Date.now() + 180_000;
  for (;;) {
    const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > until || child.exitCode !== null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  owner.token = readFileSync(join(dataDir, 'first-token.txt'), 'utf8').trim();
});

after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 500));
  llm?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

test('a server with no members behaves as before (no household files, owner signs in as always)', async () => {
  const login = await call(null, 'POST', '/api/login', { token: owner.token });
  assert.equal(login.status, 200, login.text);
  owner.cookie = login.cookie!;
  assert.ok(!existsSync(join(dataDir, 'household.json')), 'nothing is written until the first invite');
  assert.ok(!existsSync(join(dataDir, 'members')));
  const s = await call(owner, 'GET', '/api/session');
  assert.equal(s.json.role, 'owner');
  assert.equal(s.json.household, true);
  // Set up a model and the owner's private data.
  const prov = await call(owner, 'PUT', '/api/providers/fake', { kind: 'openai-compatible', label: 'Fake models', baseUrl: `http://127.0.0.1:${llmPort}/v1`, defaultModel: 'fake-1', needsKey: true, apiKey: 'sk-owner-secret-key-0123456789abcdef' });
  assert.equal(prov.status, 200, prov.text);
  assert.equal((await call(owner, 'PUT', '/api/settings', { defaultProviderId: 'fake', defaultModel: 'fake-1', ownerName: 'Alex' })).status, 200);
  assert.equal((await call(owner, 'POST', '/api/disclosure/accept', {})).status, 200);
  const comp = await call(owner, 'POST', '/api/companions', { name: 'Zelda', pronouns: 'she' });
  assert.equal(comp.status, 200, comp.text);
  ownerSecondCompanion = String(comp.json.id);
  const conv = await call(owner, 'POST', '/api/conversations', {});
  owner.conv = String(conv.json.id);
  owner.convs.push(owner.conv);
  const r = await say(owner, owner.conv, `Remember this: ${M.owner}`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Noted/);
  assert.equal((await call(owner, 'POST', '/api/notes', { body: `owner note ${M.owner}` })).status, 201);
});

test('invites: 18+ confirmation, a model, single use, revoke', async () => {
  const hh = await call(owner, 'GET', '/api/household');
  assert.equal(hh.status, 200, hh.text);
  const models = hh.json.models as { providerId: string; model: string }[];
  assert.ok(models.some((m) => m.model === 'fake-1'), JSON.stringify(models));
  const limits = { models: [{ providerId: 'fake', model: 'fake-1' }], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true };
  assert.equal((await call(owner, 'POST', '/api/household/invites', { name: 'Ana', hours: 24, limits })).status, 400, 'owner must confirm 18+');
  assert.equal((await call(owner, 'POST', '/api/household/invites', { name: 'Ana', hours: 24, confirm18: true, limits: { ...limits, models: [{ providerId: 'fake', model: 'not-there' }] } })).status, 400);
  const ia = await call(owner, 'POST', '/api/household/invites', { name: 'Ana', hours: 24, confirm18: true, limits });
  assert.equal(ia.status, 200, ia.text);
  const ib = await call(owner, 'POST', '/api/household/invites', { name: 'Ben', hours: 1, confirm18: true, limits });
  const ic = await call(owner, 'POST', '/api/household/invites', { name: 'Cleo', hours: 1, confirm18: true, limits });
  assert.match(String(ia.json.url), /\/#join=/);
  // Only the code's hash is kept.
  const file = readFileSync(join(dataDir, 'household.json'), 'utf8');
  for (const r of [ia, ib, ic]) assert.ok(!file.includes(String(r.json.code)) && !file.includes(String(r.json.code).replace(/-/g, '')));
  // Revoke Cleo's: it stops working.
  assert.equal((await call(owner, 'DELETE', `/api/household/invites/${(ic.json.invite as { id: string }).id}`)).status, 200);
  assert.equal((await call(null, 'GET', `/api/household/join?code=${ic.json.code}`)).status, 404);
  // Joining needs the member's own 18+ confirmation.
  assert.equal((await call(null, 'GET', `/api/household/join?code=${ia.json.code}`)).json.invite && true, true);
  assert.equal((await call(null, 'POST', '/api/household/join', { code: ia.json.code })).status, 400);
  const ja = await call(null, 'POST', '/api/household/join', { code: ia.json.code, confirm18: true });
  assert.equal(ja.status, 200, ja.text);
  ana.token = String(ja.json.token);
  ana.cookie = ja.cookie!;
  assert.match(ana.token, /^sara_m\.[a-f0-9]{10}\./);
  assert.equal((await call(null, 'POST', '/api/household/join', { code: ia.json.code, confirm18: true })).status, 404, 'an invite works once');
  const jb = await call(null, 'POST', '/api/household/join', { code: ib.json.code, confirm18: true });
  assert.equal(jb.status, 200, jb.text);
  ben.token = String(jb.json.token);
  ben.cookie = jb.cookie!;
  const list = (await call(owner, 'GET', '/api/household')).json.members as { id: string; name: string }[];
  ana.memberId = list.find((m) => m.name === 'Ana')!.id;
  ben.memberId = list.find((m) => m.name === 'Ben')!.id;
  assert.ok(existsSync(join(dataDir, 'members', ana.memberId, 'sara.db')));
});

test('members get their own space: own companion, conversations, notes, uploads, library', async () => {
  for (const p of [ana, ben]) {
    const s = await call(p, 'GET', '/api/session');
    assert.equal(s.json.role, 'member');
    assert.equal(s.json.disclosureAccepted, false, 'each member accepts the AI notice themselves');
    assert.equal((await call(p, 'POST', '/api/disclosure/accept', {})).status, 200);
    assert.deepEqual(await call(p, 'GET', '/api/conversations').then((r) => (JSON.parse(r.text) as unknown[]).length), 0);
    const conv = await call(p, 'POST', '/api/conversations', {});
    p.conv = String(conv.json.id);
    p.convs.push(p.conv);
    const r = await say(p, p.conv, `My private thing is ${p.marker}`, { images: [png(p.name)] });
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /Noted/);
    assert.match(r.text, /disclosure/, 'the AI notice is shown at the start of a member\'s first session');
    const msgs = (await call(p, 'GET', `/api/conversations/${p.conv}`)).json.messages as { role: string; meta?: { images?: string[] } }[];
    p.upload = msgs.find((m) => m.role === 'user')?.meta?.images?.[0];
    assert.ok(p.upload);
    assert.equal((await call(p, 'POST', '/api/notes', { body: `note ${p.marker}` })).status, 201);
    const doc = await call(p, 'POST', '/api/library?name=private.txt&learn=0', Buffer.from(`My library ${p.marker}`), { 'content-type': 'application/octet-stream' });
    assert.ok(doc.status === 200 || doc.status === 201, doc.text);
    p.doc = Number((doc.json.doc as { id: number }).id);
  }
  const op = await call(owner, 'POST', '/api/library?name=owner.txt&learn=0', Buffer.from(`Owner library ${M.owner}`), { 'content-type': 'application/octet-stream' });
  owner.doc = Number((op.json.doc as { id: number }).id);
  const om = (await call(owner, 'POST', `/api/conversations/${owner.conv}/messages`, { content: 'a photo', images: [png('owner')] }));
  assert.equal(om.status, 200);
  owner.upload = ((await call(owner, 'GET', `/api/conversations/${owner.conv}`)).json.messages as { meta?: { images?: string[] } }[]).find((m) => m.meta?.images)?.meta?.images?.[0];
  // A member's providers list: only the allowed model, no address, no key.
  const pv = await call(ana, 'GET', '/api/providers');
  assert.equal(pv.status, 200);
  assert.ok(!pv.text.includes(String(llmPort)) && !pv.text.includes('sk-owner'), pv.text);
  assert.deepEqual((pv.json.providers as { id: string; defaultModel: string }[]).map((p) => `${p.id}/${p.defaultModel}`), ['fake/fake-1']);
});

/** Every route family in src/server.ts and its route modules (src/routes/), with the second path parts it knows. */
function routeFamilies(): Map<string, Set<string>> {
  const routes = join(ROOT, 'src', 'routes');
  const src = [join(ROOT, 'src', 'server.ts'), ...readdirSync(routes).filter((f) => f.endsWith('.ts')).sort().map((f) => join(routes, f))].map((f) => readFileSync(f, 'utf8')).join('\n');
  const fam = new Map<string, Set<string>>();
  for (const m of src.matchAll(/a === '([\w-]+)'/g)) if (!fam.has(m[1])) fam.set(m[1], new Set());
  for (const m of src.matchAll(/a === '([\w-]+)' && b === '([\w-]+)'/g)) fam.get(m[1])!.add(m[2]);
  for (const m of src.matchAll(/a === '([\w-]+)' && \(b === '([\w-]+)' \|\| b === '([\w-]+)'\)/g)) {
    fam.get(m[1])!.add(m[2]);
    fam.get(m[1])!.add(m[3]);
  }
  return fam;
}
/** Owner-only route families (a member gets 403 ownerOnly). Every family must be in one of the two lists. */
const OWNER_ONLY = ['backups', 'update', 'doctor', 'logs', 'status', 'health', 'access', 'private-local', 'local-models', 'subscriptions', 'mcp', 'bridges', 'github', 'github-watch', 'google', 'home', 'ssh', 'workspaces', 'jobs', 'previews', 'team', 'codemap', 'code-projects', 'starters', 'recipes', 'history-import', 'import', 'model-jobs', 'tools', 'search', 'desktop-apps', 'claim', 'demo', 'public', 'login', 'telegram', 'discord', 'budgets', 'sandbox', 'security-pass', 'findings', 'threat-model', 'evals', 'redteam',
  // Phase 98 (ST3): plugins: install, enable, settings, update, rollback, remove, log, calls (owner only).
  'plugins',
  // Phase 102 (ST7): webhooks: list, make, change, rotate, test, log, enable, remove (owner only).
  'hooks',
  // Phase 104 (MI1): move in from another agent: the collector, codes, uploads, preview, import, Undo (owner only).
  'movein',
  // Phase 87: computer use. Member routes in src/household.ts, but answered 403 ownerOnly while the
  // owner's "Let household members use computer use" is off (the default, as here).
  'hands', 'computer'];
/**
 * Owner-only paths inside a member family (Phase 83: time-travel in `runs`; a member's run view
 * stays read-only). Each must answer a member 403 ownerOnly.
 */
const OWNER_ONLY_SUBPATHS: [string, string][] = [
  ['POST', '/api/runs/1/branch'],
  ['GET', '/api/runs/1/diff/2'],
  ['POST', '/api/runs/1/use'],
  ['POST', '/api/runs/1/apply'],
  ['POST', '/api/runs/1/discard'],
  ['POST', '/api/runs/1/stop'],
  ['GET', '/api/runs/1/steps/0/branch'],
  // Phase 90: the saved logins on a computer (the `hands` family: owner-only while the owner's member
  // switch is off, as here; with it on, a member reaches only their own computers' logins).
  ['GET', '/api/hands/1/logins'],
  ['DELETE', '/api/hands/1/logins/GitHub'],
  ['DELETE', '/api/hands/1/logins'],
  // Phase 91: "Lock now" for a computer's password managers (the same `hands` family, owner-only here).
  ['POST', '/api/hands/1/relock'],
  // Phase 93: desktop operations keep the hands/computer owner boundary.
  ['POST', '/api/hands/1/op'],
  ['POST', '/api/hands/1/stop'],
  ['PUT', '/api/computer'],
  // Phase 96: trusting a workspace's project skills is the owner's (members have no workspaces).
  ['POST', '/api/skills/trust-project'],
];
/** Families not exercised by the generic loop (sign-out or streams) and checked on their own. */
const SKIP = new Set(['logout', 'events', 'health', 'login', 'claim', 'demo', 'public']);

test('owner-only paths inside member families (time-travel): members get 403 ownerOnly, the owner reaches them', async () => {
  for (const p of [ana, ben]) {
    for (const [method, path] of OWNER_ONLY_SUBPATHS) {
      const r = await call(p, method, path, method === 'GET' ? undefined : { fromStep: 0 });
      assert.equal(r.status, 403, `${p.name} ${method} ${path}`);
      assert.equal(r.json.ownerOnly, true, `${p.name} ${method} ${path}`);
    }
  }
  // The owner gets past the gate (no such run here: 404, never 403).
  for (const [method, path] of OWNER_ONLY_SUBPATHS) assert.notEqual((await call(owner, method, path.replace('/1/', '/999999/'), method === 'GET' ? undefined : { fromStep: 0 })).status, 403, path);
});

test('plugins (Phase 98): every plugin route answers a member 403 ownerOnly', async () => {
  const routes: [string, string][] = [
    ['GET', '/api/plugins'], ['POST', '/api/plugins/install'], ['GET', '/api/plugins/install/x'], ['DELETE', '/api/plugins/install/x'],
    ['POST', '/api/plugins/hello-hooks/approve'], ['POST', '/api/plugins/hello-hooks/enable'], ['GET', '/api/plugins/hello-hooks/settings'], ['PUT', '/api/plugins/hello-hooks/settings'],
    ['POST', '/api/plugins/hello-hooks/update-check'], ['POST', '/api/plugins/hello-hooks/rollback'], ['DELETE', '/api/plugins/hello-hooks'], ['GET', '/api/plugins/hello-hooks/log'],
    ['POST', '/api/plugins/hello-hooks/calls/x'], ['POST', '/api/plugins/hello-hooks/action'], ['GET', '/api/plugins/hello-hooks/file?path=a.png'],
  ];
  for (const who of [ana, ben]) {
    for (const [method, path] of routes) {
      const r = await call(who, method, path, method === 'GET' || method === 'DELETE' ? undefined : { path: process.cwd(), companion: 'main', on: true });
      assert.equal(r.status, 403, `${who.name} ${method} ${path}`);
      assert.equal(r.json.ownerOnly, true, `${who.name} ${method} ${path}`);
    }
  }
});

test('webhooks (Phase 102): every hook route answers a member 403 ownerOnly; /hook/* never in a member space', async () => {
  const routes: [string, string][] = [
    ['GET', '/api/hooks'], ['PUT', '/api/hooks'], ['POST', '/api/hooks'], ['PUT', '/api/hooks/h000000000000'], ['DELETE', '/api/hooks/h000000000000'],
    ['POST', '/api/hooks/h000000000000/rotate'], ['POST', '/api/hooks/h000000000000/test'], ['GET', '/api/hooks/h000000000000/deliveries'], ['POST', '/api/hooks/h000000000000/enable'],
  ];
  for (const who of [ana, ben]) {
    for (const [method, path] of routes) {
      const r = await call(who, method, path, method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', verify: 'url', action: { kind: 'tell' }, on: true, keepDays: 7 });
      assert.equal(r.status, 403, `${who.name} ${method} ${path}`);
      assert.equal(r.json.ownerOnly, true, `${who.name} ${method} ${path}`);
    }
  }
});

test('boards (Phase 99): own boards per person; a shared board only by membership, invitation first', async () => {
  // Each person's own board lists only their own to-dos.
  for (const p of [owner, ana, ben]) {
    const r = await call(p, 'GET', '/api/boards');
    assert.equal(r.status, 200, `${p.name} ${r.text}`);
    for (const v of [owner, ana, ben].filter((x) => x !== p)) assert.ok(!r.text.includes(v.marker), `${p.name} saw ${v.name}'s board`);
  }
  // Ana shares a board with Ben (the household's ids only), Ben accepts.
  const made = await call(ana, 'POST', '/api/boards', { name: `Trip ${M.a}`, shared: true, people: [ben.memberId, 'not-a-person'] });
  assert.equal(made.status, 201, made.text);
  const sid = String(made.json.id);
  assert.match(sid, /^s\d+$/);
  const card = await call(ana, 'POST', `/api/boards/${sid}/cards`, { title: `Passports ${M.a}` });
  assert.equal(card.status, 201, card.text);
  const ref = String(card.json.ref);
  assert.equal((await call(ben, 'GET', `/api/boards/${sid}`)).status, 404, 'not before accepting');
  const inv = await call(ben, 'GET', '/api/boards');
  assert.ok((inv.json.invites as { boardId: string }[]).some((i) => i.boardId === sid));
  assert.equal((await call(ben, 'POST', `/api/boards/invites/${sid}/accept`, {})).status, 200);
  const seen = await call(ben, 'GET', `/api/boards/${sid}`);
  assert.equal(seen.status, 200);
  assert.ok(seen.text.includes(`Passports ${M.a}`), 'a member of the board sees its cards');
  // The owner isn't on it: every way in by id is a 404, and nothing shows in his lists.
  for (const [method, path] of [['GET', `/api/boards/${sid}`], ['PUT', `/api/boards/${sid}`], ['DELETE', `/api/boards/${sid}`], ['POST', `/api/boards/${sid}/cards`], ['POST', `/api/boards/${sid}/share`], ['GET', `/api/tasks/${ref}/activity`], ['POST', `/api/tasks/${ref}/move`], ['POST', `/api/tasks/${ref}/assign`], ['POST', `/api/tasks/${ref}/comment`], ['POST', `/api/boards/invites/${sid}/accept`]] as const) {
    const r = await call(owner, method, path, method === 'GET' || method === 'DELETE' ? undefined : { columnId: 1, text: 'x', title: 'x', people: ['owner'], assignee: 'sara' });
    assert.equal(r.status, 404, `owner ${method} ${path} → ${r.status}`);
    assert.ok(!r.text.includes(M.a));
  }
  assert.ok(!(await call(owner, 'GET', '/api/boards')).text.includes(M.a));
  // Ben leaves: access ends.
  assert.equal((await call(ben, 'POST', `/api/boards/${sid}/leave`, {})).status, 200);
  assert.equal((await call(ben, 'GET', `/api/boards/${sid}`)).status, 404);
  assert.equal((await call(ana, 'DELETE', `/api/boards/${sid}`)).status, 200);
});

test('people (Phase 101): each person\'s cards are their own; no one reaches another\'s by id', async () => {
  const ids = new Map<Person, number>();
  for (const p of [owner, ana, ben]) {
    const made = await call(p, 'POST', '/api/people', { name: `Robin ${p.marker}`, relation: `my friend ${p.marker}` });
    assert.equal(made.status, 201, made.text);
    ids.set(p, Number((made.json.person as { id: number }).id));
  }
  for (const p of [owner, ana, ben]) {
    const list = await call(p, 'GET', '/api/people');
    assert.equal(list.status, 200);
    assert.ok(list.text.includes(p.marker), `${p.name} sees their own card`);
    for (const o of [owner, ana, ben].filter((x) => x !== p)) {
      assert.ok(!list.text.includes(o.marker), `${p.name} never sees ${o.name}'s people`);
      // Ids are per space: another person's card id is someone else (or nobody) here.
      for (const [method, path] of [['GET', `/api/people/${ids.get(o)}`], ['PUT', `/api/people/${ids.get(o)}`], ['GET', `/api/people?q=${encodeURIComponent(o.marker)}`]] as const) {
        const r = await call(p, method, path, method === 'PUT' ? { notes: 'x' } : undefined);
        assert.ok(!r.text.includes(o.marker), `${p.name} ${method} ${path}`);
      }
    }
  }
  for (const p of [owner, ana, ben]) assert.equal((await call(p, 'DELETE', `/api/people/${ids.get(p)}?memories=1`)).status, 200);
});

test('her plans (Phase 103): each person\'s own agenda, off by default; no one reaches another\'s plans', async () => {
  const ids = new Map<Person, number>();
  for (const p of [owner, ana, ben]) {
    const first = await call(p, 'GET', '/api/agenda');
    assert.equal(first.status, 200, `${p.name}: ${first.text}`);
    assert.equal((first.json.settings as { enabled: boolean }).enabled, false, `${p.name}: off by default`);
    const on = await call(p, 'PUT', '/api/agenda', { enabled: true });
    assert.equal(on.status, 200);
    const made = await call(p, 'POST', '/api/agenda/items', { what: `Ask about the trip ${p.marker}`, dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(made.status, 201, made.text);
    ids.set(p, Number((made.json.item as { id: number }).id));
  }
  for (const p of [owner, ana, ben]) {
    const list = await call(p, 'GET', '/api/agenda');
    assert.ok(list.text.includes(p.marker), `${p.name} sees their own plan`);
    for (const o of [owner, ana, ben].filter((x) => x !== p)) {
      assert.ok(!list.text.includes(o.marker), `${p.name} never sees ${o.name}'s plans`);
      // Ids are per space: another person's plan id is someone else's (or nobody's) here.
      const r = await call(p, 'PUT', `/api/agenda/items/${ids.get(o)}`, { what: 'x' });
      assert.ok(!r.text.includes(o.marker), `${p.name} PUT another's plan`);
    }
  }
  for (const p of [owner, ana, ben]) {
    assert.equal((await call(p, 'POST', '/api/agenda/clear', {})).status, 200);
    assert.equal((await call(p, 'POST', '/api/agenda/off', {})).status, 200);
  }
});

test('skills (Phase 96): each member has their own; a folder on the server is the owner\'s only', async () => {
  const made = await call(ana, 'POST', '/api/skills', { name: 'ana-only-skill', description: `Ana's own how-to ${M.a}. Use when Ana asks.`, body: `# Ana\n${M.a}` });
  assert.equal(made.status, 201);
  for (const p of [owner, ben]) {
    const list = await call(p, 'GET', '/api/skills');
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes('ana-only-skill') && !list.text.includes(M.a), `${p.name} doesn't see Ana's skill`);
    assert.equal((await call(p, 'GET', '/api/skills/companion/ana-only-skill')).status, 404);
  }
  const own = await call(ana, 'GET', '/api/skills');
  assert.ok(own.text.includes('ana-only-skill'));
  assert.deepEqual(own.json.projects, []);
  // The built-ins are there for members too.
  assert.ok((own.json.skills as { scope: string }[]).some((s) => s.scope === 'builtin'));
  const folder = await call(ana, 'POST', '/api/skills/import', { path: process.cwd() });
  assert.equal(folder.status, 403);
  assert.equal(folder.json.ownerOnly, true);
  assert.equal((await call(ana, 'DELETE', '/api/skills/companion/ana-only-skill')).status, 200);
});

test('skills she learns (Phase 97): each person learns in their own space; settings are their own', async () => {
  const put = await call(ana, 'PUT', '/api/skills/learning', { times: 5, perDay: 2 });
  assert.equal(put.status, 200, put.text);
  assert.equal((put.json.settings as { times: number }).times, 5);
  for (const p of [owner, ben]) {
    const st = await call(p, 'GET', '/api/skills/learning');
    assert.equal(st.status, 200, `${p.name}: ${st.text}`);
    assert.equal((st.json.settings as { times: number }).times, 3, `${p.name} keeps their own count`);
  }
  // A member's offers and fixes are theirs: another person's ids are not found.
  assert.equal((await call(ben, 'GET', '/api/skills/learning/offers/1')).status, 404);
  assert.equal((await call(ana, 'PUT', '/api/skills/learning', { times: 3, perDay: 1 })).status, 200);
});

test('every route family: no person ever gets another person\'s data', async () => {
  const fam = routeFamilies();
  assert.ok(fam.size > 80, `found ${fam.size} route families`);
  const { MEMBER_ROUTES } = await import('../src/household.ts');
  for (const a of fam.keys()) assert.ok(MEMBER_ROUTES.has(a) || OWNER_ONLY.includes(a) || SKIP.has(a), `route family "${a}" must be classified as a member route or owner-only (src/household.ts MEMBER_ROUTES / this test)`);
  const people = [owner, ana, ben];
  const others = (p: Person) => people.filter((x) => x !== p);
  let tried = 0;
  const failures: string[] = [];
  const CONV_SUFFIXES = ['messages', 'retry', 'continue', 'stop', 'together', 'pins', 'summary', 'forget', 'move'];
  for (const attacker of people) {
    const victims = others(attacker);
    const vMarkers = victims.map((v) => v.marker);
    const ids = victims.flatMap((v) => [v.conv, v.upload ?? '', String(v.doc ?? '')]).filter(Boolean);
    if (attacker !== owner) ids.push(ownerSecondCompanion);
    const jobs: { method: string; path: string; ownerOnly: boolean }[] = [];
    for (const [a, subs] of fam) {
      if (SKIP.has(a)) continue;
      const paths = new Set<string>([`/api/${a}`]);
      for (const b of subs) paths.add(`/api/${a}/${b}`);
      for (const id of ids) {
        paths.add(`/api/${a}/${encodeURIComponent(id)}`);
        for (const c of a === 'conversations' || a === 'live' || a === 'video' ? CONV_SUFFIXES : ['messages', 'face', 'file']) paths.add(`/api/${a}/${encodeURIComponent(id)}/${c}`);
      }
      const ownerOnly = OWNER_ONLY.includes(a);
      for (const path of paths) {
        const methods = attacker === owner ? ['GET'] : ownerOnly ? ['GET', 'POST', 'PUT', 'DELETE'] : ['GET'];
        // Writes aimed at another person's ids (never the attacker's own collection). Only ids that
        // can't also name something of the attacker's own (conversation uuids, photo hashes): a
        // number like note 1 exists in every space, and changing one's own note 1 is allowed.
        if (!ownerOnly && ids.filter((id) => !/^\d+$/.test(id)).some((id) => path.includes(encodeURIComponent(id))) && !/\/devices|\/owner-token|\/two-step|\/household/.test(path)) methods.push('POST', 'PATCH', 'DELETE');
        for (const method of methods) jobs.push({ method, path, ownerOnly });
      }
    }
    const one = async (j: { method: string; path: string; ownerOnly: boolean }) => {
      const body = j.method === 'GET' || j.method === 'DELETE' ? undefined : { conversationId: victims[0].conv, id: victims[0].doc, messageId: 1, content: 'x', body: 'x', name: 'x' };
      let r: Res;
      try {
        r = await call(attacker, j.method, j.path, body, {}, 10_000);
      } catch (err) {
        failures.push(`${attacker.name} ${j.method} ${j.path} → no answer (${(err as Error).name})`);
        return;
      }
      tried++;
      if (vMarkers.some((m) => r.text.includes(m))) failures.push(`${attacker.name} ${j.method} ${j.path} → ${r.status} LEAKED another person's data`);
      if (r.status >= 500) failures.push(`${attacker.name} ${j.method} ${j.path} → ${r.status}`);
      if (attacker !== owner && j.ownerOnly && r.status !== 403) failures.push(`${attacker.name} ${j.method} ${j.path} → ${r.status}, expected 403 (owner only)`);
      if (attacker !== owner && j.ownerOnly && r.status === 403 && r.json.ownerOnly !== true) failures.push(`${attacker.name} ${j.method} ${j.path}: 403 without ownerOnly`);
    };
    // A few at a time (keeps the run short; the server handles them like any busy app would).
    for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(one));
  }
  assert.deepEqual(failures, [], failures.slice(0, 30).join('\n'));
  assert.ok(tried > 3000, `tried ${tried} requests`);
  console.log(`isolation: ${tried} requests across ${fam.size} route families`);
  // Nothing of theirs was changed: each person still has their conversation, note, upload and document.
  for (const p of people) {
    const c = await call(p, 'GET', `/api/conversations/${p.conv}`);
    assert.equal(c.status, 200, `${p.name} conversation`);
    assert.ok(c.text.includes(p.marker), `${p.name}'s messages are intact`);
    assert.ok((await call(p, 'GET', '/api/notes')).text.includes(p.marker), `${p.name}'s note is intact`);
    if (p.upload) assert.equal((await call(p, 'GET', `/api/uploads/${p.upload}`)).status, 200, `${p.name}'s photo is intact`);
    if (p.doc) assert.ok((await call(p, 'GET', '/api/library')).text.includes('.txt'), `${p.name}'s document is intact`);
  }
});

test('targeted checks: uploads, faces, search, exports, companion header, owner credentials', async () => {
  // Another person's photo by its content hash: not found.
  assert.equal((await call(ana, 'GET', `/api/uploads/${owner.upload}`)).status, 404);
  assert.equal((await call(owner, 'GET', `/api/uploads/${ana.upload}`)).status, 404);
  assert.equal((await call(ben, 'GET', `/api/uploads/${ana.upload}`)).status, 404);
  // The owner's second companion's face from a member: no such companion.
  assert.equal((await call(ana, 'GET', `/api/companions/${ownerSecondCompanion}/face`)).status, 404);
  // Picking the owner's companion with the header/cookie stays inside the member's own space.
  const hdr = await call(ana, 'GET', '/api/conversations', undefined, { 'x-sara-companion': ownerSecondCompanion });
  assert.ok(!hdr.text.includes(owner.conv) && hdr.text.includes(ana.conv));
  const comps = await call(ana, 'GET', '/api/companions');
  assert.ok(!comps.text.includes('Zelda'));
  // Search and recall look only in one's own space.
  for (const p of [owner, ana, ben]) {
    for (const v of [owner, ana, ben].filter((x) => x !== p)) {
      const f = await call(p, 'GET', '/api/find?q=MARK');
      assert.ok(!f.text.includes(v.marker), `${p.name} found ${v.name}'s data`);
    }
  }
  // Exports.
  const ex = await call(ana, 'GET', '/api/export');
  assert.ok(ex.text.includes(M.a) && !ex.text.includes(M.owner) && !ex.text.includes(M.b));
  const mine = await call(ana, 'GET', '/api/household/me/export');
  assert.equal(mine.status, 200);
  assert.ok(mine.text.includes(M.a) && !mine.text.includes(M.owner) && !mine.text.includes(M.b));
  const oex = await call(owner, 'GET', '/api/export');
  assert.ok(oex.text.includes(M.owner) && !oex.text.includes(M.a) && !oex.text.includes(M.b));
  // The owner's view of members: usage numbers only.
  const hh = await call(owner, 'GET', '/api/household');
  assert.ok(!hh.text.includes(M.a) && !hh.text.includes(M.b) && !hh.text.includes(ana.conv));
  const anaRow = (hh.json.members as { id: string; usage: { days: { messages: number }[]; byModel: { model: string }[] } }[]).find((m) => m.id === ana.memberId)!;
  assert.ok(anaRow.usage.days.reduce((n, d) => n + d.messages, 0) >= 1);
  assert.ok(anaRow.usage.byModel.some((m) => m.model === 'fake-1'));
  // Mixing credentials: a member's cookie with the owner token as a bearer gets nothing.
  const mixed = await call(ana, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${owner.token}` });
  assert.ok(mixed.status === 401 && !mixed.text.includes(owner.conv));
  // The owner token never opens a member's space; a member's token never opens the owner's.
  const asOwner = await call(null, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${owner.token}` });
  assert.ok(asOwner.text.includes(owner.conv) && !asOwner.text.includes(ana.conv));
  const asAna = await call(null, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${ana.token}` });
  assert.ok(asAna.text.includes(ana.conv) && !asAna.text.includes(owner.conv));
  const forged = await call(null, 'GET', '/api/conversations', undefined, { authorization: `Bearer sara_m.${ben.memberId}.${ana.token.split('.').pop()}` });
  assert.equal(forged.status, 401);
});

test('no prompt to a model ever mixes two people, and members get no server tools', async () => {
  // Let background work (memory, library, captions) run a little.
  await new Promise((r) => setTimeout(r, 1500));
  const all = [M.owner, M.a, M.b];
  for (const r of llmRequests) {
    const who = all.filter((m) => r.text.includes(m));
    assert.ok(who.length <= 1, `a model request contained ${who.join(' + ')}`);
  }
  const memberTurns = llmRequests.filter((r) => r.text.includes(M.a) || r.text.includes(M.b));
  assert.ok(memberTurns.length >= 2);
  const forbidden = ['shell', 'write_file', 'read_file', 'edit_file', 'list_dir', 'search', 'web_fetch', 'web_search', 'run_job', 'github_issue', 'gmail_search', 'home_state', 'preview_start', 'browser_open', 'team_start', 'code_map', 'delegate'];
  for (const r of memberTurns) for (const t of r.tools) assert.ok(!forbidden.some((f) => t === f || t.startsWith('mcp_') || t.startsWith('git_') || t.startsWith('github') || t.startsWith('browser_') || t.startsWith('preview_')), `a member's turn offered the tool ${t}`);
});

test('/v1 and /mcp keys are per person', async () => {
  const k = await call(ana, 'POST', '/api/devices/api-key', { label: 'Test app', token: ana.token });
  assert.equal(k.status, 200, k.text);
  const key = String(k.json.key);
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.text());
  assert.ok(!models.includes('Zelda'), models);
  // The API key can't read the app's own API.
  assert.equal((await call(null, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${key}` })).status, 401);
  const rpc = async (name: string, args: Record<string, unknown>) =>
    fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.text());
  for (const [name, args] of [['list_recent_conversations', {}], ['list_notes', {}], ['search_memory', { query: 'MARK' }], ['search_library', { query: 'library' }], ['list_tasks', {}], ['get_today', {}]] as const) {
    const out = await rpc(name, args);
    assert.ok(!out.includes(M.owner) && !out.includes(M.b), `MCP ${name} leaked: ${out.slice(0, 300)}`);
  }
  const ownNotes = await rpc('list_notes', {});
  assert.ok(ownNotes.includes(M.a), ownNotes.slice(0, 300));
});

test('apps: member token sign-in, pairing codes and device codes land in the right space', async () => {
  const login = await call(null, 'POST', '/api/login', { token: ana.token });
  assert.equal(login.status, 200, login.text);
  const fresh: Person = { ...ana, cookie: login.cookie! };
  assert.ok((await call(fresh, 'GET', '/api/conversations')).text.includes(ana.conv));
  // A pairing code made by Ben signs the new device in to Ben's space.
  const pc = await call(ben, 'POST', '/api/pair', {});
  assert.equal(pc.status, 200);
  const red = await call(null, 'POST', '/api/pair/redeem', { code: pc.json.code });
  assert.equal(red.status, 200, red.text);
  const phone: Person = { ...ben, cookie: red.cookie! };
  const convs = await call(phone, 'GET', '/api/conversations');
  assert.ok(convs.text.includes(ben.conv) && !convs.text.includes(owner.conv) && !convs.text.includes(ana.conv));
  // The owner's pairing code still signs in the owner.
  const opc = await call(owner, 'POST', '/api/pair', {});
  const ored = await call(null, 'POST', '/api/pair/redeem', { code: opc.json.code });
  assert.ok((await call({ ...owner, cookie: ored.cookie! }, 'GET', '/api/conversations')).text.includes(owner.conv));
  // Device code: an app asks, Ben approves while signed in as himself: the app's token is Ben's.
  const start = await call(null, 'POST', '/api/device/start', { name: 'sara-chat test' });
  assert.equal(start.status, 200, start.text);
  assert.deepEqual((await call(ana, 'GET', '/api/device/pending')).json.pending, [], 'a member does not see the waiting list');
  const ok = await call(ben, 'POST', '/api/device/approve', { code: start.json.code, token: ben.token });
  assert.equal(ok.status, 200, ok.text);
  const poll = await call(null, 'POST', '/api/device/poll', { pollToken: start.json.pollToken });
  const devToken = String(poll.json.token);
  assert.match(devToken, /^sara_dev\./);
  const dc = await call(null, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${devToken}` });
  assert.ok(dc.text.includes(ben.conv) && !dc.text.includes(ana.conv) && !dc.text.includes(owner.conv));
});

test('events stream: another person\'s messages never reach it', async () => {
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { cookie: `sara_session=${ana.cookie}` }, signal: ctl.signal });
  let seen = '';
  const reader = r.body!.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += Buffer.from(value).toString();
      }
    } catch {
      /* aborted */
    }
  })();
  await say(owner, owner.conv, `Another secret ${M.owner}`);
  await say(ben, ben.conv, `Another secret ${M.b}`);
  await call(owner, 'POST', '/api/notes', { body: 'owner planner change' });
  await say(ana, ana.conv, `my own ${M.a}`);
  await new Promise((res) => setTimeout(res, 1200));
  ctl.abort();
  await pump;
  assert.ok(seen.includes(ana.conv), 'her own events arrive');
  assert.ok(!seen.includes(owner.conv) && !seen.includes(ben.conv) && !seen.includes(M.owner) && !seen.includes(M.b), seen.slice(0, 500));
});

test('models outside the member\'s list and daily limits are refused before any model call', async () => {
  const before = llmRequests.filter((r) => r.model === 'fake-2').length;
  const conv = await call(ana, 'POST', '/api/conversations', { providerId: 'fake', model: 'fake-2' });
  const r = await say(ana, String(conv.json.id), 'hello on the other model');
  assert.match(r.text, /hasn't made fake-2 available/);
  assert.equal(llmRequests.filter((x) => x.model === 'fake-2').length, before);
  // A daily message limit.
  assert.equal((await call(owner, 'PUT', `/api/household/members/${ana.memberId}`, { limits: { messagesPerDay: 20 } })).status, 200);
  let blocked = '';
  for (let i = 0; i < 25 && !blocked; i++) {
    const m = await say(ana, ana.conv, `message ${i}`);
    if (/today's limit of 20 messages/.test(m.text)) blocked = m.text;
  }
  assert.ok(blocked, 'the limit stopped her messages');
  assert.equal((await call(owner, 'PUT', `/api/household/members/${ana.memberId}`, { limits: { messagesPerDay: 0, voice: false } })).status, 200);
  // Voice switched off: voice routes refuse.
  assert.equal((await call(ana, 'POST', '/api/voice/speak', { text: 'hi' })).status, 403);
  // Unknown limit values are refused.
  assert.equal((await call(owner, 'PUT', `/api/household/members/${ana.memberId}`, { limits: { messagesPerDay: 7 } })).status, 400);
});

test('adult mode is per member and only from their own browser', async () => {
  const web = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' };
  const phone = { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) SaraPhone/3' };
  assert.equal((await call(ana, 'PUT', '/api/adult', { on: true, confirm18: true }, phone)).status, 403);
  const on = await call(ana, 'PUT', '/api/adult', { on: true, confirm18: true }, web);
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.on, true);
  assert.equal((await call(owner, 'GET', '/api/adult')).json.on, false, "the owner's stays off");
  assert.equal((await call(ben, 'GET', '/api/adult')).json.on, false, "Ben's stays off");
});

test('suspend, remove (export only), delete now; delete my own account', async () => {
  assert.equal((await call(owner, 'POST', `/api/household/members/${ben.memberId}/suspend`, {})).status, 200);
  assert.equal((await call(ben, 'GET', '/api/conversations')).status, 403);
  assert.equal((await call(ben, 'GET', '/api/session')).json.member && ((await call(ben, 'GET', '/api/session')).json.member as { status: string }).status, 'suspended');
  assert.equal((await call(owner, 'POST', `/api/household/members/${ben.memberId}/resume`, {})).status, 200);
  assert.equal((await call(ben, 'GET', '/api/conversations')).status, 200);
  assert.equal((await call(owner, 'DELETE', `/api/household/members/${ben.memberId}`)).status, 409, 'remove first');
  assert.equal((await call(owner, 'POST', `/api/household/members/${ben.memberId}/remove`, {})).status, 200);
  assert.equal((await call(ben, 'GET', '/api/conversations')).status, 403);
  const exp = await call(ben, 'GET', '/api/household/me/export');
  assert.equal(exp.status, 200);
  assert.ok(exp.text.includes(M.b));
  assert.equal((await call(owner, 'DELETE', `/api/household/members/${ben.memberId}`)).status, 200);
  assert.ok(!existsSync(join(dataDir, 'members', ben.memberId!)), "Ben's folder is gone");
  assert.equal((await call(ben, 'GET', '/api/session')).json.authenticated, false);
  // Ana deletes her own account: her token confirms it.
  assert.equal((await call(ana, 'POST', '/api/household/me/delete', { token: 'wrong' })).status, 403);
  assert.equal((await call(ana, 'POST', '/api/household/me/delete', { token: ana.token })).status, 200);
  // The space is deleted right after the reply (once her open requests end): wait for it, up to 10 s
  // (a fixed 0.5 s was too short on a busy server).
  for (let i = 0; i < 100 && existsSync(join(dataDir, 'members', ana.memberId!)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!existsSync(join(dataDir, 'members', ana.memberId!)), "Ana's folder is gone");
  assert.equal((await call(null, 'POST', '/api/login', { token: ana.token })).status, 401);
  // The owner's data is all still there.
  assert.ok((await call(owner, 'GET', `/api/conversations/${owner.conv}`)).text.includes(M.owner));
  assert.deepEqual((await call(owner, 'GET', '/api/household')).json.members, []);
});
