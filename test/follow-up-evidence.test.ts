import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followUps } from '../src/memory.ts';
import { ownerEventMemory, pendingOwnerEvents } from '../src/owner-evidence.ts';
import { makeApp, tempDir } from './helpers.ts';

for (const text of ["My interview wasn't cancelled", "My interview isn't cancelled", "My interview hadn't been cancelled"]) {
  test(`E2: real followUps retains an owner event after a negated cancellation: ${text}`, () => {
    const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
    try {
      const c = app.store.createConversation();
      const event = app.memory!.addOwner({ kind: 'date', content: 'Interview at Acme', onDate: '2026-11-04', happenedOn: '2026-11-01' });
      clock.now = new Date('2026-11-05T18:00:00Z');
      const pending = () => followUps(app, c.id, '2026-11-05').map(row => row.memory.id);
      assert.deepEqual(pending(), [event.id]);
      const answer = app.store.addMessage(c.id, 'user', text); app.store.markDirectOwnerMessage(answer.id);
      assert.deepEqual(pending(), [event.id], 'a trusted denial supplies no cancellation or outcome evidence');
      app.store.updateMessageContent(answer.id, 'My interview was not cancelled'); assert.deepEqual(pending(), [event.id]);
      app.store.updateMessageContent(answer.id, 'My interview was cancelled'); assert.deepEqual(pending(), []);
      app.store.updateMessageContent(answer.id, text); assert.deepEqual(pending(), [event.id], 'current denial revokes a stale cancellation');
      app.store.updateMessageContent(answer.id, "My interview didn't go well"); assert.deepEqual(pending(), []);
      app.store.updateMessageContent(answer.id, "I don't want to discuss my interview"); assert.deepEqual(pending(), []);
    } finally { app.store.close(); t.cleanup(); }
  });
}

for (const terminal of ['.', '!', ';']) {
  test(`E2: current attributable source reconciles its exact terminal punctuation ${terminal}`, () => {
    const t = tempDir(); const app = makeApp(t.dir, { now: new Date('2026-11-05T15:00:00Z') });
    try {
      const c = app.store.createConversation();
      const source = app.store.addMessage(c.id, 'user', `My interview is tomorrow${terminal}`);
      app.store.markDirectOwnerMessage(source.id);
      const event = app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: '2026-11-06', happenedOn: '2026-11-05' });
      assert.equal(ownerEventMemory(app, c.id, event), true, 'an exact attributed quote remains valid with its original terminator');
      app.store.db.prepare('UPDATE memories SET evidence = ? WHERE id = ?').run('My interview is tomorrow?', event.id);
      assert.equal(ownerEventMemory(app, c.id, app.memory!.get(event.id)!), false, 'a fabricated question terminator is not the original evidence');
    } finally { app.store.close(); t.cleanup(); }
  });
}

for (const date of ['2026-11-05', '2026-11-06']) {
  for (const timing of ['before', 'during']) {
    test(`E2: real Life tick rejects cancelled ${date} date ${timing} provider await`, async () => {
      const { LifeWorker } = await import('../src/life.ts');
      const { UsageStore } = await import('../src/usage.ts');
      const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
      try {
        app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'America/Chicago', proactive: { enabled: true, maxPerDay: 2, minGapHours: 1, quietStart: 23, quietEnd: 7 } });
        const c = app.store.createConversation();
        const source = app.store.addMessage(c.id, 'user', `My interview is November ${date.endsWith('05') ? '5' : '6'}`); app.store.markDirectOwnerMessage(source.id);
        const event = app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: date, happenedOn: '2026-11-01' });
        // A separate valid date forces generation for the upcoming-date fixture.
        const valid = date.endsWith('06') ? app.memory!.addOwner({ kind: 'date', content: 'Birthday today', onDate: '11-05', happenedOn: '2026-11-01' }) : undefined;
        app.store.addMessage(c.id, 'assistant', 'Good luck');
        const cancel = () => app.store.updateMessageContent(source.id, `${source.content}. My interview was cancelled`);
        if (timing === 'before') cancel();
        clock.now = new Date('2026-11-05T18:00:00Z');
        app.life!.set('2026-11-05', 'A quiet morning spent reading a novel.', clock.now);
        app.usage = new UsageStore(app.store.db, () => clock.now);
        let calls = 0; let injected = false;
        app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream(req) {
          calls++; injected = req.messages.some((m) => m.content.includes('Interview at Acme'));
          if (timing === 'during') cancel();
          yield { type: 'text', text: 'Hope your day goes well.' }; yield { type: 'usage', input: 31, output: 7 };
        } });
        const before = app.store.messages(c.id).length; const state = app.inner!.get(clock.now);
        const result = await new LifeWorker(app, app.life!, app.inner!, () => 0.99).tick();
        const shouldSend = timing === 'before' && Boolean(valid);
        assert.equal(calls, timing === 'before' && !valid ? 0 : 1);
        assert.equal(injected, timing === 'during', 'cancelled dates are absent before handoff; in-flight dates were initially eligible');
        assert.equal(Boolean(result.proactive), shouldSend);
        assert.equal(app.store.messages(c.id).length, before + (shouldSend ? 2 : 0), 'revocation must not add a notice or message');
        assert.equal(app.memory!.get(event.id)!.mentionedOn, null);
        assert.equal(app.inner!.get(clock.now).proactiveCount, state.proactiveCount + (shouldSend ? 1 : 0));
        if (valid) assert.equal(app.memory!.get(valid.id)!.mentionedOn, shouldSend ? '2026-11-05' : null);
        assert.equal(app.usage.exportRows().length, calls);
        if (calls) {
          const usage = app.usage.exportRows()[0];
          assert.equal(usage.input, 31); assert.equal(usage.output, 7); assert.equal(usage.purpose, 'her-life');
        }
      } finally { app.store.close(); t.cleanup(); }
    });
  }
}

test('E2: real Life tick respects inner-life opt-out during provider await without delivery writes', async () => {
  const { LifeWorker } = await import('../src/life.ts'); const { UsageStore } = await import('../src/usage.ts');
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'America/Chicago', proactive: { enabled: true, maxPerDay: 2, minGapHours: 1, quietStart: 23, quietEnd: 7 } });
    const c = app.store.createConversation(); const source = app.store.addMessage(c.id, 'user', 'My interview is November 5'); app.store.markDirectOwnerMessage(source.id);
    const event = app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: '2026-11-05', happenedOn: '2026-11-01' });
    app.store.addMessage(c.id, 'assistant', 'Good luck'); clock.now = new Date('2026-11-05T18:00:00Z');
    app.life!.set('2026-11-05', 'A quiet morning spent reading a novel.', clock.now); app.usage = new UsageStore(app.store.db, () => clock.now);
    let calls = 0; app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() {
      calls++; app.settings.update({ persona: { ...app.settings.get().persona, innerLife: false } });
      yield { type: 'text', text: 'Hope your interview goes well today.' }; yield { type: 'usage', input: 37, output: 9 };
    } });
    const before = app.store.messages(c.id).length; const state = app.inner!.get(clock.now);
    const result = await new LifeWorker(app, app.life!, app.inner!, () => 0.99).tick();
    assert.equal(calls, 1); assert.equal(result.proactive, undefined); assert.match(result.skipped ?? '', /source|context|changed/);
    assert.equal(app.store.messages(c.id).length, before); assert.equal(app.memory!.get(event.id)!.mentionedOn, null);
    assert.equal(app.inner!.get(clock.now).proactiveCount, state.proactiveCount);
    const rows = app.usage.exportRows(); assert.equal(rows.length, 1); assert.equal(rows[0].input, 37); assert.equal(rows[0].output, 9); assert.equal(rows[0].purpose, 'her-life');
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: shared date batch preserves competitors before current and future chronology checks', () => {
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    app.settings.update({ timeZone: 'America/Chicago' }); const c = app.store.createConversation();
    const today = app.memory!.addOwner({ kind: 'date', content: 'Interview at Acme', onDate: '2026-11-05', happenedOn: '2026-11-01' });
    const tomorrow = app.memory!.addOwner({ kind: 'date', content: 'Interview at Globex', onDate: '2026-11-06', happenedOn: '2026-11-01' });
    clock.now = new Date('2026-11-05T18:00:00Z');
    const answer = app.store.addMessage(c.id, 'user', 'My interview was cancelled'); app.store.markDirectOwnerMessage(answer.id);
    const pending = () => pendingOwnerEvents(app, c.id, app.memory!.upcoming('2026-11-05', 14)).map((p) => p.memory.id);
    assert.deepEqual(pending(), [today.id, tomorrow.id], 'date must not disambiguate a shared topic');
    app.store.updateMessageContent(answer.id, 'My interview at Globex went well');
    assert.deepEqual(pending(), [today.id, tomorrow.id], 'reported outcome before the future event remains premature');
    app.store.updateMessageContent(answer.id, 'My interview at Acme went well'); assert.deepEqual(pending(), [tomorrow.id]);
    app.store.updateMessageContent(answer.id, 'I do not want to discuss my interview at Globex'); assert.deepEqual(pending(), [today.id]);
    app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-10-31T18:00:00Z', answer.id);
    assert.deepEqual(pending(), [today.id, tomorrow.id], 'decline older than event creation cannot close it');
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: mere topic mention is not an outcome', () => {
  const t = tempDir(); const clock = { now: new Date('2026-11-05T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    const c = app.store.createConversation();
    const m = app.memory!.addOwner({ kind: 'date', content: 'Alex interview at Acme', onDate: '2026-11-04', happenedOn: '2026-11-01' });
    const message = app.store.addMessage(c.id, 'user', 'The interview has not happened yet'); app.store.markDirectOwnerMessage(message.id);
    const result = followUps(app, c.id, '2026-11-05');
    assert.deepEqual(result.map((p) => p.memory.id), [m.id]);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: sourced events reconcile current attributable quote, category and destination workspace', () => {
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    const c = app.store.createConversation(); const dest = app.store.createConversation();
    const source = app.store.addMessage(c.id, 'user', 'My interview is November 4'); app.store.markDirectOwnerMessage(source.id);
    const m = app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: '2026-11-04', happenedOn: '2026-11-01' });
    assert.ok(ownerEventMemory(app, dest.id, m));
    app.store.updateMessageContent(source.id, 'My exam is November 4'); assert.equal(ownerEventMemory(app, dest.id, m), false);
    app.store.updateMessageContent(source.id, 'He said "My interview is November 4"'); assert.equal(ownerEventMemory(app, dest.id, m), false);
    app.store.updateMessageContent(source.id, source.content);
    app.store.updateConversation(c.id, { workspace: 'other' }); assert.equal(ownerEventMemory(app, dest.id, m), false);
    app.store.updateConversation(c.id, { workspace: 'main', private: true }); assert.equal(ownerEventMemory(app, dest.id, m), false);
    app.store.updateConversation(c.id, { private: false });
    app.store.updateMessageMeta(source.id, { forgotten: true }); assert.equal(ownerEventMemory(app, dest.id, m), false);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: batch matching retains ambiguous interviews and closes only explicit distinguished actual outcomes', () => {
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' }); const c = app.store.createConversation();
    const a = app.memory!.addOwner({ kind: 'date', content: 'Interview at Acme', onDate: '2026-11-04', happenedOn: '2026-11-01' });
    const b = app.memory!.addOwner({ kind: 'date', content: 'Interview at Globex', onDate: '2026-11-04', happenedOn: '2026-11-01' });
    clock.now = new Date('2026-11-05T18:00:00Z');
    const answer = app.store.addMessage(c.id, 'user', 'The interview went great'); app.store.markDirectOwnerMessage(answer.id);
    assert.deepEqual(followUps(app, c.id, '2026-11-05').map((p) => p.memory.id).sort(), [a.id,b.id]);
    app.store.updateMessageContent(answer.id, 'My interview at Acme did not go well');
    assert.deepEqual(followUps(app, c.id, '2026-11-05').map((p) => p.memory.id), [b.id]);
    app.store.updateMessageMeta(answer.id, { forgotten: true }); assert.equal(followUps(app, c.id, '2026-11-05').length, 2);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: early cancellation closes a sourced event while premature reported outcomes do not', () => {
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    app.settings.update({ timeZone: 'America/Chicago' }); const c = app.store.createConversation();
    const source = app.store.addMessage(c.id, 'user', 'My interview is November 4'); app.store.markDirectOwnerMessage(source.id);
    app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: '2026-11-04', happenedOn: '2026-11-01' });
    clock.now = new Date('2026-11-02T18:00:00Z'); const answer = app.store.addMessage(c.id, 'user', 'My interview went well'); app.store.markDirectOwnerMessage(answer.id);
    clock.now = new Date('2026-11-05T18:00:00Z'); assert.equal(followUps(app,c.id,'2026-11-05').length,1);
    app.store.updateMessageContent(answer.id, 'My interview was cancelled'); assert.equal(followUps(app,c.id,'2026-11-05').length,0);
    app.store.updateMessageContent(answer.id, 'I do not want to discuss my interview'); assert.equal(followUps(app,c.id,'2026-11-05').length,0);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: Life drops generated follow-up when source privacy changes during provider await', async () => {
  const { LifeWorker } = await import('../src/life.ts');
  const { UsageStore } = await import('../src/usage.ts');
  const t = tempDir(); const clock = { now: new Date('2026-11-01T18:00:00Z') }; const app = makeApp(t.dir, clock);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'America/Chicago', proactive: { enabled: true, maxPerDay: 2, minGapHours: 1, quietStart: 23, quietEnd: 7 } });
    const c = app.store.createConversation(); const source = app.store.addMessage(c.id, 'user', 'My interview is November 4'); app.store.markDirectOwnerMessage(source.id);
    app.store.addMessage(c.id, 'assistant', 'Good luck');
    const m = app.memory!.add({ kind: 'date', content: 'Interview at Acme', evidence: source.content, conversationId: c.id, sourceMessageId: source.id, onDate: '2026-11-04', happenedOn: '2026-11-01' });
    clock.now = new Date('2026-11-05T18:00:00Z');
    app.usage = new UsageStore(app.store.db, () => clock.now);
    let calls=0;
    app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() { calls++; app.store.updateConversation(c.id,{private:true}); yield { type: 'text', text: 'How did your interview go?' }; yield { type: 'usage', input: 31, output: 7 }; } });
    const before = app.store.messages(c.id).length; const state = app.inner!.get(clock.now);
    const result = await new LifeWorker(app,app.life!,app.inner!,()=>0.99).maybeProactive();
    assert.equal(calls,1); assert.equal(result.proactive,undefined); assert.match(result.skipped ?? '', /source|context|changed/);
    assert.equal(app.store.messages(c.id).length,before); assert.equal(app.memory!.get(m.id)!.mentionedOn,null);
    assert.equal(app.inner!.get(clock.now).proactiveCount,state.proactiveCount);
    assert.equal(app.usage.exportRows().length,1); assert.equal(app.usage.exportRows()[0].input,31); assert.equal(app.usage.exportRows()[0].output,7);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: source eligibility does not authenticate stale event text after memory edits', () => {
  const t=tempDir(); const app=makeApp(t.dir,{now:new Date('2026-11-05T18:00:00Z')});
  try {
    const c=app.store.createConversation(); const old=app.memory!.addOwner({kind:'date',content:'Interview at Acme',onDate:'2026-11-04',happenedOn:'2026-11-01'});
    app.memory!.update(old.id,'Interview at Globex');
    assert.equal(ownerEventMemory(app,c.id,old),false);
    assert.equal(ownerEventMemory(app,c.id,app.memory!.get(old.id)!),true);
  } finally { app.store.close(); t.cleanup(); }
});

test('E2: Life revalidates other event sources included in the date prompt after await', async () => {
  const { LifeWorker } = await import('../src/life.ts');
  const t=tempDir(); const clock={now:new Date('2026-11-01T18:00:00Z')}; const app=makeApp(t.dir,clock);
  try {
    app.settings.update({providers:[{id:'p',label:'P',kind:'openai-compatible',baseUrl:'http://x'}],defaultProviderId:'p',defaultModel:'m',timeZone:'America/Chicago',proactive:{enabled:true,maxPerDay:2,minGapHours:1,quietStart:23,quietEnd:7}});
    const sourceConv=app.store.createConversation({mode:'coding'}); const c=app.store.createConversation();
    const source=app.store.addMessage(sourceConv.id,'user','My interview is November 6'); app.store.markDirectOwnerMessage(source.id);
    app.memory!.add({kind:'date',content:'Interview at Acme',evidence:source.content,conversationId:sourceConv.id,sourceMessageId:source.id,onDate:'2026-11-06',happenedOn:'2026-11-01'});
    app.memory!.addOwner({kind:'date',content:'Appointment today',onDate:'2026-11-05',happenedOn:'2026-11-01'});
    app.store.addMessage(c.id,'user','Hello'); app.store.addMessage(c.id,'assistant','Hi'); clock.now=new Date('2026-11-05T18:00:00Z');
    app.providerFactory=(config)=>({config,async listModels(){return ['m'];},async *stream(){app.store.updateConversation(sourceConv.id,{private:true});yield {type:'text',text:'Hope your appointment goes well.'};}});
    const result=await new LifeWorker(app,app.life!,app.inner!,()=>0.99).maybeProactive();
    assert.equal(result.proactive,undefined); assert.match(result.skipped ?? '',/source|context|changed/);
  } finally {app.store.close();t.cleanup();}
});

test('E2: retained source quote cannot outvote a later explicit event correction', () => {
  const t=tempDir(); const app=makeApp(t.dir,{now:new Date('2026-11-05T18:00:00Z')});
  try {
    const c=app.store.createConversation(); const source=app.store.addMessage(c.id,'user','My interview is November 4'); app.store.markDirectOwnerMessage(source.id);
    const m=app.memory!.add({kind:'date',content:'Interview at Acme',evidence:source.content,conversationId:c.id,sourceMessageId:source.id,onDate:'2026-11-04',happenedOn:'2026-11-01'});
    assert.equal(ownerEventMemory(app,c.id,m),true);
    app.store.updateMessageContent(source.id,source.content+'. Actually I do not have an interview');
    assert.equal(ownerEventMemory(app,c.id,m),false);
    assert.deepEqual(followUps(app,c.id,'2026-11-05'),[]);
  } finally {app.store.close();t.cleanup();}
});

test('E2: reported event outcomes respect local day start across the DST fall-back', () => {
  const t=tempDir(); const clock={now:new Date('2026-10-30T18:00:00Z')}; const app=makeApp(t.dir,clock);
  try {
    app.settings.update({timeZone:'America/Chicago'}); const c=app.store.createConversation();
    app.memory!.addOwner({kind:'date',content:'Interview at Acme',onDate:'2026-11-01',happenedOn:'2026-10-30'});
    clock.now=new Date('2026-11-01T04:59:59Z'); const answer=app.store.addMessage(c.id,'user','My interview went well'); app.store.markDirectOwnerMessage(answer.id);
    clock.now=new Date('2026-11-02T18:00:00Z'); assert.equal(followUps(app,c.id,'2026-11-02').length,1);
    app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-11-01T05:00:00Z',answer.id);
    assert.equal(followUps(app,c.id,'2026-11-02').length,0);
    app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('invalid',answer.id); assert.equal(followUps(app,c.id,'2026-11-02').length,1);
    app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-11-03T18:00:00Z',answer.id); assert.equal(followUps(app,c.id,'2026-11-02').length,1);
  } finally {app.store.close();t.cleanup();}
});

test('E2: source cancellation still invalidates an event beyond the bounded recent-answer window', () => {
  const t=tempDir(); const clock={now:new Date('2026-11-01T18:00:00Z')}; const app=makeApp(t.dir,clock);
  try {
    const c=app.store.createConversation(); const source=app.store.addMessage(c.id,'user','My interview is November 4'); app.store.markDirectOwnerMessage(source.id);
    app.memory!.add({kind:'date',content:'Interview at Acme',evidence:source.content,conversationId:c.id,sourceMessageId:source.id,onDate:'2026-11-04',happenedOn:'2026-11-01'});
    app.store.updateMessageContent(source.id,source.content+'. My interview was cancelled');
    clock.now=new Date('2026-11-05T18:00:00Z');
    for(let i=0;i<205;i++){const m=app.store.addMessage(c.id,'user','An unrelated ordinary message');app.store.markDirectOwnerMessage(m.id);}
    assert.deepEqual(followUps(app,c.id,'2026-11-05'),[]);
  } finally {app.store.close();t.cleanup();}
});
