import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

export async function stagedHome() {
 const home=mkdtempSync(join(tmpdir(),'devbench-protocol-')),source=join(home,'source');mkdirSync(source);
 const before={openapi:'3.0.3',info:{title:'Fixture',version:'1'},paths:{'/pets':{get:{responses:{'200':{description:'OK'}}}}}};
 writeFileSync(join(source,'before.json'),JSON.stringify(before));writeFileSync(join(source,'after.json'),JSON.stringify({...before,paths:{}}));writeFileSync(join(source,'README.md'),'Synthetic snapshot, not a build receipt.');
 const {stageSnapshot}=await import('../tools/developer-workbench/repo-map.mjs');await stageSnapshot(source,home);return home;
}
test('real Node stdio initialize/initialized/list/call/cancel/shutdown and malformed protocol', {timeout:15000}, async t => {
 const server=resolve('tools/developer-workbench/server.mjs');assert.ok(existsSync(server),'real stdio MCP exists');const home=await stagedHome();
 const child=spawn(process.execPath,[server],{cwd:home,stdio:['pipe','pipe','pipe']});const responses=new Map<number,any>();let stderr='';child.stderr.on('data',b=>stderr+=b);
 const exit=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);responses.set(m.id,m);});
 const send=(m:object)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
 async function answer(id:number) {const until=Date.now()+5000;while(!responses.has(id)){assert.ok(Date.now()<until,'response deadline');await new Promise(r=>setTimeout(r,5));}return responses.get(id);}
 try {
  send({id:1,method:'tools/list',params:{}});assert.ok((await answer(1)).error);
  send({id:2,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});assert.equal((await answer(2)).result.protocolVersion,'2025-06-18');
  send({method:'notifications/initialized'});send({id:3,method:'tools/list',params:{}});const tools=(await answer(3)).result.tools;assert.deepEqual(tools.map((x:any)=>x.name),['contract_diff','repo_map']);assert.ok(tools.every((x:any)=>x.inputSchema.additionalProperties===false));
  send({id:4,method:'tools/call',params:{name:'contract_diff',arguments:{format:'openapi3',before:'before.json',after:'after.json'}}});const diff=JSON.parse((await answer(4)).result.content[0].text);assert.equal(diff.compatible,false);assert.equal(diff.evidence.before.file,'before.json');assert.equal(diff.findings[0].before,'/paths/~1pets/get');
  send({id:5,method:'tools/call',params:{name:'repo_map',arguments:{}}});const map=JSON.parse((await answer(5)).result.content[0].text);assert.equal(map.files.length,3);assert.equal(map.buildExecuted,false);
  send({id:6,method:'tools/call',params:{name:'repo_map',arguments:{root:'C:/'}}});assert.equal((await answer(6)).result.isError,true);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'repo_map',arguments:{}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:7}})+'\n');assert.match(JSON.stringify(await answer(7)),/cancelled/);
  child.stdin.write('{broken\n');assert.equal((await answer(null as any)).error.code,-32700);
  send({id:8,method:'shutdown'});assert.equal((await answer(8)).result,null);child.stdin.end();assert.deepEqual(await exit,{code:0,signal:null});assert.equal(stderr,'');t.diagnostic(JSON.stringify({tools:tools.map((x:any)=>x.name),diff,map,shutdown:'exit0',cancellation:responses.get(7)}));
 }finally{if(child.exitCode===null)child.kill();await exit;rmSync(home,{recursive:true,force:true});}
});
