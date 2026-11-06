import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const python=resolve('outputs/developer-addons/mcp-qdrant/venv/Scripts/python.exe');
const dir=resolve('tools/developer-mcp-qdrant');
const vectors=JSON.parse(readFileSync('test/fixtures/developer/mcp-qdrant/vectors.json','utf8'));
function env(home:string){return {SYSTEMROOT:process.env.SYSTEMROOT,HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,TMPDIR:home,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'};}
function seed(home:string){const r=spawnSync(python,['-I',join(dir,'seed.py'),home],{env:env(home),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function rpc(home:string,seal:string,messages:any[]){const r=spawnSync(python,['-I',join(dir,'server.py'),home,seal],{env:env(home),input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:20_000});assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').map(x=>JSON.parse(x));}
const request=(id:number,method:string,params:any={})=>({jsonrpc:'2.0',id,method,params});
test('numeric search rejects nonclosed, wrong collection, dimension and expensive requests',{skip:process.env.QDRANT_LOCAL_QUALIFY!=='1'},()=>{
 const home=mkdtempSync(join(tmpdir(),'mcp-qdrant-'));
 const good={collection:'owned-vectors',vector:[1,0,0],limit:2};
 const bad=[{...good,url:'https://outside.invalid'},{...good,collection:'foreign'},{...good,collection:'../owned-vectors'},{...good,vector:[1,0]},{...good,vector:[1,0,0,0]},{...good,vector:['1',0,0]},{...good,vector:[true,0,0]},{...good,vector:[1001,0,0]},{...good,vector:[0,0,0]},{...good,vector:{text:'no inference'}},{...good,vector:[[1],0,0]},{...good,limit:0},{...good,limit:6},{...good,limit:true},{...good,limit:1.5},{...good,filter:{must:[]}},null,[]];
 try{const s=seed(home);const responses=rpc(home,s.seal,[request(1,'initialize'),{method:'notifications/initialized'},...bad.map((a,i)=>request(i+2,'tools/call',{name:'qdrant-local-search',arguments:a}))]);for(const [i,r] of responses.slice(1).entries())assert.ok(r.error,`accepted invalid request ${i}: ${JSON.stringify(bad[i])}`);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('malformed, duplicate, deeply nested and nonfinite protocol inputs fail closed without ending valid session',{skip:process.env.QDRANT_LOCAL_QUALIFY!=='1'},()=>{
 const home=mkdtempSync(join(tmpdir(),'mcp-qdrant-'));
 try{const s=seed(home);const invalid=['{','{"id":1,"id":2,"method":"tools/list"}',JSON.stringify({id:3,method:'tools/call',params:{name:'qdrant-local-search',arguments:{collection:'owned-vectors',vector:[1,0,0],limit:1},extra:'refuse'}}),'{"id":4,"method":"tools/call","params":{"x":'+ '['.repeat(12)+'0'+']'.repeat(12)+'}}','{"id":5,"method":"tools/call","params":{"value":NaN}}'];
 const input=[JSON.stringify(request(10,'initialize')),JSON.stringify({method:'notifications/initialized'}),...invalid,JSON.stringify(request(20,'tools/list'))].join('\n')+'\n';
 const r=spawnSync(python,['-I',join(dir,'server.py'),home,s.seal],{env:env(home),input,encoding:'utf8',timeout:20_000});assert.equal(r.status,0,r.stderr);const responses=r.stdout.trim().split('\n').map(x=>JSON.parse(x));assert.equal(responses.length,7);assert.ok(responses.slice(1,-1).every(r=>r.error));assert.deepEqual(responses.at(-1).result.tools.map((t:any)=>t.name),['qdrant-local-search']);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('real persistent QdrantLocal returns deterministic nearest numeric vectors',{skip:process.env.QDRANT_LOCAL_QUALIFY!=='1'},()=>{
 assert.match(tmpdir().replaceAll('\\','/'),/hermes\/cache\/scratch\/mcp-qdrant/i);
 const home=mkdtempSync(join(tmpdir(),'mcp-qdrant-'));
 try{const s=seed(home);assert.equal(s.engine,'qdrant_client.local.qdrant_local.QdrantLocal');
 const responses=rpc(home,s.seal,[request(1,'initialize',{protocolVersion:'2025-06-18'}),{jsonrpc:'2.0',method:'notifications/initialized'},request(2,'tools/list'),...vectors.queries.map((q:any,i:number)=>request(i+3,'tools/call',{name:'qdrant-local-search',arguments:{collection:'owned-vectors',vector:q.vector,limit:q.limit}}))]);
 assert.deepEqual(responses[1].result.tools.map((x:any)=>x.name),['qdrant-local-search']);
 for(const [i,q] of vectors.queries.entries()){const result=JSON.parse(responses[i+2].result.content[0].text);assert.deepEqual(result.points.map((p:any)=>p.id),q.expectedIds);assert.ok(result.points.every((p:any)=>Number.isFinite(p.score)));}
 }finally{rmSync(home,{recursive:true,force:true});}
});
