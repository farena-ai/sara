// Phase 121 (2.54.0): the routines gallery and the safety check-up (docs/design/BEGIN.md §5.14).
// The model is the scripted fake from helpers.ts (it records every request); tools are fakes in the
// test registry; the clock is fake (makeApp's clock object); GitHub is a fake transport behind
// netFetch; pushes are recorded. Every turn a test starts is awaited (until the loop leaves
// `ticking`), and each test cleans up its own temp folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { checklist } from '../src/checklist.ts';
import { checkCi } from '../src/issues.ts';
import { Loops, loopsFor } from '../src/loops.ts';
import { setNetTransport, setPrivateLocal } from '../src/net-guard.ts';
import { checkRoutineFile, loadCatalog, MEMBER_ENGINES, READ_ONLY_TOOLS, Routines, ROUTINES_DIR, createSuggestRoutineTool } from '../src/routines.ts';
import { acceptCheck, applyFix, DIRECTIONS, MASK, runSafetyCheck, safetyLogFor, sweepUndo, tightensOnly, todaySafetyLine, undoFix, weeklySafetyTick, type SafetyDeps } from '../src/safety-check.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { HookStore, DEFAULT_LIMITS } from '../src/webhooks.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const SARA_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Sunday 1 November 2026, 15:00 UTC.
const START = new Date('2026-11-01T15:00:00Z');
const H = 3_600_000;
const DAY = 24 * H;

async function until<T>(f: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the state');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Setup {
  app: TestApp;
  clock: { now: Date };
  dir: string;
  auth: OwnerAuth;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  pushes: { title: string; text: string }[];
  ran: Record<string, number>;
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, o: { settings?: Record<string, unknown> } = {}): Promise<Setup> {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(START) };
  const app = makeApp(dir, clock);
  const pushes: Setup['pushes'] = [];
  app.push = { notifyOwner: async (title: string, txt: string) => void pushes.push({ title, text: txt }) } as never;
  const ran: Record<string, number> = { web_fetch: 0, gmail_search: 0, gmail_organize: 0 };
  const fake = (name: string, perm: 'auto' | 'ask'): Tool => ({
    spec: { name, description: name, parameters: { type: 'object', properties: { url: { type: 'string' } } } },
    defaultPermission: perm,
    summarize: (a) => `${name} ${String(a.url ?? '')}`,
    async run() {
      ran[name]++;
      return name === 'web_fetch' ? 'Kindle Paperwhite — £88.00' : 'ok';
    },
  });
  for (const tl of [fake('web_fetch', 'ask'), fake('gmail_search', 'ask'), fake('gmail_organize', 'ask')]) app.tools.add(tl);
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'UTC',
    disclosureAcceptedAt: START.toISOString(),
    proactive: { quietStart: 22, quietEnd: 7 },
    ...(o.settings ?? {}),
  } as never);
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: SARA_VERSION, revision: null, startedAt: START.toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    setNetTransport(undefined);
    setPrivateLocal(false);
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };
  return { app, clock, dir, auth, api, pushes, ran };
}

const on = async (s: Setup, id: string, answers: Record<string, unknown>) => {
  const p = await s.api('POST', `/routines/${id}/preview`, { answers });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const r = await s.api('POST', `/routines/${id}/on`, { answers, sig: p.json.sig });
  return { preview: p.json, on: r };
};
const loopOf = (s: Setup, id: number) => loopsFor(s.app).get(id)!;
const settled = (s: Setup, id: number) => until(() => loopOf(s, id).state !== 'ticking' && loopOf(s, id));

// ------------------------------------------------------------------ part A: routines

test('A1 the catalog: the ten files load; a file with an unknown engine, four questions or its own cost is skipped with a log line', () => {
  const list = loadCatalog(ROUTINES_DIR, { fresh: true });
  assert.deepEqual(list.map((r) => r.id).sort(), ['backup-check', 'bedtime', 'ci-watch', 'inbox-triage', 'leave-on-time', 'morning-brief', 'new-issues', 'price-watch', 'stretch', 'weekly-review']);
  const { dir, cleanup } = tempDir();
  try {
    const good = JSON.parse(readFileSync(join(ROUTINES_DIR, 'stretch.json'), 'utf8'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(good));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...good, id: 'bad-engine', engine: 'cron' }));
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ ...good, id: 'four', fields: [...good.fields, ...good.fields.slice(0, 1)] }));
    writeFileSync(join(dir, 'd.json'), JSON.stringify({ ...good, id: 'costly', cost: 'free' }));
    const logs: string[] = [];
    const got = loadCatalog(dir, { fresh: true, log: (m) => logs.push(m) });
    assert.deepEqual(got.map((r) => r.id), ['stretch']);
    assert.equal(logs.length, 3);
    assert.match(logs.join('\n'), /unknown engine cron/);
    assert.match(logs.join('\n'), /at most three questions/);
    assert.match(logs.join('\n'), /may not state its own cost/);
  } finally {
    loadCatalog(ROUTINES_DIR, { fresh: true });
    cleanup();
  }
  // Loop routines may only name read-only tools (a plugin naming shell or gmail_organize is refused at load).
  assert.match(String(checkRoutineFile({ id: 'xx', title: 'x', pitch: 'x', engine: 'loop', fields: [], needs: [], tools: ['shell'] })), /not a read-only tool/);
  assert.match(String(checkRoutineFile({ id: 'xx', title: 'x', pitch: 'x', engine: 'loop', fields: [], needs: [], tools: ['gmail_organize'] })), /not a read-only tool/);
  for (const name of READ_ONLY_TOOLS) assert.doesNotMatch(name, /send|write|organize|delete|shell|command|purchase/);
});

test('A2 morning briefing end to end: card, a code-only preview, Turn on through settings.briefing, Off', async (t) => {
  const s = await setup(t);
  const g = await s.api('GET', '/routines');
  const card = (g.json.catalog as { id: string; needs: { id: string; ok: boolean }[]; cost: { words: string } }[]).find((r) => r.id === 'morning-brief')!;
  assert.equal(card.needs.find((n) => n.id === 'brain')?.ok, true);
  assert.match(card.cost.words, /About 1 model call a day.*At most 1 a day/);
  const before = s.app.providerCalls;
  const p = await s.api('POST', '/routines/morning-brief/preview', { answers: { time: '07:30' } });
  assert.equal(p.status, 200);
  assert.equal(s.app.providerCalls, before, 'the preview makes no model call');
  assert.match((p.json.creates as string[])[0], /morning briefing at 07:30/);
  assert.deepEqual(p.json.next, ['Mon 07:30', 'Tue 07:30', 'Wed 07:30']);
  assert.match(String(p.json.sample), /Sample, without her words/);
  const r = await s.api('POST', '/routines/morning-brief/on', { answers: { time: '07:30' }, sig: p.json.sig });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(s.app.settings.get().briefing?.enabled, true);
  const row = r.json.routine as { id: number; target: { settingsKey: string } };
  assert.deepEqual(row.target, { settingsKey: 'briefing' });
  assert.equal(s.app.providerCalls, before, 'Turn on makes no model call');
  const off = await s.api('POST', `/routines/mine/${row.id}/off`, {});
  assert.equal(off.status, 200);
  assert.equal(s.app.settings.get().briefing?.enabled, false);
});

test('A3 stale preview → 409; a hard need lost between preview and Turn on → 412', async (t) => {
  const s = await setup(t);
  const p = await s.api('POST', '/routines/morning-brief/preview', { answers: { time: '07:30' } });
  s.app.settings.update({ prices: [{ model: 'm', inPerM: 3, outPerM: 15 }] } as never);
  const r = await s.api('POST', '/routines/morning-brief/on', { answers: { time: '07:30' }, sig: p.json.sig });
  assert.equal(r.status, 409);
  s.app.vault.set('github', 'ghp_x');
  const { GITHUB_VAULT } = await import('../src/tools/coding.ts');
  s.app.vault.set(GITHUB_VAULT, 'ghp_testtoken');
  const p2 = await s.api('POST', '/routines/ci-watch/preview', { answers: { repo: 'octo/hello', branch: 'main' } });
  s.app.vault.delete(GITHUB_VAULT);
  const r2 = await s.api('POST', '/routines/ci-watch/on', { answers: { repo: 'octo/hello', branch: 'main' }, sig: p2.json.sig });
  assert.equal(r2.status, 412);
});

test('A4 free means free: stretch (weekdays 11:00) and bedtime are repeating reminders that fire on the right days with no model call', async (t) => {
  const s = await setup(t);
  const a = await on(s, 'stretch', { text: 'Stand up and stretch', time: '11:00', repeat: 'weekdays' });
  assert.equal(a.on.status, 200);
  assert.match((a.preview.cost as { words: string }).words, /^Free · no model calls\.$/);
  const b = await on(s, 'bedtime', { text: 'Time to wind down', time: '22:00' });
  assert.equal(b.on.status, 200);
  const rems = s.app.planner!.reminders({ status: 'pending', kind: 'timed' });
  assert.deepEqual(rems.map((r) => r.repeat).sort(), ['daily', 'weekdays']);
  const { ReminderScheduler } = await import('../src/reminders.ts');
  const sched = new ReminderScheduler(s.app, s.app.planner!);
  const fired: string[] = [];
  s.app.events!.subscribe((ev) => {
    const m = (ev as { message?: { meta?: { reminder?: unknown }; content?: string } }).message;
    if (m?.meta?.reminder) fired.push(`${s.clock.now.toISOString().slice(0, 13)} ${m.content}`);
  });
  for (let h = 0; h < 7 * 24; h++) {
    s.clock.now = new Date(START.getTime() + h * H + 60_000);
    sched.tick();
  }
  sched.stop?.();
  const stretch = fired.filter((f) => /stretch/.test(f));
  assert.equal(stretch.length, 5, stretch.join('\n'));
  for (const f of stretch) assert.ok(!/2026-11-07|2026-11-08/.test(f), f);
  assert.equal(fired.filter((f) => /wind down/.test(f)).length, 7);
  assert.equal(s.app.providerCalls, 0);
});

test('A5 one list, live state: Off on its own page shows Off; a briefing from before and a typed repeat are Set up elsewhere', async (t) => {
  const s = await setup(t);
  const a = await on(s, 'weekly-review', { day: 0, time: '18:00' });
  const rid = (a.on.json.routine as { id: number }).id;
  s.app.settings.update({ weeklyReview: { ...s.app.settings.get().weeklyReview, enabled: false } });
  const mine = (await s.api('GET', '/routines')).json.mine as { rid?: number; on: boolean; elsewhere?: boolean; kind?: string; key?: string }[];
  assert.equal(mine.find((x) => x.rid === rid)?.on, false, 'the row is not the source of truth');
  s.app.settings.update({ briefing: { enabled: true, time: '07:00' } });
  const conv = s.app.store.createConversation({ title: 'deploys' });
  const lp = loopsFor(s.app).create(conv.id, { prompt: 'check the deploy', everyMin: 10, start: true });
  assert.ok('loop' in lp);
  const mine2 = (await s.api('GET', '/routines')).json.mine as { on: boolean; elsewhere?: boolean; kind?: string; key?: string }[];
  const brief = mine2.find((x) => x.elsewhere && x.kind === 'briefing')!;
  assert.ok(brief);
  assert.ok(mine2.find((x) => x.elsewhere && x.kind === 'loop'));
  assert.equal((await s.api('POST', `/routines/elsewhere/briefing/briefing/off`, {})).status, 200);
  assert.equal(s.app.settings.get().briefing?.enabled, false);
});

test('A6 price watch, a grown loop: its own chat under Routines, every 12 h for 30 days; tools keep their approval (ask pauses), and met needs the fetch', async (t) => {
  // Quiet hours away from the 03:00 / 15:00 slots.
  const s = await setup(t, { settings: { proactive: { quietStart: 4, quietEnd: 5 } } });
  const bad = await s.api('POST', '/routines/price-watch/preview', { answers: { url: 'https://shop.example/kindle', target: 90, every: '1' } });
  assert.equal(bad.status, 400);
  const a = await on(s, 'price-watch', { url: 'https://shop.example/kindle', target: 90, every: '12' });
  assert.equal(a.on.status, 200, JSON.stringify(a.on.json));
  assert.match(String(a.preview.tools), /approval settings still apply/);
  const target = (a.on.json.routine as { target: { loopId: number; conversationId: string } }).target;
  const l = loopOf(s, target.loopId);
  assert.equal(l.everyMin, 720);
  assert.equal(l.routineId, (a.on.json.routine as { id: number }).id);
  assert.equal(Date.parse(l.endsAt), START.getTime() + 30 * DAY);
  const conv = s.app.store.getConversation(target.conversationId)!;
  assert.equal(s.app.planner!.projects().find((p) => p.id === conv.projectId)?.name, 'Routines');
  // web_fetch is set to Ask: the routine pauses and tells him (BEGIN §11 Q5 answered NO).
  s.app.script.push([call('f0', 'web_fetch', { url: 'https://shop.example/kindle' })], text('£95 [[loop: same]]'));
  s.clock.now = new Date(START.getTime() + 12 * H);
  loopsFor(s.app).due(s.clock.now);
  const paused = await settled(s, l.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, 'approval');
  assert.equal(s.ran.web_fetch, 0);
  // Once he sets web_fetch to auto himself, ticks run: same (folded, no push), then met with the receipt.
  s.app.settings.update({ toolPermissions: { web_fetch: 'auto' } });
  s.app.script.length = 0;
  assert.ok('loop' in loopsFor(s.app).resume(l.id));
  s.app.script.push([call('f1', 'web_fetch', { url: 'https://shop.example/kindle' })], text('It is £95 now. [[loop: same]]'));
  s.clock.now = new Date(START.getTime() + 24 * H + 60_000);
  loopsFor(s.app).due(s.clock.now);
  await settled(s, l.id);
  const pushesAfterSame = s.pushes.length;
  s.app.script.push([call('f2', 'web_fetch', { url: 'https://shop.example/kindle' })], text('£88.00: below your £90 target. [[loop: met]]'));
  s.clock.now = new Date(Date.parse(loopOf(s, l.id).nextAt!) + 1000);
  loopsFor(s.app).due(s.clock.now);
  const done = await until(() => loopOf(s, l.id).state === 'done' && loopOf(s, l.id));
  assert.equal(done.state, 'done');
  assert.ok(s.pushes.length > pushesAfterSame);
  const mine = (await s.api('GET', '/routines')).json.mine as { status: string; on: boolean }[];
  assert.match(mine[0].status, /^Ended/);
});

test('A7 inbox triage, a clock schedule: weekday 08:00 slots only; a slot in quiet hours is skipped, never made up', async (t) => {
  const s = await setup(t);
  s.app.google = { status: () => ({ gmail: true, calendar: true }) } as never;
  s.app.settings.update({ toolPermissions: { gmail_search: 'auto' } });
  const a = await on(s, 'inbox-triage', { at: '08:00', repeat: 'weekdays', days: '30' });
  assert.equal(a.on.status, 200, JSON.stringify(a.on.json));
  const id = (a.on.json.routine as { target: { loopId: number } }).target.loopId;
  assert.deepEqual(loopOf(s, id).schedule, { at: '08:00', repeat: 'weekdays' });
  assert.equal(loopOf(s, id).nextAt, '2026-11-02T08:00:00.000Z');
  const ticked: string[] = [];
  for (let d = 1; d <= 7; d++) {
    s.clock.now = new Date(Date.UTC(2026, 10, 1 + d, 8, 0, 30));
    s.app.script.push(text('2 things need you today. [[loop: same]]'));
    const n = loopsFor(s.app).due(s.clock.now);
    if (n) ticked.push(s.clock.now.toISOString().slice(0, 10));
    await settled(s, id);
    s.app.script.length = 0;
  }
  assert.deepEqual(ticked, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  // Quiet hours that end at 09:00 cover 08:00: one skipped row, and nothing runs at 09:00.
  s.app.settings.update({ proactive: { quietStart: 22, quietEnd: 9 } } as never);
  s.clock.now = new Date('2026-11-09T08:00:30Z');
  assert.equal(loopsFor(s.app).due(s.clock.now), 0);
  assert.equal(loopsFor(s.app).ticks(id).filter((x) => x.why === 'quiet').length, 1);
  s.clock.now = new Date('2026-11-09T09:00:30Z');
  assert.equal(loopsFor(s.app).due(s.clock.now), 0);
  assert.equal(loopOf(s, id).nextAt, '2026-11-10T08:00:00.000Z');
});

test('A8 restarts: a routine loop stays on with its next slot (one skipped row, no tick); a typed /loop comes back paused', async (t) => {
  const s = await setup(t);
  s.app.google = { status: () => ({ gmail: true, calendar: true }) } as never;
  const a = await on(s, 'inbox-triage', { at: '08:00', repeat: 'weekdays', days: '30' });
  const id = (a.on.json.routine as { target: { loopId: number } }).target.loopId;
  const conv = s.app.store.createConversation({ title: 'typed' });
  const typed = loopsFor(s.app).create(conv.id, { prompt: 'check it', everyMin: 10, start: true }) as { loop: { id: number } };
  const calls = s.app.providerCalls;
  s.clock.now = new Date('2026-11-03T10:00:00Z'); // Monday's 08:00 slot was missed while it was down
  const fresh = new Loops(s.app, s.app.store.db);
  fresh.startupSweep();
  const l = fresh.get(id)!;
  assert.equal(l.state, 'active');
  assert.equal(l.nextAt, '2026-11-04T08:00:00.000Z');
  assert.equal(fresh.ticks(id).filter((x) => x.why === 'restart').length, 1);
  assert.equal(fresh.get(typed.loop.id)!.state, 'paused');
  assert.equal(fresh.get(typed.loop.id)!.reason, 'restart');
  assert.equal(s.app.providerCalls, calls);
});

test('A9 ends: one “ends on …” line a week before (no silent extension), then it ends', async (t) => {
  const s = await setup(t);
  s.app.google = { status: () => ({ gmail: true, calendar: true }) } as never;
  const a = await on(s, 'inbox-triage', { at: '08:00', repeat: 'weekdays', days: '7' });
  const tg = (a.on.json.routine as { target: { loopId: number; conversationId: string } }).target;
  s.clock.now = new Date(START.getTime() + 60_000);
  loopsFor(s.app).due(s.clock.now);
  loopsFor(s.app).due(s.clock.now);
  const lines = s.app.store.messages(tg.conversationId).filter((m) => /This routine ends on/.test(m.content));
  assert.equal(lines.length, 1);
  assert.equal(Date.parse(loopOf(s, tg.loopId).endsAt), START.getTime() + 7 * DAY);
  s.clock.now = new Date(START.getTime() + 8 * DAY);
  loopsFor(s.app).due(s.clock.now);
  assert.equal(loopOf(s, tg.loopId).state, 'ended');
});

test('A10 CI watch: a failure → one notice and a push; the same run again → nothing; a success → green again; no model call', async (t) => {
  const s = await setup(t);
  const { GITHUB_VAULT } = await import('../src/tools/coding.ts');
  s.app.vault.set(GITHUB_VAULT, 'ghp_testtoken');
  let runs: { id: number; name: string; conclusion: string; html_url: string; run_number: number }[] = [{ id: 1, name: 'Tests', conclusion: 'success', html_url: 'https://github.com/octo/hello/actions/runs/1', run_number: 561 }];
  const asked: string[] = [];
  setNetTransport((async (u: string | URL | Request) => {
    asked.push(String(u));
    return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  const a = await on(s, 'ci-watch', { repo: 'octo/hello', branch: 'main' });
  assert.equal(a.on.status, 200);
  assert.deepEqual(s.app.settings.get().githubWatch?.ciRepos, ['octo/hello']);
  assert.deepEqual(await checkCi(s.app), []); // the first look notes where things stand
  runs = [{ id: 2, name: 'Tests', conclusion: 'failure', html_url: 'https://github.com/octo/hello/actions/runs/2', run_number: 562 }, ...runs];
  const said = await checkCi(s.app);
  assert.equal(said.length, 1);
  assert.match(said[0], /Tests failed on main \(run 562\)/);
  assert.equal(s.pushes.length, 1);
  assert.deepEqual(await checkCi(s.app), []);
  runs = [{ id: 3, name: 'Tests', conclusion: 'success', html_url: 'x', run_number: 563 }, ...runs];
  assert.match((await checkCi(s.app))[0], /green again/);
  runs = [{ id: 4, name: 'Tests', conclusion: 'success', html_url: 'x', run_number: 564 }, ...runs];
  assert.deepEqual(await checkCi(s.app), []);
  assert.equal(s.app.providerCalls, 0);
  assert.ok(asked.every((u) => u.includes('/repos/octo/hello/actions/runs?branch=main')));
  assert.equal(s.app.settings.get().githubWatch?.repos.length, 0, 'watching CI does not turn issues into tasks');
});

test('A11 private local mode: price watch and inbox triage are not offered; turning it on pauses a routine loop', async (t) => {
  const s = await setup(t);
  const a = await on(s, 'price-watch', { url: 'https://shop.example/x', target: 9, every: '12' });
  const id = (a.on.json.routine as { target: { loopId: number } }).target.loopId;
  setPrivateLocal(true);
  const g = (await s.api('GET', '/routines')).json.catalog as { id: string; needs: { id: string; ok: boolean }[] }[];
  assert.equal(g.find((r) => r.id === 'price-watch')!.needs.find((n) => n.id === 'online')!.ok, false);
  assert.equal(g.find((r) => r.id === 'inbox-triage')!.needs.find((n) => n.id === 'online')!.ok, false);
  assert.equal((await s.api('POST', '/routines/price-watch/preview', { answers: { url: 'https://shop.example/x', target: 9, every: '12' } })).status, 409);
  loopsFor(s.app).due(s.clock.now);
  assert.equal(loopOf(s, id).state, 'paused');
  assert.equal(loopOf(s, id).reason, 'private-local');
});

test('A12 who: members get briefing, review, reminders and leave-by only; the families are classified', async (t) => {
  const s = await setup(t);
  assert.ok(MEMBER_ROUTES.has('routines'));
  assert.ok(!MEMBER_ROUTES.has('safety-check'));
  s.app.member = {} as never;
  const rs = new Routines(s.app, ROUTINES_DIR);
  assert.deepEqual([...new Set(rs.catalog().map((r) => r.engine))].sort(), [...MEMBER_ENGINES].sort());
  await assert.rejects(() => rs.turnOn('price-watch', {}, 'x'), (e: Error & { status?: number }) => e.status === 404);
  delete s.app.member;
  const owner = new Routines(s.app, ROUTINES_DIR);
  s.app.member = {} as never;
  assert.throws(() => owner.preview('price-watch', { url: 'https://a.example', target: 1 }), (e: Error & { status?: number }) => e.status === 404 || e.status === 403);
  delete s.app.member;
});

test('A13 Getting started: the morning step (now Turn on a routine) is done with any routine on, and with a briefing from before', async (t) => {
  const s = await setup(t);
  const step = () => checklist(s.app, { devices: [], pushDevices: 0, personaCustom: false }).items.find((i) => i.id === 'morning');
  s.app.settings.update({ usePath: 'company' });
  assert.equal(step()?.label, 'Turn on a routine');
  assert.equal(step()?.done, false);
  await on(s, 'stretch', { text: 'Stretch', time: '11:00', repeat: 'daily' });
  assert.equal(step()?.done, true);
  const { dir, cleanup } = tempDir();
  try {
    const app2 = makeApp(dir, { now: START });
    app2.settings.update({ briefing: { enabled: true, time: '07:30' }, usePath: 'company' });
    assert.equal(checklist(app2, { devices: [], pushDevices: 0, personaCustom: false }).items.find((i) => i.id === 'morning')?.done, true);
    app2.store.close();
  } finally {
    cleanup();
  }
});

test('A14 she can\'t turn things on: suggest_routine returns a card; no routines row, no setting changed', async (t) => {
  const s = await setup(t);
  const before = JSON.stringify(s.app.settings.get());
  const out = await createSuggestRoutineTool(() => s.app).run({ routine: 'price watch' }, {} as never);
  assert.match(String(out), /Price watch/);
  assert.match(String(out), /Costs:/);
  assert.equal(JSON.stringify(s.app.settings.get()), before);
  assert.equal((s.app.store.db.prepare('SELECT COUNT(*) AS n FROM routines').get() as { n: number }).n, 0);
});

// ------------------------------------------------------------------ part B: the safety check-up

const SECRET = 'sk-ant-supersecretvalue1234567890';
function weak(s: Setup): SafetyDeps {
  const app = s.app;
  app.vault.set('provider:p', SECRET);
  app.settings.update({ backup: { auto: false }, toolPermissions: { shell: 'auto' }, telegram: { allowOthers: true } as never, adultMode: { on: true, confirmedAt: START.toISOString() } });
  app.tools.add({ spec: { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', runsCommands: true, summarize: () => 'shell', run: async () => '' });
  const hooks = new HookStore(app.store.db, () => s.clock.now);
  hooks.add({ id: 'h1', name: 'CI', verify: 'url', sender: 'github', preset: null, filters: [], action: { kind: 'tell' } as never, tools: [], companion: 'main', limits: DEFAULT_LIMITS, memory: 'none', forward: null, secretHash: 'x' });
  app.hooks = { store: hooks } as never;
  app.store.db.prepare("INSERT INTO memories (kind, content, happened_on, created_at, updated_at) VALUES ('fact', ?, '2026-11-01', ?, ?)").run(`The API key is ${SECRET} for the shop`, START.toISOString(), START.toISOString());
  // An owner file from before 2.54: no tokenAt.
  const f = join(s.dir, 'owner.json');
  const o = JSON.parse(readFileSync(f, 'utf8'));
  delete o.tokenAt;
  writeFileSync(f, JSON.stringify(o));
  writeFileSync(join(s.dir, 'owner.json.bak'), JSON.stringify(o));
  s.auth = new OwnerAuth(s.dir, () => s.clock.now);
  return { app, auth: s.auth, dataDir: s.dir, sandbox: { mode: 'none', network: true, detail: 'tests' }, env: { SARA_HOST: '0.0.0.0' }, platform: 'linux', updateStatus: () => ({ state: 'available', latest: '9.9.9', changes: ['Faster'] }), version: SARA_VERSION, now: () => s.clock.now };
}
const statusOf = (r: { checks: { id: string; status: string }[] }) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

test('B1 the report on a weak setup: fix-first, the expected statuses, plain lines, no secret, no model call, nothing sent', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  const sent: string[] = [];
  setNetTransport((async (u: string | URL | Request) => {
    sent.push(String(u));
    return new Response('{}');
  }) as typeof fetch);
  const r = await runSafetyCheck(d);
  assert.equal(r.verdict, 'fix-first');
  const st = statusOf(r);
  assert.equal(st.backups, 'red');
  assert.equal(st.approvals, 'red');
  assert.equal(st.bridges, 'amber');
  assert.equal(st.hooks, 'amber');
  assert.equal(st.secrets, 'red');
  assert.equal(st.token, 'amber');
  assert.equal(st['adult-lock'], 'amber');
  assert.equal(st.bind, 'red');
  assert.equal(st.version, 'amber');
  assert.equal(r.checks.length, 17);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the secret never appears');
  assert.equal(s.app.providerCalls, 0);
  assert.deepEqual(sent, []);
  // The route says the same, and also never shows the secret.
  s.app.hooks = d.app.hooks;
  const g = await s.api('GET', '/safety-check');
  assert.equal(g.status, 200);
  assert.ok(!JSON.stringify(g.json).includes(SECRET));
});

test('B2 each one-click fix tightens and only that, and its check turns green', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  s.app.settings.update({ discord: { answerBots: true, ownerWorkInServers: true } as never });
  const before = structuredClone(s.app.settings.get()) as unknown as Record<string, unknown>;
  const r1 = await applyFix(d, 'approvals', 'ask-again');
  assert.equal(r1.check.status, 'green');
  const after = s.app.settings.get() as unknown as Record<string, unknown>;
  assert.deepEqual(after.toolPermissions, { shell: 'ask' });
  for (const k of Object.keys(before)) if (k !== 'toolPermissions') assert.deepEqual(after[k], before[k], k);
  await applyFix(d, 'bridges', 'only-me');
  assert.equal(s.app.settings.get().telegram?.allowOthers, false);
  await applyFix(d, 'bridges', 'no-bots');
  await applyFix(d, 'bridges', 'no-group-tools');
  assert.equal(statusOf(await runSafetyCheck(d)).bridges, 'green');
  assert.equal((await applyFix(d, 'backups', 'auto-on')).check.status === 'red', false);
  assert.equal(s.app.settings.get().backup?.auto, true);
  assert.equal((await applyFix(d, 'hooks', 'pause')).check.status, 'green');
  s.app.settings.update({ toolPermissions: { shell: 'ask' } });
  const net = await runSafetyCheck(d);
  assert.equal(statusOf(net).sandbox, 'amber');
  assert.equal((await applyFix(d, 'sandbox', 'net-off')).check.fixes.some((f) => f.id === 'net-off'), false);
  assert.equal(s.app.settings.get().shellNetwork, false);
  if (process.platform !== 'win32') {
    chmodSync(s.dir, 0o755);
    assert.equal((await applyFix(d, 'folder', 'private')).check.status, 'green');
    assert.equal(statSync(s.dir).mode & 0o777, 0o700);
  }
});

test('B3 the gate: every direction reversed throws; adultMode, hub, a provider or a tool to auto throws; nothing is written', async (t) => {
  const s = await setup(t);
  const reversed: [string, unknown, unknown][] = [
    ['toolPermissions.shell', 'ask', 'auto'], ['telegram.allowOthers', false, true], ['discord.answerBots', false, true], ['shellNetwork', false, true],
    ['backup.auto', true, false], ['backup.now', 'made', 'none'], ['hooks.h1.enabled', false, true], ['session.abc', 'removed', 'present'],
    ['folder.mode', 0o700, 0o755], ['owner.token', 'new', 'old'], ['text.0.memories.content.1', `x ${MASK}`, 'x secret'],
  ];
  assert.equal(reversed.length, DIRECTIONS.length + 2);
  const file = join(s.dir, 'settings.json');
  const bytes = readFileSync(file);
  for (const [key, before, after] of reversed) assert.throws(() => tightensOnly([{ key, before, after }]), (e: Error & { status?: number }) => e.status === 422, key);
  for (const key of ['adultMode.on', 'hub.checkin', 'providers.0.baseUrl', 'privateLocal', 'safetyClassifier']) assert.throws(() => tightensOnly([{ key, before: true, after: false }]), /can't change/);
  assert.throws(() => tightensOnly([{ key: 'toolPermissions.shell', before: 'ask', after: 'auto' }]), /less safe/);
  assert.throws(() => tightensOnly([]));
  assert.deepEqual(readFileSync(file), bytes);
  // And the right way passes.
  tightensOnly([{ key: 'toolPermissions.shell', before: 'auto', after: 'ask' }, { key: 'backup.auto', before: false, after: true }]);
});

test('B4 Undo: the old values come back; changed since → 409, nothing written; the undo row points at the fix', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  const f = await applyFix(d, 'bridges', 'only-me');
  undoFix(d, f.fixId);
  assert.equal(s.app.settings.get().telegram?.allowOthers, true);
  assert.equal(safetyLogFor(s.app).recent(5).find((x) => x.undoOf === f.fixId)?.fixId, 'only-me');
  assert.throws(() => undoFix(d, f.fixId), (e: Error & { status?: number }) => e.status === 409);
  const g = await applyFix(d, 'approvals', 'ask-again');
  s.app.settings.update({ toolPermissions: { shell: 'never' } });
  assert.throws(() => undoFix(d, g.fixId), /changed it since/);
  assert.equal(s.app.settings.get().toolPermissions?.shell, 'never');
  assert.throws(() => undoFix(d, 99_999), /not found/);
});

test('B5 secrets: Hide masks the text, FTS no longer finds it, the vault keeps it 30 days; Undo restores it exactly; after 31 days it cannot', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  const orig = `The API key is ${SECRET} for the shop`;
  const f = await applyFix(d, 'secrets', 'hide');
  assert.equal(f.undo, '30-days');
  const row = s.app.store.db.prepare('SELECT content FROM memories').get() as { content: string };
  assert.ok(row.content.includes(MASK) && !row.content.includes(SECRET));
  assert.equal((s.app.store.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'supersecretvalue1234567890'").get() as { n: number }).n, 0);
  assert.ok(s.app.vault.has(`safety-undo:${f.fixId}:0`));
  undoFix(d, f.fixId);
  assert.equal((s.app.store.db.prepare('SELECT content FROM memories').get() as { content: string }).content, orig);
  assert.ok(!s.app.vault.has(`safety-undo:${f.fixId}:0`));
  const g = await applyFix(d, 'secrets', 'hide');
  s.clock.now = new Date(START.getTime() + 31 * DAY);
  assert.equal(sweepUndo(s.app, s.clock.now), 1);
  assert.throws(() => undoFix(d, g.fixId), /can't be undone any more/);
  // A key-shaped value that isn't in the vault adds the \"change it where it's used\" line.
  s.app.store.db.prepare("INSERT INTO memories (kind, content, happened_on, created_at, updated_at) VALUES ('fact', ?, '2026-11-01', ?, ?)").run('token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', START.toISOString(), START.toISOString());
  const r = await runSafetyCheck(d);
  const sec = r.checks.find((c) => c.id === 'secrets')!;
  assert.match(String(sec.detail), /change it where it's used/);
  assert.ok(!JSON.stringify(r).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'));
});

test('B6 the token: amber without tokenAt; no current → 400, wrong → 403; right → a new token once, tokenAt set, every session gone; reset-token sets tokenAt', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  assert.equal(statusOf(await runSafetyCheck(d)).token, 'amber');
  assert.equal(d.auth!.tokenAt, undefined, 'no tokenAt is invented');
  const sess = s.auth.createSession('Browser');
  await assert.rejects(() => applyFix(d, 'token', 'new-token'), (e: Error & { status?: number }) => e.status === 400);
  await assert.rejects(() => applyFix(d, 'token', 'new-token', { current: 'nope' }), (e: Error & { status?: number }) => e.status === 403);
  const tokenFile = JSON.parse(readFileSync(join(s.dir, 'owner.json'), 'utf8'));
  assert.equal(tokenFile.tokenAt, undefined);
  const fresh = new OwnerAuth(s.dir, () => s.clock.now);
  const tok = fresh.resetToken();
  assert.ok(fresh.tokenAt, 'resetToken sets tokenAt');
  const d2 = { ...d, auth: fresh };
  // A session made with the new token, then the fix with the right token.
  fresh.createSession('Phone');
  // tokenAt is fresh, so the check is green: move the clock a year on.
  s.clock.now = new Date(START.getTime() + 400 * DAY);
  const r = await applyFix(d2, 'token', 'new-token', { current: tok });
  assert.ok(r.token && r.token !== tok);
  assert.equal(fresh.tokenAt, s.clock.now.toISOString());
  assert.equal(fresh.devices().filter((x) => x.kind === 'browser' || x.kind === 'app').length, 0);
  assert.equal(fresh.verifySession(sess.value), false);
  assert.equal(r.check.status, 'green');
});

test('B7 old devices: an API key unused for 120 days is listed (browser sessions expire by themselves); the fix signs out exactly the ticked ones', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  const k = s.auth.createApiKey('Open WebUI');
  const k2 = s.auth.createApiKey('SillyTavern');
  s.clock.now = new Date(START.getTime() + 120 * DAY);
  const keep = s.auth.createSession('This laptop');
  const r = await runSafetyCheck(d);
  const dev = r.checks.find((c) => c.id === 'devices')!;
  assert.equal(dev.status, 'amber');
  assert.match(dev.line, /Open WebUI/);
  assert.deepEqual(dev.fixes[0].items!.map((x) => x.id).sort(), [`session.${k.id}`, `session.${k2.id}`].sort());
  assert.equal(dev.fixes[0].undo, 'none');
  await applyFix(d, 'devices', 'sign-out', { items: [`session.${k.id}`] });
  const left = s.auth.devices().map((x) => x.id);
  assert.ok(left.includes(k2.id) && left.includes(keep.id) && !left.includes(k.id));
});

test('B8 guided fixes change nothing (400); their offers carry the page or the command for the platform', async (t) => {
  const s = await setup(t);
  const d = weak(s);
  for (const id of ['bind', 'https', 'open-door', 'offsite', 'two-step', 'version']) await assert.rejects(() => applyFix(d, id, 'x'), (e: Error & { status?: number }) => e.status === 400 || e.status === 409, id);
  for (const [platform, re] of [['linux', /sudo sara access local/], ['win32', /Access/], ['darwin', /sudo sara access local/]] as const) {
    const r = await runSafetyCheck({ ...d, platform });
    assert.match(r.checks.find((c) => c.id === 'bind')!.fixes[0].command!, re);
  }
  const ol = await runSafetyCheck({ ...d, env: { OLLAMA_HOST: '0.0.0.0' }, platform: 'win32' });
  assert.equal(ol.checks.find((c) => c.id === 'open-door')!.status, 'red');
  assert.match(ol.checks.find((c) => c.id === 'open-door')!.fixes[0].command!, /OLLAMA_HOST 127\.0\.0\.1/);
});

test('B9 accept: an amber moves to fine with the note and the verdict follows; a red → 400', async (t) => {
  const s = await setup(t);
  const d = { ...weak(s), env: {} };
  await applyFix(d, 'approvals', 'ask-again');
  await applyFix(d, 'backups', 'auto-on');
  await applyFix(d, 'secrets', 'hide');
  s.app.settings.update({ adultMode: { on: false } });
  let r = await runSafetyCheck(d);
  assert.equal(r.verdict, 'tighten');
  await assert.rejects(() => acceptCheck(d, 'backups', true).then(() => acceptCheck({ ...d }, 'nope', true)), (e: Error & { status?: number }) => e.status === 404 || e.status === 400);
  for (const c of r.checks.filter((x) => x.status === 'amber')) await acceptCheck(d, c.id, true);
  r = await runSafetyCheck(d);
  assert.equal(r.verdict, 'safe');
  assert.ok(r.checks.some((c) => c.accepted));
  s.app.settings.update({ backup: { auto: false } });
  await assert.rejects(() => acceptCheck(d, 'backups', true), (e: Error & { status?: number }) => e.status === 400);
});

test('B10 the weekly quiet check: worse → one notice + push; nothing worse → nothing; better → nothing', async (t) => {
  const s = await setup(t);
  const d = { ...weak(s), env: {} };
  await applyFix(d, 'backups', 'auto-on');
  s.app.settings.update({ safetyCheck: { weekly: true } });
  assert.equal((await weeklySafetyTick(d)).ran, true);
  assert.equal(s.pushes.length, 0, 'the first run only notes where things stand');
  s.clock.now = new Date(START.getTime() + 3 * DAY);
  assert.equal((await weeklySafetyTick(d)).ran, false, 'once a week');
  s.app.settings.update({ backup: { auto: false } });
  s.clock.now = new Date(START.getTime() + 7 * DAY);
  const w = await weeklySafetyTick(d);
  assert.deepEqual(w.worse, ['backups']);
  assert.equal(s.pushes.length, 1);
  assert.match(s.pushes[0].text, /Automatic backups are off/);
  s.clock.now = new Date(START.getTime() + 14 * DAY);
  assert.deepEqual((await weeklySafetyTick(d)).worse, []);
  s.app.settings.update({ backup: { auto: true } });
  s.clock.now = new Date(START.getTime() + 21 * DAY);
  assert.deepEqual((await weeklySafetyTick(d)).worse, []);
  assert.equal(s.pushes.length, 1);
});

test('B11 Today: a red row → one Needs you line; amber only → none', async (t) => {
  const s = await setup(t);
  const d = { ...weak(s), env: {} };
  await runSafetyCheck(d);
  assert.match(String(todaySafetyLine(s.app)?.line), /safety problem/);
  for (const [c, f] of [['approvals', 'ask-again'], ['backups', 'auto-on'], ['secrets', 'hide']]) await applyFix(d, c, f);
  await runSafetyCheck(d);
  assert.equal(todaySafetyLine(s.app), null);
});

test('B12 who: the safety-check routes are owner-only; safety_report is never offered in groups, partner chats or other apps', () => {
  const iso = readFileSync(join(ROOT, 'test', 'household-isolation.test.ts'), 'utf8');
  assert.match(iso, /'safety-check'/);
  const chat = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
  assert.match(chat, /opts\.group \|\| opts\.outside \|\| conv\.partner\) tools = tools\.filter\(\(t\) => t\.spec\.name !== 'safety_report'/);
  // No tool can apply a fix.
  const src = readFileSync(join(ROOT, 'src', 'safety-check.ts'), 'utf8');
  assert.equal((src.match(/name: '[a-z_]+'/g) ?? []).length, 1);
});

test('B13 CLI: doctor --safety prints the check-up, exits 0/1/2 and changes nothing', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const env = { ...process.env, SARA_DATA: dir, SARA_SETUP: 'off', SARA_HOST: '127.0.0.1' };
  delete (env as Record<string, unknown>).SARA_ACCESS;
  const node = process.execPath;
  // A first start makes the files; then backups off (red).
  spawnSync(node, ['--disable-warning=ExperimentalWarning', 'src/main.ts', '--version'], { cwd: ROOT, env, encoding: 'utf8' });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ providers: [], backup: { auto: false } }));
  const bytes = readFileSync(join(dir, 'settings.json'));
  const r = spawnSync(node, ['--disable-warning=ExperimentalWarning', 'src/main.ts', 'doctor', '--safety'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.match(r.stdout, /Automatic backups are off/);
  assert.match(r.stdout, /Fix these first/);
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(readFileSync(join(dir, 'settings.json')).subarray(0, bytes.length).toString().startsWith('{'), true);
  const full = spawnSync(node, ['--disable-warning=ExperimentalWarning', 'src/main.ts', '--doctor'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.match(full.stdout, /\nSafety\n/);
  assert.match(full.stdout, /Fix these first: .*sara doctor --safety/);
});

test('both: zero new runtime dependencies; no new setInterval in main.ts; the check-up touches no safety.ts path', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.equal((main.match(/setInterval\(/g) ?? []).length, 6, "2.53's six timers");
  const src = readFileSync(join(ROOT, 'src', 'safety-check.ts'), 'utf8');
  assert.doesNotMatch(src, /from '\.\/safety\.ts'/);
});
