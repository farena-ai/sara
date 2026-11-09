// sara-job.mjs: asks Sara to run one job for this plugin (channel op `job.run`, H_EXEC). Copy it
// beside sara-plugin.mjs; it needs `permissions.run` in sara-plugin.json. Every job waits for the
// owner's approval, runs in a disposable copy (never the real workspace) and ends with the request
// that asked for it. docs/ops/H_EXEC_DESIGN.md has the plan fields and limits.
//
//   import { runJob } from './sara-job.mjs';
//   const r = await runJob({ program: 'node', args: ['--test'], from: 'repo', timeoutS: 60 });
//   // r: { ok, exitCode, timedOut, cancelled, stdout, stderr, changed, fence, isolated, deleted, … }
//
// It shares stdin/stdout with sara-plugin.mjs: its own call ids start with "sara-job-", and the
// helper only reads answers carrying one of them.

let seq = 0;
let buf = '';
let listening = false;
const waiting = new Map();

function listen() {
  if (listening) return;
  listening = true;
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.includes('"sara-job-')) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiting.get(msg?.id);
      if (!w || (msg.type !== 'result' && msg.type !== 'error')) continue;
      waiting.delete(msg.id);
      if (msg.type === 'error') w.reject(new Error(String(msg.error ?? 'error')));
      else w.resolve(msg);
    }
  });
}

/** Asks Sara to run `plan`; resolves with the result (or rejects with Sara's refusal). */
export function runJob(plan) {
  listen();
  const id = `sara-job-${++seq}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.stdout.write(`${JSON.stringify({ v: 1, id, type: 'call', op: 'job.run', plan })}\n`);
  });
}
