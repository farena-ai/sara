// EC26 (docs/ops/EC26_DESIGN.md): Her at work. The work profile (defaults, merge, the policy pin),
// the two memory spaces (isolation both ways, copies, stamping), work tools and the work turn.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { runTurn } from '../src/chat.ts';
import { PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { createRecallTool, lastTimeNote } from '../src/recall.ts';
import type { Tool } from '../src/tools/types.ts';
import { atWork, copyToOtherSpace, memoryGate, mergeWorkProfile, spaceView, stampWork, WORK_DEFAULTS, workProfile, workTools } from '../src/work-profile.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 }));
const pol = new PolicyStore(dir);
setPolicy(pol);
after(() => {
  setPolicy(new PolicyStore());
  setAuditTrail(undefined as never);
  app.store.close();
  cleanup();
});
const named = (name: string) => ({ spec: { name, description: name, parameters: { type: 'object' as const } } });

test('work profile: off by default, Slack and Teams, merge keeps only known values, audited', () => {
  const p = workProfile(app);
  assert.equal(p.on, false);
  assert.deepEqual(p.channels, ['plugin-slack', 'plugin-teams']);
  assert.deepEqual(p.tools, WORK_DEFAULTS.tools);
  assert.equal(p.tools.commands, false);
  assert.equal(p.workspace, 'work');
  const n = mergeWorkProfile(app, { on: true, name: ' Sara\u0007 Weather ', tone: 'loud', channels: ['plugin-slack', 'web', 'plugin-matrix'], tools: { commands: 'yes' } });
  assert.equal(n.on, true);
  assert.equal(n.name, 'Sara Weather');
  assert.equal(n.tone, 'professional');
  assert.deepEqual(n.channels, ['plugin-slack', 'plugin-matrix']);
  assert.equal(n.tools.commands, false);
  assert.throws(() => mergeWorkProfile(app, { workspace: '../etc' }), /workspace name/);
  const row = auditTrail()!.list({}).find((r) => r.action === 'work-profile.change');
  assert.ok(row);
  assert.ok(row.keys?.includes('channels'));
  assert.equal(JSON.stringify(row).includes('Sara Weather'), false, 'names only, never values');
  mergeWorkProfile(app, { on: false, channels: ['plugin-slack', 'plugin-teams'], name: '' });
});

test('spaces: a chat is work only with the profile on and its channel ticked; stamps stay', () => {
  const slack = app.store.createConversation({ channel: 'plugin-slack', channelKey: 'D1' });
  const web = app.store.createConversation({ channel: 'web' });
  assert.equal(atWork(app, slack), false);
  assert.equal(spaceView(app).active, false, 'never used: no gate');
  assert.equal(memoryGate(app, 'personal'), undefined);
  mergeWorkProfile(app, { on: true });
  assert.equal(atWork(app, slack), true);
  assert.equal(atWork(app, web), false);
  const workFact = app.memory!.add({ kind: 'fact', content: 'The Q3 launch is on the 14th', conversationId: slack.id, sourceMessageId: 1, happenedOn: '2026-11-07' });
  const homeFact = app.memory!.add({ kind: 'fact', content: 'Alex has a dog called Biscuit', conversationId: web.id, sourceMessageId: 2, happenedOn: '2026-11-07' });
  const added = app.memory!.addOwner({ kind: 'fact', content: 'Alex likes tea', happenedOn: '2026-11-07' });
  const atWorkGate = memoryGate(app, 'work')!;
  const homeGate = memoryGate(app, 'personal')!;
  assert.equal(atWorkGate(workFact), true);
  assert.equal(atWorkGate(homeFact), false);
  assert.equal(atWorkGate(added), false, 'a note he added by hand is personal');
  assert.equal(homeGate(workFact), false);
  assert.equal(homeGate(homeFact), true);
  // Turning the profile off (or unticking Slack) never moves work notes into personal chats.
  stampWork(app, slack.id);
  mergeWorkProfile(app, { on: false });
  assert.equal(memoryGate(app, 'personal')!(workFact), false);
  assert.equal(atWork(app, slack), false);
  mergeWorkProfile(app, { on: true });
});

test('copy: the only way a note crosses, the original stays, one audit row', () => {
  const web = app.store.createConversation({ channel: 'web' });
  const fact = app.memory!.add({ kind: 'fact', content: 'Alex is allergic to peanuts', conversationId: web.id, sourceMessageId: 3, happenedOn: '2026-11-07' });
  const { memory, space } = copyToOtherSpace(app, fact.id);
  assert.equal(space, 'work');
  assert.equal(memory.content, fact.content);
  assert.equal(memory.space, 'work');
  assert.equal(memoryGate(app, 'work')!(memory), true);
  assert.equal(memoryGate(app, 'personal')!(memory), false);
  assert.equal(memoryGate(app, 'personal')!(fact), true, 'the original stays personal');
  const back = copyToOtherSpace(app, memory.id);
  assert.equal(back.space, 'personal');
  assert.ok(auditTrail()!.list({}).some((r) => r.action === 'memory.copy-space' && r.target === 'personal->work'));
  assert.throws(() => copyToOtherSpace(app, 999999), /Not found/);
});

test('work tools: research, files and calendar by default; commands only when allowed', () => {
  const all = ['recall', 'web_search', 'web_fetch', 'read_file', 'write_file', 'calendar_events', 'shell', 'run_code', 'git_commit', 'take_photo', 'share_photo', 'moments', 'change_outfit', 'scrapbook', 'ssh_run', 'pc_look', 'gmail_search', 'agenda_add', 'remind', 'home_control', 'scene_canon', 'shared_list'].map(named);
  const names = (p: Parameters<typeof workTools>[1]) => workTools(all, p).map((t) => t.spec.name);
  assert.deepEqual(names(WORK_DEFAULTS), ['recall', 'web_search', 'web_fetch', 'read_file', 'write_file', 'calendar_events']);
  assert.deepEqual(names({ tools: { ...WORK_DEFAULTS.tools, commands: true, files: false } }), ['recall', 'web_search', 'web_fetch', 'calendar_events', 'shell', 'run_code', 'git_commit']);
});

test('policy pin workMode: only on, forces every chat to work, refuses turning off (server side)', () => {
  assert.throws(() => validatePolicy({ pins: { workMode: false } }), /only be pinned on/);
  assert.deepEqual(validatePolicy({ pins: { workMode: true } }).pins, { workMode: true });
  mergeWorkProfile(app, { on: false });
  pol.set({ name: 'Acme', pins: { workMode: true } });
  try {
    const web = app.store.createConversation({ channel: 'web' });
    const p = workProfile(app);
    assert.equal(p.on, true);
    assert.equal(p.pinned, true);
    assert.equal(atWork(app, web), true, 'the app too');
    assert.throws(() => mergeWorkProfile(app, { on: false }), (e: Error & { status?: number }) => e.status === 409);
    // Other changes still save (name, tone, tools).
    assert.equal(mergeWorkProfile(app, { tone: 'formal' }).tone, 'formal');
    // A note he adds under the pin is a work note.
    const added = app.memory!.addOwner({ kind: 'fact', content: 'Badge number 4411', happenedOn: '2026-11-07' });
    assert.equal(memoryGate(app, 'work')!(added), true);
  } finally {
    pol.set({ name: 'Acme', pins: {} });
  }
  assert.equal(workProfile(app).pinned, false);
});

// ---------------------------------------------------------------- the turn (slice 3)

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ defaultPermission: 'auto', source: 'test', spec: { name, description: name, parameters: { type: 'object' } }, summarize: () => name, run: async () => 'done', ...extra });
for (const n of ['read_file', 'write_file', 'take_photo', 'moments', 'change_outfit', 'ssh_run', 'pc_look', 'calendar_events', 'home_control']) app.tools.add(tool(n));
app.tools.add(tool('shell', { runsCommands: true }));
app.tools.add(createRecallTool(() => app));
const turn = async (convId: string, msg: string) => {
  app.script.push(text('ok'));
  const events = [];
  for await (const ev of runTurn(app, convId, msg)) events.push(ev);
  const req = app.requests.at(-1)!;
  return { events, system: String(req.messages[0]?.content ?? ''), tools: (req.tools ?? []).map((t) => t.name) };
};

test('a work turn: memory isolation both ways, work tools, no companion features, her work name', async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p' });
  mergeWorkProfile(app, { on: true, name: 'Ava Desk', tone: 'formal', tools: { commands: false } });
  const slack = app.store.createConversation({ channel: 'plugin-slack', channelKey: 'D9', title: 'Slack' });
  const teams = app.store.createConversation({ channel: 'plugin-teams', channelKey: 'T9', title: 'Teams' });
  const web = app.store.createConversation({ channel: 'web', title: 'Home' });
  // One exchange in each first (so each has history), then the notes.
  await turn(slack.id, 'Morning, the Zephyr deadline moved.');
  await turn(web.id, 'My sister Mira visits next week.');
  app.memory!.add({ kind: 'fact', content: 'The Zephyr project deadline is Friday', conversationId: slack.id, sourceMessageId: 1, happenedOn: '2026-11-07' });
  app.memory!.add({ kind: 'fact', content: 'Alex has a sister called Mira who loves sailing', conversationId: web.id, sourceMessageId: 2, happenedOn: '2026-11-07' });
  clock.now = new Date(clock.now.getTime() + 3600_000);

  const atWorkTurn = await turn(teams.id, 'What about Zephyr and Mira?');
  assert.match(atWorkTurn.system, /Zephyr project deadline is Friday/, 'work notes reach every work chat');
  assert.doesNotMatch(atWorkTurn.system, /Mira who loves sailing/, 'personal notes never reach work');
  assert.doesNotMatch(atWorkTurn.system, /sister Mira visits/, 'nor personal lines (last time, elsewhere)');
  assert.match(atWorkTurn.system, /You are at work here \(Microsoft Teams\)\. Here you go by Ava Desk\./);
  assert.match(atWorkTurn.system, /formal and polite/);
  for (const section of ['## How you feel', '## Your day', '## You and Alex', '## Your life', "## What you're into lately", '## Doing something together']) assert.equal(atWorkTurn.system.includes(section), false, section);
  assert.doesNotMatch(atWorkTurn.system, /Affection, flirting and romance are fine/);
  assert.deepEqual(atWorkTurn.tools.filter((n) => ['take_photo', 'moments', 'change_outfit', 'ssh_run', 'pc_look', 'shell', 'home_control', 'remind', 'todo'].includes(n)), [], 'companion and personal tools stay out');
  for (const n of ['read_file', 'write_file', 'calendar_events', 'recall']) assert.ok(atWorkTurn.tools.includes(n), `${n} in ${atWorkTurn.tools.join(',')}`);
  assert.equal(app.store.getConversation(teams.id)!.workspace, 'work', 'her files at work are the work workspace');
  const notice = atWorkTurn.events.find((e) => e.type === 'notice' && e.kind === 'disclosure') as { text: string } | undefined;
  assert.ok(notice && /Ava Desk/.test(notice.text), 'the disclosure in her work name, once per work chat');

  const home = await turn(web.id, 'What about Zephyr and Mira?');
  assert.match(home.system, /Mira who loves sailing/);
  assert.doesNotMatch(home.system, /Zephyr project deadline/, 'work notes never reach personal chats');
  assert.doesNotMatch(home.system, /Zephyr deadline moved/);
  assert.doesNotMatch(home.system, /You are at work here/);
  assert.match(home.system, /## How you feel/, 'personal chats keep her inner life');
  assert.ok(home.tools.includes('take_photo') && home.tools.includes('shell'), 'personal chats keep their tools');
  assert.equal(app.store.getConversation(web.id)!.workspace, 'main');

  // Commands at work only when allowed.
  mergeWorkProfile(app, { tools: { commands: true } });
  assert.ok((await turn(slack.id, 'run the build')).tools.includes('shell'));
  mergeWorkProfile(app, { tools: { commands: false } });

  // Looking back: the recall tool and "last time" stay in their own space.
  const recall = app.tools.get('recall')!;
  const atWorkRecall = await recall.run({ query: 'Mira sister' }, { conversationId: teams.id } as never);
  assert.doesNotMatch(String(atWorkRecall), /sister Mira/);
  const homeRecall = await recall.run({ query: 'Zephyr deadline' }, { conversationId: web.id } as never);
  assert.doesNotMatch(String(homeRecall), /deadline moved/);
  assert.match(String(await recall.run({ query: 'Zephyr deadline' }, { conversationId: teams.id } as never)), /deadline moved/);
  const fresh = app.store.createConversation({ channel: 'web' });
  assert.doesNotMatch(lastTimeNote(app, fresh.id, 'Alex') ?? '', /deadline moved|"Slack"|"Teams"/);
  assert.match(lastTimeNote(app, app.store.createConversation({ channel: 'plugin-slack', channelKey: 'D10' }).id, 'Alex') ?? '', /"Teams"|"Slack"/);

  // A copy is the one way across.
  const fact = app.memory!.list({ kind: 'fact', q: 'Mira sailing' })[0];
  copyToOtherSpace(app, fact.id);
  assert.match((await turn(teams.id, 'Mira?')).system, /Mira who loves sailing/);

  // The profile off: Slack is personal again for new chats, but the stamped ones stay work.
  mergeWorkProfile(app, { on: false });
  const home2 = await turn(web.id, 'Zephyr?');
  assert.doesNotMatch(home2.system, /Zephyr project deadline/);
  const later = await turn(slack.id, 'Biscuit the dog?');
  assert.doesNotMatch(later.system, /You are at work here/, 'no work profile while it is off');
  assert.doesNotMatch(later.system, /dog called Biscuit/, 'it stays in the work space');
  assert.match((await turn(web.id, 'Biscuit the dog?')).system, /dog called Biscuit/);
});

test('the workMode pin: the app itself is at work for every chat', async () => {
  pol.set({ name: 'Acme', pins: { workMode: true } });
  try {
    const web = app.store.createConversation({ channel: 'web' });
    const r = await turn(web.id, 'hello');
    assert.match(r.system, /You are at work here \(the app\)/);
    assert.equal(r.system.includes('## How you feel'), false);
    assert.equal(r.tools.includes('take_photo'), false);
  } finally {
    pol.set({ name: 'Acme', pins: {} });
  }
});

test('routes: owner only, known values, memories by space, copy, the pin refuses turning it off', async () => {
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, o: { method?: string; body?: unknown; auth?: boolean } = {}) =>
    fetch(`${base}/api${path}`, { method: o.method ?? 'GET', headers: { ...(o.auth === false ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  try {
    assert.equal((await api('/work-profile', { auth: false })).status, 401);
    const put = await api('/work-profile', { method: 'PUT', body: { on: true, name: 'Ava', channels: ['plugin-slack', 'bogus'] } });
    assert.equal(put.status, 200);
    const got = (await (await api('/work-profile')).json()) as { profile: { on: boolean; name: string; channels: string[]; pinned: boolean }; choices: { channels: string[] } };
    assert.equal(got.profile.on, true);
    assert.equal(got.profile.name, 'Ava');
    assert.deepEqual(got.profile.channels, ['plugin-slack']);
    assert.ok(got.choices.channels.includes('plugin-teams'));
    const slack = app.store.createConversation({ channel: 'plugin-slack', channelKey: 'R1' });
    const m = app.memory!.add({ kind: 'fact', content: 'Standup is at 9:30', conversationId: slack.id, sourceMessageId: 1, happenedOn: '2026-11-07' });
    const work = (await (await api('/work-profile/memories?space=work')).json()) as { memories: { id: number }[] };
    assert.ok(work.memories.some((x) => x.id === m.id));
    const personal = (await (await api('/work-profile/memories?space=personal')).json()) as { memories: { id: number }[] };
    assert.equal(personal.memories.some((x) => x.id === m.id), false);
    const copied = (await (await api('/work-profile/copy', { method: 'POST', body: { id: m.id } })).json()) as { id: number; space: string };
    assert.equal(copied.space, 'personal');
    assert.equal((await api('/work-profile/copy', { method: 'POST', body: { id: 'x' } })).status, 400);
    pol.set({ name: 'Acme', pins: { workMode: true } });
    const refused = await api('/work-profile', { method: 'PUT', body: { on: false } });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /Set by your admin/);
  } finally {
    pol.set({ name: 'Acme', pins: {} });
    server.close();
  }
});
