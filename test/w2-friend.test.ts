// W2.3 (docs/HOSTING_FRIENDS.md): host a Sara for a friend. A hosted space is NOT a household
// member: its own settings and models, its own key file, no shared family features, and the owner
// only ever sees usage totals. Unit tests; the real-server isolation sweep is w2-friend-isolation.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HouseholdStore, MemberPolicy, memberDirs, memberRouteCheck, type MemberRecord } from '../src/household.ts';
import { HostedSettings, hostedVault, hostedView, HOSTED_SETTINGS_OWN } from '../src/hosted.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';

const fakeKey = () => ['sk', 'test', Math.random().toString(36).slice(2)].join('-');

function hostedStore(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const h = new HouseholdStore(dir);
  const { code } = h.invite({ name: 'Robin', hours: 24, confirm18: true, limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true }, hosted: true });
  return { dir, h, code };
}

test('W2.3 a hosted invite makes a hosted space that is not a household member', (t) => {
  const { h, code } = hostedStore(t);
  assert.equal(h.invites()[0]?.hosted, true);
  assert.equal(h.checkInvite(code)?.hosted, true);
  // A family invite stays a family invite.
  h.invite({ name: 'Ana', hours: 24, confirm18: true, limits: { models: [{ providerId: 'p', model: 'm' }], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } });
  assert.equal(h.invites().find((i) => i.name === 'Ana')?.hosted, undefined);
});

test('W2.3 redeem: the friend confirms 18+, gets a folder; members() never lists them, hosted() does', (t) => {
  const { dir, h, code } = hostedStore(t);
  assert.throws(() => h.redeem(code, false), /18/);
  const { member, dir: mdir } = h.redeem(code, true);
  assert.equal(member.hosted, true);
  assert.ok(existsSync(mdir));
  assert.deepEqual(h.members(), [], 'not a household member (boards, Family, sign-in rules, member tools)');
  assert.deepEqual(h.hosted().map((m) => m.name), ['Robin']);
  assert.equal(h.get(member.id)?.hosted, true, 'their own space still finds its record');
  assert.deepEqual(memberDirs(dir, h).map((m) => m.member.id), [member.id], 'their space is built at start-up');
  // Pause, resume and remove (the export window) work like a member's.
  assert.equal(h.setStatus(member.id, 'suspended').status, 'suspended');
  assert.equal(h.setStatus(member.id, 'active').status, 'active');
  assert.equal(h.markLeaving(member.id).status, 'leaving');
});

test('W2.3 routes: a friend changes their own models and spend limit, never shared or server things', () => {
  const rec = { id: 'abcdef0123', name: 'Robin', createdAt: '', status: 'active', ownerConfirmed18At: 'x', memberConfirmed18At: 'x', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true }, hosted: true } as MemberRecord;
  const ok = (m: string, p: string[]) => assert.equal(memberRouteCheck(rec, m, p), undefined, `${m} /api/${p.join('/')} should be allowed`);
  const no = (m: string, p: string[]) => assert.equal(memberRouteCheck(rec, m, p)?.status, 403, `${m} /api/${p.join('/')} should be refused`);
  ok('PUT', ['providers', 'mine']);
  ok('DELETE', ['providers', 'mine']);
  ok('POST', ['providers', 'mine', 'models', 'refresh']);
  ok('GET', ['spend']);
  ok('PUT', ['spend']);
  ok('GET', ['usage']);
  ok('GET', ['household', 'me']);
  ok('GET', ['household', 'me', 'export']);
  ok('POST', ['conversations', '1', 'messages']);
  for (const p of [['family'], ['boards'], ['columns'], ['hands'], ['computer'], ['alexa'], ['household'], ['household', 'hosted'], ['household', 'members', 'x'], ['mcp'], ['plugins'], ['backup'], ['update']]) no('GET', p);
  // A household member still can't change models or spend.
  const member = { ...rec, hosted: undefined } as MemberRecord;
  assert.equal(memberRouteCheck(member, 'PUT', ['providers', 'mine'])?.status, 403);
  assert.equal(memberRouteCheck(member, 'PUT', ['spend'])?.status, 403);
  // Paused or being removed: same rules as members (export only while leaving).
  assert.equal(memberRouteCheck({ ...rec, status: 'suspended' }, 'PUT', ['providers', 'x'])?.status, 403);
  assert.equal(memberRouteCheck({ ...rec, status: 'leaving' }, 'GET', ['household', 'me', 'export']), undefined);
  assert.equal(memberRouteCheck({ ...rec, status: 'leaving' }, 'PUT', ['providers', 'x'])?.status, 403);
});

test('W2.3 policy: any model of their own is fine (no owner allow-list); paused stops every call', (t) => {
  const { h, code } = hostedStore(t);
  const { member } = h.redeem(code, true);
  const pol = new MemberPolicy(h, member.id, () => []);
  assert.doesNotThrow(() => pol.checkModel('mine', 'any-model'));
  assert.doesNotThrow(() => pol.checkBudget());
  h.setStatus(member.id, 'suspended');
  assert.throws(() => pol.checkBudget(), /paused/);
});

test('W2.3 settings: their own providers and spend; never the owner\'s, never server-wide keys', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new HostedSettings(dir);
  const prov = { id: 'mine', label: 'My models', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'm1' };
  s.update({ providers: [prov], defaultProviderId: 'mine', defaultModel: 'm1', spend: { dayUsd: 1, monthUsd: 10, perTool: {}, prices: {} }, mcpServers: [{ id: 'x' }], shellNetwork: true, plugins: { on: true } } as never);
  const got = s.get() as unknown as Record<string, unknown>;
  assert.deepEqual((got.providers as { id: string }[]).map((p) => p.id), ['mine']);
  assert.equal(got.defaultModel, 'm1');
  assert.deepEqual((got.spend as { dayUsd: number }).dayUsd, 1);
  for (const k of ['mcpServers', 'shellNetwork', 'plugins']) assert.equal(got[k], undefined, `${k} is the server owner's`);
  for (const k of HOSTED_SETTINGS_OWN) assert.ok(['providers', 'prices', 'modelLists', 'modelAutoSwitch', 'routes'].includes(k));
  // Other apps may never use their tools on the owner's server.
  assert.equal((got.otherApps as { tools: boolean }).tools, false);
  // A fresh friend space has no providers at all (nothing of the owner's leaks in).
  const { dir: d2, cleanup: c2 } = tempDir();
  t.after(c2);
  assert.deepEqual(new HostedSettings(d2).get().providers, []);
});

test('W2.3 keys: the friend\'s vault has its own key file, not the server owner\'s', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const owner = new Vault(dir);
  const friendDir = join(dir, 'members', 'abcdef0123');
  const v = hostedVault(friendDir);
  const secret = fakeKey();
  v.set('provider:mine', secret);
  assert.equal(v.get('provider:mine'), secret);
  assert.equal(owner.get('provider:mine'), undefined);
  const ownerKey = readFileSync(join(dir, 'master.key'), 'utf8');
  const friendKey = readFileSync(join(friendDir, 'keys', 'master.key'), 'utf8');
  assert.notEqual(ownerKey, friendKey);
  assert.ok(!readFileSync(join(friendDir, 'keys', 'secrets.enc'), 'utf8').includes(secret), 'sealed at rest');
  // The owner's key can't open it.
  assert.throws(() => {
    const w = new Vault(join(friendDir, 'keys'), ownerKey.trim());
    if (w.get('provider:mine') !== secret) throw new Error('unreadable with the owner key');
  });
});

test('W2.3 the owner\'s view of a friend: name, status and usage totals only', () => {
  const rec = { id: 'abcdef0123', name: 'Robin', createdAt: '2026-11-19T00:00:00.000Z', status: 'active', ownerConfirmed18At: 'x', memberConfirmed18At: 'x', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true }, hosted: true } as MemberRecord;
  const usage = { days: [{ day: '2026-11-19', messages: 3 }], byModel: [{ model: 'secret-model', provider: 'Their provider', usd: 0.5, tokens: 300, calls: 3 }], usd: 0.5, tokens: 300 };
  const v = hostedView(rec, usage);
  assert.deepEqual(Object.keys(v).sort(), ['createdAt', 'deleteAfter', 'id', 'name', 'status', 'usage']);
  assert.deepEqual(v.usage, { messages7d: 3, usd7d: 0.5, tokens7d: 300 });
  assert.ok(!JSON.stringify(v).includes('secret-model'), 'which models they use is theirs');
  assert.deepEqual(hostedView(rec, null).usage, { messages7d: 0, usd7d: 0, tokens7d: 0 });
});
