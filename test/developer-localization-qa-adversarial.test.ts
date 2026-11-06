import test from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Standalone JavaScript.
import {analyze,catalog,tokens} from '../store/plugins/localization-qa/engine.mjs';
// @ts-expect-error Standalone workflow.
import {handle,labels} from '../store/plugins/localization-qa/workflow.mjs';
test('maximal disjoint catalogs emit all 64 scoped references without source text or truncation in every locale',()=>{
 const base=JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['private-base-'+i,'😀'.repeat(128)]))),target=JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['private-target-'+i,'x'.repeat(512)])));
 for(const lang of Object.keys(labels)){const result=handle({base,target,grammar:'named-v1'},lang),r=JSON.parse(result.content);assert.equal(r.findings.length,64);assert.equal(new Set(r.findings.map((f:any)=>f.side+f.ref)).size,64);assert.ok(!result.content.includes('private-'));assert.ok(Buffer.byteLength(result.content)<46000);assert.ok(Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),...result}))<60000);}
});
test('valid JSON escaping and decoded duplicates are handled at token boundaries',()=>{
 for(const raw of ['{"a":"x","a":"y"}','{"a":"x","\\u0061":"y"}','{"a\\\"b":"x","a\\u0022b":"y"}'])assert.throws(()=>catalog(raw));
 const obj={'quote"slash\\':'line\ntext','unicode':'été 😀'};assert.deepEqual({...catalog(JSON.stringify(obj))},obj);
 for(const raw of ['{"a":"x"}{}','{"a":"x"}true','{"a":"x", "b" "x"}','{"a":"\\q"}','{"a":"x",/*x*/"b":"y"}','{"a": ["x"]}','{"a": true}'])assert.throws(()=>catalog(raw));
 assert.deepEqual(tokens('{x} then {y:number}'),tokens('{y:number} puis {x:string}'));
});
test('non-JSON structures refuse without serialization side effects, including hidden array callbacks',()=>{
 let calls=0;const f=()=>{calls++;return [];},base={base:'{"a":"x"}',target:'{"a":"y"}',grammar:'named-v1'};
 const list:any[]=[];Object.defineProperty(list,'toJSON',{value:f});const cycle:any={};cycle.next=cycle;
 for(const evidence of [list,cycle,new Map(),new Date(),{rows:BigInt(1)},{rows:Symbol('private')},Object.defineProperty({},'rows',{get:f,enumerable:true})])assert.throws(()=>analyze({...base,evidence}));assert.equal(calls,0);
});
