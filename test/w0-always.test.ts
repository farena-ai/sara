// W0.7: "Always allow everything" (src/always-allow.ts, docs/ALWAYS_ALLOW.md). Every former ask path
// returns allow under the override; the password/key limits stay; kids can't enable it; adults only
// with the owner's say-so; it expires; turning it on needs the step-up proof and the warning.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { alwaysAllowArgs, alwaysAllowOn, alwaysAllowView, mayAlwaysAllow, setAlwaysAllow, type AlwaysApp } from '../src/always-allow.ts';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { actionVerdict, desktopActionVerdict, loginVerdict, navigationVerdict, ownBrowserPage, type ActFacts } from '../src/computer-policy.ts';
import { DesktopConsent } from '../src/hands-desktop-consent.ts';
import { cleanLimits } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { timelineOf } from '../src/timeline.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const T0 = Date.parse('2026-11-19T15:00:00Z');
function fakeApp(dir: string, o: Partial<AlwaysApp> = {}) {
  mkdirSync(dir, { recursive: true });
  const clock = { t: T0 };
  const app: AlwaysApp = { dataDir: dir, now: () => new Date(clock.t), ...o };
  return { app, clock };
}

// ---------- every former ask path returns allow ----------
const act = (o: Partial<ActFacts>): ActFacts => ({ kind: 'click', site: 'shop.example', target: { role: 'button', name: 'Next' }, page: { url: 'https://shop.example/', title: 'Shop' }, level: 'task', taskSites: new Set(), always: [], ...o });

test('W0.7 browser actions: payments, account-hard, sends and every level allow under the override', () => {
  const asks: Partial<ActFacts>[] = [
    { target: { role: 'button', name: 'Place order' } },
    { target: { role: 'button', name: 'Pay now' } },
    { target: { role: 'textbox', name: 'Card number', card: true }, kind: 'type', text: '4242' },
    { target: { role: 'button', name: 'Delete my account' } },
    { target: { role: 'button', name: 'Turn on two-factor' } },
    { target: { role: 'button', name: 'Save' }, page: { url: 'https://acct.example/security', title: 'Security settings' } },
    { target: { role: 'button', name: 'Send' } },
    { level: 'ask' },
    { level: 'task' },
  ];
  for (const a of asks) {
    assert.equal(actionVerdict(act(a)).act, 'ask', `asks today: ${JSON.stringify(a.target ?? a.level)}`);
    assert.equal(actionVerdict(act({ ...a, allowAll: true })).act, 'allow', `allowed with the override: ${JSON.stringify(a.target ?? a.level)}`);
  }
  // Limits, not approvals: never a password field, never a key-shaped text.
  assert.equal(actionVerdict(act({ kind: 'type', target: { role: 'textbox', name: 'Password', secret: true }, text: 'x', allowAll: true })).act, 'block');
  const key = ['sk', 'z'.repeat(24)].join('-');
  assert.equal(actionVerdict(act({ kind: 'type', target: { role: 'textbox', name: 'Notes' }, text: key, allowAll: true })).act, 'block');
});

test('W0.7 navigation, saved logins and the person\u2019s own browser pages allow under the override', () => {
  const facts = { ownerText: 'look things up', granted: new Set<string>(), localOnly: false, jobPort: () => false };
  assert.equal(navigationVerdict('https://unnamed.example/', facts).act, 'ask');
  assert.equal(navigationVerdict('https://unnamed.example/', { ...facts, allowAll: true }).act, 'allow');
  assert.equal(navigationVerdict('http://localhost:9999/', { ...facts, allowAll: true }).act, 'allow');
  assert.equal(navigationVerdict('file:///c:/x', { ...facts, allowAll: true }).act, 'block', 'only web addresses, still');
  assert.equal(loginVerdict().act, 'ask');
  assert.equal(loginVerdict(true).act, 'allow');
  assert.equal(ownBrowserPage('Checkout', 'https://shop.example/checkout').act, 'once');
  assert.equal(ownBrowserPage('Checkout', 'https://shop.example/checkout', '', false, true).act, 'level');
  assert.equal(ownBrowserPage('Sign in', 'https://acct.example/signin/2fa', '', true, true).act, 'level');
  assert.equal(ownBrowserPage('Extensions', 'edge://extensions', '', false, true).act, 'level');
  assert.equal(ownBrowserPage('Passwords', 'edge://settings/passwords', '', false, true).act, 'block', 'the browser\u2019s password pages stay off limits');
  assert.equal(ownBrowserPage('x', 'https://bank.example', 'banking', false, true).act, 'block', 'a hidden tab stays hidden');
});

test('W0.7 desktop actions: payments, account settings, extension removal and Ask every time allow; hard limits stay', () => {
  const d = (o: Partial<Parameters<typeof desktopActionVerdict>[0]>) => desktopActionVerdict({ site: 'desktop:x', target: { name: 'OK' }, level: 'task', ...o });
  for (const o of [{ target: { name: 'Buy now' } }, { target: { name: 'Change password' } }, { target: { name: 'Remove' }, window: { app: 'msedge', title: 'Extensions' } }, { level: 'ask' as const }, { level: 'task' as const }]) {
    assert.equal(d(o).act, 'ask', JSON.stringify(o));
    assert.equal(d({ ...o, allowAll: true }).act, 'allow', JSON.stringify(o));
  }
  assert.equal(d({ target: { name: 'Password', secret: true }, allowAll: true }).act, 'block');
  assert.equal(d({ target: { name: 'Setup', elevated: true }, allowAll: true }).act, 'block');
  assert.equal(d({ target: { name: 'x', blocked: true }, allowAll: true }).act, 'block');
});

test('W0.7 the computer confirms the key once on its own card, then nothing asks (review cards and once-only too)', async () => {
  const c = new DesktopConsent();
  c.level = 'ask';
  const shown: string[][] = [];
  const prompt = async (p: { choices: string[] }) => (shown.push(p.choices), 'task' as const);
  const base = { op: 'd.click', task: 't1', target: { name: 'Buy now' } };
  assert.equal(await c.allow({ ...base, forceOnce: true }, async () => 'once'), true, 'without the key it asks');
  assert.equal(await c.allow({ ...base, allowAll: 'aa:owner:1', allowAllMs: 3600_000 }, prompt), true);
  assert.deepEqual(shown, [['once', 'task']], 'the key offers its confirm button');
  let asked = 0;
  const never = async () => (asked++, 'deny' as const);
  assert.equal(await c.allow({ ...base, forceOnce: true, review: 'Name: Alex', allowAll: 'aa:owner:1' }, never), true);
  assert.equal(asked, 0, 'confirmed once: no more cards');
  c.clear();
  assert.equal(await c.allow({ ...base, allowAll: 'aa:owner:1' }, never), true, 'a task ending does not drop it');
  assert.equal(await c.allow({ ...base, allowAll: 'aa:owner:2' }, never), false, 'a new stretch (new key) asks again');
  c.now = () => Date.now() + 2 * 3600_000;
  assert.equal(await c.allow({ ...base, allowAll: 'aa:owner:1' }, never), false, 'it ends with its time');
  await assert.rejects(c.allow({ op: 'd.type', task: 't', target: { name: 'Password', secret: true }, allowAll: 'aa:owner:1' }, never), /password/i);
});

// ---------- the switch itself ----------
test('W0.7 on/off, warning, expiry (1 hour, 1 day, until off) and the computer key', () => {
  const { dir, cleanup } = tempDir();
  try {
    const { app, clock } = fakeApp(dir);
    assert.equal(alwaysAllowOn(app), false);
    assert.throws(() => setAlwaysAllow(app, { on: true, for: '1h' }), /warning/);
    const v = setAlwaysAllow(app, { on: true, for: '1h', warned: true });
    assert.equal(v.on, true);
    assert.equal(v.until, new Date(T0 + 3600_000).toISOString());
    const k = alwaysAllowArgs(app);
    assert.match(k.allowAll ?? '', /^aa:owner:/);
    assert.equal(k.allowAllMs, 3600_000);
    clock.t += 3599_000;
    assert.equal(alwaysAllowOn(app), true);
    clock.t += 2000;
    assert.equal(alwaysAllowOn(app), false, 'expired after 1 hour');
    assert.equal(alwaysAllowView(app).ended?.why, 'time');
    assert.deepEqual(alwaysAllowArgs(app), {});
    setAlwaysAllow(app, { on: true, for: '1d' });
    clock.t += 23 * 3600_000;
    assert.equal(alwaysAllowOn(app), true, 'the warning is shown once');
    clock.t += 3600_000;
    assert.equal(alwaysAllowOn(app), false, 'expired after 1 day');
    setAlwaysAllow(app, { on: true, for: 'off' });
    clock.t += 30 * 86_400_000;
    assert.equal(alwaysAllowOn(app), true, 'until I turn it off');
    const key2 = alwaysAllowArgs(app).allowAll;
    assert.notEqual(key2, k.allowAll, 'a new stretch has a new key');
    setAlwaysAllow(app, { on: false });
    assert.equal(alwaysAllowOn(app), false);
    assert.equal(alwaysAllowView(app).ended?.why, 'you');
  } finally {
    cleanup();
  }
});

test('W0.7 kids never; adults only when the owner allows it for them', () => {
  const { dir, cleanup } = tempDir();
  try {
    const kid = fakeApp(join(dir, 'kid'), { member: { id: 'k1', child: () => ({ age: 10 }), limits: () => ({ alwaysAllow: true }) } }).app;
    assert.equal(mayAlwaysAllow(kid).ok, false);
    assert.throws(() => setAlwaysAllow(kid, { on: true, warned: true }), /kid/i);
    const adult = { allow: false };
    const bo = fakeApp(join(dir, 'bo'), { member: { id: 'm1', child: () => undefined, limits: () => ({ alwaysAllow: adult.allow }) } }).app;
    assert.equal(mayAlwaysAllow(bo).ok, false);
    assert.throws(() => setAlwaysAllow(bo, { on: true, warned: true }), /owner/i);
    adult.allow = true;
    assert.equal(setAlwaysAllow(bo, { on: true, warned: true }).on, true);
    assert.match(alwaysAllowArgs(bo).allowAll ?? '', /^aa:m1:/);
    // The owner takes it back: it is off at once.
    adult.allow = false;
    assert.equal(alwaysAllowOn(bo), false);
    assert.equal(alwaysAllowView(bo).ended?.why, 'policy');
    // The household limits keep the owner's choice (and say nothing when it's off).
    assert.equal(cleanLimits({ alwaysAllow: true }, []).alwaysAllow, true);
    assert.equal('alwaysAllow' in cleanLimits({}, []), false);
    assert.equal(cleanLimits({ alwaysAllow: false }, [], cleanLimits({ alwaysAllow: true }, [])).alwaysAllow, undefined);
  } finally {
    cleanup();
  }
});

// ---------- chat turns: no card, still on the timeline and in the audit trail ----------
function askTool(name: string, extra: Partial<Tool> = {}): Tool {
  return { defaultPermission: 'ask', changes: true, spec: { name, description: 'changes a thing', parameters: { type: 'object' } }, summarize: () => `do ${name}`, run: async () => 'done', ...extra } as Tool;
}
async function turn(o: { on: boolean; tool?: Tool; opts?: Record<string, unknown> }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(T0) };
  const app = makeApp(dir, clock);
  const trail = new AuditTrail(dir, { redact: (s) => s, key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
    const tool = o.tool ?? askTool('pc_test_change');
    app.tools.add(tool);
    if (o.on) setAlwaysAllow(app as never, { on: true, warned: true });
    const conv = app.store.createConversation();
    app.script.push([call('c1', tool.spec.name, {})], text('Done.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(app, conv.id, 'do the thing', undefined, (o.opts ?? {}) as never)) {
      evs.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true);
    }
    return { evs, cards: evs.filter((e) => e.type === 'approval').length, ran: evs.some((e) => e.type === 'tool_result' && /done/.test((e as { output: string }).output)), timeline: timelineOf(app).list(), audit: trail.list({}, { content: true }) };
  } finally {
    setAuditTrail(undefined);
    app.store.close();
    cleanup();
  }
}

test('W0.7 chat: an ask tool and an always-asks command run without a card; timeline + audit rows remain', async () => {
  const off = await turn({ on: false });
  assert.equal(off.cards, 1, 'asks today');
  const on = await turn({ on: true });
  assert.equal(on.cards, 0, 'no card under the override');
  assert.ok(on.ran);
  assert.ok(on.timeline.some((r) => r.tool === 'pc_test_change'), 'still on the Action timeline');
  assert.ok(on.audit.some((r) => r.action === 'approval.always_allow' && r.target === 'pc_test_change'), 'and in the audit trail');
  const forced = await turn({ on: true, tool: askTool('pc_test_forced', { defaultPermission: 'auto', asksFirst: () => true }) });
  assert.equal(forced.cards, 0, 'a call that always asks (Phase 73) runs too');
  const prepAsk = await turn({ on: true, tool: askTool('pc_test_prep', { defaultPermission: 'auto', prepare: async () => ({ ask: true, summary: 'buy it' }) }) });
  assert.equal(prepAsk.cards, 0, 'a prepared ask (computer cards) runs too');
});

test('W0.7 chat: other people\u2019s requests still ask; a disabled tool stays off', async () => {
  // (pc_ tools are never offered to other apps; an MCP tool is.)
  const mcp = () => askTool('mcp_comfyui_generate_image', { source: 'MCP: comfyui' } as Partial<Tool>);
  assert.equal((await turn({ on: true, tool: mcp(), opts: { externalApp: true } })).cards, 1, 'another app');
  assert.equal((await turn({ on: true, tool: mcp(), opts: { untrusted: true } })).cards, 1, 'forwarded text');
  const never = await turn({ on: true, tool: askTool('pc_test_never', { defaultPermission: 'never' }) });
  assert.equal(never.cards, 0);
  assert.equal(never.ran, false, 'never past \u201cnever\u201d');
});

// ---------- routes: step-up required ----------
const r = tempDir();
const rclock = { now: new Date(T0) };
const rapp = makeApp(r.dir, rclock);
const rauth = new OwnerAuth(r.dir, () => rclock.now);
const ownerToken = rauth.newToken!;
const server = createSaraServer({ app: rapp, auth: rauth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  rapp.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: rclock.now.toISOString() });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rapp.store.close();
  r.cleanup();
});
const req = (method: string, body?: unknown) => fetch(`${base}/api/computer/always`, { method, headers: { authorization: `Bearer ${ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('W0.7 route: on needs the warning and the owner token again; off needs nothing', async () => {
  const g = await (await req('GET')).json();
  assert.equal(g.on, false);
  assert.equal(g.may, true);
  assert.equal((await req('PUT', { on: true, for: '1h', token: ownerToken })).status, 400, 'the warning first');
  const noProof = await req('PUT', { on: true, for: '1h', warned: true });
  assert.equal(noProof.status, 403, 'step-up: the session alone is not enough');
  assert.equal((await req('PUT', { on: true, for: '1h', warned: true, token: 'wrong' })).status, 403);
  assert.equal((await req('PUT', { on: true, for: 'week', warned: true, token: ownerToken })).status, 400);
  const ok = await req('PUT', { on: true, for: '1h', warned: true, token: ownerToken });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).on, true);
  assert.equal(alwaysAllowOn(rapp as never), true);
  assert.ok(JSON.parse(readFileSync(join(r.dir, 'always-allow.json'), 'utf8')).until);
  const offed = await req('DELETE');
  assert.equal((await offed.json()).on, false);
  assert.equal(alwaysAllowOn(rapp as never), false);
});
