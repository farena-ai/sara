import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=process.cwd(),engine=join(root,'store/plugins/performance-regression-lab/engine.mjs'),fx=join(root,'test/fixtures/developer/performance-regression-lab');
const median=(v:number[])=>{const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
async function lab(){assert.ok(existsSync(engine),'performance lab engine has not been implemented');const p='../store/plugins/performance-regression-lab/engine.mjs';return import(p);}
function stage(home:string,id:string,base:string,cand:string){const d=join(home,'perf-lab-v1',id);mkdirSync(d,{recursive:true});copyFileSync(join(fx,base),join(d,'baseline.js'));copyFileSync(join(fx,cand),join(d,'candidate.js'));return d;}
const params=(benchmark:string,samples=30)=>({benchmark,samples,warmup:4,minEffectPercent:20,sampleTimeoutMs:290});
// A sample that a starved host stalls past its limit (290 ms here, wall time: it is also the hang
// guard) is refused like a hang. That is honest, not an answer: ask again, within a deadline, so a lab
// that always refuses still fails.
async function measure(handle:any,p:any){
 const plan=JSON.parse((await handle({operation:'plan',...p})).content);const until=Date.now()+150_000;
 for(;;){
  try{return JSON.parse((await handle({operation:'run',...p,planSha:plan.planSha})).content);}
  catch(e){assert.match(String(e),/^Error: Performance run refused:/);if(Date.now()>until)throw e;}
 }
}
test('detects an injected regression from repeatable interleaved measurements and retained raw samples',{timeout:240000},async()=>{
 const {handle}=await lab();const home=mkdtempSync(join(tmpdir(),'perf-lab-'));
 try{
  stage(home,'injected','baseline.js','candidate-injected.js');stage(home,'control','baseline.js','baseline.js');process.chdir(home);
  const plan=JSON.parse((await handle({operation:'plan',...params('injected')})).content);
  assert.match(plan.planSha,/^[a-f0-9]{64}$/);assert.match(plan.baselineSha256,/^[a-f0-9]{64}$/);assert.notEqual(plan.baselineSha256,plan.candidateSha256);assert.equal(plan.executed,false);
  // Repeatability: two independent judged runs both see the regression. C2: a run is judged by its own
  // samples, not by how busy the host was. On a busy host time slices land inside the samples: the
  // spread widens ('noisy') or both sides are stretched alike so the 4x gap shrinks into the
  // uncertainty band ('effect-uncertain'). Both are honest 'inconclusive' answers with no percentage;
  // the lab is asked again until two runs are judged (a quiet host needs exactly two runs). It must
  // never call the injected regression fine.
  let judged=0,runs=0,refused=0;const unjudged:string[]=[];const until=Date.now()+150_000;
  while(judged<2&&(runs<6||Date.now()<until)){
   runs++;
   // Refused (a sample stalled past its limit on a starved host, see measure()): not judged.
   let answer;
   try{answer=await handle({operation:'run',...params('injected'),planSha:plan.planSha});}
   catch(e){assert.match(String(e),/^Error: Performance run refused:/);refused++;unjudged.push('refused');continue;}
   const r=JSON.parse(answer.content);
   assert.notEqual(r.status,'no-regression','a 4x slowdown is never within the threshold');
   if(r.status==='inconclusive'){
    assert.ok(['noisy','effect-uncertain'].includes(r.reason),r.reason);unjudged.push(`${r.reason} ${JSON.stringify(r.medianNs)} ${JSON.stringify(r.relativeMad)}`);
    if(r.reason==='noisy')assert.ok(r.relativeMad.some((x:number)=>x>0.25),JSON.stringify(r.relativeMad));
    assert.equal(Object.hasOwn(r,'slowdownPercent'),false);assert.equal(Object.hasOwn(r,'ratioCi'),false);
    continue;
   }
   judged++;
   assert.equal(r.status,'regression',JSON.stringify({reason:r.reason,ci:r.ratioCi}));assert.equal(r.order,'interleaved-abba');
   assert.equal(r.rawSamplesNs.baseline.length,30);assert.equal(r.rawSamplesNs.candidate.length,30);
   for(const v of [...r.rawSamplesNs.baseline,...r.rawSamplesNs.candidate])assert.match(v,/^[1-9][0-9]*$/);
   const b=r.rawSamplesNs.baseline.map(Number),c=r.rawSamplesNs.candidate.map(Number);
   assert.equal(r.slowdownPercent,Math.round((median(c)/median(b)-1)*1000)/10,'percentage is derived from the returned raw samples');
   assert.ok(r.slowdownPercent>20&&r.ratioCi[0]>1.2);assert.equal(r.planSha,plan.planSha);assert.equal(typeof r.hardware.cpus,'number');
  }
  assert.equal(judged,2,`two runs were judged (${runs} tried, ${refused} refused): ${unjudged.join('; ')}`);
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
test('control and negative oracles: identical code never regresses; noisy or underpowered runs are inconclusive without a percentage',{timeout:240000},async()=>{
 const {handle}=await lab();const home=mkdtempSync(join(tmpdir(),'perf-lab-'));
 try{
  stage(home,'control','baseline.js','baseline.js');stage(home,'noisy','baseline.js','noisy.js');stage(home,'small','baseline.js','candidate-injected.js');process.chdir(home);
  const control=await measure(handle,params('control'));assert.notEqual(control.status,'regression');
  if(control.status==='no-regression')assert.ok(control.ratioCi[1]<1.2);else assert.equal(Object.hasOwn(control,'slowdownPercent'),false);
  const noisy=await measure(handle,params('noisy'));assert.equal(noisy.status,'inconclusive');assert.equal(noisy.reason,'noisy');
  // C2: the verdict comes from the fixture's own paced spread (a fixed 6..96 ms ladder), which host load can only widen.
  assert.ok(noisy.relativeMad[1]>0.25,JSON.stringify(noisy.relativeMad));
  const small=await measure(handle,params('small',5));assert.equal(small.status,'inconclusive');assert.equal(small.reason,'underpowered');
  for(const r of [noisy,small]){assert.equal(Object.hasOwn(r,'slowdownPercent'),false);assert.equal(Object.hasOwn(r,'ratioCi'),false);assert.ok(r.rawSamplesNs.baseline.length>0);}
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
test('stale plans, unknown fields, hangs and host-object access refuse visibly',{timeout:60000},async()=>{
 const {handle}=await lab();const home=mkdtempSync(join(tmpdir(),'perf-lab-'));const refuse=(a:any)=>assert.rejects(handle(a),/^Error: Performance run refused:/);
 try{
  const d=stage(home,'stale','baseline.js','candidate-injected.js');stage(home,'hang','baseline.js','hang.js');stage(home,'escape','baseline.js','escape.js');process.chdir(home);
  const plan=JSON.parse((await handle({operation:'plan',...params('stale')})).content);
  writeFileSync(join(d,'candidate.js'),'function bench(){return 2;}\n');await refuse({operation:'run',...params('stale'),planSha:plan.planSha});
  await refuse({operation:'run',...params('stale'),planSha:'0'.repeat(64)});
  for(const a of [{operation:'plan',...params('stale'),root:home},{operation:'plan',...params('../stale')},{operation:'plan',...params('stale'),samples:1000},{operation:'plan',...params('stale'),command:'node'},{operation:'apply'}])await refuse(a);
  let touched=false;const hostile={operation:'plan',...params('stale')};Object.defineProperty(hostile,'toJSON',{value:()=>{touched=true;return {};}});await refuse(hostile);assert.equal(touched,false);
  for(const id of ['hang','escape']){const p=JSON.parse((await handle({operation:'plan',...params(id)})).content);const started=Date.now();await refuse({operation:'run',...params(id),planSha:p.planSha});assert.ok(Date.now()-started<5000);}
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
