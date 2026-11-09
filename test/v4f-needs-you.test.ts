// 3.0.3 (docs/ops/V4_DESIGN.md → V4f): the sidebar's red "needs you" dot. The conversation list says
// which chats need the person (a waiting approval, her question, a failed run not seen yet), live via
// the `needs` event; opening the chat clears a failed run; each space only sees its own chats.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import type { HubEvent } from '../src/events.ts';
import { needsYouMap, wireNeedsYou } from '../src/needs-you.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const fnOf = (src: string, name: string) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';

function fixture() {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-09T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.runs = new RunStore(app.store.db, () => clock.now);
  return { dir, cleanup, clock, app };
}

test('V4f needs you: approvals, her questions and unseen failed runs, most urgent reason first', () => {
  const { app, cleanup } = fixture();
  try {
    const a = app.store.createConversation({ title: 'A' });
    const b = app.store.createConversation({ title: 'B' });
    const c = app.store.createConversation({ title: 'C' });
    const d = app.store.createConversation({ title: 'D' });
    assert.equal(needsYouMap(app).size, 0);
    // A waiting approval; it ends when answered.
    const ctl = new AbortController();
    const req = app.approvals.request(a.id, ctl.signal);
    assert.deepEqual(needsYouMap(app).get(a.id), { reason: 'approval', count: 1 });
    // A failed turn in B; a stopped one and a restart-interrupted one in C don't count.
    const r1 = app.runs!.open({ kind: 'turn', conversationId: b.id });
    app.runs!.close(r1, 'error', 0, Date.now());
    const r2 = app.runs!.open({ kind: 'turn', conversationId: c.id });
    app.runs!.close(r2, 'stopped', 0, Date.now());
    const r3 = app.runs!.open({ kind: 'turn', conversationId: c.id });
    app.runs!.close(r3, 'interrupted', 0, Date.now());
    assert.deepEqual(needsYouMap(app).get(b.id), { reason: 'failed', count: 1 });
    assert.equal(needsYouMap(app).has(c.id), false);
    // Her questions: a board card parked on card_ask and a team checkpoint.
    app.cardWork = { questions: () => [{ work: { conversationId: d.id } }] } as never;
    app.team = { running: () => [{ id: 7, conversationId: b.id }], approvals: () => [{}], waitingConversations: () => [a.id] } as never;
    const m = needsYouMap(app);
    assert.deepEqual(m.get(d.id), { reason: 'question', count: 1 });
    // B: a team step approval outranks the failed run; A: approval + checkpoint question.
    assert.deepEqual(m.get(b.id), { reason: 'approval', count: 2 });
    assert.deepEqual(m.get(a.id), { reason: 'approval', count: 2 });
    app.cardWork = undefined;
    app.team = undefined;
    // Answered: the approval is gone. Seen: the failed run is too, until a newer run fails.
    app.approvals.decide(req.id, false);
    assert.equal(needsYouMap(app).has(a.id), false);
    assert.equal(app.runs!.markSeen(b.id), true);
    assert.equal(app.runs!.markSeen(b.id), false);
    assert.equal(needsYouMap(app).has(b.id), false);
    const r4 = app.runs!.open({ kind: 'turn', conversationId: b.id });
    app.runs!.close(r4, 'ok', 0, Date.now());
    const r5 = app.runs!.open({ kind: 'job', conversationId: b.id });
    app.runs!.close(r5, 'error', 0, Date.now());
    assert.equal(needsYouMap(app).get(b.id)?.reason, 'failed');
    // A run running while the chat was opened and failing later still needs the person.
    app.runs!.markSeen(b.id);
    const r6 = app.runs!.open({ kind: 'turn', conversationId: b.id });
    app.runs!.markSeen(b.id);
    app.runs!.close(r6, 'error', 0, Date.now());
    assert.equal(needsYouMap(app).get(b.id)?.reason, 'failed');
    ctl.abort();
  } finally {
    app.store.close();
    cleanup();
  }
});

test('V4f needs you: old failures (more than three days) never light up after the update', () => {
  const { app, clock, cleanup } = fixture();
  try {
    const a = app.store.createConversation({ title: 'A' });
    const r = app.runs!.open({ kind: 'turn', conversationId: a.id });
    app.runs!.close(r, 'error', 0, Date.now());
    clock.now = new Date('2026-11-13T12:00:00Z');
    assert.equal(needsYouMap(app).has(a.id), false);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('V4f needs you: a waiting approval publishes `needs` when it starts and ends (wired once)', () => {
  const { app, cleanup } = fixture();
  try {
    const conv = app.store.createConversation({ title: 'A' });
    const seen: HubEvent[] = [];
    app.events!.subscribe((ev) => seen.push(ev));
    wireNeedsYou(app);
    wireNeedsYou(app);
    const ctl = new AbortController();
    const r = app.approvals.request(conv.id, ctl.signal);
    app.approvals.decide(r.id, true);
    const needs = seen.filter((e) => e.type === 'needs');
    assert.deepEqual(needs.map((e) => (e as { conversationId: string }).conversationId), [conv.id, conv.id]);
    // An abort ends it too.
    const ctl2 = new AbortController();
    app.approvals.request(conv.id, ctl2.signal);
    ctl2.abort();
    assert.equal(seen.filter((e) => e.type === 'needs').length, 4);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('V4f needs you: the conversation list carries needsYou; opening the chat or POST seen clears a failed run', async () => {
  const { app, dir, cleanup } = fixture();
  const auth = new OwnerAuth(dir, () => app.now());
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const req = (path: string, method = 'GET') => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }).then((r) => r.json());
  const events: HubEvent[] = [];
  app.events!.subscribe((ev) => events.push(ev));
  try {
    const a = app.store.createConversation({ title: 'A' });
    const b = app.store.createConversation({ title: 'B' });
    const r1 = app.runs!.open({ kind: 'turn', conversationId: a.id });
    app.runs!.close(r1, 'error', 0, Date.now());
    const r2 = app.runs!.open({ kind: 'turn', conversationId: b.id });
    app.runs!.close(r2, 'error', 0, Date.now());
    const ctl = new AbortController();
    app.approvals.request(b.id, ctl.signal);
    const list = async () => {
      const r = await req('/conversations?cap=200');
      return new Map((r.conversations as { id: string; needsYou?: unknown }[]).map((c) => [c.id, c.needsYou]));
    };
    let m = await list();
    assert.deepEqual(m.get(a.id), { reason: 'failed', count: 1 });
    assert.deepEqual(m.get(b.id), { reason: 'approval', count: 2 });
    // The plain list (older apps) carries it too.
    const plain = (await req('/conversations')) as { id: string; needsYou?: unknown }[];
    assert.deepEqual(plain.find((c) => c.id === a.id)?.needsYou, { reason: 'failed', count: 1 });
    // Opening A clears its failed run (and tells other tabs).
    await req(`/conversations/${a.id}`);
    assert.ok(events.some((e) => e.type === 'needs' && e.conversationId === a.id));
    // The open chat watched B's failure live: POST seen; the approval still waits.
    assert.deepEqual(await req(`/conversations/${b.id}/seen`, 'POST'), { ok: true });
    m = await list();
    assert.equal(m.get(a.id), undefined);
    assert.deepEqual(m.get(b.id), { reason: 'approval', count: 1 });
    ctl.abort();
    m = await list();
    assert.equal(m.get(b.id), undefined);
  } finally {
    await new Promise((r) => server.close(r));
    app.store.close();
    cleanup();
  }
});

test('V4f needs you: household isolation: each space only sees its own chats', () => {
  const owner = fixture();
  const member = fixture();
  try {
    const mine = owner.app.store.createConversation({ title: 'Mine' });
    const theirs = member.app.store.createConversation({ title: 'Theirs' });
    const c1 = new AbortController();
    const c2 = new AbortController();
    member.app.approvals.request(theirs.id, c1.signal);
    const r = member.app.runs!.open({ kind: 'turn', conversationId: theirs.id });
    member.app.runs!.close(r, 'error', 0, Date.now());
    owner.app.approvals.request(mine.id, c2.signal);
    assert.deepEqual([...needsYouMap(owner.app).keys()], [mine.id]);
    assert.deepEqual([...needsYouMap(member.app).keys()], [theirs.id]);
    // A shared board's cards come through the space's own card worker (it keeps only that person's work).
    const cw = readFileSync(join(ROOT, 'src', 'board-work.ts'), 'utf8');
    assert.match(cw, /questions\(\): WorkCard\[\] \{[\s\S]*?if \(this\.#mine\(c\.work\)\) out\.push\(c\);/);
    c1.abort();
    c2.abort();
  } finally {
    owner.app.store.close();
    member.app.store.close();
    owner.cleanup();
    member.cleanup();
  }
});

test('V4f needs you: the sidebar draws a red dot with its reason and a red count on the folder row', () => {
  const app = web('app.js');
  const row = fnOf(app, 'convRow');
  // The V4d state line stays; needs-you is its own attribute and a labelled dot.
  assert.match(row, /a\.dataset\.state = c\.working \? 'working' : c\.endedAt \? 'ended' : c\.id === state\.currentId \? 'open' : 'idle';/);
  assert.match(row, /if \(c\.needsYou\) \{[\s\S]*?a\.dataset\.needs = c\.needsYou\.reason;[\s\S]*?needsLabel\(c\.needsYou\)/);
  assert.match(row, /setAttribute\('role', 'img'\)/);
  assert.match(row, /setAttribute\('aria-label', label\)/);
  const nl = fnOf(app, 'needsLabel');
  for (const s of ['An approval is waiting for you', 'She asked you something', 'Something failed here']) assert.ok(nl.includes(`t('${s}')`), s);
  const g = fnOf(app, 'group');
  assert.match(g, /const needing = convs\.filter\(\(c\) => c\.needsYou\)\.length;/);
  assert.match(g, /el\('small', 'group-needs', String\(needing\)\)/);
  // Live: `needs`, team and board events reload the list (debounced); a failure seen live is marked seen.
  assert.match(app, /es\.addEventListener\('needs', \(\) => needsReload\(\)\)/);
  assert.match(app, /api\(`\/conversations\/\$\{conversationId\}\/seen`, \{ method: 'POST'/);
  const css = web('v4-pages.css');
  assert.ok(css.includes('#conversations a.conv[data-needs]::before'));
  assert.match(css, /\.group-needs \{[^}]*background: var\(--danger/);
  assert.match(css, /\.conv-needs \{/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8');
    for (const s of ['An approval is waiting for you', 'She asked you something', 'Something failed here', '{n} chats need you', '1 chat needs you']) assert.ok(tr.includes(`"${s}":`), `${lang}: ${s}`);
  }
});
