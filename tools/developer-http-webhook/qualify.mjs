import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {makeApp,ROOT,tempDir} from '../../test/helpers.ts';
const id='http-webhook-workbench';
async function until(f){const end=Date.now()+10000;while(!f()){assert.ok(Date.now()<end,'host deadline');await new Promise(r=>setTimeout(r,20));}}
export async function qualify(){
 const fence=process.env.SARA_HTTP_HOST_FENCE??'node-only';
 if(!['node-only','bwrap'].includes(fence))throw Error('SARA_HTTP_HOST_FENCE must be node-only or bwrap');
 const host=process.env.SARA_HTTP_HOST_ROOT??ROOT;
 const load=p=>import(pathToFileURL(join(host,p)).href);
 const [{PluginManager},{pluginToolName},{fromFolder,fromZip,hashFiles},{packPath},{splitListing}]=await Promise.all(['src/plugins/manager.ts','src/plugins/manifest.ts','src/packages.ts','src/store/pack.ts','src/store/checks.ts'].map(load));
 const version=JSON.parse(readFileSync(join(host,'package.json'),'utf8')).version;
 const {dir,cleanup}=tempDir();const app=makeApp(dir);app.companionId='main';app.providerFactory=()=>{throw Error('no model');};
 const pm=new PluginManager({db:app.store.db,dataDir:dir,vault:app.vault,sandbox:app.sandbox,events:app.events,scrub:s=>s,fence,saraVersion:'2.70.0',lookup:async()=>{throw Error('no DNS');},httpGet:async()=>{throw Error('no fetch');}});
 app.pluginManager=pm;pm.attach('main',app);
 const observed=[];const sockets=new Set();
 const seeded=['fixture-header-private','fixture-body-private','fixture-cookie-private','fixture-response-private'];
 const server=createServer((req,res)=>{
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   observed.push({method:req.method,path:req.url,public:req.headers['x-public'],authorization: req.headers.authorization===seeded[0],body:JSON.parse(body||'{}')});
   if(req.url==='/redirect'){res.writeHead(302,{Location:'http://192.168.1.2/never'});res.end();return;}
   if(req.url==='/large'){res.writeHead(200,{'Content-Length':'9000'});res.end('x'.repeat(9000));return;}
   if(req.url==='/slow')return;
   const raw={
    '/collision':Buffer.from('{"password":"alpha","alpha":{"publicObservation":"must survive"},"[REDACTED]":{"different":"later public member"}}'),
    '/invalid-utf8':Buffer.concat([Buffer.from('{"message":"'),Buffer.from([255]),Buffer.from('"}')]),
    '/close-budget':Buffer.from(JSON.stringify({message:'a'.repeat(8900)}))
   };
   if(req.url==='/informational'){res.socket.end('HTTP/1.1 100 Continue\r\nContent-Length: 2\r\n\r\n{}');return;}
   if(raw[req.url]){const body=raw[req.url];res.socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n'+(req.url==='/close-budget'?'Connection: close':`Content-Length: ${body.length}`)+'\r\n\r\n'),body]));return;}
   const payload=JSON.stringify({message:'owned fixture accepted',iteration:observed.length,echo:JSON.parse(body||'{}'),echoHeader:req.headers.authorization,token:seeded[3],cookieEcho:seeded[2]});
   res.writeHead(201,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'Set-Cookie':seeded[2],'X-Public':'owned-fixture'});res.end(payload);
  });
 });server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const output=process.env.SARA_HTTP_OUTPUT??join(ROOT,'outputs/developer-addons/http-webhook');
 try{
  const source=join(ROOT,'store/plugins',id);
  const packed=await packPath(source,{saraVersion:'2.70.0',smoke:fence,scratch:dir,watchMs:80,readyMs:10000});
  assert.equal(packed.report.ready,true,JSON.stringify(packed.report.results));assert.equal(packed.report.smoke,'ran');
  const runtime=f=>splitListing(f).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));const files=runtime(fromZip(packed.zip));
  assert.equal(hashFiles(files),hashFiles(runtime(fromFolder(source))));assert.equal(hashFiles(files),packed.report.contentSha);
  const staged=pm.stage(files,{kind:'zip',where:'owned-http-fixture.zip'});assert.equal(staged.fence,fence);assert.equal(staged.needsTrust,fence==='node-only');if(fence==='node-only')await assert.rejects(pm.approve(staged.id),/trust/i);
  await pm.approve(staged.id,{trust:true});assert.equal(pm.enabledFor(id,'main'),false);assert.equal(pm.store.get(id).approved_sha,packed.report.contentSha);
  await pm.putSettings(id,'main',{endpoint:`127.0.0.1:${port}`});await pm.setEnabled(id,'main',true);
  const full=pluginToolName(id,'request');await until(()=>app.tools.get(full)?.isAvailable?.()===true);const tool=app.tools.get(full);assert.equal(tool.defaultPermission,'ask');assert.equal(app.tools.permission(full,{}),'ask');
  const cards=[];const call=async args=>JSON.parse(await tool.run(args,{workspaceDir:dir,sandbox:app.sandbox,signal:AbortSignal.timeout(40000),attachCard:c=>cards.push(c)}));
  const report=await call({method:'POST',path:'/hook',headers:{Authorization:seeded[0],'Content-Type':'application/json','X-Public':'fixture-public'},body:JSON.stringify({event:'owned.test',password:seeded[1],echo:seeded[1]}),replay:true});
  assert.equal(report.ok,true);assert.equal(observed.length,2);assert.deepEqual(observed.map(r=>r.method),['POST','POST']);assert.ok(observed.every(r=>r.authorization&&r.body.password===seeded[1]));
  assert.equal(report.responses[0].status,201);assert.equal(report.responses[0].body.message,'owned fixture accepted');assert.equal(report.responses[0].headers['x-public'],'owned-fixture');assert.equal(report.replay.count,2);assert.equal(report.replay.sameStatus,true);assert.equal(report.replay.sameBody,false);assert.equal(cards.length,1);assert.equal(cards[0].plugin,id);
  const controls=[];
  for(const args of [{method:'GET',path:'http://example.com/'},{method:'POST',path:'/',headers:{Host:'bad'}},{method:'GET',path:'/redirect'},{method:'GET',path:'/large'},{method:'GET',path:'/slow'},...['/collision','/close-budget','/invalid-utf8','/informational'].map(path=>({method:'GET',path}))]){
   const before=observed.length;const r=await call(args);assert.equal(r.ok,false);controls.push({path:args.path,ok:r.ok,requests:observed.length-before});
  }
  assert.deepEqual(controls.map(c=>c.requests),[0,0,1,1,1,1,1,1,1]);
  assert.equal(cards.length,1+controls.length);assert.ok(cards.every(c=>c.plugin===id));
  const logs=pm.store.logs(id);for(const secret of seeded){assert.ok(!JSON.stringify({report,cards,logs}).includes(secret),'no seeded raw secrets in outputs');}
  assert.equal(app.providerCalls,0);assert.deepEqual(pm.waiting(),[]);
  const approvedSha=pm.store.get(id).approved_sha;await pm.setEnabled(id,'main',false);assert.equal(app.tools.get(full),undefined);assert.equal(tool.isAvailable?.(),false);
  mkdirSync(output,{recursive:true});writeFileSync(join(output,id+'.zip'),packed.zip);
  const receipt={id,targetSara:'2.70.0',hostVersion:version,hostRoot:resolve(host),hostModuleSha256:createHash('sha256').update(readFileSync(join(host,'src/plugins/manager.ts'))).digest('hex'),fence,osSandboxQualified:false,osSandboxScope:fence==='bwrap'?'actual broker fixture lifecycle only; not a general sandbox safety assessment':'not exercised',chatApprovalQualified:false,approvedSha,contentSha:packed.report.contentSha,archiveSha256:packed.sha256,archiveBytes:packed.size,fileHashes:Object.fromEntries(files.map(f=>[f.path,createHash('sha256').update(f.data).digest('hex')])),report,cards,controls,fixture:{requests:observed.length,approvedPosts:2,rawSeededValuesAbsent:true},checks:{pack:true,smoke:true,stage:true,trust:true,explicitEnable:true,registeredInvoke:true,card:true,disable:true}};
  writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
 }finally{
  await pm.stopAll();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await until(()=>sockets.size===0);app.store.close();cleanup();await until(()=>{cleanup();return !existsSync(dir);});
  mkdirSync(output,{recursive:true});writeFileSync(join(output,'cleanup.json'),JSON.stringify({serverClosed:!server.listening,sockets:sockets.size,tempRemoved:!existsSync(dir)}));
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await qualify()));
