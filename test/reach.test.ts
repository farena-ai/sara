// 3.3.0 (easy reach): how other devices reach Sara (src/reach.ts), with a fake tailscale command.
// Nothing here runs the real Tailscale: every call goes to the fake below and is recorded.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { browserOrigin, checkReach, cleanOrigin, computerPairLink, isLoopbackHost, phonePairLink, resolveReach, serveOff, serveOn, setReachDeps, type ReachDeps } from '../src/reach.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const DNS = 'box.tail-1234.ts.net';
const TS_IP = '100.101.102.103';
interface Fake {
  state?: string;
  dns?: string | null;
  https?: boolean;
  serve?: Record<string, unknown>;
  serveExit?: number;
  serveOut?: string;
}
/** A fake tailscale CLI: answers status / serve status from `f`, records every call. */
function fakeTs(f: Fake, calls: string[][] = []): ReachDeps['run'] {
  return async (_cli, args) => {
    calls.push(args);
    if (args[0] === 'status') {
      return { status: f.state === 'Running' ? 0 : 1, stderr: '', stdout: JSON.stringify({ BackendState: f.state ?? 'Running', CertDomains: f.https === false ? [] : f.dns === null ? null : [f.dns ?? DNS], Self: { DNSName: f.dns === null ? '' : `${f.dns ?? DNS}.`, TailscaleIPs: [TS_IP, 'fd7a:115c:a1e0::1'] } }) };
    }
    if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stderr: '', stdout: JSON.stringify(f.serve ?? {}) };
    if (args[0] === 'serve' && args[1] === '--bg') {
      if (!f.serveExit) {
        const p = Number(String(args[2]).split('=')[1]);
        f.serve = { ...(f.serve ?? {}), TCP: { ...((f.serve?.TCP as object) ?? {}), [p]: { HTTPS: true } }, Web: { ...((f.serve?.Web as object) ?? {}), [`${f.dns ?? DNS}:${p}`]: { Handlers: { '/': { Proxy: args[3] } } } } };
      }
      return { status: f.serveExit ?? 0, stdout: f.serveOut ?? '', stderr: '' };
    }
    if (args[0] === 'serve' && String(args[1]).startsWith('--https=') && args[2] === 'off') {
      const p = String(args[1]).split('=')[1];
      const web = { ...((f.serve?.Web as Record<string, unknown>) ?? {}) };
      delete web[`${f.dns ?? DNS}:${p}`];
      f.serve = { ...(f.serve ?? {}), Web: web };
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unknown' };
  };
}
const ifs = (...addrs: string[]) => () => ({ eth: addrs.map((address) => ({ address, family: 'IPv4' as const, internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null })), lo: [{ address: '127.0.0.1', family: 'IPv4' as const, internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: null }] });
const ourServe = (port: number, httpsPort = 443) => ({ TCP: { [httpsPort]: { HTTPS: true } }, Web: { [`${DNS}:${httpsPort}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
const noTs = (): ReachDeps => ({ cli: () => null, interfaces: ifs() });

afterEach(() => setReachDeps({}));

test('reach: never offers this computer (127.0.0.1, localhost, ::1, 0.0.0.0) to another device', async () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'sara.localhost', '::1', '[::1]', '0.0.0.0', '::']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['192.168.1.5', TS_IP, DNS, 'sara.example.com']) assert.equal(isLoopbackHost(h), false, h);
  assert.equal(cleanOrigin('http://127.0.0.1:7860'), null);
  assert.equal(cleanOrigin('http://localhost:7860/x'), null);
  assert.equal(cleanOrigin('https://user:pw@sara.example.com'), null, 'no user info');
  assert.equal(cleanOrigin('ftp://sara.example.com'), null);
  assert.equal(cleanOrigin('https://sara.example.com/a/b'), 'https://sara.example.com');
  // Loopback everywhere: the browser's address, SARA_PUBLIC_URL (the installer's "just this computer"), the host.
  setReachDeps({ ...noTs(), env: { SARA_PORT: '7860', SARA_PUBLIC_URL: 'http://127.0.0.1:7860', SARA_ACCESS: 'local' }, interfaces: ifs('192.168.1.20') });
  const r = await resolveReach({ origin: 'http://127.0.0.1:7860', fresh: true });
  assert.equal(r.address, null);
  assert.equal(r.awayAddress, null);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.listen.loopbackOnly, true);
  assert.equal(r.tailscale.installed, false);
  assert.throws(() => phonePairLink('http://127.0.0.1:7860', 'AAAA-BBBB-CCCC'));
  assert.throws(() => computerPairLink('http://localhost:7860', 'AAAA-BBBB-CCCC'));
  assert.equal(JSON.stringify(r).includes('127.0.0.1:7860'), false, 'no loopback address anywhere in the answer');
});

test('reach: tailscale serve pointing at Sara is the first choice (https, works anywhere)', async () => {
  const calls: string[][] = [];
  setReachDeps({ cli: () => 'C:\\fake\\tailscale.exe', run: fakeTs({ serve: ourServe(7861, 8443) }, calls), interfaces: ifs('192.168.1.20', TS_IP), env: { SARA_PORT: '7861', SARA_HOST: '0.0.0.0' } });
  const r = await resolveReach({ fresh: true });
  assert.equal(r.address, `https://${DNS}:8443`);
  assert.equal(r.kind, 'tailscale-https');
  assert.equal(r.away, true);
  assert.equal(r.https, true);
  assert.equal(r.tailscale.serve.on, true);
  assert.equal(r.tailscale.canServe, false, 'already on');
  assert.deepEqual(r.candidates.map((c) => c.kind), ['tailscale-https', 'tailscale', 'lan'], 'then the 100.x address, then the home network');
  assert.deepEqual(calls, [['status', '--json'], ['serve', 'status', '--json']], 'read-only questions only');
});

test('reach: Tailscale running but Sara only on this computer: no address yet, and "Turn on secure access" can be offered', async () => {
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({}), interfaces: ifs('192.168.1.20', TS_IP), env: { SARA_PORT: '7862' } });
  const r = await resolveReach({ origin: 'http://localhost:7862', fresh: true });
  assert.equal(r.address, null);
  assert.equal(r.tailscale.running, true);
  assert.equal(r.tailscale.dnsName, DNS);
  assert.equal(r.tailscale.ip, TS_IP);
  assert.equal(r.tailscale.canServe, true);
  // HTTPS certificates off on the tailnet: serve can't give https, so it isn't offered.
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ https: false }), interfaces: ifs(), env: { SARA_PORT: '7862' } });
  assert.equal((await resolveReach({ fresh: true })).tailscale.canServe, false);
  // Signed out: installed, not running.
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ state: 'NeedsLogin' }), interfaces: ifs(), env: {} });
  const s = await resolveReach({ fresh: true });
  assert.deepEqual([s.tailscale.installed, s.tailscale.running, s.tailscale.state], [true, false, 'NeedsLogin']);
});

test('reach: listening on the network: Tailscale 100.x (away) before the home network (home only)', async () => {
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({}), interfaces: ifs('192.168.1.20', TS_IP), env: { SARA_PORT: '7863', SARA_HOST: '0.0.0.0' } });
  const r = await resolveReach({ fresh: true });
  assert.equal(r.address, `http://${TS_IP}:7863`);
  assert.equal(r.kind, 'tailscale');
  assert.equal(r.away, true);
  assert.equal(r.https, false);
  // No Tailscale: the home network, which is not "away".
  setReachDeps({ ...noTs(), interfaces: ifs('192.168.1.20'), env: { SARA_PORT: '7863', SARA_HOST: '0.0.0.0' } });
  const h = await resolveReach({ fresh: true });
  assert.equal(h.address, 'http://192.168.1.20:7863');
  assert.equal(h.kind, 'lan');
  assert.equal(h.away, false);
  assert.equal(h.awayAddress, null);
  // A 100.x interface without the command still counts as Tailscale.
  setReachDeps({ ...noTs(), interfaces: ifs(TS_IP), env: { SARA_PORT: '7863', SARA_HOST: '0.0.0.0' } });
  assert.equal((await resolveReach({ fresh: true })).address, `http://${TS_IP}:7863`);
});

test('reach: the owner\'s https address and the address the browser used count; a home name stays "home only"', async () => {
  setReachDeps({ ...noTs(), env: { SARA_PUBLIC_URL: 'https://sara.example.com', SARA_PORT: '7864' } });
  const r = await resolveReach({ fresh: true });
  assert.deepEqual([r.address, r.kind, r.away, r.https], ['https://sara.example.com', 'public', true, true]);
  setReachDeps({ ...noTs(), env: { SARA_PORT: '7864' } });
  const b = await resolveReach({ origin: `https://${DNS}`, fresh: true });
  assert.deepEqual([b.address, b.kind], [`https://${DNS}`, 'tailscale-https']);
  const l = await resolveReach({ origin: 'http://192.168.1.9:7864', fresh: true });
  assert.deepEqual([l.address, l.away], ['http://192.168.1.9:7864', false]);
  // browserOrigin: Origin first, then Host with the forwarded protocol; loopback → null.
  assert.equal(browserOrigin({ headers: { origin: 'http://127.0.0.1:7864' } }), null);
  assert.equal(browserOrigin({ headers: { host: DNS, 'x-forwarded-proto': 'https' } }), `https://${DNS}`);
  assert.equal(browserOrigin({ headers: { host: 'localhost:7864' } }), null);
});

test('reach: the phone QR link opens the Sara app with the reachable address and the one-time code', () => {
  const link = phonePairLink(`https://${DNS}:8443/`, 'ABCD-EFGH-JKLM');
  assert.equal(link, `https://backstagecoding.com/sara/pair#s=${encodeURIComponent(`https://${DNS}:8443`)}&c=ABCD-EFGH-JKLM`);
  // The Android app reads s= and c= after the # (MainActivity.handlePairLink).
  const frag = new URLSearchParams(new URL(link).hash.slice(1));
  assert.equal(frag.get('s'), `https://${DNS}:8443`);
  assert.equal(frag.get('c'), 'ABCD-EFGH-JKLM');
  const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:host="backstagecoding\.com"/);
  assert.match(manifest, /android:pathPrefix="\/sara\/pair"/);
  assert.equal(computerPairLink('http://192.168.1.20:7860', 'ABCD-EFGH-JKLM'), 'http://192.168.1.20:7860/pair#ABCD-EFGH-JKLM');
});

test('serve on: a free HTTPS port (the owner\'s own 443 stays), recorded for Undo; Undo turns off only her own', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const calls: string[][] = [];
    const owners = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
    const f: Fake = { serve: owners };
    setReachDeps({ cli: () => 'tailscale', run: fakeTs(f, calls), interfaces: ifs(), env: { SARA_PORT: '7865' } });
    const on = await serveOn({ dataDir: dir });
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(on.url, `https://${DNS}:8443`);
    assert.deepEqual(calls.find((c) => c[1] === '--bg'), ['serve', '--bg', '--https=8443', 'http://127.0.0.1:7865'], 'tailnet only (serve, never funnel), to this computer');
    assert.equal(calls.some((c) => c.includes('funnel')), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'reach.json'), 'utf8')).servePort, 8443);
    const r = await resolveReach({ dataDir: dir, fresh: true });
    assert.equal(r.address, `https://${DNS}:8443`);
    assert.equal(r.tailscale.serve.ours, true);
    // Turning it on again changes nothing.
    const n = calls.length;
    assert.equal((await serveOn({ dataDir: dir })).ok, true);
    assert.equal(calls.slice(n).some((c) => c[1] === '--bg'), false);
    // Undo: only port 8443, and the owner's 443 is still there.
    const off = await serveOff({ dataDir: dir });
    assert.equal(off.ok, true);
    assert.deepEqual(calls.at(-1), ['serve', '--https=8443', 'off']);
    assert.ok((f.serve!.Web as Record<string, unknown>)[`${DNS}:443`], "the owner's own serve stays");
    // Nothing of hers left: Undo refuses to touch anything.
    assert.equal((await serveOff({ dataDir: dir })).code, 'NOT_OURS');
  } finally {
    cleanup();
  }
});

test('serve on: plain reasons when it can\'t (not installed, signed out, HTTPS off, Tailscale asks to approve)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    setReachDeps({ ...noTs(), env: {} });
    assert.equal((await serveOn({ dataDir: dir })).code, 'NO_TAILSCALE');
    setReachDeps({ cli: () => 'tailscale', run: fakeTs({ state: 'Stopped' }), interfaces: ifs(), env: {} });
    assert.equal((await serveOn({ dataDir: dir })).code, 'NOT_RUNNING');
    setReachDeps({ cli: () => 'tailscale', run: fakeTs({ https: false }), interfaces: ifs(), env: {} });
    const h = await serveOn({ dataDir: dir });
    assert.equal(h.code, 'NO_HTTPS');
    assert.equal(h.link, 'https://login.tailscale.com/admin/dns');
    setReachDeps({ cli: () => 'tailscale', run: fakeTs({ serveExit: 1, serveOut: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n' }), interfaces: ifs(), env: {} });
    const a = await serveOn({ dataDir: dir });
    assert.equal(a.code, 'NEEDS_APPROVAL');
    assert.equal(a.link, 'https://login.tailscale.com/f/serve?node=abc123');
    assert.equal(existsSync(join(dir, 'reach.json')), false, 'nothing recorded when it did not work');
  } finally {
    cleanup();
  }
});

// ---- the routes ----

const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date() });
const auth = new OwnerAuth(dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let PORT = 0;
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  PORT = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${PORT}`;
});
after(() => {
  setReachDeps({});
  server.close();
  app.store.close();
  cleanup();
});
const call = async (method: string, path: string, body?: unknown, tok: string | null = token) => {
  const r = await fetch(base + path, { method, headers: { origin: base, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
};

test('routes: GET /api/access/reach is the owner\'s; the pairing QR is only made with a reachable address', async () => {
  setReachDeps({ ...noTs(), env: { SARA_PORT: '7866' } });
  assert.equal((await call('GET', '/api/access/reach', undefined, null)).status, 401);
  const r = await call('GET', '/api/access/reach');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.address, null);
  assert.equal((r.json.get as { android: string }).android, 'https://play.google.com/store/apps/details?id=com.backstagecoding.sara');
  // No reachable address: no QR (the old one held http://127.0.0.1/pair, which a phone can't open).
  const p = await call('POST', '/api/pair', {});
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.reachable, false);
  assert.equal(p.json.qr, undefined);
  assert.equal(p.json.phone, undefined);
  // With Tailscale serve on: the phone QR holds the app link with the ts.net address and the code.
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ serve: ourServe(PORT) }), interfaces: ifs(), env: { SARA_PORT: '7866' } });
  const q = await call('POST', '/api/pair', {});
  const phone = q.json.phone as { link: string; qr: string; address: string };
  assert.equal(q.json.reachable, true);
  assert.equal(phone.address, `https://${DNS}`);
  assert.equal(phone.link, `https://backstagecoding.com/sara/pair#s=${encodeURIComponent(`https://${DNS}`)}&c=${q.json.code}`);
  assert.match(phone.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((q.json.computer as { url: string }).url, `https://${DNS}/pair#${q.json.code}`);
  await call('DELETE', '/api/pair');
});

test('routes: serve on/off needs the owner, a confirmation, and no device-code app; the demo can\'t', async () => {
  const calls: string[][] = [];
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({}, calls), interfaces: ifs(), env: { SARA_PORT: '7867' } });
  assert.equal((await call('POST', '/api/access/serve', { action: 'on', confirm: true }, null)).status, 401);
  const nc = await call('POST', '/api/access/serve', { action: 'on' });
  assert.equal(nc.status, 400);
  assert.equal(nc.json.needsConfirm, true);
  assert.equal((await call('POST', '/api/access/serve', { action: 'sideways', confirm: true })).status, 400);
  assert.equal(calls.some((c) => c[1] === '--bg'), false, 'nothing ran before the confirmation');
  const devTok = auth.createDeviceToken('Terminal').token;
  assert.equal((await call('POST', '/api/access/serve', { action: 'on', confirm: true }, devTok)).status, 403);
  const on = await call('POST', '/api/access/serve', { action: 'on', confirm: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.ok, true);
  assert.equal(on.json.url, `https://${DNS}`);
  assert.equal((on.json.reach as { address: string }).address, `https://${DNS}`);
  const off = await call('POST', '/api/access/serve', { action: 'off', confirm: true });
  assert.equal(off.json.ok, true, off.text);
  assert.equal((off.json.reach as { address: string | null }).address, null);
});

test('routes: the self-test reaches this very Sara through the address, and tells another server apart', async () => {
  // The fake fetch sends the request for the ts.net address to this test server instead.
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ serve: ourServe(PORT) }), interfaces: ifs(), env: { SARA_PORT: '7868' }, fetch: ((u: string, init?: RequestInit) => fetch(String(u).replace(`https://${DNS}`, base), init)) as typeof fetch });
  const ok = await call('POST', '/api/access/reach/check', {});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true, ok.text);
  assert.equal(ok.json.address, `https://${DNS}`);
  // Another server answering at that address (no matching signature).
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ serve: ourServe(PORT) }), interfaces: ifs(), env: { SARA_PORT: '7868' }, fetch: (async () => new Response(JSON.stringify({ ok: true, reach: 'nope' }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  assert.equal((await checkReach(`https://${DNS}`)).code, 'OTHER');
  assert.equal((await checkReach(null)).code, 'NO_ADDRESS');
  assert.equal((await checkReach('http://127.0.0.1:7868')).code, 'NO_ADDRESS', 'never tests a loopback address');
  // The public ping refuses junk.
  assert.equal((await fetch(`${base}/api/health/reach?n=x`)).status, 400);
});

test('routes: the move-in line uses the same answer; without a reachable address the page gets reachable:false', async () => {
  setReachDeps({ ...noTs(), env: { SARA_PORT: '7869' } });
  const one = await call('POST', '/api/movein/oneline', { system: 'windows' });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.reachable, false);
  setReachDeps({ cli: () => 'tailscale', run: fakeTs({ serve: ourServe(PORT) }), interfaces: ifs(), env: { SARA_PORT: '7869' } });
  const two = await call('POST', '/api/movein/oneline', { system: 'windows' });
  assert.equal(two.json.reachable, true);
  assert.match(String(two.json.line), new RegExp(`^irm "https://${DNS.replace(/\./g, '\\.')}/movein/go\\.ps1\\?c=`));
});
