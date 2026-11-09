import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { makeApp, tempDir } from './helpers.ts';

const scenes = await import('../src/shared-scenes.ts').catch(() => undefined);
const NOW = new Date('2026-11-05T12:00:00.000Z');
function fixture() {
  const temp = tempDir();
  const store = new Store(join(temp.dir, 'sara.db'), () => NOW);
  assert.ok(scenes?.SharedSceneStore, 'shared scene store is missing');
  const records = new scenes.SharedSceneStore(store.db, () => NOW);
  const web = store.createConversation({ title: 'Web story' });
  const dm = store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'Discord DM' });
  return { ...temp, store, records, web, dm, close() { store.close(); temp.cleanup(); } };
}
const status = (code: number) => (error: any) => error instanceof scenes!.SceneStoreError && error.status === code;
const seatInput = (c: { id: string; channel: string; channelKey?: string | null }) => ({ conversationId: c.id, audience: 'owner' as const, channel: c.channel, channelKey: c.channelKey ?? null });
const keys = (f: ReturnType<typeof fixture>, id: number) => f.records.canon(id).map((c: any) => c.key).sort();

test('Store setup installs the scene schema; reopening keeps rows; reads create and change nothing', () => {
  const f = fixture();
  try {
    const tables = (db: typeof f.store.db) => (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'scene%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    assert.deepEqual(tables(f.store.db).filter(n => ['scenes', 'scene_seats', 'scene_canon', 'scene_events'].includes(n)).sort(), ['scene_canon', 'scene_events', 'scene_seats', 'scenes']);
    const scene = f.records.create({ title: 'The Ember Road', premise: 'A caravan crosses the dunes.', adult: false });
    f.records.link(scene.id, scene.revision, seatInput(f.web));
    f.records.setCanon(scene.id, scene.revision + 1, { key: 'inn', text: 'The inn burned down.', author: 'owner-ui' });
    const master = f.store.db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    const changes = f.store.db.prepare('SELECT total_changes() AS n').get();
    f.records.list(); f.records.scene(scene.id); f.records.seats(scene.id); f.records.seatOf(f.web.id); f.records.canon(scene.id); f.records.history(scene.id, 'inn'); f.records.events(scene.id, 50);
    new scenes!.SharedSceneStore(f.store.db, () => NOW).list();
    assert.deepEqual(f.store.db.prepare('SELECT total_changes() AS n').get(), changes);
    assert.deepEqual(f.store.db.prepare('SELECT count(*) AS n FROM sqlite_master').get(), master);
    f.store.close();
    const reopened = new Store(join(f.dir, 'sara.db'), () => NOW);
    try {
      const again = new scenes!.SharedSceneStore(reopened.db, () => NOW);
      assert.equal(again.scene(scene.id)!.title, 'The Ember Road');
      assert.equal(again.canon(scene.id)[0].text, 'The inn burned down.');
      assert.equal(again.seatOf(f.web.id)!.sceneId, scene.id);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('every scene limit refuses without truncating', () => {
  const f = fixture();
  try {
    assert.throws(() => f.records.create({ title: ' ' }), status(400));
    assert.throws(() => f.records.create({ title: 'x'.repeat(81) }), status(400));
    assert.throws(() => f.records.create({ title: 'Ok', premise: 'p'.repeat(1501) }), status(400));
    const first = f.records.create({ title: 'x'.repeat(80), premise: 'p'.repeat(1500) });
    assert.equal(first.title.length, 80); assert.equal(first.premise.length, 1500);
    for (let i = 1; i < 20; i++) f.records.create({ title: `Scene ${i}` });
    assert.throws(() => f.records.create({ title: 'Twenty-first' }), status(413));
    assert.equal(f.records.list().length, 20);
    // Seats: at most three owner seats.
    let rev = first.revision;
    const owners = [f.web, f.dm, f.store.createConversation({ channel: 'telegram', channelKey: '4242' })];
    for (const c of owners) rev = f.records.link(first.id, rev, seatInput(c)).scene.revision;
    const fourth = f.store.createConversation({ channel: 'web' });
    assert.throws(() => f.records.link(first.id, rev, seatInput(fourth)), status(413));
    // A conversation sits in one scene only.
    const other = f.records.list().find((s: any) => s.id !== first.id)!;
    assert.throws(() => f.records.link(other.id, other.revision, seatInput(f.web)), status(409));
    // Canon key and text rules.
    for (const key of ['', 'Inn', '-inn', 'inn_2', 'k'.repeat(41), 'inn place']) assert.throws(() => f.records.setCanon(first.id, rev, { key, text: 'Fine.', author: 'owner-ui' }), status(400), key);
    assert.throws(() => f.records.setCanon(first.id, rev, { key: 'inn', text: '   ', author: 'owner-ui' }), status(400));
    assert.throws(() => f.records.setCanon(first.id, rev, { key: 'inn', text: 't'.repeat(401), author: 'owner-ui' }), status(400));
    assert.deepEqual(f.records.canon(first.id), []);
    const long = f.records.setCanon(first.id, rev, { key: 'k'.repeat(40), text: `  ${'t'.repeat(400)}  `, author: 'owner-ui' });
    assert.equal(long.entry.text.length, 400); rev = long.scene.revision;
    for (let i = 1; i < 40; i++) rev = f.records.setCanon(first.id, rev, { key: `fact-${i}`, text: `Fact ${i}.`, author: 'owner-ui' }).scene.revision;
    assert.throws(() => f.records.setCanon(first.id, rev, { key: 'one-too-many', text: 'No room.', author: 'owner-ui' }), status(413));
    // Changing an existing key at the cap is fine; versions keep the newest five.
    for (let v = 2; v <= 8; v++) rev = f.records.setCanon(first.id, rev, { key: 'fact-1', text: `Fact 1 v${v}.`, author: 'owner-ui' }).scene.revision;
    const history = f.records.history(first.id, 'fact-1');
    assert.deepEqual(history.map((h: any) => h.version), [8, 7, 6, 5, 4]);
    assert.equal(f.records.canon(first.id).length, 40);
    // Events keep the newest 200 per scene, pruned on writes.
    for (let i = 0; i < 210; i++) rev = f.records.setCanon(first.id, rev, { key: 'fact-2', text: `Fact 2 #${i}.`, author: 'owner-ui' }).scene.revision;
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM scene_events WHERE scene_id=?').get(first.id) as { n: number }).n, 200);
  } finally { f.close(); }
});

test('stale revisions conflict; identical text is idempotent after the revision check', () => {
  const f = fixture();
  try {
    const scene = f.records.create({ title: 'Duel at dawn' });
    const set = f.records.setCanon(scene.id, scene.revision, { key: 'duel', text: 'The duel is at dawn.', author: 'owner-ui' });
    assert.equal(set.scene.revision, scene.revision + 1);
    assert.throws(() => f.records.setCanon(scene.id, scene.revision, { key: 'duel', text: 'The duel is at dawn.', author: 'owner-ui' }), status(409));
    const same = f.records.setCanon(scene.id, set.scene.revision, { key: 'duel', text: 'The duel is at dawn.', author: 'owner-ui' });
    assert.equal(same.scene.revision, set.scene.revision); assert.equal(same.changed, false);
    assert.equal(f.records.history(scene.id, 'duel').length, 1);
    for (const op of [() => f.records.update(scene.id, 1, { title: 'Stale' }), () => f.records.remove(scene.id, 1), () => f.records.reset(scene.id, 1), () => f.records.retire(scene.id, 1, 'duel'), () => f.records.link(scene.id, 1, seatInput(f.web))]) assert.throws(op, status(409));
    assert.throws(() => f.records.retire(scene.id, same.scene.revision, 'missing'), status(404));
    const retired = f.records.retire(scene.id, same.scene.revision, 'duel');
    assert.deepEqual(f.records.canon(scene.id), []);
    assert.equal(f.records.history(scene.id, 'duel')[0].retired, true);
    const reset = f.records.reset(scene.id, retired.scene.revision);
    assert.deepEqual(f.records.history(scene.id, 'duel'), []);
    assert.equal(reset.scene.title, 'Duel at dawn');
    assert.equal(f.records.scene(999), undefined);
    assert.ok(f.records.events(scene.id, 50).every((e: any) => !('text' in e)));
  } finally { f.close(); }
});

test('editing, deleting or forgetting a source line erases only canon from that line on', () => {
  const f = fixture();
  try {
    const scene = f.records.create({ title: 'Ember Road' });
    let rev = f.records.link(scene.id, scene.revision, seatInput(f.web)).scene.revision;
    const lines = [1, 2, 3, 4].map(i => f.store.addMessage(f.web.id, i % 2 ? 'user' : 'assistant', `Line ${i}`));
    const from = (key: string, m: { id: number }) => { rev = f.records.setCanon(scene.id, rev, { key, text: `From ${key}`, author: 'owner-ui', source: { conversationId: f.web.id, messageId: m.id, epoch: 0 } }).scene.revision; };
    const reseed = () => { for (const [i, m] of lines.entries()) if (!f.records.canon(scene.id).some((c: any) => c.key === `l${i + 1}`)) from(`l${i + 1}`, m); };
    rev = f.records.setCanon(scene.id, rev, { key: 'typed', text: 'Alex typed this.', author: 'owner-ui' }).scene.revision;
    reseed();
    f.store.addMessage(f.web.id, 'user', 'A later message');
    f.store.addMessage(f.web.id, 'notice', 'bookkeeping');
    f.store.updateMessageMeta(lines[1].id, { refs: [] });
    assert.deepEqual(keys(f, scene.id), ['l1', 'l2', 'l3', 'l4', 'typed'], 'new messages and neutral meta keep canon');
    const before = f.records.scene(scene.id)!.revision;
    f.store.db.prepare('UPDATE messages SET content=? WHERE id=?').run('Edited line 3', lines[2].id);
    assert.deepEqual(keys(f, scene.id), ['l1', 'l2', 'typed']);
    assert.ok(f.records.scene(scene.id)!.revision > before, 'revocation bumps the revision');
    assert.ok(f.records.events(scene.id, 50).some((e: any) => e.kind === 'revoked' && e.actor === 'system'));
    rev = f.records.scene(scene.id)!.revision; reseed();
    f.store.updateMessageMeta(lines[3].id, { forgotten: true });
    assert.deepEqual(keys(f, scene.id), ['l1', 'l2', 'l3', 'typed']);
    rev = f.records.scene(scene.id)!.revision;
    f.store.db.prepare('DELETE FROM messages WHERE id=?').run(lines[1].id);
    assert.deepEqual(keys(f, scene.id), ['l1', 'typed']);
  } finally { f.close(); }
});

test('conversation scope changes erase the seat and its derived canon without resurrection; titles keep it', () => {
  const f = fixture();
  try {
    for (const field of ['workspace', 'private', 'channel', 'channel_key', 'partner', 'archived_at', 'ended_at']) {
      const c = f.store.createConversation({ channel: 'discord', channelKey: `dm-${field}` });
      const scene = f.records.create({ title: `Scope ${field}` });
      let rev = f.records.link(scene.id, scene.revision, seatInput(c)).scene.revision;
      const m = f.store.addMessage(c.id, 'user', 'A line');
      rev = f.records.setCanon(scene.id, rev, { key: 'derived', text: 'Derived.', author: 'owner-ui', source: { conversationId: c.id, messageId: m.id, epoch: 0 } }).scene.revision;
      rev = f.records.setCanon(scene.id, rev, { key: 'typed', text: 'Typed.', author: 'owner-ui' }).scene.revision;
      f.store.setTitle(c.id, 'A new title', { source: 'owner' } as never);
      assert.ok(f.records.seatOf(c.id), `${field}: title change keeps the seat`);
      const old = (f.store.db.prepare(`SELECT ${field} AS v FROM conversations WHERE id=?`).get(c.id) as { v: unknown }).v;
      f.store.db.prepare(`UPDATE conversations SET ${field}=? WHERE id=?`).run(field === 'private' ? 1 : 'changed', c.id);
      f.store.db.prepare(`UPDATE conversations SET ${field}=? WHERE id=?`).run(old as never, c.id);
      assert.equal(f.records.seatOf(c.id), undefined, field);
      assert.deepEqual(keys(f, scene.id), ['typed'], field);
      assert.ok(f.records.scene(scene.id)!.revision > rev, field);
      f.records.remove(scene.id, f.records.scene(scene.id)!.revision);
    }
  } finally { f.close(); }
});

test('room identity changes erase matching seats; kind/adult round trip never brings them back; title refresh keeps them', () => {
  const temp = tempDir(); const clock = { now: NOW };
  const app = makeApp(temp.dir, clock);
  try {
    const records = new scenes!.SharedSceneStore(app.store.db, () => clock.now);
    const dm = app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm' });
    noteRoom(app, { bridge: 'discord', key: 'alex-dm', kind: 'dm', title: 'Alex' });
    const scene = records.create({ title: 'Rooms' });
    let rev = records.link(scene.id, scene.revision, seatInput(dm)).scene.revision;
    const m = app.store.addMessage(dm.id, 'user', 'A line');
    rev = records.setCanon(scene.id, rev, { key: 'derived', text: 'Derived.', author: 'owner-ui', source: { conversationId: dm.id, messageId: m.id, epoch: 0 } }).scene.revision;
    clock.now = new Date(NOW.getTime() + 2 * 86400000);
    noteRoom(app, { bridge: 'discord', key: 'alex-dm', kind: 'dm', title: 'Alex renamed' });
    assert.ok(records.seatOf(dm.id), 'title/checked refresh keeps the seat');
    noteRoom(app, { bridge: 'discord', key: 'alex-dm', kind: 'room', title: 'Alex renamed' });
    noteRoom(app, { bridge: 'discord', key: 'alex-dm', kind: 'dm', title: 'Alex renamed' });
    assert.equal(records.seatOf(dm.id), undefined);
    assert.deepEqual(records.canon(scene.id), []);
    rev = records.link(scene.id, records.scene(scene.id)!.revision, seatInput(dm)).scene.revision;
    app.store.db.prepare("UPDATE rooms SET adult=1 WHERE key='alex-dm'").run();
    app.store.db.prepare("UPDATE rooms SET adult=0 WHERE key='alex-dm'").run();
    assert.equal(records.seatOf(dm.id), undefined);
    records.link(scene.id, records.scene(scene.id)!.revision, seatInput(dm));
    app.store.db.prepare("DELETE FROM rooms WHERE key='alex-dm'").run();
    assert.equal(records.seatOf(dm.id), undefined);
  } finally { app.store.close(); temp.cleanup(); }
});

test('scene delete cascades seats, canon and events; conversation delete removes its seat and canon', () => {
  const f = fixture();
  try {
    const scene = f.records.create({ title: 'Cascade' });
    let rev = f.records.link(scene.id, scene.revision, seatInput(f.web)).scene.revision;
    rev = f.records.link(scene.id, rev, seatInput(f.dm)).scene.revision;
    const m = f.store.addMessage(f.dm.id, 'user', 'A line');
    rev = f.records.setCanon(scene.id, rev, { key: 'derived', text: 'Derived.', author: 'owner-ui', source: { conversationId: f.dm.id, messageId: m.id, epoch: 0 } }).scene.revision;
    rev = f.records.setCanon(scene.id, rev, { key: 'typed', text: 'Typed.', author: 'owner-ui' }).scene.revision;
    f.store.db.prepare('DELETE FROM conversations WHERE id=?').run(f.dm.id);
    assert.equal(f.records.seatOf(f.dm.id), undefined);
    assert.deepEqual(keys(f, scene.id), ['typed']);
    assert.ok(f.records.scene(scene.id)!.revision > rev);
    const unlinked = f.records.unlink(scene.id, f.records.scene(scene.id)!.revision, f.web.id);
    assert.equal(unlinked.erasedCanon, 0);
    f.records.remove(scene.id, unlinked.scene.revision);
    for (const table of ['scenes', 'scene_seats', 'scene_canon', 'scene_events']) assert.equal((f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  } finally { f.close(); }
});

test('unlinking a seat erases canon taken from its lines and keeps typed canon', () => {
  const f = fixture();
  try {
    const scene = f.records.create({ title: 'Leave' });
    let rev = f.records.link(scene.id, scene.revision, seatInput(f.dm)).scene.revision;
    const m = f.store.addMessage(f.dm.id, 'user', 'A line');
    rev = f.records.setCanon(scene.id, rev, { key: 'derived', text: 'Derived.', author: 'owner-ui', source: { conversationId: f.dm.id, messageId: m.id, epoch: 0 } }).scene.revision;
    rev = f.records.setCanon(scene.id, rev, { key: 'typed', text: 'Typed.', author: 'owner-ui' }).scene.revision;
    const out = f.records.unlink(scene.id, rev, f.dm.id);
    assert.equal(out.erasedCanon, 1);
    assert.deepEqual(keys(f, scene.id), ['typed']);
    assert.throws(() => f.records.unlink(scene.id, out.scene.revision, f.dm.id), status(404));
  } finally { f.close(); }
});
