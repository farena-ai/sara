// The stand-in for a real server (Phase 73, moved here in 2.52.1 so phase73 and ssh-easy share
// it): a fake OpenSSH (ssh, ssh-keygen, ssh-keyscan) injected as the command runner, playing one
// server with a host key, a password, an authorized_keys file and (2.52.1) a methods list (the
// `none` reply), a shell kind, ports that answer SSH / something else / nothing, and cPanel's
// ~/.ssh/sara-*.pub key files. No real server, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandRunner, RunOptions, RunResult } from '../src/ssh.ts';
import type { Greeting } from '../src/ssh-easy.ts';

/** A PEM block, built from parts so the release scan doesn't take the test for a leaked key. */
export const pem = (body: string, nl = false) => `-----BEGIN OPENSSH ${['PRIVATE', 'KEY'].join(' ')}-----\n${body}\n-----END OPENSSH ${['PRIVATE', 'KEY'].join(' ')}-----${nl ? '\n' : ''}`;
export const PASSWORD = 'Corr3ct-Horse!Battery';
export const HOSTKEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const HOSTKEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const OWNER_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnersOwnKeyStaysHere0000000000000000000 alex@laptop';
export const fpOf = (key: string) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

export interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export type PortKind = 'ssh' | 'http' | 'refused' | 'timeout' | 'silent';
export type ShellKind = 'bash' | 'jailshell' | 'noshell' | '/bin/false';

/** A fake OpenSSH and one server behind it. */
export class FakeSsh {
  calls: Call[] = [];
  hostKey = HOSTKEY_A;
  password = PASSWORD;
  authorized: string[] = [OWNER_LINE];
  passwordsSeen: string[] = [];
  remoteCommands: string[] = [];
  pubkeyAuth = true;
  /** 2.52.1: what the server lists in "Permission denied (…)" (the `none` reply). */
  methods: string[] = ['publickey', 'password', 'keyboard-interactive'];
  shell: ShellKind = 'bash';
  /** 3.4.1: what `id -u` says on the server (0 = root under any name). */
  uid = 1000;
  userExists = true;
  /** A second step (a code) after the key. */
  twoStep = false;
  /** Every ssh run fails before sign-in like this. */
  down?: 'refused' | 'timeout' | 'dns' | 'closed' | 'too-many';
  /** Ports and what answers there (the greeting read). Anything not listed: refused. */
  ports: Record<number, PortKind> = { 22: 'ssh', 2222: 'ssh' };
  greetings: { host: string; port: number }[] = [];
  /** cPanel's key files in ~/.ssh (name → content). */
  pubFiles: Record<string, string> = {};
  /** Names that don't resolve. */
  badNames = new Set<string>();
  lookups: string[] = [];

  greet = async (host: string, port: number): Promise<Greeting> => {
    this.greetings.push({ host, port });
    if (this.badNames.has(host)) return { kind: 'dns' };
    const k = this.ports[port] ?? 'refused';
    if (k === 'ssh') return { kind: 'ssh', banner: 'SSH-2.0-OpenSSH_9.6' };
    if (k === 'http') return { kind: 'other', banner: 'HTTP/1.1 400 Bad Request' };
    return { kind: k };
  };

  lookup = async (host: string): Promise<string> => {
    this.lookups.push(host);
    if (this.badNames.has(host)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return '192.0.2.10';
  };

  run: CommandRunner = async (cmd: string, args: string[], opts: RunOptions) => {
    this.calls.push({ cmd, args: [...args], env: { ...opts.env } });
    if (cmd === 'ssh-keyscan') {
      if (this.down) return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: `# 127.0.0.1:22 SSH-2.0-OpenSSH_9.6\n${args.at(-1)} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCrsa\n${args.at(-1)} ssh-ed25519 ${this.hostKey}\n`, stderr: '' };
    }
    if (cmd === 'ssh-keygen') return this.#keygen(args);
    if (cmd === 'ssh') return this.#ssh(args, opts);
    if (cmd === 'icacls') return { code: 0, stdout: '', stderr: '' };
    return { code: 127, stdout: '', stderr: `${cmd}: not found` };
  };

  #keygen(args: string[]): RunResult {
    if (args[0] === '-l') {
      const f = args[args.indexOf('-f') + 1];
      const key = readFileSync(f, 'utf8').trim().split(/\s+/)[2];
      return { code: 0, stdout: `256 ${fpOf(key)} sara-x (ED25519)\n`, stderr: '' };
    }
    if (args.includes('-y')) {
      const f = args[args.indexOf('-f') + 1];
      const body = readFileSync(f, 'utf8');
      if (/ENCRYPTED/.test(body)) return { code: 1, stdout: '', stderr: 'incorrect passphrase supplied to decrypt private key' };
      return { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIImportedKey00000000000000000000000000000\n', stderr: '' };
    }
    // -q -t ed25519 -N '' -C comment -f path
    const f = args[args.indexOf('-f') + 1];
    const comment = args[args.indexOf('-C') + 1];
    assert.equal(args[args.indexOf('-N') + 1], '', 'no passphrase on her key');
    assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', 'ed25519']);
    this.keysMade++;
    writeFileSync(f, pem('fake', true), { mode: 0o644 });
    writeFileSync(`${f}.pub`, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${Buffer.from(`${f}#${this.keysMade}`).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(-40)} ${comment}\n`);
    return { code: 0, stdout: '', stderr: '' };
  }
  keysMade = 0;

  async #ssh(args: string[], opts: RunOptions): Promise<RunResult> {
    if (args[0] === '-V') return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1' };
    const opt = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    const host = args[args.indexOf('--') + 1];
    if (this.down === 'dns') return { code: 255, stdout: '', stderr: `ssh: Could not resolve hostname ${host}: Name or service not known` };
    if (this.down === 'refused') return { code: 255, stdout: '', stderr: `ssh: connect to host ${host} port 22: Connection refused` };
    if (this.down === 'timeout') return { code: 255, stdout: '', stderr: `ssh: connect to host ${host} port 22: Connection timed out` };
    if (this.down === 'closed') return { code: 255, stdout: '', stderr: `kex_exchange_identification: Connection closed by remote host\nConnection closed by ${host} port 22` };
    // Host key check, the way StrictHostKeyChecking=yes does it.
    const known = existsSync(opt('UserKnownHostsFile')!) ? readFileSync(opt('UserKnownHostsFile')!, 'utf8') : '';
    const alias = opt('HostKeyAlias')!;
    if (!known.split('\n').some((l) => l.startsWith(`${alias} `) && l.includes(this.hostKey))) {
      return { code: 255, stdout: '', stderr: known.includes(alias) ? '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.' : 'No ED25519 host key is known for x and you have requested strict checking.\nHost key verification failed.' };
    }
    const denied = (list: string[]) => ({ code: 255, stdout: '', stderr: `user@host: Permission denied (${list.join(',')}).` });
    if (this.down === 'too-many') return { code: 255, stdout: '', stderr: `Received disconnect from ${host} port 22:2: Too many authentication failures\nDisconnected from ${host} port 22` };
    // 2.52.1: the methods check (every client method off): only the `none` request goes out.
    if (opt('PubkeyAuthentication') === 'no' && opt('PasswordAuthentication') === 'no') {
      this.methodChecks.push([...args]);
      return denied(this.methods);
    }
    const command = args.at(-1)!;
    const i = args.indexOf('-i');
    if (i >= 0) {
      const pub = readFileSync(`${args[i + 1]}.pub`, 'utf8').trim();
      if (!this.methods.includes('publickey') || !this.userExists || !this.pubkeyAuth || !this.authorized.includes(pub)) return denied(this.methods);
      if (this.twoStep) return { code: 255, stdout: '', stderr: 'Authenticated using "publickey" with partial success.\nuser@host: Permission denied (keyboard-interactive).' };
    } else {
      if (!this.methods.includes('password') && !this.methods.includes('keyboard-interactive')) return denied(this.methods);
      // Password: ssh runs SSH_ASKPASS (here: read the file the helper prints).
      const helper = opts.env.SSH_ASKPASS;
      assert.equal(opts.env.SSH_ASKPASS_REQUIRE, 'force');
      const script = readFileSync(helper, 'utf8');
      const file = /["']([^"']+[\\/]p)["']/.exec(script)![1];
      const given = readFileSync(file, 'utf8');
      this.passwordsSeen.push(given);
      if (given !== this.password || !this.userExists) return denied(this.methods);
    }
    const verbose = opt('LogLevel') === 'VERBOSE' ? `Authenticated to ${host} ([192.0.2.10]:22) using "publickey".\n` : '';
    if (this.shell === 'noshell') return { code: 1, stdout: '', stderr: `${verbose}Shell access is not enabled on your account!\n` };
    if (this.shell === '/bin/false') return { code: 1, stdout: '', stderr: verbose };
    this.remoteCommands.push(command);
    const r = this.#remote(command);
    return { ...r, stderr: `${verbose}${r.stderr}` };
  }
  methodChecks: string[][] = [];

  /** What the remote shell would do with her scripts. */
  #remote(command: string): RunResult {
    const zero = this.shell === 'jailshell' ? '/usr/local/cpanel/bin/jailshell' : 'bash';
    if (command.startsWith('echo sara-ok;')) {
      const inst = /grep -c '([^']+)'/.exec(command)?.[1] ?? 'sara@';
      return { code: 0, stdout: `sara-ok\nsara-shell:${zero}:${zero === 'bash' ? '/bin/bash' : zero}\nsara-own:${this.authorized.filter((l) => l.includes(inst)).length}\n${command.includes('sara-uid:') ? `sara-uid:${this.uid}\n` : ''}`, stderr: '' };
    }
    if (command.includes('sara-list-begin')) {
      const pat = /grep -F '([^']+)'/.exec(command)![1];
      return { code: 0, stdout: `sara-list-begin\n${this.authorized.filter((l) => l.includes(pat)).join('\n')}\nsara-list-end\n`, stderr: '' };
    }
    const line = /echo ('[^']+') >>/.exec(command)?.[1] ?? /grep -vxF ('[^']+')/.exec(command)?.[1];
    const lineText = line?.slice(1, -1);
    if (command.includes('sara-key-added') && lineText) {
      if (this.authorized.includes(lineText)) return { code: 0, stdout: 'sara-key-present\n', stderr: '' };
      this.authorized.push(lineText);
      return { code: 0, stdout: 'sara-key-added\n', stderr: '' };
    }
    if (command.includes('sara-key-removed') && lineText) {
      const had = this.authorized.includes(lineText);
      this.authorized = this.authorized.filter((l) => l !== lineText);
      // cPanel's key file: by exact name, or (cleanup) any sara-*.pub holding exactly that line.
      const byName = /rm -f "\$HOME\/\.ssh\/(sara-[a-z0-9]{10}\.pub)"/.exec(command)?.[1];
      if (byName) delete this.pubFiles[byName];
      if (/sara-\*\.pub/.test(command)) for (const [n, c] of Object.entries(this.pubFiles)) if (c.trim() === lineText) delete this.pubFiles[n];
      return { code: 0, stdout: had ? 'sara-key-removed\n' : 'sara-key-gone\n', stderr: '' };
    }
    if (/^echo sara-(key-)?ok$/.test(command)) return { code: 0, stdout: `${command.slice(5)}\n`, stderr: '' };
    return { code: 0, stdout: `ran: ${command}\n`, stderr: '' };
  }

  sshCalls(): Call[] {
    return this.calls.filter((c) => c.cmd === 'ssh' && c.args[0] !== '-V');
  }
}
