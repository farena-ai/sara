import test from 'node:test';import assert from 'node:assert/strict';
import {fixtureArgs,ids} from '../tools/developer-evidence/fixtures.mjs';
for(const id of ids)test(id+': closed nested schemas, meaningful native evidence cards and low entropy confidentiality',async()=>{
 const {handle,parameters}=await import(`../store/plugins/${id}/workflow.mjs`);assert.equal(parameters.additionalProperties,false);
 const r=await handle(fixtureArgs(id),'en');const report=JSON.parse(r.content);const count=report.branches?.length??report.totalMatches??report.totalEvents??report.checked;assert.ok(r.card.lines.some((s:string)=>s.endsWith(': '+count)),'card must carry measured evidence, not generic prose only');
 for(const args of [{...fixtureArgs(id),__extra:'PRIVATE'}, {...fixtureArgs(id),...(id==='environment-config-doctor'?{rules:[{name:'__proto__',type:'string',required:true,secret:true}]}:{files:[{path:'../PRIVATE',text:'PRIVATE',format:'line',kind:'metric'}]})}])await assert.rejects(()=>handle(args,'en'),/Refused/);
 if(id==='environment-config-doctor')for(const secret of ['0','x','é猫','a\nb','PORT']){const raw=JSON.stringify({PORT:secret});const x=await handle({format:'json',text:raw,rules:[{name:'PORT',type:'integer',required:true,secret:true,min:1000,max:9999}]},'en');const parsed=JSON.parse(x.content);assert.deepEqual(parsed.findings,[{rule:0,status:'invalid',line:null}]);assert.ok(!JSON.stringify(x).includes('PORT'));}
});
