// EC28 (docs/ops/EC1828_DESIGN.md): the readiness rules, with fixtures. Pure: no server, no clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DRILL_FRESH_DAYS, readinessReport, type ReadinessFacts } from '../src/readiness.ts';

const NOW = new Date('2026-11-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const green = (line = 'fine') => ({ status: 'green' as const, line, fixes: [] });

/** Every area ready. */
function good(): ReadinessFacts {
  return {
    backups: { count: 3, newestAt: hoursAgo(5), newestName: 'sara-auto.tar.gz', auto: true },
    drill: { at: hoursAgo(24), ok: true, backup: 'sara-auto.tar.gz', madeAt: hoursAgo(30), totalMs: 9000, dataLossHours: 6 },
    offsiteTest: undefined,
    diskFreeBytes: 50e9,
    model: { configured: true, probe: { at: hoursAgo(0.01), ok: true } },
    bridges: [],
    paused: { jobs: 0, teams: 0, deliveries: 0 },
    safety: { offsite: green(), version: green(), https: green(), bind: green(), 'two-step': green(), token: green(), devices: green() },
    audit: { present: true, ok: true },
    metrics: true,
  };
}
const area = (f: ReadinessFacts, id: string) => readinessReport(f, NOW).areas.find((a) => a.id === id)!;

test('EC28 every area ready → Ready; fixed order of areas', () => {
  const r = readinessReport(good(), NOW);
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.areas.map((a) => a.id), ['backups', 'drill', 'offsite', 'disk', 'model', 'bridges', 'paused', 'updates', 'https', 'signin', 'policy', 'monitoring']);
  assert.ok(r.areas.every((a) => a.status === 'ready'), JSON.stringify(r.areas.filter((a) => a.status !== 'ready')));
  assert.deepEqual(r.counts, { ready: 12, attention: 0, 'not-ready': 0 });
});

test('EC28 backups: none → not ready; old or auto off → needs attention; each with a fix', () => {
  const f = good();
  f.backups = { count: 0, newestAt: null, newestName: null, auto: true };
  assert.equal(area(f, 'backups').status, 'not-ready');
  assert.equal(area(f, 'backups').reason, 'none');
  assert.deepEqual(area(f, 'backups').fix, { open: 'settings:dh-backups' });
  f.backups = { count: 1, newestAt: hoursAgo(72), newestName: 'x', auto: true };
  assert.equal(area(f, 'backups').status, 'attention');
  assert.equal(area(f, 'backups').reason, 'old');
  assert.equal(area(f, 'backups').params?.hours, 72);
  f.backups = { count: 1, newestAt: hoursAgo(1), newestName: 'x', auto: false };
  assert.equal(area(f, 'backups').reason, 'auto-off');
  assert.equal(readinessReport(f, NOW).verdict, 'attention');
});

test('EC28 restore drill: never or failed → not ready; older than the fresh window → attention; the fix runs a drill', () => {
  const f = good();
  f.drill = undefined;
  assert.equal(area(f, 'drill').status, 'not-ready');
  assert.equal(area(f, 'drill').reason, 'never');
  assert.deepEqual(area(f, 'drill').fix, { action: 'drill' });
  f.drill = { at: hoursAgo(2), ok: false, error: 'The database is damaged.' };
  assert.equal(area(f, 'drill').reason, 'failed');
  assert.equal(readinessReport(f, NOW).verdict, 'not-ready');
  f.drill = { at: hoursAgo(24 * (DRILL_FRESH_DAYS + 1)), ok: true, totalMs: 1000, dataLossHours: 1 };
  assert.equal(area(f, 'drill').status, 'attention');
  assert.equal(area(f, 'drill').reason, 'stale');
  // A passing off-server test restore does not replace a local drill, but is mentioned.
  f.drill = undefined;
  f.offsiteTest = { at: hoursAgo(10), ok: true };
  assert.equal(area(f, 'drill').status, 'not-ready');
  assert.equal(area(f, 'drill').params?.offsiteOk, true);
});

test('EC28 disk: < 1 GB not ready, < 5 GB attention, unknown attention', () => {
  const f = good();
  f.diskFreeBytes = 0.5e9;
  assert.equal(area(f, 'disk').status, 'not-ready');
  f.diskFreeBytes = 3e9;
  assert.equal(area(f, 'disk').status, 'attention');
  assert.equal(area(f, 'disk').params?.gb, '3.0');
  f.diskFreeBytes = null;
  assert.equal(area(f, 'disk').status, 'attention');
  assert.equal(area(f, 'disk').reason, 'unknown');
});

test('EC28 model: none → not ready; unreachable → not ready; not probed yet → attention', () => {
  const f = good();
  f.model = { configured: false };
  assert.equal(area(f, 'model').status, 'not-ready');
  assert.deepEqual(area(f, 'model').fix, { open: 'settings:models-providers' });
  f.model = { configured: true, probe: { at: hoursAgo(0), ok: false, error: 'connection refused' } };
  assert.equal(area(f, 'model').status, 'not-ready');
  assert.equal(area(f, 'model').reason, 'unreachable');
  assert.deepEqual(area(f, 'model').fix, { action: 'probe' });
  f.model = { configured: true };
  assert.equal(area(f, 'model').status, 'attention');
});

test('EC28 chat apps: none set up is fine; one not running needs attention and opens its page', () => {
  const f = good();
  assert.equal(area(f, 'bridges').reason, 'none');
  f.bridges = [{ name: 'Telegram', page: 'co-telegram', running: true }, { name: 'Discord', page: 'co-discord', running: false, error: 'bad token' }];
  assert.equal(area(f, 'bridges').status, 'attention');
  assert.deepEqual(area(f, 'bridges').params, { names: 'Discord', n: 1, total: 2 });
  assert.deepEqual(area(f, 'bridges').fix, { open: 'settings:co-discord' });
});

test('EC28 paused work needs attention and points at the recovery list below', () => {
  const f = good();
  f.paused = { jobs: 1, teams: 0, deliveries: 2 };
  assert.equal(area(f, 'paused').status, 'attention');
  assert.deepEqual(area(f, 'paused').params, { jobs: 1, teams: 0, deliveries: 2 });
  assert.deepEqual(area(f, 'paused').fix, { action: 'recovery' });
});

test('EC28 safety-backed areas: red → not ready, amber → attention, accepted amber → ready, worst row wins', () => {
  const f = good();
  f.safety.version = { status: 'amber', line: 'Version 3.0 is out', fixes: [{ open: 'settings:dh-updates' }] };
  assert.equal(area(f, 'updates').status, 'attention');
  assert.equal(area(f, 'updates').line, 'Version 3.0 is out');
  assert.deepEqual(area(f, 'updates').fix, { open: 'settings:dh-updates' });
  f.safety.version = { ...f.safety.version, accepted: true };
  assert.equal(area(f, 'updates').status, 'ready');
  f.safety.bind = { status: 'red', line: 'listens on every network', fixes: [{ command: 'sara access local' }] };
  assert.equal(area(f, 'https').status, 'not-ready');
  assert.equal(area(f, 'https').line, 'listens on every network');
  assert.deepEqual(area(f, 'https').fix, { command: 'sara access local' });
  f.safety['two-step'] = { status: 'amber', line: 'no lock', fixes: [] };
  assert.equal(area(f, 'signin').status, 'attention');
  assert.deepEqual(area(f, 'signin').fix, { open: 'settings:dh-devices' }, 'a default page when the row has no fix');
  // No policy set → ready ("no policy"); drift → attention.
  assert.equal(area(f, 'policy').reason, 'none');
  f.safety.policy = { status: 'amber', line: 'looser than the policy', fixes: [] };
  assert.equal(area(f, 'policy').status, 'attention');
});

test('EC28 monitoring: audit trail broken → not ready; metrics off → attention', () => {
  const f = good();
  f.metrics = false;
  assert.equal(area(f, 'monitoring').status, 'attention');
  assert.equal(area(f, 'monitoring').reason, 'metrics-off');
  assert.deepEqual(area(f, 'monitoring').fix, { open: 'settings:dh-operations' });
  f.audit = { present: true, ok: false };
  assert.equal(area(f, 'monitoring').status, 'not-ready');
  assert.deepEqual(area(f, 'monitoring').fix, { open: 'settings:dh-audit' });
});
