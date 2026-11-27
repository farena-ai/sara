// T54: the companion side, off and on again (src/companion-switch.ts). Off is a plain work
// assistant: no personality, life, moods, relationship, adult mode or messages of her own; every
// tool and her memory stay; on again brings back exactly what was there.
// Also here: the settings route gives and takes the two new settings. 3.47.0 shipped "Check facts
// before she answers" with a control that did not save, because the route lists its fields.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OwnerAuth } from '../src/auth.ts';
import { innerEnabled, runTurn } from '../src/chat.ts';
import { COMPANION_TOOLS, companionOff, installCompanionSwitch, plainSheet } from '../src/companion-switch.ts';
import { proactiveSettings } from '../src/life.ts';
import { buildSystemPrompt, PLAIN } from '../src/persona.ts';
import type { ChatRequest, Provider, ProviderConfig } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { adultModeOn } from '../src/settings.ts';
import { makeApp, tempDir, text, type TestApp } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}
const CTX = { now: new Date('2026-11-27T12:00:00Z'), timeZone: 'UTC', ownerName: 'Alex', tools: ['read_file', 'web_search', 'recall'], inner: 'You feel playful.', day: 'You went for a run.', threads: 'Learning the synth.', closeness: 80, adultOn: true, stayYourself: 'too generic' };

test('T54: her instructions with the companion side off are a plain assistant, with safety intact', (t) => {
  const { app } = setup(t);
  const on = buildSystemPrompt(app.persona, CTX as never);
  assert.match(on, /## Personality/);
  assert.match(on, /## Staying in character/);
  assert.match(on, /## How you feel/);
  const off = buildSystemPrompt(plainSheet(app.persona), CTX as never);
  assert.match(off, /^You are Sara, an AI assistant\. You work for Alex/);
  for (const gone of ['## Who you are', '## Your life', '## Personality', '## Staying in character', '## How you feel', '## Your day', "## What you're into lately", '## Be yourself', 'Live fully as', 'in character ("give me a sec', 'lake town']) assert.equal(off.includes(gone), false, `still there: ${gone}`);
  assert.match(off, /No small talk, no feelings or moods/);
  assert.match(off, /You are an AI, not a person/);
  // What must stay: the hard boundaries, the danger rule, tools, facts, memory.
  assert.match(off, /## Boundaries/);
  assert.match(off, /Never produce sexual content involving minors/);
  assert.match(off, /## If Alex is in danger/);
  assert.match(off, /## What you can do/);
  assert.match(off, /## Getting facts right/);
  assert.match(off, /## What you remember from before/);
  // The explicit flag does the same as the mark on the sheet.
  assert.equal(buildSystemPrompt(app.persona, { ...CTX, plain: true } as never), off);
});

test('T54: the switch reaches everything that reads app.persona, and never ends up in the saved character', (t) => {
  const { app } = setup(t);
  installCompanionSwitch(app);
  const name = app.persona.name;
  assert.equal(PLAIN in (app.persona as object), false);
  app.settings.update({ companion: { on: false } });
  assert.equal(companionOff(app.settings.get()), true);
  assert.equal((app.persona as unknown as Record<symbol, unknown>)[PLAIN], true);
  assert.equal(app.persona.name, name, 'her name stays');
  assert.equal(JSON.stringify(app.persona).includes('plain'), false, 'nothing of the mark is written to disk');
  // An edit made while it is off (the routes assign a new sheet built from the current one) keeps no mark.
  app.persona = { ...app.persona, age: 31 };
  app.settings.update({ companion: { on: true } });
  assert.equal(PLAIN in (app.persona as object), false);
  assert.equal(app.persona.age, 31);
  assert.match(buildSystemPrompt(app.persona, CTX as never), /## Personality/, 'on again: as she was');
});

test('T54: off also means no mood, nothing sent first, no adult mode and no companion tools', (t) => {
  const { app } = setup(t);
  app.settings.update({ adultMode: { on: true, confirmedAt: '2026-11-01T00:00:00Z' }, proactive: { enabled: true } } as never);
  assert.equal(innerEnabled(app), true);
  assert.equal(proactiveSettings(app).enabled, true);
  assert.equal(adultModeOn(app.settings.get()), true);
  app.settings.update({ companion: { on: false } });
  assert.equal(innerEnabled(app), false);
  assert.equal(proactiveSettings(app).enabled, false);
  assert.equal(adultModeOn(app.settings.get()), false);
  assert.equal(app.settings.get().adultMode?.on, true, "the owner's own choices are kept for when it is on again");
  assert.equal(app.settings.get().proactive?.enabled, true);
  assert.deepEqual([...COMPANION_TOOLS].sort(), ['change_outfit', 'moments', 'take_photo']);
  app.settings.update({ companion: { on: true } });
  assert.equal(innerEnabled(app), true);
  assert.equal(adultModeOn(app.settings.get()), true);
});

test('T54: a turn with the switch off sends the plain instructions to the model', async (t) => {
  const { app } = setup(t);
  installCompanionSwitch(app);
  const seen: string[] = [];
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest) {
      seen.push(req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'));
      yield* text('Done.');
    },
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', companion: { on: false } });
  const conv = app.store.createConversation({ title: 'x' });
  for await (const _ of runTurn(app, conv.id, 'Rename the config file')) void _;
  assert.match(seen.at(-1)!, /You are Sara, an AI assistant/);
  assert.equal(seen.at(-1)!.includes('## Personality'), false);
  assert.equal(seen.at(-1)!.includes('## How you feel'), false);
  app.settings.update({ companion: { on: true } });
  for await (const _ of runTurn(app, conv.id, 'Thanks')) void _;
  assert.match(seen.at(-1)!, /## Personality/);
});

test('T54: the settings route gives and takes the companion switch and "Check facts before she answers"', async (t) => {
  const { app, dir } = setup(t);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex' });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '3.48.0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  let s = (await call('/api/settings', 'GET')).json;
  assert.equal(s.lookFirst, 'auto');
  assert.deepEqual(s.companion, { on: true });
  assert.equal((await call('/api/setup', 'GET')).json.companionOff, false);
  await call('/api/settings', 'PUT', { lookFirst: 'offer', companion: { on: false } });
  s = (await call('/api/settings', 'GET')).json;
  assert.equal(s.lookFirst, 'offer');
  assert.deepEqual(s.companion, { on: false });
  assert.equal(app.settings.get().lookFirst, 'offer');
  assert.equal((await call('/api/setup', 'GET')).json.companionOff, true);
  assert.equal((await call('/api/settings', 'PUT', { lookFirst: 'sometimes' })).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { companion: { on: 'no' } })).status, 400);
  await call('/api/settings', 'PUT', { companion: { on: true }, lookFirst: 'off' });
  s = (await call('/api/settings', 'GET')).json;
  assert.deepEqual(s.companion, { on: true });
  assert.equal(s.lookFirst, 'off');
});
