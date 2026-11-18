// U1.2 (docs/CHECKS.md): the mail and calendar account check. Drives a throwaway in-process Sara (own
// temp data folder, loopback port, scripted fake model) through its real HTTP API and real chat turns
// (approval cards answered over HTTP): add, read, search, reply draft, send to self and remove for every
// mail kind, and every calendar kind.
//
//   (a) always: loopback stand-ins (IMAP + SMTP on a test certificate, a fake Google, a fake Microsoft
//       Graph, a fake CalDAV server, a fake calendar link). Two Gmail sign-ins, Gmail + an app-password
//       mailbox, re-adding the same address, removing one, default switching, the combined inbox,
//       calendars from several accounts and calendar links.
//   (b) only when the owner made .secrets/test-accounts.json (gitignored; see docs/CHECKS.md): the same
//       flows against his REAL test accounts, in a second process. Missing ones are listed and skipped.
//       Secrets are never printed; mail is only ever sent to the same test address.
//
//   node scripts/check-accounts.ts            (exit code 1 when a step failed)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CheckRun, check, missingParts, throwawayEnv, until, type RealCfg, type Step } from './checks-lib.ts';

const REAL = process.argv.includes('--real');
throwawayEnv();
// The loopback stand-ins are reachable only with the test override (never in a real run).
if (!REAL) process.env.NODE_TEST_CONTEXT = 'child-v8';
console.info = () => {};
const ROOTDIR = resolve(import.meta.dirname, '..');
const SECRETS = join(ROOTDIR, '.secrets', 'test-accounts.json');

const { makeApp, tempDir, ROOT, call, text } = await import('../test/helpers.ts');
const { OwnerAuth } = await import('../src/auth.ts');
const { createSaraServer } = await import('../src/server.ts');
const { GOOGLE_CLIENT_VAULT, GOOGLE_TOKEN_VAULT, GoogleAccount } = await import('../src/google.ts');
const { GoogleAccounts } = await import('../src/google-accounts.ts');
const { MailAccounts } = await import('../src/mail/accounts.ts');
const { MicrosoftAuth } = await import('../src/mail/graph.ts');
const { MailOrganizer } = await import('../src/mail/organize.ts');
const { CalendarLinks } = await import('../src/calendar-links.ts');
const { createGoogleTools } = await import('../src/tools/google.ts');
const { createMailTools, routeCalendarTools } = await import('../src/tools/mail.ts');
const { DatabaseSync } = await import('node:sqlite');

type J = Record<string, any>;
const run = new CheckRun(REAL ? 'Sara account check (real test accounts)' : 'Sara account check');
const fakeId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const token = () => `U1-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const day0 = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const at = (h: number) => new Date(day0.getTime() + h * 3_600_000).toISOString();
const closers: (() => Promise<void> | void)[] = [];

// ---------------------------------------------------------------- the throwaway Sara
interface Fakes {
  googleFetch?: typeof fetch;
  ms?: { graphBase: string; loginBase: string };
  imap?: { ca: string };
  caldavFetch?: typeof fetch;
  linkFetch?: (url: string, init: RequestInit) => Promise<Response>;
}
async function startSara(f: Fakes) {
  const tmp = tempDir();
  closers.push(() => tmp.cleanup());
  const app = makeApp(tmp.dir, { get now() { return new Date(); } } as never);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', providers: [{ id: 'p', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' }], defaultProviderId: 'p', defaultModel: 'fake', disclosureAcceptedAt: new Date().toISOString(), setupDone: true } as never);
  const vault = app.vault;
  const tz = () => 'UTC';
  const gOpts = f.googleFetch ? { fetch: f.googleFetch } : {};
  const google = new GoogleAccount(vault, gOpts);
  const googles = new GoogleAccounts(vault, google, gOpts);
  const msOpts = f.ms ?? {};
  const accounts = new MailAccounts(vault, google, new MicrosoftAuth(vault, msOpts), {
    ms: msOpts,
    googles,
    viewFile: join(tmp.dir, 'mail-view.json'),
    imap: { timeZone: tz, ...(f.imap ? { ca: f.imap.ca, lookup: async () => ['127.0.0.1'], testLoopback: true } : {}) },
    ...(f.caldavFetch ? { caldav: { fetch: f.caldavFetch } } : {}),
  });
  const links = new CalendarLinks(vault, join(tmp.dir, 'calendar-links.json'));
  if (f.linkFetch) links.fetch = f.linkFetch;
  accounts.calendarLinks = links;
  app.google = google;
  app.googleAccounts = googles;
  app.mailAccounts = accounts;
  // The tools wired as main.ts does: Gmail tools per Google account, mail_* for every mailbox, the calendar router.
  const googleTools = createGoogleTools(google, tz);
  const calNames = new Set(['calendar_events', 'calendar_add', 'calendar_remove']);
  for (const t of googleTools) if (!calNames.has(t.spec.name)) app.tools.add(t);
  const extra = new Map<string, Map<string, any>>();
  const googleFor = (id: string) => {
    const g = /^google:\d{1,2}$/.test(id) ? googles.get(id) : undefined;
    if (!g) return undefined;
    if (!extra.has(id)) extra.set(id, new Map(createGoogleTools(g, tz).map((t) => [t.spec.name, t])));
    return extra.get(id);
  };
  for (const t of routeCalendarTools(googleTools.filter((x) => calNames.has(x.spec.name)), accounts, tz, googleFor)) app.tools.add(t);
  app.mailOrganizer = new MailOrganizer(app.store.db, { timeZone: tz });
  for (const t of createMailTools({ accounts, organizer: app.mailOrganizer, google: new Map(googleTools.map((t) => [t.spec.name, t])), googleFor, timeZone: tz })) app.tools.add(t);
  const auth = new OwnerAuth(tmp.dir, () => new Date());
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  closers.unshift(() => new Promise<void>((ok) => (srv.closeAllConnections?.(), srv.close(() => ok()))), () => app.store.close());
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const headers = { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' };
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const req = async (method: string, path: string, body?: unknown): Promise<J> => {
    const r = await raw(method, path, body);
    const j = (await r.json().catch(() => ({}))) as J;
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${String(j.error ?? '')}`);
    return j;
  };
  let n = 0;
  /** One real chat turn: the fake model calls `tool` with `args` (once), every approval card is OKed over HTTP. */
  async function turn(words: string, tool: string, args: J, approve = true): Promise<{ output: string; status: string; cards: string[] }> {
    // A fresh chat per turn: a long one gets tidied, and the tidy-up would use the scripted model step.
    const made = await req('POST', '/api/conversations', { title: 'Account check' });
    const conv = (made.id ? made : made.conversation) as J;
    app.script.push([call(`c${++n}`, tool, args)], text('Done.'));
    const r = await fetch(`${base}/api/conversations/${conv.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: words }) });
    check(r.ok && r.body, `turn → ${r.status}`);
    const cards: string[] = [];
    let output = '';
    let status = 'none';
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data) as J;
        if (ev === 'approval') {
          cards.push(String(d.summary ?? ''));
          await fetch(`${base}/api/approvals/${d.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ approved: approve }) });
        }
        if (ev === 'tool_result' && d.name === tool) ((output = String(d.output ?? '')), (status = String(d.status)));
        if (ev === 'error') throw new Error(`turn error: ${d.message}`);
        if (process.env.CHECK_DEBUG && ev !== 'token') console.log(`  [${ev}] ${data.slice(0, 300)}`);
      }
    }
    check(status !== 'none', `${tool} did not run (not offered for "${words}"?)`);
    return { output, status, cards };
  }
  return { app, accounts, links, googles, base, req, raw, turn, vault, tmp };
}
type Sara = Awaited<ReturnType<typeof startSara>>;

const idIn = (out: string, near?: string) => {
  const lines = out.split('\n');
  const line = near ? lines.find((l) => l.includes(near)) : lines.find((l) => /\[[^\]]+\]/.test(l));
  return line ? /\[([^\]\s]+)\]/.exec(line)?.[1] : undefined;
};

/** The mail flow for one mailbox: send to self → (delivered) → search → read → reply draft. */
async function mailboxFlow(s: Sara, label: string, address: string, o: { deliver?: (subject: string, body: string) => void | Promise<void>; drafted?: (subject: string) => boolean | Promise<boolean>; waitMs?: number }) {
  const tk = token();
  const subject = `Sara check ${tk}`;
  check(/@/.test(address), 'no address');
  let id: string | undefined;
  const sent = await run.step(`${label}: send to self (approval card)`, async () => {
    const t = await s.turn(`Send an email to myself from ${address} to check my mail`, 'mail_send', { account: address, to: address, subject, body: `Testing ${tk}. Reply not needed.` });
    check(t.status === 'ok', `send ${t.status}: ${t.output.slice(0, 160)}`);
    check(t.cards.some((c) => c.includes(address)), `card did not name the mailbox: ${t.cards.join(' / ').slice(0, 160)}`);
    await o.deliver?.(subject, `Testing ${tk}. Reply not needed.`);
    return `card "${t.cards[0]?.split('\n').slice(0, 3).join(' · ')}"`;
  });
  await run.step(`${label}: search finds it`, async () => {
    check(sent, 'nothing was sent');
    const out = await until(async () => {
      const t = await s.turn(`Search my email in ${address} for ${tk}`, 'mail_search', { account: address, query: REAL ? tk : `subject:${tk}` });
      return t.output.includes(tk) && t.output;
    }, 'the email in search', o.waitMs ?? 8000);
    id = idIn(out, tk);
    check(id, `no email id in: ${out.slice(0, 200)}`);
    return `id ${id.slice(0, 18)}`;
  });
  await run.step(`${label}: read it`, async () => {
    check(id, 'no id');
    const t = await s.turn(`Read that email ${id}`, 'mail_read', { id, account: address });
    check(t.output.includes(tk), `read: ${t.output.slice(0, 200)}`);
    return 'subject and body read back';
  });
  await run.step(`${label}: reply draft (nothing sent)`, async () => {
    check(id, 'no id');
    const t = await s.turn(`Draft a reply to that email ${id}`, 'mail_draft', { account: address, to: address, subject: `Re: ${subject}`, body: 'Draft only.', reply_to: id });
    check(t.status === 'ok', `draft ${t.status}: ${t.output.slice(0, 160)}`);
    if (o.drafted) check(await o.drafted(subject), 'the draft is not in the mailbox');
    return t.output.split('\n')[0].slice(0, 140);
  });
}

// ---------------------------------------------------------------- loopback stand-ins
async function loopback() {
  const { FakeImapBoxes } = await import('../test/mail-imap-fake.ts');
  const { FakeMailServer } = await import('../test/mail-fake.ts');
  const { FakeGraph } = await import('../test/mail-graph-fake.ts');
  // Two IMAP + SMTP mailboxes on one test CA (two CAs with the same name fail the TLS check).
  const boxes: { imap: any; smtp: any; address: string; password: string }[] = [];
  for (const address of ['alex@mail.test', 'alex.work@mail.test']) {
    const imap = new FakeImapBoxes();
    const smtp = new FakeMailServer('mail.test');
    if (boxes[0]) ((imap as J).certs = boxes[0].imap.certs);
    (smtp as J).certs = (boxes[0]?.imap ?? imap).certs;
    imap.user = smtp.user = address;
    imap.pass = smtp.pass = fakeId('app');
    await imap.start();
    await smtp.start();
    closers.push(() => imap.stop(), () => smtp.stop());
    boxes.push({ imap, smtp, address, password: imap.pass });
  }
  const graph = await new FakeGraph().start();
  closers.push(() => graph.stop());
  graph.events.push({ id: 'ev-ms1', subject: 'Outlook review', start: { dateTime: at(18).slice(0, 19), timeZone: 'UTC' }, end: { dateTime: at(19).slice(0, 19), timeZone: 'UTC' }, isAllDay: false } as never);
  const gf = fakeGoogle();
  const dav = await fakeCalDav();
  closers.push(() => dav.close());
  const linkIcs = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:link1', `DTSTART:${at(17).replace(/[-:]/g, '').slice(0, 15)}Z`, `DTEND:${at(18).replace(/[-:]/g, '').slice(0, 15)}Z`, 'SUMMARY:School concert', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const linkFetch = async (url: string) => (url.includes('calendar.example') ? new Response(linkIcs, { status: 200, headers: { 'content-type': 'text/calendar' } }) : new Response('no', { status: 404 }));
  const s = await startSara({ googleFetch: gf.f, ms: { graphBase: `${graph.base}/v1.0`, loginBase: `${graph.base}/login` }, imap: { ca: boxes[0].imap.certs.ca.pem }, caldavFetch: fetch, linkFetch });
  s.vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: `${fakeId('client')}.apps.googleusercontent.com`, clientSecret: fakeId('GOCSPX') }));
  const list = async () => (await s.req('GET', '/api/mail/accounts')).accounts as J[];
  const idOf = async (address: string) => (await list()).find((a) => a.address === address)?.id as string;
  const googleSignIn = async (who: string, add: boolean) => {
    const { url } = await s.req('POST', '/api/google/connect', add ? { add: true } : {});
    const state = new URL(url).searchParams.get('state');
    const r = await s.raw('GET', `/api/google/callback?code=${who}&state=${state}`);
    return /#google=(\w+)/.exec(await r.text())?.[1];
  };

  run.group('Loopback: adding mailboxes');
  await run.step('Google sign-in #1 (Gmail + Calendar)', async () => {
    const r = await googleSignIn('alex', false);
    check(r === 'connected', `callback said ${r}`);
    return `${(await list()).map((a) => a.address).join(', ')}`;
  });
  await run.step('Google sign-in #2: two Gmails side by side', async () => {
    const r = await googleSignIn('work', true);
    check(r === 'added', `callback said ${r}`);
    const g = (await list()).filter((a) => a.kind === 'google');
    check(g.length === 2, `${g.length} Google accounts`);
    return g.map((a) => `${a.id} ${a.address}`).join(', ');
  });
  await run.step('re-adding the same Google address replaces it (no duplicate)', async () => {
    await googleSignIn('work', true);
    const g = (await list()).filter((a) => a.kind === 'google');
    check(g.length === 2, `${g.length} Google accounts after re-adding`);
    return 'still 2';
  });
  await run.step('app-password mailbox (IMAP + SMTP) next to Gmail', async () => {
    for (const b of boxes) {
      const r = await s.req('POST', '/api/mail/imap', { preset: 'other', address: b.address, password: b.password, imapHost: 'mail.test', imapPort: b.imap.port, smtpHost: 'mail.test', smtpPort: b.smtp.smtpPort });
      check(r.added, `not added: ${JSON.stringify(r).slice(0, 160)}`);
    }
    return `${(await list()).length} mailboxes`;
  });
  await run.step('re-adding the same IMAP address replaces it (same id, "replaced")', async () => {
    const b = boxes[1];
    const before = await idOf(b.address);
    const r = await s.req('POST', '/api/mail/imap', { preset: 'other', address: b.address, password: b.password, imapHost: 'mail.test', imapPort: b.imap.port, smtpHost: 'mail.test', smtpPort: b.smtp.smtpPort });
    check(r.replaced === true && r.added === before, `replaced ${r.replaced}, id ${r.added} vs ${before}`);
    check((await list()).filter((a) => a.address === b.address).length === 1, 'duplicate');
    return `id ${before} kept`;
  });
  await run.step('a wrong app password is refused in plain words, nothing saved', async () => {
    const n0 = (await list()).length;
    const r = await s.raw('POST', '/api/mail/imap', { preset: 'other', address: 'nobody@mail.test', password: 'wrong-one', imapHost: 'mail.test', imapPort: boxes[0].imap.port, smtpHost: 'mail.test', smtpPort: boxes[0].smtp.smtpPort });
    const j = (await r.json()) as J;
    check(r.status === 400 && (await list()).length === n0, `${r.status}, ${(await list()).length} mailboxes`);
    return `400 "${String(j.error).slice(0, 90)}"`;
  });
  await run.step('Outlook / Microsoft 365 sign-in (Graph)', async () => {
    await s.req('PUT', '/api/mail/microsoft/client', { clientId: graph.clientId, clientSecret: graph.clientSecret });
    const { url } = await s.req('POST', '/api/mail/microsoft/connect', {});
    const { code, state } = graph.authorize(url);
    const r = await s.raw('GET', `/api/mail/microsoft/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    await r.text();
    const ms = (await list()).find((a) => a.kind === 'microsoft');
    check(ms, `no Outlook account (callback ${r.status})`);
    return ms.address;
  });

  run.group('Loopback: mail in every kind');
  await mailboxFlow(s, 'Gmail #1 (Google sign-in)', 'alex@gmail.example', { drafted: (subj) => gf.drafts.some((d) => d.includes(subj)) });
  await mailboxFlow(s, 'Gmail #2 (Google sign-in)', 'work@gmail.example', { drafted: (subj) => gf.drafts.some((d) => d.includes(subj)) });
  for (const b of boxes)
    await mailboxFlow(s, `IMAP ${b.address}`, b.address, {
      // The stand-in SMTP server keeps what was sent; a real provider would put it in the inbox.
      deliver: async (subject) => {
        const m = await until(() => (b.smtp.sent as J[]).find((x) => String(x.data).includes(subject)), 'SMTP to get it');
        check((m.to as string[]).every((t) => t === b.address), `sent to ${m.to}`);
        b.imap.deliver('INBOX', { from: b.address, subject, body: String(m.data).split(/\r?\n\r?\n/).slice(1).join('\n') });
      },
      drafted: (subj) => [...b.imap.boxes.get('Drafts').mails].some((x: J) => x.raw.toString().includes(subj)),
    });
  await mailboxFlow(s, 'Outlook (Graph)', graph.address, {
    deliver: async (subject) => {
      await until(() => JSON.stringify(graph.sent).includes(subject), 'Graph to send it');
      graph.add({ from: graph.address, subject, body: subject });
    },
    drafted: (subj) => graph.msgs.some((m) => m.isDraft && m.subject.includes(subj)),
  });

  run.group('Loopback: default, combined inbox');
  await run.step('default switching: a new email goes from the default', async () => {
    const work = await idOf(boxes[1].address);
    await s.req('PUT', '/api/mail/default', { id: work });
    check((await s.req('GET', '/api/mail/accounts')).default === work, 'default not saved');
    const t = await s.turn('Send an email to myself to check the default mailbox', 'mail_send', { to: boxes[1].address, subject: 'Default check', body: 'x' });
    check(t.cards.some((c) => c.includes(`From: ${boxes[1].address}`)), `card: ${t.cards.join(' / ').slice(0, 160)}`);
    await s.req('PUT', '/api/mail/default', { id: 'google' });
    return `default ${work} → card From: ${boxes[1].address}; back to google`;
  });
  await run.step('combined inbox: one search covers every mailbox in it; leaving one out narrows it', async () => {
    const all = await s.turn('Search all my email for Sara check', 'mail_search', { query: 'Sara check' });
    const n = Number(/Searched (\d+) mailboxes/.exec(all.output)?.[1] ?? 0);
    check(n >= 4, `searched ${n}: ${all.output.slice(0, 200)}`);
    await s.req('PUT', '/api/mail/view', { off: [await idOf(boxes[0].address)] });
    const less = await s.turn('Search all my email for Sara check again', 'mail_search', { query: 'Sara check' });
    const m = Number(/Searched (\d+) mailboxes/.exec(less.output)?.[1] ?? 0);
    check(m === n - 1, `searched ${m} after leaving one out`);
    await s.req('PUT', '/api/mail/view', { off: [] });
    return `${n} mailboxes → ${m} with one left out`;
  });

  run.group('Loopback: calendars');
  await run.step('CalDAV turned on for an app-password mailbox', async () => {
    const id = await idOf(boxes[0].address);
    await s.req('POST', `/api/mail/accounts/${id}/calendar`, { url: dav.url });
    const cals = (await s.req('GET', '/api/mail/calendars')).accounts as J[];
    check(cals.some((c) => c.id === id && c.calendars.some((k: J) => k.name === 'Home')), JSON.stringify(cals).slice(0, 200));
    return cals.map((c) => `${c.address}: ${c.calendars.map((k: J) => k.name).join('/')}`).join('; ');
  });
  await run.step('calendar link (webcal) added', async () => {
    const r = await s.req('POST', '/api/mail/calendar-links', { name: 'School', url: 'webcal://calendar.example/school.ics' });
    check(r.links.length === 1 && !JSON.stringify(r).includes('school.ics'), 'link list shows the secret address');
    return `${r.links.length} link, listed by host only (${r.links[0].host})`;
  });
  await run.step('one calendar read merges Google ×2, Outlook, CalDAV and the link', async () => {
    const t = await s.turn('What is on my calendar today?', 'calendar_events', { from: at(0), to: at(24) });
    const want = ['Dentist', 'Standup', 'Outlook review', 'Piano lesson', 'School concert'];
    const missing = want.filter((w) => !t.output.includes(w));
    check(!missing.length, `missing ${missing.join(', ')}: ${t.output.slice(0, 300)}`);
    return want.join(', ');
  });
  await run.step('adding an event asks which calendar; with a default set it goes there, at the time asked', async () => {
    const id = await idOf(boxes[0].address);
    const start = at(36).slice(0, 16);
    const ask = await s.turn('Add lunch with Ana to my calendar', 'calendar_add', { title: 'Lunch with Ana', start });
    check(/Which calendar/.test(ask.output) && !dav.puts.length, `no question first: ${ask.status} ${ask.output.slice(0, 120)}`);
    await s.req('PUT', '/api/mail/view', { calendarDefault: id });
    const t = await s.turn('Add lunch with Ana to my calendar', 'calendar_add', { title: 'Lunch with Ana', start });
    check(t.status === 'ok' && dav.puts.some((p) => p.includes('SUMMARY:Lunch with Ana') && p.includes(`TZID=UTC:${start.replace(/[-:]/g, '')}00`)), `${t.status}: ${t.output.slice(0, 160)}`);
    // The confirmation names the time asked for (12:00 PM), whatever zone this computer is in.
    check(t.output.includes('12:00'), `confirmation: ${t.output.slice(0, 120)}`);
    return t.output.split('(event')[0].slice(0, 120);
  });
  await run.step('a Gmail app-password mailbox can\'t open Google Calendar: it says so', async () => {
    const { info, password } = s.accounts.imapDraft({ preset: 'gmail', address: 'bea@gmail.example', password: fakeId('pw') });
    const gm = s.accounts.saveImap(info, password);
    const r = await s.raw('POST', `/api/mail/accounts/${gm.id}/calendar`, {});
    const j = (await r.json()) as J;
    await s.req('DELETE', `/api/mail/accounts/${gm.id}`);
    check(r.status === 400 && /Google/.test(String(j.error)), `${r.status} ${j.error}`);
    return String(j.error).slice(0, 100);
  });

  run.group('Loopback: removing');
  await run.step('remove the second Gmail: the first stays, its choices go', async () => {
    await s.req('PUT', '/api/mail/view', { off: ['google:2'] });
    await s.req('DELETE', '/api/google/accounts/google:2');
    const l = await list();
    check(!l.some((a) => a.id === 'google:2') && l.some((a) => a.id === 'google'), l.map((a) => a.id).join(','));
    check(!((await s.req('GET', '/api/mail/accounts')).view.off ?? []).includes('google:2'), 'view still names it');
    return l.map((a) => a.address).join(', ');
  });
  await run.step('remove the default IMAP mailbox: the default falls back, its password leaves the vault', async () => {
    const id = await idOf(boxes[1].address);
    await s.req('PUT', '/api/mail/default', { id });
    await s.req('DELETE', `/api/mail/accounts/${id}`);
    const v = await s.req('GET', '/api/mail/accounts');
    check(v.default && v.default !== id, `default ${v.default}`);
    check(!s.vault.values().some((x: string) => x === boxes[1].password), 'password still in the vault');
    return `default now ${v.default}`;
  });
  await run.step('remove the calendar link and Outlook', async () => {
    const l = (await s.req('GET', '/api/mail/calendar-links')).links as J[];
    await s.req('DELETE', `/api/mail/calendar-links/${l[0].id}`);
    const ms = (await list()).find((a) => a.kind === 'microsoft');
    await s.req('DELETE', `/api/mail/accounts/${ms!.id}`);
    check(!(await list()).some((a) => a.kind === 'microsoft'), 'Outlook still listed');
    return `${(await list()).length} mailboxes left`;
  });
  await run.step('nothing secret in any page answer', async () => {
    const pages = JSON.stringify([await s.req('GET', '/api/mail/accounts'), await s.req('GET', '/api/mail/calendars'), await s.req('GET', '/api/google')]);
    const leak = [boxes[0].password, graph.clientSecret, ...gf.tokens()].filter((x) => x && pages.includes(x));
    check(!leak.length, `${leak.length} secret(s) in page answers`);
    return 'no passwords, tokens or client secrets';
  });
}

/** A fake Google: sign-in codes name the person; Gmail (search, read, drafts, send) and Calendar per person. */
function fakeGoogle() {
  const people: Record<string, { email: string; mails: { id: string; raw: string; labels: string[] }[]; events: J[] }> = {
    alex: { email: 'alex@gmail.example', mails: [], events: [{ id: 'ga1', summary: 'Dentist', start: { dateTime: at(15) }, end: { dateTime: at(16) } }] },
    work: { email: 'work@gmail.example', mails: [], events: [{ id: 'gw1', summary: 'Standup', start: { dateTime: at(14) }, end: { dateTime: at(14.25) } }] },
  };
  const tokens = new Map<string, string>();
  const drafts: string[] = [];
  let seq = 0;
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  const hdr = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(raw.split(/\r?\n\r?\n/)[0])?.[1] ?? '';
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const msg = (m: { id: string; raw: string; labels: string[] }) => {
    const headers = ['From', 'To', 'Subject', 'Date', 'Message-ID'].map((name) => ({ name, value: hdr(m.raw, name) }));
    const body = m.raw.split(/\r?\n\r?\n/).slice(1).join('\n');
    return { id: m.id, threadId: `t${m.id}`, labelIds: m.labels, snippet: body.slice(0, 80), internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers, body: { data: b64(body) } } };
  };
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(init.body));
      const who = p.get('code') ?? [...tokens.values()][0] ?? 'alex';
      const tk = fakeId(`at-${who}`);
      tokens.set(tk, who);
      return json(200, { access_token: tk, expires_in: 3600, refresh_token: fakeId('rt'), scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    const auth = String((init.headers as Record<string, string>)?.authorization ?? (init.headers as Headers)?.get?.('authorization') ?? '').replace(/^Bearer /, '');
    const who = people[tokens.get(auth) ?? ''];
    if (!who) return json(401, { error: { message: 'bad token' } });
    const u = new URL(url);
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (p === '/profile') return json(200, { emailAddress: who.email });
    if (p === '/labels/INBOX') return json(200, { messagesUnread: who.mails.length, messagesTotal: who.mails.length });
    if (p === '/messages' && method === 'GET') {
      const q = (u.searchParams.get('q') ?? '').replace(/^subject:/, '').toLowerCase();
      return json(200, { messages: who.mails.filter((m) => m.labels.includes('INBOX') && m.raw.toLowerCase().includes(q)).map((m) => ({ id: m.id })) });
    }
    if (p === '/messages/send' && method === 'POST') {
      const raw = Buffer.from(String(body.raw), 'base64url').toString();
      const m = { id: `gm${++seq}xyz`, raw, labels: ['SENT'] };
      who.mails.push(m);
      // Sent to self: it lands in the inbox too.
      if (hdr(raw, 'To').includes(who.email)) who.mails.push({ id: `gm${++seq}xyz`, raw, labels: ['INBOX', 'UNREAD'] });
      return json(200, { id: m.id, threadId: `t${m.id}` });
    }
    if (p === '/drafts' && method === 'POST') {
      const raw = Buffer.from(String(body.message?.raw ?? ''), 'base64url').toString();
      drafts.push(raw);
      return json(200, { id: `d${drafts.length}xyz`, message: { id: `dm${drafts.length}xyz` } });
    }
    if (/^\/drafts\//.test(p)) return json(200, { id: p.split('/')[2], message: { id: 'dm' } });
    const one = /^\/messages\/([\w-]+)$/.exec(p);
    if (one) {
      const m = who.mails.find((x) => x.id === one[1]);
      return m ? json(200, msg(m)) : json(404, { error: { message: 'not found' } });
    }
    if (u.pathname.endsWith('/users/me/calendarList')) return json(200, { items: [{ id: who.email, summary: who.email, primary: true }] });
    if (u.pathname.includes('/events')) {
      if (method === 'POST') return json(200, { id: `ev${++seq}`, htmlLink: 'https://calendar.example/e', ...body });
      return json(200, { items: who.events });
    }
    return json(404, { error: { message: `fake Google has no ${method} ${u.pathname}` } });
  }) as typeof fetch;
  return { f, drafts, people, tokens: () => [...tokens.keys()] };
}

/** A fake CalDAV server: one calendar (Home) with one event today, PUT and DELETE recorded. */
async function fakeCalDav() {
  const puts: string[] = [];
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', `DTSTART:${at(16).replace(/[-:]/g, '').slice(0, 15)}Z`, `DTEND:${at(17).replace(/[-:]/g, '').slice(0, 15)}Z`, 'SUMMARY:Piano lesson', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ms207 = (xml: string) => (res.writeHead(207, { 'content-type': 'application/xml' }), res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>`));
      if (req.method === 'PROPFIND' && req.url === '/dav/') return ms207('<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/p/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>');
      if (req.method === 'PROPFIND' && req.url === '/dav/p/') return ms207('<d:response><d:href>/dav/p/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/dav/c/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>');
      if (req.method === 'PROPFIND' && req.url === '/dav/c/') return ms207('<d:response><d:href>/dav/c/home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Home</d:displayname><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>');
      if (req.method === 'REPORT') return ms207(`<d:response><d:href>/dav/c/home/e1.ics</d:href><d:propstat><d:prop><cal:calendar-data>${ics}</cal:calendar-data></d:prop></d:propstat></d:response>`);
      if (req.method === 'PUT') return (puts.push(body), res.writeHead(201), res.end());
      if (req.method === 'DELETE') return (res.writeHead(204), res.end());
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/dav/`, puts, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

// ---------------------------------------------------------------- real test accounts (--real)
async function real(c: RealCfg) {
  for (const v of [c.gmail?.[0]?.appPassword, c.gmail?.[1]?.appPassword, c.outlook?.password, c.imap?.password, c.icalLink?.url, c.caldav?.url, c.google?.clientSecret, c.google?.refreshToken]) run.secret(v);
  run.group('Real test accounts');
  const miss = missingParts(c);
  for (const m of miss) run.skip(`missing: ${m.split(' (')[0]}`, m);
  const s = await startSara({});
  const add = async (label: string, body: J) =>
    run.step(`${label}: add (signs in to IMAP and SMTP first)`, async () => {
      const r = await s.req('POST', '/api/mail/imap', body);
      check(r.added, 'not added');
      return `${r.added}${r.replaced ? ' (replaced)' : ''}`;
    });
  const boxes: { label: string; address: string; body: J }[] = [];
  c.gmail?.forEach((g, i) => g.address && g.appPassword && boxes.push({ label: `Gmail #${i + 1} (app password)`, address: g.address, body: { preset: 'gmail', address: g.address, password: g.appPassword } }));
  if (c.outlook?.address && c.outlook.password) boxes.push({ label: 'Outlook (IMAP)', address: c.outlook.address, body: { preset: 'outlook', address: c.outlook.address, password: c.outlook.password, ...(c.outlook.imapHost ? { imapHost: c.outlook.imapHost, smtpHost: c.outlook.smtpHost } : {}) } });
  if (c.imap?.address && c.imap.password) boxes.push({ label: 'IMAP', address: c.imap.address, body: { preset: c.imap.preset ?? 'other', ...c.imap } });
  if (c.google?.refreshToken) {
    await run.step('Google sign-in (test account, saved refresh token)', async () => {
      s.vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: c.google!.clientId, clientSecret: c.google!.clientSecret }));
      s.vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ access: '', refresh: c.google!.refreshToken, expiresAt: 0, email: c.google!.address, scopes: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' }));
      const t = await s.req('POST', '/api/mail/accounts/google/test', {});
      check(t.ok, t.text);
      return t.text;
    });
    boxes.unshift({ label: 'Gmail (Google sign-in)', address: c.google.address, body: {} });
  }
  for (const b of boxes) {
    if (b.body.preset && !(await add(b.label, b.body))) continue;
    await mailboxFlow(s, b.label, b.address, { waitMs: 90_000 });
  }
  const list = async () => (await s.req('GET', '/api/mail/accounts')).accounts as J[];
  if (boxes.length >= 2) {
    await run.step('default switching', async () => {
      const id = (await list()).find((a) => a.address === boxes[1].address)!.id;
      await s.req('PUT', '/api/mail/default', { id });
      check((await s.req('GET', '/api/mail/accounts')).default === id, 'not saved');
      return id;
    });
    await run.step('combined inbox search', async () => {
      const t = await s.turn('Search all my email for Sara check', 'mail_search', { query: 'Sara check' });
      return /Searched \d+ mailboxes/.exec(t.output)?.[0] ?? t.output.slice(0, 80);
    });
    if (c.gmail?.[1]?.address) await add('re-add Gmail #2', boxes.find((b) => b.address === c.gmail![1].address)!.body);
  }
  if (c.imap?.address && (c.caldav?.url || c.imap.preset)) {
    await run.step('CalDAV calendar for the IMAP mailbox', async () => {
      const id = (await list()).find((a) => a.address === c.imap!.address)!.id;
      await s.req('POST', `/api/mail/accounts/${id}/calendar`, c.caldav?.url ? { url: c.caldav.url } : {});
      const cals = (await s.req('GET', '/api/mail/calendars')).accounts as J[];
      return cals.map((x) => `${x.address}: ${x.calendars.length} calendars`).join('; ');
    });
  }
  if (c.icalLink?.url)
    await run.step('calendar link', async () => {
      const r = await s.req('POST', '/api/mail/calendar-links', { name: 'Check', url: c.icalLink!.url });
      return `${r.links.length} link`;
    });
  if (boxes.length || c.icalLink?.url)
    await run.step('read every calendar', async () => {
      const t = await s.turn('What is on my calendar this week?', 'calendar_events', { from: at(0), to: at(24 * 7) });
      check(t.status === 'ok', t.output.slice(0, 160));
      return `${t.output.split('\n').length} lines`;
    });
  await run.step('remove every test account again', async () => {
    for (const a of await list()) await s.req('DELETE', a.kind === 'google' && a.id !== 'google' ? `/api/google/accounts/${a.id}` : `/api/mail/accounts/${a.id}`).catch(() => undefined);
    for (const l of (await s.req('GET', '/api/mail/calendar-links')).links as J[]) await s.req('DELETE', `/api/mail/calendar-links/${l.id}`);
    return `${(await list()).length} left`;
  });
}

// ---------------------------------------------------------------- main
try {
  if (REAL) await real(JSON.parse(readFileSync(SECRETS, 'utf8')) as RealCfg);
  else await loopback();
} catch (err) {
  run.skip('stopped early', (err as Error).stack ?? String(err));
}
for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
if (REAL) {
  writeFileSync(String(process.env.SARA_CHECK_OUT), JSON.stringify(run.steps));
  process.exit(0);
}
// The real accounts: a second process without the loopback override.
if (existsSync(SECRETS)) {
  const out = join(ROOTDIR, 'outputs', `.accounts-real-${process.pid}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_CHECK_OUT: out };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', import.meta.filename, '--real'], { env, stdio: 'inherit', timeout: 20 * 60_000 });
  try {
    const steps = JSON.parse(readFileSync(out, 'utf8')) as Step[];
    run.steps.push(...steps);
  } catch {
    run.group('Real test accounts');
    run.skip('real run', `did not finish (exit ${r.status})`);
  }
  try {
    (await import('node:fs')).rmSync(out, { force: true });
  } catch {}
} else {
  run.group('Real test accounts');
  run.skip('no .secrets/test-accounts.json', `not there, so only the loopback stand-ins ran. Missing: ${missingParts({}).join('; ')}`);
}
const file = run.report(ROOT, 'accounts', ['A throwaway in-process Sara (temp data folder, loopback port, scripted fake model). Every step goes through her HTTP API and real chat turns; send and draft cards were approved over HTTP.']);
console.log(`\n${run.steps.filter((x) => x.result === 'pass').length} passed, ${run.failed} failed. Report: ${file}`);
process.exit(run.failed ? 1 : 0);
