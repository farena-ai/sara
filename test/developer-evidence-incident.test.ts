import test from 'node:test';import assert from 'node:assert/strict';
test('incident assembles cited operational chronology not a search wrapper; missing evidence remains unknown',async()=>{
 const {buildIncident}=await import('../tools/developer-evidence/incident.mjs');
 const files=[{path:'deploy.jsonl',kind:'deployment',text:JSON.stringify({timestamp:'2026-11-05T12:00:00+02:00',event:'deployed r2',incident:'INC42'})},{path:'metrics.jsonl',kind:'metric',text:JSON.stringify({timestamp:'2026-11-05T10:01:00Z',event:'error rate 30%',incident:'INC42'})},{path:'notes.jsonl',kind:'operator-note',text:JSON.stringify({timestamp:'2026-11-05T10:02:00',event:'investigating',incident:'INC42'})}];
 const r=buildIncident({files,incident:'INC42',sensitiveValues:[],limit:20});
 assert.equal(r.timeline[0].kind,'deployment');assert.equal(r.timeline[1].kind,'metric');assert.equal(r.timeline[0].utc,'2026-11-05T10:00:00.000Z');assert.equal(r.timeline[0].line,1);assert.equal(r.unordered.length,1);assert.equal(r.complete,false);assert.equal(r.cause,null);assert.equal(r.recovery,null);assert.deepEqual(r.missingEvidence,['cause','recovery']);
 assert.throws(()=>buildIncident({files:[{path:'a',kind:'metric',text:'{"event":"PRIVATE",broken'}],incident:'INC42',sensitiveValues:[],limit:20}),/^Error: Invalid supplied evidence$/);
});
