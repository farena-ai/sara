// T47 D5: the fake voice worker answered "err" for any recording with "bad" in its name. The engine
// names its recordings with a random UUID, and about 1 in 190 UUIDs has "bad" in it, so a voice test
// failed now and then with "Voice tools could not start (ENOENT)" (w0-hearing.test.ts:123). It was
// never the load. The magic names are now exact: crash.wav, bad.wav, slow.wav.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { WarmWorker } from '../src/voice-warm.ts';
import { ROOT } from './helpers.ts';

const FAKE = join(ROOT, 'test', 'fixtures', 'fake-voice-worker.mjs');

test('T47 fake voice worker: a random recording name with "bad", "crash" or "slow" inside is heard; the exact names still fail', async (t) => {
  const w = new WarmWorker(() => ({ cmd: process.execPath, args: [FAKE, 'stt'], env: { ...process.env } }), { idleMs: () => 60_000, minFreeMb: 0 });
  t.after(() => w.stop());
  for (const name of ['9e18e3ca-3bad-4b83-90c2-9379a71a0adc.wav', 'bada99ef-d13c-4663-b49f-fe8f112c027a.wav', 'not-bad.wav', 'crashed.wav', 'slower.wav']) {
    assert.match(await w.ask(join('some', 'folder', name)), new RegExp(`^heard ${name.replace('.', '\\.')} by \\d+$`), name);
  }
  await assert.rejects(w.ask(join('some', 'folder', 'bad.wav')), /no audio/);
  assert.equal(w.state, 'ready');
  await assert.rejects(w.ask('crash.wav'), /stopped|exit/i);
});
