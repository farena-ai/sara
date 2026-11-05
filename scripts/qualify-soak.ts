// Finite manual qualification only: fresh synthetic loopback data, never an installed server.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { restoreBackup } from '../src/backup.ts';
import { awaitBackupJobs } from '../src/backup-async.ts';
import { deliveryFor } from '../src/delivery.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT } from '../test/helpers.ts';
import { latencySummary } from './qualify-operations.ts';

export function assertSoakRecovery(db: DatabaseSync, expected: readonly Record<string, unknown>[]): void {
  assert.equal(expected.length, 100);
  for (const row of expected) { assert.equal(row.state, 'outcome_unknown'); assert.equal(row.resolution, null); assert.equal(row.archived_at, null); }
  const actual = db.prepare("SELECT * FROM deliveries WHERE logical_key LIKE 'soak-unknown-%' ORDER BY id").all();
  assert.deepEqual(actual, expected, 'All unresolved state, ciphertext, identity and retry metadata must survive');
  assert.equal(db.prepare("SELECT count(*) AS n FROM deliveries WHERE resolution IS NULL AND state='outcome_unknown' AND archived_at IS NULL").get()!.n, 100);
}

export function parseSoakArgs(args: string[]): { output: string } {
  if (!args.length) return { output: 'outputs/qualification/soak.json' };
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) throw new Error('Usage: node scripts/qualify-soak.ts [--output outputs/qualification/soak.json]');
  return { output: args[1] };
}

interface SoakEvidence {
  durationMs: number;
  windows: { requests: number; p95Ms: number }[];
  unexpectedErrors: number;
  eventLoopSamples: number;
  eventLoopP95Ms: number;
  rssGrowthBytes: number;
  backups: number;
  restored: number;
  unresolvedPreserved: boolean;
  payloadVerified: boolean;
  providerCalls: number;
}

export function evaluateSoak(e: SoakEvidence): { passed: boolean; gates: Record<string, boolean> } {
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  const gates = {
    duration: finite(e.durationMs) && e.durationMs >= 600000,
    coverage: e.windows.length === 10 && e.windows.every(w => Number.isSafeInteger(w.requests) && w.requests >= 100),
    windowLatency: e.windows.length === 10 && e.windows.every(w => finite(w.p95Ms) && w.p95Ms <= 500),
    errors: e.unexpectedErrors === 0,
    lag: Number.isSafeInteger(e.eventLoopSamples) && e.eventLoopSamples > 0 && finite(e.eventLoopP95Ms) && e.eventLoopP95Ms <= 100,
    memory: finite(e.rssGrowthBytes) && e.rssGrowthBytes <= 256 * 1024 ** 2,
    recovery: Number.isSafeInteger(e.backups) && e.backups >= 10 && e.restored === e.backups && e.unresolvedPreserved && e.payloadVerified,
    provider: e.providerCalls === 0,
  };
  return { passed: Object.values(gates).every(Boolean), gates };
}

async function qualifySoak(output: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sara-post-q4-soak-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const app = makeApp(source, { now: new Date() });
  const auth = new OwnerAuth(source);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const windows: number[][] = Array.from({ length: 10 }, () => []);
  const rssSamples: { elapsedMs: number; bytes: number }[] = [];
  const backups: { name: string; marker: number; durationMs: number }[] = [];
  const restores: { marker: number; durationMs: number }[] = [];
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  let unexpectedErrors = 0;
  let stage = 'seed';
  let passed = false;
  let report: Record<string, unknown> = {};
  let sampler: ReturnType<typeof setInterval> | undefined;
  let sourceClosed = false;
  const startedAt = new Date().toISOString();
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    const payload = randomBytes(16 * 1024 ** 2);
    const payloadHash = hash(payload);
    writeFileSync(join(source, 'synthetic-payload.bin'), payload);
    app.store.db.exec('CREATE TABLE soak_marker(value INTEGER); INSERT INTO soak_marker VALUES(0)');
    const deliveries = deliveryFor(app);
    const old = '2020-01-01T00:00:00.000Z';
    const insert = app.store.db.prepare("INSERT INTO deliveries(id,bridge,operation,destination,logical_key,nonce,state,attempts,created_at,updated_at) VALUES(?,'telegram','sendMessage','777',?,?,'acknowledged',1,?,?)");
    app.store.db.exec('BEGIN');
    try {
      for (let i = 0; i < 10000; i++) { const id = randomUUID(); insert.run(id, `soak-ack-${i}`, id.replaceAll('-', '').slice(0, 25), old, old); }
      app.store.db.exec('COMMIT');
    } catch (error) { app.store.db.exec('ROLLBACK'); throw error; }
    const unresolved: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = deliveries.enqueue({ bridge: 'discord', operation: 'sendMessage', destination: '888', logicalKey: `soak-unknown-${i}`, review: { text: `Synthetic soak uncertainty ${i}` } }).id;
      deliveries.attempt(id); deliveries.unknown(id); unresolved.push(id);
    }
    const expectedUnresolved = app.store.db.prepare("SELECT * FROM deliveries WHERE logical_key LIKE 'soak-unknown-%' ORDER BY id").all();
    for (let i = 0; i < 20; i++) assert.equal(deliveries.archive('2021-01-01T00:00:00.000Z').archived, 500);
    stage = 'listen';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const headers = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
    async function request(path: string, init: RequestInit = {}): Promise<any> {
      try {
        const response = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Unexpected fixture status');
        return await response.json();
      } catch { unexpectedErrors++; throw new Error('Synthetic soak request failed'); }
    }
    const liveStarted = performance.now();
    const rssBefore = process.memoryUsage().rss;
    const sample = () => rssSamples.push({ elapsedMs: performance.now() - liveStarted, bytes: process.memoryUsage().rss });
    sample(); sampler = setInterval(sample, 1000);
    histogram.enable();
    stage = 'live';
    let stop = false;
    const stopping = new AbortController();
    const stopClients = () => { stop = true; stopping.abort(); };
    const paths = ['/health', '/operations', '/deliveries?filter=archived&limit=100', '/conversations'];
    const clients = Array.from({ length: 8 }, (_, client) => (async () => {
      let n = client;
      try {
        while (!stop && performance.now() - liveStarted < 600000) {
          const issued = performance.now();
          await request(paths[n++ % paths.length]);
          const elapsed = performance.now() - liveStarted;
          // Assign the response to its issue window; never manufacture an extra idle window.
          windows[Math.min(9, Math.floor((issued - liveStarted) / 60000))].push(performance.now() - issued);
          if (elapsed < 600000) await delay(200);
        }
      } catch (error) { stopClients(); throw error; }
    })());
    // Observe all failures immediately and settle workers before touching their database.
    const clientResults = Promise.allSettled(clients);
    const backupResults = (async () => {
      try {
        for (let marker = 0; marker < 10 && !stop; marker++) {
          const until = liveStarted + marker * 60000 - performance.now();
          if (until > 0) await delay(until, undefined, { signal: stopping.signal });
          if (stop) break;
          app.store.db.prepare('UPDATE soak_marker SET value=?').run(marker);
          const start = performance.now();
          const backup = await request('/backups', { method: 'POST', body: '{}' });
          backups.push({ name: backup.name, marker, durationMs: performance.now() - start });
        }
        return true;
      } catch { stopClients(); return false; }
    })();
    const [results, backupOk] = await Promise.all([clientResults, backupResults]);
    histogram.disable(); clearInterval(sampler); sampler = undefined; sample();
    const liveDurationMs = performance.now() - liveStarted;
    const rssPeakSampled = Math.max(...rssSamples.map(s => s.bytes));
    const summaries = windows.map(samples => samples.length ? { requests: samples.length, ...latencySummary(samples) } : { requests: 0, p50Ms: NaN, p95Ms: NaN, maxMs: NaN });
    report = { profile: 'synthetic-loopback-ten-minute-v1', version, startedAt,
      environment: { node: process.version, platform: platform(), arch: arch() },
      workload: { clients: 8, paceMs: 200, durationTargetMs: 600000, terminalRecords: 10000, unresolvedRecords: 100, payloadBytes: payload.length },
      liveDurationMs, windows: summaries, rssBefore, rssPeakSampled, processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024, rssSamples,
      loop: { samples: histogram.count, p95Ms: histogram.count ? histogram.percentile(95) / 1e6 : NaN, maxMs: histogram.max / 1e6 }, backups };
    if (!backupOk || results.some(r => r.status === 'rejected')) throw new Error('Synthetic soak live failure');
    stage = 'restore';
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    app.store.close(); sourceClosed = true;
    for (const backup of backups) {
      const start = performance.now();
      const target = join(root, `restore-${backup.marker}`);
      restoreBackup(join(source, 'backups', backup.name), target);
      const copy = makeApp(target, { now: new Date() });
      try {
        assert.equal(Object.values(copy.store.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
        assert.equal(copy.store.db.prepare('SELECT value FROM soak_marker').get()!.value, backup.marker);
        assert.equal(hash(readFileSync(join(target, 'synthetic-payload.bin'))), payloadHash);
        const restoredDeliveries = deliveryFor(copy);
        assertSoakRecovery(copy.store.db, expectedUnresolved);
        assert.equal(copy.store.db.prepare('SELECT count(*) AS n FROM deliveries WHERE archived_at IS NOT NULL').get()!.n, 10000);
        for (const [i, id] of unresolved.entries()) assert.equal(restoredDeliveries.review(id).text, `Synthetic soak uncertainty ${i}`);
        assert.throws(() => restoredDeliveries.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '777', logicalKey: 'soak-ack-0' }));
        assert.equal(copy.providerCalls, 0);
        restores.push({ marker: backup.marker, durationMs: performance.now() - start });
      } finally { copy.store.close(); }
    }
    const evidence: SoakEvidence = { durationMs: liveDurationMs, windows: summaries, unexpectedErrors, eventLoopSamples: histogram.count, eventLoopP95Ms: histogram.percentile(95) / 1e6, rssGrowthBytes: Math.max(0, rssPeakSampled - rssBefore), backups: backups.length, restored: restores.length, unresolvedPreserved: true, payloadVerified: true, providerCalls: app.providerCalls };
    const result = evaluateSoak(evidence);
    report = { ...report, restores, evidence, result };
    passed = result.passed;
  } catch {
    report = { ...report, failed: true, failureStage: stage, unexpectedErrors, completedBackups: backups.length, completedRestores: restores.length };
  } finally {
    histogram.disable(); if (sampler) clearInterval(sampler);
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    // Aborting an HTTP backup request does not cancel an accepted worker snapshot.
    await awaitBackupJobs();
    if (!sourceClosed) app.store.close();
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify({ ...report, passed, limits: ['Ten-minute paced metadata lab, not production SLA/capacity or a long-duration soak.', 'No real inference, external sends, production data, restore or service changes.', 'Offline restores are excluded from the live lag/latency window.', 'Synthetic fixtures retained in OS temporary storage for diagnosis.'] }, null, 2) + '\n');
  }
  if (!passed) throw new Error(`Soak qualification failed; see ${output}`);
  console.log(JSON.stringify({ output, passed }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await qualifySoak(parseSoakArgs(process.argv.slice(2)).output);
