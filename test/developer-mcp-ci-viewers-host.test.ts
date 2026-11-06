import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { McpManager,mcpToolName } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Permission } from '../src/tools/types.ts';
import { startFixtureApi } from '../tools/developer-mcp-ci-viewers/fixture-api.mjs';
import { validateBuildRead } from '../tools/developer-mcp-ci-viewers/boundaries.mjs';
const out=resolve('outputs/developer-addons/mcp-ci-viewers');
const fixture=resolve('test/fixtures/developer/mcp-ci-viewers');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const sandbox={mode:'none' as const,network:true,detail:'Owned synthetic loopback only; Windows no OS fence'};
function identities(pid:number){
 const r=spawnSync(process.env.CI_VIEWER_PYTHON!,['-c','import psutil,json,sys;p=psutil.Process(int(sys.argv[1]));print(json.dumps([{\"pid\":x.pid,\"created\":x.create_time(),\"exe\":x.exe()} for x in p.children(recursive=True) if x.name()==\"buildkite-mcp-server.exe\"]))',String(pid)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
function gone(ids:any[]){
 const r=spawnSync(process.env.CI_VIEWER_PYTHON!,['-c','import psutil,json,sys;alive=[]\nfor x in json.loads(sys.argv[1]):\n try:\n  p=psutil.Process(x[\"pid\"]);alive.append(x) if p.create_time()==x[\"created\"] else None\n except psutil.NoSuchProcess:pass\nprint(json.dumps(alive))',JSON.stringify(ids)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[]);
}
test('Jenkins and CircleCI stay disabled: no provider discovery, secret lookup or invented local server',async()=>{
 const root=mkdtempSync(join(tmpdir(),'blocked-ci-'));const registry=new ToolRegistry([]);let lookups=0;
 const manager=new McpManager(registry,{dataDir:root,sandbox,secrets:()=>{lookups++;throw Error('No account authorization');}});
 try{
  const pins=JSON.parse(readFileSync('tools/developer-mcp-ci-viewers/pins.json','utf8'));
  assert.equal(pins.circleci.distribution,null);assert.match(pins.circleci.blocker,/deprecated npm/);assert.match(pins.jenkins.blocker,/No authorized existing controller/);
  const configs=[{name:'ci-circleci',transport:'http' as const,url:pins.circleci.pin.endpoint,enabled:false},{name:'ci-jenkins',transport:'http' as const,url:'https://controller-not-authorized.invalid/mcp-server/mcp',enabled:false}];
  const store=new SettingsStore(root);store.update({mcpServers:configs});
  for(const config of new SettingsStore(root).get().mcpServers!){const c=await manager.start(config);assert.equal(c.status,'stopped');assert.deepEqual(c.tools,[]);}
  assert.equal(lookups,0);assert.deepEqual(registry.list(),[]);
 }finally{manager.stopAll();rmSync(root,{recursive:true,force:true});}
});

test('Buildkite maintained binary through Sara, synthetic historical API only; policies and reconnect cleanup',{skip:process.env.CI_VIEWER_QUALIFY!=='1',timeout:60_000},async()=>{
 assert.match(tmpdir().replaceAll('\\','/'),/hermes\/cache\/scratch\/mcp-ci-viewers/i);
 assert.ok(process.env.CI_VIEWER_PYTHON);mkdirSync(out,{recursive:true});
 const root=mkdtempSync(join(tmpdir(),'host-'));const api=await startFixtureApi(fixture);
 const expected=JSON.parse(readFileSync(join(fixture,'buildkite-tools.json'),'utf8')).tools;
 const binary=resolve(out,'buildkite-bin/buildkite-mcp-server.exe');
 assert.equal(hash(readFileSync(binary)),'eef92c85d25546f767d50717668df5fa3bfbcf29c9b71f60edf749152b73ff2f');
 const registry=new ToolRegistry([]);const cache=join(root,'cache');mkdirSync(cache);
 const env={HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,TMPDIR:root,TEMP:root,TMP:root,BUILDKITE_API_TOKEN:'synthetic-fixture-not-a-provider-token',OTEL_EXPORTER_OTLP_PROTOCOL:'noop'};
 const manager=new McpManager(registry,{dataDir:root,sandbox,secrets:()=>({env})});
 const config={name:'ci-buildkite',transport:'stdio' as const,command:binary,args:['stdio','--read-only','--enabled-toolsets','builds,logs','--base-url',api.url+'/','--cache-url',pathToFileURL(cache).href,'--otel-exporter','noop','--max-log-bytes','65536','--max-log-line-bytes','8192']};
 const permissions=Object.fromEntries(expected.map((t:any)=>[mcpToolName(config.name,t.name),t.name==='get_build'?'ask':'never'])) as Record<string,Permission>;
 for(const name of ['create_build','rebuild_build','cancel_build','retry_job','unblock_job','run_pipeline','new_read_tool'])permissions[mcpToolName(config.name,name)]='never';
 const store=new SettingsStore(root);const receipt:any={scope:'Synthetic client-contract only; not provider acceptance, chat approval or OS sandbox',runtime:process.version,calls:[],identities:[]};
 const ctx={workspaceDir:root,sandbox,signal:AbortSignal.timeout(20_000)};
 const before=hash(readFileSync(join(fixture,'historical-build.json')));
 try{
  store.update({mcpServers:[{...config,enabled:false}],toolPermissions:permissions});
  await manager.start(new SettingsStore(root).get().mcpServers![0]);assert.equal(registry.list().length,0);assert.deepEqual(identities(process.pid),[]);assert.equal(api.requests.length,0);
  store.update({mcpServers:[{...config,enabled:true}]});
  const saved=new SettingsStore(root).get();assert.deepEqual(saved.toolPermissions,permissions);
  const c=await manager.start(saved.mcpServers![0]);assert.equal(c.status,'ready',c.error);assert.deepEqual(c.tools,expected);receipt.schemas=c.tools;
  receipt.identities.push(...identities(process.pid));assert.equal(receipt.identities.length,1);
  for(const t of registry.list())assert.equal(registry.permission(t.spec.name,saved.toolPermissions),permissions[t.spec.name]);
  assert.deepEqual(registry.enabled(saved.toolPermissions).map(t=>t.spec.name),[mcpToolName(config.name,'get_build')]);
  assert.equal(api.requests.length,0);receipt.savedPolicy=saved.toolPermissions;receipt.disabledBeforeLaunch=true;
  writeFileSync(join(out,'buildkite-policy-before-features.json'),JSON.stringify({permissions,schemas:c.tools,apiRequests:api.requests},null,2)+'\n');
  const args={org_slug:'synthetic-owned',pipeline_slug:'historical-viewer',build_number:'42'};
  const tool=registry.get(mcpToolName(config.name,'get_build'))!;
  const result=await tool.run(validateBuildRead('get_build',args),ctx);assert.ok(result.length<12000);assert.match(result,/synthetic-historical-build-42/);assert.match(result,/failed/);assert.match(result,/SYNTHETIC/);receipt.calls.push({raw:'get_build',args,result});
  const count=api.requests.length;for(const a of [{...args,org_slug:'foreign'},{...args,pipeline_slug:'foreign'},{...args,build_number:'43'}])assert.throws(()=>validateBuildRead('get_build',a));assert.equal(api.requests.length,count);
  // Invoke only the reviewed read directly to observe real upstream error conversion; fixture denies wrong selection.
  await assert.rejects(tool.run({...args,build_number:'43'},ctx),/Synthetic fixture boundary refused/);
  manager.stopAll();assert.equal(registry.list().length,0);await assert.rejects(tool.run(args,ctx),/not connected/);
  assert.deepEqual(new SettingsStore(root).get().toolPermissions,permissions);
  const re=await manager.start(new SettingsStore(root).get().mcpServers![0]);assert.equal(re.status,'ready',re.error);assert.deepEqual(re.tools,expected);receipt.identities.push(...identities(process.pid));
  await assert.rejects(tool.run(args,ctx),/not connected/);
  for(const t of registry.list())assert.equal(registry.permission(t.spec.name,store.get().toolPermissions),permissions[t.spec.name]);
  store.update({mcpServers:[{...config,enabled:false}]});manager.stopAll();await manager.start(new SettingsStore(root).get().mcpServers![0]);assert.equal(registry.list().length,0);
  assert.equal(hash(readFileSync(join(fixture,'historical-build.json'))),before);receipt.reconnectPolicyPersisted=true;receipt.staleReferencesRefused=true;receipt.fixtureBytesUnchanged=true;receipt.passed=true;
 }catch(e){receipt.failure=String(e);throw e;}finally{
  manager.stopAll();await new Promise(r=>setTimeout(r,1600));gone(receipt.identities);receipt.requests=api.requests;await api.close();await assert.rejects(fetch(api.url));rmSync(root,{recursive:true,force:true});receipt.cleanup={exactIdentitiesGone:true,listenerClosed:true,ownedHomeRemoved:true};writeFileSync(join(out,'buildkite-host-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 }
});
