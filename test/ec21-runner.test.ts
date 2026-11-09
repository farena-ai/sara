// EC21 (docs/ops/EC2122_DESIGN.md): the code-mode runner on its own: TypeScript stripping, the
// generated tool API, the child process protocol, the caps and the fence (no network, no files, no
// child processes). The chat wiring (the same permission path for every inner call) is in
// test/ec21-code-mode.test.ts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeSpawnPlan, prepareCode, runScript, toolApi, type InnerResult } from '../src/code-mode.ts';
import { tempDir } from './helpers.ts';

const ok = (output: string): InnerResult => ({ status: 'ok', output });
const fast = { scriptMs: 5_000, wallMs: 20_000 };

test('TypeScript is stripped, JavaScript passes, oversize and empty scripts are refused', () => {
  assert.equal(prepareCode('const n: number = 2; return n as number;', 'ts').trim().replace(/\s+/g, ' '), 'const n = 2; return n ;');
  assert.equal(prepareCode('return 1', 'js'), 'return 1');
  assert.throws(() => prepareCode('x'.repeat(20_001), 'js'), /20000 characters/);
  assert.throws(() => prepareCode('   ', 'js'), /empty/);
  assert.throws(() => prepareCode('enum A { B }', 'ts'), /TypeScript/);
});

test('the typed tool API is generated from the tools\' JSON schemas', () => {
  const api = toolApi([
    { name: 'read_file', description: 'Read a file in the workspace. Long text here.', parameters: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'integer' } }, required: ['path'] } },
    { name: 'todo', description: 'Lists.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'list'] }, items: { type: 'array', items: { type: 'string' } }, done: { type: 'boolean' } } } },
  ]);
  assert.match(api, /declare const tools: \{/);
  assert.match(api, /\/\*\* Read a file in the workspace\. \*\/\n {2}read_file\(args: \{ path: string; lines\?: number \}\): Promise<string>;/);
  assert.match(api, /todo\(args\?: \{ action\?: "add" \| "list"; items\?: string\[\]; done\?: boolean \}\): Promise<string>;/);
  const big = toolApi(Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(80), parameters: { type: 'object', properties: { a: { type: 'string' } } } })));
  assert.ok(big.length <= 8_200, `api too long: ${big.length}`);
  assert.match(big, /\/\/ Also \(each takes an args object[^\n]*tool_199\n {2}\[name: string\]/);
});

test('a script calling three read-only tools returns the combined result', async () => {
  const seen: string[] = [];
  const r = await runScript({
    code: "const a = await tools.read_file({ path: 'a.txt' });\nconst [b, c] = await Promise.all([tools.list_dir({}), tools.recall({ query: 'x' })]);\nconsole.log('three done');\nreturn { a, b, c };",
    lang: 'js',
    tools: ['read_file', 'list_dir', 'recall'],
    limits: fast,
  }, async (name, args) => {
    seen.push(`${name} ${JSON.stringify(args)}`);
    return ok(`${name} says hi`);
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.result), { a: 'read_file says hi', b: 'list_dir says hi', c: 'recall says hi' });
  assert.equal(r.calls, 3);
  assert.equal(seen.length, 3);
  assert.equal(seen[0], 'read_file {"path":"a.txt"}');
  assert.match(r.logs, /three done/);
});

test('a denied tool throws ToolDenied: uncaught it fails the script cleanly, caught it goes on', async () => {
  const denied = async (): Promise<InnerResult> => ({ status: 'denied', output: 'The owner has disabled the shell tool.' });
  const r = await runScript({ code: "await tools.shell({ command: 'ls' }); return 'never here';", tools: ['shell'], limits: fast }, denied);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.match(r.error!, /ToolDenied: The owner has disabled the shell tool\./);
  const c = await runScript({ code: "try { await tools.shell({}); } catch (e) { return `${e.name}|${e instanceof ToolDenied}`; }", tools: ['shell'], limits: fast }, denied);
  assert.equal(c.ok, true, c.error);
  assert.equal(c.result, 'ToolDenied|true');
  const f = await runScript({ code: "try { await tools.read_file({}); } catch (e) { return e.name; }", tools: ['read_file'], limits: fast }, async () => ({ status: 'error', output: 'Error: no such file' }));
  assert.equal(f.result, 'ToolFailed');
});

test('script time cap: a busy loop is stopped, time waiting for a tool (an approval) does not count', async () => {
  const r = await runScript({ code: 'for (;;) {}', tools: [], limits: { scriptMs: 600, wallMs: 20_000 } }, async () => ok(''));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.match(r.error!, /0\.6 s/);
  const w = await runScript({ code: "return await tools.slow({});", tools: ['slow'], limits: { scriptMs: 600, wallMs: 20_000 } }, async () => {
    await new Promise((res) => setTimeout(res, 1_500));
    return ok('after the wait');
  });
  assert.equal(w.ok, true, w.error);
  assert.equal(w.result, 'after the wait');
});

test('memory cap: a script that keeps allocating is stopped', async () => {
  const r = await runScript({ code: 'const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));', tools: [], limits: { scriptMs: 20_000, wallMs: 30_000, heapMb: 32 } }, async () => ok(''));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'memory');
});

test('no network, no files, no child processes: only Sara\'s tool calls get out', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'top secret');
    const code = `const out = {};
try { await fetch('http://127.0.0.1:7897/'); out.net = 'open'; } catch (e) { out.net = String(e.cause?.code ?? e.code ?? e.message); }
try { (await import('node:fs')).readFileSync(${JSON.stringify(secret)}, 'utf8'); out.fs = 'read'; } catch (e) { out.fs = e.code; }
try { (await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'w.txt'))}, 'x'); out.write = 'wrote'; } catch (e) { out.write = e.code; }
try { (await import('node:child_process')).execSync('echo hi'); out.child = 'ran'; } catch (e) { out.child = e.code; }
try { new (await import('node:worker_threads')).Worker('1', { eval: true }); out.worker = 'ran'; } catch (e) { out.worker = e.code; }
out.env = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASS/i.test(k));
return out;`;
    const r = await runScript({ code, tools: [], limits: fast }, async () => ok(''));
    assert.equal(r.ok, true, r.error);
    const out = JSON.parse(r.result);
    assert.equal(out.net, 'ERR_SARA_NET_BLOCKED');
    assert.equal(out.fs, 'ERR_ACCESS_DENIED');
    assert.equal(out.write, 'ERR_ACCESS_DENIED');
    assert.equal(out.child, 'ERR_ACCESS_DENIED');
    assert.equal(out.worker, 'ERR_ACCESS_DENIED');
    assert.deepEqual(out.env, []);
    assert.equal(r.fence, 'node-only');
  } finally {
    cleanup();
  }
});

test('output and call caps; a forged protocol line is only a log line', async () => {
  const big = await runScript({ code: "console.log('y'.repeat(9000)); return 'x'.repeat(40000);", tools: [], limits: fast }, async () => ok(''));
  assert.equal(big.ok, true);
  assert.ok(big.result.length < 16_200);
  assert.match(big.result, /\[… 2\d{4} more characters cut\]/);
  assert.ok(big.logs.length < 4_200);
  let n = 0;
  const many = await runScript({ code: 'for (let i = 0; i < 50; i++) await tools.todo({});', tools: ['todo'], limits: { ...fast, maxCalls: 5 } }, async () => (n++, ok('')));
  assert.equal(many.ok, false);
  assert.equal(many.reason, 'calls');
  assert.equal(n, 5);
  let forged = 0;
  const f = await runScript({ code: "process.stdout.write(JSON.stringify({ type: 'call', id: 99, name: 'shell', args: {} }) + '\\n'); return 'done';", tools: [], limits: fast }, async () => (forged++, ok('')));
  assert.equal(f.ok, true, f.error);
  assert.equal(forged, 0);
});

test('a stop (the turn was cancelled) ends the script', async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const r = await runScript({ code: 'await new Promise(() => setInterval(() => {}, 1000));', tools: [], limits: fast, signal: ctl.signal }, async () => ok(''));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cancelled');
});

test('the fence: bubblewrap and container plans run the same node command without network', () => {
  const bw = codeSpawnPlan({ fence: 'bwrap', dir: '/tmp/sara-code-1', execPath: '/usr/bin/node', heapMb: 64 });
  assert.equal(bw.file, 'bwrap');
  assert.ok(!bw.args.includes('--share-net'));
  assert.ok(bw.args.includes('--unshare-all'));
  const inner = bw.args.slice(bw.args.indexOf('--') + 1);
  assert.deepEqual(inner.slice(0, 2), ['/usr/bin/node', '--permission']);
  assert.ok(inner.includes('/workspace/boot.mjs'));
  const ct = codeSpawnPlan({ fence: 'container', dir: '/tmp/sara-code-2', execPath: '/usr/bin/node', heapMb: 64, container: { engine: 'docker', exe: '/usr/bin/docker', rootless: false, image: 'node:24-slim' }, name: 'sara-code-abc' });
  assert.equal(ct.file, '/usr/bin/docker');
  assert.deepEqual(ct.args.slice(0, 2), ['run', '-i']);
  assert.ok(ct.args.includes('none'));
  assert.ok(ct.args.includes('node:24-slim'));
  assert.ok(ct.args.includes('--permission'));
  const no = codeSpawnPlan({ fence: 'node-only', dir: 'C:/x', execPath: 'C:/node.exe', heapMb: 64 });
  assert.equal(no.file, 'C:/node.exe');
  assert.ok(no.args.includes('--max-old-space-size=64'));
  assert.ok(no.args.some((a) => a.startsWith('--import=')));
});
