// EC19 slice 2 (docs/ops/EC19_DESIGN.md): meetings and their notes. Fake audio: WAV clips made here
// (16 kHz mono, each clip a constant sample value that the fake hearing engine maps to its words),
// and a scripted model. Acceptance: consent required and announced; joins noticed and audited;
// what is said becomes lines; she answers only when called by name (one at a time, capped, minors
// block); a recorded file is cut into pieces and heard; no recording kept unless chosen; notes
// (summary, decisions, action items with owners and dates) saved to the Library; to-dos only for
// the items he picks; the policy pin and private local mode refuse; delete honours legal hold.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { setHoldResolver } from '../src/legal-hold.ts';
import { LibraryStore } from '../src/library/store.ts';
import { addressed, Meetings, parseNotes, splitWav, type Meeting } from '../src/meetings.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { clip, recording } from './fixtures/ec19-audio.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const WORDS: Record<number, string> = {
  1: 'Let us plan the garden party for Saturday.',
  2: 'We decided on the park, not the backyard.',
  3: 'Sara, what did we decide about the place?',
  4: 'Alex will book the tables by Friday.',
  5: 'Something about a child in a sexual way.',
  6: 'Mia buys the drinks next week.',
};

function rig(t: TestContext, o: { pins?: Record<string, unknown> } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' } } as never);
  const heard: number[] = [];
  (app as { voice?: unknown }).voice = {
    transcribe: async (wav: Buffer) => {
      const v = wav.readInt16LE(44);
      heard.push(v);
      return WORDS[v] ?? '';
    },
  };
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  const pol = new PolicyStore(dir);
  if (o.pins) pol.set({ name: 'Family rules', pins: o.pins });
  setPolicy(pol);
  const meetings = new Meetings(app, app.store.db);
  t.after(() => {
    meetings.close();
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    setPrivateLocal(false);
    setHoldResolver(undefined);
    app.store.close();
    cleanup();
  });
  const actions = () => trail.list({}).map((r) => `${r.action}:${r.outcome}`);
  return { app, meetings, heard, trail, actions, dir, clock };
}

async function until(m: Meetings, id: number, ok: (x: Meeting) => boolean, ms = 6000): Promise<Meeting> {
  const end = Date.now() + ms;
  for (;;) {
    const x = m.get(id)!;
    if (ok(x)) return x;
    if (Date.now() > end) throw new Error(`timed out in status ${x.status}: ${x.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const NOTES = JSON.stringify({
  summary: 'The group planned the garden party.',
  decisions: ['The party is in the park.'],
  actions: [
    { task: 'Book the tables', owner: 'Alex', due: 'Friday' },
    { task: 'Buy the drinks', owner: 'Mia', due: 'next week' },
    { task: 'Send invitations', owner: '', due: '' },
  ],
});

test('ec19 helpers: addressed, splitWav and parseNotes', () => {
  assert.equal(addressed('Sara', 'Sara, what did we decide?'), true);
  assert.equal(addressed('Sara', 'Hey Sara can you hear us'), true);
  assert.equal(addressed('Sara', 'What do you think, Sara?'), true);
  assert.equal(addressed('Sara', 'I told my sister Sara about it yesterday.'), false);
  assert.equal(addressed('Sara', 'Let us move on.'), false);
  const pieces = splitWav(recording([[1, 60], [2, 60], [3, 10]]), 60);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((p) => p.readInt16LE(44)), [1, 2, 3]);
  assert.equal(pieces[2].readUInt32LE(40), 10 * 32000);
  assert.throws(() => splitWav(Buffer.from('RIFF....WAVEjunk')), /WAV/);
  const n = parseNotes('Here you go:\n```json\n' + NOTES + '\n```');
  assert.equal(n.summary, 'The group planned the garden party.');
  assert.deepEqual(n.decisions, ['The party is in the park.']);
  assert.equal(n.actions.length, 3);
  assert.equal(n.actions[2].owner, '');
  assert.throws(() => parseNotes('no json here'), /notes/i);
  const big = parseNotes(JSON.stringify({ summary: 'x'.repeat(5000), decisions: Array(50).fill('d'), actions: Array(50).fill({ task: 't', owner: 'o', due: '' }) }));
  assert.ok(big.summary.length <= 2000);
  assert.equal(big.decisions.length, 30);
  assert.equal(big.actions.length, 30);
});

test('ec19 room: consent, spoken notice, joins, lines, a reply when called, notes, to-dos', async (t) => {
  const { app, meetings, heard, actions } = rig(t);
  assert.throws(() => meetings.start({ title: 'Party', consent: false }), (e: Error & { status?: number }) => e.status === 400 && /everyone/i.test(e.message));
  const m = meetings.start({ title: 'Garden party', consent: true });
  assert.equal(m.status, 'live');
  assert.equal(m.lines[0].kind, 'notice');
  assert.match(m.lines[0].text, /AI/);
  assert.match(m.lines[0].text, /listening and taking notes/);
  assert.match(m.announce, /listening and taking notes/);
  const j = meetings.join(m.id, { device: 'Laptop' });
  assert.match(j.lines.at(-1)!.text, /Laptop/);
  assert.equal(j.lines.at(-1)!.kind, 'notice');

  assert.equal((await meetings.hear(m.id, { speaker: 'Laptop', audio: clip(1) })).line?.text, WORDS[1]);
  await meetings.hear(m.id, { speaker: 'Laptop', audio: clip(2) });
  app.script.push(text('We picked the park, not the backyard.'));
  const r = await meetings.hear(m.id, { speaker: 'Phone', audio: clip(3) });
  assert.equal(r.reply?.text, 'We picked the park, not the backyard.');
  assert.equal(r.reply?.kind, 'sara');
  const asked = app.requests.at(-1)!;
  assert.match(JSON.stringify(asked.messages), /We decided on the park/);
  assert.match(JSON.stringify(asked.messages), /two short sentences/);
  assert.equal(asked.tools?.length ?? 0, 0, 'no tools in a meeting');
  const blocked = await meetings.hear(m.id, { speaker: 'Laptop', audio: clip(5) });
  assert.doesNotMatch(blocked.line!.text, /child/);
  await meetings.hear(m.id, { speaker: 'Laptop', audio: clip(4) });
  assert.equal((await meetings.hear(m.id, { speaker: 'Laptop', audio: clip(99) })).line, undefined, 'silence adds nothing');
  assert.deepEqual(heard, [1, 2, 3, 5, 4, 99]);
  const live = meetings.get(m.id)!;
  assert.deepEqual(live.lines.filter((l) => l.kind === 'said').map((l) => l.speaker), ['Laptop', 'Laptop', 'Phone', 'Laptop', 'Laptop']);
  assert.equal(live.replies, 1);

  app.script.push(text(NOTES));
  meetings.end(m.id);
  const done = await until(meetings, m.id, (x) => x.status === 'done');
  assert.equal(done.notes!.decisions[0], 'The party is in the park.');
  assert.equal(done.notes!.actions[0].dueAt, '2026-11-13T17:00:00.000Z', 'Friday after the meeting day');
  assert.equal(done.notes!.actions[2].owner, '');
  const doc = app.library!.get(done.notesDocId!)!;
  assert.match(doc.name, /^Meeting notes - Garden party - 2026-11-07\.md$/);
  const md = app.library!.file(doc)!.toString('utf8');
  assert.match(md, /## Decisions\n\n- The party is in the park\./);
  assert.match(md, /Book the tables · Alex · Friday/);
  assert.match(md, /Send invitations · Not said/);
  assert.doesNotMatch(md, /what did we decide about the place/, 'the transcript stays with the meeting');
  assert.ok(app.requests.at(-1)!.messages.some((x) => String(x.content).includes('Alex will book the tables')));

  assert.equal(app.planner!.tasks().length, 0, 'nothing reaches the Planner by itself');
  const added = meetings.addTodos(m.id, [0, 2]);
  assert.deepEqual(added.map((x) => x.title), ['Book the tables', 'Send invitations']);
  assert.equal(added[0].dueAt, '2026-11-13T17:00:00.000Z');
  assert.match(added[0].notes, /Garden party/);
  assert.equal(meetings.get(m.id)!.notes!.actions[0].taskId, added[0].id);
  assert.equal(meetings.addTodos(m.id, [0]).length, 0, 'an item is added once');
  assert.throws(() => meetings.hear(m.id, { speaker: 'x', audio: clip(1) }) as never, () => true);
  const a = actions();
  for (const want of ['meeting.start:ok', 'meeting.join:ok', 'meeting.end:ok', 'meeting.notes:ok', 'meeting.todos:ok']) assert.ok(a.includes(want), want);
  assert.doesNotMatch(JSON.stringify(a), /garden|tables/i, 'audit rows never hold the words');
});

test('ec19 room: replies are capped and one at a time; no recording unless chosen', async (t) => {
  const { app, meetings, dir } = rig(t);
  const m = meetings.start({ title: 'Cap', consent: true });
  app.script.push(text('First answer.'));
  const [a, b] = await Promise.all([meetings.hear(m.id, { speaker: 'A', audio: clip(3) }), meetings.hear(m.id, { speaker: 'B', audio: clip(3) })]);
  assert.equal([a.reply, b.reply].filter(Boolean).length, 1, 'one answer in flight');
  for (let i = 0; i < 25; i++) app.script.push(text(`Answer ${i}.`));
  for (let i = 0; i < 25; i++) await meetings.hear(m.id, { speaker: 'A', audio: clip(3) });
  assert.equal(meetings.get(m.id)!.replies, 20);
  assert.equal(existsSync(join(dir, 'meetings', String(m.id))), false, 'nothing kept');
  const k = meetings.start({ title: 'Kept', consent: true, keepAudio: true });
  await meetings.hear(k.id, { speaker: 'A', audio: clip(1) });
  await meetings.hear(k.id, { speaker: 'A', audio: clip(2) });
  const rec = meetings.recording(k.id)!;
  assert.equal(rec.type, 'audio/wav');
  assert.equal(rec.bytes.readUInt32LE(40), 2 * 32000, 'the kept pieces as one WAV');
  assert.equal(meetings.recording(m.id), undefined);
});

test('ec19 file: a recording is cut, heard, dropped, and written up; bad notes can be written again', async (t) => {
  const { app, meetings, heard, dir, actions } = rig(t);
  assert.throws(() => meetings.fromFile({ title: 'Call', consent: false, name: 'call.wav', bytes: clip(1) }), (e: Error & { status?: number }) => e.status === 400);
  app.script.push(text('Sorry, I cannot.'));
  const m = meetings.fromFile({ title: 'Discord call', consent: true, name: 'call.wav', bytes: recording([[1, 60], [4, 60], [6, 5]]) });
  assert.equal(m.source, 'file');
  const failed = await until(meetings, m.id, (x) => x.status === 'failed');
  assert.deepEqual(heard, [1, 4, 6]);
  assert.deepEqual(failed.lines.filter((l) => l.kind === 'said').map((l) => l.text), [WORDS[1], WORDS[4], WORDS[6]]);
  assert.match(failed.error!, /notes/i);
  assert.equal(existsSync(join(dir, 'meetings', String(m.id))), false, 'the file is dropped after hearing');
  app.script.push(text(NOTES));
  meetings.writeNotes(m.id);
  const ok = await until(meetings, m.id, (x) => x.status === 'done');
  assert.equal(ok.notes!.actions.length, 3);
  assert.ok(actions().includes('meeting.notes:failed'));

  const mp3 = meetings.fromFile({ title: 'Phone memo', consent: true, name: 'memo.mp3', bytes: Buffer.from('ID3\u0004fake mp3') });
  const bad = await until(meetings, mp3.id, (x) => x.status === 'failed');
  assert.match(bad.error!, /Grok voice|speech API/);
  const kept = meetings.fromFile({ title: 'Kept', consent: true, keepAudio: true, name: 'k.wav', bytes: clip(2, 2) });
  app.script.push(text(NOTES));
  await until(meetings, kept.id, (x) => x.status === 'done');
  assert.equal(meetings.recording(kept.id)!.bytes.length, clip(2, 2).length);
  assert.deepEqual(readdirSync(join(dir, 'meetings', String(kept.id))), ['recording.wav']);
});

test('ec19 safety: the policy pin, private local mode, owner delete and legal hold, restart', async (t) => {
  const pinned = rig(t, { pins: { meetings: false } });
  assert.throws(() => pinned.meetings.start({ title: 'x', consent: true }), (e: Error & { status?: number }) => e.status === 409 && /admin/.test(e.message));
  assert.throws(() => pinned.meetings.fromFile({ title: 'x', consent: true, name: 'a.wav', bytes: clip(1) }), (e: Error & { status?: number }) => e.status === 409);
  assert.ok(pinned.actions().includes('meeting.start:refused'));
  assert.match(pinned.meetings.refusal()!, /admin/);

  const { app, meetings, dir } = rig(t);
  app.settings.update({ voice: { stt: 'openai', tts: 'local' } } as never);
  setPrivateLocal(true);
  assert.throws(() => meetings.start({ title: 'x', consent: true }), (e: Error & { status?: number }) => e.status === 409 && /private local/i.test(e.message));
  app.settings.update({ voice: { stt: 'local', tts: 'local' } } as never);
  const m = meetings.start({ title: 'Local', consent: true, keepAudio: true });
  await meetings.hear(m.id, { speaker: 'A', audio: clip(1) });
  setPrivateLocal(false);
  setHoldResolver({ held: () => true, any: () => true });
  assert.throws(() => meetings.delete(m.id), /hold/i);
  setHoldResolver(undefined);
  assert.equal(meetings.delete(m.id), true);
  assert.equal(meetings.get(m.id), undefined);
  assert.equal(existsSync(join(dir, 'meetings', String(m.id))), false);
  const live = meetings.start({ title: 'Restart', consent: true });
  meetings.close();
  const again = new Meetings(app, app.store.db);
  t.after(() => again.close());
  assert.equal(again.get(live.id)!.status, 'ended', 'a room live before a restart is ended, notes can be written');
});
