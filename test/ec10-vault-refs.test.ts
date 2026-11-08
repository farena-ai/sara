// EC10: a vault entry may hold a reference (docs/ops/EC10_DESIGN.md). The resolved value is used,
// redacted and never written back; backups hold only the reference; source changes, rotation and
// failures write audit rows.
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { createBackup } from '../src/backup.ts';
import { Redactor, vaultSecretValues } from '../src/redact.ts';
import { SecretSources, setSecretSources } from '../src/secret-sources.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';

function stored(dir: string): Record<string, string> {
  const key = Buffer.from(readFileSync(join(dir, 'master.key'), 'utf8').trim(), 'base64');
  const raw = readFileSync(join(dir, 'secrets.enc'));
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as Record<string, string>;
}

function setup(env: Record<string, string | undefined>) {
  const { dir, cleanup } = tempDir();
  const sources = new SecretSources({ env, ttlMs: 60_000 });
  setSecretSources(sources);
  const trail = new AuditTrail(dir, { redact: (s) => s, key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  return {
    dir,
    sources,
    trail,
    rows: () => trail.list({}).reverse(),
    cleanup: () => {
      setAuditTrail(undefined);
      setSecretSources(new SecretSources());
      cleanup();
    },
  };
}

test('EC10 vault: a reference is stored as a reference, used resolved, redacted, and never written back', () => {
  const env: Record<string, string | undefined> = { OPENAI_KEY: 'sk-env-ref-11112222' };
  const t = setup(env);
  try {
    const vault = new Vault(t.dir);
    vault.set('provider:openai', 'env:OPENAI_KEY');
    vault.set('bridge:telegram', '123:plain-token-abcdef');
    assert.equal(vault.get('provider:openai'), 'sk-env-ref-11112222');
    assert.equal(vault.has('provider:openai'), true);
    assert.equal(vault.reference('provider:openai'), 'env:OPENAI_KEY');
    assert.equal(vault.reference('bridge:telegram'), undefined);
    const disk = stored(t.dir);
    assert.equal(disk['provider:openai'], 'sara-ref:v1:env:OPENAI_KEY');
    assert.ok(!JSON.stringify(disk).includes('sk-env-ref'), 'the resolved value is not on disk');
    // Using it does not write it back either.
    vault.get('provider:openai');
    vault.set('other', 'x');
    assert.ok(!JSON.stringify(stored(t.dir)).includes('sk-env-ref'));
    // Redaction sees the resolved value, not the reference text.
    const red = new Redactor(() => vaultSecretValues(vault.values()));
    assert.equal(red.redact('key sk-env-ref-11112222 here'), 'key [REDACTED] here');
    assert.ok(!vault.values().includes('sara-ref:v1:env:OPENAI_KEY'));
    // A source rotated at the environment is used at once.
    env.OPENAI_KEY = 'sk-env-ref-33334444';
    assert.equal(new Vault(t.dir).get('provider:openai'), 'sk-env-ref-33334444');
    // A plain value replaces the reference.
    vault.set('provider:openai', 'sk-plain-55556666');
    assert.equal(vault.reference('provider:openai'), undefined);
    assert.equal(vault.get('provider:openai'), 'sk-plain-55556666');
    const src = t.rows().filter((r) => r.action === 'secret.source');
    assert.deepEqual(src.map((r) => [r.target, r.keys]), [['provider:openai', ['from.none', 'to.env']], ['provider:openai', ['from.env', 'to.vault']]]);
    assert.ok(!JSON.stringify(t.rows()).includes('sk-'), 'no value in any audit row');
  } finally {
    t.cleanup();
  }
});

test('EC10 vault: several keys, first that works, rotation on failure with audit rows', () => {
  const env: Record<string, string | undefined> = { KEY_B: 'sk-bbbb-22223333', KEY_C: 'sk-cccc-44445555' };
  const t = setup(env);
  try {
    const vault = new Vault(t.dir);
    vault.set('provider:x', 'env:KEY_A | env:KEY_B');
    assert.equal(vault.get('provider:x'), 'sk-bbbb-22223333', 'A missing: B is used');
    env.KEY_A = 'sk-aaaa-11112222';
    assert.equal(vault.get('provider:x'), 'sk-aaaa-11112222', 'A back: A is the first');
    assert.equal(vault.rotate('provider:x'), true);
    assert.equal(vault.get('provider:x'), 'sk-bbbb-22223333', 'rotated to B');
    assert.equal(vault.rotate('provider:x'), true);
    assert.equal(vault.get('provider:x'), 'sk-aaaa-11112222', 'wraps around');
    vault.set('provider:single', 'env:KEY_C');
    assert.equal(vault.rotate('provider:single'), false, 'nothing to rotate to');
    assert.equal(vault.rotate('missing'), false);
    const rot = t.rows().filter((r) => r.action === 'secret.rotate');
    assert.deepEqual(rot.map((r) => [r.target, r.keys]), [['provider:x', ['from.1', 'to.2']], ['provider:x', ['from.2', 'to.1']]]);
    const [s] = vault.sources().filter((x) => x.name === 'provider:x');
    assert.equal(s.source, 'reference');
    assert.equal(s.active, 0);
    assert.deepEqual(s.refs!.map((r) => [r.kind, r.ref, r.ok]), [['env', 'env:KEY_A', true], ['env', 'env:KEY_B', true]]);
    // A reference that worked and starts failing: one failed row, then one ok row when it works again.
    // (A key that never worked writes no row: Settings shows it.)
    vault.get('provider:single');
    delete env.KEY_C;
    vault.get('provider:single');
    vault.get('provider:single');
    env.KEY_C = 'sk-cccc-44445555';
    vault.get('provider:single');
    const res = t.rows().filter((r) => r.action === 'secret.resolve');
    assert.deepEqual(res.map((r) => [r.target, r.outcome]), [['provider:single', 'failed'], ['provider:single', 'ok']]);
    assert.ok(!JSON.stringify(t.rows()).includes('sk-aaaa') && !JSON.stringify(t.rows()).includes('sk-cccc'));
    assert.ok(vault.sources().some((x) => x.name === 'bridge:none') === false);
  } finally {
    t.cleanup();
  }
});

test('EC10 vault: remote references resolve with ready(), check() reports plain errors, backups hold only references', async () => {
  let value = 'sk-remote-77778888';
  const server: Server = createServer((req, res) => {
    res.writeHead(req.url === '/v1/secret/data/sara' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { openai: value } } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const t = setup({ VAULT_ADDR: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, VAULT_TOKEN: 'hvs.remote-token-1' });
  try {
    const vault = new Vault(t.dir);
    vault.set('provider:openai', 'vault:secret/sara#openai');
    vault.set('provider:bad', 'vault:secret/missing#k');
    await vault.ready();
    assert.equal(vault.get('provider:openai'), 'sk-remote-77778888');
    assert.equal(new Vault(t.dir).get('provider:openai'), 'sk-remote-77778888', 'a new Vault instance shares the cache');
    const checked = await vault.check();
    const bad = checked.find((s) => s.name === 'provider:bad')!;
    assert.equal(bad.refs![0].ok, false);
    assert.equal(bad.refs![0].error, 'Vault has no secret at secret/missing (404).');
    value = 'sk-remote-99990000';
    await vault.check('provider:openai');
    assert.equal(vault.get('provider:openai'), 'sk-remote-99990000', 'Check now picks up a rotation at once');
    const plain = vault.sources().find((s) => s.name === 'bridge:telegram');
    assert.equal(plain, undefined);
    vault.set('bridge:telegram', 'tg-plain-token-1234');
    assert.equal(vault.sources().find((s) => s.name === 'bridge:telegram')?.source, 'vault');
    assert.ok(!JSON.stringify(vault.sources()).includes('tg-plain'), 'never a value in the list');
    // Backups copy the encrypted file: the reference is there, the resolved value is not.
    const out = join(t.dir, 'b.tar.gz');
    createBackup(t.dir, out);
    const { gunzipSync } = await import('node:zlib');
    const tar = gunzipSync(readFileSync(out)).toString('latin1');
    assert.ok(!tar.includes('sk-remote'), 'no resolved value in the backup');
    assert.ok(!tar.includes('hvs.remote-token-1'));
  } finally {
    t.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
