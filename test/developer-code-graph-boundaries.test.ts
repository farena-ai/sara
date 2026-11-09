import test from 'node:test';import assert from 'node:assert/strict';
// @ts-expect-error Pure bounded graph engine.
import {impact,architecture} from '../tools/developer-code-graph/graph.mjs';
const one=(source:string)=>({files:[{path:'src/a.ts',source,kind:'source'}],packages:[],changes:[{path:'src/a.ts',symbol:'changed'}]});
test('unsupported runtime edges never turn a static snapshot into complete impact',()=>{
 for(const tail of ['import("./other.js");','const callback = [changed];','const element = <Widget />;','class C { method(){ changed(); } }','const obj = { method(){ changed(); } };','new changed();']){
  const args=one('export function changed(){}; '+tail);if(tail.includes('<Widget'))args.files[0].path='src/a.tsx',args.changes[0].path='src/a.tsx';
  assert.equal(impact(args).complete,false,tail);
 }
});
test('refuses malformed inputs, unsafe namespace, prototype keys, conflicting identities and byte/AST budgets atomically',()=>{
 const invalid:any[]=[{...one('export function changed(){}'),extra:true},one('export function changed( {'),one('namespace N { export function changed(){} }')];
 const duplicate=one('export function changed(){}');duplicate.files.push({...duplicate.files[0]});invalid.push(duplicate);
 for(const path of ['../a.ts','C:/a.ts','x\\a.ts','a//b.ts','a/./b.ts','a.ts:stream','a/%2e.ts','CON/a.ts']){const a=one('export function changed(){}');a.files[0].path=path;invalid.push(a);}
 const inherited=one('export function changed(){}');Object.setPrototypeOf(inherited.files[0],{other:true});invalid.push(inherited);
 const poison=one('export function changed(){}');Object.defineProperty(poison.files[0],'__proto__',{value:{},enumerable:true});invalid.push(poison);
 const pk=one('export function changed(){}') as any;pk.packages=[{name:'same',root:'src',entry:'a.ts'},{name:'same',root:'other',entry:'a.ts'}];invalid.push(pk);
 const overlap=structuredClone(pk);overlap.packages[1]={name:'different',root:'src/nested',entry:'a.ts'};invalid.push(overlap);
 invalid.push(one('export function changed(){}; /*'+'猫'.repeat(4000)+'*/'));
 invalid.push(one('export function changed(){}; '+Array.from({length:900},(_,i)=>`const x${i}=1;`).join('')));
 for(const a of invalid)assert.throws(()=>impact(a));
});
test('ambiguous and case-sensitive module identities are incomplete, never guessed',()=>{
 const a={files:[{path:'a.ts',source:'export function changed(){}',kind:'source'},{path:'a.js',source:'export function changed(){}',kind:'source'},{path:'b.js',source:'import { changed } from "./a.js"; changed();',kind:'source'}],packages:[],changes:[{path:'a.ts',symbol:'changed'}]};
 const r=impact(a);assert.equal(r.complete,false);assert.equal(r.callers.length,0);assert.ok(r.issues.some((i:any)=>i.code==='ambiguous-module'));
 a.files=a.files.filter(f=>f.path!=='a.js');a.files[1].source='import { changed } from "./A.js"; changed();';assert.equal(impact(a).complete,false);
});
test('namespace static property, local alias and default export preserve lexical callable identity with independently resolving AST pointers',async()=>{
 const a={files:[{path:'a.ts',source:'export default function changed(){}',kind:'source'},{path:'b.jsx',source:'import * as ns from "./a.js"; const alias = ns.default; function caller(){ return alias(); }',kind:'test'}],packages:[],changes:[{path:'a.ts',symbol:'changed'}]};
 const r=impact(a);assert.deepEqual(r.callers.map((s:any)=>s.symbol),['caller']);assert.equal(r.complete,true);
 // Independent parser traversal: the emitted JSON pointer resolves to the actual CallExpression.
 const {parse}=await import('../tools/developer-code-graph/node_modules/@babel/parser/lib/index.js');
 const e=r.calls[0].evidence;const ast:any=parse(a.files[1].source,{sourceType:'module',plugins:['jsx']});const node=e.pointer.split('/').slice(1).reduce((o:any,k:string)=>o[k],ast);assert.equal(node.type,'CallExpression');assert.equal(node.start,e.start);assert.equal(node.end,e.end);
});
test('policy namespaces are closed, segment-sensitive and direction/default is explicit',()=>{
 const a:any={files:[{path:'ui/a.js',source:'import "../database/b.js";',kind:'source'},{path:'database/b.js',source:'export const b=1;',kind:'source'}],packages:[],rules:{forbidden:[{from:'ui',to:'data'}],layers:[{name:'ui',prefix:'ui'},{name:'db',prefix:'database'}],allowed:[],defaultPolicy:'allow'}};
 const r=architecture(a);assert.deepEqual(r.findings,[]);assert.equal(r.policySatisfied,true);
 a.rules.layers.push({name:'nested',prefix:'ui/nested'});assert.throws(()=>architecture(a));
});
