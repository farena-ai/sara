// N4 "Hands that finish the job" (docs/MY_DETAILS.md, docs/SHOPPING.md, docs/MAIL.md): My details and their
// validators (never cards, SSNs, passwords), mapping a page's fields to details, the one review card on the
// computer, the stop before Submit, refusals on password/card fields, the person's own browser as the way to
// check a store that blocks her (find_product and product watches), attachments resolved and capped, and the
// rules around them (household isolation, private chats, lean words, i18n, tips, page counts).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OwnerAuth } from '../src/auth.ts';
import { OFFSERVER_TOOL, runTurn, type ChatEvent } from '../src/chat.ts';
import { HandsHub } from '../src/hands.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { TestDesktop, type FixtureWindow } from '../src/hands-desktop.ts';
import type { DesktopPrompt } from '../src/hands-desktop-consent.ts';
import { cleanDetails, DetailError, looksLikeCard, looksLikeSsn, myDetailsFor, MyDetailsStore, refusalFor } from '../src/my-details.ts';
import { FormFillError, fieldKind, planFill, reportText, reviewText, runFill, type DeskPort, type DeskView } from '../src/form-fill.ts';
import { checkInMyBrowser, offerFromScreen, pageTitle, type BrowserPort, type BrowserView } from '../src/shopping/my-browser.ts';
import { ProductWatches, type MyBrowserLoad } from '../src/shopping/watch.ts';
import { formatFind, type FindResult } from '../src/shopping/find.ts';
import { applyBrowserChecks } from '../src/tools/shopping.ts';
import { ATTACH_CAP, AttachmentError, attachmentCheck, resolveAttachments } from '../src/mail/attachments.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { createMyDetailsTool } from '../src/tools/my-details.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { familyOf } from '../src/lean.ts';
import type { DesktopItem } from '../src/hands-desktop.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const ALEX = { firstName: 'Alex', lastName: 'Rivera', email: 'alex@example.com', mobilePhone: '512-555-0142', home: { line1: '14 Elm St', city: 'Austin', state: 'TX', zip: '78701', country: 'USA' }, shirtSize: 'M', shoeSize: '10.5', vehicles: [{ make: 'Honda', model: 'Civic', year: '2019', plate: 'ABC1234', vin: '2HGFC2F59KH512345' }], insurance: [{ kind: 'car', company: 'Acme Mutual', policy: 'PA-7781234' }], loyalty: [{ store: 'Home Depot', number: '6045 1234 5678' }], employer: 'Contoso', jobTitle: 'Technician', emergency: { name: 'Sam Rivera', relation: 'spouse', phone: '512-555-0199' } };

test('N4 My details: kept and cleaned; card numbers, SSNs and passwords are refused wherever they are typed', () => {
  const d = cleanDetails(ALEX);
  assert.equal(d.home?.city, 'Austin');
  assert.equal(d.vehicles?.[0]?.vin, '2HGFC2F59KH512345');
  assert.equal(d.loyalty?.[0]?.number, '6045 1234 5678', 'a loyalty number is fine');
  assert.ok(looksLikeCard('4111 1111 1111 1111'));
  assert.ok(looksLikeCard('5555-5555-5555-4444'));
  assert.ok(!looksLikeCard('4111 1111 1111 1112'), 'not Luhn-valid');
  assert.ok(looksLikeSsn('123-45-6789'));
  assert.ok(looksLikeSsn('123456789'));
  assert.ok(!looksLikeSsn('123456789', true), 'nine digits are fine where a number is expected (a policy)');
  const refuse = (raw: Record<string, unknown>, field: RegExp, why: RegExp) => assert.throws(() => cleanDetails(raw), (e: DetailError) => e instanceof DetailError && field.test(e.field) && why.test(e.message));
  refuse({ loyalty: [{ store: 'Shop', number: '4111 1111 1111 1111' }] }, /loyalty\.0\.number/, /payment card/);
  refuse({ insurance: [{ company: 'Acme', policy: '123-45-6789' }] }, /insurance\.0\.policy/, /Social Security/);
  refuse({ firstName: '123456789' }, /firstName/, /Social Security/);
  refuse({ employer: 'my password is hunter2' }, /employer/, /password/);
  refuse({ email: 'not-an-email' }, /email/, /email address/);
  refuse({ vehicles: [{ vin: 'OOO' }] }, /vin/, /17 letters/);
  refuse({ birthDate: '2099-01-01' }, /birthDate/, /date like/);
  assert.equal(refusalFor('123 Pin Oak Dr'), undefined, 'an address with "Pin" in it is fine');
  assert.equal(cleanDetails({ home: { line1: '9 Pin Oak Dr' } }).home?.line1, '9 Pin Oak Dr');
  // There is no field for passwords, cards or SSNs: unknown keys are dropped.
  assert.deepEqual(Object.keys(cleanDetails({ password: 'x', cardNumber: '4111111111111111', ssn: '1' })), []);
});

test('N4 My details: each person\u2019s own store (household isolation); nothing is saved when a value is refused', () => {
  const a = new MyDetailsStore(new DatabaseSync(':memory:'));
  const b = new MyDetailsStore(new DatabaseSync(':memory:'));
  a.set(ALEX);
  assert.equal(b.get().firstName, undefined, 'another space sees nothing');
  assert.throws(() => a.set({ ...ALEX, firstName: '4111 1111 1111 1111' }));
  assert.equal(a.get().firstName, 'Alex', 'the old details stay');
  assert.equal(a.leaveStoreTab(), false);
  a.setLeaveStoreTab(true);
  assert.equal(a.leaveStoreTab(), true);
  const db = new DatabaseSync(':memory:');
  assert.equal(myDetailsFor(db), myDetailsFor(db));
  assert.ok(MEMBER_ROUTES.has('my-details'), 'a household member has their own My details');
});

const items = (list: Partial<DesktopItem>[]): DesktopItem[] => list.map((x, i) => ({ ref: `e${i + 1}`, role: 'edit', ...x }));
const FORM = items([
  { role: 'edit', name: 'Address and search bar', value: 'shop.example/signup' },
  { role: 'document', name: 'Sign up' },
  { name: 'Full name' },
  { name: 'Email address' },
  { name: '', aid: 'tel', hint: 'Mobile phone' },
  { name: 'Street address' },
  { name: 'City' },
  { name: 'State' },
  { name: 'ZIP code' },
  { role: 'combobox', name: 'Shirt size' },
  { name: 'Password', secret: true },
  { name: 'Card number' },
  { name: 'CVV' },
  { name: 'Social Security number' },
  { name: 'Coupon code' },
  { name: 'Favorite color' },
  { role: 'button', name: 'Submit' },
]);

test('N4 field mapping: labels, ids, placeholders and autocomplete; password, card, SSN and code fields are never filled', () => {
  assert.equal(fieldKind({ name: 'E-mail' }), 'email');
  assert.equal(fieldKind({ aid: 'postal_code' }), 'zip');
  assert.equal(fieldKind({ hint: 'Apt, suite, unit' }), 'address2');
  assert.equal(fieldKind({ name: 'Anything', auto: 'family-name' }), 'lastName');
  assert.equal(fieldKind({ name: 'x', auto: 'cc-number' }), 'card');
  assert.equal(fieldKind({ name: 'Name on card' }), 'card');
  assert.equal(fieldKind({ name: 'Expiration date' }), 'card');
  assert.equal(fieldKind({ name: 'Username' }), undefined, 'a sign-in name is not a detail');
  assert.equal(fieldKind({ name: 'Company name' }), 'employer');
  assert.equal(fieldKind({ name: 'Verification code' }), 'code');
  assert.equal(fieldKind({ name: 'Anything', secret: true }), 'password');
  const plan = planFill(FORM, cleanDetails(ALEX));
  assert.deepEqual(plan.fills.map((f) => [f.label, f.value]), [['Full name', 'Alex Rivera'], ['Email address', 'alex@example.com'], ['Mobile phone', '512-555-0142'], ['Street address', '14 Elm St'], ['City', 'Austin'], ['State', 'TX'], ['ZIP code', '78701'], ['Shirt size', 'M']]);
  assert.deepEqual(plan.skipped.map((s) => s.label), ['Password', 'Card number', 'CVV', 'Social Security number']);
  assert.deepEqual(plan.unmatched.map((u) => u.label), ['Favorite color']);
  // Values from the chat win, by label or detail; a card number from the chat is refused.
  const chat = planFill(FORM, cleanDetails(ALEX), { values: { 'Favorite color': 'Green', email: 'work@contoso.example' } });
  assert.equal(chat.fills.find((f) => f.label === 'Favorite color')?.value, 'Green');
  assert.equal(chat.fills.find((f) => f.label === 'Email address')?.value, 'work@contoso.example');
  assert.throws(() => planFill(FORM, {}, { values: { 'Card number': '4111 1111 1111 1111' } }), FormFillError);
  // The review card: every field -> value, and what is left for the person.
  const review = reviewText(plan);
  assert.match(review, /^Full name \u2192 Alex Rivera$/m);
  assert.match(review, /Shirt size \u2192 M/);
  assert.match(review, /Not filled: Password \(a password field: never typed by Sara\); Card number \(a payment card field: you type it yourself\)/);
  assert.doesNotMatch(review, /4111|hunter/);
});

function fakeDesk(list: DesktopItem[], o: { deny?: number } = {}) {
  const values = new Map<string, string>();
  const calls: { ref: string; text: string; review?: string; forceOnce?: boolean }[] = [];
  const view = (): DeskView => ({ viewId: 'v1', window: 'w1', title: 'Sign up', items: list.map((i) => (values.has(i.ref) ? { ...i, value: values.get(i.ref)! } : i)) });
  const port: DeskPort = {
    look: async () => view(),
    type: async (_v, ref, text, opts) => {
      calls.push({ ref, text, ...opts });
      if (o.deny && calls.length === o.deny) throw new Error('Nothing changed: The person at this computer did not approve that action.');
      values.set(ref, text);
      return view();
    },
  };
  return { port, calls, view };
}

test('N4 runFill: one review card (first field only), read back, stop before Submit; a no stops it', async () => {
  const plan = planFill(FORM, cleanDetails(ALEX));
  const d = fakeDesk(FORM);
  const rep = await runFill(d.port, d.view(), plan, { sensitive: false, review: reviewText(plan), gapMs: 0 });
  assert.equal(d.calls.length, 8);
  assert.ok(d.calls[0]!.review?.includes('Full name \u2192 Alex Rivera'), 'the review list rides on the first field');
  assert.ok(d.calls.slice(1).every((c) => c.review === undefined));
  assert.ok(!d.calls.some((c) => /Password|Card|CVV/.test(FORM.find((i) => i.ref === c.ref)!.name ?? '')), 'never a password or card field');
  assert.ok(rep.typed.every((t) => t.verified));
  const out = reportText(rep, { sensitive: false, page: 'Sign up' });
  assert.match(out, /Verified: read back from the page: Full name = \u201cAlex Rivera\u201d/);
  assert.match(out, /STOPPED before Submit: nothing was submitted/);
  assert.match(out, /Left for them on purpose: Password/);
  // A payment or sign-in page: every field asks again; the person presses Submit themselves.
  const s = fakeDesk(FORM);
  await runFill(s.port, s.view(), plan, { sensitive: true, review: 'x', gapMs: 0 });
  assert.ok(s.calls.every((c) => c.forceOnce === true));
  assert.match(reportText(rep, { sensitive: true, page: 'Checkout' }), /they press it themselves; never press it for them/);
  // The person says no on the first card: nothing more is typed.
  const no = fakeDesk(FORM, { deny: 1 });
  const r2 = await runFill(no.port, no.view(), plan, { sensitive: false, review: 'x', gapMs: 0 });
  assert.equal(no.calls.length, 1);
  assert.equal(r2.stoppedAt, 'Full name');
});

const formWindow = (): FixtureWindow => ({
  id: 'w201', title: 'Contact details - Contoso Store - Microsoft Edge', app: 'msedge', bounds: [60, 60, 900, 700], color: [250, 250, 250], origin: 'https://shop.example',
  elements: [
    { role: 'text', name: 'Create your account', box: [20, 20, 300, 24] },
    { role: 'edit', name: 'Full name', box: [20, 60, 300, 28] },
    { role: 'edit', name: 'Email', box: [20, 100, 300, 28] },
    { role: 'edit', name: 'Phone', aid: 'tel', box: [20, 140, 300, 28] },
    { role: 'edit', name: 'Street address', box: [20, 180, 300, 28] },
    { role: 'combobox', name: 'Shirt size', box: [20, 220, 120, 28] },
    { role: 'edit', name: 'Password', secure: true, box: [20, 260, 300, 28] },
    { role: 'edit', name: 'Card number', box: [20, 300, 300, 28] },
    { role: 'button', name: 'Submit', box: [20, 340, 100, 30] },
  ],
});

async function handsRig(o: { reviewCards?: boolean; answer?: (p: DesktopPrompt) => 'once' | 'task' | 'deny' } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString(), providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://example.test/v1' }], defaultProviderId: 'fixture', defaultModel: 'fake-large' });
  for (const t of createComputerTools(app)) app.tools.add(t);
  app.tools.add(createMyDetailsTool(() => app));
  myDetailsFor(app.store.db).set(ALEX);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pair = (await (await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fixture desktop', token: auth.newToken }) })).json()) as { token: string; id: string };
  const desktop = new TestDesktop({ windows: [formWindow()] });
  desktop.foreground = 'w201';
  const prompts: DesktopPrompt[] = [];
  const ref = new HandsRef({ server: base, token: pair.token, desktop, desktopConsent: async (p) => (prompts.push(p), o.answer ? o.answer(p) : 'task'), reconnect: false, optIn: { browser: true, desktop: true }, ...(o.reviewCards === false ? { reviewCards: false } : {}) });
  await ref.start();
  for (let i = 0; !hub.hello(pair.id) && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
  return { app, desktop, prompts, base, auth, close: () => { ref.stop(); server.close(); cleanup(); } };
}

test('N4 pc_fill_form on the reference computer: one review card, allowed fields typed, password/card left, stops before Submit', async () => {
  const r = await handsRig();
  try {
    const conv = r.app.store.createConversation({ title: 'Form', mode: 'chat' });
    r.app.script.push([call('f', 'pc_fill_form', { window: 'w201' })], text('Filled.'));
    const events: ChatEvent[] = [];
    for await (const e of runTurn(r.app, conv.id, 'Fill in this sign-up form with my details.')) events.push(e);
    const res = events.find((e) => e.type === 'tool_result') as { status: string; output?: string } | undefined;
    assert.equal(res?.status, 'ok', JSON.stringify(res));
    assert.equal(r.prompts.length, 1, 'one card for the whole form');
    assert.match(r.prompts[0]!.review ?? '', /Full name \u2192 Alex Rivera\nEmail \u2192 alex@example\.com\nPhone \u2192 512-555-0142\nStreet address \u2192 14 Elm St\nShirt size \u2192 M/);
    assert.match(r.prompts[0]!.review ?? '', /Not filled: Password .*Card number/);
    assert.deepEqual(r.prompts[0]!.choices, ['once', 'task']);
    const el = (n: string) => r.desktop.windows[0]!.elements.find((x) => x.name === n)!;
    assert.equal(el('Full name').value, 'Alex Rivera');
    assert.equal(el('Shirt size').value, 'M', res!.output);
    assert.equal(el('Password').value, undefined, 'never a password');
    assert.equal(el('Card number').value, undefined, 'never a card number');
    assert.equal(r.desktop.clicked, '', 'Submit was not pressed');
    assert.match(res!.output ?? '', /STOPPED before Submit/);
    assert.match(res!.output ?? '', /Verified: read back from the page/);
  } finally {
    r.close();
  }
});

test('N4 pc_fill_form: an older app (no review cards) is refused with how to update; "Always allowed" still shows the review', async () => {
  const old = await handsRig({ reviewCards: false });
  try {
    const conv = old.app.store.createConversation({ title: 'Form', mode: 'chat' });
    old.app.script.push([call('f', 'pc_fill_form', { window: 'w201' })], text('ok'));
    const events: ChatEvent[] = [];
    for await (const e of runTurn(old.app, conv.id, 'Fill in this form with my details.')) events.push(e);
    const res = events.find((e) => e.type === 'tool_result') as { status: string; output?: string };
    assert.notEqual(res.status, 'ok');
    assert.match(JSON.stringify(res), /too old to show the form review card/);
    assert.equal(old.desktop.windows[0]!.elements[1]!.value, undefined);
  } finally {
    old.close();
  }
});

test('N4 my_details_get: the person\u2019s own details; never in shared rooms or chats with others', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date() });
    const tool = createMyDetailsTool(() => app);
    const conv = app.store.createConversation({ title: 'x', mode: 'chat' });
    const ctx = { workspaceDir: dir, signal: AbortSignal.timeout(2000), sandbox: { mode: 'none', network: false, detail: '' }, conversationId: conv.id } as never;
    assert.match(await tool.run({}, ctx), /My details are empty/);
    myDetailsFor(app.store.db).set(ALEX);
    const out = await tool.run({}, ctx);
    assert.match(out, /Name: Alex Rivera/);
    assert.match(out, /Insurance 1: car: Acme Mutual, policy PA-7781234/);
    assert.ok(!OFFSERVER_TOOL('my_details_get'), 'local: fine in private chats');
    assert.equal(familyOf(tool as never).id, 'details');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ (c) store checks in the person's own browser

const pageItems = (price: string, stock: string): DesktopItem[] => items([
  { role: 'tab', name: 'Ryobi 18V Drill - Fake Depot' },
  { role: 'button', name: 'Close tab' },
  { role: 'button', name: 'New Tab' },
  { role: 'edit', name: 'Address and search bar', value: 'depot.example/p/123' },
  { role: 'document', name: 'Ryobi 18V Drill - Fake Depot' },
  { role: 'text', name: 'Ryobi ONE+ 18V Cordless Drill Kit' },
  { role: 'text', name: 'Was $99.00' },
  { role: 'text', name: price },
  { role: 'text', name: stock },
  { role: 'text', name: 'Pickup today at Round Rock store' },
]);

test('N4 offerFromScreen: price, stock and pickup from the page text; a bot wall is still a wall', () => {
  const got = offerFromScreen(pageItems('$79.97', 'In stock'), { title: 'Ryobi 18V Drill - Fake Depot', what: 'Ryobi 18V drill' });
  assert.equal(got.offer?.price, 79.97, 'the strike price is skipped');
  assert.equal(got.offer?.availability, 'in_stock');
  assert.equal(got.pickup, 'Pickup today at Round Rock store');
  assert.deepEqual(got.offer?.fulfillment, ['pickup']);
  assert.equal(offerFromScreen(pageItems('$79.97', 'Out of stock')).offer?.availability, 'out_of_stock');
  assert.ok(offerFromScreen(items([{ role: 'document', name: 'Robot or human?' }, { role: 'text', name: 'Activate and hold the button to confirm that you are human.' }]), { title: 'Robot or human?' }).blocked);
  assert.deepEqual(offerFromScreen(items([{ role: 'document', name: 'x' }, { role: 'text', name: 'Hello' }])), {});
});

/** A fake of the person's browser: New Tab, the address bar, Enter, a page, Close tab. */
function fakeBrowser(o: { page?: (url: string) => DesktopItem[]; title?: string; deny?: string } = {}) {
  let state: 'start' | 'new' | 'typed' | 'page' | 'closed' = 'start';
  let typed = '';
  const log: string[] = [];
  const view = (): BrowserView => {
    const chrome = items([{ role: 'tab', name: 'My mail' }, { role: 'button', name: 'Close tab' }]);
    if (state === 'start' || state === 'closed') return { viewId: 'v', window: 'w9', title: 'My mail - Microsoft Edge', items: [...chrome, ...items([{ role: 'button', name: 'New Tab' }, { role: 'edit', name: 'Address and search bar', value: 'mail.example' }])].map((x, i) => ({ ...x, ref: `e${i + 1}` })) };
    if (state === 'new' || state === 'typed') return { viewId: 'v', window: 'w9', title: 'New Tab - Microsoft Edge', items: [...chrome, ...items([{ role: 'tab', name: 'New Tab' }, { role: 'button', name: 'Close tab' }, { role: 'button', name: 'New Tab' }, { role: 'edit', name: 'Address and search bar', value: typed, focused: true }])].map((x, i) => ({ ...x, ref: `e${i + 1}` })) };
    const page = (o.page ?? (() => pageItems('$79.97', 'In stock')))(typed);
    return { viewId: 'v', window: 'w9', title: `${o.title ?? 'Ryobi 18V Drill - Fake Depot'} - Microsoft Edge`, items: [...chrome, ...page].map((x, i) => ({ ...x, ref: `e${i + 1}` })) };
  };
  const port: BrowserPort = {
    tabs: async () => [{ id: 'w9', browser: 'Edge', tabs: [{ title: 'My mail', active: true }] }],
    look: async () => view(),
    click: async (v, ref) => {
      const name = v.items.find((i) => i.ref === ref)?.name ?? '';
      log.push(`click ${name}`);
      if (o.deny === name) throw new Error('The person at this computer did not approve that action.');
      if (name === 'New Tab') state = 'new';
      else if (name === 'Close tab' && state === 'page') state = 'closed';
    },
    type: async (_v, _ref, text) => { log.push(`type ${text}`); typed = text; state = 'typed'; },
    keys: async (_v, _ref, combo) => { log.push(`keys ${combo}`); if (state === 'typed' && combo === 'enter') state = 'page'; },
    sleep: async () => {},
  };
  return { port, log, state: () => state };
}

test('N4 checkInMyBrowser: New Tab, the address, Enter, a read-only look, the tab closed again (or left open)', async () => {
  const b = fakeBrowser();
  const got = await checkInMyBrowser(b.port, 'https://depot.example/p/123', { what: 'Ryobi 18V drill', loadWaitMs: 5 });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.deepEqual(b.log, ['click New Tab', 'type https://depot.example/p/123', 'keys enter', 'click Close tab']);
  assert.equal(b.state(), 'closed');
  if (got.ok) assert.equal(got.offer.price, 79.97);
  const keep = fakeBrowser();
  const left = await checkInMyBrowser(keep.port, 'https://depot.example/p/123', { leaveOpen: true, loadWaitMs: 5 });
  assert.equal(left.ok && left.closed, false);
  assert.ok(!keep.log.includes('click Close tab'));
  // A wall even there, or a no on the computer: said, nothing else done.
  const wall = await checkInMyBrowser(fakeBrowser({ title: 'Robot or human?', page: () => items([{ role: 'document', name: 'Robot or human?' }]) }).port, 'https://depot.example/p/1', { loadWaitMs: 5 });
  assert.equal(wall.ok, false);
  assert.match(wall.ok ? '' : wall.reason, /even in your browser/);
  await assert.rejects(checkInMyBrowser(fakeBrowser({ deny: 'New Tab' }).port, 'https://depot.example/p/1'), /did not approve/);
  assert.equal((await checkInMyBrowser(fakeBrowser().port, 'file:///c:/x')).ok, false);
});

test('N4 find_product: a blocked store checked in the person\u2019s browser joins the ranked list as \u201cfrom your browser\u201d', async () => {
  const r: FindResult = { what: 'Ryobi 18V drill', radiusMiles: 10, checkedAt: '2026-11-14T16:00:00Z', rows: [{ retailer: 'Amazon', title: 'Ryobi drill', price: 89, availability: 'in_stock', url: 'https://amazon.example/x', checkedAt: '2026-11-14T16:00:00Z', source: 'amazon page' }], couldNot: [{ retailer: 'Home Depot', reason: 'the page showed a bot check', url: 'https://depot.example/p/123' }, { retailer: 'Lowe\u2019s', reason: 'Access Denied', url: 'https://lowes.example/p/9' }], overMax: 0, stores: [], models: [], loads: 2 };
  const time = (iso: string) => iso.slice(11, 16);
  assert.match(formatFind(r, { id: 7, time, canUsePc: true }), /check in my browser.*find_product with result_id 7 and in_my_browser: true/);
  const b = fakeBrowser();
  const notes = await applyBrowserChecks(r, r.couldNot.slice(0, 1), async (url) => checkInMyBrowser(b.port, url, { what: r.what, loadWaitMs: 5 }), '2026-11-14T16:05:00Z');
  assert.match(notes.join(' '), /Home Depot: read in their browser \(tab closed again\)/);
  assert.equal(r.rows[0]!.retailer, 'Home Depot', 'cheaper and in stock: first');
  assert.equal(r.rows[0]!.fromBrowser, true);
  const text_ = formatFind(r, { id: 7, time, canUsePc: true });
  assert.match(text_, /1\. Home Depot \u2014 \$79\.97 \u2014 in stock .*Pickup today at Round Rock store \u2014 from your browser/);
  assert.deepEqual(r.couldNot.map((c) => c.retailer), ['Lowe\u2019s']);
  // The computer is busy or in use: \u201cnot now\u201d, nothing opened, the store stays on the list.
  const n2 = await applyBrowserChecks(r, r.couldNot, async () => ({ ok: false, reason: 'you are using the computer', notNow: true }), 'x');
  assert.match(n2.join(' '), /Not now: you are using the computer\. I stopped there/);
  assert.equal(r.couldNot[0]!.triedBrowser, undefined);
  assert.ok(OFFSERVER_TOOL('find_product'), 'never in private chats');
});

test('N4 product watch in my browser: \u201cnot now\u201d is no failure; a check there fires the alert', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const clock = { now: new Date('2026-11-14T16:00:00Z') };
    const app = makeApp(dir, clock);
    let next: Awaited<ReturnType<MyBrowserLoad>> = { ok: false, reason: 'you are using the computer', notNow: true };
    const w = new ProductWatches(app, app.store.db, async () => ({ ok: false, reason: 'blocked', via: 'reader' }), async () => next);
    const one = w.add({ url: 'https://depot.example/p/123', label: 'Ryobi drill', condition: 'back_in_stock', inMyBrowser: true });
    assert.equal(one.inMyBrowser, true);
    assert.equal(await w.check(one.id), undefined);
    assert.equal(w.get(one.id)!.fails, 0, 'not a failure');
    assert.match(w.get(one.id)!.lastError ?? '', /not checked: you are using the computer/);
    next = { ok: true, offer: { title: 'Ryobi drill', price: 79.97, availability: 'in_stock', how: 'page', url: 'https://depot.example/p/123' } };
    const said = await w.check(one.id);
    assert.match(said ?? '', /in stock at depot\.example.*in your own browser/);
    w.setInMyBrowser(one.id, false);
    assert.equal(w.get(one.id)!.inMyBrowser, false);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ (b) attachments

test('N4 attachments: Library files by number, caps per provider, the read-back line', () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  const { dir, cleanup } = tempDir();
  try {
    const p1 = join(dir, 'a.pdf');
    const p2 = join(dir, 'b.pdf');
    writeFileSync(p1, Buffer.from('%PDF small'));
    writeFileSync(p2, big);
    const app = { library: { get: (id: number) => (id === 1 ? { id, name: 'Invoice INV-1.pdf' } : id === 2 ? { id, name: 'Scan.pdf' } : undefined), filePath: (d: { id: number }) => (d.id === 1 ? p1 : p2) }, now: () => new Date() } as never;
    const one = resolveAttachments(app, ['1'], 'graph');
    assert.equal(one[0]!.name, 'Invoice INV-1.pdf');
    assert.equal(one[0]!.mime, 'application/pdf');
    assert.equal(resolveAttachments(app, 'library:1', 'imap').length, 1);
    assert.equal(resolveAttachments(app, [2], 'graph').length, 1, 'R1: Outlook takes 150 MB through an upload session');
    assert.equal(ATTACH_CAP.graph, 150 * 1024 * 1024);
    assert.equal(resolveAttachments(app, [2], 'google').length, 1, 'Gmail takes 20 MB');
    assert.throws(() => resolveAttachments(app, [9], 'google'), /Library document 9 has no file/);
    assert.equal(ATTACH_CAP.imap, 20 * 1024 * 1024);
    assert.match(attachmentCheck(one, ['Invoice INV-1.pdf'], 'the draft'), /Verified: the draft has the attachment Invoice INV-1\.pdf/);
    assert.match(attachmentCheck(one, [], 'the draft'), /Could not verify: Invoice INV-1\.pdf is not on the draft/);
    assert.match(attachmentCheck(one, undefined, 'the draft'), /Could not verify the attachments/);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ the rest: words, persona, i18n, tips, pages

test('N4 lean, persona, help and i18n: the new tools are found, said and translated', () => {
  const lean = readFileSync(join(ROOT, 'src', 'lean.ts'), 'utf8');
  assert.match(lean, /my_details_get/);
  const persona = readFileSync(join(ROOT, 'src', 'persona.ts'), 'utf8');
  assert.match(persona, /pc_fill_form/);
  assert.match(persona, /check in my browser/i);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /data-page="you-details" data-group="You" data-title="My details"/);
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  assert.ok(JSON.stringify(tips).includes('"you-details"'));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const t = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    assert.ok(t['My details'], `${lang}: My details`);
    assert.ok(t['Leave the store\u2019s tab open after a check'], `${lang}: the tab choice`);
  }
  const pt = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', 'pt-BR.json'), 'utf8')) as Record<string, string>;
  assert.notEqual(pt['My details'], 'My details');
});

test('N4 a browser window title loses the browser, profile and "and 1 more page" parts', () => {
  assert.equal(pageTitle('Ryobi 18V Drill - Fake Depot and 1 more page - Personal - Microsoft\u200b Edge'), 'Ryobi 18V Drill - Fake Depot');
  assert.equal(pageTitle('Drill | Store - Google Chrome'), 'Drill | Store');
});
