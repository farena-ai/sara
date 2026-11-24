// T45 C13: "did it work?" for Outlook and IMAP drafts. After saving, the provider looks the draft
// up again (Graph: GET by id; IMAP: search the Drafts folder by Message-ID) and mail_draft says
// "Verified" only when it was found. Against the stand-in servers, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
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
const draftTool = (accounts: MailAccounts): Tool => createMailTools({ accounts, organizer: new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => tz }), google: new Map(), timeZone: () => tz }).find((t) => t.spec.name === 'mail_draft')!;

// ---- Outlook (Microsoft Graph) ----
const vaultG = new Vault(tmpG.dir);
const msOpts = { graphBase: `${graph.base}/v1.0`, loginBase: `${graph.base}/login`, sleep: async () => {} };
const ms = new MicrosoftAuth(vaultG, msOpts);
ms.setClient(graph.clientId, graph.clientSecret);
const signIn = graph.authorize(ms.authUrl(REDIRECT));
const accountsG = new MailAccounts(vaultG, undefined, ms, { ms: msOpts });
const outlook = accountsG.addMicrosoft(await ms.finish(signIn.code, signIn.state));
const mailG = draftTool(accountsG);

test('Outlook: a saved draft is read back by its id', async () => {
  const before = graph.msgs.length;
  const out = await mailG.run({ to: 'bob@work.com', subject: 'Lunch', body: 'Friday?' }, ctx(tmpG.dir));
  const made = graph.msgs.at(-1)!;
  assert.equal(graph.msgs.length, before + 1);
  assert.equal(made.isDraft, true);
  assert.match(out, new RegExp(`^Verified: read the draft back from the mail server \\(id ${made.id}\\)\\.`, 'm'));
  assert.equal(verifyState(out), 'verified');
  // The provider itself reports it, for any other caller.
  const d: Draft = { to: 'bob@work.com', subject: 'Second', body: 'x' };
  await accountsG.provider(outlook.id).draft(d);
  assert.equal(d.saved, true);
});

test('Outlook: a reply draft is read back too', async () => {
  const orig = graph.add({ from: 'Bob <bob@work.com>', subject: 'Budget' });
  const out = await mailG.run({ to: 'bob@work.com', subject: 'Re: Budget', body: 'Fine.', reply_to: orig.id }, ctx(tmpG.dir));
  assert.match(out, /^Verified: read the draft back from the mail server/m);
});

test('Outlook: a draft that is gone on the second read is not called verified', async () => {
  const add = graph.add.bind(graph);
  // The server answers "created" and then loses the message.
  graph.add = (m) => {
    const made = add(m);
    setImmediate(() => {
      graph.msgs = graph.msgs.filter((x) => x !== made);
    });
    return made;
  };
  try {
    const out = await mailG.run({ to: 'bob@work.com', subject: 'Lost', body: 'x' }, ctx(tmpG.dir));
    assert.match(out, /^Could not verify: the draft was not there when the mail server was read back\./m);
    assert.doesNotMatch(out, /^Verified:/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    graph.add = add;
  }
});

test('Outlook: when the second read fails she says it could not be read back', async () => {
  const add = graph.add.bind(graph);
  // Every request after the create is answered "slow down" until the retries run out.
  graph.add = (m) => {
    const made = add(m);
    setImmediate(() => {
      graph.throttle = 50;
    });
    return made;
  };
  try {
    const out = await mailG.run({ to: 'bob@work.com', subject: 'Busy server', body: 'x' }, ctx(tmpG.dir));
    assert.match(out, /^Could not verify: the mail server took the draft \(id [^)]+\) but reading it back failed\./m);
    assert.equal(verifyState(out), 'unverified');
    assert.ok(graph.msgs.some((x) => x.subject === 'Busy server'), 'the draft itself was saved');
  } finally {
    graph.add = add;
    graph.throttle = 0;
  }
});

// ---- IMAP ----
const vaultI = new Vault(tmpI.dir);
const accountsI = new MailAccounts(vaultI, undefined, new MicrosoftAuth(vaultI), { imap: { ca: imap.certs.ca.pem, lookup: async () => ['127.0.0.1'], testLoopback: true, timeZone: () => tz } });
const imapDraft = accountsI.imapDraft({ preset: 'other', address: imap.user, password: imap.pass, imapHost: 'mail.test', imapPort: imap.port, smtpHost: 'mail.test', smtpPort: smtp.smtpPort });
const imapInfo = accountsI.saveImap(imapDraft.info, imapDraft.password);
const mailI = draftTool(accountsI);

test('IMAP: a saved draft is found again in the Drafts folder', async () => {
  const box = imap.boxes.get('Drafts')!;
  const before = box.mails.length;
  const out = await mailI.run({ to: 'bob@work.com', subject: 'Lunch', body: 'Friday?' }, ctx(tmpI.dir));
  assert.equal(box.mails.length, before + 1);
  assert.match(out, /^Verified: read the draft back from the mail server/m);
  assert.equal(verifyState(out), 'verified');
  // It really asked the server: a search of Drafts by the new Message-ID.
  const id = /^Message-ID: (<[^>]+>)/im.exec(box.mails.at(-1)!.raw.toString())![1];
  assert.ok(imap.log.some((l) => /UID SEARCH/i.test(l) && l.includes(id.slice(1, -1))), 'searched by Message-ID');
  const d: Draft = { to: 'bob@work.com', subject: 'Second', body: 'x' };
  await accountsI.provider(imapInfo.id).draft(d);
  assert.equal(d.saved, true);
});

test('IMAP: a draft the server said OK to but did not keep is not called verified', async () => {
  const box = imap.boxes.get('Drafts')!;
  const push = box.mails.push;
  // APPEND answers OK and the message is dropped.
  box.mails.push = () => box.mails.length;
  try {
    const out = await mailI.run({ to: 'bob@work.com', subject: 'Lost', body: 'x' }, ctx(tmpI.dir));
    assert.match(out, /^Could not verify: the draft was not there when the mail server was read back\./m);
    assert.doesNotMatch(out, /^Verified:/m);
    assert.equal(verifyState(out), 'unverified');
  } finally {
    box.mails.push = push;
  }
});
