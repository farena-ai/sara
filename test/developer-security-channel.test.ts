import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
// @ts-expect-error Pure qualification fixture module.
import {fixtureArgs} from '../tools/developer-security/fixtures.mjs';
for(const id of ['secret-scanner','license-auditor','sbom-builder','artifact-provenance-verifier']) for(const lang of ['en','es','fr','de','pt-BR','it']) test(`${id}/${lang}: actual permission-limited ready, result card and non-echo error`,{timeout:15000},async()=>{
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
  if(id==='secret-scanner') {
   const report=JSON.parse(result.content);assert.equal(report.findings.length,4);assert.ok(report.findings.every((f:any)=>f.path==='[redacted-path]'));
   send({type:'tool',id:'quoted-bad',name:'analyze',args:{files:[{path:'x',text:'"api_key":"private-synthetic\\q"'}]}});
   const refused=await wait(m=>m.id==='quoted-bad');assert.equal(refused.type,'error');assert.equal(refused.error,labels[lang].error);
   for(const value of ['small-synthetic','quoted "synthetic" 界','other-synthetic','private-synthetic']) assert.ok(!JSON.stringify(messages).includes(value));
  }
  const secret=['gh','p_','Y'.repeat(36)].join('');send({type:'tool',id:'bad',name:'analyze',args:{unexpected:secret}});const error=await wait(m=>m.id==='bad');assert.equal(error.type,'error');assert.equal(error.error,labels[lang].error);
  assert.ok(!JSON.stringify(messages).includes(secret));assert.ok(!stderr.includes(secret));assert.ok(!messages.some(m=>m.type==='call'),'No broker calls, including card calls');
 } finally {lines.close();child.stdin.end();child.kill();await exited;}
});
const ids=['secret-scanner','license-auditor','sbom-builder','artifact-provenance-verifier'];
for(const id of ids) test(`${id}: closed schemas, localized input refusals and output budgets`,async()=>{
 const {handle,parameters,labels}=await import(`../store/plugins/${id}/workflow.mjs`);
 assert.equal(parameters.additionalProperties,false);
 for(const lang of ['en','es','fr','de','pt-BR','it']) {
  assert.ok(labels[lang].description && labels[lang].error && labels[lang].scope);
  await assert.rejects(()=>handle({unexpected:'do not echo me'},lang),{message:labels[lang].error});
 }
 if(id==='secret-scanner') {
  const token=['gh','p_','Z'.repeat(36)].join('');
  const r=await handle({files:[{path:token,text:`password=tiny\n${token}`}]},'de');
  assert.equal(JSON.parse(r.content).findings[0].path,'[redacted-path]');
  assert.ok(!JSON.stringify(r).includes(token)); assert.ok(!JSON.stringify(r).includes('tiny'));
  assert.equal(r.card.title,labels.de.title); assert.ok(Buffer.byteLength(JSON.stringify(r))<60000);
 }
});
