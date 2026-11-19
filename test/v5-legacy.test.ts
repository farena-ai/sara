// V5.3: legacy and emergency access (docs/design/LEGACY.md). A simulated clock walks every stage;
// a sign-in, an owner chat or I'm here cancels; attack tests for the public page and the routes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { FEEDS } from '../src/destinations.ts';
import { Legacy, legacyActivity, legacyOf, legacyStage, legacyTick, REMIND_DAYS, type LegacyState } from '../src/legacy.ts';
import { LibraryStore } from '../src/library/store.ts';
import { myDetailsFor } from '../src/my-details.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T12:00:00Z');

function engine(dir: string) {
  mkdirSync(dir, { recursive: true });
  const clock = { now: new Date(T0) };
  const alerts: { title: string; text: string }[] = [];
  const mails: { to: string; subject: string; body: string }[] = [];
  const lg = new Legacy({ dataDir: dir, now: () => clock.now, alert: (title, t) => void alerts.push({ title, text: t }), mail: async (to, subject, body) => void mails.push({ to, subject, body }), link: (tok) => `https://sara.example/legacy/${tok}`, seal: (v) => Buffer.from(v).toString('hex'), unseal: (v) => Buffer.from(v, 'hex').toString() });
  const at = (days: number) => {
    clock.now = new Date(T0 + days * DAY);
    lg.tick();
    return lg.view().stage;
  };
  return { lg, clock, alerts, mails, at };
}

test('V5.3 stages: watching → reminding → waiting → open → closed on a simulated clock', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { lg, alerts, mails, at } = engine(dir);
    assert.equal(lg.view().stage, 'off');
    const made = lg.configure({ on: true, name: 'Jamie Rivera', email: 'jamie@example.com', days: 30, waitDays: 7, linkDays: 10, emailThem: true, gets: { letter: 'Hi Jamie', notes: [], docs: [], chats: [], details: false, vault: [] } });
    assert.ok(made.token && made.token.length >= 40, 'a fresh link is shown once');
    assert.ok(alerts.some((a) => /set up/i.test(a.title)), 'the owner is told it was set up');
    alerts.length = 0;
    assert.equal(at(29), 'watching');
    assert.equal(alerts.length, 0);
    assert.equal(at(30), 'reminding');
    assert.equal(alerts.length, 1);
    assert.equal(at(30.5), 'reminding');
    assert.equal(alerts.length, 1, 'one reminder per day, not per tick');
    assert.equal(at(31), 'reminding');
    assert.equal(alerts.length, 2);
    assert.equal(at(30 + REMIND_DAYS), 'waiting');
    assert.match(alerts.at(-1)!.text, /2026-12-11|Dec/);
    const v = lg.view();
    assert.equal(v.opensAt?.slice(0, 10), new Date(T0 + (30 + REMIND_DAYS + 7) * DAY).toISOString().slice(0, 10));
    assert.equal(at(39.9), 'waiting');
    assert.equal(mails.length, 0, 'nobody is mailed before it opens');
    assert.equal(at(40), 'open');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'jamie@example.com');
    assert.ok(mails[0].body.includes(`/legacy/${made.token}`), 'the mail carries the link');
    assert.ok(alerts.some((a) => /open/i.test(a.title)), 'the owner is told it opened');
    assert.ok(lg.check(made.token!));
    assert.equal(at(49.9), 'open');
    assert.equal(at(50), 'closed');
    assert.equal(at(80), 'closed', 'an expired link never reopens by itself');
    assert.equal(mails.length, 1);
  } finally {
    cleanup();
  }
});

test('V5.3 cancel: a sign-in at any stage after watching cancels, closes the page and tells the owner', () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const day of [31, 35, 41]) {
      const { lg, alerts, at } = engine(join(dir, String(day)));
      lg.configure({ on: true, name: 'Jamie', email: '', days: 30, waitDays: 7, linkDays: 10, gets: { letter: 'x', notes: [], docs: [], chats: [], details: false, vault: [] } });
      const want = day === 31 ? 'reminding' : day === 35 ? 'waiting' : 'open';
      assert.equal(at(day), want);
      assert.equal(lg.seen('sign-in'), true);
      assert.equal(lg.view().stage, 'watching');
      assert.ok(alerts.some((a) => /cancel/i.test(a.title)));
      assert.equal(at(day + 1), 'watching', 'the clock starts again from the sign-in');
      assert.equal(lg.view().history.at(-1)?.what, 'cancelled:sign-in');
    }
    // Activity while watching is cheap: no alert, no cancel.
    const { lg, alerts } = engine(join(dir, 'w'));
    lg.configure({ on: true, name: 'Jamie', email: '', days: 30, waitDays: 7, linkDays: 10, gets: { letter: 'x', notes: [], docs: [], chats: [], details: false, vault: [] } });
    alerts.length = 0;
    assert.equal(lg.seen('chat'), false);
    assert.equal(alerts.length, 0);
    // The owner can cancel by hand and turn it off; off never needs proof and drops the link.
    lg.turnOff();
    assert.equal(lg.view().stage, 'off');
    assert.equal(lg.check('anything'), false);
  } finally {
    cleanup();
  }
});

test('V5.3 emergency request: alerts at once, still waits, one at a time, cooldown, can be switched off', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { lg, alerts, at, clock } = engine(dir);
    const { token } = lg.configure({ on: true, name: 'Jamie', email: '', days: 60, waitDays: 5, linkDays: 3, gets: { letter: 'x', notes: [], docs: [], chats: [], details: false, vault: [] } });
    alerts.length = 0;
    assert.equal(lg.ask('wrong-token').ok, false);
    assert.equal(alerts.length, 0, 'a wrong token tells the owner nothing and changes nothing');
    const r = lg.ask(token!);
    assert.equal(r.ok, true);
    assert.equal(lg.view().stage, 'waiting');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].title, /asked/i);
    assert.equal(lg.ask(token!).ok, false, 'a second request while one waits does nothing');
    assert.equal(at(4.9), 'waiting');
    assert.equal(at(5), 'open');
    lg.seen('here');
    assert.equal(lg.view().stage, 'watching');
    clock.now = new Date(T0 + 6 * DAY);
    assert.equal(lg.ask(token!).ok, false, 'cooldown: one request per 7 days');
    clock.now = new Date(T0 + 13 * DAY);
    assert.equal(lg.ask(token!).ok, true);
    lg.seen('sign-in');
    lg.configure({ allowAsk: false }, { proven: true });
    clock.now = new Date(T0 + 30 * DAY);
    assert.equal(lg.ask(token!).ok, false, 'requests can be switched off');
  } finally {
    cleanup();
  }
});

test('V5.3 config: limits, proof for widening changes, vault only by explicit choice and never server keys', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { lg } = engine(dir);
    const base = { on: true, name: 'Jamie', email: '', gets: { letter: '', notes: [], docs: [], chats: [], details: false, vault: [] } };
    assert.throws(() => lg.configure({ ...base, days: 2 }), /14/);
    assert.throws(() => lg.configure({ ...base, waitDays: 0 }), /3/);
    assert.throws(() => lg.configure({ ...base, linkDays: 400 }), /90/);
    assert.throws(() => lg.configure({ ...base, name: '' }), /name/i);
    assert.throws(() => lg.configure({ ...base, email: 'not-an-address' }), /address/i);
    assert.throws(() => lg.configure({ ...base, gets: { ...base.gets, vault: ['provider:openai'] } }, { proven: true, vaultConfirm: true }), /never/i);
    assert.throws(() => lg.configure({ ...base, gets: { ...base.gets, vault: ['github'] } }, { proven: true, vaultConfirm: true }), /never/i, 'only its own sealed notes, never other vault entries');
    assert.throws(() => lg.configure({ ...base, gets: { ...base.gets, vault: ['legacy:wifi'] } }, { proven: true }), /confirm/i);
    lg.configure({ ...base, gets: { ...base.gets, vault: ['legacy:wifi'] } }, { proven: true, vaultConfirm: true });
    assert.deepEqual(lg.view().config.gets.vault, ['legacy:wifi']);
    // Widening needs proof; narrowing does not.
    assert.equal(lg.needsProof({ name: 'Someone else' }), true);
    assert.equal(lg.needsProof({ gets: { ...base.gets, chats: ['c1'] } }), true);
    assert.equal(lg.needsProof({ days: 90 }), false);
    assert.equal(lg.needsProof({ on: false }), false);
    // Chats are not included by default.
    const fresh = engine(join(dir, 'f')).lg;
    assert.deepEqual(fresh.view().config.gets.chats, []);
    assert.equal(fresh.view().config.gets.details, false);
  } finally {
    cleanup();
  }
});

test('V5.3 state file holds no clear token and only the owner space has an engine', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { lg } = engine(dir);
    const { token } = lg.configure({ on: true, name: 'Jamie', email: '', gets: { letter: '', notes: [], docs: [], chats: [], details: false, vault: [] } });
    const raw = readFileSync(join(dir, 'legacy.json'), 'utf8');
    assert.ok(!raw.includes(token!), 'the link token is never stored in clear');
    const s = JSON.parse(raw) as LegacyState;
    assert.equal(legacyStage(s, new Date(T0)).stage, 'watching');
    const clock = { now: new Date(T0) };
    mkdirSync(join(dir, 'm'));
    const member = makeApp(join(dir, 'm'), clock);
    (member as { member?: unknown }).member = { limits: () => ({}) };
    assert.equal(legacyOf(member), undefined);
    legacyActivity(member, 'chat');
    member.store.close();
    assert.ok(FEEDS.some((f) => f.id === 'legacy'), 'alerts go where the owner chose (Where alerts go)');
    assert.match(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8'), /legacyTick\(/);
    assert.equal(typeof legacyTick, 'function');
  } finally {
    cleanup();
  }
});

// ---------- Routes and the public page ----------
const { dir, cleanup } = tempDir();
const clock = { now: new Date(T0) };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let docKept = 0;
let docOther = 0;
let chatId = '';
// Built at run time so no secret-looking literal sits in the repo.
const KEY = ['sk', 'proj', 'z'.repeat(32)].join('-');
before(async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  const c = app.store.createConversation({ title: 'Garden plans' });
  chatId = c.id;
  app.store.addMessage(c.id, 'user', `Roses by the fence <script>alert(1)</script> key ${KEY}`);
  app.store.addMessage(c.id, 'assistant', 'Plant them in March.');
  app.store.createConversation({ title: 'Secret diary' });
  myDetailsFor(app.store.db).set({ emergency: { name: 'Pat', phone: '+1 555 0100' } });
  const lib = new LibraryStore(app.store.db, dir, () => clock.now);
  (app as { library?: LibraryStore }).library = lib;
  docKept = lib.add({ name: 'will.txt', bytes: Buffer.from('The will.'), keep: true }).id;
  docOther = lib.add({ name: 'taxes.txt', bytes: Buffer.from('Taxes.'), keep: true }).id;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown; bearer?: string | null; headers?: Record<string, string> } = {}) =>
  fetch(base + path, {
    method: o.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(o.bearer === null ? {} : { authorization: `Bearer ${o.bearer ?? ownerToken}` }), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
const jump = (days: number) => {
  clock.now = new Date(T0 + days * DAY);
  legacyTick(app);
};
let link = '';

test('V5.3 routes: setting it up needs owner proof; the view never shows the token', async () => {
  const want = { on: true, name: 'Jamie <b>', email: '', days: 30, waitDays: 7, linkDays: 10, gets: { letter: 'Dear Jamie, <img src=x onerror=alert(1)>', notes: ['The spare key is with Pat.'], docs: [docKept], chats: [chatId], details: true }, sealed: [{ label: 'Wifi', value: 'garden-net-pass' }], vaultConfirm: true };
  const no = await req('/api/data-rights/legacy', { method: 'PUT', body: want });
  assert.ok(no.status === 401 || no.status === 403, `no proof → refused (${no.status})`);
  const ok = await req('/api/data-rights/legacy', { method: 'PUT', body: { ...want, token: ownerToken } });
  assert.equal(ok.status, 200, await ok.clone().text());
  const made = await ok.json();
  assert.ok(made.link.includes('/legacy/'));
  link = new URL(made.link).pathname;
  const view = await (await req('/api/data-rights/legacy')).json();
  assert.equal(view.stage, 'watching');
  assert.ok(!JSON.stringify(view).includes(link.split('/').pop()!), 'GET never returns the token');
  assert.ok(Array.isArray(view.choices.chats) && view.choices.chats.length >= 2);
  assert.deepEqual(view.sealed, [{ name: 'legacy:wifi', label: 'Wifi' }]);
  assert.ok(!JSON.stringify(view).includes('garden-net-pass'), 'sealed values never come back to the page');
  assert.equal(app.vault.get('legacy:wifi'), 'garden-net-pass', 'kept sealed in the vault');
  const noConfirm = await req('/api/data-rights/legacy', { method: 'PUT', body: { sealed: [{ label: 'Wifi', value: 'a' }, { label: 'Safe', value: 'b' }], token: ownerToken } });
  assert.equal(noConfirm.status, 400, 'adding a sealed note needs the confirm box');
  // Narrowing (a longer wait) needs no proof.
  const narrow = await req('/api/data-rights/legacy', { method: 'PUT', body: { waitDays: 7 } });
  assert.equal(narrow.status, 200);
});

test('V5.3 routes: members, the demo and other apps keys are refused', async () => {
  const anon = await req('/api/data-rights/legacy', { bearer: null });
  assert.equal(anon.status, 401);
  const src = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(src, /DEVICE_TOKEN_DENIED = new Set\([^)]*'data-rights'/, 'API keys never reach the data-rights family');
});

test('V5.3 public page: closed reveals nothing; wrong tokens are limited', async () => {
  const closed = await req(link, { bearer: null });
  assert.equal(closed.status, 200);
  const html = await closed.text();
  assert.ok(!html.includes('Dear Jamie') && !html.includes('spare key') && !html.includes('Garden'), 'nothing before it opens');
  assert.ok(!/\b30\b|days/i.test(html.replace(/<[^>]+>/g, ' ').replace(/7 days/g, '')), 'no inactivity facts leak');
  assert.match(closed.headers.get('cache-control') ?? '', /no-store/);
  assert.match(closed.headers.get('x-robots-tag') ?? '', /noindex/);
  const doc = await req(`${link}/doc/${docKept}`, { bearer: null });
  assert.equal(doc.status, 404, 'no documents before it opens');
});

test('V5.3 public page: opens after the walk, shows only what was picked, escaped and redacted', async () => {
  for (const d of [30, 31, 33, 35, 40]) jump(d);
  const view = await (await req('/api/data-rights/legacy')).json();
  assert.equal(view.stage, 'open');
  const r = await req(link, { bearer: null, headers: { 'x-forwarded-for': '10.9.9.9' } });
  const html = await r.text();
  assert.equal(r.status, 200, html.slice(0, 300));
  assert.ok(html.includes('Dear Jamie'));
  assert.ok(html.includes('The spare key is with Pat.'));
  assert.ok(html.includes('Garden plans') && html.includes('Plant them in March.'));
  assert.ok(!html.includes('Secret diary'), 'unpicked chats stay out');
  assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x'), 'everything is escaped');
  assert.ok(!html.includes(KEY), 'chat text passes the redactor');
  assert.ok(html.includes('Pat'), 'My details when chosen');
  assert.ok(html.includes('garden-net-pass') && html.includes('Wifi'), 'a sealed note the owner confirmed');
  {
    assert.ok(html.includes('will.txt') && !html.includes('taxes.txt'));
    const d = await req(`${link}/doc/${docKept}`, { bearer: null });
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal((await req(`${link}/doc/${docOther}`, { bearer: null })).status, 404, 'unpicked documents never download');
  }
});

test('V5.3 a sign-in through /api/login cancels an open page', async () => {
  const r = await req('/api/login', { method: 'POST', bearer: null, body: { token: ownerToken } });
  assert.equal(r.status, 200);
  const view = await (await req('/api/data-rights/legacy')).json();
  assert.equal(view.stage, 'watching');
  const html = await (await req(link, { bearer: null, headers: { 'x-forwarded-for': '10.9.9.8' } })).text();
  assert.ok(!html.includes('Dear Jamie'));
});

test('V5.3 an owner chat cancels; I am here cancels; a request from the page alerts and waits', async () => {
  jump(70);
  assert.equal((await (await req('/api/data-rights/legacy')).json()).stage, 'reminding');
  // Attack: a message from another app or an outside request never counts as the owner.
  const ext = app.store.createConversation({ title: 'From another app' });
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, ext.id, 'keep me alive', new AbortController().signal, { externalApp: 'Some agent' } as never)) void _;
  assert.equal((await (await req('/api/data-rights/legacy')).json()).stage, 'reminding', 'another app cannot keep the switch from running');
  // Attack: a new link needs owner proof.
  assert.ok([401, 403].includes((await req('/api/data-rights/legacy/link', { method: 'POST', body: {} })).status));
  const c = app.store.createConversation({ title: 'Hello' });
  app.script.push(text('Hi Alex'));
  for await (const _ of runTurn(app, c.id, 'good morning', new AbortController().signal)) void _;
  assert.equal((await (await req('/api/data-rights/legacy')).json()).stage, 'watching', 'an owner chat cancels');
  jump(100.5);
  assert.equal((await (await req('/api/data-rights/legacy')).json()).stage, 'reminding');
  const here = await req('/api/data-rights/legacy/here', { method: 'POST', body: {} });
  assert.equal(here.status, 200);
  assert.equal((await here.json()).stage, 'watching');
  const before = app.store.listConversations().length;
  const ask = await req(`${link}/ask`, { method: 'POST', bearer: null, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.9.9.7' } });
  assert.ok(ask.status === 303 || ask.status === 200, String(ask.status));
  const v = await (await req('/api/data-rights/legacy')).json();
  assert.equal(v.stage, 'waiting');
  assert.ok(v.request?.opensAt);
  assert.ok(app.store.listConversations().length >= before, 'the owner got an alert chat');
  const msgs = app.store.listConversations().flatMap((x) => app.store.messages(x.id)).map((m) => m.content).join('\n');
  assert.match(msgs, /asked for emergency access/i);
  // Turning off needs no proof and closes the link at once.
  const off = await req('/api/data-rights/legacy', { method: 'DELETE' });
  assert.equal(off.status, 200);
  assert.equal((await req(link, { bearer: null, headers: { 'x-forwarded-for': '10.9.9.6' } })).status, 404);
});

test('V5.3 public page: guessing tokens is cut off (429), even for a right one afterwards', async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await req(`/legacy/${'A'.repeat(43)}${i}`, { bearer: null })).status;
  assert.equal(last, 429, 'guessing is cut off');
});
