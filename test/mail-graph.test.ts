// M1: Outlook.com / Microsoft 365 through Microsoft Graph, against a local stand-in for Microsoft's
// sign-in and Graph (test/mail-graph-fake.ts). No network. Sign-in (PKCE S256, one-time state,
// refresh rotation, a revoked sign-in), the mail_* tools (search, read, thread, needs-answer, draft,
// send), organizing with the Gmail rules (count first, approvals, trash/spam always ask, never a
// permanent delete, immutable ids, undo) and the calendar with the same approvals.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GoogleAccount } from '../src/google.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth, msBases, msTokenVault, SignedOut } from '../src/mail/graph.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { createGoogleTools } from '../src/tools/google.ts';
import { createMailTools, routeCalendarTools } from '../src/tools/mail.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { Vault } from '../src/vault.ts';
import { vaultSecretValues } from '../src/redact.ts';
import { tempDir } from './helpers.ts';
import { FakeGraph } from './mail-graph-fake.ts';

const fake = await new FakeGraph().start();
const tmp = tempDir();
after(async () => {
  await fake.stop();
  tmp.cleanup();
});

const clock = { now: Date.parse('2026-11-09T18:00:00Z') };
const vault = new Vault(tmp.dir);
const msOpts = { graphBase: `${fake.base}/v1.0`, loginBase: `${fake.base}/login`, now: () => clock.now, sleep: async () => {} };
const ms = new MicrosoftAuth(vault, msOpts);
const google = new GoogleAccount(vault);
const accounts = new MailAccounts(vault, google, ms, { ms: msOpts });
const db = new DatabaseSync(':memory:');
const organizer = new MailOrganizer(db, { timeZone: () => 'America/Chicago', now: () => new Date(clock.now) });
const tools = new Map<string, Tool>();
const googleTools = createGoogleTools(google, () => 'America/Chicago');
for (const t of createMailTools({ accounts, organizer, google: new Map(googleTools.map((t) => [t.spec.name, t])), timeZone: () => 'America/Chicago' })) tools.set(t.spec.name, t);
for (const t of routeCalendarTools(googleTools.filter((t) => t.spec.name.startsWith('calendar_')), accounts, () => 'America/Chicago')) tools.set(t.spec.name, t);
const ctx = (conversationId = 'c1'): ToolContext => ({ workspaceDir: tmp.dir, signal: AbortSignal.timeout(20_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId });
const tool = (n: string) => tools.get(n)!;
const REDIRECT = 'http://localhost:3000/api/mail/microsoft/callback';

test('test-only bases are loopback only', () => {
  assert.deepEqual(msBases({ SARA_MS_GRAPH_BASE: 'https://evil.example/v1.0' }), {});
  assert.equal(msBases({ SARA_MS_GRAPH_BASE: 'http://127.0.0.1:9999/v1.0' }).graph, 'http://127.0.0.1:9999/v1.0');
});

test('sign-in: the owner\'s own app, PKCE S256, a one-time state, then the account', async () => {
  assert.throws(() => ms.setClient('not-a-guid', 'x'), /Application \(client\) ID/);
  assert.throws(() => ms.authUrl(REDIRECT), /Add your Microsoft app/);
  ms.setClient(fake.clientId, fake.clientSecret);
  const url = ms.authUrl(REDIRECT);
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('client_id'), fake.clientId);
  assert.match(u.searchParams.get('scope')!, /offline_access.*Mail\.ReadWrite.*Mail\.Send.*Calendars\.ReadWrite/);
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  const { code, state } = fake.authorize(url);
  await assert.rejects(ms.finish(code, 'forged-state'), /expired/);
  const t = await ms.finish(code, state);
  assert.equal(t.address, 'ana@outlook.com');
  await assert.rejects(ms.finish(code, state), /expired/, 'a state works once');
  const info = accounts.addMicrosoft(t);
  assert.equal(info.kind, 'microsoft');
  assert.equal(accounts.default()?.id, info.id);
  // The account list has no secrets in it.
  assert.doesNotMatch(JSON.stringify(accounts.list()), /rt-|at-|secret/);
  assert.doesNotMatch(vault.get('mail:accounts') ?? '', /rt-|at-/);
  // The token entry holds only secrets: its strings are hidden everywhere, and the mailbox address
  // must stay readable on approval cards and in replies.
  assert.ok(!vaultSecretValues(vault.values()).includes('ana@outlook.com'), 'the address is not a vault secret');
  assert.deepEqual(Object.keys(JSON.parse(vault.get(msTokenVault(info.id))!)).sort(), ['access', 'expiresAt', 'refresh']);
});

test('a state older than 10 minutes is refused', async () => {
  const url = ms.authUrl(REDIRECT);
  const { code, state } = fake.authorize(url);
  clock.now += 11 * 60_000;
  await assert.rejects(ms.finish(code, state), /expired/);
});

test('search, read, thread and folders through the mail_ tools', async () => {
  fake.add({ from: 'bob@work.com', subject: 'Quarterly report', bodyPreview: 'Can you check the numbers?', body: 'Can you check the numbers?\n\nBob' });
  fake.add({ from: 'news@shop.com', subject: 'Big sale', internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<https://shop.com/unsub>' }], inferenceClassification: 'other' });
  fake.add({ from: 'news@shop.com', subject: 'Another sale', isRead: true, inferenceClassification: 'other' });
  const s = await tool('mail_search').run({ query: 'from:bob' }, ctx());
  assert.match(s, /Quarterly report/);
  assert.doesNotMatch(s, /Big sale/);
  assert.match(s, /information only/);
  const id = /\[(AAMk[^\]]+)\]/.exec(s)![1];
  const r = await tool('mail_read').run({ id }, ctx());
  assert.match(r, /Can you check the numbers\?/);
  assert.ok(fake.log.some((l) => l.includes('/messages/')), 'it read the message');
  const th = await tool('mail_thread').run({ id }, ctx());
  assert.match(th, /1\/1/);
  const f = await tool('mail_folders').run({}, ctx());
  assert.match(f, /Junk Email \(junk\)/);
  assert.match(f, /Categories: Blue category/);
  // Gmail-only words: a plain refusal.
  await assert.rejects(tool('mail_search').run({ query: 'category:promotions' }, ctx()), /Gmail tab/);
});

test('needs an answer: people, not newsletters; Focused Inbox respected', async () => {
  const out = await tool('mail_needs_answer').run({}, ctx());
  assert.match(out, /Quarterly report/);
  assert.match(out, /asks a question/);
  assert.doesNotMatch(out, /sale/);
});

test('draft and send ask first; replies stay in the thread', async () => {
  assert.equal(tool('mail_draft').defaultPermission, 'ask');
  assert.equal(tool('mail_send').defaultPermission, 'ask');
  const bob = fake.msgs.find((m) => m.subject === 'Quarterly report')!;
  const d = await tool('mail_draft').run({ to: 'bob@work.com', subject: 'Re: Quarterly report', body: 'Looks right.', reply_to: bob.id }, ctx());
  assert.match(d, /Nothing was sent/);
  assert.ok(fake.writes.some((w) => w.path.endsWith('/createReply')));
  await tool('mail_send').run({ to: 'ana@x.com', subject: 'Hi', body: 'Hello' }, ctx());
  assert.equal(fake.sent.length, 1);
});

test('organize: count first, the card says Outlook, archive keeps immutable ids, undo puts it back', async () => {
  const org = tool('mail_organize');
  assert.equal(org.defaultPermission, 'ask');
  const args = { action: 'archive', query: 'from:news@shop.com' };
  const p = await org.prepare!(args, ctx());
  assert.match(String(p.summary), /^Archive 2 emails in ana@outlook\.com/);
  assert.equal((p.detail as { provider?: string }).provider, 'Outlook');
  assert.equal((p.detail as { count: number }).count, 2);
  const out = await org.run(args, ctx());
  assert.match(out, /Done: 2 of 2 emails archived in Outlook/);
  const news = fake.msgs.filter((m) => m.from.emailAddress.address === 'news@shop.com');
  assert.ok(news.every((m) => m.parentFolderId === 'F-ARCH'));
  assert.ok(news.every((m) => !m.id.endsWith('moved')), 'immutable ids: the id stays the same after a move');
  assert.ok(fake.writes.filter((w) => w.path.endsWith('/move')).every((w) => w.prefer.includes('IdType="ImmutableId"')));
  // Archive again: nothing left in the inbox from them.
  const again = await org.prepare!(args, ctx());
  assert.match(String(again.refuse), /No emails match/);
  const undoId = /mail_undo with id (m_\w+)/.exec(out)![1];
  const u = tool('mail_undo');
  assert.equal(u.defaultPermission, 'ask');
  const up = await u.prepare!({ id: undoId }, ctx());
  assert.match(String(up.summary), /Undo "Archive" on 2 emails/);
  await u.run({ id: undoId }, ctx());
  assert.ok(news.every((m) => m.parentFolderId === 'F-INBOX'));
  await assert.rejects(u.run({ id: undoId }, ctx()), /already undone/);
});

test('trash and spam always ask, go to Deleted Items and Junk Email, and nothing is ever deleted for good', async () => {
  const org = tool('mail_organize');
  assert.equal(org.asksFirst!({ action: 'trash' }), true);
  assert.equal(org.asksFirst!({ action: 'spam' }), true);
  assert.equal(org.asksFirst!({ action: 'archive' }), false);
  await org.run({ action: 'trash', query: 'subject:"Big sale"' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Big sale')!.parentFolderId, 'F-DEL');
  // Trash is left out of searches unless asked.
  assert.doesNotMatch(await tool('mail_search').run({ query: 'sale' }, ctx()), /Big sale/);
  assert.match(await tool('mail_search').run({ query: 'in:trash' }, ctx()), /Big sale/);
  await org.run({ action: 'untrash', query: 'subject:"Big sale"' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Big sale')!.parentFolderId, 'F-INBOX');
  await org.run({ action: 'spam', query: 'subject:"Another sale"' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Another sale')!.parentFolderId, 'F-JUNK');
  assert.equal(fake.writes.filter((w) => w.method === 'DELETE' && w.path.includes('/messages')).length, 0);
  await assert.rejects(org.run({ action: 'delete', query: 'from:x' }, ctx()), /no permanent delete/);
});

test('star is a flag, label is a category (made on request), read counts only unread', async () => {
  const org = tool('mail_organize');
  await org.run({ action: 'star', query: 'from:bob' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Quarterly report')!.flag.flagStatus, 'flagged');
  const refuse = await org.prepare!({ action: 'label', query: 'from:bob', label: 'Work' }, ctx());
  assert.ok(refuse.summary, 'counting never makes the category');
  await assert.rejects(org.run({ action: 'label', query: 'from:bob', label: 'Work' }, ctx()), /no category called "Work"/);
  await org.run({ action: 'label', query: 'from:bob', label: 'Work', createLabel: true }, ctx());
  assert.deepEqual(fake.msgs.find((m) => m.subject === 'Quarterly report')!.categories, ['Work']);
  assert.ok(fake.categories.includes('Work'));
  const pr = await org.prepare!({ action: 'read', query: 'from:bob' }, ctx());
  assert.match(String(pr.summary), /Mark as read 1 emails/);
  const out = await org.run({ action: 'read', query: 'from:bob' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Quarterly report')!.isRead, true);
  await tool('mail_undo').run({ id: /id (m_\w+)/.exec(out)![1] }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Quarterly report')!.isRead, false);
  // move to a folder by name
  await org.run({ action: 'move', query: 'from:bob', folder: 'Receipts' }, ctx());
  assert.equal(fake.msgs.find((m) => m.subject === 'Quarterly report')!.parentFolderId, 'F-RCPT');
});

test('Graph throttling (429 Retry-After) is waited out', async () => {
  fake.throttle = 2;
  const s = await tool('mail_search').run({ query: 'in:"Receipts"' }, ctx());
  assert.match(s, /Quarterly report/);
});

test('calendar: Outlook through Graph with the same approvals', async () => {
  for (const n of ['calendar_add', 'calendar_remove', 'calendar_update']) assert.equal(tool(n).defaultPermission, 'ask', n);
  assert.equal(tool('calendar_events').defaultPermission, 'auto');
  const add = await tool('calendar_add').run({ title: 'Dentist', start: '2026-11-10T15:00', location: 'Main St', account: 'outlook' }, ctx());
  assert.match(add, /Added “Dentist”/);
  const ev = fake.events[0];
  assert.equal(ev.start.timeZone, 'America/Chicago');
  assert.equal(ev.end.dateTime, '2026-11-10T16:00:00');
  // The fake stores the wall time; the view is asked in UTC.
  ev.start.dateTime = '2026-11-10T21:00:00';
  ev.end.dateTime = '2026-11-10T22:00:00';
  const list = await tool('calendar_events').run({ from: '2026-11-10', to: '2026-11-11' }, ctx());
  assert.match(list, /Dentist · Main St/);
  await tool('calendar_update').run({ id: ev.id, title: 'Dentist (moved)' }, ctx());
  assert.equal(fake.events[0].subject, 'Dentist (moved)');
  await tool('calendar_remove').run({ id: ev.id }, ctx());
  assert.equal(fake.events.length, 0);
});

test('refresh: an expired access token is renewed and the rotated refresh token saved', async () => {
  const id = accounts.default()!.id;
  const before = JSON.parse(vault.get(msTokenVault(id))!) as { refresh: string };
  clock.now += 2 * 3600_000;
  await tool('mail_search').run({ query: 'from:bob' }, ctx());
  const now = JSON.parse(vault.get(msTokenVault(id))!) as { refresh: string };
  assert.notEqual(now.refresh, before.refresh);
  assert.equal(fake.refreshTokens.has(before.refresh), false);
});

test('a revoked sign-in signs the account out (no retry loop) and says so', async () => {
  const id = accounts.default()!.id;
  fake.revoked = true;
  clock.now += 2 * 3600_000;
  await assert.rejects(tool('mail_search').run({ query: 'from:bob' }, ctx()), (err: Error) => err instanceof SignedOut && /Sign in again/.test(err.message) && !/Trace ID|Correlation/.test(err.message));
  assert.equal(vault.get(msTokenVault(id)), undefined);
  assert.match(accounts.list().find((a) => a.id === id)!.problem ?? '', /Signed out/);
  await assert.rejects(tool('mail_search').run({ query: 'from:bob' }, ctx()), /Signed out/);
  await accounts.remove(id);
  assert.equal(accounts.list().length, 0);
});
