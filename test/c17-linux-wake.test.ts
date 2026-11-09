// C17: `sara wake` (desktop/linux/wake.ts), the parts that run without a microphone: arguments, the
// spotter's command line, reading its detections, the recorder choice, the end of a question, the
// WAV it sends and the pack check. A real desktop (PipeWire, PulseAudio) is an owner check.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { badFiles, packDir, parseArgs, parseDetection, pickTool, PLAYERS, recorderArgs, RECORDERS, Silence, spotterArgs, wavOf } from '../desktop/linux/wake.ts';
import { wavSeconds } from '../src/wake.ts';
import { MODEL_FILES } from '../src/wake-pack.ts';
import { tempDir } from './helpers.ts';

test('C17 linux · arguments: an HTTPS origin (HTTP only on loopback), ALSA default device', () => {
  assert.deepEqual(parseArgs(['--server', 'https://sara.example.com']), { server: 'https://sara.example.com', device: 'default' });
  assert.equal(parseArgs(['--server', 'http://127.0.0.1:7860', '--device', 'pipewire']).device, 'pipewire');
  assert.throws(() => parseArgs([]), /Usage: sara wake/);
  assert.throws(() => parseArgs(['--server', 'http://sara.example.com']), /HTTPS/);
  assert.throws(() => parseArgs(['--server', 'https://a:b@sara.example.com']), /origin/);
  assert.throws(() => parseArgs(['--server', 'https://sara.example.com', '--device', 'x; rm -rf ~']), /ALSA device/);
  assert.equal(packDir('/home/alex', {}), join('/home/alex', '.local', 'share', 'sara', 'wake', '1'));
});

test('C17 linux · the spotter runs with the same settings as the other apps and the server\'s keyword lines', () => {
  const a = spotterArgs('/p', '/p/keywords.txt', 'default');
  for (const x of ['--encoder=' + join('/p', 'encoder.int8.onnx'), '--num-threads=1', '--keywords-score=1.5', '--keywords-threshold=0.25', '--max-active-paths=4', '--keywords-file=/p/keywords.txt']) assert.ok(a.includes(x), x);
  assert.equal(a.at(-1), 'default');
});

test('C17 linux · detections: the label from the spotter\'s JSON or a bare line; nothing else counts', () => {
  assert.equal(parseDetection('{"start_time":1.2, "keyword": "W1", "timestamps": []}'), 'W1');
  assert.equal(parseDetection('0:W3'), 'W3');
  assert.equal(parseDetection('STOP'), 'STOP');
  assert.equal(parseDetection('Recording started!'), undefined);
  assert.equal(parseDetection('Use recording device: default'), undefined);
  assert.equal(parseDetection('W12'), undefined);
});

test('C17 linux · PipeWire first, then PulseAudio, then ALSA; 16 kHz mono 16-bit raw', () => {
  assert.equal(pickTool(RECORDERS, (n) => n !== 'pw-record'), 'parecord');
  assert.equal(pickTool(PLAYERS, () => false), undefined);
  assert.deepEqual(recorderArgs('pw-record'), ['--rate=16000', '--channels=1', '--format=s16', '-']);
  assert.ok(recorderArgs('arecord').includes('S16_LE'));
});

test('C17 linux · the end of a question: 0.8 s quiet after speech, 5 s of nothing, 15 s at most; a WAV the server reads', () => {
  const loud = new Int16Array(1600).fill(8000);
  const quiet = new Int16Array(1600);
  const s = new Silence();
  assert.equal(s.feed(loud), false);
  let done = false;
  for (let i = 0; i < 9 && !done; i++) done = s.feed(quiet);
  assert.equal(done, true);
  const n = new Silence();
  let k = 0;
  while (!n.feed(quiet)) k++;
  assert.equal(n.spoke, false);
  assert.ok(k >= 49 && k <= 51, String(k));
  const w = wavOf(Buffer.alloc(32000));
  assert.equal(wavSeconds(w), 1);
});

test('C17 linux · the pack check names every missing or changed file', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(badFiles(dir, MODEL_FILES), MODEL_FILES.map((f) => f.name));
    writeFileSync(join(dir, 'tokens.txt'), Buffer.alloc(MODEL_FILES[3].size));
    assert.ok(badFiles(dir, MODEL_FILES).includes('tokens.txt'));
  } finally {
    cleanup();
  }
});
