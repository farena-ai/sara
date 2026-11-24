// S3: a conversation's rows are kept between reads until anything in the database changes
// (Store.messages). What must hold: a read is never out of date, every caller gets rows of its own
// (a turn changes what it reads), and it works through an object made from the store.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

test('S3 reads: kept until something changes; every write is seen at once', () => {
  const { dir, cleanup } = tempDir();
  const store = new Store(join(dir, 'sara.db'));
  try {
    const a = store.createConversation({ title: 'A' });
    const b = store.createConversation({ title: 'B' });
    assert.deepEqual(store.messages(a.id), []);
    const m1 = store.addMessage(a.id, 'user', 'hello', { n: 1, tags: ['x'] });
    assert.deepEqual(store.messages(a.id).map((m) => m.content), ['hello'], 'a read from before the write is not served again');
    store.addMessage(a.id, 'assistant', 'hi');
    store.addMessage(b.id, 'user', 'other chat');
    assert.equal(store.messages(a.id).length, 2);
    assert.equal(store.messages(b.id).length, 1);
    store.updateMessageMeta(m1.id, { n: 2 });
    assert.equal(store.messages(a.id)[0]!.meta?.n, 2);
    store.updateMessageContent(m1.id, 'hello again');
    assert.equal(store.messages(a.id)[0]!.content, 'hello again');
    store.deleteMessagesFrom(a.id, m1.id + 1);
    assert.equal(store.messages(a.id).length, 1);
    // Many chats read in turn: the oldest kept ones are let go, and still read right.
    const many = Array.from({ length: 12 }, (_, i) => store.createConversation({ title: `C${i}` }));
    many.forEach((c, i) => store.addMessage(c.id, 'user', `m${i}`));
    for (const round of [0, 1]) many.forEach((c, i) => assert.deepEqual(store.messages(c.id).map((m) => m.content), [`m${i}`], `round ${round}`));
    assert.equal(store.messages(a.id).length, 1);
  } finally {
    store.close();
    cleanup();
  }
});

test('S3 reads: a caller may change what it got without changing what the next caller gets', () => {
  const { dir, cleanup } = tempDir();
  const store = new Store(join(dir, 'sara.db'));
  try {
    const c = store.createConversation({ title: 'A' });
    store.addMessage(c.id, 'user', 'hello', { tags: ['x'], nested: { deep: 1 } });
    const first = store.messages(c.id);
    first[0]!.content = 'changed';
    first[0]!.meta!.tags = ['y'];
    (first[0]!.meta!.nested as { deep: number }).deep = 2;
    first.push({ ...first[0]!, id: 999 });
    const second = store.messages(c.id);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.content, 'hello');
    assert.deepEqual(second[0]!.meta, { tags: ['x'], nested: { deep: 1 } });
    assert.notEqual(second[0], store.messages(c.id)[0], 'never the same object twice');
  } finally {
    store.close();
    cleanup();
  }
});

test('S3 reads: through an object made from the store, and after another connection writes', () => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'sara.db');
  const store = new Store(file);
  try {
    const c = store.createConversation({ title: 'A' });
    store.addMessage(c.id, 'user', 'hello');
    // A turn's scoped view of the store (src/chat.ts): private fields of Store are out of its reach.
    const view = Object.create(store) as Store;
    assert.equal(view.messages(c.id).length, 1);
    assert.equal(view.messages(c.id).length, 1);
    // Another connection (another process of hers, a restore) adds a row: the kept rows are let go.
    const other = new DatabaseSync(file);
    other.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', 'from elsewhere', ?)").run(c.id, new Date().toISOString());
    other.close();
    assert.deepEqual(store.messages(c.id).map((m) => m.content), ['hello', 'from elsewhere']);
    assert.equal(view.messages(c.id).length, 2);
  } finally {
    store.close();
    cleanup();
  }
});
