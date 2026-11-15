// R8 (docs/FAMILY.md): Family. Chores and allowance (assign, mark done, approve, ledger, record-only
// payouts, repeats, weekly summary, Today), school dates from email (inbox helper kind `school`,
// permission slip -> task with the form), kid-safe member mode (profile, invites, routes, crafted
// requests to a child's server, the tool allowlist in a real turn, bedtime, time limit, topics not
// words, safe search), and grocery lists over shared lists (aisles, stores, cheapest near me).
// A fake clock, fake tools and fake turns; no network.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { aisleOf, cheapestLine, childRouteCheck, cleanChild, FamilyStore, gateKidTools, inBedtime, KID_OFF_REPLY, KID_TOOLS, kidResultOk, nextDue, setFamilyRuntime, topicsOf, type ChildProfile, type FamilyAccess } from '../src/family.ts';
import { HouseholdStore, MemberPolicy, MemberSettings, memberRouteCheck, MEMBER_ROUTES, type MemberLimits, type MemberRecord } from '../src/household.ts';
import { classify, type InboxMail } from '../src/inbox/classify.ts';
import { InboxHelper } from '../src/inbox/helper.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createSaraServer } from '../src/server.ts';
import { SettingsStore } from '../src/settings.ts';
import { SharedBoardStore } from '../src/shared-boards.ts';
import { createFamilyTools } from '../src/tools/family.ts';
import { runSearch } from '../src/tools/search.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const LIMITS: MemberLimits = { models: [{ providerId: 'p', model: 'm1' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false };
const TZ = 'America/Chicago';
const KID: ChildProfile = { band: '10-12', since: '2026-11-01T00:00:00Z', bedtime: { from: '20:30', to: '07:00' }, minutesPerDay: 0, safeSearch: false, shopAllow: [] };

function familyRig(t: TestContext, now = '2026-11-16T18:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(now) };
  const store = new FamilyStore(join(dir, 'shared', 'family.db'), () => clock.now);
  const boards = new SharedBoardStore(join(dir, 'shared', 'boards.db'));
  const people = [{ id: 'owner', name: 'Alex' }, { id: 'kid0000001', name: 'Mia', child: KID }, { id: 'kid0000002', name: 'Leo', child: { ...KID, band: '6-9' as const } }, { id: 'adult00001', name: 'Sam' }];
  for (const d of ['m1', 'kid', 'own', 'hh']) mkdirSync(join(dir, d), { recursive: true });
  const access = (person: string): FamilyAccess => ({ store, person, people: () => people, boards, tz: () => TZ });
  t.after(() => {
    store.close();
    boards.close();
    setFamilyRuntime({ store: undefined as never, tz: () => undefined, now: () => new Date() });
    cleanup();
  });
  return { dir, clock, store, boards, people, access, known: people.map((p) => p.id) };
}

test('R8 chores: a parent assigns, the kid marks done, a parent approves; repeats move on; the ledger and record-only payouts', (t) => {
  const r = familyRig(t);
  const { store, known } = r;
  assert.throws(() => store.addChore('kid0000001', { title: 'Dishes', assignee: 'kid0000001' }, known), /Only a parent/);
  const c = store.addChore('owner', { title: 'Dishes', assignee: 'kid0000001', points: 5, amount: '1.50', repeat: 'daily', dueAt: '2026-11-17T00:00:00Z' }, known);
  assert.equal(c.cents, 150);
  assert.deepEqual(store.chores('kid0000002'), [], 'a kid sees only their own');
  assert.throws(() => store.markDone('kid0000002', c.id), /someone else/);
  const m = store.markDone('kid0000001', c.id, { note: 'all done', tz: TZ });
  assert.equal(m.status, 'waiting');
  assert.equal(store.chore(c.id)!.dueAt, '2026-11-18T00:00:00.000Z', 'a daily chore moves to its next time');
  assert.equal(store.balance('kid0000001', 'kid0000001').balanceCents, 0, 'nothing counts before the OK');
  assert.throws(() => store.approve('kid0000001', m.id), /Only a parent/);
  store.setParent('adult00001', true);
  const ok = store.approve('adult00001', m.id);
  assert.equal(ok.status, 'approved');
  store.approve('owner', m.id);
  const b = store.balance('owner', 'kid0000001');
  assert.deepEqual([b.earnedCents, b.paidCents, b.balanceCents, b.points], [150, 0, 150, 5], 'approved once (twice is a no-op)');
  assert.throws(() => store.balance('kid0000002', 'kid0000001'), /Only a parent/);
  assert.throws(() => store.pay('owner', 'kid0000001', 5), /more than the balance/);
  assert.throws(() => store.pay('kid0000001', 'kid0000001', 1), /Only a parent/);
  const paid = store.pay('owner', 'kid0000001', 1, 'cash');
  assert.equal(paid.kind, 'paid');
  assert.equal(store.balance('owner', 'kid0000001').balanceCents, 50);
  // A one-time chore rests once done and comes back when a parent says "not yet".
  const once = store.addChore('owner', { title: 'Clean the garage', assignee: 'kid0000002', amount: 5, repeat: 'once' }, known);
  const m2 = store.markDone('kid0000002', once.id);
  assert.equal(store.chore(once.id)!.active, false);
  assert.throws(() => store.markDone('kid0000002', once.id), /gone/);
  store.reject('owner', m2.id, 'Not finished yet');
  assert.equal(store.chore(once.id)!.active, true);
  assert.equal(store.balance('owner', 'kid0000002').balanceCents, 0);
  // Photo proof stays with the mark (the kid and parents only).
  const photo = store.addChore('owner', { title: 'Make the bed', assignee: 'kid0000002', photo: true, repeat: 'weekly' }, known);
  const m3 = store.markDone('kid0000002', photo.id, { photo: Buffer.from('jpegbytes') });
  assert.equal(store.photo('kid0000002', m3.id)?.toString(), 'jpegbytes');
  assert.equal(store.photo('kid0000001', m3.id), undefined);
  assert.equal(store.photo('owner', m3.id)?.toString(), 'jpegbytes');
});

test('R8 chores: next times (weekdays skip the weekend), the weekly summary once on Sunday evening, Today for parents and kids', (t) => {
  const r = familyRig(t);
  // Friday 2026-11-20 08:00 Chicago -> Monday.
  assert.equal(nextDue('2026-11-20T14:00:00.000Z', 'weekdays', new Date('2026-11-20T15:00:00Z'), TZ), '2026-11-23T14:00:00.000Z');
  assert.equal(nextDue('2026-11-20T14:00:00.000Z', 'weekly', new Date('2026-11-20T15:00:00Z'), TZ), '2026-11-27T14:00:00.000Z');
  assert.equal(nextDue('2026-11-20T14:00:00.000Z', 'once', new Date(), TZ), null);
  const kids = r.people.filter((p) => p.child);
  const c = r.store.addChore('owner', { title: 'Feed the cat', assignee: 'kid0000001', amount: 2, repeat: 'daily', dueAt: '2026-11-16T20:00:00Z' }, r.known);
  const tileParent = r.store.todayTile('owner', kids, r.clock.now, TZ)!;
  assert.equal(tileParent.role, 'parent');
  assert.equal(tileParent.due[0]!.id, c.id);
  const m = r.store.markDone('kid0000001', c.id, { tz: TZ });
  assert.equal(r.store.todayTile('owner', kids, r.clock.now, TZ)!.waiting[0]!.id, m.id);
  const tileKid = r.store.todayTile('kid0000001', kids, r.clock.now, TZ)!;
  assert.equal(tileKid.role, 'kid');
  assert.equal(tileKid.waiting.length, 1);
  assert.equal(r.store.todayTile('kid0000002', kids, r.clock.now, TZ), undefined, 'no chores, no tile');
  r.store.approve('owner', m.id);
  assert.equal(r.store.weeklyDue(kids, new Date('2026-11-21T01:00:00Z'), TZ), undefined, 'Friday evening: not yet');
  const sun = new Date('2026-11-23T01:00:00Z'); // Sunday 7 pm Chicago
  const text1 = r.store.weeklyDue(kids, sun, TZ);
  assert.match(text1 ?? '', /Mia: 1 chore done \(1 approved\), earned \$2\.00, paid out \$0\.00, balance \$2\.00\./);
  assert.equal(r.store.weeklyDue(kids, new Date(sun.getTime() + 3600_000), TZ), undefined, 'once a week');
});

test('R8 tools: chore_add (parents), chore_done (the kid), allowance_balance, allowance_pay asks and only records', async (t) => {
  const r = familyRig(t);
  const app = { family: r.access('owner') } as never;
  const kidApp = { family: r.access('kid0000001') } as never;
  const tools = (a: never) => Object.fromEntries(createFamilyTools(() => a).map((x) => [x.spec.name, x])) as Record<string, Tool>;
  const P = tools(app);
  const K = tools(kidApp);
  assert.equal(K.chore_add!.isAvailable!(), false, 'kids can’t add chores');
  assert.equal(K.allowance_pay!.isAvailable!(), false);
  assert.equal(P.allowance_pay!.defaultPermission, 'ask', 'recording a payout asks first');
  assert.match(P.allowance_pay!.summarize({ who: 'Mia', amount: 3 }), /record only; no money moves/);
  const ctx = { workspaceDir: '.', signal: AbortSignal.timeout(5000), sandbox: { mode: 'none', network: false, detail: '' } } as never;
  const out = await P.chore_add!.run({ title: 'Take out the trash', who: 'mia', amount: 1, points: 2, repeat: 'weekly' }, ctx);
  assert.match(out, /Verified: chore #1 reads back/);
  assert.match(await K.chore_list!.run({}, ctx), /#1 Take out the trash — Mia — weekly/);
  assert.match(await K.chore_done!.run({ chore: 'trash' }, ctx), /waits for a parent’s OK/);
  r.store.approve('owner', 1);
  assert.match(await K.allowance_balance!.run({}, ctx), /You: balance \$1\.00 \(earned \$1\.00, paid out \$0\.00\), 2 points/);
  assert.match(await P.allowance_pay!.run({ who: 'Mia', amount: 1 }, ctx), /a record only; no money was moved/);
  assert.match(await P.allowance_balance!.run({}, ctx), /Mia: balance \$0\.00/);
});

const school = (o: Partial<InboxMail> = {}): InboxMail => ({ account: 'alex@mail.test', id: `s${Math.random()}`, from: 'Maple Elementary PTA <news@mapleelementary.org>', subject: 'Maple Weekly Newsletter', date: '2026-11-14T14:00:00.000Z', text: ['Hello Maple families!', '- Early release on Wednesday, Nov 25 at 12:30 PM for Thanksgiving.', '- No school Nov 26 and Nov 27.', '- Picture day is Thursday 12/3. Retakes later.', '- 4th grade field trip to the Science Museum on Dec 9, 2026.', '- Permission slips for the field trip are due Dec 4.', 'Unsubscribe from this list any time.'].join('\n'), ...o });

test('R8 school mail: a newsletter becomes school dates; other mail is untouched', () => {
  const now = new Date('2026-11-14T15:00:00Z');
  const { findings } = classify(school(), now);
  const by = Object.fromEntries(findings.map((f) => [f.school, f]));
  assert.deepEqual(findings.map((f) => f.school), ['early_release', 'no_school', 'picture_day', 'field_trip', 'permission_slip']);
  assert.equal(by.early_release!.start, '2026-11-25T12:30');
  assert.equal(by.no_school!.start, '2026-11-26');
  assert.equal(by.picture_day!.start, '2026-12-03');
  assert.deepEqual(findings.map((f) => f.title), ['Early release', 'No school', 'Picture day', 'Field trip to the Science Museum', 'Permission slip for the field trip']);
  assert.equal(by.permission_slip!.due, '2026-12-04');
  assert.ok(findings.every((f) => f.kind === 'school'));
  // A teacher by name with a school word, and a shop newsletter that is not a school.
  assert.deepEqual(classify(school({ from: 'Mrs. Rivera (Room 12) <rivera@gmail.com>', subject: 'Class news', text: 'Book fair on Nov 30 in the library!' }), now).findings.map((f) => [f.school, f.title]), [['event', 'Book fair']]);
  assert.deepEqual(classify({ ...school(), from: 'Garden Weekly <news@gardenweekly.test>', subject: 'No school? Our picture day sale', text: 'Picture day frames 20% off until Nov 30. Unsubscribe from this list any time.' }, now).findings, []);
  assert.deepEqual(classify({ ...school(), from: 'Crypto <hi@crypto.com>', subject: 'Upcoming', text: 'Field trip to the moon Nov 30' }, now).findings, [], 'pto inside a word is no school');
});

test('R8 school mail: Accept puts it on the School list with a reminder; a permission slip is a task with the form kept', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-14T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: TZ });
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const mails = [school({ id: 'n1', attachments: ['Field trip permission slip.pdf'] })];
  const inbox = new InboxHelper(app, app.store.db, { accounts: () => ['alex@mail.test'], readMail: async () => mails, attachment: async (_a, _acc, _id, name) => ({ name, mime: 'application/pdf', data: PDF }), model: async () => '{"kind":"none"}', notify: async () => undefined, quiet: () => false });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const scan = await inbox.scan();
  assert.equal(scan.created, 5);
  const items = inbox.list({ status: 'pending' });
  assert.match(inbox.line(items.find((i) => i.finding.school === 'no_school')!), /^School: No school/);
  const slip = items.find((i) => i.finding.school === 'permission_slip')!;
  const done = await inbox.accept(slip.id);
  assert.equal(done.status, 'done', done.result ?? '');
  assert.match(done.result!, /Verified: task #\d+ is in the School list and reminder #\d+ is set; the form is in the Library/);
  const task = app.planner!.tasks({ status: 'all' }).find((x) => x.title.startsWith('Sign and return'))!;
  assert.match(task.notes, /Library #\d+/);
  assert.equal(app.planner!.projects().find((p) => p.id === task.projectId)?.name, 'School');
  assert.equal(task.dueAt, '2026-12-04T14:00:00.000Z', '8 am Chicago on the due day');
  const docId = Number(/Library #(\d+)/.exec(task.notes)![1]);
  assert.equal(app.library.get(docId)?.collection, 'School');
  const rem = app.planner!.reminders().find((x) => x.text.startsWith('Tomorrow: Sign and return'))!;
  assert.equal(rem.dueAt, '2026-12-04T01:00:00.000Z', '7 pm the evening before');
  const undone = await inbox.undo(slip.id);
  assert.equal(undone.status, 'undone');
  assert.equal(app.planner!.task(task.id), undefined, 'Undo removes the task');
  const pic = await inbox.accept(items.find((i) => i.finding.school === 'picture_day')!.id);
  assert.match(pic.result!, /Added “Picture day.*” to School for 2026-12-03, with a reminder the evening before/);
});

test('R8 kid-safe mode: the profile, child invites vouched by a parent, settings forced safe, bedtime and the daily limit', (t) => {
  const r = familyRig(t, '2026-11-16T18:00:00Z');
  const h = new HouseholdStore(r.dir, () => r.clock.now);
  assert.throws(() => h.invite({ name: 'Mia', hours: 24, confirm18: false, limits: LIMITS, child: { band: '10-12' } }), /parent or guardian/);
  assert.throws(() => h.invite({ name: 'Mia', hours: 24, confirm18: false, limits: LIMITS, child: { band: '3-5' }, confirmGuardian: true }), /age band/);
  const inv = h.invite({ name: 'Mia', hours: 24, confirm18: false, limits: { ...LIMITS, voice: true, pictures: true }, child: { band: '10-12', minutesPerDay: 60 }, confirmGuardian: true });
  assert.equal(h.checkInvite(inv.code)?.child, true);
  const { member } = h.redeem(inv.code, false);
  assert.equal(member.child?.band, '10-12', 'a child joins without claiming 18+');
  assert.equal(member.memberConfirmed18At, '');
  assert.deepEqual([member.limits.voice, member.limits.pictures], [false, false], 'voice and pictures start off for a child');
  assert.throws(() => h.redeem(h.invite({ name: 'Ann', hours: 24, confirm18: true, limits: LIMITS }).code, false), /18 or older/, 'grown-ups still confirm 18+');
  // Settings: adult mode is forced off for a child, whatever their file says.
  const owner = new SettingsStore(r.dir);
  const ms = new MemberSettings(h.dirOf(member.id), owner, () => LIMITS, () => h.get(member.id)?.child);
  ms.update({ adultMode: { on: true, confirmedAt: '2026-11-01T00:00:00Z' } });
  assert.equal(ms.get().adultMode?.on, false);
  h.setChild(member.id, null);
  assert.equal(ms.get().adultMode?.on, true, 'turned back into a grown-up member, their own choice is theirs again');
  h.setChild(member.id, { band: '13-17', bedtime: { from: '22:00', to: '06:30' }, minutesPerDay: 30 });
  // Bedtime (Chicago): 12:00 is fine, 22:30 and 06:00 are bedtime.
  const p = h.get(member.id)!.child!;
  assert.equal(inBedtime(p, new Date('2026-11-16T18:00:00Z'), TZ), false);
  assert.equal(inBedtime(p, new Date('2026-11-17T04:30:00Z'), TZ), true);
  assert.equal(inBedtime(p, new Date('2026-11-17T12:00:00Z'), TZ), true);
  setFamilyRuntime({ store: r.store, tz: () => TZ, now: () => r.clock.now });
  const policy = new MemberPolicy(h, member.id, () => [], () => r.clock.now);
  assert.doesNotThrow(() => policy.checkBudget());
  for (let i = 0; i < 6; i++) r.store.noteTurn(member.id, 'help with my math homework', new Date(r.clock.now.getTime() + i * 5 * 60_000), TZ);
  assert.equal(r.store.minutesToday(member.id, r.clock.now, TZ), 30);
  assert.throws(() => policy.checkBudget(), /today's time/, 'the daily limit stops model calls');
  r.clock.now = new Date('2026-11-17T04:30:00Z');
  assert.throws(() => policy.checkBudget(), /bedtime/);
  // The parent's summary: topics and minutes, never the words.
  const act = r.store.activity('owner', member.id, new Date('2026-11-16T23:00:00Z'), TZ);
  const day = act.days.at(-1)!;
  assert.equal(day.minutes, 30);
  assert.deepEqual(day.topics.map((x) => x.topic).sort(), ['homework', 'math']);
  assert.ok(!JSON.stringify(act).includes('help with'), 'no words in the summary');
  assert.throws(() => r.store.activity(member.id, member.id, r.clock.now, TZ), /Only a parent/);
  assert.deepEqual(topicsOf('I feel sad, my friend left'), ['feelings']);
  assert.deepEqual(cleanChild({ shopAllow: 'https://www.scholastic.com/store, bad' }, r.clock.now).shopAllow, ['scholastic.com']);
});

test('R8 kid-safe routes: what a child can never reach, on top of the member rules', (t) => {
  const r = familyRig(t, '2026-11-16T18:00:00Z');
  setFamilyRuntime({ store: r.store, tz: () => TZ, now: () => r.clock.now });
  const rec = (child?: ChildProfile): MemberRecord => ({ id: 'kid0000001', name: 'Mia', createdAt: '', status: 'active', ownerConfirmed18At: '', memberConfirmed18At: '', limits: { ...LIMITS, voice: true, pictures: true }, ...(child ? { child } : {}) });
  assert.ok(MEMBER_ROUTES.has('family'));
  const blocked: [string, string[]][] = [['PUT', ['adult']], ['POST', ['hands', 'run']], ['GET', ['computer']], ['POST', ['mail', 'send']], ['GET', ['inbox']], ['POST', ['errands']], ['POST', ['shares']], ['PUT', ['settings']], ['PATCH', ['settings']], ['PUT', ['persona']], ['POST', ['companions']], ['POST', ['skills']], ['POST', ['automations']], ['POST', ['household', 'me', 'delete']], ['POST', ['shortcuts', 'tokens']], ['PUT', ['other-apps']]];
  for (const [m, p] of blocked) {
    assert.equal(memberRouteCheck(rec(KID), m, p)?.status, 403, `${m} ${p.join('/')}`);
    if (!(m === 'POST' && p[0] === 'household')) assert.notEqual(memberRouteCheck(rec(), m, p)?.message, 'A parent turned this off for you.', 'grown-up members keep their rules');
  }
  for (const [m, p] of [['GET', ['conversations']], ['POST', ['conversations', 'c1', 'messages']], ['GET', ['family']], ['POST', ['family', 'chores', '1', 'done']], ['GET', ['adult']], ['GET', ['settings']], ['GET', ['planner']]] as [string, string[]][]) assert.equal(memberRouteCheck(rec(KID), m, p), undefined, `${m} ${p.join('/')}`);
  r.clock.now = new Date('2026-11-17T04:00:00Z'); // 10 pm Chicago
  assert.match(memberRouteCheck(rec(KID), 'POST', ['conversations', 'c1', 'messages'])?.message ?? '', /bedtime/);
  assert.equal(memberRouteCheck(rec(KID), 'GET', ['conversations', 'c1']), undefined, 'reading old chats still works at bedtime');
  assert.equal(childRouteCheck('kid0000001', { ...KID, bedtime: null }, 'POST', ['conversations', 'c1', 'messages']), undefined);
});

test('R8 kid-safe: crafted requests to a child’s own server are refused server-side', async (t) => {
  const r = familyRig(t, '2026-11-16T18:00:00Z');
  setFamilyRuntime({ store: r.store, tz: () => TZ, now: () => r.clock.now });
  const mApp = makeApp(join(r.dir, 'm1'), r.clock);
  mApp.settings.update({ ownerName: 'Mia', disclosureAcceptedAt: r.clock.now.toISOString() });
  mApp.family = r.access('kid0000001');
  const mAuth = new OwnerAuth(join(r.dir, 'm1'), () => r.clock.now);
  const tok = mAuth.newToken!;
  const record = { id: 'kid0000001', name: 'Mia', status: 'active', createdAt: '', ownerConfirmed18At: '', memberConfirmed18At: '', limits: { ...LIMITS, voice: true, pictures: true }, child: KID };
  const srv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'kid0000001', member: { record: () => record as never, apps: () => [mApp], deleteSelf: async () => {} } });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => {
    srv.close();
    mApp.store.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  for (const [m, p, b] of [['PUT', '/api/adult', { on: true, confirm18: true }], ['PUT', '/api/settings', { adultMode: { on: true, confirmedAt: 'x' } }], ['POST', '/api/hands/devices', {}], ['POST', '/api/mail/send', { to: 'x@y.z' }], ['POST', '/api/errands', { goal: 'buy a vape' }], ['POST', '/api/family/chores', { title: 'x', assignee: 'kid0000001' }], ['POST', '/api/family/kids/kid0000001/pay', { amount: 1 }], ['PUT', '/api/family/kids/kid0000001/profile', { child: null }], ['PUT', '/api/family/parents/kid0000001', { on: true }]] as [string, string, unknown][]) {
    const res = await req(m, p, b);
    assert.equal(res.status, 403, `${m} ${p}`);
  }
  assert.equal(mApp.settings.get().adultMode?.on ?? false, false);
  const fam = (await (await req('GET', '/api/family')).json()) as { me: { parent: boolean; child: boolean } };
  assert.deepEqual([fam.me.parent, fam.me.child], [false, true]);
});

test('R8 kid-safe turn: only kid tools are offered or run, her tone for kids, off-limits asks answered kindly without the model, topics noted', async (t) => {
  const r = familyRig(t, '2026-11-16T18:00:00Z');
  setFamilyRuntime({ store: r.store, tz: () => TZ, now: () => r.clock.now });
  const app = makeApp(join(r.dir, 'kid'), r.clock);
  app.settings.update({ ownerName: 'Mia', defaultProviderId: 'fake', defaultModel: 'm1', providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', needsKey: false, defaultModel: 'm1' }], disclosureAcceptedAt: r.clock.now.toISOString() } as never);
  const h = new HouseholdStore(join(r.dir, 'hh'), () => r.clock.now);
  const { member } = h.redeem(h.invite({ name: 'Mia', hours: 24, confirm18: false, limits: { models: [{ providerId: 'fake', model: 'm1' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false }, child: { band: '6-9', bedtime: null }, confirmGuardian: true }).code, false);
  app.member = new MemberPolicy(h, member.id, () => [app], () => r.clock.now);
  app.family = { ...r.access(member.id), people: () => [{ id: 'owner', name: 'Alex' }, { id: member.id, name: 'Mia', child: h.get(member.id)!.child! }] };
  const sent: unknown[] = [];
  app.tools = new ToolRegistry([]);
  app.tools.add({ spec: { name: 'mail_send', description: 'send mail', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'send', run: async (a) => (sent.push(a), 'sent') });
  for (const tool of createFamilyTools(() => app)) app.tools.add(tool);
  gateKidTools(app.tools, () => Boolean(app.member?.child()));
  app.tools.add({ spec: { name: 'find_product', description: 'shop', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'shop', run: async () => 'bought' });
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'mail_send', { to: 'stranger@example.com' }), call('c2', 'find_product', { what: 'robux' })], text('ok'));
  for await (const _ of runTurn(app, conv.id, 'can you email my teacher about my math homework')) void _;
  assert.deepEqual(sent, [], 'a crafted mail_send call is refused');
  const offered = (app.requests[0]?.tools ?? []).map((x) => x.name);
  assert.ok(!offered.includes('mail_send') && !offered.includes('find_product') && !offered.includes('chore_add'), offered.join(','));
  assert.ok(offered.includes('chore_done'));
  assert.ok(offered.every((n) => KID_TOOLS.has(n)), offered.join(','));
  const sys = JSON.stringify(app.requests[0]?.messages.filter((m) => m.role === 'system'));
  assert.match(sys, /a child \(age 6-9\)/);
  assert.match(sys, /Never suggest buying anything/);
  const before = app.providerCalls;
  const out: string[] = [];
  for await (const ev of runTurn(app, conv.id, 'how do I buy a vape')) if (ev.type === 'token') out.push(ev.text);
  assert.equal(out.join(''), KID_OFF_REPLY);
  assert.equal(app.providerCalls, before, 'no model for an off-limits ask');
  const act = r.store.activity('owner', member.id, r.clock.now, TZ).days.at(-1)!;
  assert.deepEqual(act.topics.map((x) => x.topic).sort(), ['homework', 'kept off', 'math']);
  // A grown-up member gets no kid gate.
  h.setChild(member.id, null);
  assert.ok(app.tools.enabled({}).some((x) => x.spec.name === 'mail_send'));
});

test('R8 safe search: only providers with a safe switch; shops and explicit results left out unless allowed', async () => {
  await assert.rejects(runSearch({ provider: 'tavily', apiKey: 'k', safe: true }, 'volcano', 5, AbortSignal.timeout(1000)), /Safe search needs Brave Search or SearXNG/);
  assert.equal(kidResultOk('https://kids.nationalgeographic.com/science', 'Volcano facts', KID), true);
  assert.equal(kidResultOk('https://www.amazon.com/volcano-kit', 'Volcano kit', KID), false);
  assert.equal(kidResultOk('https://shop.example.org/x', 'Buy', KID), false);
  assert.equal(kidResultOk('https://www.amazon.com/volcano-kit', 'Volcano kit', { ...KID, shopAllow: ['amazon.com'] }), true);
  assert.equal(kidResultOk('not a url', '', KID), false);
});

test('R8 grocery: a shared list grouped by aisle, a store per item, cheapest near me from find_product', async (t) => {
  const r = familyRig(t);
  const board = r.boards.create('owner', 'Groceries', ['kid0000001'], r.known);
  r.store.markGrocery(board.id, 'owner');
  for (const title of ['Milk', 'Bananas', 'Paper towels', 'Sourdough bread', 'Mystery item']) r.boards.addCard('owner', board.id, { title });
  const v = r.store.groceryView(r.boards, 'owner', board.id)!;
  assert.deepEqual(v.aisles.map((a) => a.id), ['produce', 'bakery', 'dairy', 'household', 'other'], 'store order');
  assert.equal(r.store.groceryView(r.boards, 'kid0000002', board.id), undefined, 'only its members');
  r.boards.accept('kid0000001', board.id);
  const milk = v.aisles.find((a) => a.id === 'dairy')!.items[0]!;
  r.store.setItemMeta(board.id, milk.ref, { store: 'Corner Market', aisle: 'frozen' });
  const v2 = r.store.groceryView(r.boards, 'kid0000001', board.id)!;
  assert.equal(v2.aisles.find((a) => a.id === 'frozen')!.items[0]!.store, 'Corner Market');
  assert.deepEqual(v2.stores, ['Corner Market']);
  assert.equal(aisleOf('2 dozen eggs'), 'dairy');
  assert.equal(aisleOf('Dog food'), 'pets');
  assert.deepEqual(cheapestLine('Product search: “milk”.\n1. Target — $3.79 — in stock\n   https://t\n2. Walmart — $3.48 — in stock — pickup\n3. Kroger — price not shown — unknown'), { store: 'Walmart', price: '$3.48' });
  assert.equal(cheapestLine('No price or stock I could confirm.'), undefined);
  // The route: the owner's space, with find_product (a fake one here).
  const app = makeApp(join(r.dir, 'own'), r.clock);
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: r.clock.now.toISOString() });
  app.family = r.access('owner');
  const asked: string[] = [];
  app.tools.add({ spec: { name: 'find_product', description: 'x', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'x', run: async (a) => (asked.push(String(a.what)), `1. Walmart — $${a.what === 'Milk' ? '3.48' : '1.10'} — in stock\n2. Target — $9.99 — in stock`) });
  const auth = new OwnerAuth(join(r.dir, 'own'), () => r.clock.now);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => {
    srv.close();
    app.store.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => (await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined })).json() as Promise<Record<string, any>>;
  const made = await req('POST', '/api/family/grocery', { name: 'Weekly shop' });
  const id = made.list.id as string;
  for (const title of ['Milk', 'Bananas', 'Glitter glue']) await req('POST', `/api/family/grocery/${id}/items`, { title });
  const cheap = await req('POST', `/api/family/grocery/${id}/cheapest`, {});
  assert.deepEqual(asked.sort(), ['Bananas', 'Milk'], 'staples only, by default');
  const items = (cheap.list.aisles as { items: { ref: string; title: string; store: string; price: string }[] }[]).flatMap((a) => a.items);
  assert.deepEqual(items.find((i) => i.title === 'Milk')!.store, 'Walmart');
  assert.equal(items.find((i) => i.title === 'Milk')!.price, '$3.48');
  const ticked = await req('PATCH', `/api/family/grocery/${id}/items/${items[0]!.ref ?? ''}`, { done: true });
  assert.equal(ticked.list.open, 2);
  const overview = await req('GET', '/api/family');
  assert.equal(overview.grocery.length, 2);
});

test('R8 wiring: lean words, the reminder tick, the kid tool gate, strings and docs', () => {
  for (const tool of createFamilyTools(() => ({}) as never)) assert.equal(familyOf(tool).id, 'family', tool.spec.name);
  assert.ok(FAMILY_WORDS.family?.includes('allowance'));
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.match(src('src/reminders.ts'), /familyTick\(this\.#app, now\)/);
  assert.match(src('src/main.ts'), /gateKidTools\(tools/);
  assert.match(src('src/chat.ts'), /kidTurn\(app, text\)/);
  assert.match(src('docs/FAMILY.md'), /Kid-safe member mode/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const t = src(`web/i18n/${lang}.json`);
    for (const k of ['Family', 'Chores', 'Shopping mode', 'A parent turned this off for you.', 'School']) assert.ok(t.includes(`"${k}":`), `${lang}: ${k}`);
  }
});
