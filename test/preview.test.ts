// Phase 49: preview proxy security and behaviour, with a tiny local HTTP app as the "dev server".
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { JobManager } from '../src/jobs.ts';
import { ownsPort, parseLsof, parseNetstat, parseProcNet, treeListensOn } from '../src/ports.ts';
import { cleanStartPath, portsInOutput, PreviewError, PreviewManager, previewUrl, rewriteCss, rewriteHtml, rewriteLocation, safeTarget, type PreviewJobs } from '../src/preview.ts';
import { createSaraServer } from '../src/server.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { listen, makeApp, readBody, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-26T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
let base = '';
let appPort = 0;
let otherPort = 0;
let cookie = '';
const seen: { url: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];

// The "dev server" her job runs.
const devApp = await listen(async (req, res) => {
  const body = await readBody(req);
  seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
  const u = req.url ?? '/';
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'app=1; Path=/', 'x-frame-options': 'DENY', 'content-security-policy': 'default-src *', 'access-control-allow-origin': 'https://evil.example', 'access-control-allow-credentials': 'true' });
    return res.end('<!doctype html><html><head><title>Todo</title><link rel="stylesheet" href="/style.css"></head><body><img src=/logo.png><a href="next.html">next</a><a href="//cdn.example/x.js">cdn</a><form action="/add"></form><div style="background:url(/bg.png)"></div></body></html>');
  }
  if (u === '/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end('body{background:url("/img.png")} @import "/more.css"; .x{background:url(//cdn.example/y.png)}');
  }
  if (u === '/redir-path') {
    res.writeHead(302, { location: '/target?x=1' });
    return res.end();
  }
  if (u === '/redir-full') {
    res.writeHead(301, { location: `http://127.0.0.1:${appPort}/full#h` });
    return res.end();
  }
  if (u === '/redir-other') {
    res.writeHead(302, { location: 'http://127.0.0.1:7860/api/session' });
    return res.end();
  }
  if (u === '/redir-ext') {
    res.writeHead(302, { location: 'https://example.com/docs' });
    return res.end();
  }
  if (u === '/redir-js') {
    res.writeHead(302, { location: 'javascript:alert(1)' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
  res.end(JSON.stringify({ url: u, method: req.method, headers: req.headers, body }));
});
// Something else on this machine that her job did not open (e.g. Ollama or another app).
const otherService = await listen((_req, res) => {
  res.end('SECRET from another local service');
});

// Her background jobs (stand-in): job 1 runs the dev app, as process 4242.
let jobAlive = true;
const jobs: PreviewJobs = {
  running: () => (jobAlive ? [{ id: 1, conversationId: 'c', workspace: 'main', label: 'npx serve', kind: 'command', status: 'running', exitCode: null, startedAt: '', endedAt: null, tail: `Serving!\n  Local: http://localhost:${appPort}/\n` }] : []),
  pidOf: (id) => (id === 1 && jobAlive ? 4242 : undefined),
};
let now = Date.parse('2026-10-26T12:00:00Z');
const previews = new PreviewManager({ now: () => now, owns: async (pid, port) => pid === 4242 && port === appPort, ownPorts: () => [Number(new URL(base || 'http://x:1').port)] });
app.previews = previews;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  appPort = Number(new URL(devApp.url).port);
  otherPort = Number(new URL(otherService.url).port);
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ownerToken }) });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  server.close();
  devApp.server.close();
  otherService.server.close();
  app.store.close();
  await new Promise((r) => setTimeout(r, 200));
  cleanup();
});

const conv = () => app.store.createConversation({ title: 'web app' });

/** Raw HTTP so request targets aren't normalised by a client. */
function raw(target: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: Number(u.port), method: opts.method ?? 'GET', path: target, headers: opts.headers ?? {} }, async (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: await readBody(res) }));
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function open(): Promise<string> {
  const p = await previews.start({ conversationId: conv().id, workspace: 'main', port: appPort, jobs });
  return p.token;
}

test('the owner session cookie and authorization never reach the app; app scripts get an opaque origin', async () => {
  const t = await open();
  const r = await raw(`/preview/${t}/echo?q=1`, { headers: { cookie: `${cookie}; other=1`, authorization: `Bearer ${ownerToken}`, 'x-forwarded-for': '1.2.3.4', origin: base, referer: `${base}/`, 'x-sara-companion': 'main', accept: 'application/json' } });
  assert.equal(r.status, 200);
  const echoed = JSON.parse(r.body) as { url: string; headers: Record<string, string> };
  assert.equal(echoed.url, '/echo?q=1');
  for (const h of ['cookie', 'authorization', 'x-forwarded-for', 'origin', 'referer', 'x-sara-companion']) assert.equal(echoed.headers[h], undefined, `${h} must not be forwarded`);
  assert.equal(echoed.headers.host, `127.0.0.1:${appPort}`);
  assert.equal(echoed.headers.accept, 'application/json');
  assert.ok(!r.body.includes(ownerToken), 'no owner secret anywhere in what the app saw');
  // Opaque origin: the CSP sandbox without allow-same-origin, on every response.
  const csp = String(r.headers['content-security-policy']);
  assert.match(csp, /^sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
});

test('L1: Sara’s own page can open a preview as a page or frame, but not load its scripts, styles or data', async () => {
  const t = await open();
  const b = `/preview/${t}/`;
  const same = (dest: string, mode = 'no-cors') => raw(`${b}style.css`, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': dest, 'sec-fetch-mode': mode } });
  for (const dest of ['script', 'style', 'image', 'font', 'worker']) assert.equal((await same(dest)).status, 403, dest);
  assert.equal((await same('empty', 'cors')).status, 403, 'fetch() from Sara’s page');
  for (const dest of ['iframe', 'document']) assert.equal((await same(dest, 'navigate')).status, 200, dest);
  assert.equal((await same('empty', 'navigate')).status, 200);
  // The sandboxed app's own requests arrive cross-site; requests without fetch metadata pass too.
  assert.equal((await raw(`${b}style.css`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'style' } })).status, 200);
  assert.equal((await raw(`${b}style.css`)).status, 200);
});

test('Set-Cookie and the app’s own framing/CSP/CORS headers are replaced', async () => {
  const t = await open();
  const r = await raw(`/preview/${t}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(String(r.headers['content-security-policy']), /^sandbox /);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
  const json = await raw(`/preview/${t}/api/data`);
  assert.equal(json.headers['set-cookie'], undefined);
});

test('HTML gets a <base href> and root-relative links under the preview; CSS too', async () => {
  const t = await open();
  const b = `/preview/${t}/`;
  const html = (await raw(b)).body;
  assert.match(html, new RegExp(`<head><base href="${b}">`));
  assert.match(html, new RegExp(`href="${b}style.css"`));
  assert.match(html, new RegExp(`src=${b}logo.png`));
  assert.match(html, new RegExp(`action="${b}add"`));
  assert.match(html, new RegExp(`url\\(${b}bg.png\\)`));
  assert.match(html, /href="next.html"/, 'relative links stay relative');
  assert.match(html, /href="\/\/cdn.example\/x.js"/, 'protocol-relative addresses are not prefixed');
  assert.doesNotMatch(html, /<script/i, 'nothing is injected but the base');
  const css = (await raw(`${b}style.css`)).body;
  assert.match(css, new RegExp(`url\\("${b}img.png"\\)`));
  assert.match(css, new RegExp(`@import "${b}more.css"`));
  assert.match(css, /url\(\/\/cdn.example/);
  // Unit level: pages without <head>, with their own <base>.
  assert.equal(rewriteHtml('<p>x</p>', '/preview/t/'), '<base href="/preview/t/"><p>x</p>');
  assert.equal(rewriteHtml('<html><body></body></html>', '/b/'), '<html><head><base href="/b/"></head><body></body></html>');
  assert.equal(rewriteHtml('<head><base href="/"></head>', '/b/'), '<head><base href="/b/"></head>');
  assert.equal(rewriteCss('a{b:url(/x)}', '/b/'), 'a{b:url(/b/x)}');
});

test('redirects: paths on the app stay in the preview; other local ports and scripts are dropped', async () => {
  const t = await open();
  const b = `/preview/${t}/`;
  assert.equal((await raw(`${b}redir-path`)).headers.location, `${b}target?x=1`);
  assert.equal((await raw(`${b}redir-full`)).headers.location, `${b}full#h`);
  assert.equal((await raw(`${b}redir-other`)).headers.location, undefined);
  assert.equal((await raw(`${b}redir-ext`)).headers.location, 'https://example.com/docs');
  assert.equal((await raw(`${b}redir-js`)).headers.location, undefined);
  assert.equal(rewriteLocation('next.html', b, appPort), 'next.html');
  assert.equal(rewriteLocation(`http://localhost:${appPort}/x`, b, appPort), `${b}x`);
  // "/preview/<token>" without the slash goes to the start page.
  const p = await previews.start({ conversationId: conv().id, workspace: 'main', port: appPort, path: '/about.html', jobs });
  const r = await raw(`/preview/${p.token}`);
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, `/preview/${p.token}/about.html`);
});

test('wrong, revoked, expired and job-ended tokens all answer 404', async () => {
  assert.equal((await raw('/preview/0123456789abcdef0123456789abcdef/')).status, 404);
  assert.equal((await raw('/preview/not-a-token/')).status, 404);
  assert.equal((await raw('/preview/')).status, 404);
  let t = await open();
  assert.equal((await raw(`/preview/${t}/`)).status, 200);
  assert.ok(previews.stop(t));
  assert.equal((await raw(`/preview/${t}/`)).status, 404, 'revoked');
  t = await open();
  now += 12 * 3600_000 + 1;
  assert.equal((await raw(`/preview/${t}/`)).status, 404, 'expired after 12 hours');
  t = await open();
  jobAlive = false;
  try {
    assert.equal((await raw(`/preview/${t}/`)).status, 404, 'the job ended');
  } finally {
    jobAlive = true;
  }
  t = await open();
  previews.jobEnded(1);
  assert.equal((await raw(`/preview/${t}/`)).status, 404, 'closed when the job reports its end');
  // The owner's cookie is never a way in.
  assert.equal((await raw('/preview/0123456789abcdef0123456789abcdef/', { headers: { cookie } })).status, 404);
});

test('only a port her own job in that workspace opened; never Sara’s own port', async () => {
  const c = conv().id;
  await assert.rejects(previews.start({ conversationId: c, workspace: 'main', port: otherPort, jobs }), PreviewError, 'a local service her job did not open');
  await assert.rejects(previews.start({ conversationId: c, workspace: 'main', port: 11434, jobs }), PreviewError);
  await assert.rejects(previews.start({ conversationId: c, workspace: 'other', port: appPort, jobs }), /Nothing is running in this workspace/);
  await assert.rejects(previews.start({ conversationId: c, workspace: 'main', port: Number(new URL(base).port), jobs }), /Sara's own port/);
  await assert.rejects(previews.start({ conversationId: c, workspace: 'main', port: 80, jobs }), /between 1024/);
  await assert.rejects(previews.start({ conversationId: c, workspace: 'main', port: appPort, jobs: undefined }), PreviewError);
  // Without a port: found in the job's output (and still checked).
  const p = await previews.start({ conversationId: c, workspace: 'main', jobs });
  assert.equal(p.port, appPort);
  assert.match(previewUrl(p), /^\/preview\/[0-9a-f]{32}\/$/);
  assert.equal(p.token.length, 32, '128-bit token');
  // A new preview of the same port replaces the old link.
  const q = await previews.start({ conversationId: c, workspace: 'main', port: appPort, jobs });
  assert.equal(previews.get(p.token), undefined);
  assert.ok(previews.get(q.token));
});

test('no path traversal, backslashes or absolute addresses; the app only ever gets a path on its own port', async () => {
  const t = await open();
  for (const bad of [`/preview/${t}/../../api/session`, `/preview/${t}/%2e%2e/%2e%2e/api/session`, `/preview/${t}/a/..%2F..%2Fapi`, `/preview/${t}//evil.example/x`, `/preview/${t}/a\\..\\b`, `/preview/${t}/%5c..%5capi`, `/preview/${t}/./x`, `/preview/${t}/%00`]) {
    const before = seen.length;
    const r = await raw(bad);
    assert.equal(r.status, 400, bad);
    assert.equal(seen.length, before, `${bad} must not reach the app`);
  }
  // An absolute address in the path is just a path for the app (on 127.0.0.1:<its port>).
  const r = await raw(`/preview/${t}/http://127.0.0.1:${otherPort}/`);
  assert.doesNotMatch(r.body, /SECRET/);
  assert.equal(JSON.parse(r.body).url, `/http://127.0.0.1:${otherPort}/`);
  // An absolute-form request target never goes to the preview proxy.
  const s = connect(Number(new URL(base).port), '127.0.0.1');
  const reply = await new Promise<string>((resolve) => {
    let got = '';
    s.on('data', (d) => (got += d.toString()));
    s.on('end', () => resolve(got));
    s.on('error', () => resolve(got));
    s.write(`GET http://127.0.0.1:${otherPort}/preview/${t}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  assert.doesNotMatch(reply, /SECRET/);
  assert.equal(safeTarget('/a/b?c=../d'), '/a/b?c=../d', 'dots in the query are fine');
  assert.throws(() => cleanStartPath('../etc/passwd'), PreviewError);
  assert.throws(() => cleanStartPath('//evil'), PreviewError);
  assert.equal(cleanStartPath('about.html'), '/about.html');
});

test('requests are rebuilt: exact length for chunked bodies, body cap, CORS preflight answered here, no WebSocket', async () => {
  const t = await open();
  // A chunked upload arrives at the app with a Content-Length and no Transfer-Encoding.
  const u = new URL(base);
  const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: Number(u.port), method: 'POST', path: `/preview/${t}/save`, headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, async (res) => resolve({ status: res.statusCode ?? 0, body: await readBody(res) }));
    req.on('error', reject);
    req.write('{"a":');
    req.end('1}');
  });
  const e = JSON.parse(r.body) as { method: string; body: string; headers: Record<string, string> };
  assert.equal(e.method, 'POST');
  assert.equal(e.body, '{"a":1}');
  assert.equal(e.headers['content-length'], '7');
  assert.equal(e.headers['transfer-encoding'], undefined);
  // Over 10 MB: refused before the app sees it.
  const before = seen.length;
  const big = await raw(`/preview/${t}/save`, { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': String(11 * 1024 * 1024) }, body: '' }).catch(() => ({ status: 413, headers: {}, body: '' }));
  assert.equal(big.status, 413);
  assert.equal(seen.length, before);
  // Methods outside the usual set.
  assert.equal((await raw(`/preview/${t}/x`, { method: 'PROPFIND' })).status, 405);
  // Preflight from the app's own scripts (opaque origin) is answered without the app.
  const pre = await raw(`/preview/${t}/api`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
  // WebSocket (hot reload) upgrades are refused.
  const s = connect(Number(u.port), '127.0.0.1');
  const reply = await new Promise<string>((resolve) => {
    let got = '';
    s.on('data', (d) => (got += d.toString()));
    s.on('close', () => resolve(got));
    s.write(`GET /preview/${t}/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  assert.match(reply, /^HTTP\/1.1 404/);
});

test('owner-only preview API: list, open for a job port, close', async () => {
  assert.equal((await fetch(`${base}/api/previews`)).status, 401);
  const h = { cookie, 'content-type': 'application/json' };
  const c = conv();
  const made = await fetch(`${base}/api/previews`, { method: 'POST', headers: h, body: JSON.stringify({ conversationId: c.id, port: appPort }) });
  assert.equal(made.status, 400, 'no jobs on this app context: refused');
  app.jobs = jobs as unknown as JobManager;
  try {
    const ok = await (await fetch(`${base}/api/previews`, { method: 'POST', headers: h, body: JSON.stringify({ conversationId: c.id, port: appPort }) })).json();
    assert.match(ok.url, /^\/preview\/[0-9a-f]{32}\/$/);
    const list = await (await fetch(`${base}/api/previews?workspace=main`, { headers: h })).json();
    assert.ok(list.previews.some((p: { token: string }) => p.token === ok.token));
    const del = await (await fetch(`${base}/api/previews/${ok.token}`, { method: 'DELETE', headers: h })).json();
    assert.equal(del.ok, true);
    assert.equal((await raw(ok.url)).status, 404);
    const refused = await fetch(`${base}/api/previews`, { method: 'POST', headers: h, body: JSON.stringify({ conversationId: c.id, port: otherPort }) });
    assert.equal(refused.status, 400);
  } finally {
    app.jobs = undefined;
  }
});

test('ports are found in dev-server output', () => {
  assert.deepEqual(portsInOutput('  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host'), [5173]);
  assert.deepEqual(portsInOutput('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), [8000]);
  assert.deepEqual(portsInOutput('listening on 127.0.0.1:3000\nrestarted on 127.0.0.1:3001'), [3001, 3000]);
  assert.deepEqual(portsInOutput('nothing here, port 80'), []);
});

// The OS check asks netstat and the Windows process list (PowerShell + WMI); on a loaded PC each
// answer takes 15-25 s, so these tests get a cap far above that. A quick machine is not slowed.
test('the real operating-system check: a port is "owned" only by the job’s own process tree', { timeout: 300_000 }, async () => {
  // A child process (like her job) listening on a free port.
  const script = join(dir, 'listen.cjs');
  writeFileSync(script, "require('http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',function(){console.log('PORT '+this.address().port)});setTimeout(()=>{},60000);");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise<number>((resolve) => child.stdout.on('data', (d: Buffer) => /PORT (\d+)/.test(String(d)) && resolve(Number(/PORT (\d+)/.exec(String(d))![1]))));
    assert.equal(await treeListensOn(child.pid!, port), true, 'the child listens there');
    assert.equal(await treeListensOn(child.pid!, appPort), false, 'a port this test process opened is not the child’s');
    assert.equal(await treeListensOn(process.pid, port), true, 'a parent owns what its children open');
  } finally {
    child.kill();
  }
});

test('ports (M1): only listeners the proxy reaches at 127.0.0.1 count; [::1] next to another program’s 127.0.0.1 is refused', { timeout: 300_000 }, async (t) => {
  // Parsers + the decision, on every platform.
  const ns = ['  TCP    0.0.0.0:7931   0.0.0.0:0   LISTENING   11', '  TCP    [::]:7931   [::]:0   LISTENING   11', '  TCP    [::1]:7932   [::]:0   LISTENING   22', '  TCP    127.0.0.1:7932   0.0.0.0:0   LISTENING   33'].join('\r\n');
  assert.deepEqual(parseNetstat(ns, 7931), [{ pid: 11, reaches: true }, { pid: 11, reaches: false }]);
  assert.deepEqual(parseNetstat(ns, 7932), [{ pid: 22, reaches: false }, { pid: 33, reaches: true }]);
  assert.equal(ownsPort(parseNetstat(ns, 7932), new Set([22])), false, 'the job only has [::1]; 127.0.0.1 is another program');
  assert.equal(ownsPort(parseNetstat(ns, 7932), new Set([22, 33])), true);
  assert.equal(ownsPort([{ pid: 22, reaches: false }], new Set([22])), false, '[::1] alone never counts');
  assert.equal(ownsPort([{ pid: 1, reaches: true }, { pid: 2, reaches: true }], new Set([1])), false, 'someone else listens there too');
  const lsof = ['p50', 'f5', 'tIPv6', 'n[::1]:8000', 'p60', 'f7', 'tIPv4', 'n127.0.0.1:8000', 'p70', 'f3', 'tIPv6', 'n*:8000'].join('\n');
  assert.deepEqual(parseLsof(lsof), [{ pid: 50, reaches: false }, { pid: 60, reaches: true }, { pid: 70, reaches: true }]);
  const proc = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode', '   0: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1', '   1: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1', '   2: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1'].join('\n');
  assert.deepEqual([...parseProcNet(proc, 8000)], [['111', true], ['222', false], ['333', true]]);
  // The real operating system: this test process holds 127.0.0.1:P, a child holds [::1]:P.
  const victim = createNetServer((s) => s.end('VICTIM-SERVICE'));
  await new Promise<void>((r) => victim.listen(0, '127.0.0.1', r));
  t.after(() => victim.close());
  const port = (victim.address() as AddressInfo).port;
  const script = join(dir, 'listen6.cjs');
  writeFileSync(script, `require('net').createServer((s)=>s.end('JOB')).on('error',(e)=>{console.log('ERR '+e.code);}).listen(${port},'::1',function(){console.log('PORT '+this.address().port)});setTimeout(()=>{},60000);`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const said = await new Promise<string>((resolve) => child.stdout.on('data', (d: Buffer) => resolve(String(d))));
  if (!/PORT/.test(said)) {
    t.skip(`no IPv6 loopback here (${said.trim()})`);
    return;
  }
  assert.equal(await treeListensOn(child.pid!, port), false, 'a job on [::1] does not own 127.0.0.1');
});

test('integration: a real background job, port found in its output, token ends when the job stops', { timeout: 300_000 }, async () => {
  const jm = new JobManager(app, app.store.db);
  const pm = new PreviewManager();
  jm.onEnd = (j) => pm.jobEnded(j.id, jm);
  const c = conv();
  const ws = workspaceDir(dir, c.workspace);
  writeFileSync(join(ws, 'server.cjs'), "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<html><head></head><body>hello from the job</body></html>')}).listen(0,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port+'/')});");
  const node = process.execPath.replace(/\\/g, '/');
  // The job outlives the test's own cap: it is stopped on purpose below, never by its time limit
  // (a 60 s limit once ended it while a loaded PC was still checking the port, so the page was gone).
  const { job, done } = jm.start({ conversationId: c.id, workspace: c.workspace, label: 'dev server', command: `"${node}" server.cjs`, timeoutMs: 600_000 });
  try {
    let port = 0;
    const printed = Date.now() + 60_000;
    while (!port && Date.now() < printed) {
      await new Promise((r) => setTimeout(r, 100));
      port = portsInOutput(jm.get(job.id)!.tail)[0] ?? 0;
    }
    assert.ok(port, 'the job printed its port');
    await assert.rejects(pm.start({ conversationId: c.id, workspace: c.workspace, port: otherPort, jobs: jm }), PreviewError, 'a port another process opened');
    const p = await pm.start({ conversationId: c.id, workspace: c.workspace, jobs: jm });
    assert.equal(p.port, port);
    assert.equal(p.jobId, job.id);
    const srv = await listen((req, res) => void pm.handle(req, res));
    try {
      const page = await fetch(`${srv.url}${previewUrl(p)}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /hello from the job/);
      jm.stop(job.id);
      await done;
      assert.equal((await fetch(`${srv.url}${previewUrl(p)}`)).status, 404, 'gone with the job');
    } finally {
      srv.server.close();
    }
  } finally {
    jm.stop(job.id);
    await done.catch(() => {});
  }
});
