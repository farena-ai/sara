import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { deliveryFor, DeliveryStore } from '../src/delivery.ts';
import { createSaraServer } from '../src/server.ts';
import { OwnerAuth } from '../src/auth.ts';
import type { MemberRecord } from '../src/household.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
const OLD='2000-01-01T00:00:00.000Z', BEFORE='2001-01-01T00:00:00.000Z';
function fixture(t: import('node:test').TestContext) {
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('1999-01-01T00:00:00Z')});const d=deliveryFor(app);
 t.after(()=>{app.store.close();cleanup();});
 const add=(state='acknowledged',resolution:string|null=null,held=0,payload:string|null=null)=>{
  const {id}=d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'private_destination',logicalKey:`key-${crypto.randomUUID()}`});
  app.store.db.prepare('UPDATE deliveries SET state=?,resolution=?,resolved_at=?,held=?,payload=?,updated_at=?,refs=?,reason=? WHERE id=?').run(state,resolution,resolution?OLD:null,held,payload,OLD,'["123456"]','private_reason',id);return id;
 };
 return {app,d,add,dir};
}
test('archive keeps unresolved/live/inflight/payload evidence and uses strict transport plus resolution age',t=>{
 const {app,d,add}=fixture(t);const eligible=[add(),add('outcome_unknown','confirmed_received'),add('failed','confirmed_not_received'),add('queued','dismissed',1)];
 const protectedIds=[add('queued'),add('queued',null,1),add('failed'),add('outcome_unknown'),add('attempted'),add('attempted','dismissed'),add('queued','dismissed'),add('failed','invalid'),add('acknowledged',null,0,'private_encrypted_payload')];
 const recent=add('outcome_unknown','dismissed');app.store.db.prepare('UPDATE deliveries SET resolved_at=? WHERE id=?').run(new Date().toISOString(),recent);protectedIds.push(recent);
 const boundary=add();app.store.db.prepare('UPDATE deliveries SET updated_at=? WHERE id=?').run(BEFORE,boundary);protectedIds.push(boundary);
 assert.deepEqual(d.archivePreview(BEFORE),{eligible:4});assert.deepEqual(d.archive(BEFORE),{archived:4,remaining:0});
 assert.deepEqual(d.page({filter:'archived'}).deliveries.map(x=>x.id),eligible);
 for(const id of protectedIds)assert.equal(app.store.db.prepare('SELECT archived_at FROM deliveries WHERE id=?').get(id)!.archived_at,null);
 assert.equal(d.list().some(x=>eligible.includes(x.id)),false);assert.equal(d.page({filter:'all'}).deliveries.some(x=>eligible.includes(x.id)),false);
 const raw=app.store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(eligible[3])!;assert.equal(raw.destination,'');assert.equal(raw.refs,null);assert.equal(raw.reason,null);assert.equal(raw.payload,null);assert.equal(raw.resolution,'dismissed');assert.equal(raw.updated_at,OLD);assert.equal(raw.resolved_at,OLD);assert.ok(raw.nonce);assert.ok(raw.logical_key);
 assert.equal(JSON.stringify(d.page({filter:'archived'})).includes('private_'),false);
 assert.throws(()=>d.resolve(eligible[0],'acknowledged','dismissed'),/changed/);assert.throws(()=>d.review(eligible[0]),/unavailable/);
 const archivedAt=raw.archived_at;new DeliveryStore(app.store.db,app.vault);assert.equal(app.store.db.prepare('SELECT archived_at FROM deliveries WHERE id=?').get(eligible[3])!.archived_at,archivedAt);
 assert.throws(()=>d.attempt(eligible[3]));assert.throws(()=>d.fail(eligible[0]));assert.throws(()=>d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1',logicalKey:raw.logical_key as string}));
});
test('archive batches at most500, retains identity, pages archives, and rolls back atomic failures',t=>{
 const {app,d,add}=fixture(t);for(let n=0;n<503;n++)add();assert.deepEqual(d.archive(BEFORE),{archived:500,remaining:3});
 let cursor:string|undefined;const seen=new Set<string>();do{const p=d.page({filter:'archived',limit:37,cursor});for(const r of p.deliveries){assert.ok(r.archivedAt);seen.add(r.id);}cursor=p.nextCursor??undefined;}while(cursor);assert.equal(seen.size,500);
 const faultId=app.store.db.prepare('SELECT id FROM deliveries WHERE archived_at IS NULL ORDER BY rowid LIMIT 1 OFFSET 1').get()!.id;
 app.store.db.exec(`CREATE TRIGGER archive_fault BEFORE UPDATE OF archived_at ON deliveries WHEN NEW.id='${faultId}' AND NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL BEGIN SELECT RAISE(ABORT,'synthetic archive failure'); END`);assert.throws(()=>d.archive(BEFORE));assert.deepEqual(d.archivePreview(BEFORE),{eligible:3});app.store.db.exec('DROP TRIGGER archive_fault');assert.deepEqual(d.archive(BEFORE,2),{archived:2,remaining:1});
 for(const before of ['',OLD.slice(0,-1),'2000-02-30T00:00:00.000Z','2000-01-01T00:00:00Z','2000-01-01T00:00:00.000+00:00','2999-01-01T00:00:00.000Z'])assert.throws(()=>d.archivePreview(before),/Invalid archive cutoff/);
 for(const limit of [0,-1,501,1.5,NaN,'1'])assert.throws(()=>d.archive(BEFORE,limit as number),/Invalid archive limit/);
});
test('recent human resolution cannot immediately archive an old interrupted delivery',t=>{
 const {app,d,add}=fixture(t);const id=add('queued',null,1);
 d.resolve(id,'queued','dismissed');
 assert.deepEqual(d.archivePreview(BEFORE),{eligible:0});
 assert.deepEqual(d.archive(BEFORE),{archived:0,remaining:0});
 const raw=app.store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id)!;
 assert.equal(raw.updated_at,OLD);assert.equal(raw.resolution,'dismissed');assert.ok(String(raw.resolved_at)>BEFORE);
});
test('archive migrates an old database without losing ledger rows',t=>{
 const {app,d,add}=fixture(t);const id=add();if(app.store.db.prepare('PRAGMA table_info(deliveries)').all().some(c=>c.name==='archived_at'))app.store.db.exec('DROP INDEX IF EXISTS deliveries_archived; ALTER TABLE deliveries DROP COLUMN archived_at');const restored=new DeliveryStore(app.store.db,app.vault);assert.deepEqual(restored.archive(BEFORE),{archived:1,remaining:0});assert.equal(restored.page({filter:'archived'}).deliveries[0].id,id);
});
async function httpFixture(t:import('node:test').TestContext,role:'owner'|'demo'|'member'='owner'){
 const f=fixture(t);const auth=new OwnerAuth(f.dir);const member={id:'synthetic',name:'Alex',createdAt:OLD,status:'active',ownerConfirmed18At:OLD,memberConfirmed18At:OLD,limits:{models:[],messagesPerDay:0,costPerDay:0,voice:false,pictures:false}} satisfies MemberRecord;
 const server=createSaraServer({app:f.app,auth,webDir:join(ROOT,'web'),...(role==='demo'?{demo:true}:{}),...(role==='member'?{member:{record:()=>member,apps:()=>[f.app],deleteSelf:async()=>{}}}:{})});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/deliveries`;const headers={authorization:`Bearer ${auth.newToken}`,'content-type':'application/json'};return {...f,auth,base,headers};
}
test('owner archive HTTP preview is read-only, strict, current eligibility rechecked, archived filter explicit',async t=>{
 const {app,d,add,base,headers}=await httpFixture(t);const id=add();const preview=()=>fetch(`${base}/archive?before=${BEFORE}`,{headers});assert.deepEqual(await (await preview()).json(),{eligible:1});assert.equal(d.page({filter:'all'}).deliveries.length,1);
 app.store.db.prepare('UPDATE deliveries SET state=? WHERE id=?').run('attempted',id);
 const post=(body:unknown)=>fetch(`${base}/archive`,{method:'POST',headers,body:JSON.stringify(body)});assert.deepEqual(await (await post({before:BEFORE})).json(),{archived:0,remaining:0});
 app.store.db.prepare('UPDATE deliveries SET state=? WHERE id=?').run('acknowledged',id);assert.deepEqual(await (await post({before:BEFORE,limit:1})).json(),{archived:1,remaining:0});
 for(const filter of ['', '?filter=all','?filter=unresolved'])assert.equal((await (await fetch(base+filter,{headers})).json()).deliveries.length,0);assert.equal((await (await fetch(base+'?filter=archived',{headers})).json()).deliveries.length,1);
 for(const body of [{},{before:BEFORE,extra:true},{before:BEFORE,limit:'1'},{before:BEFORE,limit:null},{before:'2000-02-30T00:00:00.000Z'},{before:'2999-01-01T00:00:00.000Z'},null,[]])assert.equal((await post(body)).status,400);
 for(const q of ['',`before=${BEFORE}&before=${BEFORE}`,`before=${BEFORE}&extra=1`,'before=invalid'])assert.equal((await fetch(`${base}/archive?${q}`,{headers})).status,400);
 assert.equal((await fetch(`${base}/archive?before=${BEFORE}`,{method:'POST',headers,body:JSON.stringify({before:BEFORE})})).status,400);
});
test('archive HTTP refuses unauthenticated, device, demo and household member callers',async t=>{
 const f=await httpFixture(t);assert.equal((await fetch(`${f.base}/archive?before=${BEFORE}`)).status,401);const device=f.auth.createDeviceToken('Synthetic');
 for(const method of ['GET','POST']){const r=await fetch(`${f.base}/archive${method==='GET'?`?before=${BEFORE}`:''}`,{method,headers:{...f.headers,authorization:`Bearer ${device.token}`},...(method==='POST'?{body:JSON.stringify({before:BEFORE})}:{})});assert.equal(r.status,403);}
 for(const role of ['demo','member'] as const){const x=await httpFixture(t,role);for(const method of ['GET','POST'])assert.equal((await fetch(`${x.base}/archive${method==='GET'?`?before=${BEFORE}`:''}`,{method,headers:x.headers,...(method==='POST'?{body:JSON.stringify({before:BEFORE})}:{})})).status,403);}
});
