import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { privateLocalOn, setPrivateLocal } from '../src/net-guard.ts';
import { makeApp, tempDir } from './helpers.ts';

async function adapter() {
  const module = await import('../src/owner-cues.ts').catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return { ownerCueNote: undefined };
  });
  assert.equal(typeof module.ownerCueNote, 'function', 'fresh qualified owner cue adapter exists');
  return module.ownerCueNote!;
}

function fixture() {
  const temp = tempDir(); const clock = { now: new Date('2026-11-05T15:00:00Z') };
  const app = makeApp(temp.dir, clock); app.persona = { ...app.persona, name: 'Nova' };
  const c = app.store.createConversation();
  const add = (text = "I'm exhausted", id = c.id, meta?: Record<string, unknown>) => {
    const m = app.store.addMessage(id, 'user', text, meta); app.store.markDirectOwnerMessage(m.id); return m;
  };
  return { app, c, clock, temp, add, close() { app.store.close(); temp.cleanup(); } };
}

test('E2 cues: uses current conversation and companion, with no writes or provider calls', async () => {
  const note = await adapter(); const f = fixture();
  try {
    const m = f.add('Nova is useless');
    const before = f.app.store.db.prepare('SELECT total_changes() n').get();
    f.app.providerFactory = () => { throw new Error('cue adapter cannot invoke provider'); };
    const result = note(f.app, f.c.id, {});
    assert.match(result!, /^\[Owner cues v1\]/); assert.match(result!, /directed-hostility/);
    assert.match(result!, new RegExp(`"messageId":${m.id}`));
    assert.deepEqual(f.app.store.db.prepare('SELECT total_changes() n').get(), before);
    assert.equal(f.app.providerCalls, 0); assert.equal(f.app.requests.length, 0);
  } finally { f.close(); }
});

test('E2 cues: supplied forbidden context denies before any conversation or source read', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add();
    for (const turn of [{ externalApp: false }, { outside: null }, { clientHistory: [] }, { clientNote: '' }, { group: null }, { untrusted: false }, { roomNote: '' }, { roomNow: '' }, { roomId: 0 }, { roomCrisis: false }, { replay: null }, { recorder: null }, { resume: false }, { resume: true }, { voiceRoom: false }, { persist: false }]) {
      const original = f.app.store.getConversation;
      let reads = 0;
      f.app.store.getConversation = (...args) => { reads++; return original.apply(f.app.store, args); };
      try {
        assert.equal(note(f.app, f.c.id, turn as never), undefined, JSON.stringify(turn));
        assert.equal(reads, 0, 'forbidden runtime context is checked before source reads');
      }
      finally { f.app.store.getConversation = original; }
    }
  } finally { f.close(); }
});

test('E2 cues: opt-out and app role are rechecked before source reads', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add(); assert.ok(note(f.app, f.c.id, {}));
    for (const role of ['member', 'demo', 'offRecord'] as const) {
      f.app[role] = true as never;
      const original = f.app.store.getConversation;
      f.app.store.getConversation = () => { throw new Error('role gate source read'); };
      try { assert.equal(note(f.app, f.c.id, {}), undefined, role); }
      finally { f.app.store.getConversation = original; delete f.app[role]; }
    }
    f.app.settings.update({ persona: { innerLife: false } });
    const original = f.app.store.getConversation;
    f.app.store.getConversation = () => { throw new Error('disabled source read'); };
    try { assert.equal(note(f.app, f.c.id, {}), undefined); }
    finally { f.app.store.getConversation = original; }
    f.app.settings.update({ persona: { innerLife: true } }); assert.ok(note(f.app, f.c.id, {}));
  } finally { f.close(); }
});

test('E2 cues: edit, forget and deletion invalidate the next read without cached notes', async () => {
  const note = await adapter(); const f = fixture();
  try {
    const m = f.add(); assert.match(note(f.app, f.c.id, {})!, /exhausted/);
    f.app.store.updateMessageContent(m.id, 'hello'); assert.equal(note(f.app, f.c.id, {}), undefined);
    f.app.store.updateMessageContent(m.id, "I'm exhausted"); assert.ok(note(f.app, f.c.id, {}));
    f.app.store.updateMessageMeta(m.id, { forgotten: false }); assert.equal(note(f.app, f.c.id, {}), undefined);
    const newer = f.add(); assert.ok(note(f.app, f.c.id, {}));
    f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(newer.id);
    assert.equal(note(f.app, f.c.id, {}), undefined);
  } finally { f.close(); }
});

test('E2 cues: current private/archive/workspace/room flags deny source reuse', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add(); assert.ok(note(f.app, f.c.id, {}));
    f.app.store.updateConversation(f.c.id, { private: true }); assert.equal(note(f.app, f.c.id, {}), undefined);
    f.app.store.updateConversation(f.c.id, { private: false, archived: true }); assert.equal(note(f.app, f.c.id, {}), undefined);
    f.app.store.updateConversation(f.c.id, { archived: false }); assert.ok(note(f.app, f.c.id, {}));
    const other = f.app.store.createConversation({ workspace: 'other' }); f.add('I am tired', other.id);
    f.app.store.db.prepare('UPDATE messages SET conversation_id=? WHERE conversation_id=?').run(other.id, f.c.id);
    assert.equal(note(f.app, f.c.id, {}), undefined);
    f.app.store.db.exec('CREATE TABLE rooms (bridge TEXT, key TEXT, kind TEXT)');
    const bridge = f.app.store.createConversation({ channel: 'discord', channelKey: '42' }); f.add('I am tired', bridge.id);
    assert.ok(note(f.app, bridge.id, {}));
    f.app.store.db.prepare('INSERT INTO rooms VALUES (?,?,?)').run('discord', '42', 'room');
    assert.equal(note(f.app, bridge.id, {}), undefined);
  } finally { f.close(); }
});

test('E2 cues: current six eligible rows cannot be starved by other chats or denied sources', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add(); const other = f.app.store.createConversation();
    for (let i = 0; i < 205; i++) { f.add('hello', other.id); f.add('hello', f.c.id, { importedFrom: 'fixture' }); }
    assert.match(note(f.app, f.c.id, {})!, /fatigue/);
    f.app.store.addMessage(f.c.id, 'user', "I'm rested now");
    assert.match(note(f.app, f.c.id, {})!, /fatigue/, 'unknown origin cannot clear owner evidence');
    for (let i = 0; i < 6; i++) f.add('hello');
    assert.equal(note(f.app, f.c.id, {}), undefined, 'latest six eligible messages bound the window');
  } finally { f.close(); }
});

test('E2 cues: corrections win and invalid/future timestamps cannot manufacture evidence', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add(); f.add("I'm rested now"); assert.equal(note(f.app, f.c.id, {}), undefined);
    const bad = f.add(); const future = f.add();
    f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('invalid', bad.id);
    f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-11-05T15:01:00Z', future.id);
    assert.equal(note(f.app, f.c.id, {}), undefined);
  } finally { f.close(); }
});

test('E2 cues: reopen reconstructs current source only until its original exact expiry', async () => {
  const note = await adapter(); const f = fixture();
  try {
    f.add(); assert.ok(note(f.app, f.c.id, {}));
    f.app.store.close(); f.app.store = new Store(join(f.temp.dir, 'sara.db'), () => f.clock.now);
    f.clock.now = new Date('2026-11-05T15:29:59.999Z'); assert.ok(note(f.app, f.c.id, {}));
    f.add('hello'); f.clock.now = new Date('2026-11-05T15:30:00Z');
    assert.equal(note(f.app, f.c.id, {}), undefined, 'unrelated messages never renew original expiry');
  } finally { f.close(); }
});

test('E2 cues: global private-local permits ordinary qualified source while conversation-private does not', async () => {
  const note = await adapter(); const f = fixture();
  const prior = privateLocalOn();
  try {
    f.add(); setPrivateLocal(true); assert.equal(privateLocalOn(), true);
    assert.ok(note(f.app, f.c.id, {}));
    f.app.store.updateConversation(f.c.id, { private: true }); assert.equal(note(f.app, f.c.id, {}), undefined);
  } finally { setPrivateLocal(prior); f.close(); }
});
