import { lstatSync, readFileSync } from 'node:fs';
import { openBusinessProfile } from './profile.ts';
import { createBusinessRuntime } from './runtime.ts';
import { restoreBusinessBackup } from './backup.ts';
import { configureBusinessModelsFile } from './model-config.ts';
import { businessRecoveryStatus, completeBusinessRecovery, issueBusinessReenrollment, reconcileBusinessRecovery, resumeBusinessSpending, resumeBusinessPause } from './recovery.ts';
import { inspectBusinessConfiguration } from './check.ts';

function localFile(path: string, maximum: number): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Invalid bounded operator input.');
  return readFileSync(path, 'utf8');
}
/** Explicit operator CLI is dispatched before personal startup; secrets are files, never argv values. */
export async function runBusinessCli(args: string[], env: NodeJS.ProcessEnv): Promise<number | void> {
  const [command, ...values] = args;
  if (command === '--business-check') {
    const report = inspectBusinessConfiguration(env, values);
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.status === 'blocked' ? 1 : 0;
  }
  if (!env.SARA_DATA || !command?.startsWith('--business-')) throw new Error('Explicit business data and command required.');
  // Reject unsupported command shapes before opening or initializing any data root.
  const valid = command === '--business-restore' ? values.length === 5 && values[1] === '--target' && values[3] === '--passphrase-file'
    : command === '--business-backup' ? values.length === 3 && values[1] === '--passphrase-file'
    : command === '--business-status' ? values.length === 0
    : command === '--business-reenroll' ? values.length === 1 || values.length === 2 && values[1] === '--reactivate'
    : ['--business-configure', '--business-reconcile', '--business-complete', '--business-resume-spending', '--business-resume-pause'].includes(command) && values.length === 1;
  if (!valid) throw new Error('Unknown business command or invalid arguments.');
  if (command === '--business-restore') {
    const manifest = await restoreBusinessBackup(values[0], values[2], localFile(values[4], 4096).trim());
    process.stdout.write(JSON.stringify({ generation: manifest.generation, recovery: 'reconciliation-required', spending: 'held' }) + '\n'); return;
  }
  const profile = openBusinessProfile(env.SARA_DATA);
  if (command === '--business-configure' && values.length === 1) { configureBusinessModelsFile(profile, values[0]); process.stdout.write('Business model policy saved. Provider keys remain in the business operator vault.\n'); return; }
  if (command === '--business-status' && values.length === 0) { process.stdout.write(JSON.stringify(businessRecoveryStatus(profile)) + '\n'); return; }
  if (command === '--business-reenroll' && (values.length === 1 || values.length === 2 && values[1] === '--reactivate')) {
    // This one-time individual secret is intentionally shown only to the invoking local operator.
    process.stdout.write(JSON.stringify(issueBusinessReenrollment(profile, values[0], values.length === 2)) + '\n'); return;
  }
  if (command === '--business-reconcile' && values.length === 1) { reconcileBusinessRecovery(profile, JSON.parse(localFile(values[0], 1024 * 1024))); process.stdout.write('Grant reconciliation saved; fresh individual passkey enrollment remains required.\n'); return; }
  if (command === '--business-complete' && values.length === 1) { completeBusinessRecovery(profile, values[0]); process.stdout.write('Explicit reconciled access enabled. Model spending remains held.\n'); return; }
  if (command === '--business-resume-spending' && values.length === 1) { resumeBusinessSpending(profile, JSON.parse(localFile(values[0], 4096))); process.stdout.write('Operator accepted preserved exposure. Held requests remain held and are never replayed.\n'); return; }
  if (command === '--business-resume-pause' && values.length === 1) { resumeBusinessPause(profile, JSON.parse(localFile(values[0], 4096))); process.stdout.write('Operator accepted the current spending pause. Held requests and charges remain unchanged; new admission is enabled.\n'); return; }
  if (command === '--business-backup' && values.length === 3 && values[1] === '--passphrase-file') {
    const runtime = createBusinessRuntime({ profile, origin: env.SARA_BUSINESS_ORIGIN ?? 'http://127.0.0.1:7860' });
    try { const manifest = await runtime.backup(values[0], localFile(values[2], 4096).trim()); process.stdout.write(JSON.stringify({ generation: manifest.generation, workspaces: manifest.workspaceIds.length }) + '\n'); }
    finally { await runtime.close(); }
    return;
  }
  throw new Error('Unknown business command or invalid arguments.');
}
