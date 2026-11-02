// Phase 125 (2.58.0, SARA_STORE.md §9.5, H2): the Sara Store's checker on the hub's server. The hub
// writes jobs/<SUB>/{package.zip, job.json} and touches the queue file; a root-owned path unit starts
// this as its own user with no network (PrivateNetwork=yes), never from /tmp:
//   /opt/sara/node/bin/node /opt/sara/src/store/check-cli.ts --jobs /var/lib/sara-store-check/jobs
// For each job without a result.json it runs every check of `sara pack` (the same checks.ts as the
// author's computer and Sara's install) with the smoke test under bubblewrap when it works inside the
// unit, else under Node's permissions with the unit's PrivateNetwork as the fence (the report says
// which), and writes result.json for the hub to read. It never reads the hub's or Sara's data.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageError } from '../packages.ts';
import { packFiles, readStoreZip } from './pack.ts';
import { smokeFence } from './pack-cli.ts';
import type { Fence } from '../plugins/runtime.ts';

export interface JobResult {
  v: 1;
  submission: string;
  ready: boolean;
  by: string;
  fence: string;
  contentSha?: string;
  report?: unknown;
  error?: string;
}

/** Checks one job folder and writes its result.json (returns it too). */
export async function checkJob(dir: string, o: { saraVersion: string; fence?: Fence | false; readyMs?: number; watchMs?: number }): Promise<JobResult> {
  const by = `sara-store-check ${o.saraVersion}`;
  const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { submission?: string; kind?: string; sha256?: string; size?: number };
  const sub = String(job.submission ?? '');
  const fence: Fence | false = o.fence ?? smokeFence();
  const done = (r: Omit<JobResult, 'v' | 'submission' | 'by'>): JobResult => {
    const out: JobResult = { v: 1, submission: sub, by, ...r };
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify(out)}\n`);
    return out;
  };
  const zip = readFileSync(join(dir, 'package.zip'));
  if (job.sha256 && createHash('sha256').update(zip).digest('hex') !== job.sha256) return done({ ready: false, fence: String(fence), error: "The package doesn't match the hash it was sent with." });
  let files;
  try {
    files = readStoreZip(zip);
  } catch (err) {
    return done({ ready: false, fence: String(fence), error: err instanceof PackageError ? err.message : 'The package could not be read.' });
  }
  // The checker's own scratch folder, inside the job (never /tmp: it is noexec on the server).
  const scratch = join(dir, 'tmp');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const pack = await packFiles(files, { saraVersion: o.saraVersion, smoke: fence, scratch, ...(o.readyMs ? { readyMs: o.readyMs } : {}), ...(o.watchMs !== undefined ? { watchMs: o.watchMs } : {}) });
    if (job.kind && pack.report.kind !== job.kind) pack.report.results.push({ id: 'manifest', ok: false, warnings: [], problems: [`It was sent as a ${job.kind} but it is a ${pack.report.kind}.`] }), (pack.report.ready = false);
    return done({ ready: pack.report.ready, fence: pack.report.fence ?? (fence === false ? 'skipped' : fence), ...(pack.report.contentSha ? { contentSha: pack.report.contentSha } : {}), report: { ...pack.report, manifest: undefined } });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Every open job under `jobs/` (one at a time; a bad job never stops the others). */
export async function runJobs(jobsDir: string, o: { saraVersion: string; fence?: Fence | false; log?: (l: string) => void }): Promise<JobResult[]> {
  const out: JobResult[] = [];
  if (!existsSync(jobsDir)) return out;
  for (const name of readdirSync(jobsDir).sort()) {
    if (!/^SUB-\d{1,9}$/.test(name)) continue;
    const dir = join(jobsDir, name);
    if (existsSync(join(dir, 'result.json')) || !existsSync(join(dir, 'job.json')) || !existsSync(join(dir, 'package.zip'))) continue;
    try {
      const r = await checkJob(dir, o);
      o.log?.(`${name}: ${r.ready ? 'ready for review' : 'checks failed'} (${r.fence})`);
      out.push(r);
    } catch (err) {
      o.log?.(`${name}: the checker failed: ${(err as Error).message}`);
      writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ v: 1, submission: name, ready: false, by: `sara-store-check ${o.saraVersion}`, fence: 'none', error: 'The checker failed on this package.' })}\n`);
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--jobs');
  const jobs = i > 0 ? process.argv[i + 1] : '';
  if (!jobs) {
    console.log('Usage: node src/store/check-cli.ts --jobs /var/lib/sara-store-check/jobs');
    process.exit(2);
  }
  const { SARA_VERSION } = await import('../plugins/manager.ts');
  await runJobs(resolve(jobs), { saraVersion: SARA_VERSION, log: (l) => console.log(l) });
}
