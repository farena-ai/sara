// EC19 slice 3: the meeting routes. Owner only (household members and the demo get 403); a room over
// HTTP (start with consent, join, audio, a reply when called, end, notes, to-dos), a recorded file,
// the kept recording download (an audit row), delete, and the policy pin refusing server side.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Meetings } from '../src/meetings.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { clip } from './fixtures/ec19-audio.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const WORDS: Record<number, string> = { 1: 'We will ship on Monday.', 3: 'Sara, when do we ship?', 4: 'Mia writes the release notes by Friday.' };

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner', pins?: Record<string, unknown>) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => new Date('2026-11-07T12:00:00Z'));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' } } as never);
  (app as { voice?: unknown }).voice = { transcribe: async (wav: Buffer) => WORDS[wav.readInt16LE(44)] ?? '' };
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  const pol = new PolicyStore(dir);
  if (pins) pol.set({ name: 'Office rules', pins });
  setPolicy(pol);
  app.meetings = new Meetings(app, app.store.db);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    app.meetings?.close();
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(auth.newToken ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(body === undefined ? {} : { body: raw ? new Uint8Array(body as Buffer) : JSON.stringify(body) }) });
    return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
  }
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const r = await api(path, method, body);
    return { status: r.status, body: JSON.parse(r.bytes.toString('utf8') || '{}') };
  };
  return { app, api, json, trail };
}

async function waitFor(json: (p: string) => Promise<{ body: any }>, id: number, status: string) {
  const end = Date.now() + 6000;
  for (;;) {
    const m = (await json(`/api/meetings/${id}`)).body.meeting;
    if (m.status === status) return m;
    if (Date.now() > end) throw new Error(`stuck in ${m.status}: ${m.error}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const NOTES = JSON.stringify({ summary: 'Shipping was planned.', decisions: ['Ship on Monday.'], actions: [{ task: 'Write the release notes', owner: 'Mia', due: 'Friday' }] });

test('ec19 routes: a room over HTTP, owner only, with notes, to-dos and a kept recording', async (t) => {
  const { app, api, json, trail } = await rig(t);
  const list = await json('/api/meetings');
  assert.equal(list.status, 200);
  assert.equal(list.body.ready, true);
  assert.equal((await json('/api/meetings', 'POST', { title: 'Release' })).status, 400, 'consent required');
  const { meeting } = (await json('/api/meetings', 'POST', { title: 'Release', consent: true, keepAudio: true })).body;
  assert.match(meeting.announce, /listening and taking notes/);
  assert.equal((await json(`/api/meetings/${meeting.id}/join`, 'POST', { device: 'Phone' })).status, 200);
  const said = await json(`/api/meetings/${meeting.id}/audio?speaker=Laptop`, 'POST', clip(1));
  assert.equal(said.body.line.text, WORDS[1]);
  app.script.push(text('On Monday.'));
  const asked = await json(`/api/meetings/${meeting.id}/audio?speaker=Phone`, 'POST', clip(3));
  assert.equal(asked.body.reply.text, 'On Monday.');
  await json(`/api/meetings/${meeting.id}/audio?speaker=Laptop`, 'POST', clip(4));
  const since = (await json(`/api/meetings/${meeting.id}?since=3`)).body.meeting;
  assert.deepEqual(since.lines.map((l: { n: number }) => l.n), [4, 5, 6], 'only new lines');
  app.script.push(text(NOTES));
  assert.equal((await json(`/api/meetings/${meeting.id}/end`, 'POST', {})).status, 200);
  const done = await waitFor(json, meeting.id, 'done');
  assert.equal(done.notes.actions[0].owner, 'Mia');
  assert.ok(done.notesDocId);
  const todo = await json(`/api/meetings/${meeting.id}/todos`, 'POST', { items: [0] });
  assert.equal(todo.body.added.length, 1);
  assert.equal(app.planner!.tasks()[0].title, 'Write the release notes');
  const rec = await api(`/api/meetings/${meeting.id}/recording`);
  assert.equal(rec.status, 200);
  assert.equal(rec.type, 'audio/wav');
  assert.equal(rec.bytes.readUInt32LE(40), 3 * 32000);
  app.script.push(text(NOTES));
  const file = await json('/api/meetings/file?title=Discord%20call&consent=1&name=call.wav', 'POST', clip(4, 2));
  assert.equal(file.body.meeting.source, 'file');
  await waitFor(json, file.body.meeting.id, 'done');
  assert.equal((await api(`/api/meetings/${file.body.meeting.id}/recording`)).status, 404, 'not kept');
  assert.equal((await json('/api/meetings/file?title=x&name=a.wav', 'POST', clip(1))).status, 400, 'file consent required');
  assert.equal((await json(`/api/meetings/${meeting.id}`, 'DELETE')).status, 200);
  assert.equal((await json(`/api/meetings/${meeting.id}`)).status, 404);
  const acts = trail.list({}).map((r) => r.action);
  for (const a of ['meeting.start', 'meeting.join', 'meeting.end', 'meeting.notes', 'meeting.todos', 'meeting.recording', 'meeting.file', 'meeting.delete']) assert.ok(acts.includes(a), a);
});

test('ec19 routes: members and the demo get 403; the policy pin refuses new meetings', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const { json } = await rig(t, mode);
    const r = await json('/api/meetings', 'POST', { title: 'x', consent: true });
    assert.equal(r.status, 403, mode);
    if (mode === 'member') assert.equal(r.body.ownerOnly, true);
    assert.equal((await json('/api/meetings')).status, 403);
  }
  const { json } = await rig(t, 'owner', { meetings: false });
  const list = (await json('/api/meetings')).body;
  assert.equal(list.ready, false);
  assert.match(list.why, /admin/);
  const r = await json('/api/meetings', 'POST', { title: 'x', consent: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.policy?.key, 'meetings');
  assert.equal((await json('/api/meetings/file?title=x&consent=1&name=a.wav', 'POST', clip(1))).status, 409);
});
