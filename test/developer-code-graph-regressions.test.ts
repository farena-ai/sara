import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
// @ts-expect-error Pure JS graph.
import {impact,architecture} from '../tools/developer-code-graph/graph.mjs';
const input=(files:any[])=>({files:files.map(([path,source])=>({path,source,kind:'source'})),packages:[],changes:[{path:'a.ts',symbol:'changed'}]});
test('function expression binds both variable and private self name without confusing callers',()=>{
 const r=impact(input([['a.ts','export const changed = function privateName(){ return 1; }; function caller(){ return changed(); }']]));assert.deepEqual(r.callers.map((s:any)=>s.symbol),['caller']);
});
test('export-star does not reexport default and unresolved star identities cannot verify an ambiguous imported call',()=>{
 for(const middle of ['export * from "./a.js";','export * from "./a.js"; export * from "./missing.js";']){
  const r=impact(input([['a.ts','export default function changed(){}'],['middle.ts',middle],['call.ts','import changed from "./middle.js"; changed();']]));assert.equal(r.callers.length,0);assert.equal(r.complete,false);
 }
});
test('method bodies are not attributed to enclosing functions and escaped namespace members remain incomplete',()=>{
 const a=input([['a.ts','export function changed(){}; function outer(){ const obj={ method(){ changed(); } }; return obj; }']]);const r=impact(a);assert.equal(r.callers.length,0);assert.equal(r.complete,false);
 const ns=impact(input([['a.ts','export function changed(){}'],['b.ts','import * as ns from "./a.js"; const callbacks=[ns.changed];']]));assert.equal(ns.complete,false);
});
test('specifier-level type imports cannot become runtime callers',()=>{
 const r=impact(input([['a.ts','export function changed(){}'],['b.ts','import {type changed} from "./a.js"; changed();']]));assert.equal(r.callers.length,0);assert.equal(r.complete,false);
});
test('deterministic complete golden snapshot excludes same-name shadow and import-only consumers',()=>{
 const a=JSON.parse(readFileSync(new URL('./fixtures/developer/code-graph/impact.json',import.meta.url),'utf8'));const r=impact(a);assert.equal(r.complete,true);assert.deepEqual(r.callers.map((s:any)=>s.symbol),['caller','testValue']);a.files.reverse();a.packages.reverse();assert.deepEqual(impact(a),r);
 const aa=JSON.parse(readFileSync(new URL('./fixtures/developer/code-graph/architecture.json',import.meta.url),'utf8'));const rr=architecture(aa);aa.files.reverse();assert.deepEqual(architecture(aa),rr);
});
test('large UTF-8 evidence amplification is refused atomically through the actual workflow',async()=>{
 const workflow=await import('../store/plugins/change-impact-analyzer/workflow.mjs');
 const source='export function changed(){}; function caller(){'+ 'changed();'.repeat(200)+'}';const a=input([['a.ts',source]]);
 await assert.rejects(workflow.handle(a),/Invalid, unsupported or excessive/);
});
test('multibyte identifiers amplify valid bounded source into refused output, not clipped successful evidence',async()=>{
 const workflow=await import('../store/plugins/change-impact-analyzer/workflow.mjs');const name='猫'.repeat(20);const a=input([['a.ts',`function ${name}(){} function caller(){${(name+'();').repeat(100)}}`]]);a.changes[0].symbol=name;assert.ok(Buffer.byteLength(a.files[0].source)<8192);assert.ok(Buffer.byteLength(JSON.stringify(impact(a)))>42000);await assert.rejects(workflow.handle(a));
});
