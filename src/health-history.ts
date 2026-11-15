// Phase 30: health history for Settings → Privacy & system. A sample every 5 minutes while Sara runs
// (so gaps are downtime): problems logged, chat turns, failed turns, how long replies took to
// start, memory and disk. Kept 31 days, in sara.db. Read back per hour or per day.
import { freemem, loadavg } from 'node:os';
import { statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const SAMPLE_MS = 5 * 60_000;
const KEEP_DAYS = 31;

export interface HealthBucket {
  /** Start of the hour (or day), ISO. */
  t: string;
  /** Share of 5-minute slots Sara was running (0..1); null before the history began. */
  up: number | null;
  problems: number;
  turns: number;
  failed: number;
  /** Average time until a reply started (ms), null without turns. */
  replyMs: number | null;
  rssMb: number | null;
}

export class HealthHistory {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #problems: () => number;
  readonly #dataDir: string;
  #timer: NodeJS.Timeout | undefined;
  #turns = 0;
  #failed = 0;
  #replyMsSum = 0;
  #replyN = 0;
  #lastProblems = 0;

  constructor(db: DatabaseSync, opts: { now?: () => Date; problems?: () => number; dataDir: string }) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date());
    this.#problems = opts.problems ?? (() => 0);
    this.#dataDir = opts.dataDir;
    db.exec(`CREATE TABLE IF NOT EXISTS health_samples (
      t TEXT PRIMARY KEY,
      problems INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      reply_ms INTEGER,
      rss_mb INTEGER,
      load REAL,
      disk_free_gb REAL,
      mem_free_mb INTEGER
    )`);
  }

  /** A chat turn finished: when its reply started (ms), and whether it failed. */
  turn(firstTokenMs: number | null, failed: boolean): void {
    this.#turns++;
    if (failed) this.#failed++;
    if (firstTokenMs !== null) {
      this.#replyMsSum += firstTokenMs;
      this.#replyN++;
    }
  }

  start(): void {
    this.#lastProblems = this.#problems();
    this.sample();
    this.#timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Writes one sample (what happened since the last one) and drops old ones. */
  sample(): void {
    const now = this.#now();
    const slot = new Date(Math.floor(now.getTime() / SAMPLE_MS) * SAMPLE_MS).toISOString();
    const problems = this.#problems();
    let disk: number | null = null;
    try {
      const s = statfsSync(this.#dataDir);
      disk = Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
    } catch {
      /* not supported */
    }
    this.#db
      .prepare(
        `INSERT INTO health_samples (t, problems, turns, failed, reply_ms, rss_mb, load, disk_free_gb, mem_free_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(t) DO UPDATE SET problems = problems + excluded.problems, turns = turns + excluded.turns, failed = failed + excluded.failed,
           reply_ms = COALESCE(excluded.reply_ms, reply_ms), rss_mb = excluded.rss_mb, load = excluded.load, disk_free_gb = excluded.disk_free_gb, mem_free_mb = excluded.mem_free_mb`,
      )
      .run(
        slot,
        Math.max(0, problems - this.#lastProblems),
        this.#turns,
        this.#failed,
        this.#replyN ? Math.round(this.#replyMsSum / this.#replyN) : null,
        Math.round(process.memoryUsage().rss / 1048576),
        Math.round(loadavg()[0] * 100) / 100,
        disk,
        Math.round(freemem() / 1048576),
      );
    this.#lastProblems = problems;
    this.#turns = this.#failed = this.#replyMsSum = this.#replyN = 0;
    this.#db.prepare('DELETE FROM health_samples WHERE t < ?').run(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString());
  }

  /** The last `hours` hours per hour, or `days` days per day. */
  history(opts: { hours?: number; days?: number }): { buckets: HealthBucket[]; up: number } {
    const per = opts.days ? 86_400_000 : 3_600_000;
    const n = opts.days ?? opts.hours ?? 24;
    const now = this.#now().getTime();
    const end = Math.floor(now / per) * per + per;
    const start = end - n * per;
    const rows = this.#db.prepare('SELECT * FROM health_samples WHERE t >= ? ORDER BY t').all(new Date(start).toISOString()) as Record<string, number | string | null>[];
    // Time before the very first sample isn't downtime: there was no history yet.
    const firstRow = this.#db.prepare('SELECT min(t) AS t FROM health_samples').get() as { t: string | null };
    const first = firstRow.t ? Date.parse(firstRow.t) : now;
    const buckets: HealthBucket[] = [];
    let slotsUp = 0;
    let slotsAll = 0;
    for (let b = start; b < end; b += per) {
      const inB = rows.filter((r) => {
        const t = Date.parse(String(r.t));
        return t >= b && t < b + per;
      });
      // Only the slots since the history began, and up to now in the current bucket.
      const from = Math.max(b, Math.floor(first / SAMPLE_MS) * SAMPLE_MS);
      const to = Math.min(b + per, now + 1);
      const slots = to > from ? Math.max(1, Math.ceil((to - from) / SAMPLE_MS)) : 0;
      const up = slots ? Math.min(1, inB.length / slots) : null;
      slotsAll += slots;
      slotsUp += Math.min(inB.length, slots);
      const replies = inB.filter((r) => r.reply_ms !== null);
      const sum = (k: string) => inB.reduce((s, r) => s + Number(r[k] ?? 0), 0);
      buckets.push({
        t: new Date(b).toISOString(),
        up: up === null ? null : Math.round(up * 1000) / 1000,
        problems: sum('problems'),
        turns: sum('turns'),
        failed: sum('failed'),
        replyMs: replies.length ? Math.round(replies.reduce((s, r) => s + Number(r.reply_ms), 0) / replies.length) : null,
        rssMb: inB.length ? Math.round(sum('rss_mb') / inB.length) : null,
      });
    }
    return { buckets, up: slotsAll ? Math.round((slotsUp / slotsAll) * 1000) / 1000 : 0 };
  }
}
