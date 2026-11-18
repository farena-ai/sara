// S11 (docs/WRITING_STYLE.md): "Write like a person". The deterministic checker in six languages, the
// facts lock (numbers, names, quotes, citations, links), the rewrite flow with a scripted model (retry,
// sentence repair, length, "didn't improve"), Match my voice style cards (each person's own), the
// humanize_text tool, make_document's style option, kid mode coaching, the routes and the UI wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { checkText, coachFeedback, diffWords, extractStyleCard, factsLock, humanize, isAssignment, repairFacts, styleCardNote, writingFor, writingNote } from '../src/humanize.ts';
import { createHumanizeTool } from '../src/tools/humanize.ts';
import { createMakeDocumentTool } from '../src/tools/make-document.ts';
import { KID_TOOLS, kidNote } from '../src/family.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const KID = { band: '10-12' as const, bedtime: null, minutesPerDay: 0, shopAllow: [], topics: true } as never;

function rig(t: TestContext): TestApp {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-16T15:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC' } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}
const asKid = (app: TestApp) => {
  (app as unknown as { member: unknown }).member = { child: () => KID };
};

const STIFF_EN = "In today's fast-paced world, it's important to note that gardening is a testament to patience. Moreover, we must delve into the rich tapestry of soil, water, and light. Furthermore, the results are truly incredibly rewarding. In conclusion, gardening matters — a lot — for everyone.";
const PLAIN_EN = 'My tomatoes took nine weeks this year. The first ones split after a heavy rain, so I picked the rest early and let them ripen on the windowsill. They tasted fine. Next spring I will water less and stake them sooner.';

test('S11 checker: stock phrases, em-dashes, triplets and flat rhythm are counted; plain writing reads natural', () => {
  const stiff = checkText(STIFF_EN);
  const plain = checkText(PLAIN_EN);
  assert.equal(stiff.lang, 'en');
  const kinds = new Set(stiff.flags.map((f) => f.kind));
  for (const k of ['phrase', 'em-dash', 'triplet', 'intensifier']) assert.ok(kinds.has(k as never), k);
  const phrases = stiff.flags.filter((f) => f.kind === 'phrase').map((f) => f.text);
  for (const p of ["in today's fast-paced", "it's important to note", 'testament to', 'delve', 'tapestry', 'moreover', 'furthermore', 'in conclusion']) assert.ok(phrases.includes(p), p);
  assert.ok(stiff.flags.every((f) => f.count >= 1));
  assert.ok(stiff.emDashPer1k > 0);
  assert.ok(stiff.score < 50, `stiff ${stiff.score}`);
  assert.ok(plain.score >= 80, `plain ${plain.score}`);
  assert.equal(plain.label, 'natural');
  assert.equal(stiff.label, 'stiff');
  // Flat rhythm: many sentences of the same length.
  const flat = checkText(Array.from({ length: 8 }, (_, i) => `The garden plot number ${i} has six rows of beans.`).join(' '));
  assert.ok(flat.flags.some((f) => f.kind === 'rhythm'));
  // Headings everywhere in a short piece.
  assert.ok(checkText('# Plan\n\n## Why\n\nShort.\n\n## How\n\nAlso short.\n\n## When\n\nSoon.').flags.some((f) => f.kind === 'headings'));
  // Hedging stacks.
  assert.ok(checkText('It may potentially be possible that this could perhaps work, arguably.').flags.some((f) => f.kind === 'hedge'));
});

test('S11 checker: phrase lists in Spanish, French, German, Portuguese and Italian', () => {
  const cases: [string, string, string][] = [
    ['es', 'Es importante destacar que el jardín es un testimonio de paciencia. Además, la tierra y el agua son para todos. En conclusión, los resultados son para el pueblo.', 'es importante destacar'],
    ['fr', "Il est important de noter que le jardin est un témoignage de patience. De plus, les plantes et le sol sont pour vous. En conclusion, votre jardin est une passion.", 'il est important de noter'],
    ['de', 'Es ist wichtig zu beachten, dass der Garten ein Zeugnis der Geduld ist. Darüber hinaus ist die Erde für die Pflanzen nicht unwichtig. Zusammenfassend ist das ein Garten mit Herz.', 'es ist wichtig zu beachten'],
    ['pt', 'É importante ressaltar que o jardim é um testemunho de paciência. Além disso, a terra dos canteiros não é para você. Em conclusão, os resultados são da sua família.', 'é importante ressaltar'],
    ['it', "È importante sottolineare che il giardino è una testimonianza di pazienza. Inoltre, la terra della serra è per il suo orto. In conclusione, il giardino è una passione per sempre.", 'è importante sottolineare'],
  ];
  for (const [lang, sample, phrase] of cases) {
    const r = checkText(sample);
    assert.equal(r.lang, lang, lang);
    const found = r.flags.filter((f) => f.kind === 'phrase').map((f) => f.text);
    assert.ok(found.includes(phrase), `${lang}: ${found.join(', ')}`);
    assert.ok(found.length >= 3, `${lang}: ${found.join(', ')}`);
    assert.ok(r.score < checkText(PLAIN_EN).score, lang);
  }
});

test('S11 facts lock: numbers, names, quotes, citations and links must survive; invented ones are caught', () => {
  const before = 'Maria Lopez planted 12 rows in 2024 [1]. She said "water at dawn" and the guide at https://example.org/soil agrees [2].';
  assert.equal(factsLock(before, before).ok, true);
  const ok = 'In 2024 Maria Lopez put in 12 rows [1]. "water at dawn," she said, and https://example.org/soil backs her up [2].';
  assert.equal(factsLock(before, ok).ok, true, JSON.stringify(factsLock(before, ok)));
  const bad = 'Maria planted 14 rows in 2024 [1]. She said "water early" and a guide agrees.';
  const lock = factsLock(before, bad);
  assert.equal(lock.ok, false);
  for (const m of ['12', '"water at dawn"', '[2]', 'https://example.org/soil', 'Maria Lopez']) assert.ok(lock.missing.includes(m), `missing ${m}: ${lock.missing.join(' | ')}`);
  assert.ok(lock.added.includes('14'), 'an invented number');
  // Sentence repair keeps the original sentences for the broken spans.
  const fixed = repairFacts(before, 'Maria Lopez put in 14 rows in 2024 [1]. She told everyone to water early.');
  assert.equal(factsLock(before, fixed).ok, true, fixed);
  assert.ok(fixed.includes('She said "water at dawn"'));
});

test('S11 rewrite: a scripted model, the rules in the prompt, scores before/after and the changed spans', async (t) => {
  const app = rig(t);
  const before = 'Moreover, it is important to note that the plan costs $1,200 [1]. Furthermore, Dana Wu will delve into the details on May 4.';
  app.script.push(text('The plan costs $1,200 [1]. Dana Wu will go through the details on May 4.'));
  const r = await humanize(app, before);
  assert.equal(r.kept, 'rewrite');
  assert.equal(r.facts.ok, true);
  assert.ok(r.check.after.score > r.check.before.score);
  assert.ok(r.changes.some((c) => c.type === 'del' && /Moreover/.test(c.text)));
  assert.ok(r.changes.some((c) => c.type === 'same'));
  const sys = app.requests.at(-1)!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  for (const rule of ['delve', 'rule-of-three', 'em-dash', 'Keep every number', '15%']) assert.ok(sys.includes(rule), rule);
  assert.ok(!/detector/i.test(sys), 'never framed as detector evasion');
});

test('S11 rewrite: a broken fact gets one retry, then the original sentences are kept for those spans', async (t) => {
  const app = rig(t);
  const before = 'Moreover, the roof cost $8,400 in 2023. Furthermore, the inspector, Sam Ortiz, said it would last 20 years. In conclusion, it was worth it.';
  app.script.push(text('The roof was about $8,000 in 2023. Sam Ortiz, the inspector, gave it 20 years. It was worth it.'));
  app.script.push(text('The roof cost $8,400 in 2023. The inspector gave it 25 years. It was worth it.'));
  const r = await humanize(app, before);
  assert.equal(app.requests.length, 2, 'one retry');
  assert.equal(r.kept, 'repaired');
  assert.equal(r.facts.ok, true);
  assert.ok(r.after.includes('Sam Ortiz') && r.after.includes('20 years'), r.after);
  assert.ok(!r.after.includes('25'), r.after);
  assert.ok(r.after.includes('$8,400'));
});

test('S11 rewrite: a reply that does not read better, or wanders far from the length, keeps the text as written', async (t) => {
  const app = rig(t);
  app.script.push(text(STIFF_EN + ' Moreover, delve deeper.'), text(STIFF_EN + ' Moreover, delve deeper.'));
  const same = await humanize(app, PLAIN_EN);
  assert.equal(same.kept, 'original');
  assert.equal(same.after, PLAIN_EN);
  const app2 = rig(t);
  const long = Array.from({ length: 6 }, () => PLAIN_EN).join(' ');
  app2.script.push(text('Short.'), text('Short.'));
  const short = await humanize(app2, long);
  assert.equal(short.kept, 'original');
  assert.match(short.reason ?? '', /length/);
});

test('S11 Match my voice: a style card from samples, applied in the prompt, kept per person', async (t) => {
  const card = extractStyleCard(["Honestly? I don't love long meetings. We'd get more done on a quick call. Coffee first, though!", "I'm not sure the budget works. Let's check the numbers again tomorrow, okay? Coffee helps.", 'Quick note: the coffee machine is broken again. I\'ll call the repair folks.']);
  assert.equal(card.samples, 3);
  assert.equal(card.contractions, 'often');
  assert.equal(card.formality, 'casual');
  assert.ok(card.favorites.includes('coffee'));
  assert.ok(card.avgSentence > 3 && card.avgSentence < 15);
  assert.ok(card.punctuation.includes('questions') && card.punctuation.includes('exclamations'));
  const note = styleCardNote(card);
  assert.match(note, /contractions/);
  assert.ok(note.length < 600);
  // Each space keeps its own card (a household member's lives in their own store).
  const owner = rig(t);
  const member = rig(t);
  writingFor(owner).setCard(card);
  writingFor(owner).setStyle('natural');
  assert.equal(writingFor(member).get().card, null);
  assert.equal(writingFor(member).get().style, 'as-written');
  assert.equal(writingFor(owner).get().style, 'natural');
  owner.script.push(text('Coffee first. The meeting can wait.'));
  await humanize(owner, 'Moreover, it is important to note that the meeting is important.', { voice: true });
  assert.ok(owner.requests.at(-1)!.messages.some((m) => typeof m.content === 'string' && m.content.includes('contractions')));
  assert.equal(writingNote(member), undefined, 'As written: no note');
  assert.match(writingNote(owner) ?? '', /like a person/);
  assert.throws(() => extractStyleCard([]), /sample/);
  assert.throws(() => extractStyleCard(Array.from({ length: 6 }, () => PLAIN_EN)), /5/);
});

test('S11 humanize_text tool: rewrites for an adult; coaches a child (suggestions, never a rewrite)', async (t) => {
  const app = rig(t);
  const tool = createHumanizeTool(() => app);
  assert.equal(tool.spec.name, 'humanize_text');
  app.script.push(text('The plan costs $1,200 [1]. Dana Wu will go through it on May 4.'));
  const out = String(await tool.run({ text: 'Moreover, it is important to note that the plan costs $1,200 [1]. Furthermore, Dana Wu will delve into it on May 4.' }, {} as never));
  assert.match(out, /Dana Wu will go through it on May 4/);
  assert.match(out, /reads natural/i);
  const kid = rig(t);
  asKid(kid);
  const before = kid.requests.length;
  const coach = String(await createHumanizeTool(() => kid).run({ text: 'My book report. Moreover, the book is a testament to friendship. In conclusion, it is good, nice, and fun.' }, {} as never));
  assert.equal(kid.requests.length, before, 'no model rewrite for a child');
  assert.match(coach, /suggestions/i);
  assert.match(coach, /Moreover/);
  assert.ok(KID_TOOLS.has('humanize_text'));
  assert.match(kidNote(KID, 'Mia'), /book report/);
  const fb = coachFeedback('In conclusion, the book is a testament to friendship, loyalty, and courage.');
  assert.ok(fb.suggestions.length >= 2);
  assert.ok(fb.questions.length >= 2);
  assert.ok(isAssignment('Can you write my book report on Hatchet?'));
  assert.ok(isAssignment('Escribe mi tarea de historia'));
  assert.ok(isAssignment('Schreib meinen Aufsatz'));
  assert.ok(!isAssignment('Make a grocery list for the week'));
});

test('S11 make_document: style natural rewrites prose formats; a child gets coaching, not a written assignment', async (t) => {
  const app = rig(t);
  const tool = createMakeDocumentTool(() => app);
  assert.ok((tool.spec.parameters as { properties: Record<string, unknown> }).properties.style, 'a style option');
  app.script.push(text('# Garden notes\n\nThe beds need 3 bags of compost. Start on May 4.'));
  const out = String(await tool.run({ format: 'md', title: 'Garden notes', content: '# Garden notes\n\nMoreover, it is important to note that the beds need 3 bags of compost. Furthermore, we will delve in on May 4.', style: 'natural' }, {} as never));
  assert.match(out, /Made/);
  assert.match(out, /sound human|natural/i);
  const kid = rig(t);
  asKid(kid);
  const kt = createMakeDocumentTool(() => kid);
  const essay = Array.from({ length: 12 }, () => 'The boy in the story learns to survive alone in the woods after the plane crash.').join(' ');
  await assert.rejects(() => kt.run({ format: 'docx', title: 'Book report: Hatchet', content: essay }, {} as never), /outline|own words|coach/i);
  const outline = await kt.run({ format: 'md', title: 'Book report outline', content: '# Book report outline\n\n- Who is the main character?\n- What problem does he face?\n- What changes by the end?' }, {} as never);
  assert.match(String(outline), /Made/);
});

async function server(t: TestContext, app: TestApp, member = false) {
  const auth = new OwnerAuth(app.dataDir);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(member ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Mia', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  });
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
}

test('S11 routes: style default, voice card, humanize with before/after, members keep their own', async (t) => {
  const app = rig(t);
  app.settings.update({ disclosureAcceptedAt: app.now().toISOString() });
  const api = await server(t, app);
  assert.deepEqual((await api('/api/writing')).body, { style: 'as-written', card: null });
  assert.equal((await api('/api/writing', 'PUT', { style: 'natural' })).body.style, 'natural');
  assert.equal((await api('/api/writing', 'PUT', { style: 'shouty' })).status, 400);
  const v = await api('/api/writing/voice', 'POST', { samples: ["I don't mind rain. It's quiet. Coffee tastes better then!", "We'll go anyway, won't we? Coffee first."] });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.card.samples, 2);
  assert.equal((await api('/api/writing/voice', 'POST', { samples: [] })).status, 400);
  app.script.push(text('The plan costs $1,200 [1]. Dana Wu will go through it on May 4.'));
  const h = await api('/api/writing/humanize', 'POST', { text: 'Moreover, it is important to note that the plan costs $1,200 [1]. Furthermore, Dana Wu will delve into it on May 4.' });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.kept, 'rewrite');
  assert.ok(h.body.check.after.score > h.body.check.before.score);
  assert.ok(Array.isArray(h.body.changes));
  assert.equal((await api('/api/writing/check', 'POST', { text: STIFF_EN })).body.label, 'stiff');
  // A research report: Make it sound human, then Keep replaces the report text.
  let report = 'Moreover, it is important to note that the plan costs $1,200 [1]. Furthermore, Dana Wu will delve into it on May 4.';
  (app as unknown as { research: unknown }).research = { get: (id: number) => (id === 7 ? { id, report } : undefined), replaceReport: (id: number, md: string) => ((report = md), { id }) };
  app.script.push(text('The plan costs $1,200 [1]. Dana Wu will go through it on May 4.'));
  const rh = await api('/api/writing/humanize', 'POST', { researchId: 7 });
  assert.equal(rh.body.kept, 'rewrite', JSON.stringify(rh.body));
  assert.equal((await api('/api/writing/keep', 'POST', { researchId: 7, text: rh.body.after })).status, 200);
  assert.equal(report, rh.body.after);
  assert.equal((await api('/api/writing/voice', 'DELETE')).status, 200);
  assert.equal((await api('/api/writing')).body.card, null);
  // A household member: their own space, their own style card.
  const m = rig(t);
  m.settings.update({ disclosureAcceptedAt: m.now().toISOString() });
  const mapi = await server(t, m, true);
  assert.equal((await mapi('/api/writing')).status, 200);
  assert.equal((await mapi('/api/writing')).body.style, 'as-written');
  assert.equal(writingFor(app).get().style, 'natural');
});

test('S11 diff: changed spans for the side-by-side view', () => {
  const d = diffWords('The cat sat on the mat.', 'The cat lay on the mat.');
  assert.deepEqual(d.filter((x) => x.type !== 'same').map((x) => [x.type, x.text.trim()]), [['del', 'sat'], ['add', 'lay']]);
});

test('S11 UI: the button on made documents and research reports, the side-by-side view, the Settings section', () => {
  const card = web('doc-card.js');
  assert.match(card, /Make it sound human/);
  assert.match(web('research.js'), /Make it sound human/);
  const hz = web('humanize.js');
  for (const s of ['Before', 'After', 'Keep', 'Undo', 'Match my voice', 'Reads natural']) assert.ok(hz.includes(`'${s}`), s);
  assert.ok(!/detector/i.test(hz));
  const html = web('index.html');
  for (const id of ['wr-style', 'wr-samples', 'wr-lib', 'wr-make', 'wr-forget']) assert.ok(html.includes(`id="${id}"`), id);
  const tips = JSON.parse(web('tips.json'));
  for (const id of ['wr-style', 'wr-samples', 'wr-lib']) assert.ok(tips.tips?.[id] ?? tips[id], `tip ${id}`);
  assert.ok(!/style="/.test(hz), 'no inline styles');
  const doc = readFileSync(join(ROOT, 'docs', 'WRITING_STYLE.md'), 'utf8');
  assert.ok(!/evad|evasion|bypass/i.test(doc.replace(/not (built|sold|framed)[^.]*\./gi, '')), 'not framed as detector evasion');
});

// U1.1 real-model run: "Make this sound more human" (no document word in the message) never offered
// humanize_text, so the model rewrote by hand with no facts lock.
test('S11 lean picker: everyday phrasings offer humanize_text', async (t) => {
  const { planFor } = await import('../src/lean.ts');
  const app = rig(t);
  app.tools.add(createHumanizeTool(() => app));
  app.settings.update({ lean: { tools: { mode: 'always' } } } as never);
  for (const say of ['Make this sound more human, but keep every fact: Dear Ms. Rivera, the heater is broken.', 'Can you make this less robotic? We met on May 2.', 'This sounds too much like AI, fix the wording: hello team.', 'humanize this: hi']) {
    const conv = app.store.createConversation({});
    assert.ok(planFor(app, conv, say).offered.has('humanize_text'), say);
  }
});
