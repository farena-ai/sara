// EC1 (docs/ops/EC1_DESIGN.md "Host changes"): the two small host additions the Slack plugin needs.
// B5, named-domain endpoints (`host: "domain:slack.com"`): public, TLS, listed ports; the plugin
// names a host inside that domain at net.open and Sara checks it, resolves it, refuses private
// addresses and checks the certificate against that name. And `permissions.bridgeApprovals` (her
// requests for his OK as Allow/Deny buttons in a plugin's chats) on the review card.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as tlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectId, parseManifest, permissionIds, permissionLines } from '../src/plugins/manifest.ts';
import { PluginSockets } from '../src/plugins/net.ts';
import { makeCert } from './x509-test.ts';
import { ROOT } from './helpers.ts';

const base = (permissions: Record<string, unknown>) => JSON.stringify({ manifest: 1, id: 'chat-x', name: 'Chat X', version: '1.0.0', description: 'A chat app.', main: 'main.mjs', permissions });
const ep = (o: Record<string, unknown> = {}) => ({ id: 'api', host: 'domain:slack.com', ports: [443], where: 'public', tls: 'required', ...o });

test('B5: a domain endpoint parses only as public, encrypted and with its ports listed', () => {
  const m = parseManifest(base({ bridges: ['chatx'], connect: [ep()] }), { saraVersion: '9.0.0' });
  assert.equal(m.permissions.connect[0].host, 'domain:slack.com');
  assert.throws(() => parseManifest(base({ connect: [ep({ where: 'local' })] }), { saraVersion: '9.0.0' }), /domain.*public/i);
  assert.throws(() => parseManifest(base({ connect: [ep({ tls: 'optional' })] }), { saraVersion: '9.0.0' }), /only allowed to a program on this computer|always encrypted/);
  assert.throws(() => parseManifest(base({ connect: [ep({ ports: 'setting' })] }), { saraVersion: '9.0.0' }), /list their ports/);
  for (const bad of ['domain:com', 'domain:*.slack.com', 'domain:slack..com', 'domain:Slack.com/x', 'domain:', 'slack.com']) assert.throws(() => parseManifest(base({ connect: [ep({ host: bad })] }), { saraVersion: '9.0.0' }), /host must be/, bad);
  // The review card names the domain; a changed domain is a new permission (an addition at update).
  const lines = permissionLines(m);
  const line = lines.find((l) => l.id.startsWith('connect:'))!;
  assert.equal(line.key, 'Connects to {domain} and its subdomains (ports {ports}, always encrypted)');
  assert.deepEqual(line.params, { domain: 'slack.com', ports: '443' });
  assert.notEqual(connectId(m.permissions.connect[0]), connectId({ ...m.permissions.connect[0], host: 'domain:slack-gov.com' }));
});

test('bridgeApprovals: needs a bridge, shows on the review card and counts as a permission', () => {
  assert.throws(() => parseManifest(base({ bridgeApprovals: true }), { saraVersion: '9.0.0' }), /bridgeApprovals needs a bridge/);
  const m = parseManifest(base({ bridges: ['chatx'], bridgeApprovals: true }), { saraVersion: '9.0.0' });
  assert.equal(m.permissions.bridgeApprovals, true);
  assert.ok(permissionLines(m).some((l) => l.id === 'bridgeApprovals' && l.key === 'Shows her requests for your OK in its chats, with Allow and Deny (only you can answer)' && l.risk === 'high'));
  assert.ok(permissionIds(m).includes('bridgeApprovals'));
  assert.equal(parseManifest(base({ bridges: ['chatx'] }), { saraVersion: '9.0.0' }).permissions.bridgeApprovals, false);
  // The review card's words are translated (web/plugins.js PERM, then every web/i18n file).
  const perms = readFileSync(join(ROOT, 'web', 'plugins.js'), 'utf8');
  for (const k of ['Connects to {domain} and its subdomains (ports {ports}, always encrypted)', 'Shows her requests for your OK in its chats, with Allow and Deny (only you can answer)']) {
    assert.ok(perms.includes(`'${k}'`), k);
    for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.ok((JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>)[k], `${lang}: ${k}`);
  }
});

test('B5 through the broker: inside the domain only, public addresses only, the certificate checked against the named host', async (t) => {
  const now = Date.now();
  const ca = makeCert({ cn: 'Sara test CA', ca: true, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 86_400_000) });
  const leaf = makeCert({ cn: 'slack.com', dns: ['slack.com', '*.slack.com'], issuer: ca, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 86_400_000) });
  const server = tlsServer({ key: leaf.key.export({ type: 'pkcs8', format: 'pem' }) as string, cert: leaf.pem }, (s) => s.end('hi\n'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const logs: string[] = [];
  const dns: Record<string, string[]> = { 'slack.com': ['127.0.0.1'], 'wss-primary.slack.com': ['127.0.0.1'], 'files.slack.com': ['127.0.0.1'], 'inside.slack.com': ['10.0.0.5'] };
  const endpoints = [{ id: 'api', host: 'domain:slack.com', ports: [443], where: 'public' as const, tls: 'required' as const }];
  const sent: Record<string, unknown>[] = [];
  const socks = new PluginSockets({ endpoints, settings: () => ({}), send: (m) => (sent.push(m), true), backlog: () => 0, log: (_k, x) => logs.push(x), lookup: async (h) => dns[h] ?? [], ca: ca.pem, testLoopback: true, testPort: port });
  t.after(() => socks.dispose());
  // The named host inside the domain (and the bare domain when none is named).
  const a = await socks.open({ endpoint: 'api', host: 'wss-primary.slack.com' });
  assert.ok(String(a.socket).startsWith('s'));
  assert.ok(logs.some((l) => /connected to wss-primary\.slack\.com:443/.test(l)), logs.join('\n'));
  // The SDK passes the endpoint as given: `<id>@<host>` names the host too.
  await socks.open({ endpoint: 'api@files.slack.com' });
  assert.ok(logs.some((l) => /connected to files\.slack\.com:443/.test(l)));
  await assert.rejects(socks.open({ endpoint: 'api@evil.example' }), /isn't slack\.com or one of its subdomains/);
  const b = await socks.open({ endpoint: 'api' });
  assert.ok(b.socket);
  assert.ok(logs.some((l) => /connected to slack\.com:443/.test(l)));
  // Outside the domain, look-alikes and a private answer are refused.
  for (const h of ['evil.example', 'slack.com.evil.example', 'xslack.com', 'a..slack.com', 'wss primary.slack.com']) await assert.rejects(socks.open({ endpoint: 'api', host: h }), /isn't slack\.com or one of its subdomains/, h);
  await assert.rejects(socks.open({ endpoint: 'api', host: 'inside.slack.com' }), /private or local address/);
  await assert.rejects(socks.open({ endpoint: 'api', host: 'nothing.slack.com' }), /couldn't be found/);
  await assert.rejects(socks.open({ endpoint: 'api', host: 'files.slack.com', port: 8443 }), /isn't one of 443/);
  // A `setting:` endpoint never takes a named host (`<id>@<host>` isn't one of its connections).
  const mixed = new PluginSockets({ endpoints: [{ id: 'hs', host: 'setting:homeserver', ports: [443], where: 'public', tls: 'required' }], settings: () => ({ homeserver: 'slack.com' }), send: () => true, backlog: () => 0, log: () => undefined, lookup: async (h) => dns[h] ?? [], ca: ca.pem, testLoopback: true });
  t.after(() => mixed.dispose());
  await assert.rejects(mixed.open({ endpoint: 'hs@files.slack.com' }), /isn't one of the connections in its manifest/);
  // Without the test override the loopback stand-in is refused like any private address.
  const real = new PluginSockets({ endpoints, settings: () => ({}), send: () => true, backlog: () => 0, log: () => undefined, lookup: async (h) => dns[h] ?? [], ca: ca.pem, testPort: port });
  t.after(() => real.dispose());
  await assert.rejects(real.open({ endpoint: 'api', host: 'files.slack.com' }), /private or local address/);
});
