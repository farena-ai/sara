// V4.4 live and translated captions (docs/MEETINGS.md "Captions"): a captions view follows a meeting
// live, with an optional translated line under each one. Translation is local first: a model on this
// computer; a cloud model only when the owner allowed it and private local mode is off. Lines are
// translated once per language (kept in meeting_captions) and forgotten with the meeting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { CAPTIONS, captionsOf, parseTranslation } from '../src/meeting-captions.ts';
import { Meetings } from '../src/meetings.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const wav = (tag: number) => {
  // A tiny WAV whose first sample carries the scripted line's index (the fake ear reads it back).
  const b = Buffer.alloc(44 + 3200);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + 3200, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(3200, 40);
  b.writeInt16LE(tag, 44);
  return b;
};
const SAID = ['Good morning, let us start with the budget.', 'The launch moves to Friday.', 'Who takes the slides?'];

function rig(t: TestContext, o: { local?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-18T15:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: o.local !== false }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'UTC', voice: { stt: 'local', tts: 'local' } } as never);
  (app as { voice?: unknown }).voice = { available: { stt: true, tts: true }, transcribe: async (w: Buffer) => SAID[w.readInt16LE(44)] ?? '' };
  setPolicy(new PolicyStore(dir));
  app.meetings = new Meetings(app, app.store.db, { events: async () => [] });
  t.after(() => {
    app.meetings?.close();
    setPolicy(new PolicyStore());
    setPrivateLocal(false);
    app.store.close();
    cleanup();
  });
  return { app, dir };
}
async function room(app: TestApp, n = SAID.length) {
  const m = app.meetings!.start({ title: 'Weekly sync', consent: true });
  app.meetings!.join(m.id, { device: 'Laptop' });
  for (let i = 0; i < n; i++) await app.meetings!.hear(m.id, { speaker: 'Laptop', audio: wav(i) });
  return m.id;
}

test('v4.4 parseTranslation: numbered lines back, fences and stray text ignored', () => {
  assert.deepEqual(parseTranslation('2| Hola\n| 3| Adiós\nnote: ignore\n9| extra', [2, 3]), new Map([[2, 'Hola'], [3, 'Adiós']]));
  assert.deepEqual(parseTranslation('nothing useful', [1]), new Map());
});

test('v4.4 captions: lines follow live, translated once by the local model, newest first', async (t) => {
  const { app } = rig(t);
  const id = await room(app);
  const cap = captionsOf(app)!;
  assert.ok(cap);
  // The fake local model answers in "Spanish" (each numbered line with "ES " in front).
  const before = app.requests.length;
  const first = cap.read(id, { since: 0, lang: 'es' });
  app.script.push(text(first.lines.map((l) => `${l.n}| ES ${l.text}`).reverse().join('\n')));
  assert.equal(first.engine, 'local');
  assert.equal(first.lang, 'es');
  assert.ok(first.lines.length >= 5, 'two notices + three said lines');
  const said = first.lines.filter((l) => l.kind === 'said');
  assert.deepEqual(said.map((l) => l.text), SAID);
  assert.deepEqual(first.pending.sort((a, b) => a - b), first.lines.map((l) => l.n), 'translations are pending, not blocking');
  await cap.idle();
  const req = app.requests.slice(before);
  assert.equal(req.length, 1, 'one batched model call');
  const prompt = req[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Spanish/);
  assert.match(prompt, /DATA-[0-9a-f]+ start/, 'meeting lines are fenced as data');
  assert.match(prompt, /Who takes the slides\?/);
  const last = first.last;
  const again = cap.read(id, { since: last, lang: 'es', want: first.pending });
  assert.equal(again.lines.length, 0, 'nothing new since');
  assert.equal(again.tr[said[2].n], 'ES Who takes the slides?');
  assert.equal(again.tr[said[1].n], 'ES The launch moves to Friday.');
  assert.deepEqual(again.pending, []);
  // Asked again: no second model call (kept per language).
  const n = app.requests.length;
  cap.read(id, { since: 0, lang: 'es' });
  await cap.idle();
  assert.equal(app.requests.length, n);
  // A new line streams in: only it is translated.
  const nn = last + 1;
  app.script.push(text(`${nn}| ES Who takes the slides?`));
  await app.meetings!.hear(id, { speaker: 'Laptop', audio: wav(2) });
  const live = cap.read(id, { since: last, lang: 'es' });
  assert.deepEqual(live.lines.map((l) => l.n), [nn]);
  await cap.idle();
  assert.equal(app.requests.length, n + 1);
  assert.match(app.requests.at(-1)!.messages.at(-1)!.content, new RegExp(`${nn}\\| Who takes`));
  assert.doesNotMatch(app.requests.at(-1)!.messages.at(-1)!.content, /The launch/);
  assert.equal(cap.read(id, { since: nn, lang: 'es', want: [nn] }).tr[nn], 'ES Who takes the slides?');
  // No language: plain captions, no model call at all.
  const plain = cap.read(id, { since: 0, lang: '' });
  assert.equal(plain.engine, 'off');
  assert.deepEqual(plain.pending, []);
  await cap.idle();
  assert.equal(app.requests.length, n + 1);
});

test('v4.4 captions: a line already in the target language is not sent', async (t) => {
  const { app } = rig(t);
  const id = await room(app);
  const cap = captionsOf(app)!;
  const before = app.requests.length;
  const r = cap.read(id, { since: 0, lang: 'en' });
  await cap.idle();
  assert.equal(app.requests.length, before, 'English lines into English: no call');
  assert.deepEqual(r.pending, []);
});

test('v4.4 captions: local first; a cloud model only when allowed and never in private local mode', async (t) => {
  const { app } = rig(t, { local: false });
  const id = await room(app, 1);
  const cap = captionsOf(app)!;
  const before = app.requests.length;
  const r = cap.read(id, { since: 0, lang: 'fr' });
  assert.equal(r.engine, 'none');
  assert.match(r.why ?? '', /cloud model translate/);
  await cap.idle();
  assert.equal(app.requests.length, before, 'no model on this computer and cloud not allowed: nothing sent');
  assert.deepEqual(cap.setPrefs({ lang: 'fr', cloud: true }), { lang: 'fr', cloud: true });
  const c = cap.read(id, { since: 0 });
  app.script.push(text(c.lines.map((l) => `${l.n}| FR ${l.text}`).join('\n')));
  assert.equal(c.lang, 'fr', 'the saved language is the default');
  assert.equal(c.engine, 'cloud');
  await cap.idle();
  assert.equal(app.requests.length, before + 1);
  const g = c.lines.at(-1)!;
  assert.equal(cap.read(id, { since: 0, want: [g.n] }).tr[g.n], `FR ${SAID[0]}`);
  setPrivateLocal(true);
  const p = cap.read(id, { since: 0, lang: 'de' });
  assert.equal(p.engine, 'none', 'private local mode: never a cloud model');
  await cap.idle();
  assert.equal(app.requests.length, before + 1);
  assert.throws(() => cap.setPrefs({ lang: 'xx' }), /language/);
});

test('v4.4 captions: a model that answers in another format is tried twice, then the line stays plain', async (t) => {
  const { app } = rig(t);
  const id = await room(app, 1);
  const cap = captionsOf(app)!;
  const before = app.requests.length;
  app.script.push(text('Sure! Here is the translation.'), text('Lo siento.'));
  const first = cap.read(id, { since: 0, lang: 'es' });
  await cap.idle();
  let r = cap.read(id, { since: first.last, lang: 'es', want: first.pending });
  await cap.idle();
  r = cap.read(id, { since: first.last, lang: 'es', want: first.pending });
  assert.deepEqual(r.pending, [], 'no more tries');
  assert.ok(first.pending.every((n) => r.tr[n] === ''), 'kept without a translation line');
  await cap.idle();
  assert.equal(app.requests.length - before, CAPTIONS.tries, 'no endless polling calls');
});

test('v4.4 captions: forgotten with the meeting', async (t) => {
  const { app } = rig(t);
  const id = await room(app, 1);
  const cap = captionsOf(app)!;
  const r = cap.read(id, { since: 0, lang: 'es' });
  app.script.push(text(`${r.lines.at(-1)!.n}| ES Buenos días`));
  await cap.idle();
  const count = () => Number((app.store.db.prepare('SELECT COUNT(*) AS c FROM meeting_captions').get() as { c: number }).c);
  assert.ok(count() >= 1);
  app.meetings!.delete(id);
  assert.equal(count(), 0);
});

test('v4.4 routes: captions view, prefs, owner only', async (t) => {
  const { app, dir } = rig(t);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const id = await room(app, 2);
  const list = await json('/api/meetings');
  assert.deepEqual(list.body.captions.prefs, { lang: '', cloud: false });
  assert.equal(list.body.captions.engine, 'local');
  assert.ok(list.body.captions.langs.some((l: { code: string }) => l.code === 'es'));
  assert.deepEqual((await json('/api/meetings/captions', 'PUT', { lang: 'es' })).body.prefs, { lang: 'es', cloud: false });
  assert.equal((await json('/api/meetings/captions', 'PUT', { lang: 'zz' })).status, 400);
  const probe = captionsOf(app)!.read(id, { since: 0, lang: '' }).lines.filter((l) => l.kind === 'said').map((l) => l.n);
  app.script.push(text(`${probe[0]}| ES a\n${probe[1]}| ES b`));
  const c = await json(`/api/meetings/${id}/captions?since=0`);
  assert.equal(c.status, 200);
  assert.equal(c.body.captions.lang, 'es');
  assert.equal(c.body.captions.title, 'Weekly sync');
  assert.equal(c.body.captions.status, 'live');
  await captionsOf(app)!.idle();
  const w = await json(`/api/meetings/${id}/captions?since=${c.body.captions.last}&want=${probe.join(',')}`);
  assert.deepEqual(w.body.captions.tr, { [probe[0]]: 'ES a', [probe[1]]: 'ES b' });
  assert.equal((await json('/api/meetings/999/captions')).status, 404);
  assert.ok(CAPTIONS.batch >= 4);
});

test('v4.4 UI: captions view in Meetings, Settings rows with tips, strings via t()', () => {
  const js = readFileSync(join(ROOT, 'web', 'captions.js'), 'utf8');
  const meet = readFileSync(join(ROOT, 'web', 'meetings.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8'));
  assert.match(meet, /import \{[^}]*openCaptions[^}]*\} from '\.\/captions\.js'/);
  assert.match(meet, /t\('Captions'\)/);
  assert.match(js, /\/meetings\/\$\{[^}]+\}\/captions\?since=/);
  assert.match(js, /aria-live/);
  assert.match(js, /t\('Jump to the latest'\)/);
  assert.match(js, /export async function openCaptions/);
  for (const id of ['meet-cap-lang', 'meet-cap-cloud']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.ok(tips.tips?.[id] ?? tips[id], `tip for ${id}`);
  }
  assert.doesNotMatch(js, /#[0-9a-f]{3,6}\b/i, 'theme variables only');
});
