// Pre-1.0 review fixes (server side): M3 (other apps never draw on private, imported or adult-channel
// conversations), M4 (Home Assistant's own limited token), L4 (API keys survive the sign-in cap),
// L6 (/v1 and /mcp robustness) and UX 14 (a failed first /v1 turn keeps the AI notice).
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_SESSIONS, OwnerAuth } from '../src/auth.ts';
import type { Provider, ProviderConfig } from '../src/providers/types.ts';
import { sharedWithApps } from '../src/recall.ts';
import { createSaraServer, HA_CHANNEL } from '../src/server.ts';
import { call as toolCall, makeApp, ROOT, tempDir, text } from './helpers.ts';

// PL2d (C5): under the full suite a kept-alive connection is now and then closed by the server just as
// the next request goes out (ECONNRESET, seen on the Home Assistant token path, M4). Such a request
// never reached Sara, so this file's requests are sent once more after a reset; any other error, or a
// second reset, still fails the test.
const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
  try {
    return await globalThis.fetch(url, init);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw err;
    return globalThis.fetch(url, init);
  }
};

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-27T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let key = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  key = auth.createApiKey('Scripts').token;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

const v1 = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify({ model: 'sara', ...body }) });
const ownerApi = (path: string, method = 'GET', body?: unknown) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${owner}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const systemOf = () => app.requests.at(-1)!.messages[0].content;
const allText = () => app.requests.at(-1)!.messages.map((m) => m.content).join('\n');

/** A private conversation (and an adult-channel one) with something only it knows. */
function seedSecrets() {
  const priv = app.store.createConversation({ title: 'Diary', private: true });
  app.store.addMessage(priv.id, 'user', 'My pineapple password is Kumquat-77. Remember when I told you about the pineapple tart?');
  app.store.addMessage(priv.id, 'assistant', 'Kumquat-77, got it.');
  app.memory!.add({ kind: 'fact', content: 'Alex keeps a pineapple password: Kumquat-77', conversationId: priv.id, sourceMessageId: null, happenedOn: '2026-10-26' });
  app.memory!.add({ kind: 'summary', content: 'Private talk about the pineapple password Kumquat-77', conversationId: priv.id, sourceMessageId: null, happenedOn: '2026-10-26' });
  app.memory!.add({ kind: 'date', content: 'Pineapple anniversary (secret)', conversationId: priv.id, sourceMessageId: null, happenedOn: '2026-10-26', onDate: '10-28' } as never);
  const nsfw = app.store.createConversation({ title: 'Late', channel: 'discord-nsfw', channelKey: 'x' });
  app.memory!.add({ kind: 'fact', content: 'Alex has a pineapple nickname: Sugarlips', conversationId: nsfw.id, sourceMessageId: null, happenedOn: '2026-10-26' });
  const mine = app.store.createConversation({ title: 'Garden' });
  app.memory!.add({ kind: 'fact', content: 'Alex grows pineapple sage in the garden', conversationId: mine.id, sourceMessageId: null, happenedOn: '2026-10-26' });
  return { priv, nsfw, mine };
}

test('M3: a private conversation\'s notes, summary, dates and lines never reach a /v1 or MCP turn', async () => {
  const { priv, nsfw } = seedSecrets();
  assert.equal(sharedWithApps(priv), false);
  assert.equal(sharedWithApps(nsfw), false);
  // Control: her own app does use it (the owner's private notes are hers to use with the owner).
  const web = (await (await ownerApi('/api/conversations', 'POST', {})).json()) as { id: string };
  app.script.push(text('Mm.'));
  await (await ownerApi(`/api/conversations/${web.id}/messages`, 'POST', { content: 'what was my pineapple password again?' })).text();
  assert.match(allText(), /Kumquat-77/, 'control: the web app has it');

  app.script.push(text('No idea.'));
  const r = await v1({ messages: [{ role: 'user', content: 'Remember when I told you my pineapple password? What was it?' }] }, { 'x-sara-conversation': 'm3' });
  assert.equal(r.status, 200);
  const seen = allText();
  assert.doesNotMatch(seen, /Kumquat/, 'no private note, summary, recall or last-time line');
  assert.doesNotMatch(seen, /Sugarlips/, 'no adult-channel note');
  assert.doesNotMatch(seen, /Pineapple anniversary/, 'no date from a private conversation');
  assert.match(systemOf(), /pineapple sage/, 'her own shareable notes still come');
  assert.doesNotMatch(systemOf(), /lately in your other conversations|another chat in the app/i);

  // MCP ask_sara: the same rule.
  app.script.push(text('No idea.'));
  const m = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_sara', arguments: { message: 'remember my pineapple password?' } } }) });
  assert.equal(m.status, 200);
  assert.doesNotMatch(allText(), /Kumquat|Sugarlips/);

  // With her tools allowed for other apps, her look-back tool (recall) still stays out.
  app.settings.update({ otherApps: { tools: true } });
  try {
    app.script.push(text('Ok.'));
    await v1({ messages: [{ role: 'user', content: 'hi' }] }, { 'x-sara-conversation': 'm3-tools' });
    const names = (app.requests.at(-1)!.tools ?? []).map((t) => t.name);
    assert.ok(names.length > 0 && !names.includes('recall'), names.join(','));
  } finally {
    app.settings.update({ otherApps: { tools: false } });
  }
});

test('UX 14: a first /v1 turn that fails keeps the AI notice in the error and leaves no dangling line', async () => {
  const orig = app.providerFactory!;
  const broken = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => [],
    async *stream() {
      throw new Error('model is down');
    },
  });
  app.providerFactory = broken;
  // A new session: the AI notice is due again.
  clock.now = new Date(clock.now.getTime() + 3 * 86_400_000);
  try {
    const r = await v1({ messages: [{ role: 'user', content: 'tell me a story about a fox' }] }, { 'x-sara-conversation': 'fails' });
    assert.equal(r.status, 502);
    const j = (await r.json()) as { error: { message: string; code: string } };
    assert.equal(j.error.code, 'turn_failed');
    assert.match(j.error.message, /AI/, 'the notice is in the error');
    assert.match(j.error.message, /model is down/);
    const conv = app.store.listConversations().find((c) => c.channel === 'api' && c.title.endsWith('fails'))!;
    assert.deepEqual(app.store.messages(conv.id).map((m) => m.role), [], 'nothing left behind');
    // Streamed: the notice comes as text, then the error.
    const s = await v1({ stream: true, messages: [{ role: 'user', content: 'again?' }] }, { 'x-sara-conversation': 'fails-stream' });
    const raw = await s.text();
    assert.match(raw, /AI/);
    assert.match(raw, /"code":"turn_failed"/);
  } finally {
    app.providerFactory = orig;
  }
  // The next turn shows the notice again (it was never really shown) and doesn't see the failed line.
  app.script.push(text('Once there was a fox.'));
  const ok = await v1({ messages: [{ role: 'user', content: 'tell me a story about a fox' }] }, { 'x-sara-conversation': 'fails' });
  const content = ((await ok.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
  assert.match(content, /AI/);
  assert.match(content, /Once there was a fox\.$/);
  assert.equal(app.requests.at(-1)!.messages.filter((m) => m.role === 'user' && m.content === 'tell me a story about a fox').length, 1);
});

test('L6: a broken %-sequence on /v1 is a 404; MCP keeps a character split across chunks whole', async () => {
  const bad = await fetch(`${base}/v1/models/%E0%A4%A`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(bad.status, 404);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'unknown_url');
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_memory', arguments: { query: 'Zoë' } } }));
  const cut = body.indexOf(Buffer.from('ë')) + 1; // between the two bytes of ë
  const out = await new Promise<string>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18', 'content-length': body.length } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve(t));
    });
    req.on('error', reject);
    req.write(body.subarray(0, cut));
    setTimeout(() => req.end(body.subarray(cut)), 50);
  });
  assert.match(out, /Zoë/);
  assert.doesNotMatch(out, /\uFFFD/);
});

test('L4: a pile of sign-ins never drops an API key; other sign-ins are capped on their own', () => {
  const d = tempDir();
  try {
    const a = new OwnerAuth(d.dir, () => clock.now);
    const keys = [a.createApiKey('One'), a.createApiKey('Two'), a.createApiKey('Three')];
    for (let i = 0; i < MAX_SESSIONS + 20; i++) {
      if (i % 2) a.createSession(`Browser ${i}`);
      else a.createDeviceToken(`App ${i}`);
    }
    for (const k of keys) assert.ok(a.deviceTokenId(k.token), 'every API key still works');
    const list = a.devices();
    assert.equal(list.filter((x) => x.kind === 'api').length, 3);
    assert.equal(list.filter((x) => x.kind !== 'api').length, MAX_SESSIONS);
    assert.ok(list.some((x) => x.label === `Browser ${MAX_SESSIONS + 19}`), 'the newest sign-ins are kept');
  } finally {
    d.cleanup();
  }
});

/** Signs in like the Home Assistant integration: a device code asking for the limited scope. */
async function haToken(scope?: string): Promise<{ token: string; id: string }> {
  const json = { 'content-type': 'application/json', 'user-agent': 'HomeAssistant-Sara/0.2.0' };
  const start = (await (await fetch(`${base}/api/device/start`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Home Assistant', ...(scope ? { scope } : {}) }) })).json()) as { code: string; pollToken: string; scope: string };
  assert.equal(start.scope, scope === 'home-assistant' ? 'home-assistant' : 'full');
  const pending = (await (await ownerApi(`/api/device/pending?code=${start.code}`)).json()) as { request: { scope: string } };
  assert.equal(pending.request.scope, start.scope, 'the owner sees what it asked for');
  assert.equal((await ownerApi('/api/device/approve', 'POST', { code: start.code, token: owner })).status, 200);
  const poll = (await (await fetch(`${base}/api/device/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pollToken: start.pollToken }) })).json()) as { token: string; deviceId: string };
  return { token: poll.token, id: poll.deviceId };
}

test('M4: Home Assistant\'s token only talks in its own conversations, with her tools off', async () => {
  const ha = await haToken('home-assistant');
  assert.equal(auth.devices().find((d) => d.id === ha.id)?.kind, 'home-assistant');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${ha.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const who = (await (await call('/api/device/whoami')).json()) as { device: { scope: string } };
  assert.equal(who.device.scope, 'home-assistant');
  // Nothing of hers outside its own conversations.
  for (const path of ['/api/memories', '/api/settings', '/api/persona', '/api/tasks', '/api/files', '/api/today', '/api/health/details', '/api/devices']) assert.equal((await call(path)).status, 403, path);
  assert.deepEqual(await (await call('/api/conversations')).json(), [], 'the owner\'s conversations are not listed');
  const ownerConv = app.store.createConversation({ title: 'Owner only' });
  assert.equal((await call(`/api/conversations/${ownerConv.id}/messages?limit=20`)).status, 404);
  assert.equal((await call(`/api/conversations/${ownerConv.id}/messages`, 'POST', { content: 'hi' })).status, 404, 'cannot post into the owner\'s conversations');
  // Its own conversation: made, renamed, used.
  const conv = (await (await call('/api/conversations', 'POST', {})).json()) as { id: string; channel: string };
  assert.equal(conv.channel, HA_CHANNEL);
  assert.equal((await call(`/api/conversations/${conv.id}`, 'PATCH', { title: 'Home Assistant', private: true })).status, 200);
  assert.equal(app.store.getConversation(conv.id)?.private, false, 'only the title can change');
  assert.deepEqual(((await (await call('/api/conversations')).json()) as { id: string }[]).map((c) => c.id), [conv.id]);
  app.script.push([toolCall('t1', 'todo', { action: 'add', title: 'Buy milk' })], text('Okay.'));
  const tasks = app.planner!.tasks().length;
  const sse = await (await call(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'add milk; and what is my pineapple password?' })).text();
  assert.match(sse, /"type":"done"|"type":"token"/);
  assert.equal(app.requests.at(-1)!.tools?.length ?? 0, 0, 'her tools are off for Home Assistant by default');
  assert.equal(app.planner!.tasks().length, tasks);
  assert.doesNotMatch(allText(), /Kumquat/, 'the external-app memory rule applies (M3)');
  // Approving her actions is for the owner; signing out works.
  assert.equal((await call('/api/approvals/x', 'POST', { approved: true })).status, 403);
  assert.equal((await call('/api/approvals/x', 'POST', { approved: false })).status, 404);
  // Another Home Assistant token doesn't see this one's conversations.
  const other = await haToken('home-assistant');
  assert.deepEqual(await (await fetch(`${base}/api/conversations`, { headers: { authorization: `Bearer ${other.token}` } })).json(), []);
  assert.equal((await call('/api/device/logout', 'POST', {})).status, 200);
  assert.equal((await call('/api/conversations')).status, 401);
  // An app that doesn't ask for the scope gets a normal device token (terminal, VS Code).
  const full = await haToken();
  assert.equal(auth.devices().find((d) => d.id === full.id)?.kind, 'app');
});
