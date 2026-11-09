import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createInterface } from 'node:readline';
const ROOT=resolve('store/plugins/api-contract-guard');
const before={openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths:{'/pets':{get:{responses:{'200':{description:'OK'}}}}}};
export const compareArgs={before,after:{...before,paths:{}}};
const locales=['en','es','fr','de','pt-BR','it'];
test('native permission-limited process: localized ready schemas and real invocation-scoped cards; malformed args denied without broker calls', {timeout:15000},async t=>{
 assert.ok(existsSync(join(ROOT,'main.mjs')),'native compare facade exists');
 assert.deepEqual(readFileSync(join(ROOT,'sara-plugin.mjs')),readFileSync('examples/plugins/sara-plugin.mjs'));
 const summaries=new Set<string>();
 for(const lang of locales){
  const c=spawn(process.execPath,['--permission',`--allow-fs-read=${ROOT}`,join(ROOT,'main.mjs')],{stdio:['pipe','pipe','pipe']});const msgs:any[]=[];let stderr='';c.stderr.on('data',b=>stderr+=b);createInterface({input:c.stdout}).on('line',l=>msgs.push(JSON.parse(l)));const exit=new Promise(r=>c.on('exit',(code,signal)=>r({code,signal})));
  const send=(m:object)=>c.stdin.write(JSON.stringify({v:1,...m})+'\n');async function wait(id?:string){const deadline=Date.now()+3000;while(!msgs.some(m=>id?m.id===id:m.type==='ready')){assert.ok(Date.now()<deadline,stderr||'native deadline');await new Promise(r=>setTimeout(r,5));}return msgs.find(m=>id?m.id===id:m.type==='ready');}
  try{send({type:'init',lang});const ready=await wait();assert.deepEqual(ready.tools.map((x:any)=>x.name),['compare']);assert.equal(ready.tools[0].permission,'ask');assert.equal(ready.tools[0].parameters.additionalProperties,false);
   send({type:'tool',id:'t1',name:'compare',args:compareArgs});const r=await wait('t1');assert.equal(r.type,'result');const report=JSON.parse(r.content);assert.equal(report.compatible,false);assert.equal(report.evidence.kind,'explicit-documents');assert.ok(r.card.title);assert.ok(r.card.lines.includes(report.summary));assert.ok(r.card.lines.every((s:string)=>s.length<=200));summaries.add(report.summary);
   send({type:'tool',id:'t2',name:'compare',args:{...compareArgs,command:'anything'}});assert.equal((await wait('t2')).type,'error');assert.ok(!msgs.some(m=>m.type==='call'),'no model/network/tool/card broker');t.diagnostic(JSON.stringify({lang,description:ready.tools[0].description,result:report,card:r.card}));
   c.stdin.end();assert.deepEqual(await exit,{code:0,signal:null});
  }finally{if(c.exitCode===null)c.kill();await exit;}
 }
 assert.equal(summaries.size,6);
});
