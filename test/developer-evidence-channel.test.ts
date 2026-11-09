import test from 'node:test';
import {reviewCases} from '../tools/developer-evidence/review-fixtures.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
// Pure synthetic qualification fixtures.
import {fixtureArgs} from '../tools/developer-evidence/fixtures.mjs';
for(const id of ['coverage-explorer','log-explorer','incident-workbench','environment-config-doctor']) for(const lang of ['en','es','fr','de','pt-BR','it']) test(`${id}/${lang}: actual permission-limited ready, result card and non-echo error`,{timeout:15000},async()=>{
 const dir=fileURLToPath(new URL(`../store/plugins/${id}/`,import.meta.url));
 const {labels,parameters}=await import(`../store/plugins/${id}/workflow.mjs`);
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${dir}`,join(dir,'main.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');let stderr='';child.stderr.on('data',d=>stderr+=d);
 const messages:any[]=[]; const lines=createInterface({input:child.stdout});lines.on('line',line=>messages.push(JSON.parse(line)));
 const send=(m:any)=>child.stdin.write(JSON.stringify({v:1,...m})+'\n');
 const wait=async(pred:(m:any)=>boolean)=>{const end=Date.now()+8000;while(!messages.some(pred)){assert.equal(child.exitCode,null,stderr);assert.ok(Date.now()<end,'channel deadline');await new Promise(r=>setTimeout(r,10));}return messages.find(pred);};
 try {
  send({type:'init',lang,plugin:id,companion:'synthetic'});
  const ready=await wait(m=>m.type==='ready');assert.equal(ready.tools[0].description,labels[lang].description);assert.deepEqual(ready.tools[0].parameters,parameters);
  send({type:'tool',id:'ok',name:'analyze',args:fixtureArgs(id)});const result=await wait(m=>m.id==='ok');assert.equal(result.type,'result');assert.equal(result.card.title,labels[lang].title);assert.equal(JSON.parse(result.content).scope,labels[lang].scope);
  const secret=['gh','p_','Y'.repeat(36)].join('');send({type:'tool',id:'bad',name:'analyze',args:{unexpected:secret}});const error=await wait(m=>m.id==='bad');assert.equal(error.type,'error');assert.equal(error.error,labels[lang].error);
  for(const [index,c] of reviewCases(id).entries()){
   const req='review-'+index;send({type:'tool',id:req,name:'analyze',args:c.args});const response=await wait(m=>m.id===req);
   assert.equal(response.type,c.refuse?'error':'result');
   if(c.refuse){assert.equal(response.error,labels[lang].error);assert.equal(response.card,undefined);}
   else {assert.equal(response.card.title,labels[lang].title);const r=JSON.parse(response.content);if(id==='log-explorer')assert.ok(r.totalMatches>0);if(c.events)assert.deepEqual(r.timeline.map((e:any)=>e.event),c.events);}
   for(const value of c.absent??[]){const body=response.content??response.error;assert.ok(!body.includes(JSON.stringify(value).slice(1,-1)),body);assert.ok(!JSON.stringify(response.card??{}).includes(JSON.stringify(value).slice(1,-1)));assert.ok(!stderr.includes(value));}
  }
  assert.ok(!JSON.stringify(messages).includes(secret));assert.ok(!stderr.includes(secret));assert.ok(!messages.some(m=>m.type==='call'),'No broker calls, including card calls');
 } finally {lines.close();child.stdin.end();child.kill();const [code,signal]=await exited;const out=resolve(import.meta.dirname,'../outputs/developer-addons/evidence-fix/cleanup');mkdirSync(out,{recursive:true});writeFileSync(join(out,id+'-'+lang+'.json'),JSON.stringify({id,lang,pid:child.pid,exitCode:code,signal,exitObserved:true}));}
});
