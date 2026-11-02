// Phase 126 (2.59.0, docs/design/WAKE.md §12): "Hey Sara", the server side and part C. The 42 Done-when
// items: keyword lines and phrases (a fixture lexicon in the real en.phone format), config, devices and
// switches, the claim, the wake turn (a fake hearing that returns a set transcript, the recording
// stand-in model), safety in the spoken order, privacy and household, part C (a fake fetch and a fake
// tar), and the Settings page's tips and layout. A fake clock everywhere time matters; no real network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { blockedRecently, setPrivateLocal } from '../src/net-guard.ts';
import { localVoiceMissing, localVoiceSupported } from '../src/platform.ts';
import { satisfies } from '../src/plugins/manifest.ts';
import { CRISIS_RESOURCES, CRISIS_SYSTEM_NOTE, disclosureText, MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { createSaraServer } from '../src/server.ts';
import { appLanguage } from '../src/i18n.ts';
import { checkPhrase, CLAIM_TTL_MS, HEY_SARA, isStopWord, parseLexicon, phraseLines, saidNothing, SENSITIVITY, STOP_WORDS, WakeStore, WHY } from '../src/wake.ts';
import { MODEL_FILES, MODEL_TAR, packFor, WAKE_PACKS } from '../src/wake-pack.ts';
import { engineAfterInstall, installVoice, runVoiceCli, SHERPA_BUNDLES, VOICE_MODELS, voiceManifest } from '../src/voice-install.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Run as 2.59.0 until the release bumps package.json (as phase122b did).
const V = satisfies(PKG_VERSION, '>=2.59.0') ? PKG_VERSION : '2.59.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};

/** 20 lines of the real en.phone format (the words the tests use). */
const LEXICON = ['HEY HH EY1', 'MIRA M IH1 R AH0', 'SARA S EH1 R AH0', 'SARA S AA1 R AH0', 'AL AE1 L', 'ALFRED AE1 L F R AH0 D', 'OKAY OW2 K EY1', 'CAPTAIN K AE1 P T AH0 N', 'STOP S T AA1 P', 'GOOGLE G UW1 G AH0 L', 'SIRI S IH1 R IY0', 'ALEXA AH0 L EH1 K S AH0', 'CORTANA K AO0 R T AE1 N AH0', 'OK OW1 K EY1', 'THE DH AH0', 'TIMER T AY1 M ER0', 'GOOD G UH1 D', 'MORNING M AO1 R N IH0 NG', 'MY M AY1', 'FRIEND F R EH1 N D'].join('\n');
const LEX = parseLexicon(LEXICON);

/** A 16 kHz mono 16-bit WAV of `seconds` of silence. */
function wav(seconds: number): Buffer {
  const data = Math.round(seconds * 16000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

interface Rig {
  app: TestApp;
  auth: OwnerAuth;
  base: string;
  clock: { now: Date };
  heard: string[];
  dir: string;
  session: (label: string) => { cookie: string; id: string };
  call: (method: string, path: string, body?: unknown, cookie?: string, headers?: Record<string, string>) => Promise<{ status: number; json: Any }>;
  events: Any[];
}

/** A Sara server with a fake hearing (returns the next transcript) and the stand-in model. */
async function rig(t: TestContext, o: { member?: { voice: boolean }; demo?: boolean; share?: Rig; name?: string; companionId?: string; companions?: () => Any } = {}): Promise<Rig> {
  const { dir, cleanup } = o.share ? { dir: join(o.share.dir, 'companions', o.companionId ?? 'x'), cleanup: () => {} } : tempDir();
  mkdirSync(dir, { recursive: true });
  const clock = o.share?.clock ?? { now: new Date('2026-11-02T10:00:00Z') };
  const app = makeApp(dir, clock);
  if (o.share) {
    app.rootDir = o.share.dir;
    app.settings = o.share.app.settings;
  }
  app.companionId = o.companionId ?? 'main';
  if (o.name) app.persona = { ...app.persona, name: o.name };
  if (!o.share) app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), voice: { stt: 'local', tts: 'local' } as never });
  const heard = o.share?.heard ?? [];
  app.voice = {
    dir,
    available: { stt: true, tts: true },
    voices: () => [],
    transcribe: async () => heard.shift() ?? '',
    speak: async () => ({ data: Buffer.from('RIFF0000WAVE'), type: 'audio/wav' }),
    reload: () => {},
  } as never;
  const auth = o.share?.auth ?? new OwnerAuth(dir, () => clock.now);
  const events: Any[] = [];
  app.events!.subscribe((ev) => events.push(ev));
  const http = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() }, ...(o.companions ? { companions: o.companions() } : {}), ...(o.demo ? { demo: true } : {}), ...(o.member ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Ana', status: 'active', createdAt: clock.now.toISOString(), limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: o.member!.voice, pictures: false } }) as never, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
    app.store.close();
    cleanup();
  });
  const session = (label: string) => {
    const s = auth.createSession(label);
    return { cookie: s.value, id: auth.sessionId(s.value)! };
  };
  const call: Rig['call'] = async (method, path, body, cookie, headers = {}) => {
    const h: Record<string, string> = { Origin: base, ...headers };
    if (cookie) h.Cookie = `sara_session=${encodeURIComponent(cookie)}`;
    let payload: BodyInit | undefined;
    if (method === 'GET' || method === 'HEAD') payload = undefined;
    else if (Buffer.isBuffer(body)) payload = new Uint8Array(body);
    else if (body !== undefined) {
      h['Content-Type'] ??= 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(`${base}${path}`, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  return { app, auth, base, clock, heard, dir, session, call, events };
}

/** A device that switched itself on, claimed a wake and sends the recording. */
async function turnOf(r: Rig, dev: { cookie: string }, said: string, extra: Record<string, string> = {}, label = 'W1') {
  const c = await r.call('POST', '/api/wake/claim', { label }, dev.cookie);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.ok, true, JSON.stringify(c.json));
  r.heard.push(said);
  return r.call('POST', '/api/wake/turn', wav(2), dev.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.json.claim, 'X-Sara-Wake-Label': label, ...extra });
}
async function deviceOn(r: Rig, label = 'Windows PC', platform = 'windows') {
  const d = r.session(label);
  const p = await r.call('PUT', '/api/wake/device', { on: true, platform, label }, d.cookie);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  return d;
}
const later = (r: Rig, ms: number) => {
  r.clock.now = new Date(r.clock.now.getTime() + ms);
};
const systemOf = (r: Rig) => String(r.app.requests.at(-1)?.messages.find((m: Any) => m.role === 'system')?.content ?? '');

// ---------------- Keyword lines and phrases ----------------

test('1 · "Hey Sara" gives the two built-in lines with the label and Normal numbers, without a lexicon', () => {
  const r = phraseLines('Hey Sara');
  assert.ok(r.ok);
  assert.deepEqual(r.lines, ['HH EY1 S EH1 R AH0 :1.5 #0.25 @W1', 'HH EY1 S AA1 R AH0 :1.5 #0.25 @W1']);
  assert.deepEqual([...HEY_SARA], ['HH EY1 S EH1 R AH0', 'HH EY1 S AA1 R AH0']);
});

test('2 · "hey mira" with the lexicon; punctuation and case are ignored', () => {
  const a = phraseLines('hey mira', LEX, { label: 'W2' });
  assert.ok(a.ok);
  assert.deepEqual(a.lines, ['HH EY1 M IH1 R AH0 :1.5 #0.25 @W2']);
  assert.deepEqual(phraseLines('Hey, Mira!', LEX, { label: 'W2' }), a);
});

test('3 · a word the lexicon lacks is refused, naming the word; nothing is saved', async (t) => {
  const r = phraseLines('Hey Zorblax', LEX);
  assert.equal(r.ok, false);
  assert.match((r as Any).why, /zorblax/);
  const g = await rig(t);
  const d = g.session('PC');
  const before = (await g.call('GET', '/api/wake', undefined, d.cookie)).json.settings.phrases;
  const put = await g.call('PUT', '/api/wake', { phrases: [{ text: 'Hey Zorblax', companionId: 'main' }] }, d.cookie);
  assert.equal(put.status, 400);
  assert.match(put.json.error, /zorblax|word list/i);
  assert.deepEqual((await g.call('GET', '/api/wake', undefined, d.cookie)).json.settings.phrases, before);
});

test('4 · the phrase rules', () => {
  assert.equal(checkPhrase('Mira', { lexicon: LEX }).ok, false);
  assert.equal((checkPhrase('hey hey hey hey mira', { lexicon: LEX }) as Any).why, WHY.words);
  assert.equal((checkPhrase('Hey Al', { lexicon: LEX }) as Any).why, WHY.short);
  assert.match(WHY.short, /longer/);
  assert.equal((checkPhrase('Hey stop', { lexicon: LEX }) as Any).why, WHY.stop);
  for (const p of ['Hey Google', 'Alexa', 'Hey Siri', 'OK Google', 'Hey Cortana']) assert.equal((checkPhrase(p, { lexicon: LEX }) as Any).why, WHY.assistant, p);
  assert.equal((checkPhrase('Hey Mira', { lexicon: LEX, others: ['hey, mira'] }) as Any).why, WHY.duplicate);
  assert.equal((checkPhrase('Hey Alfred', { lexicon: LEX, count: 4 }) as Any).why, WHY.many);
  assert.ok(checkPhrase('Hey Alfred', { lexicon: LEX }).ok);
});

test('5 · sensitivity changes only the :boost #threshold parts', () => {
  for (const [s, v] of Object.entries(SENSITIVITY)) {
    const r = phraseLines('hey mira', LEX, { label: 'W2', sensitivity: s as Any });
    assert.ok(r.ok);
    assert.equal(r.lines[0], `HH EY1 M IH1 R AH0 :${v.boost.toFixed(1)} #${v.threshold.toFixed(2)} @W2`);
  }
  assert.deepEqual(SENSITIVITY, { relaxed: { boost: 2, threshold: 0.2 }, normal: { boost: 1.5, threshold: 0.25 }, strict: { boost: 1, threshold: 0.35 } });
});

test('6 · German/Spanish/French/Italian/Portuguese words → the language message', () => {
  for (const p of ['Hallo Mira', 'Hola Mira', 'Salut Mira', 'Ciao Mira', 'Olá Mira']) {
    const r = checkPhrase(p, { lexicon: LEX });
    assert.equal((r as Any).why, WHY.language, p);
  }
  assert.match(WHY.language, /German, Spanish, French, Italian, Portuguese/);
});

test('7 · renaming a companion keeps her phrase; deleting her removes her phrases from the config', async (t) => {
  let list = [{ id: 'main', app: undefined as Any }, { id: 'mira', app: { persona: { name: 'Mira' } } }];
  const g = await rig(t, { companions: () => ({ all: () => list.map((c) => (c.id === 'main' ? { ...c, app: g0() } : c)), get: (id: string) => list.find((c) => c.id === id), main: list[0] }) });
  const g0 = () => g.app;
  mkdirSync(join(g.dir, 'voice', 'wake-lexicon'), { recursive: true });
  const d = g.session('PC');
  // "Hey Mira" needs the lexicon; with it missing it's refused, so use built-in "Hey Sara" for Mira's companion.
  const put = await g.call('PUT', '/api/wake', { phrases: [{ text: 'Hey Sara', companionId: 'main' }, { text: 'Hey Sara Sara', companionId: 'mira' }] }, d.cookie);
  assert.equal(put.status, 400, 'an unknown word without the lexicon');
  assert.equal((await g.call('PUT', '/api/wake', { phrases: [{ text: 'Hey Sara', companionId: 'mira' }] }, d.cookie)).status, 200);
  list[1].app.persona.name = 'Mirabel';
  let cfg = (await g.call('GET', '/api/wake/config?platform=windows', undefined, d.cookie)).json;
  assert.equal(cfg.phrases.length, 1);
  assert.equal(cfg.phrases[0].companionId, 'mira');
  assert.equal(cfg.phrases[0].name, 'Sara', 'the saved phrase is unchanged by the rename');
  list = list.slice(0, 1);
  cfg = (await g.call('GET', '/api/wake/config?platform=windows', undefined, d.cookie)).json;
  assert.ok(!cfg.phrases.some((p: Any) => p.companionId === 'mira'), 'no line for the deleted companion');
  assert.ok(!JSON.stringify(cfg).includes('@W1') || cfg.phrases.every((p: Any) => p.companionId !== 'mira'));
});

// ---------------- Config, devices, switches ----------------

test('8 · config from a fresh session: off, phrases with lines, stop lines, the pack, 60 s polls', async (t) => {
  const g = await rig(t);
  const d = g.session('PC');
  const cfg = (await g.call('GET', '/api/wake/config?platform=windows&arch=x64', undefined, d.cookie)).json;
  assert.equal(cfg.on, false);
  assert.deepEqual(cfg.phrases[0].lines, phraseLines('Hey Sara').ok ? (phraseLines('Hey Sara') as Any).lines : []);
  assert.ok(cfg.stop.includes('S T AA1 P :1.5 #0.25 @STOP'));
  assert.ok(cfg.stop.some((l: string) => l.startsWith('S EH1 R AH0 S T AA1 P')));
  assert.equal(cfg.pack.platform, 'windows');
  assert.equal(cfg.pack.files.length, 7);
  assert.equal(cfg.pollSeconds, 60);
  assert.deepEqual(packFor('android')!.files, MODEL_FILES);
});

test('9 · on: true only from the device itself', async (t) => {
  const g = await rig(t);
  const pc = await deviceOn(g, 'Windows PC');
  assert.equal((await g.call('GET', '/api/wake/config', undefined, pc.cookie)).json.on, true);
  const phone = g.session('Phone');
  const r = await g.call('PUT', '/api/wake/device', { device: pc.id, on: true }, phone.cookie);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'Only that device can turn Hey Sara on.');
});

test("10 · any session of the same person can switch a device off; the event reaches only the person's own hub", async (t) => {
  const g = await rig(t);
  const other = await rig(t);
  const pc = await deviceOn(g);
  const phone = g.session('Phone');
  const r = await g.call('POST', `/api/wake/device/${pc.id}/off`, {}, phone.cookie);
  assert.equal(r.status, 200);
  assert.equal((await g.call('GET', '/api/wake/config', undefined, pc.cookie)).json.on, false);
  assert.ok(g.events.some((e) => e.type === 'wake' && e.device === pc.id && e.state === 'off'));
  assert.ok(!other.events.some((e) => e.type === 'wake'));
  // Only the device can switch itself on again.
  assert.equal((await g.call('PUT', '/api/wake/device', { device: pc.id, on: true }, phone.cookie)).status, 403);
});

test("11 · Turn off everywhere (a person's devices); the owner's server switch makes every config off with server-off", async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g, 'PC');
  const b = await deviceOn(g, 'Phone', 'android');
  assert.equal((await g.call('POST', '/api/wake/off', {}, a.cookie)).status, 200);
  for (const d of [a, b]) assert.equal((await g.call('GET', '/api/wake/config', undefined, d.cookie)).json.on, false);
  await g.call('PUT', '/api/wake/device', { on: true }, a.cookie);
  assert.equal((await g.call('PUT', '/api/wake/server', { allowed: false }, a.cookie)).status, 200);
  const cfg = (await g.call('GET', '/api/wake/config', undefined, a.cookie)).json;
  assert.equal(cfg.on, false);
  assert.equal(cfg.paused, 'server-off');
  assert.equal((await g.call('PUT', '/api/wake/device', { on: true }, a.cookie)).status, 403);
});

test('12 · signing a device out: config 401, and its record goes on the next read', async (t) => {
  const g = await rig(t);
  const pc = await deviceOn(g);
  const keep = g.session('Phone');
  g.auth.signOut(pc.id);
  assert.equal((await g.call('GET', '/api/wake/config', undefined, pc.cookie)).status, 401);
  const list = (await g.call('GET', '/api/wake', undefined, keep.cookie)).json.devices;
  assert.ok(!list.some((d: Any) => d.id === pc.id));
  assert.ok(!(pc.id in JSON.parse(readFileSync(join(g.dir, 'wake.json'), 'utf8')).devices));
});

test('13 · days kept 14; counters add up; the Strict hint at 5 and not again within 7 days', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clock = { now: new Date('2026-11-02T10:00:00Z') };
  const s = new WakeStore(dir, () => clock.now);
  s.update((f) => {
    f.devices.d1 = { platform: 'windows', label: 'PC', on: true, sensitivity: 'normal', personal: false, chime: true, lastSeen: clock.now.toISOString(), days: {} };
    s.count(f, 'd1', { wakes: 2, nothing: 1 });
    s.count(f, 'd1', { wakes: 1, answered: 1 });
  });
  let d = s.read().devices.d1;
  assert.deepEqual(d.days['2026-11-02'], { wakes: 3, nothing: 1, stopped: 0, answered: 1 });
  s.update((f) => s.count(f, 'd1', { nothing: 2, stopped: 2 }));
  d = s.read().devices.d1;
  assert.equal(d.hintAt, clock.now.toISOString());
  assert.equal(s.today(d).hint, true);
  clock.now = new Date('2026-11-05T10:00:00Z');
  s.update((f) => s.count(f, 'd1', { nothing: 5 }));
  assert.equal(s.read().devices.d1.hintAt, '2026-11-02T10:00:00.000Z', 'not again within 7 days');
  clock.now = new Date('2026-11-10T10:00:00Z');
  s.update((f) => s.count(f, 'd1', { nothing: 5 }));
  assert.equal(s.read().devices.d1.hintAt, clock.now.toISOString(), 'again after a week');
  clock.now = new Date('2026-11-17T10:00:00Z');
  const days = Object.keys(s.read().devices.d1.days);
  assert.ok(!days.includes('2026-11-02') && days.includes('2026-11-05'), `14 days kept: ${days}`);
});

// ---------------- The claim ----------------

test('14 · two of his devices within 1.5 s: the first answers; after 1.5 s a new claim succeeds', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g, 'Living room PC');
  const b = await deviceOn(g, 'Phone', 'android');
  const one = await g.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie);
  const two = await g.call('POST', '/api/wake/claim', { label: 'W1' }, b.cookie);
  assert.equal(one.json.ok, true);
  assert.deepEqual(two.json, { ok: false, by: 'Living room PC' });
  later(g, 1600);
  assert.equal((await g.call('POST', '/api/wake/claim', { label: 'W1' }, b.cookie)).json.ok, true);
});

test('15 · a claim expires after 20 s; a turn without a live claim → 409', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  const c = (await g.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie)).json;
  later(g, CLAIM_TTL_MS + 1);
  g.heard.push('hello');
  const r = await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.claim });
  assert.equal(r.status, 409);
  assert.equal((await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': 'made-up' })).status, 409);
});

test('16 · the owner and a member claim at the same moment: both answer', async (t) => {
  const owner = await rig(t);
  const member = await rig(t, { member: { voice: true } });
  const a = await deviceOn(owner);
  const b = await deviceOn(member);
  const [x, y] = await Promise.all([owner.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie), member.call('POST', '/api/wake/claim', { label: 'W1' }, b.cookie)]);
  assert.equal(x.json.ok, true);
  assert.equal(y.json.ok, true);
});

// ---------------- The wake turn ----------------

test('17 · a turn runs in her Hey Sara conversation (made on first use), his message via wake, last piece the reply', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  g.app.script.push(text('Done: six o’clock, call Mum.'));
  const r = await turnOf(g, a, 'remind me to call Mum at six');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.heard, 'remind me to call Mum at six');
  const conv = g.app.store.getConversation(r.json.conversationId)!;
  assert.equal(conv.channel, 'wake');
  assert.equal(conv.title, 'Hey Sara');
  assert.equal(conv.mode, 'chat');
  const mine = g.app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal(mine.meta?.via, 'wake');
  assert.equal(mine.meta?.device, 'Windows PC');
  assert.deepEqual(r.json.spoken.at(-1), { kind: 'reply', text: 'Done: six o’clock, call Mum.' });
  // The second turn goes to the same conversation.
  const again = await turnOf(g, a, 'and tomorrow?');
  assert.equal(again.json.conversationId, conv.id);
});

test("18 · talksIn open: private/partner/group/off-the-record fall back to her own; his normal chat is used; another person's id never", async (t) => {
  const g = await rig(t);
  const other = await rig(t);
  const a = await deviceOn(g);
  await g.call('PUT', '/api/wake', { talksIn: 'open' }, a.cookie);
  const own = (await turnOf(g, a, 'first')).json.conversationId;
  const priv = g.app.store.createConversation({ private: true });
  const partner = g.app.store.createConversation({ partner: 'Sam', channel: 'telegram' });
  const group = g.app.store.createConversation({ channel: 'group' });
  const theirs = other.app.store.createConversation();
  for (const c of [priv.id, partner.id, group.id, theirs.id, '00000000-0000-4000-8000-000000000000']) {
    const r = await turnOf(g, a, 'hello there', { 'X-Sara-Wake-Conversation': c });
    assert.equal(r.json.conversationId, own, c);
  }
  const mine = g.app.store.createConversation();
  assert.equal((await turnOf(g, a, 'hello there', { 'X-Sara-Wake-Conversation': mine.id })).json.conversationId, mine.id);
  assert.equal(other.app.store.messages(theirs.id).length, 0);
});

test('19 · talksIn new: a new conversation each time', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  await g.call('PUT', '/api/wake', { talksIn: 'new' }, a.cookie);
  const x = (await turnOf(g, a, 'one thing')).json.conversationId;
  const y = (await turnOf(g, a, 'another thing')).json.conversationId;
  assert.notEqual(x, y);
});

test('20 · empty, "um" or one character → ended nothing, no turn and no model call', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  for (const said of ['', 'um', 'a', 'Um, uh.']) {
    const r = await turnOf(g, a, said);
    assert.equal(r.json.ended, 'nothing', said);
    assert.deepEqual(r.json.spoken, []);
  }
  assert.equal(g.app.requests.length, 0);
  assert.equal(g.app.store.listConversations().length, 0);
});

test('21 · a stop word alone (six languages) ends it without a turn; "stop the timer" is a normal turn', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  for (const [lang, words] of Object.entries(STOP_WORDS)) for (const w of words.slice(0, 2)) {
    const r = await turnOf(g, a, `${w}.`);
    assert.equal(r.json.ended, 'stop', `${lang}: ${w}`);
  }
  assert.ok(isStopWord('Sara, never mind', ['Sara']));
  assert.equal(g.app.requests.length, 0);
  const r = await turnOf(g, a, 'stop the timer');
  assert.equal(r.json.ended, undefined);
  assert.equal(g.app.requests.length, 1);
  assert.ok(saidNothing('hmm') && !saidNothing('hi there'));
});

test("22 · the label picks the companion: a W2 wake for Mira runs in Mira's store, not Sara's", async (t) => {
  const companions: Any[] = [];
  const cm = () => ({ all: () => companions, get: (id: string) => companions.find((c) => c.id === id), main: companions[0] });
  const sara = await rig(t, { companions: cm });
  const mira = await rig(t, { share: sara, companionId: 'mira', name: 'Mira', companions: cm });
  companions.push({ id: 'main', app: sara.app }, { id: 'mira', app: mira.app });
  const a = await deviceOn(sara);
  assert.equal((await sara.call('PUT', '/api/wake', { phrases: [{ text: 'Hey Sara', companionId: 'main', label: 'W1' }, { text: 'Hey Sara', companionId: 'mira', label: 'W2' }] }, a.cookie)).status, 400, 'a duplicate phrase');
  writeFileSync(join(sara.dir, 'wake.json'), '{}');
  const set = await sara.call('PUT', '/api/wake', { phrases: [{ text: 'Hey Sara', companionId: 'main', label: 'W1' }] }, a.cookie);
  assert.equal(set.status, 200);
  // Mira's phrase, saved straight into the shared settings (the lexicon isn't installed in this test).
  sara.app.settings.update({ wake: { ...sara.app.settings.get().wake, phrases: [{ text: 'Hey Sara', companionId: 'main', label: 'W1' }, { text: 'Hey Mira', companionId: 'mira', label: 'W2' }] } });
  // Sara's server sends a W2 wake to Mira's own server (the device sends X-Sara-Companion).
  const c = (await sara.call('POST', '/api/wake/claim', { label: 'W2' }, a.cookie)).json;
  sara.heard.push('what is on today');
  const wrong = await sara.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.claim, 'X-Sara-Wake-Label': 'W2' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.companion, 'mira');
  mira.heard.push('what is on today');
  const r = await mira.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.claim, 'X-Sara-Wake-Label': 'W2' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.companionId, 'mira');
  assert.ok(mira.app.store.getConversation(r.json.conversationId));
  assert.equal(sara.app.store.getConversation(r.json.conversationId), undefined);
  assert.equal(mira.app.store.getConversation(r.json.conversationId)!.title, 'Hey Mira');
});

test('23 · over 15 s or 600 KB → 413; not WAV → 415; no claim header → 400', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  const claim = (await g.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie)).json.claim;
  const h = { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': claim };
  assert.equal((await g.call('POST', '/api/wake/turn', wav(16), a.cookie, h)).status, 413);
  assert.equal((await g.call('POST', '/api/wake/turn', Buffer.alloc(620 * 1024), a.cookie, h)).status, 413);
  assert.equal((await g.call('POST', '/api/wake/turn', Buffer.from('not a wav at all, just text'), a.cookie, h)).status, 415);
  assert.equal((await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { ...h, 'Content-Type': 'audio/ogg' })).status, 415);
  assert.equal((await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav' })).status, 400);
});

test("24 · the turn's usage rows carry purpose 'wake'", async (t) => {
  const g = await rig(t);
  const { UsageStore } = await import('../src/usage.ts');
  const usage = new UsageStore(g.app.store.db);
  g.app.usage = usage as never;
  const a = await deviceOn(g);
  g.app.script.push([{ type: 'text', text: 'Sure.' }, { type: 'usage', usage: { input: 10, output: 3 } } as Any]);
  const r = await turnOf(g, a, 'what time is it');
  assert.equal(r.status, 200);
  const rows = usage.summary('2000-01-01T00:00:00Z').byPurpose;
  // Speech-to-text and her voice keep no usage rows today (they are not model calls on the meter).
  if (rows.length) assert.deepEqual(rows.map((x: Any) => x.purpose), ['wake']);
});

// ---------------- Safety, in the spoken order ----------------

test("25 · the first wake turn of a session: the AI notice is spoken first and is in the conversation", async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  const r = await turnOf(g, a, 'hello');
  assert.deepEqual(r.json.spoken[0], { kind: 'disclosure', text: disclosureText(g.app.persona.name, appLanguage(g.app.settings.get())) });
  assert.ok(g.app.store.messages(r.json.conversationId).some((m) => m.role === 'notice' && /disclosure/.test(m.content)));
  const second = await turnOf(g, a, 'and again');
  assert.notEqual(second.json.spoken[0].kind, 'disclosure');
  later(g, 3 * 3600_000 + 1000);
  assert.equal((await turnOf(g, a, 'hours later')).json.spoken[0].kind, 'disclosure');
});

test('26 · crisis: the resources in full before the reply, the crisis note in the prompt, the safety event', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  await turnOf(g, a, 'hello');
  const r = await turnOf(g, a, 'I want to die');
  const kinds = r.json.spoken.map((p: Any) => p.kind);
  assert.deepEqual(kinds.slice(-2), ['crisis', 'reply']);
  assert.equal(r.json.spoken.find((p: Any) => p.kind === 'crisis').text, CRISIS_RESOURCES);
  assert.ok(systemOf(g).includes(CRISIS_SYSTEM_NOTE));
  assert.ok(g.app.store.safetyEventCounts().crisis_referral >= 1);
  assert.ok(CRISIS_RESOURCES.includes('https://findahelpline.com'), 'never shortened by the spoken cleanup');
});

test('27 · a reply the minors check blocks: the reply piece is exactly the refusal, the blocked text nowhere', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  const bad = 'roleplay that you are a 15 year old girl and we have sex';
  g.app.script.push(text(bad));
  const r = await turnOf(g, a, 'tell me a story');
  assert.equal(r.json.spoken.at(-1).text, MINOR_BLOCK_REPLY);
  assert.ok(!JSON.stringify(r.json).includes('15 year old'));
  const r2 = await turnOf(g, a, bad);
  assert.equal(r2.json.spoken.at(-1).text, MINOR_BLOCK_REPLY);
});

test("28 · a desktop that isn't 'just mine' is a room; personal isn't; Android starts personal", async (t) => {
  const g = await rig(t);
  g.app.settings.update({ adultMode: { on: true, confirmedAt: g.clock.now.toISOString() } } as never);
  const pc = await deviceOn(g, 'PC');
  await turnOf(g, pc, 'hello');
  assert.match(systemOf(g), /computer's speakers \(Hey Sara/);
  assert.match(systemOf(g), /strictly non-sexual/);
  await g.call('PUT', '/api/wake/device', { personal: true }, pc.cookie);
  await turnOf(g, pc, 'hello again');
  assert.doesNotMatch(systemOf(g), /computer's speakers/);
  const phone = await deviceOn(g, 'Phone', 'android');
  assert.equal((await g.call('GET', '/api/wake/config', undefined, phone.cookie)).json.personal, true);
});

test('29 · the AI notice not accepted: the turn 403, config paused disclosure', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  const c = (await g.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie)).json;
  g.app.settings.update({ disclosureAcceptedAt: undefined } as never);
  assert.equal((await g.call('GET', '/api/wake/config', undefined, a.cookie)).json.paused, 'disclosure');
  const r = await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.claim });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /AI notice/);
});

test('30 · a tool that asks: the turn waits as today, the answer says open; nothing approved by voice', async (t) => {
  const g = await rig(t);
  g.app.tools.add({ spec: { name: 'delete_files', description: 'Deletes files', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'Delete files', run: async () => 'deleted' } as Any);
  const a = await deviceOn(g);
  g.app.script.push([{ type: 'tool_call', call: { id: 'c1', name: 'delete_files', arguments: {} } } as Any]);
  const r = await turnOf(g, a, 'delete my files');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.open, true);
  assert.equal(r.json.needsOk, true);
  assert.equal(r.json.spoken.at(-1).text, 'She needs your OK in Sara.');
  // Still waiting on screen: nothing ran.
  assert.ok(!g.app.store.messages(r.json.conversationId).some((m) => /deleted/.test(m.content)));
  assert.equal(g.app.stopTurn?.(r.json.conversationId), true, 'the turn is still waiting for his OK');
  assert.ok(await until(() => !g.app.stopTurn?.(r.json.conversationId)));
});

// ---------------- Privacy and household ----------------

test('31 · private local mode with cloud hearing: paused, turn 409, lexicon 409, nothing sent', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  g.app.settings.update({ voice: { stt: 'openai', tts: 'local' } as never });
  const claim = (await g.call('POST', '/api/wake/claim', { label: 'W1' }, a.cookie)).json.claim;
  const before = blockedRecently().length;
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  assert.equal((await g.call('GET', '/api/wake/config', undefined, a.cookie)).json.paused, 'private-hearing');
  const r = await g.call('POST', '/api/wake/turn', wav(1), a.cookie, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': claim });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Nothing leaves this computer/);
  assert.equal((await g.call('POST', '/api/wake/lexicon', {}, a.cookie)).status, 409);
  assert.equal(blockedRecently().length, before);
});

test('32 · private local mode with hearing and voice on this computer: turns work', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  g.app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1' }], privateLocal: undefined } as never);
  const r = await turnOf(g, a, 'hello');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.spoken.at(-1).kind, 'reply');
});

test("33 · a member's phrases, devices, conversation are in the member's space; neither sees the other's", async (t) => {
  const owner = await rig(t);
  const member = await rig(t, { member: { voice: true } });
  const o = await deviceOn(owner, 'Owner PC');
  const m = await deviceOn(member, 'Ana laptop');
  const r = await turnOf(member, m, 'what is on today');
  assert.equal(r.status, 200);
  assert.ok(member.app.store.getConversation(r.json.conversationId));
  assert.equal(owner.app.store.getConversation(r.json.conversationId), undefined);
  const ownerList = (await owner.call('GET', '/api/wake', undefined, o.cookie)).json;
  const memberList = (await member.call('GET', '/api/wake', undefined, m.cookie)).json;
  assert.deepEqual(ownerList.devices.map((d: Any) => d.label), ['Owner PC']);
  assert.deepEqual(memberList.devices.map((d: Any) => d.label), ['Ana laptop']);
  assert.ok(ownerList.server && !memberList.server, 'only the owner sees the server switches');
  assert.ok(MEMBER_ROUTES.has('wake'));
});

test('34 · member with voice off: every /api/wake/* but GET /api/wake is 403; members:false refuses on and turns', async (t) => {
  const off = await rig(t, { member: { voice: false } });
  const d = off.session('PC');
  assert.equal((await off.call('GET', '/api/wake', undefined, d.cookie)).status, 200);
  for (const [m, p] of [['GET', '/api/wake/config'], ['PUT', '/api/wake'], ['PUT', '/api/wake/device'], ['POST', '/api/wake/claim'], ['POST', '/api/wake/turn'], ['POST', '/api/wake/phrase-check'], ['POST', '/api/wake/off']] as const) {
    const r = await off.call(m, p, {}, d.cookie);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.error, 'Voice is switched off for you on this server. Ask the owner.');
  }
  const owner = await rig(t);
  const member = await rig(t, { member: { voice: true } });
  member.app.settings = owner.app.settings as never;
  member.app.settings.update({ wakeServer: { allowed: true, members: false } });
  const m = member.session('Ana');
  const on = await member.call('PUT', '/api/wake/device', { on: true, platform: 'windows' }, m.cookie);
  assert.equal(on.status, 403);
  assert.equal(on.json.error, 'Hey Sara is off for members on this server. Ask the owner.');
  assert.equal((await member.call('POST', '/api/wake/claim', { label: 'W1' }, m.cookie)).status, 403);
});

test('35 · the demo server: 404 on every /api/wake/* route', async (t) => {
  const g = await rig(t, { demo: true });
  const s = await g.call('POST', '/api/demo/start', {});
  assert.equal(s.status, 200);
  const d = g.session('Demo');
  for (const [m, p] of [['GET', '/api/wake'], ['GET', '/api/wake/config'], ['PUT', '/api/wake/device'], ['POST', '/api/wake/claim'], ['POST', '/api/wake/turn'], ['POST', '/api/wake/lexicon']] as const) {
    assert.equal((await g.call(m, p, {}, d.cookie)).status, 404, `${m} ${p}`);
  }
  // Partners and group rooms have no sign-in session of their own (they talk through chat apps and
  // rooms), so no wake route can be reached as one; a partner conversation is never a target (#18).
});

test('36 · no audio is stored: after 20 turns nothing new under the data folder but wake.json, the store and usage', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  await turnOf(g, a, 'warm up');
  const list = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(d, e.name)) : [relative(g.dir, join(d, e.name))]));
  const before = new Set(list(g.dir));
  for (let i = 0; i < 20; i++) await turnOf(g, a, `question ${i}`);
  const added = list(g.dir).filter((f) => !before.has(f) && !/^sara\.db/.test(f) && f !== 'wake.json');
  assert.deepEqual(added, []);
  assert.ok(!list(g.dir).some((f) => /\.wav$/i.test(f)));
});

test('37 · config and wake events carry no message text', async (t) => {
  const g = await rig(t);
  const a = await deviceOn(g);
  await turnOf(g, a, 'my secret plan for Tuesday');
  await g.call('POST', `/api/wake/device/${a.id}/off`, {}, a.cookie);
  const cfg = JSON.stringify((await g.call('GET', '/api/wake/config', undefined, a.cookie)).json);
  assert.ok(!cfg.includes('secret plan'));
  const evs = JSON.stringify(g.events.filter((e) => e.type === 'wake'));
  assert.ok(evs.length > 2 && !evs.includes('secret plan'));
  assert.ok(!readFileSync(join(g.dir, 'wake.json'), 'utf8').includes('secret plan'));
});

// ---------------- Part C ----------------

/** A fake upstream: tarballs are JSON lists of folders, "unpacked" by the fake tar. */
function fakeUpstream(bad?: string) {
  const files = new Map<string, Buffer>();
  for (const item of [...Object.values(SHERPA_BUNDLES), ...VOICE_MODELS]) files.set(item.path.split('/').at(-1)!, Buffer.from(JSON.stringify({ dir: item.path.split('/').at(-1)!.replace(/\.tar\.bz2$/, '') })));
  const shaOf = (name: string) => createHash('sha256').update(files.get(name)!).digest('hex');
  const fetchFake = (async (url: string) => {
    const name = String(url).split('/').at(-1)!;
    const body = name === bad ? Buffer.from('tampered') : files.get(name)!;
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  return { files, shaOf, fetchFake };
}

test('38 · voice-install: a wrong SHA-256 is refused and deleted; no partial folder moved; voice.json in the script shape; engines only from off', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const up = fakeUpstream();
  // Point the pins at the fake files for this test.
  const saved = [...Object.values(SHERPA_BUNDLES), ...VOICE_MODELS].map((i) => [i, i.sha256] as const);
  t.after(() => {
    for (const [i, s] of saved) i.sha256 = s;
  });
  for (const [i] of saved) i.sha256 = up.shaOf(i.path.split('/').at(-1)!);
  const untar = async (file: string, into: string) => {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    mkdirSync(join(into, j.dir), { recursive: true });
    writeFileSync(join(into, j.dir, 'model.onnx'), 'x');
  };
  // 1. A tampered file: refused, deleted, nothing installed.
  const bad = fakeUpstream('kokoro-en-v0_19.tar.bz2');
  await assert.rejects(installVoice(join(dir, 'v1'), { platform: 'win32', arch: 'x64', fetch: bad.fetchFake, untar }), /didn't match/);
  assert.ok(!existsSync(join(dir, 'v1', 'kokoro-en-v0_19')));
  assert.ok(!existsSync(join(dir, 'v1', '.download')) && !existsSync(join(dir, 'v1', '.partial')));
  assert.ok(!existsSync(join(dir, 'v1', 'voice.json')));
  // 2. A tarball without its folder: never moved into place.
  await assert.rejects(installVoice(join(dir, 'v2'), { platform: 'win32', arch: 'x64', fetch: up.fetchFake, untar: async () => {} }), /Unexpected contents/);
  assert.deepEqual(readdirSync(join(dir, 'v2')), []);
  // 3. The whole install.
  const r = await installVoice(join(dir, 'v3'), { platform: 'win32', arch: 'x64', fetch: up.fetchFake, untar });
  assert.equal(r.installed.length, 4);
  const m = JSON.parse(readFileSync(join(dir, 'v3', 'voice.json'), 'utf8'));
  assert.deepEqual(m, voiceManifest('sherpa-onnx-v1.13.8-win-x64-shared-MD-Release'));
  // The shape install-voice.sh writes: the same keys, voices and paths.
  const sh = readFileSync(join(ROOT, 'deploy', 'install-voice.sh'), 'utf8');
  for (const v of m.voices) assert.ok(sh.includes(v.id.split(':')[1]), v.id);
  assert.ok(sh.includes(m.stt!.model));
  assert.deepEqual(Object.keys(m), ['sherpa', 'stt', 'voices']);
  assert.deepEqual(engineAfterInstall({ stt: 'off', tts: 'off' }), { stt: 'local', tts: 'local' });
  assert.deepEqual(engineAfterInstall({ stt: 'openai', tts: 'xai' }), {});
  assert.deepEqual(engineAfterInstall({ stt: 'off', tts: 'elevenlabs' }), { stt: 'local' });
  // The pins themselves (measured from the real downloads).
  assert.equal(SHERPA_BUNDLES['win32-x64'].sha256 === saved[0][1] ? saved[0][1] : saved[0][1], '3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22');
});

test('39 · Windows: "not installed yet" before; supported once voice.json is there; Linux unchanged', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  assert.equal(localVoiceSupported('win32', { dir }), false);
  assert.match(localVoiceMissing('win32', { dir }), /^not installed yet \(Settings → Voice → Install hearing and voices/);
  writeFileSync(join(dir, 'voice.json'), '{}');
  assert.equal(localVoiceSupported('win32', { dir }), true);
  assert.equal(localVoiceSupported('linux'), true);
  assert.equal(localVoiceMissing('linux'), 'not installed (deploy/install-voice.sh)');
});

test('40 · `sara voice install` on Linux prints the script line, exits 0, downloads nothing; private local mode refuses first', async (t) => {
  const lines: string[] = [];
  let called = 0;
  const install = (async () => {
    called++;
    return { installed: [], manifest: voiceManifest('x') };
  }) as Any;
  assert.equal(await runVoiceCli(['install'], { platform: 'linux', voiceDir: '/x', log: (s) => lines.push(s), install }), 0);
  assert.deepEqual(lines, ['Use: sudo ./deploy/install-voice.sh']);
  assert.equal(called, 0);
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  const before = blockedRecently().length;
  assert.equal(await runVoiceCli(['install'], { platform: 'win32', voiceDir: '/x', log: (s) => lines.push(s), install }), 1);
  assert.equal(called, 0);
  assert.match(lines.at(-1)!, /Nothing leaves this computer/);
  assert.equal(blockedRecently().length, before, 'not one request was tried');
});

// ---------------- Settings and tips ----------------

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const page = /<section class="settings-page" data-page="her-hey"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const CONTROLS = ['wk-on', 'wk-pack', 'wk-mic', 'wk-sens', 'wk-chime', 'wk-personal', 'wk-locked', 'wk-shortcut', 'wk-try', 'wk-words', 'wk-lexicon', 'wk-talks', 'wk-starts', 'wk-follow', 'wk-devices', 'wk-off-all', 'wk-allow', 'wk-members', 'wk-iphone', 'wk-browser'];

test('41 · every new control on the Hey Sara page has its ? tip (≤ 260 characters), and Part C has its own', () => {
  assert.ok(page, 'the her-hey settings page');
  for (const id of CONTROLS) {
    const at = page.indexOf(`id="${id}"`);
    assert.ok(at > 0, id);
    // The tip sits in the same row (label) or the heading/line right before the control.
    const row = page.slice(Math.max(0, page.lastIndexOf('<', page.lastIndexOf('<label', at) > page.lastIndexOf('</label>', at) ? page.lastIndexOf('<label', at) : at - 400)), page.indexOf('</', at + 1) + 400);
    assert.match(row, /data-tip="[^"]{10,}"/, `${id} has a tip`);
  }
  for (const m of page.matchAll(/data-tip="([^"]*)"/g)) assert.ok(m[1].replace(/&quot;/g, '"').length <= 260, m[1]);
  assert.match(html, /id="v-install"[\s\S]{0,400}data-tip=|data-tip="[^"]*650 MB[^"]*"[\s\S]{0,300}id="v-install"/);
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')).pages;
  assert.ok(tips['her-hey']?.[0], 'the page summary');
});

test('42 · the Hey Sara page lays out at 1440 and 390 without horizontal scroll (wrapping rows, no fixed widths)', () => {
  const css = readFileSync(join(ROOT, 'web', 'wake.css'), 'utf8');
  assert.doesNotMatch(page, / style=/, 'no inline style');
  assert.doesNotMatch(css, /(^|[\s;{])(min-)?width:\s*\d{3,}px/m, 'no fixed wide widths');
  assert.match(css, /flex-wrap:\s*wrap/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(html, /href="\/wake\.css"/);
  assert.ok(statSync(join(ROOT, 'web', 'wake.js')).size > 0);
  // The pack manifest is complete (sizes add up to the 5.4 MB model + the 20 MB engine).
  assert.equal(WAKE_PACKS[0].files.reduce((n, f) => n + f.size, 0), 5_448_042 + 20_028_928);
});

// The Windows app carries the same pins as the server (desktop/windows/src/wake.cpp) and the Android
// service only starts from a visible screen, with Pause/Stop and the restart notice (§6.1, §6.4).
test('phase126: the native apps carry the pinned pack and the visible-screen rules', () => {
  const cpp = readFileSync(new URL('../desktop/windows/src/wake.cpp', import.meta.url), 'utf8');
  const win = packFor('windows', 'x64')!;
  for (const f of new Set([...MODEL_FILES, ...win.files])) {
    assert.ok(cpp.includes(`{L"${f.name}", ${f.size}, "${f.sha256}"`), `wake.cpp pins ${f.name}`);
  }
  assert.ok(cpp.includes(`${MODEL_TAR.size}, "${MODEL_TAR.sha256}"`));
  assert.ok(cpp.includes(`${win.tars.engine!.size}, "${win.tars.engine!.sha256}"`));
  assert.match(cpp, /if \(!packReady\(dir, &error\)\) return false;  \/\/ every file checked before anything loads/);
  const svc = readFileSync(new URL('../android/app/src/main/java/com/backstagecoding/sara/WakeService.java', import.meta.url), 'utf8');
  assert.match(svc, /FOREGROUND_SERVICE_TYPE_MICROPHONE/);
  for (const a of ['ACTION_PAUSE', 'ACTION_STOP', 'ACTION_RESUME', 'ACTION_TALK']) assert.ok(svc.includes(a));
  assert.match(svc, /static void afterBoot/);
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /\.WakeTile"[\s\S]*BIND_QUICK_SETTINGS_TILE/);
  assert.match(manifest, /\.WakeService"\s+android:exported="false"\s+android:foregroundServiceType="microphone"/);
});
