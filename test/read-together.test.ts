// E5a (docs/ops/E5_DESIGN.md): sharing a passage of a text/Markdown document. The server reads the
// text from the library itself and checks the hashes; the browser only sends positions and hashes.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { ReadTogether, ReadTogetherError, RT, sharedExcerpt } from '../src/read-together.ts';
import { createSaraServer } from '../src/server.ts';
import { ROOT } from './helpers.ts';
import { hash, readFixture } from './read-together-fixture.ts';

const refused = (f: () => unknown, status: number, reason: string) =>
  assert.throws(f, (err: unknown) => err instanceof ReadTogetherError && err.status === status && err.reason === reason);

test('read together: a valid slice is shared and read back from the library, never from the browser', (t) => {
  const f = readFixture(t);
  const view = f.app.readTogether!.share(f.app, f.conv.id, { ...f.slice(1, 10, 40), text: 'INJECTED BROWSER TEXT' });
  assert.equal(view.docId, f.doc.id);
  assert.equal(view.place, 'part 2');
  assert.equal(view.heading, 'Cleaning');
  const got = sharedExcerpt(f.app, f.app.readTogether!.get(f.conv.id)!);
  assert.deepEqual(got, { text: f.passages[1].text.slice(10, 40), place: 'part 2', heading: 'Cleaning', name: 'heater.md', docId: f.doc.id, revision: f.doc.sha.slice(0, 12) });
  // Two passages: from an offset in the first to an offset in the last.
  const two = f.passages[0].text.slice(5) + '\n\n' + f.passages[1].text.slice(0, 12);
  f.app.readTogether!.share(f.app, f.conv.id, { docId: f.doc.id, sha: f.doc.sha, ordFrom: 0, ordTo: 1, start: 5, end: 12, textSha: hash(two), mode: 'passage' });
  assert.equal((sharedExcerpt(f.app, f.app.readTogether!.get(f.conv.id)!) as { text: string }).text, two);
});

test('read together: more than 3 passages or more than 4,000 characters is refused, never cut', (t) => {
  const f = readFixture(t);
  const all = f.passages.map((p) => p.text).join('\n\n');
  refused(() => f.app.readTogether!.share(f.app, f.conv.id, { docId: f.doc.id, sha: f.doc.sha, ordFrom: 0, ordTo: 3, start: 0, end: f.passages[3].text.length, textSha: hash(all), mode: 'passage' }), 409, 'too-long');
  const long = Array.from({ length: 3 }, (_, i) => ({ where: `part ${i + 1}`, text: `${'Long sentence about the heater and its parts. '.repeat(29)}End ${i}.` }));
  const g = readFixture(t, long);
  assert.equal(g.passages.length, 3);
  const text = g.passages.map((p) => p.text).join('\n\n');
  assert.ok(text.length > RT.maxChars);
  refused(() => g.app.readTogether!.share(g.app, g.conv.id, { docId: g.doc.id, sha: g.doc.sha, ordFrom: 0, ordTo: 2, start: 0, end: g.passages[2].text.length, textSha: hash(text), mode: 'passage' }), 409, 'too-long');
  assert.equal(g.app.readTogether!.get(g.conv.id), undefined);
});

test('read together: a hash that does not match the library text, or positions outside it, is refused', (t) => {
  const f = readFixture(t);
  refused(() => f.app.readTogether!.share(f.app, f.conv.id, { ...f.slice(0, 0, 20), textSha: hash('something else') }), 409, 'passage');
  refused(() => f.app.readTogether!.share(f.app, f.conv.id, f.slice(0, 0, 5000)), 409, 'passage');
  refused(() => f.app.readTogether!.share(f.app, f.conv.id, { ...f.slice(0, 0, 20), sha: 'ffffffffffff' }), 409, 'revision');
  refused(() => f.app.readTogether!.share(f.app, f.conv.id, { ...f.slice(0, 0, 20), ordFrom: 'x' }), 400, 'bad');
  assert.equal(f.app.readTogether!.get(f.conv.id), undefined);
});

test('read together: PDFs and Word documents are refused (text and Markdown only)', (t) => {
  for (const kind of ['pdf', 'docx']) {
    const f = readFixture(t, undefined, kind);
    refused(() => f.app.readTogether!.share(f.app, f.conv.id, f.slice(0, 0, 20)), 409, 'kind');
  }
});

test('read together: a changed revision, an edited passage or a removed/unkept document is a mismatch', (t) => {
  const f = readFixture(t);
  const rt = f.app.readTogether!;
  const db = f.app.store.db;
  rt.share(f.app, f.conv.id, f.slice(2, 0, 30));
  const s = rt.get(f.conv.id)!;
  db.prepare('UPDATE library_docs SET sha = ? WHERE id = ?').run('0'.repeat(64), f.doc.id);
  assert.deepEqual(sharedExcerpt(f.app, s), { mismatch: 'revision', name: 'heater.md' });
  db.prepare('UPDATE library_docs SET sha = ? WHERE id = ?').run(f.doc.sha, f.doc.id);
  db.prepare('UPDATE library_passages SET text = ? WHERE doc_id = ? AND ord = 2').run('Store it flat.', f.doc.id);
  assert.deepEqual(sharedExcerpt(f.app, s), { mismatch: 'passage', name: 'heater.md' });
  db.prepare('UPDATE library_docs SET keep = 0 WHERE id = ?').run(f.doc.id);
  assert.deepEqual(sharedExcerpt(f.app, s), { mismatch: 'gone', name: 'heater.md' });
  f.app.library!.delete(f.doc.id);
  assert.deepEqual(sharedExcerpt(f.app, s), { mismatch: 'gone', name: 'heater.md' });
  refused(() => rt.share(f.app, f.conv.id, f.slice(0, 0, 10)), 409, 'gone');
});

test('read together: the 13th update in a minute is refused (429); stop clears at once; a restart has no share', (t) => {
  const f = readFixture(t);
  const rt = f.app.readTogether!;
  for (let i = 0; i < RT.perMinute; i++) rt.share(f.app, f.conv.id, f.slice(0, 0, 10 + i, { mode: 'follow' }));
  refused(() => rt.share(f.app, f.conv.id, f.slice(0, 0, 40, { mode: 'follow' })), 429, 'rate');
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  assert.equal(rt.share(f.app, f.conv.id, f.slice(0, 0, 40, { mode: 'follow' })).mode, 'follow');
  assert.equal(rt.stop(f.conv.id), true);
  assert.equal(rt.get(f.conv.id), undefined);
  rt.share(f.app, f.conv.id, f.slice(0, 0, 10));
  assert.equal(new ReadTogether(() => f.clock.now).get(f.conv.id), undefined, 'memory only');
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
  async function api(path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  return { ...f, api };
}

test('read together API: the owner shares and stops; a position update never starts a turn', async (t) => {
  const s = await serve(t);
  const before = s.app.store.messages(s.conv.id).length;
  // The viewer gets the revision (the first 12 of the document's sha), never the whole sha.
  const doc = (await s.api(`/api/library/${s.doc.id}`)).body.doc;
  assert.equal(doc.revision, s.doc.sha.slice(0, 12));
  assert.equal(doc.sha, undefined);
  const put = await s.api(`/api/read-together/${s.conv.id}`, 'PUT', s.slice(0, 0, 30, { mode: 'follow' }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.ok, true);
  assert.equal(put.body.share.place, 'part 1');
  assert.equal((await s.api(`/api/read-together/${s.conv.id}`)).body.share.mode, 'follow');
  assert.equal(s.app.providerCalls, 0, 'no model call');
  assert.equal(s.app.store.messages(s.conv.id).length, before, 'no message row');
  const bad = await s.api(`/api/read-together/${s.conv.id}`, 'PUT', { ...s.slice(0, 0, 30), textSha: hash('x') });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.reason, 'passage');
  assert.equal((await s.api(`/api/read-together/${s.conv.id}`, 'DELETE')).status, 204);
  assert.equal(s.app.readTogether!.get(s.conv.id), undefined);
  assert.equal((await s.api('/api/read-together/nope', 'PUT', s.slice(0, 0, 30))).status, 404);
  const partner = s.app.store.createConversation({ title: 'Casey', partner: 'Casey' } as never);
  assert.equal((await s.api(`/api/read-together/${partner.id}`, 'PUT', s.slice(0, 0, 30))).status, 404);
  assert.equal((await s.api(`/api/read-together/${s.conv.id}`, 'PUT', s.slice(0, 0, 30), null)).status, 401);
});

test('read together API: household members and the demo are refused before any data access', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const s = await serve(t, mode);
    const r = await s.api(`/api/read-together/${s.conv.id}`, 'PUT', s.slice(0, 0, 30));
    assert.equal(r.status, 403, mode);
    assert.equal(s.app.readTogether!.get(s.conv.id), undefined, mode);
  }
});
