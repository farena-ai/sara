// Manual synthetic qualification only; no dependency installation or owner-data target.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const limits = [
  'Fresh synthetic loopback profiles; actual Chromium with virtual WebAuthn. No owner data or inference/provider calls.',
  'Keyboard, narrow-screen and browser status/role assertions are engineering checks, not physical screen-reader or novice acceptance.',
  'Encrypted local archive and fresh-target closed restore only; not offsite custody, power-loss, workload capacity, production RPO/RTO or deployment proof.',
  'Source Node and Docker COPY recipe only. Actual packaged native runtimes and built multi-architecture images require separate release qualification.',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function names(values) {
  assert.ok(Array.isArray(values) && values.length > 0, 'Nonempty result list required');
  assert.ok(values.every(value => typeof value === 'string' && value.trim()), 'Every result needs a name');
  assert.equal(new Set(values).size, values.length, 'Duplicate result names are not complete evidence');
}
export function validateReceipt(kind, value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'JSON object required');
  if (kind === 'anonymous') {
    assert.deepEqual(value.initialFailures, [], 'Anonymous first-response failures must be empty'); return 0;
  }
  if (kind === 'onboarding') {
    names(value.results); assert.deepEqual(value.pageErrors, [], 'Browser page errors must be empty');
    assert.ok(typeof value.limits === 'string' && value.limits.length); return value.results.length;
  }
  if (kind === 'b2' || kind === 'b3') {
    assert.ok(Array.isArray(value.results), 'Results required');
    names(value.results.map(result => result?.name));
    assert.ok(value.results.every(result => result.pass === true && result.error === undefined), 'Every child result must pass');
    assert.deepEqual(value.errors, [], 'Browser page errors must be empty');
    if (kind === 'b2') assert.ok(typeof value.limits === 'string' && value.limits.length);
    else { assert.equal(value.isolated, true); assert.equal(value.closed, true); }
    return value.results.length;
  }
  if (kind === 'integration') {
    assert.equal(value.version, 1); assert.equal(value.pass, true);
    names(value.checks?.map(check => check?.id));
    assert.deepEqual(value.checks.map(check => check.id), ['readonly-cli', 'scoped-invites', 'encrypted-restore']);
    assert.ok(value.checks.every(check => check.pass === true), 'Every integration check must pass');
    assert.equal(value.checks[0].unchanged, true); assert.ok(value.checks[0].entries > 0);
    assert.equal(value.checks[1].denied, 6); assert.equal(value.checks[2].closed, true);
    assert.ok(Array.isArray(value.limits) && value.limits.length); return value.checks.length;
  }
  throw new Error('Unsupported receipt kind');
}

function artifact(output, path) {
  const bytes = readFileSync(path);
  return { file: relative(output, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) };
}
async function child(args, env, stdout, stderr) {
  const out = openSync(stdout, 'wx'), err = openSync(stderr, 'wx');
  try {
    return await new Promise(resolveChild => {
      let error;
      const processChild = spawn(process.execPath, args, { cwd: checkout, env, windowsHide: true, stdio: ['ignore', out, err], timeout: 180_000 });
      processChild.once('error', reason => { error = reason.message; });
      processChild.once('close', (exitCode, signal) => resolveChild({ exitCode, signal, ...(error ? { error } : {}) }));
    });
  } finally { closeSync(out); closeSync(err); }
}

export async function runSteps(outputPath, steps) {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  // Exclusive creation is the evidence boundary: every attempt gets its own directory.
  mkdirSync(output);
  const report = { version: 1, pass: false, node: process.version, platform: process.platform, steps: [], limits };
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  for (const step of steps) {
    assert.match(step.id, /^[a-z][a-z0-9-]*$/);
    const directory = join(output, step.id); mkdirSync(directory);
    const stdout = join(directory, 'stdout.log'), stderr = join(directory, 'stderr.log');
    const env = { ...process.env, [step.envName]: directory };
    const result = await child(step.args, env, stdout, stderr);
    const receipts = step.receipts.map(receipt => {
      const file = join(directory, receipt.file);
      let evidence = { file: relative(output, file).replaceAll('\\', '/'), exists: false, valid: false };
      try {
        const metadata = statSync(file); assert.ok(metadata.isFile() && metadata.size <= 1024 * 1024, 'Receipt must be a bounded regular file');
        evidence = { ...evidence, ...artifact(output, file), exists: true };
        let value;
        try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Invalid JSON receipt'); }
        return { ...evidence, valid: true, groups: validateReceipt(receipt.kind, value) };
      } catch (error) { return { ...evidence, error: error.message }; }
    });
    const pass = result.exitCode === 0 && !result.signal && !result.error && receipts.length > 0 && receipts.every(receipt => receipt.valid);
    report.steps.push({ id: step.id, command: [process.execPath, ...step.args], cwd: checkout,
      environment: { [step.envName]: directory, ...(process.env.SARA_PLAYWRIGHT_MODULE ? { SARA_PLAYWRIGHT_MODULE: process.env.SARA_PLAYWRIGHT_MODULE } : {}) },
      ...result, stdout: artifact(output, stdout), stderr: artifact(output, stderr), receipts, pass });
    save(); console.log(`${pass ? 'PASS' : 'FAIL'} ${step.id}`);
  }
  report.pass = report.steps.length > 0 && report.steps.every(step => step.pass); save(); return report;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--output' && args[1].trim(), 'Usage: node scripts/qualify-business-operations.mjs --output <new-run-directory>');
  const steps = [
    { id: 'b2-browser', args: ['scripts/qualify-business-b2.mjs'], envName: 'SARA_B2_OUTPUT', receipts: [{ file: 'results.json', kind: 'b2' }] },
    { id: 'b3-browser', args: ['scripts/qualify-business-invitations.mjs'], envName: 'SARA_B3_OUTPUT', receipts: [{ file: 'results.json', kind: 'b3' }] },
    { id: 'onboarding', args: ['scripts/qualify-business-onboarding.mjs'], envName: 'SARA_BUSINESS_BROWSER_OUTPUT', receipts: [{ file: 'onboarding-results.json', kind: 'onboarding' }, { file: 'anonymous-first-401-results.json', kind: 'anonymous' }] },
    { id: 'operator-recovery', args: ['test/fixtures/business-operations.ts'], envName: 'SARA_B4_OUTPUT', receipts: [{ file: 'results.json', kind: 'integration' }] },
  ];
  const report = await runSteps(args[1], steps);
  if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
