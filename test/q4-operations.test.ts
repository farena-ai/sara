import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function implementation() {
 assert.ok(existsSync(new URL('../src/operations.ts', import.meta.url)), 'operations monitor implemented');
 return import('../src/operations.ts');
}
test('operations bounds samples, counts completion once, sanitizes families and keeps finite percentiles', async () => {
 const { OperationsMonitor, operationFamily } = await implementation();
 const { dir, cleanup } = tempDir(); const app = makeApp(dir, { now: new Date() });
 let clock = 0; const logs: unknown[] = [];
 const monitor = new OperationsMonitor({ clock: () => clock, log: line => logs.push(line) });
 try {
  for (let i = 0; i < 600; i++) {
   const req = { url: '/secret-user/path?token=synthetic-secret', headers: { 'x-request-id': 'untrusted' } } as unknown as IncomingMessage;
   const res = Object.assign(new EventEmitter(), { statusCode: i === 0 ? 500 : i === 1 ? 404 : 200, writableFinished: false, setHeader: (_k: string, value: string) => { assert.match(value, /^[\da-f-]{36}$/); assert.notEqual(value, 'untrusted'); } });
   monitor.track(req, res as unknown as ServerResponse); clock += i === 599 ? 100 : 1;
   res.emit(i === 2 ? 'close' : 'finish'); res.emit('close');
  }
  const s = monitor.snapshot(app);
  assert.equal(s.requests.total, 600); assert.equal(s.requests.sampleCount, 512);
  assert.equal(s.requests.inFlight, 0); assert.equal(s.requests.peakInFlight, 1);
  assert.equal(s.requests.clientErrors, 1); assert.equal(s.requests.serverErrors, 1); assert.equal(s.requests.aborted, 1);
  assert.equal(s.requests.p50Ms, 1); assert.equal(s.requests.p95Ms, 1); assert.equal(s.requests.maxMs, 100);
  assert.equal(s.requests.families.other, 600); assert.equal(logs.length, 600);
  assert.equal(JSON.stringify([s, logs]).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify([s, logs]).includes(dir.replaceAll('\\', '\\\\')), false);
  for (const path of ['/api/stranger-secret?a=token', '/hook/secret', '/preview/secret', '/api/operations-malicious']) assert.equal(operationFamily(path), 'other');
  assert.equal(operationFamily('/api/operations?secret=x'), 'operations');
  assert.equal(operationFamily('/api/conversations/private-id/messages?x=y'), 'conversations');
  assert.ok(Number.isFinite(s.process.eventLoop.p95Ms)); assert.ok(Number.isFinite(s.process.eventLoop.maxMs));
 } finally { monitor.close(); monitor.close(); app.store.close(); cleanup(); }
});

test('operations owner HTTP report is private; public health stays minimal and request IDs are generated', async t => {
 const { dir, cleanup } = tempDir(); const app = makeApp(dir, { now: new Date() }); const auth = new OwnerAuth(dir);
 const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
 await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
 t.after(async () => { await new Promise<void>(r => server.close(() => r())); app.store.close(); cleanup(); });
 const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const health = await fetch(base + '/api/health', { headers: { 'x-request-id': 'synthetic-secret' } });
 assert.deepEqual(await health.json(), { ok: true }); assert.match(health.headers.get('x-request-id') ?? '', /^[\da-f-]{36}$/);
 assert.equal((await fetch(base + '/api/operations')).status, 401);
 const device = auth.createDeviceToken('synthetic device');
 assert.equal((await fetch(base + '/api/operations', { headers: { authorization: `Bearer ${device.token}` } })).status, 403);
 const response = await fetch(base + '/api/operations', { headers: { authorization: `Bearer ${auth.newToken}` } });
 assert.equal(response.status, 200); const body = await response.json();
 assert.equal(body.scope, 'current-server'); assert.equal(body.coverage, 'http-responses'); assert.equal(body.process.scope, 'process-wide');
 assert.equal(body.readiness.database.status, 'ready'); assert.equal(body.readiness.model.status, 'not_configured');
 assert.equal(body.readiness.model.configuredOnly, true); assert.equal(body.readiness.backup.status, 'unavailable');
 assert.equal(JSON.stringify(body).includes(dir.replaceAll('\\', '\\\\')), false); assert.equal(app.providerCalls, 0);
});

test('operations refuses authenticated demo and member spaces over HTTP', async t => {
 for (const role of ['demo', 'member']) {
  const {dir, cleanup} = tempDir(); const app = makeApp(dir, {now:new Date()}); const auth = new OwnerAuth(dir);
  const member = { record: () => ({id:'synthetic-member',name:'Example',createdAt:new Date().toISOString(),status:'active' as const,ownerConfirmed18At:'fixture',memberConfirmed18At:'fixture',limits:{models:[],messagesPerDay:0,costPerDay:0,voice:false,pictures:false}}), apps:()=>[app], deleteSelf:async()=>{} };
  const server = createSaraServer({app,auth,webDir:join(ROOT,'web'),...(role==='demo'?{demo:true}:{member})});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try { const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/operations`,{headers:{authorization:`Bearer ${auth.newToken}`}}); assert.equal(response.status,403,role); }
  finally {await new Promise<void>(r=>server.close(()=>r()));app.store.close();cleanup();}
 }
});

test('readiness probes configured evidence without provider calls and fails closed for unavailable stores', async () => {
 const {OperationsMonitor}=await implementation(); const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date()});const monitor=new OperationsMonitor({log:()=>{}});
 try {
  app.settings.update({providers:[{id:'synthetic-provider',kind:'openai-compatible',label:'synthetic-secret',baseUrl:'http://127.0.0.1:1'}],defaultProviderId:'synthetic-provider',defaultModel:'synthetic-secret'});
  let body=monitor.snapshot(app); assert.equal(body.readiness.model.status,'ready');assert.equal(app.providerCalls,0);
  assert.equal(JSON.stringify(body).includes('synthetic-secret'),false);
  app.store.close(); body=monitor.snapshot(app);assert.equal(body.readiness.database.status,'unavailable');assert.equal(body.queues.pending.status,'unavailable');
  app.dataDir=join(dir,'missing-directory');body=monitor.snapshot(app);assert.equal(body.readiness.storage.status,'unavailable');
 } finally {monitor.close();cleanup();}
});

test('monitors have independent inflight and sample state and release loop monitor on close', async () => {
 const {OperationsMonitor}=await implementation(); const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date()});
 const first=new OperationsMonitor({log:()=>{}}),second=new OperationsMonitor({log:()=>{}});
 const response=()=>Object.assign(new EventEmitter(),{statusCode:200,writableFinished:true,setHeader:()=>{}});
 try {
  const a=response(),b=response();first.track({url:'/api/health'} as IncomingMessage,a as unknown as ServerResponse);first.track({url:'/api/health'} as IncomingMessage,b as unknown as ServerResponse);
  assert.equal(first.snapshot(app).requests.inFlight,2);assert.equal(first.snapshot(app).requests.peakInFlight,2);assert.equal(second.snapshot(app).requests.total,0);
  a.emit('finish');b.emit('close');assert.equal(first.snapshot(app).requests.total,2);assert.equal(first.snapshot(app).requests.aborted,0);
  assert.equal(a.listenerCount('close'),0);assert.equal(b.listenerCount('finish'),0);
  first.close();const count=first.snapshot(app).process.eventLoop.sampleCount;
  await new Promise(r=>setTimeout(r,50));assert.equal(first.snapshot(app).process.eventLoop.sampleCount,count);
 } finally{first.close();second.close();app.store.close();cleanup();}
});

test('readiness exposes only aggregate bridge/backup/queue evidence and canonical restore time', async () => {
 const {OperationsMonitor}=await implementation();const {mkdirSync,writeFileSync}=await import('node:fs');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date()});const monitor=new OperationsMonitor({log:()=>{}});
 try{
  mkdirSync(join(dir,'backups'));writeFileSync(join(dir,'backups','sara-synthetic-secret.tar.gz'),'fixture metadata only');
  app.settings.update({telegram:{enabled:true},offsite:{kind:'s3',lastTest:{ok:true,at:'04 Nov 2026 00:00:00 GMT',detail:'synthetic-secret',error:'synthetic-secret'}}} as never);
  app.bridges={telegram:{status:()=>({running:true,bot:'synthetic-secret',error:'synthetic-secret'})}} as never;
  app.store.db.exec("CREATE TABLE jobs (status TEXT); INSERT INTO jobs VALUES ('running'),('synthetic-secret');");
  const s=monitor.snapshot(app);assert.equal(s.readiness.bridges.status,'ready');assert.equal(s.readiness.bridges.running,1);
  assert.equal(s.readiness.backup.status,'ready');assert.equal(s.readiness.backup.count,1);assert.equal(s.readiness.backup.offsiteRestore.status,'ready');
  assert.equal(s.readiness.backup.offsiteRestore.lastTestAt,'2026-11-04T00:00:00.000Z');
  assert.equal(s.queues.jobs.total,2);assert.equal(s.queues.jobs.states.running,1);assert.equal(s.queues.jobs.states.unknown,1);
  assert.equal(JSON.stringify(s).includes('synthetic-secret'),false);
 }finally{monitor.close();app.store.close();cleanup();}
});

test('offsite readiness requires a valid recorded nonfuture restore timestamp', async () => {
 const {OperationsMonitor}=await implementation();const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date()});const monitor=new OperationsMonitor({log:()=>{}});
 try {
  for(const at of [undefined,'synthetic-secret','2999-01-01T00:00:00.000Z']) {
   app.settings.update({offsite:{kind:'s3',lastTest:{ok:true,at}}} as never);
   const result=monitor.snapshot(app).readiness.backup.offsiteRestore;
   assert.equal(result.status,'unavailable',String(at));assert.equal(result.lastTestAt,null,String(at));
  }
 }finally{monitor.close();app.store.close();cleanup();}
});

test('model readiness matches configured provider selection and its model fallback', async () => {
 const {OperationsMonitor}=await implementation();const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date()});const monitor=new OperationsMonitor({log:()=>{}});
 try {
  const providers=[{id:'fixture',kind:'openai-compatible' as const,label:'Fixture',baseUrl:'http://127.0.0.1:1',defaultModel:'provider-fallback'}];
  for(const defaultProviderId of [undefined,'stale-provider']) {
   app.settings.update({providers,defaultProviderId,defaultModel:'global-model'});
   assert.equal(monitor.snapshot(app).readiness.model.status,'not_configured',String(defaultProviderId));
  }
  app.settings.update({providers,defaultProviderId:'fixture',defaultModel:undefined});
  assert.equal(monitor.snapshot(app).readiness.model.status,'ready');
  assert.equal(app.providerCalls,0);assert.equal(app.requests.length,0);
 }finally{monitor.close();app.store.close();cleanup();}
});
