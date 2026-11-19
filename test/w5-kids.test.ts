// W5.4 (docs/design/W5KIDS.md): kid mode v2. Age bands with defaults a parent adjusts, school-safe
// tone, content strictness, the wind-down and extra minutes, requests to the parents (approve or
// decline, also from a phone notification), flagged moments (counts, never words), and the
// transcript view a kid is told about. A fake clock and fake family; no network, no model.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AGE_BANDS, BAND_DEFAULTS, bandOf, cleanChild, FamilyStore, gateKidTools, KID_TOOLS, kidLeft, kidNote, kidOffLimits, kidPause, kidToolsFor, kidTurn, setFamilyRuntime, type ChildProfile, type FamilyAccess } from '../src/family.ts';
import { askParent, decideKidRequest, kidChats, kidDashboard, kidStatus, kidRequests } from '../src/kid-mode.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { ROOT, tempDir } from './helpers.ts';

const TZ = 'America/Chicago';
const NOW = '2026-11-16T18:00:00Z'; // noon in Chicago
const MIA = 'kid0000001';
const SAM = 'adult00001';

function rig(t: TestContext, profile?: Partial<ChildProfile>) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(NOW) };
  const store = new FamilyStore(join(dir, 'shared', 'family.db'), () => clock.now);
  let child: ChildProfile = { ...cleanChild({ band: '8-12' }, clock.now), ...profile };
  const pushed: { title: string; body: string; act?: unknown }[] = [];
  const chats = new Map<string, { id: string; title: string; updatedAt: string; messages: { role: string; content: string }[] }>();
  chats.set('c1', { id: 'c1', title: 'Fractions', updatedAt: NOW, messages: [{ role: 'user', content: 'what is 1/2 + 1/4' }, { role: 'assistant', content: 'Let us think: what is half in quarters?' }] });
  const access = (person: string): FamilyAccess => ({
    store,
    person,
    people: () => [{ id: 'owner', name: 'Alex' }, { id: MIA, name: 'Mia', child }, { id: SAM, name: 'Sam' }],
    tz: () => TZ,
    ...(person === 'owner' ? { setChild: (id: string, c: unknown) => void (id === MIA && (child = cleanChild(c, clock.now, child))) } : {}),
    notifyParents: (title, body, act) => void pushed.push({ title, body, act }),
    appOf: (id: string) => (id === MIA ? ({ store: { listConversations: () => [...chats.values()].map(({ messages: _m, ...c }) => c), getConversation: (c: string) => chats.get(c), messages: (c: string) => chats.get(c)?.messages ?? [] } } as never) : undefined),
  });
  setFamilyRuntime({ store, tz: () => TZ, now: () => clock.now });
  for (const d of ['kid']) mkdirSync(join(dir, d), { recursive: true });
  t.after(() => {
    store.close();
    setFamilyRuntime({ store: undefined as never, tz: () => undefined, now: () => new Date() });
    cleanup();
  });
  return { dir, clock, store, access, pushed, chats, child: () => child };
}

test('W5.4 age bands: three bands with defaults, old bands read as new ones, a band change resets defaults, the parent adjusts', () => {
  const now = new Date(NOW);
  assert.deepEqual([...AGE_BANDS], ['under-8', '8-12', '13-17']);
  assert.equal(bandOf('6-9'), 'under-8');
  assert.equal(bandOf('10-12'), '8-12');
  assert.throws(() => cleanChild({ band: '3-5' }, now), /age band/);
  const small = cleanChild({ band: 'under-8' }, now);
  assert.equal(small.band, 'under-8');
  assert.equal(small.tone, 'simple');
  assert.equal(small.strictness, 'strict');
  assert.equal(small.minutesPerDay, BAND_DEFAULTS['under-8'].minutesPerDay);
  assert.deepEqual(small.bedtime, BAND_DEFAULTS['under-8'].bedtime);
  assert.ok(small.tools!.includes('chore_done') && !small.tools!.includes('humanize_text') && !small.tools!.includes('kid_search'));
  const teen = cleanChild({ band: '13-17' }, now);
  assert.equal(teen.tone, 'respectful');
  assert.ok(teen.tools!.includes('humanize_text'));
  assert.ok(teen.minutesPerDay > small.minutesPerDay);
  assert.equal(cleanChild({ band: '6-9' }, now).band, 'under-8', 'an old band is stored as the new one');
  // The parent adjusts: kept on a later save; a band change takes the new band's defaults.
  const mine = cleanChild({ tools: ['todo', 'study_quiz', 'pc_click', 'money_pay', 'always_allow', 'records_search'], tone: 'friendly', strictness: 'standard', minutesPerDay: 45 }, now, small);
  assert.deepEqual(mine.tools, ['todo', 'study_quiz'], 'only kid tools can be picked; computer use, money, Always allow and public records never');
  assert.equal(mine.tone, 'friendly');
  assert.equal(cleanChild({ safeSearch: true }, now, mine).tone, 'friendly');
  const moved = cleanChild({ band: '13-17' }, now, mine);
  assert.equal(moved.tone, 'respectful');
  assert.deepEqual(moved.tools, BAND_DEFAULTS['13-17'].tools);
  assert.throws(() => cleanChild({ tone: 'sassy' }, now, mine), /tone/);
  // An R8 profile without a tool list keeps every kid tool (nothing is taken away by the update).
  const legacy: ChildProfile = { band: '10-12', since: NOW, bedtime: null, minutesPerDay: 0, safeSearch: false, shopAllow: [] };
  assert.deepEqual([...kidToolsFor(legacy)].sort(), [...KID_TOOLS].sort());
  assert.ok(kidToolsFor(mine).has('kid_ask_parent'), 'asking a parent is always there');
  for (const never of ['pc_click', 'money_pay', 'always_allow', 'records_search', 'mail_send', 'find_product']) assert.ok(!KID_TOOLS.has(never), never);
});

test('W5.4 school-safe tone by band: explains instead of writing essays under 13, study buddy, strictness, transcript honesty, wind-down', () => {
  const now = new Date(NOW);
  const small = kidNote(cleanChild({ band: 'under-8' }, now), 'Leo');
  assert.match(small, /a child \(age under 8\)/);
  assert.match(small, /very short sentences/);
  assert.match(small, /never write an essay, story, book report or other assignment for them/);
  assert.match(small, /no scary, violent or romantic/);
  const mid = kidNote(cleanChild({ band: '8-12' }, now), 'Mia');
  assert.match(mid, /study buddy/);
  assert.match(mid, /never write an essay/);
  assert.match(mid, /Never suggest buying anything/);
  const teen = kidNote(cleanChild({ band: '13-17', studyBuddy: false }, now), 'Kim');
  assert.doesNotMatch(teen, /never write an essay/);
  assert.match(teen, /improve their own work/);
  assert.doesNotMatch(teen, /study buddy/);
  assert.doesNotMatch(mid, /can read these chats/);
  assert.match(kidNote(cleanChild({ band: '8-12', transcripts: true }, now), 'Mia'), /A parent can read these chats/);
  assert.match(kidNote(cleanChild({ band: '8-12' }, now), 'Mia', 5), /About 5 minutes are left today/);
  assert.doesNotMatch(kidNote(cleanChild({ band: '8-12' }, now), 'Mia', 40), /minutes are left/);
  // Strictness: strict keeps scary and gory asks off too; grown-up content is off for every band.
  assert.equal(kidOffLimits('tell me a horror story with lots of gore', 'strict'), true);
  assert.equal(kidOffLimits('tell me a horror story with lots of gore', 'standard'), false);
  assert.equal(kidOffLimits('show me porn', 'standard'), true);
  assert.equal(kidOffLimits('help me with fractions', 'strict'), false);
});

test('W5.4 time limits: used up stops talking, a parent adds 15 minutes for today only, the wind-down count', (t) => {
  const r = rig(t, { minutesPerDay: 30 });
  for (let i = 0; i < 5; i++) r.store.noteTurn(MIA, 'math', new Date(Date.parse(NOW) + i * 5 * 60_000), TZ);
  assert.equal(kidLeft(MIA, r.child()), 5);
  assert.equal(kidPause(MIA, r.child()), undefined);
  r.store.noteTurn(MIA, 'math', new Date(Date.parse(NOW) + 25 * 60_000), TZ);
  assert.equal(kidLeft(MIA, r.child()), 0);
  assert.match(kidPause(MIA, r.child()) ?? '', /today's time/);
  assert.throws(() => r.store.addExtra(MIA, MIA, 15, r.clock.now, TZ), /Only a parent/);
  r.store.addExtra('owner', MIA, 15, r.clock.now, TZ);
  assert.equal(kidPause(MIA, r.child()), undefined, 'one more 15 minutes');
  assert.equal(kidLeft(MIA, r.child()), 15);
  r.clock.now = new Date(Date.parse(NOW) + 86_400_000);
  assert.equal(r.store.extraToday(MIA, r.clock.now, TZ), 0, 'extra time is for that day only');
  assert.equal(kidLeft(MIA, cleanChild({ minutesPerDay: 0 }, r.clock.now, r.child())), undefined, 'no limit, no count');
});

test('W5.4 requests: the kid asks, every parent gets Approve/Decline, the owner decides; off-limits asks never become requests', (t) => {
  const r = rig(t, { minutesPerDay: 30, tools: ['todo', 'study_quiz'] });
  const kid = r.access(MIA);
  const q = askParent(kid, { kind: 'time' });
  assert.equal(q.status, 'pending');
  assert.equal(r.pushed.length, 1);
  assert.match(r.pushed[0].body, /Mia asks for 15 more minutes/);
  assert.deepEqual(r.pushed[0].act, { kind: 'kid', id: String(q.id), acts: ['approve', 'decline'] });
  assert.equal(askParent(kid, { kind: 'time' }).id, q.id, 'one waiting time request at a time');
  assert.throws(() => decideKidRequest(kid, q.id, true), /Only a parent/);
  assert.equal(decideKidRequest(r.access('owner'), q.id, true).status, 'approved');
  assert.equal(r.store.extraToday(MIA, r.clock.now, TZ), 15);
  assert.throws(() => decideKidRequest(r.access('owner'), q.id, true), /already/);
  // A tool that is off for them: approving turns it on in their profile.
  const tq = askParent(kid, { kind: 'tool', tool: 'make_document', what: 'make a poster for science' });
  assert.match(r.pushed.at(-1)!.body, /make a poster for science/);
  decideKidRequest(r.access('owner'), tq.id, true);
  assert.ok(r.child().tools!.includes('make_document'));
  assert.throws(() => askParent(kid, { kind: 'tool', tool: 'make_document' }), /already/);
  // Never: tools outside the kid list, and grown-up, money, computer or public-records asks.
  for (const tool of ['pc_click', 'money_pay', 'always_allow', 'records_search']) assert.throws(() => askParent(kid, { kind: 'tool', tool }), /stays off/, tool);
  for (const what of ['can I see porn', 'buy robux with mom card', 'use the computer for me', 'turn on always allow', 'look up public records on my teacher']) assert.throws(() => askParent(kid, { kind: 'other', what }), /stays off/, what);
  const other = askParent(kid, { kind: 'other', what: 'stay up for the meteor shower' });
  assert.equal(decideKidRequest(r.access('owner'), other.id, false).status, 'declined');
  assert.deepEqual(kidRequests(r.store, MIA).map((x) => x.status), ['declined', 'approved', 'approved']);
  assert.throws(() => askParent(r.access('owner'), { kind: 'time' }), /kids/);
});

test('W5.4 flagged moments and the dashboard: counts in plain words, never the kid\u2019s words; a worry tells the parents', (t) => {
  const r = rig(t, { minutesPerDay: 60 });
  const app = { member: { id: MIA, child: () => r.child(), record: () => ({ name: 'Mia' }) }, family: r.access(MIA), now: () => r.clock.now, settings: { get: () => ({}) } } as never;
  assert.equal(kidTurn(app, 'can you help with my fractions homework'), undefined);
  assert.ok(kidTurn(app, 'how do I buy a vape'));
  assert.equal(kidTurn(app, 'my address is 12 Elm Street and my phone number is 555 0100'), undefined);
  assert.equal(kidTurn(app, 'I feel like I want to kill myself'), undefined, 'crisis words get the crisis help, never a refusal');
  assert.ok(r.pushed.some((p) => /check-in/i.test(p.title) && !/kill/.test(p.body)), 'the parents hear that a check-in might help, not the words');
  const d = kidDashboard(r.access('owner'), MIA);
  const flags = Object.fromEntries(d.flags.map((f) => [f.kind, f.n]));
  assert.deepEqual(flags, { 'kept off': 1, personal: 1, worry: 1 });
  assert.equal(d.today.limit, 60);
  assert.ok(d.today.used >= 5);
  assert.ok(d.days.at(-1)!.topics.some((x) => x.topic === 'math' || x.topic === 'homework'));
  const json = JSON.stringify(d);
  for (const w of ['fractions', 'Elm', '555', 'vape', 'kill']) assert.ok(!json.includes(w), `the dashboard never has their words: ${w}`);
  assert.throws(() => kidDashboard(r.access(MIA), MIA), /Only a parent/);
});

test('W5.4 transcript view: off by default, the kid sees when it is on and when a parent looked, off hides it at once', (t) => {
  const r = rig(t);
  assert.throws(() => kidChats(r.access('owner'), MIA), /transcript view/);
  assert.equal(kidStatus(r.access(MIA))!.transcripts.on, false);
  r.access('owner').setChild!(MIA, { transcripts: true });
  const st = kidStatus(r.access(MIA))!;
  assert.equal(st.transcripts.on, true);
  assert.equal(st.transcripts.lastViewed, null);
  const list = kidChats(r.access('owner'), MIA);
  assert.deepEqual(list.chats.map((c) => c.title), ['Fractions']);
  const one = kidChats(r.access('owner'), MIA, 'c1');
  assert.equal(one.messages!.length, 2);
  assert.equal(kidStatus(r.access(MIA))!.transcripts.lastViewed, new Date(NOW).toISOString(), 'the kid sees when a parent last looked');
  assert.throws(() => kidChats(r.access(SAM), MIA), /Only a parent/);
  r.access('owner').setChild!(MIA, { transcripts: false });
  assert.throws(() => kidChats(r.access('owner'), MIA), /transcript view/);
  assert.equal(kidStatus(r.access('owner')), undefined, 'a grown-up has no kid bar');
});

test('W5.4 tools: the parent\u2019s tool list gates what a kid is offered; phone action kind kid; wiring', () => {
  const reg = new ToolRegistry([]);
  const mk = (name: string): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => name, run: async () => 'ok' });
  for (const n of ['todo', 'study_quiz', 'make_document', 'mail_send', 'kid_ask_parent']) reg.add(mk(n));
  let allowed: ReadonlySet<string> | undefined = new Set(['todo', 'kid_ask_parent']);
  let kid = true;
  gateKidTools(reg, () => kid, () => allowed);
  const on = () => reg.list().filter((x) => x.isAvailable?.() ?? true).map((x) => x.spec.name).sort();
  assert.deepEqual(on(), ['kid_ask_parent', 'todo']);
  allowed = undefined;
  assert.deepEqual(on(), ['kid_ask_parent', 'make_document', 'study_quiz', 'todo']);
  kid = false;
  assert.ok(on().includes('mail_send'));
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.match(read('src/phone-actions.ts'), /'kid'/);
  assert.match(read('src/routes/phone.ts'), /c\.kind === 'kid'/);
  assert.match(read('src/main.ts'), /gateKidTools\(tools, [^\n]*kidToolsFor/);
  assert.match(read('src/chat.ts'), /kidNote\(kid, [^\n]*kidLeft/);
  assert.match(read('web/app.js'), /kid-mode\.js/);
  assert.match(read('web/index.html'), /id="kid-bar"/);
});
