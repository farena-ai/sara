// C8 (docs/ops/C8_DESIGN.md, docs/COSTS.md): spend control. Price tags before paid calls (card and
// step), the usage ledger row after one ran, day/month/per-tool limits with the owner's one-call
// override, the hard cap pin, Token Saver (off = byte-identical requests; on = shorter, smaller,
// fewer steps, quick route; auto with hysteresis and the daily reset), /saver, the owner-only route,
// and add-on auto-update (off by default, asks on more permissions, rolls back when unhealthy).
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { autoUpdateOn, autoUpdateSettings, runAutoUpdates, type AutoUpdateDeps, type StagedUpdate } from '../src/addon-autoupdate.ts';
import { parseCommand, runCommand, type BridgeAdapter } from '../src/bridges/commands.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { parseManifest } from '../src/plugins/manifest.ts';
import { PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { createSpendRoutes } from '../src/routes/spend.ts';
import { priceLine, priceTagFor, saverDecide, saverSettings, spendCheck, spendSettings, spentNow, SAVER } from '../src/spend.ts';
import type { Tool } from '../src/tools/types.ts';
import { UsageStore } from '../src/usage.ts';
import { call, listen, makeApp, tempDir, text, type TestApp } from './helpers.ts';

function rig(t: TestContext, extra: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), ...extra } as never);
  const ran: string[] = [];
  const paid: Tool = { spec: { name: 'make_poster', description: 'Make a poster', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', cost: 0.25, summarize: () => 'Make a poster', run: async () => (ran.push('poster'), 'poster made') };
  const free: Tool = { spec: { name: 'say_hi', description: 'Hi', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'Say hi', run: async () => 'hi' };
  app.tools.add(paid);
  app.tools.add(free);
  t.after(() => {
    setPolicy(new PolicyStore());
    app.store.close();
    cleanup();
  });
  return { app, clock, ran, dir };
}

async function drain(gen: AsyncGenerator<ChatEvent>, app: TestApp, answer = true): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, answer);
  }
  return out;
}
const ofType = <K extends ChatEvent['type']>(evs: ChatEvent[], k: K) => evs.filter((e): e is Extract<ChatEvent, { type: K }> => e.type === k);

test('C8 price tags: built-in picture engines, the add-on manifest, the owner’s own price; free tools have none', () => {
  const s = (photos?: unknown, spend?: unknown) => ({ providers: [], ...(photos ? { photos } : {}), ...(spend ? { spend } : {}) }) as never;
  assert.deepEqual(priceTagFor({ settings: s({ engine: 'grok' }) }, 'take_photo'), { usd: 0.07, source: 'built-in' });
  assert.deepEqual(priceTagFor({ settings: s({ engine: 'openai' }) }, 'take_photo'), { usd: 0.04, source: 'built-in' });
  assert.equal(priceTagFor({ settings: s({ engine: 'comfyui' }) }, 'take_photo'), undefined, 'ComfyUI on your own computer is free');
  assert.deepEqual(priceTagFor({ settings: s({ engine: 'tool' }) }, 'take_photo'), { usd: null, source: 'built-in' }, 'an image tool: cost unknown');
  assert.deepEqual(priceTagFor({ settings: s(), tool: { cost: 0.5 } }, 'x__y'), { usd: 0.5, source: 'add-on' });
  assert.deepEqual(priceTagFor({ settings: s(), tool: { cost: null } }, 'x__y'), { usd: null, source: 'add-on' });
  assert.deepEqual(priceTagFor({ settings: s(undefined, { prices: { x__y: 0.02 } }), tool: { cost: 0.5 } }, 'x__y'), { usd: 0.02, source: 'owner' }, 'the owner’s row wins');
  assert.equal(priceTagFor({ settings: s(), tool: {} }, 'say_hi'), undefined);
  assert.equal(priceLine({ usd: 0.07, source: 'built-in' }), 'about $0.07');
  assert.equal(priceLine({ usd: 0.25, source: 'add-on' }), 'about $0.25');
  assert.equal(priceLine({ usd: null, source: 'add-on' }), 'cost unknown');
});

test('C8 manifest: costs name its own tools in dollars per call (or null); anything else is refused', () => {
  const m = (costs: unknown) => JSON.stringify({ manifest: 1, id: 'poster-maker', name: 'Poster', version: '1.0.0', description: 'd', main: 'index.mjs', permissions: { tools: ['make'] }, ...(costs === undefined ? {} : { costs }) });
  assert.deepEqual(parseManifest(m({ make: 0.1 }), { saraVersion: '2.86.0' }).costs, { make: 0.1 });
  assert.deepEqual(parseManifest(m({ make: null }), { saraVersion: '2.86.0' }).costs, { make: null });
  assert.equal(parseManifest(m(undefined), { saraVersion: '2.86.0' }).costs, undefined);
  assert.throws(() => parseManifest(m({ other: 1 }), { saraVersion: '2.86.0' }), /isn't one of its tools/);
  assert.throws(() => parseManifest(m({ make: -1 }), { saraVersion: '2.86.0' }), /dollars per call/);
});

test('C8 limits: day, month and per tool count what was spent plus this call; the pin is a hard cap', () => {
  const sp = spendSettings({ spend: { dayUsd: 1, monthUsd: 10, perTool: { make_poster: { dayUsd: 0.5 } } } });
  const tag = { usd: 0.25, source: 'add-on' as const };
  const at = (day: number, month: number, toolDay = 0) => ({ day, month, toolDay, toolMonth: toolDay, dayTokens: 0 });
  assert.equal(spendCheck(sp, at(0.5, 2), tag, 'other'), undefined);
  assert.equal(spendCheck(sp, at(0.8, 2), tag, 'other')?.limit, 'day', 'this call would pass the daily limit');
  assert.equal(spendCheck(sp, at(0.1, 9.9), tag, 'other')?.limit, 'month');
  assert.equal(spendCheck(sp, at(0.3, 1, 0.3), tag, 'make_poster')?.limit, 'tool-day');
  const capped = spendCheck(sp, at(2, 2), tag, 'other', 2);
  assert.equal(capped?.limit, 'cap');
  assert.equal(capped?.hard, true);
  assert.equal(spendCheck(sp, at(0.8, 2), tag, 'other')?.hard, false);
  assert.equal(spendCheck(spendSettings({}), at(100, 100), tag, 'other'), undefined, 'no limits set: never stops');
  // the pin
  assert.deepEqual(validatePolicy({ pins: { spendCap: 5 } }).pins, { spendCap: 5 });
  assert.throws(() => validatePolicy({ pins: { spendCap: 0 } }), /spendCap/);
});

test('C8 the approval card and the tool step say the price first; the call that ran is on the usage ledger', async (t) => {
  const { app, ran } = rig(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'make_poster', {})], text('done'));
  const evs = await drain(runTurn(app, conv.id, 'make a poster'), app);
  const step = ofType(evs, 'tool_call').find((e) => e.name === 'make_poster')!;
  assert.deepEqual(step.price, { usd: 0.25, source: 'add-on' });
  const card = ofType(evs, 'approval')[0];
  assert.deepEqual(card.price, { usd: 0.25, source: 'add-on' });
  assert.equal(card.spend, undefined);
  assert.deepEqual(ran, ['poster']);
  const rows = app.usage!.exportRows().filter((r) => r.purpose === 'tool');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'make_poster');
  assert.equal(rows[0].usd, 0.25);
  assert.equal(spentNow(app.usage, app.now(), 'America/Chicago', 'make_poster').toolDay, 0.25);
  // a free tool's step has no price
  app.script.push([call('c2', 'say_hi', {})], text('ok'));
  const evs2 = await drain(runTurn(app, conv.id, 'hi'), app);
  assert.equal('price' in ofType(evs2, 'tool_call')[0], false);
});

test('C8 at a limit the paid call stops with a plain card; the owner can allow one call; declined = nothing spent', async (t) => {
  const { app, ran } = rig(t, { spend: { dayUsd: 0.3 }, toolPermissions: { make_poster: 'auto' } });
  app.usage!.recordTool('make_poster', 0.25, {});
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'make_poster', {})], text('stopped'));
  const evs = await drain(runTurn(app, conv.id, 'another poster'), app, false);
  const card = ofType(evs, 'approval')[0];
  assert.ok(card, 'a tool set to run on its own still stops at the limit');
  assert.match(card.spend!.message, /Today's spending limit \(\$0\.30\) is reached/);
  assert.equal(card.alwaysOk, undefined);
  assert.deepEqual(ran, []);
  // allow this one call
  app.script.push([call('c2', 'make_poster', {})], text('made'));
  await drain(runTurn(app, conv.id, 'yes, just this once'), app, true);
  assert.deepEqual(ran, ['poster']);
});

test('C8 the hard cap pin: refused with no card and nothing spent', async (t) => {
  const { app, ran, dir } = rig(t);
  const pol = new PolicyStore(dir);
  pol.set({ pins: { spendCap: 0.2 } });
  setPolicy(pol);
  app.usage!.recordTool('make_poster', 0.25, {});
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'make_poster', {})], text('capped'));
  const evs = await drain(runTurn(app, conv.id, 'poster'), app);
  assert.equal(ofType(evs, 'approval').length, 0);
  const r = ofType(evs, 'tool_result')[0];
  assert.match(r.output, /daily spending cap \(\$0\.20\) is reached/);
  assert.deepEqual(ran, []);
});

test('C8 Token Saver off: the model requests are byte-identical to a server that never had it', async (t) => {
  const run = async (extra: Record<string, unknown>) => {
    const { app } = rig(t, extra);
    const conv = app.store.createConversation();
    for (let i = 0; i < 3; i++) {
      app.script.push([call(`c${i}`, 'say_hi', {})], text(`reply ${i}`));
      await drain(runTurn(app, conv.id, `message ${i} ${'words '.repeat(40)}`), app);
    }
    return JSON.stringify(app.requests);
  };
  const never = await run({});
  const off = await run({ tokenSaver: { mode: 'off', dailyTokens: 1000 }, spend: { dayUsd: 5 } });
  assert.equal(off, never);
});

test('C8 Token Saver on: shorter replies, the note, a smaller history, fewer steps, the quick route', async (t) => {
  const { app } = rig(t, { tokenSaver: { mode: 'on' }, historyBudgetChars: 4000, providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }, { id: 'q', label: 'Q', kind: 'openai-compatible', baseUrl: 'http://y' }], routes: { quick: { providerId: 'q', model: 'small' } } });
  const conv = app.store.createConversation();
  for (let i = 0; i < 6; i++) app.store.addMessage(conv.id, i % 2 ? 'assistant' : 'user', `old ${i} ${'x'.repeat(700)}`);
  app.script.push(text('short'));
  await drain(runTurn(app, conv.id, 'hello'), app);
  const req = app.requests.at(-1)!;
  assert.equal(req.maxTokens, SAVER.replyTokens);
  assert.equal(req.model, 'small', 'the quick route');
  assert.ok(req.messages.some((m) => m.role === 'system' && m.content === SAVER.note));
  const kept = req.messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('old ')).length;
  assert.ok(kept <= 2, `half the history window (kept ${kept})`);
  // steps: a model that keeps calling tools stops at SAVER.steps
  for (let i = 0; i < 12; i++) app.script.push([call(`s${i}`, 'say_hi', {})]);
  const before = app.requests.length;
  await drain(runTurn(app, conv.id, 'loop'), app);
  assert.ok(app.requests.length - before <= SAVER.steps + 1, `at most ${SAVER.steps} steps`);
  app.script.length = 0;
});

test('C8 Token Saver auto: on near the daily line, off only below the lower line, and off at the reset', () => {
  const sv = saverSettings({ tokenSaver: { mode: 'auto', dailyTokens: 1000 } });
  assert.equal(sv.onAt, 0.8);
  assert.equal(sv.offAt, 0.6);
  let d = saverDecide(sv, 0.5, undefined, '2026-11-08');
  assert.equal(d.on, false);
  d = saverDecide(sv, 0.85, d.auto, '2026-11-08');
  assert.equal(d.on, true);
  d = saverDecide(sv, 0.7, d.auto, '2026-11-08');
  assert.equal(d.on, true, 'hysteresis: still on between the lines');
  d = saverDecide(sv, 0.55, d.auto, '2026-11-08');
  assert.equal(d.on, false);
  d = saverDecide(sv, 0.85, d.auto, '2026-11-08');
  d = saverDecide(sv, 0.7, d.auto, '2026-11-09');
  assert.equal(d.on, false, 'a new day starts off');
  assert.equal(saverDecide(sv, undefined, undefined, 'x').on, false, 'no line set: never on');
  assert.equal(saverDecide(saverSettings({ tokenSaver: { mode: 'off' } }), 5, undefined, 'x').on, false);
});

test('C8 /saver: shows and sets the mode, the owner only', async (t) => {
  const { app } = rig(t);
  const conv = app.store.createConversation();
  const adapter: BridgeAdapter = { currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 } as unknown as BridgeAdapter;
  const run = (line: string, place: 'owner-dm' | 'room' = 'owner-dm') => runCommand({ app, cmd: parseCommand(line, { herName: 'Sara', namePrefix: false })!, place, who: place === 'owner-dm' ? 'owner' : 'person', lang: 'en', bridge: 'telegram', adapter });
  assert.match((await run('/saver')).text, /Token Saver is off/);
  assert.match((await run('/saver on')).text, /Token Saver is on/);
  assert.equal(saverSettings(app.settings.get()).mode, 'on');
  assert.match((await run('/saver auto')).text, /auto/);
  assert.equal((await run('/saver maybe')).refused, true);
  assert.equal((await run('/saver off', 'room')).refused, true);
  assert.equal(saverSettings(app.settings.get()).mode, 'auto');
});

test('C8 /api/spend: the owner reads and sets limits and Token Saver; members and the demo get 403', async (t) => {
  const { app } = rig(t, { photos: { engine: 'grok', mode: 'new' } });
  const mk = (opts: Record<string, unknown>) => createSpendRoutes({ app, opts } as never);
  const serve = (h: ReturnType<typeof mk>) => listen(async (req: IncomingMessage, res: ServerResponse) => {
    const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean).slice(1);
    try {
      await h(req, res, req.method ?? 'GET', parts);
    } catch (err) {
      res.writeHead((err as { status?: number }).status ?? 500).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  const { server, url } = await serve(mk({}));
  t.after(() => server.close());
  const got = (await (await fetch(`${url}/api/spend`)).json()) as { spend: { dayUsd: number }; saver: { on: boolean }; priced: { name: string; usd: number | null }[] };
  assert.equal(got.spend.dayUsd, 0);
  assert.equal(got.saver.on, false);
  assert.ok(got.priced.some((p) => p.name === 'make_poster' && p.usd === 0.25));
  const put = (await (await fetch(`${url}/api/spend`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spend: { dayUsd: 2, perTool: { make_poster: { dayUsd: 1 } } }, tokenSaver: { mode: 'on' } }) })).json()) as { spend: { dayUsd: number; perTool: Record<string, unknown> }; saver: { on: boolean } };
  assert.equal(put.spend.dayUsd, 2);
  assert.deepEqual(put.spend.perTool, { make_poster: { dayUsd: 1 } });
  assert.equal(put.saver.on, true);
  const m = await serve(mk({ member: true }));
  t.after(() => m.server.close());
  assert.equal((await fetch(`${m.url}/api/spend`)).status, 403);
});

// ------------------------------------------------------------------------------------------------
// add-on auto-update
// ------------------------------------------------------------------------------------------------

function fakeUpdater(o: { on?: Record<string, unknown>; added?: string[]; healthy?: boolean; applyFails?: boolean; needsTrust?: boolean }) {
  let settings = { providers: [], addonAutoUpdate: o.on } as never as import('../src/settings.ts').Settings;
  const log: string[] = [];
  const notes: string[] = [];
  const d: AutoUpdateDeps = {
    settings: () => settings,
    save: (p) => {
      settings = { ...settings, ...p };
    },
    now: () => new Date('2026-11-08T12:00:00Z'),
    candidates: () => [{ item: 'weather', name: 'Weather', current: '1.0.0', version: '1.1.0' }],
    stage: async (item): Promise<StagedUpdate> => (log.push(`stage ${item}`), { id: 'r1', added: o.added ?? [], needsTrust: o.needsTrust ?? false, manifest: { name: 'Weather', version: '1.1.0' } }),
    cancel: (id) => void log.push(`cancel ${id}`),
    apply: async () => {
      log.push('apply');
      if (o.applyFails) throw new Error('disk full');
    },
    healthy: async () => (log.push('health'), o.healthy === false ? { ok: false, why: 'it crashed after starting' } : { ok: true }),
    rollback: async (item) => void log.push(`rollback ${item}`),
    notify: (title, line) => void notes.push(`${title} | ${line}`),
    tr: (s, p) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p?.[k] ?? '')),
  };
  return { d, log, notes, settings: () => settings };
}

test('C8 auto-update is off by default; all or one add-on turns it on (its own switch wins)', async () => {
  const off = fakeUpdater({});
  assert.deepEqual(await runAutoUpdates(off.d), []);
  assert.deepEqual(off.log, []);
  assert.equal(autoUpdateOn(autoUpdateSettings({ addonAutoUpdate: { all: true, items: { weather: false } } }), 'weather'), false);
  assert.equal(autoUpdateOn(autoUpdateSettings({ addonAutoUpdate: { items: { weather: true } } }), 'weather'), true);
});

test('C8 auto-update: installs, health-checks, tells the owner', async () => {
  const u = fakeUpdater({ on: { all: true } });
  const out = await runAutoUpdates(u.d);
  assert.deepEqual(out.map((x) => x.outcome), ['updated']);
  assert.deepEqual(u.log, ['stage weather', 'apply', 'health']);
  assert.match(u.notes[0], /Weather updated to 1\.1\.0/);
  assert.equal(autoUpdateSettings(u.settings()).last[0].outcome, 'updated');
});

test('C8 auto-update never installs a version that asks for more permissions: it asks once per version', async () => {
  const u = fakeUpdater({ on: { items: { weather: true } }, added: ['network:api.example'] });
  assert.deepEqual((await runAutoUpdates(u.d)).map((x) => x.outcome), ['asked']);
  assert.deepEqual(u.log, ['stage weather', 'cancel r1']);
  assert.match(u.notes[0], /needs your OK/);
  await runAutoUpdates(u.d);
  assert.equal(u.notes.length, 1, 'not asked again for the same version');
  const trust = fakeUpdater({ on: { all: true }, needsTrust: true });
  assert.deepEqual((await runAutoUpdates(trust.d)).map((x) => x.outcome), ['asked'], 'an unfenced computer needs the trust tick');
});

test('C8 auto-update rolls back by itself when the new version is unhealthy, and says so', async () => {
  const u = fakeUpdater({ on: { all: true }, healthy: false });
  const out = await runAutoUpdates(u.d);
  assert.deepEqual(out.map((x) => x.outcome), ['rolled-back']);
  assert.deepEqual(u.log, ['stage weather', 'apply', 'health', 'rollback weather']);
  assert.match(u.notes[0], /Weather went back to 1\.0\.0/);
  const f = fakeUpdater({ on: { all: true }, applyFails: true });
  assert.deepEqual((await runAutoUpdates(f.d)).map((x) => x.outcome), ['failed']);
  assert.deepEqual(f.log, ['stage weather', 'apply', 'cancel r1']);
});
