// C7: bring your companion from Character.AI, Replika, Kindroid or Nomi. Each source detected from a
// small invented export, the preview (name, persona, greeting, example lines, memories, a chat count),
// the safety rules (minors refused, explicit memories left out with Adult mode off, HTML never run,
// size caps, password-locked zips), saving into a companion (memories marked imported with source
// and date, the chat as an archived conversation, unticked things left out), and the HTTP flow that
// makes a new companion.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { applyBring, BringError, MAX_BRING_BYTES, planBring, readBring } from '../src/companion-import/bring.ts';
import { CompanionManager, CompanionSettings, LinkedToolRegistry, MAIN_ID, type Companion } from '../src/companions.ts';
import { loadPersona } from '../src/persona.ts';
import { createSaraServer, pickCompanion } from '../src/server.ts';
import { caiExportZip, kindroidPaste, nomiChatHtml, nomiNotes, replikaJson } from './bring-companion-fixtures.ts';
import { makeZip } from './history-fixtures.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-08T15:00:00Z');
const file = (name: string, v: string | Buffer | object) => ({ name, bytes: Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)) });

test('Character.AI: the export (characters + chats) becomes name, greeting, example lines and a chat', () => {
  const r = readBring({ files: [file('cai.zip', caiExportZip())] }, NOW);
  assert.equal(r.source, 'characterai');
  assert.equal(r.name, 'Mira');
  assert.match(r.profile.greeting, /lighthouse door/);
  assert.match(r.profile.examples, /lamp needs oiling/);
  assert.match(r.profile.personality, /Lighthouse keeper/, 'the tagline');
  assert.equal(r.chats?.conversations.length, 1);
  const plan = planBring(r, { adultOn: false });
  assert.equal(plan.persona.name, 'Mira');
  assert.equal(plan.persona.age, 31);
  assert.equal(plan.messages, 3);
  assert.ok(plan.examples.some((x) => /lamp needs oiling/.test(x)));
  assert.ok(!plan.examples.some((x) => /END_OF_DIALOG/.test(x)));
});

test('Replika: profile, memory facts (about you), diary (hers) and messages', () => {
  const r = readBring({ files: [file('replika-export.json', replikaJson())] }, NOW);
  assert.equal(r.source, 'replika');
  assert.equal(r.name, 'Mira');
  assert.deepEqual(r.memories.map((m) => [m.about, m.date]), [['you', '2025-01-10'], ['you', '2025-02-02'], ['her', '2025-02-14']]);
  assert.equal(r.memories[2].label, 'diary entry');
  const plan = planBring(r, { adultOn: false });
  assert.equal(plan.messages, 3);
  assert.match(plan.persona.summary, /curious about everything/);
});

test('Kindroid: a pasted backstory with key memories, journal entries, example message and directive', () => {
  const r = readBring({ text: kindroidPaste() }, NOW);
  assert.equal(r.source, 'kindroid');
  assert.equal(r.name, 'Mira');
  assert.match(r.profile.description, /marine biologist/);
  assert.match(r.profile.style, /short, playful/);
  const labels = r.memories.map((m) => `${m.label}|${m.date ?? ''}|${m.text}`);
  assert.deepEqual(labels, ['key memory||Alex is afraid of spiders.', 'key memory||Alex and Mira met at the aquarium in spring 2024.', 'journal entry|2024-06-12|Alex and Mira went to the amusement park and rode the big wheel twice.', 'journal entry|2024-08-01|Alex started a new job at the hospital.']);
  const plan = planBring(r, { adultOn: false });
  assert.equal(plan.persona.age, 29);
  assert.equal(plan.messages, 0);
});

test('Nomi: shared notes pasted in plus a chat saved as HTML (never run, tags and scripts dropped)', () => {
  const r = readBring({ text: nomiNotes(), files: [file('juno.html', nomiChatHtml())] }, NOW);
  assert.equal(r.source, 'nomi');
  assert.equal(r.name, 'Juno', 'from the chat speakers');
  assert.match(r.profile.appearance, /silver hair/);
  assert.match(r.profile.boundaries, /after 10 pm/);
  assert.ok(r.memories.some((m) => m.about === 'you' && /tall with curly hair/.test(m.text)));
  const all = JSON.stringify(r);
  assert.ok(!/stolen|alert|cookie|onerror|<b>/.test(all), 'nothing of the script, handlers or tags');
  assert.deepEqual(r.chats?.conversations[0].messages.map((m) => m.text), ['Morning, starling! Coffee?', 'Always. & a croissant.', 'Already on the plate <3', 'You are the best.']);
  const plan = planBring(r, { adultOn: false });
  assert.match(plan.persona.appearance ?? '', /silver hair/);
  assert.ok(plan.persona.background.some((b) => /after 10 pm/.test(b)), 'her boundaries from the notes');
});

test('the owner can name the source; unknown text becomes a backstory', () => {
  const r = readBring({ text: 'Kai is a calm 40-year-old gardener who hums while working.', source: 'nomi', name: 'Kai' }, NOW);
  assert.equal(r.source, 'nomi');
  assert.equal(r.name, 'Kai');
  assert.match(r.profile.description, /gardener/);
});

test('safety: minors refused, explicit memories left out with Adult mode off, unsafe chats dropped, caps', () => {
  assert.throws(() => planBring(readBring({ text: 'Name: Lily\nBackstory:\nLily is 15 and has a crush on you, she loves to flirt.' }, NOW), { adultOn: true }), /under 18|always adults/);
  const r = readBring({ text: `${kindroidPaste()}\n\nKey memories:\n- Alex and Mira had explicit sex on the beach, naked and moaning.` }, NOW);
  const off = planBring(r, { adultOn: false });
  assert.ok(!off.memories.some((m) => /beach/.test(m.text)));
  assert.match(JSON.stringify(off.notes), /left out because Adult mode is off/);
  const on = planBring(r, { adultOn: true });
  assert.ok(on.memories.some((m) => /beach/.test(m.text)));
  // A chat that fails the minors check is dropped whole.
  const bad = readBring({ text: kindroidPaste(), files: [file('chat.txt', 'Alex: hi\nMira: the 12-year-old girl was naked and sexy\nAlex: no\nMira: ok')] }, NOW);
  const p = planBring(bad, { adultOn: true });
  assert.equal(p.messages, 0);
  assert.equal(p.droppedForSafety, 1);
  assert.throws(() => readBring({ files: [{ name: 'big.json', bytes: Buffer.alloc(MAX_BRING_BYTES + 1) }] }, NOW), BringError);
  assert.throws(() => readBring({ text: 'x'.repeat(300_001) }, NOW), /too long/);
  assert.throws(() => readBring({ text: '   ' }, NOW), /Nothing to bring/);
  const locked = makeZip({ 'a.json': '{}' });
  locked.writeUInt16LE(locked.readUInt16LE(6) | 1, 6); // local header: encrypted
  const cd = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  locked.writeUInt16LE(locked.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => readBring({ files: [file('cai.zip', locked)] }, NOW), /password/);
});

test('applyBring: memories marked imported (source, date), the chat archived, unticked things left out', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: NOW });
    const r = readBring({ text: kindroidPaste(), files: [file('chat.txt', 'Alex: hi Mira\nMira: hi Alex! *grins*\nAlex: how are you?\nMira: happy you are here')] }, NOW);
    const plan = planBring(r, { adultOn: false, picks: { memories: [0, 2, 3], greeting: false } });
    assert.equal(plan.memories.length, 3);
    const out = applyBring(app, r, plan, { chats: true });
    assert.equal(out.memories, 3);
    assert.equal(out.conversations, 1);
    const mems = app.memory!.list({ limit: 50 });
    assert.equal(mems.length, 3);
    assert.ok(mems.every((m) => /^Imported from Kindroid \((key memory|journal entry)\) on 2026-11-08/.test(m.evidence ?? '')));
    assert.ok(mems.some((m) => m.happenedOn === '2024-06-12'));
    assert.ok(!mems.some((m) => /aquarium/.test(m.content)), 'the unticked memory');
    const convs = app.store.db.prepare("SELECT id, channel, archived_at FROM conversations WHERE channel = 'import-kindroid'").all() as { id: string; archived_at: string | null }[];
    assert.ok(convs.length >= 1 && convs.every((c) => c.archived_at));
    const msgs = app.store.db.prepare("SELECT role, content, meta FROM messages ORDER BY id").all() as { role: string; meta: string }[];
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(msgs.every((m) => JSON.parse(m.meta).importedFrom === 'kindroid'));
    // Chats off: none kept.
    mkdirSync(join(dir, 'b'));
    const app2 = makeApp(join(dir, 'b'), { now: NOW });
    assert.equal(applyBring(app2, r, planBring(r, { adultOn: false }), { chats: false }).conversations, 0);
    app.store.close();
    app2.store.close();
  } finally {
    cleanup();
  }
});

// ---------- HTTP: preview, then a new companion ----------

const { dir, cleanup } = tempDir();
const clock = { now: NOW };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const companions = new CompanionManager(dir);
const mainApp = makeApp(dir, clock);
function build(id: string, cdir: string): Companion {
  const app: TestApp = id === MAIN_ID ? mainApp : makeApp(cdir, clock);
  if (id !== MAIN_ID) {
    app.settings = new CompanionSettings(cdir, mainApp.settings);
    app.tools = new LinkedToolRegistry(mainApp.tools);
    app.persona = loadPersona(join(cdir, 'persona.json'));
    app.vault = mainApp.vault;
  }
  app.rootDir = dir;
  app.companionId = id;
  app.companions = companions;
  return { id, app, server: createSaraServer({ app, auth, webDir: join(ROOT, 'web'), companions }), start() {}, async stop() {} };
}
companions.build = build;
companions.add(build(MAIN_ID, dir));
const front: Server = createServer((req, res) => void pickCompanion(companions, req).server.emit('request', req, res));
let base = '';
before(async () => {
  mainApp.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: NOW.toISOString(), setupDone: true });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
after(() => {
  front.close();
  for (const c of companions.all()) c.app.store.close();
  cleanup();
});
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP: preview a Replika export, untick a memory, bring her over as a new companion', async () => {
  const res = await post('/api/companions/bring/preview', { files: [{ name: 'replika.json', data: Buffer.from(JSON.stringify(replikaJson())).toString('base64') }] });
  assert.equal(res.status, 200);
  const p = (await res.json()) as { token: string; preview: { source: string; name: string; memories: { index: number; text: string }[]; messages: number; canAdd: boolean } };
  assert.equal(p.preview.source, 'replika');
  assert.equal(p.preview.name, 'Mira');
  assert.equal(p.preview.memories.length, 3);
  assert.equal(p.preview.messages, 3);
  assert.equal(p.preview.canAdd, true);
  const done = await post('/api/companions/bring/import', { token: p.token, name: 'Mira R', memories: [0, 2], chats: true });
  assert.equal(done.status, 200);
  const d = (await done.json()) as { companion: string; memories: number; conversations: number };
  assert.equal(d.memories, 2);
  assert.equal(d.conversations, 1);
  const c = companions.get(d.companion)!;
  assert.equal(c.app.persona.name, 'Mira R');
  assert.equal(c.app.memory!.list({ limit: 50 }).length, 2);
  assert.equal(mainApp.memory!.list({ limit: 50 }).length, 0, 'the main companion is untouched');
  // The draft is used up.
  assert.equal((await post('/api/companions/bring/import', { token: p.token })).status, 404);
  // Nothing readable: a plain error.
  const bad = await post('/api/companions/bring/preview', { text: '' });
  assert.equal(bad.status, 400);
});
