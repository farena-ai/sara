// T45: an embedding model too slow for the computer. On the owner's server bge-m3 took over a
// minute for every index batch, so each one was thrown away whole and tried again a minute later,
// for ever. Batches now shrink until one fits, what fits is kept, and when even one text does not
// fit the index rests and says why.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { type EmbedTarget, PACE, embedPace, embedPaced, resetEmbedPace } from '../src/embeddings.ts';

/** An embeddings endpoint that takes `msPerText` for each text it is given. */
async function slowServer(msPerText: () => number): Promise<{ target: EmbedTarget; sizes: number[]; close: () => Promise<void> }> {
  const sizes: number[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const input = JSON.parse(body).input as string[];
      sizes.push(input.length);
      const timer = setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, index + 1] })) }));
      }, msPerText() * input.length);
      res.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    target: { config: { id: 'e', label: 'E', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, local: true }, model: 'slow-embed' },
    sizes,
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}

const texts = (n: number): string[] => Array.from({ length: n }, (_, i) => `note ${i}`);

function tuned(t: test.TestContext): void {
  const keep = { ...PACE };
  t.after(() => (Object.assign(PACE, keep), resetEmbedPace()));
  Object.assign(PACE, { limitMs: 400, slowMs: 200, quickMs: 120, restMs: 300 });
  resetEmbedPace();
}

test('T45 pace: a batch that runs out of time gets smaller until it fits, and what fits is kept', async (t) => {
  tuned(t);
  const s = await slowServer(() => 60);
  t.after(s.close);
  await assert.rejects(embedPaced(s.target, texts(32)), 'thirty-two at 60 ms each do not fit in 400 ms');
  assert.equal(embedPace(s.target).size, PACE.afterTimeout, 'straight down to a few, not a slow halving');
  const vecs = await embedPaced(s.target, texts(32));
  assert.equal(vecs.length, 4, 'the first four come back; the caller stores them and asks again');
  assert.deepEqual(s.sizes, [32, 4]);
  assert.equal(embedPace(s.target).size, 2, 'four took over half the limit: fewer next time');
});

test('T45 pace: a model that turns quick again gets its full batches back', async (t) => {
  tuned(t);
  let ms = 60;
  const s = await slowServer(() => ms);
  t.after(s.close);
  await assert.rejects(embedPaced(s.target, texts(32)));
  ms = 0;
  for (let i = 0; i < 5; i++) await embedPaced(s.target, texts(64));
  assert.deepEqual(s.sizes, [32, 4, 8, 16, 32, 64]);
  assert.equal(embedPace(s.target).size, Infinity);
});

test('T45 pace: when one text does not fit, the index rests and says the model is too slow', async (t) => {
  tuned(t);
  const s = await slowServer(() => 600);
  t.after(s.close);
  await assert.rejects(embedPaced(s.target, texts(2)));
  await assert.rejects(embedPaced(s.target, texts(2)));
  assert.equal(embedPace(s.target).resting, true);
  const before = s.sizes.length;
  await assert.rejects(embedPaced(s.target, texts(2)), /too slow on this computer/);
  assert.equal(s.sizes.length, before, 'while resting the model is not asked at all');
  await new Promise((ok) => setTimeout(ok, 320));
  assert.equal(embedPace(s.target).resting, false, 'and then it is tried again');
});

test('T45 pace: a caller who gives up teaches nothing about speed', async (t) => {
  tuned(t);
  const s = await slowServer(() => 60);
  t.after(s.close);
  await assert.rejects(embedPaced(s.target, texts(8), AbortSignal.timeout(30)));
  assert.equal(embedPace(s.target).size, Infinity);
});
