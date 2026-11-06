import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Message = Record<string, any>;
/** Real permission-limited native shim; host/model replies are synthetic fixtures, NOT manager qualification. */
export async function workflowChannel(id: string, host?: (m: Message) => Message | Promise<Message>, lang = 'en') {
  const folder = resolve('store/plugins', id), shim = resolve('src/plugins/plugin-host.mjs');
  const launch = { args: ['--permission', `--allow-fs-read=${folder}`, `--allow-fs-read=${shim}`, '--no-addons', '--max-old-space-size=128', shim, resolve(folder, 'main.mjs')], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } };
  const child = spawn(process.execPath, launch.args, { cwd: folder, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: Message[] = [];
  const calls: Message[] = [];
  let buffer = '', stderr = '', sequence = 0;
  child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
  const send = (m: Message) => child.stdin.write(JSON.stringify({ v: 1, ...m }) + '\n');
  child.stdout.setEncoding('utf8').on('data', (s: string) => {
    buffer += s;
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
      if (!line) continue;
      const m = JSON.parse(line); messages.push(m);
      if (m.type === 'call') {
        calls.push(m);
        Promise.resolve(m.op === 'card' ? { error: 'Undeclared card broker operation forbidden; return result.card' } : host ? host(m) : { error: 'Unexpected host call' }).then(r => send({ type: r.error ? 'error' : 'result', id: m.id, ...r }));
      }
    }
  });
  const wait = async (predicate: (m: Message) => boolean) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const m = messages.find(predicate); if (m) return m;
      if (child.exitCode !== null) throw new Error(`Plugin ${id} exited ${child.exitCode}: ${stderr}`);
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Plugin ${id} channel timeout: ${stderr}`);
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (process.env.SARA_WORKFLOW_CHILD_LOG) appendFileSync(process.env.SARA_WORKFLOW_CHILD_LOG, JSON.stringify({ plugin: id, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, closed: true }) + '\n');
    if (process.env.SARA_WORKFLOW_EVIDENCE_DIR) {
      mkdirSync(process.env.SARA_WORKFLOW_EVIDENCE_DIR, { recursive: true });
      writeFileSync(resolve(process.env.SARA_WORKFLOW_EVIDENCE_DIR, `${id}-${child.pid}.json`), JSON.stringify({ fixture: true, managerQualified: false, lang, launch, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, messages, stderr }, null, 2));
    }
  };
  try {
    send({ type: 'init', plugin: id, companion: 'fixture', lang, settings: {}, secrets: {} });
    const ready = await wait(m => m.type === 'ready');
    return { ready, calls, messages, launch, pid: child.pid, close,
      async tool(args: unknown, name = 'workflow') {
        const requestId = `t${++sequence}`; send({ type: 'tool', id: requestId, name, args });
        return wait(m => m.id === requestId && (m.type === 'result' || m.type === 'error'));
      },
    };
  } catch (err) { await close(); throw err; }
}
export function fixtureHost() {
  const values = new Map<string, unknown>();
  return (m: Message): Message => {
    if (m.op === 'kv.get') return { value: values.get(m.key) ?? null };
    if (m.op === 'kv.set') { values.set(m.key, m.value); return { ok: true }; }
    return { error: `Unsupported fixture operation ${m.op}` };
  };
}
export const output = (m: Message): Message => {
  if (m.type === 'error') throw new Error(m.error);
  assert.ok(m.card, 'successful workflow must return a tool-result card');
  assert.equal(typeof m.card.title, 'string'); assert.ok(m.card.title.trim() && m.card.title.length <= 120);
  assert.ok(Array.isArray(m.card.lines) && m.card.lines.length > 0 && m.card.lines.length <= 8);
  assert.ok(m.card.lines.every((line: unknown) => typeof line === 'string' && line.length <= 200 && !/[\u0000-\u001f]/.test(line)));
  return JSON.parse(m.content);
};
