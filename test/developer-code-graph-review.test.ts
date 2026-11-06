import test,{after} from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';
// @ts-expect-error Pure bounded JS API.
import {impact as runImpact,architecture as runArchitecture} from '../tools/developer-code-graph/graph.mjs';
// Independent installed AST parser, not the shipped resolution implementation.
import {parse} from '../tools/developer-code-graph/node_modules/@babel/parser/lib/index.js';
import traverse from '../tools/developer-code-graph/node_modules/@babel/traverse/lib/index.js';
const evidenceCounts={reports:0,pointers:0,lexicalBindings:0,callOwners:0,targetNodes:0};
after(()=>{mkdirSync('outputs/developer-addons/code-graph-fix',{recursive:true});writeFileSync('outputs/developer-addons/code-graph-fix/review-evidence.json',JSON.stringify(evidenceCounts,null,2)+'\n');});
function verifyEvidence(input:any,report:any){
 const asts=new Map<string,any>(),sources=new Map<string,string>(),calls=new Map<string,any>();
 for(const f of input.files){const ast=parse(f.source,{sourceType:'module',plugins:['typescript']});asts.set(f.path,ast);sources.set(f.path,f.source);traverse(ast,{CallExpression(p){calls.set(f.path+':'+p.node.start,p);},OptionalCallExpression(p){calls.set(f.path+':'+p.node.start,p);}});}
 function visit(v:any){if(!v||typeof v!=='object')return;
  if(typeof v.pointer==='string'&&typeof v.path==='string'){
   const n=v.pointer.split('/').slice(1).reduce((o:any,k:string)=>o[k],asts.get(v.path));assert.ok(n,v.pointer);assert.equal(v.start,n.start);assert.equal(v.end,n.end);assert.equal(v.line,n.loc.start.line);assert.equal(v.column,n.loc.start.column);
   const prefix=sources.get(v.path)!.slice(0,v.start);assert.equal(v.line,prefix.split('\n').length);assert.equal(v.column,prefix.length-prefix.lastIndexOf('\n')-1);evidenceCounts.pointers++;
  }for(const child of Object.values(v))visit(child);
 }visit(report);
 for(const c of report.calls??[]){const p=calls.get(c.evidence.path+':'+c.evidence.start);assert.ok(p);const enclosing=p.findParent((x:any)=>x.isFunction());assert.equal(c.from.start,enclosing?.node.start??0);evidenceCounts.callOwners++;
  const callee=p.get('callee'),name=callee.isIdentifier()?callee.node.name:callee.isMemberExpression()&&callee.get('object').isIdentifier()?callee.node.object.name:null;
  const b=name?p.scope.getBinding(name):null;if(b){assert.equal(c.binding.name,b.identifier.name);assert.equal(c.binding.start,b.identifier.start);assert.equal(c.binding.end,b.identifier.end);evidenceCounts.lexicalBindings++;}else assert.equal(c.binding,null);
  const target=c.to.evidence.pointer.split('/').slice(1).reduce((o:any,k:string)=>o[k],asts.get(c.to.path));assert.ok(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(target.type));assert.equal(target.start,c.to.start);evidenceCounts.targetNodes++;
 }evidenceCounts.reports++;
}
const impact=(input:any)=>{const r=runImpact(input);verifyEvidence(input,r);return r;};
const architecture=(input:any)=>{const r=runArchitecture(input);verifyEvidence(input,r);return r;};
const snapshot=(files:[string,string][])=>({files:files.map(([path,source])=>({path,source,kind:'source'})),packages:[] as any[],changes:[{path:'a.ts',symbol:'changed'}]});
const rules={forbidden:[],layers:[],allowed:[],defaultPolicy:'allow'};
const architectureInput=(i:any)=>({files:i.files,packages:i.packages,rules});
const single=(source:string)=>snapshot([['a.ts',source]]);
const ambiguous=Symbol('ambiguous');
// Independent AST-only ResolveExport subset: cycles mean no contribution, ambiguity is terminal,
// explicit names override stars; identities are declaration origin, not exported name text.
function oracle(files:any[],path:string,name:string,seen=new Set<string>()):string|symbol|null{
 const key=path+'#'+name;if(seen.has(key))return null;seen=new Set([...seen,key]);
 const ast:any=parse(files.find(f=>f.path===path).source,{sourceType:'module',plugins:['typescript']});
 const target=(s:string)=>s.replace('./','').replace(/\.js$/,'.ts');
 for(const n of ast.program.body){if(n.type!=='ExportNamedDeclaration')continue;
  if(n.declaration?.type==='FunctionDeclaration'&&n.declaration.id.name===name)return path+'#'+name;
  for(const s of n.specifiers)if(s.exported.name===name)return oracle(files,target(n.source.value),s.local.name,seen);
 }
 let found:string|symbol|null=null;
 for(const n of ast.program.body){if(n.type!=='ExportAllDeclaration'||name==='default'||n.exportKind==='type')continue;
  const result=oracle(files,target(n.source.value),name,seen);if(result===ambiguous)return ambiguous;
  if(result!==null){if(found!==null&&found!==result)return ambiguous;found=result;}
 }return found;
}
const exportCases:[string,[string,string][],string|symbol|null][]=[
 ['nested ambiguity',[['ambiguous.ts','export * from "./a.js"; export * from "./other.js";'],['barrel.ts','export * from "./ambiguous.js"; export * from "./a.js";']],ambiguous],
 ['identical diamond',[['left.ts','export * from "./a.js";'],['right.ts','export * from "./a.js";'],['barrel.ts','export * from "./left.js"; export * from "./right.js";']],'a.ts#changed'],
 ['cycle with origin',[['loop.ts','export * from "./barrel.js";'],['barrel.ts','export * from "./loop.js"; export * from "./a.js";']],'a.ts#changed'],
 ['pure cycle',[['loop.ts','export * from "./barrel.js";'],['barrel.ts','export * from "./loop.js";']],null],
 ['named override',[['ambiguous.ts','export * from "./a.js"; export * from "./other.js";'],['barrel.ts','export * from "./ambiguous.js"; export {changed} from "./a.js";']],'a.ts#changed'],
 ['named propagates ambiguity',[['ambiguous.ts','export * from "./a.js"; export * from "./other.js";'],['barrel.ts','export {changed} from "./ambiguous.js";']],ambiguous],
];
for(const [label,middle,expected] of exportCases)test('review R1 export states / independent AST oracle: '+label,()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['other.ts','export function changed(){}'],...middle,['z.ts','import {changed as local} from "./barrel.js"; function caller(){ local(); }']]);
 assert.equal(oracle(i.files,'barrel.ts','changed'),expected);const r=impact(i);
 assert.equal(r.complete,typeof expected==='string');assert.equal(r.callers.length,typeof expected==='string'?1:0);
 assert.equal(r.calls.length,typeof expected==='string'?1:0);if(r.calls.length)assert.equal(r.calls[0].to.path,'a.ts');
 const a=architecture(architectureInput(i));assert.equal(a.complete,r.complete);if(!r.complete)assert.equal(a.policySatisfied,null);
});
test('review R1 an explicit noncallable export is not absence in a star competitor',()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['other.ts','export const changed=1;'],['barrel.ts','export * from "./a.js"; export * from "./other.js";'],['z.ts','import {changed} from "./barrel.js"; function caller(){changed();}']]);
 const r=impact(i);assert.equal(r.complete,false);assert.deepEqual(r.callers,[]);assert.deepEqual(r.calls,[]);
});
for(const declaration of ['export class changed {}','export const {changed}={changed:1};'])test('review R1 unsupported/noncallable declaration cannot disappear from export identity: '+declaration,()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['other.ts',declaration],['barrel.ts','export * from "./a.js"; export * from "./other.js";'],['z.ts','import {changed} from "./barrel.js"; function caller(){changed();}']]);const r=impact(i);assert.equal(r.complete,false);assert.deepEqual(r.calls,[]);
});
test('review R1 distinct exported alias bindings are not an identical-identity diamond',()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['alias.ts','import {changed as original} from "./a.js"; export const changed=original;'],['barrel.ts','export * from "./a.js"; export * from "./alias.js";'],['z.ts','import {changed} from "./barrel.js"; function caller(){changed();}']]);
 const r=impact(i);assert.equal(r.complete,false);assert.deepEqual(r.calls,[]);
});
test('review R1 ambiguity survives immutable aliases and namespace members',()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['other.ts','export function changed(){}'],['bad.ts','export * from "./a.js"; export * from "./other.js";'],['barrel.ts','export * from "./bad.js"; export * from "./a.js";'],['z.ts','import * as ns from "./barrel.js"; const alias=ns.changed; function caller(){alias();}']]);
 const r=impact(i);assert.equal(r.complete,false);assert.deepEqual(r.callers,[]);
});
for(const [label,source] of [
 ['array arrow','function changed(){} const callbacks=[()=>changed()];'],
 ['array function','const callbacks=[function changed(){}];'],
 ['object arrow','function changed(){} const api={callback:()=>changed()};'],
 ['object function','function changed(){} const api={callback:function(){changed();}};'],
 ['argument arrow','function accept(x){} function changed(){} accept(()=>changed());'],
 ['argument function','function accept(x){} function changed(){} accept(function(){changed();});'],
 ['returned arrow','function changed(){} function factory(){return ()=>changed();}'],
 ['returned function','function changed(){} function factory(){return function(){changed();};}'],
] as [string,string][])test('review R2 escaping callable value: '+label,()=>{
 const i=single(source),r=impact(i);assert.equal(r.complete,false);assert.ok(r.issues.some((x:any)=>x.code==='escaped-callable-value'));
 const a=architecture(architectureInput(i));assert.equal(a.complete,false);assert.equal(a.policySatisfied,null);
 // Calls lexically inside callbacks are retained as static evidence, not executed reachability.
 if(label!=='array function')assert.ok(r.calls.some((c:any)=>c.to.symbol==='changed'));
});
for(const source of ['function changed(){} const callback=()=>changed(); callback();','function changed(){} const callback=function self(){changed();}; callback();','function changed(){} (()=>changed())();','function changed(){} (function(){changed();})();'])test('review R2 valid immutable/direct expression retains precision: '+source,()=>{
 const r=impact(single(source));assert.equal(r.complete,true);assert.ok(r.calls.some((c:any)=>c.to.symbol==='changed'));
});
test('review R3 identifier default export retains correct imported caller and completeness',()=>{
 const i=snapshot([['a.ts','// 😀\nfunction changed(){}; export default changed;'],['z.ts','import value from "./a.js"; function caller(){value();}']]);
 const r=impact(i);assert.equal(r.complete,true);assert.deepEqual(r.callers.map((s:any)=>s.symbol),['caller']);assert.equal(r.calls[0].binding.name,'value');assert.equal(r.calls[0].to.path,'a.ts');
});
for(const type of ['type Callable=typeof changed;','type Callable={run:typeof changed};','interface Callable {run:typeof changed}'])test('review R3 erased type query is not runtime escape: '+type,()=>{
 const r=impact(single('export function changed(){}; '+type+' function caller(){changed();}'));assert.equal(r.complete,true);assert.deepEqual(r.callers.map((s:any)=>s.symbol),['caller']);
});
for(const hidden of ['toJSON','hidden','symbol','index-accessor'])test('review R4 hostile in-process array rejected without invoking '+hidden,()=>{
 const i=single('function changed(){}');let invoked=0;
 if(hidden==='index-accessor')Object.defineProperty(i.files,'0',{get(){invoked++;return {};}});
 else Object.defineProperty(i.files,hidden==='symbol'?Symbol('hidden'):hidden,{value(){invoked++;return [];},enumerable:false});
 assert.throws(()=>impact(i));assert.equal(invoked,0);assert.throws(()=>architecture(architectureInput(i)));assert.equal(invoked,0);
});
test('review R4 nested arrays reject hidden descriptors before any budget serialization',()=>{
 const i=single('function changed(){}');let invoked=0;Object.defineProperty(i.changes,'toJSON',{get(){invoked++;return ()=>[];}});assert.throws(()=>impact(i));assert.equal(invoked,0);
});
for(const [label,files,packages] of [
 ['file ancestor',[['a.ts','export function changed(){}'],['a.ts/nested.ts','import {changed} from "../a.js"; changed();']],[]],
 ['file equals package root',[['a.ts','export function changed(){}'],['a.ts/entry.ts','export function entry(){}']],[{name:'pkg',root:'a.ts',entry:'entry.ts'}]],
 ['file ancestors package root',[['a.ts','export function changed(){}'],['a.ts/pkg/entry.ts','export function entry(){}']],[{name:'pkg',root:'a.ts/pkg',entry:'entry.ts'}]],
] as [string,[string,string][],any[]][])test('review P3 impossible real-source identity refuses: '+label,()=>{
 const i=snapshot(files);i.packages=packages;assert.throws(()=>impact(i));assert.throws(()=>architecture(architectureInput(i)));
});
test('review P3 valid segment neighbors retain literal identities and completeness',()=>{
 const i=snapshot([['a.ts','export function changed(){}'],['a.tsx/entry.ts','export function entry(){}']]);i.packages=[{name:'pkg',root:'a.tsx',entry:'entry.ts'}];assert.equal(impact(i).complete,true);assert.equal(i.files[1].path,'a.tsx/entry.ts');
});
