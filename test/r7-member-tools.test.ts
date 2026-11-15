// R7: tool rules for household members (src/member-tools.ts). Families off / always ask / allowed,
// "every tool asks", a hard daily cap for paid tools, purchases/commands/coding never. Enforced on the
// server: a member can't reach a blocked tool by crafting settings, approvals or tool calls.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { memberClampFor, memberFamilyOf, MemberTools, MEMBER_TOOLS_FILE, setMemberTools, toolSpendCap } from '../src/member-tools.ts';
import { createSaraServer } from '../src/server.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const M = 'a1b2c3d4e5';
const tool = (name: string, defaultPermission: 'auto' | 'ask', ran: string[]): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission, summarize: () => name, run: async () => (ran.push(name), `${name} done`) });

test('families map tools; purchases, commands and coding are never for members', () => {
  assert.equal(memberFamilyOf('pc_browser_click'), 'computer');
  assert.equal(memberFamilyOf('mail_send'), 'mail-send');
  assert.equal(memberFamilyOf('web_search'), 'web');
  assert.equal(memberFamilyOf('errand_start'), 'errands');
  assert.equal(memberFamilyOf('automation_create'), 'automations');
  assert.equal(memberFamilyOf('shell'), 'shell');
  assert.equal(memberFamilyOf('pc_run'), 'shell');
  assert.equal(memberFamilyOf('git_commit'), 'coding');
  assert.equal(memberFamilyOf('recall'), undefined);
  const { dir, cleanup } = tempDir();
  try {
    const mt = new MemberTools(dir);
    for (const n of ['shell', 'run_code', 'pc_run', 'git_commit', 'code_definition']) assert.equal(mt.clamp(M, n, 'auto'), 'never', n);
    assert.equal(mt.clamp(M, 'mail_send', 'ask'), 'ask', 'nothing set: unchanged');
    assert.equal(mt.clamp(M, 'recall', 'auto'), 'auto');
  } finally {
    cleanup();
  }
});

test('rules: Everyone, a member override, every tool asks, never loosens; saved and audited', () => {
  const { dir, cleanup } = tempDir();
  const trail = new AuditTrail(dir, { key: () => 'k' });
  setAuditTrail(trail);
  try {
    const mt = new MemberTools(dir);
    mt.set({ everyone: { families: { 'mail-send': 'off', computer: 'ask' } } }, () => true);
    assert.equal(mt.clamp(M, 'mail_send', 'auto'), 'never');
    assert.equal(mt.clamp(M, 'pc_look', 'auto'), 'ask');
    assert.equal(mt.clamp(M, 'pc_look', 'never'), 'never', 'never stays never');
    // The member's own choice beats Everyone's.
    mt.set({ members: { [M]: { families: { 'mail-send': 'ask' }, alwaysAsk: true, spendPerDay: 0.5 } } }, () => true);
    assert.equal(mt.clamp(M, 'mail_send', 'auto'), 'ask');
    assert.equal(mt.clamp(M, 'recall', 'auto'), 'ask', 'every tool asks');
    assert.equal(mt.clamp(M, 'find_tools', 'auto'), 'auto', 'loading tool descriptions never asks');
    assert.equal(mt.clamp('ffffffffff', 'mail_send', 'auto'), 'never', 'other members: Everyone');
    assert.equal(mt.spendCap(M), 0.5);
    // Persisted; null = same as Everyone again.
    const again = new MemberTools(dir);
    assert.equal(again.clamp(M, 'mail_send', 'auto'), 'ask');
    again.set({ members: { [M]: null } }, () => true);
    assert.equal(again.clamp(M, 'mail_send', 'auto'), 'never');
    assert.equal(again.spendCap(M), undefined);
    // Strict input.
    assert.throws(() => again.set({ everyone: { families: { purchases: 'allow' } } }, () => true), /Unknown field/);
    assert.throws(() => again.set({ everyone: { families: { web: 'yes' } } }, () => true), /allow, ask or off/);
    assert.throws(() => again.set({ everyone: { families: {}, spendPerDay: 3 } }, () => true), /offered limits/);
    assert.throws(() => again.set({ members: { [M]: { families: {} } } }, () => false), /No such person/);
    const rows = trail.list({ action: 'member-tools' });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.action === 'member-tools.change'));
  } finally {
    setAuditTrail(undefined);
    cleanup();
  }
});

test('a damaged rules file turns every family off for members (fails closed)', () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, MEMBER_TOOLS_FILE), '{nope');
    const mt = new MemberTools(dir);
    assert.equal(mt.clamp(M, 'mail_send', 'auto'), 'never');
    assert.equal(mt.clamp(M, 'recall', 'auto'), 'ask');
  } finally {
    cleanup();
  }
});

test('spend cap: the tighter of the admin pin and the member cap', () => {
  const { dir, cleanup } = tempDir();
  try {
    const mt = new MemberTools(dir);
    setMemberTools(mt);
    mt.set({ everyone: { families: {}, spendPerDay: 1 } }, () => true);
    assert.equal(toolSpendCap(undefined, M), 1);
    assert.equal(toolSpendCap(0.25, M), 0.25);
    assert.equal(toolSpendCap(5, M), 1);
    assert.equal(toolSpendCap(5, undefined), 5, 'the owner: only the pin');
    assert.equal(toolSpendCap(undefined, undefined), undefined);
  } finally {
    setMemberTools(undefined);
    cleanup();
  }
});

function memberRig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-15T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Sam', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
  (app as { member?: unknown }).member = { id: M, checkModel() {}, checkBudget() {}, limits: () => ({ models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true }), record: () => undefined };
  const registry = new ToolRegistry([]);
  for (const x of app.tools.list()) registry.add(x);
  registry.memberClamp = memberClampFor(() => M);
  (app as { tools: ToolRegistry }).tools = registry;
  const ran: string[] = [];
  registry.add(tool('mail_send', 'auto', ran));
  registry.add(tool('pc_look', 'auto', ran));
  registry.add(tool('shell', 'auto', ran));
  const mt = new MemberTools(join(dir, 'owner-rules'));
  mkdirSync(join(dir, 'owner-rules'), { recursive: true });
  setMemberTools(mt);
  t.after(() => {
    setMemberTools(undefined);
    app.store.close();
    cleanup();
  });
  return { app, ran, mt };
}

const results = (evs: ChatEvent[]) => evs.filter((e): e is Extract<ChatEvent, { type: 'tool_result' }> => e.type === 'tool_result');

test('chat: a blocked family is not offered, and a crafted call to it does not run', async (t) => {
  const { app, ran, mt } = memberRig(t);
  mt.set({ everyone: { families: { 'mail-send': 'off' } } }, () => true);
  // Crafted: the member's own settings say Always allow, and the model calls it anyway.
  app.settings.update({ toolPermissions: { mail_send: 'auto', shell: 'auto' } } as never);
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'mail_send', { to: 'x@example.com' }), call('c2', 'shell', { command: 'dir' })], text('I could not send it.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'send the email to the plumber')) evs.push(ev);
  assert.deepEqual(ran, [], 'neither ran');
  assert.ok(!evs.some((e) => e.type === 'approval'), 'no card to click through');
  const offered = (app.requests[0]?.tools ?? []).map((x) => x.name);
  assert.ok(!offered.includes('mail_send') && !offered.includes('shell'), 'never offered');
  assert.equal(results(evs).length, 2);
  assert.ok(results(evs).every((r) => r.status !== 'ok'));
});

test('chat: Always ask turns an automatic tool into a card; No means it does not run', async (t) => {
  const { app, ran, mt } = memberRig(t);
  mt.set({ everyone: { families: { computer: 'ask' } } }, () => true);
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'pc_look', {})], text('Okay.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'look at my computer screen')) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
  }
  assert.ok(evs.some((e) => e.type === 'approval'), 'it asked');
  assert.deepEqual(ran, []);
  // Allowed again: it runs on its own.
  mt.set({ everyone: { families: {} } }, () => true);
  app.script.push([call('c2', 'pc_look', {})], text('Done.'));
  const evs2: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'look at my computer screen again')) evs2.push(ev);
  assert.ok(!evs2.some((e) => e.type === 'approval'));
  assert.deepEqual(ran, ['pc_look']);
});

test('routes: owner reads and changes the rules; a member gets 403, even hand-made', async (t) => {
  const { dir, cleanup } = tempDir();
  for (const d of ['owner', 'm']) mkdirSync(join(dir, d), { recursive: true });
  const clock = { now: new Date('2026-11-15T12:00:00Z') };
  const app = makeApp(join(dir, 'owner'), clock);
  const mApp = makeApp(join(dir, 'm'), clock);
  const auth = new OwnerAuth(join(dir, 'owner'), () => clock.now);
  const mAuth = new OwnerAuth(join(dir, 'm'), () => clock.now);
  const record = { id: M, name: 'Sam', status: 'active', createdAt: '', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } };
  const household = { store: { members: () => [record] } } as never;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), household });
  const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: M, member: { record: () => record as never, apps: () => [mApp], deleteSelf: async () => {} } });
  setMemberTools(new MemberTools(join(dir, 'owner')));
  for (const s of [server, msrv]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => {
    setMemberTools(undefined);
    for (const s of [server, msrv]) await new Promise<void>((r) => s.close(() => r()));
    app.store.close();
    mApp.store.close();
    cleanup();
  });
  for (const a of [app, mApp]) a.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mbase = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
  const h = (tok: string, origin: string) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', origin });
  const owner = h(auth.newToken!, base);
  let r = await fetch(`${base}/api/member-tools`, { headers: owner });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.deepEqual(v.people.map((p: { id: string }) => p.id), [M]);
  assert.equal(v.people[0].effective.families['mail-send'], 'allow');
  r = await fetch(`${base}/api/member-tools`, { method: 'PUT', headers: owner, body: JSON.stringify({ members: { [M]: { families: { 'mail-send': 'off' }, spendPerDay: 1 } } }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).people[0].effective.families['mail-send'], 'off');
  r = await fetch(`${base}/api/member-tools`, { method: 'PUT', headers: owner, body: JSON.stringify({ members: { ffffffffff: { families: {} } } }) });
  assert.equal(r.status, 404);
  // The member can't read or change it, even with a hand-made request.
  const member = h(mAuth.newToken!, mbase);
  for (const method of ['GET', 'PUT']) {
    const m = await fetch(`${mbase}/api/member-tools`, { method, headers: member, ...(method === 'PUT' ? { body: JSON.stringify({ members: { [M]: null } }) } : {}) });
    assert.equal(m.status, 403, method);
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'owner', MEMBER_TOOLS_FILE), 'utf8')).members[M].families['mail-send'], 'off', 'unchanged');
});

test('computer use: a member companion never presses a payment button (browser and desktop)', () => {
  const src = readFileSync(join(ROOT, 'src', 'tools', 'computer.ts'), 'utf8');
  assert.equal(src.split("if (app.member && verdict.risk === 'payment') return { refuse: `Error: ${PURCHASE_REFUSAL}` };").length - 1, 2);
  const reg = readFileSync(join(ROOT, 'src', 'tools', 'registry.ts'), 'utf8');
  assert.match(reg, /return this\.memberClamp \? this\.memberClamp\(name, p\) : p;/);
  assert.match(readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8'), /if \(isMember\) tools\.memberClamp = memberClampFor/);
});
