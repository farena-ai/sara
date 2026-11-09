// EC22 (docs/ops/EC2122_DESIGN.md): the embedding SDK (packages/sara-sdk) against a throwaway Sara
// in this process: device-code sign-in, conversations, a streamed reply, an approval answered by the
// example app, a file upload, the OpenAI-compatible /v1, webhook verification; the route table
// against the server; the generated REST reference; the tsc build and the npm pack file list.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Sara, SaraError, verifyWebhook, ROUTES, fill, type ChatEvent } from '../packages/sara-sdk/src/index.ts';
import { OwnerAuth } from '../src/auth.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createSaraServer } from '../src/server.ts';
import { signStandard } from '../src/webhook-verify.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const PKG = join(ROOT, 'packages', 'sara-sdk');
// Production installs (the server suite) have no typescript dev dependency: no build there.
const NO_TSC = existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')) ? false : 'needs the typescript dev dependency (not in production installs)';
const NODE = process.execPath;
const { dir, cleanup } = tempDir();
const clock = { now: new Date() };
const app = makeApp(dir, clock);
app.library = new LibraryStore(app.store.db, dir, () => clock.now);
const ran: string[] = [];
app.tools.add({ spec: { name: 'save_note', description: 'Save a note.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }, defaultPermission: 'ask', source: 'built-in', summarize: (a) => `Save the note "${String(a.text ?? '')}"`, run: async (a) => (ran.push(String(a.text)), 'saved') });
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let deviceToken = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' }], defaultProviderId: 'c', defaultModel: 'cloud-m', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  // A test that stopped early must not leave its scripted model steps for the next one.
  app.script.length = 0;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

test('it builds with tsc to dist (ESM + types) and npm pack ships only dist, README and LICENSE', { skip: NO_TSC }, () => {
  rmSync(join(PKG, 'dist'), { recursive: true, force: true });
  execFileSync(NODE, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'tsconfig.json')], { stdio: 'pipe' });
  for (const f of ['index.js', 'index.d.ts', 'routes.js', 'webhooks.js']) assert.ok(existsSync(join(PKG, 'dist', f)), f);
  assert.match(readFileSync(join(PKG, 'dist', 'index.js'), 'utf8'), /from '\.\/routes\.js'/, 'relative imports end in .js');
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.engines.node, '>=18');
  const npmCli = join(NODE, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packed = JSON.parse(execFileSync(NODE, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PKG, encoding: 'utf8' })) as { files: { path: string }[] }[];
  const files = packed[0].files.map((f) => f.path).sort();
  assert.ok(files.every((f) => f.startsWith('dist/') || ['LICENSE', 'README.md', 'package.json'].includes(f)), files.join(', '));
  assert.ok(files.includes('dist/index.d.ts'));
});

test('the SDK source is browser-safe: no Node imports except the WebCrypto fallback, no Buffer or process', () => {
  for (const f of ['index.ts', 'routes.ts', 'webhooks.ts', 'sse.ts']) {
    const src = readFileSync(join(PKG, 'src', f), 'utf8');
    const nodeImports = [...src.matchAll(/import\((?:\/\*[^*]*\*\/\s*)?'(node:[^']+)'/g), ...src.matchAll(/from '(node:[^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(nodeImports.filter((m) => m !== 'node:crypto'), [], f);
    assert.doesNotMatch(src, /\bBuffer\.|\bprocess\./, f);
  }
});

test('device-code sign-in: start, the owner approves, the SDK gets a token; whoami', async () => {
  const sara = new Sara({ server: base });
  const seen: string[] = [];
  const token = await sara.auth.signIn({
    name: 'SDK test app',
    intervalMs: 30,
    onCode: async (c) => {
      seen.push(c.code);
      const r = await fetch(`${base}/api/device/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: c.code, token: owner }) });
      assert.equal(r.status, 200);
    },
  });
  assert.equal(seen.length, 1);
  assert.match(token, /\S{20,}/);
  assert.equal(sara.token, token);
  deviceToken = token;
  const me = await sara.auth.whoami();
  assert.equal(me.companion, app.persona.name);
  assert.equal(me.device?.label, 'SDK test app');
});

test('conversations and a streamed reply', async () => {
  const sara = new Sara({ server: base, token: deviceToken });
  const conv = await sara.conversations.create({ title: 'From the SDK' });
  assert.ok(conv.id);
  assert.ok((await sara.conversations.list()).some((c) => c.id === conv.id));
  app.script.push(text('Hello', ' from', ' Sara.'));
  const tokens: string[] = [];
  const types = new Set<string>();
  for await (const ev of sara.chat(conv.id, 'hi')) {
    types.add(ev.type);
    if (ev.type === 'token') tokens.push(ev.text);
  }
  assert.equal(tokens.join(''), 'Hello from Sara.');
  assert.ok(types.has('done'));
  app.script.push(text('Again.'));
  const r = await sara.reply(conv.id, 'once more');
  assert.equal(r.text, 'Again.');
  const got = await sara.conversations.get(conv.id, { limit: 10 });
  assert.ok(got.messages.some((m) => m.role === 'assistant' && m.content === 'Again.'));
  await assert.rejects(sara.conversations.get('nope'), (e: unknown) => e instanceof SaraError && e.status === 404);
});

test('the example app streams a reply and answers an approval', { skip: NO_TSC }, async () => {
  const sara = new Sara({ server: base, token: deviceToken });
  const conv = await sara.conversations.create({});
  app.script.push([call('n1', 'save_note', { text: 'milk' })], text('Saved', ' your note.'));
  const child = spawn(NODE, [join(PKG, 'examples', 'stream-and-approve.mjs')], { env: { ...process.env, SARA_SERVER: base, SARA_TOKEN: deviceToken, SARA_CONVERSATION: conv.id, SARA_MESSAGE: 'note: milk', SARA_APPROVE: 'yes' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, err);
  assert.match(out, /Sara wants to: Save the note "milk"/);
  assert.match(out, /→ allowed/);
  assert.match(out, /Saved your note\./);
  assert.deepEqual(ran, ['milk']);
});

test('a denied approval through approvals.answer: nothing runs', async () => {
  const sara = new Sara({ server: base, token: deviceToken });
  const conv = await sara.conversations.create({});
  app.script.push([call('n2', 'save_note', { text: 'eggs' })], text('Okay, I did not save it.'));
  const r = await sara.reply(conv.id, 'note: eggs', { onApproval: async () => false });
  assert.match(r.text, /did not save/);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].approved, false);
  assert.ok(!ran.includes('eggs'));
});

test('files: upload a document and send it with a message', async () => {
  const sara = new Sara({ server: base, token: deviceToken });
  const conv = await sara.conversations.create({});
  const up = await sara.files.upload(new TextEncoder().encode('# Notes\nBuy milk.'), { name: 'notes.md', conversationId: conv.id });
  assert.ok(up.doc.id > 0);
  assert.equal(up.doc.name, 'notes.md');
  app.script.push(text('I see your notes.'));
  const r = await sara.reply(conv.id, 'read this', { docs: [up.doc.id] });
  assert.equal(r.text, 'I see your notes.');
});

test('/v1: models and chat (plain and streamed) with an API key', async () => {
  const key = auth.createApiKey('SDK v1').token;
  const sara = new Sara({ server: base, token: key });
  const models = await sara.v1.models();
  assert.ok(models.data.some((m) => m.id === 'sara'));
  app.script.push(text('Plain answer.'));
  const c = await sara.v1.chat({ model: 'sara', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(c.choices[0].message.content, 'Plain answer.');
  app.script.push(text('Streamed', ' answer.'));
  let s = '';
  for await (const part of sara.v1.chatStream({ model: 'sara', messages: [{ role: 'user', content: 'hi again' }] })) s += part;
  assert.equal(s, 'Streamed answer.');
  await assert.rejects(new Sara({ server: base, token: 'wrong' }).v1.models(), (e: unknown) => e instanceof SaraError && e.status === 401);
});

test('C5 /v1/responses through the SDK: create, continue with previous_response_id while streaming, get, delete', async () => {
  const sara = new Sara({ server: base, token: auth.createApiKey('SDK responses').token });
  app.script.push(text('Green, noted.'));
  const first = await sara.v1.responses.create({ model: 'sara', input: 'My favourite colour is green.' });
  assert.equal(first.status, 'completed');
  app.script.push(text('It is ', 'green.'));
  let words = '';
  let last: string | undefined;
  for await (const ev of sara.v1.responses.stream({ model: 'sara', previous_response_id: first.id, input: 'Which colour?' })) {
    if (ev.type === 'response.output_text.delta') words += ev.delta;
    last = ev.type;
  }
  assert.match(words, /It is green\.$/);
  assert.equal(last, 'response.completed');
  assert.equal((await sara.v1.responses.get(first.id)).id, first.id);
  assert.equal((await sara.v1.responses.delete(first.id)).deleted, true);
  await assert.rejects(sara.v1.responses.get(first.id), (e: unknown) => e instanceof SaraError && e.status === 404);
});

test('webhooks: Sara\'s signature verifies; a changed body, a stale stamp or another secret do not', async () => {
  const secret = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`;
  const body = JSON.stringify({ event: 'reply', text: 'hi' });
  const now = 1_800_000_000;
  const headers = signStandard(secret, 'msg_1', now, body);
  assert.deepEqual(await verifyWebhook({ secret, body, headers, nowS: now + 10 }), { ok: true, id: 'msg_1' });
  assert.equal((await verifyWebhook({ secret, body: new TextEncoder().encode(body), headers: new Headers(headers), nowS: now })).ok, true);
  assert.match((await verifyWebhook({ secret, body: body.replace('hi', 'ho'), headers, nowS: now })).why!, /no v1 signature/);
  assert.match((await verifyWebhook({ secret, body, headers, nowS: now + 301 })).why!, /too old/);
  assert.equal((await verifyWebhook({ secret: `whsec_${btoa('another secret, 32 bytes long!!')}`, body, headers, nowS: now })).ok, false);
  assert.match((await verifyWebhook({ secret, body, headers: {}, nowS: now })).why!, /missing/);
});

test('every route in the SDK table exists on the server (no generic 404)', async () => {
  const key = auth.createApiKey('routes').token;
  const device = auth.createDeviceToken('routes').token;
  // Signing out last (it ends the token the others use).
  for (const r of [...ROUTES].sort((a, b) => Number(a.sdk === 'auth.signOut') - Number(b.sdk === 'auth.signOut'))) {
    const url = base + fill(r.path, { id: 'x-not-there' });
    const res = await fetch(url, { method: r.method, headers: { authorization: `Bearer ${r.auth === 'api-key' ? key : device}`, 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : r.path === '/api/library' ? 'x' : '{}' });
    const body = await res.text();
    const generic = res.status === 404 && (/^\{"error":"Not found"\}$/.test(body) || /unknown_url/.test(body));
    assert.ok(!generic, `${r.method} ${r.path}: ${res.status} ${body.slice(0, 120)}`);
    assert.ok(res.status !== 405 && !(r.auth !== 'none' && res.status === 401), `${r.method} ${r.path}: ${res.status}`);
  }
});

test('docs/API.md is generated from the route table and up to date', () => {
  const out = execFileSync(NODE, [join(ROOT, 'scripts', 'api-reference.ts'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
  const doc = readFileSync(join(ROOT, 'docs', 'API.md'), 'utf8');
  for (const r of ROUTES) assert.ok(doc.includes(`${r.method} ${r.path}`), r.path);
});

test('ChatEvent narrowing compiles for the common events', () => {
  const show = (ev: ChatEvent): string => (ev.type === 'token' ? ev.text : ev.type === 'approval' ? ev.approvalId : ev.type);
  assert.equal(show({ type: 'token', text: 'x' }), 'x');
});
