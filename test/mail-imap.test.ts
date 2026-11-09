// M1: IMAP + SMTP mailboxes (Yahoo, iCloud, Fastmail…, here "Other" on stand-in servers over TLS
// with a test certificate). No network: the servers are on loopback, reachable only under node
// --test with the test override. Special-use folders, search, flags, MOVE and undo by Message-ID,
// drafts by APPEND, send by SMTP (and a copy in Sent), never EXPUNGE, the app password only in the
// vault, and the presets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MailAccounts, imapPasswordVault } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { openMailSocket } from '../src/mail/socket.ts';
import { fromMutf7, imapId, parseImapId } from '../src/mail/imap.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { guessPreset, IMAP_PRESETS, isMicrosoftAddress, presetById } from '../src/mail/presets.ts';
import { createMailTools } from '../src/tools/mail.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';
import { FakeMailServer } from './mail-fake.ts';
import { FakeImapBoxes } from './mail-imap-fake.ts';

const imap = await new FakeImapBoxes().start();
// One test CA for both stand-ins (two CAs with the same name would confuse the TLS check).
const smtp = new FakeMailServer('mail.test');
(smtp as unknown as { certs: typeof imap.certs }).certs = imap.certs;
await smtp.start();
smtp.user = imap.user;
smtp.pass = imap.pass;
const tmp = tempDir();
after(async () => {
  await imap.stop();
  await smtp.stop();
  tmp.cleanup();
});

const vault = new Vault(tmp.dir);
const tz = 'America/Chicago';
const accounts = new MailAccounts(vault, undefined, new MicrosoftAuth(vault), { imap: { ca: imap.certs.ca.pem, lookup: async () => ['127.0.0.1'], testLoopback: true, timeZone: () => tz } });
const organizer = new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => tz });
const tools = new Map<string, Tool>();
for (const t of createMailTools({ accounts, organizer, google: new Map(), timeZone: () => tz })) tools.set(t.spec.name, t);
const ctx = (): ToolContext => ({ workspaceDir: tmp.dir, signal: AbortSignal.timeout(30_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId: 'c1' });
const tool = (n: string) => tools.get(n)!;
const input = (password: string) => ({ preset: 'other', address: imap.user, password, imapHost: 'mail.test', imapPort: imap.port, smtpHost: 'mail.test', smtpPort: smtp.smtpPort });

test('presets: servers and app-password steps; Outlook.com is not an IMAP preset', () => {
  for (const id of ['yahoo', 'aol', 'icloud', 'fastmail', 'zoho', 'gmx', 'webde', 'proton']) assert.ok(presetById(id), id);
  assert.equal(presetById('yahoo')!.imap.host, 'imap.mail.yahoo.com');
  assert.equal(presetById('icloud')!.smtp.port, 587);
  assert.equal(presetById('proton')!.imap.host, '127.0.0.1');
  assert.equal(presetById('proton')!.loopback, true);
  assert.ok(IMAP_PRESETS.every((p) => p.passwordHow.length > 20));
  assert.ok(!IMAP_PRESETS.some((p) => /outlook|office365/.test(p.imap.host)));
  assert.equal(guessPreset('a@ymail.com'), 'yahoo');
  assert.equal(guessPreset('a@me.com'), 'icloud');
  assert.equal(guessPreset('a@web.de'), 'webde');
  assert.equal(guessPreset('a@proton.me'), 'proton');
  assert.equal(isMicrosoftAddress('a@hotmail.co.uk'), true);
  assert.equal(fromMutf7('Entw&APw-rfe'), 'Entwürfe');
  assert.deepEqual(parseImapId(imapId('Bulk Mail', 7, 42)), { folder: 'Bulk Mail', validity: 7, uid: 42 });
});

test('adding: a wrong password is refused before anything is saved; the right one is kept only in the vault', async () => {
  const bad = accounts.imapDraft(input('nope-1234'));
  await assert.rejects(bad.provider.test(), /refused the password/);
  assert.equal(accounts.list().length, 0);
  const d = accounts.imapDraft(input(imap.pass));
  assert.match(await d.provider.test(), /Signed in as me@mail\.test: 0 emails/);
  await d.provider.testSmtp();
  const info = accounts.saveImap(d.info, d.password);
  assert.equal(vault.get(imapPasswordVault(info.id)), imap.pass);
  assert.doesNotMatch(JSON.stringify(accounts.list()), new RegExp(imap.pass));
  assert.doesNotMatch(vault.get('mail:accounts') ?? '', new RegExp(imap.pass));
  assert.ok(!imap.log.some((l) => l.includes(imap.pass)));
  assert.equal(accounts.default()?.id, info.id);
});

test('search, read and folders (special-use: \\Junk is "Bulk Mail")', async () => {
  const old = new Date('2026-09-15T12:00:00Z');
  imap.deliver('INBOX', { from: 'Bob <bob@work.com>', subject: 'Quarterly report', body: 'Can you check the numbers?', messageId: '<q1@work.com>' });
  imap.deliver('INBOX', { from: 'news@shop.com', subject: 'Big sale', headers: ['List-Unsubscribe: <https://shop.com/u>'], date: old });
  imap.deliver('INBOX', { from: 'news@shop.com', subject: 'Old sale', date: old, flags: ['\\Seen'] });
  imap.deliver('Archive', { from: 'Bob <bob@work.com>', subject: 'Older thread', date: old });
  const s = await tool('mail_search').run({ query: 'from:bob' }, ctx());
  assert.match(s, /Quarterly report/);
  assert.match(s, /Older thread/, 'the inbox and the archive are searched');
  const id = /\[(i\.[^\]]+)\]/.exec(s)![1];
  assert.match(await tool('mail_read').run({ id }, ctx()), /Can you check the numbers\?/);
  assert.match(await tool('mail_search').run({ query: 'is:unread before:2026/10/01' }, ctx()), /Big sale/);
  const f = await tool('mail_folders').run({}, ctx());
  assert.match(f, /Bulk Mail \(junk\)/);
  assert.match(f, /Archive \(archive\)/);
  // Reading never marks as read (BODY.PEEK).
  assert.ok(!imap.find('Quarterly report')!.flags.includes('\\Seen'));
});

test('needs an answer: people only; a reply in Sent counts as answered', async () => {
  let out = await tool('mail_needs_answer').run({}, ctx());
  assert.match(out, /Quarterly report/);
  assert.match(out, /asks a question/);
  assert.doesNotMatch(out, /Big sale/);
  imap.deliver('Sent', { from: imap.user, to: 'bob@work.com', subject: 'Re: Quarterly report', inReplyTo: '<q1@work.com>', references: '<q1@work.com>' });
  out = await tool('mail_needs_answer').run({}, ctx());
  assert.doesNotMatch(out, /Quarterly report/);
});

test('organize: archive (MOVE to \\Archive) with the count first, undo finds them by Message-ID; read and star are flags', async () => {
  const org = tool('mail_organize');
  const p = await org.prepare!({ action: 'archive', query: 'from:news@shop.com' }, ctx());
  assert.match(String(p.summary), /^Archive 2 emails in me@mail\.test/);
  assert.equal((p.detail as { provider?: string }).provider, 'Mail');
  const out = await org.run({ action: 'archive', query: 'from:news@shop.com' }, ctx());
  assert.match(out, /Done: 2 of 2 emails archived/);
  assert.equal(imap.find('Big sale')!.box.name, 'Archive');
  await tool('mail_undo').run({ id: /id (m_\w+)/.exec(out)![1] }, ctx());
  assert.equal(imap.find('Big sale')!.box.name, 'INBOX');
  assert.equal(imap.find('Old sale')!.box.name, 'INBOX');
  const r = await org.run({ action: 'read', query: 'from:news@shop.com' }, ctx());
  assert.match(r, /Done: 1 of 1/, 'only the unread one is counted');
  assert.ok(imap.find('Big sale')!.flags.includes('\\Seen'));
  await org.run({ action: 'star', query: 'subject:"Quarterly report"' }, ctx());
  assert.ok(imap.find('Quarterly report')!.flags.includes('\\Flagged'));
  await assert.rejects(org.run({ action: 'important', query: 'from:bob' }, ctx()), /important/);
});

test('trash and spam ask every time and are moves to \\Trash and \\Junk; no EXPUNGE, ever', async () => {
  const org = tool('mail_organize');
  assert.equal(org.asksFirst!({ action: 'trash' }), true);
  const t = await org.run({ action: 'trash', query: 'subject:"Old sale"' }, ctx());
  assert.equal(imap.find('Old sale')!.box.name, 'Trash');
  await org.run({ action: 'spam', query: 'subject:"Big sale"' }, ctx());
  assert.equal(imap.find('Big sale')!.box.name, 'Bulk Mail');
  await tool('mail_undo').run({ id: /id (m_\w+)/.exec(t)![1] }, ctx());
  assert.equal(imap.find('Old sale')!.box.name, 'INBOX');
  await org.run({ action: 'move', query: 'subject:"Old sale"', folder: 'Receipts' }, ctx());
  assert.equal(imap.find('Old sale')!.box.name, 'Receipts');
  assert.ok(!imap.log.some((l) => /EXPUNGE/i.test(l)), 'never an expunge when the server has MOVE');
});

test('drafts go to \\Drafts by APPEND; send goes by SMTP and a copy into Sent; replies keep the thread', async () => {
  const q = /\[(i\.[^\]]+)\]/.exec(await tool('mail_search').run({ query: 'subject:"Quarterly report"' }, ctx()))![1];
  await tool('mail_draft').run({ to: 'bob@work.com', subject: 'Re: Quarterly report', body: 'Looks right.', reply_to: q }, ctx());
  const draft = imap.boxes.get('Drafts')!.mails.at(-1)!;
  assert.ok(draft.flags.includes('\\Draft'));
  assert.match(draft.raw.toString(), /In-Reply-To: <q1@work\.com>/);
  const before = smtp.sent.length;
  const sentBox = imap.boxes.get('Sent')!.mails.length;
  await tool('mail_send').run({ to: 'bob@work.com', cc: 'ana@x.com', subject: 'Numbers', body: 'All good. Ünïcode too.' }, ctx());
  assert.equal(smtp.sent.length - before, 2, 'one envelope per recipient');
  assert.match(smtp.sent.at(-1)!.data, /^From: <me@mail\.test>/m);
  assert.equal(imap.boxes.get('Sent')!.mails.length, sentBox + 1);
});

test('Proton Mail Bridge: only this computer; a remote host is refused for it', async () => {
  const p = accounts.imapDraft({ preset: 'proton', address: 'me@proton.me', password: 'bridge-pass-1' });
  assert.equal(p.info.imap!.loopback, true);
  assert.equal(p.info.imap!.imap.host, '127.0.0.1');
  await assert.rejects(openMailSocket('imap.example.com', 1143, { loopback: true, lookup: async () => ['93.184.216.34'] }), /isn't this computer/);
  // Any other provider: a private or local address is refused (no test override here).
  await assert.rejects(openMailSocket('mail.test', 993, { lookup: async () => ['127.0.0.1'] }), /private or local address/);
  await assert.rejects(openMailSocket('mail.test', 993, { lookup: async () => ['192.168.1.20'] }), /private or local address/);
});

test('removing the account deletes its app password', async () => {
  const id = accounts.default()!.id;
  await accounts.remove(id);
  assert.equal(vault.get(imapPasswordVault(id)), undefined);
  assert.equal(accounts.list().length, 0);
});
