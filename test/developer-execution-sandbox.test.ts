import test from 'node:test';
import assert from 'node:assert/strict';

test('native fixture proves AppContainer identity, FS/network boundary and cleanup', { skip: process.env.DEV_SANDBOX_QUALIFY !== '1', timeout: 120_000 }, async () => {
  const { qualify } = await import(runnerUrl.href);
  const result = await qualify({ optIn: '1' });
  assert.equal(result.status, 'qualified', JSON.stringify(result));
  assert.equal(result.cleaned, true);
  assert.equal(result.boundary.outsideReadDenied, true);
  assert.equal(result.boundary.outsideWriteDenied, true);
  assert.equal(result.boundary.sourceWriteDenied, true);
  assert.equal(result.boundary.outputWriteAllowed, true);
  assert.equal(result.boundary.loopbackDenied, true);
  assert.equal(result.native.isAppContainer, true);
  assert.equal(result.native.capabilityCount, 0);
  assert.equal(result.native.inOwnedJob, true);
  assert.equal(result.native.profileDeleted, true);
  assert.equal(result.native.profileRegistry64Existed, true);
  assert.equal(result.native.profileFolderExisted, true);
  assert.equal(result.native.profileRegistryView, 'Registry64');
  assert.ok(result.native.profileFolderPath);
  assert.equal(result.native.rootIdentity.authority, 'original-creation-handle');
  assert.equal(result.native.quiescenceVerified, true);
  assert.equal(result.native.handlesClosed, true);
  assert.equal(result.native.activeAfterCleanup, 0);
});

test('native descendant job enforces active-process refusal and awaited PID/birth cleanup', { skip: process.env.DEV_SANDBOX_QUALIFY !== '1', timeout: 120_000 }, async () => {
  const { qualify } = await import(runnerUrl.href);
  const r = await qualify({optIn:'1', mode:'tree'});
  assert.equal(r.status, 'qualified', JSON.stringify(r));
  assert.equal(r.boundary.processLimitRefused, true);
  assert.equal(r.boundary.fixturePids.length, 3);
  assert.ok(r.boundary.fixturePids.every((pid: number) => r.native.identities.some((i: any) => i.pid === pid)));
  assert.equal(r.native.allObservedExited, true);
  assert.equal(r.native.activeAfterCleanup, 0);
  assert.equal(r.native.profileAbsentAfterDelete, true);
});

test('native wall deadline kills a live job without completion', { skip: process.env.DEV_SANDBOX_QUALIFY !== '1', timeout: 120_000 }, async () => {
  const { qualify } = await import(runnerUrl.href);
  const r = await qualify({optIn:'1', mode:'timeout'});
  assert.equal(r.status, 'qualified', JSON.stringify(r));
  assert.equal(r.native.timedOut, true);
  assert.ok(r.native.wallElapsedMs >= 1000 && r.native.wallElapsedMs < 5000);
  assert.equal(r.native.allObservedExited, true);
  assert.equal(r.cleaned, true);
});

test('native commit budget refuses an oversized fixture allocation', { skip: process.env.DEV_SANDBOX_QUALIFY !== '1', timeout: 120_000 }, async () => {
  const { qualify } = await import(runnerUrl.href);
  const r = await qualify({optIn:'1', mode:'memory'});
  assert.equal(r.status, 'qualified', JSON.stringify(r));
  assert.equal(r.boundary.memoryRefused, true);
  assert.equal(r.native.activeAfterCleanup, 0);
  assert.equal(r.cleaned, true);
});

const runnerUrl = new URL('../tools/developer-execution-sandbox/qualify.ts', import.meta.url);
test('execution sandbox refuses without explicit native opt-in', async () => {
  const module = await import(runnerUrl.href).catch(() => null);
  assert.ok(module, 'fixture sandbox runner must exist');
  const result = await module.qualify({ optIn: '0' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'DEV_SANDBOX_QUALIFY=1 required');
  assert.equal(result.nativeStarted, false);
});
