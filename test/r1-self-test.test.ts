// R1 (c): Check everything (Settings → Data & health → Health). Against the fake Graph (mail + calendar)
// and stand-ins for push, the desktop app, the inbox helper, automations and Auto. Writes only with consent,
// and each write is removed again; every line is ok / needs attention / not run, with a fix and a page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { formatSelfTest, runSelfTest, SELF_TEST_SUBJECT, type SelfTestDeps } from '../src/self-test.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { FakeGraph } from './mail-graph-fake.ts';

const fake = await new FakeGraph().start();
const tmp = tempDir();
after(async () => {
  await fake.stop();
  tmp.cleanup();
});
const vault = new Vault(tmp.dir);
const msOpts = { graphBase: `${fake.base}/v1.0`, loginBase: `${fake.base}/login`, sleep: async () => {} };
const ms = new MicrosoftAuth(vault, msOpts);
const accounts = new MailAccounts(vault, undefined, ms, { ms: msOpts });
ms.setClient(fake.clientId, fake.clientSecret);
const { code, state } = fake.authorize(ms.authUrl('http://localhost:3000/api/mail/microsoft/callback'));
accounts.addMicrosoft(await ms.finish(code, state));
fake.add({ from: 'bob@work.com', subject: 'Hello' });

const now = new Date('2026-11-15T15:00:00Z');
const pushed: unknown[] = [];
const requests: string[] = [];
const base = (): SelfTestDeps => ({
  now: () => now,
  timeZone: 'America/Chicago',
  mail: accounts,
  push: { list: () => [{ endpoint: 'https://push.example/1', label: 'Pixel' }, { endpoint: 'https://push.example/2', label: 'iPhone' }], sendAll: async (p) => (pushed.push(p), { sent: 2, failed: 0, removed: 0 }) },
  hands: {
    devices: () => [
      { id: 'w1', label: 'Desk', computer: 'Desk PC', connected: true, busy: false, frames: 0, os: 'windows', optIn: { browser: true, desktop: true }, ops: ['d.windows'] },
      { id: 'm1', label: 'Mac', computer: 'Alex Mac', connected: true, busy: false, frames: 0, os: 'macos 15', optIn: { browser: true, desktop: false, tabs: false }, ops: [] },
    ],
    request: async (id, op) => (requests.push(`${id}:${op}`), { ok: true, result: { windows: [{ t: 'a' }, { t: 'b' }, { t: 'c' }] } } as never),
  },
  apps: () => [{ id: 'a1', platform: 'windows', version: '3.9.0', computer: 'Desk PC', label: '', how: 'server', auto: true, seenAt: now.toISOString(), behind: true, canAsk: true, asked: false } as never],
  serverVersion: '3.10.0',
  inbox: () => ({ lastScan: { at: new Date(now.getTime() - 3 * 3_600_000).toISOString(), problems: [] } }),
  lastAutomation: () => ({ name: 'Morning summary', at: new Date(now.getTime() - 60 * 60_000).toISOString(), outcome: 'failed' }),
  auto: () => ({ model: 'gemma4:31b-cloud', provider: 'Ollama', auto: true, firstMs: 2400 }),
});

test('without consent nothing is written: reads only, the write checks say how to run them', async () => {
  const writes = fake.writes.length;
  const lines = await runSelfTest(base());
  assert.equal(fake.writes.length, writes, 'no draft, no event');
  assert.equal(pushed.length, 0, 'no notification');
  const by = (id: string) => lines.find((l) => l.id === id)!;
  const acc = accounts.list()[0]!.id;
  assert.equal(by(`mail:${acc}`).status, 'ok');
  assert.match(by(`mail:${acc}`).text, /reads mail/);
  assert.equal(by(`draft:${acc}`).status, 'skipped');
  assert.equal(by(`cal:${acc}`).status, 'ok');
  assert.equal(by(`event:${acc}`).status, 'skipped');
  assert.equal(by('push').status, 'skipped');
  // The desktop app: listed windows (a read), never an action; the Mac tabs switch; the old app version.
  assert.deepEqual(requests, ['w1:d.windows']);
  assert.equal(by('pc:w1').params?.n, 3);
  assert.equal(by('tabs:m1').status, 'attention');
  assert.equal(by('tabs:m1').page, 'co-computer');
  assert.equal(by('app:a1').status, 'attention');
  assert.equal(by('app:a1').page, 'dh-devices');
  assert.equal(by('inbox').status, 'ok');
  assert.equal(by('automations').status, 'attention');
  assert.equal(by('auto').status, 'ok');
  assert.equal(by('auto').params?.s, 2);
  for (const l of lines) if (l.status === 'attention') assert.ok(l.fix && l.page, `${l.id} has a fix and a page`);
});

test('with consent: a draft made and removed, a test event added and removed, a notification sent', async () => {
  const before = fake.msgs.length;
  const evBefore = fake.events.length;
  const lines = await runSelfTest(base(), { draft: true, event: true, push: true });
  const acc = accounts.list()[0]!.id;
  const by = (id: string) => lines.find((l) => l.id === id)!;
  assert.equal(by(`draft:${acc}`).status, 'ok', by(`draft:${acc}`).text);
  assert.match(by(`draft:${acc}`).text, /made a draft and removed it again/);
  assert.equal(fake.msgs.length, before, 'the test draft is gone');
  assert.ok(fake.writes.some((w) => w.method === 'POST' && w.path === '/me/messages' && (w.body as { subject?: string }).subject === SELF_TEST_SUBJECT));
  assert.equal(by(`event:${acc}`).status, 'ok', by(`event:${acc}`).text);
  assert.equal(fake.events.length, evBefore, 'the test event is gone');
  assert.equal(by('push').status, 'ok');
  assert.equal(pushed.length, 1);
});

test('the draft remover never deletes a real message', async () => {
  const p = accounts.provider(accounts.list()[0]!.id);
  const real = fake.msgs.find((m) => !m.isDraft)!;
  await assert.rejects(p.discardDraft!(real.id), /not a draft/);
  assert.ok(fake.msgs.includes(real));
});

test('nothing connected: each line needs attention and links where to fix it; the report is plain', async () => {
  const lines = await runSelfTest({ now: () => now, timeZone: 'UTC' });
  assert.deepEqual(lines.map((l) => l.id), ['mail', 'push', 'desktop', 'auto']);
  assert.ok(lines.every((l) => l.status === 'attention' && l.fix && l.page));
  const r = formatSelfTest(lines, '3.10.0');
  assert.match(r, /^Sara check everything \(Sara 3\.10\.0\)/);
  assert.match(r, /- \[NEEDS ATTENTION\] Mail: No mailbox is connected\. Fix: Connect Gmail/);
});

test('a mailbox that fails says so with the reason, and the rest still runs', async () => {
  const d = base();
  d.mail = { list: () => [{ id: 'x', kind: 'imap', provider: 'imap', address: 'me@home.example', addedAt: '' } as never], provider: () => ({ searchIds: async () => { throw new Error('LOGIN failed'); } }) as never };
  const lines = await runSelfTest(d);
  const m = lines.find((l) => l.id === 'mail:x')!;
  assert.equal(m.status, 'attention');
  assert.equal(m.params?.why, 'LOGIN failed');
  assert.ok(lines.some((l) => l.id === 'auto'));
});

test('route: owner only, 404 for the demo; the page has the button, consent boxes and copy', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/self-test`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { lines: { id: string }[]; report: string };
  assert.ok(j.lines.some((l) => l.id === 'mail'));
  assert.match(j.report, /Sara check everything/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['selftest-run', 'selftest-draft', 'selftest-event', 'selftest-push', 'selftest-list', 'selftest-copy', 'selftest-report']) assert.ok(html.includes(`id="${id}"`), id);
});
