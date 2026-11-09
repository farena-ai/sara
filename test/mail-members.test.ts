// M1 (3.1): each household member's own mailboxes, end to end on the real server (src/main.ts) with
// a stand-in Microsoft sign-in + Graph and a fake model. The owner and a member each connect an
// Outlook mailbox; another member connects none. Isolation both ways (routes, files, tools, Today,
// the model's prompts), approvals stay in the member's own space, the Microsoft app stays the
// owner's, and the admin's `memberMail: false` pin switches members' mail off (the owner's stays).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from './helpers.ts';
import { FakeGraph } from './mail-graph-fake.ts';

const OWNER_MAIL = 'owner@outlook.com';
const ANA_MAIL = 'ana@outlook.com';

// ---- the fake model: records every request; "TOOL:<name> <json>END" in the last user turn calls that tool ----
const llmRequests: { text: string; tools: string[] }[] = [];
let llm: Server;
let llmPort = 0;
function llmReply(res: import('node:http').ServerResponse, stream: boolean, msg: { content?: string; tool?: { name: string; args: string } }): void {
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (msg.tool) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: msg.tool.name, arguments: msg.tool.args } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: msg.content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    return void res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  const message = msg.tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: msg.tool.name, arguments: msg.tool.args } }] } : { role: 'assistant', content: msg.content };
  res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: msg.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
}

const graph = new FakeGraph();
let child: ChildProcess;
let dataDir = '';
let base = '';
let log = '';

interface Person {
  cookie: string;
  conv: string;
  memberId?: string;
}
const owner: Person = { cookie: '', conv: '' };
const ana: Person = { cookie: '', conv: '' };
const ben: Person = { cookie: '', conv: '' };

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
async function call(who: Person | null, method: string, path: string, body?: unknown): Promise<Res> {
  const h: Record<string, string> = {};
  if (who?.cookie) h.cookie = `sara_session=${who.cookie}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  let json: Res['json'] = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const m = /sara_session=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
  return { status: r.status, text, json, ...(m ? { cookie: decodeURIComponent(m[1]) } : {}) };
}
const say = (who: Person, content: string) => call(who, 'POST', `/api/conversations/${who.conv}/messages`, { content });

/** Sends a message and answers the first approval card it shows (the turn waits for it). */
async function sayAndDecide(who: Person, content: string, decide: (approvalId: string) => Promise<void>): Promise<string> {
  const r = await fetch(`${base}/api/conversations/${who.conv}/messages`, { method: 'POST', headers: { cookie: `sara_session=${who.cookie}`, 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(120_000) });
  const reader = r.body!.getReader();
  let text = '';
  let decided = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const m = /"approvalId":"([^"]+)"/.exec(text);
    if (m && !decided) {
      decided = true;
      await decide(m[1]);
    }
  }
  assert.ok(decided, `no approval card came:\n${text.slice(0, 2000)}`);
  return text;
}

/** Signs `who` in to the stand-in Microsoft as `address` (Sara's connect → Microsoft → the callback). */
async function connectOutlook(who: Person, address: string): Promise<Res> {
  const c = await call(who, 'POST', '/api/mail/microsoft/connect', {});
  assert.equal(c.status, 200, c.text);
  const { code, state } = graph.authorize(String(c.json.url));
  graph.address = address;
  // The browser comes back without anything but the code and the one-time state.
  return call(null, 'GET', `/api/mail/microsoft/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}
const addresses = (r: Res) => ((r.json.accounts ?? []) as { address: string }[]).map((a) => a.address).sort();

before(async () => {
  await graph.start();
  graph.add({ from: 'friend@example.com', subject: 'Lunch on Friday?' });
  llm = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
      }
      let body: { stream?: boolean; messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* ignore */
      }
      llmRequests.push({ text: JSON.stringify(body.messages ?? ''), tools: (body.tools ?? []).map((t) => String(t.function?.name)) });
      const msgs = body.messages ?? [];
      const last = msgs[msgs.length - 1];
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      const m = last?.role === 'user' ? /TOOL:(\w+) (\{.*?\})END/.exec(lastText.replace(/\\"/g, '"')) : null;
      if (m) return llmReply(res, Boolean(body.stream), { tool: { name: m[1], args: m[2] } });
      llmReply(res, Boolean(body.stream), { content: 'Noted, thanks.' });
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  llmPort = (llm.address() as AddressInfo).port;

  dataDir = mkdtempSync(join(tmpdir(), 'sara-mail-members-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: dataDir, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_VOICE_DIR: join(dataDir, 'novoice'), SARA_MS_GRAPH_BASE: `${graph.base}/v1.0`, SARA_MS_LOGIN_BASE: `${graph.base}/login` };
  delete env.NODE_TEST_CONTEXT;
  delete env.SARA_DEMO;
  delete env.SARA_PRIVATE_LOCAL;
  delete env.SARA_MASTER_KEY;
  child = spawn(process.execPath, [join(ROOT, 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  const until = Date.now() + 180_000;
  for (;;) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    if (Date.now() > until || child.exitCode !== null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const { readFileSync } = await import('node:fs');
  const login = await call(null, 'POST', '/api/login', { token: readFileSync(join(dataDir, 'first-token.txt'), 'utf8').trim() });
  assert.equal(login.status, 200, login.text);
  owner.cookie = login.cookie!;
  assert.equal((await call(owner, 'PUT', '/api/providers/fake', { kind: 'openai-compatible', label: 'Fake models', baseUrl: `http://127.0.0.1:${llmPort}/v1`, defaultModel: 'fake-1', needsKey: false })).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/settings', { defaultProviderId: 'fake', defaultModel: 'fake-1', ownerName: 'Alex', timeZone: 'UTC' })).status, 200);
  assert.equal((await call(owner, 'POST', '/api/disclosure/accept', {})).status, 200);
  owner.conv = String((await call(owner, 'POST', '/api/conversations', {})).json.id);
  const limits = { models: [{ providerId: 'fake', model: 'fake-1' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false };
  for (const [p, name] of [[ana, 'Ana'], [ben, 'Ben']] as const) {
    const inv = await call(owner, 'POST', '/api/household/invites', { name, hours: 24, confirm18: true, limits });
    assert.equal(inv.status, 200, inv.text);
    const j = await call(null, 'POST', '/api/household/join', { code: inv.json.code, confirm18: true });
    assert.equal(j.status, 200, j.text);
    p.cookie = j.cookie!;
    await call(p, 'POST', '/api/disclosure/accept', {});
    p.conv = String((await call(p, 'POST', '/api/conversations', {})).json.id);
  }
  const list = (await call(owner, 'GET', '/api/household')).json.members as { id: string; name: string }[];
  ana.memberId = list.find((m) => m.name === 'Ana')!.id;
  ben.memberId = list.find((m) => m.name === 'Ben')!.id;
});

after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 500));
  llm?.close();
  await graph.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

test('the Microsoft app is the owner\'s: a member sees the page but cannot set it up', async () => {
  const before = await call(ana, 'GET', '/api/mail/accounts');
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.member, true);
  assert.equal(before.json.google, false, 'no Gmail sign-in for members (Gmail through an app password instead)');
  assert.ok((before.json.presets as { id: string }[]).some((p) => p.id === 'gmail'));
  assert.equal((before.json.microsoft as { configured: boolean }).configured, false);
  const put = await call(ana, 'PUT', '/api/mail/microsoft/client', { clientId: graph.clientId, clientSecret: graph.clientSecret });
  assert.equal(put.status, 403, put.text);
  assert.equal(put.json.ownerOnly, true);
  assert.equal((await call(ana, 'DELETE', '/api/mail/microsoft/client')).status, 403);
  assert.equal((await call(ana, 'POST', '/api/mail/microsoft/connect', {})).status, 400, 'no app yet: nothing to sign in with');
  // The owner sets it up once; the member then signs in with it, but never sees its id.
  assert.equal((await call(owner, 'PUT', '/api/mail/microsoft/client', { clientId: graph.clientId, clientSecret: graph.clientSecret })).status, 200);
  const after = await call(ana, 'GET', '/api/mail/accounts');
  assert.deepEqual(after.json.microsoft, { configured: true, clientId: null, redirect: (after.json.microsoft as { redirect: string }).redirect, ownerApp: true });
});

test('each person connects their own Outlook: lists, files and vaults never mix', async () => {
  const o = await connectOutlook(owner, OWNER_MAIL);
  assert.match(o.text, /#microsoft=connected/, o.text);
  const a = await connectOutlook(ana, ANA_MAIL);
  assert.match(a.text, /#microsoft=connected/, a.text);
  assert.deepEqual(addresses(await call(owner, 'GET', '/api/mail/accounts')), [OWNER_MAIL]);
  assert.deepEqual(addresses(await call(ana, 'GET', '/api/mail/accounts')), [ANA_MAIL]);
  assert.deepEqual(addresses(await call(ben, 'GET', '/api/mail/accounts')), []);
  // Stored where they belong: Ana's list and token in her own vault, never in the server's.
  const { Vault } = await import('../src/vault.ts');
  const { readFileSync } = await import('node:fs');
  const key = readFileSync(join(dataDir, 'master.key'), 'utf8').trim();
  const ownerVault = new Vault(dataDir);
  const anaVault = new Vault(join(dataDir, 'members', ana.memberId!, 'mail'), key);
  assert.ok(existsSync(join(dataDir, 'members', ana.memberId!, 'mail', 'secrets.enc')));
  assert.ok(!existsSync(join(dataDir, 'members', ana.memberId!, 'mail', 'master.key')), 'sealed with the server key: her folder alone holds no key');
  assert.match(ownerVault.get('mail:accounts') ?? '', /owner@outlook\.com/);
  assert.doesNotMatch(ownerVault.get('mail:accounts') ?? '', /ana@outlook/);
  assert.match(anaVault.get('mail:accounts') ?? '', /ana@outlook\.com/);
  assert.doesNotMatch(anaVault.get('mail:accounts') ?? '', /owner@outlook/);
  assert.ok(!existsSync(join(dataDir, 'members', ben.memberId!, 'mail', 'secrets.enc')), 'nothing written for Ben');
  // Nobody reaches another person's account by its id: not to test, set as default or remove.
  const ownerId = ((await call(owner, 'GET', '/api/mail/accounts')).json.accounts as { id: string }[])[0].id;
  const anaId = ((await call(ana, 'GET', '/api/mail/accounts')).json.accounts as { id: string }[])[0].id;
  assert.equal((await call(owner, 'POST', `/api/mail/accounts/${anaId}/test`, {})).json.ok, false);
  assert.equal((await call(ana, 'POST', `/api/mail/accounts/${ownerId}/test`, {})).json.ok, false);
  assert.equal((await call(ana, 'POST', `/api/mail/accounts/${anaId}/test`, {})).json.ok, true);
  assert.equal((await call(owner, 'PUT', '/api/mail/default', { id: anaId })).status, 400);
  assert.equal((await call(ben, 'PUT', '/api/mail/default', { id: anaId })).status, 400);
  assert.equal((await call(owner, 'DELETE', `/api/mail/accounts/${anaId}`)).status, 400);
  assert.equal((await call(ana, 'DELETE', `/api/mail/accounts/${ownerId}`)).status, 400);
  assert.deepEqual(addresses(await call(ana, 'GET', '/api/mail/accounts')), [ANA_MAIL], 'still there');
});

test("Today's Mail card: each person sees their own mailbox; a member without one sees none", async () => {
  const t = async (p: Person) => (await call(p, 'GET', '/api/today?fresh=1')).json.mail as { account?: string; unread?: number } | undefined;
  assert.equal((await t(owner))?.account, OWNER_MAIL);
  assert.equal((await t(ana))?.account, ANA_MAIL);
  assert.equal((await t(ana))?.unread, 1);
  assert.equal(await t(ben), undefined);
});

test("tools: a member's turn has her own mail tools, the owner's lists only his, Ben's has none", async () => {
  const mark = llmRequests.length;
  assert.equal((await say(ana, 'Check my email inbox. TOOL:mail_accounts {}END')).status, 200);
  const anaReqs = llmRequests.slice(mark);
  assert.ok(anaReqs[0].tools.includes('mail_search') && anaReqs[0].tools.includes('mail_send'), anaReqs[0].tools.join(','));
  assert.ok(!anaReqs[0].tools.some((n) => n.startsWith('gmail_')), 'no Gmail sign-in tools for members');
  const anaResult = anaReqs.map((r) => r.text).join('\n');
  assert.match(anaResult, /ana@outlook\.com/);
  assert.doesNotMatch(anaResult, /owner@outlook\.com/);

  const mark2 = llmRequests.length;
  assert.equal((await say(owner, 'Check my email inbox. TOOL:mail_accounts {}END')).status, 200);
  const ownerResult = llmRequests.slice(mark2).map((r) => r.text).join('\n');
  assert.match(ownerResult, /owner@outlook\.com/);
  assert.doesNotMatch(ownerResult, /ana@outlook\.com/, "the owner can't read a member's mail through Sara");

  const mark3 = llmRequests.length;
  assert.equal((await say(ben, 'Check my email inbox and my calendar.')).status, 200);
  for (const r of llmRequests.slice(mark3)) assert.ok(!r.tools.some((n) => n.startsWith('mail_') || n.startsWith('gmail_')), r.tools.join(','));
});

test("approvals: a member's send waits for her own OK in her own space, never the owner's", async () => {
  const sentBefore = graph.sent.length;
  let ownerTried = 0;
  await sayAndDecide(ana, 'TOOL:mail_send {"to":"friend@example.com","subject":"Friday","body":"Yes, lunch works."}END', async (id) => {
    // The owner can't answer (or see) her card.
    const o = await call(owner, 'POST', `/api/approvals/${id}`, { approved: true });
    ownerTried = o.status;
    const b = await call(ben, 'POST', `/api/approvals/${id}`, { approved: true });
    assert.equal(b.status, 404, b.text);
    const r = await call(ana, 'POST', `/api/approvals/${id}`, { approved: true });
    assert.equal(r.status, 200, r.text);
  });
  assert.equal(ownerTried, 404);
  assert.equal(graph.sent.length, sentBefore + 1, 'sent once, after her OK');
});

test("the admin's memberMail pin switches members' mail off (the owner's stays); lifting it brings it back", async () => {
  const set = await call(owner, 'PUT', '/api/policy', { name: 'Home', pins: { memberMail: false } });
  assert.equal(set.status, 200, set.text);
  const v = await call(ana, 'GET', '/api/mail/accounts');
  assert.equal(v.status, 200);
  assert.equal(v.json.off, true);
  assert.deepEqual(addresses(v), []);
  const conn = await call(ana, 'POST', '/api/mail/microsoft/connect', {});
  assert.equal(conn.status, 409, conn.text);
  assert.equal((await call(ana, 'POST', '/api/mail/imap', { preset: 'gmail', address: 'ana@gmail.com', password: 'abcd efgh ijkl mnop' })).status, 409);
  assert.equal((await call(ana, 'GET', '/api/today?fresh=1')).json.mail, undefined);
  const mark = llmRequests.length;
  await say(ana, 'Check my email inbox and my calendar.');
  for (const r of llmRequests.slice(mark)) assert.ok(!r.tools.some((n) => n.startsWith('mail_') || n.startsWith('calendar_')), r.tools.join(','));
  // The owner's mail is not affected.
  assert.deepEqual(addresses(await call(owner, 'GET', '/api/mail/accounts')), [OWNER_MAIL]);
  assert.equal(((await call(owner, 'GET', '/api/today?fresh=1')).json.mail as { account?: string } | undefined)?.account, OWNER_MAIL);
  // Lifted: her mailbox is back as it was.
  assert.equal((await call(owner, 'PUT', '/api/policy', { name: 'Home', pins: {} })).status, 200);
  assert.deepEqual(addresses(await call(ana, 'GET', '/api/mail/accounts')), [ANA_MAIL]);
});

test('a member removes her mailbox: her secrets go, the owner\'s stay', async () => {
  const anaId = ((await call(ana, 'GET', '/api/mail/accounts')).json.accounts as { id: string }[])[0].id;
  assert.equal((await call(ana, 'DELETE', `/api/mail/accounts/${anaId}`)).status, 200);
  assert.deepEqual(addresses(await call(ana, 'GET', '/api/mail/accounts')), []);
  assert.deepEqual(addresses(await call(owner, 'GET', '/api/mail/accounts')), [OWNER_MAIL]);
});
