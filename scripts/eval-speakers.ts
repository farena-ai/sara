// U3.13 (docs/RESULTS.md "Speakers in meetings"): the speaker add-on on a generated 3-voice meeting.
// Windows only (two voices are Windows' own SAPI voices David and Zira; the third is the free Piper
// hfc_female voice through sherpa-onnx's TTS tool, both downloaded with the same pins Sara uses).
// Installs the REAL speaker add-on (src/speaker-addon.ts) into the work folder, builds a 52-second
// meeting (13 lines, pauses of 0.15-1.2 s: three hand-overs are shorter than a pause), and scores
// S2's pauses-and-pitch way against voice prints: speakers found, share of speech time given the
// right speaker (one-to-one mapping), lines right; plus one voice alone and a 10-minute part's time.
//   node scripts/eval-speakers.ts [--dir <work folder>] [--out docs/results/speakers.json]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { diarize, diarizeByVoice, readPcm, to16k, type Pcm } from '../src/meeting-audio.ts';
import { SpeakerAddon } from '../src/speaker-addon.ts';
import { downloadPinned, runTar, SHERPA_BUNDLES, VOICE_MODELS } from '../src/voice-install.ts';

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DIR = resolve(arg('--dir', join(tmpdir(), 'sara-eval-speakers')));
const OUT = arg('--out', '');
if (process.platform !== 'win32') throw new Error('Windows only (SAPI voices).');
mkdirSync(join(DIR, 'utt'), { recursive: true });

const addon = new SpeakerAddon(join(DIR, 'addon'));
if (addon.status().state !== 'ready') await addon.install();
// The TTS tool and the Piper voice (same pins as `sara voice install`).
const R = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
for (const item of [SHERPA_BUNDLES['win32-x64'], VOICE_MODELS.find((m) => m.path.includes('hfc_female'))!]) {
  const name = item.path.split('/').at(-1)!.replace(/\.tar\.bz2$/, '');
  if (existsSync(join(DIR, name))) continue;
  const file = join(DIR, `${name}.tar.bz2`);
  await downloadPinned(`${R}/${item.path}`, item.sha256, file);
  await runTar()(file, DIR);
}
const SAPI = join(DIR, 'sapi.ps1');
writeFileSync(SAPI, ['param([string]$Voice, [string]$Text, [string]$Out)', 'Add-Type -AssemblyName System.Speech', '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer', '$s.SelectVoice($Voice)', '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)', '$s.SetOutputToWaveFile($Out, $f)', '$s.Speak($Text)', '$s.Dispose()'].join('\n'));
const bin = join(DIR, 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release', 'bin');
const P = join(DIR, 'vits-piper-en_US-hfc_female-medium');
const say = (v: number, text: string, f: string) => {
  if (existsSync(f)) return;
  if (v < 2) spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAPI, '-Voice', ['Microsoft David Desktop', 'Microsoft Zira Desktop'][v], '-Text', text, '-Out', f]);
  else spawnSync(join(bin, 'sherpa-onnx-offline-tts.exe'), [`--vits-model=${P}/en_US-hfc_female-medium.onnx`, `--vits-tokens=${P}/tokens.txt`, `--vits-data-dir=${P}/espeak-ng-data`, `--output-filename=${f}`, text], { env: { ...process.env, PATH: `${bin};${process.env.PATH}` } });
  if (!existsSync(f)) throw new Error(`no audio for voice ${v}`);
};
const LINES: [number, string][] = [
  [0, 'Good morning everyone, let us start with the budget for next quarter.'],
  [1, 'Thanks. I looked at the numbers yesterday and travel is over by about ten percent.'],
  [2, 'That matches what I saw. Most of it was the conference in Denver.'],
  [0, 'Okay. Can we cut anything before the end of the month?'],
  [1, 'We could skip the second trip to Chicago.'],
  [2, 'I would rather keep Chicago, the client meeting there matters.'],
  [1, 'Fair enough. Then let us move the team dinner to January.'],
  [0, 'Good, that works for me. Next item is the launch date.'],
  [2, 'Marketing asked for two more weeks to finish the videos.'],
  [0, 'Two weeks is fine if the store listing is ready on time.'],
  [1, 'I will check with the store team today and send a note.'],
  [2, 'And I will update the plan and share it on Friday.'],
  [0, 'Great. Thanks everyone, that is all for today.'],
];
const GAPS = [0.9, 0.15, 1.1, 0.7, 0.15, 1.0, 0.8, 1.2, 0.15, 0.9, 0.6, 1.0];
const trim = (c: Float32Array) => {
  let a = 0;
  let z = c.length;
  while (a < z && Math.abs(c[a]) < 0.01) a++;
  while (z > a && Math.abs(c[z - 1]) < 0.01) z--;
  return c.subarray(a, z);
};
const load = (f: string) => {
  const p = readPcm(readFileSync(f));
  return trim(to16k(p.ch[0], p.rate));
};
const join16 = (xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) out.set(x, o), (o += x.length);
  return out;
};
const pieces: Float32Array[] = [];
const truth: { start: number; end: number; v: number }[] = [];
let at = 0;
for (const [i, [v, text]] of LINES.entries()) {
  const f = join(DIR, 'utt', `${i}.wav`);
  say(v, text, f);
  const x = load(f);
  truth.push({ start: at, end: at + x.length / 16000, v });
  pieces.push(x);
  at += x.length / 16000;
  if (i < GAPS.length) pieces.push(new Float32Array(Math.round(GAPS[i] * 16000))), (at += GAPS[i]);
}
const pcm: Pcm = { rate: 16000, ch: [join16(pieces)] };

function score(segs: { start: number; end: number; speaker: number }[]) {
  const at = (t: number) => segs.find((s) => t >= s.start && t < s.end)?.speaker ?? -1;
  const pts: [number, number][] = [];
  for (const u of truth) for (let t = u.start + 0.05; t < u.end; t += 0.1) pts.push([u.v, at(t)]);
  const labels = [...new Set(segs.map((s) => s.speaker))];
  let map = new Map<number, number>();
  let best = -1;
  const pick = (v: number, used: number[]) => {
    if (v === 3) {
      const m = new Map(used.map((g, i) => [i, g]));
      const n = pts.filter(([x, g]) => g === m.get(x)).length;
      if (n > best) (best = n), (map = m);
      return;
    }
    for (const g of [...labels, -100 - v]) if (!used.includes(g)) pick(v + 1, [...used, g]);
  };
  pick(0, []);
  const lines = truth.filter((u) => {
    const c = new Map<number, number>();
    for (let t = u.start + 0.05; t < u.end; t += 0.1) c.set(at(t), (c.get(at(t)) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1])[0][0] === map.get(u.v);
  }).length;
  return { speakers: labels.length, timeline: Math.round((best / pts.length) * 1000) / 10, lines: `${lines}/${truth.length}` };
}
const prints = (x: Float32Array, w: [number, number][]) => addon.prints(x, w);
const pitch = score(diarize(pcm, { byChannel: false }).segments);
let t0 = Date.now();
const voices = { ...score((await diarizeByVoice(pcm, prints)).segments), ms: Date.now() - t0 };
// One voice alone: every line said by David.
const solo = join16(LINES.flatMap(([, text], i) => (say(0, text, join(DIR, 'utt', `david-${i}.wav`)), [load(join(DIR, 'utt', `david-${i}.wav`)), new Float32Array(12800)])));
const oneVoice = new Set((await diarizeByVoice({ rate: 16000, ch: [solo] }, prints)).segments.map((s) => s.speaker)).size;
// A 10-minute part: the meeting 11 times.
const long = join16(Array.from({ length: 11 }, () => pcm.ch[0]));
t0 = Date.now();
const longSpeakers = new Set((await diarizeByVoice({ rate: 16000, ch: [long] }, prints)).segments.map((s) => s.speaker)).size;
const result = { date: new Date().toISOString().slice(0, 10), clipSec: Math.round(at * 10) / 10, voices: 'SAPI David, SAPI Zira, Piper hfc_female', model: '3dspeaker_speech_eres2net_sv_en_voxceleb_16k (CPU)', pauseAndPitch: pitch, voicePrints: voices, oneVoiceSpeakers: oneVoice, tenMinutePart: { minutes: Math.round((long.length / 16000 / 60) * 10) / 10, ms: Date.now() - t0, speakers: longSpeakers } };
console.log(JSON.stringify(result, null, 2));
if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
