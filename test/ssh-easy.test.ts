// 2.52.1 (docs/design/SSH_EASY.md §10): "Connect a server", the easy way. The fake OpenSSH from
// test/ssh-fake.ts plays the server (methods list, shell kind, user, refused / timed-out / not-SSH
// ports); the port greeting runs against REAL local TCP listeners (one answering SSH-2.0, one a web
// server); cPanel is a real local HTTP server reached through the tests-only base URL, with the TLS
// look (certificate + cpsrvd) injected. No real server, no network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { memberRouteCheck, MEMBER_ROUTES, type MemberRecord } from '../src/household.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { pasteCommand, redactTypedPassword, SshManager, vaultKeyOf } from '../src/ssh.ts';
import { cpanelCall, cpanelPath, CPANEL_ALLOWED, DIAG, diagnoseRun, MAX_PORT_TRIES, parseAddress, PORT_LIST, readGreeting, type CpanelPeek } from '../src/ssh-easy.ts';
import { createSshTools, sshServerLink } from '../src/tools/ssh.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';
import { FakeSsh, fpOf, HOSTKEY_B, OWNER_LINE, PASSWORD } from './ssh-fake.ts';

const closers: (() => void | Promise<void>)[] = [];
after(async () => {
  setPrivateLocal(false);
  for (const c of closers.reverse()) await c();
});
function scratch(): string {
  const t = tempDir();
  closers.push(t.cleanup);
  return t.dir;
}
const clock = { now: new Date('2026-11-01T15:00:00Z') };
const TOKEN = 'Q7K2M9X4B8N3V6C1Z5L0P2R7T4W9Y3H8';

// ---------- a fake cPanel (real local HTTP server, reached through the tests-only base URL) ----------
interface CpanelSeen {
  url: string;
  auth: string;
}
class FakeCpanel {
  seen: CpanelSeen[] = [];
  user = 'alex';
  token = TOKEN;
  tokens = [{ name: 'sara' }, { name: 'other' }];
  importFails = false;
  keys: Record<string, string> = {};
  server = createHttpServer((req, res) => this.#handle(req, res));
  port = 0;
  readonly fake: FakeSsh;
  constructor(fake: FakeSsh) {
    this.fake = fake;
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((r) => this.server.close(() => r())));
    return this;
  }
  #handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const auth = String(req.headers.authorization ?? '');
    this.seen.push({ url: req.url ?? '', auth });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', server: 'cpsrvd/11.120' });
      res.end(JSON.stringify(body));
    };
    if (auth !== `cpanel ${this.user}:${this.token}`) return json(401, { errors: ['Access denied'] });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/execute/Tokens/list') return json(200, { status: 1, data: this.tokens, errors: null });
    if (u.pathname === '/execute/Tokens/revoke') {
      this.tokens = this.tokens.filter((t) => t.name !== u.searchParams.get('name'));
      return json(200, { status: 1, data: 1, errors: null });
    }
    if (u.pathname === '/json-api/cpanel') {
      const fn = u.searchParams.get('cpanel_jsonapi_func');
      if (fn === 'importkey') {
        if (this.importFails) return json(200, { cpanelresult: { event: { result: 0 }, error: 'The key could not be imported.', data: [] } });
        this.keys[u.searchParams.get('name')!] = u.searchParams.get('key')!;
        this.fake.pubFiles[`${u.searchParams.get('name')}.pub`] = u.searchParams.get('key')!;
        return json(200, { cpanelresult: { event: { result: 1 }, data: [{ name: u.searchParams.get('name') }] } });
      }
      if (fn === 'authkey' && u.searchParams.get('action') === 'authorize') {
        const k = this.keys[u.searchParams.get('key')!];
        if (k && !this.fake.authorized.includes(k)) this.fake.authorized.push(k);
        return json(200, { cpanelresult: { event: { result: 1 }, data: [{ status: 'authorized' }] } });
      }
    }
    return json(404, { errors: ['no such function'] });
  }
}
const goodPeek = async (): Promise<CpanelPeek> => ({ reachable: true, cpanel: true, certOk: true, certNames: [] });

function manager(o: { fake?: FakeSsh; cpanel?: FakeCpanel; peek?: (h: string) => Promise<CpanelPeek>; privateLocal?: boolean; dir?: string } = {}) {
  const dir = o.dir ?? scratch();
  const fake = o.fake ?? new FakeSsh();
  const vault = new Vault(dir);
  const peeks: string[] = [];
  const m = new SshManager({
    dir, vault, run: fake.run, greet: fake.greet, lookup: fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => o.privateLocal === true,
    cpanel: { peek: async (h) => (peeks.push(h), (o.peek ?? goodPeek)(h)), ...(o.cpanel ? { baseUrl: () => `http://127.0.0.1:${o.cpanel!.port}` } : {}) },
  });
  return { m, fake, vault, dir, peeks };
}
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const trustPending = (m: SshManager, id: string) => m.trust(id, m.view(m.get(id)).pendingFingerprint!);

// ---------------------------------------------------------------------------------------------
// 1. Address parsing
// ---------------------------------------------------------------------------------------------
test('1. address parsing: user@host:port, a pasted ssh -p command, a cPanel link; junk keeps the old words', async () => {
  assert.deepEqual(parseAddress('alex@example.com:2222'), { host: 'example.com', user: 'alex', port: 2222 });
  assert.deepEqual(parseAddress('ssh -p 2222 alex@example.com'), { host: 'example.com', user: 'alex', port: 2222 });
  assert.deepEqual(parseAddress('ssh alex@example.com -p 21098'), { host: 'example.com', user: 'alex', port: 21098 });
  assert.deepEqual(parseAddress('https://example.com:2083/'), { host: 'example.com', cpanel: true });
  assert.deepEqual(parseAddress('  example.com '), { host: 'example.com' });
  assert.deepEqual(parseAddress('203.0.113.5'), { host: '203.0.113.5' });
  const { m } = manager();
  await assert.rejects(m.connectServer({ address: 'not a host!', user: 'alex' }), (e: Error & { code?: string }) => e.code === 'BAD_HOST' && /server’s name or IP address/.test(e.message));
  await assert.rejects(m.connectServer({ address: 'example.com', user: 'bad user' }), (e: Error & { code?: string }) => e.code === 'BAD_USER');
  await assert.rejects(m.connectServer({ address: 'example.com' }), (e: Error & { code?: string }) => e.code === 'BAD_USER');
  const s = await m.connectServer({ address: 'ssh -p 2222 alex@example.com' });
  assert.equal(s.user, 'alex');
  assert.equal(s.port, 2222);
  assert.equal(s.name, 'example', 'the name defaults to the first label');
});

// ---------------------------------------------------------------------------------------------
// 2. Port finding (with real local listeners for the greeting read)
// ---------------------------------------------------------------------------------------------
const listeners: Server[] = [];
async function listen(onConn: (sock: import('node:net').Socket) => void): Promise<number> {
  const srv = createTcpServer(onConn);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  listeners.push(srv);
  closers.push(() => new Promise<void>((r) => srv.close(() => r())));
  return (srv.address() as AddressInfo).port;
}
test('2a. the greeting read against real listeners: SSH-2.0 is SSH, a web server is not, nothing listening is refused', async () => {
  const sshPort = await listen((s) => s.end('SSH-2.0-OpenSSH_9.6\r\n'));
  const webPort = await listen((s) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
  assert.deepEqual(await readGreeting('127.0.0.1', sshPort, 3000), { kind: 'ssh', banner: 'SSH-2.0-OpenSSH_9.6' });
  const web = await readGreeting('127.0.0.1', webPort, 4000);
  assert.equal(web.kind, 'other');
  assert.match(web.banner!, /^HTTP\/1\.1 400/);
  const closed = await listen(() => undefined);
  listeners.at(-1)!.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readGreeting('127.0.0.1', closed, 3000)).kind, 'refused');
});

test('2b. port finding: blank port finds a non-22 port from the list; never more than 7; NOT_SSH, PORT_CLOSED, TIMEOUT with the ports tried', async () => {
  assert.deepEqual([...PORT_LIST], [22, 2222, 21098, 18765, 65002, 7822]);
  assert.ok(PORT_LIST.length <= MAX_PORT_TRIES);
  const f = new FakeSsh();
  f.ports = { 18765: 'ssh' };
  const { m } = manager({ fake: f });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  assert.equal(s.port, 18765);
  assert.deepEqual(s.probe!.ports, [22, 2222, 21098, 18765]);
  assert.ok(s.probe!.recommended !== 'fix');
  const f2 = new FakeSsh();
  f2.ports = { 22: 'http' };
  const nonSsh = await manager({ fake: f2 }).m.connectServer({ address: 'example.com', user: 'alex' });
  assert.equal(nonSsh.probe!.code, 'NOT_SSH');
  assert.equal(nonSsh.probe!.recommended, 'fix');
  assert.ok(f2.greetings.length <= MAX_PORT_TRIES);
  const f3 = new FakeSsh();
  f3.ports = {};
  const shut = await manager({ fake: f3 }).m.connectServer({ address: 'example.com', user: 'alex' });
  assert.equal(shut.probe!.code, 'PORT_CLOSED');
  assert.equal(shut.probe!.params!.ports, '22, 2222, 21098, 18765, 65002, 7822');
  assert.equal(f3.greetings.length, 6);
  const f4 = new FakeSsh();
  f4.ports = Object.fromEntries(PORT_LIST.map((p) => [p, 'timeout']));
  const quiet = await manager({ fake: f4 }).m.connectServer({ address: '192.0.2.10', user: 'alex' });
  assert.equal(quiet.probe!.code, 'TIMEOUT');
  // An owner-given port is the only one tried, until "Find the port".
  const f5 = new FakeSsh();
  f5.ports = { 2222: 'ssh' };
  const o5 = manager({ fake: f5 });
  const given = await o5.m.connectServer({ address: 'example.com:22', user: 'alex' });
  assert.equal(given.probe!.code, 'PORT_CLOSED');
  assert.equal(f5.greetings.length, 1);
  const found = await o5.m.probe(given.id, { findPort: true });
  assert.equal(found.port, 2222);
});

// ---------------------------------------------------------------------------------------------
// 3. Methods
// ---------------------------------------------------------------------------------------------
test('3. methods: (publickey) → PASSWORD_OFF, no password path; (publickey,password) → password path; the check offers nothing', async () => {
  const f = new FakeSsh();
  f.methods = ['publickey'];
  const { m, dir } = manager({ fake: f, peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  assert.deepEqual(s.probe!.methods, ['publickey']);
  assert.equal(s.probe!.passwords, false);
  assert.equal(s.probe!.recommended, 'paste');
  // With cPanel on 2083: the token path.
  const f2 = new FakeSsh();
  f2.methods = ['publickey', 'gssapi-keyex', 'gssapi-with-mic'];
  const cp = await manager({ fake: f2 }).m.connectServer({ address: 'example.com', user: 'alex' });
  assert.equal(cp.probe!.recommended, 'cpanel');
  assert.equal(cp.probe!.passwords, false);
  // (publickey,password) → the password path.
  const f3 = new FakeSsh();
  f3.methods = ['publickey', 'password'];
  const pw = await manager({ fake: f3, peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) }).m.connectServer({ address: 'example.com', user: 'alex' });
  assert.equal(pw.probe!.recommended, 'password');
  // The check itself: every client method off, BatchMode, a throw-away known_hosts with the pending key; no key, no askpass.
  const c = f.methodChecks[0];
  for (const want of ['BatchMode=yes', 'PubkeyAuthentication=no', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=yes', 'IdentityFile=none', 'IdentityAgent=none']) assert.ok(c.includes(want), want);
  assert.ok(!c.includes('-i'));
  const kh = c.find((a) => a.startsWith('UserKnownHostsFile='))!.slice('UserKnownHostsFile='.length);
  assert.notEqual(kh, m.knownHostsFile(s.id), 'not the approved known_hosts');
  assert.equal(existsSync(kh), false, 'thrown away');
  const call = f.calls.find((x) => x.args === c || x.args.join() === c.join())!;
  assert.equal(call.env.SSH_ASKPASS, undefined);
  assert.equal(existsSync(m.knownHostsFile(s.id)), false, 'nothing trusted on her own');
  void dir;
  // The password try on a key-only server reads as PASSWORD_OFF.
  trustPending(m, s.id);
  await assert.rejects(m.loginWithPassword(s.id, PASSWORD), (e: Error & { code?: string }) => e.code === 'PASSWORD_OFF');
  assert.equal(f.passwordsSeen.length, 0, 'ssh never asked for it');
});

// ---------------------------------------------------------------------------------------------
// 4. Her key before sign-in
// ---------------------------------------------------------------------------------------------
test('4. her key is made at Connect (0600), the paste line is exact, a failed try keeps it, a second sign-in reuses it', async () => {
  const { m, fake, dir } = manager({ peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) });
  const s = await m.connectServer({ address: 'alex@example.com', user: '' });
  const saved = JSON.parse(readFileSync(join(dir, 'ssh', 'servers.json'), 'utf8')) as { servers: { key?: { publicLine: string } }[] };
  const line = saved.servers[0].key!.publicLine;
  assert.match(line, /^ssh-ed25519 \S+ sara@home-20261101$/);
  assert.ok(existsSync(m.keyFile(s.id)));
  if (process.platform !== 'win32') assert.equal(statSync(m.keyFile(s.id)).mode & 0o777, 0o600);
  assert.equal(pasteCommand(line), `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${line}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);
  assert.equal(m.view(m.get(s.id)).pasteCommand, pasteCommand(line));
  assert.equal(m.view(m.get(s.id)).ready, false, 'made, not installed');
  trustPending(m, s.id);
  await assert.rejects(m.loginWithPassword(s.id, 'Wr0ng-Pass!'), (e: Error & { code?: string }) => e.code === 'WRONG_PASSWORD');
  assert.equal(m.get(s.id).key!.publicLine, line, 'kept after a failed try');
  await m.loginWithPassword(s.id, PASSWORD);
  await m.loginWithPassword(s.id, PASSWORD);
  assert.equal(fake.authorized.filter((l) => / sara@home-/.test(l)).length, 1, 'no second line');
  assert.equal(m.get(s.id).key!.publicLine, line, 'the same key');
  assert.equal(fake.keysMade, 1);
  assert.equal(m.get(s.id).connectedVia, 'password');
});

// ---------------------------------------------------------------------------------------------
// 5. The cPanel path
// ---------------------------------------------------------------------------------------------
test('5. cPanel: header only, exactly four allow-listed calls, her line authorized, token revoked and nowhere on disk', async () => {
  const fake = new FakeSsh();
  fake.methods = ['publickey'];
  const cp = await new FakeCpanel(fake).start();
  const o = manager({ fake, cpanel: cp });
  const s = await o.m.connectServer({ address: 'https://example.com:2083/', user: 'alex' });
  assert.equal(s.probe!.recommended, 'cpanel');
  trustPending(o.m, s.id);
  const r = await o.m.installViaCpanel(s.id, TOKEN);
  assert.equal(r.test.ok, true, JSON.stringify(r.test));
  assert.equal(r.tokenRevoked, true);
  const fns = cp.seen.map((x) => /cpanel_jsonapi_func=(\w+)/.exec(x.url)?.[1] ?? /\/execute\/Tokens\/(\w+)/.exec(x.url)?.[1]);
  assert.deepEqual(fns, ['list', 'importkey', 'authkey', 'revoke']);
  for (const x of cp.seen) {
    assert.equal(x.auth, `cpanel alex:${TOKEN}`, 'the token in the Authorization header');
    assert.ok(!x.url.includes(TOKEN), `no token in ${x.url}`);
  }
  const imp = new URL(cp.seen[1].url, 'http://x').searchParams;
  assert.equal(imp.get('name'), `sara-${s.id}`);
  assert.equal(imp.get('key'), o.m.get(s.id).key!.publicLine);
  assert.equal(new URL(cp.seen[2].url, 'http://x').searchParams.get('action'), 'authorize');
  assert.ok(fake.authorized.includes(o.m.get(s.id).key!.publicLine));
  assert.equal(o.m.get(s.id).connectedVia, 'cpanel');
  assert.ok(!cp.tokens.some((t) => t.name === 'sara'), 'Sara deleted the token');
  assert.ok(o.m.get(s.id).history!.some((h) => /through cPanel/.test(h.text)));
  // The token: no file under the data folder, no vault entry, no error text, no receipt line.
  for (const f of walk(o.dir)) assert.ok(!readFileSync(f).includes(Buffer.from(TOKEN)), `token in ${f}`);
  assert.ok(!o.vault.values().some((v) => v.includes(TOKEN)), 'no vault entry');
  assert.ok(!JSON.stringify(o.m.view(o.m.get(s.id))).includes(TOKEN));
  // Remove: her line and cPanel's sara-<id>.pub go.
  assert.ok(fake.pubFiles[`sara-${s.id}.pub`]);
  await o.m.revokeKey(s.id);
  assert.equal(fake.pubFiles[`sara-${s.id}.pub`], undefined);
  assert.ok(!fake.authorized.some((l) => / sara@home-/.test(l)));
});

test('5b. cPanel: a 401 is WRONG_USER; a certificate for another name sends no token and offers that name; the allow-list throws before a request', async () => {
  const fake = new FakeSsh();
  const cp = await new FakeCpanel(fake).start();
  cp.user = 'someoneelse';
  const o = manager({ fake, cpanel: cp });
  const s = await o.m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(o.m, s.id);
  await assert.rejects(o.m.installViaCpanel(s.id, TOKEN), (e: Error & { code?: string; message: string }) => e.code === 'WRONG_USER' && /no cPanel user “alex”/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(cp.seen.length, 1, 'stopped after Tokens::list');
  await assert.rejects(o.m.installViaCpanel(s.id, 'not-a-token'), (e: Error & { code?: string }) => e.code === 'BAD_TOKEN');
  // The certificate is for the server's own name: no token is sent; that name is offered.
  const cp2 = await new FakeCpanel(fake).start();
  const o2 = manager({ fake, cpanel: cp2, peek: async (h) => (h === 'server123.host.test' ? { reachable: true, cpanel: true, certOk: true, certNames: [] } : { reachable: true, cpanel: true, certOk: false, certNames: ['server123.host.test'] }) });
  const s2 = await o2.m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(o2.m, s2.id);
  await assert.rejects(o2.m.installViaCpanel(s2.id, TOKEN), (e: Error & { code?: string; diagnosis?: { params: Record<string, string> } }) => e.code === 'CERT_NAME' && e.diagnosis!.params.other === 'server123.host.test');
  assert.equal(cp2.seen.length, 0, 'no token sent');
  await assert.rejects(o2.m.installViaCpanel(s2.id, TOKEN, { apiHost: 'evil.example' }), /certificate showed/);
  const ok = await o2.m.installViaCpanel(s2.id, TOKEN, { apiHost: 'server123.host.test' });
  assert.equal(ok.test.ok, true);
  assert.equal(o2.m.get(s2.id).cpanelHost, 'server123.host.test');
  assert.equal(o2.m.get(s2.id).host, 'example.com', 'the SSH address stays');
  // Allow-list.
  assert.deepEqual([...CPANEL_ALLOWED], ['Tokens::list', 'SSH::importkey', 'SSH::authkey', 'Tokens::revoke']);
  assert.throws(() => cpanelPath('Fileman::upload_files', 'alex', {}), /allow-list/);
  let fetched = 0;
  await assert.rejects(cpanelCall('UAPI::anything' as never, { apiHost: 'x', port: 2083, user: 'a', token: Buffer.from(TOKEN), http: { fetch: (async () => (fetched++, new Response('{}'))) as typeof fetch } }), /allow-list/);
  assert.equal(fetched, 0);
  // importkey failing → CPANEL_FAILED pointing at copy-paste.
  const cp3 = await new FakeCpanel(fake).start();
  cp3.importFails = true;
  const o3 = manager({ fake, cpanel: cp3 });
  const s3 = await o3.m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(o3.m, s3.id);
  await assert.rejects(o3.m.installViaCpanel(s3.id, TOKEN), (e: Error & { code?: string; diagnosis?: { actions: string[] } }) => e.code === 'CPANEL_FAILED' && e.diagnosis!.actions.includes('paste'));
});

// ---------------------------------------------------------------------------------------------
// 6. Paste path
// ---------------------------------------------------------------------------------------------
test('6. paste: check now before the line is there → KEY_NOT_ACCEPTED with the Authorize hint; after → connected', async () => {
  const fake = new FakeSsh();
  fake.methods = ['publickey'];
  const { m } = manager({ fake, peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(m, s.id);
  const before = await m.checkKey(s.id);
  assert.equal(before.ok, false);
  assert.equal(before.code, 'KEY_NOT_ACCEPTED');
  assert.match(before.fix, /Manage → Authorize/);
  fake.authorized.push(m.get(s.id).key!.publicLine);
  const now = await m.checkKey(s.id);
  assert.equal(now.ok, true);
  assert.equal(now.code, 'CONNECTED');
  assert.equal(m.get(s.id).connectedVia, 'paste');
  assert.equal(m.view(m.get(s.id)).ready, true);
});

// ---------------------------------------------------------------------------------------------
// 7. Diagnoses
// ---------------------------------------------------------------------------------------------
test('7. every diagnosis comes from the fake’s output, in plain words; no raw OpenSSH text; no secret in Details', async () => {
  const ctx = (mode: 'password' | 'key' | 'test' = 'key') => ({ mode, host: 'example.com', port: 22, user: 'alex', name: 'example', secrets: [PASSWORD] });
  const run = (stderr: string, code: number | null = 255, stdout = '') => ({ code, stdout, stderr });
  const cases: [string, ReturnType<typeof run>, 'password' | 'key' | 'test'][] = [
    ['DNS', run('ssh: Could not resolve hostname exmaple.com: Name or service not known'), 'key'],
    ['PORT_CLOSED', run('ssh: connect to host example.com port 22: Connection refused'), 'key'],
    ['TIMEOUT', run('ssh: connect to host 192.0.2.10 port 22: Connection timed out'), 'key'],
    ['HOSTKEY_CHANGED', run('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.'), 'key'],
    ['PASSWORD_OFF', run('alex@example.com: Permission denied (publickey).'), 'password'],
    ['WRONG_PASSWORD', run(`alex@example.com: Permission denied (publickey,password). tried ${PASSWORD}`), 'password'],
    ['KEY_NOT_ACCEPTED', run('alex@example.com: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).'), 'key'],
    ['NO_SHELL', run('Shell access is not enabled on your account!', 1), 'test'],
    ['NO_SHELL', run('Authenticated to example.com using "publickey".', 1), 'test'],
    ['TWO_STEP', run('Authenticated using "publickey" with partial success.\nalex@example.com: Permission denied (keyboard-interactive).'), 'key'],
    ['TOO_MANY', run('Received disconnect from 192.0.2.10 port 22:2: Too many authentication failures'), 'key'],
    ['TOO_MANY', run('kex_exchange_identification: Connection closed by remote host'), 'key'],
    ['UNKNOWN', run('something odd happened'), 'key'],
  ];
  for (const [code, r, mode] of cases) {
    const d = diagnoseRun(r, ctx(mode))!;
    assert.equal(d.code, code, `${code}: ${r.stderr}`);
    for (const t of [d.title, d.fix]) {
      assert.doesNotMatch(t, /Permission denied|ssh: connect|kex_exchange|Could not resolve|Host key verification|REMOTE HOST/, `${code}: raw OpenSSH text in "${t}"`);
      assert.ok(!t.includes(PASSWORD));
    }
    assert.ok(!(d.details ?? '').includes(PASSWORD), `${code}: password in Details`);
  }
  // NOT_SSH and WRONG_USER come from the probe and cPanel (tests 2 and 5); the jailed note from the test.
  const fake = new FakeSsh();
  fake.shell = 'jailshell';
  const { m } = manager({ fake, peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(m, s.id);
  await m.loginWithPassword(s.id, PASSWORD);
  const t = await m.test(s.id);
  assert.equal(t.code, 'JAILED');
  assert.equal(t.ok, true);
  fake.shell = 'noshell';
  assert.equal((await m.test(s.id)).code, 'NO_SHELL');
  fake.shell = '/bin/false';
  assert.equal((await m.test(s.id)).code, 'NO_SHELL');
  fake.shell = 'bash';
  fake.twoStep = true;
  assert.equal((await m.test(s.id)).code, 'TWO_STEP');
  fake.twoStep = false;
  fake.down = 'too-many';
  assert.equal((await m.test(s.id)).code, 'TOO_MANY');
  fake.down = undefined;
  // Every code has a title; the page translates them (en() templates in src/ssh-easy.ts).
  for (const [k, v] of Object.entries(DIAG)) assert.ok(v.title, k);
});

// ---------------------------------------------------------------------------------------------
// 8. Host key
// ---------------------------------------------------------------------------------------------
test('8. host key: first-use and changed wording on the page; trust needs the exact fingerprint; a changed key blocks exec', async () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'web', 'ssh.js'), 'utf8');
  assert.match(html, /Is this really your server\?/);
  assert.match(html, /How can I check it\?/);
  assert.match(js, /Stop: \{host\} is showing a different ID card\./);
  assert.match(js, /Yes, remember it and continue/);
  assert.match(js, /I reinstalled or moved it: trust the new one/);
  assert.doesNotMatch(html, /It matches: trust this host key/);
  const fake = new FakeSsh();
  const { m } = manager({ fake });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  assert.throws(() => m.trust(s.id, 'SHA256:nope'), /doesn’t match/);
  trustPending(m, s.id);
  await m.loginWithPassword(s.id, PASSWORD);
  fake.hostKey = HOSTKEY_B;
  await assert.rejects(m.exec(s.id, 'uptime'), (e: Error & { code?: string }) => e.code === 'HOSTKEY_CHANGED');
  await assert.rejects(m.exec(s.id, 'uptime'), /changed since you approved it/);
  const t = await m.test(s.id);
  assert.equal(t.code, 'HOSTKEY_CHANGED');
  assert.equal(t.diagnosis!.params.new, fpOf(HOSTKEY_B));
  // Connect again: the probe stops at the changed key too.
  const again = await m.probe(s.id);
  assert.equal(again.probe!.code, 'HOSTKEY_CHANGED');
});

// ---------------------------------------------------------------------------------------------
// 9. Keys: replace, clean up, remove, edit
// ---------------------------------------------------------------------------------------------
test('9. replace installs the new line with the old key, then removes the old; clean up takes only stale sara lines; edit keeps a matching host key', async () => {
  const fake = new FakeSsh();
  const { m } = manager({ fake, peek: async () => ({ reachable: false, cpanel: false, certOk: false, certNames: [] }) });
  const s = await m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(m, s.id);
  await m.loginWithPassword(s.id, PASSWORD);
  const old = m.get(s.id).key!.publicLine;
  const seenPw = fake.passwordsSeen.length;
  const r = await m.replaceKey(s.id);
  const fresh = m.get(s.id).key!.publicLine;
  assert.notEqual(fresh, old);
  assert.ok(fake.authorized.includes(fresh));
  assert.ok(!fake.authorized.includes(old));
  assert.ok(fake.authorized.includes(OWNER_LINE), "the owner's own line stays");
  assert.equal(fake.passwordsSeen.length, seenPw, 'no password needed');
  assert.match(r.message, /new one works and the old line is gone/);
  assert.equal(existsSync(`${m.keyFile(s.id)}.new`), false);
  assert.ok((await m.test(s.id)).ok);
  // Stale lines from an older install, and a look-alike that isn't hers.
  const stale = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIstaleSaraLine000000000000000000000000 sara@home-20261001';
  const lookAlike = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsomeoneElse0000000000000000000000000 sara@office-20261001';
  fake.authorized.push(stale, lookAlike);
  fake.pubFiles['sara-oldoldold1.pub'] = stale;
  const t = await m.test(s.id);
  assert.equal(m.get(s.id).lastCheck!.extraLines, 1, `the test sees the extra line (${t.code})`);
  const list = await m.listOwnLines(s.id);
  assert.deepEqual(list.lines.sort(), [fresh, stale].sort());
  const c = await m.cleanupOwnLines(s.id);
  assert.equal(c.removed, 1);
  assert.deepEqual(c.comments, ['sara@home-20261001']);
  assert.ok(!fake.authorized.includes(stale));
  assert.ok(fake.authorized.includes(lookAlike) && fake.authorized.includes(OWNER_LINE) && fake.authorized.includes(fresh));
  assert.equal(fake.pubFiles['sara-oldoldold1.pub'], undefined);
  // Edit: a new port with the same host key keeps it; a different key there is a hard stop.
  const fp = m.get(s.id).fingerprint;
  await m.updateServer(s.id, { port: 2222, name: 'web box' });
  assert.equal(m.get(s.id).port, 2222);
  assert.equal(m.get(s.id).fingerprint, fp);
  assert.equal(m.get(s.id).pending, undefined);
  assert.equal(m.get(s.id).name, 'web box');
  fake.hostKey = HOSTKEY_B;
  await m.updateServer(s.id, { port: 22 });
  assert.equal(m.view(m.get(s.id)).hostKeyChanged, true);
  fake.hostKey = 'AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  await m.updateServer(s.id, { port: 2222 });
  assert.equal(m.view(m.get(s.id)).hostKeyChanged, undefined);
  // Edit user: her line belongs to the old user, so the card asks to connect again.
  await m.updateServer(s.id, { user: 'deploy' });
  assert.equal(m.view(m.get(s.id)).ready, false);
  // Replace when the old key no longer works: the new key is kept and the owner reconnects.
  fake.authorized = [OWNER_LINE];
  await m.updateServer(s.id, { user: 'alex' });
  const lost = await m.replaceKey(s.id);
  assert.equal(lost.reconnect, true);
  assert.equal(lost.diagnosis!.code, 'KEY_NOT_ACCEPTED');
});

// ---------------------------------------------------------------------------------------------
// 10. Who; 11. Chat; 12 is test/phase73.test.ts
// ---------------------------------------------------------------------------------------------
function setupApp(dir: string, withSsh = true, cp?: FakeCpanel): TestApp & { fake: FakeSsh } {
  const app = makeApp(dir, clock) as TestApp & { fake: FakeSsh };
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  closers.push(() => app.store.close());
  app.fake = cp?.fake ?? new FakeSsh();
  if (withSsh) {
    app.ssh = new SshManager({ dir, vault: app.vault, run: app.fake.run, greet: app.fake.greet, lookup: app.fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => false, cpanel: { peek: goodPeek, ...(cp ? { baseUrl: () => `http://127.0.0.1:${cp.port}` } : {}) } });
    for (const t of createSshTools(() => app.ssh)) app.tools.add(t);
  }
  return app;
}

test('10. private local mode refuses a non-loopback probe and the cPanel call before any connect or fetch', async () => {
  const fake = new FakeSsh();
  const cp = await new FakeCpanel(fake).start();
  const o = manager({ fake, cpanel: cp, privateLocal: true });
  await assert.rejects(o.m.connectServer({ address: 'example.com', user: 'alex' }), (e: Error & { code?: string }) => e.code === 'PRIVATE_LOCAL');
  assert.equal(fake.greetings.length + fake.lookups.length + fake.calls.length + o.peeks.length, 0);
  // A server added before the mode went on: the probe and the cPanel call stop before anything.
  const o2 = manager({ fake, cpanel: cp });
  const s = await o2.m.connectServer({ address: 'example.com', user: 'alex' });
  trustPending(o2.m, s.id);
  const o3 = manager({ fake, cpanel: cp, privateLocal: true, dir: o2.dir });
  const g = fake.greetings.length;
  const p = await o3.m.probe(s.id);
  assert.equal(p.probe!.code, 'PRIVATE_LOCAL');
  assert.equal(fake.greetings.length, g);
  await assert.rejects(o3.m.installViaCpanel(s.id, TOKEN), (e: Error & { code?: string }) => e.code === 'PRIVATE_LOCAL');
  assert.equal(cp.seen.length, 0);
  assert.equal(o3.peeks.length, 0);
});

const ownerDir = scratch();
const cpFake = new FakeSsh();
cpFake.methods = ['publickey'];
const cpanel = new FakeCpanel(cpFake);
let owner: TestApp & { fake: FakeSsh };
let base = '';
let ownerToken = '';
before(async () => {
  await cpanel.start();
  owner = setupApp(ownerDir, true, cpanel);
  const auth = new OwnerAuth(ownerDir, () => clock.now);
  ownerToken = auth.newToken!;
  const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
});
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', origin: base }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

test('10b/11. the routes end to end (Connect → yes → cPanel token), members 403 on every new route; ssh_connect gives the plan and the deep link', async () => {
  const conv = owner.store.createConversation();
  const tool = createSshTools(() => owner.ssh).find((t) => t.spec.name === 'ssh_connect')!;
  const said = await tool.run({ host: 'https://example.com:2083', user: 'alex' }, { conversationId: conv.id } as never);
  const srv = owner.ssh!.list()[0];
  assert.match(said, /runs cPanel and doesn't take passwords/);
  assert.ok(said.includes(sshServerLink(srv.id)), said);
  assert.match(said, /\/#view=settings:ab-ssh&server=[a-z0-9]{10}/);
  assert.match(said, /never in chat/);
  // The page: GET, then the path the owner takes.
  const list = await api('GET', '/ssh');
  const v = list.json.servers[0];
  assert.equal(v.probe.recommended, 'cpanel');
  assert.ok(v.pasteCommand && v.publicKey);
  assert.equal((await api('POST', `/ssh/servers/${v.id}/cpanel`, { token: TOKEN })).status, 400, 'host key first');
  assert.equal((await api('POST', `/ssh/servers/${v.id}/trust`, { fingerprint: v.pendingFingerprint })).status, 200);
  const bad = await api('POST', `/ssh/servers/${v.id}/cpanel`, { token: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.diagnosis.code, 'BAD_TOKEN');
  const done = await api('POST', `/ssh/servers/${v.id}/cpanel`, { token: TOKEN });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.ok, true);
  assert.equal(done.json.tokenRevoked, true);
  assert.ok(!JSON.stringify(done.json).includes(TOKEN));
  assert.equal(done.json.server.connectedVia, 'cpanel');
  assert.equal((await api('PATCH', `/ssh/servers/${v.id}`, { name: 'my site' })).json.server.name, 'my site');
  assert.equal((await api('POST', `/ssh/servers/${v.id}/check`, {})).json.code, 'CONNECTED');
  assert.ok(Array.isArray((await api('GET', `/ssh/servers/${v.id}/cleanup`)).json.lines));
  assert.equal((await api('POST', `/ssh/servers/${v.id}/cleanup`, {})).status, 200);
  assert.equal((await api('POST', `/ssh/servers/${v.id}/replace-key`, {})).status, 200);
  assert.equal((await api('POST', `/ssh/servers/${v.id}/probe`, {})).status, 200);
  const connected = await api('POST', '/ssh/servers', { address: 'ssh -p 2222 deploy@example.org' });
  assert.equal(connected.status, 200);
  assert.equal(connected.json.server.port, 2222);
  for (const f of walk(ownerDir)) assert.ok(!readFileSync(f).includes(Buffer.from(TOKEN)), `token in ${f}`);
  assert.ok(!JSON.stringify(owner.store.messages(conv.id)).includes(TOKEN));
  // Members: owner-only route group (every new route lives under /api/ssh).
  assert.equal(MEMBER_ROUTES.has('ssh'), false);
  const rec = { id: 'm1', name: 'Jo', status: 'active', limits: { voice: true, pictures: true } } as unknown as MemberRecord;
  for (const [m, parts] of [['PATCH', ['ssh', 'servers', 'x']], ['POST', ['ssh', 'servers', 'x', 'probe']], ['POST', ['ssh', 'servers', 'x', 'cpanel']], ['POST', ['ssh', 'servers', 'x', 'check']], ['POST', ['ssh', 'servers', 'x', 'replace-key']], ['POST', ['ssh', 'servers', 'x', 'cleanup']]] as const) assert.equal(memberRouteCheck(rec, m, [...parts])?.ownerOnly, true, parts.join('/'));
});

test('11. chat: a pasted cPanel token is redacted before storage; no tool schema has a token or password field', async () => {
  assert.equal(redactTypedPassword(`here is the cpanel token ${TOKEN} thanks`).text, 'here is the cpanel token [REDACTED] thanks');
  assert.equal(redactTypedPassword(`API token: ${TOKEN}`).text, 'API token: [REDACTED]');
  assert.equal(redactTypedPassword('the token is expired').changed, false);
  const app = setupApp(scratch());
  const conv = app.store.createConversation();
  app.script.push(text('I didn’t read it.'));
  for await (const _ of runTurn(app, conv.id, `connect my site, token ${TOKEN}`)) void _;
  assert.ok(!JSON.stringify(app.store.messages(conv.id)).includes(TOKEN));
  assert.ok(!JSON.stringify(app.requests).includes(TOKEN), 'not sent to the model');
  for (const t of createSshTools(() => app.ssh)) {
    const props = Object.entries((t.spec.parameters as { properties: Record<string, { type: string }> }).properties);
    for (const [k, p] of props) assert.ok(!/token|passphrase/i.test(k) && !(/password/i.test(k) && p.type === 'string'), `${t.spec.name}.${k}`);
  }
  void vaultKeyOf;
});

// ---------------------------------------------------------------------------------------------
// 13. The page
// ---------------------------------------------------------------------------------------------
test('13. the Connect page: two fields, the checklist, path cards, status under each button, ✕ not Close, no inline style', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const page = /<section class="settings-page" data-page="ab-ssh"[\s\S]*?<\/section>/.exec(html)![0];
  const form = /<div id="ssh-connect"[\s\S]*?<\/div>\s*<!-- \/ssh-connect -->/.exec(page)![0];
  const visible = [...form.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((i) => !/type="hidden"/.test(i));
  const notHiddenRow = visible.filter((i) => !/id="ssh-port"/.test(i));
  assert.equal(notHiddenRow.length, 2, 'address + user (the port row is hidden until asked)');
  for (const id of ['ssh-host', 'ssh-user', 'ssh-connect-go', 'ssh-connect-status', 'ssh-flow', 'ssh-checklist', 'ssh-hk', 'ssh-path-cpanel', 'ssh-path-pw', 'ssh-path-paste', 'ssh-path-key', 'ssh-notfound', 'ssh-token', 'ssh-cpanel-go', 'ssh-cpanel-status', 'ssh-pw-status', 'ssh-check-go', 'ssh-check-status']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(page, /style=/);
  assert.doesNotMatch(page, />\s*Close\s*</);
  assert.match(page, /<input id="ssh-token" type="password" autocomplete="off"/);
  assert.match(page, /Sara keeps only her own key/);
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(css, /\.ssh-step/);
  const js = readFileSync(join(ROOT, 'web', 'ssh.js'), 'utf8');
  assert.match(js, /diagBox/);
});

// PL2a (docs/design/POLISH2.md N7): a Connect that never reached the server leaves no row in Your
// servers; trying the same address again keeps one; Cancel removes it; one that reached SSH is listed.
test('14. a failed first connect leaves no server row; Cancel removes the draft; the step card has Cancel, not a second ✕', async () => {
  const fake = new FakeSsh();
  fake.badNames.add('nonexistent.invalid');
  const { m } = manager({ fake });
  const s = await m.connectServer({ address: 'nonexistent.invalid', user: 'alex' });
  assert.equal(s.probe?.code, 'DNS');
  assert.equal(m.views().length, 0, 'not listed under Your servers');
  assert.equal(m.view(m.get(s.id)).draft, true, 'the flow card still has it (Edit address, Try again)');
  const again = await m.connectServer({ address: 'nonexistent.invalid', user: 'alex' });
  assert.equal(m.list().length, 1, 'the earlier try went; no second draft');
  assert.notEqual(again.id, s.id);
  m.remove(again.id);
  assert.equal(m.list().length, 0);
  // One that reaches SSH is listed at once (Not connected yet · Remove), with no draft flag.
  const ok = await m.connectServer({ address: 'example.com', user: 'alex' });
  assert.deepEqual(m.views().map((v) => v.id), [ok.id]);
  assert.equal(m.get(ok.id).draft, undefined);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<button id="ssh-flow-close" type="button" class="ghost small" title="Done with this server for now">Cancel<\/button>/);
  assert.match(readFileSync(join(ROOT, 'web', 'ssh.js'), 'utf8'), /if \(s\?\.draft && !s\.ready && !s\.fingerprint && !s\.pendingFingerprint\) void api\(`\/ssh\/servers\/\$\{s\.id\}`, \{ method: 'DELETE'/);
});
