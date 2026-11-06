import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('CI fixture dispatch admits only exact owned historical build and rejects all other tools/resources',async()=>{
 assert.ok(existsSync('tools/developer-mcp-ci-viewers/boundaries.mjs'),'CI viewer boundary implementation required');
 const { validateBuildRead }=await import('../tools/developer-mcp-ci-viewers/boundaries.mjs');
 const good={org_slug:'synthetic-owned',pipeline_slug:'historical-viewer',build_number:'42'};
 assert.deepEqual(validateBuildRead('get_build',good),good);
 for(const raw of ['create_build','rebuild_build','cancel_build','get_job_env','read_logs','new_read_tool']) assert.throws(()=>validateBuildRead(raw,good),/not reviewed/);
 for(const args of [{...good,org_slug:'foreign'},{...good,pipeline_slug:'other'},{...good,build_number:'43'},{...good,outputDir:'outside'},{...good,telemetry:{context:'secret'}}])assert.throws(()=>validateBuildRead('get_build',args),/owned historical/);
});

test('synthetic stored API fixture denies all effects and cross-pipeline reads, retaining bytes',async()=>{
 assert.ok(existsSync('tools/developer-mcp-ci-viewers/fixture-api.mjs'),'Synthetic API fixture required');
 const { startFixtureApi }=await import('../tools/developer-mcp-ci-viewers/fixture-api.mjs');
 const f=await startFixtureApi(resolve('test/fixtures/developer/mcp-ci-viewers'));
 try{
  const path='/v2/organizations/synthetic-owned/pipelines/historical-viewer/builds/42';
  assert.deepEqual(await (await fetch(f.url+path)).json(),JSON.parse(readFileSync('test/fixtures/developer/mcp-ci-viewers/historical-build.json','utf8')));
  const query='?exclude_jobs=true&exclude_pipeline=true&include_test_engine=true';
  assert.equal((await fetch(f.url+path+query)).status,200);
  assert.deepEqual(await (await fetch(f.url+path+'/annotations?omit_body=true&page=1&per_page=100&scope=all')).json(),[]);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(f.url+path,{method})).status,405);
  for(const p of [path.replace('synthetic-owned','foreign'),path+'/rebuild',path.replace('42','43'),path+'?extra=1','/v2/user'])assert.equal((await fetch(f.url+p)).status,403);
  assert.ok(f.requests.every((r:any)=>r.allowed=== (r.method==='GET'&&[path,path+query,path+'/annotations?omit_body=true&page=1&per_page=100&scope=all'].includes(r.path))));
 }finally{await f.close();}
 await assert.rejects(fetch(f.url));
});
