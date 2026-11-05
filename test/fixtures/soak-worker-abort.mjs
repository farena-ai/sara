// Child-only fault injection: HTTP cancellation does not cancel accepted worker work.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';

let online = false;
let exited = false;
const NativeWorker = workerThreads.Worker;
// Backup workers deliberately clear execArgv. Inject the delay explicitly in this child only.
workerThreads.Worker = class extends NativeWorker {
  constructor(file, options) {
    super(file, { ...options, execArgv: [...(options?.execArgv ?? []), '--import', new URL('./soak-worker-delay.mjs', import.meta.url).href] });
    this.on('online', () => { online = true; });
    this.on('exit', () => { exited = true; });
  }
};
const write = fs.writeFileSync;
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync = function (file, data, ...args) {
  if (String(file) === output) {
    const report = JSON.parse(String(data));
    data = JSON.stringify({ ...report, fixtureWorkerOnline: online, fixtureWorkerExitObserved: exited });
  }
  return write.call(this, file, data, ...args);
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/api/backups') return originalFetch(input, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try { return await originalFetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};
