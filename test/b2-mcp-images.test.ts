// B2 fix 7 (owner report, run 1376): ComfyUI's get_image returns an MCP image block, which Sara used to
// drop as "[image image/png omitted]"; she then said she had sent the picture. Pictures from MCP tools
// are now saved like her photos and attached to her reply, with a plain reason when one can't be.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { McpManager } from '../src/tools/mcp.ts';
import { UploadStore } from '../src/uploads.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'mcp-image-server.mjs');
const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };
const noSandbox = { mode: 'none' as const, network: true, detail: '' };

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T09:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.uploads ??= new UploadStore(dir);
  app.settings.update({ providers: [CLOUD], defaultProviderId: 'c', defaultModel: 'cloud-m', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { mcp_img_get_image: 'auto', mcp_img_big: 'auto', mcp_img_svg: 'auto', mcp_img_many: 'auto' } } as never);
  const mgr = new McpManager(app.tools, { dataDir: dir, sandbox: noSandbox, secrets: () => ({}) });
  const conn = await mgr.start({ name: 'img', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE] });
  assert.equal(conn.status, 'ready', conn.error);
  t.after(async () => {
    mgr.stopAll();
    app.store.close();
    await new Promise((r) => setTimeout(r, 300));
    cleanup();
  });
  return { app, dir };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const result = (evs: ChatEvent[], name: string) => (evs.find((e) => e.type === 'tool_result' && e.name === name) as Extract<ChatEvent, { type: 'tool_result' }>).output;

test('B2 fix 7: an MCP image block is saved as an upload and attached to her reply', async (t) => {
  const { app } = await setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'mcp_img_get_image', {})], text('Here it is.'));
  const evs = await drain(runTurn(app, conv.id, 'show me the last ComfyUI picture'));
  const out = result(evs, 'mcp_img_get_image');
  assert.match(out, /ComfyUI_00001_\.png/);
  assert.match(out, /Image attached to your reply \(1 KB\)\. It is shown to the owner with your message\./);
  assert.doesNotMatch(out, /omitted/);
  const imgs = evs.filter((e) => e.type === 'image') as Extract<ChatEvent, { type: 'image' }>[];
  assert.equal(imgs.length, 1);
  assert.ok(app.uploads!.load(imgs[0].id), 'the picture is a real upload');
  const msgs = app.store.messages(conv.id).filter((m) => m.role === 'assistant');
  assert.ok(msgs.some((m) => (m.meta?.images as string[] | undefined)?.includes(imgs[0].id)), 'kept with her message');
});

test('B2 fix 7: over the size cap, another type or more than four: each says why it was not attached', async (t) => {
  const { app } = await setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'mcp_img_big', {}), call('c2', 'mcp_img_svg', {}), call('c3', 'mcp_img_many', {})], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'pictures please'));
  assert.match(result(evs, 'mcp_img_big'), /Image not attached: it is 9\.0 MB; pictures can be up to 8 MB\./);
  assert.match(result(evs, 'mcp_img_svg'), /Image not attached: image\/svg\+xml pictures can't be shown; only PNG, JPEG, WebP or GIF\./);
  const many = result(evs, 'mcp_img_many');
  assert.equal(many.match(/Image attached to your reply/g)?.length, 4);
  assert.match(many, /Image not attached: at most 4 pictures per tool call\./);
  assert.equal(evs.filter((e) => e.type === 'image').length, 4, 'the same picture four times is four attachments at most');
});

test('B2 fix 7: without a chat to attach to, the tool says the picture was not attached', async (t) => {
  const { app, dir } = await setup(t);
  const out = await app.tools.get('mcp_img_get_image')!.run({}, { workspaceDir: dir, signal: new AbortController().signal, sandbox: noSandbox });
  assert.match(out, /Image not attached: pictures from tools can't be shown here\./);
});
