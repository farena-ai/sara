import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,mkdirSync,readFileSync,cpSync,rmSync} from 'node:fs';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {PluginManager} from '../src/plugins/manager.ts';import {pluginToolName} from '../src/plugins/manifest.ts';import {spawnSpec} from '../src/plugins/runtime.ts';import {fromFolder,fromZip,hashFiles} from '../src/packages.ts';import {packPath} from '../src/store/pack.ts';import {splitListing} from '../src/store/checks.ts';import {makeApp,ROOT,tempDir} from './helpers.ts';
async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}}
test('official pack/smoke and real manager trust/enable/preview/apply/result.card/disable in six languages',{timeout:120000},async()=>{
 const id='code-migration-studio',{dir,cleanup}=tempDir(),app=makeApp(dir,{now:new Date()});app.companionId='main';app.providerFactory=()=>{throw Error('No model');};
 const pm=new PluginManager({db:app.store.db,dataDir:dir,vault:app.vault,sandbox:app.sandbox,events:app.events,scrub:s=>s,fence:'node-only',saraVersion:'2.68.0',lookup:async()=>{throw Error('No DNS');},httpGet:async()=>{throw Error('No HTTP');}});app.pluginManager=pm;pm.attach('main',app);
 try{
  const source=join(ROOT,'store/plugins',id),packed=await packPath(source,{saraVersion:'2.68.0',smoke:'node-only',scratch:dir,watchMs:80,readyMs:10000});assert.equal(packed.report.ready,true,JSON.stringify(packed.report.results));assert.equal(packed.report.smoke,'ran');
  const runtime=(f:ReturnType<typeof fromFolder>)=>splitListing(f).pkg.filter(x=>!['CHANGES.md','icon.png'].includes(x.path)),files=runtime(fromZip(packed.zip));assert.equal(hashFiles(files),hashFiles(runtime(fromFolder(source))));
  const review=pm.stage(files,{kind:'zip',where:'synthetic-migration.zip'});await assert.rejects(pm.approve(review.id),/trust this plugin.s author/i);const row=await pm.approve(review.id,{trust:true});assert.equal(pm.enabledFor(id,'main'),false);assert.equal(hashFiles(fromFolder(row.dir)),pm.store.get(id)!.approved_sha);
  const home=pm.dataDirFor(id,'main'),ws=join(home,'migration-v1/workspace'),fx=join(ROOT,'test/fixtures/developer/code-migration-studio/workspace');mkdirSync(home,{recursive:true});
  const stage=()=>{rmSync(ws,{recursive:true,force:true});cpSync(fx,ws,{recursive:true});}; // trusted operator staging of a disposable selected-workspace copy
  const digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
  const spec=spawnSpec({fence:'node-only',pluginDir:row.dir,dataDir:home,main:'main.mjs'});assert.equal(spec.cwd,home);assert.ok(!spec.args.some(a=>a.includes('allow-child-process')));
  const full=pluginToolName(id,'migrate'),cards:any[]=[],ctx={workspaceDir:dir,sandbox:app.sandbox,signal:AbortSignal.timeout(20000),attachCard:(c:any)=>cards.push(c)};
  const p={codemod:'rename-named-import',version:1,module:'lib/math.mjs',from:'add',to:'sum',files:['src/report.mjs','src/alias.mjs','src/shadow.mjs','main.mjs']};
  for(const language of ['en','es','fr','de','pt-BR','it']){
   app.settings.update({language} as never);await pm.setEnabled(id,'main',true);await until(()=>app.tools.get(full)?.isAvailable?.()===true);const tool=app.tools.get(full)!;
   assert.deepEqual(tool.spec.parameters,JSON.parse(readFileSync(join(source,'schema.json'),'utf8')));assert.equal(tool.defaultPermission,'ask');assert.equal(pm.enabledFor(id,'other'),false);
   stage();const legacy=digest(join(ws,'unselected/legacy.mjs'));const plan=JSON.parse(await tool.run({operation:'preview',...p},ctx));assert.equal(digest(join(ws,'main.mjs')),plan.files.find((f:any)=>f.path==='main.mjs').beforeSha256);const run=JSON.parse(await tool.run({operation:'apply',...p,planSha:plan.planSha},ctx));
   assert.equal(run.applied,true);assert.equal(run.verified,true);assert.equal(run.planSha,plan.planSha);for(const f of plan.files)assert.equal(digest(join(ws,f.path)),f.afterSha256);assert.equal(digest(join(ws,'unselected/legacy.mjs')),legacy);
   await assert.rejects(tool.run({operation:'apply',...p,planSha:plan.planSha},ctx),/Migration refused/,'a consumed plan is stale after apply');
   const labels=JSON.parse(readFileSync(join(source,'labels.json'),'utf8'))[language];assert.equal(cards.at(-1).title,labels.title);assert.equal(cards.at(-1).lines[0],labels.applied);
   await pm.setEnabled(id,'main',false);assert.equal(app.tools.get(full),undefined);
  }
  assert.equal(cards.length,12);assert.equal(app.providerCalls,0);assert.deepEqual(pm.waiting(),[]);
 }finally{await pm.stopAll();app.store.close();cleanup();await until(()=>{cleanup();return !existsSync(dir);});}
});
