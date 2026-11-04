import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBackup, inspectBackup, restoreBackup } from '../src/backup.ts';
import { Store } from '../src/store.ts';
import { deliveryFor } from '../src/delivery.ts';
import { JobManager } from '../src/jobs.ts';
import { JobRecoveryStore } from '../src/job-recovery.ts';
import { createCodingTools } from '../src/tools/coding.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

const SPACES = ['', 'companions/fixture-companion', 'members/0123456789', 'members/0123456789/companions/fixture-member-companion'];

test('Q3 backup: excluding workspaces covers owner, companion, member and member companion', () => {
  const { dir, cleanup } = tempDir();
  const source = join(dir, 'source');
  const stores: Store[] = [];
  try {
    for (const [i, rel] of SPACES.entries()) {
      const home = join(source, rel);
      mkdirSync(join(home, 'workspaces', 'fixture'), { recursive: true });
      writeFileSync(join(home, 'workspaces', 'fixture', 'must-not-be-exported.txt'), `workspace-${i}`);
      const store = new Store(join(home, 'sara.db'));
      stores.push(store);
      store.db.exec('CREATE TABLE q3_fixture_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      store.db.prepare('INSERT INTO q3_fixture_marker VALUES (1, ?)').run(`space-${i}`);
    }
    const file = join(dir, 'without-workspaces.tar.gz');
    createBackup(source, file, { includeWorkspaces: false, saraVersion: 'q3-fixture' });
    const names = inspectBackup(file).entries.map(e => e.path);
    assert.deepEqual(names.filter(n => /(^|\/)workspaces\//.test(n)), [], 'no space exports workspace files');
    for (const rel of SPACES) assert.ok(names.includes(rel ? `${rel}/sara.db` : 'sara.db'));
    const restored = join(dir, 'restored');
    restoreBackup(file, restored);
    for (const [i, rel] of SPACES.entries()) {
      const copy = new Store(join(restored, rel, 'sara.db'));
      try { assert.equal(copy.db.prepare('SELECT value FROM q3_fixture_marker').get()?.value, `space-${i}`); }
      finally { copy.close(); }
    }
  } finally { for (const s of stores) s.close(); cleanup(); }
});

test('Q3 all-space restore retains encrypted review, job intent and conservative interrupted states', () => {
  const { dir, cleanup } = tempDir();
  const source = join(dir, 'source');
  const apps: TestApp[] = [];
  const expected: { jobId: number; attempted: string; queued: string; acknowledged: string; command: string; review: string }[] = [];
  try {
    for (const [i, rel] of SPACES.entries()) {
      const home = join(source, rel);
      mkdirSync(home, { recursive: true });
      const app = makeApp(home, { now: new Date('2026-11-04T12:00:00Z') });
      apps.push(app);
      app.jobs = new JobManager(app, app.store.db);
      const conv = app.store.createConversation({ mode: 'coding', workspace: 'fixture', title: `Fixture ${i}` });
      const jobId = Number(app.store.db.prepare("INSERT INTO jobs(conversation_id,workspace,label,kind,status,started_at,tail) VALUES(?,?,?,'command','running',?,?)").run(conv.id, 'fixture', `Fixture job ${i}`, app.now().toISOString(), `Durable progress ${i}`).lastInsertRowid);
      const command = `echo original-q3-request-${i}`;
      new JobRecoveryStore(app, app.store.db).save(jobId, { conversationId: conv.id, workspace: 'fixture', label: 'Fixture', command: 'runtime command is not checkpoint data', timeoutMs: 120000, recoveryIntent: { kind: 'command', command }, budget: { tokens: 40000 } });
      const deliveries = deliveryFor(app);
      const review = `Preserved fixture review ${i}`;
      const descriptor = { bridge: 'telegram' as const, operation: 'sendMessage', destination: '777', review: { text: review } };
      const attempted = deliveries.enqueue(descriptor).id;
      deliveries.attempt(attempted);
      const queued = deliveries.enqueue(descriptor).id;
      const acknowledged = deliveries.enqueue(descriptor).id;
      deliveries.attempt(acknowledged);
      deliveries.acknowledge(acknowledged, ['9001']);
      const raw = JSON.stringify(app.store.db.prepare('SELECT * FROM deliveries').all()) + JSON.stringify(app.store.db.prepare('SELECT * FROM job_recovery').all());
      assert.equal(raw.includes(command), false);
      assert.equal(raw.includes(review), false);
      expected.push({ jobId, attempted, queued, acknowledged, command, review });
    }
    const archive = join(dir, 'all-spaces.tar.gz');
    createBackup(source, archive, { saraVersion: 'q3-fixture' });
    const restored = join(dir, 'restored-elsewhere');
    restoreBackup(archive, restored);
    for (const [i, rel] of SPACES.entries()) {
      const app = makeApp(join(restored, rel), { now: new Date('2026-11-04T12:00:05Z') });
      try {
        app.jobs = new JobManager(app, app.store.db);
        for (const tool of createCodingTools(app)) app.tools.add(tool);
        const e = expected[i];
        const job = app.jobs.get(e.jobId)!;
        assert.equal(job.status, 'interrupted');
        assert.equal(job.tail, `Durable progress ${i}`);
        assert.equal(app.jobs.running().length, 0);
        assert.ok(app.jobs.prepareRecovery(e.jobId).draft.includes(e.command));
        assert.equal(app.providerCalls, 0, 'review never invokes a model');
        const deliveries = deliveryFor(app);
        const rows = deliveries.list();
        assert.equal(rows.length, 3);
        assert.equal(rows.find(x => x.id === e.attempted)?.state, 'outcome_unknown');
        assert.equal(rows.find(x => x.id === e.queued)?.state, 'queued');
        assert.equal(rows.find(x => x.id === e.acknowledged)?.state, 'acknowledged');
        assert.equal(deliveries.review(e.attempted).text, e.review);
        assert.equal(deliveries.review(e.queued).text, e.review);
        assert.throws(() => deliveries.review(e.acknowledged), /unavailable/);
        assert.equal(rows.some(x => JSON.stringify(x).includes(e.review)), false);
      } finally { app.store.close(); }
    }
  } finally { for (const app of apps) app.store.close(); cleanup(); }
});
