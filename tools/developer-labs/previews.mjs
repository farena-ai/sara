// Real bounded handler results on synthetic fixtures, for clearly labelled preview images.
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..'),fx=id=>join(root,'test/fixtures/developer',id),out=[];
const ENGINES={'test-doctor':'doctor.mjs','flaky-test-lab':'lab.mjs'};
const engine=id=>import(pathToFileURL(join(root,'store/plugins',id,ENGINES[id]??'engine.mjs')).href);
// H_EXEC add-ons: the host's real plan check and job runner (Node fence, a disposable copy) stand in for Sara.
const hostRun=async(home,raw,perm={programs:['node'],sources:['data'],network:false})=>{const {parsePlan,runJob}=await import(pathToFileURL(join(root,'src/plugins/exec-job.ts')).href);const plan=parsePlan(raw,perm,'node-only');return {ok:true,...await runJob(plan,{sourceDir:join(home,...plan.from.split('/')),cacheDir:join(home,'..',`${home.split(/[\\/]/).pop()}-jobs`),fence:'node-only',signal:new AbortController().signal})};};
const setups={
 'performance-regression-lab':async(home,{handle})=>{const d=join(home,'perf-lab-v1/injected');mkdirSync(d,{recursive:true});copyFileSync(join(fx('performance-regression-lab'),'baseline.js'),join(d,'baseline.js'));copyFileSync(join(fx('performance-regression-lab'),'candidate-injected.js'),join(d,'candidate.js'));
  const p={benchmark:'injected',samples:30,warmup:4,minEffectPercent:20,sampleTimeoutMs:250},plan=JSON.parse((await handle({operation:'plan',...p})).content);return handle({operation:'run',...p,planSha:plan.planSha});},
 'build-reproducibility-inspector':async(home,{handle})=>{const d=join(home,'repro-v1/seeded');mkdirSync(d,{recursive:true});cpSync(join(fx('build-reproducibility-inspector'),'source'),join(d,'source'),{recursive:true});copyFileSync(join(fx('build-reproducibility-inspector'),'nondeterministic.js'),join(d,'build.js'));
  const plan=JSON.parse((await handle({operation:'plan',profile:'seeded'})).content);return handle({operation:'compare',profile:'seeded',planSha:plan.planSha});},
 'test-doctor':async(home,{handle})=>{cpSync(join(fx('test-doctor'),'repo'),join(home,'projects/shop'),{recursive:true});const a={project:'shop',file:'test/price.test.mjs',test:'total applies the discount once'},run=raw=>hostRun(home,raw);
  const plan=JSON.parse((await handle({operation:'plan',...a},'en',run,home)).content);return handle({operation:'run',...a,planSha:plan.planSha},'en',run,home);},
 'flaky-test-lab':async(home,{handle})=>{cpSync(join(fx('flaky-test-lab'),'repo'),join(home,'projects/cart'),{recursive:true});const a={project:'cart',file:'test/cart.test.mjs',test:'intermittent stock check',runs:20},run=raw=>hostRun(home,raw);
  const plan=JSON.parse((await handle({operation:'plan',...a},'en',run,home)).content);return handle({operation:'run',...a,planSha:plan.planSha},'en',run,home);},
 'code-migration-studio':async(home,{handle})=>{cpSync(join(fx('code-migration-studio'),'workspace'),join(home,'migration-v1/workspace'),{recursive:true});
  return handle({operation:'preview',codemod:'rename-named-import',version:1,module:'lib/math.mjs',from:'add',to:'sum',files:['src/report.mjs','src/alias.mjs','src/shadow.mjs','main.mjs']});},
};
const only=process.argv.slice(2);
for(const [id,setup] of Object.entries(setups)){if(only.length&&!only.includes(id))continue;
 const home=mkdtempSync(join(tmpdir(),'lab-preview-')),cwd=process.cwd();
 try{process.chdir(home);const r=await setup(home,await engine(id));out.push({id,...r.card,report:JSON.parse(r.content)});}finally{process.chdir(cwd);rmSync(home,{recursive:true,force:true});}
}
mkdirSync(join(root,'outputs/developer-labs'),{recursive:true});writeFileSync(join(root,'outputs/developer-labs/previews.json'),JSON.stringify(out,null,2)+'\n');
console.log(out.map(x=>x.id+': '+x.lines.join(' | ')).join('\n'));
