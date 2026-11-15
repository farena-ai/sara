// R5 (docs/PHONE_CALLS.md): voice that does things, ready but switched off. A fake telephony provider
// (simulated webhooks with real signatures and a fake Media Stream sending PCM frames as μ-law), fake
// hearing and voice, a fake clock. Off by default and every path says what's missing; screening;
// messages to chat; "stop" hangs up; max length; recording only after the consent line; outbound
// approval cards with number, script and cost; an errand's call step end to end; Discord voice stays
// off; car mode's spoken approvals follow the phone rule. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { carErrandLines, errandLine, voiceAnswer } from '../src/car-errands.ts';
import { DEFAULT_DISCORD_VOICE, discordVoiceStatus, saveDiscordVoice, voiceStateUpdate } from '../src/discord-voice.ts';
import { Errands } from '../src/errands.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { carNote } from '../src/phone-actions.ts';
import { audioToUlaw, decodeUlaw, encodeUlaw, FRAME_BYTES, pcmToUlaw, pcmToWav, ulawToPcm, ulawToWav, wavToPcm } from '../src/phone-audio.ts';
import { approvalWord, CallSession, DEFAULT_PHONE_CALLS, PHONE_LINES, PhoneCalls, STOP_RE, type CallVoice, type PhoneCallsOptions } from '../src/phone-calls.ts';
import { e164, streamTwiml, twilioSignature, TwilioProvider, type Credentials, type TelephonyProvider } from '../src/telephony.ts';
import { createPhoneCallTools } from '../src/tools/phone-calls.ts';
import type { WsConnection } from '../src/ws.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// Not a real account id: built at run time so secret scanners don't mistake it for one.
const CREDS = { sid: ['AC', 'fake'.repeat(8)].join(''), token: 'tok_test_0123456789' };
const PUBLIC = 'https://sara.example.test';

/** A provider that speaks Twilio's protocol but places no real calls. */
function fakeProvider(log: string[]) {
  return (c: Credentials): TelephonyProvider => {
    const real = new TwilioProvider({ creds: c, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    return Object.assign(Object.create(real) as TelephonyProvider, {
      verify: real.verify.bind(real),
      place: async (o: { to: string }) => (log.push(`place ${o.to}`), { callId: `CA${log.length}` }),
      hangup: async (id: string) => void log.push(`hangup ${id}`),
      record: async (id: string) => void log.push(`record ${id}`),
    });
  };
}

/** Speech: "loud" audio is heard as the next scripted line; her voice makes a short 16 kHz WAV. */
function fakeVoice(heard: string[], said: string[]): CallVoice {
  return {
    hear: async () => heard.shift() ?? '',
    say: async (text) => (said.push(text), { data: pcmToWav(new Int16Array(1600).fill(1000), 16000), type: 'audio/wav' }),
  };
}

/** A fake Media Stream: the provider's side of the WebSocket. */
function fakeWs() {
  const out: Record<string, unknown>[] = [];
  const ws = {
    open: true,
    send: (d: string | Buffer) => void out.push(JSON.parse(String(d)) as Record<string, unknown>),
    close: () => void (ws.open = false),
  } as unknown as WsConnection & { open: boolean };
  const msg = (o: unknown) => ws.onMessage?.(JSON.stringify(o));
  const loud = encodeUlaw(new Int16Array(FRAME_BYTES).map((_, i) => (i % 2 ? 9000 : -9000)));
  const quiet = encodeUlaw(new Int16Array(FRAME_BYTES));
  return {
    ws,
    out,
    start: (t: string) => msg({ event: 'start', start: { streamSid: 'MZ1', callSid: '', customParameters: { t } } }),
    /** One spoken turn: 0.4 s of speech then 0.8 s of quiet, as base64 μ-law frames. */
    speak: () => {
      for (let i = 0; i < 20; i++) msg({ event: 'media', media: { track: 'inbound', payload: loud.toString('base64') } });
      for (let i = 0; i < 40; i++) msg({ event: 'media', media: { track: 'inbound', payload: quiet.toString('base64') } });
    },
    /** The provider tells that each line she sent has played. */
    playMarks: () => {
      for (const m of out.filter((o) => o.event === 'mark').splice(0)) msg({ event: 'mark', mark: (m as { mark: unknown }).mark });
      out.splice(0, out.length, ...out.filter((o) => o.event !== 'mark'));
    },
    stop: () => msg({ event: 'stop' }),
  };
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function rig(t: TestContext, o: { ready?: boolean; heard?: string[]; otherBrain?: PhoneCallsOptions['otherBrain']; ownerBrain?: PhoneCallsOptions['ownerBrain'] } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  const log: string[] = [];
  const heard = o.heard ?? [];
  const said: string[] = [];
  const calls = new PhoneCalls(app, app.store.db, { provider: fakeProvider(log), voice: fakeVoice(heard, said), ...(o.otherBrain ? { otherBrain: o.otherBrain } : {}), ...(o.ownerBrain ? { ownerBrain: o.ownerBrain } : {}) });
  app.phoneCalls = calls;
  if (o.ready) {
    calls.setCreds(CREDS.sid, CREDS.token);
    calls.save({ on: true, number: '+1 512 555 0100', ownerNumber: '(512) 555-0199', publicUrl: PUBLIC, pricePerMinute: 0.013, maxMinutes: 10, allow: [{ name: 'Mom', number: '+15125550142' }] });
  }
  t.after(() => {
    calls.stop();
    app.store.close();
    cleanup();
  });
  return { app, clock, calls, log, heard, said };
}

const signed = (path: string, params: Record<string, string>, token = CREDS.token) => ({ url: `${PUBLIC}${path}`, params, sig: twilioSignature(token, `${PUBLIC}${path}`, params) });

test('off by default: nothing answers or calls, and every path says what is missing', async (t) => {
  assert.equal(DEFAULT_PHONE_CALLS.on, false);
  assert.equal(DEFAULT_PHONE_CALLS.record, false);
  const { calls, app } = rig(t);
  const st = calls.status();
  assert.equal(st.ready, false);
  assert.equal(st.configured, false);
  for (const line of [PHONE_LINES.creds, PHONE_LINES.number, PHONE_LINES.url, PHONE_LINES.off]) assert.ok(st.missing.includes(line), line);
  // A webhook without credentials: 404 (as if the route didn't exist).
  const w = signed('/tel/twilio/voice', { CallSid: 'CA1', From: '+15125550199', To: '+15125550100', Direction: 'inbound' });
  assert.equal(calls.webhook('voice', w.url, w.params, w.sig).status, 404);
  await assert.rejects(calls.place({ to: '+15125550123', script: 'hi' }), /account SID|switched off/);
  // The chat tool explains instead of asking.
  const [tool] = createPhoneCallTools(() => app);
  assert.equal(tool!.asksFirst?.({}), false);
  const out = await tool!.run({ number: '+15125550123', script: 'Ask if the order shipped.' }, { workspaceDir: '', signal: AbortSignal.timeout(1000), sandbox: {} as never });
  assert.match(out, /aren't ready, so nothing was called/);
  assert.match(out, /Ask if the order shipped/);
  // Credentials set but switched off: configured, not ready; inbound calls are rejected.
  calls.setCreds(CREDS.sid, CREDS.token);
  calls.save({ number: '+15125550100', publicUrl: PUBLIC });
  assert.equal(calls.status().configured, true);
  assert.equal(calls.status().ready, false);
  assert.deepEqual(calls.status().missing, [PHONE_LINES.off]);
  const r = calls.webhook('voice', w.url, w.params, w.sig);
  assert.equal(r.status, 200);
  assert.match(r.body, /<Reject/);
});

test('credentials live in the vault, never in settings; bad values are refused', (t) => {
  const { calls, app } = rig(t);
  assert.throws(() => calls.setCreds('x', 'y'), /account SID/);
  calls.setCreds(CREDS.sid, CREDS.token);
  assert.ok(app.vault.get('bridge:phone')?.includes(CREDS.token));
  assert.ok(!JSON.stringify(app.settings.get()).includes(CREDS.token));
  assert.throws(() => calls.save({ publicUrl: 'http://insecure.example' }), /public https/);
  assert.throws(() => calls.save({ number: 'not a number' }), /phone number/);
  assert.equal(calls.save({ maxMinutes: 500 }).maxMinutes, 60);
  calls.clearCreds();
  assert.equal(calls.creds(), undefined);
});

test('Twilio protocol: signatures, TwiML, media frames, E.164', () => {
  const p = new TwilioProvider({ creds: CREDS });
  const w = signed('/tel/twilio/voice', { CallSid: 'CA9', From: '+15125550199' });
  assert.equal(p.verify(w.url, w.params, w.sig), true);
  assert.equal(p.verify(w.url, { ...w.params, From: '+19995550000' }, w.sig), false);
  assert.equal(p.verify(w.url, w.params, undefined), false);
  assert.match(streamTwiml('wss://x.test/tel/twilio/stream', { t: 'a&b' }), /<Connect><Stream url="wss:\/\/x.test\/tel\/twilio\/stream"><Parameter name="t" value="a&amp;b"\/><\/Stream><\/Connect>/);
  const ev = p.parseStream(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: Buffer.from([1, 2]).toString('base64') } }));
  assert.equal(ev.type, 'media');
  assert.deepEqual(JSON.parse(p.audioMessage('MZ1', Buffer.from([0xff]))), { event: 'media', streamSid: 'MZ1', media: { payload: '/w==' } });
  assert.equal(e164('(512) 555-0199'), '+15125550199');
  assert.equal(e164('+44 20 7946 0958'), '+442079460958');
  assert.equal(e164('123'), '');
});

test('phone audio: μ-law round trip, WAV in and out, PCM to 8 kHz', () => {
  for (const s of [0, 1000, -1000, 12000, -32000]) assert.ok(Math.abs(ulawToPcm(pcmToUlaw(s)) - s) <= Math.max(16, Math.abs(s) * 0.07), String(s));
  const wav = ulawToWav(encodeUlaw(new Int16Array(800).fill(4000)));
  const back = wavToPcm(wav)!;
  assert.equal(back.rate, 16000);
  assert.ok(back.pcm.length >= 1590 && back.pcm.length <= 1610);
  assert.equal(audioToUlaw({ data: pcmToWav(new Int16Array(1600), 16000), type: 'audio/wav' })!.length, 800);
  assert.equal(audioToUlaw({ data: Buffer.alloc(3200), type: 'audio/L16;rate=16000' })!.length, 800);
  assert.equal(audioToUlaw({ data: Buffer.from('ID3...'), type: 'audio/mpeg' }), undefined);
  assert.equal(decodeUlaw(Buffer.from([0xff]))[0], 0);
});

test('inbound screening: the owner and listed people get through, others leave a message that lands in the chat', async (t) => {
  const { calls, app, said, log, heard } = rig(t, { ready: true, heard: ['This is Pat from the garage, your car is ready.', 'No, that’s all.'] });
  const owner = signed('/tel/twilio/voice', { CallSid: 'CA-own', From: '+15125550199', To: '+15125550100', Direction: 'inbound' });
  const r1 = calls.webhook('voice', owner.url, owner.params, owner.sig);
  assert.match(r1.body, /<Stream url="wss:\/\/sara.example.test\/tel\/twilio\/stream">/);
  assert.equal(calls.byProviderId('CA-own')?.mode, 'owner');
  assert.equal(calls.screen('+15125550142').through, true);
  assert.equal(calls.screen('+15125550142').name, 'Mom');
  // A bad signature is refused.
  assert.equal(calls.webhook('voice', owner.url, owner.params, 'bad').status, 403);
  calls.hangup(calls.byProviderId('CA-own')!.id);
  // A stranger: screened, she takes a message (her voice, over the media stream).
  const st = signed('/tel/twilio/voice', { CallSid: 'CA-str', From: '+15125550777', To: '+15125550100', Direction: 'inbound' });
  const r2 = calls.webhook('voice', st.url, st.params, st.sig);
  const token = /name="t" value="([^"]+)"/.exec(r2.body)![1]!;
  assert.equal(calls.byProviderId('CA-str')?.mode, 'message');
  const line = fakeWs();
  calls.attach(line.ws);
  line.start(token);
  await settle();
  assert.match(said[0]!, /Alex’s assistant.*Who’s calling/);
  assert.ok(line.out.some((o) => o.event === 'media'), 'her voice went out as media frames');
  line.playMarks();
  line.speak();
  await settle();
  assert.match(said.at(-1)!, /Anything else for Alex/);
  line.playMarks();
  line.speak();
  await settle();
  assert.match(said.at(-1)!, /pass it on\. Goodbye/);
  line.playMarks();
  await settle(10);
  assert.ok(log.includes('hangup CA-str'), log.join());
  const rec = calls.byProviderId('CA-str')!;
  assert.equal(rec.status, 'done');
  assert.match(rec.summary ?? '', /your car is ready/);
  const conv = app.store.listConversations().find((c) => c.id === rec.conversationId)!;
  const msg = app.store.messages(conv.id).at(-1)!;
  assert.match(msg.content, /Phone message from \+15125550777/);
  assert.match(msg.content, /Transcript:/);
  assert.equal(heard.length, 0);
  // A replayed token does nothing.
  const again = fakeWs();
  calls.attach(again.ws);
  again.start(token);
  assert.equal(again.ws.open, false);
});

test('"stop" on the line hangs up, and the length limit ends a call', async (t) => {
  assert.ok(STOP_RE.test('Stop.') && STOP_RE.test('hang up') && STOP_RE.test('cuelga') && STOP_RE.test('Auf Wiedersehen') && STOP_RE.test('tchau') && !STOP_RE.test('stop by the store tomorrow'));
  const sent: string[] = [];
  let hung = 0;
  const ended: string[] = [];
  const said: string[] = [];
  const s = new CallSession({
    opening: 'Hi',
    brain: async () => ({ say: 'ok' }),
    voice: fakeVoice(['stop'], said),
    sendAudio: () => void sent.push('a'),
    sendMark: (n) => void sent.push(n),
    sendClear: () => void sent.push('clear'),
    hangup: async () => void hung++,
    maxMs: 60_000,
    now: () => new Date(),
    goodbye: 'Bye.',
    limitLine: 'Time is up.',
    onEnd: (why) => void ended.push(why),
  });
  await s.begin();
  const loud = encodeUlaw(new Int16Array(FRAME_BYTES).fill(9000));
  const quiet = encodeUlaw(new Int16Array(FRAME_BYTES));
  for (let i = 0; i < 10; i++) s.feed(loud);
  assert.ok(sent.includes('clear'), 'talking over her clears her audio (barge-in)');
  for (let i = 0; i < 40; i++) s.feed(quiet);
  await settle();
  assert.equal(said.at(-1), 'Bye.');
  s.marked('m1');
  s.marked('m2');
  await settle();
  assert.equal(hung, 1);
  assert.deepEqual(ended, ['stop']);
  // Max length: a tiny limit ends the call with the limit line.
  const said2: string[] = [];
  const ended2: string[] = [];
  const s2 = new CallSession({ opening: 'Hi', brain: async () => ({ say: 'ok' }), voice: fakeVoice([], said2), sendAudio: () => {}, sendMark: () => {}, sendClear: () => {}, hangup: async () => {}, maxMs: 20, now: () => new Date(), goodbye: 'Bye.', limitLine: 'Time is up.', onEnd: (why) => void ended2.push(why) });
  await s2.begin();
  await new Promise((r) => setTimeout(r, 60));
  await settle();
  assert.equal(said2.at(-1), 'Time is up.');
  s2.marked('m2');
  await settle();
  assert.deepEqual(ended2, ['limit']);
});

test('outbound: the card shows number, script, length, cost and recording; recording starts only after the consent line', async (t) => {
  const { calls, app, log, said } = rig(t, { ready: true, heard: ['Yes, your order shipped today.'], otherBrain: () => async () => ({ say: 'Great, thank you. Goodbye.', end: true }) });
  const [tool] = createPhoneCallTools(() => app);
  assert.equal(tool!.asksFirst?.({}), true, 'every call asks, even if set to run on its own');
  const card = tool!.summarize({ number: '512-555-0123', name: 'Acme Store', script: 'Did order A-1001 ship?' });
  assert.match(card, /Call Acme Store at \+15125550123/);
  assert.match(card, /She says: “Did order A-1001 ship\?”/);
  assert.match(card, /Up to \$0\.13 for 10 minutes \(at your price of \$0\.013 a minute\)/);
  assert.match(card, /Recording: off/);
  calls.save({ record: true, pricePerMinute: null });
  assert.match(tool!.summarize({ number: '5125550123', script: 'x' }), /No cost estimate.*Recording: on, after she tells them/s);
  const conv = app.store.createConversation({ title: 'chat' });
  const out = await tool!.run({ number: '5125550123', name: 'Acme Store', script: 'Did order A-1001 ship?' }, { workspaceDir: '', signal: AbortSignal.timeout(1000), sandbox: {} as never, conversationId: conv.id });
  assert.match(out, /Calling \+15125550123 now/);
  assert.ok(log.includes('place +15125550123'));
  // One call at a time.
  await assert.rejects(calls.place({ to: '+15125550124', script: 'x' }), /already on a call/);
  const rec = calls.list(1)[0]!;
  assert.equal(rec.recorded, true);
  assert.equal(rec.number, '+15125550123');
  assert.equal(said.length, 0, 'nothing is said before the provider connects the stream');
  // Hang up from the page: the provider is told, the record ends.
  await calls.hangup(rec.id);
  assert.equal(calls.get(rec.id)!.status, 'missed');
});

test('outbound media stream: consent, recording, transcript and summary back to the chat', async (t) => {
  let lastParams: Record<string, string> = {};
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-16T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex' });
  const log: string[] = [];
  const said: string[] = [];
  const provider = (c: Credentials): TelephonyProvider => {
    const real = new TwilioProvider({ creds: c });
    return Object.assign(Object.create(real) as TelephonyProvider, { verify: real.verify.bind(real), place: async (o: { to: string; params: Record<string, string> }) => ((lastParams = o.params), log.push(`place ${o.to}`), { callId: 'CA77' }), hangup: async (id: string) => void log.push(`hangup ${id}`), record: async (id: string) => void log.push(`record ${id}`) });
  };
  const calls = new PhoneCalls(app, app.store.db, { provider, voice: fakeVoice(['Yes, it shipped today, tracking 1Z999.'], said), otherBrain: () => async () => ({ say: 'Thank you, goodbye.', end: true }) });
  t.after(() => (calls.stop(), app.store.close(), cleanup()));
  calls.setCreds(CREDS.sid, CREDS.token);
  calls.save({ on: true, number: '+15125550100', publicUrl: PUBLIC, record: true });
  const conv = app.store.createConversation({ title: 'chat' });
  const rec = await calls.place({ to: '5125550123', name: 'Acme', script: 'Did order A-1001 ship?', conversationId: conv.id });
  const line = fakeWs();
  calls.attach(line.ws);
  line.start(lastParams.t!);
  await settle();
  assert.match(said[0]!, /this call is recorded/);
  assert.match(said[1]!, /AI assistant calling for Alex\. Did order A-1001 ship\?/);
  assert.ok(!log.some((l) => l.startsWith('record')), 'no recording before the consent line played');
  line.playMarks();
  await settle();
  assert.ok(log.includes('record CA77'), log.join());
  line.speak();
  await settle();
  line.playMarks();
  await settle(10);
  assert.ok(log.includes('hangup CA77'));
  const done = calls.get(rec.id)!;
  assert.equal(done.status, 'done');
  assert.match(done.summary ?? '', /tracking 1Z999/);
  const last = app.store.messages(conv.id).at(-1)!;
  assert.match(last.content, /Phone call with Acme \(\+15125550123\)/);
  assert.match(last.content, /Them: Yes, it shipped today/);
});

test('an errand’s call step: card with number and script, approve places the call, its end finishes the step with evidence', async (t) => {
  let lastParams: Record<string, string> = {};
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-16T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex' });
  const said: string[] = [];
  const provider = (c: Credentials): TelephonyProvider => {
    const real = new TwilioProvider({ creds: c });
    return Object.assign(Object.create(real) as TelephonyProvider, { verify: real.verify.bind(real), place: async (o: { params: Record<string, string> }) => ((lastParams = o.params), { callId: 'CA5' }), hangup: async () => {}, record: async () => {} });
  };
  const errands = new Errands(app, app.store.db, { notify: async () => {}, quiet: () => false, ownAddresses: () => [] });
  app.errands = errands;
  const calls = new PhoneCalls(app, app.store.db, { provider, voice: fakeVoice(['Sure, Thursday at 9 works. Your booking number is B-42.'], said), otherBrain: () => async () => ({ say: 'Thank you, goodbye.', end: true }) });
  app.phoneCalls = calls;
  t.after(() => (calls.stop(), app.store.close(), cleanup()));
  // Off: the old hand-over (number + script), with nothing called.
  const e0 = errands.start({ goal: 'Book an oil change', steps: [{ text: 'Call the garage', kind: 'call', phone: '+1 512 555 0101', script: 'I’d like to book an oil change this week.' }] }, { by: 'chat' });
  await errands.advance(e0.id);
  assert.match(errands.get(e0.id)!.needs ?? '', /Calling is not switched on.*\+1 512 555 0101/s);
  errands.stop(e0.id);
  // Ready: the step's card has the number, the script and the cost line.
  calls.setCreds(CREDS.sid, CREDS.token);
  calls.save({ on: true, number: '+15125550100', publicUrl: PUBLIC, pricePerMinute: 0.02 });
  const e = errands.start({ goal: 'Book an oil change', steps: [{ text: 'Call the garage', kind: 'call', phone: '+1 512 555 0101', script: 'I’d like to book an oil change this week.' }] }, { by: 'chat' });
  await errands.advance(e.id);
  const ask = errands.get(e.id)!.needs ?? '';
  assert.match(ask, /Should she call now\?/);
  assert.match(ask, /\+15125550101/);
  assert.match(ask, /book an oil change this week/);
  assert.match(ask, /\$0\.20 for 10 minutes/);
  await errands.approve(e.id);
  assert.equal(errands.get(e.id)!.status, 'waiting_others');
  // The tick doesn't ask again while the call is on.
  await errands.advance(e.id);
  assert.equal(errands.get(e.id)!.status, 'waiting_others');
  const line = fakeWs();
  calls.attach(line.ws);
  line.start(lastParams.t!);
  await settle();
  line.playMarks();
  line.speak();
  await settle();
  line.playMarks();
  await settle(20);
  const done = errands.get(e.id)!;
  assert.equal(done.status, 'done', JSON.stringify(done.log));
  const step = done.steps[0]!;
  assert.match(step.result ?? '', /B-42/);
  assert.equal(step.evidence?.tool, 'phone_call');
  assert.match(step.evidence?.line ?? '', /^Verified: the call to \+15125550101 connected/);
  const chat = app.store.messages(done.conversationId!).map((m: { content: string }) => m.content).join('\n');
  assert.match(chat, /Transcript:/);
});

test('owner calls: approvals by voice follow the phone rule (PC-only cards wait for the computer)', async (t) => {
  assert.equal(approvalWord('Approve.'), 'approve');
  assert.equal(approvalWord('sí, hazlo'), 'approve');
  assert.equal(approvalWord('nein'), 'decline');
  assert.equal(approvalWord('approve the plan tomorrow maybe'), null);
  const { app } = rig(t);
  const conv = app.store.createConversation({ title: 'car' });
  const active = new Map<string, { approvals: Map<string, unknown> }>();
  assert.equal(voiceAnswer(app, active, conv.id, true).ok, false);
  const decided: [string, boolean][] = [];
  app.approvals.decide = ((id: string, ok: boolean) => (decided.push([id, ok]), true)) as typeof app.approvals.decide;
  active.set(conv.id, { approvals: new Map([['c1', { approvalId: 'a1', name: 'pc_click', summary: 'click' }]]) });
  const pc = voiceAnswer(app, active, conv.id, true);
  assert.equal(pc.pcOnly, true);
  assert.deepEqual(decided, []);
  active.set(conv.id, { approvals: new Map([['c2', { approvalId: 'a2', name: 'errand_start', summary: 'Start this errand' }]]) });
  assert.equal(voiceAnswer(app, active, conv.id, true).ok, true);
  assert.deepEqual(decided, [['a2', true]]);
});

test('car mode errands: spoken status lines and the car note', (t) => {
  const { app } = rig(t);
  const errands = new Errands(app, app.store.db, { notify: async () => {}, quiet: () => false, ownAddresses: () => [] });
  app.errands = errands;
  const e = errands.start({ goal: 'Get my Acme refund', facts: { merchant: 'Acme Store' }, steps: [{ text: 'Wait for their answer', kind: 'wait' }] }, { by: 'chat' });
  const row = errands.get(e.id)!;
  row.status = 'waiting_others';
  assert.equal(errandLine(row), '"Get my Acme refund" is waiting on Acme Store.');
  assert.match(carErrandLines(app)[0]!, /Get my Acme refund/);
  const note = carNote('Alex', [], ['"Get my Acme refund" is waiting on Acme Store.']);
  assert.match(note, /start an errand by voice \(errand_start/);
  assert.match(note, /waiting on Acme Store/);
  // The car-mode page knows the same approval words (web/car-mode.js).
  const web = readFileSync(join(ROOT, 'web', 'car-mode.js'), 'utf8');
  assert.match(web, /export function approvalCommand/);
  assert.match(web, /\/car\/answer/);
});

test('Discord voice: an interface only, off by default, Join explains why', (t) => {
  const { app } = rig(t);
  assert.equal(DEFAULT_DISCORD_VOICE.on, false);
  const s = saveDiscordVoice(app, { guildId: '123456789012345678', channelId: '223456789012345678', on: true });
  assert.equal(s.on, false, 'no voice transport: it stays off');
  const st = discordVoiceStatus(app, { bridge: true });
  assert.equal(st.canJoin, false);
  assert.match(st.missing.join(' '), /voice library/);
  assert.deepEqual(JSON.parse(voiceStateUpdate('1', '2')), { op: 4, d: { guild_id: '1', channel_id: '2', self_mute: false, self_deaf: false } });
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some((d) => /discord|opus/.test(d)), 'no Discord voice library is shipped');
});

test('lean words, private chats and wiring', () => {
  assert.equal(familyOf({ spec: { name: 'phone_call', description: '', parameters: {} }, source: 'built-in' } as never)?.id, 'calls');
  assert.ok(FAMILY_WORDS.calls!.length >= 20);
  const chat = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
  assert.match(chat, /name === 'phone_call'/);
  const server = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(server, /url\.pathname\.startsWith\('\/tel\/'\)/);
  assert.match(server, /'\/tel\/twilio\/stream'/);
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(main, /new PhoneCalls\(app, store\.db\)/);
  const doc = readFileSync(join(ROOT, 'docs', 'PHONE_CALLS.md'), 'utf8');
  assert.match(doc, /switched off/i);
  assert.match(doc, /SIP/);
});
