// EC9 (docs/ops/EC89_DESIGN.md): the egress allowlist. A small HTTP proxy per run lets a sandboxed
// command or plugin job reach only listed hosts, refuses everything else (one audit row per host per
// run), never resolves a listed name to a private address unless told to, and can add a key at the
// proxy so the key never enters the sandbox. Fake targets listen on 7907/7908 (the proxy itself on
// an ephemeral port); names are resolved by an injected resolver.
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { EgressError, matchEntry, parseAllowlist, startEgressProxy, startForwarder, type EgressRefusal } from '../src/egress.ts';

const ALLOWED = 7907;
const OTHER = 7908;

function fake(port: number, name: string): Promise<Server & { seen: { url?: string; auth?: string }[] }> {
  const seen: { url?: string; auth?: string }[] = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    res.end(`${name}:${req.url}`);
  }) as Server & { seen: typeof seen };
  s.seen = seen;
  return new Promise((ok) => s.listen(port, '127.0.0.1', () => ok(s)));
}

const resolve = async (host: string) => {
  if (host.endsWith('.test')) return '127.0.0.1';
  throw new Error('no such host');
};

/** A raw CONNECT through the proxy, then one GET inside the tunnel. Returns the proxy status line and body. */
function tunnel(proxyPort: number, target: string): Promise<{ status: string; body: string }> {
  return new Promise((ok, fail) => {
    const s = connect(proxyPort, '127.0.0.1');
    let buf = '';
    let opened = false;
    s.on('data', (d) => {
      buf += d.toString();
      if (!opened && buf.includes('\r\n\r\n')) {
        const status = buf.split('\r\n')[0];
        if (!/ 200 /.test(status)) {
          s.destroy();
          return ok({ status, body: '' });
        }
        opened = true;
        buf = '';
        s.write('GET /in-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      }
    });
    s.on('end', () => ok({ status: 'HTTP/1.1 200 tunnel', body: buf.split('\r\n\r\n').slice(1).join('') }));
    s.on('error', fail);
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

function viaProxy(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', fail);
    r.end();
  });
}

test('allowlist entries: exact hosts, *.wildcards, ports, keys; bad entries refused', () => {
  const e = parseAllowlist(['Example.COM', '*.github.com', 'api.test:8443', { host: 'models.test', key: 'egress:models' }]);
  assert.deepEqual(e.map((x) => [x.host, x.wildcard, x.port ?? null, x.key ?? null]), [
    ['example.com', false, null, null],
    ['github.com', true, null, null],
    ['api.test', false, 8443, null],
    ['models.test', false, null, 'egress:models'],
  ]);
  assert.ok(matchEntry(e, 'example.com', 443));
  assert.ok(matchEntry(e, 'example.com', 80));
  assert.equal(matchEntry(e, 'example.com', 22), undefined, 'only 80/443 without an explicit port');
  assert.equal(matchEntry(e, 'evil-example.com', 443), undefined);
  assert.equal(matchEntry(e, 'sub.example.com', 443), undefined, 'exact means exact');
  assert.ok(matchEntry(e, 'raw.github.com', 443));
  assert.equal(matchEntry(e, 'github.com', 443), undefined, '*.x covers subdomains only');
  assert.equal(matchEntry(e, 'api.test', 443), undefined);
  assert.ok(matchEntry(e, 'api.test', 8443));
  for (const bad of ['', '*', '*.com', 'http://x.com', 'a b.com', 'x.com/path', 'x.com:0', 'x.com:99999', '1.2.3.4', '[::1]', 'localhost', 'x..com', '-x.com', { host: 'x.com', key: 'bad key!' }, 42])
    assert.throws(() => parseAllowlist([bad]), EgressError, JSON.stringify(bad));
  assert.throws(() => parseAllowlist(Array.from({ length: 51 }, (_, i) => `h${i}.example.com`)), EgressError);
  assert.deepEqual(parseAllowlist([]), []);
});

test('proxy: a listed host is reachable (CONNECT and plain HTTP), any other is refused once per host', async (t) => {
  const a = await fake(ALLOWED, 'allowed');
  const b = await fake(OTHER, 'other');
  const refused: EgressRefusal[] = [];
  const p = await startEgressProxy({ entries: parseAllowlist([`allowed.test:${ALLOWED}`]), resolve, privateOk: true, onRefused: (r) => refused.push(r) });
  t.after(async () => {
    await p.close();
    a.close();
    b.close();
  });
  assert.ok(p.port && p.port > 0);
  const ok = await tunnel(p.port!, `allowed.test:${ALLOWED}`);
  assert.match(ok.status, / 200 /);
  assert.equal(ok.body, 'allowed:/in-tunnel');
  const plain = await viaProxy(p.port!, `http://allowed.test:${ALLOWED}/plain`);
  assert.equal(plain.status, 200);
  assert.equal(plain.body, 'allowed:/plain');
  const no = await tunnel(p.port!, `other.test:${OTHER}`);
  assert.match(no.status, / 403 /);
  const no2 = await viaProxy(p.port!, `http://other.test:${OTHER}/x`);
  assert.equal(no2.status, 403);
  assert.equal(b.seen.length, 0, 'the unlisted target never saw a request');
  assert.deepEqual(refused, [{ host: 'other.test', port: OTHER, why: 'not-listed' }], 'one refusal per host per run');
  // An IP address or an unlisted port of a listed host is refused too.
  assert.match((await tunnel(p.port!, `127.0.0.1:${ALLOWED}`)).status, / 403 /);
  assert.match((await tunnel(p.port!, 'allowed.test:22')).status, / 403 /);
});

test('proxy: a listed name that resolves to a private or loopback address is refused (Sara stays unreachable)', async (t) => {
  const a = await fake(ALLOWED, 'allowed');
  const refused: EgressRefusal[] = [];
  const p = await startEgressProxy({ entries: parseAllowlist([`allowed.test:${ALLOWED}`]), resolve, onRefused: (r) => refused.push(r) });
  t.after(async () => {
    await p.close();
    a.close();
  });
  assert.match((await tunnel(p.port!, `allowed.test:${ALLOWED}`)).status, / 403 /);
  assert.equal(a.seen.length, 0);
  assert.deepEqual(refused, [{ host: 'allowed.test', port: ALLOWED, why: 'private' }]);
});

test('proxy: a key is added at the proxy for its host and never comes from the sandbox', async (t) => {
  const a = await fake(ALLOWED, 'allowed');
  const p = await startEgressProxy({ entries: parseAllowlist([{ host: `allowed.test:${ALLOWED}`, key: 'egress:fake' }]), resolve, privateOk: true, upstreamHttps: false, secret: (k) => (k === 'egress:fake' ? 'sk-test-123' : undefined) });
  t.after(async () => {
    await p.close();
    a.close();
  });
  const r = await viaProxy(p.port!, `http://allowed.test:${ALLOWED}/v1`, { authorization: 'Bearer from-inside' });
  assert.equal(r.status, 200);
  assert.deepEqual(a.seen, [{ url: '/v1', auth: 'Bearer sk-test-123' }], 'the inside header is replaced by the vault key');
  // CONNECT to a key-bearing host is refused: the key could not be added inside TLS.
  assert.match((await tunnel(p.port!, `allowed.test:${ALLOWED}`)).status, / 403 /);
});

test('forwarder: a TCP port inside the sandbox reaches the proxy over a socket path (the bubblewrap bridge)', async (t) => {
  const a = await fake(ALLOWED, 'allowed');
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\sara-egress-test-${process.pid}` : `${process.env.TMPDIR ?? '/tmp'}/sara-egress-${process.pid}.sock`;
  const p = await startEgressProxy({ entries: parseAllowlist([`allowed.test:${ALLOWED}`]), resolve, privateOk: true, listen: { path } });
  const f = await startForwarder(0, path);
  t.after(async () => {
    await f.close();
    await p.close();
    a.close();
  });
  const port = (f.server.address() as AddressInfo).port;
  const ok = await tunnel(port, `allowed.test:${ALLOWED}`);
  assert.equal(ok.body, 'allowed:/in-tunnel');
});

test('the sidecar program (node egress.ts serve) answers on its port and prints each refusal', async (t) => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['src/egress.ts', 'serve'], { env: { SARA_EGRESS_ALLOW: JSON.stringify(['allowed.example.com']), SARA_EGRESS_PORT: '7909', SARA_EGRESS_SECRETS: '{}', SystemRoot: process.env.SystemRoot ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const until = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, re);
  };
  await until(/SARA-EGRESS-READY 7909/);
  assert.match((await tunnel(7909, 'other.example.org:443')).status, / 403 /);
  await until(/SARA-EGRESS-REFUSED \{"host":"other.example.org","port":443,"why":"not-listed"\}/);
});

// ---- the backend that exists on this PC: a real Node-only plugin job ----

const PROBE = `import net from 'node:net';
import dns from 'node:dns/promises';
const out = {};
const get = async (k, url) => {
  try {
    const r = await fetch(url);
    out[k] = r.status + ':' + (await r.text()).trim();
  } catch (e) {
    out[k] = 'ERR ' + String(e.cause?.message ?? e.message).slice(0, 120);
  }
};
await get('allowed', 'http://allowed.test:${ALLOWED}/hi');
await get('other', 'http://other.test:${OTHER}/x');
await new Promise((done) => {
  const s = net.connect(${OTHER}, '127.0.0.1');
  s.on('connect', () => { out.direct = 'connected'; s.destroy(); done(); });
  s.on('error', (e) => { out.direct = e.code; done(); });
});
await new Promise((done) => {
  const s = net.connect(${ALLOWED}, 'allowed.test');
  s.on('connect', () => { out.directAllowed = 'connected'; s.destroy(); done(); });
  s.on('error', (e) => { out.directAllowed = e.code; done(); });
});
try { await dns.lookup('example.com'); out.dns = 'resolved'; } catch (e) { out.dns = e.code; }
try { Object.defineProperty(net.Socket.prototype, 'connect', { value: () => 0 }); out.unpatch = 'replaced'; } catch { out.unpatch = 'refused'; }
try { process.binding('tcp_wrap'); out.binding = 'open'; } catch (e) { out.binding = e.code; }
console.log(JSON.stringify(out));
`;

async function probeJob(t: { after: (fn: () => void | Promise<void>) => void }, network: boolean) {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parsePlan, runJob } = await import('../src/plugins/exec-job.ts');
  const root = mkdtempSync(join(tmpdir(), 'ec89-job-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'probe.mjs'), PROBE);
  const plan = parsePlan({ program: 'node', args: ['probe.mjs'], network, timeoutS: 60 }, { programs: ['node'], sources: ['data'], network: true }, 'node-only');
  const r = await runJob(plan, { sourceDir: src, cacheDir: join(root, 'cache'), fence: 'node-only', signal: new AbortController().signal });
  assert.equal(r.exitCode, 0, `${r.stderr}\n${r.error ?? ''}`);
  return { r, out: JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, string> };
}

test('Node-only plugin job under the allowlist (this PC): listed host answers, others refused and audited, direct and DNS blocked', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AuditTrail, setAuditTrail } = await import('../src/audit-trail.ts');
  const { setEgressProxyOverrides, setEgressSource } = await import('../src/egress-run.ts');
  const a = await fake(ALLOWED, 'allowed');
  const b = await fake(OTHER, 'other');
  const dir = mkdtempSync(join(tmpdir(), 'ec89-audit-'));
  const trail = new AuditTrail(dir, { key: () => 'k' });
  setAuditTrail(trail);
  setEgressSource(() => parseAllowlist([`allowed.test:${ALLOWED}`]));
  setEgressProxyOverrides({ resolve, privateOk: true });
  t.after(() => {
    setEgressSource(() => undefined);
    setEgressProxyOverrides();
    setAuditTrail(undefined);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { r, out } = await probeJob(t, true);
  assert.equal(r.egress, 'node-guard');
  assert.equal(out.allowed, '200:allowed:/hi', 'the listed host answers through the proxy');
  // fetch tunnels through CONNECT; the proxy's 403 ends the request (refused, and audited below).
  assert.match(out.other, /^ERR /);
  assert.equal(out.direct, 'ERR_SARA_NET_BLOCKED', 'a direct connection that skips the proxy is blocked');
  assert.equal(out.directAllowed, 'ERR_SARA_NET_BLOCKED', 'even to a listed host');
  assert.equal(out.dns, 'ERR_SARA_NET_BLOCKED');
  assert.equal(out.unpatch, 'refused');
  assert.equal(out.binding, 'ERR_ACCESS_DENIED');
  assert.equal(b.seen.length, 0, 'the unlisted target never saw a request');
  assert.deepEqual(a.seen.map((s) => s.url), ['/hi']);
  const rows = trail.list({ action: 'egress.refused' });
  assert.deepEqual(rows.map((x) => [x.target, x.outcome, x.who]), [[`other.test:${OTHER}`, 'refused', 'plugin-job']]);
});

test('Node-only plugin job without network: every connection is blocked (not just proxy variables)', async (t) => {
  const a = await fake(ALLOWED, 'allowed');
  t.after(() => a.close());
  const { r, out } = await probeJob(t, false);
  assert.equal(r.egress, 'off');
  assert.match(out.allowed, /^ERR /);
  assert.equal(out.direct, 'ERR_SARA_NET_BLOCKED');
  assert.equal(out.dns, 'ERR_SARA_NET_BLOCKED');
  assert.equal(a.seen.length, 0);
});

// ---- Linux with bubblewrap (the Linux server runs these; skipped elsewhere) ----
const hasBwrap = process.platform === 'linux' && (await import('node:child_process')).spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true']).status === 0;

test('bubblewrap command under the allowlist: listed host via the bridge, others refused, direct blocked', { skip: hasBwrap ? false : 'needs Linux with bubblewrap (the server runs it)' }, async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setEgressProxyOverrides, setEgressSource } = await import('../src/egress-run.ts');
  const { runCommand } = await import('../src/tools/sandbox.ts');
  const a = await fake(ALLOWED, 'allowed');
  const b = await fake(OTHER, 'other');
  const ws = mkdtempSync(join(tmpdir(), 'ec89-bw-'));
  setEgressSource(() => parseAllowlist([`allowed.test:${ALLOWED}`]));
  setEgressProxyOverrides({ resolve, privateOk: true });
  t.after(() => {
    setEgressSource(() => undefined);
    setEgressProxyOverrides();
    a.close();
    b.close();
    rmSync(ws, { recursive: true, force: true });
  });
  const probe = `const o={};for(const [k,u] of [['allowed','http://allowed.test:${ALLOWED}/hi'],['other','http://other.test:${OTHER}/x']]){try{const r=await fetch(u);o[k]=r.status+':'+(await r.text())}catch(e){o[k]='ERR'}};await new Promise(d=>{const s=require('node:net').connect(${OTHER},'127.0.0.1');s.on('connect',()=>{o.direct='connected';s.destroy();d()});s.on('error',e=>{o.direct=e.code;d()})});console.log(JSON.stringify(o))`;
  const r = await runCommand(`node --input-type=commonjs -e ${JSON.stringify(`(async()=>{${probe}})()`)}`, ws, { mode: 'bwrap', network: true, detail: '' }, { timeoutMs: 60_000, signal: new AbortController().signal });
  const out = JSON.parse(r.output.trim().split('\n').at(-1)!);
  assert.equal(out.allowed, '200:allowed:/hi');
  assert.equal(out.other, 'ERR');
  assert.notEqual(out.direct, 'connected');
  assert.equal(b.seen.length, 0);
});
