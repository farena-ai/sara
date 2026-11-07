// E7 (B2s, B3): pictures she sends on her own: off by default, her own-message rules (quiet hours,
// daily limit, never after an unanswered one), one a day, monthly limit, only the owner's own chat,
// minors/adult rules, and a message only with a real picture attached.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { LifeWorker } from '../src/life.ts';
import { maybeOwnPhoto, monthlyEstimate } from '../src/own-photos.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const NOON = new Date('2026-11-07T18:00:00Z'); // Saturday noon in Chicago

function setup(t: { after: (fn: () => void) => void }, o: { attach?: boolean; own?: Record<string, unknown> } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(NOON.getTime() - 3 * 3_600_000) };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), photos: { mode: 'new', own: { on: true, ...o.own } } });
  const scenes: string[] = [];
  const take: Tool = {
    defaultPermission: 'ask',
    source: 'built-in',
    spec: { name: 'take_photo', description: '', parameters: { type: 'object' } },
    summarize: () => '',
    run: async (a, ctx) => {
      scenes.push(String(a.scene));
      if (o.attach !== false) ctx.attachImage?.(app.uploads!.save(PNG).id);
      return 'ok';
    },
  };
  app.tools.add(take);
  const conv = app.store.createConversation({ channel: 'web' });
  app.store.addMessage(conv.id, 'user', 'off to the farmers market, talk later');
  app.store.addMessage(conv.id, 'assistant', 'Have fun!');
  clock.now = NOON;
  const say = (scene: string, caption: string) => app.script.push(text(`SCENE: ${scene}\nCAPTION: ${caption}`));
  return { app, clock, conv, scenes, say, take };
}
const go = (app: TestApp, force = false) => maybeOwnPhoto(app, { random: () => 0, force });

test('E7 B2s: off by default; switched on she sends one picture with its caption, counted as one of her messages', async (t) => {
  const s = setup(t, { own: { on: false } });
  assert.equal((await go(s.app)).skipped, 'off');
  s.app.settings.update({ photos: { mode: 'new', own: { on: true } } });
  s.say('selfie at the farmers market holding a bag of apples, cozy green sweater', 'Look what I found 🍎');
  const r = await go(s.app);
  assert.equal(r.sent?.caption, 'Look what I found 🍎');
  assert.deepEqual(s.scenes, ['selfie at the farmers market holding a bag of apples, cozy green sweater']);
  const m = s.app.store.messages(s.conv.id).at(-1)!;
  assert.equal(m.role, 'assistant');
  assert.equal((m.meta?.images as string[]).length, 1);
  assert.deepEqual(m.meta?.proactive, { reason: 'picture' });
  assert.equal(s.app.inner!.get(s.clock.now).proactiveCount, 1, 'counts toward her daily own-message limit');
  assert.match(String(s.app.requests.at(-1)!.messages.at(-1)!.content), /send Alex a picture of yourself.*Keep it non-explicit/s);
  // The same day: never a second one (and her picture is unanswered anyway).
  s.app.store.addMessage(s.conv.id, 'user', 'cute!');
  assert.equal((await go(s.app)).skipped, 'one a day');
});

test('E7 B2s: quiet hours, the daily limit, the pace and the random wait', async (t) => {
  const s = setup(t, { own: { often: 'rarely' } });
  s.clock.now = new Date('2026-11-07T05:00:00Z'); // 23:00 in Chicago
  assert.equal((await go(s.app)).skipped, 'quiet hours');
  s.clock.now = NOON;
  s.app.inner!.save({ ...s.app.inner!.get(NOON), proactiveDay: '2026-11-07', proactiveCount: 2 });
  assert.equal((await go(s.app)).skipped, 'daily limit');
  s.app.inner!.save({ ...s.app.inner!.get(NOON), proactiveCount: 0 });
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, often: 'rarely', sent: ['2026-11-04T18:00:00.000Z'] } } });
  assert.equal((await go(s.app)).skipped, 'not yet', 'rarely: about a week between pictures');
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, often: 'often', sent: ['2026-11-06T18:00:00.000Z'] } } });
  assert.equal((await maybeOwnPhoto(s.app, { random: () => 0.9 })).skipped, 'not this time');
  s.app.settings.update({ proactive: { enabled: false, maxPerDay: 2, quietStart: 22, quietEnd: 9, minGapHours: 6 } });
  assert.equal((await go(s.app)).skipped, 'her messages off');
});

test('E7 B2s: skipped after an ignored own message, or when the owner has been away for 7 days', async (t) => {
  const s = setup(t);
  s.app.store.addMessage(s.conv.id, 'assistant', 'Thinking of you!', { proactive: { reason: 'x' } });
  assert.equal((await go(s.app)).skipped, 'unanswered');
  s.app.store.addMessage(s.conv.id, 'user', 'hey');
  s.clock.now = new Date(NOON.getTime() + 8 * 86_400_000);
  assert.equal((await go(s.app)).skipped, 'owner away');
});

test('E7 B2s: only the owner\'s own chat in the app: not a bot channel, a private chat, a member or the demo', async (t) => {
  const s2 = setup(t);
  s2.app.store.deleteConversation(s2.conv.id);
  const tg = s2.app.store.createConversation({ channel: 'telegram', channelKey: '-100123' });
  s2.app.store.addMessage(tg.id, 'user', 'hi');
  s2.app.store.createConversation({ channel: 'web', private: true });
  assert.equal((await go(s2.app)).skipped, 'no chat');
  const s3 = setup(t);
  s3.app.member = { limits: () => ({ pictures: true }) } as never;
  assert.equal((await go(s3.app)).skipped, 'not here');
  s3.app.member = undefined;
  s3.app.demo = true;
  assert.equal((await go(s3.app)).skipped, 'not here');
});

test('E7 B2s: never minors; explicit only with Adult mode; nothing is claimed without a real picture', async (t) => {
  const s = setup(t);
  s.say('at the beach with a toddler on my lap', 'Beach day!');
  s.say('a sexy little schoolgirl outfit', 'For you');
  for (let i = 0; i < 2; i++) assert.equal((await go(s.app)).skipped, 'failed checks');
  s.say('lying in bed, naked under the sheets', 'Miss you');
  assert.equal((await go(s.app)).skipped, 'failed checks', 'adult mode off: non-explicit only');
  assert.equal(s.scenes.length, 0, 'nothing reached the picture engine');
  s.say('a cozy reading nook with tea', "I've emailed your boss the report.");
  assert.equal((await go(s.app)).skipped, 'failed checks', 'no unbacked action claims in the caption');
  s.app.settings.update({ adultMode: { on: true, confirmedAt: NOON.toISOString() } });
  s.say('lying in bed, naked under the sheets', 'Miss you');
  assert.ok((await go(s.app)).sent, 'with Adult mode on in her own chat');
  const n = setup(t, { attach: false });
  n.say('walking in the park', 'Nice day out');
  assert.equal((await go(n.app)).skipped, 'no picture');
  assert.equal(n.app.store.messages(n.conv.id).length, 2, 'no message without the picture');
});

test('E7 B2s: the monthly limit holds even for Send one now; Send one now ignores quiet hours', async (t) => {
  const s = setup(t, { own: { monthlyCap: 1 } });
  s.clock.now = new Date('2026-11-07T05:00:00Z');
  s.say('stretching on a yoga mat at home', 'Late stretch');
  assert.ok((await go(s.app, true)).sent);
  s.clock.now = new Date('2026-11-09T18:00:00Z');
  assert.equal((await go(s.app, true)).skipped, 'monthly limit');
  assert.equal(monthlyEstimate('openai', { often: 'rarely', monthlyCap: 8 }).pictures, 4);
  assert.equal(monthlyEstimate('openai', { often: 'often', monthlyCap: 8 }).dollars, 0.32);
  assert.equal(monthlyEstimate('grok', { often: 'often', monthlyCap: 8 }, true).dollars, 0);
  assert.equal(monthlyEstimate('tool', { often: 'often', monthlyCap: 8 }).dollars, undefined);
});

test('E7 B2s: her life tick tries a picture when she sent no message', async (t) => {
  const s = setup(t);
  s.app.script.push(text('Slept in, then a long walk by the river and coffee with Maya after. Baking bread later.'));
  s.say('baking bread, flour on my hands', 'Bread day');
  // Her message waits (he wrote 3 hours ago); the picture's own chance comes up.
  const life = new LifeWorker(s.app, s.app.life!, s.app.inner!, () => 0);
  const r = (await life.tick()) as { picture?: string };
  assert.equal(r.picture, 'Bread day');
});

test('E7 B3: /api/photos keeps the engine and own-picture settings and Send one now answers', async (t) => {
  const s = setup(t);
  const auth = new OwnerAuth(s.app.dataDir!, () => s.clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app: s.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const wf = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }, '9': { class_type: 'SaveImage', inputs: {} } };
  let r = await call('/photos', 'PUT', { engine: 'comfyui', comfy: { server: 'comfyui', workflow: JSON.stringify(wf), seed: true }, own: { on: true, often: 'sometimes', monthlyCap: 12 } });
  assert.equal(r.status, 200);
  const v = (await r.json()) as { engine: string; comfy: { node: string; nodes: unknown[]; seed: boolean }; own: { on: boolean; often: string; monthlyCap: number }; estimate: { pictures: number; dollars: number } };
  assert.equal(v.engine, 'comfyui');
  assert.equal(v.comfy.node, '6');
  assert.equal(v.comfy.seed, true);
  assert.deepEqual([v.own.on, v.own.often, v.own.monthlyCap], [true, 'sometimes', 12]);
  assert.deepEqual(v.estimate, { pictures: 11, dollars: 0 });
  assert.equal((await call('/photos', 'PUT', { comfy: { workflow: '{"nodes":[],"links":[]}' } })).status, 400);
  assert.equal((await call('/photos', 'PUT', { engine: 'dalle' })).status, 400);
  s.app.settings.update({ photos: { ...s.app.settings.get().photos!, engine: 'grok' } });
  s.say('a sunny window seat with a book', 'Reading break');
  r = await call('/photos/own/test', 'POST', {});
  assert.equal(((await r.json()) as { sent?: { caption: string } }).sent?.caption, 'Reading break');
});
