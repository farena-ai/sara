import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp, tempDir } from './helpers.ts';

test('E2: generic messages and memories cannot claim authenticated owner provenance', () => {
  const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
  try {
    const conv = app.store.createConversation();
    const msg = app.store.addMessage(conv.id, 'user', 'My interview is tomorrow', { ownerOrigin: 'direct-v1' });
    assert.equal(msg.ownerOrigin ?? null, null);
    const memory = app.memory!.add({ kind: 'date', content: 'Interview', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-04' });
    assert.equal(memory.origin, 'derived');
    app.memory!.update(memory.id, 'Edited interview');
    assert.equal(app.memory!.get(memory.id)!.origin, 'derived');
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: dialogue mutation witness ignores inserts/noops/tools but captures metadata and moves', () => {
  const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
  try {
    const a = app.store.createConversation(); const b = app.store.createConversation();
    const epoch = (id: string) => app.store.getConversation(id)!.dialogueEpoch;
    assert.equal(epoch(a.id), 0);
    const m = app.store.addMessage(a.id, 'user', 'hello');
    assert.equal(epoch(a.id), 0);
    app.store.updateMessageContent(m.id, 'hello'); assert.equal(epoch(a.id), 0);
    app.store.updateMessageMeta(m.id, { pinned: true }); assert.equal(epoch(a.id), 1);
    app.store.updateMessageMeta(m.id, { runId: 7 }); assert.equal(epoch(a.id), 2);
    app.store.updateMessageMeta(m.id, { runId: 7 }); assert.equal(epoch(a.id), 2);
    app.store.markDirectOwnerMessage(m.id); assert.equal(epoch(a.id), 2);
    app.store.db.prepare('UPDATE messages SET conversation_id = ? WHERE id = ?').run(b.id, m.id);
    assert.equal(epoch(a.id), 3); assert.equal(epoch(b.id), 1);
    const tool = app.store.addMessage(b.id, 'tool', 'output');
    app.store.updateMessageContent(tool.id, 'changed'); assert.equal(epoch(b.id), 1);
    const notice=app.store.addMessage(b.id,'notice','notice'); app.store.updateMessageMeta(notice.id,{pinned:true}); assert.equal(epoch(b.id),1);
    app.store.db.prepare("UPDATE messages SET role='assistant' WHERE id=?").run(tool.id); assert.equal(epoch(b.id),2);
    app.store.updateMessageContent(tool.id,'edited assistant'); assert.equal(epoch(b.id),3);
    app.store.db.prepare('DELETE FROM messages WHERE id = ?').run(m.id); assert.equal(epoch(b.id), 4);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: latest 200 evidence filters current workspace, rooms and untrusted metadata before limiting', () => {
  const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
  try {
    assert.equal(typeof app.store.followUpEvidenceSince, 'function', 'dedicated eligible source API');
    const a = app.store.createConversation(); const other = app.store.createConversation({ workspace: 'other' });
    const good = app.store.addMessage(a.id, 'user', 'My interview went well'); app.store.markDirectOwnerMessage(good.id);
    for (let i = 0; i < 205; i++) {
      const m = app.store.addMessage(i % 2 ? other.id : a.id, 'user', 'not eligible', i % 2 ? undefined : { untrusted: false });
      app.store.markDirectOwnerMessage(m.id);
    }
    const read = () => app.store.followUpEvidenceSince('2026-11-01T00:00:00Z', { workspace: 'main', until: app.now().toISOString() });
    assert.deepEqual(read().map((m) => m.id), [good.id]);
    app.store.db.exec("CREATE TABLE rooms (bridge TEXT, key TEXT, kind TEXT)");
    const dm = app.store.createConversation({ channel: 'discord', channelKey: '42' });
    const d = app.store.addMessage(dm.id, 'user', 'My interview went badly'); app.store.markDirectOwnerMessage(d.id);
    app.store.db.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run('discord', '42', 'room');
    assert.deepEqual(read().map((m) => m.id), [good.id]);
    app.store.db.prepare("UPDATE rooms SET kind='dm'").run();
    assert.deepEqual(read().map((m) => m.id), [good.id, d.id]);
    app.store.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run('{bad', good.id);
    assert.deepEqual(read().map((m) => m.id), [d.id]);
  } finally { app.store.close(); t.cleanup(); }
});


// Import dynamically so the first RED is an explicit missing-policy assertion.
test('E2: owner policy denies supplied empty context before reads and preserves private legacy only', async () => {
  const policy = await import('../src/owner-evidence.ts');
  assert.equal(typeof policy.ownerEvidenceConversation, 'function', 'trusted context policy exists');
  const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
  try {
    const c = app.store.createConversation();
    assert.ok(policy.ownerEvidenceConversation(app, c.id));
    for (const turn of [{ clientHistory: [] }, { clientNote: '' }, { roomNote: '' }, { roomNow: '' }, { roomId: 0 }, { roomCrisis: false }, { persist: false }, { recorder: null }, { group: null }, { outside: null }, { externalApp: false }, { replay: null }, { resume: false }, { resume: null }, { resume: undefined }]) {
      let reads = 0; const original = app.store.getConversation.bind(app.store);
      app.store.getConversation = (id) => { reads++; return original(id); };
      try { assert.equal(policy.ownerEvidenceConversation(app, c.id, turn as never), undefined); assert.equal(reads, 0); }
      finally { app.store.getConversation = original; }
    }
    app.store.updateConversation(c.id, { private: true });
    assert.equal(policy.ownerEvidenceConversation(app, c.id), undefined);
    assert.ok(policy.legacyInnerConversation(app, c.id));
    assert.ok(policy.legacyInnerConversation(app, c.id, { resume: true }));
    assert.ok(policy.legacyInnerConversation(app, c.id, { resume: false }));
    assert.ok(policy.legacyInnerConversation(app, c.id, { resume: undefined }));
    assert.equal(policy.ownerEvidenceConversation(app, c.id, { resume: true }), undefined);
    app.member = {} as never;
    assert.equal(policy.legacyInnerConversation(app, c.id), undefined);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: Memory POST authenticates owner marker, preserves member notes and ignores forged origin', async () => {
  const { createMemoryRoutes } = await import('../src/routes/memory.ts');
  const { listen } = await import('./helpers.ts');
  const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
  let authed = true;
  const handler = createMemoryRoutes({ app, opts: {}, isAuthed: () => authed } as never);
  const { server, url } = await listen((req,res) => { void handler(req,res,req.method!,['memories']).catch((e: Error) => { res.writeHead(500); res.end(e.message); }); });
  try {
    const post = async () => (await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'date',content:'Interview',onDate:'2026-11-04',origin:'owner'})})).json();
    assert.equal((await post()).origin,'owner');
    app.member = {} as never; assert.equal((await post()).origin,'derived'); app.member=undefined;
    app.demo=true; assert.equal((await post()).origin,'derived'); app.demo=false;
    app.offRecord=true; assert.equal((await post()).origin,'derived'); app.offRecord=false;
    authed=false; assert.equal((await post()).origin,'derived','a route without authenticated owner cannot mint origin');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); app.store.close(); t.cleanup(); }
});

test('E2: JSON imports never inherit trusted message or memory origin; legacy notes stay editable', async () => {
  const { exportAll, importAll } = await import('../src/export.ts');
  const { Store } = await import('../src/store.ts');
  const { MemoryStore } = await import('../src/memory.ts');
  const { join } = await import('node:path');
  const t = tempDir(); const copy = tempDir(); const clock={now:new Date('2026-11-05T15:00:00Z')}; const app=makeApp(t.dir,clock); const imported=makeApp(copy.dir,clock);
  let reopened: InstanceType<typeof Store> | undefined;
  try {
    const c=app.store.createConversation(); const m=app.store.addMessage(c.id,'user','My interview is tomorrow'); app.store.markDirectOwnerMessage(m.id);
    const note=app.memory!.addOwner({kind:'date',content:'Interview at Acme',onDate:'2026-11-04',happenedOn:'2026-11-01'});
    const file=exportAll(app); importAll(imported,file);
    assert.equal(imported.store.messages(imported.store.listConversations()[0].id)[0].ownerOrigin,null);
    const legacy=imported.memory!.list()[0]; assert.equal(legacy.origin,null);
    assert.equal(imported.memory!.update(legacy.id,'Edited interview')!.origin,null);
    assert.ok(imported.memory!.search('interview').length);
    app.store.close(); reopened=new Store(join(t.dir,'sara.db'),()=>clock.now); const mem=new MemoryStore(reopened.db,()=>clock.now);
    assert.equal(reopened.messageById(m.id)!.ownerOrigin,'direct-v1'); assert.equal(mem.get(note.id)!.origin,'owner');
  } finally { reopened?.close(); if (!reopened) app.store.close(); imported.store.close(); t.cleanup(); copy.cleanup(); }
});

test('E2: migration backfills document-derived provenance without promoting legacy sourceless notes', async () => {
  const { MemoryStore } = await import('../src/memory.ts');
  const t=tempDir(); const clock={now:new Date('2026-11-05T15:00:00Z')}; const app=makeApp(t.dir,clock);
  try {
    const doc=app.memory!.add({kind:'date',content:'Document interview',conversationId:null,sourceMessageId:null,sourceDocId:7,happenedOn:'2026-11-01'});
    const legacy=app.memory!.add({kind:'date',content:'Legacy interview',conversationId:null,sourceMessageId:null,evidence:'You added this.',happenedOn:'2026-11-01'});
    app.store.db.exec('ALTER TABLE memories DROP COLUMN origin');
    const mem=new MemoryStore(app.store.db,()=>clock.now);
    assert.equal(mem.get(doc.id)!.origin,'derived'); assert.equal(mem.get(legacy.id)!.origin,null);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: current origin metadata including explicit false external markers cannot become evidence', async () => {
  const { ownerEvidenceMessage }=await import('../src/owner-evidence.ts');
  const t=tempDir(); const app=makeApp(t.dir,{now:new Date('2026-11-05T15:00:00Z')});
  try {
    const c=app.store.createConversation();
    for (const key of ['group','groupFrom','untrusted','hookFrom','importedFrom','forgotten','skipped','external','externalApp','replay','resume','outside','clientHistory','clientNote','roomId','roomCrisis','persist','recorder']) {
      const m=app.store.addMessage(c.id,'user','My interview went well',{[key]:false}); app.store.markDirectOwnerMessage(m.id);
      assert.equal(ownerEvidenceMessage(app,c.id,m.id),undefined,key);
    }
    const valid=app.store.addMessage(c.id,'user','My interview went well'); app.store.markDirectOwnerMessage(valid.id);
    const other=app.store.createConversation(); const extra=app.store.addMessage(other.id,'user','My exam went well');app.store.markDirectOwnerMessage(extra.id);
    assert.deepEqual(app.store.followUpEvidenceSince('2026-11-01T00:00:00Z',{workspace:'main',until:app.now().toISOString(),conversationId:c.id}).map((m)=>m.id),[valid.id]);
  } finally {app.store.close();t.cleanup();}
});
