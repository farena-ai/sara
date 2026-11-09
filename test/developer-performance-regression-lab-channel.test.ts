import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=fileURLToPath(new URL('../store/plugins/performance-regression-lab/',import.meta.url)),fx=fileURLToPath(new URL('./fixtures/developer/performance-regression-lab/',import.meta.url));
for(const lang of ['en','es','fr','de','pt-BR','it'])test(`perf lab/${lang}: real permission-limited channel plans, measures and refuses`,{timeout:30000},async()=>{
 const labels=JSON.parse(readFileSync(join(dir,'labels.json'),'utf8')),parameters=JSON.parse(readFileSync(join(dir,'schema.json'),'utf8'));
 const home=mkdtempSync(join(tmpdir(),'perf-channel-')),bench=join(home,'perf-lab-v1/control');mkdirSync(bench,{recursive:true});copyFileSync(join(fx,'baseline.js'),join(bench,'baseline.js'));copyFileSync(join(fx,'baseline.js'),join(bench,'candidate.js'));
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${dir}`,`--allow-fs-read=${home}`,join(dir,'main.mjs')],{cwd:home,stdio:['pipe','pipe','pipe'],windowsHide:true});const exited=once(child,'exit');let stderr='';child.stderr.on('data',d=>stderr+=d);const messages:any[]=[];
 createInterface({input:child.stdout}).on('line',line=>messages.push(JSON.parse(line)));const send=(m:any)=>child.stdin.write(JSON.stringify({v:1,...m})+'\n');
 const wait=async(pred:(m:any)=>boolean)=>{const end=Date.now()+20000;while(!messages.some(pred)){assert.equal(child.exitCode,null,stderr);assert.ok(Date.now()<end,'channel deadline');await new Promise(r=>setTimeout(r,10));}return messages.find(pred);};
 try{
  send({type:'init',lang,plugin:'performance-regression-lab',companion:'synthetic'});const ready=await wait(m=>m.type==='ready');assert.equal(ready.tools[0].description,labels[lang].description);assert.deepEqual(ready.tools[0].parameters,parameters);
  const p={benchmark:'control',samples:12,warmup:2,minEffectPercent:20,sampleTimeoutMs:500};
  send({type:'tool',id:'p',name:'compare',args:{operation:'plan',...p}});const plan=await wait(m=>m.id==='p');assert.equal(plan.type,'result',JSON.stringify(plan));const planSha=JSON.parse(plan.content).planSha;assert.equal(plan.card.title,labels[lang].title);
  send({type:'tool',id:'r',name:'compare',args:{operation:'run',...p,planSha}});const run=await wait(m=>m.id==='r');assert.equal(run.type,'result',JSON.stringify(run));const r=JSON.parse(run.content);assert.notEqual(r.status,'regression');assert.equal(run.card.lines[0],labels[lang][r.status]);
  send({type:'tool',id:'x',name:'compare',args:{operation:'run',...p,planSha:'f'.repeat(64)}});const bad=await wait(m=>m.id==='x');assert.equal(bad.type,'error');
 }finally{child.stdin.end();child.kill();await exited;rmSync(home,{recursive:true,force:true});}
});
