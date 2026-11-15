// Pictures from her with ComfyUI: comfyui-mcp's get_history answers in markdown (not JSON), so the
// picture was finished in ComfyUI while Sara kept waiting. Both shapes are read; terminal states stop
// the wait at once with a plain reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comfyPhoto, comfyReason, readComfyHistory, type ComfyWorkflow } from '../src/image-engines.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';

const MD_OK = [
  '## Execution: 4f1c2a9e-1111-2222-3333-444455556666',
  '**Status**: success | Completed: true',
  '**Duration**: 29.81s',
  '',
  '### Outputs (2 nodes)',
  '- Node 12: text → hello',
  '- Node 10: images → **sara-test/pic_00001_.png (type=output), sara-test/pic_00002_.png (type=output)**',
].join('\n');
const MD_TEMP = ['## Execution: abc123', '**Status**: success | Completed: true', '', '### Outputs (1 nodes)', '- Node 5: images → **ComfyUI_temp_x_00001_.png (type=temp)**'].join('\n');
const MD_ERR = [
  '## Execution: abc123',
  '**Status**: error | Completed: false',
  '',
  '### Error Details',
  '**Failed node**: 4 (CheckpointLoaderSimple)',
  '**Exception**: Value not in list: ckpt_name: missing.safetensors',
  '**Type**: ValueError',
  '',
  '**Traceback**:',
  '```',
  'Traceback (most recent call last): ...',
  '```',
].join('\n');
const MD_STOP = ['## Execution: abc123', '**Status**: error | Completed: false', '', '**Execution was interrupted/cancelled**'].join('\n');
const MD_EMPTY = ['## Execution: abc123', '**Status**: success | Completed: true', '**Duration**: 1.2s'].join('\n');

test('ownpics: the markdown history of comfyui-mcp is read (file, subfolder, type)', () => {
  assert.deepEqual(readComfyHistory('No history found for prompt abc123.'), { state: 'pending' });
  assert.deepEqual(readComfyHistory(MD_OK), { state: 'done', file: 'sara-test/pic_00001_.png', type: 'output' });
  assert.deepEqual(readComfyHistory(MD_TEMP), { state: 'done', file: 'ComfyUI_temp_x_00001_.png', type: 'temp' });
  const why = (t: string) => { const r = readComfyHistory(t); return r.state === 'error' ? r.reason : `not an error: ${r.state}`; };
  const err = { reason: why(MD_ERR) };
  assert.equal(readComfyHistory(MD_ERR).state, 'error');
  assert.match(err.reason!, /Value not in list: ckpt_name: missing\.safetensors/);
  assert.match(err.reason!, /CheckpointLoaderSimple/);
  assert.match(why(MD_STOP), /stopped in ComfyUI/);
  assert.match(why(MD_EMPTY), /saved no picture: check it ends in Save Image/);
  // The old JSON shape still works.
  assert.deepEqual(readComfyHistory(JSON.stringify({ outputs: { '9': { images: [{ filename: 'a.png', subfolder: 'e7', type: 'output' }] } } })), { state: 'done', file: 'e7/a.png', type: 'output' });
  assert.deepEqual(readComfyHistory(JSON.stringify({ status: 'running' })), { state: 'pending' });
  assert.equal(readComfyHistory(JSON.stringify({ status: { status_str: 'error' }, execution_error: { exception_message: 'boom' } })).state, 'error');
});

const WF: ComfyWorkflow = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'sara-test/pic' } },
};
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function engine(history: string[]) {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const tools = new Map<string, Tool>();
  const add = (name: string, run: (a: Record<string, unknown>, ctx: ToolContext) => string) =>
    tools.set(`mcp_comfyui_${name}`, { defaultPermission: 'auto', source: 'MCP: comfyui', spec: { name: `mcp_comfyui_${name}`, description: '', parameters: { type: 'object' } }, summarize: () => name, run: async (a, ctx) => (seen.push({ tool: name, args: a }), run(a, ctx)) });
  add('enqueue_workflow', () => 'Workflow queued. prompt_id: 4f1c2a9e-1111-2222-3333-444455556666');
  let i = 0;
  add('get_history', () => history[Math.min(i++, history.length - 1)]);
  add('get_image', (_a, ctx) => ((ctx as ToolContext & { saveImage: (b: Buffer) => string }).saveImage(PNG), 'ok'));
  const sleeps: number[] = [];
  const d = { tools: { get: (n: string) => tools.get(n), permission: () => 'auto' as const }, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };
  return { d, seen, sleeps };
}

test('ownpics: comfyPhoto gets the picture from a markdown history and passes its type', async () => {
  const e = engine(['No history found for prompt 4f1c2a9e-1111-2222-3333-444455556666.', MD_OK]);
  const got = await comfyPhoto(e.d, { server: 'comfyui', workflow: WF, node: '6' }, 'a cozy nook', {});
  assert.equal(got.length, PNG.length);
  assert.deepEqual(e.seen.find((s) => s.tool === 'get_image')!.args, { action: 'get', filename: 'sara-test/pic_00001_.png', type: 'output' });
  assert.equal(e.seen.filter((s) => s.tool === 'get_history').length, 2);
});

test('ownpics: a failed or empty run stops at once with the reason (no 5-minute wait)', async () => {
  const bad = engine([MD_ERR]);
  await assert.rejects(comfyPhoto(bad.d, { server: 'comfyui', workflow: WF, node: '6' }, 'x', {}), /ComfyUI couldn't finish the picture: .*Value not in list/);
  assert.equal(bad.seen.filter((s) => s.tool === 'get_history').length, 1);
  assert.equal(bad.seen.some((s) => s.tool === 'get_image'), false);
  const empty = engine([MD_EMPTY]);
  await assert.rejects(comfyPhoto(empty.d, { server: 'comfyui', workflow: WF, node: '6' }, 'x', {}), /saved no picture/);
  const stop = engine([MD_STOP]);
  await assert.rejects(comfyPhoto(stop.d, { server: 'comfyui', workflow: WF, node: '6' }, 'x', {}), /stopped in ComfyUI/);
});

test('ownpics: a workflow ComfyUI refuses gives its plain reason, not the raw JSON', async () => {
  const refused = JSON.stringify({ error: 'WORKFLOW_EXECUTION_ERROR', message: "ComfyUI rejected the workflow (400): Prompt outputs failed validation\n- CheckpointLoaderSimple (node 4): Value not in list (ckpt_name: 'x.safetensors' not in (list of length 61))", details: { status: 400 } });
  assert.equal(comfyReason(refused), "ComfyUI rejected the workflow (400): Prompt outputs failed validation · CheckpointLoaderSimple (node 4): Value not in list (ckpt_name: 'x.safetensors' not in (list of length 61))");
  assert.equal(comfyReason('plain words'), 'plain words');
  const e = engine([MD_OK]);
  e.d.tools.get('mcp_comfyui_enqueue_workflow')!.run = async () => {
    throw new Error(refused);
  };
  await assert.rejects(comfyPhoto(e.d, { server: 'comfyui', workflow: WF, node: '6' }, 'x', {}), (err: Error) => /^ComfyUI didn't take the workflow: ComfyUI rejected the workflow \(400\).*Value not in list/.test(err.message) && !err.message.includes('{'));
});
