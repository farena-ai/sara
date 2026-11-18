// U3.13 better speaker separation (docs/design/U3SPEAK.md). Clustering on voice prints finds the
// number of speakers (1-8, extra voices merged and explained); synthetic multi-voice audio (formant
// "voices") through diarizeByVoice with a fake add-on that reads the audio; an end-to-end meeting
// upload with the add-on mocked (labels, renames, notices, fallbacks); the add-on's download is
// refused on a bad checksum or with "Nothing leaves this computer"; a real run when the add-on is
// installed (SARA_SPEAKER_ADDON_DIR).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { diarizeByVoice, readPcm } from '../src/meeting-audio.ts';
import { Meetings } from '../src/meetings.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { SPEAKER_MODEL, SpeakerAddon, runtimeFor, runtimeUrl } from '../src/speaker-addon.ts';
import { agglomerate, clusterVoices, cosine, MAX_SPEAKERS, segmentsOf, windowsOf } from '../src/speaker-cluster.ts';
import { fakeEngine, fakePrint, RATE, speak, voicesWav, type Turn } from './fixtures/u3speak-audio.ts';
import { makeApp, tempDir } from './helpers.ts';

/** Random unit-ish vectors around k centers (deterministic). */
function blobs(k: number, per: number, spread = 0.35, dim = 48): { vecs: number[][]; truth: number[] } {
  let s = 7;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const centers = Array.from({ length: k }, () => Array.from({ length: dim }, r));
  const vecs: number[][] = [];
  const truth: number[] = [];
  for (let i = 0; i < k * per; i++) {
    const c = i % k;
    vecs.push(centers[c].map((x) => x + spread * r()));
    truth.push(c);
  }
  return { vecs, truth };
}
/** Same grouping up to renumbering. */
function sameGroups(a: number[], b: number[]): boolean {
  const m = new Map<number, number>();
  const back = new Map<number, number>();
  return a.every((x, i) => (m.get(x) ?? (m.set(x, b[i]), b[i])) === b[i] && (back.get(b[i]) ?? (back.set(b[i], x), x)) === x);
}

test('u3speak clustering finds 1 to 8 speakers; more than 8 are merged and explained', () => {
  for (let k = 1; k <= 8; k++) {
    const { vecs, truth } = blobs(k, 6);
    const g = agglomerate(vecs);
    assert.equal(Math.max(...g.labels) + 1, k, `${k} voices`);
    assert.ok(sameGroups(g.labels, truth), `${k} voices grouped right`);
    assert.equal(g.labels[0], 0, 'numbered in order of first appearance');
  }
  const ten = blobs(10, 5);
  const g = agglomerate(ten.vecs);
  assert.equal(Math.max(...g.labels) + 1, MAX_SPEAKERS, 'never more than 8 speakers');
  assert.equal(g.merges.filter((x) => x.why === 'too-many').length, 2, 'the two extra voices are explained');
  assert.deepEqual(agglomerate([]).labels, []);
  assert.deepEqual(agglomerate([[1, 0]]).labels, [0]);
});

test('u3speak clustering keeps numbers across parts and explains alike voices', () => {
  const { vecs } = blobs(3, 6);
  const wins = vecs.map((_, i) => ({ start: i, end: i + 1, turn: i }));
  const first = clusterVoices(vecs.slice(0, 9), wins.slice(0, 9));
  assert.equal(first.centers.length, 3);
  // The second part starts with voice 2 (speaker 3): it keeps number 2, not 0.
  const later = clusterVoices([vecs[2], vecs[5], vecs[0]], wins.slice(0, 3), first.centers);
  assert.deepEqual(later.labels, [2, 2, 0]);
  assert.equal(later.centers.length, 3, 'no new speaker for known voices');
  // A new voice in a later part gets the next number.
  const fresh = blobs(1, 3, 0.1, 48).vecs.map((v) => v.map((x, i) => x * (i % 2 ? -1 : 1) + (i === 0 ? 5 : 0)));
  const next = clusterVoices([vecs[0], ...fresh], wins.slice(0, 4), first.centers);
  assert.equal(next.labels[0], 0);
  assert.equal(new Set(next.labels.slice(1)).size, 1);
  assert.equal(next.labels[1], 3, 'a new voice is speaker 4');
  // Two groups just above the line are merged and reported as a close call.
  const base = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0));
  const near = Array.from({ length: 16 }, (_, i) => (i === 0 ? 0.52 : i === 1 ? 0.85 : 0));
  const jitter = (v: number[], k: number) => v.map((x, i) => x + (i === 2 + k ? 0.05 : 0));
  const alike = clusterVoices([0, 1, 2, 3].map((k) => jitter(base, k)).concat([0, 1, 2, 3].map((k) => jitter(near, k))), Array.from({ length: 8 }, (_, i) => ({ start: i, end: i + 1, turn: i })));
  assert.equal(new Set(alike.labels).size, 1, 'kept as one voice');
  assert.equal(alike.merges[0]?.why, 'alike');
  assert.ok(cosine(base, near) > 0.45 && cosine(base, near) < 0.57);
});

test('u3speak windows and segments: a change of voice without a pause cuts the turn', () => {
  const w = windowsOf([{ start: 0, end: 6 }, { start: 7, end: 7.8 }]);
  assert.ok(w.every((x) => x.end - x.start <= 1.5 + 1e-9));
  assert.equal(w.at(-1)!.turn, 1);
  assert.equal(w.filter((x) => x.turn === 0).at(-1)!.end, 6, 'the last window reaches the end of the turn');
  const labels = w.map((x) => (x.turn === 0 && x.start >= 3 ? 1 : x.turn === 1 ? 1 : 0));
  const s = segmentsOf(w, labels);
  assert.equal(s.length, 3);
  assert.ok(Math.abs(s[0].end - 3.375) < 0.4 && s[1].start === s[0].end, `cut near 3 s: ${JSON.stringify(s)}`);
  assert.deepEqual(s.map((x) => x.speaker), [0, 1, 1]);
});

/** Speaker per second of a diarized clip vs the script (accuracy of the timeline, speech only). */
function timelineAccuracy(script: Turn[], segs: { start: number; end: number; speaker: number }[]): number {
  let t = 0;
  const truth: number[] = [];
  for (const [v, sec] of script) for (let i = 0; i < Math.round(sec * 10); i++, t += 0.1) truth.push(v);
  const got = truth.map((_, i) => segs.find((s) => i / 10 + 0.05 >= s.start && i / 10 + 0.05 < s.end)?.speaker ?? -1);
  // Best mapping: each true voice to the label it got most.
  const map = new Map<number, number>();
  for (const v of new Set(truth.filter((x) => x >= 0))) {
    const counts = new Map<number, number>();
    truth.forEach((x, i) => x === v && got[i] >= 0 && counts.set(got[i], (counts.get(got[i]) ?? 0) + 1));
    map.set(v, [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -2);
  }
  const speech = truth.map((v, i) => [v, i] as const).filter(([v]) => v >= 0);
  return speech.filter(([v, i]) => got[i] === map.get(v)).length / speech.length;
}

test('u3speak synthetic 3- and 5-voice clips: right count, ordered labels, a change without a pause', async () => {
  const e = fakeEngine();
  const three: Turn[] = [[0, 3], [-1, 1], [1, 2.5], [-1, 1], [2, 3], [-1, 1], [0, 2], [1, 2], [-1, 1], [2, 2]];
  const d3 = await diarizeByVoice(readPcm(voicesWav(three)), e.prints);
  assert.equal(d3.centers.length, 3, 'three voices');
  assert.deepEqual([...new Set(d3.segments.map((s) => s.speaker))], [0, 1, 2], 'Speaker 1 is heard first');
  const acc3 = timelineAccuracy(three, d3.segments);
  assert.ok(acc3 >= 0.9, `3 voices: ${acc3}`);
  const five: Turn[] = [[3, 2], [-1, 1], [4, 2], [-1, 0.8], [5, 2], [-1, 1], [6, 2.5], [-1, 1], [7, 2], [-1, 1], [3, 2], [-1, 1], [6, 2]];
  const d5 = await diarizeByVoice(readPcm(voicesWav(five, 3)), e.prints);
  assert.equal(d5.centers.length, 5, 'five voices');
  assert.ok(timelineAccuracy(five, d5.segments) >= 0.9);
  // 44.1 kHz input is brought to 16 kHz for the prints.
  const wav = voicesWav([[0, 2], [-1, 1], [1, 2]]);
  const up = Buffer.from(wav);
  up.writeUInt32LE(44100, 24);
  const d44 = await diarizeByVoice(readPcm(up), e.prints);
  assert.ok(d44.segments.length >= 1);
  // Silence: nothing.
  assert.deepEqual((await diarizeByVoice(readPcm(voicesWav([[-1, 3]])), e.prints)).segments, []);
});

const WORDS = ['We should move the launch to March.', 'Agreed, and who tells the client?', 'Marketing needs a new budget.', 'I can draft the email tonight.'];
const REFS = [0, 1, 2, 3].map((v) => fakePrint(speak(v, 1.5, 50)));

function rig(t: TestContext, engine: ReturnType<typeof fakeEngine> | undefined, prefs: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' }, meetings: prefs } as never);
  // A fake hearing engine: says the line of the voice the piece sounds most like.
  (app as { voice?: unknown }).voice = {
    available: { stt: true, tts: true },
    transcribe: async (wav: Buffer) => {
      const x = readPcm(wav).ch[0];
      const p = fakePrint(x.subarray(Math.floor(0.2 * RATE), Math.max(Math.floor(0.2 * RATE) + 1, x.length - Math.floor(0.2 * RATE))));
      const best = REFS.map((r, i) => [cosine(p, r), i] as const).sort((a, b) => b[0] - a[0])[0];
      return best[0] > 0.3 ? WORDS[best[1]] : '';
    },
  };
  setPolicy(new PolicyStore(dir));
  const meetings = new Meetings(app, app.store.db, { events: async () => [], ...(engine ? { speakers: engine } : {}) });
  app.meetings = meetings;
  t.after(() => {
    meetings.close();
    setPolicy(new PolicyStore());
    setPrivateLocal(false);
    app.store.close();
    cleanup();
  });
  return { app, meetings };
}
async function hearAll(meetings: Meetings, parts: Buffer[], channels = 'mixed') {
  const m = meetings.upload({ title: 'Planning', consent: true, name: 'plan.m4a', parts: parts.length, channels, seconds: 30 });
  for (const [i, p] of parts.entries()) await meetings.part(m.id, i, p);
  const end = Date.now() + 15000;
  for (;;) {
    const x = meetings.get(m.id)!;
    if (x.status !== 'hearing' && x.status !== 'live') return x;
    if (Date.now() > end) throw new Error(`timed out: ${x.status} ${x.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const said = (m: { lines: { kind: string; speaker: string; text: string }[] }) => m.lines.filter((l) => l.kind === 'said').map((l) => `${l.speaker}: ${l.text}`);
const notices = (m: { lines: { kind: string; text: string }[] }) => m.lines.filter((l) => l.kind === 'notice').map((l) => l.text);

test('u3speak end to end: an upload in two parts, four voices by voice print, steady labels, rename', async (t) => {
  const engine = fakeEngine();
  const { meetings } = rig(t, engine);
  const a = voicesWav([[0, 2.5], [-1, 1], [1, 2.5], [-1, 1], [2, 2.5], [-1, 1]], 1);
  // Part two: voice 3 first (it stays Speaker 3), then a new voice (Speaker 4), then voice 1.
  const b = voicesWav([[2, 2.5], [-1, 1], [3, 2.5], [-1, 1], [0, 2.5], [-1, 1]], 9);
  const m = await hearAll(meetings, [a, b]);
  // (The notes need a model, which this test has none of: only the transcript matters here.)
  assert.ok(m.status !== 'hearing', m.error ?? '');
  assert.deepEqual(said(m), [`Speaker 1: ${WORDS[0]}`, `Speaker 2: ${WORDS[1]}`, `Speaker 3: ${WORDS[2]}`, `Speaker 3: ${WORDS[2]}`, `Speaker 4: ${WORDS[3]}`, `Speaker 1: ${WORDS[0]}`]);
  assert.match(notices(m).join('\n'), /told apart by their voices/);
  assert.equal(engine.calls.prints, 2);
  const lines = m.lines.filter((l) => l.kind === 'said');
  assert.ok(lines[3].t! >= lines[2].t!, 'running times across parts');
  const r = meetings.rename(m.id, 'Speaker 4', 'Kim');
  assert.match(said(r).join('\n'), /Kim: I can draft/);
  assert.equal(meetings.speakerAddon()?.state, 'ready');
  assert.equal(meetings.speakerAddon()?.on, true);
});

test('u3speak fallbacks: missing add-on downloads on first use, a crash, stereo, switched off', async (t) => {
  const clip = voicesWav([[0, 2.5], [-1, 1], [1, 2.5], [-1, 1], [2, 2.5], [-1, 1]], 2);
  // Missing: the download starts, this recording uses pauses and pitch (at most two voices).
  const missing = fakeEngine('missing');
  const r1 = rig(t, missing);
  const m1 = await hearAll(r1.meetings, [clip]);
  assert.equal(missing.calls.ensure, 1);
  assert.equal(missing.calls.prints, 0);
  assert.match(notices(m1).join('\n'), /downloading \(about 40 MB\)/);
  assert.ok(new Set(m1.lines.filter((l) => l.kind === 'said').map((l) => l.speaker)).size <= 2);
  // A crash in the add-on: the part is still heard, with a notice.
  const broken = fakeEngine();
  broken.fail = true;
  const r2 = rig(t, broken);
  const m2 = await hearAll(r2.meetings, [clip]);
  assert.match(notices(m2).join('\n'), /stopped, so this part was split by pauses/);
  assert.ok(said(m2).length >= 1);
  // The desktop app's stereo keeps the channel way; switched off in Settings: never used.
  const e3 = fakeEngine();
  const r3 = rig(t, e3);
  const stereo = Buffer.from(clip);
  await hearAll(r3.meetings, [stereo], 'speakers').catch(() => undefined);
  assert.equal(e3.calls.prints, 0, 'stereo: by channel');
  const e4 = fakeEngine('missing');
  const r4 = rig(t, e4, { speakers: false });
  await hearAll(r4.meetings, [clip]);
  assert.equal(e4.calls.prints + e4.calls.ensure, 0, 'off: no download, no prints');
  assert.equal(r4.meetings.speakerAddon()?.on, false);
  // Settings actions.
  assert.equal(r4.meetings.speakerAddonAction('install')?.state, 'installing');
  assert.equal(r4.meetings.speakerAddonAction('remove')?.state, 'missing');
  assert.throws(() => r4.meetings.speakerAddonAction('zap'), /Unknown/);
});

test('u3speak add-on download: pinned per system, a bad checksum keeps nothing, private mode refuses', async (t) => {
  assert.ok(runtimeFor('win32', 'x64') && runtimeFor('linux', 'x64') && runtimeFor('darwin', 'arm64') && runtimeFor('linux', 'arm64'));
  assert.equal(runtimeFor('freebsd', 'x64'), undefined);
  assert.match(runtimeUrl(runtimeFor('linux', 'x64')!), /^https:\/\/registry\.npmjs\.org\/sherpa-onnx-linux-x64\/-\/sherpa-onnx-linux-x64-2\.0\.1\.tgz$/);
  assert.match(SPEAKER_MODEL.path, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const asked: string[] = [];
  const fakeFetch = (async (url: string) => (asked.push(String(url)), new Response('not the real file'))) as unknown as typeof fetch;
  const a = new SpeakerAddon(join(dir, 'sa'), { platform: 'linux', arch: 'x64', fetch: fakeFetch });
  assert.equal(a.status().state, 'missing');
  await assert.rejects(a.install(), /didn't match/);
  assert.equal(a.status().state, 'failed');
  assert.equal(existsSync(join(dir, 'sa', '.partial')), false, 'nothing half-done kept');
  assert.equal(asked.length, 1);
  await assert.rejects(a.prints(new Float32Array(16000), [[0, 1]]), /not installed/);
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  await assert.rejects(new SpeakerAddon(join(dir, 'sb'), { platform: 'linux', arch: 'x64', fetch: fakeFetch }).install(), /Nothing leaves this computer/);
  assert.equal(asked.length, 1, 'no download in private mode');
  assert.equal(new SpeakerAddon(join(dir, 'sc'), { platform: 'freebsd', arch: 'x64' }).status().state, 'unsupported');
});

test('u3speak real add-on (only when SARA_SPEAKER_ADDON_DIR points at an installed one)', { skip: !process.env.SARA_SPEAKER_ADDON_DIR }, async () => {
  const a = new SpeakerAddon(process.env.SARA_SPEAKER_ADDON_DIR!);
  assert.equal(a.status().state, 'ready');
  const x = readPcm(voicesWav([[0, 2], [-1, 0.5], [1, 2]])).ch[0];
  const p = await a.prints(x, [[0, 2], [2.5, 4.5]]);
  assert.equal(p.length, 2);
  assert.ok(p[0].length >= 128);
});

test('u3speak ui: Settings → Voice → Meetings has the switch with a tip, its state and actions', () => {
  const root = join(import.meta.dirname, '..');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  assert.match(html, /<input id="meet-speakers" type="checkbox"> Better speaker separation <button type="button" class="tip" data-tip="[^"]+">\?<\/button>/);
  assert.match(html, /id="meet-speakers-row" class="small" hidden>.*id="meet-speakers-get".*id="meet-speakers-remove"/);
  const js = readFileSync(join(root, 'web', 'meetings.js'), 'utf8');
  assert.match(js, /\/meetings\/speaker-addon/);
  assert.match(js, /\['#meet-speakers', 'speakers'\]/);
  for (const s of ["t('Ready on this computer.')", "t('Downloading (about {mb} MB)…'"]) assert.ok(js.includes(s), s);
  assert.doesNotMatch(js.slice(js.indexOf('function drawSpeakerAddon')), /style=|\.style\./);
  assert.match(readFileSync(join(root, 'web', 'app.js'), 'utf8'), /loadMeetingPrefs\(\)\.catch/, 'Settings loads the meeting prefs (they were never loaded before U3.13)');
});
