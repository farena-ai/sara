// T47: a failed reply in the owner's language. The turn's error event and the kept notice carry the
// English template and values of a marked error; the app (web/trouble.js failedReplyText) and the
// bridges (src/i18n.ts errorText) show it from those.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { en, enf, errorText, tr } from '../src/i18n.ts';
import { ProviderError, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent } from '../src/providers/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const LOCAL: ProviderConfig = { id: 'box', label: 'The box', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'small' };
type ErrorEvent = Extract<ChatEvent, { type: 'error' }>;

/** An app whose model fails every call with `error()`. */
function failingApp(t: { after: (fn: () => void) => void }, error: () => Error): TestApp {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-24T09:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [LOCAL], defaultProviderId: LOCAL.id, defaultModel: LOCAL.defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
  app.providerFactory = (config): Provider => ({
    config,
    listModels: async () => ['small'],
    // eslint-disable-next-line require-yield
    async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
      throw error();
    },
  }) as Provider;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}

/** Runs one turn quietly and gives its error event. */
async function failedTurn(app: TestApp, conversationId: string): Promise<ErrorEvent> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    let err: ErrorEvent | undefined;
    for await (const ev of runTurn(app, conversationId, 'Hello?')) if (ev.type === 'error') err = ev;
    assert.ok(err, 'the turn ended in an error');
    return err;
  } finally {
    console.warn = warn;
  }
}

/** web/trouble.js has no imports, so it runs here as it does in the browser. */
const trouble = (): Promise<{ failedReplyText: (data: unknown, message: unknown, t: (s: string, p?: Record<string, unknown>) => string) => string }> =>
  import(pathToFileURL(join(ROOT, 'web', 'trouble.js')).href);
/** The app's t() for one language, from the same web/i18n files. */
const tIn = (lang: string) => (s: string, p?: Record<string, unknown>) => tr(s, lang, p);

test('an error with values: the event and the kept notice carry its template and values', async (t) => {
  const app = failingApp(t, () => new ProviderError(enf('{label} returned no body', { label: 'The box' })));
  const conv = app.store.createConversation();
  const err = await failedTurn(app, conv.id);
  assert.equal(err.message, 'The box returned no body', 'the English text is as it was');
  assert.equal(err.key, '{label} returned no body');
  assert.deepEqual(err.params, { label: 'The box' });
  const notice = app.store.messages(conv.id).find((m) => m.id === err.messageId);
  assert.ok(notice, 'the notice is kept');
  const meta = notice.meta as { error?: string; key?: string; params?: Record<string, unknown> };
  assert.equal(meta.error, 'The box returned no body');
  assert.equal(meta.key, '{label} returned no body');
  assert.deepEqual(meta.params, { label: 'The box' });

  const { failedReplyText } = await trouble();
  // Live (the event) and after a reload (the kept notice's meta) read the same.
  const live = failedReplyText(err, err.message, tIn('de'));
  assert.equal(live, 'Diese Antwort ist fehlgeschlagen: The box hat keinen Inhalt geliefert');
  assert.equal(failedReplyText(meta, 'The box returned no body', tIn('de')), live);
  assert.equal(failedReplyText(err, err.message, tIn('en')), 'This reply failed: The box returned no body');
  for (const lang of ['es', 'fr', 'pt-BR', 'it']) {
    const text = failedReplyText(err, err.message, tIn(lang));
    assert.ok(text.includes('The box'), `${lang}: keeps the value: ${text}`);
    assert.ok(!text.includes('returned no body'), `${lang}: still English: ${text}`);
  }
});

test('an error with fixed words has no template; the app looks the words up as they are', async (t) => {
  const app = failingApp(t, () => new ProviderError(en('ChatGPT returned no body')));
  const conv = app.store.createConversation();
  const err = await failedTurn(app, conv.id);
  assert.equal(err.message, 'ChatGPT returned no body');
  assert.equal(err.key, undefined);
  const { failedReplyText } = await trouble();
  assert.equal(failedReplyText(err, err.message, tIn('de')), 'Diese Antwort ist fehlgeschlagen: ChatGPT hat keinen Inhalt geliefert');
});

test("a service's own words stay as they came", async (t) => {
  const app = failingApp(t, () => new Error('upstream said: bad gateway thing 77'));
  const conv = app.store.createConversation();
  const err = await failedTurn(app, conv.id);
  assert.equal(err.key, undefined);
  const { failedReplyText } = await trouble();
  assert.equal(failedReplyText(err, err.message, tIn('fr')), `${tr('This reply failed: {error}', 'fr', { error: 'upstream said: bad gateway thing 77' })}`);
  assert.match(failedReplyText(err, err.message, tIn('fr')), /upstream said: bad gateway thing 77$/);
  assert.equal(failedReplyText(undefined, undefined, tIn('en')), 'This reply failed: ');
});

test('twice empty: the error keeps its template, so the app can show it in another language than the server wrote', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-24T09:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [LOCAL], defaultProviderId: LOCAL.id, defaultModel: LOCAL.defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
  const conv = app.store.createConversation();
  app.script.push([{ type: 'usage', input: 5, output: 0 }], [{ type: 'usage', input: 5, output: 0 }]);
  const err = await failedTurn(app, conv.id);
  assert.match(String(err.key), /^\{model\} returned an empty reply \(twice\)/);
  assert.deepEqual(err.params, { model: 'The box (small)' });
  const { failedReplyText } = await trouble();
  const it = failedReplyText(err, err.message, tIn('it'));
  assert.ok(it.includes('The box (small)') && !it.includes('returned an empty reply'), it);
});

test('bridges: the error line uses the template and values, or the fixed words', () => {
  const keyed = { message: 'The box returned no body', key: '{label} returned no body', params: { label: 'The box' } };
  assert.equal(errorText(keyed, 'de'), 'The box hat keinen Inhalt geliefert');
  assert.equal(errorText(keyed, 'en'), 'The box returned no body');
  assert.equal(errorText({ message: 'ChatGPT returned no body' }, 'de'), 'ChatGPT hat keinen Inhalt geliefert');
  assert.equal(errorText({ message: 'HTTP 418 from somewhere' }, 'de'), 'HTTP 418 from somewhere');
});
