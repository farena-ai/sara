import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.cwd(),engine=join(root,'store/plugins/build-cache-inspector/engine.mjs');
const NO_TSC=existsSync(join(root,'node_modules/typescript/bin/tsc'))?false:'needs the typescript dev dependency (not in production installs)';
const digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
test('measure compiler-produced owned files and preview without changing bytes or installed mtimes',{skip:NO_TSC},async()=>{
 assert.ok(existsSync(engine),'real filesystem inspector has not been implemented');
 const modulePath='../store/plugins/build-cache-inspector/engine.mjs';const {handle}=await import(modulePath);
 const home=mkdtempSync(join(tmpdir(),'cache-inspector-'));
 try {
  const source=join(home,'source.ts'),cache=join(home,'owned-caches-v1/typescript');mkdirSync(cache,{recursive:true});
  writeFileSync(source,'export const answer: number = 42;\n');
  for(const generation of ['a','b']) {
   const built=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),source,'--target','ES2022','--module','ES2022','--skipLibCheck','--outDir',join(cache,generation)],{encoding:'utf8',cwd:home});
   assert.equal(built.status,0,built.stdout+built.stderr);
  }
  const paths=[source,join(cache,'a/source.js'),join(cache,'b/source.js')];
  const state=()=>paths.map(p=>({sha:digest(p),size:statSync(p).size,mtime:statSync(p,{bigint:true}).mtimeNs.toString()}));
  const before=state();process.chdir(home);
  const measured=JSON.parse((await handle({operation:'inspect',cacheId:'typescript'})).content);
  assert.equal(measured.complete,true);assert.equal(measured.files.length,2);assert.equal(measured.totalBytes,String(before[1].size+before[2].size));
  const preview=JSON.parse((await handle({operation:'preview',cacheId:'typescript',snapshot:measured.snapshot,policy:{referenceMs:Date.now(),minAgeMs:0,maxPruneBytes:16777216,retainNewest:1,preserve:[]}})).content);
  assert.equal(preview.complete,true);assert.equal(preview.candidates.length,1);assert.equal(preview.estimatedBytes,String(before[1].size));assert.equal(preview.mutated,false);
  assert.deepEqual(state(),before);assert.ok(!JSON.stringify(measured).includes('source.js'));assert.ok(!JSON.stringify(measured).includes(home));
 } finally {process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
