import test from 'node:test';import assert from 'node:assert/strict';
test('environment validates actual supplied dotenv and config rules without any values or digests',async()=>{
 const {checkEnvironment}=await import('../tools/developer-evidence/environment.mjs');
 const rules=[{name:'PORT',type:'integer',required:true,secret:false,min:1,max:65535},{name:'API_TOKEN',type:'string',required:true,secret:true,minLength:8},{name:'MODE',type:'enum',required:true,secret:false,values:['dev','prod']}];
 const r=checkEnvironment({format:'dotenv',text:'PORT=nope\nAPI_TOKEN="x"\nMODE=dev',rules});assert.deepEqual(r.findings.map((f:any)=>[f.rule,f.status]),[[0,'invalid'],[1,'invalid']]);assert.equal(r.valid,false);assert.ok(!JSON.stringify(r).includes('nope'));assert.ok(!JSON.stringify(r).includes('"x"'));
 const good=checkEnvironment({format:'json',text:'{"PORT":8080,"API_TOKEN":"synthetic-value","MODE":"prod"}',rules});assert.equal(good.valid,true);
 const missing=checkEnvironment({format:'dotenv',text:'PORT=80\nMODE=dev',rules});assert.equal(missing.findings[0].status,'missing');
 for(const text of ['API_TOKEN="PRIVATE\nPORT=4','API_TOKEN=x\nAPI_TOKEN=y','__proto__=PRIVATE'])assert.throws(()=>checkEnvironment({format:'dotenv',text,rules}),/^Error: Invalid supplied evidence$/);
 assert.throws(()=>checkEnvironment({format:'json',text:'{"API_TOKEN":"PRIVATE",BROKEN}',rules}),/^Error: Invalid supplied evidence$/);
});
