// 3.4.3 (owner report: "when I sent her a screenshot of a medical record ... she could not see it and
// convert it to information that she could save from it, like lab results that are an image").
// The real Ollama adapter against a fake daemon that records what reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { ModelContextStore, noteOllamaDaemon, parseOllamaShow, parseOllamaTags, parseOpenRouter } from '../src/model-context.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { modelSees } from '../src/picture-reader.ts';
import { OpenAICompatibleProvider, resetOllamaContext } from '../src/providers/openai-compatible.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { checkClaims, correctionNote } from '../src/receipts.ts';
import { listen, makeApp, readBody, tempDir, type TestApp } from './helpers.ts';

/** A tiny real JPEG (the header bytes the upload store checks). */
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`;
const LAB = 'A lab report.\nGlucose 97 mg/dL 70-99\nTSH 2.31 uIU/mL 0.45-4.5';

interface Seen { path: string; model: string; images: number; text: string }

/** A fake Ollama daemon: /api/tags + /api/show with capabilities, /api/chat and /v1 recorded. */
async function fakeOllama(caps: Record<string, string[]>, answer: (s: Seen) => string = (s) => (s.images ? (s.text.includes('Read this picture') ? LAB : 'Glucose 97 mg/dL.') : 'Hello.')) {
  const seen: Seen[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const j = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (req.url === '/api/tags') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: Object.entries(caps).map(([name, c]) => ({ name, model: name, details: { context_length: 131072 }, capabilities: c })) }));
    if (req.url === '/api/show') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ capabilities: caps[String(j.model)] ?? ['completion'], model_info: { 'general.architecture': 'x', 'x.context_length': 131072 } }));
    const msgs = (j.messages ?? []) as { role: string; content: unknown; images?: string[] }[];
    let images = 0;
    let text = '';
    for (const m of msgs) {
      if (Array.isArray(m.content)) {
        images += m.content.filter((p: { type?: string }) => p.type === 'image_url').length;
        text += ` ${m.content.map((p: { text?: string }) => p.text ?? '').join(' ')}`;
      } else text += ` ${String(m.content ?? '')}`;
      images += m.images?.length ?? 0;
    }
    const s: Seen = { path: String(req.url), model: String(j.model), images, text };
    seen.push(s);
    const out = /safety classifier/i.test(text) ? 'OK' : answer(s);
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: out }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3 })}\n`);
      return void res.end();
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const turns = () => seen.filter((s) => !/safety classifier/i.test(s.text) && (s.path.endsWith('/chat/completions') || s.path === '/api/chat'));
  return { seen, turns, url, close: () => server.close() };
}

/** A text-only subscription agent (like the owner's Grok): records that it was called. */
class Blind implements Provider {
  readonly config: ProviderConfig;
  calls: ChatRequest[] = [];
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push(req);
    yield { type: 'text', text: 'blind' };
  }
}

function setup(t: { after: (fn: () => void) => void }, providers: ProviderConfig[], extra: Record<string, unknown> = {}): { app: TestApp; blind: Blind[] } {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
  app.settings.update({ providers, defaultProviderId: providers[0].id, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', ...extra });
  app.modelContext = new ModelContextStore(dir, app.now);
  const blind: Blind[] = [];
  app.providerFactory = (config) => {
    if (config.kind === 'openai-compatible') return new OpenAICompatibleProvider(config);
    const b = new Blind(config);
    blind.push(b);
    return b;
  };
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, blind };
}

async function send(app: TestApp, convId: string, text: string, images: string[] = []): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, text, new AbortController().signal, images.length ? { images } : {})) out.push(ev);
  return out;
}

const VISION = ['completion', 'vision', 'tools', 'thinking'];
const TEXT = ['completion', 'tools', 'thinking'];
const GROK: ProviderConfig = { id: 'grok-sub', label: 'Grok (SuperGrok / X Premium+)', kind: 'grok-cli', baseUrl: 'https://cli-chat-proxy.grok.com' };
const CLAUDE: ProviderConfig = { id: 'claude-sub', label: 'Claude (your subscription)', kind: 'claude-code', baseUrl: 'https://api.anthropic.com' };

// ---------------------------------------------------------------------------------------------
// The capability lookup
// ---------------------------------------------------------------------------------------------

test('capabilities: Ollama /api/tags and /api/show, OpenRouter input modalities; unknown stays unknown', () => {
  const tags = parseOllamaTags({ models: [{ name: 'gemma4:31b-cloud', details: { context_length: 131072 }, capabilities: VISION }, { name: 'glm-5.2:cloud', details: { context_length: 131072 }, capabilities: TEXT }, { name: 'old', details: { context_length: 8192 } }] });
  assert.equal(tags['gemma4:31b-cloud'].vision, true);
  assert.equal(tags['glm-5.2:cloud'].vision, false);
  assert.equal(tags.old.vision, undefined);
  assert.equal(parseOllamaShow({ capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'g', 'g.context_length': 4096 } })?.vision, true);
  const or = parseOpenRouter({ data: [{ id: 'a', context_length: 1000, architecture: { input_modalities: ['text', 'image'] } }, { id: 'b', context_length: 1000, architecture: { input_modalities: ['text'] } }] });
  assert.equal(or.a.vision, true);
  assert.equal(or.b.vision, false);
  // Subscription command-line agents get text only, whatever the model.
  assert.equal(modelSees({}, GROK, 'grok-4.7'), false);
  assert.equal(modelSees({}, { id: 'x', label: 'x', kind: 'openai-compatible', baseUrl: 'http://x' }, 'm'), undefined);
});

// ---------------------------------------------------------------------------------------------
// Photos reach /v1 and /api/chat
// ---------------------------------------------------------------------------------------------

for (const model of ['gemma4:31b-cloud', 'gemma4:12b']) {
  for (const priv of [false, true]) {
    if (priv && model.endsWith('cloud')) continue; // a cloud model is never a private chat's model (checked below)
    test(`a photo reaches ${model} through the Ollama daemon (${model.endsWith('cloud') ? '/v1' : '/api/chat'}, ${priv ? 'private' : 'not private'})`, async (t) => {
      resetOllamaContext();
      const o = await fakeOllama({ [model]: VISION });
      t.after(o.close);
      noteOllamaDaemon(`${o.url}/v1`);
      const { app } = setup(t, [{ id: 'ol', label: 'Ollama on the server', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true }], { defaultModel: model, ...(priv ? { routes: { private: { providerId: 'ol', model } } } : {}) });
      const conv = app.store.createConversation({ private: priv });
      const up = app.uploads!.save(JPEG);
      await send(app, conv.id, 'Can you save these lab results for me?', [up.id]);
      const turn = o.turns();
      assert.ok(turn.length >= 1, 'the model was called');
      assert.equal(turn[0].path, model.endsWith('cloud') ? '/v1/chat/completions' : '/api/chat');
      assert.equal(turn[0].images, 1, 'the picture reached the model');
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The owner's settings: Vision = Grok (blind) with gemma4:31b-cloud as its fallback; Adult = gemma4.
// ---------------------------------------------------------------------------------------------

function ownerSettings(url: string, more: Record<string, unknown> = {}) {
  const ol: ProviderConfig = { id: 'ollama-local', label: 'Ollama on the server', kind: 'openai-compatible', baseUrl: `${url}/v1`, local: true };
  return {
    providers: [ol, GROK, CLAUDE],
    extra: {
      defaultModel: 'gemma4:31b-cloud',
      adultMode: { on: true, confirmedAt: '2026-10-25T01:47:59.117Z' },
      routes: {
        chat: { providerId: 'claude-sub', model: 'claude-opus-5-5' },
        vision: { providerId: 'grok-sub', model: 'grok-4.7', fallbacks: [{ providerId: 'ollama-local', model: 'gemma4:31b-cloud' }] },
        adult: { providerId: 'ollama-local', model: 'gemma4:31b-cloud' },
        screen: { providerId: 'grok-sub', model: 'grok-4.7' },
        ...more,
      },
    },
  };
}

test('the owner\'s case: an adult-route turn on gemma4:31b-cloud (the picture job\'s own fallback) gets the photo itself', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'gemma4:31b-cloud': VISION });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const { providers, extra } = ownerSettings(o.url);
  const { app, blind } = setup(t, providers, extra);
  const conv = app.store.createConversation();
  // An earlier adult message makes this an adult turn (the adult route wins over the picture job).
  app.store.addMessage(conv.id, 'user', 'last night was hot sex, babe');
  app.store.addMessage(conv.id, 'assistant', 'Mm.');
  const up = app.uploads!.save(JPEG);
  const evs = await send(app, conv.id, 'look', [up.id]);
  const turn = o.turns();
  assert.equal(turn[0].model, 'gemma4:31b-cloud');
  assert.equal(turn[0].images, 1, `the photo reached gemma: ${JSON.stringify(turn.map((s) => [s.path, s.images]))}`);
  assert.ok(!turn[0].text.includes('photo(s) shared earlier'), 'no bare "photo shared" note');
  assert.ok(!blind.some((b) => b.calls.length), 'Grok (text only) is never asked');
  assert.ok(!evs.some((e) => e.type === 'notice' && e.kind === 'picture'), 'nothing to explain: she saw it');
});

test('a talking model that can\'t see: the picture job\'s seeing model reads it into text; the owner is told which', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'gemma4:31b-cloud': VISION, 'glm-5.2:cloud': TEXT });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const { providers, extra } = ownerSettings(o.url, { adult: { providerId: 'ollama-local', model: 'glm-5.2:cloud' } });
  const { app } = setup(t, providers, extra);
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'last night was hot sex, babe');
  const up = app.uploads!.save(JPEG);
  const evs = await send(app, conv.id, 'save these please', [up.id]);
  const turns = o.turns();
  const read = turns.find((s) => s.text.includes('Read this picture'));
  assert.ok(read, `a reader was asked: ${JSON.stringify(turns.map((s) => [s.model, s.images]))}`);
  assert.equal(read!.model, 'gemma4:31b-cloud');
  assert.equal(read!.images, 1);
  const talk = turns.find((s) => s.model === 'glm-5.2:cloud')!;
  assert.equal(talk.images, 0, 'the blind model gets no picture');
  assert.match(talk.text, /Ollama on the server \(gemma4:31b-cloud\) read it for you/);
  assert.match(talk.text, /Glucose 97 mg\/dL 70-99/);
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'picture') as { text: string } | undefined;
  assert.match(notice!.text, /glm-5\.2:cloud\) can't see pictures, so Ollama on the server \(gemma4:31b-cloud\) read yours/);
  // Kept with the message: the next turn has the values without reading again.
  const user = app.store.messages(conv.id).find((m) => m.role === 'user' && Array.isArray(m.meta?.images))!;
  assert.match(String((user.meta?.readout as { text: string }).text), /TSH 2\.31/);
  const before = o.turns().length;
  await send(app, conv.id, 'what did the picture say about TSH?');
  const next = o.turns().slice(before);
  assert.ok(!next.some((s) => s.text.includes('Read this picture')), 'not read again');
  assert.match(next.at(-1)!.text, /TSH 2\.31 uIU\/mL/);
});

test('the picture job saw it; the next turn\'s text-only model is told so (it doesn\'t take the values for made up)', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'gemma4:31b-cloud': VISION, 'glm-5.2:cloud': TEXT });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const ol: ProviderConfig = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true };
  const { app } = setup(t, [ol], { defaultModel: 'glm-5.2:cloud', routes: { vision: { providerId: 'ol', model: 'gemma4:31b-cloud' } } });
  const conv = app.store.createConversation();
  await send(app, conv.id, 'save these', [app.uploads!.save(JPEG).id]);
  assert.equal(o.turns()[0].model, 'gemma4:31b-cloud');
  assert.equal(o.turns()[0].images, 1);
  const before = o.turns().length;
  await send(app, conv.id, 'what was my TSH?');
  const next = o.turns().slice(before).find((x) => x.model === 'glm-5.2:cloud')!;
  assert.match(next.text, /seen then by Ollama \(gemma4:31b-cloud\): what was said about it right after came from the picture itself/);
});

test('no picture job: another model the owner set up that can see reads it (capability lookup)', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'qwen3.5:9b': VISION, 'glm-5.2:cloud': TEXT });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const ol: ProviderConfig = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true };
  const { app } = setup(t, [ol], { defaultModel: 'glm-5.2:cloud', routes: { quick: { providerId: 'ol', model: 'qwen3.5:9b' } } });
  const conv = app.store.createConversation();
  const up = app.uploads!.save(JPEG);
  const evs = await send(app, conv.id, 'look', [up.id]);
  assert.ok(!evs.some((e) => e.type === 'error'), JSON.stringify(evs.filter((e) => e.type === 'error')));
  const read = o.turns().find((s) => s.text.includes('Read this picture'));
  assert.equal(read?.model, 'qwen3.5:9b', JSON.stringify(o.seen.map((x) => [x.path, x.model, x.images, x.text.slice(0, 80)])));
  const talk = o.turns().find((s) => s.model === 'glm-5.2:cloud');
  assert.equal(talk?.images, 0, JSON.stringify(o.seen.map((x) => [x.path, x.model, x.images, x.text.slice(0, 80)])));
});

test('a model the owner never chose is never sent the picture; nothing can read it: she is told plainly, never pretends', async (t) => {
  resetOllamaContext();
  // The daemon has a seeing model, but the owner never set it up for anything.
  const o = await fakeOllama({ 'glm-5.2:cloud': TEXT, 'gemma4:12b': VISION }, (s) => (s.text.includes('Receipt check failed') ? "I can't see pictures with this model. Could you type the numbers?" : '*my eyes scanning the image carefully* Oh, these numbers look good!'));
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const ol: ProviderConfig = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true };
  const { app } = setup(t, [ol], { defaultModel: 'glm-5.2:cloud' });
  const conv = app.store.createConversation();
  const up = app.uploads!.save(JPEG);
  const evs = await send(app, conv.id, 'look', [up.id]);
  assert.ok(!o.turns().some((s) => s.model === 'gemma4:12b'), 'not a model the owner didn\'t configure');
  const talk = o.turns()[0];
  assert.equal(talk.images, 0);
  assert.match(talk.text, /the picture did not reach you/);
  assert.match(talk.text, /Which model does what → Looking at pictures/);
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'picture') as { text: string } | undefined;
  assert.match(notice!.text, /^I can't see pictures with the current model.*Fix it: pick a model that can see in Settings → Which model does what → Looking at pictures\.$/);
  // Her pretending to look is caught and corrected.
  const check = evs.find((e) => e.type === 'claim_check') as { claims: { kind: string }[] } | undefined;
  assert.ok(check?.claims.some((c) => c.kind === 'see'), 'the "looking at it" claim is flagged');
  const last = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.match(last.content, /can't see pictures/);
});

test('private conversation: only a model on this computer reads the picture; a cloud picture model never gets it', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'gemma4:31b-cloud': VISION, 'qwen3.5:9b': VISION, small: TEXT });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const ol: ProviderConfig = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true };
  const { app } = setup(t, [ol], { defaultModel: 'small', routes: { private: { providerId: 'ol', model: 'small' }, vision: { providerId: 'ol', model: 'gemma4:31b-cloud' }, quick: { providerId: 'ol', model: 'qwen3.5:9b' } } });
  const conv = app.store.createConversation({ private: true });
  const up = app.uploads!.save(JPEG);
  await send(app, conv.id, 'look', [up.id]);
  assert.ok(!o.seen.some((s) => s.model === 'gemma4:31b-cloud' && s.images), 'the cloud model never gets the picture');
  const read = o.turns().find((s) => s.text.includes('Read this picture'));
  assert.equal(read?.model, 'qwen3.5:9b', 'the local seeing model reads it');
  // Without a local seeing model: the honest note (and the private one).
  resetOllamaContext();
  const o2 = await fakeOllama({ 'gemma4:31b-cloud': VISION, small: TEXT });
  t.after(o2.close);
  noteOllamaDaemon(`${o2.url}/v1`);
  const { app: app2 } = setup(t, [{ ...ol, baseUrl: `${o2.url}/v1` }], { defaultModel: 'small', routes: { private: { providerId: 'ol', model: 'small' }, vision: { providerId: 'ol', model: 'gemma4:31b-cloud' } } });
  const c2 = app2.store.createConversation({ private: true });
  await send(app2, c2.id, 'look', [app2.uploads!.save(JPEG).id]);
  assert.ok(!o2.seen.some((s) => s.images));
  assert.match(o2.turns()[0].text, /on this computer for this private conversation/);
});

test('household member: a reader the owner didn\'t allow for the member is skipped', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama({ 'qwen3.5:9b': VISION, 'glm-5.2:cloud': TEXT });
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const ol: ProviderConfig = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true };
  const { app } = setup(t, [ol], { defaultModel: 'glm-5.2:cloud', routes: { quick: { providerId: 'ol', model: 'qwen3.5:9b' } } });
  (app as { member?: unknown }).member = { checkModel: (_p: string, m: string) => { if (m !== 'glm-5.2:cloud') throw new Error('not allowed'); }, checkBudget: () => {} };
  const conv = app.store.createConversation();
  await send(app, conv.id, 'look', [app.uploads!.save(JPEG).id]);
  assert.ok(!o.turns().some((s) => s.model === 'qwen3.5:9b'), 'not a model the member may not use');
  assert.match(o.turns()[0].text, /the picture did not reach you/);
});

// ---------------------------------------------------------------------------------------------
// Claims and her instructions
// ---------------------------------------------------------------------------------------------

test('claims: "looking at the picture" only counts when it never reached her; "I\'ve saved your results" needs the note tool', () => {
  const s = '*my eyes scanning the image carefully* Your numbers look great.';
  assert.ok(checkClaims(s, [], [], { pictureMissed: true }).some((c) => c.kind === 'see'));
  assert.ok(!checkClaims(s, [], [], { pictureMissed: false }).some((c) => c.kind === 'see'));
  assert.ok(checkClaims("I'm looking at your lab results now.", [], [], { pictureMissed: true }).some((c) => c.kind === 'see'));
  assert.ok(!checkClaims("I can't see the picture with this model.", [], [], { pictureMissed: true }).length);
  const saved = checkClaims("I've saved your lab results to your notes.", [], []);
  assert.ok(saved.some((c) => c.kind === 'planner'), JSON.stringify(saved));
  assert.equal(checkClaims("I've saved your lab results to your notes.", [{ name: 'note', status: 'ok', args: { action: 'add' }, output: 'Added to note 3.' } as never], []).length, 0);
  assert.match(correctionNote([{ kind: 'see', sentence: s, problem: 'missing' }]), /the picture did not reach you/);
  // A save from an earlier turn, named by its note number, is backed by that turn's note call.
  const prior = [{ name: 'note', status: 'ok', args: { action: 'add', text: 'Lab Results' }, output: 'Added to note #1 "Lab Results".' }] as never;
  assert.equal(checkClaims('Based on the lab results I saved in note #1:', [], prior).length, 0);
  assert.ok(checkClaims('Based on the lab results I saved in note #2:', [], prior).length, 'another note number is not backed');
  assert.ok(checkClaims('Based on the lab results I saved in note #1:', [], []).length, 'no earlier save: flagged');
});

test('her instructions: read document photos exactly and keep the values with note add', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
  const p = buildSystemPrompt(app.persona, { now: new Date(), ownerName: 'Alex', tools: ['note'] });
  app.store.close();
  cleanup();
  assert.match(p, /picture of a document[^\n]*exactly/);
  assert.match(p, /If Alex wants it kept, save the values with note add/);
  assert.match(p, /Only say you see a picture when it really reached you/);
});
