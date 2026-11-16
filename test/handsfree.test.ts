// HANDSFREE (docs/desktop.md → Hands-free): "Let her finish this task", and the robustness fixes for
// smaller models (stale refs, scrolling without a ref, tab ids, made-up tool names). A fake computer
// answers over the real hands socket; nothing here touches a real browser or desktop.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { accountHard, actionVerdict, desktopActionVerdict, navigationVerdict, ownBrowserPage, type ActFacts } from '../src/computer-policy.ts';
import { HANDS_OPS, HandsHub } from '../src/hands.ts';
import { HandsFree, handsFreeMs, saysGoAhead } from '../src/handsfree.ts';
import { createSaraServer } from '../src/server.ts';
import { toolAlias } from '../src/tool-alias.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { APPROVAL_HOWS, ApprovalBroker } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { connectWebSocket } from '../src/ws.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date();
const base = (over: Partial<ActFacts> = {}): ActFacts => ({ kind: 'click', site: 'accounts.google.com', target: { role: 'button', name: 'Next' }, page: { url: 'https://accounts.google.com/signin', title: 'Sign in - Google Accounts' }, level: 'task', taskSites: new Set(), always: [], ...over });

test('policy: hands-free lets everything below the hard limits go ahead; the hard limits stay', () => {
  // Without hands-free: the first action asks, and the card offers "Let her finish this task".
  const first = actionVerdict(base({ offerFree: true }));
  assert.equal(first.act, 'ask');
  assert.ok(first.act === 'ask' && first.choices.includes('free'));
  assert.ok(first.act === 'ask' && !actionVerdict(base()).act.includes('x') && !(actionVerdict(base()) as { choices: string[] }).choices.includes('free'), 'no free choice unless offered');
  // Hands-free: no card on any site, for clicks, typing, sending.
  for (const f of [base(), base({ site: 'console.cloud.google.com', page: { url: 'https://console.cloud.google.com/apis/credentials/consent', title: 'OAuth consent screen' } }), base({ kind: 'type', target: { role: 'textbox', name: 'App name' } }), base({ target: { role: 'button', name: 'Publish app' } })]) assert.equal(actionVerdict({ ...f, handsFree: true }).act, 'allow', f.page.url);
  // Account and security words that aren't hard ask once per task (no longer every click).
  const consent = actionVerdict(base({ target: { role: 'button', name: 'Save' }, page: { url: 'https://console.cloud.google.com/apis/credentials/consent', title: 'OAuth consent screen - privacy settings' }, offerFree: true }));
  assert.equal(consent.act, 'ask');
  assert.deepEqual(consent.act === 'ask' && consent.choices, ['once', 'task', 'free']);
  assert.equal(actionVerdict(base({ target: { role: 'button', name: 'Revoke access tokens' }, taskSites: new Set(['accounts.google.com']) })).act, 'allow', 'once per task');
  // The hard limits, even hands-free: payments, passwords/2FA/recovery, password fields, secret text.
  for (const name of ['Pay now', 'Place order', 'Buy']) assert.deepEqual(actionVerdict(base({ handsFree: true, target: { role: 'button', name } })), { act: 'ask', risk: 'payment', why: 'a payment or purchase (asks every time)', choices: ['once'] });
  for (const name of ['Change password', 'Turn on 2-Step Verification', 'Recovery email', 'Delete account', 'Backup codes']) {
    const v = actionVerdict(base({ handsFree: true, target: { role: 'button', name } }));
    assert.equal(v.act, 'ask', name);
    assert.deepEqual(v.act === 'ask' && v.choices, ['once'], name);
  }
  assert.ok(accountHard(base({ target: { role: 'button', name: 'Save' }, page: { url: 'https://myaccount.google.com/signinoptions/two-step-verification', title: 'Security' } })));
  assert.equal(actionVerdict(base({ handsFree: true, kind: 'type', target: { role: 'textbox', secret: true } })).act, 'block');
  assert.equal(actionVerdict(base({ handsFree: true, kind: 'type', target: { role: 'textbox', name: 'Notes' }, text: 'sk-' + 'x'.repeat(24) })).act, 'block');
  // Opening a site she wasn't told about: no card hands-free; private conversations still only localhost.
  const nav = { ownerText: 'set up my calendar', granted: new Set<string>(), localOnly: false, jobPort: () => false };
  assert.equal(navigationVerdict('https://console.cloud.google.com/', nav).act, 'ask');
  assert.equal(navigationVerdict('https://console.cloud.google.com/', { ...nav, handsFree: true }).act, 'allow');
  assert.equal(navigationVerdict('https://console.cloud.google.com/', { ...nav, handsFree: true, localOnly: true }).act, 'block');
  // The person's own browser: Google sign-in and account pages ask once per task hands-free; payments and passwords every time.
  assert.equal(ownBrowserPage('Sign in - Google Accounts', 'accounts.google.com/v3/signin').act, 'once');
  assert.equal(ownBrowserPage('Sign in - Google Accounts', 'accounts.google.com/v3/signin', '', true).act, 'level');
  assert.equal(ownBrowserPage('Google Cloud console', 'console.cloud.google.com/auth/clients', '', true).act, 'level');
  assert.equal(ownBrowserPage('Checkout', 'shop.example/checkout', '', true).act, 'once');
  assert.equal(ownBrowserPage('Password Manager', 'passwords.google.com', '', true).act, 'once');
  assert.equal(ownBrowserPage('x', 'edge://settings/passwords', '', true).act, 'block');
  // Desktop: hands-free allows normal and account words except passwords; never at "ask every time"; blocks stay.
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'Calendar settings' }, level: 'task', handsFree: true }).act, 'allow');
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'Account' }, level: 'task', handsFree: true }).act, 'allow');
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'Change password' }, level: 'task', handsFree: true }).act, 'ask');
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'Buy' }, level: 'task', handsFree: true }).act, 'ask');
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'OK', elevated: true }, level: 'task', handsFree: true }).act, 'block');
  assert.equal(desktopActionVerdict({ site: 'd', target: { name: 'Next' }, level: 'ask', handsFree: true }).act, 'ask');
  // The card's new answer runs the action.
  assert.ok(APPROVAL_HOWS.includes('free'));
  const b = new ApprovalBroker();
  const r = b.request('c', new AbortController().signal);
  b.decide(r.id, false, 'free');
  return r.decision.then((ok) => assert.equal(ok, true));
});

test('go-ahead words in six languages, and not the opposite', () => {
  for (const s of ['Set up Google Calendar for me, just do it', 'connect my calendar, you have my ok', 'do it yourself, don\u2019t ask me', 'hands-free please', 'hazlo tú, sin preguntarme', 'fais-le sans demander', 'mach es einfach', 'faz isso sem perguntar', 'fallo tu senza chiedere']) assert.ok(saysGoAhead(s), s);
  for (const s of ['set up my calendar', 'ask me first before each step', "don't just do it", 'can you do it?']) assert.ok(!saysGoAhead(s), s);
});

test('the hands-free state: start, renew, steps, the time running out, stop, takeover', () => {
  const hf = new HandsFree();
  let now = 1_000_000;
  hf.now = () => now;
  const ended: string[] = [];
  hf.onEnd = (s) => ended.push(`${s.conversationId}:${s.ended?.why}`);
  const s = hf.start('c1', { ms: handsFreeMs('15m'), by: 'words' });
  assert.equal(s.until - now, 15 * 60_000);
  assert.equal(handsFreeMs('stop'), 8 * 3600_000);
  assert.equal(handsFreeMs(undefined), 3600_000);
  hf.step('c1', 'opened https://calendar.google.com/');
  hf.step('c1', 'click: clicking the button \u201cSettings\u201d', 'calendar.google.com');
  now += 60_000;
  const again = hf.start('c1', { ms: handsFreeMs('15m'), by: 'card' });
  assert.equal(again.task, s.task, 'a renewal keeps the same stretch (and the computer\u2019s grant)');
  assert.equal(again.steps.length, 2);
  assert.equal(hf.view('c1').active, true);
  assert.equal(hf.view('c1').steps[1].where, 'calendar.google.com');
  now += 16 * 60_000;
  assert.equal(hf.active('c1'), undefined, 'the time ran out');
  assert.deepEqual(ended, ['c1:time']);
  assert.equal(hf.view('c1').ended?.why, 'time');
  assert.equal(hf.view('c1').steps.length, 2, 'the log stays for after');
  hf.start('c2', { ms: 3600_000, by: 'card' });
  assert.equal(hf.stop('c2', 'you'), true);
  assert.equal(hf.stop('c2', 'you'), false);
  hf.start('c3', { ms: 3600_000, by: 'card' });
  assert.equal(hf.stopWhere((id) => id === 'c3', 'takeover'), 1);
  assert.deepEqual(ended, ['c1:time', 'c2:you', 'c3:takeover']);
});

test('made-up tool names: close ones run the right tool with a note, others list the real ones', () => {
  const offered = ['pc_browser_read', 'pc_browser_look', 'pc_browser_scroll', 'pc_look', 'pc_scroll', 'pc_my_tabs', 'mail_search'];
  const a = toolAlias('pc_read_text', offered);
  assert.ok(a && 'note' in a && a.name === 'pc_browser_read');
  assert.match((a as { note: string }).note, /no tool "pc_read_text".*pc_browser_read/);
  const s = toolAlias('pc_browser_scroll_down', offered, { tab: 't1' });
  assert.deepEqual(s && 'args' in s && s.args, { direction: 'down', tab: 't1' });
  assert.equal((toolAlias('pc_browser_lok', offered) as { name: string }).name, 'pc_browser_look', 'a typo');
  const h = toolAlias('pc_do_magic', offered);
  assert.ok(h && 'hint' in h && /pc_browser_read, pc_browser_look/.test(h.hint));
  assert.equal(toolAlias('pc_look', offered), undefined, 'a real name is left alone');
  assert.equal(toolAlias('weather_now', offered), undefined, 'no family offered: no guess');
  assert.equal(toolAlias('mail_serch', ['mail_search', 'pc_look']) && (toolAlias('mail_serch', ['mail_search', 'pc_look']) as { name: string }).name, 'mail_search');
});

test('a made-up tool name in a real turn runs the right tool and says so', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: NOW.toISOString() } as never);
    let ran = 0;
    const fake: Tool = { defaultPermission: 'auto', spec: { name: 'notes_read', description: 'Read the notes (test).', parameters: { type: 'object', properties: {} } }, summarize: () => 'read notes', async run() { ran++; return 'the notes say hi'; } };
    app.tools.add(fake);
    const conv = app.store.createConversation({ title: 't' });
    app.script.push([call('c1', 'notes_reed', {})], text('done'));
    for await (const _ of runTurn(app, conv.id, 'read the notes please')) void _;
    const tool = app.store.messages(conv.id).find((m) => m.role === 'tool');
    assert.ok(app.requests.some((r) => (r.tools ?? []).some((t) => t.name === "notes_read")), "offered");
    assert.equal(ran, 1);
    assert.match(String(tool?.content), /no tool "notes_reed"; this ran notes_read instead/);
    assert.match(String(tool?.content), /the notes say hi/);
  } finally {
    app.store.close();
    cleanup();
  }
});

// ---- a fake computer over the real hands socket ----
interface Env {
  app: TestApp;
  hub: HandsHub;
  tools: Map<string, Tool>;
  ops: { op: string; args: Record<string, any> }[];
  answer: (fn: (op: string, args: Record<string, any>) => { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }) => void;
  conv: string;
  ws: { send: (s: string) => void };
  base: string;
  token: string;
  close: () => Promise<void>;
}
async function env(message: string, settings: Record<string, unknown> = {}): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.settings.update({ disclosureAcceptedAt: NOW.toISOString(), ...settings });
  const list = createComputerTools(app);
  for (const t of list) app.tools.add(t);
  const server: Server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const paired = await (await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test PC', token }) })).json() as { token: string; id: string };
  const ws = await connectWebSocket(`${base.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${paired.token}` } });
  const ops: Env['ops'] = [];
  let handler: Parameters<Env['answer']>[0] = () => ({ ok: true, result: {} });
  ws.onMessage = (d) => {
    const m = JSON.parse(String(d)) as Record<string, any>;
    if (m.t !== 'req') return;
    ops.push({ op: m.op, args: m.args ?? {} });
    const r = handler(m.op, m.args ?? {});
    ws.send(JSON.stringify({ t: 'res', id: m.id, ...r }));
  };
  ws.send(JSON.stringify({ t: 'hello', v: 1, app: 'fake 3', optIn: { browser: true, desktop: true }, ops: [...HANDS_OPS], approvalsHere: true, takeover: 'pause' }));
  const end = Date.now() + 5000;
  while (!hub.hello(paired.id)) {
    if (Date.now() > end) throw new Error('no hello');
    await new Promise((r) => setTimeout(r, 20));
  }
  const conv = app.store.createConversation({ title: 'Calendar' });
  app.store.addMessage(conv.id, 'user', message);
  return {
    app, hub, ops, conv: conv.id, base, token, ws,
    tools: new Map(list.map((t) => [t.spec.name, t])),
    answer: (fn) => (handler = fn),
    close: async () => {
      hub.closeAll();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      app.store.close();
      cleanup();
    },
  };
}
const ctxOf = (e: Env) => ({ signal: new AbortController().signal, conversationId: e.conv, recordThumb: () => {}, attachProof: () => {} }) as never;
const page = (url: string, title: string) => ({ url, title });
const snapshot = (items: Record<string, unknown>[], url = 'https://calendar.google.com/calendar/r/settings', title = 'Google Calendar - Settings') => ({ ok: true, result: { title, url, items, total: items.length } });

test('hands-free from the go-ahead words: no cards across Google hosts; payments still ask; the step log', async () => {
  const e = await env('Set up Google Calendar for me, just do it');
  try {
    const where = { url: 'https://accounts.google.com/signin', title: 'Sign in - Google Accounts' };
    e.answer((op, a) => {
      if (op === 'b.snapshot') return snapshot([{ ref: 'e1', role: 'button', name: 'Next' }, { ref: 'e2', role: 'button', name: 'Pay now' }], where.url, where.title);
      if (op === 'b.find') return { ok: true, result: { found: true, role: 'button', name: a.ref === 'e2' ? 'Pay now' : 'Next', page: page(where.url, where.title) } };
      if (op === 'b.click') return { ok: true, result: { target: { role: 'button', name: 'Next' }, state: { url: where.url } } };
      return { ok: true, result: {} };
    });
    const look = e.tools.get('pc_browser_look')!;
    const click = e.tools.get('pc_browser_click')!;
    await look.run({}, ctxOf(e));
    for (const [url, title] of [['https://accounts.google.com/signin', 'Sign in - Google Accounts'], ['https://console.cloud.google.com/apis/credentials/consent', 'OAuth consent screen'], ['https://calendar.google.com/calendar/r/settings', 'Settings']]) {
      where.url = url;
      where.title = title;
      const args = { ref: 'e1' };
      const p = await click.prepare!(args, ctxOf(e));
      assert.deepEqual(p, {}, `no card on ${url}`);
      await click.run(args, ctxOf(e));
    }
    const pay = await click.prepare!({ ref: 'e2' }, ctxOf(e));
    assert.equal(pay.ask, true, 'a payment still asks');
    assert.deepEqual(pay.computer?.choices, ['once']);
    const view = e.hub.handsFree.view(e.conv);
    assert.equal(view.active, true);
    assert.equal(view.by, 'words');
    assert.equal(view.steps.length, 3);
    // The route shows it and Stop ends it.
    const got = await (await fetch(`${e.base}/api/computer/handsfree/${e.conv}`, { headers: { authorization: `Bearer ${e.token}` } })).json() as { active: boolean; steps: unknown[] };
    assert.equal(got.active, true);
    assert.equal(got.steps.length, 3);
    const stopped = await (await fetch(`${e.base}/api/computer/handsfree/${e.conv}`, { method: 'DELETE', headers: { authorization: `Bearer ${e.token}` } })).json() as { active: boolean; ended: { why: string } };
    assert.equal(stopped.active, false);
    assert.equal(stopped.ended.why, 'you');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(e.ops.some((o) => o.op === 'c.endTask' && typeof o.args.endHandsFree === 'string'), 'the computer drops its grant');
  } finally {
    await e.close();
  }
});

test('the first card offers "Let her finish this task"; choosing it covers every later site; Ask before each step offers nothing', async () => {
  const e = await env('connect my calendar');
  try {
    let url = 'https://calendar.google.com/calendar/r';
    e.answer((op) => {
      if (op === 'b.snapshot') return snapshot([{ ref: 'e1', role: 'button', name: 'Settings' }], url);
      if (op === 'b.find') return { ok: true, result: { found: true, role: 'button', name: 'Settings', page: page(url, 'Google Calendar') } };
      return { ok: true, result: {} };
    });
    const click = e.tools.get('pc_browser_click')!;
    await e.tools.get('pc_browser_look')!.run({}, ctxOf(e));
    const p = await click.prepare!({ ref: 'e1' }, ctxOf(e));
    assert.equal(p.ask, true);
    assert.ok(p.computer?.choices.includes('free'));
    p.answered!(true, 'free');
    url = 'https://console.cloud.google.com/';
    assert.deepEqual(await click.prepare!({ ref: 'e1' }, ctxOf(e)), {}, 'another host: no card');
    assert.equal(e.hub.handsFree.view(e.conv).by, 'card');
    // The person takes over on the computer: hands-free ends.
    e.hub.claim(e.hub.devices()[0].id, e.conv);
    e.ws.send(JSON.stringify({ t: 'ev', kind: 'takeover' }));
    const end = Date.now() + 3000;
    while (e.hub.handsFree.view(e.conv).active && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.hub.handsFree.view(e.conv).ended?.why, 'takeover');
  } finally {
    await e.close();
  }
  const s = await env('connect my calendar, just do it', { computerUse: { approvals: 'step' } });
  try {
    s.answer((op) => (op === 'b.find' ? { ok: true, result: { found: true, role: 'button', name: 'Settings', page: page('https://calendar.google.com/', 'Calendar') } } : op === 'b.snapshot' ? snapshot([{ ref: 'e1', role: 'button', name: 'Settings' }]) : { ok: true, result: {} }));
    await s.tools.get('pc_browser_look')!.run({}, ctxOf(s));
    const p = await s.tools.get('pc_browser_click')!.prepare!({ ref: 'e1' }, ctxOf(s));
    assert.equal(p.ask, true, 'ask before each step: even the go-ahead words ask');
    assert.ok(!p.computer?.choices.includes('free'));
  } finally {
    await s.close();
  }
});

test('stale refs: she looks again once and acts on the same element (role + name); read falls back to the page', async () => {
  const e = await env('just do it');
  try {
    let looks = 0;
    e.answer((op, a) => {
      if (op === 'b.snapshot') {
        looks++;
        return snapshot(looks === 1 ? [{ ref: 'e177', role: 'button', name: 'Integrate calendar' }] : [{ ref: 'e3', role: 'link', name: 'Help' }, { ref: 'e181', role: 'button', name: 'Integrate calendar' }]);
      }
      if (op === 'b.find') return a.ref === 'e177' ? { ok: true, result: { found: false, stale: true, error: 'There is no e177 on the page now: look again.' } } : { ok: true, result: { found: true, role: 'button', name: 'Integrate calendar', page: page('https://calendar.google.com/', 'Settings') } };
      if (op === 'b.click') return { ok: true, result: { target: { role: 'button', name: 'Integrate calendar' }, state: { url: 'https://calendar.google.com/' } } };
      if (op === 'b.read') return a.ref ? { ok: false, error: { code: 'not_found', message: `No element ${a.ref} on the page now.` } } : { ok: true, result: { title: 'Settings', url: 'https://calendar.google.com/', text: 'Secret address in iCal format' } };
      return { ok: true, result: {} };
    });
    await e.tools.get('pc_browser_look')!.run({}, ctxOf(e));
    const args: Record<string, unknown> = { ref: 'e177' };
    const click = e.tools.get('pc_browser_click')!;
    assert.deepEqual(await click.prepare!(args, ctxOf(e)), {});
    assert.equal(args.ref, 'e181');
    const out = await click.run(args, ctxOf(e));
    assert.match(String(out), /looked again and acted on the same element, now e181/);
    assert.equal(e.ops.filter((o) => o.op === 'b.click').at(-1)?.args.ref, 'e181');
    const read = await e.tools.get('pc_browser_read')!.run({ ref: 'e999' }, ctxOf(e));
    assert.match(String(read), /Secret address in iCal format/);
    assert.match(String(read), /e999 is not on the page any more, so this is the whole page's text/);
  } finally {
    await e.close();
  }
});

test('scrolling: no ref needed, Page Down when nothing moved, where she is; a stale ref scrolls its way', async () => {
  const e = await env('just do it');
  try {
    let y = 0;
    e.answer((op, a) => {
      if (op === 'b.scroll') return a.ref ? { ok: false, error: { code: 'stale_view', message: 'There is no e177 on the page now: look again.' } } : { ok: true, result: { scrollY: y, maxY: 1600, before: y, moved: false } };
      if (op === 'b.keys') {
        y = 700;
        return { ok: true, result: {} };
      }
      if (op === 'b.snapshot') return snapshot([{ ref: 'e2', role: 'link', name: 'Other' }]);
      return { ok: true, result: {} };
    });
    const scroll = e.tools.get('pc_browser_scroll')!;
    const out = String(await scroll.run({ direction: 'down' }, ctxOf(e)));
    assert.ok(e.ops.some((o) => o.op === 'b.keys' && o.args.combo === 'PageDown'), 'keyboard fallback');
    assert.match(out, /pressed Page Down/);
    assert.ok(e.ops.find((o) => o.op === 'b.scroll')!.args.dy > 0);
    e.answer((op, a) => (op === 'b.scroll' ? (a.ref ? { ok: false, error: { code: 'stale_view', message: 'There is no e177 on the page now: look again.' } } : { ok: true, result: { scrollY: 800, maxY: 1600, before: 0, moved: true, container: 'Settings panel' } }) : op === 'b.snapshot' ? snapshot([{ ref: 'e2', role: 'link', name: 'Other' }]) : { ok: true, result: {} }));
    const st = String(await scroll.run({ ref: 'e177', direction: 'up' }, ctxOf(e)));
    assert.match(st, /e177 is not on the page any more, so I scrolled the page up/);
    assert.match(st, /scrolling panel “Settings panel”: now in the middle \(50% down\)/);
  } finally {
    await e.close();
  }
});

test('tab ids: a made-up "t1" or a title fragment finds the tab; otherwise the error lists the tabs', async () => {
  const e = await env('read my calendar settings');
  try {
    e.answer((op, a) => {
      if (op === 'b.tabs') return { ok: true, result: { tabs: [{ tab: 'T9f2', title: 'Google Calendar', url: 'https://calendar.google.com/' }, { tab: 'Ta01', title: 'Cloud console', url: 'https://console.cloud.google.com/' }] } };
      if (op === 'b.read') return a.tab === 'T9f2' || a.tab === 'Ta01' ? { ok: true, result: { title: 'x', url: 'https://x/', text: `tab ${a.tab}` } } : { ok: false, error: { code: 'not_found', message: `No tab ${a.tab}` } };
      return { ok: true, result: {} };
    });
    const read = e.tools.get('pc_browser_read')!;
    assert.match(String(await read.run({ tab: 't1' }, ctxOf(e))), /tab T9f2/);
    assert.match(String(await read.run({ tab: 'console' }, ctxOf(e))), /tab Ta01/);
    await assert.rejects(read.run({ tab: 'nothing here' }, ctxOf(e)), /Tabs in .* now: 1\. T9f2 “Google Calendar”; 2\. Ta01 “Cloud console”/);
  } finally {
    await e.close();
  }
});

test('desktop: hands-free is sent to the computer (it confirms once there); covered windows and old looks retry once', async () => {
  const e = await env('set it up for me, just do it');
  try {
    let n = 0;
    let oldOnce = true;
    e.answer((op) => {
      if (op === 'd.elements' || op === 'd.shot') return { ok: true, result: { viewId: `v${++n}`, window: { id: 'w1', app: 'chrome', title: 'Google Calendar' }, items: [{ ref: 'e4', role: 'button', name: 'Settings', box: [10, 10, 50, 20] }, { ref: 'e5', role: 'document', name: 'Calendar', box: [0, 0, 800, 600] }] } };
      if (op === 'd.click' && n === 1) return { ok: false, error: { code: 'denied_local', message: 'Another window covers that point. Sara will not act on it.' } };
      if (op === 'd.scroll' && oldOnce) {
        oldOnce = false;
        return { ok: false, error: { code: 'stale_view', message: 'That look is older than 20 seconds: look again.' } };
      }
      return { ok: true, result: {} };
    });
    const ctx = { ...(ctxOf(e) as object), canSee: false };
    await e.tools.get('pc_look')!.run({ picture: false }, ctx as never);
    const args = { ref: 'e4' };
    assert.deepEqual(await e.tools.get('pc_click')!.prepare!(args, ctx as never), {});
    const out = String(await e.tools.get('pc_click')!.run(args, ctx as never));
    assert.match(out, /Another window was in front: I brought the window forward, looked again and acted/);
    const clicks = e.ops.filter((o) => o.op === 'd.click');
    assert.equal(clicks.length, 2);
    assert.equal(typeof clicks[1].args.handsFree, 'string');
    assert.ok(clicks[1].args.handsFreeMs > 3_000_000);
    // pc_scroll with only a direction: the biggest scrolling part, about a screen down; an old look retries.
    await e.tools.get('pc_look')!.run({ picture: false }, ctx as never);
    const sargs: Record<string, unknown> = { direction: 'down' };
    await e.tools.get('pc_scroll')!.prepare!(sargs, ctx as never);
    const sout = String(await e.tools.get('pc_scroll')!.run(sargs, ctx as never));
    const scrolls = e.ops.filter((o) => o.op === 'd.scroll');
    assert.equal(scrolls[0].args.ref, 'e5');
    assert.ok(scrolls[0].args.dy > 0);
    assert.equal(scrolls.length, 2, 'retried once after the old look');
    assert.match(sout, /looked again once and acted on the same control/);
  } finally {
    await e.close();
  }
});

test('the page agent scrolls the panel under the middle of the window and says whether it moved', () => {
  const src = readFileSync(join(ROOT, 'desktop', 'shared', 'page-agent.js'), 'utf8');
  assert.match(src, /elementFromPoint\(Math\.round\(innerWidth \/ 2\), Math\.round\(innerHeight \/ 2\)\)/);
  assert.match(src, /moved: true, container/);
  const cpp = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'hands.cpp'), 'utf8');
  assert.match(cpp, /freeGrants_/);
  assert.match(cpp, /endHandsFree/);
  assert.match(readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'hands-approval.cpp'), 'utf8'), /Let her finish this task/);
  assert.match(readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'hands-screen.cpp'), 'utf8'), /bool hardAction/);
});
