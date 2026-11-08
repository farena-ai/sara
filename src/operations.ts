// Bounded local HTTP measurements. No request data is retained beyond fixed route families.
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './chat.ts';
import { listBackups } from './backup.ts';

type Status = 'ready' | 'not_configured' | 'unavailable' | 'unknown';
type RequestLog = { requestId: string; family: string; status: number; durationMs: number };
const FAMILIES = ['health', 'operations', 'conversations', 'settings', 'deliveries', 'jobs', 'team', 'models', 'status', 'pending'] as const;
const STATES = {
  pending: ['waiting', 'taken', 'moved', 'dropped', 'stale'],
  jobs: ['running', 'ok', 'failed', 'stopped', 'interrupted', 'budget'],
  teams: ['planning', 'running', 'waiting', 'done', 'failed', 'stopped', 'limit', 'interrupted'],
  deliveries: ['queued', 'attempted', 'acknowledged', 'failed', 'outcome_unknown'],
} as const;

export function operationFamily(target: string): string {
  const path = target.split('?')[0];
  const family = /^\/api\/([a-z-]+)(?:\/|$)/.exec(path)?.[1];
  return FAMILIES.includes(family as typeof FAMILIES[number]) ? family! : 'other';
}

const finite = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
const percentile = (samples: number[], p: number) => samples.length
  ? samples[Math.max(0, Math.ceil(samples.length * p) - 1)] : 0;

export class OperationsMonitor {
  readonly #since = new Date().toISOString();
  readonly #lag = monitorEventLoopDelay({ resolution: 20 });
  readonly #clock: () => number;
  readonly #log: (line: RequestLog) => void;
  readonly #families: Record<string, number> = Object.fromEntries([...FAMILIES, 'other'].map(key => [key, 0]));
  #closed = false;
  #samples: number[] = [];
  #total = 0;
  #inFlight = 0;
  #peak = 0;
  #client = 0;
  #server = 0;
  #aborted = 0;

  constructor(options: { clock?: () => number; log?: (line: RequestLog) => void } = {}) {
    this.#clock = options.clock ?? (() => performance.now());
    this.#log = options.log ?? (line => console.info(JSON.stringify(line)));
    this.#lag.enable();
  }

  track(req: IncomingMessage, res: ServerResponse): void {
    const requestId = randomUUID();
    const family = operationFamily(req.url ?? '/');
    const start = this.#clock();
    res.setHeader('X-Request-Id', requestId);
    this.#inFlight++;
    this.#peak = Math.max(this.#peak, this.#inFlight);
    let completed = false;
    const complete = (aborted: boolean) => {
      if (completed) return;
      completed = true;
      res.off('finish', finish);
      res.off('close', close);
      const durationMs = finite(this.#clock() - start);
      const status = aborted ? 0 : res.statusCode;
      this.#inFlight--;
      this.#total++;
      this.#families[family]++;
      if (aborted) this.#aborted++;
      else if (status >= 500) this.#server++;
      else if (status >= 400) this.#client++;
      this.#samples.push(durationMs);
      if (this.#samples.length > 512) this.#samples.shift();
      try {
        this.#log({ requestId, family, status, durationMs });
      } catch {
        /* Logging must not break response completion. */
      }
    };
    const finish = () => complete(false);
    const close = () => complete(!res.writableFinished);
    res.once('finish', finish);
    res.once('close', close);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#lag.disable();
    }
  }

  snapshot(app: AppContext) {
    const samples = [...this.#samples].sort((a, b) => a - b);
    const sampledAt = new Date();
    const settings = app.settings.get();
    const selectedProvider = settings.providers.find(provider => provider.id === settings.defaultProviderId);
    const selectedModel = settings.defaultModel ?? selectedProvider?.defaultModel;
    let database: { status: Status } = { status: 'unavailable' };
    let databaseBytes: number | null = null;
    try {
      app.store.db.prepare('SELECT 1').get();
      database = { status: 'ready' };
      const pages = app.store.db.prepare('PRAGMA page_count').get() as { page_count: number };
      const size = app.store.db.prepare('PRAGMA page_size').get() as { page_size: number };
      databaseBytes = finite(Number(pages.page_count) * Number(size.page_size));
    } catch {
      /* Missing evidence remains unavailable. */
    }

    let storage: { status: Status; freeBytes: number | null; totalBytes: number | null } = {
      status: 'unavailable', freeBytes: null, totalBytes: null,
    };
    try {
      const disk = statfsSync(app.dataDir);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
        storage = { status: freeBytes > 1e9 ? 'ready' : 'unavailable', freeBytes: finite(freeBytes), totalBytes: finite(totalBytes) };
      }
    } catch {
      /* Unsupported filesystem probes are not readiness evidence. */
    }

    let configured = 0;
    let running = 0;
    for (const name of ['telegram', 'discord'] as const) {
      if (!settings[name]?.enabled) continue;
      configured++;
      try {
        if (app.bridges?.[name]?.status().running) running++;
      } catch {
        /* No running evidence. */
      }
    }
    const bridges = {
      status: (configured === 0 ? 'not_configured' : running === configured ? 'ready' : 'unavailable') as Status,
      configured, running,
    };
    let count = 0;
    let lastCreatedAt: string | null = null;
    let backupStatus: Status = 'unavailable';
    try {
      const backups = listBackups(app.rootDir ?? app.dataDir);
      count = backups.length;
      lastCreatedAt = backups[0]?.createdAt ?? null;
      backupStatus = count ? 'ready' : 'unavailable';
    } catch {
      /* No backup evidence. */
    }
    const offsite = settings.offsite;
    const lastTest = offsite?.lastTest;
    const testTime = lastTest && typeof lastTest.at === 'string' ? Date.parse(lastTest.at) : NaN;
    const validTestTime = Number.isFinite(testTime) && testTime <= sampledAt.getTime();
    const offsiteRestore = {
      status: (!offsite || offsite.kind === 'off' ? 'not_configured'
        : !lastTest ? 'unknown' : lastTest.ok && validTestTime ? 'ready' : 'unavailable') as Status,
      lastTestAt: validTestTime ? new Date(testTime).toISOString() : null,
    };

    const queue = (table: string, column: string, allowed: readonly string[]) => {
      const states: Record<string, number> = Object.fromEntries([...allowed, 'unknown'].map(s => [s, 0]));
      let status: 'ready' | 'unavailable' = 'ready';
      let total = 0;
      try {
        if (app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          // Table and column names are constants; row state values never become output keys.
          const rows = app.store.db.prepare(`SELECT ${column} AS state, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all();
          for (const row of rows) {
            const n = finite(Number(row.n));
            const key = allowed.includes(String(row.state)) ? String(row.state) : 'unknown';
            states[key] += n;
            total += n;
          }
        }
      } catch {
        status = 'unavailable';
      }
      return { status, total, states };
    };
    return {
      scope: 'current-server' as const,
      coverage: 'http-responses' as const,
      since: this.#since,
      sampledAt: sampledAt.toISOString(),
      requests: {
        total: this.#total, inFlight: this.#inFlight, peakInFlight: this.#peak,
        sampleCount: samples.length, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95),
        maxMs: samples.at(-1) ?? 0, clientErrors: this.#client, serverErrors: this.#server,
        aborted: this.#aborted, families: { ...this.#families },
      },
      process: {
        scope: 'process-wide' as const,
        rssBytes: process.memoryUsage().rss,
        // EC18: cumulative CPU time of this process (scripts/load-test.ts turns it into a percentage).
        cpu: { userMs: Math.round(process.cpuUsage().user / 1000), systemMs: Math.round(process.cpuUsage().system / 1000) },
        eventLoop: {
          sampleCount: finite(this.#lag.count),
          p95Ms: this.#lag.count ? finite(this.#lag.percentile(95) / 1e6) : 0,
          maxMs: this.#lag.count ? finite(this.#lag.max / 1e6) : 0,
        },
      },
      readiness: {
        database, storage,
        model: { status: (selectedProvider && selectedModel ? 'ready' : 'not_configured') as Status, configuredOnly: true },
        bridges,
        backup: { status: backupStatus, count, lastCreatedAt, scope: 'server-data' as const, offsiteRestore },
      },
      queues: {
        pending: queue('pending_inputs', 'state', STATES.pending),
        jobs: queue('jobs', 'status', STATES.jobs),
        teams: queue('team_tasks', 'status', STATES.teams),
        deliveries: queue('deliveries', 'state', STATES.deliveries),
        databaseBytes,
      },
    };
  }
}
