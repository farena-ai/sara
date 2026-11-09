// EC10: external secret sources (docs/ops/EC10_DESIGN.md): parsing, every resolver against fakes,
// caching and rotation at the source, failure messages in plain words that never hold a value.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseReference, isReference, SecretSources, SecretSourceError, type CommandRunner } from '../src/secret-sources.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { tempDir } from './helpers.ts';

async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test('EC10 parse: every syntax, lists, and plain values are not references', () => {
  assert.deepEqual(parseReference('env:OPENAI_KEY')?.map((r) => r.kind), ['env']);
  assert.equal(parseReference('file:/run/secrets/openai')![0].path, '/run/secrets/openai');
  assert.equal(parseReference('file:C:/secrets/openai.txt')![0].path, 'C:/secrets/openai.txt');
  const v = parseReference('vault:secret/sara/openai#api_key')![0];
  assert.deepEqual([v.kind, v.mount, v.path, v.key], ['vault', 'secret', 'sara/openai', 'api_key']);
  const o = parseReference('op://Servers/OpenAI/credential')![0];
  assert.deepEqual([o.kind, o.vault, o.item, o.section, o.field], ['op', 'Servers', 'OpenAI', undefined, 'credential']);
  assert.equal(parseReference('op://Servers/OpenAI/api/credential')![0].section, 'api');
  const k = parseReference('keychain:sara/openai')![0];
  assert.deepEqual([k.kind, k.service, k.account], ['keychain', 'sara', 'openai']);
  const c = parseReference('cmd:bws secret get "3f a" #value')![0];
  assert.deepEqual([c.kind, c.argv, c.jsonPath], ['cmd', ['bws', 'secret', 'get', '3f a'], 'value']);
  const list = parseReference('env:KEY_A | env:KEY_B | vault:secret/sara#backup')!;
  assert.deepEqual(list.map((r) => r.raw), ['env:KEY_A', 'env:KEY_B', 'vault:secret/sara#backup']);
  for (const plain of ['sk-proj-abc123', '{"env":{"A":"b"}}', 'env:', 'env:lower case', 'file:relative/path', 'vault:secret', 'vault:secret/x', 'op://a/b', 'keychain:only', 'https://example.com', 'env:A | sk-123', ''])
    assert.equal(isReference(plain), false, plain);
  assert.equal(isReference(Array(9).fill('env:A').join(' | ')), false, 'at most 8 keys');
});

test('EC10 env and file: read at use time, rotation at the source shows up, errors in plain words', async () => {
  const { dir, cleanup } = tempDir();
  try {
    let t = 0;
    const env: Record<string, string> = { OPENAI_KEY: 'sk-env-1111' };
    const s = new SecretSources({ env, now: () => t, ttlMs: 1000 });
    const [e] = parseReference('env:OPENAI_KEY')!;
    assert.equal(s.peek(e).value, 'sk-env-1111');
    env.OPENAI_KEY = 'sk-env-2222';
    assert.equal(s.peek(e).value, 'sk-env-2222', 'env is never cached');
    delete env.OPENAI_KEY;
    assert.equal(s.peek(e).value, undefined);
    assert.equal(s.peek(e).error, 'The environment variable OPENAI_KEY is not set.');

    const path = join(dir, 'openai');
    writeFileSync(path, 'sk-file-1111\n');
    const [f] = parseReference(`file:${path.replaceAll('\\', '/')}`)!;
    assert.equal(s.peek(f).value, 'sk-file-1111', 'trailing newline trimmed');
    writeFileSync(path, 'sk-file-2222\n');
    assert.equal(s.peek(f).value, 'sk-file-1111', 'cached within the TTL');
    t = 1500;
    assert.equal(s.peek(f).value, 'sk-file-2222', 'rotated file picked up after the TTL');
    const [missing] = parseReference('file:/run/secrets/nope')!;
    const err = await s.resolve(missing).then(() => undefined, (e: SecretSourceError) => e);
    assert.equal(err?.message, 'The file /run/secrets/nope does not exist.');
    assert.equal(err?.key, 'The file {path} does not exist.', 'the template travels with it (the app translates it)');
    assert.deepEqual(err?.params, { path: '/run/secrets/nope' });
  } finally {
    cleanup();
  }
});

test('EC10 Vault/OpenBao KV v2: token header, namespace, data.data[key], rotation and failures', async () => {
  let value = 'sk-vault-1111';
  let status = 200;
  const seen: Array<string | undefined> = [];
  const { url, server, hits } = await fake((req, res) => {
    seen.push(`${req.headers['x-vault-token']}|${req.headers['x-vault-namespace']}`);
    if (req.url !== '/v1/secret/data/sara/openai') return json(res, 404, { errors: [] });
    if (status !== 200) return json(res, status, { errors: ['permission denied'] });
    json(res, 200, { data: { data: { api_key: value }, metadata: { version: 3 } } });
  });
  try {
    let t = 0;
    const s = new SecretSources({ env: { VAULT_ADDR: url + '/', VAULT_TOKEN: 'hvs.vault-token-xyz', VAULT_NAMESPACE: 'team' }, now: () => t, ttlMs: 1000 });
    const [r] = parseReference('vault:secret/sara/openai#api_key')!;
    assert.equal(s.peek(r).value, undefined, 'not resolved yet: no value, resolving starts');
    assert.equal(await s.resolve(r), 'sk-vault-1111');
    assert.deepEqual(seen.at(-1), 'hvs.vault-token-xyz|team');
    assert.equal(s.peek(r).value, 'sk-vault-1111');
    const n = hits.length;
    s.peek(r);
    assert.equal(hits.length, n, 'cached: no new request within the TTL');
    value = 'sk-vault-2222';
    t = 2000;
    assert.equal(s.peek(r).value, 'sk-vault-1111', 'stale: the last good value while refreshing');
    await s.settled();
    assert.equal(s.peek(r).value, 'sk-vault-2222', 'rotation at the source picked up');
    assert.equal(await s.resolve(parseReference('vault:secret/sara/openai#other')![0]).catch((e: Error) => e.message), 'Vault has no key "other" in secret/sara/openai.');
    assert.equal(await s.resolve(parseReference('vault:secret/missing#k')![0]).catch((e: Error) => e.message), 'Vault has no secret at secret/missing (404).');
    status = 403;
    const err = await s.resolve(r, true).catch((e: Error) => e);
    assert.ok(err instanceof SecretSourceError);
    assert.equal(err.message, 'Vault refused secret/sara/openai (403: permission denied). Check the token and its policy.');
    assert.equal(s.peek(r).value, 'sk-vault-2222', 'a failed refresh keeps the last good value');
    assert.equal(s.peek(r).error, err.message);
    assert.doesNotMatch(err.message, /hvs\.|sk-/);
    const none = new SecretSources({ env: {} });
    assert.equal(await none.resolve(r).catch((e: Error) => e.message), 'VAULT_ADDR is not set on the server, so Vault references cannot be read.');
    const noToken = new SecretSources({ env: { VAULT_ADDR: url } });
    assert.equal(await noToken.resolve(r).catch((e: Error) => e.message), 'VAULT_TOKEN (or VAULT_TOKEN_FILE) is not set on the server, so Vault references cannot be read.');
    assert.ok(s.values().includes('hvs.vault-token-xyz'), 'the source token is redacted too');
    assert.ok(s.values().includes('sk-vault-2222'));
  } finally {
    await close(server);
  }
});

test('EC10 Vault/OpenBao: the real multi-error body ("1 error occurred:\\n\\t* permission denied") reads as one plain line', async () => {
  // C1: a real OpenBao 2.7.2 dev server answers a policy refusal with this exact body.
  const { url, server } = await fake((_req, res) => json(res, 403, { errors: ['1 error occurred:\n\t* permission denied\n\n'] }));
  try {
    const s = new SecretSources({ env: { VAULT_ADDR: url, VAULT_TOKEN: 's.weak-token' } });
    const msg = await s.resolve(parseReference('vault:secret/sara#openai')![0]).catch((e: Error) => e.message);
    assert.equal(msg, 'Vault refused secret/sara (403: permission denied). Check the token and its policy.');
  } finally {
    await close(server);
  }
});

test('EC10 1Password Connect: vault, item and field by name or id, section, errors', async () => {
  const auth: Array<string | undefined> = [];
  const { url, server } = await fake((req, res) => {
    auth.push(req.headers.authorization);
    if (req.url === '/v1/vaults') return json(res, 200, [{ id: 'v1abc', name: 'Servers' }]);
    if (req.url === '/v1/vaults/v1abc/items') return json(res, 200, [{ id: 'i1abc', title: 'OpenAI' }]);
    if (req.url === '/v1/vaults/v1abc/items/i1abc')
      return json(res, 200, { id: 'i1abc', title: 'OpenAI', sections: [{ id: 's1', label: 'api' }], fields: [{ id: 'credential', label: 'credential', value: 'sk-op-1111' }, { id: 'f2', label: 'credential', section: { id: 's1' }, value: 'sk-op-sect' }, { id: 'f3', label: 'empty' }] });
    json(res, 404, { message: 'not found' });
  });
  try {
    const s = new SecretSources({ env: { OP_CONNECT_HOST: url, OP_CONNECT_TOKEN: 'op-connect-token-xyz' } });
    assert.equal(await s.resolve(parseReference('op://Servers/OpenAI/credential')![0]), 'sk-op-1111');
    assert.equal(auth.at(-1), 'Bearer op-connect-token-xyz');
    assert.equal(await s.resolve(parseReference('op://v1abc/i1abc/api/credential')![0]), 'sk-op-sect');
    assert.equal(await s.resolve(parseReference('op://Nope/OpenAI/credential')![0]).catch((e: Error) => e.message), '1Password Connect has no vault "Nope".');
    assert.equal(await s.resolve(parseReference('op://Servers/Nope/credential')![0]).catch((e: Error) => e.message), '1Password Connect has no item "Nope" in vault "Servers".');
    assert.equal(await s.resolve(parseReference('op://Servers/OpenAI/password')![0]).catch((e: Error) => e.message), '1Password Connect has no field "password" in item "OpenAI".');
    assert.equal(await s.resolve(parseReference('op://Servers/OpenAI/empty')![0]).catch((e: Error) => e.message), 'The field "empty" in item "OpenAI" is empty.');
    const none = new SecretSources({ env: {} });
    assert.match(await none.resolve(parseReference('op://Servers/OpenAI/credential')![0]).catch((e: Error) => e.message), /^OP_CONNECT_HOST and OP_CONNECT_TOKEN are not set/);
    const down = new SecretSources({ env: { OP_CONNECT_HOST: 'http://127.0.0.1:1', OP_CONNECT_TOKEN: 'x' } });
    assert.match(await down.resolve(parseReference('op://Servers/OpenAI/credential')![0]).catch((e: Error) => e.message), /^1Password Connect can't be reached/);
  } finally {
    await close(server);
  }
});

test('EC10 keychain: the right OS command per platform, plain errors', async () => {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const run: CommandRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o?.env });
    return cmd === 'secret-tool' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: 'sk-kc-1111\n', stderr: '' };
  };
  const [r] = parseReference('keychain:sara/openai')!;
  assert.equal(await new SecretSources({ env: {}, run, platform: 'darwin' }).resolve(r), 'sk-kc-1111');
  assert.deepEqual(calls.at(-1)!.args, ['find-generic-password', '-s', 'sara', '-a', 'openai', '-w']);
  assert.equal(calls.at(-1)!.cmd, 'security');
  assert.equal(await new SecretSources({ env: {}, run, platform: 'win32' }).resolve(r), 'sk-kc-1111');
  assert.equal(calls.at(-1)!.cmd, 'powershell.exe');
  assert.equal(calls.at(-1)!.env?.SARA_KC_TARGET, 'sara/openai', 'the target goes in through the environment, never the script');
  assert.equal(await new SecretSources({ env: {}, run, platform: 'linux' }).resolve(r).catch((e: Error) => e.message), 'The keychain has no entry for sara/openai.');
  assert.deepEqual(calls.at(-1)!.args, ['lookup', 'service', 'sara', 'account', 'openai']);
  assert.equal(await new SecretSources({ env: {}, run, platform: 'aix' }).resolve(r).catch((e: Error) => e.message), 'There is no keychain Sara can read on this system.');
  const missing: CommandRunner = async () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(await new SecretSources({ env: {}, run: missing, platform: 'linux' }).resolve(r).catch((e: Error) => e.message), 'secret-tool is not installed, so the keychain cannot be read.');
});

test('EC10 command: off unless the server allows it, no shell, JSON path, failures', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let out = '{"id":"3f","value":"sk-bws-1111"}';
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: cmd === 'fail' ? 2 : 0, stdout: out, stderr: cmd === 'fail' ? 'secret sk-leak-9999 not found' : '' };
  };
  const [r] = parseReference('cmd:bws secret get 3f #value')!;
  assert.equal(await new SecretSources({ env: {}, run }).resolve(r).catch((e: Error) => e.message), 'Commands as secret sources are off. Set SARA_SECRET_COMMANDS=1 on the server to allow them.');
  assert.equal(calls.length, 0);
  const s = new SecretSources({ env: { SARA_SECRET_COMMANDS: '1' }, run });
  assert.equal(await s.resolve(r), 'sk-bws-1111');
  assert.deepEqual(calls.at(-1), { cmd: 'bws', args: ['secret', 'get', '3f'] });
  out = 'sk-op-cli-1\n';
  assert.equal(await s.resolve(parseReference('cmd:op read op://Servers/OpenAI/credential')![0]), 'sk-op-cli-1');
  assert.equal(await s.resolve(r, true).catch((e: Error) => e.message), 'The command "bws" did not print JSON with "value".');
  const failed = await s.resolve(parseReference('cmd:fail now')![0]).catch((e: Error) => e.message);
  assert.equal(failed, 'The command "fail" failed (exit code 2).');
  assert.doesNotMatch(failed, /sk-leak/, 'stderr is never in the message');
});

test('EC10 private local mode: a cloud secret store is refused through the network guard', async () => {
  setPrivateLocal(true);
  try {
    const s = new SecretSources({ env: { VAULT_ADDR: 'https://vault.example.com', VAULT_TOKEN: 'hvs.x' } });
    assert.equal(await s.resolve(parseReference('vault:secret/sara#openai')![0]).catch((e: Error) => e.message), 'Vault at vault.example.com is blocked by private local mode.');
  } finally {
    setPrivateLocal(false);
  }
});
