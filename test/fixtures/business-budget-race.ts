import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { BusinessBudget, type BusinessBudgetBounds, type BusinessRequestKey } from '../../src/business/budget.ts';

const data = workerData as { path: string; key: BusinessRequestKey; bounds: BusinessBudgetBounds };
const db = new DatabaseSync(data.path); const budget = new BusinessBudget(db);
parentPort!.once('message', () => {
  try { budget.reserve(data.key, data.bounds); parentPort!.postMessage({ admitted: true }); }
  catch { parentPort!.postMessage({ admitted: false }); }
  finally { db.close(); }
});
parentPort!.postMessage({ ready: true });
