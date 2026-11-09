import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const handoffs = await import('../src/session-handoffs.ts').catch(() => undefined);
function fixture() {
  const temp = tempDir(); const now = new Date('2026-11-05T12:00:00Z');
  const store = new Store(join(temp.dir, 'sara.db'), () => now);
  const a = store.createConversation(); const b = store.createConversation();
  const m = store.addMessage(a.id, 'user', 'Synthetic context');
  return { ...temp, store, now, a, b, input: { sourceConversationId: a.id, targetConversationId: b.id, sourceWorkspace: a.workspace, targetWorkspace: b.workspace, sourceDialogueEpoch: 0, sourceThroughMessageId: m.id, text: 'Context only' }, close() { store.close(); temp.cleanup(); } };
}
test('Store setup installs handoff schema; primitives persist without creating schema on reads', () => {
  assert.ok(handoffs?.SessionHandoffStore, 'pure handoff store is missing');
  const f = fixture();
  try {
    const records = new handoffs.SessionHandoffStore(f.store.db);
    const saved = records.insert(f.input, f.now);
    assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.createdAt), 86400000);
    const changes = f.store.db.prepare('SELECT total_changes() AS n').get();
    assert.equal(records.headers(f.b.id)[0].id, saved.id);
    assert.equal(records.read(saved.id)!.text, 'Context only');
    assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(), changes);
    f.store.close();
    const reopened = new Store(join(f.dir, 'sara.db'), () => f.now);
    try { assert.equal(new handoffs.SessionHandoffStore(reopened.db).read(saved.id)!.text, saved.text); } finally { reopened.close(); }
  } finally { f.cleanup(); }
});
test('source epoch changes and conversation scope moves erase notes without resurrection', () => {
  assert.ok(handoffs?.SessionHandoffStore, 'handoff invalidation is missing');
  const f = fixture();
  try {
    const records = new handoffs.SessionHandoffStore(f.store.db);
    const saved = records.insert(f.input, f.now);
    f.store.addMessage(f.a.id, 'assistant', 'Later dialogue');
    f.store.addMessage(f.a.id, 'notice', 'Audit bookkeeping');
    assert.ok(records.read(saved.id));
    f.store.db.prepare("UPDATE messages SET content='Edited later dialogue' WHERE conversation_id=? AND role='assistant'").run(f.a.id);
    assert.deepEqual(records.headers(f.b.id), []);
    for (const field of ['workspace', 'private', 'channel', 'channel_key', 'partner', 'archived_at', 'ended_at']) {
      const current = f.store.getConversation(f.a.id)!;
      records.insert({ ...f.input, sourceDialogueEpoch: current.dialogueEpoch! }, f.now);
      const old = f.store.db.prepare(`SELECT ${field} AS value FROM conversations WHERE id=?`).get(f.b.id)!.value;
      f.store.db.prepare(`UPDATE conversations SET ${field}=? WHERE id=?`).run(field === 'private' ? 1 : 'changed', f.b.id);
      f.store.db.prepare(`UPDATE conversations SET ${field}=? WHERE id=?`).run(old!, f.b.id);
      assert.deepEqual(records.headers(f.b.id), [], field);
    }
    records.insert({ ...f.input, sourceDialogueEpoch: f.store.getConversation(f.a.id)!.dialogueEpoch! }, f.now);
    f.store.db.prepare('DELETE FROM conversations WHERE id=?').run(f.a.id);
    assert.deepEqual(records.headers(f.b.id), []);
  } finally { f.close(); }
});
test('writes prune expired revisions, newest five per pair and newest one hundred overall', () => {
  assert.ok(handoffs?.SessionHandoffStore, 'handoff retention is missing');
  const f = fixture();
  try {
    const records = new handoffs.SessionHandoffStore(f.store.db);
    for (let i = 0; i < 8; i++) records.insert({ ...f.input, text: String(i) }, f.now);
    assert.equal(records.headers(f.b.id).length, 5);
    for (let i = 0; i < 110; i++) {
      const target = f.store.createConversation();
      records.insert({ ...f.input, targetConversationId: target.id }, f.now);
    }
    assert.equal(records.headers().length, 100);
    const tomorrow = new Date(f.now.getTime() + 86400000);
    records.insert(f.input, tomorrow);
    assert.equal(records.headers().length, 1);
  } finally { f.close(); }
});
test('synchronous mutation rollback preserves all records, source message deletion revokes and target deletion cascades', () => {
  assert.ok(handoffs?.SessionHandoffStore);
  const f = fixture();
  try {
    const records = new handoffs.SessionHandoffStore(f.store.db);
    assert.throws(() => records.transaction(() => { records.insert(f.input, f.now); throw new Error('Rollback fixture'); }), /Rollback fixture/);
    assert.deepEqual(records.headers(), []);
    const saved = records.transaction(() => records.insert(f.input, f.now));
    f.store.markDirectOwnerMessage(f.input.sourceThroughMessageId);
    assert.ok(records.read(saved.id), 'origin audit bookkeeping does not revoke context');
    f.store.db.prepare('DELETE FROM messages WHERE id=?').run(f.input.sourceThroughMessageId);
    assert.deepEqual(records.headers(), []);
    const next = f.store.addMessage(f.a.id, 'user', 'Fresh source');
    records.insert({ ...f.input, sourceThroughMessageId: next.id, sourceDialogueEpoch: f.store.getConversation(f.a.id)!.dialogueEpoch! }, f.now);
    f.store.db.prepare('DELETE FROM conversations WHERE id=?').run(f.b.id);
    assert.deepEqual(records.headers(), []);
  } finally { f.close(); }
});
