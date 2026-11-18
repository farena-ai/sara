// U5.34 (docs/DASHBOARD.md): the server dashboard in Settings → Privacy & system → Health. One card per
// server: this one, and every linked server that gave this owner an active help pass (read through the
// S9b support report; no new remote powers). Pure summaries are tested on report-shaped objects; the
// route on two real in-process servers linked by S9a.
import assert from 'node:assert/strict';
import test from 'node:test';
import { serverCard, type DashCard } from '../src/dashboard.ts';
import { linkPair, pairNode } from './helpers-repair-pair.ts';

const NOW = new Date('2026-11-18T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const GB = 1e9;
/** A report shaped like supportReport()'s (only the parts the dashboard reads). */
function report(o: Record<string, any> = {}): Record<string, any> {
  return {
    at: NOW.toISOString(),
    version: { server: '3.23.0', update: { state: 'idle', latest: null, required: false, security: false } },
    health: { ok: true, disk: { freeBytes: 80 * GB, totalBytes: 200 * GB }, backups: { auto: true, count: 4, last: ago(5) }, checks: [{ name: 'Database', ok: true, detail: 'ok' }] },
    errors: { turns: [], tools: [], providers: [] },
    apps: [{ kind: 'windows', version: '3.23.0', behind: false, seenAt: ago(1) }],
    system: { platform: 'linux', cpus: 4, load: [0.4, 0.3, 0.2], memTotal: 16 * GB, memFree: 9 * GB, rss: 0.3 * GB },
    repair: { open: 0, checkedAt: ago(0.2) },
    ...o,
  };
}
const row = (c: DashCard, key: string) => c.rows.find((r) => r.key === key)!;

test('U5.34: a healthy server is green on every row, with versions, disk, memory, load, backups and checks', () => {
  const c = serverCard(report(), { name: 'This server', self: true, now: NOW });
  assert.equal(c.state, 'ok');
  assert.deepEqual(c.rows.map((r) => r.key), ['health', 'versions', 'disk', 'memory', 'cpu', 'backups', 'errors', 'repair', 'updates']);
  for (const r of c.rows) assert.equal(r.state, 'ok', r.key);
  assert.equal(row(c, 'versions').params?.version, '3.23.0');
  assert.deepEqual(c.apps, [{ kind: 'windows', version: '3.23.0', behind: false }]);
  assert.equal(row(c, 'disk').params?.free, '80.0');
  assert.equal(row(c, 'memory').params?.pct, 44);
  assert.equal(c.checkedAt, NOW.toISOString());
  // Every row says where to look further (this server: a Settings page).
  assert.ok(c.rows.every((r) => typeof r.page === 'string' && r.page.length > 0));
  assert.ok(c.rows.every((r) => /^[A-Z{]/.test(r.text)), 'English keys the page translates');
});

test('U5.34: colors follow trouble: failing checks, low disk, old backups, errors, open repairs, updates, old apps', () => {
  const bad = serverCard(
    report({
      version: { server: '3.21.0', update: { state: 'available', latest: '3.23.0', required: false, security: true } },
      health: { ok: false, disk: { freeBytes: 0.5 * GB, totalBytes: 100 * GB }, backups: { auto: true, count: 2, last: ago(24 * 9) }, checks: [{ name: 'Database', ok: false, detail: 'locked' }, { name: 'Model', ok: true }] },
      errors: { turns: [{ at: ago(2) }, { at: ago(3) }, { at: ago(4) }], tools: [{ at: ago(1) }], providers: [{ service: 'ollama', kind: 'down' }] },
      apps: [{ kind: 'mac', version: '3.19.0', behind: true }],
      system: { platform: 'linux', cpus: 2, load: [3.5, 2, 1], memTotal: 8 * GB, memFree: 0.2 * GB, rss: 1 * GB },
      repair: { open: 2, checkedAt: ago(1) },
    }),
    { name: 'Hank', self: false, now: NOW },
  );
  assert.equal(bad.state, 'bad');
  const s = Object.fromEntries(bad.rows.map((r) => [r.key, r.state]));
  assert.deepEqual(s, { health: 'bad', versions: 'warn', disk: 'bad', memory: 'bad', cpu: 'bad', backups: 'bad', errors: 'bad', repair: 'warn', updates: 'bad' });
  assert.equal(row(bad, 'health').params?.n, 1);
  assert.equal(row(bad, 'errors').params?.n, 5);
  assert.equal(row(bad, 'repair').params?.n, 2);
  assert.equal(row(bad, 'updates').params?.latest, '3.23.0');
  assert.ok(bad.rows.every((r) => r.view === 'msgs'), 'a linked server links to its Messages chat (the help-pass report)');
  // Mild trouble is amber.
  const warn = serverCard(report({ health: { ok: true, disk: { freeBytes: 4 * GB, totalBytes: 100 * GB }, backups: { auto: true, count: 2, last: ago(24 * 4) }, checks: [] }, version: { server: '3.23.0', update: { state: 'available', latest: '3.23.1' } } }), { name: 'x', self: true, now: NOW });
  assert.deepEqual([row(warn, 'disk').state, row(warn, 'backups').state, row(warn, 'updates').state, warn.state], ['warn', 'warn', 'warn', 'warn']);
  // Old errors (more than a week) don't count.
  assert.equal(row(serverCard(report({ errors: { turns: [{ at: ago(24 * 10) }], tools: [], providers: [] } }), { name: 'x', self: true, now: NOW }), 'errors').state, 'ok');
  // No backups at all is red.
  assert.equal(row(serverCard(report({ health: { ok: true, disk: null, backups: { auto: false, count: 0, last: null }, checks: [] } }), { name: 'x', self: true, now: NOW }), 'backups').state, 'bad');
});

test('U5.34: what a system does not report is grey (unknown), never a guess; an unreachable server is grey too', () => {
  const win = serverCard(report({ system: { platform: 'win32', cpus: 8, load: null, memTotal: 32 * GB, memFree: 20 * GB }, health: { ok: true, disk: null, backups: { auto: true, count: 1, last: ago(1) }, checks: [] } }), { name: 'x', self: true, now: NOW });
  assert.equal(row(win, 'cpu').state, 'unknown');
  assert.equal(row(win, 'disk').state, 'unknown');
  assert.equal(win.state, 'ok', 'unknown rows do not make the card red');
  // An older server without the system/repair parts (before U5.34) still gets a card.
  const old = serverCard(report({ system: undefined, repair: undefined }), { name: 'x', self: false, now: NOW });
  assert.deepEqual([row(old, 'memory').state, row(old, 'cpu').state, row(old, 'repair').state], ['unknown', 'unknown', 'unknown']);
  const gone = serverCard(undefined, { name: 'Hank', self: false, now: NOW, error: 'not reachable' });
  assert.equal(gone.state, 'unknown');
  assert.equal(gone.error, 'not reachable');
  assert.equal(gone.rows.length, 0);
});

test('U5.34: /api/dashboard shows this server and, after Refresh, each linked server with an active help pass', async (t) => {
  const hank = await pairNode(t, 'Hank');
  const sam = await pairNode(t, 'Sam');
  const { aLink } = await linkPair(hank, sam);
  // No pass yet: Sam's dashboard has only Sam's own server, and the link is listed as not shared.
  const d0 = await sam.req('GET', '/api/dashboard');
  assert.equal(d0.servers.length, 1);
  assert.equal(d0.servers[0].self, true);
  assert.ok(['ok', 'warn', 'bad', 'unknown'].includes(d0.servers[0].state));
  assert.ok(d0.servers[0].rows.some((r: any) => r.key === 'memory' && r.state !== undefined));
  assert.deepEqual(d0.linked, []);
  // Hank gives Sam a help pass: Sam's Refresh reads Hank's redacted report.
  await hank.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  const d1 = await sam.req('POST', '/api/dashboard/refresh', {});
  assert.equal(d1.servers.length, 2);
  const h = d1.servers.find((c: any) => !c.self);
  assert.equal(h.name, 'Hank');
  assert.ok(h.rows.length >= 8);
  assert.ok(h.link);
  assert.ok(h.checkedAt);
  // The read is the S9b look (both sides see it in the help log), nothing new.
  assert.ok((await hank.req('GET', '/api/support')).log.some((r: any) => r.kind === 'look'));
  // A plain GET keeps the last remote card with its time (no new look).
  const looks = (await hank.req('GET', '/api/support')).log.filter((r: any) => r.kind === 'look').length;
  const d2 = await sam.req('GET', '/api/dashboard');
  assert.equal(d2.servers.find((c: any) => !c.self).checkedAt, h.checkedAt);
  assert.equal((await hank.req('GET', '/api/support')).log.filter((r: any) => r.kind === 'look').length, looks);
  // Revoked: the card goes away at the next refresh.
  const given = (await hank.req('GET', '/api/support')).given[0];
  await hank.req('DELETE', `/api/support/passes/${given.id}`);
  const d3 = await sam.req('POST', '/api/dashboard/refresh', {});
  assert.equal(d3.servers.length, 1);
});
