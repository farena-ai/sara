// U4.24 (docs/VOICE_FIRST.md): Talk with Sara, the voice-first mode. The page's turn loop (web/talk.js:
// goodbye, spoken yes/no for a waiting card, filler lines while she thinks, the live transcript, first
// audio timing), the speech gate on the classic call's energy VAD (web/voice.js), the server's
// voice hard limits (money and passwords never by voice, in talk, car mode and phone calls), the talk
// prefs, the talk note on a turn, the /api/talk/answer route (member voice switch, prefs) and Hey Sara
// starting a talk. No network, no microphone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { voiceAnswer } from '../src/car-errands.ts';
import { phoneMayApprove, voiceMayApprove, VOICE_NEVER_TOOL } from '../src/phone-actions.ts';
import { cleanTalk, talkNote, TALK_DEFAULTS } from '../src/talk.ts';
import { wakeView } from '../src/wake.ts';

registerHooks({ resolve: (spec, ctx, next) => (spec === './identity.js' ? next(new URL('../src/identity.ts', import.meta.url).href, ctx) : next(spec, ctx)) });
// @ts-expect-error plain browser JavaScript, no types
const talk = (await import('../web/talk.js')) as Record<string, any>;
// @ts-expect-error plain browser JavaScript, no types
const { Call, SpeechGate } = (await import('../web/voice.js')) as Record<string, any>;

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('goodbye ends the talk in six languages; a sentence that only contains the word does not', () => {
  for (const s of ['Goodbye.', 'bye Sara', 'Okay, bye!', "That's all for now", 'thanks, goodbye', 'Adiós', 'au revoir', 'Tschüss', 'tchau', 'arrivederci', 'ciao Sara'])
    assert.equal(talk.goodbyeCommand(s), true, s);
  for (const s of ['say goodbye to my sister in an email', 'how do I say goodbye in Japanese?', 'bye the way, what time is it', '', 'hello'])
    assert.equal(talk.goodbyeCommand(s), false, s);
});

test('the page mirrors the server rule for which cards a spoken yes may answer', () => {
  const cases = [
    { name: 'mail_send', summary: 'Send to Bo' },
    { name: 'errand_start', summary: 'Start' },
    { name: 'pc_click', summary: 'click' },
    { name: 'allowance_pay', summary: 'Pay 5' },
    { name: 'pc_browser_save_login', summary: 'save' },
    { name: 'ssh_forget_password', summary: 'forget' },
    { name: 'buy_tickets', summary: 'buy' },
    { name: 'note_add', summary: 'x', spend: { usd: 2 } },
    { name: 'note_add', summary: 'x', price: '3 USD' },
    { name: 'shell', summary: 'x', sandbox: true },
    { name: 'vault_set', summary: 'x' },
  ];
  for (const c of cases) assert.equal(talk.voiceMayAnswer(c), voiceMayApprove(c), c.name);
  assert.equal(voiceMayApprove({ name: 'mail_send' }), true);
  assert.equal(voiceMayApprove({ name: 'allowance_pay' }), false, 'money never by voice');
  assert.equal(phoneMayApprove({ name: 'allowance_pay' }), true, 'a tap on a phone notification still may');
  assert.equal(VOICE_NEVER_TOOL('pc_browser_login'), true);
  assert.equal(VOICE_NEVER_TOOL('ssh_forget_password'), true);
  assert.equal(VOICE_NEVER_TOOL('note_add'), false);
});

function session(over: Record<string, unknown> = {}) {
  const log: string[] = [];
  const timers: (() => void)[] = [];
  let now = 1000;
  const s = new talk.TalkSession({
    now: () => now,
    setTimer: (fn: () => void) => (timers.push(fn), timers.length),
    clearTimer: (h: number) => (timers[h - 1] = () => {}),
    prefs: () => ({ ...TALK_DEFAULTS }),
    say: (line: string) => log.push(`say:${line}`),
    filler: (i: number) => log.push(`filler:${i}`),
    stopFiller: () => log.push('stopFiller'),
    send: async (text: string) => void log.push(`send:${text}`),
    answer: async (ok: boolean) => (log.push(`answer:${ok}`), { line: ok ? 'Approved.' : 'Declined.' }),
    end: (why: string) => log.push(`end:${why}`),
    onLines: () => {},
    ...over,
  });
  return { s, log, timers, tick: (ms: number) => (now += ms), fire: () => timers.splice(0).forEach((f) => f()) };
}

test('a turn: what you said is sent, a filler plays only while she is still quiet, first audio is timed', async () => {
  const { s, log, fire, tick } = session();
  assert.equal(await s.heard('what is on my calendar'), 'sent');
  assert.deepEqual(log.filter((l) => l !== 'stopFiller'), ['send:what is on my calendar']);
  fire();
  assert.equal(log.at(-1), 'filler:0');
  tick(900);
  const n = log.length;
  s.herText('You have two meetings.');
  assert.deepEqual(log.slice(n), ['stopFiller'], 'her first words stop the filler');
  s.herAudio();
  assert.equal(s.latency.at(-1), 900);
  s.herDone();
  assert.deepEqual(
    s.lines.map((l: { who: string; text: string }) => [l.who, l.text]),
    [['you', 'what is on my calendar'], ['her', 'You have two meetings.']],
  );
  // Next turn: she answers before the filler time, so no filler; the filler index moves on otherwise.
  await s.heard('thanks');
  s.herText('Any time.');
  fire();
  assert.equal(log.filter((l) => l.startsWith('filler')).length, 1);
});

test('the clock and the filler start when you stop talking, before hearing is done', async () => {
  const { s, log, fire, tick } = session();
  s.ended();
  tick(700);
  fire();
  assert.equal(log.at(-1), 'filler:0', 'the filler plays while hearing still works');
  tick(500);
  await s.heard('what time is it');
  fire();
  assert.equal(log.filter((l) => l.startsWith('filler')).length, 1, 'one filler per turn');
  tick(1300);
  s.herText('It is noon.');
  s.herAudio();
  assert.equal(s.latency.at(-1), 2500, 'measured from the end of your words');
  // A cough: hearing finds nothing, so no filler plays for it.
  s.ended();
  s.nothing();
  fire();
  assert.equal(log.filter((l) => l.startsWith('filler')).length, 1);
});

test('fillers can be switched off; goodbye ends', async () => {
  const { s, log, fire } = session({ prefs: () => ({ ...TALK_DEFAULTS, fillers: false }) });
  await s.heard('hi');
  fire();
  assert.ok(!log.some((l) => l.startsWith('filler')));
  assert.equal(await s.heard('Goodbye!'), 'end');
  assert.ok(log.includes('end:goodbye'));
  assert.ok(!log.includes('send:Goodbye!'), 'goodbye is never sent to her');
});

test('a waiting card: she says how to answer; yes/no answer it by voice, other words go to her', async () => {
  const { s, log } = session();
  assert.equal(s.keepsTurn('yes'), false, 'nothing waits yet');
  s.approval({ id: 'c1', name: 'mail_send', summary: 'Send to Bo' });
  assert.match(log.at(-1)!, /^say:Say yes to go ahead/);
  assert.equal(s.waiting, true);
  assert.equal(s.keepsTurn('yes'), true, 'a yes for the card never stops the turn that waits');
  assert.equal(s.keepsTurn('what about tomorrow'), false);
  assert.equal(await s.heard('yes'), 'answer');
  assert.ok(log.includes('answer:true'));
  assert.equal(log.at(-1), 'say:Approved.');
  s.approvalDone('c1');
  assert.equal(await s.heard('yes'), 'sent', 'nothing waits: a yes is just words to her');
  // A money card: the spoken yes is refused before reaching the server; the card waits for a tap.
  s.approval({ id: 'c2', name: 'allowance_pay', summary: 'Pay 5' });
  assert.match(log.at(-1)!, /needs a tap/);
  const before = log.filter((l) => l.startsWith('answer')).length;
  assert.equal(await s.heard('yes'), 'tap');
  assert.equal(log.filter((l) => l.startsWith('answer')).length, before);
});

test('approve by voice switched off: every card needs a tap', async () => {
  const { s, log } = session({ prefs: () => ({ ...TALK_DEFAULTS, approveByVoice: false }) });
  s.approval({ id: 'c1', name: 'mail_send', summary: 'Send' });
  assert.match(log.at(-1)!, /needs a tap/);
  assert.equal(await s.heard('approve'), 'tap');
  assert.ok(!log.some((l) => l.startsWith('answer')));
});

test('the speech gate: voiced sound passes, steady hiss and mains hum do not', () => {
  const rate = 48000;
  const frames = (fn: (i: number) => number, ms: number) => {
    const out: Float32Array[] = [];
    let i = 0;
    for (let t = 0; t < ms; t += 128000 / rate) {
      const f = new Float32Array(128);
      for (let k = 0; k < 128; k++, i++) f[k] = fn(i);
      out.push(f);
    }
    return out;
  };
  const verdict = (fn: (i: number) => number) => {
    const g = new SpeechGate(rate);
    let v = true;
    for (const f of frames(fn, 300)) v = g.push(f);
    return v;
  };
  // A voice: a 140 Hz pitch with formant-ish harmonics.
  const voiceFn = (i: number) => 0.2 * Math.sin((2 * Math.PI * 140 * i) / rate) + 0.15 * Math.sin((2 * Math.PI * 700 * i) / rate) + 0.08 * Math.sin((2 * Math.PI * 1200 * i) / rate);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.4;
  assert.equal(verdict(voiceFn), true, 'voice');
  assert.equal(verdict(() => noise()), false, 'hiss');
  assert.equal(verdict((i) => 0.3 * Math.sin((2 * Math.PI * 50 * i) / rate)), false, 'hum');
});

test('the classic call takes an optional speech gate: loud non-speech never starts an utterance', async () => {
  const mk = (isSpeech?: () => boolean) => {
    const mic = { ctx: { sampleRate: 16000 }, chunks: [] as Float32Array[], onFrame: null as null | ((f: Float32Array, l: number) => void), async open() {}, start() {}, close() {}, trim() {}, stop: () => new Uint8Array(10) };
    const statuses: string[] = [];
    const call = new Call({ mic, speaker: { speaking: false, stop() {} }, transcribe: async () => 'x', onUtterance: async () => {}, onStatus: (s: string) => statuses.push(s), isSpeech });
    return { mic, call, statuses };
  };
  for (const [gate, want] of [[() => false, false], [undefined, true]] as const) {
    const { mic, call, statuses } = mk(gate);
    await call.start();
    for (let t = 0; t < 400; t += 20) mic.onFrame!(new Float32Array(320), 0.3);
    assert.equal(statuses.includes('hearing'), want);
  }
});

test('talk prefs, the talk note and Hey Sara starting a talk', () => {
  assert.deepEqual(cleanTalk(undefined), TALK_DEFAULTS);
  assert.deepEqual(cleanTalk({ fillers: false, approveByVoice: 'yes', goodbye: false }), { fillers: false, approveByVoice: true, goodbye: false, keepLoaded: 10, hearing: 'whole' });
  const note = talkNote('Alex');
  assert.match(note, /spoken/);
  assert.match(note, /no lists, tables, markdown/);
  assert.match(note, /money or passwords/);
  assert.equal(wakeView({ starts: 'talk' }, () => []).starts, 'talk');
  assert.equal(wakeView({ starts: 'nonsense' as 'call' }, () => []).starts, 'question');
});

test('voiceAnswer (talk and car mode) refuses money and password cards; a plain card is answered', (t) => {
  const decided: [string, boolean][] = [];
  const app = { approvals: { decide: (id: string, ok: boolean) => (decided.push([id, ok]), true) } } as unknown as Parameters<typeof voiceAnswer>[0];
  const active = new Map<string, { approvals: Map<string, unknown> }>();
  active.set('c', { approvals: new Map([['x', { approvalId: 'a1', name: 'allowance_pay', summary: 'Pay 5' }]]) });
  const r = voiceAnswer(app, active, 'c', true);
  assert.equal(r.ok, false);
  assert.equal(r.tapOnly, true);
  assert.deepEqual(decided, []);
  active.set('c', { approvals: new Map([['y', { approvalId: 'a2', name: 'mail_send', summary: 'Send' }]]) });
  assert.equal(voiceAnswer(app, active, 'c', false).ok, true);
  assert.deepEqual(decided, [['a2', false]]);
  t.diagnostic('phone calls use the same rule');
  assert.match(read('src/phone-calls.ts'), /voiceMayApprove\(pending\)/);
});

test('wiring: the button, the dialog, the talk flag, the hooks and the settings', () => {
  const html = read('web/index.html');
  assert.match(html, /<button id="talk-btn"[^>]*hidden/);
  assert.match(html, /<dialog id="talk-mode"/);
  for (const id of ['tm-lines', 'tm-status', 'tm-approvals', 'tm-end', 'tm-mute', 'talk-fillers', 'talk-voice-ok', 'talk-goodbye']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="talk">/);
  const app = read('web/app.js');
  assert.match(app, /talkEvent\(ev\)/);
  assert.match(app, /if \(talkOn\(\)\) body\.talk = true;/);
  const server = read('src/server.ts');
  assert.equal((server.match(/body\.talk === true \? \{ talk: true \}/g) ?? []).length, 2);
  assert.match(read('src/chat.ts'), /opts\.talk && !opts\.car/);
  assert.match(read('src/chat.ts'), /if \(opts\.talk\) callThink = 'none';/, 'talk turns skip private thinking (latency)');
  const tips = JSON.parse(read('web/tips.json'));
  for (const id of ['talk-fillers', 'talk-voice-ok', 'talk-goodbye']) assert.ok(tips[id] ?? tips.ids?.[id] ?? html.includes(`id="${id}"`), id);
});

test('POST /api/talk/answer: the voice rule, the talk pref and a member whose voice is off', async (t) => {
  const { OwnerAuth } = await import('../src/auth.ts');
  const { createSaraServer } = await import('../src/server.ts');
  const { makeApp, ROOT, tempDir } = await import('./helpers.ts');
  const { join } = await import('node:path');
  const rig = async (member?: { voice: boolean }) => {
    const { dir, cleanup } = tempDir();
    const app = makeApp(dir, { now: new Date() });
    const auth = new OwnerAuth(dir);
    const record = () => ({ id: 'm1', name: 'Kim', status: 'active', limits: { voice: member?.voice ?? true, pictures: false } });
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(member ? { spaceId: 'm1', member: { record, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      app.store.close();
      cleanup();
    });
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/api/talk/answer`, { method: 'POST', headers: { Origin: base, authorization: 'Bearer ' + auth.newToken, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { ok?: boolean; line?: string } };
    };
    return { app, post };
  };
  const { app, post } = await rig();
  const conv = app.store.createConversation({ title: 'talk' });
  assert.equal((await post({ conversationId: conv.id, approved: true })).status, 409, 'nothing waits');
  app.settings.update({ voice: { ...(app.settings.get().voice ?? {}), talk: { fillers: true, approveByVoice: false, goodbye: true } } as never });
  const off = await post({ conversationId: conv.id, approved: true });
  assert.equal(off.status, 409);
  assert.match(off.body.line ?? '', /Tap Approve or Decline/);
  const kid = await rig({ voice: false });
  const c2 = kid.app.store.createConversation({ title: 'talk' });
  assert.equal((await kid.post({ conversationId: c2.id, approved: true })).status, 403, 'voice off for this member');
});
