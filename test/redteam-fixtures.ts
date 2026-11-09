// Phase 86: small seeded apps for red-team mode (tests and scripts/eval-redteam.ts). No packages:
// the "express-style" app carries its own tiny router (lib/router.js) with Express's shapes
// (app.get('/p', (req, res) => …), req.query with arrays/objects for `a[]=` / `a[x]=` / duplicates,
// res.status().json()), the Python one is a plain http.server handler. Each seeded break is a
// generic robustness bug (a missing value, a huge value, a number out of range); each has a
// guarded near-miss twin. Fake secrets are built in pieces so no scanner sees a real-looking key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A fake payment key, assembled at run time (never a real one). */
export const FAKE_KEY = ['sk', 'live', 'Fz9QwT3xLmN8vR2kP5sY7bHc'].join('_');

export const ROUTER = `// A tiny Express-style router (no packages).
const http = require('http');
function parseQuery(sp) {
  const q = {};
  for (const [k, v] of sp) {
    const m = /^(\\w+)\\[(\\w*)\\]$/.exec(k);
    if (m && m[2] === '') (q[m[1]] = Array.isArray(q[m[1]]) ? q[m[1]] : []).push(v);
    else if (m) (q[m[1]] = typeof q[m[1]] === 'object' && q[m[1]] ? q[m[1]] : {})[m[2]] = v;
    else if (k in q) q[k] = [].concat(q[k], v);
    else q[k] = v;
  }
  return q;
}
module.exports = function express() {
  const routes = [];
  const app = {};
  for (const m of ['get', 'post', 'put', 'delete']) app[m] = (path, handler) => routes.push({ method: m.toUpperCase(), path, handler });
  app.handle = (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end('bad url');
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.status = (n) => ((res.statusCode = n), res);
      res.send = (b) => res.end(typeof b === 'string' ? b : JSON.stringify(b));
      res.json = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
      const route = routes.find((r) => r.method === req.method && (r.path === url.pathname || new RegExp('^' + r.path.replace(/:\\w+/g, '([^/]+)') + '$').test(url.pathname)));
      if (!route) return res.status(404).send('not found');
      const names = [...route.path.matchAll(/:(\\w+)/g)].map((m) => m[1]);
      const vals = new RegExp('^' + route.path.replace(/:\\w+/g, '([^/]+)') + '$').exec(url.pathname) || [];
      req.params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(vals[i + 1] || '')]));
      req.query = parseQuery(url.searchParams);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw && /json/.test(req.headers['content-type'] || '')) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          return res.status(400).send('bad json');
        }
      } else req.body = {};
      try {
        route.handler(req, res);
      } catch (err) {
        console.error(err.stack);
        res.status(500).send('Internal Server Error');
      }
    });
  };
  app.listen = (port, cb) => http.createServer(app.handle).listen(port, '127.0.0.1', cb);
  return app;
};
`;

/** The express-style app: five seeded breaks and their guarded twins. */
export const EXPRESS_SERVER = `const express = require('./lib/router');
const fs = require('fs');
const path = require('path');
const app = express();
const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\\r?\\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
}
app.get('/', (req, res) => res.send('ok'));
app.get('/sum', (req, res) => {
  const parts = req.query.nums.split(',');
  res.json({ total: parts.reduce((a, b) => a + Number(b), 0) });
});
app.get('/safe-sum', (req, res) => {
  if (typeof req.query.nums !== 'string' || req.query.nums.length > 1000) return res.status(400).send('nums must be a short list');
  res.json({ total: req.query.nums.split(',').reduce((a, b) => a + Number(b), 0) });
});
app.get('/note', (req, res) => {
  const text = req.query.text;
  setTimeout(() => {
    if (text.length > 2000) throw new RangeError('note too long');
  }, 0);
  res.send('saved');
});
app.get('/safe-note', (req, res) => {
  const text = String(req.query.text || '');
  if (text.length > 2000) return res.status(400).send('too long');
  res.send('saved');
});
app.get('/repeat', (req, res) => {
  const times = Number(req.query.times);
  let out = '';
  for (let i = 0; i < times; i++) out = (out + 'x').slice(-10);
  res.send(out);
});
app.get('/safe-repeat', (req, res) => {
  const times = Math.min(100, Math.max(0, Number(req.query.times) || 0));
  res.send('x'.repeat(times));
});
app.get('/shout', (req, res) => {
  try {
    res.json({ loud: req.query.word.toUpperCase() });
  } catch (err) {
    res.status(400).send(err.stack);
  }
});
app.get('/safe-shout', (req, res) => {
  if (typeof req.query.word !== 'string') return res.status(400).send('word?');
  res.json({ loud: req.query.word.toUpperCase() });
});
app.get('/status', (req, res) => {
  res.json({ ok: true, detail: req.query.verbose ? env.PAYMENT_KEY : 'quiet' });
});
app.get('/safe-status', (req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log('listening'));
`;

/** A small express-style app for the review, script and fix tests (one break is state-dependent). */
export const SMALL_SERVER = `const express = require('./lib/router');
const fs = require('fs');
const app = express();
app.get('/', (req, res) => res.send('ok'));
app.get('/sum', (req, res) => {
  const parts = req.query.nums.split(',');
  res.json({ total: parts.reduce((a, b) => a + Number(b), 0) });
});
app.get('/shout', (req, res) => {
  try {
    res.json({ loud: req.query.word.toUpperCase() });
  } catch (err) {
    res.status(400).send(err.stack);
  }
});
app.get('/order', (req, res) => {
  // Counted in a file of this copy, so the count survives the app being restarted inside one run
  // (after a request slower than the hang limit) and only a fresh copy starts at zero.
  const f = __dirname + '/.order-visits';
  const visits = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
  fs.writeFileSync(f, String(visits));
  if (visits > 3) throw new Error('order book full');
  res.json({ id: String(req.query.id) });
});
app.listen(process.env.PORT || 3000, () => console.log('listening'));
`;

export function smallProject(dir: string): void {
  writeFiles(dir, {
    'package.json': JSON.stringify({ name: 'small', private: true, scripts: { start: 'node server.js', test: 'node test.js' } }, null, 2),
    'lib/router.js': ROUTER,
    'server.js': SMALL_SERVER,
    '.gitignore': 'node_modules\n',
    'test.js': "const fs = require('fs');\nif (!fs.readFileSync(__dirname + '/server.js', 'utf8').includes(\"app.get('/sum'\")) { console.error('not ok 1 - the sum route'); process.exit(1); }\nconsole.log('ok 1 - the sum route is there');\n",
  });
}

export const PY_SERVER = `import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/age':
            age = int(q['age'][0])
            self.reply(200, {'next': age + 1})
        elif u.path == '/safe-age':
            raw = q.get('age', ['0'])[0]
            if not raw.isdigit():
                return self.reply(400, {'error': 'age must be a number'})
            self.reply(200, {'next': int(raw) + 1})
        elif u.path == '/':
            self.reply(200, {'ok': True})
        else:
            self.reply(404, {'error': 'not found'})

    def reply(self, code, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('x-content-type-options', 'nosniff')
        self.send_header('x-frame-options', 'DENY')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


port = int(os.environ.get('PORT', '8000'))
HTTPServer(('127.0.0.1', port), Handler).serve_forever()
`;

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** The express-style project (package.json with a passing test, a committed .env with a fake key). */
export function expressProject(dir: string, opts: { failingTest?: boolean } = {}): void {
  writeFiles(dir, {
    'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { start: 'node server.js', test: 'node test.js' } }, null, 2),
    'lib/router.js': ROUTER,
    'server.js': EXPRESS_SERVER,
    '.env': `PAYMENT_KEY=${FAKE_KEY}\n`,
    // The .env is committed here on purpose (the insecure-default probe must find it; ignored files
    // are not copied into the sandbox, so the app could not read it otherwise).
    '.gitignore': 'node_modules\n',
    'test.js': opts.failingTest ? "console.error('not ok 1 - totals add up'); process.exit(1);\n" : "console.log('ok 1 - nothing to test yet');\n",
  });
}

export function pythonProject(dir: string): void {
  writeFiles(dir, { 'app.py': PY_SERVER });
}

/** The labelled breaks of the seeded apps (entry path → break kinds that must be found). */
export const EXPRESS_BREAKS: Record<string, string[]> = { 'GET /sum': ['crash'], 'GET /note': ['exit'], 'GET /repeat': ['timeout'], 'GET /shout': ['stack-trace'], 'GET /status': ['secret-echo'] };
export const PY_BREAKS: Record<string, string[]> = { 'GET /age': ['uncaught'] };
