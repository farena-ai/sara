import test from 'node:test';import assert from 'node:assert/strict';
const module='../store/plugins/data-contract-validator/engine.mjs';
test('Detect breaking JSON Schema or Protobuf fixture changes and invalid payloads',async()=>{
 const e=await import(module).catch(()=>null);assert.ok(e?.analyze,'real contract feature exists');
 const before={type:'object',properties:{id:{type:'integer'}},required:['id'],additionalProperties:false};
 const after={...before,properties:{id:{type:'string'},tag:{type:'string'}},required:['id','tag']};
 const r=e.analyze({format:'json-schema',before:JSON.stringify(before),after:JSON.stringify(after),payloads:['{"id":1}','{"id":"one","tag":"x"}']});assert.equal(r.compatible,false);assert.deepEqual(r.payloads.map((p:any)=>p.valid),[false,true]);assert.ok(r.breaking.some((x:string)=>x.includes('required')));assert.ok(r.breaking.some((x:string)=>x.includes('type')));
});
