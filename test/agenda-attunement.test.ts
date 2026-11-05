import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agenda, AgendaStore } from '../src/agenda.ts';
import { UsageStore } from '../src/usage.ts';
import { exportAll, importAll } from '../src/export.ts';
import { makeApp, tempDir } from './helpers.ts';

function fixture(t: { after(fn: () => void): void }, sourceText = 'My interview at Acme is November 5', dueAt = '2026-11-05T18:00:00Z') {
  const tmp = tempDir(); const clock = { now: new Date('2026-11-01T12:00:00Z') }; const app = makeApp(tmp.dir, clock);
  t.after(() => { app.store.close(); tmp.cleanup(); });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', proactive: { maxPerDay: 2, minGapHours: 1, quietStart: 23, quietEnd: 7 } });
  const agenda = new Agenda(app, app.store.db); app.agenda = agenda; agenda.update({ enabled: true });
  const c = app.store.createConversation();
  const owner = (content: string, conversation = c.id) => { const m = app.store.addMessage(conversation, 'user', content); app.store.markDirectOwnerMessage(m.id); return m; };
  const source = owner(sourceText);
  const item = agenda.store.addItem({ kind: 'follow-up', what: 'Ask how your interview at Acme went', why: 'You said this', quote: source.content, sourceConversation: c.id, sourceMessage: source.id, dueAt, createdBy: 'her' });
  agenda.store.setState('cursor', String(source.id));
  clock.now = new Date('2026-11-05T18:00:00Z');
  app.usage = new UsageStore(app.store.db, () => clock.now);
  const calls = { count: 0 }; let during: (() => void) | undefined;
  app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream(request) { calls.count++; app.requests.push(request); during?.(); yield { type: 'text', text: 'How did your interview at Acme go?' }; yield { type: 'usage', input: 31, output: 7 }; } });
  return { app, clock, agenda, c, source, item, owner, calls, during(fn: () => void) { during = fn; }, current: () => agenda.store.item(item.id)! };
}

test('E2 Agenda: completed delivery captures its witness; immediate pronoun answer records provenance', async (t) => {
  const f = fixture(t); assert.equal((await f.agenda.tick()).sent, 1);
  assert.equal(f.current().sentDialogueEpoch, f.app.store.getConversation(f.c.id)!.dialogueEpoch);
  const answer = f.owner('It went great'); await f.agenda.tick();
  assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, answer.id); assert.equal(f.current().answerMatchKind, 'direct');
  assert.deepEqual(f.agenda.store.goal(1), undefined); assert.equal(f.calls.count, 1);
});

test('E2 Agenda: actual follow-up prompt describes the bounded evidence honestly', async (t) => {
  const f = fixture(t); await f.agenda.tick();
  assert.match(String(f.app.requests.at(-1)!.messages.at(-1)!.content), /no clear outcome was found in eligible recent messages/i);
  assert.match(String(f.app.requests.at(-1)!.messages.at(-1)!.content), /ask only if still relevant.*do not repeat if answered here/i);
});

test('E2 Agenda: delivery captures the post-await epoch rather than the generation-start epoch', async (t) => {
  const f = fixture(t); const before = f.app.store.getConversation(f.c.id)!.dialogueEpoch ?? 0;
  f.during(() => f.app.store.updateMessageMeta(f.source.id, { pinned: true })); await f.agenda.tick();
  assert.equal(f.current().sentDialogueEpoch, before + 1); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
});

test('E2 Agenda: explicit owner plan and Agenda consent remain independent of inner-life opt-out', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { status: 'cancelled' });
  f.app.settings.update({ persona: { ...f.app.settings.get().persona, innerLife: false } }); f.agenda.update({ followUps: false });
  const ownerPlan = f.agenda.store.addItem({ kind: 'follow-up', what: 'Ask about the interview', why: 'You asked her to', dueAt: f.item.dueAt, createdBy: 'owner' });
  assert.equal((await f.agenda.tick()).sent, 1); assert.equal(f.agenda.store.item(ownerPlan.id)!.status, 'sent');
});

test('E2 Agenda: automatic follow-up closure never creates goal progress', async (t) => {
  const f = fixture(t); const goal = f.agenda.store.addGoal({ title: 'Find work', why: 'You asked her to', status: 'active', createdBy: 'owner' });
  f.app.store.db.prepare('UPDATE agenda_items SET goal_id=? WHERE id=?').run(goal.id, f.item.id);
  await f.agenda.tick(); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
  assert.deepEqual(f.agenda.store.goal(goal.id)!.notes, []); assert.equal(f.agenda.store.goal(goal.id)!.status, 'active'); assert.equal(f.agenda.store.items({ goalId: goal.id }).length, 1);
});

test('E2 Agenda: a qualified unknown-category sourced plan retains delivery without inferred completion', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { status: 'cancelled' });
  f.clock.now = new Date('2026-11-01T12:00:00Z'); const source = f.owner('I see the plumber on Wednesday.');
  const item = f.agenda.store.addItem({ kind: 'follow-up', what: 'Ask how the plumber visit went', why: `You said ${source.content}`, quote: source.content, sourceConversation: f.c.id, sourceMessage: source.id, dueAt: '2026-11-05T18:00:00Z', createdBy: 'her' });
  f.agenda.store.setState('cursor', String(source.id)); f.clock.now = new Date('2026-11-05T18:00:00Z');
  assert.equal((await f.agenda.tick()).sent, 1); f.owner('The plumber visit went well'); await f.agenda.tick();
  assert.equal(f.agenda.store.item(item.id)!.status, 'sent'); assert.equal(f.calls.count, 1);
});

test('E2 Agenda: unrelated answer stays sent; a later explicit topic-bearing outcome closes it', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.owner('Please help me fix this build'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
  f.app.store.addMessage(f.c.id, 'assistant', 'Which error do you see?'); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
  const answer = f.owner('My interview at Acme went badly'); await f.agenda.tick(); assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, answer.id); assert.equal(f.current().answerMatchKind, 'topic');
});

for (const mutation of ['delete-intervening', 'forget-intervening', 'pin', 'runId', 'question-edit']) {
  test(`E2 Agenda: ${mutation} cannot manufacture immediate pronoun adjacency`, async (t) => {
    const f = fixture(t); await f.agenda.tick();
    if (mutation.includes('intervening')) {
      const m = f.app.store.addMessage(f.c.id, 'assistant', 'How was lunch?'); f.owner('It went great');
      if (mutation === 'delete-intervening') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
      else f.app.store.updateMessageMeta(m.id, { forgotten: true });
    } else {
      f.owner('It went great');
      if (mutation === 'question-edit') f.app.store.updateMessageContent(f.current().messageId!, 'How was lunch?');
      else f.app.store.updateMessageMeta(f.current().messageId!, { [mutation === 'pin' ? 'pinned' : 'runId']: mutation === 'pin' ? true : 'other-run' });
    }
    await f.agenda.tick(); assert.equal(f.current().status, 'sent'); assert.equal(f.current().answerMessageId, null); assert.equal(f.calls.count, 1);
  });
}

for (const mutation of ['answer-edit', 'answer-delete', 'answer-forget', 'answer-private', 'answer-workspace', 'source-edit', 'source-delete', 'source-forget', 'source-private', 'question-delete', 'question-meta']) {
  test(`E2 Agenda: derived closure loses ${mutation} authority without resetting or redelivering`, async (t) => {
    const f = fixture(t); await f.agenda.tick(); const answer = f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
    const sent = f.current(); const ledger = f.agenda.store.ledger('2026-11-05');
    if (mutation === 'answer-edit') f.app.store.updateMessageContent(answer.id, 'Please help with this build');
    if (mutation === 'answer-delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(answer.id);
    if (mutation === 'answer-forget') f.app.store.updateMessageMeta(answer.id, { forgotten: true });
    if (mutation === 'answer-private' || mutation === 'source-private') f.app.store.updateConversation(f.c.id, { private: true });
    if (mutation === 'answer-workspace') { const other = f.app.store.createConversation({ workspace: 'elsewhere' }); f.app.store.db.prepare('UPDATE messages SET conversation_id=? WHERE id=?').run(other.id, answer.id); }
    if (mutation === 'source-edit') f.app.store.updateMessageContent(f.source.id, 'My exam is November 5');
    if (mutation === 'source-delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(f.source.id);
    if (mutation === 'source-forget') f.app.store.updateMessageMeta(f.source.id, { forgotten: true });
    if (mutation === 'question-delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(sent.messageId);
    if (mutation === 'question-meta') f.app.store.updateMessageMeta(sent.messageId!, { agenda: { itemId: 999 } });
    await f.agenda.tick(); const current = f.current(); assert.equal(current.status, 'sent'); assert.equal(current.answerMessageId, null); assert.equal(current.answerMatchKind, null);
    assert.equal(current.messageId, sent.messageId); assert.equal(current.sentConversation, sent.sentConversation); assert.equal(current.sentDialogueEpoch, sent.sentDialogueEpoch); assert.equal(current.dueAt, sent.dueAt); assert.equal(current.moved, sent.moved);
    assert.deepEqual(f.agenda.store.ledger('2026-11-05'), ledger); assert.equal(f.calls.count, 1);
  });
}

test('E2 Agenda: legacy done remains done; legacy sent without epoch accepts only explicit topic', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.agenda.store.patchItem(f.item.id, { sentDialogueEpoch: null });
  f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
  f.owner('My interview at Acme went well'); await f.agenda.tick(); assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMatchKind, 'topic');
  f.agenda.store.patchItem(f.item.id, { answerMessageId: null, answerMatchKind: null }); f.app.store.updateMessageContent(f.source.id, 'No interview'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
  assert.equal(new AgendaStore(f.app.store.db).item(f.item.id)!.status, 'done');
});

test('E2 Agenda: moving an explicit topic answer out of its sent conversation revokes completion', async (t) => {
  const f = fixture(t); await f.agenda.tick(); const answer = f.owner('My interview at Acme went well'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
  const other = f.app.store.createConversation(); f.app.store.db.prepare('UPDATE messages SET conversation_id=? WHERE id=?').run(other.id, answer.id);
  await f.agenda.tick(); assert.equal(f.current().status, 'sent'); assert.equal(f.current().answerMessageId, null);
});

for (const outcome of ['My interview at Acme was cancelled', 'I do not want to discuss my interview at Acme']) {
  test(`E2 Agenda: early source outcome suppresses question: ${outcome}`, async (t) => {
    const f = fixture(t); f.clock.now = new Date('2026-11-03T18:00:00Z'); f.owner(outcome); f.clock.now = new Date('2026-11-05T18:00:00Z');
    assert.equal((await f.agenda.tick()).sent, undefined); assert.equal(f.calls.count, 0); assert.equal(f.current().messageId, null);
  });
}

test('E2 Agenda: reported outcome before local event day is premature across DST', async (t) => {
  const f = fixture(t, 'My interview at Acme is November 6', '2026-11-06T18:00:00Z');
  f.clock.now = new Date('2026-11-06T05:30:00Z'); f.owner('My interview at Acme went well'); f.clock.now = new Date('2026-11-06T18:00:00Z');
  assert.equal((await f.agenda.tick()).sent, 1, '05:30Z remains the previous day in Chicago after DST ends');
  await f.agenda.tick(); assert.equal(f.current().status, 'sent');
  f.owner('My interview at Acme did not go well'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
});

test('E2 Agenda: moving the question window never moves the actual event day', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { dueAt: '2026-11-06T18:00:00Z', moved: true });
  f.owner('My interview at Acme went well'); f.clock.now = new Date('2026-11-06T18:00:00Z');
  assert.equal((await f.agenda.tick()).sent, undefined, 'November 5 outcome still answers November 5 event after its window moves'); assert.equal(f.calls.count, 0);
});

test('E2 Agenda: unknown event day never infers completion from a prior unsent report', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { status: 'cancelled' });
  f.clock.now = new Date('2026-11-01T12:00:00Z');
  const unknown = f.agenda.store.addItem({ kind: 'follow-up', what: 'Ask how the interview went', why: 'You asked her to', createdBy: 'owner', dueAt: f.item.dueAt });
  f.clock.now = new Date('2026-11-05T12:00:00Z'); f.owner('My interview went well'); f.clock.now = new Date('2026-11-05T18:00:00Z');
  assert.equal((await f.agenda.tick()).sent, 1); await f.agenda.tick(); assert.equal(f.agenda.store.item(unknown.id)!.status, 'sent');
  f.owner('My interview went badly'); await f.agenda.tick(); assert.equal(f.agenda.store.item(unknown.id)!.status, 'done');
});

test('E2 Agenda: actual planned event date survives rescheduling and clears when owner changes meaning', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { status: 'cancelled' });
  f.clock.now = new Date('2026-11-02T12:00:00Z'); const source = f.owner('My exam is November 6.');
  const planned = f.agenda.planFromMessage(f.app.store.getConversation(f.c.id)!, source).items[0]; assert.ok(planned); assert.equal(planned.eventDate, '2026-11-06');
  assert.equal(f.agenda.editItem(planned.id, { dueAt: new Date('2026-11-07T18:00:00Z') })!.eventDate, '2026-11-06');
  assert.equal(f.agenda.editItem(planned.id, { what: 'Ask about an interview' })!.eventDate, null);
  assert.equal(new AgendaStore(f.app.store.db).item(planned.id)!.eventDate, null);
});

test('E2 Agenda: actual missed window preserves the known event day before the moved question', async (t) => {
  const f = fixture(t); f.agenda.store.patchItem(f.item.id, { status: 'cancelled' });
  f.clock.now = new Date('2026-11-02T12:00:00Z'); const source = f.owner('My interview is Friday.');
  const planned = f.agenda.planFromMessage(f.app.store.getConversation(f.c.id)!, source).items[0]; f.agenda.store.setState('cursor', String(source.id));
  assert.equal(planned.eventDate, '2026-11-06'); f.clock.now = new Date('2026-11-07T18:00:00Z'); assert.equal((await f.agenda.tick()).moved, 1);
  const moved = f.agenda.store.item(planned.id)!; assert.equal(moved.eventDate, '2026-11-06'); assert.equal(moved.moved, true);
  f.clock.now = new Date('2026-11-06T22:00:00Z'); f.owner('My interview went well'); f.clock.now = new Date(moved.dueAt);
  assert.equal((await f.agenda.tick()).sent, undefined); assert.equal(f.calls.count, 0);
});

test('E2 Agenda: edited legacy unknown-day plan conservatively ignores prequestion reports', async (t) => {
  const f = fixture(t); f.agenda.editItem(f.item.id, { dueAt: new Date('2026-11-06T18:00:00Z') }); assert.equal(f.current().eventDate, null);
  f.owner('My interview at Acme went well'); f.clock.now = new Date('2026-11-06T18:00:00Z'); assert.equal((await f.agenda.tick()).sent, 1);
  await f.agenda.tick(); assert.equal(f.current().status, 'sent'); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
});

test('E2 Agenda: unknown owner provenance cannot close a follow-up', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.app.store.addMessage(f.c.id, 'user', 'My interview at Acme went well', { ownerOrigin: 'direct-v1' });
  await f.agenda.tick(); assert.equal(f.current().status, 'sent');
});

test('E2 Agenda: competing same-category prompts deny pronoun shortcut', async (t) => {
  const f = fixture(t); await f.agenda.tick(); const other = f.agenda.store.addItem({ kind: 'follow-up', what: 'Ask about your interview at Globex', why: 'You asked her to', dueAt: '2026-11-06T18:00:00Z', createdBy: 'owner' });
  f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'sent'); assert.equal(f.agenda.store.item(other.id)!.status, 'planned');
});

test('E2 Agenda: one question mark with two supported targets is not a single pronoun target', async (t) => {
  const f = fixture(t); f.app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() { yield { type: 'text', text: 'How did your interview and exam go?' }; } });
  await f.agenda.tick(); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
});

test('E2 Agenda: an explicit topic answer still closes a coordinated question without a pronoun shortcut', async (t) => {
  const f = fixture(t);
  f.app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() { yield { type: 'text', text: 'How did your interview and exam go?' }; } });
  await f.agenda.tick(); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
  const answer = f.owner('My interview at Acme went well'); await f.agenda.tick();
  assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, answer.id); assert.equal(f.current().answerMatchKind, 'topic');
});

for (const question of [
  'How was lunch after your interview at Acme?',
  'How did your drive home from the interview go?',
  'How was your interview preparation?',
  'How did your interview question on the exam go?',
  'How did your interview at Globex go?',
  'I remember your interview at Acme. How was lunch?',
  'Speaking of your interview, how was lunch?',
  'I remember your interview and how was lunch?',
  'The note says “How did your interview go”?',
  'I remember your interview. “How was lunch”?',
  'I remember your interview. `How was lunch`?',
]) {
  test(`E2 Agenda: only the actual unambiguous question authenticates a pronoun: ${question}`, async (t) => {
    const f = fixture(t);
    f.app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() { f.calls.count++; yield { type: 'text', text: question }; } });
    assert.equal((await f.agenda.tick()).sent, 1);
    f.owner('It went great'); await f.agenda.tick();
    assert.equal(f.current().status, 'sent'); assert.equal(f.current().answerMessageId, null); assert.equal(f.current().answerMatchKind, null); assert.equal(f.calls.count, 1);
  });
}

for (const question of [
  'How did the interview go?',
  'Hey, how did your interview go?',
  'Hey, how did your interview at Acme go?',
  'I remember your interview at Acme. How did the interview go?',
  'I remember your exam. How did your interview at Acme go?',
  '¿Cómo fue tu entrevista?',
  "Comment s’est passé ton entretien ?",
  'Wie lief dein Vorstellungsgespräch?',
  'Como foi tua entrevista?',
  'Come è andato il tuo colloquio?',
]) {
  test(`E2 Agenda: a genuine final interview question retains direct and topic answers: ${question}`, async (t) => {
    const f = fixture(t);
    f.app.providerFactory = (config) => ({ config, async listModels() { return ['m']; }, async *stream() { f.calls.count++; yield { type: 'text', text: question }; } });
    await f.agenda.tick(); const direct = f.owner('It went great'); await f.agenda.tick();
    assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, direct.id); assert.equal(f.current().answerMatchKind, 'direct');
    f.app.store.updateMessageContent(direct.id, 'Please help with the build'); await f.agenda.tick(); assert.equal(f.current().status, 'sent');
    const topic = f.owner('My interview at Acme went badly'); await f.agenda.tick();
    assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, topic.id); assert.equal(f.current().answerMatchKind, 'topic'); assert.equal(f.calls.count, 1);
  });
}

for (const invalid of ['source-edit', 'source-forget', 'cancelled', 'reported']) {
  for (const laterValid of [false, true]) {
    test(`E2 Agenda: ${invalid} earliest due plan ${laterValid ? 'does not block a later owner plan' : 'makes no provider or ledger writes'}`, async (t) => {
      const f = fixture(t);
      if (invalid === 'source-edit') f.app.store.updateMessageContent(f.source.id, 'I no longer have that plan.');
      if (invalid === 'source-forget') f.app.store.updateMessageMeta(f.source.id, { forgotten: true });
      f.clock.now = new Date('2026-11-05T12:00:00Z');
      if (invalid === 'cancelled') f.owner('My interview at Acme was cancelled');
      if (invalid === 'reported') f.owner('My interview at Acme went well');
      f.clock.now = new Date('2026-11-05T15:00:00Z');
      const valid = laterValid ? f.agenda.addItemByOwner({ what: 'Ask how my exam went', dueAt: new Date('2026-11-05T17:00:00Z') }) : undefined;
      f.agenda.store.patchItem(f.item.id, { dueAt: '2026-11-05T16:00:00Z' });
      f.clock.now = new Date('2026-11-05T18:00:00Z');
      const item = f.current(); const ledger = f.agenda.store.ledger('2026-11-05'); const messages = f.app.store.messages(f.c.id).length;
      const result = await f.agenda.tick();
      assert.deepEqual(f.current(), item, 'item-specific suppression preserves the invalid plan and its delivery witnesses');
      assert.equal(f.calls.count, laterValid ? 1 : 0);
      if (!valid) {
        assert.equal(result.sent, undefined); assert.deepEqual(f.agenda.store.ledger('2026-11-05'), ledger); assert.equal(f.app.store.messages(f.c.id).length, messages);
      } else {
        assert.equal(result.sent, 1); assert.equal(result.itemId, valid.id); assert.equal(f.agenda.store.item(valid.id)!.status, 'sent'); assert.equal(f.agenda.store.ledger('2026-11-05').reachedOut, ledger.reachedOut + 1);
        const prompt = String(f.app.requests[0].messages.at(-1)!.content);
        assert.match(prompt, /Ask how my exam went/); assert.doesNotMatch(prompt, /interview|Acme|You said this/);
        if (invalid === 'source-edit' || invalid === 'source-forget') assert.ok(!JSON.stringify(f.app.requests[0]).includes(f.source.content), 'revoked source text is absent from the actual request');
        assert.equal((await f.agenda.tick()).sent, undefined); assert.equal(f.calls.count, 1, 'shared cap and unanswered gates still prevent a second call');
      }
    });
  }
}

test('E2 Agenda: malformed sent-question metadata fails closed without crashing the tick', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
  f.app.store.db.prepare('UPDATE messages SET meta=? WHERE id=?').run('{broken', f.current().messageId);
  await f.agenda.tick(); assert.equal(f.current().status, 'sent'); assert.equal(f.current().answerMessageId, null);
});

test('E2 Agenda: no-op metadata and notice/tool rows preserve immediate answer compatibility', async (t) => {
  const f = fixture(t); await f.agenda.tick(); const q = f.current().messageId!;
  f.app.store.updateMessageContent(q, f.app.store.messageById(q)!.content); f.app.store.updateMessageMeta(q, {});
  const notice = f.app.store.addMessage(f.c.id, 'notice', 'Information'); f.app.store.updateMessageContent(notice.id, 'Updated information');
  f.app.store.addMessage(f.c.id, 'tool', 'Tool data'); f.owner('It went great'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
});

test('E2 Agenda: reopening the DB preserves closure provenance and revalidates the source chain', async (t) => {
  const f = fixture(t); await f.agenda.tick(); const answer = f.owner('It went great'); await f.agenda.tick();
  const reopened = makeApp(f.app.dataDir, f.clock); t.after(() => reopened.store.close());
  const agenda = new Agenda(reopened, reopened.store.db); reopened.agenda = agenda;
  const before = agenda.store.item(f.item.id)!; assert.equal(before.answerMessageId, answer.id); assert.equal(before.answerMatchKind, 'direct');
  assert.equal(before.sentDialogueEpoch, f.current().sentDialogueEpoch); await agenda.tick(); assert.equal(agenda.store.item(f.item.id)!.status, 'done');
  reopened.store.updateMessageContent(answer.id, 'What time is it?'); await agenda.tick(); assert.equal(agenda.store.item(f.item.id)!.status, 'sent');
  assert.equal(agenda.store.item(f.item.id)!.messageId, before.messageId); assert.equal(agenda.store.ledger('2026-11-05').reachedOut, 1);
});

test('E2 Agenda: imported dialogue cannot revive plans or become new answer evidence', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.owner('My interview at Acme went well'); await f.agenda.tick();
  const tmp = tempDir(); const app = makeApp(tmp.dir, f.clock); t.after(() => { app.store.close(); tmp.cleanup(); });
  importAll(app, JSON.parse(JSON.stringify(exportAll(f.app)))); const agenda = new Agenda(app, app.store.db); app.agenda = agenda;
  assert.equal(agenda.store.items().length, 0); agenda.update({ enabled: true });
  await agenda.tick(); assert.equal(agenda.store.items().length, 0, 'import loses trusted owner origin and carries no Agenda table');
});

test('E2 Agenda: newest eligible answers are selected after forbidden rows, not before', async (t) => {
  const f = fixture(t); await f.agenda.tick(); const answer = f.owner('My interview at Acme went well');
  const privateChat = f.app.store.createConversation({ private: true }); const otherWorkspace = f.app.store.createConversation({ workspace: 'elsewhere' });
  for (let i = 0; i < 220; i++) { f.owner('Unrelated private data', i % 2 ? privateChat.id : otherWorkspace.id); }
  await f.agenda.tick(); assert.equal(f.current().status, 'done'); assert.equal(f.current().answerMessageId, answer.id);
});

test('E2 Agenda: competing events stay ambiguous and distinguishing explicit outcomes select one', async (t) => {
  const f = fixture(t); f.clock.now = new Date('2026-11-01T12:00:00Z'); const otherSource = f.owner('My interview at Globex is November 5'); f.clock.now = new Date('2026-11-05T18:00:00Z');
  const other = f.agenda.store.addItem({ kind: 'follow-up', what: 'Ask how your interview at Globex went', why: 'You said this', quote: otherSource.content, sourceConversation: f.c.id, sourceMessage: otherSource.id, dueAt: f.item.dueAt, createdBy: 'her' });
  f.agenda.store.setState('cursor', String(otherSource.id)); await f.agenda.tick();
  f.owner('My interview went well'); await f.agenda.tick(); assert.equal(f.current().status, 'sent'); assert.equal(f.agenda.store.item(other.id)!.status, 'planned');
  f.owner('My interview at Acme went badly'); await f.agenda.tick(); assert.equal(f.current().status, 'done'); assert.equal(f.agenda.store.item(other.id)!.status, 'planned');
});

for (const timing of ['before', 'during']) for (const mutation of ['privacy', 'source', 'followUps', 'off']) {
  test(`E2 Agenda: ${mutation} revoked ${timing} await suppresses delivery while retaining usage`, async (t) => {
    const f = fixture(t); const revoke = () => {
      if (mutation === 'privacy') f.app.store.updateConversation(f.c.id, { private: true });
      if (mutation === 'source') f.app.store.updateMessageContent(f.source.id, 'My exam is November 5');
      if (mutation === 'followUps') f.agenda.update({ followUps: false });
      if (mutation === 'off') f.agenda.update({ enabled: false });
    };
    if (timing === 'before') revoke(); else f.during(revoke);
    const before = f.app.store.messages(f.c.id).length; const result = await f.agenda.tick();
    assert.equal(result.sent, undefined); assert.equal(f.app.store.messages(f.c.id).length, before); assert.equal(f.current().messageId, null); assert.equal(f.agenda.store.ledger('2026-11-05').reachedOut, 0);
    assert.equal(f.calls.count, timing === 'before' ? 0 : 1); const usage = f.app.usage!.exportRows(); assert.equal(usage.length, f.calls.count);
    if (usage.length) { assert.equal(usage[0].input, 31); assert.equal(usage[0].output, 7); assert.equal(usage[0].purpose, 'agenda'); }
  });
}

test('E2 Agenda: manual cancellation or edits clear derived answer authority', async (t) => {
  const f = fixture(t); await f.agenda.tick(); f.owner('It went great'); await f.agenda.tick();
  const changed = f.agenda.editItem(f.item.id, { what: 'Interview reviewed' }); assert.ok(changed); assert.equal(changed.status, 'done'); assert.equal(changed.answerMessageId, null);
  f.app.store.updateMessageContent(f.source.id, 'My exam is November 5'); await f.agenda.tick(); assert.equal(f.current().status, 'done');
  assert.equal(f.agenda.editItem(f.item.id, { cancel: true })!.status, 'cancelled'); await f.agenda.tick(); assert.equal(f.current().status, 'cancelled');
});

