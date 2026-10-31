// Phase 90 (computer use CU4, docs/design/COMPUTER_USE.md §8 and §11 "Done when"): saved logins that
// live only on the owner's computer. The rules (exact current-origin match, look-alikes get nothing,
// no save without the ticked "I understand", names and sites only on the server), the reference hands
// filling a fixture login through her tools with a card every time, "Use what I just typed", the
// sign-in pause ("Your turn"), removal from the web Settings removing it on the device, and THE proof:
// the test password never appears in the hands channel (every frame both ways), the model's messages,
// the run steps or any file in the server's data folder, while the fixture site really received it.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { findBrowser } from '../src/browser.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { askedToSaveLogin, loginVerdict } from '../src/computer-policy.ts';
import { CU4_OPS, HANDS_OPS, HandsHub, loginViews, WAITING_DEADLINE_MS } from '../src/hands.ts';
import { cleanLoginName, loginOrigin, SAVE_LOGIN_WARNING, siteMatches, TestVault, type ConsentAnswer, type ConsentRequest } from '../src/hands-logins.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools, COMPUTER_TOOLS } from '../src/tools/computer.ts';
import { connectWebSocket } from '../src/ws.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date();
const browser = findBrowser();
const REAL = browser.found;
// An obviously fake test password, built in pieces (never a real one).
const PASSWORD = 'fake-' + 'pass-' + 'cu4-' + 'Zq7';
const USER = 'alex-' + 'test';
const HOST = 'accounts.sara.test';
const EVIL = 'accounts.sara.test.evil.test';

// ---- the fixture site: a sign-in form; POST /session says who signed in, and records what it got ----
let fixture: Server;
let fixture2: Server;
let P = 0;
let Q = 0;
const received: { host: string; body: string }[] = [];
function site(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const html = (title: string, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
  };
  if (req.method === 'POST' && url.pathname === '/session') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ host: String(req.headers.host ?? ''), body });
      const f = new URLSearchParams(body);
      if (f.get('password') === PASSWORD) html('Signed in', `<h1>Signed in (${f.get('username') === USER ? 'the right user' : 'someone else'})</h1>`);
      else html('Wrong', '<h1 role="alert">Wrong username or password</h1>');
    });
    return;
  }
  // "Type it like a person": the page itself fills and submits the form (what the person's own typing
  // looks like to the catcher); the values are in the page's script, never in its text.
  if (url.pathname === '/login')
    return html(
      'Sign in',
      `<h1>Sign in</h1><form method="post" action="/session">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form>
<button type="button" id="person">Type it like a person</button>
<script>document.getElementById('person').onclick=function(){var f=document.forms[0];f.username.value=${JSON.stringify(USER)};f.password.value=${JSON.stringify(PASSWORD)};f.requestSubmit();};</script>`,
    );
  html('Home', '<h1>Home</h1><a href="/login">Sign in</a>');
}
before(async () => {
  fixture = createServer(site);
  fixture2 = createServer(site);
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => fixture2.listen(0, '127.0.0.1', r));
  P = (fixture.address() as AddressInfo).port;
  Q = (fixture2.address() as AddressInfo).port;
});
after(() => {
  fixture.close();
  fixture2.close();
});

interface Env {
  app: TestApp;
  auth: OwnerAuth;
  token: string;
  server: Server;
  base: string;
  hub: HandsHub;
  dir: string;
  close: () => Promise<void>;
}
async function env(): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.runs = new RunStore(app.store.db, () => NOW);
  app.runs.settings = () => runSettings(app.settings.get());
  app.settings.update({ disclosureAcceptedAt: NOW.toISOString(), providers: [{ id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }], defaultProviderId: 'cloud', defaultModel: 'fake-large' });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    auth,
    token,
    server,
    base,
    hub,
    dir,
    close: async () => {
      hub.closeAll();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      app.store.close();
      cleanup();
    },
  };
}
async function api(e: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any>; text: string }> {
  const r = await fetch(e.base + path, { method, headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(t) as Record<string, any>;
  } catch {
    /* not json */
  }
  return { status: r.status, json, text: t };
}
async function pair(e: Env): Promise<{ token: string; id: string }> {
  const r = await api(e, 'POST', '/api/hands/pair', { name: 'Test PC', token: e.token });
  assert.equal(r.status, 200, r.text);
  return { token: r.json.token, id: r.json.id };
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every file under a folder, as bytes read as latin1 (the SQLite database and its WAL included). */
function allFiles(dir: string): string {
  let out = '';
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) out += allFiles(p);
    else if (st.size < 64 * 1024 * 1024) out += readFileSync(p).toString('latin1');
  }
  return out;
}

// ------------------------------------------------------------------------------------------------

test('the rules: exact current-origin match (look-alikes, http vs https, other ports get nothing), names, the warning, save only when asked', () => {
  const l = { sites: ['https://github.com'] };
  assert.equal(siteMatches(l, 'https://github.com/login?x=1'), true);
  assert.equal(siteMatches(l, 'https://GitHub.com:443/session'), true);
  for (const bad of ['https://github.com.evil.test/login', 'http://github.com/login', 'https://github.com:8443/login', 'https://www.github.com/login', 'https://evil.test/https://github.com', 'https://user:pw@github.com/', 'file:///C:/github.com', 'javascript:alert(1)', 'about:blank', '']) assert.equal(siteMatches(l, bad), false, bad);
  assert.equal(loginOrigin('HTTP://Example.TEST:80/a'), 'http://example.test');
  assert.equal(loginOrigin('http://example.test:8080/a'), 'http://example.test:8080');
  assert.equal(cleanLoginName('  Git\nHub  '), 'Git Hub');
  assert.match(SAVE_LOGIN_WARNING, /never on Sara's server, and she never sees it/);
  assert.match(SAVE_LOGIN_WARNING, /signing in yourself once and letting the Sara browser remember you is safer/);
  // A saved login asks every time, whatever the level.
  assert.deepEqual(loginVerdict().choices, ['once']);
  // She may only offer to save when the owner said so in so many words.
  for (const yes of ['save my GitHub login', 'Please remember the password for this site.', 'keep my sign-in for next time', 'can you store these credentials']) assert.equal(askedToSaveLogin(yes), true, yes);
  for (const no of ['sign me in to GitHub', 'log in and save the file', "don't save my password", 'what is my password', 'save the page as PDF']) assert.equal(askedToSaveLogin(no), false, no);
  // The device saves nothing without the ticked box.
  const v = new TestVault();
  assert.throws(() => v.save('http://s', 'https://github.com', { save: true, understood: false, username: 'a', password: 'b' }), /I understand/);
  assert.throws(() => v.save('http://s', 'https://github.com', { save: false, understood: true, username: 'a', password: 'b' }), /Cancel/);
  assert.equal(v.list('http://s').length, 0);
  const saved = v.save('http://s', 'https://github.com/login', { save: true, understood: true, name: 'GitHub', username: 'a', password: 'b' });
  assert.deepEqual(saved.sites, ['https://github.com']);
  assert.equal(JSON.stringify(v.list('http://s')).includes('"b"'), false, 'the list carries no password');
  // Another Sara paired on the same computer can't see or use it.
  assert.equal(v.list('http://other').length, 0);
  assert.equal(v.find('http://other', 'GitHub'), undefined);
  assert.equal(v.remove('http://s', 'github'), 1);
  // The protocol: the command set, the 10-minute ops, names and sites only from a hello.
  assert.ok(CU4_OPS.every((o) => (HANDS_OPS as readonly string[]).includes(o)));
  assert.equal(WAITING_DEADLINE_MS, 600_000);
  assert.deepEqual(loginViews([{ name: 'GitHub', sites: ['https://github.com', 'javascript:x'], username: 'alex', password: PASSWORD }, 'Old style', 7]), [
    { name: 'GitHub', sites: ['https://github.com'] },
    { name: 'Old style', sites: [] },
  ]);
  for (const t of ['pc_browser_login', 'pc_browser_save_login', 'pc_browser_your_turn']) assert.ok(COMPUTER_TOOLS.has(t), t);
});

test('protocol: hello and ev logins carry names and sites only; the consent window and Your turn get 10 minutes; Settings lists and removes through the device', async () => {
  const e = await env();
  const { token, id } = await pair(e);
  try {
    const ws = await connectWebSocket(`${e.base.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${token}` } });
    const reqs: Record<string, any>[] = [];
    let logins = [{ name: 'GitHub', sites: ['https://github.com'], created: NOW.toISOString() }];
    ws.onMessage = (d) => {
      const m = JSON.parse(String(d)) as Record<string, any>;
      if (m.t !== 'req') return;
      reqs.push(m);
      if (m.op === 'b.logins') ws.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result: { logins } }));
      else if (m.op === 'b.forgetLogin') {
        const n = logins.filter((l) => m.args.all || l.name === m.args.name).length;
        logins = logins.filter((l) => !(m.args.all || l.name === m.args.name));
        ws.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result: { removed: n, logins } }));
        ws.send(JSON.stringify({ t: 'ev', kind: 'logins', logins }));
      } else ws.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result: { outcome: 'cancelled' } }));
    };
    // A device that (wrongly) sends more than names and sites: the server keeps names and sites only.
    ws.send(JSON.stringify({ t: 'hello', v: 1, app: 'fake 4', optIn: { browser: true, desktop: false }, ops: [...HANDS_OPS], logins: [{ name: 'GitHub', sites: ['https://github.com'], username: USER, password: PASSWORD }], vault: { kind: 'test', verify: false } }));
    await until(() => Boolean(e.hub.hello(id)));
    const view = e.hub.devices().find((d) => d.id === id)!;
    assert.deepEqual(view.logins, [{ name: 'GitHub', sites: ['https://github.com'] }]);
    assert.deepEqual(view.vault, { kind: 'test', verify: false });
    const listed = await api(e, 'GET', '/api/hands');
    assert.ok(!listed.text.includes(PASSWORD) && !listed.text.includes(USER), 'GET /api/hands never shows a username or password');
    // The waiting ops get 10 minutes.
    await e.hub.request(id, 'b.saveLogin', { name: 'x' });
    assert.equal(reqs.find((r) => r.op === 'b.saveLogin')?.deadlineMs, 600_000);
    // Settings: the computer lists its logins, and removes one when asked (then tells the server).
    const g = await api(e, 'GET', `/api/hands/${id}/logins`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.logins.map((l: { name: string }) => l.name), ['GitHub']);
    const rm = await api(e, 'DELETE', `/api/hands/${id}/logins/${encodeURIComponent('GitHub')}`);
    assert.equal(rm.json.ok, true);
    assert.equal(rm.json.removed, 1);
    assert.deepEqual(reqs.find((r) => r.op === 'b.forgetLogin')?.args, { name: 'GitHub' });
    await until(() => (e.hub.devices().find((d) => d.id === id)?.logins ?? []).length === 0);
    const all = await api(e, 'DELETE', `/api/hands/${id}/logins`);
    assert.deepEqual(reqs.filter((r) => r.op === 'b.forgetLogin').at(-1)?.args, { all: true });
    assert.equal(all.json.ok, true);
    ws.close(1000, 'bye');
    await until(() => !e.hub.connected(id));
    const off = await api(e, 'GET', `/api/hands/${id}/logins`);
    assert.equal(off.json.connected, false);
  } finally {
    await e.close();
  }
});

test('the reference hands: save (not without the tick), sign in with a card every time, look-alikes get nothing, Use what I just typed, Your turn, removal from Settings; the password never leaves the computer', { skip: !REAL && 'no Chromium-family browser here' }, async () => {
  const e = await env();
  const { token, id } = await pair(e);
  const answers: ConsentAnswer[] = [];
  const asked: ConsentRequest[] = [];
  const vault = new TestVault([{ name: 'Https only', sites: [`https://${HOST}:${P}`], username: USER, password: PASSWORD, server: new URL(e.base).origin, created: NOW.toISOString() }]);
  const ref = new HandsRef({
    server: e.base,
    token,
    name: 'Test PC',
    info: browser,
    vault,
    recordWire: true,
    consent: async (req) => {
      asked.push(req);
      return answers.shift() ?? { save: false, understood: false };
    },
    // Look-alike sites for the test, all served by the fixture on this computer.
    browserArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${EVIL} 127.0.0.1`],
  });
  const real = `http://${HOST}:${P}`;
  const turn = async (conv: string, owner: string, decide: (ev: Extract<ChatEvent, { type: 'approval' }>) => boolean = () => true) => {
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(e.app, conv, owner)) {
      evs.push(ev);
      if (ev.type === 'approval') e.app.approvals.decide(ev.approvalId, decide(ev));
    }
    return { evs, cards: evs.filter((x): x is Extract<ChatEvent, { type: 'approval' }> => x.type === 'approval'), results: evs.filter((x): x is Extract<ChatEvent, { type: 'tool_result' }> => x.type === 'tool_result') };
  };
  try {
    await ref.start();
    await until(() => Boolean(e.hub.hello(id)), 10_000);
    assert.ok(CU4_OPS.every((o) => e.hub.hello(id)!.ops!.includes(o)));
    const conv = e.app.store.createConversation({ title: 'Logins', mode: 'coding' }).id;
    received.length = 0;

    // 1. Saving: she may offer; the consent window decides. Without the tick nothing is saved.
    answers.push({ save: true, understood: false, name: 'Sara Test', username: USER, password: PASSWORD });
    e.app.script.push([call('a1', 'pc_browser_open', { url: `${real}/login` })], [call('a2', 'pc_browser_save_login', { name: 'Sara Test' })], text('Not saved.'));
    const t1 = await turn(conv, `open ${real}/login and save my login there as "Sara Test"`);
    assert.match(t1.results[1].output, /Nothing was saved .*I understand/);
    assert.equal(vault.find(new URL(e.base).origin, 'Sara Test'), undefined);
    assert.equal(asked[0].site, real);
    assert.ok(asked[0].warning.includes(`sign in to ${real} for you on this computer`));
    // With the tick: saved, and the server hears the name and site only.
    answers.push({ save: true, understood: true, name: 'Sara Test', username: USER, password: PASSWORD });
    e.app.script.push([call('b1', 'pc_browser_save_login', { name: 'Sara Test' })], text('Saved.'));
    const t2 = await turn(conv, 'save my login again please, I ticked the box this time');
    assert.match(t2.results[0].output, /The owner saved the login “Sara Test” for http:\/\/accounts\.sara\.test:\d+/);
    await until(() => (e.hub.devices().find((d) => d.id === id)?.logins ?? []).some((l) => l.name === 'Sara Test'));
    assert.deepEqual(e.hub.devices().find((d) => d.id === id)!.logins!.find((l) => l.name === 'Sara Test'), { name: 'Sara Test', sites: [real] });
    // Not asked in so many words: she can't even open the window.
    e.app.script.push([call('c1', 'pc_browser_save_login', {})], text('I can only do that when you ask.'));
    const t3 = await turn(conv, 'thanks, that page looks nice');
    assert.match(t3.results[0].output, /Only when the owner asks in so many words/);
    assert.equal(asked.length, 2);

    // 2. Signing in: a card every time (even at Always allowed), filled on the device, signed in.
    e.app.settings.update({ computerUse: { ...e.app.settings.get().computerUse, level: 'always', alwaysWarned: true } });
    e.app.script.push([call('d1', 'pc_browser_open', { url: `${real}/login` })], [call('d2', 'pc_browser_login', { login: 'Sara Test' })], [call('d3', 'pc_browser_look', {})], text('You are signed in.'));
    const t4 = await turn(conv, `sign me in at ${real}/login`);
    assert.equal(t4.cards.length, 1, 'a saved login asks every time, even with Always allowed');
    const card = t4.cards[0].computer!;
    assert.equal(card.action, 'login');
    assert.equal(card.risk, 'login');
    assert.equal(card.name, 'Sara Test');
    assert.deepEqual(card.choices, ['once']);
    assert.match(t4.cards[0].summary, /sign in to accounts\.sara\.test:\d+ with your saved “Sara Test” login/);
    assert.match(t4.results[1].output, /Filled the saved “Sara Test” login on Test PC and pressed Enter/);
    assert.match(t4.results[2].output, /Signed in \(the right user\)/);
    assert.equal(received.length, 1);
    assert.equal(received[0].host, `${HOST}:${P}`);
    assert.ok(received[0].body.includes(encodeURIComponent(PASSWORD)), 'the real site got the password (positive control)');
    // Don't on the card: nothing is filled.
    e.app.script.push([call('e1', 'pc_browser_open', { url: `${real}/login` })], [call('e2', 'pc_browser_login', { login: 'Sara Test' })], text('OK, I did not.'));
    const t5 = await turn(conv, `sign me in at ${real}/login`, () => false);
    assert.equal(t5.cards.length, 1);
    assert.equal(t5.results[1].status, 'denied');
    assert.equal(received.length, 1);

    // 3. Look-alikes get nothing, on the device itself (the server checks too, but the device decides).
    const op = async (name: string, args: Record<string, unknown> = {}) => {
      await sleep(260);
      return e.hub.request(id, name, args).then((r) => r.result, (err: Error & { code?: string }) => ({ error: err.code, message: err.message }) as Record<string, any>);
    };
    for (const url of [`http://${EVIL}:${P}/login`, `http://${HOST}:${Q}/login`, `http://127.0.0.1:${P}/login`, `http://localhost:${P}/login`]) {
      await op('b.open', { url });
      const r = await op('b.login', { name: 'Sara Test' });
      assert.equal(r.outcome, 'site_mismatch', url);
      assert.equal(JSON.stringify(r).includes(PASSWORD), false);
    }
    // http where only https was saved:
    await op('b.open', { url: `${real}/login` });
    assert.equal((await op('b.login', { name: 'Https only' })).outcome, 'site_mismatch');
    assert.equal((await op('b.login', { name: 'Nobody' })).outcome, 'not_found');
    assert.equal(received.length, 1, 'no look-alike got a sign-in');
    // The server refuses before a card on a look-alike (no pointless card).
    e.app.script.push([call('f1', 'pc_browser_open', { url: `http://${EVIL}:${P}/login` })], [call('f2', 'pc_browser_login', { login: 'Sara Test' })], text('Not that site.'));
    const t6 = await turn(conv, `open http://${EVIL}:${P}/login and sign in`);
    assert.equal(t6.cards.length, 0);
    assert.match(t6.results[1].output, /only for http:\/\/accounts\.sara\.test:\d+/);
    // She never types a password key by key either.
    await op('b.open', { url: `${real}/login` });
    await op('b.type', { text: 'Username', field: true, value: 'someone' });
    await op('b.keys', { combo: 'Tab' });
    const k = await op('b.keys', { combo: 'x' });
    assert.equal(k.error, 'denied_local', JSON.stringify(k));

    // 4. "Use what I just typed": the person signs in once; the device caught it (memory only).
    await op('b.open', { url: `${real}/login` });
    await op('b.click', { text: 'Type it like a person' });
    await until(() => received.length === 2);
    answers.push({ save: true, understood: true, useTyped: true, name: 'Typed' });
    const st = await op('b.saveLogin', { name: 'Typed' });
    assert.equal(st.outcome, 'saved', JSON.stringify(st));
    assert.equal(asked.at(-1)!.canUseTyped, true);
    assert.equal(vault.find(new URL(e.base).origin, 'Typed')?.password, PASSWORD);
    await op('b.open', { url: `${real}/login` });
    assert.equal((await op('b.login', { name: 'Typed' })).outcome, 'filled');
    await until(() => received.length === 3);

    // 5. Your turn: the person signs in themselves; she waits for Continue.
    const timer = setInterval(() => {
      if (ref.yourTurn) ref.continueTurn();
    }, 50);
    try {
      e.app.script.push([call('g1', 'pc_browser_your_turn', { what: 'sign in to the test site' })], text('Thanks.'));
      const t7 = await turn(conv, 'I will sign in myself, wait for me');
      assert.match(t7.results[0].output, /The owner pressed Continue on Test PC/);
    } finally {
      clearInterval(timer);
    }

    // 6. Removing from the web Settings removes it on the device.
    const g = await api(e, 'GET', `/api/hands/${id}/logins`);
    assert.deepEqual(g.json.logins.map((l: { name: string }) => l.name).sort(), ['Https only', 'Sara Test', 'Typed']);
    assert.ok(!g.text.includes(PASSWORD) && !g.text.includes(USER));
    const rm = await api(e, 'DELETE', `/api/hands/${id}/logins/${encodeURIComponent('Sara Test')}`);
    assert.equal(rm.json.removed, 1);
    assert.equal(vault.find(new URL(e.base).origin, 'Sara Test'), undefined);
    await until(() => !(e.hub.devices().find((d) => d.id === id)?.logins ?? []).some((l) => l.name === 'Sara Test'));
    await api(e, 'DELETE', `/api/hands/${id}/logins`);
    assert.equal(vault.list(new URL(e.base).origin).length, 0);
    assert.equal(vault.hasPassword(PASSWORD), false);

    // THE PROOF. The test password reached the real site (above) but never: the hands channel (every
    // frame both ways), any model message, a run step, the conversation, or any file of the server.
    const wire = ref.wire.join('\n');
    assert.ok(wire.includes('"op":"b.login"') && wire.includes('"op":"b.saveLogin"') && wire.length > 10_000, 'the capture saw the traffic');
    assert.equal(wire.includes(PASSWORD), false, 'the hands channel never carried the password');
    assert.equal(wire.includes(USER), false, 'nor the username');
    assert.equal(JSON.stringify(e.app.requests).includes(PASSWORD), false, 'no model message has it');
    const runs = e.app.runs!.list({ conversationId: conv });
    assert.ok(runs.length >= 5);
    assert.equal(JSON.stringify(runs.map((r) => e.app.runs!.steps(r.id))).includes(PASSWORD), false, 'no run step has it');
    assert.equal(JSON.stringify(e.app.store.messages(conv)).includes(PASSWORD), false);
    const files = allFiles(e.dir);
    assert.ok(files.length > 10_000);
    assert.equal(files.includes(PASSWORD), false, 'no file of the server (database, logs) has it');
  } finally {
    await ref.stop();
    await e.close();
  }
});

test('the page, the apps and the conformance script know saved logins', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  for (const id of ['cu-logins', 'cu-logins-list', 'cu-verify', 'cu-this-logins']) assert.match(html, new RegExp(`id="${id}"`), id);
  const page = html.slice(html.indexOf('data-page="co-computer"'), html.indexOf('</section>', html.indexOf('data-page="co-computer"')));
  assert.ok(!/style=/.test(page));
  assert.match(page, /id="cu-verify"[\s\S]{0,300}class="tip"/);
  assert.match(page, /Saved logins <button type="button" class="tip"/);
  const app = web('app.js');
  assert.match(app, /wants to sign in to \{site\} with your saved “\{login\}” login/);
  assert.match(app, /loginsList/);
  assert.match(app, /\/logins\/\$\{encodeURIComponent\(l\.name\)\}/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v24'\)/);
  assert.match(web('sw.js'), /Phase 89 had caches\.open\('sara-shell-v23'\)/);
  assert.match(web('help.html'), /Use what I just typed/);
  for (const f of ['desktop/windows/src/hands.cpp', 'desktop/mac/Sources/Hands.swift']) {
    const code = readFileSync(join(ROOT, f), 'utf8');
    for (const o of CU4_OPS) assert.ok(code.includes(`"${o}"`), `${f}: ${o}`);
    assert.ok(code.includes('I understand'), `${f}: the tick`);
    assert.ok(code.includes("Saving this password lets Sara sign in to"), `${f}: the warning`);
    assert.ok(code.includes('Use what I just typed'), `${f}: use what I just typed`);
  }
  assert.match(readFileSync(join(ROOT, 'desktop/windows/src/hands.cpp'), 'utf8'), /CryptProtectData[\s\S]*Sara logins/);
  assert.match(readFileSync(join(ROOT, 'desktop/mac/Sources/Hands.swift'), 'utf8'), /kSecAttrAccessibleWhenUnlockedThisDeviceOnly[\s\S]*Sara logins|Sara logins[\s\S]*kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  const conf = readFileSync(join(ROOT, 'scripts', 'hands-conformance.ts'), 'utf8');
  assert.match(conf, /CU4/);
  assert.match(conf, /site_mismatch/);
  assert.ok(existsSync(join(ROOT, 'scripts', 'hands-capture.ts')));
});
