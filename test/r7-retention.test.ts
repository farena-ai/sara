// R7: retention per kind also covers run history, older log files and inbox scans, on the same
// hourly check as chats, memories and files; a legal hold beats all of it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { DataRights, RETENTION_KINDS, setDataRights, type PersonSpace } from '../src/data-rights.ts';
import { InboxHelper } from '../src/inbox/helper.ts';
import { RunStore } from '../src/runs.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const DAY = 86_400_000;

function world() {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-15T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.runs = new RunStore(app.store.db, () => clock.now);
  app.inbox = new InboxHelper(app);
  const spaces = (): PersonSpace[] => [{ person: 'owner', name: 'Owner', dir, apps: () => [app] }];
  const rights = new DataRights(dir, { spaces, deleteMember: async () => {} }, () => clock.now);
  setDataRights(rights);
  const trail = new AuditTrail(dir, { key: () => 'k' });
  setAuditTrail(trail);
  const done = () => {
    setDataRights(undefined);
    setAuditTrail(undefined);
    app.store.close();
    cleanup();
  };
  return { dir, clock, app, rights, trail, done };
}

function seed(w: ReturnType<typeof world>) {
  const db = w.app.store.db;
  const old = new Date(w.clock.now.getTime() - 60 * DAY).toISOString();
  const fresh = new Date(w.clock.now.getTime() - 2 * DAY).toISOString();
  const runOld = w.app.runs!.open({ kind: 'turn', title: 'old run' });
  w.app.runs!.close(runOld, 'ok', 10, 0);
  const runNew = w.app.runs!.open({ kind: 'turn', title: 'new run' });
  w.app.runs!.close(runNew, 'ok', 10, 0);
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(old, runOld);
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(fresh, runNew);
  const item = (key: string, status: string, at: string) => db.prepare("INSERT INTO inbox_items (key, kind, status, account, mail_id, mail_from, mail_subject, mail_date, finding_json, attachments_json, created_at) VALUES (?, 'bill', ?, 'a', ?, 'x@example.com', 's', ?, '{}', '[]', ?)").run(key, status, key, at, at);
  item('old-done', 'done', old);
  item('old-waiting', 'pending', old);
  item('new-done', 'done', fresh);
  const logs = join(w.dir, 'logs');
  mkdirSync(logs, { recursive: true });
  for (const n of ['sara.log', 'sara.log.1', 'sara.log.2']) writeFileSync(join(logs, n), 'x\n');
  const t = new Date(w.clock.now.getTime() - 60 * DAY);
  utimesSync(join(logs, 'sara.log'), t, t);
  utimesSync(join(logs, 'sara.log.2'), t, t);
  return { runOld, runNew, logs };
}

const runIds = (w: ReturnType<typeof world>) => (w.app.store.db.prepare('SELECT id FROM runs ORDER BY id').all() as { id: number }[]).map((r) => r.id);
const inboxKeys = (w: ReturnType<typeof world>) => (w.app.store.db.prepare('SELECT key FROM inbox_items ORDER BY key').all() as { key: string }[]).map((r) => r.key);

test('retention kinds: runs, logs and inbox are new, off by default and strict', () => {
  const w = world();
  try {
    assert.deepEqual([...RETENTION_KINDS], ['chats', 'memories', 'files', 'runs', 'logs', 'inbox']);
    assert.deepEqual(w.rights.retention, { chats: 0, memories: 0, files: 0, runs: 0, logs: 0, inbox: 0 });
    seed(w);
    assert.equal(w.rights.runRetention().runs, 0);
    assert.equal(runIds(w).length, 2, 'nothing goes by default');
    assert.throws(() => w.rights.setRetention({ runs: 7 }), /Pick 30/);
    w.rights.setRetention({ runs: 30, logs: 30, inbox: 30 });
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'data-rights.json'), 'utf8')).retention, { chats: 0, memories: 0, files: 0, runs: 30, logs: 30, inbox: 30 });
    assert.ok(w.trail.list({ action: 'data.retention' })[0]!.keys!.includes('runs_30'));
  } finally {
    w.done();
  }
});

test('retention run: old runs, old finished inbox scans and old rotated logs go; the rest stays; audited', () => {
  const w = world();
  try {
    const s = seed(w);
    w.rights.setRetention({ runs: 30, logs: 30, inbox: 30 });
    const r = w.rights.runRetention();
    assert.equal(r.runs, 1);
    assert.deepEqual(runIds(w), [s.runNew]);
    assert.equal(r.inbox, 1);
    assert.deepEqual(inboxKeys(w), ['new-done', 'old-waiting'], 'a card still waiting stays');
    assert.equal(r.logs, 1);
    assert.ok(existsSync(join(s.logs, 'sara.log')), 'the current log is never cut');
    assert.ok(existsSync(join(s.logs, 'sara.log.1')), 'a recent old log stays');
    assert.ok(!existsSync(join(s.logs, 'sara.log.2')));
    const row = w.trail.list({ action: 'retention.run' })[0]!;
    assert.ok(row.keys!.includes('runs_1') && row.keys!.includes('logs_1') && row.keys!.includes('inbox_1'));
  } finally {
    w.done();
  }
});

test('legal hold: runs, inbox scans and logs are all kept', () => {
  const w = world();
  try {
    const s = seed(w);
    w.rights.setRetention({ runs: 30, logs: 30, inbox: 30 });
    w.rights.setHolds({ people: ['owner'] });
    const r = w.rights.runRetention();
    assert.equal(r.heldSpaces, 1);
    assert.equal(r.runs + r.inbox + r.logs, 0);
    assert.equal(runIds(w).length, 2);
    assert.equal(inboxKeys(w).length, 3);
    assert.ok(existsSync(join(s.logs, 'sara.log.2')));
  } finally {
    w.done();
  }
});

test('page: Retention and legal hold has the three new pick-lists, each with a tip', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['dr-runs', 'dr-logs', 'dr-inbox']) assert.match(html, new RegExp(`<select id="${id}">[\\s\\S]*?</select> <button type="button" class="tip" data-tip="[^"]{20,260}">\\?</button>`));
  assert.match(readFileSync(join(ROOT, 'web', 'data-rights.js'), 'utf8'), /const KINDS = \['chats', 'memories', 'files', 'runs', 'logs', 'inbox'\];/);
});
