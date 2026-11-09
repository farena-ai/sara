// B2 (owner report, run 1362): "can you see the ComfyUI installation". The lean list offered the
// installer and not the health check, the installer answered an input-validation error, and she told
// him to install ComfyUI although it was running. The tools are the real comfyui-mcp 0.52.206 list
// (test/fixtures/comfyui-mcp-tools.json), with the permissions the Store recipe's advice gives them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { DEFAULT_LEAN, leanFor, normLean } from '../src/lean.ts';
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

test('B2 fix 1: "can you see the ComfyUI installation" offers get_system_stats, ranked above the installer', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push(text('Looking.'));
  await drain(runTurn(app, conv.id, 'can you see the ComfyUI installation'), app);
  const names = (app.requests[0].tools ?? []).map((x) => x.name);
  const stats = names.indexOf('mcp_comfyui_get_system_stats');
  assert.ok(stats >= 0, `get_system_stats offered (${names.join(', ')})`);
  const inst = names.indexOf('mcp_comfyui_install_comfyui');
  assert.ok(inst === -1 || inst > stats, 'install_comfyui ranked below get_system_stats');
  for (const n of ['report_issue', 'restart_comfyui', 'download_model']) {
    const i = names.indexOf(`mcp_comfyui_${n}`);
    assert.ok(i === -1 || i > stats, `${n} ranked below the health check`);
  }
});

test('B2 fix 1: a limited family budget prefers read-only (auto) tools over ask and installer tools', () => {
  const { tools, perms } = comfy();
  const tt = leanFor({ ...DEFAULT_LEAN.tools, mode: 'always' }, tools, { text: 'what does comfyui have', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1], permission: (n) => perms[n] ?? 'ask' });
  const offered = tt.offeredNames().filter((n) => n.startsWith('mcp_comfyui_'));
  assert.ok(offered.length <= 12);
  const autos = Object.entries(perms).filter(([, p]) => p === 'auto').map(([n]) => n);
  for (const n of autos) assert.ok(offered.includes(n), `${n} (read-only) offered`);
  for (const n of ['install_comfyui', 'report_issue', 'restart_comfyui', 'download_model', 'install_custom_node']) assert.ok(!offered.includes(`mcp_comfyui_${n}`) || offered.indexOf(`mcp_comfyui_${n}`) > offered.indexOf('mcp_comfyui_get_system_stats'), n);
});
