import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const checkout = resolve(import.meta.dirname, '..');
const workspaceId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const sentinel = 'synthetic-business-check-SECRET-DO-NOT-PRINT';
const scratch = () => mkdtempSync(join(realpathSync(tmpdir()), 'sara-business-check-'));
const policy = () => ({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 0, maxConcurrent: 2,
  models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: sentinel, baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false },
    model: 'synthetic-model', cloud: false, inputNanoUsdPerToken: 0, outputNanoUsdPerToken: 0, maxInputTokens: 1024, maxOutputTokens: 64, maxOutputBytes: 1024, deadlineMs: 1000, tone: 'professional' }],
  workspaces: { [workspaceId]: { modelId: 'local', allowanceNanoUsd: 0 } } });
function invoke(root: string | undefined, args = ['--business-check'], changes: NodeJS.ProcessEnv = {}, cwd = checkout) {
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_PROFILE: 'business', SARA_BUSINESS_ORIGIN: 'http://localhost:17863', SARA_PORT: '17863', ...changes };
  if (root === undefined) delete env.SARA_DATA; else env.SARA_DATA = root;
  return spawnSync(process.execPath, ['src/main.ts', ...args], { cwd, env, encoding: 'utf8', timeout: 20_000 });
}
function report(result: ReturnType<typeof invoke>, status: string, exit = 0) {
  assert.equal(result.error, undefined); assert.equal(result.status, exit, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['checks', 'status', 'version']);
  assert.equal(parsed.version, 1); assert.equal(parsed.status, status);
  assert.deepEqual(parsed.checks.map((check: { id: string }) => check.id), ['invocation', 'origin', 'port', 'data-root', 'profile-marker', 'layout', 'storage', 'model-policy', 'access', 'usage-recovery', 'credentials', 'inference', 'backup', 'availability']);
  assert.equal(new Set(parsed.checks.map((check: { id: string }) => check.id)).size, parsed.checks.length);
  assert.ok(parsed.checks.length > 5 && parsed.checks.length < 20);
  for (const check of parsed.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['action', 'id', 'message', 'status']);
    assert.match(check.id, /^[a-z-]+$/); assert.ok(['ok', 'needs-action', 'unverified', 'blocked'].includes(check.status));
    assert.ok(check.message.length > 0 && check.message.length < 350); assert.ok(check.action.length > 0 && check.action.length < 350);
  }
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
  return parsed as { version: 1; status: string; checks: { id: string; status: string; message: string; action: string }[] };
}
function fixture(root: string) {
  mkdirSync(join(root, 'business'), { recursive: true });
  writeFileSync(join(root, 'profile.json'), JSON.stringify({ version: 1, profile: 'business' }));
  writeFileSync(join(root, 'business', 'model-policy.json'), JSON.stringify({ revision: actorId, policy: policy() }));
}
function snapshot(root: string): unknown {
  if (!existsSync(root)) return null;
  function visit(path: string): unknown {
    const stat = lstatSync(path);
    return { mode: stat.mode, mtime: stat.mtimeMs, size: stat.isDirectory() ? undefined : stat.size,
      bytes: stat.isFile() ? readFileSync(path).toString('hex') : undefined,
      entries: stat.isDirectory() ? readdirSync(path).sort().map(name => [name, visit(join(path, name))]) : undefined };
  }
  return visit(root);
}

test('actual main business-check leaves a missing data root missing', () => {
  const dir = scratch(); const root = join(dir, 'missing');
  try {
    const result = invoke(root);
    assert.equal(existsSync(root), false, 'Inspection must not initialize the missing root');
    report(result, 'setup-needed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown business commands and invalid arity refuse before profile initialization', () => {
  const dir = scratch();
  try {
    for (const args of [['--business-unknown'], ['--business-status', 'extra'], ['--business-configure'], ['--business-reenroll'], ['--business-reenroll', actorId, '--wrong'], ['--business-backup', 'out', '--wrong', 'pass'], ['--business-reconcile'], ['--business-complete'], ['--business-resume-spending'], ['--business-resume-pause'], ['--business-restore', 'archive']]) {
      const root = join(dir, 'missing'); const result = invoke(root, args);
      assert.equal(existsSync(root), false, args.join(' ')); assert.equal(result.status, 1, args.join(' '));
    }
    const invalidCheck = invoke(join(dir, 'missing'), ['--business-check', sentinel]);
    assert.equal(existsSync(join(dir, 'missing')), false); report(invalidCheck, 'blocked', 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('business-check requires explicit business profile, data root, canonical origin and serving port', () => {
  const dir = scratch();
  try {
    for (const changes of [{ SARA_PROFILE: '' }, { SARA_PROFILE: 'personal' }, { SARA_PROFILE: 'busines' }, { SARA_BUSINESS_ORIGIN: '' },
      { SARA_BUSINESS_ORIGIN: 'http://untrusted.example.test' }, { SARA_BUSINESS_ORIGIN: 'https://example.test/' },
      { SARA_BUSINESS_ORIGIN: `https://${sentinel}@example.test` }, { SARA_PORT: '0' }, { SARA_PORT: '-1' }, { SARA_PORT: '65536' }, { SARA_PORT: '1e3' }]) {
      report(invoke(dir, undefined, changes), 'blocked', 1); assert.deepEqual(readdirSync(dir), []);
    }
    report(invoke(undefined), 'blocked', 1);
    report(invoke('   '), 'blocked', 1);
    const reverseProxy = report(invoke(dir, undefined, { SARA_BUSINESS_ORIGIN: 'https://business.example.test', SARA_PORT: '7860' }), 'setup-needed');
    assert.equal(reverseProxy.checks.find(item => item.id === 'origin')?.status, 'ok');
    const ip = report(invoke(dir, undefined, { SARA_BUSINESS_ORIGIN: 'http://127.0.0.1:17863' }), 'setup-needed');
    assert.equal(ip.checks.find(item => item.id === 'origin')?.status, 'needs-action');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty, marked empty and policy-configured roots remain byte and metadata unchanged', () => {
  const dir = scratch();
  try {
    const emptyBefore = snapshot(dir); report(invoke(dir), 'setup-needed'); assert.deepEqual(snapshot(dir), emptyBefore);
    fixture(dir); const policyPath = join(dir, 'business', 'model-policy.json');
    chmodSync(policyPath, 0o600); utimesSync(policyPath, 1700000000, 1700000000);
    const before = snapshot(dir); const configured = report(invoke(dir), 'setup-needed'); assert.deepEqual(snapshot(dir), before);
    assert.equal(configured.checks.find(item => item.id === 'model-policy')?.status, 'ok');
    assert.equal(configured.checks.find(item => item.id === 'access')?.status, 'unverified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live-looking DB, pending ledger, credentials, key, Vault, policy and fence remain untouched and unknown', () => {
  const dir = scratch();
  try {
    fixture(dir);
    for (const sub of ['operator', `auth/${actorId}/0`, `workspaces/${workspaceId}`]) mkdirSync(join(dir, 'business', sub), { recursive: true });
    for (const file of ['business.db', 'business.db-wal', 'business.db-shm', 'writer-fence.db', 'writer-fence.db-journal', 'operator/master.key', 'operator/secrets.enc',
      `auth/${actorId}/0/owner.json`, `auth/${actorId}/0/owner.json.bak`, `auth/${actorId}/0/scope.json`, `workspaces/${workspaceId}/content.db`, 'recovery-generation.json', 'proxy-secret']) {
      const path = join(dir, 'business', file); writeFileSync(path, `${sentinel}: pending held private-user-name private-content`); chmodSync(path, 0o600); utimesSync(path, 1700000000, 1700000000);
    }
    const before = snapshot(dir); const result = invoke(dir); const parsed = report(result, 'configuration-only');
    assert.deepEqual(snapshot(dir), before);
    for (const id of ['access', 'usage-recovery', 'credentials', 'inference', 'backup', 'availability', 'storage']) assert.equal(parsed.checks.find(item => item.id === id)?.status, 'unverified', id);
    for (const value of [dir, actorId, workspaceId, 'private-user-name', 'private-content', '127.0.0.1:11434']) assert.equal((result.stdout + result.stderr).includes(value), false, value);
    assert.doesNotMatch(result.stdout, /heldCount|ready|production-ready|activeGrants/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('personal, mixed, nested and malformed profile roots fail closed without input echoes or mutations', () => {
  const dir = scratch();
  try {
    for (const [index, name] of ['owner.json', 'household.json', 'settings.json', 'sara.db', 'members', 'companions', sentinel].entries()) {
      const root = join(dir, String(index)); mkdirSync(root); writeFileSync(join(root, name), sentinel);
      const before = snapshot(root); report(invoke(root), 'blocked', 1); assert.deepEqual(snapshot(root), before);
    }
    const mixed = join(dir, 'mixed'); fixture(mixed); writeFileSync(join(mixed, 'business', sentinel), sentinel);
    const before = snapshot(mixed); report(invoke(mixed), 'blocked', 1); assert.deepEqual(snapshot(mixed), before);
    const nested = join(mixed, 'nested'); report(invoke(nested), 'blocked', 1); assert.equal(existsSync(nested), false);
    for (const marker of [sentinel, '{}', '{"version":2,"profile":"business"}', '{"version":1,"profile":"personal"}', `{"version":1,"profile":"business","extra":"${sentinel}"}`]) {
      const root = join(dir, 'marker'); mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'profile.json'), marker);
      const saved = snapshot(root); report(invoke(root), 'blocked', 1); assert.deepEqual(snapshot(root), saved);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symlink roots, ancestor links, dangling links, hardlinks and nonregular marker paths are refused', () => {
  const dir = scratch();
  try {
    const outside = join(dir, 'outside'); fixture(outside);
    const linked = join(dir, 'linked'); symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    report(invoke(linked), 'blocked', 1); report(invoke(join(linked, 'missing')), 'blocked', 1);
    const inner = join(outside, 'business', 'operator'); symlinkSync(join(dir, 'missing-target'), inner, process.platform === 'win32' ? 'junction' : 'dir');
    report(invoke(outside), 'blocked', 1); rmSync(inner);
    linkSync(join(outside, 'profile.json'), join(dir, 'marker-copy')); report(invoke(outside), 'blocked', 1); rmSync(join(dir, 'marker-copy'));
    linkSync(join(outside, 'business', 'model-policy.json'), join(dir, 'policy-copy')); report(invoke(outside), 'blocked', 1); rmSync(join(dir, 'policy-copy'));
    mkdirSync(join(outside, 'business', 'operator')); writeFileSync(join(outside, 'business', 'operator', 'master.key'), sentinel);
    linkSync(join(outside, 'business', 'operator', 'master.key'), join(dir, 'key-copy')); report(invoke(outside), 'blocked', 1);
    const root = join(dir, 'directory-marker'); mkdirSync(join(root, 'profile.json'), { recursive: true }); report(invoke(root), 'blocked', 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded profile and policy reads refuse oversize, malformed and unsupported schema input', () => {
  const dir = scratch();
  try {
    fixture(dir); writeFileSync(join(dir, 'profile.json'), Buffer.alloc(4097, 32)); report(invoke(dir), 'blocked', 1);
    fixture(dir); writeFileSync(join(dir, 'business', 'model-policy.json'), Buffer.alloc(262145, 32)); report(invoke(dir), 'blocked', 1);
    for (const value of [sentinel, '{}', JSON.stringify({ revision: actorId, policy: { ...policy(), maxConcurrent: 0 } }), JSON.stringify({ revision: actorId, policy: { ...policy(), models: [] } }), JSON.stringify({ revision: actorId, policy: policy(), keys: sentinel })]) {
      fixture(dir); writeFileSync(join(dir, 'business', 'model-policy.json'), value); const before = snapshot(dir);
      report(invoke(dir), 'blocked', 1); assert.deepEqual(snapshot(dir), before);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded descriptor reads tolerate exact limits and refuse input growth without reading beyond the cap', async () => {
  const { inspectBusinessConfiguration } = await import('../src/business/check.ts');
  const dir = scratch();
  try {
    fixture(dir);
    for (const [file, maximum] of [['profile.json', 4096], ['business/model-policy.json', 262144]] as const) {
      const path = join(dir, file); const text = readFileSync(path, 'utf8'); writeFileSync(path, text.padEnd(maximum));
    }
    const env = { ...process.env, SARA_PROFILE: 'business', SARA_DATA: dir, SARA_BUSINESS_ORIGIN: 'http://localhost:17863', SARA_PORT: '17863' };
    assert.equal(inspectBusinessConfiguration(env).checks.find(check => check.id === 'model-policy')?.status, 'ok');
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const fs = createRequire(import.meta.url)('node:fs'), read = fs.readSync;
      let grew = false, policyBytes = 0;
      fs.readSync = function(fd, buffer, offset, length, position) {
        if (buffer.length === 262145) {
          if (!grew) { grew = true; fs.appendFileSync(join(process.env.SARA_DATA, 'business', 'model-policy.json'), Buffer.alloc(1048576, 32)); }
          if (length > 262145) throw new Error('Read exceeded fixed bound');
          const count = read.call(this, fd, buffer, offset, length, position); policyBytes += count; return count;
        }
        return read.call(this, fd, buffer, offset, length, position);
      };
      syncBuiltinESMExports();
      const { inspectBusinessConfiguration } = await import('./src/business/check.ts');
      const report = inspectBusinessConfiguration(process.env);
      console.log(JSON.stringify({ status: report.status, policy: report.checks.find(check => check.id === 'model-policy').status, grew, policyBytes }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { status: 'blocked', policy: 'blocked', grew: true, policyBytes: 262145 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspection refuses junction and directory substitutions after traversal without reading the replacement policy', () => {
  const dir = scratch();
  try {
    const observations: unknown[] = [];
    for (const variant of ['junction', 'directory', 'final-boundary'] as const) {
      const root = join(dir, variant); fixture(root); writeFileSync(join(root, 'business', 'business.db'), sentinel);
      const outside = join(dir, variant + '-outside'); mkdirSync(outside);
      cpSync(join(root, 'business', 'model-policy.json'), join(outside, 'model-policy.json'));
      const businessBefore = snapshot(join(root, 'business')); const outsideBefore = snapshot(outside); const markerBefore = readFileSync(join(root, 'profile.json'));
      const script = `
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        import { join, resolve, sep } from 'node:path';
        const fs = createRequire(import.meta.url)('node:fs'), open = fs.openSync, read = fs.readSync, close = fs.closeSync;
        const root = process.env.SARA_DATA, outside = process.env.CHECK_OUTSIDE, profile = join(root, 'profile.json'), policy = join(root, 'business', 'model-policy.json');
        const replacedDescriptors = new Set(); let swapped = false, replacementOpens = 0, replacementReads = 0, policyDescriptor;
        const substitute = () => {
          fs.renameSync(join(root, 'business'), root + '-saved-business');
          if (process.env.CHECK_VARIANT !== 'directory') fs.symlinkSync(outside, join(root, 'business'), process.platform === 'win32' ? 'junction' : 'dir');
          else fs.renameSync(outside, join(root, 'business'));
          swapped = true;
        };
        fs.openSync = function(path, ...args) {
          if (path === profile && !swapped && process.env.CHECK_VARIANT !== 'final-boundary') substitute();
          const descriptor = open.call(this, path, ...args);
          if (path === policy) policyDescriptor = descriptor;
          if (path === policy && swapped) { replacementOpens++; replacedDescriptors.add(descriptor); }
          return descriptor;
        };
        fs.readSync = function(fd, ...args) { if (replacedDescriptors.has(fd)) replacementReads++; return read.call(this, fd, ...args); };
        fs.closeSync = function(fd) { const result = close.call(this, fd); if (fd === policyDescriptor && !swapped && process.env.CHECK_VARIANT === 'final-boundary') substitute(); return result; };
        syncBuiltinESMExports();
        const { inspectBusinessConfiguration } = await import('./src/business/check.ts');
        const report = inspectBusinessConfiguration(process.env);
        const text = JSON.stringify(report);
        console.log(JSON.stringify({ status: report.status, swapped, replacementOpens, replacementReads, leaked: [root, outside, process.env.CHECK_SECRET].some(value => text.includes(value)) }));
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout,
        env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: root, SARA_BUSINESS_ORIGIN: 'https://business.example.test', SARA_PORT: '7860', CHECK_OUTSIDE: outside, CHECK_VARIANT: variant, CHECK_SECRET: sentinel }, encoding: 'utf8', timeout: 20_000 });
      assert.equal(child.status, 0, child.stderr);
      observations.push({ variant, ...JSON.parse(child.stdout) });
      assert.deepEqual(snapshot(root + '-saved-business'), businessBefore);
      assert.deepEqual(snapshot(variant === 'directory' ? join(root, 'business') : outside), outsideBefore);
      assert.deepEqual(readFileSync(join(root, 'profile.json')), markerBefore);
    }
    assert.deepEqual(observations, ['junction', 'directory', 'final-boundary'].map(variant => ({ variant, status: 'blocked', swapped: true, replacementOpens: 0, replacementReads: 0, leaked: false })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('metadata traversal rejects excess entries and deep unrecognized state', async () => {
  const { inspectBusinessConfiguration } = await import('../src/business/check.ts');
  const dir = scratch();
  try {
    fixture(dir); const auth = join(dir, 'business', 'auth'); mkdirSync(auth);
    for (let i = 0; i < 10001; i++) mkdirSync(join(auth, `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`));
    const env = { SARA_PROFILE: 'business', SARA_DATA: dir, SARA_BUSINESS_ORIGIN: 'http://localhost:17863', SARA_PORT: '17863' };
    assert.equal(inspectBusinessConfiguration(env).status, 'blocked');
    rmSync(auth, { recursive: true }); mkdirSync(join(dir, 'business', ...Array(12).fill('nested')), { recursive: true });
    assert.equal(inspectBusinessConfiguration(env).status, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual packaged runtime subset supports business-check without a checkout convenience script', () => {
  const dir = scratch(); const packaged = join(dir, 'packaged'); const root = join(dir, 'missing');
  try {
    mkdirSync(packaged); cpSync(join(checkout, 'src'), join(packaged, 'src'), { recursive: true });
    cpSync(join(checkout, 'web'), join(packaged, 'web'), { recursive: true });
    cpSync(join(checkout, 'package.json'), join(packaged, 'package.json'));
    assert.equal(existsSync(join(packaged, 'scripts')), false);
    report(invoke(root, undefined, {}, packaged), 'setup-needed'); assert.equal(existsSync(root), false);
    fixture(root); writeFileSync(join(root, 'business', 'business.db'), sentinel); const before = snapshot(root);
    report(invoke(root, undefined, {}, packaged), 'configuration-only'); assert.deepEqual(snapshot(root), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('instrumented actual main inspection performs no DB, Vault, secret/content read, write, probe or lock', () => {
  const dir = scratch();
  try {
    fixture(dir); mkdirSync(join(dir, 'business', 'operator'));
    for (const file of ['business.db', 'writer-fence.db', 'operator/master.key', 'operator/secrets.enc']) writeFileSync(join(dir, 'business', file), sentinel);
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { resolve, join, sep } from 'node:path';
      const require = createRequire(import.meta.url), fs = require('node:fs'), sqlite = require('node:sqlite'), net = require('node:net'), crypto = require('node:crypto');
      const root = resolve(process.env.SARA_DATA), allowed = new Set([join(root, 'profile.json'), join(root, 'business', 'model-policy.json')]);
      const calls = { database: 0, protectedRead: 0, write: 0, network: 0, decrypt: 0 };
      const denied = key => { calls[key]++; throw new Error('Forbidden inspection operation'); };
      const inside = path => typeof path === 'string' && (resolve(path) === root || resolve(path).startsWith(root + sep));
      for (const method of ['readFileSync', 'openSync']) {
        const original = fs[method];
        fs[method] = function(path, ...args) {
          if (inside(path) && !allowed.has(resolve(path))) return denied('protectedRead');
          if (method === 'openSync' && inside(path) && (typeof args[0] === 'string' ? args[0] !== 'r' : !!(args[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)))) return denied('write');
          return original.call(this, path, ...args);
        };
      }
      for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'linkSync', 'unlinkSync', 'rmSync', 'truncateSync', 'chmodSync', 'utimesSync']) fs[method] = () => denied('write');
      sqlite.DatabaseSync = class { constructor() { denied('database'); } };
      net.Server.prototype.listen = () => denied('network'); net.Socket.prototype.connect = () => denied('network');
      globalThis.fetch = () => denied('network'); crypto.createDecipheriv = () => denied('decrypt');
      syncBuiltinESMExports();
      process.on('exit', () => process.stderr.write('CHECK_PROBES:' + JSON.stringify(calls) + '\\n'));
      process.argv = [process.execPath, resolve('src/main.ts'), '--business-check'];
      await import('./src/main.ts');
    `;
    const before = snapshot(dir);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: dir, SARA_BUSINESS_ORIGIN: 'https://business.example.test', SARA_PORT: '7860' }, encoding: 'utf8', timeout: 20_000 });
    report(child, 'configuration-only'); assert.deepEqual(snapshot(dir), before);
    const match = /CHECK_PROBES:(\{[^\n]+\})/.exec(child.stderr); assert.ok(match, child.stderr);
    assert.deepEqual(JSON.parse(match[1]), { database: 0, protectedRead: 0, write: 0, network: 0, decrypt: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared model policy validator preserves runtime normalization, rejection and error classes', async () => {
  const { validateBusinessModelPolicy } = await import('../src/business/model-policy.ts');
  const { BusinessAccessError } = await import('../src/business/policy.ts');
  const { BusinessAdmissionError } = await import('../src/business/budget.ts');
  const original = policy(); const validated = validateBusinessModelPolicy(original);
  assert.deepEqual(validated, original); assert.ok(Object.isFrozen(validated.models[0])); assert.ok(Object.isFrozen(validated.models[0].provider));
  assert.throws(() => validateBusinessModelPolicy({ ...original, maxConcurrent: 0 }), BusinessAdmissionError);
  assert.throws(() => validateBusinessModelPolicy({ ...original, models: [] }), BusinessAccessError);
  assert.throws(() => validateBusinessModelPolicy({ ...original, workspaces: { invalid: { modelId: 'local', allowanceNanoUsd: 0 } } }), BusinessAccessError);
  const invalidProvider = policy(); invalidProvider.models[0].provider.baseUrl = 'https://example.test/?secret=value';
  assert.throws(() => validateBusinessModelPolicy(invalidProvider), BusinessAccessError);
});

test('check leaves a real pending ledger and an actively owned writer fence unchanged', async () => {
  const { openBusinessProfile } = await import('../src/business/profile.ts');
  const { createBusinessRuntime } = await import('../src/business/runtime.ts');
  const dir = scratch();
  const runtime = createBusinessRuntime({ profile: openBusinessProfile(dir), origin: 'http://localhost:17863' });
  try {
    runtime.configureModels(policy());
    runtime.identities.database.prepare(`INSERT INTO business_model_requests(request_id,actor_id,workspace_id,conversation_id,payload_hash,policy_hash,state,reserved,input_rate,output_rate,max_input,max_output,created_at)
      VALUES(?,?,?,?,?,?,'pending',123,0,0,1024,64,1)`).run(actorId, actorId, workspaceId, workspaceId, 'synthetic-payload-hash', 'synthetic-policy-hash');
    const beforeRows = runtime.identities.database.prepare('SELECT * FROM business_model_requests').all();
    const before = snapshot(dir); const parsed = report(invoke(dir), 'configuration-only');
    assert.equal(parsed.checks.find(item => item.id === 'usage-recovery')?.status, 'unverified');
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(runtime.identities.database.prepare('SELECT * FROM business_model_requests').all(), beforeRows);
    assert.equal(runtime.identities.database.prepare("SELECT value FROM business_model_state WHERE key='paused'").get(), undefined);
    const { acquireBusinessWriter } = await import('../src/business/lifecycle.ts');
    assert.throws(() => acquireBusinessWriter(openBusinessProfile(dir)), /active writer/);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('direct CLI inspection returns an exit code without changing the process exit code', async () => {
  const { runBusinessCli } = await import('../src/business/cli.ts');
  const before = process.exitCode; const original = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await runBusinessCli(['--business-check'], {}), 1);
    assert.equal(JSON.parse(output).status, 'blocked'); assert.equal(process.exitCode, before);
  } finally { process.stdout.write = original; }
});
