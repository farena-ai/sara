// S2 meeting assistant routes and UI (docs/MEETINGS.md): an upload in parts, rename a speaker, a
// draft waiting for the owner, the kept recording played with seeking (Range), prefs; static UI
// checks for the Meetings page (search, playback with timestamps, rename, drafts, desktop recording
// with its consent notice) and the Today tile, the tools' lean family and the desktop bridge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Meetings } from '../src/meetings.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { monoWav, pitchOf } from './fixtures/s2-audio.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

async function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-16T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => new Date('2026-11-16T12:00:00Z'));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' } } as never);
  (app as { voice?: unknown }).voice = { available: { stt: true, tts: true }, transcribe: async (wav: Buffer) => (pitchOf(wav) ? (pitchOf(wav) < 180 ? 'Low words.' : 'High words.') : '') };
  setPolicy(new PolicyStore(dir));
  app.meetings = new Meetings(app, app.store.db, { events: async () => [] });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    app.meetings?.close();
    setPolicy(new PolicyStore());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, ...headers, ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(body === undefined ? {} : { body: raw ? new Uint8Array(body as Buffer) : JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const r = await api(path, method, body);
    return { status: r.status, body: JSON.parse(r.bytes.toString('utf8') || '{}') };
  };
  return { app, api, json };
}

test('s2 routes: upload in parts, rename, drafts, recording with Range, prefs', async (t) => {
  const { app, api, json } = await rig(t);
  const NOTES = JSON.stringify({ summary: 'Short.', decisions: [], actions: [], questions: ['When?'] });
  app.script.push(text(NOTES));
  const up = await json('/api/meetings/upload', 'POST', { title: 'Sync', consent: true, keepAudio: true, name: 'a.mp3', parts: 1, channels: 'mixed' });
  assert.equal(up.status, 200);
  const id = up.body.meeting.id;
  assert.equal((await json(`/api/meetings/${id}/part?i=0`, 'POST', monoWav([[120, 2], [0, 1], [240, 2], [0, 1]]))).status, 200);
  let m;
  for (const end = Date.now() + 6000; Date.now() < end; await new Promise((r) => setTimeout(r, 30))) {
    m = (await json(`/api/meetings/${id}`)).body.meeting;
    if (m.status === 'done') break;
  }
  assert.equal(m.status, 'done');
  assert.deepEqual(m.notes.questions, ['When?']);
  assert.deepEqual(m.lines.filter((l: { kind: string }) => l.kind === 'said').map((l: { speaker: string }) => l.speaker), ['Speaker 1', 'Speaker 2']);
  const rn = await json(`/api/meetings/${id}/speakers`, 'POST', { from: 'Speaker 1', to: 'Sam' });
  assert.equal(rn.body.meeting.lines.find((l: { kind: string }) => l.kind === 'said').speaker, 'Sam');
  const full = await api(`/api/meetings/${id}/recording?play=1`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.doesNotMatch(full.headers.get('content-disposition') ?? '', /attachment/, 'played inline');
  const part = await api(`/api/meetings/${id}/recording?play=1`, 'GET', undefined, { range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.bytes.length, 100);
  assert.equal((await json(`/api/meetings/${id}/drafts/0`, 'POST', { action: 'send' })).status, 404, 'no draft without a calendar event');
  assert.deepEqual((await json('/api/meetings')).body.prefs, { remind: true, cloud: false, speakers: true });
  assert.equal((await json('/api/meetings/upload', 'POST', { title: 'x', parts: 1 })).status, 400, 'consent required');
  // U3.13: no speaker add-on wired on this server: shown as none, and its actions say so.
  assert.equal((await json('/api/meetings')).body.speakerAddon, null);
  assert.equal((await json('/api/meetings/speaker-addon', 'POST', { action: 'install' })).status, 404);
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const src = (f: string) => readFileSync(join(ROOT, 'src', f), 'utf8');

test('s2 ui: Meetings page parts, consent, search, playback, rename, drafts, desktop recording, Today tile', () => {
  const js = web('meetings.js');
  for (const s of ["t('Search the transcript')", "t('Rename')", "t('Open questions')", "t('Follow-up emails')", "t('Send')", "t('Save as a draft')", "t('Record this computer')", "t('Stop and write the notes')", "t('Nothing is sent until you press Send.')"]) assert.ok(js.includes(s), s);
  assert.match(js, /\/meetings\/upload/);
  assert.match(js, /\/part\?i=/);
  assert.match(js, /decodeAudioData/, 'other formats are turned into WAV pieces in the browser');
  assert.match(js, /currentTime = /, 'a line plays the recording from its time');
  assert.match(js, /SaraDesktop/, 'desktop recording goes through the app bridge');
  assert.match(js, /sara-meeting-file/);
  assert.doesNotMatch(js, /style=|\.style\./);
  const html = web('index.html');
  assert.match(html, /<section class="today-card td-tile" id="td-meetings" hidden/);
  assert.match(web('today.js'), /draw\('td-meetings', /);
  assert.match(src('today-layout.ts'), /'td-meetings'/);
  assert.match(src('today.ts'), /meetings\?\.todayTile\(\)/);
  assert.match(src('lean.ts'), /meeting_\(list\|summarize\)/);
  assert.match(src('pending.ts'), /'meeting_list', 'meeting_summarize'/);
  assert.match(html, /<input id="meet-remind" type="checkbox">/);
  assert.match(html, /<input id="meet-cloud" type="checkbox">/);
  const cpp = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'meeting-rec.cpp'), 'utf8');
  assert.match(cpp, /AUDCLNT_STREAMFLAGS_LOOPBACK/, 'the computer sound by WASAPI loopback');
  assert.match(cpp, /eCapture/, 'and the microphone');
  const main = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8');
  assert.match(main, /kind == L"meetingRec"/);
  assert.match(main, /sara-meeting-file/);
});
