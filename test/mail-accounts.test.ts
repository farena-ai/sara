// M1: several mailboxes at once (Gmail + Outlook + IMAP): the default, `account` routing, Gmail
// handed to the gmail_* tools unchanged, approvals on every change, Today's Mail card and the
// morning briefing with an Outlook default; a household member's own list (the owner's Microsoft app,
// her own vault, the admin's off switch). End to end on the real server: mail-members.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GOOGLE_CLIENT_VAULT, GOOGLE_TOKEN_VAULT, GoogleAccount } from '../src/google.ts';
import { MailAccounts, mailAccountsForState, MEMBER_MAIL_OFF } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { createMailTools, routeCalendarTools } from '../src/tools/mail.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { buildToday, clearTodayCache, mailToday } from '../src/today.ts';
import { cardFor } from '../src/cards.ts';
import { gatherFacts } from '../src/briefing.ts';
import { makeApp, tempDir } from './helpers.ts';
import { FakeGraph } from './mail-graph-fake.ts';

const fake = await new FakeGraph().start();
const tmp = tempDir();
after(async () => {
  await fake.stop();
  tmp.cleanup();
});
const clock = { now: new Date('2026-11-09T18:00:00Z') };
const app = makeApp(tmp.dir, clock);
const vault = app.vault;
// Gmail signed in (as the Google page leaves it).
vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'GOCSPX-123456' }));
vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3600_000, email: 'me@gmail.com', scopes: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' }));
const google = new GoogleAccount(vault);
const msOpts = { graphBase: `${fake.base}/v1.0`, loginBase: `${fake.base}/login` };
const ms = new MicrosoftAuth(vault, msOpts);
const accounts = new MailAccounts(vault, google, ms, { ms: msOpts });
const organizer = new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => 'UTC' });

// Stand-ins for the Gmail tools: they record what reaches them.
const gmailCalls: { name: string; args: Record<string, unknown> }[] = [];
const stub = (name: string, permission: 'auto' | 'ask' = 'auto'): Tool => ({
  defaultPermission: permission,
  spec: { name, description: name, parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  isAvailable: () => true,
  summarize: () => name,
  async prepare(args) {
    gmailCalls.push({ name: `${name}:prepare`, args });
    return { summary: `GMAIL ${name}` };
  },
  async run(args) {
    gmailCalls.push({ name, args });
    return `GMAIL ${name} ${JSON.stringify(args)}`;
  },
});
const googleTools = ['gmail_search', 'gmail_read', 'gmail_thread', 'gmail_needs_answer', 'gmail_draft', 'gmail_send', 'gmail_organize', 'gmail_undo', 'gmail_labels', 'gmail_senders', 'gmail_unsubscribe_info', 'calendar_events', 'calendar_add', 'calendar_remove'].map((n) => stub(n, /draft|send|organize|undo|add|remove/.test(n) ? 'ask' : 'auto'));
const tools = new Map<string, Tool>();
for (const t of createMailTools({ accounts, organizer, google: new Map(googleTools.map((t) => [t.spec.name, t])), timeZone: () => 'UTC' })) tools.set(t.spec.name, t);
for (const t of routeCalendarTools(googleTools.filter((t) => t.spec.name.startsWith('calendar_')), accounts, () => 'UTC')) tools.set(t.spec.name, t);
const ctx = (): ToolContext => ({ workspaceDir: tmp.dir, signal: AbortSignal.timeout(20_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId: 'c9' });
const tool = (n: string) => tools.get(n)!;

test('with only Gmail, the mail_ tools stay hidden (the gmail_ tools are the way in, unchanged)', () => {
  assert.deepEqual(accounts.list().map((a) => a.id), ['google']);
  assert.equal(tool('mail_search').isAvailable!(), false);
});

test('Gmail + Outlook: the default, routing by account, Gmail handed over as it was', async () => {
  ms.setClient(fake.clientId, fake.clientSecret);
  const { code, state } = fake.authorize(ms.authUrl('http://localhost/api/mail/microsoft/callback'));
  const out = accounts.addMicrosoft(await ms.finish(code, state));
  fake.add({ from: 'boss@work.com', subject: 'Contract', importance: 'high' });
  fake.add({ from: 'promo@shop.com', subject: 'Deals', inferenceClassification: 'other', isRead: true });
  assert.equal(tool('mail_search').isAvailable!(), true);
  assert.equal(accounts.default()!.id, 'google', 'the first stays the default until the owner picks');
  const acc = await tool('mail_accounts').run({}, ctx());
  assert.match(acc, /me@gmail\.com \(Gmail\) · default/);
  assert.match(acc, /ana@outlook\.com \(Outlook \/ Microsoft 365\)/);
  // No account: the default (Gmail) through gmail_search, with the same words.
  assert.match(await tool('mail_search').run({ query: 'from:boss' }, ctx()), /^GMAIL gmail_search \{"query":"from:boss","max":10\}/);
  // account: outlook → Graph.
  assert.match(await tool('mail_search').run({ query: 'from:boss', account: 'outlook' }, ctx()), /Contract/);
  assert.match(await tool('mail_search').run({ query: 'from:boss', account: 'ana@outlook.com' }, ctx()), /Contract/);
  await assert.rejects(tool('mail_search').run({ query: 'x', account: 'nobody@nowhere' }, ctx()), /no mailbox "nobody@nowhere"/);
  // Organizing Gmail: the gmail_organize prepare + run get the same arguments (no account).
  const p = await tool('mail_organize').prepare!({ action: 'archive', query: 'from:a', account: 'gmail' }, ctx());
  assert.equal(p.summary, 'GMAIL gmail_organize');
  assert.deepEqual(gmailCalls.at(-1)!.args, { action: 'archive', query: 'from:a' });
  await assert.rejects(tool('mail_organize').run({ action: 'move', query: 'from:a', folder: 'X', account: 'gmail' }, ctx()), /labels instead of folders/);
  // The owner picks Outlook as the default.
  accounts.setDefault(out.id);
  assert.match(await tool('mail_search').run({ query: 'from:boss' }, ctx()), /Contract/);
  const all = await tool('mail_needs_answer').run({ account: 'all' }, ctx());
  assert.match(all, /me@gmail\.com \(Gmail\):\nGMAIL gmail_needs_answer/);
  assert.match(all, /ana@outlook\.com \(Outlook\): 1 conversation/);
});

test('every change asks first, whichever mailbox', () => {
  for (const n of ['mail_draft', 'mail_send', 'mail_organize', 'mail_undo', 'calendar_add', 'calendar_remove', 'calendar_update']) assert.equal(tool(n).defaultPermission, 'ask', n);
  for (const n of ['mail_accounts', 'mail_search', 'mail_read', 'mail_thread', 'mail_needs_answer', 'mail_folders', 'mail_senders', 'mail_unsubscribe_info', 'calendar_events']) assert.equal(tool(n).defaultPermission, 'auto', n);
  assert.equal(tool('mail_organize').asksFirst!({ action: 'spam', account: 'gmail' }), true);
});

test('calendar: with an Outlook default, no account means Outlook; "google" still reaches Google', async () => {
  await tool('calendar_add').run({ title: 'Lunch', start: '2026-11-11T12:00' }, ctx());
  assert.equal(fake.events.at(-1)!.subject, 'Lunch');
  assert.match(await tool('calendar_events').run({ account: 'google' }, ctx()), /^GMAIL calendar_events \{\}/);
  await assert.rejects(tool('calendar_update').run({ id: 'x', title: 'y', account: 'google' }, ctx()), /remove it and add it again/);
});

test('the result card of an Outlook change: Undo by m_ id, no Gmail link', async () => {
  const out = await tool('mail_organize').run({ action: 'star', query: 'from:boss' }, ctx());
  const card = cardFor({ name: 'mail_organize', args: {}, status: 'ok', output: out }) as { kind: string; id: string; link?: string; provider?: string };
  assert.equal(card.kind, 'gmail');
  assert.match(card.id, /^m_/);
  assert.equal(card.link, undefined);
  assert.equal(card.provider, 'Outlook');
  // A Gmail result still links to Gmail.
  const g = cardFor({ name: 'gmail_organize', args: {}, status: 'ok', output: '[gmail-result {"id":"g_abcd","action":"archive","done":1,"failed":0,"total":1,"query":"from:a"}]' }) as { link?: string };
  assert.match(g.link!, /^https:\/\/mail\.google\.com\//);
});

test("Today's Mail card and the briefing use the Outlook default", async () => {
  app.mailAccounts = accounts;
  app.google = google;
  const m = await mailToday(app);
  assert.equal(m!.provider, 'Outlook');
  assert.equal(m!.account, 'ana@outlook.com');
  assert.equal(m!.total, 2);
  assert.equal(m!.unread, 1);
  assert.deepEqual(m!.important.map((x) => x.subject), ['Contract']);
  assert.match(m!.webUrl!, /^https:\/\/outlook\.live\.com\//);
  clearTodayCache(app);
  const d = await buildToday(app, { parts: ['mail'] });
  assert.equal(d.mail?.provider, 'Outlook');
  assert.deepEqual(d.mail?.organised, [], "Gmail's organized-today list is not shown for another mailbox");
  // 3.1: a member's companion only ever holds her OWN mailboxes (main.ts attaches the space's own
  // list), so her Today shows them; without a list of her own there is no mail at all, and the
  // owner's Gmail never reaches her (members have no Google account attached).
  app.member = { id: 7, name: 'Ana' } as never;
  clearTodayCache(app);
  assert.equal((await buildToday(app, { parts: ['mail'] })).mail?.account, 'ana@outlook.com');
  const own = app.mailAccounts;
  const g = app.google;
  delete (app as { mailAccounts?: unknown }).mailAccounts;
  delete (app as { google?: unknown }).google;
  clearTodayCache(app);
  assert.equal((await buildToday(app, { parts: ['mail'] })).mail, undefined);
  app.mailAccounts = own;
  if (g) app.google = g;
  delete (app as { member?: unknown }).member;
});

test("the morning briefing reads the Outlook mailbox and calendar", async () => {
  fake.events.push({ id: 'EVb', subject: 'Standup', start: { dateTime: '2026-11-09T19:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-09T19:15:00', timeZone: 'UTC' }, isAllDay: false });
  const f = await gatherFacts(app, clock.now, async () => new Response('{}'));
  assert.match(f.mail ?? '', /1 unread; important:\n- boss@work\.com: Contract/);
  assert.match(f.calendar ?? '', /Standup/);
});

test("a member's own list: the owner's Microsoft app (read only), her own vault, the admin's switch", async () => {
  const { Vault } = await import('../src/vault.ts');
  const mtmp = tempDir();
  try {
    const mine = new Vault(mtmp.dir);
    let off = false;
    const mms = new MicrosoftAuth(mine, { ...msOpts, clientVault: vault });
    const macc = new MailAccounts(mine, undefined, mms, { ms: msOpts, off: () => off });
    assert.equal(macc.member, true);
    assert.equal(accounts.member, false);
    // The owner's app is used, never changed from her space.
    assert.equal(mms.clientId(), ms.clientId());
    assert.throws(() => mms.setClient('11111111-2222-3333-4444-555555555555', 'secret-value-123456'), /Only the owner/);
    assert.throws(() => mms.forgetClient(), /Only the owner/);
    // The callback finds whose sign-in a state is.
    const url = mms.authUrl('http://127.0.0.1/api/mail/microsoft/callback');
    const state = new URL(url).searchParams.get('state')!;
    assert.equal(mailAccountsForState(state), macc);
    const ownerState = new URL(ms.authUrl('http://127.0.0.1/api/mail/microsoft/callback')).searchParams.get('state')!;
    assert.equal(mailAccountsForState(ownerState), accounts);
    assert.equal(mailAccountsForState('nope'), undefined);
    const { code } = fake.authorize(url);
    const before = fake.address;
    fake.address = 'member@outlook.com';
    const added = macc.addMicrosoft(await mms.finish(code, state));
    fake.address = before;
    assert.equal(mailAccountsForState(state), undefined, 'used once');
    assert.deepEqual(macc.list().map((a) => a.address), ['member@outlook.com']);
    assert.ok(!accounts.list().some((a) => a.address === 'member@outlook.com'), "never in the owner's list");
    assert.equal(vault.get('mail:accounts')?.includes('member@outlook.com') ?? false, false);
    // Pinned off: nothing listed or added; removing still works (her secrets go).
    off = true;
    assert.deepEqual(macc.list(), []);
    assert.equal(macc.hasOthers(), false);
    assert.throws(() => macc.addMicrosoft({ access: 'a', refresh: 'r', expiresAt: 0, scopes: '', address: 'x@outlook.com' }), new RegExp(MEMBER_MAIL_OFF.slice(0, 20)));
    await macc.remove(added.id);
    off = false;
    assert.deepEqual(macc.list(), []);
    assert.equal(mms.hasTokens(added.id), false);
  } finally {
    mtmp.cleanup();
  }
});
