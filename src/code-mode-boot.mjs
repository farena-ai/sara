// EC21 (docs/ops/EC2122_DESIGN.md): the code-mode bootstrap, run by Sara's own Node with the
// permission model and the network guard (src/plugins/job-net-guard.mjs). It reads one start line
// on stdin (the script, the tool names, a per-run tag), runs the script as an async function body
// with a `tools` object, and talks to Sara only through tagged JSON lines: `call` out, `result` in,
// `done` at the end. Lines without the tag (the script's own stdout) are plain logs to Sara.
import { createInterface } from 'node:readline';

const out = process.stdout.write.bind(process.stdout);
let tag = '';
let seq = 0;
const waiting = new Map();
const logs = [];
let logChars = 0;

class ToolDenied extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolDenied';
  }
}
class ToolFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolFailed';
  }
}

const send = (m) => out(`${tag}${JSON.stringify(m)}\n`);
const show = (v) => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
const log = (...a) => {
  if (logChars > 8000) return;
  const line = a.map(show).join(' ');
  logChars += line.length + 1;
  logs.push(line);
};
const sandboxConsole = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

function start(m) {
  tag = String(m.tag);
  const callTool = (name) => (args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      send({ type: 'call', id, name, args: args && typeof args === 'object' ? args : {} });
    });
  const listed = Object.freeze(Object.fromEntries(m.tools.map((n) => [n, callTool(n)])));
  // A name she wasn't given still goes to Sara, which refuses it (a clean ToolDenied, not a TypeError).
  const tools = new Proxy(listed, {
    get: (t, k) => (typeof k !== 'string' || k in t || k === 'then' || k === 'toJSON' ? t[k] : callTool(k)),
  });
  const AsyncFunction = (async () => {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction('tools', 'console', 'ToolDenied', 'ToolFailed', m.code);
  } catch (err) {
    send({ type: 'done', ok: false, error: `${err.name}: ${err.message}`, logs: logs.join('\n') });
    return;
  }
  Promise.resolve()
    .then(() => fn(tools, sandboxConsole, ToolDenied, ToolFailed))
    .then(
      (v) => send({ type: 'done', ok: true, result: v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v), logs: logs.join('\n') }),
      (err) => send({ type: 'done', ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : `Thrown: ${show(err)}`, logs: logs.join('\n') }),
    );
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'start' && !tag) start(m);
  else if (m.type === 'result') {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.status === 'ok') w.resolve(String(m.output));
    else w.reject(m.status === 'denied' ? new ToolDenied(String(m.output)) : new ToolFailed(String(m.output)));
  }
});
