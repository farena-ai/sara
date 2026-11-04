import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
class Element {
 children:any[]=[]; listeners:Record<string,Function>={}; textContent=''; value=''; disabled=false; hidden=false; checked=false; attrs:Record<string,string>={}; className=''; id=''; type=''; open=false; focused=false;
 tag=''; constructor(tag=''){this.tag=tag;} append(...n:any[]){this.children.push(...n);} replaceChildren(...n:any[]){this.children=n;} setAttribute(k:string,v:string){this.attrs[k]=v;} addEventListener(k:string,f:Function){this.listeners[k]=f;} focus(){this.focused=true;} showModal(){this.open=true;} close(){this.open=false;this.listeners.close?.();} remove(){} getClientRects(){return [1];}
}
const all=(n:any):any[]=>[n,...n.children.flatMap(all)];
function fixture(module:string,data:any={}) {
 const path=new URL(`../web/${module}.js`,import.meta.url);assert.ok(existsSync(path),`${module} module exists`);
 const root=new Element(),body=new Element();const calls:any[]=[];let owner=true;
 const api=async(p:string,o:any={})=>{calls.push([p,o]);if(data.error)throw Error('fixture');if(typeof data[p]==='function')return data[p](p,o);return data[p]??(p==='/jobs'?[]:p==='/team'?{tasks:[]}:p.startsWith('/deliveries')?{deliveries:[]}:{});};
 const sandbox:any={document:{createElement:(tag:string)=>new Element(tag),body,activeElement:new Element()},t:(s:string,v:any={})=>s.replace(/\{(\w+)\}/g,(_:string,k:string)=>String(v[k])),setTimeout};
 const name=module==='operations'?'createOperations':'createRecovery';
 runInNewContext(readFileSync(path,'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+`\nthis.factory=${name}`,sandbox);
 const instance=sandbox.factory({root,api,isOwner:()=>owner,getDraft:()=>'',getConversation:()=>null});
 return {root,body,calls,data,instance,setOwner:(v:boolean)=>owner=v,find:(text:string)=>all(root).concat(all(body)).find(n=>n.tag==='button'&&n.textContent===text),text:()=>all(root).map(n=>n.textContent).join(' ')};
}
const snapshot={scope:'current-server',since:'2026-11-04T10:00:00.000Z',sampledAt:'2026-11-04T11:00:00.000Z',coverage:'http-responses',requests:{total:50,inFlight:1,peakInFlight:3,sampleCount:50,p50Ms:2,p95Ms:8,maxMs:11,clientErrors:2,serverErrors:1,aborted:0,families:{health:5}},process:{scope:'process-wide',rssBytes:100,eventLoop:{sampleCount:4,p95Ms:1,maxMs:3}},readiness:{database:{status:'ready'},storage:{status:'unknown'},model:{status:'ready',configuredOnly:true},bridges:{status:'not_configured',configured:0,running:0},backup:{status:'unknown',count:0,lastCreatedAt:null,offsiteRestore:{status:'unknown',lastTestAt:null}}},queues:{pending:{status:'ready',total:0,states:{}},jobs:{status:'ready',total:0,states:{}},teams:{status:'ready',total:0,states:{}},deliveries:{status:'ready',total:1,states:{outcome_unknown:1}},databaseBytes:120}};
test('Q4 actual operations handlers render window samples and truthful scope caveats',async()=>{const f=fixture('operations',{'/operations':snapshot});await f.instance.refresh();assert.match(f.text(),/2026-11-04T10/);assert.match(f.text(),/50/);assert.match(f.text(),/successful reply/);assert.match(f.text(),/process-wide/);assert.match(f.text(),/prove recovery/);await f.find('Refresh operations').listeners.click();assert.equal(f.calls.length,2);});
test('Q4 operations unavailable is accessible and refresh recovers; forbidden owner makes no calls',async()=>{const f=fixture('operations',{error:true});await f.instance.refresh();assert.match(f.text(),/unavailable/i);assert.ok(all(f.root).some(n=>n.attrs.role==='status'));f.data.error=false;f.data['/operations']=snapshot;await f.find('Refresh operations').listeners.click();assert.match(f.text(),/50/);f.setOwner(false);await f.instance.refresh();assert.equal(f.calls.length,2);assert.equal(f.root.children.length,0);});
test('Q4 archive requires blank explicit cutoff, read-only preview, second confirmation and fixed batch',async()=>{const before='2026-01-01T00:00:00.000Z';const f=fixture('recovery',{[`/deliveries/archive?before=${encodeURIComponent(before)}`]:{eligible:7},'/deliveries/archive':{archived:7,remaining:0}});await f.instance.refresh();const input=all(f.root).find(n=>n.id==='archive-before');assert.ok(input);assert.equal(input.value,'');await f.find('Preview archive').listeners.click();assert.equal(f.calls.filter(c=>c[0].startsWith('/deliveries/archive')).length,0);input.value=before;input.listeners.input();await f.find('Preview archive').listeners.click();assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);assert.match(all(f.body).map(n=>n.textContent).join(' '),/7/);await f.find('Confirm archive batch').listeners.click();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[1].method==='POST')[1].body)),{before,limit:500});assert.equal(input.value,before);});
test('Q4 changing cutoff invalidates preview and late forbidden role cannot archive',async()=>{const before='2026-01-01T00:00:00.000Z';const f=fixture('recovery',{[`/deliveries/archive?before=${encodeURIComponent(before)}`]:{eligible:3}});await f.instance.refresh();const input=all(f.root).find(n=>n.id==='archive-before');input.value=before;input.listeners.input();await f.find('Preview archive').listeners.click();input.value='2026-02-01T00:00:00.000Z';input.listeners.input();await f.find('Confirm archive batch').listeners.click();assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);f.setOwner(false);await f.instance.refresh();assert.equal(f.root.children.length,0);});
test('Q4 Archived filter requests historical view and archived rows expose no review actions',async()=>{const f=fixture('recovery',{'/deliveries?filter=archived':{deliveries:[{id:'old',state:'outcome_unknown',archivedAt:'2026-01-01T00:00:00.000Z',reviewAvailable:true}]}});await f.instance.refresh();await f.find('Archived').listeners.click();assert.equal(f.find('Review message'),undefined);assert.equal(f.find('I confirmed receipt'),undefined);await f.find('Refresh recovery').listeners.click();assert.equal(f.calls.at(-1)[0],'/deliveries?filter=archived');});
test('Q4 actual settings page inventory omits operations for demo and member roles',()=>{const code=readFileSync(new URL('../web/settings-nav.js',import.meta.url),'utf8');const expr=/export const settingsPages = \(\) =>[\s\S]*?\n  \);/.exec(code)![0].replace('export ','');for(const role of ['demo','member','owner']){const page={dataset:{page:'dh-operations',ownerOnly:''}};const sandbox:any={document:{querySelectorAll:()=>[page],body:{classList:{contains:()=>role==='demo'}}},navigator:{userAgent:''},window:{},isMember:()=>role==='member'};runInNewContext(expr+';this.pages=settingsPages()',sandbox);assert.equal(sandbox.pages.length,role==='owner'?1:0);}});


test('Q4 operation record counts and backup evidence never masquerade as approvals or successful restore',async()=>{const data:any=structuredClone(snapshot);data.readiness.backup={status:'ready',count:1,lastCreatedAt:'2026-01-01T00:00:00.000Z',offsiteRestore:{status:'unavailable',lastTestAt:'2026-01-01T01:00:00.000Z'}};data.queues.jobs.states={running:2,completed:8};const f=fixture('operations',{'/operations':data});await f.instance.refresh();assert.match(f.text(),/Queued user inputs/);assert.doesNotMatch(f.text(),/Pending approvals/);assert.match(f.text(),/Record totals include finished history/);assert.match(f.text(),/Running/);assert.match(f.text(),/Recorded evidence/);assert.match(f.text(),/Unavailable · 2026-01-01T01/);});

test('Q4 archive preview errors never post and filter changes preserve keyboard focus',async()=>{const f=fixture('recovery');await f.instance.refresh();const input=all(f.root).find(n=>n.id==='archive-before');input.value='2026-01-01T00:00:00.000Z';input.listeners.input();f.data.error=true;await f.find('Preview archive').listeners.click();assert.match(f.text(),/Archive result unavailable/);assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);f.data.error=false;await f.find('Archived').listeners.click();assert.equal(f.find('Archived').focused,true);});

test('Q4 one archive confirmation is consumed even when a committed batch loses its response',async()=>{
 const before='2026-01-01T00:00:00.000Z';let remaining=1000,posts=0;
 const f=fixture('recovery',{
  [`/deliveries/archive?before=${encodeURIComponent(before)}`]:()=>({eligible:remaining}),
  '/deliveries/archive':()=>{remaining-=500;posts++;if(posts===1)throw Error('committed batch, lost response');return {archived:500,remaining};},
 });
 await f.instance.refresh();const input=all(f.root).find(n=>n.id==='archive-before');input.value=before;input.listeners.input();
 await f.find('Preview archive').listeners.click();const original=f.find('Confirm archive batch');await original.listeners.click();
 assert.equal(posts,1);assert.equal(remaining,500);assert.match(all(f.body).map(n=>n.textContent).join(' '),/Archive result unavailable/);
 assert.equal(original.disabled,true,'uncertain outcome must consume the preview approval');
 await original.listeners.click();assert.equal(posts,1,'old confirmation cannot archive a second batch');
 await f.find('Close').listeners.click();await f.find('Preview archive').listeners.click();
 const fresh=all(f.body).filter(n=>n.tag==='button'&&n.textContent==='Confirm archive batch').at(-1);assert.notEqual(fresh,original);
 await fresh.listeners.click();assert.equal(posts,2);assert.equal(remaining,0);assert.equal(fresh.disabled,true);
});

test('Q4 actual browser fixture restores global networking after failed server startup',async()=>{
 const { Server } = await import('node:http');
 const { startBrowserFixture } = await import('./fixtures/q4-browser.ts');
 const originalFetch=globalThis.fetch,originalListen=Server.prototype.listen;
 Server.prototype.listen=function(){throw Error('synthetic listen failure');} as typeof originalListen;
 try {await assert.rejects(startBrowserFixture(),/synthetic listen failure/);assert.equal(globalThis.fetch,originalFetch,'failed startup must restore original fetch');}
 finally {Server.prototype.listen=originalListen;globalThis.fetch=originalFetch;}
});

test('Q4 asynchronous fixture bind errors reject with networking restored instead of escaping startup cleanup',async()=>{
 const { spawnSync } = await import('node:child_process');
 const fixtureUrl=new URL('./fixtures/q4-browser.ts',import.meta.url).href;
 const source=`import { Server } from 'node:http';
 import { startBrowserFixture } from ${JSON.stringify(fixtureUrl)};
 const originalFetch=globalThis.fetch;
 Server.prototype.listen=function(){queueMicrotask(()=>this.emit('error',new Error('synthetic async bind failure')));return this;};
 process.once('uncaughtException',()=>{console.log(JSON.stringify({uncaught:true,restored:globalThis.fetch===originalFetch}));process.exit(1);});
 try {await startBrowserFixture();console.log(JSON.stringify({unexpectedSuccess:true}));process.exitCode=2;}
 catch(error){console.log(JSON.stringify({caught:error.message==='synthetic async bind failure',restored:globalThis.fetch===originalFetch}));}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,`async bind failure must be caught: ${child.stdout} ${child.stderr}`);
 assert.deepEqual(JSON.parse(child.stdout.trim()),{caught:true,restored:true});
});
