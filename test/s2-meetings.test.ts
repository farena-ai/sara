// S2 meeting assistant (docs/MEETINGS.md, on top of EC19). Synthetic audio (two tone "voices" with
// pauses; stereo mic/computer channels), a fake hearing engine that names the voice by its pitch, a
// scripted model and a fake calendar and mailbox. Acceptance: speakers told apart by channel or by
// pauses and pitch (Speaker 1/2, renamable); long uploads arrive in parts with running timestamps;
// notes add open questions and the matching calendar event; follow-up drafts per attendee group wait
// for the owner (never sent on their own); local hearing first, a cloud engine only when allowed;
// Today lists action items due; meeting_list / meeting_summarize only read.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { LibraryStore } from '../src/library/store.ts';
import { diarize, readPcm } from '../src/meeting-audio.ts';
import { Meetings, type Meeting } from '../src/meetings.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PlannerStore } from '../src/planner.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createMeetingTools } from '../src/tools/meetings.ts';
import { monoWav, pitchOf, stereoWav } from './fixtures/s2-audio.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const LOW = 'We should move the launch to March.';
const HIGH = 'Agreed, and who tells the client?';
const heardWords = (wav: Buffer) => {
  const p = pitchOf(wav);
  return p === 0 ? '' : p < 180 ? LOW : HIGH;
};
const at = (d: string) => new Date(d);
const fakeId = (n: number) => ['ev', n, 'x'].join('-');

function rig(t: TestContext, o: { voice?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: at('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.planner = new PlannerStore(app.store.db, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' } } as never);
  const heard: string[] = [];
  if (o.voice !== false)
    (app as { voice?: unknown }).voice = {
      available: { stt: true, tts: true },
      transcribe: async (wav: Buffer) => {
        const w = heardWords(wav);
        heard.push(w);
        return w;
      },
    };
  const sent: { to: string; subject: string; body: string }[] = [];
  const saved: { to: string }[] = [];
  const provider = { send: async (d: { to: string; subject: string; body: string }) => (sent.push(d), 'id1'), draft: async (d: { to: string }) => (saved.push(d), 'd1') };
  (app as { mailAccounts?: unknown }).mailAccounts = {
    list: () => [{ id: 'a1', kind: 'imap', address: 'alex@home.test', label: 'Home' }],
    default: () => ({ id: 'a1', kind: 'imap', address: 'alex@home.test' }),
    provider: () => provider,
  };
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  setPolicy(new PolicyStore(dir));
  const events = [{ id: fakeId(1), title: 'Launch sync', start: '2026-11-16T14:00:00Z', end: '2026-11-16T15:00:00Z', allDay: false, attendees: ['alex@home.test', 'dana@acme.test', 'lee@acme.test', 'kim@other.test'], account: 'Home' }];
  const asked: [string, string][] = [];
  const meetings = new Meetings(app, app.store.db, {
    events: async (from: Date, to: Date) => {
      asked.push([from.toISOString(), to.toISOString()]);
      return events.filter((e) => new Date(e.end) > from && new Date(e.start) < to);
    },
  });
  app.meetings = meetings;
  t.after(() => {
    meetings.close();
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    setPrivateLocal(false);
    app.store.close();
    cleanup();
  });
  const actions = () => trail.list({}).map((r) => `${r.action}:${r.outcome}`);
  return { app, meetings, heard, sent, saved, asked, actions, dir, clock };
}

async function until(m: Meetings, id: number, ok: (x: Meeting) => boolean, ms = 8000): Promise<Meeting> {
  const end = Date.now() + ms;
  for (;;) {
    const x = m.get(id)!;
    if (ok(x)) return x;
    if (Date.now() > end) throw new Error(`timed out in status ${x.status}: ${x.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const NOTES = JSON.stringify({
  summary: 'The team moved the launch to March.',
  decisions: ['Launch in March.'],
  actions: [
    { task: 'Tell the client about the new date', owner: 'Speaker 2', due: 'tomorrow' },
    { task: 'Update the plan', owner: 'Alex', due: '' },
  ],
  questions: ['Does marketing need a new budget?'],
});
const DRAFTS = JSON.stringify({ drafts: [{ group: 0, subject: 'Launch sync: notes', body: 'Hi Dana and Lee, the launch moves to March.' }, { group: 1, subject: 'Launch sync: next steps', body: 'Hi Kim, a short recap.' }] });

test('s2 audio: speakers by pauses and pitch (mono) and by channel (stereo)', () => {
  const mono = diarize(readPcm(monoWav([[120, 2], [0, 1], [240, 2], [0, 1], [120, 2]])), { byChannel: false });
  assert.equal(mono.mode, 'pauses');
  assert.deepEqual(mono.segments.map((s) => s.speaker), [0, 1, 0]);
  assert.deepEqual(mono.segments.map((s) => Math.round(s.start)), [0, 3, 6]);
  const one = diarize(readPcm(monoWav([[150, 2], [0, 1], [150, 2]])), { byChannel: false });
  assert.deepEqual([...new Set(one.segments.map((s) => s.speaker))], [0], 'one voice stays Speaker 1');
  const st = diarize(readPcm(stereoWav([[200, 2], [0, 3]], [[0, 2.5], [200, 2.5]])), { byChannel: true });
  assert.equal(st.mode, 'channel');
  assert.deepEqual(st.segments.map((s) => s.speaker), [0, 1], 'the microphone is Speaker 1, the computer Speaker 2');
  assert.deepEqual(diarize(readPcm(monoWav([[0, 3]])), { byChannel: false }).segments, [], 'silence: nothing');
});

test('s2 upload in parts: speakers, timestamps, rename, questions, the calendar event, drafts waiting', async (t) => {
  const { meetings, app, sent, saved, asked, actions, dir } = rig(t);
  const m = meetings.upload({ title: 'Launch sync', consent: true, name: 'sync.m4a', parts: 2, channels: 'mixed', startedAt: '2026-11-16T14:05:00Z', seconds: 16 });
  assert.equal(m.status, 'hearing');
  assert.throws(() => meetings.upload({ title: 'x', parts: 1 }), /Tick/);
  app.script.push(text(NOTES), text(DRAFTS));
  await meetings.part(m.id, 0, monoWav([[120, 2], [0, 1], [240, 2], [0, 3]]));
  await meetings.part(m.id, 1, monoWav([[120, 2], [0, 1], [240, 2], [0, 3]]));
  const done = await until(meetings, m.id, (x) => x.status === 'done');
  const said = done.lines.filter((l) => l.kind === 'said');
  assert.deepEqual(said.map((l) => l.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  assert.deepEqual(said.map((l) => l.text), [LOW, HIGH, LOW, HIGH]);
  assert.deepEqual(said.map((l) => Math.round(l.t ?? -1)), [0, 3, 8, 11], 'part two continues the clock');
  assert.deepEqual(done.notes!.questions, ['Does marketing need a new budget?']);
  assert.equal(done.notes!.event?.title, 'Launch sync');
  assert.ok(asked.length, 'the calendar was asked around the recording time');
  assert.equal(existsSync(join(dir, 'meetings', String(m.id))), false, 'no recording kept unless chosen');

  const drafts = done.notes!.drafts!;
  assert.deepEqual(drafts.map((d) => d.to), [['dana@acme.test', 'lee@acme.test'], ['kim@other.test']], 'grouped by organisation, never to the owner');
  assert.deepEqual(drafts.map((d) => d.status), ['waiting', 'waiting']);
  assert.equal(sent.length, 0, 'nothing is sent on its own');

  meetings.rename(m.id, 'Speaker 2', 'Dana');
  assert.deepEqual(meetings.get(m.id)!.lines.filter((l) => l.kind === 'said').map((l) => l.speaker), ['Speaker 1', 'Dana', 'Speaker 1', 'Dana']);
  assert.equal(meetings.get(m.id)!.notes!.actions[0].owner, 'Dana', 'an owner named by label follows the rename');

  await meetings.draft(m.id, 0, { action: 'send', body: 'Hi both, the launch moves to March.' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dana@acme.test, lee@acme.test');
  assert.equal(sent[0].body, 'Hi both, the launch moves to March.', 'his edits are what goes out');
  await meetings.draft(m.id, 1, { action: 'save' });
  assert.equal(saved.length, 1);
  await assert.rejects(meetings.draft(m.id, 0, { action: 'send' }), /already/);
  assert.deepEqual(meetings.get(m.id)!.notes!.drafts!.map((d) => d.status), ['sent', 'saved']);
  assert.ok(actions().includes('meeting.draft:ok'));
  assert.match(meetings.markdown({ ...done, notes: meetings.get(m.id)!.notes! }), /Open questions[\s\S]*marketing/);
});

test('s2 desktop recording: stereo mic/computer channels become Speaker 1 and 2; drafts refused in private local mode', async (t) => {
  const { meetings, app } = rig(t);
  const m = meetings.upload({ title: 'Call', consent: true, name: 'rec.wav', parts: 1, channels: 'speakers', keepAudio: true });
  app.script.push(text(NOTES), text(DRAFTS));
  await meetings.part(m.id, 0, stereoWav([[120, 2], [0, 3]], [[0, 2.5], [240, 2.5]]));
  const done = await until(meetings, m.id, (x) => x.status === 'done');
  assert.deepEqual(done.lines.filter((l) => l.kind === 'said').map((l) => [l.speaker, l.text]), [['Speaker 1', LOW], ['Speaker 2', HIGH]]);
  assert.ok(meetings.recording(m.id)!.bytes.length > 44, 'kept when chosen');
  setPrivateLocal(true);
  await assert.rejects(meetings.draft(m.id, 0, { action: 'send' }), /private local/i);
});

test('s2 hearing: local first, a cloud engine only when allowed for meetings', (t) => {
  const { app, meetings } = rig(t, { voice: false });
  app.settings.update({ voice: { stt: 'openai', tts: 'local', openai: { baseUrl: 'https://api.openai.com/v1' } } } as never);
  assert.match(meetings.refusal()!, /cloud/i);
  app.settings.update({ meetings: { cloud: true } } as never);
  assert.equal(meetings.refusal(), null);
  const local = rig(t);
  local.app.settings.update({ voice: { stt: 'openai', tts: 'local', openai: { baseUrl: 'https://api.openai.com/v1' } } } as never);
  assert.equal(local.meetings.refusal(), null, 'a hearing engine on this computer is used first');
  assert.deepEqual(local.meetings.prefs(), { remind: true, cloud: false, speakers: true });
});

test('s2 Today tile and tools: action items due, meeting_list and meeting_summarize only read', async (t) => {
  const { meetings, app } = rig(t);
  const m = meetings.upload({ title: 'Launch sync', consent: true, name: 'a.wav', parts: 1, startedAt: '2026-11-16T14:10:00Z' });
  app.script.push(text(NOTES), text(DRAFTS));
  await meetings.part(m.id, 0, monoWav([[120, 2], [0, 1], [240, 2], [0, 1]]));
  await until(meetings, m.id, (x) => x.status === 'done');
  const tile = meetings.todayTile()!;
  assert.deepEqual(tile.items.map((i) => i.task), ['Tell the client about the new date']);
  assert.equal(tile.drafts, 2);
  meetings.addTodos(m.id, [0]);
  assert.equal(meetings.todayTile()!.items.length, 0, 'in the Planner: off the tile');

  const tools = createMeetingTools(() => app);
  assert.deepEqual(tools.map((x) => x.spec.name), ['meeting_list', 'meeting_summarize']);
  for (const x of tools) assert.equal(x.defaultPermission, 'auto');
  const ctx = { signal: new AbortController().signal, conversationId: 'c' } as never;
  assert.match(await tools[0].run({}, ctx), /Launch sync/);
  const sum = await tools[1].run({ id: String(m.id) }, ctx);
  assert.match(sum, /moved the launch to March/);
  assert.match(sum, /marketing need a new budget/);
  assert.match(sum, /Tell the client/);
  assert.match(await tools[1].run({}, ctx), /Launch sync/, 'no id: the latest meeting');
});
