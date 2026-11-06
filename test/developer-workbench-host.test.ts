import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PluginManager } from '../src/plugins/manager.ts';
import { fromFolder, hashFiles, fromZip } from '../src/packages.ts';
import { splitListing } from '../src/store/checks.ts';
import { packPath } from '../src/store/pack.ts';
import { makeApp, tempDir } from './helpers.ts';
import { McpManager } from '../src/tools/mcp.ts';
import { SettingsStore } from '../src/settings.ts';
import type { PluginCard } from '../src/hooks.ts';
async function until(check:()=>boolean) {const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'host deadline');await new Promise(r=>setTimeout(r,20));}}
const args={before:{openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths:{'/pets':{get:{responses:{'200':{description:'OK'}}}}}},after:{openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths:{}}};
const regressionSchemas=[
 ['request',{type:'object'},{type:'object',properties:{tag:{type:'string'}}}],
 ['request',{type:'object',properties:{tag:{type:'integer'}},additionalProperties:{type:'string'}},{type:'object',additionalProperties:{type:'string'}}],
 ['response',{type:'object',additionalProperties:{type:'integer'}},{type:'object',properties:{tag:{type:'string'}},additionalProperties:{type:'integer'}}]
] as const;
const regressionDocs=regressionSchemas.map(([mode,b,a])=>{
 const doc=(schema:object)=>({openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths:{'/items':{post:{...(mode==='request'?{requestBody:{content:{'application/json':{schema}}}}:{}),responses:{'200':{description:'OK',...(mode==='response'?{content:{'application/json':{schema}}}:{})}}}}}});
 return {before:doc(b),after:doc(a)};
});
test('target2.68 real PluginManager stage/approve/enable/registered result.card/denial/disable and official pack/smoke frozen bytes', {timeout:45000},async t=>{
 const {dir,cleanup}=tempDir(),app=makeApp(dir,{now:new Date('2026-11-05T12:00:00Z')});const pm=new PluginManager({db:app.store.db,dataDir:dir,vault:app.vault,sandbox:app.sandbox,events:app.events,scrub:s=>s,fence:'node-only',saraVersion:'2.68.0',lookup:async()=>{throw new Error('DNS forbidden');},httpGet:async()=>{throw new Error('HTTP forbidden');}});pm.attach('main',app);
 try {
  const folder=resolve('store/plugins/api-contract-guard');const files=splitListing(fromFolder(folder)).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
  const review=pm.stage(files,{kind:'zip',where:'synthetic-contract.zip'});assert.equal(review.needsTrust,true);await assert.rejects(pm.approve(review.id),/trust/i);await pm.approve(review.id,{trust:true});
  const row=pm.store.get('api-contract-guard')!;assert.equal(hashFiles(fromFolder(row.dir)),row.approved_sha);assert.equal(pm.enabledFor(row.id,'main'),false);assert.equal(app.tools.get('api_contract_guard__compare'),undefined);
  await pm.setEnabled(row.id,'main',true);await until(()=>app.tools.get('api_contract_guard__compare')?.isAvailable?.()===true);const tool=app.tools.get('api_contract_guard__compare')!;assert.equal(tool.defaultPermission,'ask');
  app.settings.update({toolPermissions:{[tool.spec.name]:'never'}});const saved=new SettingsStore(dir).get().toolPermissions;assert.equal(app.tools.permission(tool.spec.name,saved),'never');assert.ok(!app.tools.enabled(saved).includes(tool));
  app.settings.update({toolPermissions:{[tool.spec.name]:'ask'}});assert.equal(app.tools.permission(tool.spec.name,new SettingsStore(dir).get().toolPermissions),'ask');
  const cards:PluginCard[]=[];const ctx={workspaceDir:dir,sandbox:app.sandbox,signal:AbortSignal.timeout(10000),attachCard:(c:PluginCard)=>cards.push(c)};
  const report=JSON.parse(await tool.run(args,ctx));assert.equal(report.compatible,false);assert.equal(cards.length,1);assert.equal(cards[0].plugin,row.id);assert.equal(cards[0].title,'API Contract Guard');assert.equal(report.findings[0].before,'/paths/~1pets/get');
  const regressionResults=[];for(const input of regressionDocs){const result=JSON.parse(await tool.run(input,ctx));assert.equal(result.compatible,false);regressionResults.push(result);}assert.equal(cards.length,4,'each corrected regression attaches exactly one invocation card');
  await assert.rejects(tool.run({...args,command:'not allowed'},ctx));assert.deepEqual(pm.waiting(),[]);assert.equal(app.providerCalls,0);assert.deepEqual(app.requests,[]);assert.deepEqual(pm.store.logs(row.id).filter(l=>l.kind==='call'),[]);
  await pm.setEnabled(row.id,'main',false);assert.equal(tool.isAvailable?.(),false);assert.equal(app.tools.get(tool.spec.name),undefined);
  const packed=await packPath(folder,{saraVersion:'2.68.0',smoke:'node-only',scratch:dir,watchMs:100});t.diagnostic(JSON.stringify(packed.report));assert.equal(packed.report.smoke,'ran');assert.equal(packed.report.ready,true);
  const runtime=splitListing(fromZip(packed.zip)).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));assert.equal(hashFiles(runtime),row.approved_sha);assert.equal(packed.report.contentSha,row.approved_sha);
  mkdirSync('outputs/developer-addons/s1',{recursive:true});writeFileSync('outputs/developer-addons/s1/api-contract-guard.zip',packed.zip);writeFileSync('outputs/developer-addons/s1/native-host-pack.json',JSON.stringify({targetSara:'2.68.0',isolatedBase:'2.67.0',fence:pm.fence,approvedSha:row.approved_sha,archiveSha256:packed.sha256,report:packed.report,registeredResult:report,regressionResults,cards},null,2));
 }finally{await pm.stopAll();app.store.close();cleanup();await until(()=>{cleanup();return !existsSync(dir);});}
});
test('actual Sara MCP launcher: explicit disabled config, saved Ask/Off readback/reconnect and direct staged feature calls (not chat approval)',{timeout:30000},async t=>{
 const {dir,cleanup}=tempDir(),app=makeApp(dir,{now:new Date('2026-11-05T12:00:00Z')});const manager=new McpManager(app.tools,{dataDir:dir,sandbox:app.sandbox,secrets:()=>({})});
 try {
  const home=join(dir,'mcp','devbench');mkdirSync(home,{recursive:true});const fixture=join(dir,'source');mkdirSync(fixture);for(const file of ['base.json','removed.json','added.json'])writeFileSync(join(fixture,file),readFileSync(resolve('test/fixtures/developer/workbench/contracts',file)));for(const [i,input] of regressionDocs.entries())for(const side of ['before','after'] as const)writeFileSync(join(fixture,`case${i}-${side}.json`),JSON.stringify(input[side]));const modulePath='../tools/developer-workbench/repo-map.mjs';const {stageSnapshot}=await import(modulePath);await stageSnapshot(fixture,home);
  const backendSha=hashFiles(fromFolder(resolve('tools/developer-workbench')));
  const cfg={name:'devbench',enabled:false,transport:'stdio' as const,command:process.execPath,args:[resolve('tools/developer-workbench/server.mjs')]};
  const policies={'mcp_devbench_contract_diff':'ask' as const,'mcp_devbench_repo_map':'never' as const};app.settings.update({mcpServers:[cfg],toolPermissions:policies});let stored=new SettingsStore(dir).get();assert.equal(stored.mcpServers![0].enabled,false);assert.deepEqual(stored.toolPermissions,policies);
  assert.equal((await manager.start(stored.mcpServers![0])).status,'stopped');assert.equal(app.tools.get('mcp_devbench_contract_diff'),undefined);
  app.settings.update({mcpServers:[{...cfg,enabled:true}]});stored=new SettingsStore(dir).get();assert.equal((await manager.start(stored.mcpServers![0])).status,'ready');
  const name='mcp_devbench_contract_diff',tool=app.tools.get(name)!;assert.equal(tool.defaultPermission,'auto','host readOnly default is NOT Ask');assert.equal(app.tools.permission(name,stored.toolPermissions),'ask');assert.equal(app.tools.permission('mcp_devbench_repo_map',stored.toolPermissions),'never');assert.ok(!app.tools.enabled(stored.toolPermissions).some(t=>t.spec.name==='mcp_devbench_repo_map'));
  const ctx={workspaceDir:dir,sandbox:app.sandbox,signal:AbortSignal.timeout(10000)};const r=JSON.parse(await tool.run({format:'openapi3',before:'base.json',after:'removed.json'},ctx));assert.equal(r.compatible,false);assert.equal(r.evidence.before.file,'base.json');await assert.rejects(tool.run({format:'openapi3',before:'../outside.json',after:'removed.json'},ctx));
  const regressionResults=[];for(const i of regressionDocs.keys()){const result=JSON.parse(await tool.run({format:'openapi3',before:`case${i}-before.json`,after:`case${i}-after.json`},ctx));assert.equal(result.compatible,false);assert.equal(result.evidence.before.file,`case${i}-before.json`);regressionResults.push(result);}
  app.settings.update({toolPermissions:{...policies,mcp_devbench_repo_map:'ask'}});assert.equal(app.tools.permission('mcp_devbench_repo_map',new SettingsStore(dir).get().toolPermissions),'ask');const map=JSON.parse(await app.tools.get('mcp_devbench_repo_map')!.run({},ctx));assert.equal(map.buildExecuted,false);assert.equal(map.files.length,9);app.settings.update({toolPermissions:policies});
  await assert.rejects(tool.run({format:'openapi3',before:'base.json',after:'removed.json'},{...ctx,signal:AbortSignal.abort()}),/Cancelled/);
  manager.stop('devbench');assert.equal(app.tools.get(name),undefined);assert.equal((await manager.start(new SettingsStore(dir).get().mcpServers![0])).status,'ready');assert.deepEqual(new SettingsStore(dir).get().toolPermissions,policies);
  assert.equal(hashFiles(fromFolder(resolve('tools/developer-workbench'))),backendSha);const receipt={backendSha,targetSara:'2.68.0',launcher:'src/tools/mcp.ts',scope:'node fallback on Windows; not OS isolation or chat approval',savedSettings:stored,report:r,regressionResults};t.diagnostic(JSON.stringify(receipt));writeFileSync('outputs/developer-addons/s1/mcp-host.json',JSON.stringify(receipt,null,2));
 }finally{manager.stopAll();app.store.close();cleanup();await until(()=>{cleanup();return !existsSync(dir);});}
});
