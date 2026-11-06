import test from 'node:test';
import assert from 'node:assert/strict';
import { qualify } from '../tools/developer-execution-sandbox/qualify.ts';
const enabled = process.env.DEV_SANDBOX_QUALIFY === '1' && process.env.DEV_SANDBOX_FAULT_TEST === '1';
test('enumeration failure cannot bypass real job termination or original-root await', {skip:!enabled, timeout:120000}, async () => {
  const r = await qualify({optIn:'1',mode:'tree',fault:'enumerate'});
  assert.equal(r.status,'blocked');
  assert.equal(typeof r.native.rootIdentity.birthFileTime,'string','FILETIME recovery identity must survive JSON without numeric rounding');
  assert.equal(r.native.profileRegistry64Existed,true,JSON.stringify(r));
  assert.equal(r.native.profileFolderExisted,true);
  assert.equal(r.native.profileRegistryView,'Registry64');
  assert.ok(r.native.profileFolderPath);
  assert.ok(r.native.profileRegistryPath.endsWith(r.native.sid));
  assert.equal(r.native.jobTerminateSucceeded,true,JSON.stringify(r));
  assert.equal(r.native.rootExited,true);
  assert.equal(r.native.quiescenceVerified,true);
  assert.equal(r.native.handlesClosed,true);
  assert.equal(r.native.profileDeleted,true);
  assert.ok(r.native.cleanupErrors.some((e:string)=>e.includes('enumerate')));
});
test('multiple cleanup failures aggregate without suppressing real fallback closes and waits',{skip:!enabled,timeout:120000},async()=>{
 const r=await qualify({optIn:'1',mode:'tree',fault:'terminate-wait-close'}); const n=r.native;
 assert.equal(r.status,'blocked',JSON.stringify(r));
 assert.ok(n.cleanupErrors.some((e:string)=>e.includes('Injected terminate')));
 assert.ok(n.cleanupErrors.some((e:string)=>e.includes('Injected wait')));
 assert.ok(n.cleanupErrors.some((e:string)=>e.includes('Injected close-middle')));
 assert.equal(n.jobTerminateSucceeded,false); assert.equal(n.rootExited,true);
 assert.equal(n.quiescenceVerified,true); assert.equal(n.resourcesReleased,true);
 assert.equal(n.handlesClosed,true); assert.ok(n.observedWaits.every((v:boolean)=>v));
 assert.ok(n.observedHandleCloseResults.every((v:boolean)=>v));
});
for (const fault of ['open-first','open-later','birth','assignment-observer','terminate','wait','close-middle','unknown'] as const) {
 test(`native fault ${fault} preserves independent cleanup and exact recovery`, {skip:!enabled,timeout:120000}, async()=>{
  const r=await qualify({optIn:'1',mode:'tree',fault}); const n=r.native;
  assert.equal(r.status,'blocked',JSON.stringify(r));
  assert.equal(n.cleaned,false);
  assert.equal(n.resourcesReleased,true,JSON.stringify(r));
  assert.equal(n.rootExited,true); assert.equal(n.allObservedExited,true);
  assert.equal(n.handlesClosed,true); assert.equal(n.profileDeleted,true);
  assert.equal(n.observedHandleCloseResults.length,n.observedHandlesAcquired);
  assert.ok(n.observedHandleCloseResults.every((v:boolean)=>v));
  assert.ok(n.observedWaits.every((v:boolean)=>v));
  assert.ok(n.cleanupErrors.length>0);
  assert.equal(n.rootIdentity.authority,'original-creation-handle');
  assert.ok(n.rootIdentity.birthFileTime>0);
  assert.ok(n.identities.every((i:any)=>i.inOwnedJob===true));
  if(fault==='birth') assert.ok(n.observedHandlesAcquired>n.identities.length,'post-open birth failure handle must still be closed');
  if(fault==='close-middle') assert.ok(n.observedHandleCloseResults.length>=3,'later close must execute');
  if(fault==='assignment-observer') { assert.equal(n.unassignedTerminateSucceeded,true); assert.equal(r.nativeStarted,false); assert.match(n.error,/assignment-observer/); }
  if(fault==='terminate') { assert.equal(n.jobTerminateSucceeded,false); assert.ok(n.activeAfterCleanup>0); }
  if(fault==='unknown') {
   assert.equal(n.quiescenceVerified,false); assert.equal(n.profileRetained,true);
   assert.deepEqual(n.retentionReadback,{profileFolderExists:true,mappingExists:true,fixtureExists:true});
   assert.equal(n.testRecovery.exactOwnedHandlesAwaited,true); assert.equal(n.testRecovery.quiescenceVerified,true);
   assert.equal(n.recoveryIdentity.profileName,n.profileName);
  } else assert.equal(n.quiescenceVerified,true);
 });
}
