// EC8 + EC9 (docs/ops/EC89_DESIGN.md): the backend setting, re-detection without a restart, the
// admin's pins ('require container sandbox', 'egress allowlist only'), the routes and their audit
// rows, drift in the check-up, and the sandbox gate's container driver.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import type { Probe } from '../src/container.ts';
import { effectiveEgress, engineExe, IsolationService, isolationSettings, setIsolation } from '../src/isolation.ts';
import { policy, PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { detectIsolation } from '../src/sandbox-run.ts';
import { createSaraServer } from '../src/server.ts';
import type { SandboxInfo } from '../src/tools/sandbox.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev });
setAuditTrail(trail);
const store = new PolicyStore(dir);
setPolicy(store);

/** Docker appears once `installed` is true (a later *Look again* finds it). */
const engine = { installed: false };
const probe: Probe = (file, args) => {
  if (!engine.installed || !file.endsWith('docker') && !file.endsWith('docker.exe')) return { status: null, stdout: '' };
  if (args[0] === 'version') return { status: 0, stdout: '27.1\n' };
  if (args[0] === 'info') return { status: 0, stdout: '[]' };
  return { status: 0, stdout: 'id' };
};
const native: SandboxInfo = { mode: 'none', network: true, detail: 'no sandbox' };
const svc = new IsolationService({ native, target: app.sandbox, settings: () => isolationSettings(app.settings.get()), image: () => 'node:24-slim', required: () => policy().pins.containerSandbox === true, probe, platform: 'win32' });
setIsolation(svc);
let base = '';
before(async () => {
  svc.recheck();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  setIsolation(undefined);
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown } = {}) => fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : null });

test('Windows without an engine: commands stay unsandboxed and say so; after an install, Look again switches to the container', async () => {
  let v = await (await req('/api/isolation')).json();
  assert.equal(v.backend, 'auto');
  assert.equal(v.sandbox.mode, 'none');
  assert.equal(v.sandbox.isolated, false);
  assert.ok(v.tried.length >= 2);
  assert.equal(v.egress.mode, 'open');
  assert.equal(v.egress.commands, 'variables');
  assert.match(v.egress.commandsText, /not enforced/);
  assert.equal(v.egress.jobs, 'node-guard');
  engine.installed = true;
  v = await (await req('/api/isolation/recheck', { method: 'POST', body: {} })).json();
  assert.equal(v.sandbox.mode, 'container');
  assert.equal(v.sandbox.isolated, true);
  assert.equal(v.found.engine, 'docker');
  assert.equal(app.sandbox.mode, 'container', 'the live sandbox object every holder shares is updated in place');
  assert.equal(app.sandbox.container?.image, 'node:24-slim');
  assert.equal(v.egress.commands, 'container');
  assert.match(v.egress.commandsText, /^enforced: the container network/);
  // The owner may keep the native choice.
  v = await (await req('/api/isolation', { method: 'PUT', body: { backend: 'native' } })).json();
  assert.equal(v.sandbox.mode, 'none');
  assert.equal(app.settings.get().isolation?.backend, 'native');
  v = await (await req('/api/isolation', { method: 'PUT', body: { backend: 'auto' } })).json();
  assert.equal(v.sandbox.mode, 'container');
  assert.equal((await req('/api/isolation', { method: 'PUT', body: { backend: 'vm' } })).status, 400);
});

test('the egress allowlist: validated, saved, in force only when switched on; every change is one audit row', async () => {
  assert.equal(effectiveEgress(app.settings.get(), policy().pins), undefined);
  const bad = await req('/api/isolation', { method: 'PUT', body: { egressMode: 'allowlist', egressHosts: ['http://x.com/path'] } });
  assert.equal(bad.status, 400);
  const ok = await (await req('/api/isolation', { method: 'PUT', body: { egressMode: 'allowlist', egressHosts: ['registry.npmjs.org', '*.github.com'] } })).json();
  assert.equal(ok.egress.mode, 'allowlist');
  assert.deepEqual(ok.egress.hosts, ['registry.npmjs.org', '*.github.com']);
  assert.deepEqual(effectiveEgress(app.settings.get(), policy().pins)!.map((e) => e.host), ['registry.npmjs.org', 'github.com']);
  await new Promise((r) => setTimeout(r, 30));
  const rows = trail.list({ action: 'isolation.change' });
  assert.ok(rows.length >= 1, JSON.stringify(trail.list({}).map((r) => r.action)));
  assert.deepEqual(rows[0].keys, ['egressMode', 'egressHosts'], 'names only, never the hosts');
  await req('/api/isolation', { method: 'PUT', body: { egressMode: 'open' } });
  assert.equal(effectiveEgress(app.settings.get(), policy().pins), undefined);
});

test("EC5 pins: 'require container sandbox' and 'egress allowlist only' only tighten, refuse in the route and show as drift", async () => {
  assert.throws(() => validatePolicy({ pins: { containerSandbox: false } }), /only be pinned on/);
  assert.throws(() => validatePolicy({ pins: { egressAllowlist: ['*'] } }), /host name/);
  assert.deepEqual(validatePolicy({ pins: { egressAllowlist: ['API.Example.com'] } }).pins.egressAllowlist, ['api.example.com']);
  store.set({ name: 'Locked', pins: { containerSandbox: true, egressAllowlist: ['api.example.com'] } });
  svc.recheck();
  assert.deepEqual(effectiveEgress(app.settings.get(), policy().pins)!.map((e) => e.host), ['api.example.com'], 'the pinned list is in force although the owner chose open');
  const r = await req('/api/isolation', { method: 'PUT', body: { backend: 'native' } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).policy.key, 'containerSandbox');
  const r2 = await req('/api/isolation', { method: 'PUT', body: { egressMode: 'open' } });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).policy.key, 'egressAllowlist');
  const v = await (await req('/api/isolation')).json();
  assert.deepEqual(v.pinned, { containerSandbox: true, egressAllowlist: true });
  assert.equal(v.egress.mode, 'allowlist');
  const drift = store.drift(app.settings.get(), { sandboxMode: app.sandbox.mode });
  assert.deepEqual(drift.map((d) => d.key).sort(), ['containerSandbox', 'egressAllowlist']);
  // The pin with no engine: refused, never an unisolated run.
  engine.installed = false;
  svc.recheck();
  assert.equal(app.sandbox.mode, 'none');
  assert.match(app.sandbox.refuse ?? '', /requires the container sandbox/);
  store.set({ name: 'Open', pins: {} });
  svc.recheck();
  assert.equal(app.sandbox.refuse, undefined);
});

test('household members and the demo cannot see or change the sandbox choice', async () => {
  const m = makeApp(tempDir().dir, clock);
  m.member = { id: 'kid', name: 'Kid' } as never;
  const s2 = createSaraServer({ app: m, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/isolation`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403);
  } finally {
    s2.close();
    m.store.close();
  }
});

test('engines are found in their install folders (PATH is stale after an install), and the sandbox gate uses the container', () => {
  assert.equal(engineExe('docker', { ProgramFiles: 'C:\\PF' }, (p) => p === 'C:\\PF\\Docker\\Docker\\resources\\bin\\docker.exe', 'win32'), 'C:\\PF\\Docker\\Docker\\resources\\bin\\docker.exe');
  assert.equal(engineExe('podman', { ProgramFiles: 'C:\\PF' }, () => false, 'win32'), 'podman');
  const iso = detectIsolation({ mode: 'container', network: false, detail: '', container: { engine: 'podman', exe: 'podman', rootless: true, image: 'node:24-slim' } }, undefined, { platform: 'linux', probe: () => null });
  assert.deepEqual([iso.driver, iso.isolated], ['container', true]);
});
