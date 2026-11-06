import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,linkSync,symlinkSync,truncateSync,utimesSync,readFileSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const entry='../store/plugins/build-cache-inspector/engine.mjs';const {handle}=await import(entry);
const home=mkdtempSync(join(tmpdir(),'cache-boundaries-')),root=process.cwd(),cache=join(home,'owned-caches-v1/typescript');
mkdirSync(cache,{recursive:true});writeFileSync(join(cache,'negative-control.js'),'export const negativeControl=1;\n');
const args={operation:'inspect',cacheId:'typescript'};
const refuse=(a:any)=>assert.rejects(handle(a),/^Error: Cache inspection refused:/);
function reset(){rmSync(cache,{recursive:true,force:true});mkdirSync(cache,{recursive:true});writeFileSync(join(cache,'negative-control.js'),'export const negativeControl=1;\n');}
test('closed input admission refuses roots, paths, apply, unknown fields and hostile descriptors before serialization',async()=>{
 process.chdir(home);try{
  for(const a of [{...args,cacheId:home},{...args,root:home},{...args,operation:'apply'},{...args,size:23},{...args,cacheId:'../typescript'},null,[],{...args,policy:{}}])await refuse(a);
  let invoked=false;const hostile={...args};Object.defineProperty(hostile,'toJSON',{value:()=>{invoked=true;return args;}});await refuse(hostile);assert.equal(invoked,false);
  const getter={...args};Object.defineProperty(getter,'root',{get(){invoked=true;return home;}});await refuse(getter);assert.equal(invoked,false);
 }finally{process.chdir(root);}
});
test('stale content, installed mtime and invalid policy refuse atomically; preserve and cutoff deterministic',async()=>{
 process.chdir(home);try{reset();writeFileSync(join(cache,'second.js'),'export const second=2;\n');const read=async(a:any)=>JSON.parse((await handle(a)).content);const m=await read(args);
 const policy={referenceMs:Date.now(),minAgeMs:0,maxPruneBytes:0,retainNewest:1,preserve:[]};const preview={operation:'preview',cacheId:'typescript',snapshot:m.snapshot,policy};
 const p=await read(preview);assert.deepEqual(p.candidates,[]);assert.equal(p.cutoff,true);assert.equal(p.estimatedBytes,'0');
 assert.deepEqual((await read({...preview,policy:{...policy,maxPruneBytes:16777216,preserve:m.files.map((f:any)=>f.ref)}})).candidates,[]);
 for(const bad of [{...policy,referenceMs:0},{...policy,minAgeMs:-1},{...policy,maxPruneBytes:1.5},{...policy,retainNewest:0},{...policy,preserve:['f999']},{...policy,preserve:['f001','f001']},{...policy,referenceMs:Date.now()+120000},{...policy,preserve:[],apply:true}])await refuse({...preview,policy:bad});
 writeFileSync(join(cache,'second.js'),'export const changed=3;\n');await refuse(preview);const updated=await read(args);utimesSync(join(cache,'second.js'),new Date(),new Date(Date.now()-5000));await refuse({...preview,snapshot:updated.snapshot});
 }finally{process.chdir(root);}
});
test('hardlinks, junctions, depth, count, total bytes and strange names fail whole scan',async()=>{
 process.chdir(home);try{
 reset();linkSync(join(cache,'negative-control.js'),join(cache,'hardlink.js'));await refuse(args);
 reset();symlinkSync(home,join(cache,'junction'),'junction');await refuse(args);
 reset();mkdirSync(join(cache,...Array(10).fill('deep')),{recursive:true});await refuse(args);
 reset();for(let i=0;i<129;i++)writeFileSync(join(cache,'file'+i),'');await refuse(args);
 reset();truncateSync(join(cache,'negative-control.js'),16777217);await refuse(args);
 reset();writeFileSync(join(cache,'x'.repeat(129)),'');await refuse(args);
 }finally{process.chdir(root);reset();}
});
test('hash-time real file mutation refuses instead of certifying a mixed snapshot',async()=>{
 const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
 process.chdir(home);reset();const original=fs.readSync;let fired=false;
 try{
  fs.readSync=((...a:any[])=>{const n=(original as any)(...a);if(!fired){fired=true;writeFileSync(join(cache,'negative-control.js'),'changed during hash');}return n;}) as typeof fs.readSync;syncBuiltinESMExports();
  await refuse(args);assert.equal(fired,true);
 }finally{fs.readSync=original;syncBuiltinESMExports();process.chdir(root);}
});
test('age threshold equality, stable ordinal ties and preserve-array descriptors',async()=>{
 process.chdir(home);try{
  reset();writeFileSync(join(cache,'second.js'),'two');writeFileSync(join(cache,'third.js'),'three');
  const time=Math.floor(Date.now()/1000)*1000-10000;for(const n of ['negative-control.js','second.js','third.js'])utimesSync(join(cache,n),time/1000,time/1000);
  const measured=JSON.parse((await handle(args)).content),referenceMs=time+10000;
  const preview={operation:'preview',cacheId:'typescript',snapshot:measured.snapshot,policy:{referenceMs,minAgeMs:10000,maxPruneBytes:16777216,retainNewest:1,preserve:[]}};
  const p=JSON.parse((await handle(preview)).content);assert.deepEqual(p.preserved,['f001']);assert.deepEqual(p.candidates,['f002','f003']);
  assert.deepEqual(JSON.parse((await handle({...preview,policy:{...preview.policy,minAgeMs:10001}})).content).candidates,[]);
  let invoked=false;const preserve:any[]=[];Object.defineProperty(preserve,'toJSON',{value:()=>{invoked=true;return [];}});await refuse({...preview,policy:{...preview.policy,preserve}});assert.equal(invoked,false);
  const sparse=Array(1);await refuse({...preview,policy:{...preview.policy,preserve:sparse}});
 }finally{process.chdir(root);}
});
test('bounded streaming directory admission does not allocate an unbounded readdir list',async()=>{
 const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');process.chdir(home);reset();const original=fs.readdirSync;
 try{fs.readdirSync=(()=>{throw Error('Unbounded enumeration forbidden');}) as typeof fs.readdirSync;syncBuiltinESMExports();assert.equal(JSON.parse((await handle(args)).content).complete,true);}
 finally{fs.readdirSync=original;syncBuiltinESMExports();process.chdir(root);}
});
test('snapshot binds directory metadata, not just regular-file tuples',async()=>{
 process.chdir(home);try{reset();const m=JSON.parse((await handle(args)).content);mkdirSync(join(cache,'new-empty-directory'));await refuse({operation:'preview',cacheId:'typescript',snapshot:m.snapshot,policy:{referenceMs:Date.now(),minAgeMs:0,maxPruneBytes:100,retainNewest:1,preserve:[]}});}finally{process.chdir(root);}
});
test.after(()=>{process.chdir(root);rmSync(home,{recursive:true,force:true});});
