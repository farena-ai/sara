import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,createWriteStream } from 'node:fs';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { McpManager,mcpToolName } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Permission } from '../src/tools/types.ts';
import { validateTerraform,validateStorybook,validatePreviewUrl } from '../tools/developer-mcp-public/boundaries.mjs';
const out=resolve('outputs/developer-addons/mcp-public');
const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const sandbox={mode:'none' as const,network:true,detail:'Windows owned fixture only; no OS fence'};
const ctx=(root:string)=>({workspaceDir:root,sandbox,signal:AbortSignal.timeout(20_000)});
const fixture=resolve('test/fixtures/developer/mcp-public');
const expected=(name:string)=>JSON.parse(readFileSync(join(fixture,name+'-tools.json'),'utf8')).tools;
const readSnapshot=()=>Object.fromEntries(['Button.js','Button.stories.js'].map(f=>[f,hash(readFileSync(join(fixture,f)))]));
function tree(pid:number){
 const py=process.env.PUBLIC_MCP_PYTHON!;assert.ok(py,'Explicit existing Python/psutil required');
 const r=spawnSync(py,['-c','import psutil,json,sys;p=psutil.Process(int(sys.argv[1]));print(json.dumps([{\"pid\":x.pid,\"created\":x.create_time()} for x in [p]+p.children(recursive=True)]))',String(pid)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
function assertGone(identities:any[]){
 const r=spawnSync(process.env.PUBLIC_MCP_PYTHON!,['-c','import psutil,json,sys;alive=[]\nfor x in json.loads(sys.argv[1]):\n try:\n  p=psutil.Process(x[\"pid\"]);alive.append(x) if p.create_time()==x[\"created\"] else None\n except psutil.NoSuchProcess:pass\nprint(json.dumps(alive))',JSON.stringify(identities)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[]);
}
async function configured(name:string,config:any,reads:string[],root:string,secrets:any,receipt:any){
 const registry=new ToolRegistry([]);const manager=new McpManager(registry,{dataDir:root,sandbox,secrets:()=>secrets});
 const tools=expected(name);const permissions=Object.fromEntries(tools.map((t:any)=>[mcpToolName(name,t.name),reads.includes(t.name)?'ask':'never'])) as Record<string,Permission>;
 const knownRaw=name==='terraform'?JSON.parse(readFileSync(join(fixture,'terraform-all-tool-names.json'),'utf8')).names:[...tools.map((t:any)=>t.name),'test-run','review-create'];
 for(const raw of knownRaw)if(!reads.includes(raw))permissions[mcpToolName(name,raw)]='never';
 permissions[mcpToolName(name,'unreviewed-new-tool')]='never';
 const store=new SettingsStore(root);store.update({mcpServers:[{...config,enabled:false}],toolPermissions:permissions});
 await manager.start(new SettingsStore(root).get().mcpServers![0]);assert.equal(registry.list().length,0);
 store.update({mcpServers:[{...config,enabled:true}]});const saved=new SettingsStore(root).get();assert.deepEqual(saved.toolPermissions,permissions);
 const c=await manager.start(saved.mcpServers![0]);assert.equal(c.status,'ready',c.error);assert.deepEqual(c.tools,tools);
 const effective=Object.fromEntries(registry.list().map(t=>[t.spec.name,registry.permission(t.spec.name,saved.toolPermissions)]));
 assert.deepEqual(effective,Object.fromEntries(tools.map((t:any)=>[mcpToolName(name,t.name),permissions[mcpToolName(name,t.name)]])));
 assert.deepEqual(registry.enabled(saved.toolPermissions).map(t=>t.spec.name).sort(),reads.map(t=>mcpToolName(name,t)).sort());
 receipt.schemas=c.tools;receipt.policy={saved:saved.toolPermissions,effective,readBackBeforeFeatures:true,disabledStartRegisteredZero:true};writeFileSync(join(out,name+'-policy-before-features.json'),JSON.stringify(receipt.policy,null,2));
 const call=async(raw:string,args:any)=>{assert.ok(reads.includes(raw));const t=registry.get(mcpToolName(name,raw))!;assert.equal(registry.permission(t.spec.name,saved.toolPermissions),'ask');const result=await t.run(args,ctx(root));assert.ok(result.length<30_000,'Output must not reach host clipping boundary');receipt.calls.push({raw,args,result});return result;};
 return {registry,manager,store,permissions,call,config};
}
async function reconnect(h:any,name:string,root:string,receipt:any){
 const stale=h.registry.get(mcpToolName(name,receipt.calls[0].raw))!;h.manager.stopAll();assert.equal(h.registry.list().length,0);
 await assert.rejects(stale.run(receipt.calls[0].args,ctx(root)),/not connected/);
 const saved=new SettingsStore(root).get();assert.deepEqual(saved.toolPermissions,h.permissions);
 const c=await h.manager.start(saved.mcpServers![0]);assert.equal(c.status,'ready',c.error);assert.deepEqual(c.tools,expected(name));
 for(const t of h.registry.list())assert.equal(h.registry.permission(t.spec.name,saved.toolPermissions),h.permissions[t.spec.name]);
 if(name==='terraform'){const identity=JSON.parse(readFileSync(join(out,'terraform-host.identity.json'),'utf8'));receipt.reconnectedIdentities=tree(identity.launcherPid);}
 await assert.rejects(stale.run(receipt.calls[0].args,ctx(root)),/not connected/);
 h.store.update({mcpServers:[{...h.config,enabled:false}]});h.manager.stopAll();await h.manager.start(new SettingsStore(root).get().mcpServers![0]);assert.equal(h.registry.list().length,0);
 receipt.reconnect={persisted:true,staleReferenceRefusedBeforeAndAfterReconnect:true,disabledReadback:true,registryEmpty:true};
}
test('Terraform pinned Windows upstream through actual Sara: public search/document and lifecycle',{skip:process.env.PUBLIC_MCP_QUALIFY!=='1',timeout:90_000},async()=>{
 assert.match(tmpdir().replaceAll('\\','/'),/hermes\/cache\/scratch\/mcp-public/i);const root=mkdtempSync(join(tmpdir(),'terraform-'));const receipt:any={runtime:process.version,scope:'public registry GET only; direct registered calls, not chat approval',calls:[]};let h:any;let identities:any[]=[];
 try{
 const binary=resolve(out,'terraform-bin/terraform-mcp-server.exe');receipt.binarySha256=hash(readFileSync(binary));assert.equal(receipt.binarySha256,JSON.parse(readFileSync('tools/developer-mcp-public/pins.json','utf8')).terraform.binarySha256);
 h=await configured('terraform',{name:'terraform',transport:'stdio',command:process.execPath,args:[resolve('tools/developer-mcp-public/terraform-launch.mjs')]},['search_provider_docs','get_provider_details'],root,{env:{PUBLIC_MCP_BINARY:binary,PUBLIC_MCP_EVIDENCE:join(out,'terraform-host'),TEMP:tmpdir(),TMP:tmpdir()}},receipt);
 const identity=JSON.parse(readFileSync(join(out,'terraform-host.identity.json'),'utf8'));identities=tree(identity.launcherPid);
 const knownIds=new Set<string>();const args={provider_namespace:'hashicorp',provider_name:'random',provider_version:'3.7.2',service_slug:'string',provider_document_type:'resources'};
 validateTerraform('search_provider_docs',args,knownIds);const search=await h.call('search_provider_docs',args);assert.match(search,/hashicorp\/random version: 3\.7\.2/);assert.match(search,/Title: string/);
 for(const m of search.matchAll(/providerDocID: (\d+)/g))knownIds.add(m[1]);assert.ok(knownIds.size>0&&knownIds.size<=5);receipt.discoveredDocIds=[...knownIds];
 const docArgs={provider_doc_id:[...knownIds][0]};validateTerraform('get_provider_details',docArgs,knownIds);const doc=await h.call('get_provider_details',docArgs);assert.match(doc,/random_string/);assert.match(doc,/length/);assert.match(doc,/special/);
 const tool=h.registry.get(mcpToolName('terraform','get_provider_details'))!;await assert.rejects(tool.run({provider_doc_id:'https://outside.invalid'},ctx(root)),/valid number/);
 await reconnect(h,'terraform',root,receipt);receipt.featurePassed=true;
 }catch(e){receipt.failure=String(e);throw e;}finally{h?.manager.stopAll();await pause(2300);identities.push(...(receipt.reconnectedIdentities??[]));assertGone(identities);rmSync(root,{recursive:true,force:true});receipt.cleanup={identities,exited:true,rootRemoved:!existsSync(root)};writeFileSync(join(out,'terraform-host-receipt.json'),JSON.stringify(receipt,null,2));}
});
test('Storybook owned rendered component via pinned MCP and Sara HTTP',{skip:process.env.PUBLIC_MCP_QUALIFY!=='1',timeout:120_000},async()=>{
 const pins=JSON.parse(readFileSync('tools/developer-mcp-public/pins.json','utf8'));assert.equal(hash(readFileSync('tools/developer-mcp-public/package-lock.json')),pins.dependencyLockSha256);
 for(const [pkg,file,inspected] of [['@storybook/addon-mcp','dist/preset.js','storybook-addon'],['storybook','dist/bin/dispatcher.js','storybook-core']])assert.equal(hash(readFileSync(resolve('tools/developer-mcp-public/node_modules',pkg,file))),hash(readFileSync(join(out,'inspection',inspected,'package',file))));
 const root=mkdtempSync(join(tmpdir(),'storybook-'));const before=readSnapshot();const receipt:any={runtime:process.version,scope:'Owned HTML component/story; documentation manifests not supplied by HTML framework; direct calls not chat approval',calls:[],before};let h:any;let browser:any;let identities:any[]=[];let child:any;let port=0;
 try{
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));
 const log=createWriteStream(join(out,'storybook-host-server.log'));
 child=spawn(process.execPath,[resolve('tools/developer-mcp-public/node_modules/storybook/dist/bin/dispatcher.js'),'dev','--port',String(port),'--host','127.0.0.1','--config-dir',resolve('tools/developer-mcp-public/fixture/.storybook'),'--ci','--no-open','--disable-telemetry','--no-version-updates'],{cwd:resolve('tools/developer-mcp-public'),env:{SYSTEMROOT:process.env.SYSTEMROOT,PATH:process.env.PATH,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,TEMP:root,TMP:root,CI:'true',STORYBOOK_DISABLE_TELEMETRY:'1',STORYBOOK_DISABLE_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});child.stdout.pipe(log);child.stderr.pipe(log);
 let index:any;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Storybook exit '+child.exitCode);try{const res=await fetch(`http://127.0.0.1:${port}/index.json`);if(res.ok){index=await res.json();break;}}catch{}await pause(400);}assert.ok(index,'Storybook ready');receipt.index=index;
 const initRes=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'sara-public-qualification',version:'1'}}})});receipt.initialize={status:initRes.status,body:await initRes.text()};assert.equal(initRes.status,200);assert.match(receipt.initialize.body,/10\.6\.6/);
 const stories=new Set<string>(Object.keys(index.entries));assert.deepEqual([...stories].sort(),['owned-button--disabled','owned-button--primary']);
 h=await configured('storybook',{name:'storybook',transport:'http',url:`http://127.0.0.1:${port}/mcp`},['stories-preview','stories-find-by-component'],root,{},receipt);
 const component=join(fixture,'Button.js');const findArgs={componentPaths:[component]};validateStorybook('stories-find-by-component',findArgs,stories,component);const found=await h.call('stories-find-by-component',findArgs);assert.match(found,/owned-button--primary/);assert.match(found,/owned-button--disabled/);
 const previewArgs={stories:[...stories].map(storyId=>({storyId}))};validateStorybook('stories-preview',previewArgs,stories,component);const result=await h.call('stories-preview',previewArgs);receipt.previewRaw=result;
 const urls=[...result.matchAll(/http:\/\/[^\s"<>]+/g)].map(m=>m[0].replace(/[),]$/,''));receipt.previewUrls=urls;assert.ok(urls.length>=2);
 const pwPath=process.env.PUBLIC_MCP_PLAYWRIGHT!;assert.ok(pwPath,'Existing compatible Playwright required');const pw=await import(pathToFileURL(pwPath).href);receipt.playwrightModule=pwPath;
 browser=await pw.chromium.launchPersistentContext(join(root,'browser-profile'),{headless:true});receipt.browserVersion=browser.browser()?.version();
 const blocked:string[]=[];await browser.route('**/*',async(route:any)=>{const u=new URL(route.request().url());if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==String(port)){blocked.push(u.origin);await route.abort();}else await route.continue();});
 receipt.rendered=[];for(const value of [...new Set(urls)]){const u=validatePreviewUrl(value,port,stories);const id=u.searchParams.get('path')!.slice(7);const page=await browser.newPage();await page.goto(u.href,{waitUntil:'domcontentloaded'});const button=page.frameLocator('#storybook-preview-iframe').getByRole('button',{name:id.endsWith('disabled')?'SARA PUBLIC MCP DISABLED':'SARA PUBLIC MCP PRIMARY',exact:true});await button.waitFor({timeout:25_000});assert.equal(await button.isDisabled(),id.endsWith('disabled'));receipt.rendered.push({id,label:await button.textContent(),disabled:await button.isDisabled()});await page.screenshot({path:join(out,id+'.png')});await page.close();}
 assert.equal(receipt.rendered.length,2);receipt.blockedExternalOrigins=[...new Set(blocked)];await browser.close();browser=undefined;
 // Upstream unknown story is a real error result, not a fabricated response.
 const unknown=await h.call('stories-preview',{stories:[{storyId:'owned-button--missing'}]});assert.equal(unknown,'No story found for story ID "owned-button--missing"');receipt.unknownStoryRefused=true;
 // Test/docs toolsets are not registered for this fixture; a client header must not create them.
 const post=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','X-MCP-Toolsets':'test,docs'},body:JSON.stringify({jsonrpc:'2.0',id:100,method:'tools/list',params:{}})});receipt.headerToolsetProbe={status:post.status,body:await post.text()};assert.equal(post.status,200);const rpcMessages=receipt.headerToolsetProbe.body.split('\n').filter((line:string)=>line.startsWith('data:')).map((line:string)=>JSON.parse(line.slice(5)));assert.deepEqual(rpcMessages.find((msg:any)=>msg.id===100).result.tools,[]);
 await reconnect(h,'storybook',root,receipt);assert.deepEqual(readSnapshot(),before);receipt.after=readSnapshot();receipt.featurePassed=true;
 }catch(e){receipt.failure=String(e);throw e;}finally{await browser?.close();h?.manager.stopAll();if(child){identities=tree(child.pid);child.kill();}await pause(2500);assertGone(identities);if(port)await assert.rejects(fetch(`http://127.0.0.1:${port}/index.json`));rmSync(root,{recursive:true,force:true});receipt.cleanup={identities,exited:true,listenerClosed:true,rootRemoved:!existsSync(root)};writeFileSync(join(out,'storybook-host-receipt.json'),JSON.stringify(receipt,null,2));}
});
