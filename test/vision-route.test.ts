// 2.52.1 fix (owner report: "I just sent Sara a picture and she told me she could not see it"). His
// Vision and Screen jobs were set to a subscription command-line agent (Grok), which gets text only,
// so the photo was replaced by a note and the seeing fallback was never tried. A picture job now
// skips models that can't see: the job's next model, else the talking model, takes the picture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveChain, runTurn, type ChatEvent } from '../src/chat.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { seesPictures } from '../src/providers/types.ts';
import { ModelContextStore } from '../src/model-context.ts';
import { pictureNotices } from '../src/routes/models.ts';
import { makeApp, tempDir } from './helpers.ts';

const seen: { provider: string; model: string; images: number }[] = [];
class Fake implements Provider {
  readonly config: ProviderConfig;
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const images = req.messages.reduce((n, m) => n + (m.role === 'user' && m.images ? m.images.length : 0), 0);
    seen.push({ provider: this.config.id, model: req.model, images });
    yield { type: 'text', text: `${this.config.id} saw ${images} photo(s).` };
  }
}

const PROVIDERS: ProviderConfig[] = [
  { id: 'ollama', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  { id: 'grok-sub', label: 'Grok (SuperGrok / X Premium+)', kind: 'grok-cli', baseUrl: 'https://cli-chat-proxy.grok.com' },
  { id: 'claude-sub', label: 'Claude (your subscription)', kind: 'claude-code', baseUrl: 'https://api.anthropic.com' },
];

function setup(t: { after: (fn: () => void) => void }, routes: Record<string, unknown>) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-02T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.providerFactory = (config) => new Fake(config);
  app.settings.update({ providers: PROVIDERS, defaultProviderId: 'ollama', defaultModel: 'gemma4:31b', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-02T12:00:00.000Z', routes: routes as never });
  return app;
}

test('seesPictures: subscription command-line agents are blind, API and local models see', () => {
  assert.equal(seesPictures({ kind: 'grok-cli' }), false);
  assert.equal(seesPictures({ kind: 'claude-code' }), false);
  assert.equal(seesPictures({ kind: 'chatgpt' }), true);
  assert.equal(seesPictures({ kind: 'openai-compatible' }), true);
});

test('a blind Vision model is skipped for its seeing fallback (the owner\'s exact settings)', (t) => {
  const app = setup(t, {
    chat: { providerId: 'ollama', model: 'gemma4:31b-cloud' },
    vision: { providerId: 'grok-sub', model: 'grok-4.7', fallbacks: [{ providerId: 'ollama', model: 'gemma4:31b-cloud' }] },
    screen: { providerId: 'grok-sub', model: 'grok-4.7' },
  });
  const conv = app.store.createConversation();
  const v = resolveChain(app, conv, 'vision');
  assert.equal(`${v[0].provider.config.id}/${v[0].model}`, 'ollama/gemma4:31b-cloud');
  assert.ok(v.every((c) => seesPictures(c.provider.config)));
  // Screen has no seeing fallback of its own: the talking model takes it.
  const s = resolveChain(app, conv, 'screen');
  assert.equal(`${s[0].provider.config.id}/${s[0].model}`, 'ollama/gemma4:31b-cloud');
  // Plain talk is untouched.
  assert.equal(resolveChain(app, conv, 'turn')[0].model, 'gemma4:31b-cloud');
});

test('a photo in the chat reaches a model that can see it, and she answers about it', async (t) => {
  const app = setup(t, {
    chat: { providerId: 'claude-sub', model: 'sonnet', fallbacks: [{ providerId: 'ollama', model: 'gemma4:31b' }] },
    vision: { providerId: 'grok-sub', model: 'grok-4.7' },
  });
  const conv = app.store.createConversation();
  const up = app.uploads!.save(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`);
  seen.length = 0;
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'what do I need to put here', undefined, { images: [up.id] })) out.push(ev);
  const first = seen[0];
  assert.ok(first, `a model answered: ${JSON.stringify(out.filter((e) => e.type === 'error'))}`);
  assert.equal(first.provider, 'ollama', 'the seeing model took the picture, not Grok or Claude');
  assert.equal(first.images, 1, 'and it got the photo itself');
});

test('a conversation with its own model chosen keeps it (his explicit choice wins)', (t) => {
  const app = setup(t, { vision: { providerId: 'grok-sub', model: 'grok-4.7' } });
  const conv = app.store.createConversation();
  const c = app.store.updateConversation(conv.id, { providerId: 'grok-sub', model: 'grok-4.7' })!;
  assert.equal(resolveChain(app, c, 'vision')[0].provider.config.id, 'grok-sub');
});

// Leftover 6 (3.4.x follow-up): an API model whose provider's list says it takes no pictures (a Grok
// text model through xAI's API) is skipped like a subscription app, and Settings → Models says so.
test('a text-only API model in the Vision slot is skipped for the next model that can see, with a notice', async (t) => {
  const app = setup(t, {
    chat: { providerId: 'ollama', model: 'gemma4:31b' },
    vision: { providerId: 'xai', model: 'grok-code-fast', fallbacks: [{ providerId: 'xai', model: 'grok-4-vision' }] },
  });
  app.settings.update({ providers: [...PROVIDERS, { id: 'xai', label: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' }] });
  // The fake provider list: grok-code-fast is text only, grok-4-vision sees, gemma4 unknown.
  app.modelContext = new ModelContextStore(undefined);
  app.modelContext.limits = (_c, m) => (m === 'grok-code-fast' ? { limits: { context: 1, vision: false }, source: 'provider' } : m === 'grok-4-vision' ? { limits: { context: 1, vision: true }, source: 'provider' } : { source: 'default' });
  const conv = app.store.createConversation();
  const v = resolveChain(app, conv, 'vision');
  assert.equal(`${v[0].provider.config.id}/${v[0].model}`, 'xai/grok-4-vision');
  assert.ok(!v.some((c) => c.model === 'grok-code-fast'));
  assert.deepEqual(pictureNotices(app), { vision: { providerId: 'xai', model: 'grok-code-fast', usedProvider: 'xAI', usedModel: 'grok-4-vision' } });
  // A real photo goes to the seeing model with the image.
  const up = app.uploads!.save(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`);
  seen.length = 0;
  for await (const ev of runTurn(app, conv.id, 'what is this', undefined, { images: [up.id] })) void ev;
  assert.equal(`${seen[0]?.provider}/${seen[0]?.model}`, 'xai/grok-4-vision');
  assert.equal(seen[0].images, 1);
  // Without the seeing backup the talking model takes it; with a model that sees, no notice.
  app.settings.update({ routes: { chat: { providerId: 'ollama', model: 'gemma4:31b' }, vision: { providerId: 'xai', model: 'grok-code-fast' } } as never });
  assert.equal(resolveChain(app, conv, 'vision')[0].model, 'gemma4:31b');
  assert.equal(pictureNotices(app).vision?.usedModel, 'gemma4:31b');
  app.settings.update({ routes: { vision: { providerId: 'xai', model: 'grok-4-vision' } } as never });
  assert.deepEqual(pictureNotices(app), {});
});
