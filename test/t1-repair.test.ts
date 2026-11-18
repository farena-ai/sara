// ROADMAP_T T1+T2 (docs/SELF_REPAIR.md): the self-repair engine with a fake server (doctor, health, models,
// add-ons, jobs, errands, database, disk, apps, skills) and a fake clock. Detection, each level 1 fix with
// verify and automatic undo when health gets worse, the permission modes (incl. the 24-hour switch running
// out), level 2 growth on trial, and the never-list.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { detectProblems, fullOn, neverTouch, Repair, RepairRefused, repairSettings, runsAlone, safeSet, scoreOf, type RepairEnv } from '../src/repair.ts';

type Audit = { action: string; target?: string; outcome: string };
function fake(over: Partial<RepairEnv> = {}) {
  const clock = { now: new Date('2026-11-16T12:00:00Z') };
  let settings: Record<string, any> = {
    providers: [
      { id: 'cloud', label: 'Cloud' },
      { id: 'ollama', label: 'Ollama' },
    ],
    defaultProviderId: 'cloud',
    defaultModel: 'big-1',
    defaultFallbacks: [{ providerId: 'ollama', model: 'small-1' }],
  };
  const st = {
    down: new Set<string>(),
    addons: [] as { id: string; name: string; version: string; status: string; enabled: boolean }[],
    addonRestartWorks: true,
    jobs: [] as { id: number; label: string; startedAt: string }[],
    errands: [] as { id: number; goal: string; status: string; updatedAt: string }[],
    dbCheck: 'ok',
    bloat: { freeBytes: 0, totalBytes: 100e6 },
    backups: [] as string[],
    vacuumed: 0,
    reindexed: 0,
    free: 50e9 as number | null,
    cacheBytes: 0,
    apps: [] as { id: string; label: string; version: string; state?: string; canAsk: boolean }[],
    asked: [] as string[],
    skills: new Map<string, string>(),
    turnErrors: [] as { at: string; kind: string; message: string }[],
    toolErrors: [] as { at: string; tool: string }[],
    signedOut: false,
    retryWorks: false,
    /** A setting that makes health worse when set (a fix that hurts). */
    hurtsWhen: undefined as undefined | ((s: Record<string, any>) => boolean),
    privateLocal: false,
  };
  const audits: Audit[] = [];
  const reports: string[] = [];
  const env: RepairEnv = {
    now: () => clock.now,
    settings: { get: () => structuredClone(settings), update: (p) => (settings = { ...settings, ...p }) },
    audit: (r) => audits.push(r),
    privateLocal: () => st.privateLocal,
    health: () => (st.hurtsWhen?.(settings) ? [{ name: 'Memory', ok: false, detail: 'broken by the change' }] : [{ name: 'Memory', ok: true, detail: 'ok' }]),
    doctor: async () => [{ name: 'Testing browser', status: 'fail', detail: 'not found' }],
    selfTest: async () => [{ id: 'desktop', area: 'Desktop app', status: 'attention', text: 'The desktop app is not connected.' }],
    history: () => ({ turns: 10, failed: 1 }),
    turnErrors: () => st.turnErrors,
    toolErrors: () => st.toolErrors,
    trouble: () => [
      ...[...st.down].map((id) => ({ id: `model:${id}`, kind: 'unreachable', key: '{service} did not answer.', params: { service: id }, fix: { page: 'models-providers' } })),
      ...(st.signedOut ? [{ id: 'mail:g1', kind: 'mail', key: '{service} signed me out', params: { service: 'Gmail' }, fix: { page: 'ab-google' } }] : []),
    ],
    models: {
      providers: () => [
        { id: 'cloud', label: 'Cloud', local: false, daemon: false },
        { id: 'ollama', label: 'Ollama', local: true, daemon: true },
      ],
      retry: async (id) => {
        if (st.retryWorks) st.down.delete(id);
        return !st.down.has(id);
      },
      pull: async () => true,
      onThisComputer: (id) => id === 'ollama',
    },
    jobs: { running: () => st.jobs, stop: (id) => st.jobs.length !== (st.jobs = st.jobs.filter((j) => j.id !== id)).length },
    errands: {
      open: () => st.errands,
      nudge: (id) => {
        const e = st.errands.find((x) => x.id === id);
        if (e) e.updatedAt = clock.now.toISOString();
      },
      updatedAt: (id) => st.errands.find((x) => x.id === id)?.updatedAt,
    },
    addons: {
      list: () => st.addons,
      restart: async (id) => {
        const a = st.addons.find((x) => x.id === id)!;
        if (st.addonRestartWorks) a.status = 'ready';
      },
      setEnabled: async (id, on) => {
        const a = st.addons.find((x) => x.id === id)!;
        a.enabled = on;
        a.status = on ? 'crashed' : 'stopped';
      },
    },
    db: {
      check: () => st.dbCheck,
      bloat: () => st.bloat,
      backup: () => {
        const n = `sara-auto-${st.backups.length + 1}.tar.gz`;
        st.backups.push(n);
        return n;
      },
      reindex: () => {
        st.reindexed++;
        st.dbCheck = 'ok';
      },
      vacuum: () => {
        st.vacuumed++;
        st.bloat = { freeBytes: 0, totalBytes: 100e6 };
      },
    },
    disk: {
      freeBytes: () => st.free,
      caches: () => ({ bytes: st.cacheBytes }),
      clean: () => {
        const bytes = st.cacheBytes;
        st.free = (st.free ?? 0) + bytes;
        st.cacheBytes = 0;
        return { bytes, files: 12 };
      },
    },
    apps: { list: () => st.apps, ask: (id) => (st.asked.push(id), true) },
    grow: {
      skill: (d) => (st.skills.set(d.name, d.body), { name: d.name, scope: 'companion' }),
      removeSkill: (_scope, name) => void st.skills.delete(name),
      automation: (d) => ({ id: 7, name: String(d.name ?? 'auto') }),
      removeAutomation: () => {},
    },
    report: (t) => reports.push(t),
    ...over,
  };
  const db = new DatabaseSync(':memory:');
  const rep = new Repair(env, db);
  return { env, st, rep, clock, audits, reports, settings: () => settings, set: (p: Record<string, unknown>) => (settings = { ...settings, ...p }) };
}
const ids = (ps: { id: string }[]) => ps.map((p) => p.id).sort();

test('T1 detection: one list with stable ids, plain words, evidence and severity from every source', async () => {
  const f = fake();
  assert.deepEqual(ids(await detectProblems(f.env)), [], 'a healthy server has no problems');
  f.st.down.add('cloud');
  f.st.signedOut = true;
  f.st.addons.push({ id: 'slack', name: 'Slack', version: '1.2.0', status: 'crashed', enabled: true });
  f.st.jobs.push({ id: 4, label: 'npm test', startedAt: new Date(f.clock.now.getTime() - 3 * 3600_000).toISOString() }, { id: 5, label: 'fresh', startedAt: f.clock.now.toISOString() });
  f.st.errands.push({ id: 9, goal: 'Refund the charge', status: 'working', updatedAt: '2026-11-14T00:00:00Z' }, { id: 10, goal: 'Waiting on them', status: 'waiting_others', updatedAt: '2026-11-01T00:00:00Z' });
  f.st.dbCheck = 'row 12 missing from index';
  f.st.free = 0.4e9;
  f.st.cacheBytes = 3e9;
  f.st.apps.push({ id: 'win1', label: 'Sara app on Windows', version: '3.17.0', state: 'failed', canAsk: true });
  f.set({ fallbackAfterSec: 5000, timeZone: 'Mars/Olympus', 'toolPermissions': { shell: 'auto' } });
  const t = (n: number) => new Date(f.clock.now.getTime() - n * 3600_000).toISOString();
  f.st.turnErrors.push({ at: t(1), kind: 'Timeout', message: 'x' }, { at: t(5), kind: 'Timeout', message: 'x' }, { at: t(30), kind: 'Timeout', message: 'x' }, { at: t(400), kind: 'Timeout', message: 'old' });
  f.st.toolErrors.push({ at: t(1), tool: 'web_fetch' }, { at: t(2), tool: 'web_fetch' });
  const ps = await f.rep.detect();
  assert.deepEqual(ids(ps), ['addon:slack', 'app:win1', 'db:integrity', 'disk:low', 'errand:9', 'grow:turn:Timeout', 'job:4', 'model:cloud', 'setting:fallbackAfterSec', 'setting:timeZone', 'signin:g1']);
  for (const p of ps) {
    assert.ok(p.text && p.evidence.length && ['low', 'medium', 'high'].includes(p.severity), p.id);
  }
  assert.equal(ps.find((p) => p.id === 'signin:g1')!.fixable, false, 'she asks the person to sign in again; never types passwords');
  assert.equal(ps.find((p) => p.id === 'grow:turn:Timeout')!.level, 2);
  assert.equal(ps.find((p) => p.id === 'grow:turn:Timeout')!.params!.n, 3, 'only this week counts');
  // Deep: the doctor and the self-test join.
  const deep = ids(await detectProblems(f.env, { deep: true }));
  assert.ok(deep.includes('doctor:Testing browser') && deep.includes('selftest:desktop'));
  // Same problem, same id on the next pass (the database check stays on while it is damaged).
  assert.deepEqual(ids(await f.rep.detect()), ids(ps));
  // The integrity check reads the whole file: on the tick at most once a day.
  let reads = 0;
  const g = fake({ db: { check: () => (reads++, 'ok'), bloat: () => ({ freeBytes: 0, totalBytes: 1 }), backup: () => 'b', reindex: () => {}, vacuum: () => {} } });
  await g.rep.detect();
  await g.rep.detect();
  assert.equal(reads, 1);
  await g.rep.detect({ deep: true });
  assert.equal(reads, 2, 'Check now always reads it');
});

test('T1 detection runs on the tick at most every 15 minutes', async () => {
  let n = 0;
  const f = fake({ health: () => (n++, []) });
  f.set({ repair: { permission: 'ask' } });
  f.rep.due(f.clock.now);
  await f.rep.idle();
  f.clock.now = new Date(f.clock.now.getTime() + 10 * 60_000);
  f.rep.due(f.clock.now);
  await f.rep.idle();
  assert.equal(n, 1, 'not again within 15 minutes');
  f.clock.now = new Date(f.clock.now.getTime() + 6 * 60_000);
  f.rep.due(f.clock.now);
  await f.rep.idle();
  assert.equal(n, 2);
});

test('T1 playbook: model service (retry, then the backup model; private local mode keeps it local), undo on worse health', async () => {
  // Retry works.
  let f = fake();
  f.st.down.add('cloud');
  f.st.retryWorks = true;
  await f.rep.detect();
  let [r] = await f.rep.fix('model:cloud', { by: 'owner' });
  assert.equal(r!.result, 'fixed');
  assert.equal(f.settings().defaultProviderId, 'cloud', 'no switch when it answers again');
  // Still down: switch to the configured backup; Undo puts the old one back.
  f = fake();
  f.st.down.add('cloud');
  await f.rep.detect();
  f.st.down.clear(); // the switch makes Model healthy again (the backup answers)
  f.env.models!.retry = async () => false;
  f.env.trouble = () => (f.settings().defaultProviderId === 'cloud' ? [{ id: 'model:cloud', kind: 'unreachable', key: 'k', params: {} }] : []);
  [r] = await f.rep.fix('model:cloud', { by: 'owner' });
  assert.equal(r!.result, 'fixed');
  assert.equal(f.settings().defaultProviderId, 'ollama');
  assert.equal(f.settings().defaultModel, 'small-1');
  assert.ok(r!.undoable);
  const u = await f.rep.undo(r!.id);
  assert.equal(u.result, 'undone');
  assert.equal(f.settings().defaultProviderId, 'cloud');
  assert.equal(f.settings().defaultModel, 'big-1');
  await assert.rejects(f.rep.undo(r!.id), RepairRefused, 'undone once');
  // The switch makes health worse: put back by itself, and said so.
  f = fake();
  f.env.models!.retry = async () => false;
  f.env.trouble = () => [{ id: 'model:cloud', kind: 'unreachable', key: 'k', params: {} }].filter(() => f.settings().defaultProviderId === 'cloud');
  f.st.hurtsWhen = (s) => s.defaultProviderId === 'ollama';
  await f.rep.detect();
  [r] = await f.rep.fix('model:cloud', { by: 'owner' });
  assert.equal(r!.result, 'undone');
  assert.ok(r!.undone);
  assert.equal(f.settings().defaultProviderId, 'cloud');
  assert.ok(r!.steps.some((s) => /Health got worse/.test(s.text)));
  // Private local mode: a cloud backup is never picked.
  f = fake();
  f.st.privateLocal = true;
  f.set({ defaultProviderId: 'ollama', defaultModel: 'small-1', defaultFallbacks: [{ providerId: 'cloud', model: 'big-1' }] });
  f.st.down.add('ollama');
  await f.rep.detect();
  [r] = await f.rep.fix('model:ollama', { by: 'owner' });
  assert.equal(f.settings().defaultProviderId, 'ollama', 'stays on this computer');
  assert.ok(r!.steps.some((s) => /Downloading/.test(s.text)), 'a local model is downloaded again');
  assert.ok(r!.steps.some((s) => /private local mode/.test(s.text)));
});

test('T1 playbook: stuck job and errand, add-on restart or off (undo), database with a backup first, caches, settings, apps', async () => {
  const f = fake();
  f.st.jobs.push({ id: 4, label: 'npm test', startedAt: '2026-11-16T08:00:00Z' });
  f.st.errands.push({ id: 9, goal: 'Refund', status: 'working', updatedAt: '2026-11-14T00:00:00Z' });
  f.st.addons.push({ id: 'slack', name: 'Slack', version: '1.2.0', status: 'crashed', enabled: true });
  f.st.dbCheck = 'row 12 missing from index';
  f.st.free = 0.5e9;
  f.st.cacheBytes = 2e9;
  f.set({ fallbackAfterSec: 5000, backup: { auto: true, keep: -3 } });
  f.st.apps.push({ id: 'win1', label: 'Sara app on Windows', version: '3.17.0', state: 'failed', canAsk: true });
  await f.rep.detect();
  const runs = await f.rep.fix('everything', { by: 'owner' });
  const by = Object.fromEntries(runs.map((r) => [r.problem, r]));
  assert.equal(by['job:4']!.result, 'fixed');
  assert.equal(f.st.jobs.length, 0);
  assert.equal(by['errand:9']!.result, 'fixed');
  assert.equal(by['addon:slack']!.result, 'fixed', 'restarting it worked');
  assert.equal(by['db:integrity']!.result, 'fixed');
  assert.deepEqual(f.st.backups, ['sara-auto-1.tar.gz'], 'a backup before touching the database');
  assert.ok(by['db:integrity']!.steps[0]!.text.startsWith('Made a backup first'));
  assert.equal(f.st.reindexed, 1);
  assert.equal(f.st.vacuumed, 1);
  assert.equal(by['disk:low']!.result, 'fixed');
  assert.equal(f.st.cacheBytes, 0);
  assert.equal(by['setting:fallbackAfterSec']!.result, 'fixed');
  assert.equal(f.settings().fallbackAfterSec, undefined, 'back to its default');
  assert.equal(f.settings().backup.keep, 7);
  assert.equal(f.settings().backup.auto, true, 'the rest of the object stays');
  assert.match(JSON.stringify(by['setting:fallbackAfterSec']!.steps), /5000/, 'says which value it was');
  assert.equal(by['app:win1']!.result, 'needs-you');
  assert.deepEqual(f.st.asked, ['win1'], 'the app reinstalls through its own updater');
  // Undo a settings fix puts the old value back.
  await f.rep.undo(by['setting:fallbackAfterSec']!.id);
  assert.equal(f.settings().fallbackAfterSec, 5000);
  // An add-on that keeps crashing is turned off; Undo turns it back on.
  const g = fake();
  g.st.addons.push({ id: 'slack', name: 'Slack', version: '1.2.0', status: 'crashed', enabled: true });
  g.st.addonRestartWorks = false;
  await g.rep.detect();
  const [a] = await g.rep.fix('addon:slack', { by: 'owner' });
  assert.equal(a!.result, 'fixed');
  assert.equal(g.st.addons[0]!.enabled, false);
  await g.rep.undo(a!.id);
  assert.equal(g.st.addons[0]!.enabled, true);
  // Every action has an audit row.
  assert.ok(f.audits.filter((x) => x.action === 'repair.fix').length >= 8);
  assert.ok(f.audits.some((x) => x.action === 'repair.undo'));
  // The log: level, problem, steps, snapshot, result, undone.
  const log = f.rep.runs();
  assert.ok(log.length >= 8 && log.every((r) => r.level === 1 && r.steps.length && r.at));
  assert.ok(log.find((r) => r.problem === 'db:integrity')!.snapshot!.includes('sara-auto-1'));
});

test('T1 a settings fix that makes health worse is put back by itself', async () => {
  const f = fake();
  f.set({ timeZone: 'Mars/Olympus' });
  f.st.hurtsWhen = (s) => s.timeZone === undefined;
  await f.rep.detect();
  const [r] = await f.rep.fix('setting:timeZone', { by: 'owner' });
  assert.equal(r!.result, 'undone');
  assert.equal(f.settings().timeZone, 'Mars/Olympus');
  assert.ok(f.audits.some((x) => x.action === 'repair.undo'));
});

test('T1 permissions: auto1 runs level 1 on its own and reports after; ask never does; 24 hours then expires', async () => {
  const f = fake();
  assert.deepEqual(repairSettings(f.settings()), { permission: 'auto1', fullUntil: null, share: false, shareLinks: [] }, 'auto1 by default (U3.17: sharing off)');
  f.set({ fallbackAfterSec: 5000 });
  f.rep.due(f.clock.now);
  await f.rep.idle();
  assert.equal(f.settings().fallbackAfterSec, undefined, 'fixed on its own');
  assert.equal(f.rep.runs()[0]!.by, 'auto');
  assert.equal(f.reports.length, 1, 'and reported after');
  // ask: nothing on its own.
  const g = fake();
  g.set({ fallbackAfterSec: 5000, repair: { permission: 'ask' } });
  g.rep.due(g.clock.now);
  await g.rep.idle();
  assert.equal(g.settings().fallbackAfterSec, 5000);
  assert.equal(g.rep.runs().length, 0);
  assert.equal(g.rep.allowedAlone(['setting:fallbackAfterSec']), false);
  // Full permission for 24 hours: level 1 runs alone even with 'ask', until it runs out.
  const until = new Date(g.clock.now.getTime() + 24 * 3600_000).toISOString();
  g.set({ repair: { permission: 'ask', fullUntil: until } });
  assert.equal(fullOn(g.settings(), g.clock.now), true);
  assert.equal(g.rep.allowedAlone(['setting:fallbackAfterSec']), true);
  assert.equal(runsAlone(g.settings(), 2, g.clock.now), false, 'level 2 always asks');
  g.clock.now = new Date(g.clock.now.getTime() + 24 * 3600_000 + 1000);
  assert.equal(fullOn(g.settings(), g.clock.now), false, 'expired after 24 hours');
  assert.equal(g.rep.allowedAlone(['setting:fallbackAfterSec']), false);
  // A failed automatic try is not repeated within a day.
  const h = fake();
  h.st.jobs.push({ id: 4, label: 'x', startedAt: '2026-11-16T08:00:00Z' });
  h.env.jobs!.stop = () => false;
  h.rep.due(h.clock.now);
  await h.rep.idle();
  h.clock.now = new Date(h.clock.now.getTime() + 20 * 60_000);
  h.rep.due(h.clock.now);
  await h.rep.idle();
  assert.equal(h.rep.runs().length, 1);
});

test('T2 grow: repeated failures and "learn to do X" become a skill, automation or add-on, on trial, undoable', async () => {
  const f = fake();
  const t = (n: number) => new Date(f.clock.now.getTime() - n * 3600_000).toISOString();
  f.st.toolErrors.push({ at: t(1), tool: 'web_fetch' }, { at: t(2), tool: 'web_fetch' }, { at: t(3), tool: 'web_fetch' });
  const ps = await f.rep.detect();
  assert.ok(ps.some((p) => p.id === 'grow:tool:web_fetch' && p.level === 2));
  assert.equal((await f.rep.fix('everything', { by: 'owner' })).length, 0, '"everything" is level 1 only');
  const [r] = await f.rep.fix('grow:tool:web_fetch', { by: 'chat' });
  assert.equal(r!.result, 'applied');
  assert.ok(f.st.skills.has('handle-web-fetch'));
  assert.ok(r!.trialUntil && Date.parse(r!.trialUntil) > f.clock.now.getTime(), 'starts on trial');
  assert.ok(!(await f.rep.detect()).some((p) => p.id === 'grow:tool:web_fetch'), 'not proposed again for two weeks');
  await f.rep.undo(r!.id);
  assert.equal(f.st.skills.has('handle-web-fetch'), false);
  const l = await f.rep.learn({ what: 'Check the shared calendar every Monday', body: '# Monday calendar\n1. Read it.' }, 'chat');
  assert.equal(l.result, 'applied');
  assert.match(f.st.skills.get('learned-check-the-shared-calendar-every-monday')!, /Monday calendar/);
  const au = await f.rep.learn({ kind: 'automation', what: 'Weekly backup reminder', automation: { name: 'Weekly backup reminder', trigger: { kind: 'schedule' } } }, 'chat');
  assert.equal(au.result, 'applied');
  assert.ok(au.undoable && au.trialUntil);
  const ad = await f.rep.learn({ kind: 'addon', what: 'Read my Notion pages' }, 'chat');
  assert.equal(ad.result, 'needs-you', 'add-ons install through Get more with their own review');
  // Declined: quiet for two weeks.
  const g = fake();
  g.st.turnErrors.push({ at: t(1), kind: 'Timeout', message: '' }, { at: t(2), kind: 'Timeout', message: '' }, { at: t(3), kind: 'Timeout', message: '' });
  await g.rep.detect();
  g.rep.decline('grow:turn:Timeout', 'owner');
  assert.ok(!(await g.rep.detect()).some((p) => p.level === 2));
  assert.ok(g.audits.some((x) => x.action === 'repair.grow' && x.outcome === 'refused'));
});

test('T1 never-list: safety, limits, kid mode, approvals, audit, permissions and vault are never written', async () => {
  for (const p of ['safety', 'safety.level', 'hardLimits', 'kidMode', 'family.kids', 'toolPermissions', 'approvals', 'auditTrail', 'repair', 'repair.permission', 'repair.fullUntil', 'adultMode', 'privateLocal', 'vault', 'providers.0.apiKey', 'budgets', 'selfCode.cap']) assert.ok(neverTouch(p), p);
  for (const p of ['fallbackAfterSec', 'timeZone', 'defaultModel', 'backup.keep']) assert.ok(!neverTouch(p), p);
  const f = fake();
  assert.throws(() => safeSet(f.env, 'toolPermissions', { shell: 'auto' }), RepairRefused);
  assert.throws(() => safeSet(f.env, 'repair.permission', 'auto1'), RepairRefused, 'never gives herself more permission');
  assert.equal(f.settings().toolPermissions, undefined);
  assert.ok(f.audits.some((x) => x.action === 'repair.setting' && x.outcome === 'refused'));
  // A problem id that names a never-path is refused (and audited), even when asked for directly.
  f.set({ repair: { permission: 'ask' } });
  await f.rep.detect();
  const [r] = await f.rep.fix('setting:repair.permission', { by: 'chat' });
  assert.equal(r!.result, 'refused');
  assert.deepEqual(f.settings().repair, { permission: 'ask' });
  assert.ok(f.audits.some((x) => x.action === 'repair.fix' && x.outcome === 'refused'));
  // The engine has no vault at all.
  assert.ok(!('vault' in f.env));
  assert.equal(scoreOf([]), 0);
});
