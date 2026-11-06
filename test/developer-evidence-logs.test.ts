import test from 'node:test';import assert from 'node:assert/strict';
test('log explorer searches seeded incident across structured and multiline logs with safe citations',async()=>{
 const {searchLogs}=await import('../tools/developer-evidence/logs.mjs');
 const files=[{path:'api.log',format:'jsonl',text:JSON.stringify({timestamp:'2026-11-05T10:00:00Z',message:'incident42 timeout password=é猫',token:'multi\nline'})},{path:'worker.log',format:'line',text:'2026-11-05T10:00:01+00:00 ERROR incident42 é猫\n stack multi\nline'}];
 const r=searchLogs({files,query:'incident42',sensitiveValues:['é猫','multi\nline'],limit:10});
 assert.equal(r.matches.length,2);assert.equal(r.matches[1].endLine,3);assert.equal(r.matches[0].line,1);assert.equal(r.matches[0].timestamp,'2026-11-05T10:00:00Z');
 assert.ok(!JSON.stringify(r).includes('é猫'));assert.ok(!JSON.stringify(r).includes('multi'));assert.equal(r.complete,true);
 const truncated=searchLogs({files,query:'incident42',sensitiveValues:['é猫','multi\nline'],limit:1});assert.equal(truncated.complete,false);assert.equal(truncated.totalMatches,2);
});
