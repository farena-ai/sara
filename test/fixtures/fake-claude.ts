// Fake `claude -p` for tests: speaks stream-json like Claude Code and drives the MCP config it was
// given (spawns the bridge, lists tools, calls the first one), then answers from the tool result.
// Behaviour by prompt: "use a tool" → tool call; "fail" → error result; otherwise echoes.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const say = (text: string) => {
  for (const piece of text.match(/.{1,6}/gs) ?? []) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
};

if (args.includes('--help')) {
  process.stdout.write(process.env.FAKE_CLAUDE_HELP ?? 'Usage: claude [options]\n');
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const system = readFileSync(opt('--system-prompt-file')!, 'utf8');
  if (process.env.FAKE_CLAUDE_LOG) writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, system, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, home: process.env.HOME }));
  out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  if (process.env.FAKE_CLAUDE_NO_EFFORT && args.includes('--effort')) {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'This model does not support the effort parameter.' });
    return;
  }
  if (/fail/.test(prompt)) {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'Invalid API key · Please run /login' });
    return;
  }
  if (!/use a tool/.test(prompt) || !opt('--mcp-config')) {
    say(`echo: ${prompt.trim()}`);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    return;
  }
  const cfg = JSON.parse(readFileSync(opt('--mcp-config')!, 'utf8')).mcpServers.sara;
  const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (r: { result?: Record<string, unknown> }) => void>();
  createInterface({ input: mcp.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<{ result?: Record<string, unknown> }>((r) => {
      const id = ++n;
      waiting.set(id, r);
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const tools = (await rpc('tools/list', {})).result!.tools as { name: string }[];
  say('Let me check. ');
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: `mcp__sara__${tools[0].name}`, input: { city: 'KC' } }] } });
  const r = await rpc('tools/call', { name: tools[0].name, arguments: { city: 'KC' } });
  const text = ((r.result!.content as { text: string }[])[0]).text;
  say(`Tool said: ${text}`);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  mcp.kill();
});
