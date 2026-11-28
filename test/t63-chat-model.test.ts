// T63 (owner, 2026-11-28): one model control, in the message box. "Model selection is in two places
// across the top, switching one does not switch the other, and a new pick doesn't change what is shown."
// Server: GET /api/conversations/:id/model names what the NEXT message uses (the same decision a turn
// makes); a PATCH applies from the next message, and a reply already being written keeps its model.
// Web: the chip / + menu item / picker (web/chat-model.js), no model in the strip or the header chip,
// and no model fields in the chat's settings dialog (one place to pick it).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// web/naming.js imports /identity.js, which the server builds from src/identity.ts: the same here.
registerHooks({
  resolve: (spec, context, next) => (spec === './identity.js' && String(context.parentURL).endsWith('/web/naming.js') ? next(pathToFileURL(join(ROOT, 'src', 'identity.ts')).href, context) : next(spec, context)),
});

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('T63 server: the next message uses the chat model the moment it is set; a reply in progress keeps its model', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-28T12:00:00Z') };
  const app = makeApp(dir, clock);
  // A provider whose first reply waits until the test lets it finish (a reply "being written").
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let started: () => void = () => {};
  const streaming = new Promise<void>((r) => (started = r));
  const asked: string[] = [];
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => ['fake-small', 'fake-large'],
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      asked.push(req.model);
      if (asked.length === 1) {
        yield { type: 'text', text: 'Part one, ' };
        started();
        await gate;
      }
      yield { type: 'text', text: 'done.' };
    },
  });
  app.settings.update({
    providers: [
      { id: 'p', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true },
      { id: 'q', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8' },
    ],
    defaultProviderId: 'p',
    defaultModel: 'fake-small',
    ownerName: 'Alex',
    timeZone: 'UTC',
    disclosureAcceptedAt: clock.now.toISOString(),
  } as never);
  const auth = new OwnerAuth(dir, () => clock.now);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = (p: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(base + p, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  const conv = await (await call('/conversations', { method: 'POST', body: {} })).json();

  // No model set: the default, named.
  let v = await (await call(`/conversations/${conv.id}/model`)).json();
  assert.equal(v.chosen, null);
  assert.deepEqual({ providerId: v.next.providerId, model: v.next.model, provider: v.next.provider }, { providerId: 'p', model: 'fake-small', provider: 'Local' });
  assert.deepEqual(v.default, v.next);

  // Her own model (Settings → Which model does what → her model) is what the default means for her.
  app.settings.update({ companionModel: { providerId: 'q', model: 'fake-large' } } as never);
  v = await (await call(`/conversations/${conv.id}/model`)).json();
  assert.equal(v.next.model, 'fake-large');
  assert.equal(v.next.from, 'companion');
  app.settings.update({ companionModel: null } as never);

  // A reply is being written with the default model...
  const first = call(`/conversations/${conv.id}/messages`, { method: 'POST', body: { content: 'hi' } });
  await streaming;
  // ...the model is switched mid-reply...
  const patched = await (await call(`/conversations/${conv.id}`, { method: 'PATCH', body: { providerId: 'q', model: 'fake-large' } })).json();
  assert.equal(patched.providerId, 'q');
  assert.equal(patched.model, 'fake-large');
  v = await (await call(`/conversations/${conv.id}/model`)).json();
  assert.deepEqual(v.chosen, { providerId: 'q', model: 'fake-large' });
  assert.equal(v.next.model, 'fake-large');
  assert.equal(v.next.from, 'conversation');
  assert.equal(v.default.model, 'fake-small', 'the default stays the default');
  // ...the reply in progress finishes as it started (never cut, never switched halfway).
  release();
  const body = await (await first).text();
  assert.match(body, /Part one, /);
  assert.match(body, /done\./);
  assert.deepEqual(asked, ['fake-small']);
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal(reply.meta?.model, 'fake-small');

  // The very next message uses the new model.
  await (await call(`/conversations/${conv.id}/messages`, { method: 'POST', body: { content: 'and now?' } })).text();
  assert.deepEqual(asked, ['fake-small', 'fake-large']);
  assert.equal(app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!.meta?.model, 'fake-large');

  // Back to the default: the next one uses it again.
  await call(`/conversations/${conv.id}`, { method: 'PATCH', body: { providerId: null, model: null } });
  v = await (await call(`/conversations/${conv.id}/model`)).json();
  assert.equal(v.chosen, null);
  assert.equal(v.next.model, 'fake-small');
  await (await call(`/conversations/${conv.id}/messages`, { method: 'POST', body: { content: 'last one' } })).text();
  assert.deepEqual(asked, ['fake-small', 'fake-large', 'fake-small']);

  // A private chat with a cloud model: the next message can't use it, and the view says why.
  await call(`/conversations/${conv.id}`, { method: 'PATCH', body: { private: true, providerId: 'q', model: 'fake-large' } });
  v = await (await call(`/conversations/${conv.id}/model`)).json();
  assert.equal(v.next, null);
  assert.ok(v.error);
  assert.equal((await call('/conversations/nope/model')).status, 404);
});

test('T63 web: short names, the picker groups and recent picks', async () => {
  const { shortModel, pickerGroups, readRecent, pushRecent } = await import(pathToFileURL(join(ROOT, 'web', 'chat-model.js')).href);
  assert.equal(shortModel('gemma4:31b-cloud'), 'gemma4:31b');
  assert.equal(shortModel('gpt-oss:120b:cloud'), 'gpt-oss:120b');
  assert.equal(shortModel('llama3.2:latest'), 'llama3.2');
  assert.equal(shortModel('anthropic/claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(shortModel('gpt-4o-2024-08-06'), 'gpt-4o');
  assert.equal(shortModel('qwen3:8b'), 'qwen3:8b');
  assert.equal(shortModel(''), '');
  const providers = [{ id: 'p', label: 'Ollama' }, { id: 'q', label: 'OpenAI' }];
  const groups = pickerGroups(providers, { p: ['a', 'b'], q: ['c'] }, { providerId: 'q', model: 'retired' }, [{ providerId: 'p', model: 'b' }, { providerId: 'x', model: 'gone' }]);
  assert.deepEqual(groups.map((g: { label: string }) => g.label), ['Recent', 'Ollama', 'OpenAI']);
  assert.deepEqual(groups[0].items.map((i: { model: string }) => i.model), ['b'], 'a recent pick no longer offered is left out');
  assert.deepEqual(groups[2].items.map((i: { model: string }) => i.model), ['retired', 'c'], "the chat's own model stays listed");
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  for (const m of ['a', 'b', 'c', 'd', 'a', 'e']) pushRecent({ providerId: 'p', model: m }, store);
  assert.deepEqual(readRecent(store).map((x: { model: string }) => x.model), ['e', 'a', 'd', 'c']);
  assert.deepEqual(readRecent({ getItem: () => { throw new Error('blocked'); } }), []);
});

test('T63 web: one model control in the message box; none in the strip, the header chip or the chat settings', () => {
  const html = read('web/index.html');
  const composer = html.slice(html.indexOf('<form id="composer">'), html.indexOf('</form>', html.indexOf('<form id="composer">')));
  // Wide screens: the chip next to +; phones: the + menu's first item; both open one picker.
  assert.match(composer, /<div id="composer-menu"[^>]*>\s*<!--[^>]*-->\s*<button id="cmp-model-item"/, 'the first item of the + menu');
  assert.match(composer, /<\/div>\s*<\/div>\s*<!--[^>]*-->\s*<div class="cmp-model-wrap">\s*<button id="cmp-model" class="cmp-model" type="button" aria-haspopup="menu"/, 'the chip right after +');
  assert.match(composer, /<div id="cmp-model-pop" class="cmp-model-pop head-pop" role="menu" aria-label="Model for this chat" hidden><\/div>/);
  const css = read('web/v4.css');
  assert.match(css, /@media \(min-width: 761px\) \{\n\s*#composer \{ flex-wrap: wrap; row-gap: 2px; \}\n\s*#composer > textarea#input \{ flex: 1 0 100%; \}\n\s*\.cmp-model-item \{ display: none; \}/, 'wide: the text keeps its whole row');
  assert.match(css, /@media \(max-width: 760px\) \{\n\s*\.cmp-model-wrap \{ display: none; \}/, 'phones: no chip');
  assert.match(css, /\.cmp-model-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  // The picker: Default at the top, a PATCH at once, the notice, the next message (never a reply in progress).
  const js = read('web/chat-model.js');
  assert.match(js, /row\(null, \{ checked: !chosen, label: t\('Default \(\{model\}\)'/);
  assert.match(js, /ctx\.api\(`\/conversations\/\$\{c\.id\}`, \{ method: 'PATCH', body: \{ providerId: pick\?\.providerId \?\? null, model: pick\?\.model \?\? null \} \}\)/);
  assert.match(js, /busy \? t\('This chat now uses \{model\} from your next message\. The reply she is writing finishes as it started\.'/);
  assert.match(js, /ctx\.api\(`\/conversations\/\$\{c\.id\}\/model`\)/, 'the chip names what the next message uses');
  assert.match(js, /if \(e\.key === 'Escape'\) \{/);
  assert.match(js, /e\.key !== 'ArrowDown' && e\.key !== 'ArrowUp'/);
  assert.match(js, /!ctx\.isGroup\(c\) && !ctx\.demo\(\)/, 'hidden in group chats and the demo');
  const app = read('web/app.js');
  assert.match(app, /const chatModel = initChatModel\(\{/);
  assert.match(app, /chatModel\.sync\(\);\n\s*panelConv\(\);/);
  assert.match(app, /if \(\/\^\\\/model\\b\/i\.test\(text\)\) void chatModel\.refresh\(\);/, '/model typed in the chat shows on the chip');
  // The header chip names the chat's settings, never the model; the dialog has no model fields.
  assert.match(app, /const words = \[c\.mode === 'coding' \? t\('Coding'\) : '', folder \? ws : ''\]\.filter\(Boolean\)\.join\(' · '\) \|\| t\('Chat settings'\);/);
  assert.doesNotMatch(app, /#cs-provider|#cs-model|csLoadModels/);
  assert.doesNotMatch(html, /id="cs-provider"|id="cs-model"/);
  assert.match(html, /title="Settings for this chat: mode, workspace, privacy, thinking and project"/);
  // The strip: no model chip, nothing there opens the server-wide model page.
  const v4 = read('web/v4.js');
  assert.doesNotMatch(v4, /modelNow|key: 'model'|openSettings\('models-routes'\)/);
  const v4ctx = app.slice(app.indexOf('initV4({'), app.indexOf('});', app.indexOf('initV4({')));
  assert.doesNotMatch(v4ctx, /\bmodel: \(\) =>/);
});
