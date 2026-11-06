import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PluginManager} from '../src/plugins/manager.ts';
import {pluginToolName} from '../src/plugins/manifest.ts';
import {fromFolder,fromZip,hashFiles} from '../src/packages.ts';
import {packPath} from '../src/store/pack.ts';
import {splitListing} from '../src/store/checks.ts';
import {makeApp,ROOT,tempDir} from './helpers.ts';
// @ts-expect-error Pure fixture module; generated keys stay in memory.
import {ids,fixtureArgs} from '../tools/developer-data/fixtures.mjs';
async function until(check:()=>boolean) {const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'ready/cleanup deadline');await new Promise(r=>setTimeout(r,20));}}
for(const id of ids as string[]) test(`${id}: official pack/smoke exact bytes → real manager trust/enable/run/card/disable`,{timeout:45000},async t=>{
 const {dir,cleanup}=tempDir(); mkdirSync(join(dir,'other')); const main=makeApp(dir,{now:new Date('2026-11-05T12:00:00Z')}),other=makeApp(join(dir,'other'),{now:new Date('2026-11-05T12:00:00Z')});
 main.companionId='main';other.companionId='other';
 for(const app of [main,other]) app.providerFactory=()=>{throw new Error('No model allowed');};
 const pm=new PluginManager({db:main.store.db,dataDir:dir,vault:main.vault,sandbox:main.sandbox,events:main.events,scrub:s=>s,fence:'node-only',saraVersion:'2.68.0',lookup:async()=>{throw new Error('No DNS');},httpGet:async()=>{throw new Error('No HTTP');}});
 for(const app of [main,other]) {app.pluginManager=pm;pm.attach(app.companionId!,app);}
 try {
  const source=join(ROOT,'store/plugins',id);
  const packed=await packPath(source,{saraVersion:'2.68.0',smoke:'node-only',scratch:dir,watchMs:80,readyMs:10000});
  assert.equal(packed.report.ready,true,JSON.stringify(packed.report.results));assert.equal(packed.report.smoke,'ran');
  const runtime=(files:ReturnType<typeof fromFolder>)=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
  const files=runtime(fromZip(packed.zip));assert.equal(hashFiles(files),hashFiles(runtime(fromFolder(source))));assert.equal(hashFiles(files),packed.report.contentSha);
  const review=pm.stage(files,{kind:'zip',where:`synthetic-${id}.zip`});assert.equal(review.needsTrust,true);
  await assert.rejects(pm.approve(review.id),/trust this plugin.s author/i);
  const row=await pm.approve(review.id,{trust:true});assert.equal(pm.enabledFor(id,'main'),false);
  assert.equal(pm.store.get(id)!.approved_sha,hashFiles(files));assert.equal(hashFiles(fromFolder(row.dir)),hashFiles(files));
  assert.equal(pm.verify(id),true);assert.equal(other.tools.get(pluginToolName(id,'analyze')),undefined);
  await pm.setEnabled(id,'main',true);const full=pluginToolName(id,'analyze');await until(()=>main.tools.get(full)?.isAvailable?.()===true);
  const tool=main.tools.get(full)!;assert.equal(tool.defaultPermission,'ask');assert.equal(main.tools.permission(full,{}),'ask');
  const cards:any[]=[];
  const args=fixtureArgs(id);const content=await tool.run(args,{workspaceDir:dir,sandbox:main.sandbox,signal:AbortSignal.timeout(10000),attachCard:c=>cards.push(c)});
  const report=JSON.parse(content);assert.ok(Buffer.byteLength(content)<48000);assert.equal(cards.length,1);assert.equal(cards[0].plugin,id);
  if(id==='database-fixture-studio')assert.equal(report.tables.child.length,5);else {assert.deepEqual(report.payloads.map((p:any)=>p.valid),[false,true]);const proto=JSON.parse(await tool.run({format:'protobuf',before:'syntax="proto3"; message Item { int32 id=1; }',after:'syntax="proto3"; message Item { string id=1; }',message:'Item',payloads:['{"id":1}','{"id":"synthetic"}']},{workspaceDir:dir,sandbox:main.sandbox,signal:AbortSignal.timeout(10000)}));assert.equal(proto.compatible,false);assert.deepEqual(proto.payloads.map((p:any)=>p.valid),[false,true]);assert.ok(proto.payloads[1].wireBytes>0);}
  // Reviewed defects also execute through the exact approved registered tool.
  const context={workspaceDir:dir,sandbox:main.sandbox,signal:AbortSignal.timeout(10000)};
  const reviewedChecks:string[]=[];
  if(id==='database-fixture-studio'){
   const db=new DatabaseSync(':memory:');try{db.exec(report.sql);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
   const table=(name:string)=>({name,rows:1,columns:[{name:'id',type:'integer'}]});
   for(const tables of [[table('Users'),table('users')],[table('sQlItE_fixture')],[{...table('Users'),columns:[{name:'id',type:'integer'},{name:'ID',type:'integer'}]}]])await assert.rejects(()=>tool.run({seed:1,tables},context));
   reviewedChecks.push('R2-04');
  }else{
   const source='syntax="proto3"; enum Status { ZERO=0; YES=1; } message Item { Status status=1; int32 n=2; }';
   const renamed=JSON.parse(await tool.run({format:'protobuf',before:source,after:source.replaceAll('Status','State'),message:'Item',payloads:['{"status":1,"n":2}']},context));assert.equal(renamed.compatible,true);assert.equal(renamed.payloads[0].valid,true);
   for(const n of ['2147483648','-2147483649','9007199254740993'])await assert.rejects(()=>tool.run({format:'protobuf',before:source,after:source.replace('YES=1','YES='+n),message:'Item',payloads:['{}']},context));
   for(const [before,after] of [[{type:'integer'},{type:'number'}],[{type:'string'},{}],[{type:'object'},{type:'object',properties:{x:{}}}],[{type:'array'},{type:'array',items:{}}],[{enum:[{a:1,b:2}]},{enum:[{b:2,a:1}]}]]){const result=JSON.parse(await tool.run({format:'json-schema',before:JSON.stringify(before),after:JSON.stringify(after),payloads:['{}']},context));assert.equal(result.compatible,true);}
   reviewedChecks.push('R2-03','R2-05','R2-06');
  }
  // Runtime validates malformed content too; no fixture call/card auto-acknowledgements.
  await assert.rejects(()=>tool.run({unexpected:'not permitted'},{workspaceDir:dir,sandbox:main.sandbox,signal:AbortSignal.timeout(10000)}));
  assert.deepEqual(pm.waiting(),[]);assert.equal(main.providerCalls,0);assert.equal(other.providerCalls,0);
  assert.deepEqual(pm.store.logs(id).filter(l=>l.kind==='call'||l.kind==='denied'),[]);
  assert.deepEqual(main.store.db.prepare("SELECT * FROM budget_ledger WHERE source LIKE 'plugin:%'").all(),[]);
  const approvedSha=pm.store.get(id)!.approved_sha;
  await pm.setEnabled(id,'main',false);assert.equal(main.tools.get(full),undefined);assert.equal(tool.isAvailable?.(),false);
  assert.equal(pm.enabledFor(id,'other'),false);assert.ok(!existsSync(pm.dataDirFor(id,'other')));
  const out=join(ROOT,'outputs/developer-addons/data');mkdirSync(out,{recursive:true});writeFileSync(join(out,id+'.zip'),packed.zip);
  const fileHashes=Object.fromEntries(files.map(f=>[f.path,createHash('sha256').update(f.data).digest('hex')]));
  const receipt={id,saraVersion:'2.68.0',fence:pm.fence,osSandboxQualified:false,chatApprovalQualified:false,approvedSha,contentSha:packed.report.contentSha,archiveSha256:packed.sha256,archiveBytes:packed.size,fileHashes,report,cards,reviewedChecks,checks:{pack:true,smoke:true,trustRequired:true,explicitEnable:true,registeredInvoke:true,resultCard:true,otherCompanionOff:true,disable:true}};
  writeFileSync(join(out,id+'-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  assert.equal(createHash('sha256').update(readFileSync(join(out,id+'.zip'))).digest('hex'),packed.sha256);
  t.diagnostic(JSON.stringify({id,approvedSha,archiveSha256:packed.sha256,bytes:Buffer.byteLength(content),checks:receipt.checks}));
 } finally {await pm.stopAll();for(const app of [main,other]){assert.ok(!app.tools.list().some(x=>x.source?.startsWith('Plugin: ')));app.store.close();}cleanup();await until(()=>{cleanup();return !existsSync(dir);});const cleanupOut=join(ROOT,'outputs/developer-addons/data-fix');mkdirSync(cleanupOut,{recursive:true});writeFileSync(join(cleanupOut,id+'-cleanup.json'),JSON.stringify({id,stopAllAwaited:true,toolsRemoved:true,storesClosed:true,scratchRemoved:!existsSync(dir)},null,2)+'\n');}
});
