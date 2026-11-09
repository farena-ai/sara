// E6a (docs/ops/E6_DESIGN.md): sharing one item of an open feed. The browser sends the item's key
// and hashes only; the server looks the item up in the snapshot it fetched itself.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { openFeed, type Snapshot } from '../src/feed-together.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { ReadTogether, ReadTogetherError, RT, sharedFeedItem, textHash } from '../src/read-together.ts';
import { createSaraServer } from '../src/server.ts';
import { PUBLIC, RSS, stubNet, xml } from './feed-together-fixture.ts';
import { ROOT } from './helpers.ts';
import { readFixture } from './read-together-fixture.ts';

const refused = (f: () => unknown, status: number, reason: string) =>
  assert.throws(f, (err: unknown) => err instanceof ReadTogetherError && err.status === status && err.reason === reason);

async function feedFixture(t: TestContext, body = RSS) {
  const f = readFixture(t);
  stubNet(t, () => xml(body));
  const snap = await openFeed('https://feeds.example.com/rss', { lookup: PUBLIC });
  f.app.readTogether!.setFeed(f.conv.id, snap);
  const item = snap.items[0];
  const pick = (extra: Record<string, unknown> = {}) => ({ source: 'feed', rev: snap.rev.slice(0, 12), key: item.key, textSha: item.textSha, ...extra });
  return { ...f, snap, item, pick };
}
const reload = async (t: TestContext, f: { app: { readTogether?: ReadTogether }; conv: { id: string } }, body: string): Promise<Snapshot> => {
  stubNet(t, () => xml(body));
  const s = await openFeed('https://feeds.example.com/rss', { lookup: PUBLIC });
  f.app.readTogether!.setFeed(f.conv.id, s);
  return s;
};

test('read together feeds: a matching key and hash is shared; the text comes from the snapshot, never the body', async (t) => {
  const f = await feedFixture(t);
  const view = f.app.readTogether!.share(f.app, f.conv.id, f.pick({ text: 'INJECTED BROWSER TEXT', title: 'Fake' }));
  assert.equal(view.source, 'feed');
  assert.equal(view.name, 'Cleaning the filter & more');
  const got = sharedFeedItem(f.app, f.app.readTogether!.get(f.conv.id) as never);
  assert.ok(!('mismatch' in got));
  assert.equal(got.item.text, f.item.text);
  assert.equal(got.feed, 'Heater Notes');
  assert.equal(got.host, 'feeds.example.com');
  assert.ok(!JSON.stringify(got).includes('INJECTED'));
});

test('read together feeds: a client hash that does not match, an unknown key or an old revision is refused', async (t) => {
  const f = await feedFixture(t);
  const rt = f.app.readTogether!;
  refused(() => rt.share(f.app, f.conv.id, f.pick({ textSha: textHash('something else') })), 409, 'passage');
  refused(() => rt.share(f.app, f.conv.id, f.pick({ key: '0123456789abcdef' })), 409, 'gone');
  refused(() => rt.share(f.app, f.conv.id, f.pick({ rev: 'ffffffffffff' })), 409, 'revision');
  refused(() => rt.share(f.app, f.conv.id, f.pick({ key: 'not hex' })), 400, 'bad');
  rt.setFeed(f.conv.id, undefined);
  refused(() => rt.share(f.app, f.conv.id, f.pick()), 409, 'gone');
  assert.equal(rt.get(f.conv.id), undefined);
});

test('read together feeds: Reload with the item edited is a revision mismatch; without it, gone', async (t) => {
  const f = await feedFixture(t);
  const rt = f.app.readTogether!;
  rt.share(f.app, f.conv.id, f.pick());
  const s = rt.get(f.conv.id)!;
  // Another item changes: the shared item still matches.
  await reload(t, f, RSS.replace('Store it upright.', 'Store it flat.'));
  assert.ok(!('mismatch' in sharedFeedItem(f.app, s as never)));
  await reload(t, f, RSS.replace('in warm water', 'in cold water'));
  assert.deepEqual(sharedFeedItem(f.app, s as never), { mismatch: 'revision', name: 'Cleaning the filter & more', feed: 'Heater Notes' });
  await reload(t, f, RSS.replace(/<item>[\s\S]*?<\/item>/, ''));
  assert.deepEqual(sharedFeedItem(f.app, s as never), { mismatch: 'gone', name: 'Cleaning the filter & more', feed: 'Heater Notes' });
});

test('read together feeds: Stop clears the share and the open feed; a restart has neither; the 13th update is 429', async (t) => {
  const f = await feedFixture(t);
  const rt = f.app.readTogether!;
  rt.share(f.app, f.conv.id, f.pick());
  assert.equal(rt.stop(f.conv.id), true);
  assert.equal(rt.get(f.conv.id), undefined);
  assert.equal(rt.feed(f.conv.id), undefined);
  rt.setFeed(f.conv.id, f.snap);
  rt.share(f.app, f.conv.id, f.pick());
  const fresh = new ReadTogether(() => f.clock.now);
  assert.equal(fresh.get(f.conv.id), undefined, 'memory only');
  assert.equal(fresh.feed(f.conv.id), undefined, 'memory only');
  for (let i = 2; i < RT.perMinute; i++) rt.share(f.app, f.conv.id, f.pick());
  refused(() => rt.share(f.app, f.conv.id, f.pick()), 429, 'rate');
  // Nothing about the feed reaches the database.
  const rows = f.app.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of rows) {
    const dump = JSON.stringify(f.app.store.db.prepare(`SELECT * FROM "${name}"`).all());
    assert.ok(!dump.includes('Heater Notes') && !dump.includes('feeds.example.com') && !dump.includes('filter &'), name);
  }
});

async function serve(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const f = readFixture(t);
  const auth = new OwnerAuth(f.dir);
  const server = createSaraServer({ app: f.app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Casey' }), apps: () => [f.app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  // Only requests to the test server itself use the real fetch; the feed site is the injected transport.
  const feedCalls = stubNet(t, (url) => (url.startsWith('https://93.184.216.34/') ? xml(RSS) : new Response('no', { status: 500 })));
  const real = globalThis.fetch;
  async function api(path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) {
    const res = await real(base + path, { method, headers: { Origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  return { ...f, api, feedCalls };
}

test('read together feeds API: Open lists items (no text), Share by key and hash, GET shows it, DELETE closes both', async (t) => {
  const s = await serve(t);
  const url = `/api/read-together/${s.conv.id}/feed`;
  const open = await s.api(url, 'POST', { url: 'https://93.184.216.34/rss' });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const feed = open.body.feed;
  assert.equal(feed.title, 'Heater Notes');
  assert.equal(feed.host, '93.184.216.34');
  assert.equal(feed.rev.length, 12);
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].text, undefined, 'the list has no item text');
  assert.ok(!JSON.stringify(open.body).includes('Rinse the filter'));
  assert.equal(s.feedCalls.length, 1);
  const before = s.app.store.messages(s.conv.id).length;
  const put = await s.api(`/api/read-together/${s.conv.id}`, 'PUT', { source: 'feed', rev: feed.rev, key: feed.items[0].key, textSha: feed.items[0].textSha });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.share.source, 'feed');
  const got = (await s.api(`/api/read-together/${s.conv.id}`)).body;
  assert.equal(got.share.source, 'feed');
  assert.equal(got.share.key, feed.items[0].key);
  assert.equal(got.feed.title, 'Heater Notes');
  assert.equal(s.feedCalls.length, 1, 'GET and Share never fetch');
  assert.equal(s.app.providerCalls, 0);
  assert.equal(s.app.store.messages(s.conv.id).length, before);
  const bad = await s.api(`/api/read-together/${s.conv.id}`, 'PUT', { source: 'feed', rev: feed.rev, key: feed.items[0].key, textSha: textHash('x') });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.reason, 'passage');
  // Follow off ends the share only; Stop also closes the feed.
  assert.equal((await s.api(`/api/read-together/${s.conv.id}?only=share`, 'DELETE')).status, 204);
  assert.equal(s.app.readTogether!.get(s.conv.id), undefined);
  assert.ok(s.app.readTogether!.feed(s.conv.id));
  assert.equal((await s.api(`/api/read-together/${s.conv.id}`, 'DELETE')).status, 204);
  assert.equal(s.app.readTogether!.get(s.conv.id), undefined);
  assert.equal(s.app.readTogether!.feed(s.conv.id), undefined);
});

test('read together feeds API: loopback, private and http addresses are refused with a plain reason and no request', async (t) => {
  const s = await serve(t);
  const url = `/api/read-together/${s.conv.id}/feed`;
  for (const target of ['https://127.0.0.1/rss', 'https://localhost/rss', 'https://192.168.0.2/rss', 'https://169.254.169.254/', 'http://93.184.216.34/rss', '']) {
    const r = await s.api(url, 'POST', { url: target });
    assert.equal(r.status, 400, target);
    assert.equal(r.body.reason, 'address', target);
  }
  assert.equal(s.feedCalls.length, 0);
});

test('read together feeds API: private chats and private local mode refuse Open; members and the demo are refused first', async (t) => {
  const s = await serve(t);
  const priv = s.app.store.createConversation({ title: 'Private', private: true } as never);
  const r = await s.api(`/api/read-together/${priv.id}/feed`, 'POST', { url: 'https://93.184.216.34/rss' });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'private');
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  const p = await s.api(`/api/read-together/${s.conv.id}/feed`, 'POST', { url: 'https://93.184.216.34/rss' });
  assert.equal(p.status, 409);
  assert.equal(p.body.reason, 'private');
  assert.match(p.body.error, /private local mode is on/);
  setPrivateLocal(false);
  assert.equal(s.feedCalls.length, 0);
  for (const mode of ['member', 'demo'] as const) {
    const m = await serve(t, mode);
    const x = await m.api(`/api/read-together/${m.conv.id}/feed`, 'POST', { url: 'https://93.184.216.34/rss' });
    assert.equal(x.status, 403, mode);
    assert.equal(m.feedCalls.length, 0, mode);
  }
});
