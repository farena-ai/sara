// Phase 16: Adult mode (off by default; web-only switch with the 18+ confirmation).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-24T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }, { id: 'a', label: 'Adult', kind: 'openai-compatible', baseUrl: 'http://y' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), routes: { adult: { providerId: 'a', model: 'unfiltered' } } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, opts: { method?: string; body?: unknown; ua?: string } = {}) =>
  fetch(base + path, { method: opts.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(opts.ua ? { 'user-agent': opts.ua } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
async function turn(textIn: string) {
  const conv = app.store.createConversation();
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, conv.id, textIn)) void _;
  return app.requests.at(-1)!;
}

test('adult mode: off by default (non-explicit note, no adult route); on needs 18+ and a browser; on = today\'s behaviour', async () => {
  // Off: she's told to keep it non-explicit, and the adult model isn't used.
  let req = await turn('be sexy with me tonight');
  assert.match(String(req.messages[0].content), /Adult mode is off on this server: keep everything non-explicit/);
  assert.equal(req.model, 'm');
  assert.deepEqual(await (await call('/api/adult')).json(), { on: false, confirmedAt: null, canTurnOn: true, reason: null });

  // The phone apps can't turn it on; the 18+ confirmation is required.
  const phone = await call('/api/adult', { method: 'PUT', body: { on: true, confirm18: true }, ua: 'Mozilla/5.0 (Linux; Android 15) SaraPhone/1' });
  assert.equal(phone.status, 403);
  assert.match((await phone.json()).error, /only be turned on in a web browser/);
  assert.deepEqual(await (await call('/api/adult', { ua: 'SaraPhone/1 (iPhone)' })).json(), { on: false, confirmedAt: null, canTurnOn: false, reason: 'app' });
  // The desktop apps (not store apps) behave like a browser (ADULTAPPS): they can see and confirm it.
  assert.deepEqual(await (await call('/api/adult', { ua: 'SaraDesktop/1 (Mac)' })).json(), { on: false, confirmedAt: null, canTurnOn: true, reason: null });
  assert.equal((await call('/api/adult', { method: 'PUT', body: { on: true }, ua: 'SaraDesktop/1 (Windows)' })).status, 400, 'the 18+ box is still needed');
  assert.equal((await call('/api/adult', { method: 'PUT', body: { on: true } })).status, 400);

  // On (from a browser, confirmed): recorded, no extra note, explicit turns go to the adult route.
  const on = await (await call('/api/adult', { method: 'PUT', body: { on: true, confirm18: true }, ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140' })).json();
  assert.equal(on.on, true);
  assert.equal(app.settings.get().adultMode?.confirmedFrom, 'Chrome on Windows');
  req = await turn('be sexy with me tonight');
  assert.doesNotMatch(String(req.messages[0].content), /Adult mode is off/);
  assert.equal(req.model, 'unfiltered');
  // The minors block and other legal rules stay in the prompt either way.
  assert.match(String(req.messages[0].content), /Never produce sexual content involving minors/);

  // Turning it off works from anywhere (the apps too).
  const off = await (await call('/api/adult', { method: 'PUT', body: { on: false }, ua: 'SaraPhone/1' })).json();
  assert.equal(off.on, false);
  // From the desktop app, confirmed: on, like a browser.
  const desk = await call('/api/adult', { method: 'PUT', body: { on: true, confirm18: true }, ua: 'Mozilla/5.0 (Windows NT 10.0) Edg/155.0 SaraDesktop/1 (Windows)' });
  assert.equal(desk.status, 200);
  assert.equal((await desk.json()).on, true);
  await call('/api/adult', { method: 'PUT', body: { on: false } });
});

test('adult mode: servers set up before the switch ask once (browsers and desktop apps); the answer clears it', async () => {
  app.settings.update({ adultMode: { on: false, ask: true } });
  assert.equal((await (await call('/api/session')).json()).adultAsk, true);
  assert.equal((await (await call('/api/session', { ua: 'SaraPhone/1' })).json()).adultAsk, undefined);
  assert.equal((await (await call('/api/session', { ua: 'SaraDesktop/1 (Windows)' })).json()).adultAsk, true, 'the desktop apps ask like a browser');
  await call('/api/adult', { method: 'PUT', body: { on: false } });
  assert.equal((await (await call('/api/session')).json()).adultAsk, undefined);
});
