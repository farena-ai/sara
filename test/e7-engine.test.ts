// E7 (B1): her pictures made with the owner's engine: ComfyUI workflow (prompt into the chosen node,
// through a fake MCP), OpenAI images, any image tool; the picture is attached only when it came back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanWorkflow, fillWorkflow, promptNodes, type ComfyWorkflow } from '../src/image-engines.ts';
import { createPhotoTools, type PhotoDeps } from '../src/photos.ts';
import { SettingsStore } from '../src/settings.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { UploadStore } from '../src/uploads.ts';
import { Vault } from '../src/vault.ts';
import { ROOT, tempDir } from './helpers.ts';
import { join } from 'node:path';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const WF: ComfyWorkflow = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] }, _meta: { title: 'Positive' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] }, _meta: { title: 'Negative' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'sara', images: ['8', 0] } },
};

/** A fake comfyui MCP server: the three tools the engine uses, registered like McpManager does. */
function fakeComfy(reg: ToolRegistry, o: { image: boolean }) {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  let polls = 0;
  const tool = (name: string, run: (args: Record<string, unknown>, ctx: ToolContext) => string): Tool => ({
    defaultPermission: 'ask',
    source: 'MCP: comfyui',
    spec: { name: `mcp_comfyui_${name}`, description: '', parameters: { type: 'object' } },
    summarize: () => name,
    run: async (args, ctx) => {
      seen.push({ tool: name, args });
      return run(args, ctx);
    },
  });
  reg.add(tool('enqueue_workflow', () => JSON.stringify({ prompt_id: 'p-123456', number: 1 })));
  reg.add(tool('get_history', () => (++polls < 2 ? JSON.stringify({ status: 'running' }) : JSON.stringify({ outputs: { '9': { images: [{ filename: 'sara_0001.png', subfolder: 'e7', type: 'output' }] } } }))));
  reg.add(
    tool('get_image', (_a, ctx) => {
      // What B2's MCP image block does: save the bytes, attach the id.
      const c = ctx as ToolContext & { saveImage?: (b: Buffer) => string };
      if (o.image && c.saveImage) c.attachImage?.(c.saveImage(PNG));
      return o.image ? 'Image attached.' : '[image image/png omitted]';
    }),
  );
  return seen;
}

function setup(t: { after: (fn: () => void) => void }, engine: Record<string, unknown>, extra: Partial<PhotoDeps> = {}) {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const settings = new SettingsStore(dir);
  settings.update({ photos: { mode: 'new', ...engine } });
  const reg = new ToolRegistry([]);
  const d: PhotoDeps = {
    webDir: join(ROOT, 'web'),
    uploads: new UploadStore(dir),
    settings,
    vault: new Vault(dir),
    xaiProviderKey: () => undefined,
    customPortrait: () => undefined,
    persona: () => ({ name: 'Mia', pronouns: 'she', appearance: 'short red hair, green eyes, freckles' }),
    wearing: () => ({ wear: 'a yellow raincoat', style: 'anime' }),
    engines: { tools: { get: (n) => reg.get(n), permission: (n) => reg.permission(n, settings.get().toolPermissions) }, sleep: async () => {}, random: () => 0.5 },
    ...extra,
  };
  const take = createPhotoTools(d).find((x) => x.spec.name === 'take_photo')!;
  const attached: string[] = [];
  const ctx = { workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: '' }, attachImage: (id: string) => attached.push(id) } as ToolContext;
  return { d, reg, take, attached, ctx, settings };
}

test('E7 B1: a pasted API workflow is checked and its prompt nodes listed', () => {
  assert.deepEqual(promptNodes(WF).map((n) => n.id), ['6', '7']);
  assert.match(promptNodes(WF)[0].label, /6 · Positive · text/);
  assert.throws(() => cleanWorkflow({ nodes: [], links: [] }), /Export \(API\)/);
  assert.throws(() => cleanWorkflow('[]'), /API format/);
  assert.equal(cleanWorkflow(JSON.stringify(WF))['6'].class_type, 'CLIPTextEncode');
  const filled = fillWorkflow({ server: 'comfyui', workflow: WF, node: '6', seed: true }, 'hello', () => 0.25);
  assert.equal(filled['6'].inputs!.text, 'hello');
  assert.equal(filled['7'].inputs!.text, 'blurry', 'the negative prompt stays');
  assert.equal(filled['3'].inputs!.seed, Math.floor(0.25 * 2 ** 48));
  assert.equal(WF['6'].inputs!.text, 'a cat', 'the saved workflow is not changed');
  assert.throws(() => fillWorkflow({ server: 'comfyui', workflow: WF, node: '4' }, 'x'), /no text input/);
});

test('E7 B1: take_photo with ComfyUI puts her look and the scene into the chosen node and attaches the picture', async (t) => {
  const s = setup(t, { engine: 'comfyui', comfy: { server: 'comfyui', workflow: WF, node: '6', seed: true } });
  const seen = fakeComfy(s.reg, { image: true });
  assert.equal(s.take.isAvailable?.(), true);
  assert.match(s.take.summarize({ scene: 'x' }), /\(ComfyUI\)/);
  const out = await s.take.run({ scene: 'selfie at a rainy bus stop' }, s.ctx);
  assert.match(out, /Took a new photo/);
  assert.equal(s.attached.length, 1);
  assert.equal(s.d.uploads.get(s.attached[0])?.mime, 'image/png');
  const wf = seen.find((x) => x.tool === 'enqueue_workflow')!.args.workflow as ComfyWorkflow;
  const text = String(wf['6'].inputs!.text);
  assert.match(text, /Mia/);
  assert.match(text, /short red hair, green eyes, freckles/);
  assert.match(text, /selfie at a rainy bus stop/);
  assert.match(text, /yellow raincoat/);
  assert.match(text, /She is an adult/);
  assert.doesNotMatch(text, /photo/i, 'an anime look is not turned into a photo');
  assert.equal(wf['3'].inputs!.seed, Math.floor(0.5 * 2 ** 48));
  assert.deepEqual(seen.find((x) => x.tool === 'get_image')!.args, { action: 'get', filename: 'e7/sara_0001.png' });
  assert.equal(seen.filter((x) => x.tool === 'get_history').length, 2, 'polled until the output was there');
});

test('E7 B1: no picture back (a Sara without MCP image blocks) → a plain error and nothing attached', async (t) => {
  const s = setup(t, { engine: 'comfyui', comfy: { server: 'comfyui', workflow: WF, node: '6' } });
  fakeComfy(s.reg, { image: false });
  await assert.rejects(s.take.run({ scene: 'reading on the couch' }, s.ctx), /can't receive pictures from tool servers yet, so nothing was sent/);
  assert.equal(s.attached.length, 0);
});

test('E7 B1: tool engines respect Off, and on her own need Always allowed; the minors block runs first', async (t) => {
  const s = setup(t, { engine: 'comfyui', comfy: { server: 'comfyui', workflow: WF, node: '6' } });
  const seen = fakeComfy(s.reg, { image: true });
  await assert.rejects(s.take.run({ scene: 'with two kids at the beach' }, s.ctx), /never involve children/);
  assert.equal(seen.length, 0, 'nothing reached ComfyUI');
  await assert.rejects(s.take.run({ scene: 'at the park' }, { ...s.ctx, unattended: true } as ToolContext), /must be Always allowed/);
  s.settings.update({ toolPermissions: { mcp_comfyui_enqueue_workflow: 'never' } });
  await assert.rejects(s.take.run({ scene: 'at the park' }, s.ctx), /set to Off/);
});

test('E7 B1: OpenAI images and any image tool get the same look prompt', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  };
  const s = setup(t, { engine: 'openai' }, { fetch });
  assert.equal(s.take.isAvailable?.(), false, 'no OpenAI key: not offered');
  s.d.engines!.openaiKey = () => 'sk-test';
  assert.equal(s.take.isAvailable?.(), true);
  await s.take.run({ scene: 'cooking pasta' }, s.ctx);
  assert.equal(bodies[0].model, 'gpt-image-1');
  assert.match(String(bodies[0].prompt), /Mia.*short red hair.*cooking pasta.*She is an adult/s);
  assert.equal(s.attached.length, 1);

  const u = setup(t, { engine: 'tool', tool: { name: 'mcp_art_draw', arg: 'description' } });
  let got: Record<string, unknown> = {};
  u.reg.add({ defaultPermission: 'ask', source: 'MCP: art', spec: { name: 'mcp_art_draw', description: '', parameters: { type: 'object' } }, summarize: () => '', run: async (a, ctx) => {
    got = a;
    const c = ctx as ToolContext & { saveImage?: (b: Buffer) => string };
    c.attachImage?.(c.saveImage!(PNG));
    return 'ok';
  } });
  await u.take.run({ scene: 'on a hike' }, u.ctx);
  assert.match(String(got.description), /on a hike/);
  assert.equal(u.attached.length, 1);
});
