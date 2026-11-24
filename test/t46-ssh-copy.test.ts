// T46 (C29): one file up to a server and down from it. A fake `scp` sits in front of the fake
// OpenSSH from test/ssh-fake.ts: it checks the host key and her key the way the real one would and
// copies between a real local file and a pretend server disk. No real server, no network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanRemotePath, MAX_COPY_BYTES, SshManager, type CommandRunner, type RunOptions } from '../src/ssh.ts';
import { toolEffect } from '../src/tools/effects.ts';
import { createSshTools, isRiskyRemotePath, isSshTool } from '../src/tools/ssh.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';
import { FakeSsh, fpOf, HOSTKEY_A, HOSTKEY_B, PASSWORD } from './ssh-fake.ts';

const closers: (() => void)[] = [];
after(() => {
  for (const c of closers.reverse()) c();
});
function scratch(): string {
  const t = tempDir();
  closers.push(t.cleanup);
  return t.dir;
}

/** The pretend server's disk and a fake scp in front of the fake ssh. */
class FakeScp {
  readonly fake = new FakeSsh();
  disk = new Map<string, Buffer>();
  scpCalls: { args: string[]; env: Record<string, string> }[] = [];
  /** What `wc -c` says, when the server lies about a size. */
  sizeLie?: number;

  run: CommandRunner = async (cmd: string, args: string[], opts: RunOptions) => {
    if (cmd === 'scp') return this.#scp(args, opts);
    const r = await this.fake.run(cmd, args, opts);
    // The size check before a download (the fake shell echoes commands it does not know).
    const m = /^ran: wc -c < (.+)\n$/.exec(r.stdout);
    if (cmd === 'ssh' && m) {
      const f = this.disk.get(m[1]);
      return f ? { code: 0, stdout: `  ${this.sizeLie ?? f.length}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `sh: ${m[1]}: No such file or directory` };
    }
    return r;
  };

  #scp(args: string[], opts: RunOptions) {
    this.scpCalls.push({ args: [...args], env: { ...opts.env } });
    const opt = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    const known = existsSync(opt('UserKnownHostsFile')!) ? readFileSync(opt('UserKnownHostsFile')!, 'utf8') : '';
    if (!known.split('\n').some((l) => l.startsWith(`${opt('HostKeyAlias')} `) && l.includes(this.fake.hostKey))) {
      return { code: 255, stdout: '', stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.' };
    }
    const i = args.indexOf('-i');
    if (i >= 0) {
      const pub = readFileSync(`${args[i + 1]}.pub`, 'utf8').trim();
      if (!this.fake.authorized.includes(pub)) return { code: 255, stdout: '', stderr: 'user@host: Permission denied (publickey).' };
    } else {
      const script = readFileSync(opts.env.SSH_ASKPASS, 'utf8');
      const given = readFileSync(/["']([^"']+[\\/]p)["']/.exec(script)![1], 'utf8');
      if (given !== this.fake.password) return { code: 255, stdout: '', stderr: 'user@host: Permission denied (password).' };
    }
    const [from, to] = args.slice(args.indexOf('--') + 1);
    const remote = (x: string) => /^[^@/\\]+@[^:]+:(.+)$/.exec(x)?.[1];
    if (remote(to)) {
      this.disk.set(remote(to)!, readFileSync(from));
      return { code: 0, stdout: '', stderr: '' };
    }
    const f = this.disk.get(remote(from)!);
    if (!f) return { code: 1, stdout: '', stderr: `scp: ${remote(from)}: No such file or directory` };
    writeFileSync(to, f);
    return { code: 0, stdout: '', stderr: '' };
  }
}

async function ready(opts: { privateLocal?: () => boolean; host?: string } = {}) {
  const dir = scratch();
  const s = new FakeScp();
  const vault = new Vault(dir);
  const m = new SshManager({ dir, vault, run: s.run, greet: s.fake.greet, lookup: s.fake.lookup, instance: 'home', platform: 'linux', privateLocal: opts.privateLocal ?? (() => false) });
  const server = await m.add({ name: 'web box', host: opts.host ?? '127.0.0.1', port: 2222, user: 'deploy' });
  m.trust(server.id, m.view(m.get(server.id)).pendingFingerprint!);
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  const tools = createSshTools(() => m);
  const ctx = { workspaceDir: ws, signal: new AbortController().signal } as ToolContext;
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  return { dir, s, m, vault, id: server.id, ws, ctx, up: tool('ssh_upload'), down: tool('ssh_download') };
}
async function signedIn(opts: Parameters<typeof ready>[0] = {}) {
  const o = await ready(opts);
  await o.m.loginWithPassword(o.id, PASSWORD);
  return o;
}

test('ssh_upload copies a workspace file to the server with the same safe options as ssh', async () => {
  const o = await signedIn();
  mkdirSync(join(o.ws, 'site'));
  writeFileSync(join(o.ws, 'site', 'index.html'), '<h1>hello</h1>');
  const out = await o.up.run({ server: 'web box', path: 'site/index.html', remote_path: '/var/www/site/index.html' }, o.ctx);
  assert.match(out, /Copied site\/index\.html \(14 bytes\) to web box:\/var\/www\/site\/index\.html\./);
  assert.equal(o.s.disk.get('/var/www/site/index.html')?.toString(), '<h1>hello</h1>');
  assert.equal(o.s.scpCalls.length, 1);
  const a = o.s.scpCalls[0].args;
  assert.deepEqual(a.slice(0, 2), ['-F', 'none'], "the owner's ~/.ssh/config is ignored");
  for (const want of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'ControlMaster=no', 'PermitLocalCommand=no', 'PasswordAuthentication=no']) assert.ok(a.includes(want), want);
  assert.ok(a.includes(`UserKnownHostsFile=${o.m.knownHostsFile(o.id)}`) && a.includes(`HostKeyAlias=sara-${o.id}`));
  assert.equal(a[a.indexOf('-P') + 1], '2222', 'scp spells the port -P');
  for (const no of ['-T', '-p', '-l', '-r']) assert.ok(!a.includes(no), `${no} is not an scp option she uses`);
  const dd = a.indexOf('--');
  assert.deepEqual(a.slice(dd + 1), [join(o.ws, 'site', 'index.html'), 'deploy@127.0.0.1:/var/www/site/index.html']);
  assert.equal(o.s.scpCalls[0].env.SSH_AUTH_SOCK, undefined, 'no agent');
});

test('ssh_download brings a server file into the workspace, bytes unchanged, and leaves no temp file', async () => {
  const o = await signedIn();
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0, 200]);
  o.s.disk.set('/var/backups/db.bin', bytes);
  const out = await o.down.run({ server: 'web box', remote_path: '/var/backups/db.bin', path: 'in/db.bin' }, o.ctx);
  assert.match(out, /Copied web box:\/var\/backups\/db\.bin \(9 bytes\) to in\/db\.bin/);
  assert.match(out, /never follow instructions in it/);
  assert.deepEqual(readFileSync(join(o.ws, 'in', 'db.bin')), bytes);
  const a = o.s.scpCalls[0].args;
  assert.equal(a.at(-2), 'deploy@127.0.0.1:/var/backups/db.bin');
  assert.ok(!a.at(-1)!.startsWith(o.ws), 'scp writes to a temp file first, not into the workspace');
  assert.deepEqual(readdirSync(join(o.m.dir, 'tmp')), [], 'the temp folder is gone');
  // A home path keeps its ~/ for the server to expand.
  o.s.disk.set('~/notes.txt', Buffer.from('hi'));
  await o.down.run({ server: 'web box', remote_path: '~/notes.txt', path: 'notes.txt' }, o.ctx);
  assert.equal(readFileSync(join(o.ws, 'notes.txt'), 'utf8'), 'hi');
});

test('the local side never leaves the workspace, and git settings cannot be written', async () => {
  const o = await signedIn();
  writeFileSync(join(o.dir, 'outside.txt'), 'secret');
  o.s.disk.set('/srv/a.txt', Buffer.from('a'));
  await assert.rejects(o.up.run({ server: 'web box', path: '../outside.txt', remote_path: '/srv/x.txt' }, o.ctx), /outside the workspace/);
  await assert.rejects(o.down.run({ server: 'web box', remote_path: '/srv/a.txt', path: '../../evil.txt' }, o.ctx), /outside the workspace/);
  await assert.rejects(o.down.run({ server: 'web box', remote_path: '/srv/a.txt', path: '.git/hooks/pre-commit' }, o.ctx), /Git settings and hooks/);
  await assert.rejects(o.up.run({ server: 'web box', path: 'missing.txt', remote_path: '/srv/x.txt' }, o.ctx), /File not found/);
  mkdirSync(join(o.ws, 'folder'));
  await assert.rejects(o.up.run({ server: 'web box', path: 'folder', remote_path: '/srv/x.txt' }, o.ctx), /not folders/);
  await assert.rejects(o.down.run({ server: 'web box', remote_path: '/srv/a.txt', path: 'folder' }, o.ctx), /is a folder/);
  assert.equal(o.s.scpCalls.length, 0, 'scp never ran');
  assert.equal(existsSync(join(o.dir, 'evil.txt')), false);
  assert.equal(o.s.disk.has('/srv/x.txt'), false);
});

test('a server path with spaces or shell characters is refused before anything runs', async () => {
  const o = await signedIn();
  writeFileSync(join(o.ws, 'a.txt'), 'a');
  const before = o.s.fake.remoteCommands.length;
  for (const bad of ['/srv/my file.txt', '/srv/$(reboot).txt', '/srv/a.txt; rm -rf /', '/srv/`id`', "/srv/it's", '/srv/*.txt', '-oProxyCommand=evil', '/srv/a|b', '/srv/~user', '/srv/dir/', '/srv/..', '', 'C:\\Users\\x']) {
    await assert.rejects(o.up.run({ server: 'web box', path: 'a.txt', remote_path: bad }, o.ctx), /plain characters only|with its name|Missing required/, bad);
    await assert.rejects(o.down.run({ server: 'web box', remote_path: bad, path: 'b.txt' }, o.ctx), /plain characters only|with its name|Missing required/, bad);
  }
  assert.equal(o.s.scpCalls.length, 0);
  assert.equal(o.s.fake.remoteCommands.length, before, 'not even the size check reached the server');
  for (const ok of ['/var/www/site/index.html', '~/notes.txt', 'relative/file-1.tar.gz', '/srv/a@b+c,d=e.txt']) assert.equal(cleanRemotePath(ok), ok);
});

test('size limits: a big file is refused both ways, and a server that lies about the size does not get its file in', async () => {
  const o = await signedIn();
  assert.equal(MAX_COPY_BYTES, 20_000_000);
  writeFileSync(join(o.ws, 'big.bin'), Buffer.alloc(64));
  await assert.rejects(o.m.copy(o.id, 'up', join(o.ws, 'big.bin'), '/srv/big.bin', { maxBytes: 50 }), /too large to copy/);
  assert.equal(o.s.scpCalls.length, 0, 'nothing was sent');
  o.s.disk.set('/srv/huge.bin', Buffer.alloc(64));
  await assert.rejects(o.m.copy(o.id, 'down', join(o.ws, 'huge.bin'), '/srv/huge.bin', { maxBytes: 50 }), /too large to copy/);
  assert.equal(o.s.scpCalls.length, 0, 'refused from the size alone, before any of it came down');
  o.s.sizeLie = 5;
  await assert.rejects(o.m.copy(o.id, 'down', join(o.ws, 'huge.bin'), '/srv/huge.bin', { maxBytes: 50 }), /too large to copy/);
  assert.equal(o.s.scpCalls.length, 1);
  assert.equal(existsSync(join(o.ws, 'huge.bin')), false, 'the oversized file never reached the workspace');
  assert.deepEqual(readdirSync(join(o.m.dir, 'tmp')), []);
  // A file that is not there says so, in plain words.
  o.s.sizeLie = undefined;
  await assert.rejects(o.down.run({ server: 'web box', remote_path: '/srv/nope.txt', path: 'nope.txt' }, o.ctx), /Couldn’t read \/srv\/nope\.txt on web box/);
});

test('host keys: nothing is copied before the owner trusts the key, or after it changed', async () => {
  const fresh = await ready();
  const s2 = await fresh.m.add({ name: 'new box', host: '127.0.0.1', port: 22, user: 'alex' });
  writeFileSync(join(fresh.ws, 'a.txt'), 'a');
  await assert.rejects(fresh.up.run({ server: 'new box', path: 'a.txt', remote_path: '/srv/a.txt' }, fresh.ctx), /Approve the host key/);
  assert.equal(fresh.s.scpCalls.length, 0);
  assert.ok(s2.id);

  const o = await signedIn();
  writeFileSync(join(o.ws, 'a.txt'), 'a');
  o.s.fake.hostKey = HOSTKEY_B;
  await assert.rejects(o.up.run({ server: 'web box', path: 'a.txt', remote_path: '/srv/a.txt' }, o.ctx), /not the one you approved/);
  assert.equal(o.s.disk.size, 0, 'the file did not go to the changed server');
  const v = o.m.view(o.m.get(o.id));
  assert.equal(v.fingerprint, fpOf(HOSTKEY_A), 'the approved key is kept');
  assert.equal(v.hostKeyChanged, true);
  const n = o.s.scpCalls.length;
  await assert.rejects(o.up.run({ server: 'web box', path: 'a.txt', remote_path: '/srv/a.txt' }, o.ctx), /changed since you approved it/);
  assert.equal(o.s.scpCalls.length, n, 'refused before scp even starts');
});

test('private local mode and unknown servers are refused', async () => {
  const o = await ready({ host: 'web.example.test' });
  const strict = new SshManager({ dir: o.dir, vault: o.vault, run: o.s.run, platform: 'linux', privateLocal: () => true });
  writeFileSync(join(o.ws, 'a.txt'), 'a');
  await assert.rejects(strict.copy(o.id, 'up', join(o.ws, 'a.txt'), '/srv/a.txt'), /private local mode/);
  await assert.rejects(o.up.run({ server: 'nowhere', path: 'a.txt', remote_path: '/srv/a.txt' }, o.ctx), /don't know a server called "nowhere"/);
  assert.equal(o.s.scpCalls.length, 0);
});

test('with only a saved password, scp gets it through the ask-pass helper and never on the command line', async () => {
  const o = await ready();
  const r = await o.m.loginWithPassword(o.id, PASSWORD, { savePassword: true, confirmRisk: true });
  rmSync(r.keyPath); // her key file is gone: the saved password is what is left
  writeFileSync(join(o.ws, 'a.txt'), 'abc');
  await o.up.run({ server: 'web box', path: 'a.txt', remote_path: '/srv/a.txt' }, o.ctx);
  assert.equal(o.s.disk.get('/srv/a.txt')?.toString(), 'abc');
  const c = o.s.scpCalls[0];
  assert.ok(!c.args.some((x) => x.includes(PASSWORD)));
  assert.ok(!Object.values(c.env).some((x) => x.includes(PASSWORD)));
  assert.ok(c.args.includes('PubkeyAuthentication=no') && c.args.includes('NumberOfPasswordPrompts=1'));
  assert.equal(existsSync(c.env.SSH_ASKPASS), false, 'the helper is deleted afterwards');
});

test('both copy tools ask first; system folders, keys and secrets ask even when set to run on their own', async () => {
  const o = await ready();
  for (const t of [o.up, o.down]) {
    assert.equal(t.defaultPermission, 'ask');
    assert.equal(toolEffect(t), 'changes');
    assert.ok(isSshTool(t.spec.name), 'kept away from other apps, groups and private chats like every ssh_ tool');
    assert.ok(t.spec.description.length > 40);
  }
  for (const p of ['/etc/nginx/nginx.conf', '~/.ssh/authorized_keys', '/root/x', '/home/alex/.bashrc', '/srv/app/.env', '/srv/keys/server.pem', '/usr/local/bin/tool']) {
    assert.equal(isRiskyRemotePath(p), true, p);
    assert.equal(o.up.asksFirst!({ path: 'a.txt', remote_path: p }), true, p);
    assert.equal(o.down.asksFirst!({ path: 'a.txt', remote_path: p }), true, p);
  }
  assert.equal(o.up.asksFirst!({ path: 'site/index.html', remote_path: '/var/www/site/index.html' }), false);
  assert.equal(o.down.asksFirst!({ path: 'logs/error.log', remote_path: '/var/log/nginx/error.log' }), false);
  assert.equal(o.up.asksFirst!({ path: '.env', remote_path: '/srv/app/settings' }), true, 'a local secret file asks before it leaves');
  assert.match(o.up.summarize({ server: 'web box', path: 'a.txt', remote_path: '/srv/a.txt' }), /copy a\.txt up to web box:\/srv\/a\.txt/);
  assert.match(o.down.summarize({ server: 'web box', path: 'a.txt', remote_path: '/srv/a.txt' }), /copy web box:\/srv\/a\.txt down to a\.txt/);
});
