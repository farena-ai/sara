import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PluginManager} from '../src/plugins/manager.ts';
import {pluginToolName} from '../src/plugins/manifest.ts';
import {fromFolder,fromZip,hashFiles} from '../src/packages.ts';
import {packPath} from '../src/store/pack.ts';
import {splitListing} from '../src/store/checks.ts';
import {makeApp,ROOT,tempDir} from './helpers.ts';
const id='sql-migration-reviewer';const baseline={tables:[{name:'items',columns:[{name:'id',type:'INTEGER'},{name:'label',type:'TEXT'}],rows:3}]};
async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'ready/cleanup deadline');await new Promise(r=>setTimeout(r,20));}}
test('SQLite official target 2.68 pack/smoke exact bytes and real manager trust/enable/registered safe+unsafe/card/disable',{timeout:60000},async t=>{
 const {dir,cleanup}=tempDir();mkdirSync(join(dir,'other'));const apps=[makeApp(dir,{now:new Date('2026-11-05T12:00:00Z')}),makeApp(join(dir,'other'),{now:new Date('2026-11-05T12:00:00Z')})];apps[0].companionId='main';apps[1].companionId='other';
 for(const app of apps)app.providerFactory=()=>{throw Error('No model allowed');};const main=apps[0];
 const pm=new PluginManager({db:main.store.db,dataDir:dir,vault:main.vault,sandbox:main.sandbox,events:main.events,scrub:s=>s,fence:'node-only',saraVersion:'2.68.0',lookup:async()=>{throw Error('No DNS');},httpGet:async()=>{throw Error('No HTTP');}});
 for(const app of apps){app.pluginManager=pm;pm.attach(app.companionId!,app);}
 const out=join(ROOT,'outputs/developer-addons/sql');mkdirSync(out,{recursive:true});
 try{
  const source=join(ROOT,'store/plugins',id);const packed=await packPath(source,{saraVersion:'2.68.0',smoke:'node-only',scratch:dir,watchMs:80,readyMs:10000});
  assert.equal(packed.report.ready,true,JSON.stringify(packed.report.results));assert.equal(packed.report.smoke,'ran');
  const runtime=(files:ReturnType<typeof fromFolder>)=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));const files=runtime(fromZip(packed.zip));
  assert.equal(hashFiles(files),hashFiles(runtime(fromFolder(source))));assert.equal(hashFiles(files),packed.report.contentSha);
  const review=pm.stage(files,{kind:'zip',where:'synthetic-sql.zip'});assert.equal(review.needsTrust,true);await assert.rejects(pm.approve(review.id),/trust this plugin.s author/i);
  const row=await pm.approve(review.id,{trust:true});assert.equal(pm.enabledFor(id,'main'),false);assert.equal(pm.store.get(id)!.approved_sha,hashFiles(files));assert.equal(hashFiles(fromFolder(row.dir)),hashFiles(files));assert.equal(pm.verify(id),true);
  await pm.setEnabled(id,'main',true);const full=pluginToolName(id,'rehearse');await until(()=>main.tools.get(full)?.isAvailable?.()===true);const tool=main.tools.get(full)!;assert.equal(tool.defaultPermission,'ask');assert.equal(main.tools.permission(full,{}),'ask');
  assert.equal(apps[1].tools.get(full),undefined);const cards:any[]=[];const context={workspaceDir:dir,sandbox:main.sandbox,signal:AbortSignal.timeout(10000),attachCard:(c:any)=>cards.push(c)};
  const safe=JSON.parse(await tool.run({baseline,sql:'CREATE TABLE archive (id INTEGER NOT NULL, label TEXT); CREATE INDEX items_id ON items (id);'},context));assert.equal(safe.status,'rehearsed');assert.equal(safe.authorizerEnforced,true);assert.equal(safe.rollbackVerified,true);assert.deepEqual(safe.before,safe.rollback);assert.equal(safe.dataPreserved,true);assert.equal(safe.after.indexes.length,1);assert.equal(safe.closed,true);
  const unsafe=JSON.parse(await tool.run({baseline,sql:'DROP TABLE items;'},context));assert.equal(unsafe.status,'rejected');assert.equal(unsafe.executedStatements,0);
  const partial=JSON.parse(await tool.run({baseline,sql:'CREATE TABLE fresh (id INTEGER); CREATE TABLE ITEMS (id INTEGER);'},context));assert.equal(partial.status,'rejected');assert.equal(partial.executedStatements,1);assert.equal(partial.rollbackVerified,true);assert.deepEqual(partial.rollback,partial.before);
  for(const sql of ['CREATE TABLE x (id INTEGER DEFAULT (random()))','CREATE TABLE x (id INTEGER); DELETE FROM items;','PRAGMA writable_schema=ON','ATTACH DATABASE \'escape.db\' AS escape']){const r=JSON.parse(await tool.run({baseline,sql},context));assert.equal(r.status,'rejected');assert.equal(r.executedStatements,0);}
  await assert.rejects(()=>tool.run({unexpected:'not permitted'},context));assert.equal(cards.length,7);assert.ok(cards.every(c=>c.plugin===id&&!JSON.stringify(c).includes('CREATE TABLE')));
  assert.deepEqual(pm.waiting(),[]);assert.equal(main.providerCalls,0);assert.equal(apps[1].providerCalls,0);assert.deepEqual(pm.store.logs(id).filter(l=>l.kind==='call'||l.kind==='denied'),[]);assert.deepEqual(main.store.db.prepare("SELECT * FROM budget_ledger WHERE source LIKE 'plugin:%'").all(),[]);
  const approvedSha=pm.store.get(id)!.approved_sha;await pm.setEnabled(id,'main',false);assert.equal(main.tools.get(full),undefined);assert.equal(tool.isAvailable?.(),false);assert.equal(pm.enabledFor(id,'other'),false);assert.ok(!existsSync(pm.dataDirFor(id,'other')));
  writeFileSync(join(out,id+'.zip'),packed.zip);const fileHashes=Object.fromEntries(files.map(f=>[f.path,createHash('sha256').update(f.data).digest('hex')]));assert.equal(createHash('sha256').update(readFileSync(join(out,id+'.zip'))).digest('hex'),packed.sha256);
  const receipt={id,node:process.version,authoringSara:JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8')).version,targetSara:'2.68.0',fence:pm.fence,osSandboxQualified:false,chatApprovalQualified:false,selectedWorkspaceQualified:false,approvedSha,contentSha:packed.report.contentSha,archiveSha256:packed.sha256,archiveBytes:packed.size,fileHashes,packReport:packed.report,safe,unsafe,partial,cards,checks:{pack:true,smoke:true,trustRequired:true,explicitEnable:true,registeredInvocation:true,resultCard:true,enforcedAuthorizer:true,actualRollback:true,otherCompanionOff:true,disable:true}};
  writeFileSync(join(out,id+'-receipt.json'),JSON.stringify(receipt,null,2)+'\n');t.diagnostic(JSON.stringify({approvedSha,archiveSha256:packed.sha256,checks:receipt.checks}));
 }finally{await pm.stopAll();for(const app of apps){assert.ok(!app.tools.list().some(x=>x.source?.startsWith('Plugin: ')));app.store.close();}cleanup();await until(()=>{cleanup();return !existsSync(dir);});writeFileSync(join(out,'host-cleanup.json'),JSON.stringify({stopAllAwaited:true,toolsRemoved:true,storesClosed:true,scratchRemoved:!existsSync(dir)},null,2)+'\n');}
});
