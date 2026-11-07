import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {createInterface} from 'node:readline';
import {mkdtempSync,cpSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=fileURLToPath(new URL('../store/plugins/code-migration-studio/',import.meta.url)),fx=fileURLToPath(new URL('./fixtures/developer/code-migration-studio/workspace/',import.meta.url));
for(const lang of ['en','es','fr','de','pt-BR','it'])test(`migration/${lang}: real permission-limited channel previews, applies and refuses`,{timeout:30000},async()=>{
 const labels=JSON.parse(readFileSync(join(dir,'labels.json'),'utf8')),parameters=JSON.parse(readFileSync(join(dir,'schema.json'),'utf8'));
 const home=mkdtempSync(join(tmpdir(),'migration-channel-')),ws=join(home,'migration-v1/workspace');cpSync(fx,ws,{recursive:true});
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${dir}`,`--allow-fs-read=${home}`,`--allow-fs-write=${home}`,join(dir,'main.mjs')],{cwd:home,stdio:['pipe','pipe','pipe'],windowsHide:true});const exited=once(child,'exit');let stderr='';child.stderr.on('data',d=>stderr+=d);const messages:any[]=[];
 createInterface({input:child.stdout}).on('line',line=>messages.push(JSON.parse(line)));const send=(m:any)=>child.stdin.write(JSON.stringify({v:1,...m})+'\n');
 const wait=async(pred:(m:any)=>boolean)=>{const end=Date.now()+20000;while(!messages.some(pred)){assert.equal(child.exitCode,null,stderr);assert.ok(Date.now()<end,'channel deadline');await new Promise(r=>setTimeout(r,10));}return messages.find(pred);};
 try{
  send({type:'init',lang,plugin:'code-migration-studio',companion:'synthetic'});const ready=await wait(m=>m.type==='ready');assert.equal(ready.tools[0].description,labels[lang].description);assert.deepEqual(ready.tools[0].parameters,parameters);
  const p={codemod:'rename-named-import',version:1,module:'lib/math.mjs',from:'add',to:'sum',files:['src/report.mjs','main.mjs']};
  send({type:'tool',id:'p',name:'migrate',args:{operation:'preview',...p}});const plan=await wait(m=>m.id==='p');assert.equal(plan.type,'result',JSON.stringify(plan));const planSha=JSON.parse(plan.content).planSha;assert.equal(plan.card.title,labels[lang].title);
  send({type:'tool',id:'r',name:'migrate',args:{operation:'apply',...p,planSha}});const run=await wait(m=>m.id==='r');assert.equal(run.type,'result',JSON.stringify(run));const r=JSON.parse(run.content);assert.equal(r.applied,true);assert.equal(run.card.lines[0],labels[lang].applied);assert.match(readFileSync(join(ws,'main.mjs'),'utf8'),/import \{ sum \}/);
  send({type:'tool',id:'x',name:'migrate',args:{operation:'apply',...p,planSha:'f'.repeat(64)}});const bad=await wait(m=>m.id==='x');assert.equal(bad.type,'error');
 }finally{child.stdin.end();child.kill();await exited;rmSync(home,{recursive:true,force:true});}
});
