// R2 (src/get-started.ts, src/routes/get-started.ts): guided setup progress, skip and resume, the
// sample space's isolation and removal, starter packs apply and revert, household isolation.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { automationsFor } from '../src/automations.ts';
import { applyPack, detect, guideView, loadSamples, PACK_DEFS, packNote, PACKS, PROGRESS_FILE, readProgress, readSamples, removeSamples, revertPack, SAMPLE_FILE, SAMPLE_KINDS, stepAction, stepsFor } from '../src/get-started.ts';
import { memberRouteCheck } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { getLayout, putLayout, SECTIONS } from '../src/today-layout.ts';
import { TRY_CARDS } from '../web/try-cards.js';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const none = { devices: [], pushDevices: 0 };

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-15T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}

/** Every table's row count (the sample space must never change one). */
function counts(app: ReturnType<typeof makeApp>): Record<string, number> {
  const tables = app.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, Number((app.store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
}

test('R2 guide: seven steps (W2.2 added bring and chat), progress saved in the person\'s own folder, skip and resume', (t) => {
  const { app, dir } = rig(t);
  let v = guideView(app, none);
  assert.deepEqual(v.steps.map((s) => s.id), ['model', 'bring', 'chat', 'mail', 'calendar', 'phone', 'computer']);
  assert.equal(v.at, 'model');
  assert.equal(v.done, 0);
  assert.equal(v.complete, false);
  stepAction(app, 'model', 'skip');
  stepAction(app, 'bring', 'skip');
  stepAction(app, 'chat', 'skip');
  stepAction(app, 'mail', 'skip');
  v = guideView(app, none);
  assert.equal(v.at, 'calendar', 'skipping moves on');
  assert.deepEqual(v.steps.filter((s) => s.state === 'skipped').map((s) => s.id), ['model', 'bring', 'chat', 'mail']);
  // Saved on disk: a new view (a reload, another device) comes back at the same step.
  assert.ok(existsSync(join(dir, PROGRESS_FILE)));
  assert.equal(readProgress(app).at, 'calendar');
  // Resume a skipped step: it is to do again and shown.
  stepAction(app, 'mail', 'resume');
  v = guideView(app, none);
  assert.equal(v.at, 'mail');
  assert.equal(v.steps.find((s) => s.id === 'mail')?.state, 'todo');
  for (const id of ['mail', 'calendar', 'phone', 'computer'] as const) stepAction(app, id, 'skip');
  assert.equal(guideView(app, none).complete, true, 'all skipped counts as complete');
  // A member has no model step (their models are the owner's).
  assert.deepEqual(stepsFor(true), ['mail', 'calendar', 'phone', 'computer']);
  assert.throws(() => stepAction(app, 'model', 'skip', true));
});

test('R2 guide: steps tick themselves from what is really connected', (t) => {
  const { app } = rig(t);
  assert.deepEqual(detect(app, none), { model: false, bring: false, chat: false, mail: false, calendar: false, phone: false, computer: false });
  app.settings.update({ defaultProviderId: 'fake', defaultModel: 'fake-model' } as never);
  app.google = { status: () => ({ connected: true, gmail: true, calendar: false }) } as never;
  const d = detect(app, { devices: ['Sara app on Android', 'Sara app on Windows'], pushDevices: 0 });
  assert.deepEqual(d, { model: true, bring: false, chat: false, mail: true, calendar: false, phone: true, computer: true });
  // A plain browser on a computer is not "the Sara app on your computer".
  assert.equal(detect(app, { devices: ['Chrome on Windows'], pushDevices: 0 }).computer, false);
  // A done step is never the one shown: the first one left is.
  stepAction(app, 'model', 'go');
  const v = guideView(app, { devices: ['Sara app on Android', 'Sara app on Windows'], pushDevices: 1 });
  assert.equal(v.at, 'bring');
  assert.equal(v.done, 4);
});

test('R2 sample space: examples never touch a real table, and Remove takes all of them', (t) => {
  const { app, dir } = rig(t);
  const before = counts(app);
  const cards = loadSamples(app, '2026-11-15');
  assert.deepEqual(cards.map((c) => c.kind), [...SAMPLE_KINDS]);
  assert.deepEqual(SAMPLE_KINDS, ['bill', 'package', 'watch', 'decision', 'invoice']);
  assert.ok(cards.every((c) => c.sample === true && c.id === `sample-${c.kind}`));
  assert.equal(cards.find((c) => c.kind === 'bill')?.day, '2026-11-18');
  assert.deepEqual(counts(app), before, 'no row added to any table');
  assert.equal(readSamples(app).on, true);
  assert.equal(guideView(app, none).samples, true);
  // Today's own data has no examples in it.
  const today = readFileSync(join(dir, SAMPLE_FILE), 'utf8');
  assert.match(today, /"sample": true/);
  assert.equal(removeSamples(app), true);
  assert.equal(existsSync(join(dir, SAMPLE_FILE)), false);
  assert.deepEqual(readSamples(app), { on: false, loadedAt: null, cards: [] });
  assert.deepEqual(counts(app), before);
  assert.equal(removeSamples(app), false, 'removing twice is harmless');
});

test('R2 starter packs: apply adds routines switched off, orders Today, gives her a hint; revert undoes it', (t) => {
  const { app } = rig(t);
  const ids = new Set(TRY_CARDS.map((c) => c.id));
  for (const id of PACKS) {
    const def = PACK_DEFS[id];
    assert.ok(def.tryCards.length >= 3 && def.tryCards.every((c) => ids.has(c)), `${id}: real Try cards`);
    assert.deepEqual([...def.sections].sort(), [...SECTIONS].sort(), `${id}: every section once`);
    assert.ok(def.routines.length >= 1);
  }
  assert.deepEqual([...PACKS], ['household', 'business', 'sales', 'student']);
  const autos = automationsFor(app);
  const mine = autos.create({ name: 'My own', trigger: { kind: 'schedule', every: 'day', time: '07:00' }, actions: [{ kind: 'notify', text: 'Hi' }] });
  const sectionsBefore = getLayout(app).prefs.sections;
  assert.equal(packNote(app), undefined);

  const r = applyPack(app, 'business');
  assert.equal(r.added.length, PACK_DEFS.business.routines.length);
  for (const id of r.added) assert.equal(autos.get(id)?.enabled, false, 'a pack routine waits for Allow');
  assert.deepEqual(getLayout(app).prefs.sections, PACK_DEFS.business.sections);
  assert.match(packNote(app) ?? '', /small business/);

  // Switching packs undoes the first one.
  const r2 = applyPack(app, 'student');
  assert.deepEqual(r2.removed.sort(), r.added.sort());
  for (const id of r.added) assert.equal(autos.get(id), undefined);
  // One Allow: a routine the person turned on stays theirs when the pack goes.
  const allowed = readProgress(app).pack!.automations[0];
  autos.setEnabled(allowed, true);
  const back = revertPack(app);
  assert.deepEqual(back.kept, [allowed]);
  assert.equal(autos.get(allowed)?.enabled, true);
  assert.equal(readProgress(app).pack, null);
  assert.deepEqual(getLayout(app).prefs.sections, sectionsBefore, 'Today\'s order is back');
  assert.ok(autos.get(mine.id), 'their own automation is never touched');
  assert.equal(packNote(app), undefined);
  // A Today order they changed after the pack is theirs: revert leaves it.
  applyPack(app, 'household');
  putLayout(app, { sections: ['work', 'day', 'needs', 'her', 'more'] });
  revertPack(app);
  assert.deepEqual(getLayout(app).prefs.sections, ['work', 'day', 'needs', 'her', 'more']);
});

async function server(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner', releases?: { get(): Promise<never> }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-15T15:00:00Z') });
  app.companionId = 'main';
  const auth = new OwnerAuth(dir);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(releases ? { releases } : {}), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown, signedIn = true) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(signedIn ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, type: res.headers.get('content-type') ?? '' };
  }
  return { app, api, base, dir };
}

test('R2 routes: guide, samples and pack over HTTP; sign-in needed; not in the demo', async (t) => {
  const { api, app } = await server(t);
  assert.equal((await api('/api/get-started', 'GET', undefined, false)).status, 401);
  let r = await api('/api/get-started');
  assert.equal(r.status, 200);
  assert.equal(r.body.guide.at, 'model');
  assert.equal(r.body.packs.list.length, 4);
  r = await api('/api/get-started/step', 'POST', { id: 'model', action: 'skip' });
  assert.equal(r.body.guide.at, 'bring');
  assert.equal((await api('/api/get-started/step', 'POST', { id: 'nope', action: 'skip' })).status, 400);
  r = await api('/api/get-started/mark', 'POST', { offered: true });
  assert.equal(r.body.guide.offered, true);
  r = await api('/api/get-started/samples', 'POST', {});
  assert.equal(r.body.samples.cards.length, 5);
  r = await api('/api/get-started/samples', 'DELETE', {});
  assert.equal(r.body.samples.on, false);
  r = await api('/api/get-started/pack', 'PUT', { id: 'sales' });
  assert.equal(r.body.packs.current, 'sales');
  assert.equal(r.body.result.added.length, PACK_DEFS.sales.routines.length);
  assert.equal((await api('/api/get-started/pack', 'PUT', { id: 'pirates' })).status, 400);
  r = await api('/api/get-started/pack', 'PUT', { id: null });
  assert.equal(r.body.packs.current, null);
  assert.equal(automationsFor(app).list().length, 0);
  r = await api('/api/get-started/restart', 'POST', {});
  assert.equal(r.body.guide.at, 'model');

  const demo = await server(t, 'demo');
  assert.equal((await demo.api('/api/get-started')).status, 403, 'the demo has no guide of its own');
  assert.equal((await demo.api('/api/get-started/samples', 'POST', {})).status, 403);
  assert.equal(existsSync(join(demo.dir, SAMPLE_FILE)), false);
});

test('R2 household isolation: a member\'s guide, samples and pack are their own', async (t) => {
  assert.equal(memberRouteCheck({ id: 'm1', name: 'Alex', status: 'active', limits: { voice: true, pictures: true } } as never, 'POST', ['get-started', 'samples']), undefined);
  const owner = await server(t);
  const member = await server(t, 'member');
  let r = await member.api('/api/get-started');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.guide.steps.map((s: { id: string }) => s.id), ['mail', 'calendar', 'phone', 'computer']);
  await member.api('/api/get-started/samples', 'POST', {});
  await member.api('/api/get-started/pack', 'PUT', { id: 'student' });
  assert.equal(existsSync(join(member.dir, SAMPLE_FILE)), true);
  r = await owner.api('/api/get-started');
  assert.equal(r.body.samples.on, false, 'the owner sees none of the member\'s examples');
  assert.equal(r.body.packs.current, null);
  assert.equal(existsSync(join(owner.dir, SAMPLE_FILE)), false);
  assert.equal(existsSync(join(owner.dir, PROGRESS_FILE)), false);
});
