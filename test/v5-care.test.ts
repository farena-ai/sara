// V5.4 (docs/design/V5CARE.md): caregiver mode. The person cared for gives consent per caregiver
// (missed doses, daily check-ins); a caregiver sees only the consented parts, computed from the
// person's own sealed health log on every request, so withdrawing consent hides them at once.
// Never chats, symptoms, mood, readings, appointments or notes. Plus the Simple home page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { careTick, careViewOf, caringFor, setCareGrant } from '../src/caregiver.ts';
import { healthFor, HealthLog } from '../src/health-log.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-18T14:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
const MED = ['Zor', 'va', 'tinex'].join('');
const SYMPTOM = ['wobble', 'knee'].join('');
const NOTE = ['take with', 'toast'].join(' ');
const sent: { to: string; title: string; body: string }[] = [];

function space(member?: { id: string; name: string; child?: boolean }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
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
const cy = space({ id: 'm2', name: 'Cy' });
const dirOf: Record<string, string> = { owner: owner.dataDir, m1: bo.dataDir, k1: kim.dataDir, m2: cy.dataDir };
const family = (person: string) => ({
  person,
  people: () => [{ id: 'owner', name: 'Alex' }, { id: 'm1', name: 'Bo' }, { id: 'k1', name: 'Kim', child: { band: '9-12' } }, { id: 'm2', name: 'Cy' }],
  store: { isParent: (p: string) => p === 'owner', parents: () => ['owner'] },
  spaceDirOf: (id: string) => dirOf[id],
  tz: () => 'America/Chicago',
  notifyPerson: (to: string, title: string, body: string) => void sent.push({ to, title, body }),
  quietFor: () => false,
});
for (const [a, id] of [[owner, 'owner'], [bo, 'm1'], [kim, 'k1'], [cy, 'm2']] as const) (a as unknown as { family: unknown }).family = family(id);

const auth = new OwnerAuth(owner.dataDir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  for (const a of apps) {
    HealthLog.closeFor(a.dataDir);
    a.store.close();
  }
  for (const d of dirs) d();
});
const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(base + '/api/health-log' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

test('consent: only the person adds or withdraws, only for adults in the household', () => {
  const h = healthFor(bo);
  assert.deepEqual(h.care().grants, []);
  assert.throws(() => setCareGrant(bo, { person: 'm1', doses: true }), /own caregiver/i);
  assert.throws(() => setCareGrant(bo, { person: 'k1', doses: true }), /adult/i);
  assert.throws(() => setCareGrant(bo, { person: 'nobody', doses: true }), /household/i);
  const g = setCareGrant(bo, { person: 'owner', doses: true, checkins: false });
  assert.equal(g?.person, 'owner');
  assert.deepEqual(h.care().grants.map((x) => [x.person, x.doses, x.checkins]), [['owner', true, false]]);
  // Sealed like the rest of the log: the grant is not readable in the database file.
  const raw = readFileSync(join(bo.dataDir, 'health-log', 'health.db')).toString('latin1');
  assert.ok(!raw.includes('"person"') && !raw.includes('owner'), 'grants are encrypted at rest');
  // Both off = withdrawn.
  assert.equal(setCareGrant(bo, { person: 'owner', doses: false, checkins: false }), undefined);
  assert.deepEqual(h.care().grants, []);
});

test('a caregiver sees only consented items; withdrawing hides them at once', () => {
  const h = healthFor(bo);
  // 8:00 in Chicago = 14:00 UTC. A dose that came up and was never answered, one taken.
  const med = h.addMed({ name: MED, dose: '10 mg', times: ['08:00'], notes: NOTE });
  const med2 = h.addMed({ name: 'Vitamin D', dose: '1', times: ['08:00'] });
  clock.now = new Date('2026-11-18T14:01:00Z');
  h.due(clock.now);
  h.logDose(med2.id, 'taken');
  h.addEntry({ type: 'symptom', name: SYMPTOM, value: 6, scale: 10 });
  h.addEntry({ type: 'mood', name: 'mood', value: 2, scale: 10 });
  h.checkIn('notgreat');
  clock.now = new Date('2026-11-18T16:30:00Z');

  // No consent yet: nothing, and a 403-style refusal.
  assert.deepEqual(caringFor(owner), []);
  assert.throws(() => careViewOf(owner, 'm1'), (e: { status?: number }) => e.status === 403);

  setCareGrant(bo, { person: 'owner', doses: true, checkins: false });
  assert.deepEqual(caringFor(owner), [{ id: 'm1', name: 'Bo' }]);
  const v = careViewOf(owner, 'm1');
  assert.deepEqual(Object.keys(v).sort(), ['doses', 'id', 'name']);
  assert.equal(v.doses?.missed.length, 1);
  assert.equal(v.doses?.missed[0].med, MED);
  assert.deepEqual(v.doses?.today, { taken: 1, skipped: 0, open: 1 });
  const s = JSON.stringify(v);
  for (const leak of [SYMPTOM, 'mood', NOTE, 'notgreat', '10 mg']) assert.ok(!s.includes(leak), `no ${leak} in the caregiver view`);

  // Check-ins only with that consent; still never symptoms or mood.
  setCareGrant(bo, { person: 'owner', doses: false, checkins: true });
  const v2 = careViewOf(owner, 'm1');
  assert.deepEqual(Object.keys(v2).sort(), ['checkins', 'id', 'name']);
  assert.deepEqual(v2.checkins?.map((c) => [c.day, c.status]), [['2026-11-18', 'notgreat']]);
  assert.ok(!JSON.stringify(v2).includes(MED));

  // Someone else in the house without consent sees nothing.
  assert.deepEqual(caringFor(cy), []);
  assert.throws(() => careViewOf(cy, 'm1'), (e: { status?: number }) => e.status === 403);

  // Withdrawn: gone on the very next look.
  h.removeCareGrant('owner');
  assert.deepEqual(caringFor(owner), []);
  assert.throws(() => careViewOf(owner, 'm1'), (e: { status?: number }) => e.status === 403);
});

test('daily check-in: one per day (latest counts), sealed', () => {
  const h = healthFor(cy);
  h.checkIn('ok');
  h.checkIn('notgreat');
  assert.deepEqual(h.checkins().map((c) => [c.day, c.status]), [['2026-11-18', 'notgreat']]);
  assert.throws(() => h.checkIn('bad' as never), /check-in/i);
});

test('notices: a missed dose once per caregiver with dose consent, no medicine name; "I need help" at once', () => {
  sent.length = 0;
  const h = healthFor(bo);
  setCareGrant(bo, { person: 'owner', doses: true, checkins: true });
  setCareGrant(bo, { person: 'm2', doses: false, checkins: true });
  careTick(bo, clock.now);
  careTick(bo, clock.now);
  const doseNotes = sent.filter((x) => /dose/i.test(x.body));
  assert.deepEqual(doseNotes.map((x) => x.to), ['owner'], 'once, and only to the dose caregiver');
  assert.ok(!JSON.stringify(sent).includes(MED), 'no medicine name on a lock screen');
  assert.match(doseNotes[0].body, /Bo/);
  sent.length = 0;
  h.checkIn('help');
  assert.deepEqual(sent.map((x) => x.to).sort(), ['m2', 'owner']);
  assert.match(sent[0].body, /help/i);
  // Withdrawn consent: no more notices.
  sent.length = 0;
  h.removeCareGrant('owner');
  h.removeCareGrant('m2');
  h.checkIn('help');
  assert.equal(sent.length, 0);
});

test('routes: own consent, check-in, contacts and the consented view over HTTP', async () => {
  const page = await api('/care');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.people.map((p: { id: string }) => p.id), ['m1', 'm2'], 'adults only, never yourself or a child');
  assert.deepEqual(page.body.caringFor, []);
  let r = await api('/care/grants', 'PUT', { person: 'm1', doses: true, checkins: true });
  assert.equal(r.status, 200);
  assert.equal(healthFor(owner).care().grants[0].person, 'm1');
  r = await api('/care/grants', 'PUT', { person: 'k1', doses: true });
  assert.equal(r.status, 400);
  r = await api('/care/checkin', 'POST', { status: 'ok' });
  assert.equal(r.status, 200);
  assert.equal(healthFor(owner).checkins()[0].status, 'ok');
  const phone = ['555', '0100'].join('-');
  r = await api('/care/contacts', 'PUT', { contacts: [{ name: 'Bo', phone }, { name: '', phone: '' }, { name: 'X', phone: 'call me' }] });
  assert.deepEqual(r.body.contacts, [{ name: 'Bo', phone }]);
  r = await api('/care/grants/m1', 'DELETE');
  assert.deepEqual(healthFor(owner).care().grants, []);

  // Bo lets Alex see check-ins: the view answers; withdrawn: 403 at once.
  setCareGrant(bo, { person: 'owner', doses: false, checkins: true });
  assert.deepEqual((await api('/care')).body.caringFor, [{ id: 'm1', name: 'Bo' }]);
  r = await api('/care/of/m1');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['checkins', 'id', 'name']);
  healthFor(bo).removeCareGrant('owner');
  r = await api('/care/of/m1');
  assert.equal(r.status, 403);
});

test('web: Health sections, the Simple home page and its view alias', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['hl-checkin', 'hl-care-grants', 'hl-care-add', 'hl-caring', 'hl-contacts', 'simple-home', 'sh-talk', 'sh-meds', 'sh-checkin', 'sh-call', 'sh-start']) assert.ok(html.includes(`id="${id}"`), id);
  const js = readFileSync(join(ROOT, 'web', 'simple-home.js'), 'utf8');
  assert.match(js, /export async function openSimpleHome/);
  assert.match(js, /sara\.simpleHome/);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /simple: \(\) => void openSimpleHome\(\)/);
});
