// S9b (docs/SUPPORT_LINK.md): the support link between two linked Sara servers. The helped owner gives a
// time-limited help pass over an S9a link; with it the helper's Sara reads a redacted support report
// (signed with the link keys, scope 'support') and may PROPOSE settings changes from an allowlist that
// the helped owner approves or denies. Never chats, memories, files, mail, messages or medical data.
import assert from 'node:assert/strict';
import { createHash, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { Log } from '../src/log.ts';
import { Messenger, signEnvelope } from '../src/messages.ts';
import { createSaraServer } from '../src/server.ts';
import { signSupport, supportFindings, supportOf, SUPPORT_HOURS } from '../src/support.ts';
import { createSupportTools } from '../src/tools/support.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

type Node = { app: TestApp; m: Messenger; base: string; req: (method: string, path: string, body?: unknown) => Promise<any>; raw: (method: string, path: string, body?: unknown) => Promise<Response>; dir: string };
const clock = { now: new Date('2026-11-16T12:00:00Z') };
const tick = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function node(t: TestContext, name: string, opts: { member?: boolean; child?: boolean } = {}): Promise<Node> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'small-1', needsKey: false }] as never, defaultProviderId: 'fake', defaultModel: 'small-1', fallbackAfterSec: 60 });
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  if (!opts.member) app.messages = m;
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const record = () => ({ id: 'mem0000001', name: 'Mo', status: 'active', child: Boolean(opts.child), limits: { voice: false, pictures: false } });
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.member ? { spaceId: 'mem0000001', member: { record: () => record() as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { app, m, base, req, raw, dir: tmp.dir };
}

/** A (helped) links with B (helper). Returns each side's link id. */
async function link(a: Node, b: Node): Promise<{ aLink: string; bLink: string }> {
  const { code } = await a.req('POST', '/api/messages/invite', { url: a.base });
  const joined = await b.req('POST', '/api/messages/join', { code, url: b.base });
  const aLink = a.m.links()[0]!.id;
  return { aLink, bLink: joined.chat.linkId };
}

test('S9b: a help pass is granted for 1 h / 1 day / 7 days, listed with its expiry on both sides, revocable, and expires', async (t) => {
  assert.deepEqual([...SUPPORT_HOURS], [1, 24, 168]);
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  // Without a pass the helper can't look.
  const before = await b.raw('POST', '/api/support/look', { link: bLink });
  assert.equal(before.status, 403);
  // Only the three durations.
  assert.equal((await a.raw('POST', '/api/support/passes', { link: aLink, hours: 5 })).status, 400);
  const g = await a.req('POST', '/api/support/passes', { link: aLink, hours: 1, note: 'my backup model fails' });
  assert.equal(Date.parse(g.pass.expiresAt) - clock.now.getTime(), 3_600_000);
  const aView = await a.req('GET', '/api/support');
  assert.equal(aView.given.length, 1);
  assert.equal(aView.given[0].active, true);
  assert.equal(aView.given[0].peer, 'Sam');
  const bView = await b.req('GET', '/api/support');
  assert.equal(bView.held.length, 1, 'the helper is told about the pass');
  assert.equal(bView.held[0].expiresAt, g.pass.expiresAt);
  assert.equal(bView.held[0].note, 'my backup model fails');
  // With the pass: a look works, and both sides log it.
  const look = await b.req('POST', '/api/support/look', { link: bLink });
  assert.ok(look.report.version.server !== undefined);
  assert.ok(Array.isArray(look.findings));
  for (const v of [await a.req('GET', '/api/support'), await b.req('GET', '/api/support')]) assert.ok(v.log.some((r: any) => r.kind === 'look'), 'both owners see the look');
  // Revoke: the helper is told, and the next look is refused.
  await a.req('DELETE', `/api/support/passes/${g.pass.id}`);
  assert.equal((await b.req('GET', '/api/support')).held.filter((p: any) => p.active).length, 0);
  assert.equal((await b.raw('POST', '/api/support/look', { link: bLink })).status, 403);
  // A new 1-day pass, then the clock runs past it: refused, shown as expired.
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 24 });
  await b.req('POST', '/api/support/look', { link: bLink });
  tick(24 * 3_600_000 + 60_000);
  assert.equal((await b.raw('POST', '/api/support/look', { link: bLink })).status, 403);
  assert.equal((await a.req('GET', '/api/support')).given.filter((p: any) => p.active).length, 0);
  // 7 days works too.
  const w = await a.req('POST', '/api/support/passes', { link: aLink, hours: 168 });
  assert.equal(Date.parse(w.pass.expiresAt) - clock.now.getTime(), 168 * 3_600_000);
  // Audit rows on both sides for passes and looks.
  const rows = auditTrail()?.list({ limit: 500 }) ?? [];
  assert.ok(rows.some((r) => r.action === 'support.look'), 'peer looks are audited');
  assert.ok(rows.some((r) => r.action.startsWith('support.')), 'owner actions are audited');
});

test('S9b: the support endpoint takes only support-scope signatures with the link keys (no message signatures, no replays)', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  const key = b.m.privateKeyFor(bLink)!;
  const post = (path: string, body: string, headers: Record<string, string>) => fetch(a.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const body = JSON.stringify({ v: 1, id: randomUUID() });
  // The real thing works.
  const ok = await post('/msg/v1/support/look', body, signSupport(bLink, 'look', body, key, clock.now));
  assert.equal(ok.status, 200);
  // The same request again: replay.
  assert.equal((await post('/msg/v1/support/look', body, signSupport(bLink, 'look', body, key, clock.now))).status, 409);
  // A message-scope signature (S9a) on the support endpoint: refused.
  const b2 = JSON.stringify({ v: 1, id: randomUUID() });
  const msgSig = signEnvelope(bLink, b2, key, clock.now);
  assert.equal((await post('/msg/v1/support/look', b2, { 'sara-sup-link': bLink, 'sara-sup-time': msgSig['sara-msg-time']!, 'sara-sup-sig': msgSig['sara-msg-sig']! })).status, 401);
  // A support signature on the message inbox: refused.
  const b3 = JSON.stringify({ v: 1, id: randomUUID(), type: 'dm', mid: 'x1', text: 'hi' });
  const sup = signSupport(bLink, 'look', b3, key, clock.now);
  assert.equal((await post('/msg/v1/inbox', b3, { 'sara-msg-link': bLink, 'sara-msg-time': sup['sara-sup-time']!, 'sara-msg-sig': sup['sara-sup-sig']! })).status, 401);
  // Signed for another operation (look → propose): refused.
  const b4 = JSON.stringify({ v: 1, id: randomUUID(), changes: [{ path: 'defaultModel', value: 'x' }] });
  assert.equal((await post('/msg/v1/support/propose', b4, signSupport(bLink, 'look', b4, key, clock.now))).status, 401);
  // Unknown link, a stranger's key, a stale time, no signature.
  const b5 = JSON.stringify({ v: 1, id: randomUUID() });
  assert.equal((await post('/msg/v1/support/look', b5, signSupport('nope', 'look', b5, key, clock.now))).status, 401);
  const { generateKeyPairSync } = await import('node:crypto');
  const stranger = generateKeyPairSync('ed25519').privateKey;
  assert.equal((await post('/msg/v1/support/look', b5, signSupport(bLink, 'look', b5, stranger, clock.now))).status, 401);
  assert.equal((await post('/msg/v1/support/look', b5, signSupport(bLink, 'look', b5, key, new Date(clock.now.getTime() - 10 * 60_000)))).status, 401);
  assert.equal((await post('/msg/v1/support/look', b5, {})).status, 401);
  // A hand-made signature over the wrong scope prefix: refused.
  const time = clock.now.toISOString();
  const wrong = sign(null, Buffer.from(`msg\n${bLink}\n${time}\nlook\n${sha(b5)}`), key).toString('base64');
  assert.equal((await post('/msg/v1/support/look', b5, { 'sara-sup-link': bLink, 'sara-sup-time': time, 'sara-sup-sig': wrong })).status, 401);
});

test('S9b: the report leaves no secrets, emails, tokens, message text or medical data, and no chats/memories/files/mail', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  // Seeds built at run time (never realistic-looking literals in the repo).
  const vaultSecret = ['vault', 'only', randomUUID().slice(0, 8), 'value'].join('Q');
  a.app.vault.set('provider:fake', vaultSecret);
  const keyShaped = 'sk-' + 'x'.repeat(4) + randomUUID().replace(/-/g, '');
  const email = `hank.${randomUUID().slice(0, 6)}@example.org`;
  const chatWords = ['purple', 'walrus', 'tangerine', 'umbrella', String(Date.now() % 10_000)];
  const chatText = `remember that ${chatWords.join(' ')} on friday`;
  const medical = 'my insulin dosage is 12 mg after the clinic visit';
  const memoryText = `Hank keeps his ${['spare', 'key', 'under', 'the', 'blue', 'pot'].join(' ')}`;
  const conv = a.app.store.createConversation({ title: 'Chat' });
  a.app.store.addMessage(conv.id, 'user', chatText);
  a.app.store.addMessage(conv.id, 'assistant', `Got it: ${chatWords.join(' ')}.`);
  a.app.store.addMessage(conv.id, 'notice', `turnerror:provider said ${keyShaped} was refused for ${email}`, { error: `provider said ${keyShaped} refused for ${email}`, errorClass: 'ProviderError' });
  a.app.store.addMessage(conv.id, 'tool', `could not read ${chatWords.join(' ')}`, { name: 'read_file', status: 'error' });
  try {
    a.app.memory?.add?.({ text: memoryText } as never);
  } catch {
    /* the memory store's API differs per build: the report never reads it anyway */
  }
  const log = new Log(a.dir, (s) => a.app.redactor.redact(s), () => clock.now);
  a.app.log = log;
  log.write('info', 'server started on port 7860');
  log.write('warn', `mail sync failed for ${email} with key ${keyShaped}`);
  log.write('warn', `vault check ${vaultSecret}`);
  log.write('error', `turn failed while answering "${chatText}"`);
  log.write('info', `user said ${chatWords.join(' ')} today`);
  log.write('warn', medical);
  log.write('info', `Authorization: Bearer ${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`);
  // A private message between the owners (S9a) must never appear either.
  const pm = `secret plan ${randomUUID().slice(0, 8)} for the party`;
  await b.req('POST', `/api/messages/chats/${bLink}/send`, { text: pm });
  await b.m.flush();
  log.write('info', `pm arrived: ${pm}`);

  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  const look = await b.req('POST', '/api/support/look', { link: bLink });
  const out = JSON.stringify(look);
  for (const bad of [vaultSecret, keyShaped, email, chatText, chatWords.slice(0, 4).join(' '), 'insulin', 'dosage', memoryText, 'spare key', pm, 'secret plan', a.dir, a.dir.replace(/\\/g, '/')]) assert.ok(!out.includes(bad), `leaked: ${bad}`);
  // What it does have: versions, health, self-test lines, errors (shapes), the log (redacted), settings with keys hidden.
  const r = look.report;
  for (const k of ['version', 'health', 'selfTest', 'errors', 'log', 'settings', 'models', 'apps']) assert.ok(k in r, `has ${k}`);
  for (const k of ['chats', 'conversations', 'memories', 'memory', 'files', 'mail', 'messages', 'medical']) assert.ok(!(k in r), `never ${k}`);
  assert.ok(r.log.some((l: string) => /server started/.test(l)), 'plain lines stay');
  assert.ok(r.errors.turns.length >= 1 && r.errors.tools.some((x: any) => x.tool === 'read_file'));
  assert.equal(r.settings.values.defaultModel, 'small-1');
  assert.deepEqual(r.settings.providers.map((p: any) => ({ id: p.id, key: typeof p.key })), [{ id: 'fake', key: 'boolean' }]);
  assert.ok(!JSON.stringify(r.settings).includes('baseUrl'), 'provider addresses are not sent');
  // The helper's own findings line up with the report.
  assert.ok(Array.isArray(supportFindings(r)));
});

test('S9b: proposals are limited to the allowlist, shown with the exact diff, and change nothing without the helped owner', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  // No pass: refused.
  assert.equal((await b.raw('POST', '/api/support/propose', { link: bLink, changes: [{ path: 'defaultModel', value: 'big-2' }] })).status, 403);
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  // Outside the allowlist: refused on both sides (helper route and helped peer endpoint).
  for (const path of ['adultMode', 'providers', 'toolPermissions', 'shellNetwork', 'computerUse', 'privateLocal', '__proto__', 'persona.innerLife.x']) {
    assert.equal((await b.raw('POST', '/api/support/propose', { link: bLink, changes: [{ path, value: true }] })).status, 400, path);
  }
  const key = b.m.privateKeyFor(bLink)!;
  const evil = JSON.stringify({ v: 1, id: randomUUID(), changes: [{ path: 'adultMode', value: { on: true } }] });
  assert.equal((await fetch(`${a.base}/msg/v1/support/propose`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(bLink, 'propose', evil, key, clock.now) }, body: evil })).status, 400);
  // An unknown provider id or a timeout out of range: refused.
  assert.equal((await b.raw('POST', '/api/support/propose', { link: bLink, changes: [{ path: 'defaultProviderId', value: 'nope' }] })).status, 400);
  assert.equal((await b.raw('POST', '/api/support/propose', { link: bLink, changes: [{ path: 'fallbackAfterSec', value: 2 }] })).status, 400);

  // A real proposal: it waits for the helped owner with the exact diff.
  const p = await b.req('POST', '/api/support/propose', { link: bLink, changes: [{ path: 'defaultModel', value: 'big-2' }, { path: 'fallbackAfterSec', value: 30 }], note: 'small-1 keeps timing out' });
  assert.ok(p.proposal.id);
  assert.equal(a.app.settings.get().defaultModel, 'small-1', 'nothing changed yet');
  const pending = (await a.req('GET', '/api/support')).proposals.filter((x: any) => x.status === 'pending');
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].diff, [{ path: 'defaultModel', before: 'small-1', after: 'big-2' }, { path: 'fallbackAfterSec', before: 60, after: 30 }]);
  assert.equal(pending[0].note, 'small-1 keeps timing out');
  // Approve: applied, the helper is told, both logs have it.
  await a.req('POST', `/api/support/proposals/${pending[0].id}`, { approve: true });
  assert.equal(a.app.settings.get().defaultModel, 'big-2');
  assert.equal(a.app.settings.get().fallbackAfterSec, 30);
  const bv = await b.req('GET', '/api/support');
  assert.equal(bv.proposals.find((x: any) => x.id === p.proposal.id).status, 'approved');
  assert.ok(bv.log.some((r: any) => r.kind === 'approved'));
  // A second decision on the same card: refused.
  assert.equal((await a.raw('POST', `/api/support/proposals/${pending[0].id}`, { approve: false })).status, 409);

  // Deny: nothing changes. A plain instruction (no change) can only be read and dismissed.
  const p2 = await b.req('POST', '/api/support/propose', { link: bLink, changes: [{ path: 'memoryTidy.on', value: true }] });
  const p3 = await b.req('POST', '/api/support/propose', { link: bLink, note: 'Open Settings → Models and press Test on Fake.' });
  const list = (await a.req('GET', '/api/support')).proposals;
  const card2 = list.find((x: any) => x.peerId === p2.proposal.id);
  assert.deepEqual(card2.diff, [{ path: 'memoryTidy.on', before: null, after: true }]);
  await a.req('POST', `/api/support/proposals/${card2.id}`, { approve: false });
  assert.notEqual(a.app.settings.get().memoryTidy?.on, true);
  const card3 = list.find((x: any) => x.peerId === p3.proposal.id);
  assert.deepEqual(card3.diff, []);
  await a.req('POST', `/api/support/proposals/${card3.id}`, { approve: true });
  assert.equal((await b.req('GET', '/api/support')).proposals.find((x: any) => x.id === p2.proposal.id).status, 'denied');
  // A proposal after the pass is revoked: refused.
  const given = (await a.req('GET', '/api/support')).given[0];
  await a.req('DELETE', `/api/support/passes/${given.id}`);
  assert.equal((await b.raw('POST', '/api/support/propose', { link: bLink, note: 'x' })).status, 403);
});

test('S9b: support_look asks once per pass and summarizes; support_propose always asks; owner only', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink } = await link(a, b);
  const [look, propose] = createSupportTools(() => b.app);
  assert.equal(look!.spec.name, 'support_look');
  assert.equal(propose!.spec.name, 'support_propose');
  assert.equal(look!.isAvailable!(), false, 'no pass held: hidden');
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  assert.equal(look!.isAvailable!(), true);
  assert.equal(look!.defaultPermission, 'ask');
  const signal = new AbortController().signal;
  const p1 = await look!.prepare!({ name: 'Hank' }, { signal });
  assert.notEqual(p1.auto, true, 'first look on a pass asks');
  const text = await look!.run({ name: 'Hank' }, { signal } as never);
  assert.match(text, /Hank/);
  assert.match(text, /Findings|findings/);
  const p2 = await look!.prepare!({ name: 'Hank' }, { signal });
  assert.equal(p2.auto, true, 'later looks on the same pass do not ask again');
  assert.equal(propose!.defaultPermission, 'ask');
  const pp = await propose!.prepare!({ name: 'Hank', changes: [{ path: 'defaultModel', value: 'big-2' }] }, { signal });
  assert.notEqual(pp.auto, true);
  assert.match(String(pp.summary), /defaultModel/);
  // A new pass asks again.
  const given = (await a.req('GET', '/api/support')).given[0];
  await a.req('DELETE', `/api/support/passes/${given.id}`);
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  assert.notEqual((await look!.prepare!({ name: 'Hank' }, { signal })).auto, true);
  // Supportive tools never exist without the owner's Messenger.
  const mem = await node(t, 'Mo', { member: true });
  assert.equal(createSupportTools(() => mem.app)[0]!.isAvailable!(), false);
  assert.equal(supportOf(mem.app), undefined);
});

test('S9b: household members and kid mode are refused; the peer endpoint does not exist for them', async (t) => {
  for (const child of [false, true]) {
    const mem = await node(t, 'Mo', { member: true, child });
    for (const [method, path] of [['GET', '/api/support'], ['POST', '/api/support/passes'], ['POST', '/api/support/look'], ['POST', '/api/support/propose']] as const) {
      const r = await mem.raw(method, path, method === 'GET' ? undefined : { link: 'x', hours: 1 });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    const peer = await fetch(`${mem.base}/msg/v1/support/look`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(peer.status, 404);
  }
});

test.before(() => {
  const d = tempDir();
  setAuditTrail(new AuditTrail(d.dir, { key: () => 'k', policyRev: () => 0 }));
});
