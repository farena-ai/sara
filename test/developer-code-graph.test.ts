import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Bounded pure JS engine under qualification.
import * as graph from '../tools/developer-code-graph/graph.mjs';
const {impact}=graph;
const files=[
 {path:'packages/core/value.ts',source:'export function changed(x: number) { return x + 1; }',kind:'source'},
 {path:'packages/core/index.ts',source:'export { changed as publicValue } from "./value.js";',kind:'source'},
 {path:'packages/app/main.ts',source:'import { publicValue as callValue } from "@fixture/core"; export function caller() { return callValue(1); }',kind:'source'},
 {path:'tests/value.test.js',source:'import { caller } from "../packages/app/main.js"; function testValue(){ return caller(); }',kind:'test'},
 {path:'packages/app/shadow.js',source:'import { changed } from "../core/value.js"; function shadow(changed) { return changed(); }',kind:'source'},
 {path:'packages/app/unused.js',source:'import { changed } from "../core/value.js"; export const label = "not a caller";',kind:'source'}
];
const packages=[{name:'@fixture/core',root:'packages/core',entry:'index.ts'},{name:'@fixture/app',root:'packages/app',entry:'main.ts'}];
export const fixture=()=>({files:structuredClone(files),packages:structuredClone(packages),changes:[{path:'packages/core/value.ts',symbol:'changed'}]});
test('golden: changed symbol resolves alias/reexport to actual transitive callers, packages and supplied tests, not mere imports or shadowed names',()=>{
 const report=impact(fixture());
 assert.deepEqual(report.callers.map((x:any)=>[x.path,x.symbol,x.distance]),[['packages/app/main.ts','caller',1],['tests/value.test.js','testValue',2]]);
 assert.deepEqual(report.packages,['@fixture/app','@fixture/core']);
 assert.deepEqual(report.tests,['tests/value.test.js']);
 const edge=report.calls.find((x:any)=>x.from.symbol==='caller');
 assert.equal(edge.to.path,'packages/core/value.ts');assert.equal(edge.to.symbol,'changed');
 assert.equal(files.find(f=>f.path===edge.evidence.path)!.source.slice(edge.evidence.start,edge.evidence.end),'callValue(1)');
 assert.equal(edge.evidence.line,1);assert.ok(edge.evidence.pointer.startsWith('/program/body/'));
 assert.equal(report.complete,false,'shadowed parameter call is unresolved, never a verified call to changed');
});
export const architectureFixture=()=>({files:[{path:'ui/a.ts',source:'import { b } from "../data/b.js"; export const a=1;',kind:'source'},{path:'data/b.ts',source:'import { a } from "../ui/a.js"; export const b=2;',kind:'source'}],packages:[],rules:{forbidden:[{from:'ui',to:'data'}],layers:[{name:'view',prefix:'ui'},{name:'storage',prefix:'data'}],allowed:[{from:'view',to:'storage'}],defaultPolicy:'deny'}});
test('golden: architecture evaluates resolved directed module edges, forbidden import, reverse layer violation and an evidenced closed cycle',()=>{
 assert.equal(typeof graph.architecture,'function','Architecture analyzer is implemented');
 const args=architectureFixture(),r=graph.architecture(args);
 assert.equal(r.complete,true);assert.equal(r.policySatisfied,false);
 assert.deepEqual(r.findings.map((x:any)=>[x.code,x.edge.from,x.edge.to]),[['forbidden-import','ui/a.ts','data/b.ts'],['layer-violation','data/b.ts','ui/a.ts']]);
 assert.deepEqual(r.cycles[0].paths,['data/b.ts','ui/a.ts','data/b.ts']);
 for(const e of r.cycles[0].edges){assert.ok(args.files.find(f=>f.path===e.from)!.source.slice(e.evidence.start,e.evidence.end).includes(e.specifier));}
 const clean=architectureFixture();clean.files[1].source='export const b=2;';clean.rules.forbidden=[];
 const ok=graph.architecture(clean);assert.equal(ok.policySatisfied,true);assert.deepEqual(ok.cycles,[]);
});
