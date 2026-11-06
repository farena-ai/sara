import test from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Standalone JS.
import {analyze} from '../store/plugins/localization-qa/engine.mjs';
const valid=()=>({base:'{"a":"OK"}',target:'{"a":"OK"}',grammar:'named-v1'});
test('hostile own descriptors and prototypes are refused without executing callbacks',()=>{
 let calls=0;const callback=()=>{calls++;return valid();};
 for(const obj of [Object.assign(Object.create({}),valid()),Object.defineProperty(valid(),'hidden',{value:callback}),Object.defineProperty(valid(),'evidence',{get:callback,enumerable:true}),{...valid(),toJSON:callback},{...valid(),unexpected:1},{...valid(),evidence:[]},null])assert.throws(()=>analyze(obj));
 const array:any[]=[];Object.defineProperty(array,'toJSON',{value:callback});assert.throws(()=>analyze({...valid(),evidence:{rows:array}}));
 assert.equal(calls,0);
});
test('raw catalogs and total input are bounded and unmeasured success is never all-translations-valid',()=>{
 for(const a of [{...valid(),grammar:'icu'},{...valid(),base:'x'.repeat(24001)},{...valid(),base:JSON.stringify(Object.fromEntries(Array.from({length:33},(_,i)=>['k'+i,'x'])))},{...valid(),target:JSON.stringify({a:'x'.repeat(513)})},{...valid(),evidence:{}}])assert.throws(()=>analyze(a));
 const r=analyze(valid());assert.equal(r.layout,'not-measured');assert.notEqual(r.status,'all-translations-valid');
});
