// Model tests: the tasks. Every job has 10 to 12 tasks in two tiers; every check passes each right
// answer and fails each wrong one with a reason; limits stay low; the pictures are what the tasks say
// they are.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { JOBS } from '../src/modelpicks.ts';
import { HARD_TASKS, instantOf, sameCode } from '../src/model-test-hard.ts';
import { BARS, NOTE_LINES, SHAPES, SWITCHES, TABLE, barsPicture, notePicture, oddPicture, shapesPicture, switchesPicture, tablePicture } from '../src/model-test-pictures.ts';
import { cleanReply, jsonIn, sentenceCount, TASK_SET, TASKS, tasksFor, textPicture } from '../src/model-test-tasks.ts';
import { ALL_BAD, ALL_GOOD, BAD, GOOD, toyVector } from './t49-model-tests-fixtures.ts';

test('every job has 10 to 12 tasks, at least 4 of them hard; ids and prompts are unique; limits and output caps stay low', () => {
  assert.ok(Number.isInteger(TASK_SET) && TASK_SET >= 2);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  const prompts = TASKS.flatMap((t) => (t.kind === 'chat' ? [t.prompt] : []));
  assert.equal(new Set(prompts).size, prompts.length, 'the scripted models find a task by its prompt');
  for (const job of JOBS) {
    const n = tasksFor(job.id).length;
    assert.ok(n >= 10 && n <= 12, `${job.id} has ${n} tasks`);
    const hard = tasksFor(job.id).filter((t) => HARD_TASKS.includes(t)).length;
    assert.ok(hard >= 4, `${job.id} has ${hard} hard tasks`);
  }
  for (const t of TASKS) {
    assert.ok(t.limitMs <= 60_000, `${t.id} limit`);
    if (t.kind === 'chat') assert.ok(t.maxTokens <= 1200, `${t.id} output cap`);
    if (t.kind === 'chat' && t.jobs.includes('quick')) assert.ok(t.maxTokens <= 80 && t.limitMs <= 20_000, `${t.id} is quick`);
  }
  // Shared tasks: the tool calls count for talking, coding and planning; Private reuses the talking tasks.
  const reminder = TASKS.find((t) => t.id === 'tools-reminder')!;
  for (const j of ['chat', 'coding', 'planning', 'private'] as const) assert.ok(reminder.jobs.includes(j));
  for (const t of tasksFor('chat')) assert.ok(t.jobs.includes('private'), `${t.id} also for private`);
});

test('every chat task passes each right answer and fails each wrong one, each with a reason', async () => {
  const wrong: string[] = [];
  await Promise.all(
    TASKS.map(async (t) => {
      if (t.kind !== 'chat') return;
      if (!GOOD[t.id] || !BAD[t.id]) return void wrong.push(`${t.id} has no fixtures`);
      if (HARD_TASKS.includes(t) && ALL_BAD(t.id).length < 2) wrong.push(`${t.id} has fewer than two wrong answers`);
      for (const [i, a] of ALL_GOOD(t.id).entries()) {
        const good = await t.check({ text: a.text ?? '', calls: a.calls ?? [] });
        if (!good.pass || good.reason.length <= 2) wrong.push(`${t.id} right answer ${i + 1} failed: ${good.reason}`);
      }
      for (const [i, a] of ALL_BAD(t.id).entries()) {
        const bad = await t.check({ text: a.text ?? '', calls: a.calls ?? [] });
        if (bad.pass) wrong.push(`${t.id} wrong answer ${i + 1} passed: ${bad.reason}`);
        else if (bad.reason.length <= 2 || bad.reason.includes('\n')) wrong.push(`${t.id} wrong answer ${i + 1} has no one-line reason`);
      }
    }),
  );
  assert.deepEqual(wrong, []);
});

test('embedding tasks: near above every far passes, the other way fails; speed counts', () => {
  for (const t of TASKS) {
    if (t.kind !== 'embed') continue;
    const vecs = t.texts.map((s) => Float32Array.from(toyVector(s)));
    assert.equal(t.check(vecs, 50).pass, true, t.id);
    if (t.id === 'emb-speed') {
      assert.equal(t.check(vecs, 20_000).pass, false);
      assert.equal(t.check(vecs.slice(1), 50).pass, false);
    } else assert.equal(t.check([vecs[0], vecs[2], vecs[1], ...vecs.slice(3)], 50).pass, false, t.id);
  }
});

test('helpers: thinking is taken out, JSON is found in fences, sentences are counted, times in zones, code compared as written', () => {
  assert.equal(cleanReply('<think>hmm</think> Yellow'), 'Yellow');
  assert.deepEqual(jsonIn('Sure:\n```json\n{"a":[1]}\n```'), { a: [1] });
  assert.deepEqual(jsonIn('["B","C"]'), ['B', 'C']);
  assert.equal(jsonIn('no json here'), undefined);
  assert.equal(sentenceCount('One. Two! Three?'), 3);
  assert.equal(sentenceCount('Wait... then it rained.'), 1);
  const at = Date.UTC(2026, 2, 4, 0, 0);
  assert.equal(instantOf('2026-03-04T09:00', 'Asia/Tokyo'), at);
  assert.equal(instantOf('2026-03-04T00:00:00', 'Europe/London'), at);
  assert.equal(instantOf('2026-03-04T09:00+09:00', 'Europe/London'), at, 'an offset wins over the zone');
  assert.equal(instantOf('2026-03-04T09:00', 'Mars/Base'), undefined);
  assert.equal(sameCode("const a = ['x', 'y'];\n// note\nf(a,\n);"), sameCode('const a = ["x","y"]\nf(a)'));
});

test('the drawn pictures decode to the asked size with dark marks on a light ground', () => {
  const img = textPicture('2741');
  assert.equal(img.mime, 'image/png');
  const png = Buffer.from(img.data, 'base64');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  assert.equal(h, 110);
  assert.equal(w, 4 * 60 - 10 + 40);
  // Pixel data: some black, mostly white.
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  const raw = inflateSync(idat);
  let black = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0) black++;
  assert.ok(black > 1000 && black < raw.length / 2);
  for (const f of [shapesPicture, barsPicture, oddPicture, tablePicture, notePicture, switchesPicture]) {
    const b = Buffer.from(f().data, 'base64');
    assert.equal(b.subarray(1, 4).toString(), 'PNG', f.name);
    assert.ok(b.readUInt32BE(16) >= 300 && b.readUInt32BE(16) <= 500 && b.readUInt32BE(20) >= 100 && b.readUInt32BE(20) <= 400, f.name);
  }
});

test('the hard pictures hold what their tasks expect', () => {
  assert.equal(SHAPES.filter(([, , s, c]) => s === 'circle' && c === 'red').length, 4, 'four red circles');
  assert.equal(SHAPES.filter(([, , , c]) => c === 'red').length, 7, 'and three red squares to tell apart');
  const tallest = [...BARS].sort((a, b) => b[1] - a[1]);
  assert.equal(tallest[0][0], 'THU');
  assert.ok(tallest[0][1] - tallest[1][1] >= 10, 'tallest by at least 10 pixels');
  assert.equal(TABLE.find((r) => r[0] === 'PEAR')?.[2], '2.40');
  assert.deepEqual(NOTE_LINES, ['MEET AT 4:15', 'ROOM B12', 'BRING BADGE 7']);
  assert.deepEqual(SWITCHES.filter(([, on]) => !on).map(([n]) => n), ['BLUETOOTH', 'ALARMS']);
});
