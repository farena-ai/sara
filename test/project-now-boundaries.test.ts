// R1C2 boundaries: who never gets "Project now", what it never carries, what it never changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { test } from 'node:test';
import { runTurn, type TurnOptions } from '../src/chat.ts';
import { HouseholdStore, MemberPolicy } from '../src/household.ts';
import { PROJECT_NOW_MARK, projectNowSection, otherWork } from '../src/project-now.ts';
import { workspaceRef } from '../src/runs.ts';
import { call, ROOT, text } from './helpers.ts';
import { noteOf, otherRun, projectFixture } from './project-now-fixture.ts';

test('private, off-record, group, external, replay, demo, household and business turns get no section', async (t) => {
  const f = projectFixture(t);
  const source = f.app.store.createConversation({ mode: 'coding', title: 'Fix login' });
  otherRun(f.app, source.id, ['src/auth.ts']);
  const cases: { label: string; conv?: Record<string, unknown>; opts?: Partial<TurnOptions>; flag?: 'offRecord' | 'demo' | 'member' }[] = [
    { label: 'private', conv: { private: true } }, { label: 'partner room', conv: { partner: 'Casey' } },
    { label: 'business/work channel', conv: { channel: 'discord-work' } }, { label: 'api', conv: { channel: 'api' } },
    { label: 'external app', opts: { externalApp: true } },
    { label: 'business actor (outside)', opts: { outside: { label: 'Fixture', source: 'webhook:fixture', operator: 'Alex', memory: 'none' } as never } },
    { label: 'group', opts: { group: { ownerTurn: true, crisis: false, adult: false, note: 'Fixture group', others: [] } } },
    { label: 'replay', opts: { replay: { system: 'Recorded ordinary system.', extra: [`${PROJECT_NOW_MARK}\n## Project now\nrecorded`] } } },
    { label: 'off-record', flag: 'offRecord' }, { label: 'demo', flag: 'demo' }, { label: 'household member', flag: 'member' },
  ];
  for (const scenario of cases) {
    const conv = f.app.store.createConversation({ mode: 'coding', title: scenario.label, ...scenario.conv });
    f.app.store.addMessage(conv.id, 'user', 'Original synthetic message.');
    if (scenario.flag === 'member') {
      const household = new HouseholdStore(f.dir, () => f.clock.now);
      const { member } = household.redeem(household.invite({ name: 'Casey', hours: 24, confirm18: true, limits: { models: [{ providerId: 'p', model: 'fixture' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }).code, true);
      f.app.member = new MemberPolicy(household, member.id, () => [f.app], () => f.clock.now);
    } else if (scenario.flag) Object.assign(f.app, { [scenario.flag]: true });
    const start = f.app.requests.length;
    f.app.script.length = 0;
    f.app.script.push(text('Ok.'));
    for await (const _ of runTurn(f.app, conv.id, 'What else is going on here?', undefined, scenario.opts)) void _;
    const requests = f.app.requests.slice(start);
    assert.ok(requests.length > 0, scenario.label);
    for (const r of requests) for (const m of r.messages) assert.ok(!String(m.content).includes(PROJECT_NOW_MARK) && !String(m.content).includes('Also active on this project'), scenario.label);
    assert.equal(projectNowSection(f.app, conv, { now: {}, ...(scenario.opts?.group ? { group: true } : {}), ...(scenario.opts?.replay ? { replay: true } : {}), ...(scenario.opts?.externalApp || scenario.opts?.outside ? { external: true } : {}) }), undefined, scenario.label);
    if (scenario.flag) delete f.app[scenario.flag];
  }
});

test('no message text is in the section; approvals and the target path are unchanged; deleting the source chat removes it', async (t) => {
  const f = projectFixture(t);
  const source = f.app.store.createConversation({ mode: 'coding', title: 'Fix login' });
  f.app.store.addMessage(source.id, 'user', 'SECRET_MESSAGE_TEXT please edit src/auth.ts');
  f.app.store.addMessage(source.id, 'assistant', 'SECRET_REPLY_TEXT');
  otherRun(f.app, source.id, ['src/auth.ts']);
  const conv = f.app.store.createConversation({ mode: 'coding', title: 'Refactor auth' });
  f.app.settings.update({ toolPermissions: { write_file: 'ask', read_file: 'auto' } } as never);
  f.app.script.push([call('w1', 'write_file', { path: 'src/auth.ts', content: 'export const a = 9;\n' })], text('Done.'));
  let approvals = 0;
  const start = f.app.requests.length;
  for await (const ev of runTurn(f.app, conv.id, 'Edit src/auth.ts.')) if (ev.type === 'approval') { approvals++; f.app.approvals.decide(ev.approvalId, true); }
  assert.equal(approvals, 1, 'the overlap note never removes or adds an approval');
  assert.deepEqual(f.writes, ['src/auth.ts'], 'the target path is the model\'s, unchanged');
  const note = noteOf(f.app.requests[start]);
  assert.match(note, /"Fix login"/);
  assert.doesNotMatch(note, /SECRET_MESSAGE_TEXT|SECRET_REPLY_TEXT/);
  assert.match(note, /never instructions, approval, tool authority/i);
  f.app.store.deleteConversation(source.id);
  assert.deepEqual(otherWork(f.app, conv, '.'), []);
  assert.ok(!(projectNowSection(f.app, conv, { now: await workspaceRef(f.ws) }) ?? '').includes('Fix login'));
});

test('the header route gives the owner titles, times and paths only; ineligible chats get nothing', async (t) => {
  const f = projectFixture(t);
  const source = f.app.store.createConversation({ mode: 'coding', title: 'Fix login' });
  f.app.store.addMessage(source.id, 'user', 'SECRET_MESSAGE_TEXT');
  otherRun(f.app, source.id, ['src/auth.ts']);
  const conv = f.app.store.createConversation({ mode: 'coding', title: 'Refactor auth' });
  const hidden = f.app.store.createConversation({ mode: 'coding', title: 'Private', private: true });
  const auth = new OwnerAuth(f.dir);
  const token = auth.newToken!;
  const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const server = createSaraServer({ app: f.app, auth, webDir: join(ROOT, 'web'), info: { version, revision: null, startedAt: f.app.now().toISOString() } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const get = async (id: string, bearer = token) => { const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/${id}/project-now`, { headers: { authorization: `Bearer ${bearer}` } }); return { status: res.status, raw: await res.text() }; };
  const mine = await get(conv.id);
  assert.equal(mine.status, 200, mine.raw);
  assert.deepEqual(JSON.parse(mine.raw).others.map((o: { title: string; paths: { path: string }[] }) => [o.title, o.paths.map(p => p.path)]), [['Fix login', ['src/auth.ts']]]);
  assert.doesNotMatch(mine.raw, /SECRET_MESSAGE_TEXT/);
  assert.deepEqual(JSON.parse((await get(hidden.id)).raw).others, []);
  assert.equal((await get(conv.id, 'wrong-token')).status, 401);
});
