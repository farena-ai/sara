import test from 'node:test';import assert from 'node:assert/strict';
test('log redaction discovers cross-file structured secrets and rejects unsafe/oversize inputs without echoes',async()=>{
 const {searchLogs}=await import('../tools/developer-evidence/logs.mjs');
 const base={files:[{path:'seed.log',format:'jsonl',text:JSON.stringify({password:'x',token:'猫\n密',message:'nothing'})},{path:'x.log',format:'line',text:'2026-11-05T10:00:00Z incident x 猫\n密'}],query:'incident',sensitiveValues:[],limit:10};
 const r=searchLogs(base);assert.ok(!r.matches[0].path.includes('x'));assert.ok(!r.matches[0].message.includes('x'));assert.ok(!JSON.stringify(r).includes('猫'));
 for(const files of [[{path:'../a',format:'line',text:'a'}],[{path:'a',format:'jsonl',text:'{"password":"DO_NOT_ECHO",BROKEN'}],[{path:'a',format:'line',text:'a'.repeat(100001)}]])assert.throws(()=>searchLogs({...base,files}),/^Error: Invalid supplied evidence$/);
 assert.throws(()=>searchLogs({...base,files:[{path:'a',format:'line',text:Array(100).fill('2026-11-05T10:00:00Z incident '+ 'z'.repeat(1000)).join('\n')}],limit:100}),/Invalid supplied evidence/);
});
