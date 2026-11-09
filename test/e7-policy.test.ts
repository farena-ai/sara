// E7 (A1, A2): "Always allow" for a tool server and on an approval card, never past destructive tools.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { createSaraServer } from '../src/server.ts';
import { applyServerPolicy, coverage, policyResolver, toolKind, type ServerPolicy } from '../src/tool-policy.ts';
import { mcpToolName } from '../src/tools/mcp.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

// comfyui-mcp@0.52.206 tools/list (41 tools; the three with annotations keep them).
const D = { destructiveHint: true };
const COMFY: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }[] = [
  'comfy_cli', 'enqueue_workflow', 'get_system_stats', 'visualize_workflow', 'create_workflow', 'queue', 'search_custom_nodes', 'download_model', 'list_local_models', 'get_history', 'runpod',
  'runpod_watch', 'get_workflow', 'save_workflow', 'restart_comfyui', 'get_image', 'upload_image', 'clear_vram', 'get_defaults', 'generate_image', 'node_snapshot', 'bisect', 'install_custom_node',
  'report_issue', 'install_comfyui', 'model_metadata', 'workspace', 'list_api_nodes', 'node_pack', 'apply_manifest', 'list_packs', 'calculate', 'train_prepare_dataset', 'train_start', 'train_doctor',
  'apps', 'batch', 'kitchen', 'list_tools', 'describe_tool', 'call_tool',
].map((name) => (['download_model', 'runpod', 'install_comfyui'].includes(name) ? { name, annotations: D } : { name }));
const DESTRUCTIVE = ['comfy_cli', 'download_model', 'runpod', 'runpod_watch', 'restart_comfyui', 'node_snapshot', 'bisect', 'install_custom_node', 'report_issue', 'install_comfyui', 'node_pack', 'apply_manifest', 'train_prepare_dataset', 'train_start', 'train_doctor', 'call_tool'];
const keyed = COMFY.map((t) => ({ ...t, key: mcpToolName('comfyui', t.name) }));

test('E7 A2: the safe set never holds a destructive tool, and covers the ComfyUI generation tools', () => {
  assert.equal(COMFY.length, 41);
  const c = coverage('comfyui', COMFY);
  assert.deepEqual(c.destructive.sort(), [...DESTRUCTIVE].sort());
  for (const name of DESTRUCTIVE) assert.ok(!c.safe.includes(name), name);
  for (const name of ['get_system_stats', 'get_history', 'get_image', 'get_workflow', 'list_local_models', 'list_packs', 'visualize_workflow', 'enqueue_workflow', 'generate_image', 'queue', 'batch', 'apps']) assert.ok(c.safe.includes(name), name);
  // A destructive hint wins over any name; a read-only hint makes an unknown tool safe.
  assert.equal(toolKind('x', 'get_thing', { destructiveHint: true }), 'destructive');
  assert.equal(toolKind('x', 'summarize', { readOnlyHint: true }), 'safe');
  assert.equal(toolKind('x', 'enqueue_workflow'), 'other', 'output-only lists are per known server');
  assert.equal(toolKind('x', 'delete_file', { readOnlyHint: true }), 'destructive');
});

test('E7 A2: Everything still asks for destructive tools; Never and Ask; an own setting on a destructive tool stays', () => {
  const perm = (policy: ServerPolicy, start: Record<string, 'auto' | 'ask' | 'never'> = {}) => applyServerPolicy(start, policy, 'comfyui', keyed);
  const all = perm('all');
  for (const t of keyed) assert.equal(all[t.key], DESTRUCTIVE.includes(t.name) ? 'ask' : 'auto', t.name);
  const safe = perm('safe');
  assert.equal(safe[mcpToolName('comfyui', 'enqueue_workflow')], 'auto');
  assert.equal(safe[mcpToolName('comfyui', 'upload_image')], 'ask');
  assert.equal(safe[mcpToolName('comfyui', 'install_custom_node')], 'ask');
  // The owner set one destructive tool himself: the safe/everything choices keep it; Ask resets it.
  const own = { [mcpToolName('comfyui', 'restart_comfyui')]: 'auto' as const, [mcpToolName('comfyui', 'runpod')]: 'never' as const };
  assert.equal(perm('all', own)[mcpToolName('comfyui', 'restart_comfyui')], 'auto');
  assert.equal(perm('safe', own)[mcpToolName('comfyui', 'runpod')], 'never');
  assert.equal(perm('ask', own)[mcpToolName('comfyui', 'restart_comfyui')], 'ask');
  for (const v of Object.values(perm('never'))) assert.equal(v, 'never');
  for (const t of keyed) assert.equal(perm('ask')[t.key], 'ask', 'no read-only hints here, so Ask asks for everything');
});

test('E7 A2: a tool that appears later follows the remembered choice; its own setting wins', () => {
  let tools = COMFY.slice(0, 2);
  const mcp = { get: (n: string) => (n === 'comfyui' ? { tools } : undefined) };
  const settings = { mcpPolicy: { comfyui: 'safe' as ServerPolicy } };
  const r = policyResolver(() => settings, mcp);
  tools = [...tools, { name: 'generate_image' }, { name: 'install_comfyui', annotations: D }];
  assert.equal(r(mcpToolName('comfyui', 'generate_image')), 'auto');
  assert.equal(r(mcpToolName('comfyui', 'install_comfyui')), 'ask');
  assert.equal(r('shell'), undefined);
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date() });
    app.tools.policyFor = r;
    app.tools.add({ defaultPermission: 'ask', source: 'MCP: comfyui', spec: { name: mcpToolName('comfyui', 'generate_image'), description: '', parameters: { type: 'object' } }, summarize: () => '', run: async () => '' });
    assert.equal(app.tools.permission(mcpToolName('comfyui', 'generate_image'), {}), 'auto');
    assert.equal(app.tools.permission(mcpToolName('comfyui', 'generate_image'), { [mcpToolName('comfyui', 'generate_image')]: 'never' }), 'never');
    app.store.close();
  } finally {
    cleanup();
  }
});

test('E7 A2: PUT /api/tools/policy writes the per-tool settings and lists what each choice covers (owner only)', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ mcpServers: [{ name: 'comfyui', transport: 'stdio', command: 'npx', enabled: true }] });
  (app as { mcp?: unknown }).mcp = { get: (n: string) => (n === 'comfyui' ? { tools: COMFY, status: 'ready' } : undefined), list: () => [] };
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (body: unknown) => fetch(`${base}/tools/policy`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await put({ server: 'comfyui', policy: 'safe' });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { safe: string[]; destructive: string[] };
  assert.ok(j.safe.includes('enqueue_workflow') && j.destructive.includes('install_comfyui'));
  const perms = app.settings.get().toolPermissions!;
  assert.equal(perms[mcpToolName('comfyui', 'get_image')], 'auto');
  assert.equal(perms[mcpToolName('comfyui', 'download_model')], 'ask');
  assert.equal(app.settings.get().mcpPolicy?.comfyui, 'safe');
  assert.equal((await put({ server: 'comfyui', policy: 'yes' })).status, 400);
  assert.equal((await put({ server: 'other', policy: 'safe' })).status, 400);
  const g = (await (await fetch(`${base}/tools`, { headers: { authorization: `Bearer ${token}` } })).json()) as { servers: { name: string; policy: string; safe: string[] }[] };
  assert.equal(g.servers[0].policy, 'safe');
  assert.ok(g.servers[0].safe.includes('generate_image'));
  app.member = { limits: () => ({}) } as never;
  assert.equal((await put({ server: 'comfyui', policy: 'all' })).status, 403, 'members never get this');
});

/** A tool that asks by default, called once by the scripted model. */
function askTool(name = 'mcp_comfyui_generate_image'): Tool {
  return { defaultPermission: 'ask', source: 'MCP: comfyui', spec: { name, description: 'makes a picture', parameters: { type: 'object' } }, summarize: () => 'make a picture', run: async () => 'done' };
}

async function cardTurn(how: 'tool' | undefined, opts: Record<string, unknown> = {}, setup?: (app: ReturnType<typeof makeApp>) => void) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T15:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
    app.tools.add(askTool());
    setup?.(app);
    const conv = app.store.createConversation();
    app.script.push([call('c1', 'mcp_comfyui_generate_image', {})], text('Here.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(app, conv.id, 'make me a picture', undefined, opts as never)) {
      evs.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true, how);
    }
    return { evs, perms: app.settings.get().toolPermissions ?? {} };
  } finally {
    app.store.close();
    cleanup();
  }
}

test('E7 A1: a plain card offers Always allow; that answer allows and sets the tool to Always allowed', async () => {
  const yes = await cardTurn('tool');
  const card = yes.evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.equal(card.alwaysOk, true);
  assert.ok(yes.evs.some((e) => e.type === 'tool_result' && e.name === 'mcp_comfyui_generate_image' && /done/.test(e.output)));
  assert.equal(yes.perms.mcp_comfyui_generate_image, 'auto');
  // A plain Allow changes nothing.
  assert.equal((await cardTurn(undefined)).perms.mcp_comfyui_generate_image, undefined);
});

test('E7 A1: no Always allow on outside-app turns, untrusted mail, or a tool that always asks', async () => {
  const ext = await cardTurn('tool', { externalApp: true });
  const c1 = ext.evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }> | undefined;
  assert.ok(!c1?.alwaysOk);
  assert.equal(ext.perms.mcp_comfyui_generate_image, undefined, 'a forged answer from another app sets nothing');
  const untrusted = await cardTurn('tool', { untrusted: true });
  assert.equal(untrusted.perms.mcp_comfyui_generate_image, undefined);
  const forced = await cardTurn('tool', {}, (app) => {
    app.tools.add({ ...askTool(), defaultPermission: 'auto', asksFirst: () => true });
  });
  const c3 = forced.evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.ok(c3 && !c3.alwaysOk, 'a call that always asks keeps asking');
  assert.equal(forced.perms.mcp_comfyui_generate_image, undefined);
});
