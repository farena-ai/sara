// Local synthetic regression profile. It cannot target an installed server or owner data.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { OwnerAuth } from '../src/auth.ts';
import { restoreBackup } from '../src/backup.ts';
import { deliveryFor } from '../src/delivery.ts';
import { LibraryStore } from '../src/library/store.ts';
import { LibraryUploads } from '../src/library/uploads.ts';
import { Log } from '../src/log.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT } from '../test/helpers.ts';

export function parseQualificationArgs(args: string[]): { output: string } {
  if (!args.length) return { output: 'outputs/qualification/operations.json' };
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) throw new Error('Usage: node scripts/qualify-operations.ts [--output outputs/qualification/operations.json]');
  return { output: args[1] };
}

export function latencySummary(values: number[]): { count: number; p50Ms: number; p95Ms: number; maxMs: number } {
  if (!values.length || values.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Finite nonnegative latency samples required');
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1)! };
}

interface Evidence {
  requests: number; unexpectedErrors: number; p95Ms: number;
  eventLoopSamples: number; eventLoopP95Ms: number; rssGrowthBytes: number;
  seededTerminal: number; archived: number; unresolvedBefore: number; unresolvedAfter: number;
  backupVerified: boolean; uploadVerified: boolean; providerCalls: number;
}
export function evaluateQualification(e: Evidence): { passed: boolean; gates: Record<string, boolean> } {
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  const gates = {
    sampleSize: Number.isSafeInteger(e.requests) && e.requests >= 400,
    noUnexpectedErrors: e.unexpectedErrors === 0,
    metadataP95: finite(e.p95Ms) && e.p95Ms <= 500,
    loopLag: e.eventLoopSamples > 0 && finite(e.eventLoopP95Ms) && e.eventLoopP95Ms <= 100,
    memoryGrowth: finite(e.rssGrowthBytes) && e.rssGrowthBytes <= 256 * 1024 * 1024,
    archive: e.seededTerminal === 10000 && e.archived === e.seededTerminal,
    unresolvedPreserved: e.unresolvedBefore === 100 && e.unresolvedAfter === e.unresolvedBefore,
    backup: e.backupVerified === true,
    upload: e.uploadVerified === true,
    noProviderCalls: e.providerCalls === 0,
  };
  return { passed: Object.values(gates).every(Boolean), gates };
}

async function qualify(output: string): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), 'sara-q4-lab-'));
  const clock = { now: new Date() };
  const app = makeApp(data, clock);
  app.log = new Log(data);
  app.library = new LibraryStore(app.store.db, data, () => clock.now);
  const deliveries = deliveryFor(app);
  const auth = new OwnerAuth(data);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  let server: ReturnType<typeof createSaraServer> | undefined;
  const failures: string[] = [];
  let report: Record<string, unknown> = {};
  let failureStage = 'seed';
  let unexpectedErrors = 0;
  const latencies: number[] = [];
  const started = performance.now();
  try {
    const insert = app.store.db.prepare("INSERT INTO deliveries(id,bridge,operation,destination,logical_key,nonce,state,attempts,created_at,updated_at) VALUES(?,'telegram','sendMessage','777',?,?,'acknowledged',1,?,?)");
    const old = new Date(Date.now() - 90 * 86400000).toISOString();
    app.store.db.exec('BEGIN');
    try {
      for (let i = 0; i < 10000; i++) { const id = randomUUID(); insert.run(id, `fixture-ack-${i}`, id.replaceAll('-', '').slice(0, 25), old, old); }
      app.store.db.exec('COMMIT');
    } catch (err) { app.store.db.exec('ROLLBACK'); throw err; }
    const unresolvedIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = deliveries.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '777', logicalKey: `fixture-unresolved-${i}`, review: { text: `Synthetic review ${i}` } }).id;
      if (i % 2) { deliveries.attempt(id); deliveries.unknown(id); }
      unresolvedIds.push(id);
    }
    const unresolvedCount = () => Number(app.store.db.prepare("SELECT count(*) AS n FROM deliveries WHERE resolution IS NULL AND state!='acknowledged'").get()!.n);
    const before = unresolvedCount();
    const preparationMs = performance.now() - started;
    // Preparation is not a serving workload: start the monitor only once the fixture is seeded.
    server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version, revision: 'synthetic-q4-lab', startedAt: new Date().toISOString() } });
    const runningServer = server;
    failureStage = 'listen';
    await new Promise<void>((resolve, reject) => {
      runningServer.once('error', reject);
      runningServer.listen(0, '127.0.0.1', () => { runningServer.off('error', reject); resolve(); });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const liveStarted = performance.now();
    const headers = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
    async function request(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
      try {
        const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30000) });
        const body = await res.json() as Record<string, any>;
        if (!res.ok) throw new Error('Unexpected fixture HTTP status');
        return body;
      } catch {
        unexpectedErrors++;
        throw new Error('Fixture request failed');
      }
    }
    const rssBefore = process.memoryUsage().rss;
    failureStage = 'upload';
    // Exercise the real streamed upload path, without extraction/model calls.
    const uploadBytes = 8 * 1024 * 1024;
    const uploadStart = performance.now();
    const upload = await request('/library/uploads', { method: 'POST', body: JSON.stringify({ name: 'synthetic-load.txt', size: uploadBytes, learn: false }) });
    const uploadResult = await request(`/library/uploads/${upload.id}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(uploadBytes, 65) });
    const uploadState = await request(`/library/uploads/${upload.id}`);
    const completedUpload = new LibraryUploads(app.library.dir).finish(String(upload.id));
    const uploadVerified = uploadResult.received === uploadBytes && uploadState.received === uploadBytes && readFileSync(completedUpload.path).equals(Buffer.alloc(uploadBytes, 65));
    const uploadMs = performance.now() - uploadStart;

    failureStage = 'load';
    let issued = 0;
    const loadStart = performance.now();
    const paths = ['/health', '/operations', '/deliveries?limit=100', '/conversations'];
    const clients = Array.from({ length: 8 }, async () => {
      while (issued < 400) {
        const n = issued++;
        const t = performance.now();
        await request(paths[n % paths.length]);
        latencies.push(performance.now() - t);
      }
    });
    // Observe rejections immediately, then settle every worker before teardown or a failure report.
    const clientsDone = Promise.allSettled(clients);
    // Measure the real worker backup alongside metadata clients, separately from HTTP responsiveness.
    const backupStart = performance.now();
    let backupMs = 0;
    const backupDone = request('/backups', { method: 'POST', body: '{}' }).then(
      value => { backupMs = performance.now() - backupStart; return { ok: true as const, value }; },
      () => ({ ok: false as const }),
    );
    const [clientResults, backupResult] = await Promise.all([clientsDone, backupDone]);
    if (!backupResult.ok || clientResults.some(r => r.status === 'rejected')) throw new Error('Fixture workload failed');
    const backup = backupResult.value;
    const loadMs = performance.now() - loadStart;
    failureStage = 'archive';
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const preview = await request(`/deliveries/archive?before=${encodeURIComponent(cutoff)}`);
    let archived = 0;
    const archiveStart = performance.now();
    for (let batch = 0; batch < 21; batch++) {
      const result = await request('/deliveries/archive', { method: 'POST', body: JSON.stringify({ before: cutoff, limit: 500 }) });
      archived += result.archived;
      if (result.remaining === 0) break;
    }
    const archiveMs = performance.now() - archiveStart;
    const after = unresolvedCount();
    for (const id of unresolvedIds) {
      if (!deliveries.review(id).text.startsWith('Synthetic review ')) throw new Error('Unresolved encrypted review lost');
    }
    // Take the serving measurements before the deliberately offline restore verification below.
    const operations = await request('/operations');
    const liveWindowMs = performance.now() - liveStarted;
    const latency = latencySummary(latencies);
    const rssGrowthBytes = Math.max(0, process.resourceUsage().maxRSS * 1024 - rssBefore);
    // Restore to an isolated sibling directory; never replace the running fixture or owner data.
    failureStage = 'restore';
    const restoreStarted = performance.now();
    const restored = join(data, 'restored-verification');
    restoreBackup(join(data, 'backups', String(backup.name)), restored);
    const restoredDb = new DatabaseSync(join(restored, 'sara.db'));
    let backupVerified = false;
    try {
      backupVerified = Object.values(restoredDb.prepare('PRAGMA integrity_check').get()!)[0] === 'ok' &&
        Number(restoredDb.prepare("SELECT count(*) AS n FROM deliveries WHERE resolution IS NULL AND state!='acknowledged'").get()!.n) === 100;
    } finally { restoredDb.close(); }
    const restoreMs = performance.now() - restoreStarted;
    failureStage = 'report';
    const evidence: Evidence = { requests: latencies.length, unexpectedErrors, p95Ms: latency.p95Ms, eventLoopSamples: operations.process.eventLoop.sampleCount, eventLoopP95Ms: operations.process.eventLoop.p95Ms, rssGrowthBytes, seededTerminal: 10000, archived, unresolvedBefore: before, unresolvedAfter: after, backupVerified, uploadVerified, providerCalls: app.providerCalls };
    report = { profile: 'synthetic-loopback-v2-live', measurementWindow: 'live-upload-reads-backup-archive', version, at: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), cpuCount: cpus().length, totalMemoryBytes: totalmem() }, workload: { clients: 8, requests: 400, terminalRecords: 10000, unresolvedRecords: 100, uploadBytes, backupDuringLoad: true }, preparationMs, liveWindowMs, restoreMs, latency, loadMs, backupMs, uploadMs, archiveMs, previewEligible: preview.eligible, evidence, operations, result: evaluateQualification(evidence), limits: ['Synthetic metadata workload; no provider inference or external delivery.', 'HTTP latency is full-response time, not model TTFT.', 'Preparation and offline restore are outside the live measurement window; restore time is reported separately.', 'Engineering regression gates, not enterprise capacity/SLA or production RTO/RPO.', 'Fixture data retained in OS temporary storage; report contains no data path or credentials.'] };
    if (!(report.result as { passed: boolean }).passed) failures.push('Engineering qualification gate failed');
  } catch (err) {
    // Keep the failure category without accidentally copying a credential-bearing raw exception.
    failures.push(err instanceof Error && /^Fixture (GET|POST|PUT) \/[a-z/?=0-9_-]+ HTTP \d{3}$/.test(err.message) ? err.message : 'Qualification fixture failed; inspect retained synthetic fixture locally');
    report = { ...report, profile: 'synthetic-loopback-v2-live', version, failed: true, failureStage, partial: { requests: latencies.length, unexpectedErrors } };
  } finally {
    if (server) {
      const runningServer = server;
      runningServer.closeAllConnections();
      await new Promise<void>(r => runningServer.close(() => r()));
    }
    app.store.close();
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify({ ...report, durationMs: performance.now() - started, failures }, null, 2) + '\n');
  }
  if (failures.length) throw new Error(`Qualification failed; see ${output}`);
  console.log(JSON.stringify({ output, passed: true, durationMs: performance.now() - started }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = parseQualificationArgs(process.argv.slice(2));
  await qualify(opts.output);
}
