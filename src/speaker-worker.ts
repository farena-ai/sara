// U3.13: the speaker add-on's helper process (src/speaker-addon.ts starts it). Loads the sherpa-onnx
// Node add-on and the voice-print model from the add-on folder and prints one voice print per
// window. A separate process, so a native crash or a missing library never takes the server down.
// argv: <runtime dir> <model file> <threads>. stdin: 4-byte length, JSON {windows:[[start,end]...]}
// (seconds), then 16 kHz mono float32 samples. stdout: JSON {dim, prints}.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [runtime, model, threads] = process.argv.slice(2);
const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const all = Buffer.concat(chunks);
    const n = all.readUInt32LE(0);
    const { windows } = JSON.parse(all.toString('utf8', 4, 4 + n)) as { windows: [number, number][] };
    const raw = all.subarray(4 + n);
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length - (raw.length % 4))));
    const addon = createRequire(import.meta.url)(join(runtime, 'sherpa-onnx.node'));
    const h = addon.createSpeakerEmbeddingExtractor({ model, numThreads: Number(threads) || 2, debug: 0, provider: 'cpu' });
    const dim = addon.speakerEmbeddingExtractorDim(h) as number;
    const prints = windows.map(([a, b]) => {
      const s = addon.speakerEmbeddingExtractorCreateStream(h);
      addon.acceptWaveformOnline(s, { samples: samples.slice(Math.max(0, Math.floor(a * 16000)), Math.min(samples.length, Math.ceil(b * 16000))), sampleRate: 16000 });
      addon.inputFinished(s);
      if (!addon.speakerEmbeddingExtractorIsReady(h, s)) return [];
      return Array.from(addon.speakerEmbeddingExtractorComputeEmbedding(h, s, false) as Float32Array, (x) => Math.round(x * 1e4) / 1e4);
    });
    process.stdout.write(JSON.stringify({ dim, prints }));
  } catch (err) {
    process.stderr.write(String((err as Error).message ?? err));
    process.exitCode = 1;
  }
});
