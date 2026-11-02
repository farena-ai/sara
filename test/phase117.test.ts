// Phase 117 part A (2.50.0, docs/design/BRIDGES3.md §9): the socket broker (permissions.connect),
// plugin contract v1.2, plugins that come with Sara (origin builtin), owner linking with a code, the
// 5-minute plugin-bridge fix (P6), the edit budget (P5) and the Signal plugin against a stand-in
// signal-cli JSON-RPC daemon written here (a TCP server on 127.0.0.1 that records every request and
// pushes envelopes). No real Signal account, no real network. Time is a manual clock wherever a
// timer matters. The email plugin is part B.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer, type AddressInfo, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import { createServer as tlsServer } from 'node:tls';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProgressMessage } from '../src/bridges/progress.ts';
import { SendQueue, type Clock } from '../src/bridges/sendq.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { fromFolder } from '../src/packages.ts';
import { identityOf } from '../src/plugins/bridge-db.ts';
import { PLUGIN_LIMITS, PluginManager, STILL_WORKING_LINE } from '../src/plugins/manager.ts';
import { addedPermissions, ManifestError, parseManifest, permissionLines } from '../src/plugins/manifest.ts';
import { addressAllowed, PluginSockets, splitAddress } from '../src/plugins/net.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';
import { makeCert } from './x509-test.ts';
import { dmEnvelope, FakeSignalCli } from './signal-cli-fake.ts';
import { keepRoomByKey, recentLines, setRoom } from '../src/bridges/keepup.ts';
import { makeTestPicture } from '../src/bridges/test-picture.ts';
const SARA_PKG_VERSION: string = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ------------------------------------------------------------------ helpers

/** A manual clock: timers run only when the test moves time on. */
class ManualClock implements Clock {
  t = 0;
  #timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.#timers = this.#timers.filter((x) => x.id !== h);
  }
  async advance(ms: number, step = 100): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      for (;;) {
        const due = this.#timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        this.#timers = this.#timers.filter((x) => x !== due);
        due.fn();
        await settle();
      }
      await settle();
    }
  }
}
const settle = () => new Promise((r) => setTimeout(r, 1));
async function drive<T>(clock: ManualClock, p: Promise<T>, maxMs = 60_000, step = 100): Promise<T> {
  let done = false;
  const out = p.finally(() => (done = true));
  for (let i = 0; i < maxMs / step && !done; i++) await clock.advance(step, step);
  return out;
}
const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};
function addSlowTool(app: TestApp, clock: ManualClock, name = 'slow', ms = 3000, output = 'done'): void {
  app.tools.add({ spec: { name, description: 'slow', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => `Run ${name}`, run: async () => {
    await new Promise<void>((r) => void clock.setTimeout(r, ms));
    return output;
  } });
}

function baseApp(dir: string): TestApp {
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.runTracked = async (id, content, onEvent, opts) => {
    for await (const ev of runTurn(app, id, content, undefined, opts)) onEvent(ev as ChatEvent);
  };
  return app;
}

type Op = (name: string, m: Record<string, unknown>) => Promise<Record<string, unknown>>;
function tap(pm: PluginManager, id: string): { out: Record<string, unknown>[]; op: Op } {
  const proc = pm.processOf(id, 'main')!;
  const out: Record<string, unknown>[] = [];
  const orig = proc.send.bind(proc);
  (proc as { send: (m: Record<string, unknown>) => boolean }).send = (m) => {
    out.push(m);
    return orig(m as never);
  };
  const op: Op = (name, m) => (proc as unknown as { events: { onCall: (op: string, msg: Record<string, unknown>) => Promise<Record<string, unknown>> } }).events.onCall(name, { type: 'call', ...m } as never).catch((err: Error): Record<string, unknown> => ({ denied: err.message }));
  return { out, op };
}

/** A LINE-like v1 plugin (the 2.49 contract) in a fresh rig. */
async function lineRig(t: { after: (fn: () => Promise<void> | void) => void }, clock: ManualClock, def = "{ bridges: { line: { send: async () => {} } }, tools: [], init: async () => {} }") {
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: SARA_PKG_VERSION, clock });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    app.store.close();
    cleanup();
  });
  cpSync(join(ROOT, 'examples', 'plugins', 'hello-hooks'), join(dir, 'br'), { recursive: true });
  const man = JSON.parse(readFileSync(join(dir, 'br', 'sara-plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'br', 'sara-plugin.json'), JSON.stringify({ ...man, id: 'line-bridge', name: 'LINE bridge', permissions: { bridges: ['line'], settings: true }, settings: [] }));
  writeFileSync(join(dir, 'br', 'main.mjs'), `import { plugin } from './sara-plugin.mjs';\nplugin(${def});\n`);
  const review = pm.stage(fromFolder(join(dir, 'br'), PLUGIN_LIMITS), { kind: 'folder', where: join(dir, 'br') });
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('line-bridge', 'main', true);
  await pm.putSettings('line-bridge', 'main', {}, { ownerChats: ['U-owner'], others: false });
  await until(() => pm.processOf('line-bridge', 'main')?.state === 'ready');
  return { app, pm, ...tap(pm, 'line-bridge') };
}

// ------------------------------------------------------------------ P6: the 5-minute bug (first)

test('P6 regression: a plugin chat-app turn longer than 5 minutes sends one "still working" line and then the WHOLE answer when it ends (2.49 sent a partial answer and lost the rest)', async (t) => {
  const clock = new ManualClock();
  const r = await lineRig(t, clock);
  // Four 2-minute steps (8 minutes), then the answer: nothing of it exists at 5 minutes.
  addSlowTool(r.app, clock, 'slow', 120_000);
  r.app.script.push([call('a', 'slow', {})], [call('b', 'slow', {})], [call('c', 'slow', {})], [call('d', 'slow', {})], text('The full answer, ', 'after eight minutes.'));
  const res = await drive(clock, r.op('bridge.inbound', { bridge: 'line', chatId: 'U-owner', from: 'Me', text: 'do the long job' }), 12 * 60_000, 1000);
  assert.equal(res.ok, true);
  const texts = r.out.filter((m) => m.type === 'bridge.send').map((m) => String(m.text)).filter((x) => !/is an AI companion, not a human/.test(x));
  assert.deepEqual(texts, [STILL_WORKING_LINE, 'The full answer, after eight minutes.'], 'one line at 5 minutes, then the whole reply (no partial reply)');
  // A v1 plugin still gets exactly the 2.49 message shape.
  assert.ok(r.out.filter((m) => m.type === 'bridge.send').every((m) => Object.keys(m).sort().join(',') === 'bridge,chatId,text,type,v'));
});

test('P6: a quick turn is unchanged (no "still working" line)', async (t) => {
  const clock = new ManualClock();
  const r = await lineRig(t, clock);
  r.app.script.push(text('Quick.'));
  await drive(clock, r.op('bridge.inbound', { bridge: 'line', chatId: 'U-owner', from: 'Me', text: 'hi' }));
  assert.deepEqual(r.out.filter((m) => m.type === 'bridge.send').map((m) => m.text).filter((x) => !/is an AI companion, not a human/.test(String(x))), ['Quick.']);
});

// ------------------------------------------------------------------ P1: the manifest and the broker

const V = SARA_PKG_VERSION;
const baseManifest = (connect: unknown, settings: unknown[] = [{ key: 'daemon', type: 'text', label: 'signal-cli address', default: '127.0.0.1:7583', tip: 'Where it listens on this computer.' }]) => ({ manifest: 1, id: 'c', name: 'C', version: '1.0.0', description: 'x', main: 'main.mjs', permissions: { bridges: ['c'], settings: true, connect }, settings });

test('manifest: permissions.connect is read, its card lines say where it connects, tls none on a public endpoint is refused at install, and an added port is an addition', () => {
  const m = parseManifest(baseManifest([{ id: 'daemon', host: 'setting:daemon', ports: 'setting', where: 'local', tls: 'none' }]), { saraVersion: V });
  assert.deepEqual(m.permissions.connect, [{ id: 'daemon', host: 'setting:daemon', ports: 'setting', where: 'local', tls: 'none' }]);
  const line = permissionLines(m).find((l) => l.id.startsWith('connect:'))!;
  assert.equal(line.key, 'Connects to a program on this computer at the address and port you give it in {setting}');
  assert.equal(line.params?.setting, 'signal-cli address');
  assert.equal(line.risk, 'high');
  const pub = parseManifest(baseManifest([{ id: 'imap', host: 'setting:imapHost', ports: [993, 143], where: 'public', tls: 'required' }], [{ key: 'imapHost', type: 'text', label: 'IMAP server', tip: 'Where she reads her mail.' }]), { saraVersion: V });
  assert.match(permissionLines(pub).find((l) => l.id.startsWith('connect:'))!.key, /always encrypted/);
  assert.throws(() => parseManifest(baseManifest([{ id: 'x', host: 'setting:daemon', ports: [25], where: 'public', tls: 'none' }]), { saraVersion: V }), ManifestError);
  assert.throws(() => parseManifest(baseManifest([{ id: 'x', host: 'mail.example.com', ports: [993], where: 'public', tls: 'required' }]), { saraVersion: V }), /setting:<key>/);
  assert.throws(() => parseManifest(baseManifest([{ id: 'x', host: 'setting:nope', ports: [993], where: 'public', tls: 'required' }]), { saraVersion: V }), /text settings/);
  assert.throws(() => parseManifest(baseManifest([{ id: 'x', host: 'setting:daemon', ports: 'setting', where: 'public', tls: 'required' }]), { saraVersion: V }), /list their ports/);
  assert.throws(() => parseManifest(baseManifest(Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, host: 'setting:daemon', ports: [1], where: 'local', tls: 'none' }))), { saraVersion: V }), /more than 4/);
  // An update that adds a port (or an endpoint) gets the full card with it marked.
  const more = parseManifest(baseManifest([{ id: 'imap', host: 'setting:daemon', ports: [993, 143, 2525], where: 'public', tls: 'required' }]), { saraVersion: V });
  const before = parseManifest(baseManifest([{ id: 'imap', host: 'setting:daemon', ports: [993, 143], where: 'public', tls: 'required' }]), { saraVersion: V });
  assert.deepEqual(addedPermissions(before, more), ['connect:imap:public:993,143,2525:required']);
});

test('broker rules: addresses only from the setting, local = this computer (home network only when ticked), public = public only', () => {
  assert.deepEqual(splitAddress('127.0.0.1:7583'), { host: '127.0.0.1', port: 7583 });
  assert.deepEqual(splitAddress('[::1]:7583'), { host: '::1', port: 7583 });
  assert.equal(splitAddress('http://evil.example:80'), undefined);
  assert.equal(addressAllowed('127.0.0.1', 'local', false), undefined);
  assert.match(String(addressAllowed('192.168.1.5', 'local', false)), /home network/);
  assert.equal(addressAllowed('192.168.1.5', 'local', true), undefined);
  assert.equal(addressAllowed('172.18.0.4', 'local', true), undefined, 'a Docker network');
  assert.match(String(addressAllowed('8.8.8.8', 'local', true)), /not on this computer/);
  assert.match(String(addressAllowed('127.0.0.1', 'public', false)), /private or local/);
  assert.equal(addressAllowed('93.184.216.34', 'public', false), undefined);
});

/** A PluginSockets with recorded log lines and plugin-bound messages. */
function sockets(endpoints: Parameters<typeof parseManifest>[0], settings: Record<string, string | number | boolean>, o: { lookup?: (h: string) => Promise<string[]>; ca?: string; clock?: Clock } = {}) {
  const m = parseManifest(endpoints, { saraVersion: V });
  const sent: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const ps = new PluginSockets({ endpoints: m.permissions.connect, settings: () => settings, send: (x) => (sent.push(x), true), backlog: () => 0, log: (k, t) => void logs.push(`${k}: ${t}`), ...(o.lookup ? { lookup: o.lookup } : {}), ...(o.ca ? { ca: o.ca } : {}), ...(o.clock ? { clock: o.clock } : {}) });
  return { ps, sent, logs };
}
async function tcpEcho(t: { after: (fn: () => void) => void }): Promise<{ port: number; seen: Buffer[] }> {
  const seen: Buffer[] = [];
  const srv = netServer((c) => c.on('data', (d) => (seen.push(d), d.length < 100 ? c.write(d) : undefined)));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: (srv.address() as AddressInfo).port, seen };
}

test('broker: opens only what the owner typed (the plugin\'s own host is ignored), relays bytes both ways, caps sockets and writes, closes idle sockets after 35 minutes, and private local mode closes and refuses', async (t) => {
  const echo = await tcpEcho(t);
  const clock = new ManualClock();
  const local = baseManifest([{ id: 'daemon', host: 'setting:daemon', ports: 'setting', where: 'local', tls: 'none' }]);
  const { ps, sent, logs } = sockets(local, { daemon: `127.0.0.1:${echo.port}` }, { clock });
  t.after(() => ps.dispose());
  const r = await ps.open({ endpoint: 'daemon', host: 'evil.example' });
  assert.equal(r.socket, 's1');
  assert.ok(logs.some((l) => /named a host of its own/.test(l)), 'its own host was ignored and logged');
  assert.ok(logs.some((l) => /connected to 127\.0\.0\.1:/.test(l)), 'every open is logged');
  ps.write({ socket: 's1', data: Buffer.from('ping\n').toString('base64') });
  assert.ok(await until(() => sent.some((x) => x.type === 'net.data')));
  assert.equal(Buffer.from(String(sent.find((x) => x.type === 'net.data')!.data), 'base64').toString(), 'ping\n');
  // Caps: 4 sockets, then denied.
  for (let i = 0; i < 3; i++) await ps.open({ endpoint: 'daemon' });
  await assert.rejects(ps.open({ endpoint: 'daemon' }), /already has 4/);
  // 16 MB of writes a minute, then paused (17 × 1 MB).
  const mb = Buffer.alloc(256 * 1024).toString('base64');
  let refused = 0;
  for (let i = 0; i < 17 * 4; i++) {
    try {
      ps.write({ socket: 's2', data: mb });
    } catch {
      refused++;
    }
  }
  assert.ok(refused >= 4, 'the 17th MB in a minute is refused');
  assert.throws(() => ps.write({ socket: 's2', data: Buffer.alloc(300 * 1024).toString('base64') }), /256 KB|paused/);
  // Idle: 35 minutes without traffic → closed (fake clock).
  await clock.advance(35 * 60_000 + 1000, 60_000);
  assert.ok(await until(() => sent.filter((x) => x.type === 'net.closed').length === 4));
  assert.match(String(sent.find((x) => x.type === 'net.closed')!.reason), /idle for 35 minutes/);
  // Private local mode: an open socket closes when it goes on; net.open is refused.
  await ps.open({ endpoint: 'daemon' });
  setPrivateLocal(true);
  try {
    assert.ok(await until(() => ps.size === 0), 'open sockets close');
    await assert.rejects(ps.open({ endpoint: 'daemon' }), /private local mode/);
  } finally {
    setPrivateLocal(false);
  }
});

test('broker: a local endpoint refuses a public address and a home-network one unless ticked; a public endpoint refuses loopback', async (t) => {
  const local = baseManifest([{ id: 'daemon', host: 'setting:daemon', ports: 'setting', where: 'local', tls: 'none' }]);
  const lookup = async (h: string) => (h === 'signal-cli' ? ['172.20.0.3'] : h === 'public.example' ? ['93.184.216.34'] : []);
  const a = sockets(local, { daemon: 'public.example:7583' }, { lookup });
  await assert.rejects(a.ps.open({ endpoint: 'daemon' }), /not on this computer/);
  const b = sockets(local, { daemon: 'signal-cli:7583', onOtherMachine: false }, { lookup });
  await assert.rejects(b.ps.open({ endpoint: 'daemon' }), /home network/);
  const c = sockets(local, { daemon: '127.0.0.1' }, { lookup });
  await assert.rejects(c.ps.open({ endpoint: 'daemon' }), /no port/);
  const pub = baseManifest([{ id: 'imap', host: 'setting:daemon', ports: [993], where: 'public', tls: 'required' }]);
  const d = sockets(pub, { daemon: '127.0.0.1' }, { lookup });
  await assert.rejects(d.ps.open({ endpoint: 'imap' }), /private or local/);
  await assert.rejects(d.ps.open({ endpoint: 'imap', port: 25 }), /isn't one of 993/);
  assert.ok(d.logs.every((l) => l.startsWith('denied: net.open')), 'every refusal is logged');
  for (const x of [a, b, c, d]) x.ps.dispose();
  void t;
});

test('broker TLS: Sara does STARTTLS on 587 herself (the server never sees AUTH before TLS), checks the certificate against the host, and a certificate for another host fails', async (t) => {
  const now = new Date();
  const ca = makeCert({ cn: 'Test CA', ca: true, notBefore: new Date(now.getTime() - 86_400_000), notAfter: new Date(now.getTime() + 86_400_000) });
  const leaf = makeCert({ cn: 'mail.test', dns: ['mail.test'], issuer: ca, notBefore: new Date(now.getTime() - 86_400_000), notAfter: new Date(now.getTime() + 86_400_000) });
  const plainSeen: string[] = [];
  const tlsSeen: string[] = [];
  const secure = tlsServer({ key: leaf.key.export({ type: 'pkcs8', format: 'pem' }) as string, cert: leaf.pem });
  const srv = netServer((c: NetSocket) => {
    c.write('220 mail.test ESMTP\r\n');
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        plainSeen.push(line);
        if (/^EHLO/i.test(line)) c.write('250-mail.test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
        else if (/^STARTTLS/i.test(line)) {
          c.write('220 go ahead\r\n');
          c.off('data', onData);
          secure.emit('connection', c);
        }
      }
    };
    c.on('data', onData);
  });
  secure.on('secureConnection', (s) => s.on('data', (d) => tlsSeen.push(d.toString())));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = (srv.address() as AddressInfo).port;
  // The test listens on a random port; the manifest lists it as the STARTTLS port by remapping 587.
  const pub = baseManifest([{ id: 'smtp', host: 'setting:daemon', ports: [587], where: 'public', tls: 'required' }]);
  const lookup = async () => ['93.184.216.34'];
  const { ps, logs } = sockets(pub, { daemon: 'mail.test' }, { lookup, ca: ca.pem });
  // Route the "public" address to the local fake: the broker connects to what it resolved.
  const net = await import('node:net');
  const orig = net.Socket.prototype.connect;
  t.after(() => void (net.Socket.prototype.connect = orig));
  (net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown }).connect = function (this: NetSocket, o: unknown, ...rest: unknown[]) {
    const opts = o as { host?: string; port?: number };
    return (orig as (...a: unknown[]) => unknown).call(this, opts && opts.host === '93.184.216.34' && opts.port === 587 ? { host: '127.0.0.1', port } : o, ...rest);
  } as never;
  const r = await ps.open({ endpoint: 'smtp' });
  assert.equal((r.tls as { starttls?: string }).starttls, 'smtp');
  assert.match(String((r.tls as { protocol?: string }).protocol), /TLS/);
  assert.deepEqual(plainSeen, ['EHLO sara.localdomain', 'STARTTLS'], 'before TLS the server only saw EHLO and STARTTLS (never AUTH)');
  ps.write({ socket: String(r.socket), data: Buffer.from('AUTH PLAIN x\r\n').toString('base64') });
  assert.ok(await until(() => tlsSeen.join('').includes('AUTH PLAIN')), 'AUTH arrived only over TLS');
  assert.ok(logs.some((l) => /STARTTLS by Sara/.test(l)));
  ps.dispose();
  // A certificate for another host name: the handshake fails and nothing is relayed.
  const other = sockets(pub, { daemon: 'other.test' }, { lookup, ca: ca.pem });
  await assert.rejects(other.ps.open({ endpoint: 'smtp' }), /certificate|encrypted connection failed|altnames|Hostname/i);
  other.ps.dispose();
});

test('P5: the progress message keeps to an edit budget: at most 7 live edits 15 s apart, the last says "and more steps", then the final line (Signal: editLimit 9)', async () => {
  const clock = new ManualClock();
  const created: string[] = [];
  const edits: { at: number; text: string }[] = [];
  const pm = new ProgressMessage({ port: { create: async (x) => (created.push(x), 'r1'), edit: async (_r, x) => void edits.push({ at: clock.now(), text: x }) }, queue: new SendQueue({ clock }), key: 'k', clock, afterMs: 10_000, intervalMs: 15_000, editLimit: 9, final: 'summary', lang: 'en', owner: true, scrub: (x) => x }).start();
  // A 3-minute turn with 20 steps.
  for (let i = 0; i < 20; i++) {
    pm.event({ type: 'tool_call', id: `t${i}`, name: 'read_file', args: {} } as ChatEvent);
    await clock.advance(4500, 500);
    pm.event({ type: 'tool_result', id: `t${i}`, name: 'read_file', status: 'ok' } as unknown as ChatEvent);
    await clock.advance(4500, 500);
  }
  await drive(clock, pm.finish(), 60_000, 500);
  assert.equal(created.length, 1, 'exactly one message');
  assert.ok(edits.length <= 8, `at most 8 edits (was ${edits.length})`);
  for (let i = 1; i < edits.length - 1; i++) assert.ok(edits[i].at - edits[i - 1].at >= 15_000, 'no two live edits closer than 15 s');
  assert.match(edits.at(-2)!.text, /and more steps/);
  assert.match(edits.at(-1)!.text, /^✅ Done · 20 steps/);
});

// ------------------------------------------------------------------ the Signal plugin (stand-in signal-cli)

const OWNER = { uuid: '0d4f3a52-1111-4a2b-9c3d-aaaaaaaaaaaa', name: 'Alex' };
const STRANGER = { uuid: '7e9b2c10-2222-4f00-8e1a-bbbbbbbbbbbb', name: 'Sam' };
const HER = { number: '+15550001111', uuid: '5c6d7e8f-3333-4abc-9def-cccccccccccc' };
const GROUP = 'Qm9va2NsdWJHcm91cElkMDAwMDAwMDAwMDAwMDA=';

async function signalRig(t: { after: (fn: () => Promise<void> | void) => void }) {
  const fake = await new FakeSignalCli().start();
  fake.identities.set(OWNER.uuid, '05 1234 5678 9012');
  fake.groups.push({ id: GROUP, name: 'Book club', members: [{ uuid: OWNER.uuid }, { uuid: STRANGER.uuid }, { uuid: HER.uuid }] });
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: SARA_PKG_VERSION });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    await fake.stop();
    app.store.close();
    cleanup();
  });
  return { fake, app, pm, dir };
}

async function installSignal(r: Awaited<ReturnType<typeof signalRig>>) {
  const review = r.pm.stageBuiltin('signal');
  await r.pm.approve(review.id, { trust: true });
  await r.pm.putSettings('signal', 'main', { daemon: `127.0.0.1:${r.fake.port}`, account: HER.number });
  await r.pm.setEnabled('signal', 'main', true);
  assert.ok(await until(() => r.fake.calls('subscribeReceive').length > 0), 'the plugin connected through the broker and subscribed');
  return review;
}

const sends = (fake: FakeSignalCli, to?: string) => fake.calls('send').filter((x) => !to || (x.params.recipient as string[] | undefined)?.[0] === to || x.params.groupId === to);
void sends;

test('builtin: Signal comes with Sara, installs only through the normal review card (trust tick still required here), and nothing runs until switched on', async (t) => {
  const r = await signalRig(t);
  const list = r.pm.builtinList();
  assert.ok(list.some((x) => x.id === 'signal' && x.name === 'Signal' && !x.installed));
  const review = r.pm.stageBuiltin('signal');
  assert.equal(review.builtin, true);
  assert.equal(review.origin.kind, 'builtin');
  assert.equal(review.needsTrust, true);
  assert.ok(review.lines.some((l) => l.key.startsWith('Connects to a program on this computer')));
  await assert.rejects(r.pm.approve(review.id), /trust/);
  await r.pm.approve(review.id, { trust: true });
  assert.equal(r.pm.processOf('signal', 'main'), undefined, 'installed, not running');
  assert.throws(() => r.pm.stageBuiltin('../etc'), /No such plugin comes with Sara/);
  assert.ok(r.pm.builtinList().find((x) => x.id === 'signal')!.installed);
  // The plugins/signal helper is the same file as the main helper (test/phase98 keeps the others).
  assert.equal(readFileSync(join(ROOT, 'plugins', 'signal', 'sara-plugin.mjs'), 'utf8'), readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  // One companion per account: a second companion can't switch it on while it's on for the first.
  await r.pm.setEnabled('signal', 'main', true);
  const { dir: d2, cleanup: c2 } = tempDir();
  const mia = baseApp(d2);
  mia.persona.name = 'Mia';
  r.pm.attach('mia', mia);
  t.after(async () => {
    await r.pm.detach('mia');
    mia.store.close();
    c2();
  });
  await assert.rejects(r.pm.setEnabled('signal', 'mia', true), /already on for/);
});

test('Signal: linking with a 6-digit code (wrong 5 times and it is gone), the safety number pinned, an owner chat with typing, a stranger gets one line, groups answer only when called, keep-up logs lines, a steer gets 👀, and a changed safety number pauses his tools until he confirms', async (t) => {
  const r = await signalRig(t);
  await installSignal(r);
  const { fake, app, pm } = r;
  const dm = (from: { uuid: string; name: string }, message: string, more: Record<string, unknown> = {}) => {
    const ts = fake.nextTs();
    fake.push(dmEnvelope(from, ts, { message, ...more }));
    return ts;
  };
  // Wrong codes five times: the code is gone, so even the right one no longer links.
  const { code } = pm.linkCode('signal', 'main');
  for (let i = 0; i < 5; i++) dm(STRANGER, `/link ${code === '000000' ? '111111' : '000000'}`);
  assert.ok(await until(() => sends(fake, STRANGER.uuid).length >= 5));
  dm(STRANGER, `/link ${code}`);
  assert.ok(await until(() => sends(fake, STRANGER.uuid).length >= 6));
  assert.deepEqual(pm.settingsView('signal', 'main').bridge?.ownerChats, []);
  assert.equal(sends(fake, STRANGER.uuid).filter((x) => /I only chat with the person who runs me/.test(String(x.params.message))).length, 1, 'a stranger gets the hello line once');
  // The owner links from his own Signal.
  const fresh = pm.linkCode('signal', 'main').code;
  dm(OWNER, `/link ${fresh}`);
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => /Linked/.test(String(x.params.message)))));
  const b = pm.settingsView('signal', 'main').bridge!;
  assert.deepEqual(b.ownerChats, [OWNER.uuid]);
  assert.deepEqual(b.ownerIds, [OWNER.uuid]);
  assert.equal(identityOf(app.store.db, 'plugin-signal', OWNER.uuid)?.fingerprint, '05 1234 5678 9012', 'his safety number is pinned');
  // An owner 1:1 message: one turn on plugin-signal, typing first, the reply to his ACI, typing stops.
  const before = app.requests.length;
  app.script.push(text('Hi **Alex**.'));
  dm(OWNER, 'hello');
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => x.params.message === 'Hi Alex.')));
  const reply = sends(fake, OWNER.uuid).find((x) => x.params.message === 'Hi Alex.')!;
  assert.deepEqual(reply.params.textStyle, ['3:4:BOLD'], 'Markdown became a Signal text style');
  const typing = fake.calls('sendTyping');
  assert.ok(typing.length >= 1 && typing[0].at <= reply.at, 'typing before the reply');
  assert.ok(await until(() => fake.calls('sendTyping').some((x) => x.params.stop === true)), 'typing stops');
  assert.equal(app.requests.length, before + 1);
  assert.ok((app.requests.at(-1)!.tools ?? []).length > 0, 'the owner turn offers her tools');
  const conv = app.store.listConversations().find((c) => c.channel === 'plugin-signal' && !c.partner)!;
  assert.ok(conv && conv.channelKey === OWNER.uuid);
  // A group message without a mention: no turn. With a mention of her: a room turn that quotes it.
  const n0 = app.requests.length;
  fake.push({ source: STRANGER.uuid, sourceUuid: STRANGER.uuid, sourceName: STRANGER.name, timestamp: fake.nextTs(), dataMessage: { timestamp: 1, message: 'anyone read the book?', groupInfo: { groupId: GROUP, type: 'DELIVER' } } });
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(app.requests.length, n0, 'not called: no turn');
  const room = keepRoomByKey(app, 'plugin-signal', `group.${GROUP}`);
  assert.ok(room, `the group is a room ${JSON.stringify(pm.store.logs('signal').slice(0, 5).map((l) => l.detail))}`);
  setRoom(app, room!.id, { keepUp: true });
  app.script.push(text('I loved it.'));
  const gts = fake.nextTs();
  fake.push({ source: STRANGER.uuid, sourceUuid: STRANGER.uuid, sourceName: STRANGER.name, timestamp: gts, dataMessage: { timestamp: gts, message: '\uFFFC what did you think?', mentions: [{ uuid: HER.uuid, number: HER.number, start: 0, length: 1 }], groupInfo: { groupId: GROUP, type: 'DELIVER' } } });
  assert.ok(await until(() => sends(fake, GROUP).some((x) => x.params.message === 'I loved it.')));
  const g = sends(fake, GROUP).find((x) => x.params.message === 'I loved it.')!;
  assert.equal(g.params.quoteTimestamp, gts, 'the group reply quotes the message she answers');
  assert.equal((app.requests.at(-1)!.tools ?? []).length, 0, 'someone else in a group gets no tools');
  assert.ok(recentLines(app, room!.id, 10).some((l) => /what did you think/.test(l.text)), 'keep-up logged the line');
  fake.push({ source: STRANGER.uuid, sourceUuid: STRANGER.uuid, sourceName: STRANGER.name, timestamp: fake.nextTs(), editMessage: { targetSentTimestamp: gts, dataMessage: { message: 'what did you REALLY think?', groupInfo: { groupId: GROUP } } } });
  assert.ok(await until(() => recentLines(app, room!.id, 10).some((l) => /REALLY/.test(l.text) && l.flags.edited === true)), 'an edit updates the line');
  // A steer while she works: 👀 on his message, taken at the safe point.
  app.tools.add({ spec: { name: 'wait_a_bit', description: 'slow', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'Wait', run: async () => (await new Promise((res) => setTimeout(res, 1500)), 'ok') });
  app.script.push([call('w1', 'wait_a_bit', {})], text('Done with pnpm.'));
  const n1 = app.requests.length;
  dm(OWNER, 'start the job');
  assert.ok(await until(() => app.requests.length > n1));
  const steerTs = dm(OWNER, 'use pnpm');
  assert.ok(await until(() => fake.calls('sendReaction').length > 0));
  const react = fake.calls('sendReaction')[0];
  assert.equal(react.params.emoji, '👀');
  assert.equal(react.params.targetTimestamp, steerTs);
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => x.params.message === 'Done with pnpm.')));
  // His safety number changes: his next message runs without tools, with the line; "It's me" trusts it.
  fake.identities.set(OWNER.uuid, '05 9999 0000 1111');
  app.script.push(text('Still me.'));
  dm(OWNER, 'is it you?');
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => /safety number changed/.test(String(x.params.message)))));
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => x.params.message === 'Still me.')));
  assert.equal((app.requests.at(-1)!.tools ?? []).length, 0, 'no tools while his identity is unconfirmed');
  const view = pm.bridgeView('signal', 'main') as { identityChanged: { chat: string; new: string }[] };
  assert.equal(view.identityChanged[0]?.new, '05 9999 0000 1111');
  assert.equal(pm.identityAction('signal', 'main', OWNER.uuid, 'confirm'), true);
  assert.ok(await until(() => fake.calls('trust').length > 0), 'It\'s me → trust in signal-cli');
  app.script.push(text('Tools are back.'));
  dm(OWNER, 'ok now?');
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => x.params.message === 'Tools are back.')));
  assert.ok((app.requests.at(-1)!.tools ?? []).length > 0, 'tools are back after confirming');
});

test('Signal: a picture from the owner reaches the turn, a rate limit pauses that chat and tells the owner once, and private local mode closes the socket', async (t) => {
  const r = await signalRig(t);
  await installSignal(r);
  const { fake, app, pm } = r;
  const s0 = pm.settingsView('signal', 'main');
  void s0;
  const code = pm.linkCode('signal', 'main').code;
  fake.push(dmEnvelope(OWNER, fake.nextTs(), { message: `/link ${code}` }));
  assert.ok(await until(() => (pm.settingsView('signal', 'main').bridge?.ownerChats ?? []).length === 1));
  fake.attachments.set('att1', makeTestPicture(8));
  app.script.push(text('Nice picture.'));
  fake.push(dmEnvelope(OWNER, fake.nextTs(), { message: 'look', attachments: [{ id: 'att1', contentType: 'image/png', filename: 'p.png', size: 100 }] }));
  assert.ok(await until(() => sends(fake, OWNER.uuid).some((x) => x.params.message === 'Nice picture.')));
  assert.equal(fake.calls('getAttachment')[0].params.id, 'att1');
  const user = app.store.messages(app.store.listConversations().find((c) => c.channel === 'plugin-signal' && !c.partner)!.id).filter((m) => m.role === 'user').at(-1)!;
  assert.equal((user.meta?.images as string[] | undefined)?.length, 1, 'the picture reached the turn');
  // Rate limit: the next send to him fails → that chat pauses, the owner is told once.
  fake.rateLimit.add(OWNER.uuid);
  app.script.push(text('First.'), text('Second.'));
  fake.push(dmEnvelope(OWNER, fake.nextTs(), { message: 'one' }));
  assert.ok(await until(() => pm.store.logs('signal').some((l) => /notify/.test(l.detail))), 'the owner was notified');
  fake.push(dmEnvelope(OWNER, fake.nextTs(), { message: 'two' }));
  await until(() => app.requests.length >= 4, 5000);
  await new Promise((res) => setTimeout(res, 1500));
  assert.ok(!sends(fake, OWNER.uuid).some((x) => x.params.message === 'Second.'), 'sends to that chat are paused');
  // Private local mode: the socket closes and the chip says paused.
  setPrivateLocal(true);
  try {
    assert.ok(await until(() => fake.clients.size === 0), 'the connection to signal-cli closed');
    assert.equal((pm.bridgeView('signal', 'main') as { state: string }).state, 'paused');
  } finally {
    setPrivateLocal(false);
  }
});
