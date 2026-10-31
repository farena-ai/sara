// Phase 82 (harness track M7, docs/design/HARNESS_TRACK.md §3 M7): the threat model after coding
// turns and its fix-only second pass.
// - entry points and sinks per framework (Express, Koa, node:http, Flask, FastAPI, Django, Go
//   net/http, gin, message handlers, uploads, the command line): true positives and guarded near
//   misses; the walk follows calls across files and is bounded;
// - the "no theater" rule at both ends: invented sink or entry quotes and threats without a path are
//   dropped; the Reviewing model may only add threats on an entry point the code listed;
// - the summary per project in the data folder; the reply's card data;
// - the SECOND pass on a temp git repo with a fake model: only the threats, edits limited to the
//   threats' regions, the threat rule as the re-check, tests in a sandbox copy, one diff, Apply,
//   never a push; budgets stop it; it is never started by itself;
// - settings, routes, member isolation; UI files, translations, tips, service worker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { OWNER_SETTINGS } from '../src/household.ts';
import { RunStore } from '../src/runs.ts';
import { SandboxGate, sandboxGateSettings, type Isolation } from '../src/sandbox-run.ts';
import { OsvClient } from '../src/security/advisories.ts';
import { FindingStore, type NewFinding } from '../src/security/findings.ts';
import { FixBranches, outsideRegions } from '../src/security/fix.ts';
import { gitLog } from '../src/security/git.ts';
import { SecurityPass, securitySettings } from '../src/security/pass.ts';
import { analyze, MAX_HOPS, pathLine, regionsFor, THREAT_RULES, type ThreatKind } from '../src/security/threat-graph.ts';
import { hitFinding, ThreatPass, threatSettings, validateThreats } from '../src/security/threats.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, ROOT, tempDir, text, call } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const COPY: Isolation = { driver: 'copy', isolated: false, label: 'Not isolated (test)' };
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const run = (files: Record<string, string>) => analyze(Object.keys(files), (f) => files[f]);
const kinds = (files: Record<string, string>) =>
  run(files)
    .hits.map((h) => `${h.kind}@${h.sink.file}:${h.sink.line}`)
    .sort();

// ------------------------------------------------------------------------------------------------
// 1. Entry points and sinks per framework
// ------------------------------------------------------------------------------------------------

test('express: a query value reaches a file read in another module; the guarded twins stay quiet', () => {
  const files = {
    'server.js': [
      "const express = require('express');",
      "const docs = require('./lib/docs');",
      "const { search, byId } = require('./lib/db');",
      'const app = express();',
      "app.get('/doc', (req, res) => {",
      '  const name = req.query.name;',
      '  res.send(docs.readDoc(name));',
      '});',
      "app.get('/doc2', (req, res) => res.send(docs.readSafe(req.query.name)));",
      "app.get('/doc3', (req, res) => res.send(docs.readBase(req.query.name)));",
      "app.get('/search', async (req, res) => res.json(await search(req.query.q)));",
      "app.get('/item/:id', async (req, res) => res.json(await byId(req.params.id)));",
      "app.get('/go', (req, res) => res.redirect(req.query.next));",
      "app.get('/home', (req, res) => res.redirect('/start?from=' + req.query.from));",
      "app.get('/hi', (req, res) => res.send('<h1>Hi ' + req.query.name + '</h1>'));",
      "app.get('/hi2', (req, res) => res.send('<h1>Hi ' + escapeHtml(req.query.name) + '</h1>'));",
      "app.get('/proxy', async (req, res) => res.send(await fetch(req.query.url)));",
      "app.get('/weather', async (req, res) => res.send(await fetch(`https://api.weather.example/v1?q=${req.query.city}`)));",
      "app.get('/env', (req, res) => res.json(process.env));",
      "app.get('/mode', (req, res) => res.json({ mode: process.env.NODE_ENV }));",
      'module.exports = app;',
    ].join('\n'),
    'lib/docs.js': [
      "const fs = require('fs');",
      "const path = require('path');",
      "const ROOT = path.join(__dirname, 'docs');",
      'function readDoc(name) {',
      "  return fs.readFileSync(path.join(ROOT, name), 'utf8');",
      '}',
      'function readSafe(name) {',
      '  const full = path.resolve(ROOT, name);',
      "  if (!full.startsWith(ROOT + path.sep)) throw new Error('outside');",
      "  return fs.readFileSync(full, 'utf8');",
      '}',
      'function readBase(name) {',
      "  return fs.readFileSync(path.join(ROOT, path.basename(name)), 'utf8');",
      '}',
      'module.exports = { readDoc, readSafe, readBase };',
    ].join('\n'),
    'lib/db.js': [
      "const db = require('./conn');",
      'exports.search = async (q) => {',
      '  return db.query("SELECT * FROM docs WHERE title LIKE \'%" + q + "%\'");',
      '};',
      'exports.byId = async (id) => {',
      "  return db.query('SELECT * FROM docs WHERE id = ?', [id]);",
      '};',
    ].join('\n'),
  };
  const a = run(files);
  assert.equal(a.entries.length, 13);
  assert.deepEqual(kinds(files), ['html@server.js:15', 'path@lib/docs.js:5', 'redirect@server.js:13', 'secret@server.js:19', 'sql@lib/db.js:3', 'ssrf@server.js:17']);
  const p = a.hits.find((h) => h.kind === 'path')!;
  assert.equal(p.entry.label, 'GET /doc');
  assert.equal(p.entry.quote, "app.get('/doc', (req, res) => {");
  assert.equal(p.sink.quote, "return fs.readFileSync(path.join(ROOT, name), 'utf8');");
  assert.equal(pathLine(p.path), 'GET /doc (server.js:5) → readDoc() (server.js:7) → file path (lib/docs.js:5)');
  assert.equal(p.hops, 1);
  // The guarded twins are listed as reached-but-guarded sinks.
  assert.ok(a.sinks.some((s) => s.file === 'lib/docs.js' && s.line === 10 && s.guarded));
  assert.ok(a.sinks.some((s) => s.file === 'lib/db.js' && s.line === 6 && s.guarded));
});

test('koa, node:http, uploads, message handlers and the command line', () => {
  const files = {
    'koa.js': ["const Router = require('koa-router');", "const { exec, execFile } = require('child_process');", 'const router = new Router();', "router.post('/convert', requireLogin, async (ctx) => {", "  exec('convert ' + ctx.request.body.file + ' out.png');", '});', "router.post('/log', requireLogin, async (ctx) => {", "  execFile('git', ['log', ctx.request.body.ref]);", '});'].join('\n'),
    'raw.js': ["const http = require('http');", "const { URL } = require('url');", 'http.createServer((req, res) => {', "  const u = new URL(req.url, 'http://x');", "  res.end(eval(u.searchParams.get('expr')));", '}).listen(8080);'].join('\n'),
    'upload.js': ["const express = require('express');", "const multer = require('multer');", "const fs = require('fs');", 'const app = express();', "const upload = multer({ dest: 'tmp/' });", "app.post('/avatar', requireLogin, upload.single('pic'), (req, res) => {", "  fs.writeFileSync('public/' + req.file.originalname, 'x');", '  res.end();', '});'].join('\n'),
    'ws.js': ["const vm = require('vm');", "wss.on('connection', (sock) => {", "  sock.on('message', (data) => {", '    vm.runInNewContext(String(data));', '  });', "  sock.on('message', (data) => console.log(JSON.parse(data)));", '});'].join('\n'),
    'cli.js': ["const { execSync } = require('child_process');", 'const target = process.argv[2];', "execSync('git clone ' + target);", "execSync('git status');"].join('\n'),
  };
  const a = run(files);
  const byKind = (k: string) => a.entries.filter((e) => e.kind === k).map((e) => e.label);
  assert.deepEqual(byKind('upload'), ['POST /avatar']);
  assert.deepEqual(byKind('message').length, 2);
  assert.deepEqual(byKind('cli'), ['command line']);
  assert.ok(byKind('http').includes('HTTP server'));
  assert.deepEqual(kinds(files), ['eval@raw.js:5', 'eval@ws.js:4', 'path@upload.js:7', 'shell@cli.js:3', 'shell@koa.js:5']);
  // A command line threat is minor (the operator runs it).
  assert.equal(hitFinding(a.hits.find((h) => h.entry.kind === 'cli')!).severity, 'low');
});

test('flask, fastapi, django: request values to files, shells, loaders and outgoing requests; the safe twins', () => {
  const files = {
    'app.py': [
      'from flask import Flask, request, redirect, send_from_directory',
      'from .storage import load_note, run_tool',
      'import pickle, yaml',
      'app = Flask(__name__)',
      '',
      "@app.route('/note')",
      'def note():',
      "    name = request.args.get('name')",
      '    return load_note(name)',
      '',
      "@app.route('/dl')",
      'def dl():',
      "    return send_from_directory('files', request.args.get('f'))",
      '',
      "@app.route('/tool', methods=['POST'])",
      '@login_required',
      'def tool():',
      "    return run_tool(request.form['arg'])",
      '',
      "@app.route('/obj', methods=['POST'])",
      '@login_required',
      'def obj():',
      '    return str(pickle.loads(request.data))',
      '',
      "@app.route('/cfg', methods=['POST'])",
      '@login_required',
      'def cfg():',
      '    return str(yaml.safe_load(request.data))',
      '',
      "@app.route('/next')",
      'def nxt():',
      "    target = request.args.get('to', '/')",
      "    if target not in ALLOWED_TARGETS:",
      "        target = '/'",
      '    return redirect(target)',
    ].join('\n'),
    'storage.py': ['import os, subprocess', "BASE = '/srv/notes'", 'def load_note(name):', '    with open(os.path.join(BASE, name)) as f:', '        return f.read()', 'def run_tool(arg):', '    return subprocess.check_output(f"tool {arg}", shell=True)', 'def safe_tool(arg):', "    return subprocess.check_output(['tool', arg])"].join('\n'),
    'api.py': ['from fastapi import FastAPI, Depends', 'import requests', 'app = FastAPI()', "@app.get('/fetch')", 'def fetch(url: str, user=Depends(get_current_user)):', '    return requests.get(url).text', "@app.get('/weather')", 'def weather(city: str):', '    return requests.get(f"https://api.weather.example/v1?q={city}").json()'].join('\n'),
    'shop/views.py': ['from django.http import HttpResponse', 'from django.db import connection', 'def item(request, slug):', '    with connection.cursor() as c:', '        c.execute("SELECT * FROM items WHERE slug = \'%s\'" % slug)', '    return HttpResponse("ok")', 'def item2(request, slug):', '    with connection.cursor() as c:', '        c.execute("SELECT * FROM items WHERE slug = %s", [slug])', '    return HttpResponse("ok")'].join('\n'),
  };
  assert.deepEqual(kinds(files), ['deserialize@app.py:23', 'path@storage.py:4', 'shell@storage.py:7', 'sql@shop/views.py:5', 'ssrf@api.py:6']);
  const a = run(files);
  assert.ok(a.entries.some((e) => e.label === 'Django view item'));
  assert.ok(a.entries.find((e) => e.label === 'GET /fetch')!.authed, 'Depends(get_current_user) is a sign-in check');
  const n = a.hits.find((h) => h.kind === 'path')!;
  assert.equal(pathLine(n.path), 'GET /note (app.py:6) → load_note() (app.py:9) → file path (storage.py:4)');
});

test('go: net/http and gin handlers, a query value to SQL in another package; parameters and fixed hosts are guarded', () => {
  const files = {
    'go.mod': 'module example.com/svc\n',
    'main.go': [
      'package main',
      'import (',
      '  "net/http"',
      '  "example.com/svc/store"',
      ')',
      'func main() {',
      '  http.HandleFunc("/file", fileHandler)',
      '  http.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {',
      '    store.FindUser(r.URL.Query().Get("id"))',
      '  })',
      '  http.HandleFunc("/user2", func(w http.ResponseWriter, r *http.Request) {',
      '    store.FindUserSafe(r.URL.Query().Get("id"))',
      '  })',
      '}',
      'func fileHandler(w http.ResponseWriter, r *http.Request) {',
      '  name := r.URL.Query().Get("name")',
      '  http.ServeFile(w, r, "/data/"+name)',
      '}',
      'func weather(w http.ResponseWriter, r *http.Request) {',
      '  http.Get("https://api.weather.example/v1?q=" + r.URL.Query().Get("city"))',
      '}',
    ].join('\n'),
    'store/store.go': ['package store', 'import "fmt"', 'func FindUser(id string) {', '  q := fmt.Sprintf("SELECT * FROM users WHERE id = \'%s\'", id)', '  db.Query(q)', '}', 'func FindUserSafe(id string) {', '  db.Query("SELECT * FROM users WHERE id = $1", id)', '}'].join('\n'),
    'gin.go': ['package main', 'import "os/exec"', 'func routes(r *gin.Engine) {', '  r.GET("/ping", func(c *gin.Context) {', '    exec.Command("sh", "-c", "ping "+c.Query("host")).Run()', '  })', '}'].join('\n'),
  };
  assert.deepEqual(kinds(files), ['path@main.go:17', 'shell@gin.go:5', 'sql@store/store.go:5']);
  const a = run(files);
  assert.ok(a.entries.some((e) => e.label === 'handler weather'), 'a net/http handler no route names is still an entry');
});

test('auth gap and rate limit: a change without sign-in, a login without a limit; their near misses', () => {
  const files = {
    'app.js': [
      "const express = require('express');",
      "const rateLimit = require('express-rate-limit');",
      'const app = express();',
      "app.get('/api/me', requireLogin, (req, res) => res.json(req.user));",
      "app.post('/api/notes', requireLogin, (req, res) => db.query('INSERT INTO notes (body) VALUES (?)', [req.body.text]));",
      "app.post('/api/admin/wipe', (req, res) => {",
      "  db.query('DELETE FROM notes');",
      '  res.end();',
      '});',
      "app.post('/api/admin/wipe2', requireAdmin, (req, res) => db.query('DELETE FROM notes'));",
      "app.post('/login', async (req, res) => {",
      '  const { user, password } = req.body;',
      '  if (await bcrypt.compare(password, hashOf(user))) req.session.user = user;',
      '  res.end();',
      '});',
      "app.post('/login2', rateLimit({ windowMs: 60000, max: 5 }), async (req, res) => {",
      '  if (await bcrypt.compare(req.body.password, hashOf(req.body.user))) req.session.user = req.body.user;',
      '  res.end();',
      '});',
      "app.get('/health', (req, res) => res.send('ok'));",
    ].join('\n'),
  };
  assert.deepEqual(kinds(files), ['auth@app.js:7', 'ratelimit@app.js:13']);
  const a = run(files);
  const auth = a.hits.find((h) => h.kind === 'auth')!;
  assert.equal(auth.entry.label, 'POST /api/admin/wipe');
  // A project-wide limiter (app.use(limiter)) guards every login route.
  const limited = { 'app.js': `${files['app.js']}\napp.use(loginLimiter);` };
  assert.deepEqual(kinds(limited), ['auth@app.js:7']);
});

test('the walk is bounded: a sink more than MAX_HOPS calls away is not followed; recursion ends', () => {
  const chain = (n: number) => {
    const lines = ["const fs = require('fs');", "const app = require('express')();", "app.get('/x', (req, res) => f1(req.query.p));"];
    for (let i = 1; i <= n; i++) lines.push(`function f${i}(v) {`, i === n ? '  fs.readFileSync(v);' : `  return f${i + 1}(v);`, '}');
    lines.push('function loop(a) { return loop(a); }', "app.get('/y', (req, res) => loop(req.query.p));");
    return { 'a.js': lines.join('\n') };
  };
  assert.equal(MAX_HOPS, 4);
  assert.deepEqual(kinds(chain(MAX_HOPS)).length, 1, 'within the bound');
  assert.deepEqual(kinds(chain(MAX_HOPS + 2)).length, 0, 'past the bound: not followed');
  assert.equal(run(chain(3)).hits[0].path.length, 5, 'entry → f1 → f2 → f3 → sink');
});

test('test files are not entry points; comments and strings do not count', () => {
  const files = {
    'test/app.test.js': "const app = require('express')();\napp.get('/x', (req, res) => eval(req.query.c));",
    'b.js': "const app = require('express')();\n// app.get('/y', (req, res) => eval(req.query.c));\napp.get('/z', (req, res) => res.send('eval(req.query.c)'));",
  };
  assert.deepEqual(kinds(files), []);
});

// ------------------------------------------------------------------------------------------------
// 2. No theater: quotes at both ends, a named path; regions for the fix pass
// ------------------------------------------------------------------------------------------------

test('validateThreats: an invented sink quote, an invented entry quote or no path → dropped; a wrong line is moved', () => {
  const files: Record<string, string> = { 'a.js': "app.get('/x', (req, res) => {\n  run(req.query.c);\n});\n", 'b.js': 'function run(c) {\n  eval(c);\n}\n' };
  const read = (f: string) => files[f];
  const entry = { file: 'a.js', line: 1, quote: "app.get('/x', (req, res) => {", label: 'GET /x', kind: 'http' };
  const path = [{ file: 'a.js', line: 1, label: 'GET /x' }, { file: 'b.js', line: 2, label: 'runs code' }];
  const base: NewFinding = { source: 'threat', severity: 'high', rule: 'threat:eval', title: 't', advice: '', file: 'b.js', line: 2, quote: 'eval(c);', meta: { entry, path } };
  const { kept, dropped } = validateThreats(
    [
      base,
      { ...base, line: 9 },
      { ...base, quote: 'eval(userInput);' },
      { ...base, meta: { entry: { ...entry, quote: "app.post('/admin', handler)" }, path } },
      { ...base, meta: { entry, path: [path[0]] } },
    ],
    read,
  );
  assert.equal(kept.length, 2);
  assert.equal(kept[1].line, 2, 'moved to the real line');
  assert.deepEqual(
    dropped.map((d) => d.why),
    ['quote not in the file', 'entry quote not in the file', 'no path from an entry point'],
  );
});

test('fix regions: the functions on the path (or the route call); edits outside are refused, adding an import is fine', () => {
  const text = "const fs = require('fs');\nfunction readDoc(name) {\n  return fs.readFileSync(name);\n}\nfunction other(x) {\n  return x + 1;\n}\n";
  const rg = regionsFor('files.js', text, [3]) as [number, number][];
  assert.deepEqual(rg, [[2, 4]]);
  assert.equal(outsideRegions(text, { find: '  return fs.readFileSync(name);', replace: '  return fs.readFileSync(path.basename(name));' }, rg), undefined);
  assert.match(String(outsideRegions(text, { find: '  return x + 1;', replace: '  return x + 2;' }, rg)), /outside the threats' code/);
  assert.equal(outsideRegions(text, { find: "const fs = require('fs');", replace: "const fs = require('fs');\nconst path = require('path');" }, rg), undefined);
  assert.match(String(outsideRegions(text, { find: 'not there', replace: 'x' }, rg)), /isn't in the file/);
});

// ------------------------------------------------------------------------------------------------
// Test apps
// ------------------------------------------------------------------------------------------------

function git(cwd: string, ...a: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  return r.stdout.trim();
}

function setup(t: { after: (fn: () => void) => void }, o: { reviewer?: boolean; mode?: 'off' | 'report' | 'offer'; security?: 'after' | 'ask' | 'off' } = {}) {
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
    securityPass: { mode: o.security ?? 'ask', reviewer: o.reviewer ?? false, advisories: false },
    threatModel: { mode: o.mode ?? 'offer' },
  });
  app.runs = new RunStore(app.store.db, app.now);
  app.findings = new FindingStore(app.store.db, app.now);
  app.security = new SecurityPass(app, app.findings, new OsvClient(app.store.db, { baseUrl: 'http://127.0.0.1:9' }));
  app.threats = new ThreatPass(app, app.findings);
  app.sandboxGate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), app.sandbox, () => sandboxGateSettings(app.settings.get()), () => COPY);
  app.fixes = new FixBranches(app, join(dir, 'cache', 'fix-branches'));
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  return { app, dir, ws, conv };
}

const SERVER = ["const express = require('express');", "const files = require('./files');", 'const app = express();', "app.get('/doc', (req, res) => {", '  res.send(files.readDoc(req.query.name));', '});', "app.get('/go', (req, res) => res.redirect(req.query.next));", 'module.exports = app;', ''].join('\n');
const FILES = ["const fs = require('fs');", "const path = require('path');", "const ROOT = path.join(__dirname, 'docs');", 'function readDoc(name) {', "  return fs.readFileSync(path.join(ROOT, name), 'utf8');", '}', 'function unrelated(x) {', '  return x + 1;', '}', 'module.exports = { readDoc, unrelated };', ''].join('\n');

function writeTool(): Tool {
  return {
    spec: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    defaultPermission: 'auto',
    summarize: (a) => `write ${String(a.path)}`,
    async run(a, ctx) {
      writeFileSync(join(ctx.workspaceDir, String(a.path)), String(a.content));
      return 'written';
    },
  };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ------------------------------------------------------------------------------------------------
// 3. The pass after a coding turn, the reviewer, the summary
// ------------------------------------------------------------------------------------------------

test('pass: after a coding turn that changed files: threats across files on the table, the summary written, the reply knows', async (t) => {
  const { app, ws, conv } = setup(t);
  app.tools.add(writeTool());
  mkdirSync(join(ws, 'docs'), { recursive: true });
  app.script.push([call('w1', 'write_file', { path: 'server.js', content: SERVER }), call('w2', 'write_file', { path: 'files.js', content: FILES })], text('Added the docs route.'));
  await drain(runTurn(app, conv.id, 'add a docs route'));
  assert.equal(app.security!.last, undefined, 'the security pass is on "only when I ask" here');
  const sum = (await app.threats!.last)!;
  assert.ok(sum, 'the threat pass ran after the final reply');
  assert.equal(sum.reason, 'turn');
  assert.equal(sum.mode, 'offer');
  assert.equal(sum.entries, 2);
  const rows = app.findings!.list({ workspace: conv.workspace, source: 'threat' });
  assert.deepEqual(rows.map((r) => r.rule).sort(), ['threat:path', 'threat:redirect']);
  const p = rows.find((r) => r.rule === 'threat:path')!;
  assert.equal(p.file, 'files.js');
  assert.equal(p.line, 5);
  assert.equal(p.quote, "return fs.readFileSync(path.join(ROOT, name), 'utf8');");
  assert.equal((p.meta.entry as { quote: string }).quote, "app.get('/doc', (req, res) => {");
  assert.equal(p.meta.category, 'Information disclosure');
  assert.equal(pathLine(p.meta.path as never), 'GET /doc (server.js:4) → readDoc() (server.js:5) → file path (files.js:5)');
  // The reply carries the summary (the card), the pass is its own run, nothing was fixed by itself.
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.deepEqual((reply.meta?.threats as { ids: number[] }).ids.sort(), rows.map((r) => r.id).sort());
  assert.equal(app.runs!.get(sum.runId!)!.title, 'Threat model');
  assert.ok(rows.every((r) => !r.fix), 'the fix pass is never started by itself');
  // The summary in the data folder: surfaces, boundaries, open threats, what changed.
  const md = readFileSync(join(app.dataDir, 'threat-models', `${conv.workspace}.md`), 'utf8');
  for (const h of ['## Surfaces (entry points)', '## Trust boundaries', '## Open threats', '## What changed this turn']) assert.ok(md.includes(h), h);
  assert.match(md, /GET \/doc · `server\.js:4` · no sign-in check seen/);
  assert.match(md, /Files: `server\.js`, `files\.js`|Files: `files\.js`, `server\.js`/);
  const model = app.threats!.model(conv.workspace)!.model;
  assert.ok(model.boundaries.some((b) => b.id === 'network-in' && b.count === 2));
  assert.deepEqual(model.changed.newIds.sort(), rows.map((r) => r.id).sort());
  // No model was asked (the reviewer is off here): only her turn's two model steps.
  assert.equal(app.requests.length, 2);
});

test('pass: two entry points to the same line are one threat, counted once; found again it keeps the newest path', async (t) => {
  const { app, ws, conv } = setup(t);
  writeFileSync(join(ws, 'files.js'), FILES);
  writeFileSync(join(ws, 'server.js'), "const files = require('./files');\nconst app = require('express')();\napp.get('/a', (req, res) => res.send(files.readDoc(req.query.name)));\napp.get('/b', (req, res) => res.send(files.readDoc(req.query.file)));\n");
  const s = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js'], reason: 'turn', private: false });
  assert.equal(s.ids.length, 1);
  assert.equal(s.counts.high, 1);
  const f = app.findings!.get(s.ids[0])!;
  assert.equal((f.meta.entry as { label: string }).label, 'GET /a');
  writeFileSync(join(ws, 'server.js'), "const files = require('./files');\nconst app = require('express')();\napp.get('/c', (req, res) => res.send(files.readDoc(req.query.name)));\n");
  const s2 = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js'], reason: 'turn', private: false });
  assert.deepEqual(s2.ids, s.ids, 'the same finding');
  assert.equal((app.findings!.get(s.ids[0])!.meta.entry as { label: string }).label, 'GET /c', 'the newest path');
});

test('pass: never in everyday chats; Off starts nothing; Report only reports; an unchanged turn has no pass', async (t) => {
  const { app, conv } = setup(t, { mode: 'off' });
  app.tools.add(writeTool());
  app.script.push([call('w', 'write_file', { path: 'server.js', content: SERVER })], text('Done.'));
  await drain(runTurn(app, conv.id, 'write it'));
  assert.equal(app.threats!.last, undefined, 'off');
  app.settings.update({ threatModel: { mode: 'report' } });
  const chat = app.store.createConversation({});
  app.script.push([call('w2', 'write_file', { path: 'server.js', content: SERVER })], text('Done.'));
  await drain(runTurn(app, chat.id, 'write it'));
  assert.equal(app.threats!.last, undefined, 'never in an everyday chat');
  app.script.push(text('Just talking.'));
  await drain(runTurn(app, conv.id, 'how are you'));
  assert.equal(app.threats!.last, undefined, 'nothing changed: no pass');
  app.script.push([call('w3', 'write_file', { path: 'files.js', content: FILES })], text('Done.'));
  await drain(runTurn(app, conv.id, 'write the helper'));
  const s = (await (app.threats as ThreatPass).last)!;
  assert.equal(s.mode, 'report');
  assert.equal(s.ids.length, 1, 'only the threat whose path runs through files.js (the redirect is all in server.js, unchanged)');
  assert.deepEqual(threatSettings({}), { mode: 'offer' });
});

test('reviewer: may add a threat only on a listed entry point, with a real quote and a named path', async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: true });
  writeFileSync(join(ws, 'server.js'), SERVER);
  writeFileSync(join(ws, 'files.js'), FILES);
  writeFileSync(join(ws, 'render.js'), 'exports.page = (title) => `<h1>${title}</h1>`;\n');
  app.script.push(
    text(
      JSON.stringify({
        threats: [
          { entry: 'E1', sink: { file: 'files.js', line: 3, quote: "const ROOT = path.join(__dirname, 'docs');" }, path: ['GET /doc', 'readDoc()', 'ROOT folder'], kind: 'path', severity: 'medium', title: 'Docs folder next to the code', advice: 'Keep docs outside.' },
          { entry: 'E99', sink: { file: 'files.js', line: 5, quote: "return fs.readFileSync(path.join(ROOT, name), 'utf8');" }, path: ['x', 'y'], kind: 'path', severity: 'high', title: 'Unknown entry', advice: '' },
          { entry: 'E1', sink: { file: 'files.js', line: 2, quote: 'fs.readFileSync(userPath)' }, path: ['GET /doc', 'sink'], kind: 'path', severity: 'high', title: 'Invented line', advice: '' },
          { entry: 'E2', sink: { file: 'render.js', line: 1, quote: 'exports.page = (title) =>' }, path: [], kind: 'html', severity: 'high', title: 'No path', advice: '' },
        ],
      }),
    ),
  );
  const s = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js', 'files.js'], reason: 'turn', private: false });
  assert.equal(s.reviewer.ran, true);
  assert.equal(s.reviewer.added, 1);
  assert.equal(s.reviewer.dropped, 1, 'the invented quote (the unknown entry and the missing path never became findings)');
  const model = app.findings!.list({ workspace: conv.workspace, source: 'threat' }).filter((f) => f.origin === 'model');
  assert.deepEqual(
    model.map((f) => [f.rule, f.line, f.title]),
    [['threat:review-path', 3, 'Docs folder next to the code']],
  );
  assert.equal((model[0].meta.entry as { label: string }).label, 'GET /doc');
  // The reviewer saw the graph (entries listed by code) and the diff; it had no tools.
  const req = app.requests.at(-1)!;
  assert.match(String(req.messages[1].content), /E1 GET \/doc at server\.js:4/);
  assert.match(String(req.messages[1].content), /threat:path GET \/doc/);
  assert.ok(!req.tools?.length, 'no tools');
});

test('reviewer: an empty diff asks no model; the threat hook only watches (no beforeTool: approvals stay as they are)', async (t) => {
  const { app, ws, conv } = setup(t, { reviewer: true, security: 'off' });
  writeFileSync(join(ws, 'server.js'), SERVER);
  writeFileSync(join(ws, 'files.js'), FILES);
  const calls = app.requests.length;
  const s = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: [], reason: 'turn', private: false });
  assert.equal(s.reviewer.ran, false);
  assert.equal(s.reviewer.note, 'empty diff');
  assert.equal(app.requests.length, calls, 'no model call');
  // With the security pass off and the threat model on, the turn's hooks only observe.
  const hooks = app.security!.turnHooks(conv, ws)!;
  assert.ok(hooks, 'the threat model still gets its seam');
  assert.equal(hooks.beforeTool, undefined);
  assert.equal(hooks.beforeModelCall, undefined);
  app.settings.update({ threatModel: { mode: 'off' } });
  assert.equal(app.security!.turnHooks(conv, ws), undefined, 'both off: no hooks at all');
});

// ------------------------------------------------------------------------------------------------
// 4. The second pass on a temp git repo
// ------------------------------------------------------------------------------------------------

function fixRepo(ws: string): string {
  mkdirSync(join(ws, 'docs'), { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'docs', private: true, scripts: { test: 'node test.js' } }, null, 2));
  writeFileSync(join(ws, 'docs', 'a.txt'), 'hello');
  writeFileSync(join(ws, 'test.js'), "const { readDoc } = require('./files.js');\nif (readDoc('a.txt') !== 'hello') { console.error('wrong'); process.exit(1); }\nconsole.log('tests pass');\n");
  writeFileSync(join(ws, 'server.js'), "module.exports = {};\n");
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'init');
  // Her turn's change (uncommitted): the route and the helper.
  writeFileSync(join(ws, 'server.js'), SERVER);
  writeFileSync(join(ws, 'files.js'), FILES);
  const remote = `${ws}-remote.git`;
  spawnSync('git', ['init', '-q', '--bare', remote]);
  git(ws, 'remote', 'add', 'origin', remote);
  return remote;
}

test('fix pass: only the threats, edits kept to their regions, the threat rule re-checks, tests in a sandbox copy, one diff, Apply, never a push', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t);
  const remote = fixRepo(ws);
  const headBefore = git(ws, 'rev-parse', 'HEAD');
  const s = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js', 'files.js'], reason: 'turn', private: false });
  assert.equal(s.ids.length, 2);
  gitLog.length = 0;
  const calls = app.requests.length;
  // Try 1 edits a function no threat runs through (refused: fix-only); try 2 fixes both threats.
  app.script.push(
    text(JSON.stringify({ edits: [{ file: 'files.js', find: '  return x + 1;', replace: '  return x + 2;' }] })),
    text(
      JSON.stringify({
        edits: [
          { file: 'files.js', find: "  return fs.readFileSync(path.join(ROOT, name), 'utf8');", replace: "  return fs.readFileSync(path.join(ROOT, path.basename(name)), 'utf8');" },
          { file: 'server.js', find: "app.get('/go', (req, res) => res.redirect(req.query.next));", replace: "app.get('/go', (req, res) => {\n  const next = String(req.query.next || '/');\n  if (!next.startsWith('/') || next.startsWith('//')) return res.redirect('/');\n  res.redirect(next);\n});" },
        ],
        note: 'Kept the file name only and allowed local redirects only.',
      }),
    ),
  );
  const started = app.fixes!.startBatch(s.ids);
  assert.equal(started.fix!.state, 'working');
  assert.match(started.fixBranch!, /^sara\/threat-fix-\d+$/);
  const done = (await app.fixes!.running.get(s.ids[0])!.promise)!;
  assert.equal(done.fix!.state, 'ready', done.fix!.error);
  assert.equal(done.fix!.attempts, 2);
  assert.equal(app.requests.length, calls + 2);
  // The first try was refused for leaving the threats' code; the prompt was fix-only.
  assert.match(String(app.requests.at(-1)!.messages[1].content), /outside the threats' code/);
  assert.match(String(app.requests.at(-1)!.messages[0].content), /fix-only pass: no new features, no refactoring/);
  assert.ok(!app.requests.at(-1)!.tools?.length, 'the fix model has no tools');
  // The proof: each threat's rule no longer fires; the project's tests pass in a sandbox copy.
  assert.equal(done.fix!.recheck!.fixed, true);
  assert.deepEqual(Object.values(done.fix!.batch!.results!).map((r) => r.fixed), [true, true]);
  assert.equal(done.fix!.tests!.ran, true);
  assert.equal(done.fix!.tests!.exitCode, 0, done.fix!.tests!.output);
  // One diff, only in the threats' regions.
  const changedLines = done.fix!.diff!.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
  assert.ok(changedLines.some((l) => l.includes('path.basename(name)')));
  assert.ok(!changedLines.some((l) => /unrelated|x \+ 1|x \+ 2/.test(l)), changedLines.join('\n'));
  assert.deepEqual(done.fix!.files!.sort(), ['files.js', 'server.js']);
  // Both findings show the same fix; the owner's files are untouched until Apply.
  const other = app.findings!.get(s.ids[1])!;
  assert.equal(other.fix!.batch!.lead, s.ids[0]);
  assert.equal(readFileSync(join(ws, 'files.js'), 'utf8'), FILES);
  // Apply (through the second finding: it acts on the batch).
  const applied = app.fixes!.apply(s.ids[1]);
  assert.equal(applied.status, 'fixed');
  assert.equal(app.findings!.get(s.ids[0])!.status, 'fixed');
  assert.match(readFileSync(join(ws, 'files.js'), 'utf8'), /path\.basename\(name\)/);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), headBefore, 'nothing committed on the owner\'s branch');
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(ws, 'branch', '--list', 'sara/threat-fix-*'), '');
  // A new pass finds nothing open.
  const again = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js', 'files.js'], reason: 'turn', private: false });
  assert.equal(again.ids.length, 0);
  // Never pushed.
  assert.equal(spawnSync('git', ['ls-remote', remote], { encoding: 'utf8' }).stdout.trim(), '');
  assert.ok(!gitLog.some((a) => a.includes('push') || a.includes('fetch') || a.includes('remote')), JSON.stringify(gitLog));
});

test('fix pass: its budget stops it (no call past it); a single threat goes through the same loop; Keep and Discard act on the batch', { skip: !HAS_GIT }, async (t) => {
  const { app, ws, conv } = setup(t);
  fixRepo(ws);
  const s = await app.threats!.run({ conversationId: conv.id, workspace: conv.workspace, wsDir: ws, changed: ['server.js', 'files.js'], reason: 'turn', private: false });
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), budgetTokens: 10_000 } });
  app.script.push([{ type: 'text', text: 'Thinking…' }, { type: 'usage', input: 9300, output: 600 }]);
  const calls = app.requests.length;
  app.fixes!.startBatch(s.ids);
  const r = (await app.fixes!.running.get(s.ids[0])!.promise)!;
  assert.equal(r.fix!.state, 'failed');
  assert.match(r.fix!.error!, /budget/);
  assert.equal(app.requests.length, calls + 1, 'one call, none past the budget');
  assert.equal(app.findings!.get(s.ids[1])!.fix!.state, 'failed', 'the whole batch');
  app.fixes!.discard(s.ids[1]);
  // "Fix on a branch" on one threat: the same loop, its rule as the re-check.
  app.settings.update({ securityPass: { ...securitySettings(app.settings.get()), budgetTokens: 30_000 } });
  const path = app.findings!.list({ workspace: conv.workspace, source: 'threat' }).find((f) => f.rule === 'threat:path')!;
  app.script.push(text(JSON.stringify({ edits: [{ file: 'files.js', find: 'path.join(ROOT, name)', replace: 'path.join(ROOT, path.basename(name))' }] })));
  const one = app.fixes!.start(path.id);
  assert.match(one.fixBranch!, /^sara\/threat-fix-/);
  const ready = (await app.fixes!.running.get(path.id)!.promise)!;
  assert.equal(ready.fix!.state, 'ready', ready.fix!.error);
  const kept = app.fixes!.keep(path.id);
  assert.equal(kept.fix!.state, 'kept');
  assert.ok(git(ws, 'branch', '--list', kept.fixBranch!).includes(kept.fixBranch!));
  app.fixes!.discard(path.id);
  assert.equal(git(ws, 'branch', '--list', 'sara/threat-fix-*'), '');
  assert.throws(() => app.fixes!.startBatch([999_999]), /not found/);
  const sec = app.findings!.add([{ source: 'security', severity: 'high', rule: 'tls-off', title: 'x', advice: '', file: 'files.js', line: 1, quote: "const fs = require('fs');" }], { workspace: conv.workspace })[0];
  assert.throws(() => app.fixes!.startBatch([sec.id]), /threats only/);
});

// ------------------------------------------------------------------------------------------------
// 5. Settings, routes, member isolation
// ------------------------------------------------------------------------------------------------

test('routes: the setting (owner only), the summary, Check now, Fix these (open threats of one project only)', { skip: !HAS_GIT }, async (t) => {
  const { app, dir, ws, conv } = setup(t);
  fixRepo(ws);
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
  const g = await api('/api/threat-model');
  assert.equal(g.json.mode, 'offer');
  assert.deepEqual((g.json.choices as { mode: string[] }).mode, ['offer', 'report', 'off']);
  assert.equal((await api('/api/threat-model', 'PUT', { mode: 'report' })).json.mode, 'report');
  assert.equal((await api('/api/threat-model', 'PUT', { mode: 'loud' })).json.mode, 'report', 'an unknown mode keeps the saved one');
  assert.equal(app.settings.get().threatModel?.mode, 'report');
  assert.equal((await api(`/api/threat-model?workspace=${conv.workspace}`)).json.summary, null, 'no pass yet');
  const scan = await api('/api/threat-model/scan', 'POST', { conversationId: conv.id });
  assert.equal(scan.status, 200);
  const ids = (scan.json.summary as { ids: number[] }).ids;
  assert.equal(ids.length, 2);
  const m = await api(`/api/threat-model?workspace=${conv.workspace}`);
  assert.equal((m.json.summary as { open: unknown[] }).open.length, 2);
  assert.match(String(m.json.markdown), /# Threat model/);
  // Fix these: wrong project / nothing named / not threats → refused plainly.
  assert.equal((await api('/api/threat-model/fix', 'POST', { ids: [] })).status, 400);
  assert.equal((await api('/api/threat-model/fix', 'POST', { ids, workspace: 'another-project' })).status, 409);
  assert.equal((await api('/api/threat-model/fix', 'POST', { ids, workspace: '../x' })).status, 400);
  app.script.push(text('{"edits":[]}'), text('{"edits":[]}'));
  const fx = await api('/api/threat-model/fix', 'POST', { ids, workspace: conv.workspace });
  assert.equal(fx.status, 202);
  await app.fixes!.running.get(ids[0])?.promise;
  assert.equal((await api('/api/threat-model/fix', 'POST', { ids })).status, 202, 'a failed fix can be tried again');
  await app.fixes!.running.get(ids[0])?.promise;
  // The findings list says which threat setting is on.
  assert.deepEqual((await api('/api/findings?source=threat')).json.threats, { mode: 'report' });
  // Members have no coding: the setting is the owner's, and an app without the pass answers 404.
  assert.ok(OWNER_SETTINGS.includes('threatModel'));
  app.threats = undefined;
  assert.equal((await api('/api/threat-model')).status, 404);
});

// ------------------------------------------------------------------------------------------------
// 6. Eval, UI files, docs
// ------------------------------------------------------------------------------------------------

test('eval: the threat rules keep their bar on both sample sets (scripts/eval-threat.ts)', async () => {
  const { runEval } = await import('../scripts/eval-threat.ts');
  const tuning = runEval('tuning');
  const held = runEval('held-out');
  assert.ok(tuning.precision >= 0.9 && tuning.recall >= 0.85, JSON.stringify(tuning));
  assert.ok(held.precision >= 0.85 && held.recall >= 0.8, JSON.stringify(held));
});

test('UI: the setting with its tip, the Threat model tab, translations, no inline styles, the service worker cache', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const tips = JSON.parse(web('tips.json')).tips as Record<string, [string, string]>;
  const help = web('help.html');
  const html = web('index.html');
  for (const id of ['thr-mode']) {
    assert.ok(tips[id], id);
    assert.ok(tips[id][0].length <= 260, `${id} tip too long`);
    assert.ok(help.includes(`id="${tips[id][1]}"`), `guide section ${tips[id][1]}`);
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('id="fnd-tab-threats"'), 'the Threat model tab');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Threat model', 'Fix these', 'Threat model after coding turns', 'Report and offer the fix pass', 'Outside input chooses a file path']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.notEqual(d[k], k, `${lang}: ${k} is translated`);
    }
  }
  const view = web('findings-view.js');
  assert.doesNotMatch(view, /style=|\.style\./, 'no inline styles');
  for (const k of Object.keys(THREAT_RULES) as ThreatKind[]) assert.ok(view.includes(`'threat:${k}'`), `the view names threat:${k}`);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v15'\)[\s\S]*sara-shell-v14 from Phase 81/);
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
  assert.ok(existsSync(join(ROOT, 'src', 'security', 'threats.ts')));
  assert.match(readFileSync(join(ROOT, 'docs', 'design', 'HARNESS_TRACK.md'), 'utf8'), /M7 · Phase 82[\s\S]*As built/);
});
