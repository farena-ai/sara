import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {McpManager,mcpToolName} from '../src/tools/mcp.ts';
import {ToolRegistry} from '../src/tools/registry.ts';
import {SettingsStore} from '../src/settings.ts';
import type {Permission} from '../src/tools/types.ts';
const out=resolve('outputs/developer-addons/mcp-qdrant');
const python=join(out,'venv/Scripts/python.exe');const server=resolve('tools/developer-mcp-qdrant/server.py');
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sandbox={mode:'none' as const,network:false,detail:'Owned Windows fixture; Python audit defense is not an OS fence'};
const expected=JSON.parse(readFileSync('test/fixtures/developer/mcp-qdrant/tools.json','utf8')).tools;
test('Sara real MCP lifecycle, saved Ask/Off before real engine feature, exact schema, reconnect and owned process cleanup',{skip:process.env.QDRANT_LOCAL_QUALIFY!=='1',timeout:60_000},async()=>{
 assert.match(tmpdir().replaceAll('\\','/'),/hermes\/cache\/scratch\/mcp-qdrant/i);
 const home=mkdtempSync(join(tmpdir(),'mcp-qdrant-'));const registry=new ToolRegistry([]);
 const manager=new McpManager(registry,{dataDir:join(home,'sara'),sandbox,secrets:()=>({env:{QDRANT_API_KEY:'synthetic-never-forwarded',HTTPS_PROXY:'https://proxy.invalid'}})});
 const receipt:any={scope:'Real embedded engine and direct registered Sara MCP fixture calls only; NOT chat approval, remote service or OS fence',calls:[],identities:[],runtimeHashes:Object.fromEntries(['server.py','seed.py','requirements-windows.lock'].map(p=>[p,hash(resolve('tools/developer-mcp-qdrant',p))])),schemaSha256:hash('test/fixtures/developer/mcp-qdrant/tools.json'),passed:false};
 const permissions:Record<string,Permission>={[mcpToolName('qdrant-fixture','qdrant-local-search')]:'ask'};
 for(const raw of ['qdrant-store','qdrant-find','delete_collection','create_collection','upsert','unreviewed-new-tool'])permissions[mcpToolName('qdrant-fixture',raw)]='never';
 const ctx={workspaceDir:home,sandbox,signal:AbortSignal.timeout(20_000)};
 try{
  const r=spawnSync(python,['-I',resolve('tools/developer-mcp-qdrant/seed.py'),home],{env:{SYSTEMROOT:process.env.SYSTEMROOT,HOME:home,USERPROFILE:home,TEMP:home,TMP:home,TMPDIR:home},encoding:'utf8'});assert.equal(r.status,0,r.stderr);const seeded=JSON.parse(r.stdout);
  const storeFiles=['meta.json','.lock','collection/owned-vectors/storage.sqlite'];
  const storeHashes=()=>Object.fromEntries(storeFiles.map(p=>[p,hash(join(home,'store',p))]));
  const before=storeHashes();receipt.storeHashesBefore=before;
  const config={name:'qdrant-fixture',enabled:false,transport:'stdio' as const,command:python,args:['-I',server,home,seeded.seal]};
  mkdirSync(join(home,'sara'));const store=new SettingsStore(join(home,'sara'));store.update({mcpServers:[config],toolPermissions:permissions});
  await manager.start(new SettingsStore(join(home,'sara')).get().mcpServers![0]);assert.deepEqual(registry.list(),[]);assert.equal(existsSync(join(home,'runtime.json')),false);
  store.update({mcpServers:[{...config,enabled:true}]});const saved=new SettingsStore(join(home,'sara')).get();assert.deepEqual(saved.toolPermissions,permissions);
  const c=await manager.start(saved.mcpServers![0]);assert.equal(c.status,'ready',c.error);assert.deepEqual(c.tools,expected);
  receipt.identities.push(JSON.parse(readFileSync(join(home,'runtime.json'),'utf8')));assert.equal(receipt.identities[0].engineImported,false);assert.equal(receipt.identities[0].environmentKeys.includes('HTTPS_PROXY'),false);assert.equal(receipt.identities[0].environmentKeys.includes('QDRANT_API_KEY'),false);
  const name=mcpToolName(config.name,'qdrant-local-search');assert.equal(registry.permission(name,saved.toolPermissions),'ask');assert.deepEqual(registry.enabled(saved.toolPermissions).map(t=>t.spec.name),[name]);
  receipt.savedPolicy=saved.toolPermissions;receipt.schemas=c.tools;receipt.disabledBeforeLaunch=true;writeFileSync(join(out,'policy-before-features.json'),JSON.stringify(receipt,null,2));
  const tool=registry.get(name)!;const args={collection:'owned-vectors',vector:[1,0,0],limit:2};const result=await tool.run(args,ctx);assert.ok(Buffer.byteLength(result)<8192);const data=JSON.parse(result);assert.deepEqual(data.points.map((p:any)=>p.id),[1,2]);receipt.calls.push({args,result});
  await assert.rejects(tool.run({...args,collection:'foreign'},ctx),/refused/);await assert.rejects(tool.run({...args,vector:[1,0]},ctx),/refused/);await assert.rejects(tool.run({...args,url:'https://outside.invalid'},ctx),/refused/);
  manager.stopAll();assert.deepEqual(registry.list(),[]);await assert.rejects(tool.run(args,ctx),/not connected/);await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(storeHashes(),before);
  assert.deepEqual(new SettingsStore(join(home,'sara')).get().toolPermissions,permissions);
  const re=await manager.start(new SettingsStore(join(home,'sara')).get().mcpServers![0]);assert.equal(re.status,'ready',re.error);assert.deepEqual(re.tools,expected);receipt.identities.push(JSON.parse(readFileSync(join(home,'runtime.json'),'utf8')));
  await assert.rejects(tool.run(args,ctx),/not connected/);assert.equal(registry.permission(name,store.get().toolPermissions),'ask');
  const again=JSON.parse(await registry.get(name)!.run({collection:'owned-vectors',vector:[0,1,0],limit:2},ctx));assert.deepEqual(again.points.map((p:any)=>p.id),[3,2]);receipt.calls.push({args:{collection:'owned-vectors',vector:[0,1,0],limit:2},result:again});
  store.update({mcpServers:[{...config,enabled:false}]});manager.stopAll();await manager.start(new SettingsStore(join(home,'sara')).get().mcpServers![0]);assert.deepEqual(registry.list(),[]);
  await new Promise(r=>setTimeout(r,500)); // Wait for upstream close/release before reading the exclusively locked .lock file.
  receipt.storeHashesAfter=storeHashes();assert.deepEqual(receipt.storeHashesAfter,before);receipt.fixtureUnchanged=true;receipt.reconnectPolicyPersisted=true;receipt.staleReferencesRefused=true;receipt.passed=true;
 }catch(e){receipt.failure=String(e);throw e;}finally{
  manager.stopAll();await new Promise(r=>setTimeout(r,500));
  for(const identity of receipt.identities){const r=spawnSync(python,['-I','-c','import runpy,sys,json;api=runpy.run_path(sys.argv[1]);print(json.dumps(api["process_identity"](int(sys.argv[2]))))',server,String(identity.pid)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.notDeepEqual(JSON.parse(r.stdout),{pid:identity.pid,created:identity.created});}
  rmSync(home,{recursive:true,force:true});receipt.cleanup={exactPidBirthIdentitiesGone:true,ownedHomeRemoved:!existsSync(home)};writeFileSync(join(out,'host-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 }
});
