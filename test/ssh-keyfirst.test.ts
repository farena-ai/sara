// 3.4.1 (owner report: root@ on a cPanel server got the cPanel token path, and her key that an admin
// had already added went unnoticed): her own key is tried first and quietly; root (user root or uid 0
// seen later) never gets the cPanel token path; the paste path checks by itself every few seconds;
// a wrong-looking token offers "Add Sara's key yourself". Fake OpenSSH from test/ssh-fake.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { SshManager } from '../src/ssh.ts';
import { DIAG, type CpanelPeek } from '../src/ssh-easy.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { FakeSsh } from './ssh-fake.ts';

const closers: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of closers.reverse()) await c();
});
const scratch = () => {
  const t = tempDir();
  closers.push(t.cleanup);
  return t.dir;
};
const clock = { now: new Date('2026-11-11T15:00:00Z') };
const cpanelPeek = async (): Promise<CpanelPeek> => ({ reachable: true, cpanel: true, certOk: true, certNames: [] });
const TOKEN = 'Q7K2M9X4B8N3V6C1Z5L0P2R7T4W9Y3H8';

function manager(fake = new FakeSsh(), dir = scratch()) {
  const fetches: string[] = [];
  const m = new SshManager({
    dir, vault: new Vault(dir), run: fake.run, greet: fake.greet, lookup: fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => false,
    cpanel: { peek: cpanelPeek, fetch: (async (u: string) => (fetches.push(String(u)), new Response('{}', { status: 401 }))) as typeof fetch },
  });
  return { m, fake, fetches };
}
const trustPending = (m: SshManager, id: string) => m.trust(id, m.view(m.get(id)).pendingFingerprint!);

test('root never gets the cPanel token path: not recommended, refused before any request, WHM steps instead', async () => {
  const fake = new FakeSsh();
  fake.methods = ['publickey', 'gssapi-keyex', 'gssapi-with-mic'];
  const { m, fetches } = manager(fake);
  const s = await m.connectServer({ address: 'root@sara.example.com', user: '' });
  assert.equal(s.probe!.cpanel?.found, true, 'cPanel is there');
  assert.equal(s.probe!.recommended, 'paste', 'but root is not a cPanel account');
  assert.equal(m.view(m.get(s.id)).root, true);
  trustPending(m, s.id);
  await assert.rejects(m.installViaCpanel(s.id, TOKEN), (e: Error & { code?: string; diagnosis?: { actions: string[] } }) => e.code === 'ROOT_CPANEL' && e.diagnosis!.actions.includes('paste'));
  assert.equal(fetches.length, 0, 'the token went nowhere');
  assert.match(DIAG.ROOT_CPANEL.fix, /WHM: Security Center → Manage root’s SSH Keys → Import Key, then Authorize/);
  // A normal cPanel user still gets the token path.
  const f2 = new FakeSsh();
  f2.methods = ['publickey'];
  assert.equal((await manager(f2).m.connectServer({ address: 'alex@example.com', user: '' })).probe!.recommended, 'cpanel');
  // root with passwords allowed: the password once (it works for root), still never cPanel.
  const f3 = new FakeSsh();
  assert.equal((await manager(f3).m.connectServer({ address: 'root@example.com', user: '' })).probe!.recommended, 'password');
});

test('uid 0 seen later (a user that is root under another name) counts as root from then on', async () => {
  const fake = new FakeSsh();
  fake.methods = ['publickey'];
  fake.uid = 0;
  const { m } = manager(fake);
  const s = await m.connectServer({ address: 'toor@example.com', user: '' });
  assert.equal(s.probe!.recommended, 'cpanel', 'nothing tells root apart yet');
  trustPending(m, s.id);
  fake.authorized.push(m.get(s.id).key!.publicLine);
  const t = await m.test(s.id);
  assert.equal(t.ok, true);
  assert.equal(m.get(s.id).uid0, true);
  assert.equal(m.view(m.get(s.id)).root, true);
  assert.equal((await m.probe(s.id)).probe!.recommended, 'paste');
});

test('her key first: already on the server → Connected right after the ID card, no path needed; not there → nothing recorded', async () => {
  const fake = new FakeSsh();
  fake.methods = ['publickey'];
  const { m } = manager(fake);
  const s = await m.connectServer({ address: 'root@example.com', user: '' });
  // Not there yet: a quiet miss leaves no failed check, no error, no history.
  trustPending(m, s.id);
  const miss = await m.tryOwnKey(s.id);
  assert.equal(miss.ok, false);
  const after1 = m.get(s.id);
  assert.equal(after1.lastCheck, undefined);
  assert.equal(after1.lastError, undefined);
  assert.equal(after1.history, undefined);
  assert.equal(m.view(after1).ready, false);
  // An admin adds it (somewhere else): the next quiet try connects.
  fake.authorized.push(m.get(s.id).key!.publicLine);
  const hit = await m.tryOwnKey(s.id);
  assert.equal(hit.ok, true);
  assert.equal(m.view(m.get(s.id)).ready, true);
  assert.equal(m.get(s.id).connectedVia, 'paste');
  // Every try is BatchMode with her key and the strict options.
  const keyRuns = fake.sshCalls().filter((c) => c.args.includes('-i'));
  assert.ok(keyRuns.length >= 2);
  for (const c of keyRuns) for (const want of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no']) assert.ok(c.args.includes(want), want);
});

test('routes: trust tries her key and comes back Connected; a reprobe of a trusted server tries it too; try-key is quiet', async () => {
  const dir = scratch();
  const fake = new FakeSsh();
  fake.methods = ['publickey'];
  const app = makeApp(dir, clock);
  closers.push(() => app.store.close());
  app.ssh = new SshManager({ dir, vault: app.vault, run: fake.run, greet: fake.greet, lookup: fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => false, cpanel: { peek: cpanelPeek } });
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const made = await api('POST', '/ssh/servers', { address: 'root@example.com' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const v = made.json.server;
  assert.equal(v.root, true);
  assert.equal(v.probe.recommended, 'paste');
  fake.authorized.push(v.publicKey); // an admin added it before the owner got here
  const trusted = await api('POST', `/ssh/servers/${v.id}/trust`, { fingerprint: v.pendingFingerprint });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.json.server.ready, true, 'Connected straight away');
  assert.equal(trusted.json.tried.ok, true);
  // A second server: not there at trust, added later; try-key (the auto-check) connects without recording misses.
  const two = (await api('POST', '/ssh/servers', { address: 'deploy@example.org' })).json.server;
  const t2 = await api('POST', `/ssh/servers/${two.id}/trust`, { fingerprint: two.pendingFingerprint });
  assert.equal(t2.json.server.ready, false);
  const quiet = await api('POST', `/ssh/servers/${two.id}/try-key`, {});
  assert.equal(quiet.status, 200);
  assert.equal(quiet.json.ok, false);
  assert.equal(quiet.json.server.lastCheck, undefined);
  fake.authorized.push(two.publicKey);
  const re = await api('POST', `/ssh/servers/${two.id}/probe`, {});
  assert.equal(re.json.server.ready, true, 'reopening / looking again tries her key');
});

test('page: key-first on open, auto-check on the paste path (stops after a few minutes), one recommended box, token hint offers paste, root hides cPanel', () => {
  const js = readFileSync(join(ROOT, 'web', 'ssh.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(js, /\/try-key`/);
  assert.match(js, /const AUTO_CHECK_MS = \d{4,5};/);
  assert.match(js, /const AUTO_CHECK_FOR_MS = [2-9] \* 60_000;/);
  assert.match(js, /function startAutoCheck\(/);
  assert.match(js, /function stopAutoCheck\(/);
  assert.match(js, /visibilitychange/);
  // Root: no cPanel token path, the WHM steps.
  assert.match(js, /s\.root/);
  assert.match(js, /show\('#ssh-other-cpanel', which !== 'cpanel' && !s\.root\)/);
  assert.match(js, /whm: \(\) => \[/);
  assert.match(html, /<option value="whm">/);
  // The recommended box and a short "Other ways" list.
  assert.match(html, /<ul id="ssh-other" class="ssh-other small"/);
  assert.match(js, /classList\.toggle\('ssh-rec'/);
  assert.match(readFileSync(join(ROOT, 'web', 'style.css'), 'utf8'), /\.ssh-rec\b/);
  assert.ok(DIAG.BAD_TOKEN.actions.includes('paste'), 'a wrong-looking token offers Add Sara’s key yourself');
});
