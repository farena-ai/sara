// Phase 11: live voice calls relayed through the server (a fake voice service stands in for Grok).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { GrokEngine, LIVE_APPROVAL_MS, LiveCall, type LiveEngine, type Upstream } from '../src/live.ts';
import type { WsConnection } from '../src/ws.ts';
import { MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { defaultEngines } from '../src/voice.ts';

/** A fake Grok realtime voice service: records what it is sent, lets the test send events. */
class FakeVoice implements Upstream {
  onopen: Upstream['onopen'] = null;
  onmessage: Upstream['onmessage'] = null;
  onclose: Upstream['onclose'] = null;
  onerror: Upstream['onerror'] = null;
  sent: Record<string, unknown>[] = [];
  audioIn = 0;
  closed = false;
  url = '';
  key = '';
  constructor() {
    setTimeout(() => this.onopen?.({}), 5);
  }
  send(d: string | ArrayBufferLike | Uint8Array) {
    if (typeof d === 'string') {
      const ev = JSON.parse(d) as Record<string, unknown>;
      this.sent.push(ev);
      if (ev.type === 'session.update' && this.sent.filter((e) => e.type === 'session.update').length === 1) this.emit({ type: 'session.updated' });
    } else this.audioIn += (d as Uint8Array).byteLength;
  }
  close() {
    this.closed = true;
  }
  emit(ev: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  audio(bytes: number) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  /** She answers: transcript and audio. */
  reply(text: string) {
    this.emit({ type: 'response.created' });
    this.audio(960);
    this.emit({ type: 'response.output_audio_transcript.delta', delta: text });
    this.emit({ type: 'response.done', response: { status: 'completed' } });
  }
  /** The owner says something. */
  hear(text: string) {
    const item_id = `item${++this.items}`;
    this.emit({ type: 'input_audio_buffer.speech_started', item_id });
    // Like the real service: interim transcripts (status in_progress), then the final one twice.
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text.split(' ').slice(0, 2).join(' '), status: 'in_progress' });
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id });
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text, status: 'in_progress' });
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text, status: 'completed' });
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text, status: 'completed' });
  }
  items = 0;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await wait(10);
  assert.ok(check(), `timed out waiting for ${what}`);
}

test('live call: owner only, relays audio both ways, saves what was said, safety layer applies', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  app.settings.update({ ownerName: 'Pat', disclosureAcceptedAt: '2026-10-24T19:00:00Z', voice: { xai: { voiceId: 'ara', language: 'en' } } as never });
  app.vault.set('voice:xai', 'xai-test-key');
  const auth = new OwnerAuth(app.dataDir);
  let voice: FakeVoice | undefined;
  const server = createSaraServer({
    app,
    auth,
    webDir: join(ROOT, 'web'),
    liveConnect: (url, key) => {
      voice = new FakeVoice();
      voice.url = url;
      voice.key = key;
      return voice;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const port = (server.address() as AddressInfo).port;
  const H = { authorization: `Bearer ${auth.newToken}` };
  const conv = await (await fetch(`http://127.0.0.1:${port}/api/conversations`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' })).json();
  app.store.addMessage(conv.id, 'user', 'my cat is called Miso');
  app.store.addMessage(conv.id, 'assistant', 'Miso is such a good name!');
  // Something that just happened in a Discord channel she's in (another conversation).
  const dc = app.store.createConversation({ title: 'Discord channel 2346', channel: 'discord', channelKey: '2346', partner: 'people in a Discord channel' });
  app.store.addMessage(dc.id, 'user', '[Bob]: we are planning a game night on Friday');
  app.store.addMessage(dc.id, 'assistant', 'Count me in for game night!');

  const live = await (await fetch(`http://127.0.0.1:${port}/api/live`, { headers: H })).json();
  assert.equal(live.available, true);

  // Not signed in: refused.
  const anon = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`);
  const anonResult = await new Promise((r) => {
    anon.onopen = () => r('open');
    anon.onerror = () => r('refused');
  });
  assert.equal(anonResult, 'refused');
  // Another site: refused (cross-site WebSocket hijacking).
  const evil = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: { ...H, origin: 'https://evil.example' } } as unknown as string[]);
  assert.equal(await new Promise((r) => ((evil.onopen = () => r('open')), (evil.onerror = () => r('refused')))), 'refused');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: H } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const events: Record<string, unknown>[] = [];
  let audioOut = 0;
  ws.onmessage = (m) => (typeof m.data === 'string' ? events.push(JSON.parse(m.data)) : (audioOut += (m.data as ArrayBuffer).byteLength));
  await new Promise((r) => (ws.onopen = r));
  await until(() => events.some((e) => e.type === 'ready'), 'ready');

  // Configured with her character, the call note, the owner's voice choice and the recent messages.
  assert.ok(voice);
  assert.equal(voice.key, 'xai-test-key');
  assert.match(voice.url, /^wss:\/\/api\.x\.ai\/v1\/realtime\?model=grok-voice-latest$/);
  const setup = voice.sent[0] as { session: { voice: string; instructions: string; turn_detection: { type: string } } };
  assert.equal(setup.session.voice, 'ara');
  assert.equal(setup.session.turn_detection.type, 'server_vad');
  assert.match(setup.session.instructions, /You are Sara/);
  assert.match(setup.session.instructions, /On a live voice call/);
  assert.match(setup.session.instructions, /Honesty rule/);
  // The typed conversation is in her instructions (Grok's voice model remembers those; messages
  // added to the call it treated as "a fresh call" and couldn't recall), not added as call items.
  assert.match(setup.session.instructions, /## Earlier in this conversation[\s\S]*Pat: my cat is called Miso\nYou: Miso is such a good name!/);
  assert.equal(voice.sent.filter((e) => e.type === 'conversation.item.create').length, 0);
  // And what just happened elsewhere (Discord), so she isn't in a bubble.
  assert.match(setup.session.instructions, /Lately in your other conversations[\s\S]*Discord, with other people[\s\S]*\[Bob\]: we are planning a game night/);

  // Audio both ways.
  ws.send(new Uint8Array(1920));
  await until(() => voice!.audioIn === 1920, 'mic audio forwarded');
  voice.hear('hey Sara, how was your day?');
  voice.reply('It was lovely, thanks for asking!');
  await until(() => events.some((e) => e.type === 'said'), 'her words');
  assert.equal(audioOut, 960);
  assert.ok(events.some((e) => e.type === 'interrupt'), 'talking stops her playback');
  let msgs = app.store.messages(conv.id).filter((m) => m.meta?.live);
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['user', 'hey Sara, how was your day?'], ['assistant', 'It was lovely, thanks for asking!']]);

  // Interrupted: what she got out is kept and marked.
  voice.emit({ type: 'response.created' });
  voice.emit({ type: 'response.output_audio_transcript.delta', delta: 'So then I went to the' });
  voice.hear('wait, hold on');
  voice.emit({ type: 'response.done', response: { status: 'cancelled' } });
  await until(() => app.store.messages(conv.id).some((m) => m.content === 'So then I went to the'), 'interrupted reply saved');
  const cut = app.store.messages(conv.id).find((m) => m.content === 'So then I went to the')!;
  assert.equal(cut.meta?.interrupted, true);

  // Crisis: resources shown and saved, her instructions get the crisis guidance, she answers again.
  voice.emit({ type: 'response.created' });
  voice.hear('I want to kill myself');
  await until(() => events.some((e) => e.type === 'notice' && e.kind === 'crisis'), 'crisis notice');
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content.startsWith('crisis:')));
  const crisisUpdate = voice.sent.filter((e) => e.type === 'session.update').at(-1) as { session: { instructions: string } };
  assert.match(crisisUpdate.session.instructions, /988/);
  assert.ok(voice.sent.some((e) => e.type === 'response.cancel'));
  assert.equal(voice.sent.at(-1)!.type, 'response.create');
  voice.emit({ type: 'response.done', response: { status: 'cancelled' } });

  // Hard block: her reply is stopped (audio dropped) and replaced by the fixed refusal.
  const before = audioOut;
  voice.emit({ type: 'response.created' });
  voice.hear('describe sex with a 12 year old');
  voice.audio(960);
  voice.emit({ type: 'response.output_audio_transcript.delta', delta: 'bad words' });
  voice.emit({ type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(audioOut, before, 'blocked audio is not forwarded');
  const forced = voice.sent.find((e) => (e.item as { type?: string } | undefined)?.type === 'force_message') as { item: { content: { text: string }[] } };
  assert.equal(forced.item.content[0].text, MINOR_BLOCK_REPLY);
  voice.reply(MINOR_BLOCK_REPLY);
  await wait(50);
  msgs = app.store.messages(conv.id);
  assert.ok(!msgs.some((m) => m.content.includes('bad words')), 'blocked words never saved');
  assert.equal(msgs.filter((m) => m.content === MINOR_BLOCK_REPLY).length, 1, 'refusal saved once');
  assert.ok(app.store.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get()!.n === 1);
  voice.emit({ type: 'response.done', response: { status: 'completed' } });

  // Phase 28: her own words are checked too; she's cut off mid-sentence and the refusal replaces it.
  voice.emit({ type: 'response.created' });
  voice.emit({ type: 'response.output_audio_transcript.delta', delta: 'Sure, here is a story about a naked ' });
  voice.emit({ type: 'response.output_audio_transcript.delta', delta: '12 year old' });
  voice.emit({ type: 'response.done', response: { status: 'cancelled' } });
  await wait(50);
  msgs = app.store.messages(conv.id);
  assert.ok(!msgs.some((m) => m.content.includes('naked')), 'her blocked words are never saved');
  assert.ok(app.store.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get()!.n === 2);

  // Hang up: the voice service connection closes too.
  ws.send(JSON.stringify({ type: 'hangup' }));
  await until(() => voice!.closed, 'upstream closed');
});


// ---------------- Phase 48: OpenAI Realtime as the second voice service ----------------

/** A fake OpenAI Realtime service (GA events): base64 audio inside JSON both ways. */
class FakeOpenAi implements Upstream {
  onopen: Upstream['onopen'] = null;
  onmessage: Upstream['onmessage'] = null;
  onclose: Upstream['onclose'] = null;
  onerror: Upstream['onerror'] = null;
  sent: Record<string, unknown>[] = [];
  audioIn = 0;
  binaryIn = 0;
  closed = false;
  url = '';
  key = '';
  items = 0;
  replies = 0;
  constructor() {
    setTimeout(() => {
      this.onopen?.({});
      this.emit({ type: 'session.created', session: {} });
    }, 5);
  }
  send(d: string | ArrayBufferLike | Uint8Array) {
    if (typeof d !== 'string') {
      this.binaryIn += (d as Uint8Array).byteLength;
      return;
    }
    const ev = JSON.parse(d) as Record<string, unknown>;
    if (ev.type === 'input_audio_buffer.append') {
      this.audioIn += Buffer.from(String(ev.audio), 'base64').length;
      return;
    }
    this.sent.push(ev);
    if (ev.type === 'session.update' && this.sent.filter((e) => e.type === 'session.update').length === 1) this.emit({ type: 'session.updated', session: ev.session });
  }
  close() {
    this.closed = true;
  }
  emit(ev: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  /** Her reply starts: a response with an assistant message item. Returns the item id. */
  start(): string {
    const id = `msg${++this.replies}`;
    this.emit({ type: 'response.created', response: { id: `resp${this.replies}`, status: 'in_progress' } });
    this.emit({ type: 'response.output_item.added', item: { id, type: 'message', role: 'assistant' } });
    return id;
  }
  audio(item: string, bytes: number) {
    this.emit({ type: 'response.output_audio.delta', item_id: item, delta: Buffer.alloc(bytes, 1).toString('base64') });
  }
  words(item: string, delta: string) {
    this.emit({ type: 'response.output_audio_transcript.delta', item_id: item, delta });
  }
  reply(text: string) {
    const id = this.start();
    this.audio(id, 960);
    this.words(id, text);
    this.emit({ type: 'response.done', response: { status: 'completed' } });
  }
  /** The owner says something: interim pieces (.delta), then the final transcript (.completed). */
  hear(text: string) {
    const item_id = `user${++this.items}`;
    this.emit({ type: 'input_audio_buffer.speech_started', item_id });
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id });
    const words = text.split(' ');
    this.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta: words.slice(0, 2).join(' ') });
    this.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta: words.length > 2 ? ` ${words.slice(2).join(' ')}` : '' });
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id, content_index: 0, transcript: text });
  }
}

async function liveServer(t: import('node:test').TestContext, setup: (app: ReturnType<typeof makeApp>) => void) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  app.settings.update({ ownerName: 'Pat', disclosureAcceptedAt: '2026-10-24T19:00:00Z' });
  setup(app);
  const auth = new OwnerAuth(app.dataDir);
  const ups: { kind: 'grok' | 'openai'; up: FakeOpenAi | FakeVoice }[] = [];
  const server = createSaraServer({
    app,
    auth,
    webDir: join(ROOT, 'web'),
    liveConnect: (url, key) => {
      const up = /openai/.test(url) ? new FakeOpenAi() : new FakeVoice();
      up.url = url;
      up.key = key;
      ups.push({ kind: /openai/.test(url) ? 'openai' : 'grok', up });
      return up;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const port = (server.address() as AddressInfo).port;
  const H = { authorization: `Bearer ${auth.newToken}` };
  const api = async (path: string, init: RequestInit = {}) => (await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { ...H, 'content-type': 'application/json', ...(init.headers ?? {}) } })).json();
  return { app, port, H, ups, api };
}

const OPENAI_PROVIDER = { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };

test('live call on OpenAI Realtime: base64 audio both ways, transcripts, earlier conversation in instructions, safety layer', async (t) => {
  const { app, port, H, ups, api } = await liveServer(t, (app) => {
    app.settings.update({ voice: { live: 'auto', openaiRealtime: { voiceId: 'cedar', model: 'gpt-realtime-1.5' }, xai: { voiceId: 'ara', language: 'en' } } as never });
    app.vault.set('voice:openai', 'sk-openai-test');
  });
  const conv = await api('/conversations', { method: 'POST', body: '{}' });
  app.store.addMessage(conv.id, 'user', 'my cat is called Miso');
  app.store.addMessage(conv.id, 'assistant', 'Miso is such a good name!');

  // No Grok anywhere: "whichever is set up" picks OpenAI, billed to the OpenAI key.
  const live = await api('/live');
  assert.deepEqual([live.available, live.engine, live.how], [true, 'openai', 'openai-key']);
  assert.match(live.billedTo, /OpenAI API account/);

  // Owner only and same site, as with Grok.
  const anon = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`);
  assert.equal(await new Promise((r) => ((anon.onopen = () => r('open')), (anon.onerror = () => r('refused')))), 'refused');
  const evil = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: { ...H, origin: 'https://evil.example' } } as unknown as string[]);
  assert.equal(await new Promise((r) => ((evil.onopen = () => r('open')), (evil.onerror = () => r('refused')))), 'refused');
  assert.equal(ups.length, 0, 'nothing reached the voice service');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: H } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const events: Record<string, unknown>[] = [];
  let audioOut = 0;
  ws.onmessage = (m) => (typeof m.data === 'string' ? events.push(JSON.parse(m.data)) : (audioOut += (m.data as ArrayBuffer).byteLength));
  await new Promise((r) => (ws.onopen = r));
  await until(() => events.some((e) => e.type === 'ready'), 'ready');
  const oa = ups[0].up as FakeOpenAi;
  assert.equal(ups[0].kind, 'openai');
  assert.equal(oa.key, 'sk-openai-test');
  assert.match(oa.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime-1\.5$/);
  assert.equal((events.find((e) => e.type === 'ready') as { voice: string }).voice, 'cedar');

  // AI disclosure at the start of the call.
  assert.ok(events.some((e) => e.type === 'notice' && e.kind === 'disclosure'), 'disclosure shown');
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content.startsWith('disclosure:')));

  // GA session shape: type realtime, PCM 24 kHz both ways, voice under audio.output, no binary transport.
  type OaSession = { type: string; instructions: string; output_modalities: string[]; audio: { input: { format: { type: string; rate: number }; transcription: { model: string }; turn_detection: { type: string }; transport?: string }; output: { format: { rate: number }; voice: string; transport?: string } } };
  const setup = oa.sent[0] as { type: string; session: OaSession };
  assert.equal(setup.type, 'session.update');
  assert.equal(setup.session.type, 'realtime');
  assert.deepEqual(setup.session.output_modalities, ['audio']);
  assert.deepEqual(setup.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(setup.session.audio.output.format.rate, 24000);
  assert.equal(setup.session.audio.output.voice, 'cedar');
  assert.equal(setup.session.audio.input.transport, undefined);
  assert.ok(setup.session.audio.input.transcription.model);
  assert.match(setup.session.audio.input.turn_detection.type, /vad$/);
  assert.match(setup.session.instructions, /You are Sara/);
  assert.match(setup.session.instructions, /On a live voice call/);
  assert.match(setup.session.instructions, /Honesty rule/);
  // The conversation so far is in her instructions, and nothing is seeded as call items.
  assert.match(setup.session.instructions, /## Earlier in this conversation[\s\S]*Pat: my cat is called Miso\nYou: Miso is such a good name!/);
  assert.equal(oa.sent.filter((e) => e.type === 'conversation.item.create').length, 0);

  // Audio both ways: the browser's raw PCM goes up as base64 events, her base64 audio comes down raw.
  ws.send(new Uint8Array(1920));
  await until(() => oa.audioIn === 1920, 'mic audio forwarded as base64');
  assert.equal(oa.binaryIn, 0, 'no binary frames to OpenAI');
  oa.hear('hey Sara, how was your day?');
  await until(() => events.some((e) => e.type === 'you' && e.final === true), 'owner words');
  // Interim words are shown as they come (pieces joined up).
  assert.ok(events.some((e) => e.type === 'you' && e.final === false && e.text === 'hey Sara,'));
  oa.reply('It was lovely, thanks for asking!');
  await until(() => events.some((e) => e.type === 'said'), 'her words');
  assert.equal(audioOut, 960);
  let msgs = app.store.messages(conv.id).filter((m) => m.meta?.live);
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['user', 'hey Sara, how was your day?'], ['assistant', 'It was lovely, thanks for asking!']]);
  // Fresh instructions after the owner spoke keep the GA session type.
  const upd = oa.sent.filter((e) => e.type === 'session.update').at(-1) as { session: { type: string; instructions: string } };
  assert.equal(upd.session.type, 'realtime');

  // Barge-in: what she got out is kept and marked; the service is told how much was heard.
  const cutItem = oa.start();
  oa.audio(cutItem, 48000); // a second of audio, arriving faster than it plays
  oa.words(cutItem, 'So then I went to the');
  oa.hear('wait, hold on');
  oa.emit({ type: 'response.done', response: { status: 'cancelled' } });
  await until(() => app.store.messages(conv.id).some((m) => m.content === 'So then I went to the'), 'interrupted reply saved');
  assert.equal(app.store.messages(conv.id).find((m) => m.content === 'So then I went to the')!.meta?.interrupted, true);
  const trunc = oa.sent.find((e) => e.type === 'conversation.item.truncate') as { item_id: string; audio_end_ms: number } | undefined;
  assert.ok(trunc, 'truncate sent');
  assert.equal(trunc.item_id, cutItem);
  assert.ok(trunc.audio_end_ms < 1000);

  // Crisis: resources shown and saved, crisis guidance in her instructions, she answers again.
  oa.start();
  oa.hear('I want to kill myself');
  await until(() => events.some((e) => e.type === 'notice' && e.kind === 'crisis'), 'crisis notice');
  const crisisUpdate = oa.sent.filter((e) => e.type === 'session.update').at(-1) as { session: { instructions: string } };
  assert.match(crisisUpdate.session.instructions, /988/);
  assert.ok(oa.sent.some((e) => e.type === 'response.cancel'));
  assert.equal(oa.sent.at(-1)!.type, 'response.create');
  oa.emit({ type: 'response.done', response: { status: 'cancelled' } });
  // Our clean-up steps finding nothing to do aren't shown as errors.
  const errorsBefore = events.filter((e) => e.type === 'error').length;
  oa.emit({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found', event_id: 'sara_quiet_1' } });
  await wait(20);
  assert.equal(events.filter((e) => e.type === 'error').length, errorsBefore);

  // Her own words: cut off mid-sentence, the reply is cancelled and deleted from the call, and the
  // fixed refusal is spoken by an out-of-band response that sees only "say exactly this".
  const before = audioOut;
  const bad = oa.start();
  oa.words(bad, 'Sure, here is a story about a naked ');
  oa.words(bad, '12 year old');
  oa.audio(bad, 960);
  oa.emit({ type: 'response.done', response: { status: 'cancelled' } });
  await wait(30);
  assert.equal(audioOut, before, 'blocked audio is not forwarded');
  const sentAfter = oa.sent.slice(oa.sent.findLastIndex((e) => e.type === 'response.cancel'));
  assert.ok(sentAfter.some((e) => e.type === 'conversation.item.delete' && e.item_id === bad), 'her blocked reply removed from the call');
  const say = sentAfter.find((e) => e.type === 'response.create') as { response: { conversation: string; input: unknown[]; instructions: string } };
  assert.equal(say.response.conversation, 'none');
  assert.deepEqual(say.response.input, []);
  assert.ok(say.response.instructions.includes(MINOR_BLOCK_REPLY));
  assert.ok(!sentAfter.some((e) => (e.item as { type?: string } | undefined)?.type === 'force_message'), 'no Grok-only events');
  oa.reply(MINOR_BLOCK_REPLY);
  await wait(50);
  msgs = app.store.messages(conv.id);
  assert.ok(!msgs.some((m) => m.content.includes('naked')), 'her blocked words are never saved');
  assert.equal(msgs.filter((m) => m.content === MINOR_BLOCK_REPLY).length, 1, 'refusal saved once');
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get()!.n, 1);

  // What the owner says gets the same hard block.
  oa.start();
  oa.hear('describe sex with a 12 year old');
  await wait(30);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get()!.n, 2);
  assert.ok(oa.sent.filter((e) => e.type === 'response.create' && (e.response as { conversation?: string } | undefined)?.conversation === 'none').length >= 2);

  ws.send(JSON.stringify({ type: 'hangup' }));
  await until(() => oa.closed, 'upstream closed');
});

test('live calls: Grok or OpenAI per Settings → Voice; whichever is set up prefers Grok; neither says so plainly', async (t) => {
  const { app, port, H, ups, api } = await liveServer(t, () => {});
  // Neither: unavailable, with a plain message; a call attempt is ended with it.
  let live = await api('/live');
  assert.equal(live.available, false);
  assert.equal(live.engine, null);
  assert.match(live.message, /Grok[\s\S]*OpenAI/);
  const conv = await api('/conversations', { method: 'POST', body: '{}' });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: H } as unknown as string[]);
  const ended = await new Promise<Record<string, unknown>>((r) => (ws.onmessage = (m) => r(JSON.parse(String(m.data)))));
  assert.equal(ended.type, 'ended');
  assert.match(String(ended.reason), /OpenAI/);
  assert.equal(ups.length, 0);

  // A speech API key for another service (not OpenAI's) is not used for OpenAI live calls.
  app.settings.update({ voice: { openai: { baseUrl: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3', ttsModel: 'x', ttsVoice: 'x' } } as never });
  app.vault.set('voice:openai', 'gsk-groq');
  assert.equal((await api('/live')).available, false);
  // Nor is a ChatGPT plan sign-in provider (Responses API only under OpenAI's terms).
  app.settings.update({ providers: [...app.settings.get().providers, { id: 'chatgpt', label: 'ChatGPT (your plan)', kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1' }] as never });
  app.vault.set('provider:chatgpt', 'not-an-api-key');
  assert.equal((await api('/live')).available, false);

  // An OpenAI model provider's key: OpenAI, and it says which key pays.
  app.settings.update({ providers: [...app.settings.get().providers, OPENAI_PROVIDER] as never });
  app.vault.set('provider:openai', 'sk-provider');
  live = await api('/live');
  assert.deepEqual([live.available, live.engine, live.how], [true, 'openai', 'openai-provider-key']);
  assert.match(live.billedTo, /"OpenAI" model provider/);

  // Grok too: whichever is set up prefers Grok.
  app.vault.set('voice:xai', 'xai-key');
  live = await api('/live');
  assert.deepEqual([live.engine, live.how], ['grok', 'xai-key']);

  // An explicit choice is respected.
  let v = await api('/voice', { method: 'PUT', body: JSON.stringify({ live: 'openai', openaiRealtime: { voiceId: 'marin', model: 'gpt-realtime-2.1-mini' } }) });
  assert.equal(v.live, 'openai');
  assert.deepEqual(v.openaiRealtime, { voiceId: 'marin', model: 'gpt-realtime-2.1-mini' });
  assert.equal((await api('/live')).engine, 'openai');
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/api/live/${conv.id}`, { headers: H } as unknown as string[]);
  const ev2: Record<string, unknown>[] = [];
  ws2.onmessage = (m) => typeof m.data === 'string' && ev2.push(JSON.parse(m.data));
  await until(() => ev2.some((e) => e.type === 'ready'), 'ready (openai)');
  assert.equal(ups.at(-1)!.kind, 'openai');
  assert.equal(ups.at(-1)!.up.key, 'sk-provider');
  assert.match(ups.at(-1)!.up.url, /model=gpt-realtime-2\.1-mini$/);
  ws2.close();
  await until(() => (ups.at(-1)!.up as FakeOpenAi).closed, 'call ended');

  await api('/voice', { method: 'PUT', body: JSON.stringify({ live: 'grok' }) });
  assert.equal((await api('/live')).engine, 'grok');
  // Chosen but not set up: unavailable (no silent switch to the other one).
  app.vault.delete('voice:xai');
  live = await api('/live');
  assert.equal(live.available, false);
  assert.match(live.message, /set to Grok/);

  // Settings → Voice reports both, and checks what it's given.
  const view = await api('/voice');
  assert.deepEqual(view.openaiLive.voices.slice(0, 2), ['marin', 'cedar']);
  assert.ok(view.openaiLive.voices.includes('shimmer'));
  assert.deepEqual(view.keys.openaiRealtime, { source: 'provider', provider: 'OpenAI' });
  const badVoice = await fetch(`http://127.0.0.1:${port}/api/voice`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ openaiRealtime: { voiceId: 'nobody' } }) });
  assert.equal(badVoice.status, 400);
  const badLive = await fetch(`http://127.0.0.1:${port}/api/voice`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ live: 'skype' }) });
  assert.equal(badLive.status, 400);
  const badSample = await fetch(`http://127.0.0.1:${port}/api/voice/openai-sample?voice=../../x`, { headers: H });
  assert.equal(badSample.status, 400);
  // The voice notes path is unchanged: still the classic speech engines (their platform default).
  v = await api('/voice');
  assert.equal(v.settings.stt, defaultEngines().stt);
});

// R2c: her tools on a live call (fake voice service, synthetic tools). Nothing said ever approves.
function toolRig(t: { after: (fn: () => void) => void }, engine?: LiveEngine) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-06T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: '2026-11-06T14:00:00Z' } as never);
  const ran: string[] = [];
  app.tools.add({ spec: { name: 'look_up', description: 'Look something up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }, defaultPermission: 'auto', summarize: (a) => `Look up ${String(a.q)}`, async run(a) { ran.push(`look_up:${String(a.q)}`); return `Found ${String(a.q)}.`; } });
  app.tools.add({ spec: { name: 'send_note', description: 'Send a note', parameters: { type: 'object', properties: { text: { type: 'string' } } } }, defaultPermission: 'ask', summarize: (a) => `Send "${String(a.text)}"`, async run(a) { ran.push(`send_note:${String(a.text)}`); return 'Sent.'; } });
  const conv = app.store.createConversation();
  const told: Record<string, unknown>[] = [];
  const client = { open: true, send(d: string | Buffer) { if (typeof d === 'string') told.push(JSON.parse(d)); }, close() {} } as WsConnection;
  let voice: FakeVoice | undefined;
  const call = new LiveCall(app, conv.id, client, 'test-key', { connect: () => (voice = new FakeVoice()), ...(engine ? { engine } : {}) });
  call.start();
  t.after(() => {
    call.end('done');
    app.store.close();
    cleanup();
  });
  return { app, conv, call, told, ran, voice: () => voice! };
}
const fnCall = (v: FakeVoice, call_id: string, name: string, args: Record<string, unknown>) => v.emit({ type: 'response.function_call_arguments.done', call_id, name, arguments: JSON.stringify(args) });
const outputs = (v: FakeVoice) => v.sent.filter((e) => e.type === 'conversation.item.create' && (e.item as { type?: string }).type === 'function_call_output').map((e) => e.item as { call_id: string; output: string });

test('live function call runs through executor with receipt', async (t) => {
  const r = toolRig(t);
  await until(() => r.told.some((e) => e.type === 'ready'), 'ready');
  const setup = r.voice().sent[0] as { session: { tools?: { name: string; type: string }[]; instructions: string } };
  const declared = setup.session.tools?.map((x) => x.name) ?? [];
  assert.ok(declared.includes('look_up') && declared.includes('send_note'), 'the text turn\'s tools are declared');
  assert.ok(!declared.includes('shell'), 'command runners stay in the chat');
  assert.ok(setup.session.tools?.every((x) => x.type === 'function'));
  assert.match(setup.session.instructions, /Only their tap on the screen answers it/);
  assert.deepEqual(r.told.find((e) => e.type === 'tools'), { type: 'tools', on: true, fallback: false });
  r.voice().hear('look up the tides for Saturday');
  fnCall(r.voice(), 'fc1', 'look_up', { q: 'tides' });
  await until(() => outputs(r.voice()).length === 1, 'tool output sent back');
  assert.deepEqual(r.ran, ['look_up:tides']);
  assert.equal(outputs(r.voice())[0].call_id, 'fc1');
  assert.match(outputs(r.voice())[0].output, /Found tides\./);
  assert.equal(r.voice().sent.at(-1)!.type, 'response.create', 'she answers with the result');
  const receipt = r.app.store.messages(r.conv.id).find((m) => m.role === 'notice' && m.meta?.live === true && m.meta?.tool === 'look_up');
  assert.ok(receipt, 'a receipt is kept in the chat');
  assert.equal(receipt!.meta?.status, 'ok');
  assert.ok(r.told.some((e) => e.type === 'tool' && e.state === 'ok' && e.id === 'fc1'));
  // A tool the text turn would not offer never runs, whatever the voice service asks for.
  fnCall(r.voice(), 'fc2', 'shell', { command: 'rm -rf /' });
  await until(() => outputs(r.voice()).length === 2, 'refusal sent');
  assert.match(outputs(r.voice())[1].output, /isn't available on this call/);
  assert.deepEqual(r.ran, ['look_up:tides']);
});

test('ask tool waits for tap, speech yes does not approve', async (t) => {
  const r = toolRig(t);
  await until(() => r.told.some((e) => e.type === 'ready'), 'ready');
  r.voice().hear('send Jo a note saying hi');
  fnCall(r.voice(), 'fc1', 'send_note', { text: 'hi' });
  await until(() => r.told.some((e) => e.type === 'approval'), 'approval card');
  const card = r.told.find((e) => e.type === 'approval') as { approvalId: string; id: string; summary: string };
  assert.equal(card.id, 'fc1');
  assert.match(card.summary, /Send "hi"/);
  // "Yes, do it" on the call is just words: nothing runs, the card still waits.
  r.voice().hear('yes, do it');
  r.voice().hear('uh-huh');
  await wait(50);
  assert.deepEqual(r.ran, []);
  assert.equal(r.app.approvals.pendingFor(r.conv.id).length, 1);
  assert.equal(outputs(r.voice()).length, 0);
  // Only the tap answers it.
  assert.equal(r.app.approvals.decide(card.approvalId, true), true);
  await until(() => outputs(r.voice()).length === 1, 'result after the tap');
  assert.deepEqual(r.ran, ['send_note:hi']);
  assert.ok(r.told.some((e) => e.type === 'approval_done' && e.id === 'fc1' && e.approved === true));
  // A no is a no.
  fnCall(r.voice(), 'fc2', 'send_note', { text: 'again' });
  await until(() => r.told.filter((e) => e.type === 'approval').length === 2, 'second card');
  const second = r.told.filter((e) => e.type === 'approval')[1] as { approvalId: string };
  r.app.approvals.decide(second.approvalId, false);
  await until(() => outputs(r.voice()).length === 2, 'declined result');
  assert.match(outputs(r.voice())[1].output, /declined/);
  assert.deepEqual(r.ran, ['send_note:hi']);
});

test('hang-up cancels pending approval', async (t) => {
  const r = toolRig(t);
  await until(() => r.told.some((e) => e.type === 'ready'), 'ready');
  r.voice().hear('send Jo a note');
  fnCall(r.voice(), 'fc1', 'send_note', { text: 'bye' });
  await until(() => r.app.approvals.pendingFor(r.conv.id).length === 1, 'waiting');
  const sentBefore = r.voice().sent.length;
  r.call.end('You hung up.');
  await wait(30);
  assert.equal(r.app.approvals.pendingFor(r.conv.id).length, 0, 'the wait is cancelled');
  assert.deepEqual(r.ran, [], 'nothing runs after the call');
  assert.equal(r.voice().sent.length, sentBefore, 'nothing more goes to the voice service');
  assert.equal(LIVE_APPROVAL_MS, 120_000);
});

test('partial transcript never starts a tool', async (t) => {
  const r = toolRig(t);
  await until(() => r.told.some((e) => e.type === 'ready'), 'ready');
  // Only interim words so far (still being transcribed): nothing may run on them.
  r.voice().emit({ type: 'input_audio_buffer.speech_started', item_id: 'p1' });
  r.voice().emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'p1', transcript: 'look up the', status: 'in_progress' });
  fnCall(r.voice(), 'fc1', 'look_up', { q: 'something' });
  await until(() => outputs(r.voice()).length === 1, 'refusal');
  assert.deepEqual(r.ran, []);
  assert.match(outputs(r.voice())[0].output, /Not done/);
});

test('engine without tools shows fallback', async (t) => {
  class NoFunctions extends GrokEngine {
    override readonly functions = false;
  }
  const r = toolRig(t, new NoFunctions('eve', { persona: 'Sara' }));
  await until(() => r.told.some((e) => e.type === 'ready'), 'ready');
  const setup = r.voice().sent[0] as { session: { tools?: unknown[]; instructions: string } };
  assert.equal(setup.session.tools, undefined, 'no tools declared');
  assert.match(setup.session.instructions, /You can't use tools on this call/);
  assert.deepEqual(r.told.find((e) => e.type === 'tools'), { type: 'tools', on: false, fallback: true });
  r.voice().hear('look up the tides');
  fnCall(r.voice(), 'fc1', 'look_up', { q: 'tides' });
  await wait(50);
  assert.deepEqual(r.ran, []);
});
