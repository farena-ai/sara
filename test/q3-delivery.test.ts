import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { makeApp, tempDir } from './helpers.ts';
test('delivery ledger holds queued work, recovers attempts, encrypts review and separates human resolution', async () => {
 assert.ok(existsSync(new URL('../src/delivery.ts',import.meta.url)), 'delivery store implemented');
 const {deliveryFor,DeliveryStore}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir(); const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 try { const d=deliveryFor(app); const q=d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1001',review:{text:'synthetic private draft'}});
 const a=d.enqueue({bridge:'discord',operation:'message',destination:'1002',logicalKey:'once',review:{text:'second'}});
 assert.throws(()=>d.enqueue({bridge:'discord',operation:'message',destination:'1002',logicalKey:'once'}));
 d.attempt(a.id); assert.throws(()=>d.resolve(a.id,'attempted','dismissed'));
 assert.equal(JSON.stringify(d.list()).includes('synthetic private draft'),false);
 const restored=new DeliveryStore(app.store.db,app.vault);
 assert.equal(restored.list().find(x=>x.id===a.id)?.state,'outcome_unknown');
 assert.equal(restored.list().find(x=>x.id===q.id)?.state,'queued');
 assert.equal(restored.review(q.id).text,'synthetic private draft');
 restored.resolve(a.id,'outcome_unknown','confirmed_received');
 assert.equal(restored.list().find(x=>x.id===a.id)?.state,'outcome_unknown');
 assert.throws(()=>restored.resolve(a.id,'outcome_unknown','dismissed'));
 const b=restored.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1'});restored.attempt(b.id);
 assert.throws(()=>restored.acknowledge(b.id,[]));restored.acknowledge(b.id,['123']);
 assert.equal(restored.list().find(x=>x.id===b.id)?.state,'acknowledged');
 } finally {app.store.close();cleanup();}
});
test('native delivery helper retries only explicit rejection and preserves one identity', async()=>{
 assert.ok(existsSync(new URL('../src/bridges/delivery.ts',import.meta.url)),'native helper implemented');
 const {sendDelivery,DeliveryRejected}=await import('../src/bridges/delivery.ts');
 const {SendQueue,RateLimited}=await import('../src/bridges/sendq.ts');
 const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});const queue=new SendQueue();
 try {let calls=0;const nonces:string[]=[];
 await sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async nonce=>{calls++;nonces.push(nonce);if(calls===1)throw new RateLimited(0);return {message_id:12};});
 assert.equal(calls,2);assert.equal(new Set(nonces).size,1);assert.equal(deliveryFor(app).list().length,1);assert.equal(deliveryFor(app).list()[0].state,'acknowledged');
 for(const err of [new Error('transport secret'),new Error('HTTP 500')]) {calls=0;await assert.rejects(sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async()=>{calls++;throw err;}));assert.equal(calls,1);}
 await assert.rejects(sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async()=>{throw new DeliveryRejected();}));
 assert.ok(deliveryFor(app).list().some(x=>x.state==='failed'));
 assert.equal(new RateLimited(NaN).retryAfterMs,1000);
 }finally{app.store.close();cleanup();}
});
test('native Telegram and Discord messages persist acknowledgments',async()=>{
 const {TelegramBridge,TELEGRAM_VAULT}=await import('../src/bridges/telegram.ts');
 const {DiscordBridge,DISCORD_VAULT}=await import('../src/bridges/discord.ts');
 const {listen,readBody}=await import('./helpers.ts');const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});const bodies:Record<string,unknown>[]=[];
 const fake=await listen(async(req,res)=>{const body=await readBody(req);if(body.startsWith('{'))bodies.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(req.url?.includes('/bot')?{ok:true,result:{message_id:42}}:{id:'123456'}));});
 app.vault.set(TELEGRAM_VAULT,'synthetic-telegram-token');app.vault.set(DISCORD_VAULT,'synthetic-discord-token');
 try{const tg=new TelegramBridge(app,{apiBase:fake.url});const dc=new DiscordBridge(app,{api:fake.url});
 await tg.send(1,'private telegram');await dc.send('2','private discord');
 assert.equal(deliveryFor(app).list().filter(x=>x.state==='acknowledged').length,2);
 assert.equal(typeof bodies[1].nonce,'string');assert.equal(bodies[1].enforce_nonce,true);
 }finally{fake.server.close();app.store.close();cleanup();}
});
test('voice storage failures never trigger text fallback; ambiguous voice is held',async()=>{
 const {TelegramBridge,TELEGRAM_VAULT}=await import('../src/bridges/telegram.ts');
 const {DiscordBridge,DISCORD_VAULT}=await import('../src/bridges/discord.ts');
 const {listen}=await import('./helpers.ts');const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});let calls=0;
 const fake=await listen(async(_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'}).end('{}');});
 app.vault.set(TELEGRAM_VAULT,'synthetic-telegram-token');app.vault.set(DISCORD_VAULT,'synthetic-discord-token');
 app.speech={canSendNotes:()=>true,speak:async()=>({data:Buffer.from('synthetic audio'),type:'audio/mpeg'})} as unknown as NonNullable<typeof app.speech>;
 try{const tg=new TelegramBridge(app,{apiBase:fake.url}),dc=new DiscordBridge(app,{api:fake.url});
 await assert.rejects(tg.sendVoice(1,'voice'),/unknown/);await assert.rejects(dc.sendVoice('2','voice'),/unknown/);assert.equal(calls,2);
 assert.equal(deliveryFor(app).list().filter(r=>r.state==='outcome_unknown').length,2);
 app.store.db.exec("CREATE TRIGGER deny_attempt BEFORE UPDATE ON deliveries WHEN NEW.state='attempted' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
 await assert.rejects(tg.sendVoice(1,'storage-fault'));await assert.rejects(dc.sendVoice('2','storage-fault'));assert.equal(calls,2);
 }finally{fake.server.close();app.store.close();cleanup();}
});
test('enqueue/attempt faults send nothing; ack fault sends once and retains uncertainty',async()=>{
 const {sendDelivery}=await import('../src/bridges/delivery.ts');const {SendQueue}=await import('../src/bridges/sendq.ts');const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});let calls=0;const queue=new SendQueue();
 const send=()=>sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async()=>{calls++;return {message_id:3};});
 try{const store=deliveryFor(app);
 app.store.db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'synthetic'); END");await assert.rejects(send());assert.equal(calls,0);app.store.db.exec('DROP TRIGGER deny_insert');
 app.store.db.exec("CREATE TRIGGER deny_attempt BEFORE UPDATE ON deliveries WHEN NEW.state='attempted' BEGIN SELECT RAISE(ABORT,'synthetic'); END");await assert.rejects(send());assert.equal(calls,0);app.store.db.exec('DROP TRIGGER deny_attempt');
 app.store.db.exec("CREATE TRIGGER deny_ack BEFORE UPDATE ON deliveries WHEN NEW.state='acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic'); END");await assert.rejects(send(),/unknown/);assert.equal(calls,1);assert.ok(store.list().some(x=>x.state==='outcome_unknown'));
 }finally{app.store.close();cleanup();}
});
test('Telegram 5xx remains unknown even when response body claims success or rate limit',async()=>{
 const {TelegramBridge,TELEGRAM_VAULT}=await import('../src/bridges/telegram.ts');const {listen}=await import('./helpers.ts');const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});let calls=0;
 const fake=await listen(async(_req,res)=>{calls++;res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({ok:true,result:{message_id:42}}));});
 app.vault.set(TELEGRAM_VAULT,'synthetic-telegram-token');
 try{const tg=new TelegramBridge(app,{apiBase:fake.url});await assert.rejects(tg.send(1,'message'),/unknown/);assert.equal(calls,1);assert.equal(deliveryFor(app).list()[0].state,'outcome_unknown');}
 finally{fake.server.close();app.store.close();cleanup();}
});
test('reviews redact even short known secrets; completed review payload retention is bounded',async()=>{
 const {deliveryFor}=await import('../src/delivery.ts');const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 try{app.vault.set('short','abc123');const d=deliveryFor(app);const a=d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1',review:{text:'contains abc123'}});
 assert.equal(d.review(a.id).text.includes('abc123'),false);d.recoverInterrupted();d.resolve(a.id,'queued','dismissed');assert.throws(()=>d.review(a.id),/unavailable/);
 }finally{app.store.close();cleanup();}
});
test('bounded 429 retries retain one identity; invalid albums remain unknown without retries', async () => {
 const {sendDelivery}=await import('../src/bridges/delivery.ts');const {SendQueue,RateLimited}=await import('../src/bridges/sendq.ts');const {deliveryFor}=await import('../src/delivery.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});const queue=new SendQueue();let calls=0;const nonces:string[]=[];
 try {
  await assert.rejects(sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async nonce=>{calls++;nonces.push(nonce);throw new RateLimited(0);}),/rejected/);
  assert.equal(calls,4);assert.equal(new Set(nonces).size,1);assert.equal(deliveryFor(app).list()[0].attempts,4);assert.equal(deliveryFor(app).list()[0].state,'failed');
  calls=0;await assert.rejects(sendDelivery(app,queue,'tg:1',1,{bridge:'telegram',operation:'sendMediaGroup',destination:'1'},async()=>{calls++;return [{message_id:1}];},2),/unknown/);assert.equal(calls,1);
 }finally{app.store.close();cleanup();}
});
test('encrypted review cannot move to another row or database; list excludes payload and destinations',async()=>{
 const {deliveryFor}=await import('../src/delivery.ts');const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 try{const store=deliveryFor(app);const a=store.enqueue({bridge:'telegram',operation:'sendMessage',destination:'123456',review:{text:'private fixture text'}});const b=store.enqueue({bridge:'telegram',operation:'sendMessage',destination:'789012',review:{text:'other fixture'}});
 const raw=app.store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(a.id)!;assert.equal(JSON.stringify(raw).includes('private fixture text'),false);assert.equal(JSON.stringify(store.list()).includes('123456'),false);
 app.store.db.prepare('UPDATE deliveries SET payload=? WHERE id=?').run(raw.payload!,b.id);assert.throws(()=>store.review(b.id),/unavailable/);
 assert.equal(store.review(a.id).text,'private fixture text');assert.equal(deliveryFor(app),store);
 store.attempt(a.id);assert.equal(deliveryFor(app).list().find(x=>x.id===a.id)?.state,'attempted');
 }finally{app.store.close();cleanup();}
});

test('unresolved-first list and bounded cursor expose every held row despite acknowledgment traffic',async()=>{
 const {deliveryFor}=await import('../src/delivery.ts');const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 try{const d=deliveryFor(app);const held:string[]=[];
 for(let n=0;n<225;n++)held.push(d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1',review:{text:`held ${n}`}}).id);
 for(let n=0;n<210;n++){const a=d.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1'});d.attempt(a.id);d.acknowledge(a.id,['12']);}
 assert.equal(d.list().every(r=>r.state==='queued'),true);d.recoverInterrupted();
 assert.equal(typeof d.page,'function');
 const seen:string[]=[];let cursor:string|undefined;
 do{const p=d.page({filter:'unresolved',limit:37,cursor});assert.ok(p.deliveries.length<=37);seen.push(...p.deliveries.map(r=>r.id));
 if(p.deliveries.length)d.resolve(p.deliveries[0].id,'queued','dismissed');cursor=p.nextCursor??undefined;}while(cursor);
 assert.deepEqual(seen,held);assert.equal(d.page({filter:'all',limit:200}).deliveries.length,200);assert.throws(()=>d.page({cursor:'invalid'}));
 }finally{app.store.close();cleanup();}
});
test('delivery HTTP pagination validates cursors and offers all history without exposing review bodies', async (t) => {
  const { createSaraServer } = await import('../src/server.ts');
  const { OwnerAuth } = await import('../src/auth.ts');
  const { deliveryFor } = await import('../src/delivery.ts');
  const { ROOT } = await import('./helpers.ts');
  const { join } = await import('node:path');
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: 'q3-fixture', revision: 'fixture', startedAt: app.now().toISOString() } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); cleanup(); });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/deliveries`;
  const headers = { authorization: `Bearer ${auth.newToken}` };
  const d = deliveryFor(app);
  const first = d.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '1', review: { text: 'private HTTP fixture' } });
  const second = d.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '1' });
  const ack = d.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '1' });
  d.attempt(ack.id); d.acknowledge(ack.id, ['34']);
  const page = await (await fetch(`${base}?limit=1`, { headers })).json();
  assert.equal(page.deliveries[0].id, first.id);
  assert.equal(JSON.stringify(page).includes('private HTTP fixture'), false);
  const rest = await (await fetch(`${base}?limit=1&cursor=${page.nextCursor}`, { headers })).json();
  assert.equal(rest.deliveries[0].id, second.id); assert.equal(rest.nextCursor, null);
  assert.equal((await (await fetch(`${base}?filter=all`, { headers })).json()).deliveries.length, 3);
  for (const query of ['cursor=bad', 'limit=201', 'filter=bad']) assert.equal((await fetch(`${base}?${query}`, { headers })).status, 400);
});
test('live queued delivery waits honestly; restart holds it and prevents dispatch or silent live resolution', async () => {
 const { deliveryFor, DeliveryStore } = await import('../src/delivery.ts');
 const { sendDelivery } = await import('../src/bridges/delivery.ts');
 const { SendQueue } = await import('../src/bridges/sendq.ts');
 const { dir, cleanup } = tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 try {
  const queue=new SendQueue();let release!:()=>void;let effects=0;
  const blocker=queue.send('tg:1',0,()=>new Promise<void>(resolve=>{release=resolve;}));
  const sending=sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1',review:{text:'waiting fixture'}},async()=>{effects++;return {message_id:4};});
  const store=deliveryFor(app);const queued=store.list()[0];
  assert.equal(queued.state,'queued');assert.equal(queued.held,false);
  assert.throws(()=>store.resolve(queued.id,'queued','dismissed'),/still queued/);
  assert.equal(store.review(queued.id).text,'waiting fixture');
  release();await blocker;await sending;assert.equal(effects,1);
  const held=store.enqueue({bridge:'telegram',operation:'sendMessage',destination:'1',review:{text:'held fixture'}});
  app.store.db.exec('ALTER TABLE deliveries DROP COLUMN held');
  const restored=new DeliveryStore(app.store.db,app.vault);
  assert.equal(restored.list().find(row=>row.id===held.id)?.held,true);
  assert.throws(()=>restored.attempt(held.id),/held/);
  assert.equal(effects,1);restored.resolve(held.id,'queued','dismissed');
 } finally {app.store.close();cleanup();}
});
test('429 backoff remains live queued and cannot be human-resolved before its bounded retry', async () => {
 const { deliveryFor }=await import('../src/delivery.ts');const { sendDelivery }=await import('../src/bridges/delivery.ts');const { SendQueue, RateLimited }=await import('../src/bridges/sendq.ts');
 const {dir,cleanup}=tempDir();const app=makeApp(dir,{now:new Date('2026-11-04T12:00:00Z')});
 let now=0;const timers:(()=>void)[]=[];const queue=new SendQueue({clock:{now:()=>now,setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:()=>undefined}});let calls=0;
 try{const sending=sendDelivery(app,queue,'tg:1',0,{bridge:'telegram',operation:'sendMessage',destination:'1'},async()=>{if(++calls===1)throw new RateLimited(1000);return {message_id:6};});
 await new Promise<void>(resolve=>setImmediate(resolve));const d=deliveryFor(app);const row=d.list()[0];
 assert.equal(row.state,'queued');assert.equal(row.held,false);assert.equal(row.attempts,1);assert.throws(()=>d.resolve(row.id,'queued','dismissed'),/still queued/);
 now=1000;for(const timer of timers.splice(0))timer();await sending;assert.equal(calls,2);assert.equal(d.list()[0].state,'acknowledged');
 }finally{app.store.close();cleanup();}
});
