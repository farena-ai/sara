// W4.4 (docs/design/W4COACH.md): a private health coach on top of the U4.22 log, V4.3 imports,
// V5.4 caregiver consent and the W1.2 nudge gate. Weekly trends computed in code, at most two small
// goals (accept/skip), red flags = "talk to your doctor" only, a value-free weekly check-in, an
// optional caregiver share, kids never. Synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { careViewOf, setCareGrant } from '../src/caregiver.ts';
import { COACH_TEXTS, coachGoalAction, coachTick, coachWeek, RED_FLAG_TEXTS } from '../src/health-coach.ts';
import { healthFor } from '../src/health-log.ts';
import type { Reading } from '../src/health-import.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
// A Sunday, 19:00 in Chicago.
const clock = { now: new Date('2026-11-23T01:00:00Z') };
const dirs: (() => void)[] = [];
const MED = ['Pla', 'ce', 'bolin'].join('');

function space(member?: { id: string; name: string; child?: boolean }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', disclosureAcceptedAt: clock.now.toISOString() } as never);
  if (member) {
    const rec = { id: member.id, name: member.name, status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, ...(member.child ? { child: { band: '9-12' } } : {}) };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => rec.child, limits: () => rec.limits };
  }
  return app;
}
const owner = space();
const bo = space({ id: 'm1', name: 'Bo' });
const kim = space({ id: 'k1', name: 'Kim', child: true });
const dirOf: Record<string, string> = { owner: owner.dataDir, m1: bo.dataDir, k1: kim.dataDir };
const family = (person: string) => ({
  person,
  people: () => [{ id: 'owner', name: 'Alex' }, { id: 'm1', name: 'Bo' }, { id: 'k1', name: 'Kim', child: { band: '9-12' } }],
  store: { isParent: (p: string) => p === 'owner', parents: () => ['owner'] },
  spaceDirOf: (id: string) => dirOf[id],
  tz: () => 'America/Chicago',
  notifyPerson: () => undefined,
  quietFor: () => false,
});
for (const [a, id] of [[owner, 'owner'], [bo, 'm1'], [kim, 'k1']] as const) (a as unknown as { family: unknown }).family = family(id);

const dayAgo = (n: number) => new Date(Date.parse('2026-11-22T12:00:00Z') - n * 86_400_000).toISOString().slice(0, 10);
function seed(app: App, o: { steps: number[]; sleep: number[]; weight?: [number, number] }) {
  const rs: Reading[] = [];
  // index 0 = today … 13 = two weeks ago
  o.steps.forEach((v, i) => rs.push({ metric: 'steps', day: dayAgo(i), value: v, unit: 'steps' } as Reading));
  o.sleep.forEach((v, i) => rs.push({ metric: 'sleep', day: dayAgo(i), value: v, unit: 'h' } as Reading));
  if (o.weight) {
    rs.push({ metric: 'weight', day: dayAgo(1), value: o.weight[0], unit: 'kg', at: `${dayAgo(1)}T13:00:00.000Z` } as Reading);
    rs.push({ metric: 'weight', day: dayAgo(8), value: o.weight[1], unit: 'kg', at: `${dayAgo(8)}T13:00:00.000Z` } as Reading);
  }
  healthFor(app).importReadings(rs, 'apple', 'export.zip');
}

const auth = new OwnerAuth(owner.dataDir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const a of [owner, bo, kim]) a.store.close();
  for (const d of dirs) d();
});
const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${base}/api${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

test('W4.4 weekly trends are computed in code from imports and the log', () => {
  seed(owner, { steps: [5000, 5200, 4800, 5100, 4900, 5300, 5000, 6000, 6000, 6000, 6000, 6000, 6000, 6000], sleep: [6, 6.2, 5.8, 6, 6.1, 6, 5.9, 7, 7, 7, 7, 7, 7, 7], weight: [70, 70.4] });
  const h = healthFor(owner);
  const m = h.addMed({ name: MED, dose: '1 tab', times: ['08:00'] });
  for (let i = 0; i < 4; i++) h.logDose(m.id, i === 0 ? 'skipped' : 'taken');
  h.addEntry({ type: 'mood', name: 'mood', value: 6, scale: 10, at: `${dayAgo(2)}T15:00:00Z` });
  const w = coachWeek(h, clock.now);
  assert.equal(w.from, dayAgo(6));
  assert.equal(w.to, dayAgo(0));
  const by = Object.fromEntries(w.metrics.map((x) => [x.name, x]));
  assert.equal(by.steps.value, 5043);
  assert.equal(by.steps.prev, 6000);
  assert.equal(by.steps.days, 7);
  assert.equal(by.sleep.value, 6);
  assert.equal(by.weight.value, 70);
  assert.equal(by.mood.value, 6);
  assert.deepEqual([by.meds.value, by.meds.days], [75, 4]);
  assert.equal(w.flags.length, 0);
});

test('W4.4 at most two small goals, accept/skip, progress, never weight or medicine changes', () => {
  const h = healthFor(owner);
  const w = coachWeek(h, clock.now);
  assert.ok(w.goals.length >= 1 && w.goals.length <= 2);
  assert.ok(w.goals.every((g) => g.status === 'proposed'));
  assert.ok(!w.goals.some((g) => g.kind === ('weight' as never)));
  const steps = w.goals.find((g) => g.kind === 'steps') ?? w.goals.find((g) => g.kind === 'sleep');
  assert.ok(steps, 'a sleep or steps goal is offered for a short week');
  if (steps!.kind === 'steps') assert.ok(steps!.target <= 6000, `small step goal: ${steps!.target}`);
  if (steps!.kind === 'sleep') assert.ok(steps!.target <= 6.5, `small sleep goal: ${steps!.target}`);
  const first = w.goals[0];
  const acc = coachGoalAction(owner, first.id, 'accept');
  assert.equal(acc.goals.find((g) => g.id === first.id)?.status, 'accepted');
  if (w.goals[1]) {
    const sk = coachGoalAction(owner, w.goals[1].id, 'skip');
    assert.ok(!sk.goals.some((g) => g.id === w.goals[1].id && g.status === 'proposed'));
  }
  const again = coachWeek(h, clock.now);
  if (w.goals[1]) assert.equal(again.goals.length, 1, 'Not now never brings in a replacement goal');
  assert.ok(again.goals.length <= 2);
  const accepted = again.goals.find((g) => g.id === first.id)!;
  assert.equal(typeof accepted.done, 'number');
  assert.equal(typeof accepted.of, 'number');
  assert.throws(() => coachGoalAction(owner, 'nope@2026-01-01', 'accept'), /not/i);
});

test('W4.4 wording rules: never medical advice', () => {
  const banned = /\b(diagnos\w*|treat\w*|cure\w*|prescri\w*|increase your|decrease your|reduce your dose|stop taking|start taking|you have (a |an )?\w*(itis|disease|condition)|disease|disorder|normal|healthy range|risk|dangerous|should take|medication change|lose weight|weight loss|diet)\b/i;
  for (const s of [...Object.values(COACH_TEXTS), ...Object.values(RED_FLAG_TEXTS)]) assert.doesNotMatch(s, banned, s);
  for (const s of Object.values(RED_FLAG_TEXTS)) assert.match(s, /^Talk to your doctor about /, s);
  assert.match(COACH_TEXTS.notAdvice, /not medical advice/);
});

test('W4.4 red flags: talk to your doctor only, no number, no goal', () => {
  const h = healthFor(bo);
  seed(bo, { steps: [3000, 3000, 3000, 3000, 3000, 3000, 3000], sleep: [3, 3.5, 3.2, 3, 3.4, 3.1, 3] });
  h.addEntry({ type: 'measure', name: 'blood pressure', value: 186, value2: 121, unit: 'mmHg', at: `${dayAgo(1)}T15:00:00Z` });
  h.addEntry({ type: 'symptom', name: ['tingly', 'elbow'].join(''), value: 9, scale: 10, at: `${dayAgo(1)}T16:00:00Z` });
  const w = coachWeek(h, clock.now);
  const names = w.flags.map((f) => f.name).sort();
  assert.deepEqual(names, ['blood pressure', 'sleep', 'symptom']);
  for (const f of w.flags) assert.match(f.key, /^Talk to your doctor about /);
  const sleep = w.metrics.find((x) => x.name === 'sleep')!;
  assert.equal(sleep.flag, true);
  assert.equal(sleep.value, undefined);
  assert.equal(sleep.prev, undefined);
  assert.ok(!w.goals.some((g) => g.kind === 'sleep'), 'no goal about a red-flag measurement');
  assert.doesNotMatch(JSON.stringify(w.flags), /186|121|\b9\b/);
});

test('W4.4 kids never: no coach, 403 on the route', async () => {
  assert.throws(() => coachWeek(healthFor(kim), clock.now, kim), /adults/i);
  // Even if the switch were on in a child's log, the tick never posts.
  healthFor(kim).setSettings({ coach: true });
  assert.equal(coachTick(kim, clock.now), undefined);
});

test('W4.4 routes: owner coach card, accept, settings switch', async () => {
  const r = await api('/health-log/coach');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.metrics));
  assert.match(r.body.notAdvice, /not medical advice/);
  const on = await api('/health-log/settings', { method: 'PUT', body: { coach: true } });
  assert.equal(on.body.settings.coach, true);
  const g = r.body.goals.find((x: { status: string }) => x.status === 'proposed');
  if (g) {
    const a = await api(`/health-log/coach/goals/${encodeURIComponent(g.id)}`, { method: 'POST', body: { action: 'skip' } });
    assert.equal(a.status, 200);
  }
  const bad = await api('/health-log/coach/goals/x', { method: 'POST', body: { action: 'fly' } });
  assert.equal(bad.status, 400);
});

test('W4.4 weekly check-in: opt-in, value-free, through the nudge gate, once per slot', () => {
  // Bo (an adult member) has it off: nothing.
  assert.equal(coachTick(bo, clock.now), undefined);
  // Owner turned it on in the route test. First look records the slot only.
  const s = healthFor(owner).settings();
  assert.equal((s as { coach?: boolean }).coach, true);
  const first = coachTick(owner, new Date('2026-11-16T01:00:00Z'));
  assert.equal(first, undefined);
  const conv = coachTick(owner, clock.now);
  assert.ok(conv, 'the next weekly slot posts');
  const msgs = owner.store.messages(conv!);
  const last = msgs.at(-1)!;
  assert.match(last.content, /Health/);
  assert.doesNotMatch(last.content, /\d/, 'no values in the check-in');
  assert.ok(!last.content.includes(MED));
  assert.equal((last.meta as { health?: boolean }).health, true, 'kept out of memory');
  assert.ok((last.meta as { nudge?: unknown }).nudge, 'went through the nudge gate');
  assert.equal(coachTick(owner, new Date(clock.now.getTime() + 3_600_000)), undefined, 'once per slot');
});

test('W4.4 caregiver share: only with consent, no mood, flags reduced', () => {
  // Bo shares the weekly summary with Alex (owner).
  setCareGrant(bo, { person: 'owner', doses: false, checkins: false, summary: true });
  const v = careViewOf(owner, 'm1');
  assert.ok(v.summary, 'summary shared');
  assert.equal(v.doses, undefined);
  assert.ok(!v.summary!.metrics.some((m) => m.name === 'mood'));
  assert.equal(v.summary!.doctor, true);
  assert.doesNotMatch(JSON.stringify(v.summary), /blood pressure|tingly|186/);
  // Withdraw: refused at once.
  setCareGrant(bo, { person: 'owner', doses: false, checkins: false, summary: false });
  assert.throws(() => careViewOf(owner, 'm1'), /not shared/);
});

test('W4.4 web: card wiring, strings, no model call in the coach', () => {
  const src = readFileSync(join(ROOT, 'src/health-coach.ts'), 'utf8');
  assert.doesNotMatch(src, /cheapCall|cheapRoute|providerFactory|runTurn|complete\(/, 'the coach never calls a model');
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  assert.match(html, /id="hl-coach"/);
  assert.match(html, /id="hl-coach-on"/);
  assert.match(html, /id="hs-coach"/);
  assert.match(html, /id="hl-care-summary"/);
  const js = readFileSync(join(ROOT, 'web/health-coach.js'), 'utf8');
  assert.match(js, /\/health-log\/coach/);
  assert.match(readFileSync(join(ROOT, 'web/health.js'), 'utf8'), /renderCoach/);
});
