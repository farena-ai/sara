// B2 fix 2 (owner report, run 1362): "can you see the ComfyUI installation". The lean list offered the
// installer and not the health check, the installer answered an input-validation error, and she told
// him to install ComfyUI although it was running. The tools are the real comfyui-mcp 0.52.206 list
// (test/fixtures/comfyui-mcp-tools.json), with the permissions the Store recipe's advice gives them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { argErrorHint, normLean } from '../src/lean.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { mcpDefaultPermission, mcpToolName } from '../src/tools/mcp.ts';
import { ToolError, type Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

type Rec = { name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; parameters: Record<string, unknown> };
const FIX = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'comfyui-mcp-tools.json'), 'utf8')) as { tools: Rec[] };
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'comfyui.json'), 'utf8')) as { mcp: { tools: { readOnly: string[]; ask: string[] } } };
const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };
const VALIDATION = 'MCP error -32602: Input validation error: Invalid arguments for tool install_comfyui: Invalid option: expected one of "install"|"update"|"update_all"|"panel"|"self_update"|"environment"|"configure_manager" at action';

/** The registry tools McpManager would make, and the permissions the recipe advice saves. */
function comfy(ran: string[] = []): { tools: Tool[]; perms: Record<string, 'auto' | 'ask'> } {
  const perms: Record<string, 'auto' | 'ask'> = {};
  const tools = FIX.tools.map((t): Tool => {
    const name = mcpToolName('comfyui', t.name);
    const a = t.annotations;
    if (RECIPE.mcp.tools.readOnly.includes(t.name) && a?.readOnlyHint !== false && a?.destructiveHint !== true) perms[name] = 'auto';
    else if (RECIPE.mcp.tools.ask.includes(t.name) && a?.readOnlyHint !== true) perms[name] = 'ask';
    return {
      defaultPermission: mcpDefaultPermission(t),
      source: 'MCP: comfyui',
      spec: { name, description: `[comfyui] ${t.description}`.slice(0, 1000), parameters: t.parameters },
      summarize: () => t.name,
      run: async () => {
        ran.push(t.name);
        if (t.name === 'install_comfyui') throw new ToolError(VALIDATION);
        return `${t.name} ok`;
      },
    };
  });
  return { tools, perms };
}

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T07:22:00Z') };
  const app: TestApp = makeApp(dir, clock);
  const ran: string[] = [];
  const { tools, perms } = comfy(ran);
  for (const x of tools) app.tools.add(x);
  app.settings.update({ providers: [CLOUD], defaultProviderId: CLOUD.id, defaultModel: CLOUD.defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: perms, lean: normLean({ tools: { mode: 'always' } }) } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, ran };
}

async function drain(gen: AsyncGenerator<ChatEvent>, app: TestApp): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true);
  }
  return out;
}

test('B2 fix 2: an input-validation error tells her nothing ran, lists the allowed values and says to retry or find_tools', async (t) => {
  const { app, ran } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'mcp_comfyui_install_comfyui', { action: 'status' })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'can you see the ComfyUI installation'), app);
  assert.deepEqual(ran, ['install_comfyui']);
  const r = evs.find((e) => e.type === 'tool_result' && e.name === 'mcp_comfyui_install_comfyui') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.ok(r, 'a tool result');
  assert.match(r.output, /expected one of/);
  assert.match(r.output, /action.*"install".*"configure_manager"/s, 'the failing field’s allowed values');
  assert.ok(r.output.trimEnd().endsWith('Your arguments were invalid and nothing ran. Fix them using the allowed values above and call the tool again, or use find_tools for a better tool, before answering.'), r.output);
});

test('B2 fix 2: argErrorHint keeps the failing field’s enum even when the schema is long, and is silent for other errors', () => {
  const big: Tool = { spec: { name: 'x', description: 'x', parameters: { type: 'object', properties: { pad: { type: 'string', description: 'p'.repeat(3000) }, mode: { type: 'string', enum: ['fast', 'slow'] } } } }, defaultPermission: 'auto', source: 'built-in', summarize: () => 'x', run: async () => '' };
  const h = argErrorHint(big, 'Error: must be equal to one of the allowed values at /mode');
  assert.match(h, /mode.*"fast".*"slow"/s);
  assert.match(h, /nothing ran/);
  assert.equal(argErrorHint(big, 'Error: connection refused'), '');
  // JSON-schema style enum errors (ajv) count too.
  assert.match(argErrorHint(big, 'Error: data/mode must be equal to one of the allowed values'), /"fast"/);
});
