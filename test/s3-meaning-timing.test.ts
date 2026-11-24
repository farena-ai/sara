// S3: a slow embedding model (docs/TOOL_EVALS.md, "Third run": with one model loaded at a time, a
// message's vector took 2.5 to 6 seconds). Routing asks first and gives up; the tools then find
// the same call still running instead of starting another. And when vectors keep coming late,
// meaning rests, so a turn stops paying for model swaps that give it nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmbedTarget } from '../src/embeddings.ts';
import { MEANT, NOT_RESEARCH, RESEARCH_ASKS, ToolMeaning } from '../src/tool-meaning.ts';
import type { Tool } from '../src/tools/types.ts';

const target = (): EmbedTarget => ({ config: { id: 'e', label: 'E', kind: 'openai-compatible', baseUrl: 'http://x/v1', local: true }, model: 'fake-embed' });
const tool = { spec: { name: 'zebra_count', description: 'Counts the stripes on a zebra.', parameters: { type: 'object' } } } as unknown as Tool;
const strip = (s: string): string => s.replace(/^search_(query|document): /, '');
const known = new Set([...RESEARCH_ASKS, ...NOT_RESEARCH]);
/** Tools and asks answer at once; a message's vector takes `ms`. */
function slowEmbed(ms: () => number, calls: string[]) {
  return async (_t: EmbedTarget, texts: string[]) => {
    const first = strip(texts[0]!);
    const isMessage = texts.length === 1 && !known.has(first) && !/zebra/.test(first);
    if (isMessage) {
      calls.push(first);
      await new Promise((ok) => setTimeout(ok, ms()));
    }
    return texts.map((raw) => (/zebra|stripy/.test(raw) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1])));
  };
}

test('S3 timing: routing gives up on a slow vector; the tools use the same call a moment later', async () => {
  const calls: string[] = [];
  const m = new ToolMeaning(target, slowEmbed(() => 250, calls));
  const said = 'how stripy is that horse over there';
  const t0 = Date.now();
  assert.equal(await m.research(said, 60), false, 'not there in time: the words decide');
  assert.ok(Date.now() - t0 < 220, 'and the turn did not wait for it');
  assert.deepEqual(await m.pick(said, [tool], new Set(), 1000), ['zebra_count']);
  assert.deepEqual(calls, [said], 'one call for the message, not two');
});

test('S3 timing: vectors late three messages in a row: meaning rests, then tries again', async (t) => {
  const keep = { restMs: MEANT.restMs, lateLimit: MEANT.lateLimit };
  t.after(() => Object.assign(MEANT, keep));
  MEANT.restMs = 150;
  const calls: string[] = [];
  let ms = 300;
  const m = new ToolMeaning(target, slowEmbed(() => ms, calls));
  for (const n of [1, 2]) {
    assert.deepEqual(await m.pick(`how stripy is horse number ${n} today`, [tool], new Set(), 40), []);
    assert.equal(m.resting, false);
  }
  // The same message asked twice (routing, then tools) counts once.
  assert.equal(await m.research('how stripy is horse number 2 today', 40), false);
  assert.equal(m.resting, false);
  assert.deepEqual(await m.pick('how stripy is horse number 3 today', [tool], new Set(), 40), []);
  assert.equal(m.resting, true);
  assert.match(m.lastError ?? '', /too slowly 3 times in a row/);
  // Resting: nothing is asked of the embedding model at all.
  const before = calls.length;
  assert.deepEqual(await m.pick('how stripy is horse number 4 today', [tool], new Set(), 40), []);
  assert.equal(await m.research('how stripy is horse number 4 today', 40), false);
  assert.equal(calls.length, before);
  // Afterwards it tries again, and a vector in time clears the count.
  await new Promise((ok) => setTimeout(ok, 400));
  ms = 0;
  assert.equal(m.resting, false);
  assert.deepEqual(await m.pick('how stripy is horse number 5 today', [tool], new Set(), 500), ['zebra_count']);
  ms = 300;
  for (const n of [6, 7]) await m.pick(`how stripy is horse number ${n} today`, [tool], new Set(), 40);
  assert.equal(m.resting, false, 'two late after one in time is not three in a row');
});
