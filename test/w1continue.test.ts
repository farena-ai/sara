// W1.3 (docs/design/ROADMAP_W.md, docs/design/W1CONTINUE.md): continue on another device. The open
// chat, unsent draft, scroll spot and an active Talk session / live view follow the person to their
// next device for a short while; "Continue on my phone" pushes it to their phone. Per person: the
// state lives in each person's own data folder, never across household members.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { continueHereOf, DEFAULT_WITHIN_MIN, deviceKind } from '../src/continue-here.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
// Fake device ids built at run time.
const PC = ['dev', 'pc', String(Date.now() % 997)].join('-');
const PHONE = ['dev', 'phone', String(Date.now() % 991)].join('-');

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-19T15:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({ title: 'Trip to Lisbon' });
  return { app, clock, conv };
}
const later = (clock: { now: Date }, ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

test('W1.3: a spot noted on the PC is offered on the phone with the W0.6 age, the draft and the scroll spot', (t) => {
  const { app, clock, conv } = setup(t);
  const ch = continueHereOf(app);
  ch.note({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'and book the hotel near', scroll: 42, talk: false, canvas: 7 });
  later(clock, 2 * 60_000);
  const offer = ch.offer(PHONE, 'en');
  assert.ok(offer, 'the phone gets an offer');
  assert.equal(offer.conversationId, conv.id);
  assert.equal(offer.title, 'Trip to Lisbon');
  assert.equal(offer.draft, 'and book the hotel near');
  assert.equal(offer.scroll, 42);
  assert.equal(offer.canvas, 7);
  assert.equal(offer.kind, 'pc');
  assert.equal(offer.ago, '2 minutes ago');
  assert.equal(ch.offer(PHONE, 'de')?.ago, 'vor 2 Minuten');
  // The same device never gets its own spot back.
  assert.equal(ch.offer(PC, 'en'), null);
});

test('W1.3: no offer after the window, after Not now, or when this device was used more recently', (t) => {
  const { app, clock, conv } = setup(t);
  const ch = continueHereOf(app);
  ch.note({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'x' });
  later(clock, (DEFAULT_WITHIN_MIN + 1) * 60_000);
  assert.equal(ch.offer(PHONE, 'en'), null, 'too old');

  ch.note({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'y' });
  later(clock, 60_000);
  const o = ch.offer(PHONE, 'en');
  assert.ok(o);
  ch.dismiss(PHONE, o.at);
  assert.equal(ch.offer(PHONE, 'en'), null, 'Not now hides that spot');

  later(clock, 60_000);
  ch.note({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'z' });
  assert.equal(ch.offer(PHONE, 'en')?.draft, 'z', 'a newer spot is offered again');
  later(clock, 30_000);
  ch.note({ device: PHONE, kind: 'phone', conversationId: conv.id, draft: '' });
  assert.equal(ch.offer(PHONE, 'en'), null, 'the phone was used after the PC');
});

test('W1.3: switched off, an off-record space, unknown or shared chats are never noted; drafts are capped', (t) => {
  const { app, clock, conv } = setup(t);
  const ch = continueHereOf(app);
  assert.throws(() => ch.note({ device: PC, kind: 'pc', conversationId: 'nope' }), /not found/i);
  const room = app.store.createConversation({ title: 'Family room', partner: 'room-1' });
  assert.equal(ch.note({ device: PC, kind: 'pc', conversationId: room.id }), false);
  ch.note({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'a'.repeat(9000) });
  later(clock, 1000);
  assert.equal(ch.offer(PHONE, 'en')?.draft.length, 4000);
  ch.setSettings({ on: false });
  assert.equal(ch.offer(PHONE, 'en'), null, 'off: nothing offered');
  assert.equal(ch.note({ device: PC, kind: 'pc', conversationId: conv.id }), false, 'off: nothing noted');
  ch.setSettings({ on: true, withinMin: 9999 });
  assert.equal(ch.settings().withinMin, 240, 'window is capped');
  assert.equal(deviceKind('Mozilla/5.0 (Linux; Android 14) Mobile SaraPhone/1'), 'phone');
  assert.equal(deviceKind('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'tablet');
  assert.equal(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) SaraDesktop/1 (Windows)'), 'pc');
  assert.equal(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac');
});

test('W1.3: per person — another household member never sees the owner spot', (t) => {
  const owner = setup(t);
  const member = setup(t);
  continueHereOf(owner.app).note({ device: PC, kind: 'pc', conversationId: owner.conv.id, draft: 'secret plans' });
  later(member.clock, 1000);
  assert.equal(continueHereOf(member.app).offer(PHONE, 'en'), null);
  assert.ok(MEMBER_ROUTES.has('continue-here'), 'members use their own space');
});

test('W1.3: routes + Continue on my phone pushes to phones only and the Android inbox carries it', async (t) => {
  const { app, clock, conv } = setup(t);
  const sent: { title: string; body: string; url: string }[] = [];
  const events: { type: string }[] = [];
  (app as { push?: unknown }).push = {
    settings: { preview: true },
    sendPhones: async (p: { title: string; body: string; url: string }) => {
      sent.push(p);
      return { sent: 1, failed: 0, removed: 0, phones: 1 };
    },
  };
  (app as { events?: unknown }).events = { publish: (e: { type: string }) => events.push(e) };
  const auth = new OwnerAuth(app.dataDir);
  const token = String(auth.newToken);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = await fetch(`${base}/continue-here`, { method: 'PUT', headers: h, body: JSON.stringify({ device: PC, kind: 'pc', conversationId: conv.id, draft: 'pack the', scroll: 3, talk: true }) });
  assert.equal(put.status, 200);
  later(clock, 2 * 60_000);
  const got = (await (await fetch(`${base}/continue-here?device=${PHONE}&lang=en`, { headers: h })).json()) as { offer: { draft: string; talk: boolean; ago: string } | null; settings: { on: boolean } };
  assert.equal(got.offer?.draft, 'pack the');
  assert.equal(got.offer?.talk, true);
  assert.equal(got.offer?.ago, '2 minutes ago');
  assert.equal(got.settings.on, true);

  const phone = await fetch(`${base}/continue-here/phone`, { method: 'POST', headers: h, body: JSON.stringify({ device: PC, conversationId: conv.id, draft: 'pack the' }) });
  assert.equal(phone.status, 200);
  const pj = (await phone.json()) as { sent: number; phones: number };
  assert.equal(pj.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, new RegExp(`#c=${conv.id}`));
  assert.match(sent[0].body, /Trip to Lisbon/);
  assert.ok(events.some((e) => e.type === 'continue'), 'live phone app hears it');
  const inbox = (await (await fetch(`${base}/phone/inbox?after=0&pmAfter=0`, { headers: h })).json()) as { handoff?: { conversationId: string; title: string; id: string } };
  assert.equal(inbox.handoff?.conversationId, conv.id);
  assert.equal(inbox.handoff?.title, 'Trip to Lisbon');
  later(clock, 31 * 60_000);
  const old = (await (await fetch(`${base}/phone/inbox?after=0&pmAfter=0`, { headers: h })).json()) as { handoff?: unknown };
  assert.equal(old.handoff, undefined, 'an old handoff is not shown again');

  const dis = await fetch(`${base}/continue-here/dismiss`, { method: 'POST', headers: h, body: JSON.stringify({ device: PHONE, at: new Date().toISOString() }) });
  assert.equal(dis.status, 200);
  const st = await fetch(`${base}/continue-here/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ on: false, withinMin: 15 }) });
  assert.deepEqual(await st.json(), { settings: { on: false, withinMin: 15 } });
});

test('W1.3: the web card, Settings section, Android and i18n are wired', () => {
  const js = read('web/continue-here.js');
  assert.match(js, /t\('Continue where you left off on \{device\}/);
  assert.match(js, /t\('Continue on my phone'\)/);
  assert.match(js, /\/continue-here/);
  const html = read('web/index.html');
  for (const id of ['cnt-on', 'cnt-within', 'cnt-phone']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(read('web/app.js'), /initContinueHere\(/);
  assert.match(read('android/app/src/main/java/com/backstagecoding/sara/InboxJob.java'), /handoff/);
  assert.match(read('android/app/src/main/java/com/backstagecoding/sara/LiveInbox.java'), /"continue"/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = read(`web/i18n/${lang}.json`);
    assert.match(tr, /"Continue where you left off on \{device\}"/, lang);
    assert.match(tr, /"Continue on my phone"/, lang);
  }
});
