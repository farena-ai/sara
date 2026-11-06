import test from 'node:test';
import assert from 'node:assert/strict';

import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {once} from 'node:events';

for(const lang of ['en','es','fr','de','pt-BR','it'])test(`permission-limited SDK channel: localized ${lang} ready description and result card`,async()=>{
 const folder=fileURLToPath(new URL('../store/plugins/http-webhook-workbench/',import.meta.url));
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${folder}`,'main.mjs'],{cwd:folder,stdio:['pipe','pipe','pipe'],env:{...process.env}});
 const exited=once(child,'exit');const lines=createInterface({input:child.stdout});const received:any[]=[];let errors='';child.stderr.on('data',b=>errors+=b);
 lines.on('line',s=>received.push(JSON.parse(s)));
 const send=(msg:unknown)=>child.stdin.write(JSON.stringify(msg)+'\n');
 const wait=async(type:string)=>{const end=Date.now()+5000;while(!received.some(m=>m.type===type)){assert.ok(Date.now()<end,errors);await new Promise(r=>setTimeout(r,10));}return received.find(m=>m.type===type);};
 try{
  const {labels}=await import(new URL('../store/plugins/http-webhook-workbench/workflow.mjs',import.meta.url).href);
  send({v:1,type:'init',lang,settings:{endpoint:''}});const ready=await wait('ready');assert.equal(ready.tools[0].permission,'ask');assert.equal(ready.tools[0].description,labels[lang][1]);assert.equal(ready.tools[0].parameters.additionalProperties,false);
  send({v:1,type:'tool',id:'t1',name:'request',args:{method:'GET',path:'/'}});const result=await wait('result');assert.equal(result.card.title,labels[lang][0]);assert.equal(result.card.lines[0],labels[lang][3]);assert.equal(JSON.parse(result.content).ok,false);assert.ok(!received.some(m=>m.type==='call'));
 }finally{child.stdin.end();child.kill();await exited;lines.close();}
});

const moduleUrl = new URL('../store/plugins/http-webhook-workbench/workbench.mjs', import.meta.url);
test('HTTP workbench refuses nonliteral loopback configuration before opening any broker socket', async () => {
  const { run } = await import(moduleUrl.href);
  let opens = 0;
  for (const endpoint of ['example.com:80', '192.168.1.1:80', 'localhost:80', 'http://127.0.0.1:80', 'user@127.0.0.1:80']) {
    const result = await run({ method: 'GET', path: '/' }, { settings: { endpoint }, net: { open() { opens++; throw Error('unexpected'); } } });
    assert.equal(JSON.parse(result.content).ok, false);
  }
  assert.equal(opens, 0);
});
test('bounded method, path, headers and body admission; localized refusal cards', async () => {
 const {run}=await import(moduleUrl.href);let opens=0;
 const cases=[{method:'CONNECT',path:'/'},{method:'GET',path:'//evil'},{method:'GET',path:'/x?token=bad'},{method:'GET',path:'/x%0d'},{method:'POST',path:'/',body:'not-json'},{method:'POST',path:'/',body:JSON.stringify({x:'é'.repeat(3000)})},{method:'GET',path:'/',headers:{'X-Public':'ok\r\nHost: evil'}},{method:'GET',path:'/',headers:{Accept:'a',accept:'b'}},{method:'GET',path:'/',replay:'yes'},{method:'GET',path:'/',extra:true}];
 for(const lang of ['en','es','fr','de','pt-BR','it'])for(const args of cases){const result=await run(args,{lang,settings:{endpoint:'127.0.0.1:1234'},net:{open(){opens++;throw Error('must not open');}}});assert.equal(JSON.parse(result.content).ok,false);assert.ok(result.card.title);assert.equal(result.card.lines[0],JSON.parse(result.content).reason);}
 assert.equal(opens,0);
});
test('real broker host runs owned POST and explicit replay with redacted request/response cards', {timeout:45000}, async () => {
  const {qualify} = await import('../tools/developer-http-webhook/qualify.mjs');
  await qualify();
});

test('review: duplicate decoded JSON keys refuse before any broker socket opens', async()=>{
 const {run}=await import(moduleUrl.href);let opens=0;
 const r=await run({method:'POST',path:'/',body:'{"password":"first-private","passw\\u006frd":"second-private","echo":"first-private"}'},{settings:{endpoint:'127.0.0.1:1234'},net:{open(){opens++;throw Error('must not open');}}});
 assert.equal(JSON.parse(r.content).ok,false);assert.equal(opens,0);
});
test('review: numeric sensitive values cannot reappear as public numeric echoes', async () => {
 const {run} = await import(moduleUrl.href);
 const payload=JSON.stringify({password:654321,echo:654321});
 const event=new EventEmitter();
 const result=await run({method:'POST',path:'/',body:payload},{settings:{endpoint:'127.0.0.1:1234'},net:{open:async()=>({onData:(fn:any)=>event.on('data',fn),onClose:()=>{},write:async()=>{queueMicrotask(()=>event.emit('data',Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)));},close:async()=>{}})}});
 assert.equal(JSON.parse(result.content).ok,true);
 assert.ok(!JSON.stringify(result).includes('654321'));
});

test('review: redaction expansion stays within the complete result transport budget', async () => {
 const {run} = await import(moduleUrl.href);
 const payload=JSON.stringify({password:'x',echo:'x'.repeat(3900)});
 const event=new EventEmitter();
 const result=await run({method:'POST',path:'/',body:payload},{settings:{endpoint:'127.0.0.1:1234'},net:{open:async()=>({onData:(fn:any)=>event.on('data',fn),onClose:()=>{},write:async()=>{queueMicrotask(()=>event.emit('data',Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)));},close:async()=>{}})}});
 assert.ok(Buffer.byteLength(JSON.stringify(result))<48000);
 assert.equal(JSON.parse(result.content).ok,false);
});
