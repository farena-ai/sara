import test from 'node:test';import assert from 'node:assert/strict';
test('logs protect bearer credentials, connection URLs and multiline private keys across files',async()=>{
 const {searchLogs}=await import('../tools/developer-evidence/logs.mjs');
 const bearer='syntheticBearer',password='tinyPW',pem='-----BEGIN PRIVATE KEY-----\nsyntheticKey\n-----END PRIVATE KEY-----';
 const files=[{path:'setup',format:'line',text:'Authorization: Bearer '+bearer+'\npostgres://user:'+password+'@db.invalid/test\n'+pem},{path:'events',format:'line',text:'2026-11-05T00:00:00Z incident '+bearer+' '+password+' '+pem}];
 const r=searchLogs({files,query:'incident',sensitiveValues:[],limit:10});for(const s of [bearer,password,'syntheticKey'])assert.ok(!JSON.stringify(r).includes(s),s+' escaped');
});
