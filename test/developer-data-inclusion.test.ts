import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const oracleResults:any[]=[];
after(()=>{mkdirSync('outputs/developer-addons/data-fix',{recursive:true});writeFileSync('outputs/developer-addons/data-fix/inclusion-oracle.json',JSON.stringify({validator:'independent unbundled Ajv 8.18.0',finiteOnly:true,cases:oracleResults.length,comparisons:oracleResults.reduce((n,r)=>n+r.payloads,0),results:oracleResults},null,2)+'\n');});
import {analyze} from '../store/plugins/data-contract-validator/engine.mjs';
// Independent unbundled pinned Ajv: never consult engine comparison internals.
import {Ajv} from '../tools/developer-data/node_modules/ajv/dist/ajv.js';
const run=(a:any,b:any,payloads:any[])=>analyze({format:'json-schema',before:JSON.stringify(a),after:JSON.stringify(b),payloads:payloads.map(v=>JSON.stringify(v))});
const cases:[string,any,any,boolean][]=[
 ['integer to number',{type:'integer'},{type:'number'},true],
 ['remove type',{type:'string'},{},true],
 ['open empty property',{type:'object'},{type:'object',properties:{x:{}}},true],
 ['open annotation property',{type:'object'},{type:'object',properties:{x:{title:'x',description:'annotation'}}},true],
 ['empty items',{type:'array'},{type:'array',items:{}},true],
 ['annotation items',{type:'array'},{type:'array',items:{description:'annotation'}},true],
 ['object enum key order',{enum:[{a:1,b:2}]},{enum:[{b:2,a:1}]},true],
 ['nested object enum key order',{enum:[{x:[{a:1,b:2}]}]},{enum:[{x:[{b:2,a:1}]}]},true],
 ['array enum order',{enum:[[1,2]]},{enum:[[2,1]]},false],
 ['number to integer',{type:'number'},{type:'integer'},false],
 ['add type',{}, {type:'string'},false],
 ['open typed property',{type:'object'},{type:'object',properties:{x:{type:'integer'}}},false],
 ['closed optional addition',{type:'object',additionalProperties:false},{type:'object',additionalProperties:false,properties:{x:{type:'integer'}}},true],
 ['items numeric widening',{type:'array',items:{type:'integer'}},{type:'array',items:{type:'number'}},true],
 ['items numeric narrowing',{type:'array',items:{type:'number'}},{type:'array',items:{type:'integer'}},false],
 ['nested bound tightening',{type:'object',properties:{x:{type:'number'}}},{type:'object',properties:{x:{type:'number',minimum:1}}},false],
 ['nested bound widening',{type:'object',properties:{x:{type:'number',minimum:1}}},{type:'object',properties:{x:{type:'number'}}},true],
 ['maximum tightening',{type:'number'},{type:'number',maximum:1},false],
 ['required addition',{type:'object',properties:{x:{}}},{type:'object',properties:{x:{}},required:['x']},false],
 ['close object',{type:'object'},{type:'object',additionalProperties:false},false],
 ['string bound',{type:'string'},{type:'string',minLength:2},false],
 ['array bound',{type:'array'},{type:'array',maxItems:1},false],
];
const atoms=[null,false,true,-2,0,1,1.5,2,'','a','abc'];
const universe=[...atoms,{}, {a:1,b:2},{b:2,a:1},{x:[{a:1,b:2}]},...atoms.map(x=>({x})),[],[1,2],[2,1],...atoms.map(x=>[x]),[1.5,2],{x:[1.5]}, {extra:true}];
for(const [name,a,b,compatible] of cases)test('R2-05 independent inclusion: '+name,()=>{
 const ajv=new Ajv({strict:true,validateFormats:false,logger:false});const before=ajv.compile(a),after=ajv.compile(b);
 const witnesses=universe.filter(v=>before(v)&&!after(v));assert.equal(witnesses.length===0,compatible,'independent finite inclusion oracle');
 for(let i=0;i<universe.length;i+=20){const batch=universe.slice(i,i+20),result=run(a,b,batch);assert.equal(result.compatible,compatible,JSON.stringify(result.breaking));assert.deepEqual(result.payloads.map((p:any)=>p.valid),batch.map(v=>!!after(v)));}
 oracleResults.push({name,compatible,payloads:universe.length,breakingWitnesses:witnesses.length});
});
