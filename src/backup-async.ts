import { realpath } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { BackupManifest, BackupSettings } from './backup.ts';

type BackupOptions = { saraVersion?: string; includeWorkspaces?: boolean; now?: Date };
type Task = { kind: 'manual'; outFile: string; opts: BackupOptions } | { kind: 'auto'; cfg: BackupSettings; now: Date; version: string };
const queues = new Map<string, Promise<unknown>>();
const jobs = new Set<Promise<unknown>>();
let closing = false;

function enqueue<T>(dataDir: string, task: Task): Promise<T> {
    if (closing) return Promise.reject(new Error('BACKUP_SHUTTING_DOWN'));
    const job = canonicalQueue<T>(dataDir, task);
    jobs.add(job);
    void job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
}

async function canonicalQueue<T>(dataDir: string, task: Task): Promise<T> {
    let root: string;
    try { root = await realpath(dataDir); }
    catch { throw new Error('BACKUP_FAILED'); }
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const previous = queues.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => runWorker<T>(root, task));
    queues.set(key, job);
    try { return await job; }
    finally { if (queues.get(key) === job) queues.delete(key); }
}

function runWorker<T>(dataDir: string, task: Task): Promise<T> {
    return new Promise((resolve, reject) => {
        // Workers use Node's native TypeScript support, without parent test/watch/eval flags.
        const worker = new Worker(new URL('./backup-worker.ts', import.meta.url), { workerData: { dataDir, task }, execArgv: [] });
        let result: { ok: boolean; value?: T } | undefined;
        let invalid = false;
        worker.on('message', (message: unknown) => {
            if (result || !message || typeof message !== 'object' || !('ok' in message)) { invalid = true; return; }
            const m = message as { ok: unknown; value?: unknown };
            const value = m.value;
            const valid = task.kind === 'auto'
                ? value === undefined || (typeof value === 'string' && /^sara-[\w-]+-auto\.tar\.gz$/.test(value))
                : !!value && typeof value === 'object' && 'format' in value && value.format === 'sara-backup'
                    && 'files' in value && Number.isInteger(value.files) && Number(value.files) >= 0
                    && 'version' in value && value.version === 1
                    && 'createdAt' in value && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
                    && 'saraVersion' in value && typeof value.saraVersion === 'string'
                    && 'includesWorkspaces' in value && typeof value.includesWorkspaces === 'boolean';
            if (typeof m.ok !== 'boolean' || (m.ok && !valid)) invalid = true;
            result = { ok: m.ok === true, value: value as T };
        });
        worker.once('error', () => { invalid = true; });
        // Settle only after exit, so the next job cannot overlap temp files or cleanup.
        worker.once('exit', code => {
            if (code !== 0 || invalid || !result?.ok) reject(new Error('BACKUP_FAILED'));
            else resolve(result.value as T);
        });
    });
}

export function createBackupAsync(dataDir: string, outFile: string, opts: BackupOptions = {}): Promise<BackupManifest> {
    return enqueue(dataDir, { kind: 'manual', outFile, opts: { saraVersion: opts.saraVersion, includeWorkspaces: opts.includeWorkspaces, now: opts.now } });
}

export function asyncAutoBackupTick(dataDir: string, cfg: BackupSettings, now: Date, version: string): Promise<string | undefined> {
    return enqueue(dataDir, { kind: 'auto', cfg: { auto: cfg.auto, keep: cfg.keep }, now, version });
}

/** Let active/queued snapshots finish before shutdown can terminate their workers. */
export async function awaitBackupJobs(): Promise<void> {
    while (jobs.size) await Promise.allSettled([...jobs]);
}

/** Atomically refuse new snapshots before draining accepted work during process shutdown. */
export function beginBackupShutdown(): Promise<void> {
    closing = true;
    return awaitBackupJobs();
}
