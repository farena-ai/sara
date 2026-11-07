import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,cpSync,copyFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),engine=join(root,'store/plugins/build-reproducibility-inspector/engine.mjs'),fx=join(root,'test/fixtures/developer/build-reproducibility-inspector');
async function inspector(){assert.ok(existsSync(engine),'build reproducibility engine has not been implemented');const p='../store/plugins/build-reproducibility-inspector/engine.mjs';return import(p);}
function stage(home:string,id:string,script:string){const d=join(home,'repro-v1',id);mkdirSync(d,{recursive:true});cpSync(join(fx,'source'),join(d,'source'),{recursive:true});copyFileSync(join(fx,script),join(d,'build.js'));return d;}
async function compare(handle:any,profile:string){const plan=JSON.parse((await handle({operation:'plan',profile})).content);return {plan,report:JSON.parse((await handle({operation:'compare',profile,planSha:plan.planSha})).content)};}
test('compares independent fixture builds and explains deliberately nondeterministic output from the artifacts',async()=>{
 const {handle}=await inspector();const home=mkdtempSync(join(tmpdir(),'repro-'));
 try{
  stage(home,'seeded','nondeterministic.js');process.chdir(home);
  const {plan,report}=await compare(handle,'seeded');
  assert.equal(plan.executed,false);assert.match(plan.planSha,/^[a-f0-9]{64}$/);assert.equal(plan.sourceFiles,2);assert.equal(plan.toolchain.node,process.version);
  assert.equal(report.reproducible,false);assert.equal(report.builds.length,2);assert.notEqual(report.builds[0].treeSha256,report.builds[1].treeSha256);
  assert.notEqual(report.builds[0].clockMs,report.builds[1].clockMs);assert.notEqual(report.builds[0].buildRoot,report.builds[1].buildRoot);
  const byPath=Object.fromEntries(report.files.map((f:any)=>[f.path,f]));
  assert.equal(byPath['dist/LICENSE.txt'].status,'identical');
  const bundle=byPath['dist/bundle.js'];assert.equal(bundle.status,'explained');assert.deepEqual(bundle.causes,['path','timestamp']);
  assert.ok(bundle.evidence.some((e:any)=>e.kind==='timestamp'&&e.format==='iso'&&e.line===1&&e.a===new Date(report.builds[0].clockMs).toISOString()&&e.b===new Date(report.builds[1].clockMs).toISOString()));
  assert.ok(bundle.evidence.some((e:any)=>e.kind==='path'&&e.a===report.builds[0].buildRoot&&e.b===report.builds[1].buildRoot));
  const version=byPath['dist/version.json'];assert.equal(version.status,'explained');assert.deepEqual(version.causes,['timestamp']);assert.ok(version.evidence.some((e:any)=>e.format==='epoch-ms'&&e.a===String(report.builds[0].clockMs)));
  // Hashes are real: recompute the explained artifact's tree from the reported per-file digests.
  for(const b of [0,1]){const tree=createHash('sha256').update(JSON.stringify(report.files.map((f:any)=>[f.path,f.sha256[b]]))).digest('hex');assert.equal(tree,report.builds[b].treeSha256);}
  assert.equal(report.unexplained,0);
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
test('control: the same reproducible build repeated passes with identical tree hashes; unattributable differences stay unexplained',async()=>{
 const {handle}=await inspector();const home=mkdtempSync(join(tmpdir(),'repro-'));
 try{
  stage(home,'control','deterministic.js');stage(home,'random','random.js');process.chdir(home);
  const c=(await compare(handle,'control')).report;assert.equal(c.reproducible,true);assert.equal(c.builds[0].treeSha256,c.builds[1].treeSha256);assert.ok(c.files.every((f:any)=>f.status==='identical'));
  const r=(await compare(handle,'random')).report;assert.equal(r.reproducible,false);assert.equal(r.files[0].status,'unexplained');assert.equal(r.unexplained,1);assert.equal(Object.hasOwn(r.files[0],'causes'),false);assert.equal(typeof r.files[0].firstDifferenceOffset,'number');
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
test('stale plans, unsafe outputs, links and unknown fields refuse; staged source is never modified',async()=>{
 const {handle}=await inspector();const home=mkdtempSync(join(tmpdir(),'repro-'));const refuse=(a:any)=>assert.rejects(handle(a),/^Error: Build comparison refused:/);
 try{
  const d=stage(home,'stale','deterministic.js');stage(home,'escape','bad-path.js');process.chdir(home);
  const before=JSON.stringify(readdirSync(d,{recursive:true}).sort());
  const plan=JSON.parse((await handle({operation:'plan',profile:'stale'})).content);writeFileSync(join(d,'source/src/version.txt'),'9.9.9\n');await refuse({operation:'compare',profile:'stale',planSha:plan.planSha});
  const e=JSON.parse((await handle({operation:'plan',profile:'escape'})).content);await refuse({operation:'compare',profile:'escape',planSha:e.planSha});
  for(const a of [{operation:'plan',profile:'stale',root:home},{operation:'plan',profile:'../stale'},{operation:'compare',profile:'stale'},{operation:'build',profile:'stale'},{operation:'plan',profile:'stale',command:'make'}])await refuse(a);
  assert.equal(JSON.stringify(readdirSync(d,{recursive:true}).sort()),before);
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
