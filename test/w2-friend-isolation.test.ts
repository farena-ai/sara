// W2.3 (docs/HOSTING_FRIENDS.md): a hosted friend on the real server (src/main.ts). The friend
// brings their own model (a second fake model server), sets their own spend limit and chats with a
// unique marker; the owner then tries every place that could show it. Nothing of the friend's may
// come back to the owner, the friend sees none of the owner's models or keys, and pause/remove
// (with the export window) work.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from './helpers.ts';

const MARK = `MARK-FRIEND-${randomBytes(6).toString('hex')}`;
const OWNER_MARK = `MARK-OWNER-${randomBytes(6).toString('hex')}`;
const FRIEND_KEY = ['fk', randomBytes(8).toString('hex')].join('-');
const OWNER_KEY = ['ok', randomBytes(8).toString('hex')].join('-');

interface Llm {
  srv: Server;
  port: number;
  seen: string[];
}
function fakeModel(model: string, reply: string): Promise<Llm> {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push(`${req.headers.authorization ?? ''} ${raw}`);
      let body: { stream?: boolean } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
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
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: (srv.address() as AddressInfo).port, seen })));
}

let ownerLlm: Llm;
let friendLlm: Llm;
let child: ChildProcess;
let dataDir = '';
let base = '';
let log = '';
const owner = { cookie: '', token: '' };
const friend = { cookie: '', token: '', id: '', conv: '' };

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
async function call(who: { cookie: string } | null, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown>; cookie?: string }> {
  const h: Record<string, string> = { origin: base };
  if (who?.cookie) h.cookie = `sara_session=${who.cookie}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const m = /sara_session=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
  return { status: r.status, text, json, ...(m ? { cookie: decodeURIComponent(m[1]) } : {}) };
}

before(async () => {
  ownerLlm = await fakeModel('owner-model', 'Owner reply.');
  friendLlm = await fakeModel('friend-model', 'Friend reply.');
  dataDir = mkdtempSync(join(tmpdir(), 'sara-w2friend-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: dataDir, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_VOICE_DIR: join(dataDir, 'novoice'), SARA_HOSTED_LOCAL_MODELS: '1' };
  for (const k of ['NODE_TEST_CONTEXT', 'SARA_DEMO', 'SARA_PRIVATE_LOCAL', 'SARA_MASTER_KEY', 'SARA_INSTANCE']) delete env[k];
  child = spawn(process.execPath, [join(ROOT, 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  const until = Date.now() + 180_000;
  for (;;) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    if (Date.now() > until || child.exitCode !== null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  owner.token = readFileSync(join(dataDir, 'first-token.txt'), 'utf8').trim();
});

after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 500));
  ownerLlm?.srv.close();
  friendLlm?.srv.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

test('W2.3 the owner hosts a friend: an invite link, the friend joins with their own sign-in', async () => {
  const login = await call(null, 'POST', '/api/login', { token: owner.token });
  assert.equal(login.status, 200, login.text);
  owner.cookie = login.cookie!;
  assert.equal((await call(owner, 'PUT', '/api/providers/ownerfake', { kind: 'openai-compatible', label: 'Owner models', baseUrl: `http://127.0.0.1:${ownerLlm.port}/v1`, defaultModel: 'owner-model', needsKey: true, apiKey: OWNER_KEY })).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/settings', { defaultProviderId: 'ownerfake', defaultModel: 'owner-model', ownerName: 'Alex' })).status, 200);
  assert.equal((await call(owner, 'POST', '/api/disclosure/accept', {})).status, 200);
  const oc = await call(owner, 'POST', '/api/conversations', {});
  assert.equal((await call(owner, 'POST', `/api/conversations/${oc.json.id}/messages`, { content: `owner secret ${OWNER_MARK}` })).status, 200);

  assert.equal((await call(owner, 'POST', '/api/household/hosted/invites', { name: 'Robin', hours: 24 })).status, 400, 'the owner confirms 18+');
  const inv = await call(owner, 'POST', '/api/household/hosted/invites', { name: 'Robin', hours: 24, confirm18: true });
  assert.equal(inv.status, 200, inv.text);
  assert.match(String(inv.json.url), /\/#join=/);
  assert.ok(String(inv.json.qr).startsWith('data:image/svg+xml'));
  const peek = await call(null, 'GET', `/api/household/join?code=${inv.json.code}`);
  assert.equal((peek.json.invite as { hosted?: boolean }).hosted, true, 'the join page can say this is their own Sara, not a household');
  const j = await call(null, 'POST', '/api/household/join', { code: inv.json.code, confirm18: true });
  assert.equal(j.status, 200, j.text);
  friend.token = String(j.json.token);
  friend.cookie = j.cookie!;
  const s = await call(friend, 'GET', '/api/session');
  assert.equal(s.json.role, 'member');
  assert.equal((s.json.member as { hosted?: boolean }).hosted, true);
  const hh = await call(owner, 'GET', '/api/household');
  assert.deepEqual(hh.json.members, [], 'a hosted friend is not a household member');
  const hosted = hh.json.hosted as { id: string; name: string }[];
  assert.equal(hosted.length, 1);
  friend.id = hosted[0].id;
});

test('W2.3 the friend brings their own model and spend limit; sees none of the owner\'s', async () => {
  const before = await call(friend, 'GET', '/api/providers');
  assert.equal(before.status, 200);
  assert.ok(!before.text.includes('ownerfake') && !before.text.includes('owner-model'), before.text);
  const p = await call(friend, 'PUT', '/api/providers/mine', { kind: 'openai-compatible', label: 'My models', baseUrl: `http://127.0.0.1:${friendLlm.port}/v1`, defaultModel: 'friend-model', needsKey: true, apiKey: FRIEND_KEY });
  assert.equal(p.status, 200, p.text);
  assert.equal((await call(friend, 'PUT', '/api/settings', { defaultProviderId: 'mine', defaultModel: 'friend-model' })).status, 200);
  const sp = await call(friend, 'PUT', '/api/spend', { spend: { dayUsd: 2, monthUsd: 20 } });
  assert.equal(sp.status, 200, sp.text);
  assert.equal((sp.json.spend as { dayUsd: number }).dayUsd, 2);
  assert.equal((await call(friend, 'POST', '/api/disclosure/accept', {})).status, 200);
  const c = await call(friend, 'POST', '/api/conversations', {});
  friend.conv = String(c.json.id);
  const r = await call(friend, 'POST', `/api/conversations/${friend.conv}/messages`, { content: `my private thing ${MARK}` });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Friend reply/);
  assert.equal((await call(friend, 'POST', '/api/notes', { body: `note ${MARK}` })).status, 201);
  // Their turn went to THEIR model with THEIR key; the owner's model never saw it.
  assert.ok(friendLlm.seen.some((x) => x.includes(MARK) && x.includes(FRIEND_KEY)));
  assert.ok(!ownerLlm.seen.some((x) => x.includes(MARK)));
  assert.ok(!friendLlm.seen.some((x) => x.includes(OWNER_MARK) || x.includes(OWNER_KEY)));
  // Their key is sealed with their own key file, not in the owner's vault.
  assert.ok(existsSync(join(dataDir, 'members', friend.id, 'keys', 'master.key')));
  assert.notEqual(readFileSync(join(dataDir, 'members', friend.id, 'keys', 'master.key'), 'utf8'), readFileSync(join(dataDir, 'master.key'), 'utf8'));
  // Shared family things and server things are refused.
  for (const path of ['/api/household', '/api/family', '/api/boards', '/api/mcp', '/api/backup', '/api/data-rights']) assert.equal((await call(friend, 'GET', path)).status, 403, path);
  const own = await call(friend, 'GET', '/api/conversations');
  assert.ok(!own.text.includes(OWNER_MARK));
});

test('W2.3 isolation: no owner route returns the friend\'s content, model or key', async () => {
  const id = friend.id;
  const paths = [
    '/api/household', '/api/household/hosted', `/api/household/members/${id}`, `/api/household/hosted/${id}`,
    '/api/conversations', `/api/conversations/${friend.conv}`, `/api/conversations/${friend.conv}/messages`, `/api/find?q=${MARK}`, `/api/search?q=${MARK}`,
    '/api/notes', '/api/memories', '/api/library', '/api/usage', '/api/usage/report?by=person,project,model', '/api/usage/report.csv?by=person,project,model',
    '/api/data-rights', `/api/data-rights/export?person=${id}`, `/api/data-rights/history?person=${id}`, '/api/providers', '/api/settings', '/api/spend', '/api/audit/export',
    '/api/member-tools', '/api/app-updates', '/api/sso', '/api/safety-check', '/api/today',
  ];
  for (const p of paths) {
    const r = await call(owner, 'GET', p);
    for (const bad of [MARK, FRIEND_KEY, 'friend-model', `:${friendLlm.port}`]) assert.ok(!r.text.includes(bad), `${p} (${r.status}) leaked ${bad}`);
  }
  // The owner's per-person data tools can't reach the friend's space.
  assert.notEqual((await call(owner, 'GET', `/api/data-rights/export?person=${id}`)).status, 200);
  assert.notEqual((await call(owner, 'POST', '/api/data-rights/delete', { person: id, confirm: 'Robin' })).status, 200);
  assert.equal((await call(owner, 'PUT', `/api/household/members/${id}`, { limits: { voice: false } })).status, 404, 'member controls are not for hosted friends');
  // What the owner does see: totals.
  const h = (await call(owner, 'GET', '/api/household')).json.hosted as { usage: { messages7d: number; usd7d: number; tokens7d: number } }[];
  assert.ok(h[0].usage.messages7d >= 1, JSON.stringify(h));
  assert.ok(h[0].usage.tokens7d > 0);
});

test('W2.3 pause, resume, remove with an export window', async () => {
  assert.equal((await call(owner, 'PUT', `/api/household/hosted/${friend.id}`, { status: 'suspended' })).status, 200);
  assert.equal((await call(friend, 'GET', '/api/conversations')).status, 403);
  assert.equal((await call(owner, 'PUT', `/api/household/hosted/${friend.id}`, { status: 'active' })).status, 200);
  assert.equal((await call(friend, 'GET', '/api/conversations')).status, 200);
  const rm = await call(owner, 'POST', `/api/household/hosted/${friend.id}/remove`, {});
  assert.equal(rm.status, 200, rm.text);
  const row = (rm.json.hosted as { status: string; deleteAfter: string | null }[])[0];
  assert.equal(row.status, 'leaving');
  assert.ok(row.deleteAfter);
  // The friend can still take everything with them, but nothing else.
  const ex = await call(friend, 'GET', '/api/household/me/export');
  assert.equal(ex.status, 200);
  assert.ok(ex.text.includes(MARK));
  assert.equal((await call(friend, 'GET', '/api/conversations')).status, 403);
  // A removal can't be paused back (it ends in deletion or the owner's Delete now).
  assert.equal((await call(owner, 'PUT', `/api/household/hosted/${friend.id}`, { status: 'active' })).status, 409);
  const del = await call(owner, 'DELETE', `/api/household/hosted/${friend.id}`, {});
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(del.json.hosted, []);
  assert.ok(!existsSync(join(dataDir, 'members', friend.id)));
});
