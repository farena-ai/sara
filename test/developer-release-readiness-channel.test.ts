// N10 Release Readiness over the real permission-limited channel (no child processes): ready in six
// languages, plan, and a run whose job.run call is answered by a stand-in host that refuses it (the
// plugin reports "not-run", never a diagnosis).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = fileURLToPath(new URL('../store/plugins/release-readiness/', import.meta.url));
const fx = fileURLToPath(new URL('./fixtures/developer/release-readiness/repo/', import.meta.url));
for (const lang of ['en', 'es', 'fr', 'de', 'pt-BR', 'it']) test(`release readiness/${lang}: real permission-limited channel plans; refused gate jobs are not-run and never ready`, { timeout: 30000 }, async () => {
  const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')), parameters = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'));
  const home = mkdtempSync(join(tmpdir(), 'release-readiness-channel-'));
  cpSync(fx, join(home, 'projects', 'cart'), { recursive: true });
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${home}`, join(dir, 'main.mjs')], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const messages: any[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  const send = (m: any) => child.stdin.write(JSON.stringify({ v: 1, ...m }) + '\n');
  const wait = async (pred: (m: any) => boolean) => {
    const end = Date.now() + 20000;
    while (!messages.some(pred)) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < end, 'channel deadline');
      await new Promise((r) => setTimeout(r, 10));
    }
    return messages.find(pred);
  };
  try {
    send({ type: 'init', lang, plugin: 'release-readiness', companion: 'synthetic' });
    const ready = await wait((m) => m.type === 'ready');
    assert.equal(ready.tools[0].description, labels[lang].description);
    assert.deepEqual(ready.tools[0].parameters, parameters);
    const a = { project: 'cart' };
    send({ type: 'tool', id: 'p', name: 'gates', args: { operation: 'plan', ...a } });
    const plan = await wait((m) => m.id === 'p');
    assert.equal(plan.type, 'result', JSON.stringify(plan));
    assert.equal(plan.card.title, labels[lang].title);
    send({ type: 'tool', id: 'r', name: 'gates', args: { operation: 'run', ...a, planSha: JSON.parse(plan.content).planSha } });
    for (let i = 1; i <= 3; i++) {
      const call = await wait((m) => m.type === 'call' && m.op === 'job.run' && m.id === `sara-job-${i}`);
      assert.equal(call.plan.program, 'node');
      send({ type: 'error', id: call.id, error: 'job: it has no run permission' });
    }
    const run = await wait((m) => m.id === 'r');
    assert.equal(run.type, 'result', JSON.stringify(run));
    const d = JSON.parse(run.content);
    assert.equal(d.verdict, 'incomplete');
    assert.ok(d.gates.every((g: any) => g.status === 'not-run'));
    assert.equal(run.card.lines[0], labels[lang].incomplete);
    send({ type: 'tool', id: 'x', name: 'gates', args: { operation: 'run', ...a, planSha: 'f'.repeat(64) } });
    assert.equal((await wait((m) => m.id === 'x')).type, 'error');
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
