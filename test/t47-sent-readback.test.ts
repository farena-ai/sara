// T47: "did it work?" for sent mail on Outlook and IMAP. After sending, the provider looks the
// message up again (Graph: by its id, else in Sent Items by Message-ID; IMAP: the Sent folder by
// Message-ID) and mail_send says "Verified" only when it was found. A send the server accepted is
// never reported as failed because the second look failed. Against the stand-in servers, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { ImapMail } from '../src/mail/imap.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { createMailTools } from '../src/tools/mail.ts';
import type { Draft } from '../src/mail/types.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { verifyState } from '../src/verify-action.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';
import { FakeMailServer } from './mail-fake.ts';
import { FakeGraph } from './mail-graph-fake.ts';
import { FakeImapBoxes } from './mail-imap-fake.ts';

const tz = 'America/Chicago';
const REDIRECT = 'http://localhost:3000/api/mail/microsoft/callback';
const graph = await new FakeGraph().start();
const imap = await new FakeImapBoxes().start();
const smtp = new FakeMailServer('mail.test');
(smtp as unknown as { certs: typeof imap.certs }).certs = imap.certs;
await smtp.start();
smtp.user = imap.user;
smtp.pass = imap.pass;
const tmpG = tempDir();
const tmpI = tempDir();
after(async () => {
  await graph.stop();
  await imap.stop();
  await smtp.stop();
  tmpG.cleanup();
  tmpI.cleanup();
});

const ctx = (dir: string): ToolContext => ({ workspaceDir: dir, signal: AbortSignal.timeout(30_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId: 'c1' });
const sendTool = (accounts: MailAccounts, files?: (ids: unknown) => { name: string; mime: string; data: Buffer }[]): Tool =>
  createMailTools({ accounts, organizer: new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => tz }), google: new Map(), timeZone: () => tz, ...(files ? { files } : {}) }).find((t) => t.spec.name === 'mail_send')!;

// ---- Outlook (Microsoft Graph) ----
const vaultG = new Vault(tmpG.dir);
const waits: number[] = [];
/** What the server does while she waits between two looks. */
let onWait: (() => void) | undefined;
const msOpts = {
  graphBase: `${graph.base}/v1.0`,
  loginBase: `${graph.base}/login`,
  sleep: async (ms: number) => {
    waits.push(ms);
    onWait?.();
  },
};
const ms = new MicrosoftAuth(vaultG, msOpts);
ms.setClient(graph.clientId, graph.clientSecret);
const signIn = graph.authorize(ms.authUrl(REDIRECT));
const accountsG = new MailAccounts(vaultG, undefined, ms, { ms: msOpts });
const outlook = accountsG.addMicrosoft(await ms.finish(signIn.code, signIn.state));
const mailG = sendTool(accountsG);

test('Outlook: a sent email is read back by its id from Sent Items', async () => {
  const before = graph.sent.length;
  const out = await mailG.run({ to: 'bob@work.com', subject: 'Lunch', body: 'Friday?' }, ctx(tmpG.dir));
  assert.equal(graph.sent.length, before + 1, 'sent once');
  const made = graph.msgs.find((m) => m.subject === 'Lunch')!;
  assert.equal(made.isDraft, false);
  assert.equal(made.parentFolderId, 'F-SENT');
  assert.deepEqual(graph.sent.at(-1), { sentDraft: made.id, subject: 'Lunch', files: [], body: 'Friday?', to: ['bob@work.com'] });
  assert.match(out, /^Sent from ana@outlook\.com to bob@work\.com\.$/m);
  assert.match(out, new RegExp(`^Verified: read the sent email back from the Sent folder \\(id ${made.id}\\)\\.$`, 'm'));
  assert.equal(verifyState(out), 'verified');
  // The provider itself reports it, for any other caller.
  const d: Draft = { to: 'bob@work.com', subject: 'Second', body: 'x' };
  await accountsG.provider(outlook.id).send(d);
  assert.equal(d.sent, true);
});

test('Outlook: a reply is sent in its thread and read back too', async () => {
  const orig = graph.add({ from: 'Bob <bob@work.com>', subject: 'Budget' });
  const out = await mailG.run({ to: 'bob@work.com', subject: 'Re: Budget', body: 'Fine.', reply_to: orig.id }, ctx(tmpG.dir));
  const made = graph.msgs.find((m) => m.subject === 'RE: Budget')!;
  assert.equal(made.conversationId, orig.conversationId, 'same thread');
  assert.equal(made.body, 'Fine.');
  assert.equal(made.parentFolderId, 'F-SENT');
  assert.match(out, /^Verified: read the sent email back from the Sent folder/m);
});

test('Outlook: when the id changed on sending, it is found in Sent Items by its Message-ID', async () => {
  graph.afterSend = (msg) => {
    msg.id = `${msg.id}new`;
  };
  try {
    const out = await mailG.run({ to: 'bob@work.com', subject: 'New id', body: 'x' }, ctx(tmpG.dir));
    assert.match(out, /^Verified: read the sent email back from the Sent folder/m);
    assert.ok(graph.log.some((l) => l.includes('/mailFolders/sentitems/messages') && l.includes('internetMessageId')), `looked in Sent Items by Message-ID: ${graph.log.slice(-4).join(' | ')}`);
  } finally {
    delete graph.afterSend;
  }
});

test('Outlook: a sent email that is nowhere on the second read is not called verified, and not called failed', async () => {
  graph.afterSend = (msg) => {
    graph.msgs = graph.msgs.filter((x) => x !== msg);
  };
  waits.length = 0;
  try {
    const before = graph.sent.length;
    const out = await mailG.run({ to: 'bob@work.com', subject: 'Lost', body: 'x' }, ctx(tmpG.dir));
    assert.equal(graph.sent.length, before + 1, 'the send itself went through, once');
    assert.match(out, /^Sent from ana@outlook\.com to bob@work\.com\.$/m);
    assert.match(out, /^Could not verify: the mail server accepted the email, but it was not in the Sent folder when read back\.$/m);
    assert.doesNotMatch(out, /^Verified:/m);
    assert.equal(verifyState(out), 'unverified');
    assert.deepEqual(waits, [1000, 2000], 'it looked three times before giving up');
  } finally {
    delete graph.afterSend;
  }
});

test('Outlook: an email still waiting to go out is found on a later look', async () => {
  // Still a draft on the first look; filed in Sent Items while she waits.
  graph.afterSend = (msg) => {
    msg.isDraft = true;
    onWait = () => {
      msg.isDraft = false;
    };
  };
  waits.length = 0;
  try {
    const out = await mailG.run({ to: 'bob@work.com', subject: 'Slow filing', body: 'x' }, ctx(tmpG.dir));
    assert.match(out, /^Verified: read the sent email back from the Sent folder/m);
    assert.deepEqual(waits, [1000], 'found on the second look');
  } finally {
    delete graph.afterSend;
    onWait = undefined;
  }
});

test('Outlook: when the second read fails the email is still reported as sent', async () => {
  // Every request after the send is answered "slow down" until the retries run out.
  graph.afterSend = () => {
    graph.throttle = 50;
  };
  try {
    const before = graph.sent.length;
    const out = await mailG.run({ to: 'bob@work.com', subject: 'Busy server', body: 'x' }, ctx(tmpG.dir));
    assert.equal(graph.sent.length, before + 1);
    assert.match(out, /^Sent from ana@outlook\.com to bob@work\.com\.$/m);
    assert.match(out, /^Could not verify: the mail server accepted the email, but reading it back from the Sent folder failed\.$/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    delete graph.afterSend;
    graph.throttle = 0;
  }
});

test('Outlook: a send the server refuses is an error, and says the message is in Drafts', async () => {
  const before = graph.sent.length;
  // The draft is made; then every call (the send) is throttled until the tries run out.
  const add = graph.add.bind(graph);
  graph.add = (m) => {
    const made = add(m);
    graph.throttle = 50;
    return made;
  };
  try {
    await assert.rejects(mailG.run({ to: 'bob@work.com', subject: 'Refused', body: 'x' }, ctx(tmpG.dir)), /The unsent message was left in Drafts\.$/);
    assert.equal(graph.sent.length, before, 'nothing was sent');
    assert.equal(graph.msgs.find((m) => m.subject === 'Refused')?.isDraft, true);
  } finally {
    graph.add = add;
    graph.throttle = 0;
  }
});

// ---- IMAP ----
const vaultI = new Vault(tmpI.dir);
const accountsI = new MailAccounts(vaultI, undefined, new MicrosoftAuth(vaultI), { imap: { ca: imap.certs.ca.pem, lookup: async () => ['127.0.0.1'], testLoopback: true, timeZone: () => tz, sleep: async () => {} } });
const imapDraft = accountsI.imapDraft({ preset: 'other', address: imap.user, password: imap.pass, imapHost: 'mail.test', imapPort: imap.port, smtpHost: 'mail.test', smtpPort: smtp.smtpPort });
const imapInfo = accountsI.saveImap(imapDraft.info, imapDraft.password);
const mailI = sendTool(accountsI);
const sentBox = () => imap.boxes.get('Sent')!;
const messageIdOf = (raw: Buffer) => /^Message-ID: (<[^>]+>)/im.exec(raw.toString())![1];

test('IMAP: a sent email is found again in the Sent folder by its Message-ID', async () => {
  const before = sentBox().mails.length;
  const out = await mailI.run({ to: 'bob@work.com', subject: 'Lunch', body: 'Friday?' }, ctx(tmpI.dir));
  assert.equal(sentBox().mails.length, before + 1, 'a copy is kept in Sent');
  assert.match(out, new RegExp(`^Sent from ${imap.user.replace(/[.]/g, '\\.')} to bob@work\\.com\\.$`, 'm'));
  assert.match(out, /^Verified: read the sent email back from the Sent folder\.$/m);
  assert.equal(verifyState(out), 'verified');
  const id = messageIdOf(sentBox().mails.at(-1)!.raw);
  assert.ok(imap.log.some((l) => /UID SEARCH/i.test(l) && l.includes(id.slice(1, -1))), 'searched by Message-ID');
  const d: Draft = { to: 'bob@work.com', subject: 'Second', body: 'x' };
  await accountsI.provider(imapInfo.id).send(d);
  assert.equal(d.sent, true);
});

test('IMAP: a copy the server said OK to but did not keep is not called verified, and the send is not called failed', async () => {
  const box = sentBox();
  const push = box.mails.push;
  box.mails.push = () => box.mails.length;
  try {
    const out = await mailI.run({ to: 'bob@work.com', subject: 'Lost copy', body: 'x' }, ctx(tmpI.dir));
    assert.match(out, /^Sent from /m);
    assert.match(out, /^Could not verify: the mail server accepted the email, but it was not in the Sent folder when read back\.$/m);
    assert.doesNotMatch(out, /^Verified:/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    box.mails.push = push;
  }
});

test('IMAP: a mailbox with no Sent folder says so plainly', async () => {
  // A second account on the same server, after its Sent folder is gone (folder roles are read once per account).
  const kept = sentBox();
  imap.boxes.delete('Sent');
  const tmp = tempDir();
  try {
    const vault = new Vault(tmp.dir);
    const accounts = new MailAccounts(vault, undefined, new MicrosoftAuth(vault), { imap: { ca: imap.certs.ca.pem, lookup: async () => ['127.0.0.1'], testLoopback: true, timeZone: () => tz, sleep: async () => {} } });
    const dr = accounts.imapDraft({ preset: 'other', address: imap.user, password: imap.pass, imapHost: 'mail.test', imapPort: imap.port, smtpHost: 'mail.test', smtpPort: smtp.smtpPort });
    accounts.saveImap(dr.info, dr.password);
    const out = await sendTool(accounts).run({ to: 'bob@work.com', subject: 'Nowhere to file', body: 'x' }, ctx(tmp.dir));
    assert.match(out, /^Sent from /m);
    assert.match(out, /^Could not verify: the mail server accepted the email, but this mailbox has no Sent folder to read it back from\.$/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    imap.boxes.set('Sent', kept);
    tmp.cleanup();
  }
});

test('IMAP: when the Sent folder cannot be read the email is still reported as sent', async () => {
  // The folder is listed, but gone by the time it is opened: APPEND and SELECT both answer NO.
  const kept = sentBox();
  const tmp = tempDir();
  try {
    const vault = new Vault(tmp.dir);
    const accounts = new MailAccounts(vault, undefined, new MicrosoftAuth(vault), { imap: { ca: imap.certs.ca.pem, lookup: async () => ['127.0.0.1'], testLoopback: true, timeZone: () => tz, sleep: async () => {} } });
    const dr = accounts.imapDraft({ preset: 'other', address: imap.user, password: imap.pass, imapHost: 'mail.test', imapPort: imap.port, smtpHost: 'mail.test', smtpPort: smtp.smtpPort });
    accounts.saveImap(dr.info, dr.password);
    const tool = sendTool(accounts);
    // The first send learns the folders.
    await tool.run({ to: 'bob@work.com', subject: 'First', body: 'x' }, ctx(tmp.dir));
    imap.boxes.delete('Sent');
    const out = await tool.run({ to: 'bob@work.com', subject: 'Unreadable', body: 'x' }, ctx(tmp.dir));
    assert.match(out, /^Sent from /m);
    assert.match(out, /^Could not verify: the mail server accepted the email, but reading it back from the Sent folder failed\.$/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    imap.boxes.set('Sent', kept);
    tmp.cleanup();
  }
});

test('IMAP: a server that files sent mail itself gets two more looks', async () => {
  // No copy is appended (Gmail and others file it themselves); here the server does it a moment later.
  const box = sentBox();
  let files = true;
  const waited: number[] = [];
  const mail = new ImapMail({ address: imap.user, user: imap.user, imap: { host: 'mail.test', port: imap.port }, smtp: { host: 'mail.test', port: smtp.smtpPort }, copySent: false }, () => imap.pass, {
    ca: imap.certs.ca.pem,
    lookup: async () => ['127.0.0.1'],
    testLoopback: true,
    sleep: async (ms) => {
      waited.push(ms);
      if (files) box.mails.push({ uid: box.next++, raw: Buffer.from(smtp.sent.at(-1)!.data), flags: ['\\Seen'], date: new Date() });
    },
  });
  const before = box.mails.length;
  const d: Draft = { to: 'bob@work.com', subject: 'Filed late', body: 'x' };
  await mail.send(d);
  assert.equal(d.sent, true);
  assert.deepEqual(waited, [1000]);
  assert.equal(box.mails.length, before + 1, 'she appended no copy of her own');
  // A server that never files it: three looks, then "not there"; the send still returns.
  files = false;
  waited.length = 0;
  const d2: Draft = { to: 'bob@work.com', subject: 'Never filed', body: 'x' };
  assert.equal(await mail.send(d2), 'bob@work.com');
  assert.equal(d2.sent, false);
  assert.deepEqual(waited, [1000, 2000]);
});
