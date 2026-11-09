// V4b (docs/ops/V4_DESIGN.md → Memory map): the graph builder (caps, links, fading, cached layout)
// and GET /api/memories/map for the owner, a household member in their own space, and the demo.
// The cross-person check (no one ever sees another's notes) is in test/household-isolation.test.ts.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { buildMemoryMap, isFading, MAP_CAP, MAP_LINK_CAP, mapLinks } from '../src/memory-map.ts';
import { DEFAULT_DECAY } from '../src/memory-rank.ts';
import type { Memory } from '../src/memory.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const note = (id: number, content: string, extra: Partial<Memory> = {}): Memory => ({ id, kind: 'fact', origin: null, content, conversationId: null, sourceMessageId: null, sourceFromId: null, happenedOn: '2026-11-01', evidence: null, edited: false, onDate: null, supersededBy: null, mentionedOn: null, resolvedAt: null, sourceDocId: null, pinned: false, lastUsedOn: null, useCount: 0, archived: false, space: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra });

test('memory map: caps nodes and links, links from words, chats, replacements and contradictions', () => {
  const topics = ['garden tomatoes basil', 'piano lessons tuesday', 'marathon training knees', 'bakery sourdough starter', 'sister wedding venue'];
  const all = Array.from({ length: 230 }, (_, i) => note(i + 1, `Frank ${topics[i % 5]} note ${i}`, { conversationId: `c${i % 11}`, useCount: i % 7, pinned: i === 229 }));
  const map = buildMemoryMap(all, { policy: DEFAULT_DECAY, today: '2026-11-08' });
  assert.equal(map.nodes.length, MAP_CAP);
  assert.equal(map.total, 230);
  assert.equal(map.capped, true);
  assert.ok(map.links.length <= MAP_LINK_CAP);
  assert.ok(map.nodes.some((n) => n.id === 230 && n.pinned), 'pinned notes are always on the map');
  const per = new Map<number, number>();
  for (const l of map.links) for (const id of [l.a, l.b]) per.set(id, (per.get(id) ?? 0) + 1);
  assert.ok(Math.max(...per.values()) <= 6, 'at most six links per note');
  const ids = new Set(map.nodes.map((n) => n.id));
  assert.ok(map.links.every((l) => ids.has(l.a) && ids.has(l.b)), 'links only between notes on the map');
  for (const n of map.nodes) assert.ok(n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1 && n.text.length <= 160);

  const few = [note(1, 'Frank grows tomatoes and basil in the garden'), note(2, 'The garden tomatoes need water daily', { conversationId: 'x' }), note(3, 'Frank likes jazz', { conversationId: 'x' }), note(4, 'Prefers coffee black', { supersededBy: 5 }), note(5, 'Prefers coffee with milk now'), note(6, 'Meeting is Monday')];
  const links = mapLinks(few, [[6, 3]]);
  const why = (a: number, b: number) => links.find((l) => l.a === Math.min(a, b) && l.b === Math.max(a, b))?.why;
  assert.equal(why(1, 2), 'words');
  assert.equal(why(2, 3), 'chat');
  assert.equal(why(4, 5), 'replaced');
  assert.equal(why(3, 6), 'contradicts');
  assert.equal(why(1, 6), undefined);
});

test('memory map: fading notes (archived, replaced, kept promises, below the decay standing); never pinned', () => {
  const policy = { ...DEFAULT_DECAY, halfLifeDays: 30 };
  const today = '2026-11-08';
  assert.equal(isFading(note(1, 'old', { happenedOn: '2025-01-01' }), policy, today), true);
  assert.equal(isFading(note(2, 'new', { happenedOn: '2026-11-07' }), policy, today), false);
  assert.equal(isFading(note(3, 'old but pinned', { happenedOn: '2025-01-01', pinned: true }), policy, today), false);
  assert.equal(isFading(note(4, 'archived by the tidy', { archived: true }), DEFAULT_DECAY, today), true);
  assert.equal(isFading(note(5, 'replaced', { supersededBy: 9 }), DEFAULT_DECAY, today), true);
  assert.equal(isFading(note(6, 'kept', { kind: 'promise', resolvedAt: '2026-11-01' }), DEFAULT_DECAY, today), true);
  assert.equal(isFading(note(7, 'nothing fades'), DEFAULT_DECAY, today), false);
});

test('memory map: the layout is deterministic and cached per store until a note changes', () => {
  const all = [note(1, 'Frank grows tomatoes in the garden'), note(2, 'The garden tomatoes need water'), note(3, 'Piano on Tuesday')];
  const store = {};
  const a = buildMemoryMap(all, { policy: DEFAULT_DECAY, today: '2026-11-08' }, store);
  assert.equal(buildMemoryMap(all, { policy: DEFAULT_DECAY, today: '2026-11-08' }, store), a, 'same object from the cache');
  const b = buildMemoryMap(all, { policy: DEFAULT_DECAY, today: '2026-11-08' });
  assert.deepEqual(b.nodes.map((n) => [n.x, n.y]), a.nodes.map((n) => [n.x, n.y]), 'same places without the cache');
  const changed = buildMemoryMap([...all.slice(0, 2), { ...all[2], updatedAt: '2026-11-08T00:00:00Z', content: 'Piano on Wednesday' }], { policy: DEFAULT_DECAY, today: '2026-11-08' }, store);
  assert.notEqual(changed, a, 'an edit rebuilds');
  assert.equal(changed.nodes.find((n) => n.id === 3)!.text, 'Piano on Wednesday');
});

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Frank', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  for (const c of [`${mode} likes the garden tomatoes`, `${mode} waters the garden tomatoes daily`, `${mode} plays piano`]) app.memory!.add({ kind: 'fact', content: c, conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Ana', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  return async (path: string, authed = true) => {
    const res = await fetch(base + path, { headers: { Origin: base, ...(authed ? { authorization: `Bearer ${auth.newToken}` } : {}) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { nodes: { text: string }[]; links: { why: string }[]; total: number } };
  };
}

for (const mode of ['owner', 'member', 'demo'] as const) {
  test(`memory map route (${mode}): this space's own notes and links, like the Memory page`, async (t) => {
    const get = await rig(t, mode);
    const r = await get('/api/memories/map');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 3);
    assert.ok(r.body.nodes.every((n) => n.text.startsWith(`${mode} `)), 'only this space\'s notes');
    assert.ok(r.body.links.some((l) => l.why === 'words'));
    if (mode !== 'demo') assert.equal((await get('/api/memories/map', false)).status, 401, 'signed in only');
  });
}
