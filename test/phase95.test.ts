import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeValues, decodeValues, encodeMessage, decodeMessage, unixAddress, variant } from '../desktop/linux/dbus.ts';

test('CU8 D-Bus values round-trip nested dictionaries, variants, arrays and structs', () => {
  const signature = 'sa{sv}(oayays)a(so)';
  const values = ['héllo', { interactive: variant('b', true), count: variant('u', 9), nested: variant('a{ss}', { key: 'value' }) }, ['/session', [0, 255], [1, 2, 3], 'text/plain'], [[':1.2', '/root']]];
  assert.deepEqual(decodeValues(signature, encodeValues(signature, values)), values);
  assert.deepEqual(decodeValues('xtd', encodeValues('xtd', [-123n, 456n, 2.5])), [-123n, 456n, 2.5]);
});

test('CU8 D-Bus framing rejects truncation, malformed signatures and oversized data', () => {
  const m = { type: 1, serial: 7, path: '/test', interface: 'test.Interface', member: 'Echo', destination: 'test.Service', signature: 's', body: ['hello'] };
  const bytes = encodeMessage(m);
  assert.deepEqual(decodeMessage(bytes).body, ['hello']);
  assert.equal(decodeMessage(bytes).serial, 7);
  assert.throws(() => decodeMessage(bytes.subarray(0, bytes.length - 1)), /truncated|length/i);
  assert.throws(() => encodeValues('a{', []), /signature/i);
  const huge = Buffer.from(bytes); huge.writeUInt32LE(0x7fffffff, 4);
  assert.throws(() => decodeMessage(huge), /size|large|length/i);
});

test('CU8 only Unix paths and Linux abstract addresses are accepted, never TCP', () => {
  assert.equal(unixAddress('unix:path=/run/user/1000/bus'), '/run/user/1000/bus');
  assert.equal(unixAddress('unix:abstract=sara%2Dtest'), '\0sara-test');
  assert.throws(() => unixAddress('tcp:host=example.com,port=123'), /Unix/i);
  assert.throws(() => unixAddress('unix:path=relative'), /absolute|Unix/i);
});

import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DBus } from '../desktop/linux/dbus.ts';
import { Portal } from '../desktop/linux/portals.ts';
import { AtSpi } from '../desktop/linux/atspi.ts';
import { PrivateStore, LinuxVault, KeyringStore } from '../desktop/linux/secrets.ts';
import { LinuxSystem, walkSize } from '../desktop/linux/checkup.ts';

test('CU8 private-file fallback persists token and vault with consent, exact origins and private permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-'));
  try {
    const warnings: string[] = [];
    const store = new PrivateStore(dir, (s) => warnings.push(s));
    store.set('token', 'fixture-hands-token');
    assert.equal(store.get('token'), 'fixture-hands-token');
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
    assert.ok(warnings.length > 0);
    const vault = new LinuxVault(store);
    assert.throws(() => vault.save('https://sara.example.test', 'https://login.example.test', { save: true, understood: false, password: 'fixture' }), /understand/);
    vault.save('https://sara.example.test', 'https://login.example.test', { name: 'Fixture', save: true, understood: true, username: 'alex', password: 'fixture' });
    const loaded = new LinuxVault(store);
    assert.equal(loaded.findBySite('https://sara.example.test', 'https://login.example.test')?.password, 'fixture');
    assert.equal(loaded.findBySite('https://sara.example.test', 'https://login.example.test.evil'), undefined);
    assert.equal(loaded.list('https://other.example.test').length, 0);
    assert.doesNotMatch(JSON.stringify(loaded.list('https://sara.example.test')), /password|alex/);
    loaded.remove('https://sara.example.test', { all: true });
    assert.deepEqual(new LinuxVault(store).list('https://sara.example.test'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CU8 bounded read-only check-up ignores symlinks and server-supplied paths/commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-'));
  try {
    mkdirSync(join(dir, '.config', 'autostart'), { recursive: true });
    mkdirSync(join(dir, 'Downloads'));
    writeFileSync(join(dir, 'Downloads', 'small'), 'hello');
    writeFileSync(join(dir, '.config', 'autostart', 'fixture.desktop'), '[Desktop Entry]\nType=Application\nName=Fixture app\nExec=never-run-this\nHidden=true\n');
    if (process.platform !== 'win32') symlinkSync(dir, join(dir, 'Downloads', 'loop'));
    assert.equal(walkSize(join(dir, 'Downloads')).bytes, 5);
    assert.equal(walkSize(join(dir, 'Downloads'), { entries: 0 }).partial, true);
    const extension = join(dir, '.config', 'chromium', 'Default', 'Extensions', 'a'.repeat(32), '1_0');
    mkdirSync(extension, { recursive: true }); writeFileSync(join(extension, 'manifest.json'), '{"name":"Fixture extension"}');
    mkdirSync(join(dir, 'cache')); writeFileSync(join(dir, 'cache', 'small'), 'cache');
    const sys = new LinuxSystem({ home: dir, config: join(dir, '.config'), machineConfig: [], cache: join(dir, 'cache') });
    const data = await sys.check({ checks: ['startup', 'folders', 'extensions', 'temp', 'disk'], path: '/', command: 'false' });
    assert.equal(data.checks.startup?.ok && data.checks.startup.items[0].enabled, false);
    assert.equal(data.checks.folders?.ok && data.checks.folders.folders[0].bytes, 5);
    assert.equal(data.checks.extensions?.ok && data.checks.extensions.browsers[0].extensions[0].name, 'Fixture extension');
    assert.equal(data.checks.temp?.ok && data.checks.temp.places[0].bytes, 5);
    assert.ok(data.checks.disk?.ok && data.checks.disk.volumes[0].total > 0);
    assert.equal(data.checks.updates, undefined);
    assert.equal(readFileSync(join(dir, 'Downloads', 'small'), 'utf8'), 'hello');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CU8 real private D-Bus: EXTERNAL, portal response race/cancel, AT-SPI secure subtree refusal', { skip: process.platform === 'win32' ? 'Linux Unix sockets and dbus-daemon are unavailable on Windows; codec/storage/check-up tests still run.' : false }, async (t) => {
  const probe = spawnSync('dbus-daemon', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('dbus-daemon is not installed; no session bus is touched');
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-bus-'));
  const config = join(dir, 'bus.conf');
  writeFileSync(config, `<busconfig><type>session</type><listen>unix:path=${join(dir, 'bus')}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`);
  const daemon = spawnSync('dbus-daemon', [`--config-file=${config}`, '--fork', '--print-address=1', '--print-pid=1'], { encoding: 'utf8' });
  if (daemon.status !== 0) { rmSync(dir, { recursive: true, force: true }); return t.skip(`Private dbus-daemon cannot start: ${daemon.stderr.slice(0, 160)}`); }
  const [address, pid] = daemon.stdout.trim().split('\n');
  const service = new DBus(); const client = new DBus();
  const calls: string[] = [];
  try {
    await service.connect(address); await client.connect(address);
    await service.requestName('org.freedesktop.portal.Desktop');
    await service.requestName('org.a11y.atspi.Registry');
    await service.requestName('org.freedesktop.secrets');
    let secret: unknown[] = [];
    service.handler = async (m) => {
      calls.push(`${m.path}:${m.member}`);
      if (m.member === 'OpenSession') return { signature: 'vo', body: [variant('s', ''), '/secret/session'] };
      if (m.member === 'ReadAlias') return { signature: 'o', body: ['/secret/collection'] };
      if (m.member === 'SearchItems') return { signature: 'aoao', body: [secret.length ? ['/secret/item'] : [], []] };
      if (m.member === 'CreateItem') { secret = m.body![1] as unknown[]; return { signature: 'oo', body: ['/secret/item', '/'] }; }
      if (m.member === 'SetSecret') { secret = m.body![0] as unknown[]; return {}; }
      if (m.member === 'GetSecret') return { signature: '(oayays)', body: [secret] };
      if (m.member === 'Screenshot') {
        const opts = m.body![1] as Record<string, { value: string }>;
        const path = `/org/freedesktop/portal/desktop/request/${m.sender!.slice(1).replaceAll('.', '_')}/${opts.handle_token.value}`;
        service.send({ type: 4, destination: m.sender, path, interface: 'org.freedesktop.portal.Request', member: 'Response', signature: 'ua{sv}', body: [opts.interactive?.value === 'cancel' ? 1 : 0, { uri: variant('s', 'file:///fixture.png') }] });
        return { signature: 'o', body: [path] };
      }
      if (m.member === 'GetRoleName') return { signature: 's', body: [m.path === '/password' ? 'password text' : m.path === '/blocked' ? 'application' : 'push button'] };
      if (m.member === 'Get' && m.interface === 'org.freedesktop.DBus.Properties') return { signature: 'v', body: [variant('s', m.path === '/blocked' ? 'KeePassXC' : 'Fixture Save')] };
      if (m.member === 'GetChildren') return { signature: 'a(so)', body: [m.path?.endsWith('/root') ? [[service.name, '/normal'], [service.name, '/password'], [service.name, '/blocked']] : []] };
      return {};
    };
    const portal = new Portal(client);
    const result = await portal.screenshot();
    assert.equal(result.uri, 'file:///fixture.png');
    await assert.rejects(portal.request('org.freedesktop.portal.Screenshot', 'Screenshot', 'sa{sv}', ['', { interactive: variant('s', 'cancel') }]), /cancel|denied/i);
    const spi = new AtSpi(client);
    const elements = await spi.elements();
    assert.ok(elements.items.some((e) => e.name === 'Fixture Save'));
    assert.ok(elements.items.some((e) => e.secret));
    assert.ok(!elements.items.some((e) => e.name.includes('KeePass')));
    assert.ok(!calls.includes('/password:Get') && !calls.includes('/password:GetChildren'));
    assert.ok(!calls.includes('/blocked:GetChildren'));
    const keyring = new KeyringStore(client, 'https://sara.example.test');
    await keyring.open(); keyring.set('token', 'fixture-only-token'); await keyring.flush();
    const reopened = new KeyringStore(client, 'https://sara.example.test'); await reopened.open();
    assert.equal(reopened.get('token'), 'fixture-only-token');
    reopened.set('token', 'renewed-fixture-token'); await reopened.flush();
    const third = new KeyringStore(client, 'https://sara.example.test'); await third.open();
    assert.equal(third.get('token'), 'renewed-fixture-token');
  } finally {
    service.close(); client.close();
    // Only the PID returned by this private daemon, with its exact private config in cmdline.
    const cmd = readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8');
    if (cmd.includes(config) && cmd.includes('dbus-daemon')) process.kill(Number(pid), 'SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

import { LinuxHands, DeviceGate, linuxBrowser, normalizeServer } from '../desktop/linux/hands.ts';

test('CU8 real device announces no fixture desktop/input/apply and enforces local Stop/takeover', () => {
  const gate = new DeviceGate(); gate.check(); gate.pause(); assert.throws(() => gate.check(), /takeover/); gate.resume(); gate.check(); gate.stop(); assert.throws(() => gate.check(), /stopped/); gate.resume(); assert.throws(() => gate.check(), /stopped/);
  assert.throws(() => normalizeServer('http://example.test'), /HTTPS/);
  assert.equal(normalizeServer('http://127.0.0.1:7880'), 'http://127.0.0.1:7880');
  assert.throws(() => normalizeServer('https://alex:secret@example.test'), /credentials/);
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-'));
  try {
    const store = new PrivateStore(dir, () => {});
    const h = new LinuxHands({ server: 'http://127.0.0.1:7880', token: 'fixture-token', dir, store, info: { found: false, how: 'Install Chrome' }, checks: true });
    const hello = h.hello();
    assert.equal(hello.app, 'linux-hands 1');
    assert.deepEqual(hello.perms, { capture: false, input: false, ax: false });
    assert.ok((hello.ops as string[]).includes('s.check'));
    assert.ok(!(hello.ops as string[]).some((o) => o.startsWith('d.') || o === 's.apply'));
    assert.notEqual((hello.vault as {kind: string}).kind, 'test');
    let event = ''; h.ws = { open: true, send: (data: string) => { event = data; } } as never; h.tellLogins();
    assert.equal(JSON.parse(event).vault.kind, 'file-0600', 'login-list refreshes keep the real Linux storage kind');
    assert.ok(!h.browser.args().includes('--headless=new'));
    assert.ok(!h.browser.args().includes('--password-store=basic'));
    assert.ok(!h.browser.args().includes('--no-sandbox'));
    assert.ok(!linuxBrowser({}).path?.includes('headless'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


import { pair } from '../desktop/linux/cli.ts';
import { makeApp } from './helpers.ts';
import { OwnerAuth } from '../src/auth.ts';
import { HandsHub } from '../src/hands.ts';
import { createSaraServer } from '../src/server.ts';
import type { AddressInfo } from 'node:net';

test('CU8 Linux pairing reuses approved device code plus fresh hands confirmation, with disclosure accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-pair-'));
  const app = makeApp(dir, { now: new Date('2026-10-31T12:00:00Z') });
  const auth = new OwnerAuth(dir); const owner = auth.newToken!;
  app.hands = new HandsHub({ events: app.events!, allowed: () => true, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  const server = createSaraServer({ app, auth, webDir: join(import.meta.dirname, '..', 'web') });
  let approve: Promise<unknown> = Promise.resolve();
  try {
    await new Promise<void>((r) => server.listen(Number(process.env.SARA_CU8_PAIR_PORT ?? 0), '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accept = await fetch(`${base}/api/disclosure/accept`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(accept.status, 200);
    const result = await pair(base, 'Fixture Linux', (line) => {
      const code = line.match(/approve code (\S+)\./)![1];
      approve = (async () => {
        const denied = await fetch(`${base}/api/device/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
        assert.equal(denied.status, 403, 'a signed-in session without fresh proof cannot pair hands');
        return fetch(`${base}/api/device/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ code, confirmation: { token: owner } }) }).then((r) => assert.equal(r.status, 200));
      })();
    });
    await approve;
    assert.match(result.token, /^sara_hands\./);
    assert.ok(auth.devices().some((d) => d.kind === 'hands'));
    assert.ok(!auth.devices().some((d) => d.kind === 'app'), 'temporary setup sign-in is revoked');
  } finally {
    app.hands.closeAll(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); app.store.close(); rmSync(dir, { recursive: true, force: true });
  }
});



import { createServer as createHttpServer } from 'node:http';
import { findBrowser } from '../src/browser.ts';
import { decodeJpeg } from '../src/jpeg.ts';

test('CU8 browser pictures redact password pixels locally before the hands channel', { skip: !process.env.SARA_CU8_TEST_BROWSER ? 'Set SARA_CU8_TEST_BROWSER to a test Chromium executable; no visible desktop is driven.' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-pixels-'));
  const site = createHttpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><input type="password" value="fixture-secret" style="position:absolute;left:10px;top:10px;width:200px;height:40px;background:red"><input value="sk-fixtureOnly0123456789abcdef" style="position:absolute;left:10px;top:65px;width:200px;height:40px;background:red"><textarea style="position:absolute;left:10px;top:120px;width:200px;height:40px;background:red"></textarea><script>document.querySelector("textarea").value="sk-fixtureOnly0123456789abcdef";new MutationObserver(()=>document.getElementById("__sara_privacy_boxes")?.remove()).observe(document,{childList:true,subtree:true})</script>'); });
  const hands = new LinuxHands({ server: 'http://127.0.0.1:1', token: 'fixture', dir, store: new PrivateStore(join(dir, 'store'), () => {}), info: findBrowser(process.platform, { SARA_BROWSER: process.env.SARA_CU8_TEST_BROWSER }), testBrowser: { headless: true, args: process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [] } });
  try {
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    await hands.browser.start(); const tab = hands.browser.tab();
    await hands.browser.waitLoad(tab, () => hands.browser.cdp!.send('Page.navigate', { url: `http://127.0.0.1:${(site.address() as AddressInfo).port}` }, tab.sessionId));
    const shot = await hands.browser.shot(tab, 1280, 80);
    const pixels = decodeJpeg(shot.data)!; assert.ok(pixels);
    const p = (25 * pixels.width + 25) * 3;
    assert.ok(pixels.data[p] < 20 && pixels.data[p + 1] < 20 && pixels.data[p + 2] < 20, 'password field is black in the outgoing JPEG');
    for (const y of [80, 135]) { const at = (y * pixels.width + 25) * 3; assert.ok(pixels.data[at] < 20 && pixels.data[at + 1] < 20 && pixels.data[at + 2] < 20, 'key-shaped input and textarea values are black in outgoing pixels'); }
    await hands.browser.cdp!.send('Runtime.evaluate', { expression: `document.body.appendChild(document.createElement('div')).attachShadow({mode:'closed'}).innerHTML='<input type=password value=fixture>'` }, tab.sessionId);
    await assert.rejects(hands.browser.shot(tab, 1280, 80), /shadow tree/);
  } finally { await hands.stop(); site.closeAllConnections(); await new Promise<void>((r) => site.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});

import { acceptWebSocket, type WsConnection } from '../src/ws.ts';
import { HandsRef } from '../src/hands-ref.ts';

test('CU8 Stop during a delayed connection cannot leave a late hands connection alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-cu8-stop-'));
  const server = createHttpServer();
  let channel: WsConnection | undefined;
  let helloCount = 0;
  const incoming = new Promise<() => void>((ready) => server.once('upgrade', (req, socket, head) => ready(() => {
    channel = acceptWebSocket(req, socket, head);
    if (channel) channel.onMessage = () => { helloCount++; };
  })));
  let hands: HandsRef | undefined;
  try {
    await new Promise<void>((r) => server.listen(process.env.SARA_CU8_PAIR_PORT ? Number(process.env.SARA_CU8_PAIR_PORT) + 1 : 0, '127.0.0.1', r));
    hands = new HandsRef({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'fixture', reconnect: false, profileDir: join(dir, 'browser'), folder: join(dir, 'files'), info: { found: false, how: '' } });
    const connecting = hands.start(); const finishUpgrade = await incoming;
    await hands.stop(); finishUpgrade(); await connecting;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hands.connected, false);
    assert.equal(helloCount, 0);
  } finally { channel?.close(); await hands?.stop(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});
