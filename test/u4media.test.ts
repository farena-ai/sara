// U4.28 (docs/PICTURES.md "Editing pictures and short video"): picture editing and short video
// through the local ComfyUI (comfyui-mcp tools): inpaint with a drawn mask, extend, upscale, remove
// the background, restyle with a strength; text-to-video and image-to-video only with the video
// models that are installed; progress + cancel; results and versions in the Library; the same
// picture rules as today (kid mode refuses, explicit only in adult mode and never from a real photo,
// never minors); private local mode keeps ComfyUI on this computer. Recorded comfyui-mcp answers;
// no network, no ComfyUI.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readComfyHistory } from '../src/image-engines.ts';
import { familyOf } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { editWorkflow, mediaAskProblem, mediaCaps, MediaStudio, readModelList, regionMask, videoWorkflow, type MediaCaps } from '../src/media-studio.ts';
import { createMediaTools } from '../src/tools/media.ts';
import { measure } from '../src/documents/images.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// comfyui-mcp@0.52.206 list_local_models (shape recorded from its source; names made up here).
const MODELS = [
  '## checkpoints (3)',
  '- sd_xl_base_1.0.safetensors (6617.6 MB) — modified 2026-01-01',
  '- ltx-video-2b-v0.9.5.safetensors',
  '- dreamy_v2.safetensors',
  '',
  '## diffusion_models (3)',
  '- wan2.1_t2v_1.3B_fp16.safetensors',
  '- wan2.1_i2v_480p_14B_fp8.safetensors',
  '- hunyuan_video_t2v_720p_bf16.safetensors',
  '',
  '## text_encoders (2)',
  '- umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  '- t5xxl_fp16.safetensors',
  '',
  '## vae (1)',
  '- wan_2.1_vae.safetensors',
  '',
  '## clip_vision (1)',
  '- clip_vision_h.safetensors',
  '',
  '## upscale_models (1)',
  '- 4x-UltraSharp.pth',
  '    base: other',
].join('\n');
const BARE = ['## checkpoints (1)', '- sd_xl_base_1.0.safetensors', ''].join('\n');

function png(w: number, h: number): Buffer {
  // A real (tiny) PNG from the mask encoder: measure() reads its size.
  return regionMask(w, h, 'whole');
}

const md = (file: string) => ['## Execution: x', '**Status**: success | Completed: true', '', '### Outputs (1 nodes)', `- Node 9: images → **${file} (type=output)**`].join('\n');

interface Fake {
  calls: { tool: string; args: Record<string, unknown> }[];
  workflows: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>[];
  history: string[];
  queue: string[];
  models: string;
  result: Buffer;
  enqueueError?: string;
  bgError?: string;
}

function fakeTools(f: Fake, save: string): Map<string, Tool> {
  const m = new Map<string, Tool>();
  const add = (name: string, run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string) =>
    m.set(`mcp_comfyui_${name}`, { spec: { name: `mcp_comfyui_${name}`, description: name, parameters: { type: 'object', properties: {} } }, permission: 'ask', run: async (args: Record<string, unknown>, ctx: ToolContext) => { f.calls.push({ tool: name, args }); return run(args, ctx); } } as unknown as Tool);
  add('list_local_models', () => f.models);
  add('upload_image', (a) => `Uploaded "${String(a.filename)}" to ComfyUI input/.`);
  add('enqueue_workflow', (a) => {
    if (f.enqueueError) throw new Error(f.enqueueError);
    f.workflows.push(a.workflow as never);
    return JSON.stringify({ prompt_id: 'pid-000001', number: 1 });
  });
  add('generate_image', () => {
    if (f.bgError) throw new Error(f.bgError);
    return JSON.stringify({ status: 'enqueued', prompt_id: 'pid-000002' });
  });
  add('queue', (a) => (a.action === 'status' ? f.queue.shift() ?? JSON.stringify({ running: false, pending: false, done: true }) : 'Cancelled.'));
  add('get_history', () => f.history.shift() ?? 'No history found.');
  add('get_image', (a, ctx) => {
    const name = String(a.filename);
    if (/\.webp$/.test(name)) {
      mkdirSync(String(a.save_dir), { recursive: true });
      const p = join(String(a.save_dir), 'clip.webp');
      writeFileSync(p, f.result);
      return `Saved to: ${p} (image/webp; not rendered inline)`;
    }
    ctx.attachImage?.(ctx.saveImage!(f.result));
    return `Saved to: ${save}`;
  });
  return m;
}

function rig(t: TestContext, o: { models?: string; child?: boolean; adult?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', mcpServers: [{ name: 'comfyui', transport: 'stdio', command: 'npx', args: ['-y', 'comfyui-mcp@0.52.206'], env: { COMFYUI_URL: 'http://127.0.0.1:8188' }, enabled: true }], ...(o.adult ? { adultMode: { on: true, confirmedAt: '2026-11-01T00:00:00Z' } } : {}) } as never);
  const lib = new LibraryStore(app.store.db, dir, () => clock.now);
  (app as { library?: unknown }).library = lib;
  if (o.child) (app as { member?: unknown }).member = { child: () => ({ band: '10-12', name: 'Kim' }) };
  const f: Fake = { calls: [], workflows: [], history: [], queue: [], models: o.models ?? MODELS, result: png(64, 48) };
  const tools = fakeTools(f, join(dir, 'x.png'));
  const studio = new MediaStudio(app, app.store.db, { tools: { get: (n) => tools.get(n), permission: () => 'ask' }, sleep: async () => {}, random: () => 0.5 });
  const src = lib.add({ name: 'beach.png', bytes: png(64, 48), keep: true, learn: false });
  lib.setRead(src.id, { kind: 'image', title: 'Beach', parts: [{ text: 'a beach', where: 'picture' }], warnings: [] });
  t.after(() => {
    setPrivateLocal(false);
    app.store.close();
    cleanup();
  });
  return { app, lib, f, studio, src, dir };
}

const wait = async (s: MediaStudio, id: string) => {
  for (let i = 0; i < 200; i++) {
    const j = s.job(id)!;
    if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job never ended');
};

test('u4media: the model list is read and only installed recipes are offered, with plain fallbacks', () => {
  const m = readModelList(MODELS);
  assert.deepEqual(m.upscale_models, ['4x-UltraSharp.pth']);
  assert.equal(m.checkpoints.length, 3);
  const c = mediaCaps(m, {}, 'comfyui');
  assert.equal(c.connected, true);
  // Video checkpoints are never offered as the picture model.
  assert.deepEqual(c.checkpoints, ['sd_xl_base_1.0.safetensors', 'dreamy_v2.safetensors']);
  assert.equal(c.checkpoint, 'sd_xl_base_1.0.safetensors');
  assert.equal(c.upscaler, '4x-UltraSharp.pth');
  for (const op of ['inpaint', 'outpaint', 'upscale', 'background', 'restyle'] as const) assert.equal(c.edits[op].ok, true, op);
  assert.equal(c.video.t2v?.family, 'wan');
  assert.equal(c.video.t2v?.model, 'wan2.1_t2v_1.3B_fp16.safetensors');
  assert.equal(c.video.i2v?.family, 'wan');
  assert.equal(c.video.i2v?.clipVision, 'clip_vision_h.safetensors');
  assert.ok(c.video.found.includes('Hunyuan Video'));
  // Nothing for video, no upscaler: offered as a plain resize, video explained.
  const b = mediaCaps(readModelList(BARE), {}, 'comfyui');
  assert.equal(b.edits.upscale.ok, true);
  assert.match(b.edits.upscale.note ?? '', /plain resize/);
  assert.equal(b.video.t2v, undefined);
  assert.match(b.video.note ?? '', /No video model/);
  // No checkpoint: the picture edits that draw are off and say why; upscale still works.
  const none = mediaCaps(readModelList('## upscale_models (1)\n- 2x.pth\n'), {}, 'comfyui');
  assert.equal(none.edits.inpaint.ok, false);
  assert.match(none.edits.inpaint.note ?? '', /picture model/);
  assert.equal(none.edits.upscale.ok, true);
  // LTX-Video 0.9 checkpoint + T5 is a recipe too when Wan is missing.
  const ltx = mediaCaps(readModelList('## checkpoints (1)\n- ltx-video-2b-v0.9.5.safetensors\n## text_encoders (1)\n- t5xxl_fp16.safetensors\n'), {}, 'comfyui');
  assert.equal(ltx.video.t2v?.family, 'ltxv');
  assert.equal(ltx.video.i2v?.family, 'ltxv');
  // A saved video workflow chosen in Settings wins.
  const own = mediaCaps(m, { videoWorkflow: 'video/my clip.json' }, 'comfyui');
  assert.equal(own.video.t2v?.family, 'own');
});

test('u4media: edit workflows keep the untouched pixels and use the strength; videos have the right length', () => {
  const base = { checkpoint: 'sd.safetensors', image: 'in.png', prompt: 'a calm beach', seed: 7, prefix: 'sara-media/edit', width: 64, height: 48 };
  const inpaint = editWorkflow('inpaint', { ...base, mask: 'mask.png' });
  const types = Object.values(inpaint).map((n) => n.class_type);
  for (const k of ['CheckpointLoaderSimple', 'LoadImage', 'ImageToMask', 'VAEEncodeForInpaint', 'KSampler', 'ImageCompositeMasked', 'SaveImage']) assert.ok(types.includes(k), k);
  const restyle = editWorkflow('restyle', { ...base, strength: 0.35 });
  const ks = Object.values(restyle).find((n) => n.class_type === 'KSampler')!;
  assert.equal(ks.inputs!.denoise, 0.35);
  const out = editWorkflow('outpaint', { ...base, pad: { left: 0, top: 0, right: 128, bottom: 0 } });
  const pad = Object.values(out).find((n) => n.class_type === 'ImagePadForOutpaint')!;
  assert.equal(pad.inputs!.right, 128);
  const up = editWorkflow('upscale', { ...base, upscaler: '4x.pth', target: { width: 3840, height: 2880 } });
  assert.ok(Object.values(up).some((n) => n.class_type === 'ImageUpscaleWithModel'));
  const scale = Object.values(up).find((n) => n.class_type === 'ImageScale')!;
  assert.deepEqual([scale.inputs!.width, scale.inputs!.height], [3840, 2880]);
  const plain = editWorkflow('upscale', { ...base, target: { width: 128, height: 96 } });
  assert.ok(!Object.values(plain).some((n) => n.class_type === 'ImageUpscaleWithModel'));
  const c = mediaCaps(readModelList(MODELS), {}, 'comfyui');
  const t2v = videoWorkflow(c.video.t2v!, { prompt: 'waves rolling in', seconds: 3, seed: 1, prefix: 'sara-media/clip' });
  const lat = Object.values(t2v).find((n) => n.class_type === 'EmptyHunyuanLatentVideo')!;
  assert.equal(lat.inputs!.length, 49); // 16 fps × 3 s + 1
  assert.ok(Object.values(t2v).some((n) => n.class_type === 'SaveAnimatedWEBP'));
  const i2v = videoWorkflow(c.video.i2v!, { prompt: 'waves', seconds: 2, seed: 1, prefix: 'p', image: 'start.png', width: 48, height: 64 });
  const w = Object.values(i2v).find((n) => n.class_type === 'WanImageToVideo')!;
  assert.equal(w.inputs!.length, 33);
  assert.ok(Number(w.inputs!.height) > Number(w.inputs!.width), 'a tall start picture makes a tall clip');
});

test('u4media: a region mask is a real PNG the size of the picture', () => {
  const m = regionMask(200, 100, 'left');
  const p = measure(m)!;
  assert.deepEqual([p.width, p.height], [200, 100]);
});

test('u4media: the picture rules (kid, minors, adult mode, real photos)', (t) => {
  const { app } = rig(t);
  assert.equal(mediaAskProblem(app, 'make it 4k', { fromPicture: true }), undefined);
  assert.match(mediaAskProblem(app, 'a nude woman on the beach', { fromPicture: false }) ?? '', /Adult mode is off/);
  assert.match(mediaAskProblem(app, 'sexy schoolgirl, 14 years old, naked', { fromPicture: false }) ?? '', /minors/);
  app.settings.update({ adultMode: { on: true, confirmedAt: '2026-11-01T00:00:00Z' } } as never);
  assert.equal(mediaAskProblem(app, 'a nude woman on the beach', { fromPicture: false }), undefined);
  // Never sexual edits of a real photo, adult mode or not.
  assert.match(mediaAskProblem(app, 'make her naked', { fromPicture: true }) ?? '', /real photo/);
  const kid = rig(t, { child: true });
  assert.match(mediaAskProblem(kid.app, 'make it 4k', { fromPicture: true }) ?? '', /kid/i);
});

test('u4media: inpaint with a drawn mask runs in ComfyUI, lands in the Library as a new version', async (t) => {
  const { studio, f, lib, src } = rig(t);
  f.queue.push(JSON.stringify({ running: false, pending: true }), JSON.stringify({ running: true, pending: false }));
  f.history.push(md('sara-media/edit_00001_.png'));
  const job = await studio.startEdit({ libraryId: src.id, op: 'inpaint', prompt: 'remove the person, empty sand', mask: regionMask(64, 48, 'left') });
  const done = await wait(studio, job.id);
  assert.equal(done.status, 'done', done.error);
  const ups = f.calls.filter((c) => c.tool === 'upload_image');
  assert.equal(ups.length, 2, 'the picture and its mask');
  assert.ok(ups.every((c) => c.args.action === 'image' && typeof c.args.source_path === 'string'));
  // The temp files are gone after the upload.
  assert.ok(ups.every((c) => !existsSync(String(c.args.source_path))));
  const wf = f.workflows[0];
  const loads = Object.values(wf).filter((n) => n.class_type === 'LoadImage').map((n) => n.inputs!.image);
  assert.deepEqual(loads.sort(), ups.map((c) => c.args.filename).sort());
  const out = lib.get(done.libraryId!)!;
  assert.equal(out.kind, 'image');
  assert.equal(out.status, 'ready');
  const v = studio.versions(src.id);
  assert.deepEqual(v.map((x) => x.libraryId), [src.id, done.libraryId]);
  assert.equal(v[1].op, 'inpaint');
  // Editing the edit adds version 3 to the same family.
  f.history.push(md('sara-media/edit_00002_.png'));
  const j2 = await wait(studio, (await studio.startEdit({ libraryId: done.libraryId!, op: 'upscale', scale: '2x' })).id);
  assert.equal(j2.status, 'done', j2.error);
  assert.deepEqual(studio.versions(done.libraryId!).map((x) => x.version), [1, 2, 3]);
});

test('u4media: background removal uses comfyui-mcp and explains a missing node', async (t) => {
  const { studio, f, src } = rig(t);
  f.bgError = JSON.stringify({ message: 'The background-removal node "BiRefNetRMBG" (ComfyUI-RMBG) is not installed.' });
  const j = await wait(studio, (await studio.startEdit({ libraryId: src.id, op: 'background' })).id);
  assert.equal(j.status, 'failed');
  assert.match(j.error ?? '', /ComfyUI-RMBG/);
  assert.match(j.error ?? '', /ComfyUI Manager/);
});

test('u4media: a refused workflow and a missing ComfyUI give plain reasons', async (t) => {
  const { studio, f, src } = rig(t);
  f.enqueueError = JSON.stringify({ message: 'Value not in list: ckpt_name' });
  const j = await wait(studio, (await studio.startEdit({ libraryId: src.id, op: 'restyle', prompt: 'watercolor', strength: 0.5 })).id);
  assert.equal(j.status, 'failed');
  assert.match(j.error ?? '', /didn't take the workflow: Value not in list/);
  const { app } = rig(t);
  const off = new MediaStudio(app, app.store.db, { tools: { get: () => undefined, permission: () => 'ask' }, sleep: async () => {} });
  const c: MediaCaps = await off.caps(true);
  assert.equal(c.connected, false);
  assert.match(c.why ?? '', /ComfyUI isn't connected/);
  await assert.rejects(off.startVideo({ prompt: 'waves' }), /ComfyUI isn't connected/);
});

test('u4media: text-to-video with progress, the clip saved to the Library; cancel stops it in ComfyUI', async (t) => {
  const { studio, f, lib } = rig(t);
  f.result = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(32)]);
  f.history.push('No history found.', md('sara-media/clip_00001_.webp'));
  const j = await wait(studio, (await studio.startVideo({ prompt: 'waves rolling onto a beach at sunset' })).id);
  assert.equal(j.status, 'done', j.error);
  const doc = lib.get(j.libraryId!)!;
  assert.equal(doc.kind, 'video');
  assert.match(doc.name, /\.webp$/);
  const wf = f.workflows[0];
  assert.ok(Object.values(wf).some((n) => n.class_type === 'UNETLoader' && n.inputs!.unet_name === 'wan2.1_t2v_1.3B_fp16.safetensors'));
  // Cancel: a never-ending run is stopped in ComfyUI too.
  const never = rig(t);
  never.f.queue.push(...Array.from({ length: 500 }, () => JSON.stringify({ running: true, pending: false })));
  let ticks = 0;
  const slow = new MediaStudio(never.app, never.app.store.db, { tools: { get: (n) => fakeTools(never.f, '').get(n), permission: () => 'ask' }, sleep: () => new Promise((r) => setTimeout(r, 2 + 0 * ++ticks)) });
  const run = await slow.startVideo({ prompt: 'clouds drifting' });
  for (let i = 0; i < 50 && slow.job(run.id)!.phase !== 'working'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(slow.job(run.id)!.phase, 'working');
  slow.cancel(run.id);
  const c = await wait(slow, run.id);
  assert.equal(c.status, 'cancelled');
  assert.ok(never.f.calls.some((x) => x.tool === 'queue' && (x.args.action === 'cancel' || x.args.action === 'cancel_queued')));
});

test('u4media: refusals happen before anything is sent to ComfyUI', async (t) => {
  const { studio, f, src } = rig(t);
  await assert.rejects(studio.startVideo({ prompt: 'a naked woman dancing' }), /Adult mode is off/);
  await assert.rejects(studio.startEdit({ libraryId: src.id, op: 'inpaint', prompt: 'make her nude', mask: regionMask(64, 48, 'whole') }), /real photo/);
  await assert.rejects(studio.startEdit({ libraryId: 99999, op: 'upscale' }), /no picture/i);
  assert.equal(f.calls.filter((c) => c.tool !== 'list_local_models').length, 0);
  // Private local mode: a ComfyUI on another computer is refused.
  const r = rig(t);
  r.app.settings.update({ mcpServers: [{ name: 'comfyui', transport: 'stdio', command: 'npx', args: [], env: { COMFYUI_URL: 'https://gpu.example.net' }, enabled: true }] } as never);
  setPrivateLocal(true);
  const c = await r.studio.caps(true);
  assert.equal(c.connected, false);
  assert.match(c.why ?? '', /Nothing leaves this computer/);
});

test('u4media: chat tools — "remove the person on the left" and "make it 4k"; kids never get them', async (t) => {
  const { app, f, studio, src } = rig(t);
  (app as { media?: unknown }).media = studio;
  const tools = createMediaTools(() => app as never);
  const edit = tools.find((x) => x.spec.name === 'picture_edit')!;
  const video = tools.find((x) => x.spec.name === 'video_make')!;
  assert.ok(edit && video);
  f.history.push(md('sara-media/edit_00001_.png'));
  const attached: string[] = [];
  const ctx = { signal: new AbortController().signal, conversationId: 'c1', saveImage: () => 'up1', attachImage: (id: string) => attached.push(id) } as unknown as ToolContext;
  const out = await edit.run({ picture: src.id, what: 'remove', instruction: 'the person on the left', region: 'left' }, ctx);
  assert.match(out, /Library/);
  assert.deepEqual(attached, ['up1']);
  const wf = f.workflows[0];
  assert.ok(Object.values(wf).some((n) => n.class_type === 'VAEEncodeForInpaint'));
  // "make it 4k": the long side becomes 3840.
  f.history.push(md('sara-media/edit_00002_.png'));
  await edit.run({ picture: src.id, what: 'upscale', size: '4k' }, ctx);
  const sc = Object.values(f.workflows[1]).find((n) => n.class_type === 'ImageScale')!;
  assert.equal(sc.inputs!.width, 3840);
  assert.equal(sc.inputs!.height, 2880);
  // Lean finds the tools from everyday words.
  assert.equal(familyOf(edit)?.id, 'media');
  assert.equal(familyOf(video)?.id, 'media');
  const kid = rig(t, { child: true });
  (kid.app as { media?: unknown }).media = kid.studio;
  for (const x of createMediaTools(() => kid.app as never)) assert.equal(x.isAvailable?.() ?? true, false, x.spec.name);
});

test('u4media: wiring — owner-only routes, kid allowlist untouched, strings and doc', () => {
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.ok(!/picture_edit|video_make/.test(src('src/family.ts')), 'not in KID_TOOLS');
  assert.ok(!/'media'/.test(src('src/household.ts').split('MEMBER_ROUTES')[1].split(']);')[0]), 'members get 403 (owner only)');
  assert.match(src('src/server.ts'), /createMediaRoutes/);
  assert.match(src('src/main.ts'), /createMediaTools/);
  assert.match(src('web/index.html'), /id="mx-editor"/);
  assert.match(src('web/index.html'), /id="lib-media"/);
  assert.match(src('docs/PICTURES.md'), /Editing pictures and short video/);
  // The history reader also finds clips (own workflows ending in a video file).
  assert.deepEqual(readComfyHistory(md('v/clip_00001.mp4'), /\.(?:png|jpe?g|webp|gif|mp4|webm)$/i), { state: 'done', file: 'v/clip_00001.mp4', type: 'output' });
});
