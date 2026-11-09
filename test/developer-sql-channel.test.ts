import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
const baseline={tables:[{name:'items',columns:[{name:'id',type:'INTEGER'}],rows:3}]};
for(const lang of ['en','es','fr','de','pt-BR','it'])test(`SQLite/${lang}: real permission-limited channel, enforced authorizer, safe/unsafe cards`,{timeout:15000},async()=>{
 const dir=fileURLToPath(new URL('../store/plugins/sql-migration-reviewer/',import.meta.url));
 // @ts-expect-error Native plugin entrypoint exports.
 const {labels,parameters}=await import('../store/plugins/sql-migration-reviewer/workflow.mjs');
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${dir}`,join(dir,'main.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});const exited=once(child,'exit');let stderr='';child.stderr.on('data',d=>stderr+=d);const messages:any[]=[];
 const lines=createInterface({input:child.stdout});lines.on('line',line=>messages.push(JSON.parse(line)));const send=(m:any)=>child.stdin.write(JSON.stringify({v:1,...m})+'\n');
 const wait=async(pred:(m:any)=>boolean)=>{const end=Date.now()+8000;while(!messages.some(pred)){assert.equal(child.exitCode,null,stderr);assert.ok(Date.now()<end,'channel deadline');await new Promise(r=>setTimeout(r,10));}return messages.find(pred);};
 try{
 send({type:'init',lang,plugin:'sql-migration-reviewer',companion:'synthetic'});const ready=await wait(m=>m.type==='ready');assert.equal(ready.tools[0].description,labels[lang].description);assert.deepEqual(ready.tools[0].parameters,parameters);
 for(const [id,sql,status] of [['safe','CREATE TABLE archive (id INTEGER); CREATE INDEX ix ON items (id);','rehearsed'],['unsafe','DROP TABLE items;','rejected']]){
 send({type:'tool',id,name:'rehearse',args:{baseline,sql}});const r=await wait(m=>m.id===id);assert.equal(r.type,'result',JSON.stringify(r));const report=JSON.parse(r.content);assert.equal(report.status,status);assert.equal(report.message,labels[lang][status]);assert.equal(r.card.title,labels[lang].title);assert.equal(r.card.lines[0],labels[lang][status]);assert.ok(!JSON.stringify(r.card).includes(sql));if(status==='rehearsed'){assert.equal(report.authorizerEnforced,true);assert.equal(report.rollbackVerified,true);assert.equal(report.dataPreserved,true);assert.equal(report.closed,true);}
 }
 const secret='SQL_PRIVATE_CANARY_927';send({type:'tool',id:'bad',name:'rehearse',args:{baseline,sql:secret}});const bad=await wait(m=>m.id==='bad');assert.ok(!JSON.stringify(bad).includes(secret));assert.equal(JSON.parse(bad.content).status,'rejected');assert.ok(!messages.some(m=>m.type==='call'));assert.ok(!stderr.includes(secret));
 mkdirSync('outputs/developer-addons/sql',{recursive:true});writeFileSync(`outputs/developer-addons/sql/channel-${lang}.json`,JSON.stringify({lang,ready,messages,stderr},null,2)+'\n');
 }finally{lines.close();child.stdin.end();child.kill();const [code,signal]=await exited;writeFileSync(`outputs/developer-addons/sql/channel-${lang}-cleanup.json`,JSON.stringify({pid:child.pid,exited:true,code,signal})+'\n');}
});
