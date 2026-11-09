import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('frozen source/archive/approved-host/evidence provenance verifier succeeds on exact qualified bytes',{skip:process.env.SARA_LOCALIZATION_FREEZE!=='1'},()=>{
 const r=spawnSync(process.execPath,['tools/developer-localization-qa/verify.ts'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.approvedEqualsSource,true);assert.equal(result.fixtureProvenance,true);
});
