// Deterministic host stand-in, real Node permission-limited plugin process. No provider calls.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { REPO_OUTPUTS_READONLY } from './repo-outputs.ts';

export type Message = Record<string, any>;
export const knowledgeIds = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review'];
export const root = resolve(import.meta.dirname, '..');
export async function channel(t: TestContext, id: string, options: { model?: (m: Message) => string | Promise<string>; lang?: string; kv?: Map<string, unknown> } = {}) {
  const folder = resolve(root, 'store/plugins', id);
  if (!existsSync(resolve(folder, 'main.mjs'))) throw new Error(`${id}: workflow implementation is missing`);
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${folder}`, `--allow-fs-read=${resolve(root, 'src/plugins/plugin-host.mjs')}`, '--no-addons', '--max-old-space-size=128', resolve(root, 'src/plugins/plugin-host.mjs'), resolve(folder, 'main.mjs')], { cwd: folder, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  const messages: Message[] = [];
  const kv = options.kv ?? new Map<string, unknown>();
  const waiters = new Set<() => void>();
  let stderr = '', exited = false, seq = 0;
  child.stderr.setEncoding('utf8').on('data', (d) => stderr += d);
  child.on('exit', () => { exited = true; for (const fn of waiters) fn(); });
  const send = (m: Message) => child.stdin.write(`${JSON.stringify({ v: 1, ...m })}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', async (line) => {
    const m = JSON.parse(line); messages.push(m);
    if (m.type === 'call') {
      try {
        let result: Message;
        if (m.op === 'kv.get') result = { value: kv.get(m.key) ?? null };
        else if (m.op === 'kv.set') { kv.set(m.key, structuredClone(m.value)); result = { ok: true }; }
        else if (m.op === 'card') result = { ok: true };
        else if (m.op === 'model') result = { text: await options.model?.(m) ?? '{"proposals":[]}' };
        else throw new Error(`Unexpected host operation: ${m.op}`);
        send({ type: 'result', id: m.id, ...result });
      } catch (e) { send({ type: 'error', id: m.id, error: (e as Error).message }); }
    }
    for (const fn of waiters) fn();
  });
  const wait = (match: (m: Message) => boolean): Promise<Message> => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new Error(`Plugin timeout: ${id}; ${stderr}`)), 8000);
    const finish = (err?: Error, value?: Message) => { clearTimeout(timer); waiters.delete(check); err ? reject(err) : resolveWait(value!); };
    const check = () => { const found = messages.find(match); if (found) finish(undefined, found); else if (exited) finish(new Error(`Plugin exited: ${id}; ${stderr}`)); };
    waiters.add(check); check();
  });
  t.after(async () => {
    // Close the plugin process before anything that can throw: a failed evidence write must never
    // leave the child (and so the whole test file) running.
    if (!exited) { const closed = once(child, 'close'); child.stdin.end(); await closed; }
    lines.close();
    if (REPO_OUTPUTS_READONLY) return;
    const output = resolve(root, 'outputs/addons/knowledge-fixes'); mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, `${id}-${t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}-${child.pid}.json`), JSON.stringify({ fixture: true, pid: child.pid, exited, exitCode: child.exitCode, messages, stderr }, null, 2));
  });
  send({ type: 'init', plugin: id, companion: 'fixture', lang: options.lang ?? 'en', settings: {}, secrets: {} });
  const ready = await wait((m) => m.type === 'ready');
  return { ready, messages, kv, pid: child.pid, tool: async (name: string, args: unknown = {}) => { const request = `t${++seq}`; send({ type: 'tool', id: request, name, args }); return wait((m) => m.id === request && (m.type === 'result' || m.type === 'error')); } };
}
