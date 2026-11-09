import test from 'node:test';import assert from 'node:assert/strict';
const mod='../store/plugins/data-contract-validator/engine.mjs';
test('Protobuf parses, validates payloads, checks numeric wire identity not field names',async()=>{
 const {analyze}=await import(mod);const before='syntax="proto3"; message Item { int32 id=1; string label=2; }';
 const run=(after:string,payloads=['{"id":-1,"label":"synthetic"}','{"id":2147483648}','{"id":"bad"}'])=>analyze({format:'protobuf',before,after,message:'Item',payloads});
 const same=run(before);assert.deepEqual(same.payloads.map((p:any)=>p.valid),[true,false,false]);assert.ok(same.payloads[0].wireBytes>0);assert.equal(same.compatible,true);
 assert.equal(run(before.replace('label=2','title=2')).compatible,true);
 assert.equal(run(before.replace('label=2','label=3')).compatible,false);
 assert.equal(run(before.replace('int32','sint32')).compatible,false);
 assert.equal(run(before.replace('string label','int32 label')).compatible,false);
 assert.equal(run(before.replace(' }',' bool active=3; }')).compatible,true);
 assert.throws(()=>run('syntax="proto3"; import "remote.proto"; message Item {int32 id=1;}'));
});
