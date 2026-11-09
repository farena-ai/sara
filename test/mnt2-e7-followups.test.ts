// MNT2 (E7 follow-ups, docs/ops/MNT2_DESIGN.md §5): pick a workflow saved inside ComfyUI (through
// the comfyui tool server's get_workflow list/get, a fake here), and her own pictures also go to the
// owner's Telegram/Discord DM when he chose it (stand-in servers; no network beyond loopback).
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { makeTestPicture } from '../src/bridges/test-picture.ts';
import { listComfyWorkflows, loadComfyWorkflow } from '../src/image-engines.ts';
import { createSaraServer } from '../src/server.ts';
import { mcpToolName } from '../src/tools/mcp.ts';
import type { Tool } from '../src/tools/types.ts';
import { listen, makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const API_WF = { '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20 } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] }, _meta: { title: 'Positive' } } };
const LIST_TEXT = 'Found 2 workflow(s) — each name below is what get_workflow (action:"get" / "analyze" / "query") takes as `filename`. Subfolders ARE included.\n\n1. portrait.json\n2. SDXL/her day.json';

function fakeComfy(app: TestApp, calls: Record<string, unknown>[], o: { get?: string } = {}): void {
  const tool: Tool = {
    spec: { name: mcpToolName('comfyui', 'get_workflow'), description: 'saved workflows', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: () => 'Read a saved workflow',
    async run(args) {
      calls.push(args);
      if (args.action === 'list') return LIST_TEXT;
      if (args.action === 'get' && args.filename === 'missing.json') return 'Workflow not found: missing.json (404)';
      if (args.action === 'get') return o.get ?? `${JSON.stringify(API_WF, null, 2)}\n**Conversion warnings (1):**\n- a Reroute was removed {not json}`;
      throw new Error('unexpected action');
    },
  };
  app.tools.add(tool);
}

test('MNT2: the saved ComfyUI workflows are listed and one is read in API format through get_workflow', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  try {
    const calls: Record<string, unknown>[] = [];
    fakeComfy(app, calls);
    const deps = { tools: { get: (n: string) => app.tools.get(n), permission: () => 'auto' as const } };
    assert.deepEqual(await listComfyWorkflows(deps, 'comfyui'), ['portrait.json', 'SDXL/her day.json']);
    assert.deepEqual(await loadComfyWorkflow(deps, 'comfyui', 'SDXL/her day.json'), API_WF);
    assert.deepEqual(calls.at(-1), { action: 'get', filename: 'SDXL/her day.json', format: 'api' });
    await assert.rejects(loadComfyWorkflow(deps, 'comfyui', 'missing.json'), /not found|couldn't read/i);
    await assert.rejects(loadComfyWorkflow(deps, 'comfyui', '../secrets.json'), /name from the list/i);
    await assert.rejects(listComfyWorkflows({ tools: { get: () => undefined, permission: () => 'auto' } }, 'comfyui'), /isn't connected/);
  } finally { app.store.close(); cleanup(); }
});

test('MNT2: Settings picks a saved workflow by name: the route lists them, keeps a copy and remembers the name', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  const calls: Record<string, unknown>[] = [];
  fakeComfy(app, calls);
  const auth = new OwnerAuth(dir); const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(origin + '/api' + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  try {
    const list = await api('/photos/comfy/workflows?server=comfyui');
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.deepEqual(list.json.workflows, ['portrait.json', 'SDXL/her day.json']);
    const saved = await api('/photos', 'PUT', { engine: 'comfyui', comfy: { server: 'comfyui', saved: 'portrait.json', seed: true } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.comfy.saved, 'portrait.json');
    assert.deepEqual(saved.json.comfy.nodes.map((n: { id: string }) => n.id), ['6']);
    assert.equal(saved.json.comfy.node, '6');
    assert.deepEqual((app.settings.get().photos as { comfy?: { workflow?: unknown } }).comfy?.workflow, API_WF, 'Sara keeps a copy');
    // Pasting a workflow again forgets the saved name.
    const pasted = await api('/photos', 'PUT', { engine: 'comfyui', comfy: { server: 'comfyui', workflow: JSON.stringify(API_WF), node: '6', input: 'text' } });
    assert.equal(pasted.json.comfy.saved, null);
    assert.equal((await api('/photos', 'PUT', { engine: 'comfyui', comfy: { server: 'comfyui', saved: 'missing.json' } })).status, 400);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    app.store.close(); cleanup();
  }
});

// ------------------------------------------------------------------ her own pictures in the chat apps

async function bodyOf(req: IncomingMessage): Promise<{ json: Record<string, unknown>; form?: FormData }> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('multipart/')) return { json: {}, form: await new Response(buf, { headers: { 'content-type': type } }).formData() };
  return { json: JSON.parse(buf.toString('utf8') || '{}') as Record<string, unknown> };
}
const until = async (f: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return f(); };

/** Her own picture message, as maybeOwnPhoto saves and publishes it. */
function ownPicture(app: TestApp): void {
  const conv = app.store.createConversation();
  const id = app.uploads!.saveBytes(makeTestPicture(8)).id;
  const msg = app.store.addMessage(conv.id, 'assistant', 'On my walk by the river.', { proactive: { reason: 'picture' }, images: [id] });
  app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'proactive' });
}

const OWNER = 1001;
test('MNT2: with "also to my chat apps" on, her own picture reaches the owner\'s Telegram as a photo; off: nothing goes', async (t) => {
  for (const toApps of [true, false]) {
    const { dir, cleanup } = tempDir();
    const app: TestApp = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
    const sent: { method: string; body: Record<string, unknown>; form?: FormData }[] = [];
    const { server, url } = await listen(async (req, res) => {
      const method = (req.url ?? '').split('/').pop()!;
      const { json, form } = await bodyOf(req);
      sent.push({ method, body: json, ...(form ? { form } : {}) });
      let result: unknown = true;
      if (method === 'getMe') result = { id: 999, is_bot: true, username: 'sara_test_bot' };
      else if (method === 'getUpdates') result = await new Promise(r => setTimeout(() => r([]), 50));
      else if (method === 'sendMessage' || method === 'sendPhoto') result = { message_id: sent.length, photo: [{ file_id: 'p' }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    });
    app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', telegram: { enabled: true, mirror: true, ownerChatId: OWNER }, photos: { mode: 'new', own: { on: true, often: 'rarely', monthlyCap: 8, toApps } } } as never);
    app.vault.set(TELEGRAM_VAULT, '123456789:AAF-test-token-for-mnt2');
    const bridge = new TelegramBridge(app, { apiBase: url });
    await bridge.restart(); await bridge.menus; await bridge.leftovers;
    try {
      ownPicture(app);
      if (toApps) {
        assert.ok(await until(() => sent.some(s => s.method === 'sendPhoto')), 'a photo went to Telegram');
        const photo = sent.find(s => s.method === 'sendPhoto')!;
        assert.equal(String(photo.form!.get('chat_id')), String(OWNER));
        assert.equal(photo.form!.get('caption'), 'On my walk by the river.');
        assert.ok(!sent.some(s => s.method === 'sendMessage' && s.body.text === 'On my walk by the river.'), 'the caption is not sent twice');
      } else {
        await new Promise(r => setTimeout(r, 300));
        assert.ok(!sent.some(s => s.method === 'sendPhoto' || (s.method === 'sendMessage' && s.body.text === 'On my walk by the river.')), 'a caption without its picture is not mirrored');
      }
    } finally { bridge.stop(); server.close(); app.store.close(); cleanup(); }
  }
  void t;
});

test('MNT2: with "also to my chat apps" on, her own picture reaches the owner\'s Discord DM as one files[0] message', async () => {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  const sent: { method: string; path: string; body: Record<string, unknown>; form?: FormData }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const path = req.url ?? '';
    const { json, form } = await bodyOf(req);
    sent.push({ method: req.method ?? '', path, body: json, ...(form ? { form } : {}) });
    let result: unknown = {};
    if (path === '/users/@me') result = { id: '900', username: 'Sara', bot: true };
    else if (path === '/users/@me/channels') result = { id: 'dm-owner' };
    else if (/\/messages$/.test(path) && req.method === 'POST') result = { id: String(sent.length), attachments: form ? [{ id: 'att-1' }] : [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', discord: { enabled: true, mirror: false, ownerUserId: '100' }, photos: { mode: 'new', own: { on: true, often: 'rarely', monthlyCap: 8, toApps: true } } } as never);
  app.vault.set(DISCORD_VAULT, ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'));
  let sock: GatewaySocket | undefined;
  const bridge = new DiscordBridge(app, { api: url, connect: () => (sock = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) });
  await bridge.restart(); void sock;
  try {
    ownPicture(app);
    const posts = () => sent.filter(s => s.method === 'POST' && s.path === '/channels/dm-owner/messages');
    assert.ok(await until(() => posts().some(p => p.form)), 'a picture went to the owner DM (even with mirroring off: he chose it)');
    const payload = JSON.parse(String(posts().find(p => p.form)!.form!.get('payload_json')));
    assert.equal(payload.content, 'On my walk by the river.');
    assert.ok(posts().find(p => p.form)!.form!.get('files[0]') instanceof Blob);
  } finally { bridge.stop(); server.close(); app.store.close(); cleanup(); }
});
