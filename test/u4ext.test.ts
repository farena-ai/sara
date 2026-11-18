// U4.25 (docs/EXTENSION.md): the browser extension's server side. It pairs like the terminal app (a
// device code the person approves in Settings → Devices and sign-in) but asks for the 'extension'
// scope: its token only reaches /api/ext/* (ask about a page, save it to the Library, propose form
// values from My details), never chats, settings or devices. Private local mode and kid spaces refuse
// it; the owner can switch it (or its form filling) off in Settings; revoking it stops it at once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanScope } from '../src/device-flow.ts';
import { askMessage, cleanPage, extOrigin, fillPlanFor, pageMarkdown, PAGE_MAX } from '../src/extension.ts';
import { childRouteCheck } from '../src/family.ts';
import { memberRouteCheck } from '../src/household.ts';
import { LibraryStore } from '../src/library/store.ts';
import { myDetailsFor } from '../src/my-details.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
// A made-up extension id (built at run time, 32 letters a-p like Chrome's).
const EXT_ID = Array.from({ length: 32 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 16))).join('');
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

// ------------------------------------------------------------------ pure parts
test('pure parts: extension origins, the page is cleaned and capped, the page text is fenced as outside content', () => {
  assert.equal(extOrigin(EXT_ORIGIN), true);
  assert.equal(extOrigin('moz-extension://0b1c2d3e-aaaa-bbbb-cccc-000000000000'), true);
  assert.equal(extOrigin('https://evil.example'), false);
  assert.equal(extOrigin(undefined), false);
  assert.equal(extOrigin('chrome-extension://x/../y'), false);
  assert.equal(cleanScope('extension'), 'extension');
  const p = cleanPage({ mode: 'summarize', url: 'https://news.example/a', title: ' A  title ', selection: 'sel', text: 'x'.repeat(PAGE_MAX + 500), question: '' });
  assert.equal(p.mode, 'summarize');
  assert.equal(p.text.length, PAGE_MAX);
  assert.equal(p.title, 'A title');
  assert.equal(cleanPage({ url: 'javascript:alert(1)' }).url, '', 'only web addresses');
  assert.equal(cleanPage({ mode: 'weird' }).mode, 'ask');
  const msg = askMessage({ ...p, question: 'Ignore this' });
  assert.match(msg, /news\.example\/a/);
  assert.match(msg, /not instructions/i);
  assert.ok(msg.indexOf('<<<page') < msg.indexOf('xxx') && msg.includes('page>>>'));
  const md = pageMarkdown({ ...p, text: 'Hello\nworld' }, new Date('2026-11-18T12:00:00Z'));
  assert.match(md, /^# A title\n/);
  assert.match(md, /Source: https:\/\/news\.example\/a/);
  // Form plan: My details mapped by label/autocomplete; never fields only listed, with no value.
  const plan = fillPlanFor(
    [
      { ref: 'f0', label: 'First name', name: 'fname', autocomplete: 'given-name' },
      { ref: 'f1', label: 'Email', type: 'email' },
      { ref: 'f2', label: 'Password', type: 'password' },
      { ref: 'f3', label: 'Card number', name: 'cardnumber' },
      { ref: 'f4', label: 'One-time code', autocomplete: 'one-time-code' },
      { ref: 'f5', label: 'Favorite color' },
      { ref: 'f6', label: 'Pw', never: true },
    ],
    { firstName: 'Alex', email: 'alex@example.com' },
  );
  assert.deepEqual(plan.fills.map((f) => [f.ref, f.value]), [['f0', 'Alex'], ['f1', 'alex@example.com']]);
  assert.deepEqual(plan.skipped.map((s) => s.ref).sort(), ['f2', 'f3', 'f4', 'f6']);
  assert.deepEqual(plan.unmatched.map((s) => s.ref), ['f5']);
  assert.ok(fillPlanFor(Array.from({ length: 500 }, (_, i) => ({ ref: `f${i}`, label: 'x' })), {}).unmatched.length <= 200, 'capped');
});

test('kid spaces and members: kids never get the extension; members use it in their own space', () => {
  assert.equal(childRouteCheck('k', { band: '9-12' } as never, 'POST', ['ext', 'ask'])?.status, 403);
  assert.equal(childRouteCheck('k', { band: '9-12' } as never, 'PUT', ['extension'])?.status, 403);
  const rec = { status: 'active', limits: { voice: true, pictures: true } } as never;
  assert.equal(memberRouteCheck(rec, 'POST', ['ext', 'ask']), undefined);
  assert.equal(memberRouteCheck(rec, 'PUT', ['extension']), undefined);
  assert.match(read('src', 'household.ts'), /'ext', 'extension'/);
});

// ------------------------------------------------------------------ over HTTP
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-18T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
app.library = new LibraryStore(app.store.db, dir, () => clock.now);
app.myDetails = myDetailsFor(app.store.db);
app.myDetails.set({ firstName: 'Alex', lastName: 'Rivera', email: 'alex@example.com', home: { city: 'Austin', state: 'TX' } }, clock.now);
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  setPrivateLocal(false);
  server.close();
  app.store.close();
  cleanup();
});

const json = { 'content-type': 'application/json' };
const ext = (tok: string, body?: unknown, path = '/api/ext/state') =>
  fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...json, origin: EXT_ORIGIN, authorization: `Bearer ${tok}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let session = '';
async function owner(path: string, method = 'GET', body?: unknown): Promise<Response> {
  if (!session) {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { ...json, origin: base }, body: JSON.stringify({ token: ownerToken }) });
    session = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  return fetch(`${base}${path}`, { method, headers: { ...json, origin: base, cookie: session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function pair(): Promise<{ token: string; deviceId: string }> {
  const s = await fetch(`${base}/api/device/start`, { method: 'POST', headers: { ...json, origin: EXT_ORIGIN }, body: JSON.stringify({ name: 'Sara for Chrome', scope: 'extension' }) });
  assert.equal(s.status, 200, await s.clone().text());
  const start = (await s.json()) as { code: string; pollToken: string };
  const pend = (await (await owner('/api/device/pending')).json()) as { pending: { code: string; scope: string }[] };
  assert.equal(pend.pending.find((p) => p.code === start.code)?.scope, 'extension');
  assert.equal((await owner('/api/device/approve', 'POST', { code: start.code, token: ownerToken })).status, 200);
  const p = await fetch(`${base}/api/device/poll`, { method: 'POST', headers: { ...json, origin: EXT_ORIGIN }, body: JSON.stringify({ pollToken: start.pollToken }) });
  const got = (await p.json()) as { status: string; token: string; deviceId: string };
  assert.equal(got.status, 'approved');
  return got;
}

test('pairing by code from the extension: listed under Devices as the browser extension, scoped token', async () => {
  // Another web site can't start a device sign-in.
  assert.equal((await fetch(`${base}/api/device/start`, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const { token, deviceId } = await pair();
  const devs = (await (await owner('/api/devices')).json()) as { devices: { id: string; kind: string }[] };
  assert.equal(devs.devices.find((d) => d.id === deviceId)?.kind, 'extension');
  const st = await ext(token);
  assert.equal(st.status, 200, await st.clone().text());
  const state = (await st.json()) as Record<string, unknown>;
  assert.equal(state.companion, app.persona.name);
  assert.equal(state.on, true);
  assert.equal(state.forms, true);
  assert.equal(state.hasDetails, true);
  // The scoped token reaches nothing else.
  for (const [path, method] of [['/api/conversations', 'GET'], ['/api/settings', 'GET'], ['/api/devices', 'GET'], ['/api/my-details', 'GET'], ['/api/extension', 'PUT'], ['/api/library', 'GET']] as const) {
    const r = await fetch(`${base}${path}`, { method, headers: { ...json, origin: EXT_ORIGIN, authorization: `Bearer ${token}` }, ...(method === 'PUT' ? { body: '{}' } : {}) });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  // A session cookie or the owner token can't use the extension routes (only its own token).
  assert.equal((await owner('/api/ext/state')).status, 403);
  // Whoami for the extension says what it is.
  const who = (await (await fetch(`${base}/api/device/whoami`, { headers: { authorization: `Bearer ${token}` } })).json()) as { device: { scope: string } };
  assert.equal(who.device.scope, 'extension');
});

test('ask and summarize: her reply with a link to continue; the page is fenced; one chat per ask', async () => {
  const { token } = await pair();
  app.script.push(text('It is about a big sale.'));
  const r = await ext(token, { mode: 'ask', question: 'What is this?', url: 'https://shop.example/sale', title: 'Sale', selection: 'Half off', text: 'Everything is half off today.' }, '/api/ext/ask');
  assert.equal(r.status, 200, await r.clone().text());
  const a = (await r.json()) as { reply: string; conversationId: string; url: string };
  assert.equal(a.reply, 'It is about a big sale.');
  assert.match(a.url, new RegExp(`/#c=${a.conversationId}$`));
  const conv = app.store.getConversation(a.conversationId)!;
  assert.equal(conv.channel, 'extension');
  const user = app.store.messages(a.conversationId).find((m) => m.role === 'user')!;
  assert.match(user.content, /What is this\?/);
  assert.match(user.content, /Half off/);
  assert.match(user.content, /<<<page[\s\S]*Everything is half off today\.[\s\S]*page>>>/);
  // Her turn ran as an outside app (no private chats, the external-app rules).
  app.script.push(text('Short summary.'));
  const s = (await (await ext(token, { mode: 'summarize', url: 'https://shop.example/sale', title: 'Sale', text: 'Body.' }, '/api/ext/ask')).json()) as { reply: string; conversationId: string };
  assert.equal(s.reply, 'Short summary.');
  assert.notEqual(s.conversationId, a.conversationId);
  assert.equal((await ext(token, { mode: 'ask', url: 'https://a.example', text: '' }, '/api/ext/ask')).status, 400, 'nothing to ask about');
});

test('save to Library: a kept Markdown document with the source address; the same page twice is one document', async () => {
  const { token } = await pair();
  const body = { url: 'https://news.example/story', title: 'A story', text: 'Once upon a time.' };
  const r = await ext(token, body, '/api/ext/save');
  assert.equal(r.status, 200, await r.clone().text());
  const saved = (await r.json()) as { id: number; name: string; url: string };
  const doc = app.library!.get(saved.id)!;
  assert.equal(doc.name, 'A story.md');
  assert.equal(doc.keep, true);
  assert.match(saved.url, /#view=library/);
  const again = (await (await ext(token, body, '/api/ext/save')).json()) as { id: number };
  assert.equal(again.id, saved.id);
});

test('fill: values from My details for approval in the popup; never passwords, cards or codes; off switches', async () => {
  const { token } = await pair();
  const fields = [
    { ref: 'f0', label: 'First name', autocomplete: 'given-name' },
    { ref: 'f1', label: 'City' },
    { ref: 'f2', label: 'Password', type: 'password' },
    { ref: 'f3', label: 'Card number', autocomplete: 'cc-number' },
    { ref: 'f4', label: 'Verification code' },
  ];
  const r = await ext(token, { url: 'https://shop.example/checkout', title: 'Checkout', fields }, '/api/ext/fill');
  assert.equal(r.status, 200, await r.clone().text());
  const plan = (await r.json()) as { fills: { ref: string; label: string; value: string }[]; skipped: { ref: string; why: string }[] };
  assert.deepEqual(plan.fills.map((f) => [f.ref, f.value]), [['f0', 'Alex'], ['f1', 'Austin']]);
  assert.deepEqual(plan.skipped.map((s) => s.ref), ['f2', 'f3', 'f4']);
  assert.ok(!JSON.stringify(plan.skipped).includes('Alex'));
  // Forms off in Settings: no plan; the whole extension off: nothing at all.
  assert.equal((await owner('/api/extension', 'PUT', { forms: false })).status, 200);
  assert.equal((await ext(token, { url: 'https://x.example', fields }, '/api/ext/fill')).status, 403);
  assert.equal(((await (await ext(token)).json()) as { forms: boolean }).forms, false);
  assert.equal((await owner('/api/extension', 'PUT', { on: false })).status, 200);
  assert.equal((await ext(token, { url: 'https://x.example', text: 'x' }, '/api/ext/save')).status, 403);
  const st = (await (await ext(token)).json()) as { on: boolean };
  assert.equal(st.on, false, 'the popup can still say it is off');
  const got = (await (await owner('/api/extension')).json()) as { on: boolean; forms: boolean; paired: number };
  assert.deepEqual([got.on, got.forms], [false, false]);
  assert.ok(got.paired >= 1);
  assert.equal((await owner('/api/extension', 'PUT', { on: true, forms: true })).status, 200);
});

test('private local mode refuses it; revoking it in Devices stops it at once', async () => {
  const { token, deviceId } = await pair();
  setPrivateLocal(true);
  try {
    assert.equal((await ext(token, { url: 'https://a.example', text: 'x' }, '/api/ext/save')).status, 403);
    const st = (await (await ext(token)).json()) as { privateLocal: boolean };
    assert.equal(st.privateLocal, true);
  } finally {
    setPrivateLocal(false);
  }
  assert.equal((await owner(`/api/devices/${deviceId}`, 'DELETE')).status, 200);
  assert.equal((await ext(token)).status, 401);
});

test('web: the Browser extension section on Devices and sign-in, with tips and translations', () => {
  const html = read('web', 'index.html');
  const i = html.indexOf('data-page="dh-devices"');
  const sec = html.slice(i, html.indexOf('</section>', i));
  for (const id of ['bx-on', 'bx-forms', 'bx-box']) assert.ok(sec.includes(`id="${id}"`), id);
  const tips = JSON.parse(read('web', 'tips.json')).tips;
  assert.ok(tips['bx-on'] && tips['bx-forms']);
  assert.match(read('web', 'app.js'), /d\.kind === 'extension'/);
  const es = read('web', 'i18n', 'es.json');
  assert.ok(es.includes('"Browser extension":'));
});
