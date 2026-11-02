// Phase 73: work on the owner's other servers over SSH. A fake OpenSSH (ssh, ssh-keygen,
// ssh-keyscan) is injected as the command runner and plays a server with a host key, a password
// and an authorized_keys file. Covered: argument arrays with the safe options, trust on first use
// and a changed host key, the one-time password (never in argv, env, logs, stored messages or the
// vault unless confirmed), her own key (0600, announced with its path), revoking exactly her line,
// the "ask first" rules, and who can't reach any of it (demo, members, private local mode, other
// apps, MCP, the OpenAI-compatible API). The remote install/revoke scripts also run for real
// under a POSIX shell when one is on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { memberRouteCheck, MEMBER_ROUTES, type MemberRecord } from '../src/household.ts';
import { describeTools } from '../src/mcp-server.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { checkClaims } from '../src/receipts.ts';
import { createSaraServer } from '../src/server.ts';
import { installScript, keyComment, redactTypedPassword, revokeScript, spawnRunner, SshManager, vaultKeyOf } from '../src/ssh.ts';
import { createSshTools, isRiskyCommand } from '../src/tools/ssh.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';
// 2.52.1: the fake OpenSSH moved to test/ssh-fake.ts (shared with test/ssh-easy.test.ts).
import { FakeSsh, fpOf, HOSTKEY_A, HOSTKEY_B, PASSWORD, pem } from './ssh-fake.ts';

const closers: (() => void)[] = [];
after(() => {
  setPrivateLocal(false);
  for (const c of closers.reverse()) c();
});
function scratch(): string {
  const t = tempDir();
  closers.push(t.cleanup);
  return t.dir;
}
const clock = { now: new Date('2026-10-29T15:00:00Z') };
function manager(dir = scratch(), fake = new FakeSsh(), extra: Partial<ConstructorParameters<typeof SshManager>[0]> = {}) {
  const vault = new Vault(dir);
  const m = new SshManager({ dir, vault, run: fake.run, greet: fake.greet, lookup: fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => false, ...extra });
  return { m, fake, vault, dir };
}

async function readyServer(o = manager()) {
  const s = await o.m.add({ name: 'web box', host: '127.0.0.1', port: 2222, user: 'deploy' });
  o.m.trust(s.id, o.m.view(o.m.get(s.id)).pendingFingerprint!);
  return { ...o, id: s.id };
}

// ---------------------------------------------------------------------------------------------
// The ssh command line
// ---------------------------------------------------------------------------------------------

test('every ssh call is an argument array with the safe options; the command is one argument after the host', async () => {
  const o = await readyServer();
  const r = await o.m.loginWithPassword(o.id, PASSWORD);
  assert.ok(r.keyPath);
  await o.m.exec(o.id, 'df -h; echo "$(id)" && rm notes.txt');
  const calls = o.fake.sshCalls();
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    const a = c.args;
    for (const want of ['StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ControlMaster=no', 'ControlPath=none', 'PermitLocalCommand=no', 'IdentityAgent=none', 'UpdateHostKeys=no']) assert.ok(a.includes(want), `${want} in ${a.join(' ')}`);
    assert.ok(a.includes(`UserKnownHostsFile=${o.m.knownHostsFile(o.id)}`));
    assert.ok(a.includes(`HostKeyAlias=sara-${o.id}`));
    assert.ok(a.includes('HostKeyAlgorithms=ssh-ed25519'), 'only the approved key type');
    assert.deepEqual(a.slice(0, 2), ['-F', 'none'], "the owner's ~/.ssh/config is ignored");
    assert.ok(a.some((x) => x.startsWith('ConnectTimeout=')) && a.some((x) => x.startsWith('ServerAliveInterval=')));
    const dd = a.indexOf('--');
    assert.equal(a[dd + 1], '127.0.0.1');
    assert.equal(a.length, dd + 3, 'exactly one remote command argument after the host');
    assert.ok(!a.some((x) => x.includes(PASSWORD)), 'never the password on the command line');
    assert.equal(c.env.SSH_AUTH_SOCK, undefined, 'no agent');
  }
  const key = calls.at(-1)!;
  assert.equal(key.args.at(-1), 'df -h; echo "$(id)" && rm notes.txt');
  assert.ok(key.args.includes('BatchMode=yes') && key.args.includes('PasswordAuthentication=no') && key.args.includes('-i'));
  // The first sign-in is the only one with a password, and it can't fall back to a key or agent.
  assert.ok(calls[0].args.includes('PubkeyAuthentication=no') && calls[0].args.includes('IdentityFile=none') && calls[0].args.includes('NumberOfPasswordPrompts=1'));
});

test('the real runner never uses a shell: metacharacters stay literal', async () => {
  const dir = scratch();
  const marker = join(dir, 'pwned');
  const script = join(dir, 'echo.cjs');
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const evil = `$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')") ; touch ${marker} | & > x`;
  const r = await spawnRunner(process.execPath, [script, evil, 'two'], { env: { PATH: process.env.PATH ?? '' , SystemRoot: process.env.SystemRoot ?? '' }, timeoutMs: 20_000 });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [evil, 'two']);
  assert.equal(existsSync(marker), false);
});

// ---------------------------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------------------------

test('host key: read first, shown as SHA256 for approval; nothing runs before trust; a wrong fingerprint is refused', async () => {
  const o = manager();
  const s = await o.m.add({ name: 'nas', host: 'nas.example.test', user: 'alex' });
  const v = o.m.view(o.m.get(s.id));
  assert.equal(v.pendingFingerprint, fpOf(HOSTKEY_A), 'ed25519 picked over rsa');
  assert.equal(v.fingerprint, undefined);
  assert.equal(v.hostKeyChanged, false);
  await assert.rejects(o.m.exec(s.id, 'uptime'), /Approve the host key/);
  await assert.rejects(o.m.loginWithPassword(s.id, PASSWORD), /Approve this server’s host key/);
  assert.equal(o.fake.sshCalls().length, 0, 'ssh never ran');
  assert.throws(() => o.m.trust(s.id, 'SHA256:somethingElse'), /doesn’t match/);
  o.m.trust(s.id, v.pendingFingerprint!);
  assert.equal(readFileSync(o.m.knownHostsFile(s.id), 'utf8'), `sara-${s.id} ssh-ed25519 ${HOSTKEY_A}\n`);
  assert.equal(o.m.view(o.m.get(s.id)).fingerprint, fpOf(HOSTKEY_A));
});

test('a changed host key stops her: nothing runs, the new fingerprint waits for the owner, and only an explicit trust continues', async () => {
  const o = await readyServer();
  await o.m.loginWithPassword(o.id, PASSWORD);
  o.fake.hostKey = HOSTKEY_B; // the server (or someone in between) now shows another key
  const before = o.fake.remoteCommands.length;
  await assert.rejects(o.m.exec(o.id, 'cat /etc/hostname'), (e: Error & { code?: string }) => e.code === 'HOSTKEY_CHANGED' && /not the one you approved/.test(e.message));
  const v = o.m.view(o.m.get(o.id));
  assert.equal(v.fingerprint, fpOf(HOSTKEY_A), 'the approved key is kept');
  assert.equal(v.pendingFingerprint, fpOf(HOSTKEY_B));
  assert.equal(v.hostKeyChanged, true);
  const sshBefore = o.fake.sshCalls().length;
  await assert.rejects(o.m.exec(o.id, 'uptime'), /changed since you approved it/);
  assert.equal(o.fake.sshCalls().length, sshBefore, 'refused before ssh even starts');
  assert.equal(o.fake.remoteCommands.length, before, 'no command reached the server');
  // Through the tool, too.
  const run = createSshTools(() => o.m).find((t) => t.spec.name === 'ssh_run')!;
  await assert.rejects(run.run({ server: 'web box', command: 'uptime' }, {} as never), /changed/);
  o.m.trust(o.id, fpOf(HOSTKEY_B));
  assert.equal((await o.m.exec(o.id, 'uptime')).code, 0);
});

// ---------------------------------------------------------------------------------------------
// The password and her own key
// ---------------------------------------------------------------------------------------------

test('password sign-in: she makes her own key (0600), installs it, announces the path, and does NOT keep the password', async () => {
  const o = await readyServer();
  const r = await o.m.loginWithPassword(o.id, PASSWORD);
  const keyPath = join(o.dir, 'ssh', 'keys', `${o.id}_ed25519`);
  assert.equal(r.keyPath, keyPath);
  assert.ok(existsSync(keyPath) && existsSync(`${keyPath}.pub`));
  if (process.platform !== 'win32') assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.match(r.publicLine, / sara@home-20261029$/, 'comment sara@<instance>-<date>');
  assert.equal(keyComment('home', clock.now), 'sara@home-20261029');
  assert.ok(o.fake.authorized.includes(r.publicLine), 'installed on the server');
  assert.equal(o.fake.authorized.length, 2, "the owner's own key line is untouched");
  assert.equal(r.passwordSaved, false);
  assert.match(r.announcement, new RegExp(`made my own SSH key for web box`));
  assert.ok(r.announcement.includes(keyPath) && r.announcement.includes(r.publicLine));
  assert.match(r.announcement, /use the key from now on/);
  assert.match(r.announcement, /did NOT keep the password/);
  // The password reached ssh only through the askpass helper, which is gone now.
  assert.deepEqual(o.fake.passwordsSeen, [PASSWORD]);
  assert.deepEqual(readdirSync(join(o.dir, 'ssh', 'tmp')), [], 'helper folder deleted');
  for (const c of o.fake.calls) assert.ok(!Object.values(c.env).some((v) => v.includes(PASSWORD)), `not in the environment of ${c.cmd}`);
  // Not in the vault, not in any file in her data folder.
  assert.equal(o.vault.has(vaultKeyOf(o.id)), false);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(o.dir)) assert.ok(!readFileSync(f).includes(Buffer.from(PASSWORD)), `password in ${f}`);
  // From now on: the key, no password.
  const n = o.fake.passwordsSeen.length;
  const out = await o.m.exec(o.id, 'uptime');
  assert.equal(out.code, 0);
  assert.equal(o.fake.passwordsSeen.length, n);
  assert.ok(o.fake.sshCalls().at(-1)!.args.includes(keyPath));
  // Twice: no duplicate line on the server.
  await o.m.loginWithPassword(o.id, PASSWORD);
  assert.equal(o.fake.authorized.filter((l) => / sara@home-/.test(l)).length, 1);
});

// 2.52.1 (SSH_EASY §2.2 step 6, "made once"): a failed try keeps her key (not installed), so the
// next try installs the same line; before, a wrong password deleted the fresh key each time.
test('a wrong password: nothing kept, her key kept but not installed, the password never in the error', async () => {
  const o = await readyServer();
  await assert.rejects(o.m.loginWithPassword(o.id, 'Wr0ng-Password!'), (e: Error & { code?: string }) => e.code === 'WRONG_PASSWORD' && !e.message.includes('Wr0ng'));
  assert.equal(o.m.get(o.id).key?.installedAt, undefined);
  assert.equal(o.m.view(o.m.get(o.id)).ready, false);
  assert.equal(existsSync(o.m.keyFile(o.id)), true, 'made once, kept');
  assert.equal(o.fake.authorized.length, 1, 'nothing installed');
  assert.equal(o.vault.has(vaultKeyOf(o.id)), false);
});

test('the password is saved only with Save AND the confirmed warning; encrypted; forgotten with one call', async () => {
  const o = await readyServer();
  await assert.rejects(o.m.loginWithPassword(o.id, PASSWORD, { savePassword: true }), /confirm that you understand the risk/);
  assert.equal(o.fake.passwordsSeen.length, 0, 'refused before signing in');
  const r = await o.m.loginWithPassword(o.id, PASSWORD, { savePassword: true, confirmRisk: true });
  assert.equal(r.passwordSaved, true);
  assert.match(r.announcement, /You asked me to keep the password, so it is saved encrypted/);
  assert.equal(o.vault.get(vaultKeyOf(o.id)), PASSWORD);
  assert.equal(new Vault(o.dir).get(vaultKeyOf(o.id)), PASSWORD, 'survives a restart');
  assert.ok(!readFileSync(join(o.dir, 'secrets.enc')).includes(Buffer.from(PASSWORD)), 'encrypted on disk');
  assert.ok(!readFileSync(join(o.dir, 'ssh', 'servers.json'), 'utf8').includes(PASSWORD));
  assert.equal(o.m.view(o.m.get(o.id)).passwordSaved, true);
  o.m.forgetPassword(o.id);
  assert.equal(o.vault.has(vaultKeyOf(o.id)), false);
  assert.equal(o.m.view(o.m.get(o.id)).passwordSaved, false);
});

// ---------------------------------------------------------------------------------------------
// Revoking and removing
// ---------------------------------------------------------------------------------------------

test('revoke removes exactly her line from authorized_keys, then the key files here', async () => {
  const o = await readyServer();
  const r = await o.m.loginWithPassword(o.id, PASSWORD);
  // A look-alike line (same key type, another comment) must survive.
  o.fake.authorized.push(`${r.publicLine.split(' ').slice(0, 2).join(' ')} someone-else`);
  const others = o.fake.authorized.filter((l) => l !== r.publicLine);
  const v = await o.m.revokeKey(o.id);
  assert.equal(v.removedFromServer, true);
  assert.match(v.message, /Removed my key from ~\/.ssh\/authorized_keys on web box/);
  assert.deepEqual(o.fake.authorized, others);
  assert.equal(existsSync(r.keyPath), false);
  assert.equal(existsSync(`${r.keyPath}.pub`), false);
  assert.equal(o.m.get(o.id).key, undefined);
  assert.ok(o.fake.remoteCommands.at(-1)!.includes(`grep -vxF '${r.publicLine}'`));
  await assert.rejects(o.m.exec(o.id, 'uptime'), /no key/);
  // Remove: host key, key and saved password all gone.
  await o.m.loginWithPassword(o.id, PASSWORD, { savePassword: true, confirmRisk: true });
  o.m.remove(o.id);
  assert.equal(o.m.list().length, 0);
  assert.equal(o.vault.has(vaultKeyOf(o.id)), false);
  assert.equal(existsSync(o.m.knownHostsFile(o.id)), false);
});

test('the remote scripts: no duplicates, 700/600, a missing last newline, exact-line removal; odd characters refused', () => {
  const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc sara@home-20261029';
  const ins = installScript(line);
  assert.match(ins, /grep -qxF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc sara@home-20261029'/);
  assert.match(ins, /chmod 700 "\$d"/);
  assert.match(ins, /chmod 600 "\$f"/);
  assert.match(ins, /tail -c 1/);
  const rev = revokeScript(line);
  assert.match(rev, /grep -vxF '/);
  assert.match(rev, /cat "\$t" > "\$f"/, 'rewrites in place (keeps owner and permissions)');
  for (const bad of ["ssh-ed25519 AAAA x'; rm -rf ~; '", 'ssh-ed25519 AAAA $(id)', 'ssh-ed25519 AAAA a\nb', 'ssh-dss AAAA x']) assert.throws(() => installScript(bad), /unexpected characters/);
});

// The same scripts in a real POSIX shell (Linux/macOS /bin/sh, or Git Bash on Windows).
const SH = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'].find((p) => existsSync(p)) : existsSync('/bin/sh') ? '/bin/sh' : undefined;
test('the remote scripts in a real shell', { skip: !SH && 'no POSIX shell here' }, () => {
  const home = scratch();
  const env = { ...process.env, HOME: home };
  const run = (script: string) => spawnSync(SH!, ['-c', script], { env, encoding: 'utf8' });
  const mine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrealShellTest sara@home-20261029';
  mkdirSync(join(home, '.ssh'));
  const ak = join(home, '.ssh', 'authorized_keys');
  writeFileSync(ak, 'ssh-ed25519 AAAAowner alex@laptop'); // no newline at the end
  assert.match(run(installScript(mine)).stdout, /sara-key-added/);
  assert.match(run(installScript(mine)).stdout, /sara-key-present/);
  assert.equal(readFileSync(ak, 'utf8'), `ssh-ed25519 AAAAowner alex@laptop\n${mine}\n`);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
    assert.equal(statSync(ak).mode & 0o777, 0o600);
  }
  writeFileSync(ak, `${readFileSync(ak, 'utf8')}${mine} extra\n`);
  assert.match(run(revokeScript(mine)).stdout, /sara-key-removed/);
  assert.equal(readFileSync(ak, 'utf8'), `ssh-ed25519 AAAAowner alex@laptop\n${mine} extra\n`, 'only the exact line went');
  assert.match(run(revokeScript(mine)).stdout, /sara-key-gone/);
  // A fresh home (no ~/.ssh yet).
  const home2 = scratch();
  assert.match(spawnSync(SH!, ['-c', installScript(mine)], { env: { ...process.env, HOME: home2 }, encoding: 'utf8' }).stdout, /sara-key-added/);
  assert.equal(readFileSync(join(home2, '.ssh', 'authorized_keys'), 'utf8'), `${mine}\n`);
});

test('a key the owner gives her: checked, copied 0600, used; revoking only deletes her copy', async () => {
  const o = await readyServer();
  const file = join(o.dir, 'given_key');
  writeFileSync(file, pem('abc', true));
  o.fake.authorized.push('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIImportedKey00000000000000000000000000000');
  await assert.rejects(o.m.importKey(o.id, { keyPath: 'relative/key' }), /full path/);
  await assert.rejects(o.m.importKey(o.id, { privateKey: 'not a key' }), /doesn’t look like an SSH private key/);
  await assert.rejects(o.m.importKey(o.id, { privateKey: pem('ENCRYPTED') }), /passphrase/);
  const s = await o.m.importKey(o.id, { keyPath: file });
  assert.equal(s.key?.source, 'imported');
  if (process.platform !== 'win32') assert.equal(statSync(s.key!.path).mode & 0o777, 0o600);
  assert.equal((await o.m.exec(o.id, 'uptime')).code, 0);
  const before = o.fake.authorized.length;
  const r = await o.m.revokeKey(o.id);
  assert.equal(r.removedFromServer, false);
  assert.match(r.message, /still on the server/);
  assert.equal(o.fake.authorized.length, before);
});

// ---------------------------------------------------------------------------------------------
// A password typed into the chat
// ---------------------------------------------------------------------------------------------

test('a password typed in the chat is redacted before it is stored or sent; ordinary sentences stay', async () => {
  assert.equal(redactTypedPassword('the password for web box is Hunter2!x, thanks').text, 'the password for web box is [REDACTED], thanks');
  assert.equal(redactTypedPassword('ssh password: "s3cret-Pa55"').text, 'ssh password: "[REDACTED]"');
  assert.equal(redactTypedPassword('mi contraseña es Gato#2024').text, 'mi contraseña es [REDACTED]');
  for (const ok of ['the password is too long', 'I forgot my password again', 'what password should I use?', 'pass the salt please']) assert.equal(redactTypedPassword(ok).changed, false, ok);
  const app = setupApp(scratch());
  const conv = app.store.createConversation();
  app.script.push(text('I removed it.'));
  for await (const _ of runTurn(app, conv.id, 'log in to web box, the password is Tr0ub4dor&3')) void _;
  const stored = app.store.messages(conv.id).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  assert.ok(!stored.includes('Tr0ub4dor&3') && stored.includes('[REDACTED]'));
  assert.ok(!JSON.stringify(app.requests).includes('Tr0ub4dor&3'), 'not sent to the model');
});

// ---------------------------------------------------------------------------------------------
// Approvals and who can use it
// ---------------------------------------------------------------------------------------------

function setupApp(dir: string, withSsh = true): TestApp & { fake: FakeSsh } {
  const app = makeApp(dir, clock) as TestApp & { fake: FakeSsh };
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  closers.push(() => app.store.close());
  app.fake = new FakeSsh();
  if (withSsh) {
    app.ssh = new SshManager({ dir, vault: app.vault, run: app.fake.run, greet: app.fake.greet, lookup: app.fake.lookup, now: () => clock.now, instance: 'home', platform: 'linux', privateLocal: () => false });
    for (const t of createSshTools(() => app.ssh)) app.tools.add(t);
  }
  return app;
}

async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Extract<ChatEvent, { type: 'approval' }>) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}

test('ssh_run asks first by default; with "auto" chosen, risky commands still ask', async () => {
  const app = setupApp(scratch());
  assert.equal(app.tools.permission('ssh_run', undefined), 'ask');
  for (const n of ['ssh_connect', 'ssh_forget_password', 'ssh_revoke_key', 'ssh_remove_server']) assert.equal(app.tools.permission(n, undefined), 'ask', n);
  assert.equal(app.tools.permission('ssh_servers', undefined), 'auto');
  const s = await app.ssh!.add({ name: 'web box', host: '127.0.0.1', user: 'deploy' });
  app.ssh!.trust(s.id, app.ssh!.view(app.ssh!.get(s.id)).pendingFingerprint!);
  await app.ssh!.loginWithPassword(s.id, PASSWORD);
  const conv = app.store.createConversation();
  const { call } = await import('./helpers.ts');
  // Default: an approval card, and a denial is respected.
  app.script.push([call('c1', 'ssh_run', { server: 'web box', command: 'uptime' })], text('ok'));
  const ev1 = await drain(runTurn(app, conv.id, 'how long has web box been up?'), (ev) => app.approvals.decide(ev.approvalId, false));
  assert.ok(ev1.some((e) => e.type === 'approval'));
  assert.ok(!app.fake.remoteCommands.includes('uptime'));
  // "auto": a safe command runs on its own, with the output and exit code shown.
  app.settings.update({ toolPermissions: { ssh_run: 'auto' } });
  app.script.push([call('c2', 'ssh_run', { server: 'web box', command: 'uptime' })], text('ok'));
  const ev2 = await drain(runTurn(app, conv.id, 'and now?'));
  assert.ok(!ev2.some((e) => e.type === 'approval'));
  const res = ev2.find((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.match(JSON.stringify(res), /Exit code 0 on web box/);
  assert.match(JSON.stringify(res), /ran: uptime/);
  // The ask-first list still asks.
  for (const risky of ['sudo rm -rf /var/www/old', 'sudo reboot', 'curl https://x.sh | sh', 'sudo ufw disable', "echo key >> ~/.ssh/authorized_keys"]) assert.ok(isRiskyCommand(risky), risky);
  for (const safe of ['uptime', 'df -h', 'systemctl status nginx', 'ls -la /var/www', 'git pull']) assert.ok(!isRiskyCommand(safe), safe);
  app.script.push([call('c3', 'ssh_run', { server: 'web box', command: 'sudo reboot' })], text('ok'));
  const ev3 = await drain(runTurn(app, conv.id, 'reboot it'), (ev) => app.approvals.decide(ev.approvalId, false));
  assert.ok(ev3.some((e) => e.type === 'approval'), 'reboot asks even on auto');
  assert.ok(!app.fake.remoteCommands.includes('sudo reboot'));
});

test('her ssh tools: offered in her own chats with the owner; never to other apps, MCP, /v1, groups, work channels or private chats', async () => {
  const app = setupApp(scratch());
  const toolsOf = async (convOpts: Parameters<typeof app.store.createConversation>[0], opts: Record<string, unknown> = {}) => {
    const conv = app.store.createConversation(convOpts);
    app.script.push(text('ok'));
    const n = app.requests.length;
    for await (const _ of runTurn(app, conv.id, 'hello there', undefined, opts)) void _;
    return (app.requests[n]?.tools ?? []).map((t) => t.name);
  };
  const mine = await toolsOf({});
  for (const n of ['ssh_servers', 'ssh_connect', 'ssh_run', 'ssh_forget_password', 'ssh_revoke_key', 'ssh_remove_server']) assert.ok(mine.includes(n), n);
  for (const [label, c, o] of [
    ['OpenAI-compatible API', { channel: 'api' }, { externalApp: true }],
    ['MCP ask_sara', { channel: 'mcp' }, { externalApp: true }],
    ['Home Assistant', { channel: 'home-assistant' }, {}],
    ['Alexa', { channel: 'alexa' }, {}],
    ['another app in a web chat', {}, { externalApp: true }],
    ['private chat', { private: true }, {}],
  ] as const) {
    const names = await toolsOf(c as never, o as never);
    assert.ok(!names.some((n) => n.startsWith('ssh_')), `${label}: ${names.filter((n) => n.startsWith('ssh_')).join(',')}`);
  }
  // The MCP server's own tool list has nothing of it.
  assert.ok(!/ssh_|"name":"ssh/.test(JSON.stringify(describeTools())));
});

test('private local mode: only servers on this computer', async () => {
  const o = manager(scratch(), new FakeSsh(), { privateLocal: () => true });
  await assert.rejects(o.m.add({ host: 'server.example.com', user: 'deploy' }), (e: Error & { code?: string }) => e.code === 'PRIVATE_LOCAL');
  await assert.rejects(o.m.add({ host: '192.168.1.20', user: 'deploy' }), /Blocked by private local mode/);
  assert.equal(o.fake.calls.length, 0, 'not even a host key scan');
  const s = await o.m.add({ host: '127.0.0.1', user: 'deploy' });
  assert.ok(o.m.view(s).pendingFingerprint);
});

// ---------------------------------------------------------------------------------------------
// The settings routes: owner only, never the demo or household members
// ---------------------------------------------------------------------------------------------

const ownerDir = scratch();
const owner = setupApp(ownerDir);
const auth = new OwnerAuth(ownerDir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') });
const demoDir = scratch();
const demoApp = setupApp(demoDir, false);
const demo = createSaraServer({ app: demoApp, auth: new OwnerAuth(demoDir, () => clock.now), webDir: join(ROOT, 'web'), demo: true });
let base = '';
let demoBase = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  demoBase = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  demo.close();
});
const api = async (method: string, path: string, body?: unknown, b = base) => {
  const r = await fetch(`${b}/api${path}`, { method, headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', origin: b }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, raw: r };
};

test('Settings routes: add → approve the fingerprint → sign in once; she says it in the chat; the password is nowhere', async () => {
  const conv = owner.store.createConversation();
  // She added it from this conversation (ssh_connect), so she tells the owner there.
  const tool = createSshTools(() => owner.ssh).find((t) => t.spec.name === 'ssh_connect')!;
  const said = await tool.run({ name: 'web box', host: '127.0.0.1', user: 'deploy', auth: 'password' }, { conversationId: conv.id } as never);
  assert.match(said, /fingerprint is SHA256:/);
  assert.match(said, /never in chat/);
  assert.match(said, /\/#view=settings:ab-ssh/);
  const list = await api('GET', '/ssh');
  assert.equal(list.status, 200);
  const srv = list.json.servers[0];
  assert.ok(srv.pendingFingerprint);
  assert.equal((await api('POST', `/ssh/servers/${srv.id}/login`, { password: PASSWORD })).status, 400, 'no sign-in before the host key is trusted');
  assert.equal((await api('POST', `/ssh/servers/${srv.id}/trust`, { fingerprint: 'SHA256:wrong' })).status, 400);
  assert.equal((await api('POST', `/ssh/servers/${srv.id}/trust`, { fingerprint: srv.pendingFingerprint })).status, 200);
  const login = await api('POST', `/ssh/servers/${srv.id}/login`, { password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const body = JSON.stringify(login.json);
  assert.ok(!body.includes(PASSWORD), 'never sent back');
  assert.equal(login.json.server.passwordSaved, false);
  assert.match(login.json.announcement, /did NOT keep the password/);
  const msgs = owner.store.messages(conv.id);
  const hers = msgs.filter((m) => m.role === 'assistant').at(-1)!;
  assert.match(hers.content, /I made my own SSH key for web box/);
  assert.ok(hers.content.includes(login.json.server.keyPath));
  assert.match(hers.content, /I did not keep your password/);
  assert.ok(!JSON.stringify(msgs).includes(PASSWORD));
  // Save needs the confirmation.
  assert.equal((await api('POST', `/ssh/servers/${srv.id}/login`, { password: PASSWORD, savePassword: true })).status, 400);
  const saved = await api('POST', `/ssh/servers/${srv.id}/login`, { password: PASSWORD, savePassword: true, confirmRisk: true });
  assert.equal(saved.json.server.passwordSaved, true);
  assert.equal((await api('DELETE', `/ssh/servers/${srv.id}/password`)).json.server.passwordSaved, false);
  const rv = await api('POST', `/ssh/servers/${srv.id}/revoke`, {});
  assert.equal(rv.json.removedFromServer, true);
  assert.equal((await api('DELETE', `/ssh/servers/${srv.id}`, {})).status, 200);
  assert.deepEqual((await api('GET', '/ssh')).json.servers, []);
});

test('the demo and household members get nothing of it', async () => {
  // A demo visitor (signed in the demo way) is refused.
  const start = await fetch(`${demoBase}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(start.status, 200);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const visit = (method: string, path: string, body?: unknown) => fetch(`${demoBase}/api${path}`, { method, headers: { cookie, origin: demoBase, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await visit('GET', '/ssh')).status, 403);
  assert.equal((await visit('POST', '/ssh/servers', { host: '127.0.0.1', user: 'x' })).status, 403);
  assert.equal(demoApp.tools.list().some((t) => t.spec.name.startsWith('ssh_')), false);
  assert.equal(MEMBER_ROUTES.has('ssh'), false);
  const rec = { id: 'm1', name: 'Jo', status: 'active', limits: { voice: true, pictures: true } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(rec, 'GET', ['ssh'])?.ownerOnly, true);
  // main.ts: the manager exists only outside the demo, and members' spaces get no ssh tools.
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(main, /const sshManager = isDemo \? undefined : new SshManager/);
  assert.match(main, /isMember \? new ToolRegistry\(\[\]\)/);
  assert.match(main, /isMember \|\| !sshManager \? \{\} : \{ ssh: sshManager \}/);
});

test('the settings page: password box, save checkbox with the warning, every string translatable', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const page = /<section class="settings-page" data-page="ab-ssh"[\s\S]*?<\/section>/.exec(html)![0];
  assert.match(page, /<input id="ssh-pw" type="password" autocomplete="off"/);
  assert.match(page, /id="ssh-save-pw" type="checkbox"/);
  assert.match(page, /id="ssh-confirm-risk" type="checkbox"/);
  assert.match(page, /data-owner-only/);
  assert.doesNotMatch(page, /style=/);
  const tipsFile = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')) as { tips: Record<string, [string, string]>; pages: Record<string, [string, string]> };
  assert.equal(tipsFile.pages['ab-ssh']?.[1], 'ssh');
  const tips = tipsFile.tips;
  for (const id of ['ssh-host', 'ssh-user', 'ssh-pw', 'ssh-save-pw', 'ssh-confirm-risk', 'ssh-key-text', 'ssh-key-path']) assert.equal(tips[id]?.[1], 'ssh', id);
  assert.match(readFileSync(join(ROOT, 'web', 'help.html'), 'utf8'), /<h2 id="ssh">/);
});

test('her claims about server work are backed by the ssh tools (and only by them)', () => {
  const ran = [{ name: 'ssh_run', status: 'ok' as const, args: { server: 'web box', command: 'systemctl restart nginx' }, output: 'Exit code 0 on web box.' }];
  assert.deepEqual(checkClaims("I've restarted it and I ran the check on web box.", ran), []);
  const added = [{ name: 'ssh_connect', status: 'ok' as const, args: { host: '127.0.0.1', user: 'deploy' }, output: 'Added web box.' }];
  assert.deepEqual(checkClaims("I've added the web box to my list!", added), []);
  assert.ok(checkClaims("I've added the web box to my list!", []).length > 0, 'without the tool it is still flagged');
  const listed = [{ name: 'ssh_servers', status: 'ok' as const, args: {}, output: '- web box' }];
  assert.ok(checkClaims('I ran the backup on web box.', listed).length > 0, 'listing servers backs no command');
  const denied = [{ ...ran[0], status: 'denied' as const }];
  assert.ok(checkClaims('I ran the backup on web box.', denied).length > 0);
});
