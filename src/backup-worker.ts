import { parentPort, workerData } from 'node:worker_threads';
import { autoBackupTick, createBackup } from './backup.ts';

try {
    const { dataDir, task } = workerData;
    const value = task.kind === 'manual'
        ? createBackup(dataDir, task.outFile, task.opts)
        : autoBackupTick(dataDir, task.cfg, task.now, task.version);
    parentPort?.postMessage({ ok: true, value });
} catch {
    // File paths, contents and raw operating-system errors never cross the worker boundary.
    parentPort?.postMessage({ ok: false });
} finally {
    parentPort?.close();
}
