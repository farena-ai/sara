// Phase 81 (harness track M6, docs/design/HARNESS_TRACK.md §2.5, §3 M6, §7 #2 #5): the security
// pass, live dependency advisories and the fix-branch loop, on the ONE findings table.
// - each deterministic check: true positives and near-miss negatives (code shapes only, no payloads);
// - the "no theater" rule: a finding whose quote isn't in the file is dropped (code and model);
// - the Reviewing model (fake provider) may only add findings with a verbatim quote; Reviewing
//   falls back to Coding;
// - OSV.dev client against a LOCAL fake OSV server (batch, details, cache TTL, offline, one request
//   in flight), never called when switched off, in private conversations or private local mode;
// - the install-time "Known vulnerability" card with an explicit, recorded override;
// - the fix-branch loop end to end on a temp git repo (worktree branch, the owner's branch and files
//   untouched, re-check, tests re-run in a sandbox copy, Apply / Keep / Discard), never a push;
// - the findings table, its routes and filters, dismiss / accept with a reason, M2/M5 rows;
// - budgets, approvals and safety are never skipped.
// The real OSV API is never called here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { resolveChain, runTurn, type ChatEvent } from '../src/chat.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { SandboxGate, sandboxGateSettings, type Isolation } from '../src/sandbox-run.ts';
import { OsvClient, osvSeverity, fixedVersion } from '../src/security/advisories.ts';
import { installTargets, isInstallCommand, readManifest } from '../src/security/deps.ts';
import { FindingStore, recordTurnFindings, validateQuotes, type NewFinding } from '../src/security/findings.ts';
import { applyEdits, detectTests, FixBranches } from '../src/security/fix.ts';
import { gitLog } from '../src/security/git.ts';
import { securitySettings, SecurityPass } from '../src/security/pass.ts';
import { checkFile, RULE_IDS, type RuleId } from '../src/security/rules.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { RunStore } from '../src/runs.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const COPY: Isolation = { driver: 'copy', isolated: false, label: 'Not isolated (test)' };
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
/** Secret-shaped test values are built from parts (the public-export scan rejects them as literals). */
const AWS = ['AK', 'IA', 'Q3EXAMPLE7KEYZ9X'].join('');
const OPENAI = ['s', 'k-', 'proj-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'].join('');

// ------------------------------------------------------------------------------------------------
// 1. The deterministic checks: true positives and near misses
// ------------------------------------------------------------------------------------------------

/** [rule, file, line, should fire]. Each rule has at least two hits and two near misses. */
const CASES: [RuleId, string, string, boolean][] = [
  // secrets in code
  ['secret-in-code', 'src/aws.js', `const key = '${AWS}';`, true],
  ['secret-in-code', 'src/ai.py', `client = OpenAI(api_key="${OPENAI}")`, true],
  ['secret-in-code', 'config.js', "const dbPassword = 'Tr0ub4dor&3horse';", true],
  ['secret-in-code', 'settings.yml', 'client_secret: "9f8e7d6c5b4a3f2e1d0c"', true],
  ['secret-in-code', 'src/a.js', 'const apiKey = process.env.API_KEY;', false],
  ['secret-in-code', 'src/a.js', "const password = 'changeme';", false],
  ['secret-in-code', 'src/a.js', "const token = req.headers['x-token'];", false],
  ['secret-in-code', '.env.example', 'API_KEY="your-api-key-here"', false],
  ['secret-in-code', 'src/a.py', 'password = os.environ["DB_PASSWORD"]', false],
  // eval / new Function / shells with interpolated input
  ['code-exec', 'src/calc.js', 'const result = eval(req.query.expr);', true],
  ['code-exec', 'src/tpl.js', 'const fn = new Function("data", body);', true],
  ['code-exec', 'src/run.js', "const { exec } = require('child_process'); exec(`ls ${req.query.dir}`);", true],
  ['code-exec', 'src/run.py', 'os.system(f"convert {filename} out.png")', true],
  ['code-exec', 'src/run.py', 'subprocess.run("tar xf " + name, shell=True)', true],
  ['code-exec', 'src/run.js', "const { execFile } = require('child_process'); execFile('git', ['log', branch]);", false],
  ['code-exec', 'src/re.js', 'const m = /a(b)/.exec(line);', false],
  ['code-exec', 'src/run.py', 'subprocess.run(["tar", "xf", name])', false],
  ['code-exec', 'src/a.py', 'value = ast.literal_eval(text)', false],
  // SQL built from strings
  ['sql-string', 'src/db.js', 'db.query("SELECT * FROM users WHERE id = " + req.params.id);', true],
  ['sql-string', 'src/db.js', 'const rows = await db.all(`SELECT name FROM items WHERE owner = ${user}`);', true],
  ['sql-string', 'src/db.py', 'cur.execute(f"DELETE FROM notes WHERE id = {note_id}")', true],
  ['sql-string', 'src/db.py', 'cur.execute("SELECT * FROM t WHERE name = \'%s\'" % name)', true],
  ['sql-string', 'src/db.js', "db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);", false],
  ['sql-string', 'src/db.py', 'cur.execute("SELECT * FROM t WHERE name = %s", (name,))', false],
  ['sql-string', 'src/ui.js', "alert('Select a file from the list ' + name);", false],
  // path traversal from request input
  ['path-traversal', 'src/files.js', "res.sendFile(path.join(__dirname, 'uploads', req.query.name));", true],
  ['path-traversal', 'src/files.py', "return open(os.path.join(BASE, request.args.get('f'))).read()", true],
  ['path-traversal', 'src/files.js', "res.sendFile(path.join(__dirname, 'uploads', path.basename(req.query.name)));", false],
  ['path-traversal', 'src/files.js', "res.sendFile(path.join(__dirname, 'public', 'index.html'));", false],
  ['path-traversal', 'src/files.py', "return send_from_directory(UPLOADS, request.args.get('f'))", false],
  // TLS checks off
  ['tls-off', 'src/http.js', 'const agent = new https.Agent({ rejectUnauthorized: false });', true],
  ['tls-off', 'src/fetch.py', 'r = requests.get(url, verify=False)', true],
  ['tls-off', 'src/main.go', 'tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}', true],
  ['tls-off', 'src/http.js', 'const agent = new https.Agent({ rejectUnauthorized: true });', false],
  ['tls-off', 'src/fetch.py', 'r = requests.get(url, verify=True, timeout=5)', false],
  // unsafe deserialization
  ['unsafe-deserialize', 'src/load.py', 'data = pickle.loads(request.data)', true],
  ['unsafe-deserialize', 'src/load.py', 'cfg = yaml.load(open(path))', true],
  ['unsafe-deserialize', 'src/load.js', "const obj = serialize.unserialize(req.cookies.profile);", true],
  ['unsafe-deserialize', 'src/load.py', 'cfg = yaml.safe_load(open(path))', false],
  ['unsafe-deserialize', 'src/load.py', 'cfg = yaml.load(f, Loader=yaml.SafeLoader)', false],
  ['unsafe-deserialize', 'src/load.js', 'const obj = JSON.parse(req.body);', false],
  // weak crypto for a secret
  ['weak-crypto', 'src/auth.js', "const hash = crypto.createHash('md5').update(password).digest('hex');", true],
  ['weak-crypto', 'src/auth.js', 'const resetToken = Math.random().toString(36).slice(2);', true],
  ['weak-crypto', 'src/enc.js', "const c = crypto.createCipheriv('aes-128-ecb', key, null);", true],
  ['weak-crypto', 'src/auth.py', 'digest = hashlib.sha1(password.encode()).hexdigest()', true],
  ['weak-crypto', 'src/cache.js', "const etag = crypto.createHash('md5').update(body).digest('hex');", false],
  ['weak-crypto', 'src/auth.js', "const hash = crypto.createHash('sha256').update(password).digest('hex');", false],
  ['weak-crypto', 'src/anim.js', 'const wobble = Math.random() * 10;', false],
  // HTML from input
  ['inner-html', 'src/page.js', "el.innerHTML = '<b>' + location.hash.slice(1) + '</b>';", true],
  ['inner-html', 'src/page.js', 'out.innerHTML = `Hello ${params.get("name")}`;', true],
  ['inner-html', 'src/page.js', "el.innerHTML = '';", false],
  ['inner-html', 'src/page.js', 'el.textContent = params.get("name");', false],
  // debug on
  ['debug-on', 'app.py', 'app.run(host="0.0.0.0", debug=True)', true],
  ['debug-on', 'settings.py', 'DEBUG = True', true],
  ['debug-on', 'app.py', 'app.run(debug=False)', false],
  ['debug-on', 'settings.py', "DEBUG = os.environ.get('DEBUG') == '1'", false],
];

test('rules: every check fires on its true positives and stays quiet on the near misses', () => {
  const misses: string[] = [];
  for (const [rule, file, line, want] of CASES) {
    const got = checkFile(file, `// header\n${line}\n`).filter((f) => f.rule === rule);
    if (Boolean(got.length) !== want) misses.push(`${rule} ${want ? 'missed' : 'false alarm'}: ${line}`);
    for (const f of got) {
      assert.equal(f.line, 2, `${rule}: the line number`);
      assert.equal(f.quote, line.trim(), `${rule}: quotes the real line`);
      assert.equal(f.origin, 'code');
    }
  }
  assert.deepEqual(misses, []);
  // Every rule is covered by at least two hits and one near miss above (CORS and missing auth below).
  for (const r of RULE_IDS.filter((x) => x !== 'cors-credentials' && x !== 'missing-auth')) {
    assert.ok(CASES.filter((c) => c[0] === r && c[3]).length >= 2, `${r}: two hits`);
    assert.ok(CASES.filter((c) => c[0] === r && !c[3]).length >= 2, `${r}: two near misses`);
  }
});

test('rules: comments are skipped (except for secrets); markdown is not code', () => {
  assert.equal(checkFile('src/a.js', '// db.query("SELECT * FROM t WHERE id = " + id)\n').length, 0);
  assert.equal(checkFile('src/a.py', '# requests.get(url, verify=False)\n').length, 0);
  assert.equal(checkFile('src/a.js', `// old key: ${AWS}\n`).filter((f) => f.rule === 'secret-in-code').length, 1, 'a secret in a comment is still a secret');
  assert.equal(checkFile('README.md', 'Run `eval(req.query.x)` and see.\n').length, 0, 'docs are not scanned for code shapes');
  assert.equal(checkFile('node_modules/x/index.js', 'eval(req.query.x)').length, 0, 'dependency folders are never read');
});

test('rules: CORS with credentials (wildcard or echoed origin) vs. a wildcard without credentials', () => {
  const bad = "app.use(cors({\n  origin: '*',\n  credentials: true,\n}));\n";
  const f = checkFile('src/server.js', bad).filter((x) => x.rule === 'cors-credentials');
  assert.equal(f.length, 1);
  assert.equal(f[0].quote, "origin: '*',");
  const echoed = "res.setHeader('Access-Control-Allow-Origin', req.headers.origin);\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n";
  assert.equal(checkFile('src/server.js', echoed).filter((x) => x.rule === 'cors-credentials').length, 1);
  const py = 'app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)\n';
  assert.equal(checkFile('main.py', py).filter((x) => x.rule === 'cors-credentials').length, 1);
  // Near misses: a wildcard without credentials; credentials with a named origin.
  assert.equal(checkFile('src/server.js', "app.use(cors({ origin: '*' }));\n").filter((x) => x.rule === 'cors-credentials').length, 0);
  assert.equal(checkFile('src/server.js', "app.use(cors({ origin: 'https://app.example.com', credentials: true }));\n").filter((x) => x.rule === 'cors-credentials').length, 0);
});

test('rules: a new route without the sign-in check the other routes use (and the near misses)', () => {
  const file = [
    "const requireAuth = require('./auth');",
    "app.get('/api/notes', requireAuth, (req, res) => res.json(notes));",
    "app.post('/api/notes', requireAuth, (req, res) => add(req.body));",
    "app.delete('/api/notes/:id', requireAuth, (req, res) => del(req.params.id));",
    "app.get('/api/export', (req, res) => res.json(everything()));",
    "app.get('/health', (req, res) => res.send('ok'));",
  ].join('\n');
  const f = checkFile('src/routes.js', file).filter((x) => x.rule === 'missing-auth');
  assert.deepEqual(f.map((x) => x.line), [5], 'the export route, not the public /health');
  // Only routes on changed lines count as new.
  assert.equal(checkFile('src/routes.js', file, { changed: new Set([2]) }).filter((x) => x.rule === 'missing-auth').length, 0);
  assert.equal(checkFile('src/routes.js', file, { changed: new Set([5]) }).filter((x) => x.rule === 'missing-auth').length, 1);
  // No detectable pattern (no route uses a check): nothing to compare with, no finding.
  const open = "app.get('/a', (req, res) => 1);\napp.get('/b', (req, res) => 2);\napp.get('/c', (req, res) => 3);\n";
  assert.equal(checkFile('src/routes.js', open).filter((x) => x.rule === 'missing-auth').length, 0);
  // A global app.use(requireAuth) covers the routes after it.
  const global = "app.use(requireAuth);\napp.get('/a', requireAuth, h);\napp.get('/b', requireAuth, h);\napp.get('/c', (req, res) => 3);\n";
  assert.equal(checkFile('src/routes.js', global).filter((x) => x.rule === 'missing-auth').length, 0);
  // Flask: @login_required on the others.
  const flask = ['@app.route("/notes")', '@login_required', 'def notes():', '    pass', '@app.route("/notes/<id>")', '@login_required', 'def note(id):', '    pass', '@app.route("/admin/dump")', 'def dump():', '    pass'].join('\n');
  assert.deepEqual(checkFile('app.py', flask).filter((x) => x.rule === 'missing-auth').map((x) => x.line), [9]);
});

// ------------------------------------------------------------------------------------------------
// 2. The "no theater" rule
// ------------------------------------------------------------------------------------------------

test('quotes: a finding whose quote is not in the file is dropped; a wrong line is moved to the real one', () => {
  const files: Record<string, string> = { 'src/a.js': 'const x = 1;\ndb.query("SELECT * FROM t WHERE id = " + id);\n' };
  const read = (f: string) => files[f];
  const base = { source: 'security' as const, severity: 'high' as const, rule: 'review:sql', title: 'x', advice: '' };
  const { kept, dropped } = validateQuotes<NewFinding>(
    [
      { ...base, file: 'src/a.js', line: 2, quote: 'db.query("SELECT * FROM t WHERE id = " + id);' },
      { ...base, file: 'src/a.js', line: 9, quote: 'SELECT * FROM t WHERE id' },
      { ...base, file: 'src/a.js', line: 1, quote: 'db.query("SELECT * FROM t WHERE id = " + req.query.id)' },
      { ...base, file: 'src/missing.js', line: 1, quote: 'whatever it is here' },
      { ...base, file: 'src/a.js', line: 1, quote: 'x' },
      { ...base, file: null, quote: 'command output line' },
    ],
    read,
  );
  assert.equal(kept.length, 3);
  assert.equal(kept[1].line, 2, 'moved to the line that really holds the quote');
  assert.deepEqual(dropped.map((d) => d.why), ['quote not in the file', 'file not readable', 'no quote']);
  assert.equal(kept[2].file, null, 'non-code findings (sandbox output) pass unchanged');
});

// ------------------------------------------------------------------------------------------------
// Test apps
// ------------------------------------------------------------------------------------------------

function git(cwd: string, ...a: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  return r.stdout.trim();
}

function setup(t: { after: (fn: () => void) => void }, o: { osv?: string; advisories?: boolean; reviewer?: boolean; mode?: 'after' | 'ask' | 'off' } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const servers: { close: () => void }[] = [];
  t.after(() => {
    setPrivateLocal(false);
    for (const s of servers) s.close();
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [
      { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' },
      { id: 'q', label: 'Q', kind: 'openai-compatible', baseUrl: 'http://y' },
    ],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    securityPass: { mode: o.mode ?? 'after', reviewer: o.reviewer ?? false, advisories: o.advisories ?? false },
  });
  app.runs = new RunStore(app.store.db, app.now);
  app.findings = new FindingStore(app.store.db, app.now);
  const osv = new OsvClient(app.store.db, { baseUrl: o.osv ?? 'http://127.0.0.1:9', now: () => clock.now });
  const clock = { now: NOW };
  app.security = new SecurityPass(app, app.findings, osv);
  app.sandboxGate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), app.sandbox, () => sandboxGateSettings(app.settings.get()), () => COPY);
  app.fixes = new FixBranches(app, join(dir, 'cache', 'fix-branches'));
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  return { app, dir, ws, conv, osv, clock, servers };
}

/** A local stand-in for OSV.dev: lodash 4.17.15 and requests 2.19.0 are vulnerable. */
async function fakeOsv(t: { after: (fn: () => void) => void }, o: { delayMs?: number; failStatus?: number } = {}) {
  const log: { path: string; queries?: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const BAD: Record<string, string[]> = { 'npm|lodash|4.17.15': ['GHSA-p6mc-m468-83gw', 'GHSA-29mw-wpgm-hmr9'], 'PyPI|requests|2.19.0': ['PYSEC-2018-28'] };
  const VULN: Record<string, unknown> = {
    'GHSA-p6mc-m468-83gw': { id: 'GHSA-p6mc-m468-83gw', summary: 'Prototype Pollution in lodash', aliases: ['CVE-2020-8203'], database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.19' }] }] }] },
    'GHSA-29mw-wpgm-hmr9': { id: 'GHSA-29mw-wpgm-hmr9', summary: 'ReDoS in lodash', database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }] },
    'PYSEC-2018-28': { id: 'PYSEC-2018-28', summary: 'requests sends credentials on redirect', affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.20.0' }] }] }] },
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let body = '';
    for await (const c of req) body += c;
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    inFlight--;
    if (o.failStatus) {
      res.writeHead(o.failStatus).end('{}');
      log.push({ path: req.url ?? '' });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/querybatch') {
      const q = JSON.parse(body) as { queries: { package: { name: string; ecosystem: string }; version: string }[] };
      log.push({ path: req.url, queries: q.queries.length });
      const results = q.queries.map((x) => ({ vulns: (BAD[`${x.package.ecosystem}|${x.package.name}|${x.version}`] ?? []).map((id) => ({ id, modified: '2024-01-01T00:00:00Z' })) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
      return;
    }
    const m = /^\/v1\/vulns\/(.+)$/.exec(req.url ?? '');
    log.push({ path: req.url ?? '' });
    if (req.method === 'GET' && m && VULN[decodeURIComponent(m[1])]) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(VULN[decodeURIComponent(m[1])]));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, stats: () => ({ maxInFlight }), close };
}

/** A stand-in for the shell tool (never runs anything; records the commands). */
function fakeShell(app: TestApp, ran: string[]): void {
  const tool: Tool = {
    spec: { name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    defaultPermission: 'auto',
    summarize: (a) => `$ ${String(a.command)}`,
    async run(a) {
      ran.push(String(a.command));
      return 'added 1 package';
    },
  };
  app.tools.add(tool);
}

type Approval = Extract<ChatEvent, { type: 'approval' }>;
async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Approval) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// 3. Dependency readers and install commands
// ------------------------------------------------------------------------------------------------

test('deps: lockfiles and manifests of npm, PyPI, crates, Go and RubyGems are read with their real lines', () => {
  const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/@scope/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0', link: true } } }, null, 2);
  const npm = readManifest('package-lock.json', lock);
  assert.deepEqual(npm.map((p) => `${p.name}@${p.version}`), ['lodash@4.17.15', '@scope/a@1.0.0']);
  assert.ok(lock.split('\n')[npm[0].line - 1].includes(npm[0].quote), 'the quote is the real line');
  assert.deepEqual(readManifest('package.json', '{"dependencies":{"lodash":"4.17.15","express":"^4.0.0"}}').map((p) => p.name), ['lodash'], 'ranges are left to the lockfile');
  assert.deepEqual(readManifest('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.15:\n    resolution: {integrity: x}\n  '@scope/b@2.1.0':\n    resolution: {}\n").map((p) => `${p.name}@${p.version}`), ['lodash@4.17.15', '@scope/b@2.1.0']);
  assert.deepEqual(readManifest('yarn.lock', '# yarn\nlodash@^4.17.0:\n  version "4.17.15"\n  resolved "x"\n').map((p) => `${p.name}@${p.version}`), ['lodash@4.17.15']);
  assert.deepEqual(readManifest('requirements.txt', 'requests==2.19.0\nflask>=2\n# x==1\nDjango[argon2]==3.2.1 ; python_version > "3"\n').map((p) => `${p.name}@${p.version}`), ['requests@2.19.0', 'Django@3.2.1']);
  assert.deepEqual(readManifest('poetry.lock', '[[package]]\nname = "urllib3"\nversion = "1.24.1"\n\n[[package]]\nname = "idna"\nversion = "2.8"\n').map((p) => `${p.name}@${p.version}`), ['urllib3@1.24.1', 'idna@2.8']);
  assert.deepEqual(readManifest('pyproject.toml', '[project]\ndependencies = ["requests==2.19.0", "rich>=13"]\n').map((p) => p.name), ['requests']);
  assert.deepEqual(readManifest('Cargo.lock', '[[package]]\nname = "smallvec"\nversion = "1.6.0"\nsource = "x"\n').map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['crates.io:smallvec@1.6.0']);
  assert.deepEqual(readManifest('go.sum', 'golang.org/x/text v0.3.7 h1:abc=\ngolang.org/x/text v0.3.7/go.mod h1:def=\n').map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['Go:golang.org/x/text@0.3.7']);
  assert.deepEqual(readManifest('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n      x (>= 1)\n').map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['RubyGems:rack@2.0.1']);
});

test('deps: install commands name the pinned versions they add; bare names have nothing to check yet', () => {
  assert.deepEqual(installTargets('npm install lodash@4.17.15 express'), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }]);
  assert.deepEqual(installTargets('cd app && pnpm add @scope/pkg@1.2.3 -D'), [{ ecosystem: 'npm', name: '@scope/pkg', version: '1.2.3' }]);
  assert.deepEqual(installTargets('yarn add left-pad@1.3.0'), [{ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }]);
  assert.deepEqual(installTargets('pip install requests==2.19.0 rich'), [{ ecosystem: 'PyPI', name: 'requests', version: '2.19.0' }]);
  assert.deepEqual(installTargets('python -m pip install "django==3.2.1"'), [{ ecosystem: 'PyPI', name: 'django', version: '3.2.1' }]);
  assert.deepEqual(installTargets('cargo add smallvec@1.6.0'), [{ ecosystem: 'crates.io', name: 'smallvec', version: '1.6.0' }]);
  assert.deepEqual(installTargets('go get golang.org/x/text@v0.3.7'), [{ ecosystem: 'Go', name: 'golang.org/x/text', version: '0.3.7' }]);
  assert.deepEqual(installTargets('gem install rack -v 2.0.1'), [{ ecosystem: 'RubyGems', name: 'rack', version: '2.0.1' }]);
  assert.deepEqual(installTargets('npm install'), []);
  assert.deepEqual(installTargets('npm test'), []);
  assert.equal(isInstallCommand('npm i lodash'), true);
  assert.equal(isInstallCommand('echo npm-install-notes'), false);
});

// ------------------------------------------------------------------------------------------------
// 4. OSV.dev client (a local fake; the real API is never called in tests)
// ------------------------------------------------------------------------------------------------

test('OSV: batch query, then details; severity and fixed version; cached for 6 hours (no second request)', async (t) => {
  const osv = await fakeOsv(t);
  const { app, clock } = setup(t, { osv: osv.url });
  const client = app.security!.osv;
  const pkgs = [{ ecosystem: 'npm' as const, name: 'lodash', version: '4.17.15' }, { ecosystem: 'npm' as const, name: 'lodash', version: '4.17.21' }, { ecosystem: 'PyPI' as const, name: 'requests', version: '2.19.0' }];
  const v = await client.check(pkgs);
  const lod = v.get('npm|lodash|4.17.15')!;
  assert.equal(lod.status, 'vulnerable');
  assert.deepEqual(lod.vulns.map((x) => x.id), ['GHSA-p6mc-m468-83gw', 'GHSA-29mw-wpgm-hmr9']);
  assert.equal(lod.vulns[0].severity, 'high');
  assert.equal(lod.vulns[0].fixed, '4.17.19');
  assert.equal(lod.vulns[1].severity, 'medium');
  assert.equal(v.get('npm|lodash|4.17.21')!.status, 'clean');
  assert.equal(v.get('PyPI|requests|2.19.0')!.vulns[0].fixed, '2.20.0');
  assert.deepEqual(osv.log.filter((l) => l.path === '/v1/querybatch').map((l) => l.queries), [3], 'one batch');
  assert.equal(osv.log.filter((l) => l.path.startsWith('/v1/vulns/')).length, 3, 'details once per id');
  // Within the TTL: no request at all.
  const before = osv.log.length;
  clock.now = new Date(NOW.getTime() + 5 * 3600_000);
  assert.equal((await client.check(pkgs)).get('npm|lodash|4.17.15')!.fromCache, true);
  assert.equal(osv.log.length, before, 'the second check within 6 hours makes no request');
  // After it: asked again (details are cached for a day, so only the batch goes out).
  clock.now = new Date(NOW.getTime() + 7 * 3600_000);
  await client.check(pkgs);
  assert.equal(osv.log.filter((l) => l.path === '/v1/querybatch').length, 2);
  assert.equal(osv.log.length, before + 1);
  assert.equal(osvSeverity({ database_specific: { severity: 'CRITICAL' } }), 'high');
  assert.equal(fixedVersion({ affected: [{ package: { name: 'x' }, ranges: [{ events: [{ fixed: '1.2.4' }] }] }] }, { ecosystem: 'npm', name: 'x', version: '1.2.3' }), '1.2.4');
});

test('OSV: never more than 50 packages a call, and one request in flight at a time (even with checks running together)', async (t) => {
  const osv = await fakeOsv(t, { delayMs: 30 });
  const { app } = setup(t, { osv: osv.url });
  const many = Array.from({ length: 120 }, (_, i) => ({ ecosystem: 'npm' as const, name: `pkg-${i}`, version: '1.0.0' }));
  const more = Array.from({ length: 30 }, (_, i) => ({ ecosystem: 'PyPI' as const, name: `py-${i}`, version: '1.0.0' }));
  await Promise.all([app.security!.osv.check(many), app.security!.osv.check(more)]);
  const sizes = osv.log.filter((l) => l.path === '/v1/querybatch').map((l) => l.queries!);
  assert.deepEqual([...sizes].sort((a, b) => a - b), [20, 30, 50, 50]);
  assert.equal(osv.stats().maxInFlight, 1, 'the server never saw two requests at once');
  assert.equal(app.security!.osv.stats.maxInFlight, 1);
});

test('OSV: offline = "not checked: offline" (nothing cached; stale verdicts still apply); errors are cached an hour', async (t) => {
  const osv = await fakeOsv(t);
  const { app, clock } = setup(t, { osv: osv.url });
  const client = app.security!.osv;
  const lodash = { ecosystem: 'npm' as const, name: 'lodash', version: '4.17.15' };
  await client.check([lodash]);
  await osv.close();
  clock.now = new Date(NOW.getTime() + 8 * 3600_000);
  const v = await client.check([lodash, { ecosystem: 'npm', name: 'never-seen', version: '1.0.0' }]);
  assert.equal(v.get('npm|lodash|4.17.15')!.status, 'vulnerable', 'the old verdict still applies offline');
  assert.equal(v.get('npm|lodash|4.17.15')!.stale, true);
  assert.equal(v.get('npm|never-seen|1.0.0')!.status, 'unknown');
  assert.equal(v.get('npm|never-seen|1.0.0')!.reason, 'offline');
  assert.equal(client.peek({ ecosystem: 'npm', name: 'never-seen', version: '1.0.0' }), undefined, 'offline answers are not cached');
  // A service error (5xx) is cached for an hour, then asked again.
  const failing = await fakeOsv(t, { failStatus: 503 });
  const c2 = new OsvClient(app.store.db, { baseUrl: failing.url, now: () => clock.now });
  const e = await c2.check([{ ecosystem: 'npm', name: 'flaky', version: '1.0.0' }]);
  assert.equal(e.get('npm|flaky|1.0.0')!.reason, 'error');
  await c2.check([{ ecosystem: 'npm', name: 'flaky', version: '1.0.0' }]);
  assert.equal(failing.log.length, 1, 'within the hour: from the cache');
});

test('OSV: private local mode sends nothing; switched off and private conversations never reach the client', async (t) => {
  const osv = await fakeOsv(t);
  const { app, ws, conv } = setup(t, { osv: osv.url, advisories: true });
  setPrivateLocal(true);
  const v = await app.security!.osv.check([{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }]);
  assert.equal(v.get('npm|lodash|4.17.15')!.reason, 'offline');
  setPrivateLocal(false);
  assert.equal(osv.log.length, 0, 'private local mode: no request');
  // The pass with advisories off, and in a private conversation: the lockfile is never sent.
  writeFileSync(join(ws, 'requirements.txt'), 'requests==2.19.0\n');
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), advisories: false } });
  const off = await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['requirements.txt'], reason: 'ask', private: false });
  assert.equal(off.advisories.note, 'off');
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), advisories: true } });
  const priv = await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['requirements.txt'], reason: 'ask', private: true });
  assert.equal(priv.advisories.note, 'private');
  assert.equal(osv.log.length, 0, 'nothing reached OSV');
  // Switched on, not private: the lockfile is checked and the finding quotes its real line.
  const on = await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['requirements.txt'], reason: 'ask', private: false });
  assert.equal(on.advisories.vulnerable, 1);
  const f = app.findings!.list({ source: 'advisory' })[0];
  assert.equal(f.file, 'requirements.txt');
  assert.equal(f.quote, 'requests==2.19.0');
  assert.match(f.advice, /2\.20\.0/);
  assert.equal(securitySettings({}).advisories, false, 'off by default (§7 #2)');
});

// ------------------------------------------------------------------------------------------------
// 5. The install-time check ("Known vulnerability" card, explicit override, recorded)
// ------------------------------------------------------------------------------------------------

test('install check: a known-vulnerable pinned install stops with the card; Install anyway is recorded; no stops nothing runs', async (t) => {
  const osv = await fakeOsv(t);
  const { app, conv } = setup(t, { osv: osv.url, advisories: true, mode: 'off' });
  // The sandbox gate (M5) has its own tests; here the stand-in shell runs directly.
  app.sandboxGate = undefined;
  const ran: string[] = [];
  fakeShell(app, ran);
  // 1. Said no: the command never runs; she reads why; a dismissed finding.
  app.script.push([call('c1', 'shell', { command: 'npm install lodash@4.17.15' })], text('Ok, I will pick 4.17.21.'));
  let card: Approval | undefined;
  const ev1 = await drain(runTurn(app, conv.id, 'add lodash'), (ev) => {
    card = ev;
    app.approvals.decide(ev.approvalId, false, 'deny');
  });
  assert.ok(card?.advisory, 'the Known vulnerability card');
  assert.equal(card!.advisory!.packages[0].name, 'lodash');
  assert.equal(card!.advisory!.packages[0].severity, 'high');
  assert.deepEqual(ran, [], 'not installed');
  const tool1 = app.store.messages(conv.id).filter((m) => m.role === 'tool').at(-1)!;
  assert.match(tool1.content, /Not installed: known vulnerabilities/);
  assert.match(tool1.content, /4\.17\.19/);
  assert.equal((tool1.meta?.advisory as { answer: string }).answer, 'deny');
  assert.ok(ev1.some((e) => e.type === 'advisory' && e.state === 'declined'));
  let rows = app.findings!.list({ source: 'advisory', status: 'all' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'dismissed');
  // 2. Install anyway: an explicit override, then it runs; recorded as accepted with the reason.
  app.script.push([call('c2', 'shell', { command: 'npm install lodash@4.17.15' })], text('Installed.'));
  await drain(runTurn(app, conv.id, 'install it anyway'), (ev) => app.approvals.decide(ev.approvalId, true, 'override'));
  assert.deepEqual(ran, ['npm install lodash@4.17.15']);
  rows = app.findings!.list({ source: 'advisory', status: 'all' });
  assert.equal(rows.length, 2, 'each decision is its own row');
  assert.equal(rows.find((r) => r.status === 'accepted')!.reason, 'Installed anyway (your override on the approval card)');
  // 3. A clean version: no card.
  app.script.push([call('c3', 'shell', { command: 'npm install lodash@4.17.21' })], text('Done.'));
  let asked = false;
  await drain(runTurn(app, conv.id, 'use the fixed one'), () => (asked = true));
  assert.equal(asked, false);
  assert.equal(ran.length, 2);
  // 4. Offline: not checked, said so, goes on (no block on a guess).
  await osv.close();
  app.security!.osv.clearCache();
  app.script.push([call('c4', 'shell', { command: 'pip install requests==2.19.0' })], text('Done.'));
  const ev4 = await drain(runTurn(app, conv.id, 'add requests'));
  assert.ok(ev4.some((e) => e.type === 'advisory' && e.state === 'offline' && e.packages[0] === 'requests 2.19.0'));
  assert.equal(ran.length, 3);
});

test('install check: never in private conversations, never when advisories are off; "never" stays never', async (t) => {
  const osv = await fakeOsv(t);
  const { app } = setup(t, { osv: osv.url, advisories: true, mode: 'off' });
  app.sandboxGate = undefined;
  const ran: string[] = [];
  fakeShell(app, ran);
  const priv = app.store.createConversation({ mode: 'coding', private: true });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'm' });
  app.script.push([call('c1', 'shell', { command: 'npm install lodash@4.17.15' })], text('Done.'));
  await drain(runTurn(app, priv.id, 'add lodash'), () => assert.fail('no card in a private conversation'));
  assert.equal(osv.log.length, 0, 'nothing sent from a private conversation');
  // Off: nothing sent.
  const conv = app.store.createConversation({ mode: 'coding' });
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), advisories: false } });
  app.script.push([call('c2', 'shell', { command: 'npm install lodash@4.17.15' })], text('Done.'));
  await drain(runTurn(app, conv.id, 'add lodash'), () => assert.fail('no card when off'));
  assert.equal(osv.log.length, 0);
  // A tool set to never is refused before any check.
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), advisories: true }, toolPermissions: { shell: 'never' } });
  app.script.push([call('c3', 'shell', { command: 'npm install lodash@4.17.15' })], text('Ok.'));
  await drain(runTurn(app, conv.id, 'add lodash'), () => assert.fail('never stays never'));
  assert.equal(osv.log.length, 0);
  assert.equal(ran.length, 2);
});

// ------------------------------------------------------------------------------------------------
// 6. The pass after a coding turn, with the Reviewing model
// ------------------------------------------------------------------------------------------------

test('pass: after a coding turn that changed files: code checks + the Reviewing model (quotes validated) on the findings table', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: true });
  git(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'app.js'), "const express = require('express');\nconst app = express();\n");
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'init');
  // Her turn writes a vulnerable route (the file tool), then the reviewer looks.
  const writeTool: Tool = {
    spec: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    defaultPermission: 'auto',
    summarize: (a) => `write ${String(a.path)}`,
    async run(a, ctx) {
      writeFileSync(join(ctx.workspaceDir, String(a.path)), String(a.content));
      return 'written';
    },
  };
  app.tools.add(writeTool);
  const code = "const express = require('express');\nconst app = express();\napp.get('/user', (req, res) => {\n  db.query(\"SELECT * FROM users WHERE id = \" + req.query.id, (e, rows) => res.json(rows));\n});\napp.get('/greet', (req, res) => res.send('<h1>Hi ' + req.query.name + '</h1>'));\n";
  // The Reviewing route is unset: it falls back to Coding (provider q).
  app.settings.update({ routes: { coding: { providerId: 'q', model: 'coder' } } });
  assert.equal(resolveChain(app, conv, 'review')[0].provider.config.id, 'q', 'Reviewing falls back to Coding');
  app.script.push([call('w1', 'write_file', { path: 'app.js', content: code })], text('Added the routes.'));
  // The reviewer's answer: one real quote, one invented, one about a file not in the change.
  app.script.push(
    text(
      JSON.stringify({
        findings: [
          { file: 'app.js', line: 6, quote: "res.send('<h1>Hi ' + req.query.name + '</h1>')", rule: 'reflected-xss', severity: 'high', title: 'Reflects the name into HTML', advice: 'Escape it.' },
          { file: 'app.js', line: 3, quote: 'app.use(bodyParser.urlencoded({ extended: true }))', rule: 'invented', severity: 'high', title: 'Invented line', advice: '' },
          { file: 'other.js', line: 1, quote: 'whatever is in there', rule: 'elsewhere', severity: 'low', title: 'Not in this change', advice: '' },
        ],
      }),
    ),
  );
  await drain(runTurn(app, conv.id, 'add a user route'));
  const sum = await app.security!.last;
  assert.ok(sum, 'the pass ran after the final reply');
  assert.equal(sum!.reason, 'turn');
  assert.deepEqual(sum!.files, 1);
  const rows = app.findings!.list({ workspace: conv.workspace });
  const sql = rows.find((r) => r.rule === 'sql-string')!;
  assert.equal(sql.file, 'app.js');
  assert.equal(sql.line, 4);
  assert.equal(sql.origin, 'code');
  const xss = rows.find((r) => r.rule === 'review:reflected-xss')!;
  assert.equal(xss.origin, 'model');
  assert.equal(xss.line, 6);
  assert.ok(!rows.some((r) => r.rule === 'review:invented' || r.rule === 'review:elsewhere'), 'the invented and out-of-change findings were dropped');
  assert.equal(sum!.reviewer.added, 1);
  assert.equal(sum!.reviewer.dropped, 1, 'the invented quote');
  // The reviewer saw the code findings as context and the diff.
  const reviewReq = app.requests.at(-1)!;
  assert.match(String(reviewReq.messages[1].content), /\[sql-string\]/);
  assert.match(String(reviewReq.messages[1].content), /\+app\.get\('\/user'/);
  // The reply knows its pass; the pass is its own run.
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.deepEqual((reply.meta?.security as { ids: number[] }).ids.sort(), [sql.id, xss.id].sort());
  const run = app.runs!.get(sum!.runId!)!;
  assert.equal(run.kind, 'security');
  // A second pass over the same code doesn't double the findings.
  await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['app.js'], reason: 'ask', private: false });
  assert.equal(app.findings!.list({ workspace: conv.workspace }).filter((r) => r.rule === 'sql-string').length, 1);
});

test('pass: never in everyday chats; "Only when I ask" and "Off" start nothing after a turn; no change = no pass', async (t) => {
  const { app, ws, conv } = setup(t, { mode: 'ask' });
  const writeTool: Tool = {
    spec: { name: 'write_file', description: 'Write', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: () => 'write',
    async run(a, ctx) {
      writeFileSync(join(ctx.workspaceDir, String(a.path)), String(a.content));
      return 'ok';
    },
  };
  app.tools.add(writeTool);
  app.script.push([call('w', 'write_file', { path: 'a.py', content: 'r = requests.get(u, verify=False)\n' })], text('Done.'));
  await drain(runTurn(app, conv.id, 'write it'));
  assert.equal(app.security!.last, undefined, 'only when asked');
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), mode: 'after' } });
  const chat = app.store.createConversation({});
  writeFileSync(join(workspaceDir(app.dataDir, chat.workspace), 'b.py'), 'x = 1\n');
  app.script.push([call('w2', 'write_file', { path: 'b.py', content: 'r = requests.get(u, verify=False)\n' })], text('Done.'));
  await drain(runTurn(app, chat.id, 'write it'));
  assert.equal(app.security!.last, undefined, 'never in an everyday chat');
  app.script.push(text('Just talking.'));
  await drain(runTurn(app, conv.id, 'how are you'));
  assert.equal(app.security!.last, undefined, 'nothing changed: no pass');
  // "Check now" still works in Only-when-I-ask mode.
  const s = await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: app.security!.filesToCheck(ws), reason: 'ask', private: false });
  assert.equal(s.counts.high, 2, 'both files in the workspace (the chat shares it)');
});

test('pass: the reviewer has its own small budget (never past it) and a private conversation reviews only on a local model', async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: true });
  writeFileSync(join(ws, 'big.js'), `${'// filler line to make the diff large\n'.repeat(4000)}eval(req.query.x);\n`);
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), budgetTokens: 10_000 } });
  app.script.push(text('{"findings":[]}'));
  const s = await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['big.js'], reason: 'ask', private: false });
  assert.equal(s.reviewer.ran, true);
  // What was sent (the prompt) plus the most it may answer fits the 10k budget: the diff was cut.
  const req = app.requests.at(-1)!;
  const promptTokens = Math.ceil(req.messages.reduce((n, m) => n + String(m.content).length, 0) / 3.5);
  assert.ok(promptTokens + (req.maxTokens ?? 0) <= 10_000, `${promptTokens} + ${req.maxTokens}`);
  assert.match(String(req.messages[1].content), /diff cut at/);
  assert.equal(s.counts.high, 1, 'the code checks still ran');
  const calls = app.requests.length;
  // Private: the cloud default can't review.
  const priv = app.store.createConversation({ mode: 'coding', private: true });
  writeFileSync(join(workspaceDir(app.dataDir, priv.workspace), 'a.js'), 'eval(req.query.x);\n');
  const p = await app.security!.run({ conversationId: priv.id, workspace: priv.workspace, wsDir: workspaceDir(app.dataDir, priv.workspace), files: ['a.js'], reason: 'ask', private: true });
  assert.equal(p.reviewer.ran, false);
  assert.match(String(p.reviewer.note), /error|no model/);
  assert.equal(app.requests.length, calls);
});

// ------------------------------------------------------------------------------------------------
// 7. The fix-branch loop, end to end on a temp git repo with a fake model
// ------------------------------------------------------------------------------------------------

function fixRepo(ws: string): string {
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node test.js' } }, null, 2));
  writeFileSync(join(ws, 'db.js'), "exports.find = (db, id) => db.query('SELECT 1');\n");
  writeFileSync(join(ws, 'test.js'), "const { find } = require('./db.js');\nlet sql;\nfind({ query: (q, p) => (sql = [q, p]) }, 7);\nif (!sql) { console.error('no query'); process.exit(1); }\nconsole.log('tests pass');\n");
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'init');
  // The owner's uncommitted work: a vulnerable change (the pass finds it), plus another file.
  writeFileSync(join(ws, 'db.js'), 'exports.find = (db, id) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  writeFileSync(join(ws, 'notes.txt'), 'my notes\n');
  // A bare "remote" to prove nothing is ever pushed.
  const remote = `${ws}-remote.git`;
  spawnSync('git', ['init', '-q', '--bare', remote]);
  git(ws, 'remote', 'add', 'origin', remote);
  return remote;
}

test('fix loop: branch in a worktree, the owner\'s branch untouched, re-check, tests re-run in a sandbox copy, Apply', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t);
  const remote = fixRepo(ws);
  const headBefore = git(ws, 'rev-parse', 'HEAD');
  const statusBefore = git(ws, 'status', '--porcelain');
  const dbBefore = readFileSync(join(ws, 'db.js'), 'utf8');
  await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['db.js'], reason: 'ask', private: false });
  const f = app.findings!.list({ workspace: conv.workspace, source: 'security' }).find((x) => x.rule === 'sql-string')!;
  assert.ok(f, 'the pass found the string-built SQL');
  gitLog.length = 0;
  // The fake Coding model's fix (exact find/replace on that file).
  app.script.push(text(JSON.stringify({ edits: [{ find: 'db.query("SELECT * FROM users WHERE id = " + id)', replace: "db.query('SELECT * FROM users WHERE id = ?', [id])" }], note: 'Used a placeholder.' })));
  const started = app.fixes!.start(f.id);
  assert.equal(started.fix!.state, 'working');
  assert.equal(started.fixBranch, `sara/fix-${f.id}`);
  const done = (await app.fixes!.running.get(f.id)!.promise)!;
  assert.equal(done.fix!.state, 'ready', done.fix!.error);
  assert.equal(done.fix!.recheck!.fixed, true);
  assert.deepEqual([done.fix!.recheck!.before, done.fix!.recheck!.after], [1, 0]);
  assert.equal(done.fix!.tests!.command, 'npm test');
  assert.equal(done.fix!.tests!.ran, true);
  assert.equal(done.fix!.tests!.exitCode, 0, done.fix!.tests!.output);
  assert.match(done.fix!.tests!.output, /tests pass/);
  assert.match(done.fix!.diff!, /-exports\.find = \(db, id\) => db\.query\("SELECT \* FROM users WHERE id = " \+ id\);/);
  assert.match(done.fix!.diff!, /\+exports\.find = \(db, id\) => db\.query\('SELECT \* FROM users WHERE id = \?', \[id\]\);/);
  assert.deepEqual(done.fix!.files, ['db.js']);
  // The prompt named only this finding and asked for only its fix.
  const req = app.requests.at(-1)!;
  assert.match(String(req.messages[0].content), /ONE security finding in ONE file/);
  assert.match(String(req.messages[1].content), new RegExp(`Finding #${f.id} \\(sql-string\\)`));
  // The owner's branch, HEAD, index and files did not change; the branch exists locally only.
  assert.equal(git(ws, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(ws, 'status', '--porcelain'), statusBefore);
  assert.equal(readFileSync(join(ws, 'db.js'), 'utf8'), dbBefore);
  assert.ok(git(ws, 'branch', '--list', `sara/fix-${f.id}`).includes(`sara/fix-${f.id}`));
  assert.match(git(ws, 'log', '--format=%s', `sara/fix-${f.id}`, '-2'), /fix finding #\d+[\s\S]*your uncommitted changes/);
  // Apply to my branch: only the fix's file is written; the finding is fixed; the branch goes.
  const applied = app.fixes!.apply(f.id);
  assert.equal(applied.status, 'fixed');
  assert.deepEqual(applied.fix!.applied!.written, ['db.js']);
  assert.match(readFileSync(join(ws, 'db.js'), 'utf8'), /WHERE id = \?', \[id\]/);
  assert.equal(readFileSync(join(ws, 'notes.txt'), 'utf8'), 'my notes\n', 'other files untouched');
  assert.equal(git(ws, 'rev-parse', 'HEAD'), headBefore, 'nothing committed on the owner\'s branch');
  assert.equal(git(ws, 'branch', '--list', `sara/fix-${f.id}`), '');
  // Never pushed: the remote has no refs; no push was ever attempted.
  assert.equal(spawnSync('git', ['ls-remote', remote], { encoding: 'utf8' }).stdout.trim(), '');
  assert.ok(!gitLog.some((a) => a.includes('push') || a.includes('fetch') || a.includes('remote')), JSON.stringify(gitLog));
});

test('fix loop: Keep the branch (worktree goes, branch stays), Discard (both go), a conflict is never overwritten, a failed fix says why', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t);
  fixRepo(ws);
  writeFileSync(join(ws, 'net.js'), "const agent = new https.Agent({ rejectUnauthorized: false });\nmodule.exports = agent;\n");
  writeFileSync(join(ws, 'auth.js'), "const crypto = require('crypto');\nexports.hash = (password) => crypto.createHash('md5').update(password).digest('hex');\n");
  await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['db.js', 'net.js', 'auth.js'], reason: 'ask', private: false });
  const byRule = (r: string) => app.findings!.list({ workspace: conv.workspace }).find((x) => x.rule === r)!;
  // Keep.
  app.script.push(text(JSON.stringify({ edits: [{ find: 'rejectUnauthorized: false', replace: 'rejectUnauthorized: true' }] })));
  const tls = byRule('tls-off');
  app.fixes!.start(tls.id);
  const ready = (await app.fixes!.running.get(tls.id)!.promise)!;
  assert.equal(ready.fix!.state, 'ready');
  const kept = app.fixes!.keep(tls.id);
  assert.equal(kept.fix!.state, 'kept');
  assert.equal(kept.status, 'open');
  assert.ok(git(ws, 'branch', '--list', kept.fixBranch!).includes(kept.fixBranch!), 'the branch stays');
  assert.ok(!git(ws, 'worktree', 'list').includes('fix-branches'), 'the worktree went');
  assert.match(readFileSync(join(ws, 'net.js'), 'utf8'), /rejectUnauthorized: false/, 'the owner\'s file unchanged');
  // Discard a kept branch: it goes.
  app.fixes!.discard(tls.id);
  assert.equal(git(ws, 'branch', '--list', kept.fixBranch!), '');
  assert.equal(app.findings!.get(tls.id)!.status, 'open');
  // A conflict: the owner changed the file meanwhile; Apply refuses to overwrite it.
  app.script.push(text(JSON.stringify({ edits: [{ find: "createHash('md5')", replace: "createHash('sha256')" }] })));
  const md5 = byRule('weak-crypto');
  app.fixes!.start(md5.id);
  await app.fixes!.running.get(md5.id)!.promise;
  writeFileSync(join(ws, 'auth.js'), "// edited by Alex meanwhile\nconst crypto = require('crypto');\n");
  assert.throws(() => app.fixes!.apply(md5.id), /changed since the fix started/);
  assert.match(readFileSync(join(ws, 'auth.js'), 'utf8'), /edited by Alex/);
  app.fixes!.discard(md5.id);
  // A fix the model can't make: two tries, then "failed" with the reason; nothing left behind.
  const sql = byRule('sql-string');
  app.script.push(text('I would rather not.'), text(JSON.stringify({ edits: [{ find: 'not in the file at all', replace: 'x' }] })));
  app.fixes!.start(sql.id);
  const failed = (await app.fixes!.running.get(sql.id)!.promise)!;
  assert.equal(failed.fix!.state, 'failed');
  assert.match(failed.fix!.error!, /isn't in the file/);
  assert.equal(failed.fix!.attempts, 2);
  assert.equal(git(ws, 'branch', '--list', 'sara/fix-*'), '');
  // Fix all high: only open, fixable high findings (the SQL one again; TLS accepted with a reason).
  app.findings!.setStatus(tls.id, 'accepted', 'Local test server only');
  app.script.push(text(JSON.stringify({ edits: [{ find: '" + id)', replace: '?", [id])' }] })));
  const all = app.fixes!.startAll(conv.workspace);
  assert.deepEqual(all.started, [sql.id]);
  await app.fixes!.running.get(sql.id)!.promise;
});

test('fix loop: its budget stops it (no model call past it); a non-git workspace and dependency findings are refused plainly', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t);
  fixRepo(ws);
  await app.security!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, files: ['db.js'], reason: 'ask', private: false });
  const f = app.findings!.list({ workspace: conv.workspace }).find((x) => x.rule === 'sql-string')!;
  // The first try spends most of the 10k budget (a model that reports its usage): no second call.
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), budgetTokens: 10_000 } });
  app.script.push([{ type: 'text', text: 'Thinking about it…' }, { type: 'usage', input: 9200, output: 600 }], text('{"edits":[]}'));
  const calls = app.requests.length;
  app.fixes!.start(f.id);
  const r = (await app.fixes!.running.get(f.id)!.promise)!;
  assert.equal(r.fix!.state, 'failed');
  assert.match(r.fix!.error!, /budget/);
  assert.equal(app.requests.length, calls + 1, 'one call, none past the budget');
  app.script.length = 0;
  // Refusals in plain words.
  const adv = app.findings!.add([{ source: 'advisory', severity: 'high', rule: 'known-vulnerability', title: 'x', advice: '', file: 'package-lock.json', line: 1, quote: '"node_modules/lodash": {' }], { workspace: conv.workspace })[0];
  assert.match(app.fixes!.why(adv)!, /upgrading the package/);
  const pf = app.findings!.add([{ source: 'security', severity: 'high', rule: 'tls-off', title: 'x', advice: '', file: 'a.js', line: 1, quote: 'rejectUnauthorized: false' }], { workspace: 'plain-folder' })[0];
  assert.match(app.fixes!.why(pf)!, /git repository/);
});

test('fix loop helpers: edits must match exactly once; tests are found from the project files', (t) => {
  assert.deepEqual(applyEdits('a\nb\n', [{ find: 'b', replace: 'c' }]), { text: 'a\nc\n' });
  assert.match((applyEdits('a\na\n', [{ find: 'a', replace: 'c' }]) as { error: string }).error, /more than once/);
  assert.match((applyEdits('a\n', [{ find: 'zz', replace: 'c' }]) as { error: string }).error, /isn't in the file/);
  assert.deepEqual(applyEdits('x = 1\r\ny = 2\r\n', [{ find: 'x = 1\ny = 2', replace: 'x = 3\ny = 4' }]), { text: 'x = 3\r\ny = 4\r\n' }, 'CRLF files');
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}');
  assert.equal(detectTests(dir), undefined, 'npm\'s placeholder is not a test');
  writeFileSync(join(dir, 'go.mod'), 'module x\n');
  assert.equal(detectTests(dir), 'go test ./...');
});

// ------------------------------------------------------------------------------------------------
// 8. The findings table: M2 / M5 rows, routes, filters, dismiss / accept with a reason
// ------------------------------------------------------------------------------------------------

test('table: plan-check stops (M2) and sandbox observations (M5) also become rows, with the owner\'s answer as status', (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const store = new FindingStore(app.store.db, () => NOW);
  const rows = recordTurnFindings(
    store,
    {
      contradictions: [{ source: 'contradiction', rule: 'push-branch', title: 'Goes against: never push to main', advice: 'Push to a branch.', act: 'stop', answer: 'override', quote: 'never push to main', note: 'Alex never pushes to main', memoryId: 4 }],
      sandbox: { id: 's1', command: 'rm -rf build', decision: 'discarded', findings: [{ severity: 'high', rule: 'mass-delete', title: 'Deleted many files', advice: 'x', files: ['a', 'b'] }, { severity: 'info', rule: 'not-isolated', title: 'Not isolated', advice: 'x' }] },
    },
    { conversationId: null, workspace: 'w', runId: 3, step: 1 },
  );
  assert.deepEqual(rows.map((r) => `${r.source}:${r.rule}:${r.status}`), ['contradiction:contradiction:push-branch:accepted', 'sandbox:sandbox:mass-delete:dismissed']);
  assert.equal(rows[0].runId, 3);
  assert.equal(rows[0].reason, 'Do it anyway (your override on the card)');
});

test('routes: findings per project and per run, filters, dismiss/accept need a reason, fix routes; settings with the package preview', { skip: !HAS_GIT }, async (t) => {
  const { app, dir, ws, conv } = setup(t);
  fixRepo(ws);
  writeFileSync(join(ws, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.15' } } }, null, 2));
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
  // Settings: defaults, then the package list shown before switching advisories on.
  const g = await api('/api/security-pass?preview=1');
  assert.equal(g.json.mode, 'after');
  assert.equal(g.json.advisories, false);
  assert.ok((g.json.preview as { name: string; version: string }[]).some((p) => p.name === 'lodash' && p.version === '4.17.15'), 'the list that would be sent');
  assert.equal((await api('/api/security-pass', 'PUT', { mode: 'ask', reviewer: true, budgetTokens: 100_000 })).json.mode, 'ask');
  assert.equal(app.settings.get().securityPass?.budgetTokens, 100_000);
  assert.equal((await api('/api/security-pass', 'PUT', { mode: 'sometimes' })).json.mode, 'ask', 'an unknown mode keeps the saved one');
  // Check now (Only when I ask), then the list with filters.
  const scan = await api('/api/findings/scan', 'POST', { conversationId: conv.id });
  assert.equal(scan.status, 200);
  const list = await api(`/api/findings?workspace=${conv.workspace}`);
  const findings = list.json.findings as { id: number; rule: string; canFix: boolean; runId: number }[];
  const sql = findings.find((f) => f.rule === 'sql-string')!;
  assert.equal(sql.canFix, true);
  assert.equal(((await api(`/api/findings?runId=${sql.runId}`)).json.findings as unknown[]).length, findings.length, 'per run');
  assert.equal(((await api('/api/findings?severity=low')).json.findings as unknown[]).length, 0);
  assert.equal(((await api(`/api/findings?conversationId=${conv.id}`)).json.findings as unknown[]).length, findings.length);
  // Dismiss needs a reason; with one it is kept; reopen.
  assert.equal((await api(`/api/findings/${sql.id}/status`, 'POST', { status: 'dismissed' })).status, 400);
  const d = await api(`/api/findings/${sql.id}/status`, 'POST', { status: 'dismissed', reason: 'Test code only' });
  assert.equal((d.json.finding as { reason: string }).reason, 'Test code only');
  assert.equal(((await api(`/api/findings?workspace=${conv.workspace}`)).json.findings as unknown[]).length, findings.length - 1, 'open by default');
  assert.equal(((await api(`/api/findings?workspace=${conv.workspace}&status=dismissed`)).json.findings as unknown[]).length, 1);
  assert.equal((await api(`/api/findings/${sql.id}/status`, 'POST', { status: 'fixed', reason: 'x' })).status, 400, 'fixed only comes from a fix');
  await api(`/api/findings/${sql.id}/status`, 'POST', { status: 'open' });
  // Fix routes.
  app.script.push(text(JSON.stringify({ edits: [{ find: '" + id)', replace: '?", [id])' }] })));
  const fx = await api(`/api/findings/${sql.id}/fix`, 'POST', {});
  assert.equal(fx.status, 202);
  await app.fixes!.running.get(sql.id)!.promise;
  assert.equal(((await api(`/api/findings/${sql.id}`)).json.finding as { fix: { state: string } }).fix.state, 'ready');
  assert.equal((await api(`/api/findings/${sql.id}/fix/discard`, 'POST', {})).status, 200);
  assert.equal((await api(`/api/findings/${sql.id}/fix/apply`, 'POST', {})).status, 409);
  assert.equal((await api('/api/findings/99999', 'GET')).status, 404);
  assert.equal((await api('/api/findings/fix-all', 'POST', { workspace: '../x' })).status, 400);
});

// ------------------------------------------------------------------------------------------------
// 9. Settings, model job, UI files, docs
// ------------------------------------------------------------------------------------------------

test('Reviewing: a model job of its own that falls back to Coding; listed in Which model does what', async () => {
  const { JOBS } = await import('../src/modelpicks.ts');
  assert.ok(JOBS.some((j) => j.id === 'review' && j.label === 'Reviewing'));
  const { ROUTE_PURPOSES } = await import('../src/settings.ts');
  assert.ok(ROUTE_PURPOSES.includes('review'));
  assert.deepEqual(securitySettings({}), { mode: 'after', reviewer: true, advisories: false, budgetTokens: 30_000, runTests: true });
});

test('eval: the deterministic pass keeps its bar on both sample sets (scripts/eval-security.ts)', async () => {
  const { runEval } = await import('../scripts/eval-security.ts');
  const tuning = runEval('tuning');
  const held = runEval('held-out');
  assert.ok(tuning.precision >= 0.9 && tuning.recall >= 0.85, JSON.stringify(tuning));
  assert.ok(held.precision >= 0.85 && held.recall >= 0.85, JSON.stringify(held));
});

test('UI: tips (≤ 260 characters, guide anchors), translations, findings view without inline styles, service worker cache', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const tips = JSON.parse(web('tips.json')).tips as Record<string, [string, string]>;
  const help = web('help.html');
  for (const id of ['sec-mode', 'sec-reviewer', 'sec-advisories', 'sec-budget', 'sec-tests', 'fnd-ws', 'fnd-status', 'fnd-severity', 'fnd-source']) {
    assert.ok(tips[id], id);
    assert.ok(tips[id][0].length <= 260, `${id} tip too long`);
    assert.ok(help.includes(`id="${tips[id][1]}"`), `guide section ${tips[id][1]}`);
    assert.ok(web('index.html').includes(`id="${id}"`), id);
  }
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Findings', 'Known vulnerability: install anyway?', 'Apply to my branch', 'Keep the branch', 'Fix on a branch', 'Security pass', 'Reviewing']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.notEqual(d[k], k, `${lang}: ${k} is translated`);
    }
  }
  const view = web('findings-view.js');
  assert.doesNotMatch(view, /style=|\.style\./, 'no inline styles');
  // The changed front-end files parse as ES modules (a duplicate top-level name only fails there).
  const { dir, cleanup } = tempDir();
  try {
    for (const f of ['app.js', 'findings-view.js', 'nav.js', 'icons.js']) {
      const copy = join(dir, f.replace(/\.js$/, '.mjs'));
      writeFileSync(copy, web(f));
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v14'\)[\s\S]*sara-shell-v13 from Phase 80/);
  assert.ok(existsSync(join(ROOT, 'web', 'findings-view.js')));
});
