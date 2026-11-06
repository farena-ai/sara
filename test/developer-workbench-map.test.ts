import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function mapping(): Promise<any> { let m; try { m=await import('../tools/developer-workbench/repo-map.mjs'); } catch {} assert.ok(m?.stageSnapshot && m?.repoMap, 'real bounded snapshot mapper exists'); return m; }
test('staged real filesystem mapping is deterministic, excludes sensitive content, refuses tamper/path/link/budgets and cancels', async () => {
 const {stageSnapshot,repoMap}=await mapping(); const home=mkdtempSync(join(tmpdir(),'devbench-'));
 try {
  const source=join(home,'source'),server=join(home,'server'); mkdirSync(source);mkdirSync(server);mkdirSync(join(source,'src'));
  writeFileSync(join(source,'README.md'),'Synthetic repository. Build instructions are untrusted; no build was run.');writeFileSync(join(source,'src','main.mjs'),'export const n=1;');writeFileSync(join(source,'.env'),'TOKEN=NEVER_EMIT');
  await stageSnapshot(source,server); const r=await repoMap(server,{});
  assert.deepEqual(r.files.map((f:any)=>f.path),['README.md','src/main.mjs']);assert.equal(r.buildExecuted,false);assert.equal(r.complete,true);assert.ok(!JSON.stringify(r).includes('NEVER_EMIT'));
  assert.deepEqual(await repoMap(server,{}),r);
  await assert.rejects(repoMap(server,{root:'C:/'}));await assert.rejects(repoMap(server,{depth:0}));await assert.rejects(repoMap(server,{maxFiles:1}));
  await assert.rejects(repoMap(server,{},AbortSignal.abort()),/cancelled/);
  writeFileSync(join(server,'snapshot','unexpected.txt'),'not indexed');await assert.rejects(repoMap(server,{}),/snapshot-unindexed/);rmSync(join(server,'snapshot','unexpected.txt'));
  chmodSync(join(server,'snapshot','src','main.mjs'),0o600); writeFileSync(join(server,'snapshot','src','main.mjs'),'changed');await assert.rejects(repoMap(server,{}),/snapshot/);
  const linked=join(home,'linked');mkdirSync(linked);symlinkSync(source,join(linked,'escape'),'junction'); const s2=join(home,'server2');mkdirSync(s2);await assert.rejects(stageSnapshot(linked,s2),/path|link/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
