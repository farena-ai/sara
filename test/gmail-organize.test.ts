// Gmail organizing (archive, read, labels, trash, spam … with count-first approval and Undo),
// against a local FAKE Gmail API server: never real Google.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GOOGLE_CLIENT_VAULT, GOOGLE_SCOPES, GOOGLE_TOKEN_VAULT, GoogleAccount, googleApiBase } from '../src/google.ts';
import { exactDates, gmailDates, midnightIn } from '../src/gmail-dates.ts';
import { GmailOrganizer, RECONNECT_TEXT, changeFor, reverse, type GmailAction } from '../src/gmail-organize.ts';
import { createGmailOrganizeTools } from '../src/tools/gmail-organize.ts';
import { cardFor } from '../src/cards.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { JobManager } from '../src/jobs.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { ROOT, call as toolCall, listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const TZ = 'America/Chicago';
const NOW = new Date('2026-10-30T15:00:00Z');

// ---------- the fake Gmail API ----------

interface Msg {
  id: string;
  labels: Set<string>;
  /** Epoch seconds. */
  at: number;
  from: string;
  subject: string;
  unsub?: string;
}

function fakeGmail() {
  const msgs = new Map<string, Msg>();
  const userLabels = new Map<string, string>([['Label_1', 'Receipts']]);
  const log: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const state = { fail429: 0, failBatchOnce: false, delayMs: 0 };
  const add = (n: number, opts: { labels?: string[]; at?: (i: number) => number; from?: (i: number) => string; prefix?: string } = {}) => {
    const start = msgs.size;
    for (let i = 0; i < n; i++) {
      const id = `${opts.prefix ?? 'm'}${String(start + i).padStart(7, '0')}`;
      msgs.set(id, { id, labels: new Set(opts.labels ?? ['INBOX', 'UNREAD']), at: opts.at ? opts.at(i) : midnightIn({ y: 2026, m: 9, d: 1 }, TZ) + i * 60, from: opts.from ? opts.from(i) : `Shop ${i % 3} <news${i % 3}@shop.example>`, subject: `Deal number ${start + i}` });
    }
  };
  const matches = (m: Msg, q: string, spamTrash: boolean) => {
    const terms = q.match(/-?\w+:("[^"]*"|\S+)|\S+/g) ?? [];
    if (!spamTrash && !/\bin:(trash|spam)\b/.test(q) && (m.labels.has('SPAM') || m.labels.has('TRASH'))) return false;
    for (const raw of terms) {
      const neg = raw.startsWith('-');
      const t = neg ? raw.slice(1) : raw;
      const [k, v = ''] = t.split(/:(.*)/s);
      let ok: boolean;
      if (k === 'before') ok = m.at < Number(v);
      else if (k === 'after') ok = m.at >= Number(v);
      else if (k === 'in') ok = m.labels.has(v.toUpperCase());
      else if (k === 'is' && v === 'unread') ok = m.labels.has('UNREAD');
      else if (k === 'is' && v === 'read') ok = !m.labels.has('UNREAD');
      else if (k === 'is') ok = m.labels.has(v.toUpperCase());
      else if (k === 'from') ok = m.from.toLowerCase().includes(v.toLowerCase());
      else if (k === 'category') ok = m.labels.has(`CATEGORY_${v.toUpperCase()}`);
      else if (k === 'label') ok = [...m.labels].some((l) => (userLabels.get(l) ?? l).toLowerCase().replace(/[\s/]+/g, '-') === v.toLowerCase());
      else ok = true;
      if (neg ? ok : !ok) return false;
    }
    return true;
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    log.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, ...(body ? { body } : {}) });
    const json = (status: number, j: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (req.method === 'POST' && state.fail429 > 0) {
      state.fail429--;
      return json(429, { error: { message: 'Too many concurrent requests for user' } });
    }
    if (path === '/profile') return json(200, { emailAddress: 'alex@example.com' });
    if (path === '/messages' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const spamTrash = url.searchParams.get('includeSpamTrash') === 'true';
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      assert.ok(max <= 500, 'maxResults is at most 500');
      const all = [...msgs.values()].filter((m) => matches(m, q, spamTrash)).sort((a, b) => b.at - a.at);
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(from, from + max);
      // resultSizeEstimate is deliberately wrong (as Gmail's often is): Sara must not trust it.
      return json(200, { messages: page.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: 201, ...(from + max < all.length ? { nextPageToken: String(from + max) } : {}) });
    }
    if (path === '/messages/batchModify') {
      const ids = body!.ids as string[];
      if (ids.length > 1000) return json(400, { error: { message: 'too many ids' } });
      if (state.failBatchOnce) {
        state.failBatchOnce = false;
        return json(400, { error: { message: 'Invalid label' } });
      }
      for (const l of [...((body!.addLabelIds as string[]) ?? []), ...((body!.removeLabelIds as string[]) ?? [])]) if (l === 'TRASH') return json(400, { error: { message: 'Invalid label TRASH' } });
      for (const id of ids) {
        const m = msgs.get(id);
        if (!m) continue;
        for (const l of (body!.addLabelIds as string[]) ?? []) m.labels.add(l);
        for (const l of (body!.removeLabelIds as string[]) ?? []) m.labels.delete(l);
      }
      res.writeHead(204);
      return res.end();
    }
    let mm: RegExpExecArray | null;
    if ((mm = /^\/messages\/([\w-]+)\/(trash|untrash)$/.exec(path))) {
      const m = msgs.get(mm[1]);
      if (!m) return json(404, { error: { message: 'not found' } });
      if (mm[2] === 'trash') {
        m.labels.add('TRASH');
        m.labels.delete('INBOX');
      } else {
        m.labels.delete('TRASH');
        m.labels.add('INBOX');
      }
      return json(200, { id: m.id, labelIds: [...m.labels] });
    }
    if ((mm = /^\/messages\/([\w-]+)$/.exec(path))) {
      const m = msgs.get(mm[1]);
      if (!m) return json(404, { error: { message: 'not found' } });
      return json(200, { id: m.id, threadId: m.id, labelIds: [...m.labels], payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(m.at * 1000).toUTCString() }, ...(m.unsub ? [{ name: 'List-Unsubscribe', value: m.unsub }] : [])] } });
    }
    if (path === '/labels' && req.method === 'GET') return json(200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'STARRED', name: 'STARRED', type: 'system' }, ...[...userLabels].map(([id, name]) => ({ id, name, type: 'user' }))] });
    if (path === '/labels' && req.method === 'POST') {
      const id = `Label_${userLabels.size + 1}`;
      userLabels.set(id, String(body!.name));
      return json(200, { id, name: body!.name });
    }
    return json(404, { error: { message: `fake gmail: no route ${path}` } });
  };
  return { msgs, add, log, state, handler, userLabels };
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, opts: { scopes?: string[]; cap?: number; backgroundOver?: number } = {}) {
  const { dir, cleanup } = tempDir();
  const gm = fakeGmail();
  const { server, url } = await listen(gm.handler);
  const clock = { now: NOW };
  const app: TestApp = makeApp(dir, clock);
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const vault = app.vault;
  vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-' + 'fakefakefake' }));
  vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ access: 'ya29.' + 'fake', refresh: '1//' + 'fake', expiresAt: Date.now() + 3600_000 * 24, scopes: (opts.scopes ?? GOOGLE_SCOPES).join(' '), email: 'alex@example.com' }));
  const google = new GoogleAccount(vault, { fetch: globalThis.fetch, apiBase: url });
  app.settings.update({ timeZone: TZ, providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  app.jobs = new JobManager(app, app.store.db);
  const waits: number[] = [];
  const organizer = new GmailOrganizer(google, app.store.db, {
    timeZone: () => TZ,
    now: () => clock.now,
    sleep: async (ms) => void waits.push(ms),
    ...(opts.cap ? { cap: opts.cap } : {}),
    ...(opts.backgroundOver ? { backgroundOver: opts.backgroundOver } : {}),
    jobs: () => app.jobs,
    workspaceOf: (id) => app.store.getConversation(id)?.workspace,
  });
  app.gmail = organizer;
  app.google = google;
  const tools = createGmailOrganizeTools({ google, organizer });
  for (const tool of tools) app.tools.add(tool);
  const tool = Object.fromEntries(tools.map((x) => [x.spec.name, x]));
  const ctx = (conversationId?: string) => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: app.sandbox, ...(conversationId ? { conversationId } : {}) });
  return { app, gm, google, organizer, tool, ctx, waits, clock, url };
}

async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Extract<ChatEvent, { type: 'approval' }>) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}

// ---------- dates ----------

test('gmail dates: natural words → Gmail search words in the owner\'s zone (before: is exclusive)', () => {
  const d = (p: string) => gmailDates(p, TZ, NOW)?.readable;
  assert.equal(d('Oct 1st, 2026 or older'), 'before:2026/10/02');
  assert.equal(d('older than Oct 1 2026'), 'before:2026/10/02');
  assert.equal(d('everything from October 1, 2026 and earlier'), 'before:2026/10/02');
  assert.equal(d('before Oct 1'), 'before:2026/10/01');
  assert.equal(d('before September'), 'before:2026/09/01');
  assert.equal(d('last week'), 'after:2026/10/19 before:2026/10/26');
  assert.equal(d('since Oct 1'), 'after:2026/10/01');
  assert.equal(d('after Oct 1'), 'after:2026/10/02');
  assert.equal(d('between Mar 1 and Mar 31'), 'after:2026/03/01 before:2026/04/01');
  assert.equal(d('older than 6 months'), 'older_than:6m');
  assert.equal(d('10/1/2026 or older'), 'before:2026/10/02');
  assert.equal(d('September'), 'after:2026/09/01 before:2026/10/01');
  assert.equal(d('December'), 'after:2025/12/01 before:2026/01/01', 'a month name without a year is the most recent one');
  assert.equal(gmailDates('from the boss', TZ, NOW), undefined);
  // The exact form is midnight in the owner's zone (Chicago is UTC-5 in October), not Pacific time.
  const exact = gmailDates('Oct 1st, 2026 or older', TZ, NOW)!.exact;
  assert.equal(exact, `before:${Date.parse('2026-10-02T05:00:00Z') / 1000}`);
  assert.equal(gmailDates('Oct 1st, 2026 or older', 'Europe/Berlin', NOW)!.exact, `before:${Date.parse('2026-10-01T22:00:00Z') / 1000}`);
  assert.equal(exactDates('from:a before:2026/10/02 in:inbox', TZ), `from:a before:${Date.parse('2026-10-02T05:00:00Z') / 1000} in:inbox`);
  // Daylight saving: Nov 2 2026 in Chicago is after the switch back (UTC-6).
  assert.equal(midnightIn({ y: 2026, m: 11, d: 2 }, TZ), Date.parse('2026-11-02T06:00:00Z') / 1000);
});

// ---------- the organizer ----------

test('gmail organize: count by paging ids (not the estimate), batchModify in chunks of 1,000, archive only what is in the inbox', async (t) => {
  const { gm, organizer, tool, ctx, app } = await setup(t, { backgroundOver: 100_000 });
  gm.add(2345);
  gm.add(10, { labels: ['UNREAD'], prefix: 'a' }); // already archived: not counted, not touched
  gm.add(7, { at: () => midnightIn({ y: 2026, m: 10, d: 5 }, TZ) }); // newer: not matched
  const conv = app.store.createConversation();
  const prep = await tool.gmail_organize.prepare!({ action: 'archive', dates: 'Oct 1st, 2026 or older' }, { signal: new AbortController().signal, conversationId: conv.id });
  assert.equal(prep.detail?.count, 2345);
  assert.equal(prep.detail?.query, 'before:2026/10/02 in:inbox');
  assert.match(prep.summary!, /^Archive 2,345 emails matching before:2026\/10\/02 in:inbox\?$/);
  const lists = gm.log.filter((l) => l.path.startsWith('/messages?'));
  assert.equal(lists.length, 5, '2,345 ids are 5 pages of 500');
  const out = await tool.gmail_organize.run({ action: 'archive', dates: 'Oct 1st, 2026 or older' }, ctx(conv.id));
  const batches = gm.log.filter((l) => l.path === '/messages/batchModify');
  assert.deepEqual(batches.map((b) => (b.body!.ids as string[]).length), [1000, 1000, 345]);
  assert.deepEqual(batches[0].body!.removeLabelIds, ['INBOX']);
  assert.match(out, /Done: 2,345 of 2,345 emails archived/);
  assert.equal([...gm.msgs.values()].filter((m) => m.labels.has('INBOX')).length, 7);
  // The run used the counted plan: no second count.
  assert.equal(gm.log.filter((l) => l.path.startsWith('/messages?')).length, 5);
  const card = cardFor({ name: 'gmail_organize', args: {}, status: 'ok', output: out });
  assert.equal(card?.kind, 'gmail');
  if (card?.kind === 'gmail') {
    assert.equal(card.done, 2345);
    assert.match(card.id, /^g_/);
    assert.equal(card.link, `https://mail.google.com/mail/u/0/#search/${encodeURIComponent('before:2026/10/02 in:inbox')}`);
  }
  // The cap: the count stops there and the card says "at least".
  const capped = new GmailOrganizer(app.google as GoogleAccount, app.store.db, { timeZone: () => TZ, cap: 600 });
  const p = await capped.plan({ action: 'star', query: 'from:shop.example' }, 'k');
  assert.equal(p.ids.length, 600);
  assert.equal(p.capped, true);
});

test('gmail organize: every action maps to the right labels, and undo reverses exactly those emails', async (t) => {
  const { gm, organizer } = await setup(t);
  const cases: [GmailAction, { add: string[]; remove: string[]; per?: string }][] = [
    ['archive', { add: [], remove: ['INBOX'] }],
    ['read', { add: [], remove: ['UNREAD'] }],
    ['unread', { add: ['UNREAD'], remove: [] }],
    ['star', { add: ['STARRED'], remove: [] }],
    ['unstar', { add: [], remove: ['STARRED'] }],
    ['important', { add: ['IMPORTANT'], remove: [] }],
    ['not_important', { add: [], remove: ['IMPORTANT'] }],
    ['label', { add: ['Label_1'], remove: [] }],
    ['unlabel', { add: [], remove: ['Label_1'] }],
    ['spam', { add: ['SPAM'], remove: ['INBOX'] }],
    ['not_spam', { add: ['INBOX'], remove: ['SPAM'] }],
    ['trash', { add: [], remove: [], per: 'trash' }],
    ['untrash', { add: [], remove: [], per: 'untrash' }],
  ];
  for (const [a, want] of cases) assert.deepEqual(changeFor(a, 'Label_1'), want, a);
  assert.deepEqual(reverse(changeFor('spam')), { add: ['INBOX'], remove: ['SPAM'] });
  assert.deepEqual(reverse(changeFor('trash')), { add: [], remove: [], per: 'untrash' });

  // A real round trip: mark read, star, label (a new one), then undo each, in reverse.
  gm.add(6, { labels: ['INBOX', 'UNREAD'] });
  gm.add(4, { labels: ['INBOX'], prefix: 'r' }); // already read: "read" must not touch them, so undo must not mark them unread
  const snapshot = () => JSON.stringify([...gm.msgs.values()].map((m) => [m.id, [...m.labels].sort()]));
  const before = snapshot();
  const read = await organizer.run(await organizer.plan({ action: 'read', query: 'from:shop.example' }, 'a'));
  assert.equal(read.done, 6);
  const star = await organizer.run(await organizer.plan({ action: 'star', query: 'from:shop.example' }, 'b'));
  assert.equal(star.done, 10);
  const lab = await organizer.run(await organizer.plan({ action: 'label', query: 'from:shop.example', label: 'Bills 2026' }, 'c'), { createLabel: true });
  assert.equal(lab.label, 'Bills 2026');
  assert.ok([...gm.userLabels.values()].includes('Bills 2026'), 'the label was made');
  // Without createLabel an unknown label is refused before anything changes.
  await assert.rejects(organizer.run(await organizer.plan({ action: 'label', query: 'from:shop.example', label: 'Nope' }, 'd')), /no label called "Nope"/);
  for (const o of [lab, star, read]) assert.equal((await organizer.undo(o.actionId!)).done, o.done);
  assert.equal(snapshot(), before, 'undo put every email back exactly as it was');
  await assert.rejects(organizer.undo(read.actionId!), /already undone/);
});

test('gmail organize: trash goes message by message (batchModify cannot add TRASH); untrash undoes it; 429 backs off', async (t) => {
  const { gm, organizer, waits } = await setup(t);
  gm.add(9, { labels: ['INBOX'] });
  gm.state.fail429 = 2;
  const o = await organizer.run(await organizer.plan({ action: 'trash', query: 'from:shop.example' }, 'k'));
  assert.equal(o.done, 9);
  assert.equal(o.failed, 0);
  assert.equal(gm.log.filter((l) => /\/trash$/.test(l.path)).length, 11, 'nine trash calls plus two answered 429');
  assert.equal(gm.log.filter((l) => l.path === '/messages/batchModify').length, 0);
  assert.deepEqual(waits, [1000, 1000], 'each 429 waited (the first back-off step) and tried again');
  assert.ok([...gm.msgs.values()].every((m) => m.labels.has('TRASH')));
  // Counting ignores the trash unless the change is about it.
  assert.equal((await organizer.plan({ action: 'archive', query: 'from:shop.example' }, 'x')).ids.length, 0);
  assert.equal((await organizer.plan({ action: 'untrash', query: 'from:shop.example' }, 'y')).ids.length, 9);
  await organizer.undo(o.actionId!);
  assert.ok([...gm.msgs.values()].every((m) => !m.labels.has('TRASH') && m.labels.has('INBOX')));
  // Back-off doubles: 1 s, 2 s, 4 s …; a 400 isn't retried and the chunk counts as failed.
  waits.length = 0;
  gm.state.fail429 = 3;
  await organizer.run(await organizer.plan({ action: 'star', query: 'from:shop.example' }, 'z'));
  assert.deepEqual(waits, [1000, 2000, 4000]);
  gm.state.failBatchOnce = true;
  const bad = await organizer.run(await organizer.plan({ action: 'unstar', query: 'from:shop.example' }, 'w'));
  assert.equal(bad.failed, 9);
  assert.match(bad.error ?? '', /Invalid label/);
  // Undo works for 30 days only.
  const ok = await organizer.run(await organizer.plan({ action: 'read', ids: ['m0000000', 'm0000001'] }, 'v'));
  assert.equal(ok.done, 2);
});

test('gmail organize in a chat turn: count-first approval card (count, query, samples); trash and spam always ask; undo by the tool', async (t) => {
  const { gm, app } = await setup(t);
  gm.add(3);
  gm.add(2, { at: () => midnightIn({ y: 2026, m: 10, d: 20 }, TZ), prefix: 'n' });
  const conv = app.store.createConversation();
  app.script.push([toolCall('c1', 'gmail_organize', { action: 'archive', dates: 'Oct 1st, 2026 or older' })], text('Archived them.'));
  let card: Extract<ChatEvent, { type: 'approval' }> | undefined;
  const evs = await drain(runTurn(app, conv.id, 'archive all my email from Oct 1st 2026 or older'), (ev) => {
    card = ev;
    app.approvals.decide(ev.approvalId, true);
  });
  assert.ok(card, 'it asked first');
  assert.equal(card!.summary, 'Archive 3 emails matching before:2026/10/02 in:inbox?');
  assert.equal(card!.detail?.kind, 'gmail');
  assert.equal(card!.detail?.count, 3);
  assert.equal(card!.detail?.query, 'before:2026/10/02 in:inbox');
  assert.equal(card!.detail?.samples.length, 3);
  assert.match(card!.detail!.samples[0].subject, /^Deal number/);
  assert.equal(card!.detail?.alwaysAsks, false);
  const res = evs.find((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.equal(res.status, 'ok');
  assert.equal(res.card?.kind, 'gmail');
  assert.equal([...gm.msgs.values()].filter((m) => m.labels.has('INBOX')).length, 2);

  // Allowed to run on its own: archive goes without a card, trash still asks (and Deny changes nothing).
  app.settings.update({ toolPermissions: { gmail_organize: 'auto', gmail_undo: 'auto' } });
  app.script.push([toolCall('c2', 'gmail_organize', { action: 'read', query: 'from:shop.example' })], text('Done.'), [toolCall('c3', 'gmail_organize', { action: 'trash', query: 'from:shop.example' })], text('Okay.'));
  let asked = 0;
  await drain(runTurn(app, conv.id, 'mark them all as read'), () => asked++);
  assert.equal(asked, 0);
  assert.ok([...gm.msgs.values()].every((m) => !m.labels.has('UNREAD')));
  let trashCard: Extract<ChatEvent, { type: 'approval' }> | undefined;
  await drain(runTurn(app, conv.id, 'now trash them'), (ev) => {
    trashCard = ev;
    app.approvals.decide(ev.approvalId, false);
  });
  assert.equal(trashCard?.detail?.alwaysAsks, true);
  assert.match(trashCard!.summary, /^Move to trash 5 emails/);
  assert.ok([...gm.msgs.values()].every((m) => !m.labels.has('TRASH')), 'denied: nothing moved');

  // "Undo that": the newest change in this conversation (mark as read) is reversed exactly.
  app.script.push([toolCall('c4', 'gmail_undo', {})], text('Undone.'));
  await drain(runTurn(app, conv.id, 'undo that'));
  assert.equal([...gm.msgs.values()].filter((m) => m.labels.has('UNREAD')).length, 5);
  // Nothing matches: no card, nothing changed.
  app.settings.update({ toolPermissions: {} });
  app.script.push([toolCall('c5', 'gmail_organize', { action: 'archive', query: 'from:nobody.example' })], text('Nothing.'));
  let none = 0;
  const e5 = await drain(runTurn(app, conv.id, 'archive mail from nobody'), () => none++);
  assert.equal(none, 0);
  assert.match((e5.find((e) => e.type === 'tool_result') as { output: string }).output, /No emails match/);
});

test('gmail organize: an older sign-in without gmail.modify gets the reconnect message; Settings sees canOrganize', async (t) => {
  const { app, google, gm } = await setup(t, { scopes: GOOGLE_SCOPES.filter((s) => !s.endsWith('gmail.modify')) });
  gm.add(3);
  assert.equal(google.status().gmail, true);
  assert.equal(google.status().canOrganize, false);
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/gmail.modify'));
  assert.ok(!GOOGLE_SCOPES.some((s) => /mail\.google\.com\/?$/.test(s)), 'never the full-access scope (permanent delete)');
  const conv = app.store.createConversation();
  app.script.push([toolCall('c1', 'gmail_organize', { action: 'archive', query: 'in:inbox' })], text('I need you to reconnect.'));
  let asked = 0;
  const evs = await drain(runTurn(app, conv.id, 'archive everything'), () => asked++);
  assert.equal(asked, 0);
  const res = evs.find((e) => e.type === 'tool_result') as { output: string };
  assert.equal(res.output, RECONNECT_TEXT);
  assert.match(RECONNECT_TEXT, /Reconnect Google in Settings/);
  assert.equal(gm.log.filter((l) => l.method === 'POST').length, 0);
});

test('gmail organize: private local mode blocks it; the test-only API base takes loopback only', async (t) => {
  const { app, gm } = await setup(t);
  gm.add(2);
  // A model on this computer (private local mode allows only loopback).
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' }] });
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  const conv = app.store.createConversation();
  app.script.push([toolCall('c1', 'gmail_organize', { action: 'archive', query: 'in:inbox' })], text('It is paused.'));
  const evs = await drain(runTurn(app, conv.id, 'archive my inbox'));
  const req = app.requests.at(-1)!;
  assert.ok(!req.tools?.some((x) => x.name.startsWith('gmail_')), 'the Gmail tools are not even offered');
  const res = evs.find((e) => e.type === 'tool_result') as { status: string; output: string };
  assert.equal(res.status, 'denied');
  assert.equal(gm.log.length, 0, 'nothing reached Gmail');
  assert.equal(googleApiBase({ SARA_GOOGLE_API_BASE: 'http://127.0.0.1:7899' }), 'http://127.0.0.1:7899');
  assert.equal(googleApiBase({ SARA_GOOGLE_API_BASE: 'https://evil.example.com' }), undefined);
  assert.equal(googleApiBase({}), undefined);
});

test('gmail organize: owner only (members and the demo never get it); other apps only through her approval rules', () => {
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  const block = main.slice(main.indexOf('if (!isMember) {\n    for (const t of createBrowserTools(app))'), main.indexOf('// Phase 38: meaning search'));
  assert.match(block, /if \(!isDemo\) \{\s+app\.gmail = new GmailOrganizer/);
  assert.match(block, /createGmailOrganizeTools/);
  assert.equal(main.match(/createGmailOrganizeTools\(/g)?.length, 1, 'registered in one place only');
  assert.match(main, /\.\.\.\(isMember \? \{\} : \{ google \}\)/, 'members have no Google account at all');
  // The Undo button's route lives under /api/google (owner-only for members, refused on the demo).
  const routes = readFileSync(join(ROOT, 'src', 'routes', 'connections.ts'), 'utf8');
  assert.match(routes, /if \(a === 'google'\) \{[\s\S]*?b === 'undo' && c && method === 'POST'[\s\S]*?const gm = app\.gmail;\s+if \(!gm\) throw new HttpError\(404/);
  // Other apps (MCP) have no Gmail tools of their own; /v1 turns stop at any approval.
  const mcp = readFileSync(join(ROOT, 'src', 'mcp-server.ts'), 'utf8');
  assert.ok(!/gmail/i.test(mcp));
});

test('gmail organize: a big set runs as a background job with progress, can be stopped, and keeps an Undo card for what it did', async (t) => {
  const { gm, app, tool, ctx, organizer } = await setup(t, { backgroundOver: 50 });
  gm.add(400, { labels: ['INBOX'] });
  const conv = app.store.createConversation();
  const seen: { status: string; tail: string }[] = [];
  app.events!.subscribe((ev) => {
    if (ev.type === 'job') seen.push({ status: (ev as { job: { status: string } }).job.status, tail: (ev as { job: { tail: string } }).job.tail });
  });
  gm.state.delayMs = 4;
  const out = await tool.gmail_organize.run({ action: 'trash', query: 'from:shop.example' }, ctx(conv.id));
  const id = Number(/^Started background job #(\d+)/.exec(out)?.[1]);
  assert.ok(id > 0, out);
  assert.equal(cardFor({ name: 'gmail_organize', args: {}, status: 'ok', output: out })?.kind, 'job');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(app.jobs!.stop(id), 'Stop works like any background job');
  for (let i = 0; i < 100 && app.jobs!.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 30));
  const job = app.jobs!.get(id)!;
  assert.equal(job.status, 'stopped');
  const trashed = [...gm.msgs.values()].filter((m) => m.labels.has('TRASH')).length;
  assert.ok(trashed > 0 && trashed < 400, `stopped part way (${trashed})`);
  assert.ok(seen.some((s) => /Moving to trash: \d+ of 400 done/.test(s.tail)), 'progress lines on the strip');
  const notice = app.store.messages(conv.id).find((m) => m.role === 'notice');
  const card = notice?.meta?.card as { kind: string; done: number; id: string; stopped?: boolean } | undefined;
  assert.equal(card?.kind, 'gmail');
  assert.equal(card?.done, trashed);
  assert.equal(card?.stopped, true);
  // Undo reverses exactly what was done, and only within 30 days.
  gm.state.delayMs = 0;
  const u = await organizer.undo(card!.id);
  assert.equal(u.done, trashed);
  assert.equal([...gm.msgs.values()].filter((m) => m.labels.has('TRASH')).length, 0);
  const again = await organizer.run(await organizer.plan({ action: 'archive', ids: ['m0000001'] }, 'q'));
  const later = new GmailOrganizer(app.google!, app.store.db, { timeZone: () => TZ, now: () => new Date(NOW.getTime() + 31 * 86_400_000) });
  assert.match(later.undoProblem(again.actionId!) ?? '', /no Gmail change|more than 30 days/);
});

test('gmail organize: a change she makes clears the Today mail cache (the tile asks Gmail again)', () => {
  const src = readFileSync(join(ROOT, 'src', 'gmail-organize.ts'), 'utf8');
  const rec = src.slice(src.indexOf('#record('), src.indexOf('#record(') + 600);
  assert.match(rec, /forgetTodayMail\(\)/);
  assert.match(readFileSync(join(ROOT, 'src', 'today.ts'), 'utf8'), /export function forgetTodayMail\(\): void \{\n  cache = undefined;/);
});
