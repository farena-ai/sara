// Phase 34: the personality studio (dials, life, starting points, one of a kind, tune by talking,
// stays-in-character checks).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { exportCharacter, parseCharacter } from '../src/characterfile.ts';
import { DriftStore, parseJudge } from '../src/drift.ts';
import { buildSystemPrompt, validatePersona } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { applyArchetype, applyRelationship, ARCHETYPES, createTuneTool, fillLifeQuick, makeUnique, savePersona, scenariosFor, surprise, tuneChange } from '../src/studio.ts';
import { LIFE_IDS, traitLines, TRAITS, traitWord } from '../src/traits.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-25T15:00:00Z') };
const app = makeApp(dir, clock);
app.drift = new DriftStore(app.store.db, () => clock.now);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
const base0 = app.persona;
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, method = 'GET', body?: unknown) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const ctx = { now: clock.now, ownerName: 'Alex' };

test('dials and life become plain instructions; middle settings add nothing; unknown values are dropped', () => {
  const p = validatePersona({ ...base0, traits: { teasing: 9, blunt: 1, warmth: 5, bogus: 3, fiery: 42 }, humour: 'dry', life: { job: 'pastry chef', hometown: 'grew up in Duluth', nope: 'x' } });
  assert.deepEqual(p.traits, { teasing: 9, blunt: 1, warmth: 5, fiery: 10 });
  assert.deepEqual(p.life, { job: 'pastry chef', hometown: 'grew up in Duluth' });
  const prompt = buildSystemPrompt(p, ctx);
  assert.match(prompt, /You tease a lot/);
  assert.match(prompt, /You are very gentle/);
  assert.match(prompt, /You are fiery/);
  assert.doesNotMatch(prompt, /You are warm:/, 'middle warmth adds no line');
  assert.match(prompt, /Your humour is dry/);
  assert.match(prompt, /## Your life\n- Work: pastry chef\n- Hometown: grew up in Duluth/);
  // The legal parts are still there whatever the dials say.
  assert.match(prompt, /Never deny being an AI when sincerely asked/);
  assert.match(prompt, /Never produce sexual content involving minors/);
  assert.equal(traitLines({ warmth: 5 }).length, 0);
  // Phase 114: Warmth's high end is now "Openly warm" (a strong band still reads as the end words).
  assert.equal(traitWord(TRAITS[0], 10), 'Openly warm');
  assert.equal(traitWord(TRAITS.find((t) => t.id === 'teasing')!, 7), 'Leaning: teases a lot');
  assert.equal(validatePersona({ ...base0, humour: 'nonsense' }).humour, undefined);
});

test('life details: childhood memories are fine; saying she is a minor is refused', () => {
  assert.ok(validatePersona({ ...base0, life: { hobbies: 'piano since she was 8; baking since she was 12 years old' } }).life);
  assert.throws(() => validatePersona({ ...base0, life: { quirks: "she's 16 and loves skating" } }), /adult/);
  assert.throws(() => validatePersona({ ...base0, life: { job: 'is a high school student' } }), /adult/);
  assert.throws(() => validatePersona({ ...base0, life: { job: 'x'.repeat(301) } }), /300/);
});

test('starting points keep who she is; two from the same starting point never match', () => {
  const start = applyArchetype(validatePersona({ ...base0, name: 'Mia', life: { job: 'nurse' } }), 'tease', 'Alex');
  assert.equal(start.name, 'Mia');
  assert.equal(start.archetype, 'tease');
  assert.equal(start.traits?.teasing, 9);
  assert.equal(start.life?.job, 'nurse', 'her own details are kept');
  assert.match(start.summary, /Alex's close friend/);
  const partner = applyRelationship(start, 'partner', 'Alex');
  assert.match(partner.summary, /affectionate partner/);
  assert.deepEqual(scenariosFor(partner).map((s) => s.id), ['greeting', 'bad-day', 'disagree', 'flirt']);
  assert.ok(!scenariosFor(start).some((s) => s.id === 'flirt'), 'no flirting sample for a friend');
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const u = makeUnique(start);
    for (const id of LIFE_IDS) assert.ok(u.life?.[id], `filled ${id}`);
    assert.equal(u.life?.job, 'nurse');
    const key = JSON.stringify([u.traits, u.life]);
    assert.ok(!seen.has(key), 'every version differs');
    seen.add(key);
  }
  const filled = fillLifeQuick(validatePersona({ ...base0, pronouns: 'he', name: 'Leo' }));
  assert.doesNotMatch(Object.values(filled.life ?? {}).join(' '), /\b(she|her)\b/i, 'pool details follow his pronouns');
  for (let i = 0; i < 10; i++) {
    const s = surprise({ pronouns: 'they' }, 'Alex');
    assert.ok(s.age >= 18 && s.name && ARCHETYPES.some((a) => a.id === s.archetype));
  }
  assert.equal(surprise({ name: 'Zed', pronouns: 'he' }, 'Alex').name, 'Zed');
});

test('saving: the "starts conversations" dial sets how often she may text first', () => {
  savePersona(app, validatePersona({ ...base0, traits: { initiative: 10 } }));
  assert.equal(app.settings.get().proactive?.maxPerDay, 4);
  assert.equal(app.settings.get().proactive?.minGapHours, 3);
  assert.ok(existsSync(join(dir, 'persona.json')));
  // Unchanged dial on a later save: the owner's own proactive numbers stay.
  app.settings.update({ proactive: { ...app.settings.get().proactive, maxPerDay: 1 } });
  savePersona(app, validatePersona({ ...app.persona, summary: 'Changed summary.' }));
  assert.equal(app.settings.get().proactive?.maxPerDay, 1);
  savePersona(app, base0);
});

test('tune by talking: she proposes a dial change (approval card text), it saves and shows in the dials', async () => {
  const tool = createTuneTool(() => app);
  assert.equal(tool.defaultPermission, 'ask');
  assert.equal(tuneChange(app.persona, { dial: 'teasing', direction: 'more' }).text, 'Teasing: 5 → 7 of 10 (Leaning: teases a lot)');
  assert.match(tool.summarize({ dial: 'affection', direction: 'less', steps: 3 }), /Shows affection: 5 → 2 of 10/);
  assert.throws(() => tuneChange(app.persona, { dial: 'nope' }), /Unknown dial/);
  const out = await tool.run({ dial: 'teasing', direction: 'more' }, {} as never);
  assert.match(out, /Done: Teasing: 5 → 7/);
  assert.equal(app.persona.traits?.teasing, 7);
  assert.equal(JSON.parse(readFileSync(join(dir, 'persona.json'), 'utf8')).traits.teasing, 7);
  await tool.run({ humour: 'sarcastic' }, {} as never);
  assert.equal(app.persona.humour, 'sarcastic');
  await assert.rejects(tool.run({ dial: 'teasing', direction: 'set', value: 7 }, {} as never), /already at 7/);
  savePersona(app, base0);
});

test('stays in character: a drifting reply gets a one-time nudge in the next reply; scores are kept', async () => {
  assert.deepEqual(parseJudge('ok {"score": 4, "note": "too formal"}'), { score: 4, note: 'too formal' });
  assert.equal(parseJudge('{"score": 42}'), undefined);
  app.settings.update({ persona: { ...app.settings.get().persona, inCharacter: 'every' } });
  const conv = app.store.createConversation();
  app.script.push(text('Certainly. How may I assist you today?'), text('{"score": 3, "note": "sounded like a formal assistant"}'));
  for await (const _ of runTurn(app, conv.id, 'hey you')) void _;
  await app.driftWork;
  const judge = app.requests.at(-1)!;
  assert.match(String(judge.messages[0].content), /Her reply:\nCertainly\. How may I assist you today\?/);
  assert.equal(app.drift!.pending(conv.id)?.score, 3);
  app.script.push(text('lol hi'), text('{"score": 9, "note": ""}'));
  for await (const _ of runTurn(app, conv.id, 'whats up')) void _;
  await app.driftWork;
  const turn2 = app.requests.at(-2)!;
  assert.match(String(turn2.messages[0].content), /## Be yourself\nYour last reply drifted from who you are \(sounded like a formal assistant\)/);
  app.script.push(text('same old'), text('{"score": 8, "note": ""}'));
  for await (const _ of runTurn(app, conv.id, 'cool')) void _;
  await app.driftWork;
  assert.doesNotMatch(String(app.requests.at(-2)!.messages[0].content), /## Be yourself/, 'the nudge is used once');
  const w = app.drift!.stats('2000-01-01');
  assert.deepEqual(w, { checks: 3, average: 6.7, drifted: 1 });
  // Off: no checks, no extra model calls.
  app.settings.update({ persona: { ...app.settings.get().persona, inCharacter: 'off' } });
  const before = app.requests.length;
  app.script.push(text('hi'));
  for await (const _ of runTurn(app, conv.id, 'again')) void _;
  assert.equal(app.requests.length, before + 1);
});

test('studio routes: choices, apply, one of a kind, surprise, fill, try samples, check setting, drift', async () => {
  const defs = await (await call('/api/persona/studio')).json();
  assert.equal(defs.traits.length, 25); // Phase 51: + the three work dials
  assert.ok(defs.traits.every((t: { tip: string; examples: string[] }) => t.tip && t.examples.length === 3), 'every dial has a ? tip and examples');
  assert.equal(defs.archetypes.length, 8);
  const applied = (await (await call('/api/persona/studio/apply', 'POST', { persona: base0, archetype: 'bookworm', talk: 'brief' })).json()).persona;
  assert.equal(applied.archetype, 'bookworm');
  assert.equal(applied.talk, 'brief');
  assert.equal((await call('/api/persona/studio/apply', 'POST', { persona: base0, archetype: 'nope' })).status, 400);
  assert.equal((await call('/api/persona/studio/apply', 'POST', { persona: { ...base0, age: 16 } })).status, 400);
  const unique = (await (await call('/api/persona/studio/unique', 'POST', { persona: applied })).json()).persona;
  assert.ok(unique.life.hometown);
  const surprised = (await (await call('/api/persona/studio/surprise', 'POST', { pronouns: 'he' })).json()).persona;
  assert.equal(surprised.pronouns, 'he');
  const filled = await (await call('/api/persona/studio/fill', 'POST', { persona: base0 })).json();
  assert.equal(filled.written, false);
  assert.ok(filled.persona.life.job);
  // The model writes the gaps (keeps what's there).
  app.script.push(text('{"job": "radio host", "hometown": "grew up in Tulsa"}'));
  const written = await (await call('/api/persona/studio/fill', 'POST', { persona: { ...base0, life: { hobbies: 'chess' } }, write: true })).json();
  assert.equal(written.written, true);
  assert.equal(written.persona.life.job, 'radio host');
  assert.equal(written.persona.life.hobbies, 'chess');
  // Try before saving: current and new side by side; nothing is saved.
  for (let i = 0; i < 6; i++) app.script.push(text(`reply ${i}`));
  const tried = await (await call('/api/persona/studio/try', 'POST', { persona: applied })).json();
  assert.deepEqual(tried.samples.map((s: { id: string }) => s.id), ['greeting', 'bad-day', 'disagree']);
  assert.ok(tried.samples.every((s: { before: string; after: string }) => s.before && s.after));
  assert.notEqual(app.persona.archetype, 'bookworm');
  assert.equal((await call('/api/persona/studio/check', 'PUT', { inCharacter: 'loud' })).status, 400);
  assert.deepEqual(await (await call('/api/persona/studio/check', 'PUT', { inCharacter: 'some' })).json(), { inCharacter: 'some' });
  const drift = await (await call('/api/persona/studio/drift')).json();
  assert.equal(drift.mode, 'some');
  assert.equal(drift.week.checks, 3);
  // Saving goes through the usual PUT, which keeps the new fields.
  const saved = await (await call('/api/persona', 'PUT', unique)).json();
  assert.equal(saved.persona.archetype, 'bookworm');
  assert.equal(app.persona.life?.hometown, unique.life.hometown);
});

test('character file: the new fields go into the file and come back', () => {
  savePersona(app, validatePersona({ ...base0, traits: { teasing: 8 }, humour: 'dry', life: { job: 'editor' }, archetype: 'bookworm', talk: 'brief', relationship: 'partner' }));
  const back = parseCharacter(JSON.parse(JSON.stringify(exportCharacter(app)))).persona;
  assert.deepEqual([back.traits, back.humour, back.life, back.archetype, back.talk, back.relationship], [{ teasing: 8 }, 'dry', { job: 'editor' }, 'bookworm', 'brief', 'partner']);
  savePersona(app, base0);
});

test('the guide (Help → Shaping your companion) shows every dial with low, middle and high examples', () => {
  const help = readFileSync(join(ROOT, 'web', 'help.html'), 'utf8');
  assert.match(help, /<h2 id="shaping">Shaping your companion<\/h2>/);
  for (const d of TRAITS) {
    const row = help.match(new RegExp(`<tr id="dial-${d.id}">([\\s\\S]*?)</tr>`))?.[1] ?? '';
    assert.ok(row.includes(d.label.replace(/&/g, '&amp;')), `guide row for ${d.id}`);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const e of d.examples) assert.ok(row.includes(esc(e)), `${d.id} example: ${e}`);
  }
});
