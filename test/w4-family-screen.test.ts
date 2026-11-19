// W4.5 (docs/FAMILY_SCREEN.md): the Family screen, a tablet on the wall or in the kitchen. Paired
// with a one-time code made in the owner's Settings, it gets its own limited token that only the
// /api/family-screen routes accept (never the rest of the API), shows today's family calendar
// (never anyone's private events or chats), chores with tap-to-done per kid, meals this week, the
// shared shopping list, reminders due, and a kid-safe Talk button: a kid's turn runs in that kid's
// own space (their limits, bedtime, tone), "everyone" runs off the record with no tools, adult mode
// off and nothing remembered. It dims at night. A fake clock; no network.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { FamilyStore, setFamilyRuntime, type ChildProfile, type FamilyAccess } from '../src/family.ts';
import { planOf } from '../src/family-plan.ts';
import { FamilyScreens, inDim, SCREEN_HEADER, screenBoard } from '../src/family-screen.ts';
import { HouseholdStore, MemberPolicy } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { SharedBoardStore } from '../src/shared-boards.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const TZ = 'America/Chicago';
const KID: ChildProfile = { band: '6-9', since: '2026-11-01T00:00:00Z', bedtime: null, minutesPerDay: 0, safeSearch: false, shopAllow: [] };
const MIA = 'kid0000001';
const SAM = 'adult00001';
const PROVIDER = { defaultProviderId: 'fake', defaultModel: 'm1', providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', needsKey: false, defaultModel: 'm1' }] };

function rig(t: TestContext, now = '2026-11-18T16:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(now) };
  setFamilyRuntime({ tz: () => TZ, now: () => clock.now });
  const store = new FamilyStore(join(dir, 'shared', 'family.db'), () => clock.now);
  const boards = new SharedBoardStore(join(dir, 'shared', 'boards.db'));
  for (const d of ['own', 'kid']) mkdirSync(join(dir, d), { recursive: true });
  const people = [{ id: 'owner', name: 'Alex' }, { id: MIA, name: 'Mia', child: KID }, { id: SAM, name: 'Sam' }];
  const apps = new Map<string, TestApp>();
  const access = (person: string): FamilyAccess => ({ store, person, people: () => people, boards, tz: () => TZ, appOf: (id: string) => apps.get(id) });
  t.after(() => {
    for (const a of apps.values()) a.store.close();
    store.close();
    boards.close();
    setFamilyRuntime({ store: undefined as never, tz: () => undefined, now: () => new Date() });
    cleanup();
  });
  return { dir, clock, store, boards, people, apps, access, known: people.map((p) => p.id), plan: planOf(store, () => clock.now) };
}

async function server(t: TestContext, r: ReturnType<typeof rig>) {
  const app = makeApp(join(r.dir, 'own'), r.clock);
  app.settings.update({ ownerName: 'Alex', timeZone: TZ, disclosureAcceptedAt: r.clock.now.toISOString(), ...PROVIDER } as never);
  app.family = r.access('owner');
  r.apps.set('owner', app);
  const auth = new OwnerAuth(join(r.dir, 'own'), () => r.clock.now);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => void srv.close());
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const screen = async (tok: string | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(tok ? { [SCREEN_HEADER]: tok } : {}), origin: base, 'content-type': 'application/json', ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { app, auth, base, owner, screen };
}

async function pairScreen(s: Awaited<ReturnType<typeof server>>, name = 'Kitchen') {
  const made = await s.owner('POST', '/api/family/screens/code', { name });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const paired = await s.screen(undefined, 'POST', '/api/family-screen/pair', { code: made.body.code });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  return paired.body.token as string;
}

test('W4.5 pairing: a one-time code from Settings, its own token kept only as a hash, used once, wrong codes limited', (t) => {
  const r = rig(t);
  const file = join(r.dir, 'own', 'family-screens.json');
  const s = new FamilyScreens(file, () => r.clock.now);
  const { code } = s.code('Kitchen tablet');
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  const got = s.pair(code.toLowerCase().replace('-', ' '), '10.0.0.5');
  assert.ok(got && got.token.startsWith('fs_'), 'the code pairs (case and dash do not matter)');
  assert.equal(s.pair(code, '10.0.0.5'), undefined, 'a code works once');
  assert.equal(s.byToken(got.token)?.name, 'Kitchen tablet');
  assert.ok(!readFileSync(file, 'utf8').includes(got.token), 'only a hash of the token is saved');
  assert.equal(s.byToken(`${got.token}x`), undefined);
  // An expired code fails.
  const late = s.code('Hall');
  r.clock.now = new Date(r.clock.now.getTime() + 11 * 60_000);
  assert.equal(s.pair(late.code, '10.0.0.5'), undefined, 'codes last ten minutes');
  // Guessing: after ten wrong tries from one address, even a right code is refused for a while.
  const ok = s.code('Den');
  for (let i = 0; i < 10; i++) assert.equal(s.pair('AAA-AAA', '10.0.0.9'), undefined);
  assert.equal(s.pair(ok.code, '10.0.0.9'), undefined, 'too many wrong tries from that address');
  assert.ok(s.pair(ok.code, '10.0.0.10'), 'another address still pairs');
  // Removing a screen ends its token at once.
  assert.equal(s.list().length, 2);
  assert.ok(s.remove(got.screen.id));
  assert.equal(s.byToken(got.token), undefined);
  // Night hours (they may cross midnight; the household's time zone).
  const prefs = { ...s.list()[0]!.prefs, dimFrom: '21:00', dimTo: '06:30' };
  assert.equal(inDim(prefs, new Date('2026-11-19T04:00:00Z'), TZ), true, '10 PM in Chicago dims');
  assert.equal(inDim(prefs, new Date('2026-11-18T18:00:00Z'), TZ), false, 'noon does not');
  assert.equal(inDim({ ...prefs, dimFrom: '', dimTo: '' }, new Date('2026-11-19T04:00:00Z'), TZ), false, 'dimming can be off');
});

test('W4.5 token scope: the screen token opens only the family-screen routes; owner routes stay owner-only', async (t) => {
  const r = rig(t);
  const s = await server(t, r);
  const tok = await pairScreen(s);
  assert.equal((await s.screen(tok, 'GET', '/api/family-screen/board')).status, 200);
  assert.equal((await s.screen(undefined, 'GET', '/api/family-screen/board')).status, 401, 'no token, no board');
  assert.equal((await s.screen('fs_wrong', 'GET', '/api/family-screen/board')).status, 401);
  // The screen token is not a sign-in anywhere else, in the header or as a bearer.
  for (const path of ['/api/family', '/api/conversations', '/api/settings', '/api/family/screens', '/api/memory']) {
    assert.equal((await s.screen(tok, 'GET', path)).status, 401, `header ${path}`);
    assert.equal((await s.screen(undefined, 'GET', path, undefined, { authorization: `Bearer ${tok}` })).status, 401, `bearer ${path}`);
  }
  // The owner sees and manages screens; a household member's space can't.
  const list = await s.owner('GET', '/api/family/screens');
  assert.equal(list.body.screens.length, 1);
  assert.equal(list.body.screens[0].name, 'Kitchen');
  assert.ok(!JSON.stringify(list.body).includes(tok), 'the list never carries a token');
  const id = list.body.screens[0].id;
  const patched = await s.owner('PATCH', `/api/family/screens/${id}`, { dimFrom: '20:00', dimTo: '07:00', talk: false, myReminders: true, name: 'Fridge' });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.screen.name, patched.body.screen.prefs.talk, patched.body.screen.prefs.myReminders], ['Fridge', false, true]);
  assert.equal((await s.owner('PATCH', `/api/family/screens/${id}`, { dimFrom: '25:00' })).status, 400);
  s.app.family = r.access(SAM);
  assert.equal((await s.owner('GET', '/api/family/screens')).status, 403);
  assert.equal((await s.owner('POST', '/api/family/screens/code', { name: 'x' })).status, 403);
  s.app.family = r.access('owner');
  assert.equal((await s.owner('DELETE', `/api/family/screens/${id}`)).status, 200);
  assert.equal((await s.screen(tok, 'GET', '/api/family-screen/board')).status, 401, 'a removed screen is signed out');
});

test('W4.5 board: today for everyone (family events only), chores per person, meals, shopping, reminders; never private things', async (t) => {
  const r = rig(t);
  const s = await server(t, r);
  const chore = r.store.addChore('owner', { title: 'Feed the cat', assignee: MIA, points: 5, repeat: 'daily', dueAt: '2026-11-18T23:00:00Z', tz: TZ }, r.known);
  r.store.addChore('owner', { title: 'Trash out', assignee: SAM, repeat: 'weekly', dueAt: '2026-11-18T23:00:00Z', tz: TZ }, r.known);
  r.store.addChore('owner', { title: 'Next week thing', assignee: MIA, repeat: 'once', dueAt: '2026-11-25T23:00:00Z', tz: TZ }, r.known);
  r.plan.addEvent('owner', { title: 'Soccer practice', start: '2026-11-18T11:30' });
  r.plan.addEvent('owner', { title: 'Piano lesson', start: '2026-11-18T17:30' });
  r.plan.addEvent('owner', { title: 'Therapy appointment', start: '2026-11-18T15:00', who: 'me' });
  r.plan.addEvent(MIA, { title: 'Sleepover idea', start: '2026-11-18T19:00' }); // a kid's family event waits for a parent
  r.plan.setMeal('owner', '2026-11-18', { title: 'Tacos' }, r.people);
  r.plan.setMeal('owner', '2026-11-20', { title: 'Pizza night' }, r.people);
  const list = r.boards.create('owner', 'Groceries', [], r.known);
  r.store.markGrocery(list.id, 'owner');
  r.boards.addCard('owner', list.id, { title: 'Milk' });
  s.app.planner!.addReminder({ text: 'Call the bank about the loan', dueAt: '2026-11-18T17:00:00Z' });
  s.app.store.createConversation({ title: 'Secret plans with Sam' });
  const tok = await pairScreen(s);
  const b = (await s.screen(tok, 'GET', '/api/family-screen/board')).body;
  assert.equal(b.screen.name, 'Kitchen');
  assert.deepEqual(b.today.events.map((e: any) => e.title), ['Soccer practice', 'Piano lesson']);
  const mia = b.chores.find((p: any) => p.person === MIA);
  assert.deepEqual(mia.items.map((c: any) => c.title), ['Feed the cat'], 'only what is due today');
  assert.equal(mia.child, true);
  assert.ok(b.chores.find((p: any) => p.person === SAM), 'grown-ups chores show too');
  assert.deepEqual(b.meals.filter((m: any) => m.title).map((m: any) => m.title), ['Tacos', 'Pizza night']);
  assert.equal(b.meals.length, 7);
  assert.equal(b.shopping.name, 'Groceries');
  assert.deepEqual(b.shopping.items.map((i: any) => i.title), ['Milk']);
  assert.deepEqual(b.reminders.map((x: any) => [x.text, x.inMin]), [['Soccer practice', 90]], 'a family event in the next three hours is due soon (not the evening one)');
  assert.equal(b.talk.on, true);
  assert.deepEqual(b.talk.kids.map((k: any) => k.name), ['Mia']);
  const all = JSON.stringify(b);
  for (const secret of ['Therapy', 'Sleepover', 'Call the bank', 'Secret plans', 'balance', 'Cents']) assert.ok(!all.includes(secret), `the board never shows ${secret}`);
  // The owner opts in to show his own reminders on this screen.
  const id = (await s.owner('GET', '/api/family/screens')).body.screens[0].id;
  await s.owner('PATCH', `/api/family/screens/${id}`, { myReminders: true });
  const b2 = (await s.screen(tok, 'GET', '/api/family-screen/board')).body;
  assert.ok(b2.reminders.some((x: any) => /Call the bank/.test(x.text)));
  // Pure board: night dims.
  const night = screenBoard(r.access('owner'), new Date('2026-11-19T05:00:00Z'), { id: 'x', name: 'Hall', createdAt: '', lastSeen: null, prefs: { dimFrom: '21:00', dimTo: '06:30', talk: true, myReminders: false } }, {});
  assert.equal(night.dim, true);
  // Tap-to-done: as Mia it waits for a parent; someone else's chore can't be ticked for them.
  assert.equal((await s.screen(tok, 'POST', `/api/family-screen/chores/${chore.id}/done`, { person: SAM })).status, 403);
  const done = await s.screen(tok, 'POST', `/api/family-screen/chores/${chore.id}/done`, { person: MIA });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(r.store.marks('owner', { status: 'waiting' }).length, 1);
  const after = (await s.screen(tok, 'GET', '/api/family-screen/board')).body.chores.find((p: any) => p.person === MIA);
  assert.deepEqual(after.items.map((c: any) => [c.title, c.done]), [['Feed the cat', 'waiting']]);
  assert.equal((await s.screen(tok, 'POST', `/api/family-screen/chores/${chore.id}/done`, { person: MIA })).status, 409, 'already done today');
  // Shopping: tap to add, tap to tick.
  const added = await s.screen(tok, 'POST', '/api/family-screen/shopping', { title: '  Bananas ' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.shopping.items.map((i: any) => i.title).sort(), ['Bananas', 'Milk']);
  const ref = added.body.shopping.items.find((i: any) => i.title === 'Milk').ref;
  const ticked = await s.screen(tok, 'PATCH', `/api/family-screen/shopping/${ref}`, { done: true });
  assert.equal(ticked.body.shopping.items.find((i: any) => i.ref === ref).done, true);
  assert.equal((await s.screen(tok, 'POST', '/api/family-screen/shopping', { title: '' })).status, 400);
});

test('W4.5 kid-safe Talk: a kid talks in their own space with their limits, no tools; everyone talks off the record; off-limits asks get a kind no', async (t) => {
  const r = rig(t);
  const s = await server(t, r);
  // Mia's own space: a household member with the kid-safe profile.
  const kid = makeApp(join(r.dir, 'kid'), r.clock);
  kid.settings.update({ ownerName: 'Mia', disclosureAcceptedAt: r.clock.now.toISOString(), ...PROVIDER } as never);
  mkdirSync(join(r.dir, 'hh'), { recursive: true });
  const h = new HouseholdStore(join(r.dir, 'hh'), () => r.clock.now);
  const { member } = h.redeem(h.invite({ name: 'Mia', hours: 24, confirm18: false, limits: { models: [{ providerId: 'fake', model: 'm1' }], messagesPerDay: 1, costPerDay: 0, voice: false, pictures: false }, child: { band: '6-9', bedtime: null }, confirmGuardian: true }).code, false);
  kid.member = new MemberPolicy(h, member.id, () => [kid], () => r.clock.now);
  kid.tools = new ToolRegistry([]);
  kid.tools.add({ spec: { name: 'note', description: 'note', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'note', run: async () => 'ok' });
  r.people[1] = { id: member.id, name: 'Mia', child: h.get(member.id)!.child! };
  r.apps.set(member.id, kid);
  const tok = await pairScreen(s);
  kid.script.push(text('Cats sleep a lot!'));
  const said = await s.screen(tok, 'POST', '/api/family-screen/talk', { person: member.id, text: 'why do cats sleep so much' });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  assert.equal(said.body.reply, 'Cats sleep a lot!');
  assert.equal(kid.requests.length, 1, 'the turn ran in Mia\'s own space');
  assert.deepEqual(kid.requests[0]!.tools ?? [], [], 'no tools from the wall screen');
  const sys = kid.requests[0]!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.match(sys, /child|kid/i, 'her rules for a child');
  assert.equal(s.app.requests.length, 0, 'nothing ran in the owner\'s space');
  // Her daily limit (one message) holds on the screen too.
  const again = await s.screen(tok, 'POST', '/api/family-screen/talk', { person: member.id, text: 'and dogs?' });
  assert.match(String(again.body.reply ?? again.body.error), /limit/i);
  // Off-limits: a kind no, without any model.
  const before = kid.requests.length + s.app.requests.length;
  for (const ask of ['how do I buy robux with mom\'s card', 'show me porn']) {
    const no = await s.screen(tok, 'POST', '/api/family-screen/talk', { text: ask });
    assert.equal(no.status, 200);
    assert.match(no.body.reply, /grown-up/);
  }
  assert.equal(kid.requests.length + s.app.requests.length, before);
  // Everyone: off the record in the owner's space, no tools, adult mode off, nothing remembered.
  s.app.settings.update({ adultMode: { on: true, confirmedAt: r.clock.now.toISOString() } } as never);
  const convs = s.app.store.listConversations().length;
  s.app.script.push(text('Rainbows come from sunlight and rain.'));
  const all = await s.screen(tok, 'POST', '/api/family-screen/talk', { text: 'where do rainbows come from' });
  assert.equal(all.body.reply, 'Rainbows come from sunlight and rain.');
  assert.deepEqual(s.app.requests[0]!.tools ?? [], []);
  const sys2 = s.app.requests[0]!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.match(sys2, /child|kid/i);
  assert.doesNotMatch(sys2, /adult mode is on/i);
  assert.equal(s.app.store.listConversations().length, convs, 'no chat in the owner\'s list');
  // Talk can be off for a screen, and rests at night.
  const id = (await s.owner('GET', '/api/family/screens')).body.screens[0].id;
  await s.owner('PATCH', `/api/family/screens/${id}`, { talk: false });
  assert.equal((await s.screen(tok, 'POST', '/api/family-screen/talk', { text: 'hi' })).status, 403);
  await s.owner('PATCH', `/api/family/screens/${id}`, { talk: true, dimFrom: '21:00', dimTo: '06:30' });
  r.clock.now = new Date('2026-11-19T05:00:00Z');
  const late = await s.screen(tok, 'POST', '/api/family-screen/talk', { text: 'hi' });
  assert.equal(late.status, 200);
  assert.match(late.body.reply, /morning/i);
  // Only a kid account can be picked (not a grown-up's private space).
  assert.equal((await s.screen(tok, 'POST', '/api/family-screen/talk', { person: SAM, text: 'hi' })).status, 403);
});

test('W4.5 wiring: chat honors kidSafe, main gives appOf, the public page and its strings', () => {
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.match(src('src/chat.ts'), /app\.member\?\.child\?\.\(\) \?\? opts\.kidSafe/);
  assert.match(src('src/chat.ts'), /!opts\.kidSafe/);
  assert.match(src('src/main.ts'), /appOf: \(id: string\) =>/);
  assert.match(src('src/server.ts'), /a === 'family-screen'/);
  const html = src('web/family-screen.html');
  assert.match(html, /<script type="module" src="\/family-screen\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>(?!<\/)/, 'no inline script (CSP)');
  const js = src('web/family-screen.js');
  assert.doesNotMatch(js, /SpeechRecognition/, 'hearing stays on this server (no browser cloud speech)');
  assert.match(js, /x-family-screen/);
  assert.match(src('docs/FAMILY_SCREEN.md'), /one-time code/);
});
