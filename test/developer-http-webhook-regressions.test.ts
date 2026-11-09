import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';

async function ownedReply(reply:Buffer,method='GET'){
 const sockets=new Set<net.Socket>();let requests=0,writes=0,closes=0;
 const server=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));let sent=false;s.on('data',()=>{if(sent)return;sent=true;requests++;s.end(reply);});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;
 let result:any;
 try{
  result=await run({method,path:'/owned'},{settings:{endpoint:`127.0.0.1:${port}`},net:{open:async(id:string)=>{
   assert.equal(id,'fixture');const s=net.connect({host:'127.0.0.1',port});await once(s,'connect');
   return {onData:(fn:any)=>s.on('data',fn),onClose:(fn:any)=>s.on('close',fn),write:async(b:Buffer)=>{writes++;s.write(b);},close:async()=>{closes++;if(s.closed)return;const ended=once(s,'close');s.destroy();await ended;}};
  }}});
 }finally{const ended=[...sockets].map(s=>s.closed?Promise.resolve():once(s,'close'));for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));await Promise.all(ended);}
 assert.equal(server.listening,false);assert.equal(sockets.size,0);assert.equal(requests,1);assert.equal(writes,1);assert.equal(closes,1);
 console.log(JSON.stringify({fixture:'owned literal loopback',requests,writes,closes,cleanup:{serverClosed:!server.listening,sockets:sockets.size}}));
 return result;
}
const frame=(body:Buffer)=>Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`),body]);
test('JSON redaction key collision visibly refuses rather than losing public evidence',async()=>{
 const result=await ownedReply(frame(Buffer.from('{"password":"alpha","alpha":{"publicObservation":"must survive"},"[REDACTED]":{"different":"later public member"}}')));
 assert.equal(JSON.parse(result.content).ok,false);
 assert.ok(!JSON.stringify(result).includes('alpha'));
 assert.equal(result.card.lines[0],'Refused');
});
test('close-delimited response actual body over 8192 bytes visibly refuses',async()=>{
 const body=JSON.stringify({message:'a'.repeat(8900)});assert.ok(Buffer.byteLength(body)>8192);
 const result=await ownedReply(Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'+body));
 assert.equal(JSON.parse(result.content).ok,false);assert.equal(result.card.lines[0],'Refused');
});
test('invalid UTF-8 JSON response visibly refuses without replacement text',async()=>{
 const result=await ownedReply(frame(Buffer.concat([Buffer.from('{"message":"'),Buffer.from([255]),Buffer.from('"}')])));
 assert.equal(JSON.parse(result.content).ok,false);assert.equal(result.card.lines[0],'Refused');assert.ok(!JSON.stringify(result).includes('\uFFFD'));
});
test('terminal informational response visibly refuses instead of returning status 100',async()=>{
 const result=await ownedReply(Buffer.from('HTTP/1.1 100 Continue\r\nContent-Length: 2\r\n\r\n{}'));
 assert.equal(JSON.parse(result.content).ok,false);assert.equal(result.card.lines[0],'Refused');
});
test('qualification refuses an invalid explicit fence before loading host modules',async()=>{
 const {qualify}=await import('../tools/developer-http-webhook/qualify.mjs');
 const oldFence=process.env.SARA_HTTP_HOST_FENCE,oldHost=process.env.SARA_HTTP_HOST_ROOT;
 try{process.env.SARA_HTTP_HOST_FENCE='unsupported';process.env.SARA_HTTP_HOST_ROOT='not-a-host';await assert.rejects(qualify(),/SARA_HTTP_HOST_FENCE/);}
 finally{if(oldFence===undefined)delete process.env.SARA_HTTP_HOST_FENCE;else process.env.SARA_HTTP_HOST_FENCE=oldFence;if(oldHost===undefined)delete process.env.SARA_HTTP_HOST_ROOT;else process.env.SARA_HTTP_HOST_ROOT=oldHost;}
});
for(const framing of ['close-delimited','content-length'])test(`body boundary: valid 8192-byte ${framing} JSON survives`,async()=>{
 const body=Buffer.from(JSON.stringify({message:'a'.repeat(8192-Buffer.byteLength(JSON.stringify({message:''})))}));assert.equal(body.length,8192);
 const result=await ownedReply(framing==='content-length'?frame(body):Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'),body]));
 const report=JSON.parse(result.content);assert.equal(report.ok,true);assert.equal(Buffer.byteLength(JSON.stringify(report.responses[0].body)),8192);
});
test('valid UTF-8 response preserves public Unicode text',async()=>{
 const message='café 日本語 🚀';const result=await ownedReply(frame(Buffer.from(JSON.stringify({message}))));
 assert.equal(JSON.parse(result.content).responses[0].body.message,message);
});
for(const method of ['HEAD','GET'])test(`no-body semantics: ${method==='HEAD'?'HEAD large representation length':'204 empty response'} remains accepted`,async()=>{
 const reply=method==='HEAD'?'HTTP/1.1 200 OK\r\nContent-Length: 9000\r\n\r\n':'HTTP/1.1 204 No Content\r\n\r\n';
 const result=await ownedReply(Buffer.from(reply),method);const report=JSON.parse(result.content);
 assert.equal(report.ok,true);assert.equal(report.responses[0].body,null);
});
test('monotonic replay admission refuses before a second open when elapsed clock outpaces timer dispatch',async t=>{
 let now=0,opens=0,writes=0,closes=0;t.mock.method(performance,'now',()=>now);
 const result=await run({method:'POST',path:'/owned',body:'{}',replay:true},{settings:{endpoint:'127.0.0.1:1234'},net:{open:async()=>{
  opens++;let data:any;return {onData:(fn:any)=>data=fn,onClose:()=>{},write:async()=>{writes++;queueMicrotask(()=>data(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')));},close:async()=>{closes++;now=20001;}};
 }}});
 assert.equal(JSON.parse(result.content).ok,false);assert.equal(opens,1);assert.equal(writes,1);assert.equal(closes,1);
});
const {run}=await import(new URL('../store/plugins/http-webhook-workbench/workflow.mjs',import.meta.url).href);

// Fake monotonic time only for delayed broker connects; real listener cases below use real time.
for(const scenario of ['two slow opens','single late open','late open rejection'])test(`invocation budget: ${scenario} cannot write after expiry`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 t.mock.method(performance,'now',()=>Date.now());
 const events:any[]=[];let opens=0,closes=0,finished=false;
 const log=(type:string,n:number)=>events.push({at:Date.now(),type,n});
 const sara={settings:{endpoint:'127.0.0.1:12345'},net:{open:()=>new Promise((resolve,reject)=>{
  const n=++opens;log('open',n);setTimeout(()=>{
   log('resolved',n);if(scenario==='late open rejection'){reject(Error('late refused'));return;}
   let data:any;resolve({onData:(fn:any)=>data=fn,onClose:()=>{},write:async()=>{
    log('write',n);setTimeout(()=>data(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')),1000);
   },close:async()=>{closes++;log('close',n);}});
  },scenario==='two slow opens'?14900:31000);
 })}};
 const invocation=run({method:'POST',path:'/owned',body:'{}',replay:scenario==='two slow opens'},sara).then((r:any)=>{finished=true;log('returned',0);return r;});
 const flush=async()=>{for(let n=0;n<24;n++)await Promise.resolve();};
 await flush();
 if(scenario==='two slow opens'){t.mock.timers.tick(14900);await flush();t.mock.timers.tick(1000);await flush();assert.equal(opens,2);}
 // The current host allows 30000ms. The plugin must return strictly before it.
 t.mock.timers.tick(scenario==='two slow opens'?13000:29000);await flush();
 assert.equal(finished,true,'overall invocation must refuse before the host deadline');
 assert.equal(JSON.parse((await invocation).content).ok,false);
 t.mock.timers.tick(10000);await flush();
 assert.equal(events.filter(e=>e.type==='write').length,scenario==='two slow opens'?1:0);
 assert.equal(closes,scenario==='late open rejection'?0:opens,'late resolved sockets must close');
 assert.ok(events.filter(e=>e.type==='write').every(e=>e.at<30000));
 console.log(JSON.stringify({scenario,clock:'mocked monotonic delayed connects only',events,opens,closes}));
});
