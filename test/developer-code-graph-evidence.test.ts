import test from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Bounded graph API.
import {impact} from '../tools/developer-code-graph/graph.mjs';
const input=(source:string)=>({files:[{path:'a.ts',source,kind:'source'}],packages:[],changes:[{path:'a.ts',symbol:'changed'}]});
test('distance is shortest reverse-call distance, not traversal discovery order',()=>{
 const r=impact(input('function changed(){} function x(){ changed(); } function y(){ x(); } function z(){ y(); } function finalCaller(){ z(); changed(); }'));assert.equal(r.callers.find((s:any)=>s.symbol==='finalCaller').distance,1);
});
test('analysis refuses evidence-edge and resolution-work budgets before serializing oversized reports',()=>{
 assert.throws(()=>impact(input('function changed(){} function caller(){'+'changed();'.repeat(300)+'}')),/budget/);
});
test('returned import and reexport evidence declares actual local/imported/exported aliases',()=>{
 const a=input('export function changed(){}') as any;a.files.push({path:'index.ts',source:'export { changed as publicName } from "./a.js";',kind:'source'},{path:'b.ts',source:'import { publicName as localName } from "./index.js"; function caller(){ localName(); }',kind:'source'});
 const r=impact(a);assert.deepEqual(r.imports.find((e:any)=>e.from==='b.ts').bindings,[{imported:'publicName',local:'localName',typeOnly:false}]);assert.deepEqual(r.imports.find((e:any)=>e.from==='index.ts').bindings,[{imported:'changed',exported:'publicName',typeOnly:false}]);assert.equal(r.calls[0].binding.name,'localName');assert.equal(r.calls[0].binding.path,'b.ts');assert.ok(r.calls[0].binding.pointer.endsWith('/local'),'binding pointer identifies the imported local Identifier, not the whole specifier');
});
