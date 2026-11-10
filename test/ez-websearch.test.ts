// 3.3.0 easy mode (ezfirst): research never promises what it can't do. Without web search, a
// "look it up" message gets a plain notice with Turn on web search (and she is told not to promise);
// /learn always answers; an Ollama Cloud key turns on Ollama web search; background research never
// makes the owner's first chat (it used to be called "Research").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, tempDir, text } from './helpers.ts';
import { runTurn } from '../src/chat.ts';
import { autoWebSearch, isOllamaCloud, useOllamaKeyForSearch, wantsWeb, webSearchOff } from '../src/web-search-auto.ts';
import { searchConfig } from '../src/integrations.ts';
import { backgroundConversation } from '../src/store.ts';
import { Research } from '../src/research.ts';
import { LibraryStore } from '../src/library/store.ts';

function rig() {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  return { app, cleanup };
}

test('websearch: what counts as asking her to look something up', () => {
  for (const s of ['Find me a good beginner guide for the WoW warrior class', 'Can you look it up?', 'search the web for cheap flights', 'what is the latest news about the election', 'research heat pumps for me', 'look into this restaurant online']) assert.equal(wantsWeb(s), true, s);
  for (const s of ['Hi Sara, how are you?', 'Tell me about yourself', 'Plan my day with me', 'I had a lovely walk today']) assert.equal(wantsWeb(s), false, s);
});

test('websearch: off + a look-it-up message = a notice with the button, and she is told not to promise', async () => {
  const { app, cleanup } = rig();
  try {
    const conv = app.store.createConversation();
    app.script.push(text('I can’t search the web yet.'));
    const evs: { type: string; kind?: string; oneTap?: boolean }[] = [];
    for await (const ev of runTurn(app, conv.id, 'Find me a good beginner guide for the WoW warrior class')) evs.push(ev as never);
    const n = evs.find((e) => e.type === 'notice' && e.kind === 'websearch');
    assert.ok(n, 'the turn says web search is off');
    assert.equal(n!.oneTap, false);
    const stored = app.store.messages(conv.id).find((m) => m.role === 'notice' && m.content.startsWith('websearch:'));
    assert.ok(stored, 'kept in the chat');
    assert.equal((stored!.meta as { page?: string }).page, 'ab-search');
    const sys = app.requests.at(-1)!.messages.map((m) => String(m.content)).join('\n');
    assert.match(sys, /Web search is not set up/);
    assert.match(sys, /Don't say you'll look/);
    // An ordinary message gets nothing.
    const before = app.store.messages(conv.id).filter((m) => m.role === 'notice').length;
    for await (const _ of runTurn(app, conv.id, 'Thanks, how are you?')) void _;
    assert.equal(app.store.messages(conv.id).filter((m) => m.role === 'notice').length, before);
  } finally {
    cleanup();
  }
});

test('websearch: an Ollama Cloud key turns on Ollama web search; his own choice stays; one tap uses the key', () => {
  const { app, cleanup } = rig();
  try {
    assert.equal(isOllamaCloud({ id: 'ollama-cloud', baseUrl: 'http://127.0.0.1:9/v1' }), true);
    assert.equal(isOllamaCloud({ id: 'mine', baseUrl: 'https://ollama.com/v1' }), true);
    assert.equal(isOllamaCloud({ id: 'openai', baseUrl: 'https://api.openai.com/v1' }), false);
    assert.equal(autoWebSearch(app, { id: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'sk-x'), false);
    assert.equal(autoWebSearch(app, { id: 'ollama-cloud', baseUrl: 'https://ollama.com/v1' }, ''), false);
    assert.equal(autoWebSearch(app, { id: 'ollama-cloud', baseUrl: 'https://ollama.com/v1' }, 'abc.def'), true);
    assert.deepEqual(searchConfig(app.settings, app.vault), { provider: 'ollama', apiKey: 'abc.def' });
    // He picked something else: a later key doesn't change it.
    app.settings.update({ search: { provider: 'searxng', url: 'http://s/' } });
    assert.equal(autoWebSearch(app, { id: 'ollama-cloud', baseUrl: 'https://ollama.com/v1' }, 'new'), false);
    assert.equal(app.settings.get().search?.provider, 'searxng');
    // One tap: an existing Ollama Cloud provider's key.
    app.settings.update({ search: undefined, providers: [...app.settings.get().providers, { id: 'ollama-cloud', label: 'Ollama Cloud', kind: 'openai-compatible', baseUrl: 'https://ollama.com/v1' }] } as never);
    app.vault.delete('search:ollama');
    app.vault.set('provider:ollama-cloud', 'k2');
    assert.deepEqual(webSearchOff(app, 'look it up'), { oneTap: true });
    assert.equal(useOllamaKeyForSearch(app), true);
    assert.equal(webSearchOff(app, 'look it up'), null);
  } finally {
    cleanup();
  }
});

test('research: background work never makes his first chat', () => {
  const { app, cleanup } = rig();
  try {
    assert.equal(app.store.listConversations().length, 0);
    const c = backgroundConversation(app.store, 'Research');
    assert.equal(c.id, '');
    app.library = new LibraryStore(app.store.db, app.dataDir, () => app.now());
    const r = new Research(app, app.store.db);
    r.modelChoice();
    assert.equal(app.store.listConversations().length, 0, 'no "Research" chat');
    const mine = app.store.createConversation();
    assert.equal(backgroundConversation(app.store, 'Research').id, mine.id);
  } finally {
    cleanup();
  }
});

test('/learn without web search answers in the chat and the answer stays (with the button flag)', async () => {
  const { app, cleanup } = rig();
  try {
    const { Learning } = await import('../src/learn.ts');
    app.learnTopics = new Learning(app, app.store.db);
    const { runCommand } = await import('../src/bridges/commands.ts');
    const conv = app.store.createConversation();
    const r = await runCommand({ app, bridge: 'web', place: 'owner-dm', who: 'owner', lang: 'en', cmd: { name: 'learn', args: 'how to grow roses', form: 'typed' }, adapter: { currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 } } as never);
    assert.match(r.text, /web search/i);
    const n = app.store.messages(conv.id).find((m) => m.role === 'notice' && m.content === 'command:learn');
    assert.ok(n, 'kept in the chat');
    assert.equal((n!.meta as { args?: string }).args, 'how to grow roses');
    assert.deepEqual((n!.meta as { webSearch?: unknown }).webSearch, { oneTap: false });
  } finally {
    cleanup();
  }
});
