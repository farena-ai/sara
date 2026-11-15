// R4 (docs/IPHONE.md): iPhone without the App Store. Shortcuts tokens (scoped, hashed, revocable,
// per person), Share to Sara / Ask Sara / the widget through Apple Shortcuts, rate limits, private
// local mode, the installed web app's badge and Home Screen guide, the page and its strings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { OwnerAuth, SHORTCUT_TOKEN_PREFIX } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { memberRouteCheck } from '../src/household.ts';
import { LibraryStore } from '../src/library/store.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { siriNote } from '../src/phone-actions.ts';
import { PushService, type PushPayload } from '../src/push.ts';
import { linkFromFile } from '../src/routes/shortcuts.ts';
import { createSaraServer } from '../src/server.ts';
import { ICLOUD_SHORTCUT_RE, ShortcutLimiter, shortAnswer, waitingCount } from '../src/shortcuts.ts';
import { ApprovalBroker } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { applyBadge, badgeValue, isIOS, needsInstallGuide, pushPossible } from '../web/ios-web.js';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';

// ------------------------------------------------------------------ tokens (unit)

test('Shortcuts tokens: shown once, hash only, scoped, revocable, and nothing else takes them', () => {
  const { dir, cleanup } = tempDir();
  try {
    const auth = new OwnerAuth(dir, () => new Date());
    const made = auth.createShortcutToken("Alex's iPhone", ['share']);
    assert.ok(made.token.startsWith(SHORTCUT_TOKEN_PREFIX));
    assert.deepEqual(made.scopes, ['share']);
    const file = readFileSync(join(dir, 'owner.json'), 'utf8');
    assert.ok(!file.includes(made.token.split('.')[2]!), 'the secret is not stored, only its hash');
    assert.deepEqual(auth.shortcutToken(made.token), { id: made.id, label: "Alex's iPhone", scopes: ['share'] });
    assert.equal(auth.shortcutToken(`${made.token}x`), undefined, 'a changed secret fails');
    assert.equal(auth.shortcutToken(made.token.replace(SHORTCUT_TOKEN_PREFIX, 'sara_dev.')), undefined);
    // Never a device token for the app's own API, never a hands token.
    assert.equal(auth.deviceTokenId(made.token.replace(SHORTCUT_TOKEN_PREFIX, 'sara_dev.')), undefined);
    assert.equal(auth.deviceKind(made.id), undefined);
    assert.equal(auth.devices().find((d) => d.id === made.id)?.kind, 'shortcut', 'listed under Devices too');
    assert.throws(() => auth.createShortcutToken('x', []), /at least one/);
    const both = auth.createShortcutToken('');
    assert.deepEqual(both.scopes, ['share', 'ask']);
    assert.equal(auth.shortcutTokens().length, 2);
    // Signing in again later never drops a token that wasn't used for a while.
    auth.createSession('Browser');
    assert.ok(auth.shortcutToken(made.token));
    auth.signOut(made.id);
    assert.equal(auth.shortcutToken(made.token), undefined, 'removed = stops at once');
    for (let i = 0; i < 9; i++) auth.createShortcutToken(`p${i}`);
    assert.throws(() => auth.createShortcutToken('one more'), /Up to 10/);
  } finally {
    cleanup();
  }
});

test('household: a token is only good in the space that made it; members may use the routes', () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const owner = new OwnerAuth(a.dir, () => new Date());
    const member = new OwnerAuth(b.dir, () => new Date());
    const tok = member.createShortcutToken('Sam', ['ask']).token;
    assert.equal(owner.shortcutToken(tok), undefined);
    assert.ok(member.shortcutToken(tok));
    assert.ok(member.hasDevice(tok.slice(SHORTCUT_TOKEN_PREFIX.length).split('.')[0]!), 'the front router finds the member by the id');
    assert.match(read('src', 'main.ts'), /tok\.startsWith\('sara_sc\.'\)/);
    assert.equal(memberRouteCheck({ status: 'active', limits: { voice: true, pictures: true } } as never, 'POST', ['shortcuts', 'tokens']), undefined);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('limits, the short answer, the badge number, the share-sheet file that is really a link', () => {
  const lim = new ShortcutLimiter({ share: { perMinute: 2, perHour: 3 }, ask: { perMinute: 1, perHour: 5 }, widget: { perMinute: 5, perHour: 5 } });
  assert.ok(lim.take('t', 'share', 0) && lim.take('t', 'share', 1));
  assert.equal(lim.take('t', 'share', 2), false, 'burst');
  assert.ok(lim.take('t', 'share', 61_000));
  assert.equal(lim.take('t', 'share', 125_000), false, 'per hour');
  assert.ok(lim.take('other', 'share', 2), 'per token');
  assert.ok(lim.take('t', 'ask', 2), 'per route');
  assert.equal(shortAnswer('**Sure!** It is 72°F and sunny. Bring sunglasses. Also a hat.\n\n- one'), 'Sure! It is 72°F and sunny.');
  assert.ok(shortAnswer('word '.repeat(200)).length <= 321);
  assert.equal(waitingCount(new Map([['c', { approvals: new Map([['x', 1], ['y', 2]]) }]]), { inbox: { list: () => [{}] } } as never), 3);
  const f = (data: string, name = 'text.txt', type = 'text/plain') => ({ fields: {}, files: [{ name, type, data: Buffer.from(data) }] });
  assert.deepEqual(linkFromFile(f('https://example.com/a?b=1\n')), { fields: { url: 'https://example.com/a?b=1' }, files: [] });
  assert.deepEqual(linkFromFile(f('Buy milk')), { fields: { text: 'Buy milk' }, files: [] });
  assert.equal(linkFromFile(f('x', 'scan.pdf', 'application/pdf')).files.length, 1, 'a real file stays a file');
  assert.match(siriNote('Alex'), /at most two short sentences/);
  assert.ok(ICLOUD_SHORTCUT_RE.test('https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef'));
  assert.ok(!ICLOUD_SHORTCUT_RE.test('https://evil.example/shortcuts/0123456789abcdef0123456789abcdef'));
});

test('iPhone web app: detection, the Home Screen guide, push only once installed, the badge', async () => {
  assert.ok(isIOS(IPHONE));
  assert.ok(isIOS(IPAD_DESKTOP, 5), 'an iPad asking for the desktop site');
  assert.ok(!isIOS(IPAD_DESKTOP, 0), 'a Mac');
  assert.ok(needsInstallGuide({ ua: IPHONE, standalone: false }));
  assert.ok(!needsInstallGuide({ ua: IPHONE, standalone: true }));
  assert.ok(!needsInstallGuide({ ua: `${IPHONE} SaraPhone/3.10`, standalone: false }), "Sara's own iPhone app");
  assert.ok(!needsInstallGuide({ ua: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile', standalone: false }));
  assert.equal(pushPossible({ ua: IPHONE, standalone: false, hasPush: true }), false);
  assert.equal(pushPossible({ ua: IPHONE, standalone: true, hasPush: true }), true);
  assert.equal(pushPossible({ ua: 'Chrome', standalone: false, hasPush: true }), true);
  assert.deepEqual([badgeValue(3), badgeValue(0), badgeValue(-2), badgeValue('x'), badgeValue(250)], [3, 0, 0, 0, 99]);
  const calls: string[] = [];
  const nav = { setAppBadge: async (n: number) => void calls.push(`set ${n}`), clearAppBadge: async () => void calls.push('clear') };
  assert.equal(await applyBadge(nav, 2), 2);
  assert.equal(await applyBadge(nav, 0), 0);
  assert.equal(await applyBadge({}, 2), null, 'no Badging API');
  assert.deepEqual(calls, ['set 2', 'clear']);
});

test('Ask Sara: the turn gets the short-answer note (not car mode)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date() });
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex' } as never);
    const conv = app.store.createConversation({});
    for await (const _ of runTurn(app, conv.id, 'weather?', undefined, { siri: true }));
    assert.match(JSON.stringify(app.requests.at(-1)!.messages), /through Siri or an Apple Shortcut/);
    assert.doesNotMatch(JSON.stringify(app.requests.at(-1)!.messages), /car mode/);
    app.store.close();
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ routes

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-15T15:00:00Z') };
const app = makeApp(dir, clock);
(app as { approvals: ApprovalBroker }).approvals = new ApprovalBroker(5000);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
app.library = new LibraryStore(app.store.db, dir, () => clock.now);
const pushed: PushPayload[] = [];
const push = new PushService(app.store.db, app.vault, app.settings, { now: () => clock.now });
push.sendAll = async (p) => (pushed.push(p), { sent: 1, failed: 0, removed: 0 });
app.push = push;
const slowTool: Tool = { spec: { name: 'slow_job', description: 'slow', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'Slow job', run: async () => (await new Promise((r) => setTimeout(r, 400)), 'done') };
app.tools.add(slowTool);
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), shortcutAskBudgetMs: 250, shortcutLinksDir: dir });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const owner = { authorization: `Bearer ${ownerToken}` };
const sc = (tok: string) => ({ authorization: `Bearer ${tok}` });
const until = async (ok: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), 'timed out');
};

async function makeToken(scopes = ['share', 'ask'], label = 'iPhone'): Promise<{ token: string; id: string; qr: string }> {
  const r = await fetch(`${base}/api/shortcuts/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie() }, body: JSON.stringify({ label, scopes }) });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
let session = '';
async function cookie(): Promise<string> {
  if (session) return session;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: ownerToken }) });
  session = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  return session;
}

test('page routes: make (shown once, with a QR code), list without secrets, revoke; tokens from the web page only', async () => {
  const made = await makeToken(['share'], "Alex's iPhone");
  assert.match(made.qr, /^data:image\/svg\+xml;base64,/);
  const list = await (await fetch(`${base}/api/shortcuts`, { headers: { cookie: await cookie() } })).json();
  assert.equal(list.tokens.length, 1);
  assert.ok(!JSON.stringify(list).includes(made.token), 'the list never has the token');
  assert.equal(list.owner, true);
  // An app signed in with a token (the owner token, a device code) can't make one.
  assert.equal((await fetch(`${base}/api/shortcuts/tokens`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  // A Shortcuts token can't use the page routes or the app's own API.
  assert.equal((await fetch(`${base}/api/shortcuts`, { headers: sc(made.token) })).status, 401);
  assert.equal((await fetch(`${base}/api/conversations`, { headers: sc(made.token) })).status, 401);
  assert.equal((await fetch(`${base}/api/shortcuts/tokens/${made.id}`, { method: 'DELETE', headers: { cookie: await cookie() } })).status, 200);
  assert.equal((await fetch(`${base}/api/shortcuts/widget`, { headers: sc(made.token) })).status, 401, 'revoked');
  // The owner's iCloud links: only real iCloud shortcut links.
  const bad = await fetch(`${base}/api/shortcuts/links`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: await cookie() }, body: JSON.stringify({ share: 'https://example.com/x' }) });
  assert.equal(bad.status, 400);
  const good = await (await fetch(`${base}/api/shortcuts/links`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: await cookie() }, body: JSON.stringify({ share: 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef', ask: '' }) })).json();
  assert.deepEqual(good.links, { share: 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef' });
});

test('share: a photo (form) and a link (JSON base64 too) go to the Library and a chat; a short sentence back', async () => {
  const { token } = await makeToken(['share']);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }), 'receipt.png');
  const r = await fetch(`${base}/api/shortcuts/share`, { method: 'POST', headers: sc(token), body: fd });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('content-type')!, /text\/plain/);
  assert.match(await r.text(), /Saved to Sara: receipt\.png/);
  assert.match(r.headers.get('x-sara-url')!, /^http:\/\/127\.0\.0\.1:\d+\/#c=[\w-]+&draft=.+&docs=\d+$/);
  // JSON with a base64 file and a note; and a link that the share sheet sent as a small text file.
  const j = await (await fetch(`${base}/api/shortcuts/share`, { method: 'POST', headers: { ...sc(token), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text: 'for the trip', files: [{ name: 'list.txt', type: 'text/plain', data: Buffer.from('passport\nsocks\n'.repeat(400)).toString('base64') }] }) })).json();
  assert.equal(j.docs.length, 1);
  assert.equal(app.library!.get(j.docs[0].id)?.keep, true);
  assert.ok(app.store.getConversation(j.conversationId));
  const fd2 = new FormData();
  fd2.append('file', new Blob(['https://example.com/recipe'], { type: 'text/plain' }), 'text.txt');
  const link = await (await fetch(`${base}/api/shortcuts/share`, { method: 'POST', headers: { ...sc(token), accept: 'application/json' }, body: fd2 })).json();
  assert.equal(link.docs.length, 0);
  assert.match(link.prefill, /link/i);
  assert.equal((await fetch(`${base}/api/shortcuts/share`, { method: 'POST', headers: sc(token), body: new FormData() })).status, 400);
});

test('ask: a short answer in the Siri chat; a long task says it will notify; waiting approvals say so', async () => {
  const { token, id } = await makeToken(['ask']);
  app.script.push(text('Sure! It is 72 degrees and sunny right now. Want the week ahead? Here is more.'));
  const r = await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(token), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'weather?' }) });
  assert.equal(r.status, 200);
  const said = await r.text();
  assert.match(said, /It is 72 degrees and sunny right now\.$/);
  assert.doesNotMatch(said, /week ahead/, 'at most two sentences');
  const conv = app.store.findChannelConversation('shortcuts', id)!;
  assert.equal(conv.title, 'Siri');
  assert.match(JSON.stringify(app.requests.at(-1)!.messages), /through Siri or an Apple Shortcut/);
  // Plain text body works too (Shortcuts: Request Body File = Provided Input).
  app.script.push(text('Hi.'));
  const plain = await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(token), 'content-type': 'text/plain' }, body: 'hello' });
  assert.equal(await plain.text(), 'Hi.');
  // Longer than the wait: \"I'm on it\", then a notification when it's done.
  app.script.push([{ type: 'tool_call', call: { id: 't1', name: 'slow_job', arguments: {} } }], text('All done with the slow job.'));
  const n = pushed.length;
  const late = await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(token), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text: 'do the slow job' }) });
  assert.equal(late.status, 202);
  const lj = await late.json();
  assert.equal(lj.later, true);
  assert.match(lj.url, new RegExp(`/#c=${conv.id}$`));
  await until(() => pushed.length > n);
  assert.match(pushed.at(-1)!.body, /All done/);
  assert.equal(pushed.at(-1)!.url, `/#c=${conv.id}`, 'the notification opens the Siri chat');
  // Nothing to ask.
  assert.equal((await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(token), 'content-type': 'application/json' }, body: '{"text":" "}' })).status, 400);
});

test('scopes, wrong tokens, rate limit and private local mode', async () => {
  const shareOnly = await makeToken(['share']);
  assert.equal((await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(shareOnly.token), 'content-type': 'application/json' }, body: '{"text":"hi"}' })).status, 403);
  const wrong = await fetch(`${base}/api/shortcuts/ask`, { method: 'POST', headers: { ...sc(`${SHORTCUT_TOKEN_PREFIX}nope.nope`), 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /not valid/);
  // No token, the owner token or a cookie: the Shortcuts routes are not for them.
  assert.equal((await fetch(`${base}/api/shortcuts/widget`)).status, 401);
  assert.equal((await fetch(`${base}/api/shortcuts/widget`, { headers: owner })).status, 404);
  const { token } = await makeToken(['ask']);
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await fetch(`${base}/api/shortcuts/widget`, { headers: sc(token) })).status;
  assert.equal(last, 429, 'the widget has a per-minute limit');
  const other = await makeToken(['ask']);
  setPrivateLocal(true);
  try {
    const r = await fetch(`${base}/api/shortcuts/widget`, { headers: sc(other.token) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Private local mode/);
  } finally {
    setPrivateLocal(false);
  }
});

test('widget: plain lines (next reminder, watches, what waits); badge count for the page', async () => {
  const { token } = await makeToken(['ask']);
  app.store.db.exec('DELETE FROM reminders');
  app.planner!.addReminder({ text: 'Water the plants', dueAt: new Date(clock.now.getTime() + 1800_000).toISOString() });
  (app as { liveWatches?: unknown }).liveWatches = { list: () => [{ state: 'active' }] };
  (app as { inbox?: unknown }).inbox = { list: () => [{ id: 1 }, { id: 2 }] };
  try {
    const r = await fetch(`${base}/api/shortcuts/widget`, { headers: sc(token) });
    assert.match(r.headers.get('content-type')!, /text\/plain/);
    const lines = (await r.text()).split('\n');
    assert.match(lines[0]!, /^Next: Water the plants, Sun 3:30/);
    assert.deepEqual(lines.slice(1), ['Watches on: 1', 'Waiting for you in Sara: 2']);
    assert.deepEqual((await (await fetch(`${base}/api/phone/badge`, { headers: owner })).json()).count, 2);
    assert.equal((await fetch(`${base}/api/phone/badge`)).status, 401);
    // Every web push carries the badge number.
    pushed.length = 0;
    const real = new PushService(app.store.db, app.vault, app.settings, { now: () => clock.now });
    real.badge = () => 2;
    assert.equal(typeof real.badge, 'function');
  } finally {
    delete (app as { liveWatches?: unknown }).liveWatches;
    delete (app as { inbox?: unknown }).inbox;
  }
  assert.ok(app.push!.badge, 'the server sets the badge count on the push service');
});

// ------------------------------------------------------------------ static wiring

test('page, service worker, strings and docs', () => {
  const html = read('web', 'index.html');
  assert.match(html, /data-page="co-shortcuts" data-group="Connections" data-title="iPhone Shortcuts"/);
  assert.match(html, /id="ph-install"/);
  assert.match(read('web', 'settings-nav.js'), /'co-phone', 'co-shortcuts'/);
  const sw = read('web', 'sw.js');
  assert.match(sw, /setAppBadge/);
  assert.match(sw, /sara-shell-v82/);
  const page = read('web', 'shortcuts-page.js');
  for (const path of ['/api/shortcuts/share', '/api/shortcuts/ask', '/api/shortcuts/widget']) assert.ok(page.includes(path), path);
  assert.match(page, /Bearer \$\{/);
  assert.doesNotMatch(page, /\?token=|[?&]t=\$\{/, 'tokens never in a URL');
  const app = read('web', 'app.js');
  assert.match(app, /initShortcutsPage\(/);
  assert.match(app, /refreshBadge/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = JSON.parse(read('web', 'i18n', `${lang}.json`)) as Record<string, string>;
    for (const k of ['iPhone Shortcuts', 'Make a token', 'Add Sara to your Home Screen', 'Waiting for you in Sara: {n}']) assert.ok(tr[k], `${lang}: ${k}`);
  }
  const doc = read('docs', 'IPHONE.md');
  assert.match(doc, /Import Questions|import questions/i);
  assert.match(doc, /not submitted|isn't submitted|not sent to the App Store/i);
});
