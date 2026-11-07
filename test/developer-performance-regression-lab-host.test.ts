import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,mkdirSync,readFileSync,copyFileSync} from 'node:fs';import {join} from 'node:path';
import {PluginManager} from '../src/plugins/manager.ts';import {pluginToolName} from '../src/plugins/manifest.ts';import {spawnSpec} from '../src/plugins/runtime.ts';import {fromFolder,fromZip,hashFiles} from '../src/packages.ts';import {packPath} from '../src/store/pack.ts';import {splitListing} from '../src/store/checks.ts';import {makeApp,ROOT,tempDir} from './helpers.ts';
async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}}
test('official pack/smoke and real manager trust/enable/plan/run/result.card/disable in six languages',{timeout:120000},async()=>{
 const id='performance-regression-lab',{dir,cleanup}=tempDir(),app=makeApp(dir,{now:new Date()});app.companionId='main';app.providerFactory=()=>{throw Error('No model');};
 const pm=new PluginManager({db:app.store.db,dataDir:dir,vault:app.vault,sandbox:app.sandbox,events:app.events,scrub:s=>s,fence:'node-only',saraVersion:'2.68.0',lookup:async()=>{throw Error('No DNS');},httpGet:async()=>{throw Error('No HTTP');}});app.pluginManager=pm;pm.attach('main',app);
 try{
  const source=join(ROOT,'store/plugins',id),packed=await packPath(source,{saraVersion:'2.68.0',smoke:'node-only',scratch:dir,watchMs:80,readyMs:10000});assert.equal(packed.report.ready,true,JSON.stringify(packed.report.results));assert.equal(packed.report.smoke,'ran');
  const runtime=(f:ReturnType<typeof fromFolder>)=>splitListing(f).pkg.filter(x=>!['CHANGES.md','icon.png'].includes(x.path)),files=runtime(fromZip(packed.zip));assert.equal(hashFiles(files),hashFiles(runtime(fromFolder(source))));
  const review=pm.stage(files,{kind:'zip',where:'synthetic-perf.zip'});await assert.rejects(pm.approve(review.id),/trust this plugin.s author/i);const row=await pm.approve(review.id,{trust:true});assert.equal(pm.enabledFor(id,'main'),false);assert.equal(hashFiles(fromFolder(row.dir)),pm.store.get(id)!.approved_sha);
  const home=pm.dataDirFor(id,'main'),bench=join(home,'perf-lab-v1/injected'),fx=join(ROOT,'test/fixtures/developer/performance-regression-lab');mkdirSync(bench,{recursive:true});
  copyFileSync(join(fx,'baseline.js'),join(bench,'baseline.js'));copyFileSync(join(fx,'candidate-injected.js'),join(bench,'candidate.js')); // trusted operator staging while disabled
  const spec=spawnSpec({fence:'node-only',pluginDir:row.dir,dataDir:home,main:'main.mjs'});assert.equal(spec.cwd,home);assert.ok(!spec.args.some(a=>a.includes('allow-child-process')));
  const full=pluginToolName(id,'compare'),cards:any[]=[],ctx={workspaceDir:dir,sandbox:app.sandbox,signal:AbortSignal.timeout(20000),attachCard:(c:any)=>cards.push(c)};
  const p={benchmark:'injected',samples:30,warmup:4,minEffectPercent:20,sampleTimeoutMs:250};
  for(const language of ['en','es','fr','de','pt-BR','it']){
   app.settings.update({language} as never);await pm.setEnabled(id,'main',true);await until(()=>app.tools.get(full)?.isAvailable?.()===true);const tool=app.tools.get(full)!;
   assert.deepEqual(tool.spec.parameters,JSON.parse(readFileSync(join(source,'schema.json'),'utf8')));assert.equal(tool.defaultPermission,'ask');assert.equal(pm.enabledFor(id,'other'),false);
   const plan=JSON.parse(await tool.run({operation:'plan',...p},ctx));const run=JSON.parse(await tool.run({operation:'run',...p,planSha:plan.planSha},ctx));
   assert.equal(run.status,'regression');assert.equal(run.rawSamplesNs.candidate.length,30);assert.equal(run.planSha,plan.planSha);
   await assert.rejects(tool.run({operation:'run',...p,planSha:'0'.repeat(64)},ctx));
   const labels=JSON.parse(readFileSync(join(source,'labels.json'),'utf8'))[language];assert.equal(cards.at(-1).title,labels.title);assert.equal(cards.at(-1).lines[0],labels.regression);
   await pm.setEnabled(id,'main',false);assert.equal(app.tools.get(full),undefined);
  }
  assert.equal(cards.length,12);assert.equal(app.providerCalls,0);assert.deepEqual(pm.waiting(),[]);
 }finally{await pm.stopAll();app.store.close();cleanup();await until(()=>{cleanup();return !existsSync(dir);});}
});
