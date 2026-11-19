// D2 (docs/WEAR.md): a Wear OS glance. The watch pairs with a short code typed in Sara (no token
// typing on a watch), then reads a glance (today, what waits on you) with a watch-kind Shortcuts
// token and asks her by voice through /api/shortcuts/ask. Approvals stay on the phone.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { normalizeCode, WEAR_PAIR_MS, WearPairing, wearGlance } from '../src/wear.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ------------------------------------------------------------------ pairing (unit)

test('pairing: a short code, claimed once by a signed-in person, handed to the watch once, then gone', () => {
  let now = 1_000_000;
  const p = new WearPairing(() => now);
  const s = p.start('1.2.3.4');
  assert.ok(s, 'started');
  assert.match(s.code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/, 'easy to read: no 0/O, 1/I/L');
  assert.ok(s.poll.length >= 32, 'the poll secret is long');
  assert.notEqual(s.poll, s.code);
  assert.deepEqual(p.take(s.poll), { state: 'pending' });
  assert.equal(normalizeCode(` ${s.code.toLowerCase().replace('-', ' ')} `), s.code, 'typed in any case, with a space or no dash');
  assert.equal(p.claim('AAA-AAA', () => ({ token: 'x', name: 'Sara' })), false, 'a wrong code claims nothing');
  let made = 0;
  assert.equal(p.claim(s.code.toLowerCase().replace('-', ''), () => (made++, { token: 'fake-token', name: 'Sara' })), true);
  assert.equal(p.claim(s.code, () => (made++, { token: 'y', name: 'Sara' })), false, 'a code works once');
  assert.equal(made, 1);
  assert.deepEqual(p.take(s.poll), { state: 'ready', token: 'fake-token', name: 'Sara' });
  assert.deepEqual(p.take(s.poll), { state: 'gone' }, 'the token is handed out once');
  assert.deepEqual(p.take('nope'), { state: 'gone' });
  // Codes run out.
  const late = p.start('1.2.3.4')!;
  now += WEAR_PAIR_MS + 1;
  assert.equal(p.claim(late.code, () => ({ token: 'z', name: 'Sara' })), false, 'an old code is refused');
  assert.deepEqual(p.take(late.poll), { state: 'gone' });
  // A flood of pairings from one address is refused; others may still start.
  for (let i = 0; i < 5; i++) assert.ok(p.start('5.6.7.8'));
  assert.equal(p.start('5.6.7.8'), undefined, 'at most five open codes per address');
  assert.ok(p.start('9.9.9.9'));
});

// ------------------------------------------------------------------ glance (unit)

test('glance: today only (her time zone), soonest first, at most three, and what waits on you', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago', language: 'en' } as never);
    const empty = wearGlance(app, 0);
    assert.equal(empty.today.length, 0);
    assert.equal(empty.waiting, 0);
    assert.match(empty.lines.nothing, /Nothing else today/);
    app.planner!.addReminder({ text: 'Call the dentist', dueAt: '2026-11-18T22:30:00Z' });
    app.planner!.addReminder({ text: 'Water the plants', dueAt: '2026-11-18T17:00:00Z' });
    app.planner!.addReminder({ text: 'Pick up Sam', dueAt: '2026-11-18T23:15:00Z' });
    app.planner!.addReminder({ text: 'Bins out', dueAt: '2026-11-19T01:00:00Z' }); // 7 PM in Chicago: still today
    app.planner!.addReminder({ text: 'Tomorrow thing', dueAt: '2026-11-19T15:00:00Z' });
    app.planner!.addReminder({ text: 'Already past', dueAt: '2026-11-18T14:00:00Z' });
    const g = wearGlance(app, 3);
    assert.deepEqual(g.today.map((x) => x.text), ['Water the plants', 'Call the dentist', 'Pick up Sam']);
    assert.equal(g.more, 1, 'one more today');
    assert.match(g.today[0]!.time, /11:00/);
    assert.equal(g.waiting, 3);
    assert.match(g.lines.waiting, /3/);
    assert.match(g.lines.waiting, /phone/i, 'answers stay on the phone');
    assert.equal(g.name, app.persona.name);
    assert.ok(Date.parse(g.at));
  } finally {
    app.store.close();
    cleanup();
  }
});

// ------------------------------------------------------------------ routes

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-18T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), shortcutAskBudgetMs: 2000, shortcutLinksDir: dir });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
let session = '';
async function cookie(): Promise<string> {
  if (session) return session;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: ownerToken }) });
  session = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  return session;
}
const json = { 'content-type': 'application/json', accept: 'application/json' };

test('routes: the watch gets a code, the owner types it in Sara, the watch gets its token once', async () => {
  const start = await fetch(`${base}/api/shortcuts/wear/pair`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(start.status, 201);
  const s = (await start.json()) as { code: string; poll: string; expiresIn: number };
  assert.match(s.code, /^\w{3}-\w{3}$/);
  assert.ok(s.expiresIn > 60);
  assert.equal((await fetch(`${base}/api/shortcuts/wear/pair/${s.poll}`)).status, 202, 'waiting for the code');
  // Only the signed-in web page claims a code: not an app's bearer token, not a stranger.
  assert.equal((await fetch(`${base}/api/shortcuts/wear/claim`, { method: 'POST', headers: { ...json, authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ code: s.code }) })).status, 403);
  assert.equal((await fetch(`${base}/api/shortcuts/wear/claim`, { method: 'POST', headers: json, body: JSON.stringify({ code: s.code }) })).status, 401);
  const wrong = await fetch(`${base}/api/shortcuts/wear/claim`, { method: 'POST', headers: { ...json, cookie: await cookie() }, body: JSON.stringify({ code: 'ZZZ-ZZZ' }) });
  assert.equal(wrong.status, 400);
  assert.match(((await wrong.json()) as { error: string }).error, /code/i);
  const ok = await fetch(`${base}/api/shortcuts/wear/claim`, { method: 'POST', headers: { ...json, cookie: await cookie() }, body: JSON.stringify({ code: s.code.toLowerCase(), label: "Alex's watch" }) });
  assert.equal(ok.status, 201);
  const view = (await ok.json()) as { watches: { id: string; label: string }[]; tokens: { device?: string }[] };
  assert.equal(view.watches.length, 1);
  assert.equal(view.watches[0]!.label, "Alex's watch");
  const got = await fetch(`${base}/api/shortcuts/wear/pair/${s.poll}`);
  assert.equal(got.status, 200);
  const { token, name } = (await got.json()) as { token: string; name: string };
  assert.ok(token.startsWith('sara_sc.'));
  assert.equal(name, app.persona.name);
  assert.equal((await fetch(`${base}/api/shortcuts/wear/pair/${s.poll}`)).status, 404, 'once');
  assert.deepEqual(auth.shortcutToken(token)?.scopes, ['ask'], 'a watch may ask and read its glance, never share files');
  assert.equal(auth.shortcutToken(token)?.device, 'watch');

  // The glance.
  app.planner!.addReminder({ text: 'Stretch', dueAt: '2026-11-18T18:00:00Z' });
  const g = await fetch(`${base}/api/shortcuts/wear`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(g.status, 200);
  const glance = (await g.json()) as { today: { text: string }[]; waiting: number; name: string };
  assert.deepEqual(glance.today.map((x) => x.text), ['Stretch']);
  assert.equal(glance.waiting, 0);
  assert.equal((await fetch(`${base}/api/shortcuts/wear`)).status, 401, 'no token, no glance');
  assert.equal((await fetch(`${base}/api/shortcuts/wear`, { headers: { authorization: `Bearer ${ownerToken}` } })).status, 404, 'the owner token is not a watch');

  // Push-to-talk: the watch's own chat, a short answer.
  app.script.push(text('It is sunny. Take a hat. And more words after that.'));
  const asked = await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...json, authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'weather?' }) });
  assert.equal(asked.status, 200);
  assert.match(((await asked.json()) as { say: string }).say, /sunny/);
  const conv = app.store.listConversations().find((c) => c.channel === 'shortcuts');
  assert.equal(conv?.title, 'Watch', "the watch's chat is named for it, not Siri");

  // Removing it stops it at once.
  const id = view.watches[0]!.id;
  assert.equal((await fetch(`${base}/api/shortcuts/tokens/${id}`, { method: 'DELETE', headers: { cookie: await cookie() } })).status, 200);
  assert.equal((await fetch(`${base}/api/shortcuts/wear`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test('routes: private local mode refuses pairing; the page lists watches apart from iPhones', async () => {
  setPrivateLocal(true);
  try {
    assert.equal((await fetch(`${base}/api/shortcuts/wear/pair`, { method: 'POST', headers: json, body: '{}' })).status, 403);
  } finally {
    setPrivateLocal(false);
  }
  auth.createShortcutToken('iPhone', ['ask']);
  const list = (await (await fetch(`${base}/api/shortcuts`, { headers: { cookie: await cookie() } })).json()) as { tokens: { label: string; device?: string }[]; watches: unknown[] };
  assert.ok(list.tokens.every((t) => t.device !== 'watch'), 'iPhone tokens only in the iPhone list');
  assert.ok(Array.isArray(list.watches));
});

// ------------------------------------------------------------------ the Wear OS app (static)

const WEAR = join('android', 'wear', 'src', 'main');
const wearJava = () => {
  const d = join(ROOT, WEAR, 'java', 'com', 'backstagecoding', 'sara', 'wear');
  return readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');
};

test('Wear app: a standalone watch app with a tile, internet only, no Google services', () => {
  const manifest = read(WEAR, 'AndroidManifest.xml');
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.type\.watch"/);
  assert.match(manifest, /com\.google\.android\.wearable\.standalone" android:value="true"/);
  assert.match(manifest, /android:permission="com\.google\.android\.wearable\.permission\.BIND_TILE_PROVIDER"/);
  assert.match(manifest, /androidx\.wear\.tiles\.action\.BIND_TILE_PROVIDER/);
  assert.match(manifest, /androidx\.wear\.tiles\.PREVIEW/);
  const perms = [...manifest.matchAll(/uses-permission android:name="android\.permission\.(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(perms, ['INTERNET'], 'speech comes from the watch\'s own recognizer: no microphone permission');
  const gradle = read('android', 'wear', 'build.gradle');
  assert.doesNotMatch(gradle, /com\.google\.android\.gms|firebase|play-services/i, 'no Google Play services or Firebase');
  assert.match(gradle, /androidx\.wear\.tiles:tiles:/);
  assert.match(gradle, /minSdk 30/);
  assert.match(gradle, /versionName appVersion/, 'the watch app follows the phone app version');
  assert.match(read('android', 'settings.gradle'), /include ':app', ':wear'|include ':wear'/);
  const java = wearJava();
  for (const path of ['/api/shortcuts/wear/pair', '/api/shortcuts/wear', '/api/shortcuts/ask']) assert.ok(java.includes(`"${path}`), `uses ${path}`);
  assert.match(java, /RecognizerIntent\.ACTION_RECOGNIZE_SPEECH/, 'push-to-talk with the watch\'s recognizer');
  assert.doesNotMatch(java, /approvals/, 'approvals stay on the phone');
});

test('Wear app: its text in six languages, the same names and placeholders, all used', () => {
  const RES = join(ROOT, WEAR, 'res');
  const strings = (d: string) => new Map([...read(WEAR, 'res', d, 'strings.xml').matchAll(/<string name="(\w+)"[^>]*>([\s\S]*?)<\/string>/g)].map((m) => [m[1]!, m[2]!]));
  const en = strings('values');
  assert.ok(en.size >= 10);
  const ph = (s: string) => [...s.matchAll(/%\d+\$[sd]/g)].map((m) => m[0]).sort().join(',');
  for (const d of ['values-de', 'values-es', 'values-fr', 'values-it', 'values-pt-rBR']) {
    const o = strings(d);
    assert.deepEqual([...o.keys()].sort(), [...en.keys()].sort(), d);
    for (const [k, v] of en) {
      assert.equal(ph(o.get(k)!), ph(v), `${d}: ${k}`);
      assert.ok(!/(^|[^\\])'/.test(o.get(k)!), `${d}: ${k} escapes apostrophes`);
    }
  }
  const pt = strings('values-pt-rBR');
  assert.ok([...en].filter(([k, v]) => k !== 'app_name' && pt.get(k) === v).length === 0, 'pt-BR is translated');
  const code = wearJava() + read(WEAR, 'AndroidManifest.xml') + readdirSync(join(RES, 'layout')).map((f) => read(WEAR, 'res', 'layout', f)).join('');
  for (const k of en.keys()) assert.ok(code.includes(`R.string.${k}`) || code.includes(`@string/${k}`), `${k} is used`);
});

test('Settings: the watch section has its controls, tips and loader', () => {
  const html = read('web', 'index.html');
  for (const id of ['wear-box', 'wear-code', 'wear-label', 'wear-pair', 'wear-list']) assert.match(html, new RegExp(`id="${id}"`), id);
  const block = html.slice(html.indexOf('id="wear-box"'), html.indexOf('id="wear-list"'));
  for (const id of ['wear-code', 'wear-label']) assert.match(block, new RegExp(`class="tip" data-tip="[^"]+">\\?</button> <input id="${id}"`), `${id} has a tip`);
  assert.match(block, /stays on your phone/);
  const js = read('web', 'wear-page.js');
  assert.match(js, /'\/shortcuts\/wear\/claim'/);
  assert.match(read('web', 'app.js'), /loadWearPage/);
});
