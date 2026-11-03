// Phase 76 (harness track M1, docs/design/HARNESS_TRACK.md §4.5): ranked memory injection with a
// sureness and a reason per note, tunable decay, pinning. The numbered tests follow the design.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { exportAll, importAll } from '../src/export.ts';
import { memberRouteCheck, type MemberRecord } from '../src/household.ts';
import { type Memory, MemoryStore, selectMemories } from '../src/memory.ts';
import { clampDecay, decayPolicy, DEFAULT_DECAY, explainPolicy, rankMemories, scoreCandidates, type Candidate } from '../src/memory-rank.ts';
import { sharedWithApps } from '../src/recall.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const TODAY = '2026-10-24';

function setup(t: { after: (fn: () => void) => void }): { app: TestApp; mem: MemoryStore } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago' });
  return { app, mem: app.memory! };
}

const add = (mem: MemoryStore, kind: Memory['kind'], content: string, happenedOn: string, conversationId: string | null = null) => mem.add({ kind, content, conversationId, sourceMessageId: null, happenedOn });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const NORMAL = decayPolicy({ fade: 'normal' });
const NEVER = decayPolicy({ fade: 'never' });

test('1+2: words+meaning above words only above standing; sureness high / medium / low; pinned+match = high', (t) => {
  const { mem } = setup(t);
  const both = add(mem, 'fact', "Alex's dog is a beagle named Biscuit.", daysAgo(3));
  const words = add(mem, 'fact', 'Alex walks the dog before work.', daysAgo(3));
  const standing = add(mem, 'fact', 'Alex prefers tea in the morning.', daysAgo(3));
  const meaningOnly = add(mem, 'fact', 'Alex has a small hound that howls.', daysAgo(3));
  const ranked = rankMemories(mem, { query: "what's my dog's name?", conversationId: 'c', oldestHistoryId: 0, related: [{ memory: mem.get(both.id)!, score: 0.8 }, { memory: mem.get(meaningOnly.id)!, score: 0.7 }], policy: NORMAL, today: TODAY });
  const at = (id: number) => ranked.findIndex((p) => p.memoryId === id);
  const pick = (id: number) => ranked.find((p) => p.memoryId === id)!;
  assert.ok(at(both.id) < at(words.id), 'words + meaning first');
  assert.ok(at(words.id) < at(standing.id), 'a match above a standing note');
  assert.equal(pick(both.id).confidence, 'high');
  assert.deepEqual(pick(both.id).why, ['words "dog", "name"', 'meaning'], '"named" counts for "name"');
  assert.equal(pick(words.id).confidence, 'medium');
  assert.equal(pick(meaningOnly.id).confidence, 'medium');
  assert.equal(pick(standing.id).confidence, 'low');
  assert.deepEqual(pick(standing.id).why, ['standing fact']);
  mem.setPinned(words.id, true);
  const again = rankMemories(mem, { query: "what's my dog's name?", conversationId: 'c', oldestHistoryId: 0, policy: NORMAL, today: TODAY });
  const pw = again.find((p) => p.memoryId === words.id)!;
  // A pinned note that didn't match sits at the top of the standing notes, never above a match.
  mem.setPinned(standing.id, true);
  const third = rankMemories(mem, { query: "what's my dog's name?", conversationId: 'c', oldestHistoryId: 0, policy: NORMAL, today: TODAY });
  assert.ok(third.findIndex((p) => p.memoryId === standing.id) > third.findIndex((p) => p.memoryId === words.id));
  assert.ok(third.filter((p) => !p.standing).every((p) => third.indexOf(p) < third.findIndex((q) => q.memoryId === standing.id)), 'matches first');
  // A loose FTS-only hit (porter: "one" ~ "on") is a weak match, said so.
  const sunday = add(mem, 'promise', 'Alex will call his mom on Sunday.', daysAgo(1));
  const loose = rankMemories(mem, { query: 'one more episode', conversationId: 'c', oldestHistoryId: 0, policy: NORMAL, today: TODAY }).find((p) => p.memoryId === sunday.id)!;
  assert.deepEqual([loose.why, loose.confidence, loose.standing], [['similar words'], 'low', false]);
  assert.equal(pw.confidence, 'high', 'pinned + a match');
  assert.ok(pw.score >= 0.9, 'pinned floored at 0.9');
});

test('3: decay weighs an old matched note lower but it still goes in; with "never" the two score the same', (t) => {
  const { mem } = setup(t);
  const fresh = add(mem, 'fact', 'Alex plays the trumpet in a band.', daysAgo(30));
  const old = add(mem, 'fact', 'Alex bought a new trumpet mouthpiece.', daysAgo(400));
  const q = { query: 'trumpet', conversationId: 'c', oldestHistoryId: 0, today: TODAY };
  const r = rankMemories(mem, { ...q, policy: NORMAL });
  const s = (id: number, rr = r) => rr.find((p) => p.memoryId === id)!;
  assert.ok(s(old.id).score < s(fresh.id).score, 'older scores lower');
  assert.equal(s(old.id).old, true);
  const inj = selectMemories(mem, { userText: 'trumpet', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: NORMAL, today: TODAY });
  assert.ok(inj.ids.includes(old.id), 'a matched note is always eligible');
  assert.match(inj.text, /mouthpiece\. \[why: words "trumpet"; sure: medium; older, may be out of date\]/);
  const n = rankMemories(mem, { ...q, policy: NEVER });
  assert.equal(s(old.id, n).score, s(fresh.id, n).score, 'never fade: same score');
});

test('4: a faded standing fact stays out; pinned it goes in; open promises and dates never fade', (t) => {
  const { mem } = setup(t);
  const oldFact = add(mem, 'fact', 'Alex played trumpet in high school.', daysAgo(400));
  const newFact = add(mem, 'fact', 'Alex started a new job at Acme.', daysAgo(5));
  const promise = add(mem, 'promise', 'Alex will call his mom.', daysAgo(600));
  const pick = () => selectMemories(mem, { userText: 'hello', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: NORMAL, today: TODAY });
  assert.ok(!pick().ids.includes(oldFact.id), 'faded out');
  assert.ok(pick().ids.includes(newFact.id));
  assert.ok(pick().ids.includes(promise.id), 'open promises never fade');
  assert.match(pick().text, /call his mom\. \[why: standing open promise; sure: low\]/, 'no "older" note on a promise');
  mem.setPinned(oldFact.id, true);
  assert.ok(pick().ids.includes(oldFact.id), 'pinned: in');
  assert.match(pick().text, /high school\. \[why: pinned; sure: low\]/);
  // Dates are the "coming up" block's (never notes), same as before.
  mem.add({ kind: 'date', content: "Alex's birthday", conversationId: null, sourceMessageId: null, happenedOn: daysAgo(900), onDate: '11-02' });
  assert.doesNotMatch(pick().text, /birthday/);
  // A custom half-life decides too: a very long one keeps the old fact; minStanding 0 keeps everything.
  mem.setPinned(oldFact.id, false);
  assert.ok(selectMemories(mem, { userText: 'hello', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: decayPolicy({ fade: 'custom', decay: { halfLifeDays: 2000 } }), today: TODAY }).ids.includes(oldFact.id));
  assert.ok(selectMemories(mem, { userText: 'hello', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: decayPolicy({ fade: 'normal', decay: { minStanding: 0 } }), today: TODAY }).ids.includes(oldFact.id));
});

test('5: markUsed adds at most 1 a day; standing picks do not count; the reuse lift is capped', async (t) => {
  const { app, mem } = setup(t);
  const dog = add(mem, 'fact', "Alex's dog is a beagle named Biscuit.", daysAgo(10));
  const tea = add(mem, 'fact', 'Alex prefers tea in the morning.', daysAgo(10));
  assert.equal(mem.markUsed([dog.id, dog.id], TODAY), 1);
  assert.equal(mem.markUsed([dog.id], TODAY), 0, 'once a day');
  assert.equal(mem.markUsed([dog.id], '2026-10-25'), 1);
  assert.equal(mem.get(dog.id)!.useCount, 2);
  assert.equal(mem.get(dog.id)!.lastUsedOn, '2026-10-25');
  // Through a real turn: the matched note counts, the standing one doesn't.
  app.settings.update({ memory: { enabled: true, quietMinutes: 30, injectBudgetChars: 2500, fade: 'normal' } });
  const conv = app.store.createConversation();
  app.script.push(text('Biscuit!'));
  for await (const _ of runTurn(app, conv.id, 'how is my dog doing?')) void _;
  assert.equal(mem.get(tea.id)!.useCount, 0, 'standing pick: not used');
  assert.equal(mem.get(dog.id)!.useCount, 3, 'matched pick: +1 (new local day)');
  // Capped lift: a thousand uses lift a note by at most reuseWeight.
  const base: Memory = { ...mem.get(tea.id)!, useCount: 0 };
  const [a] = scoreCandidates([{ memory: base, standing: true }], NORMAL, TODAY, 0);
  const [b] = scoreCandidates([{ memory: { ...base, useCount: 1000 } as Memory, standing: true }], NORMAL, TODAY, 0);
  assert.ok(b.score - a.score <= NORMAL.reuseWeight + 1e-9 && b.score > a.score);
});

test('6: total characters including the bracket notes stay within the budget', (t) => {
  const { mem } = setup(t);
  for (let i = 0; i < 40; i++) add(mem, 'fact', `Alex note ${i} about the garden and the tomatoes that grow there every summer.`, daysAgo(i));
  for (const budget of [150, 400, 1000, 2500]) {
    const inj = selectMemories(mem, { userText: 'garden tomatoes', conversationId: 'c', oldestHistoryId: 0, budgetChars: budget, policy: NORMAL, today: TODAY, extra: ['- (shared) Alex lives in Denver.'] });
    assert.ok(inj.text.length <= budget && inj.chars <= budget, `${inj.text.length} ≤ ${budget}`);
    assert.equal(inj.picks.length, inj.ids.length);
    assert.ok(inj.text.split('\n').filter((l) => l.startsWith('- (2026')).every((l) => /\[why: [^\]]+; sure: (high|medium|low)[^\]]*\]$/.test(l)));
  }
});

test('7: same inputs → same order (ties by newer date, then higher id)', (t) => {
  const { mem } = setup(t);
  const a = add(mem, 'fact', 'Alex likes red apples.', daysAgo(2));
  const b = add(mem, 'fact', 'Alex likes green apples.', daysAgo(2));
  const c = add(mem, 'fact', 'Alex likes apples baked.', daysAgo(1));
  const order = () => rankMemories(mem, { query: 'apples', conversationId: 'x', oldestHistoryId: 0, policy: NEVER, today: TODAY }).map((p) => p.memoryId);
  const first = order();
  for (let i = 0; i < 5; i++) assert.deepEqual(order(), first);
  assert.deepEqual(first.slice(0, 3), [c.id, b.id, a.id]);
});

test("8: another app's turn never sees private, imported or adult-channel notes (Hardening M3)", async (t) => {
  const { app, mem } = setup(t);
  const priv = app.store.createConversation({ private: true });
  const imp = app.store.createConversation({ channel: 'import-chatgpt' });
  const adult = app.store.createConversation({ channel: 'discord-nsfw' });
  const open = app.store.createConversation();
  add(mem, 'fact', 'PRIVATEMARK Alex secret garden fact.', daysAgo(1), priv.id);
  add(mem, 'fact', 'IMPORTMARK Alex garden fact from ChatGPT.', daysAgo(1), imp.id);
  add(mem, 'fact', 'ADULTMARK Alex garden fact.', daysAgo(1), adult.id);
  const ok = add(mem, 'fact', 'OPENMARK Alex garden fact.', daysAgo(1), open.id);
  mem.setPinned(ok.id - 1, true); // even pinned notes obey the rule
  const allow = (m: { conversationId: string | null }) => !m.conversationId || sharedWithApps(app.store.getConversation(m.conversationId));
  const inj = selectMemories(mem, { userText: 'garden', conversationId: 'z', oldestHistoryId: 0, budgetChars: 4000, policy: NORMAL, today: TODAY, allow, override: { include: [ok.id - 1] } });
  assert.match(inj.text, /OPENMARK/);
  assert.doesNotMatch(inj.text, /PRIVATEMARK|IMPORTMARK|ADULTMARK/);
  // And through a real other-app turn.
  const api = app.store.createConversation({ channel: 'api' });
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, api.id, 'tell me about the garden', undefined, { externalApp: true })) void _;
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /OPENMARK/);
  assert.doesNotMatch(sys, /PRIVATEMARK|IMPORTMARK|ADULTMARK/);
});

test('9: override.exclude takes a note out, override.include puts one in (M8 hook)', (t) => {
  const { mem } = setup(t);
  const dog = add(mem, 'fact', "Alex's dog is named Biscuit.", daysAgo(1));
  const far = add(mem, 'fact', 'Alex once visited Lisbon.', daysAgo(900));
  const base = { userText: 'my dog', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: NORMAL, today: TODAY };
  assert.ok(selectMemories(mem, base).ids.includes(dog.id));
  assert.ok(!selectMemories(mem, base).ids.includes(far.id));
  const out = selectMemories(mem, { ...base, override: { exclude: [dog.id], include: [far.id] } });
  assert.ok(!out.ids.includes(dog.id), 'excluded');
  assert.ok(out.ids.includes(far.id), 'included');
  assert.equal(out.picks.find((p) => p.id === far.id)!.included, true);
  assert.match(out.text, /Lisbon\. \[why: added for this run; sure: low; older, may be out of date\]/);
});

test('10: routes: PATCH pinned, pinned filter, settings clamp + decayText; another space cannot reach the notes', async (t) => {
  const { app, mem } = setup(t);
  const other = setup(t);
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const j = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: H });
    return { status: res.status, body: await res.json() };
  };
  const n = add(mem, 'fact', 'Alex likes chess.', daysAgo(3));
  const p = await j(`/memories/${n.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
  assert.equal(p.status, 200);
  assert.equal(p.body.pinned, true);
  assert.equal(mem.get(n.id)!.content, 'Alex likes chess.', 'pinning is not an edit');
  assert.equal(mem.get(n.id)!.edited, false);
  assert.equal((await j(`/memories/${n.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: 'yes' }) })).status, 400);
  add(mem, 'fact', 'Alex likes tea.', daysAgo(3));
  assert.deepEqual((await j('/memories?pinned=1')).body.map((m: Memory) => m.id), [n.id]);
  const g = await j('/memory/settings');
  assert.equal(g.body.fade, 'never');
  assert.equal(g.body.decay.halfLifeDays, 0);
  assert.match(g.body.decayText, /Nothing fades/);
  const put = await j('/memory/settings', { method: 'PUT', body: JSON.stringify({ fade: 'custom', decay: { halfLifeDays: 3, reuseWeight: 9, minStanding: -1 } }) });
  assert.deepEqual(put.body.decay, { halfLifeDays: 7, reuseWeight: 0.3, minStanding: 0 });
  assert.equal(put.body.fade, 'custom');
  assert.match(put.body.decayText, /halves every 7 days/);
  assert.equal((await j('/memory/settings', { method: 'PUT', body: JSON.stringify({ decay: { halfLifeDays: 99999 } }) })).body.decay.halfLifeDays, 3650);
  assert.equal((await j('/memory/settings', { method: 'PUT', body: JSON.stringify({ fade: 'slow' }) })).body.decay.halfLifeDays, 365, 'a preset sets the half-life');
  assert.deepEqual(clampDecay({ halfLifeDays: 0 }), { ...DEFAULT_DECAY, halfLifeDays: 0 });
  assert.match(explainPolicy(decayPolicy({ fade: 'normal' })), /halves every 120 days.*about 120 days/);
  // Each household space is its own data folder: an id from this space means nothing in another.
  const otherNote = add(other.mem, 'fact', 'Ben likes jazz.', daysAgo(1));
  assert.equal(otherNote.id, 1);
  assert.equal(other.mem.get(otherNote.id)!.pinned, false, 'pinning note 1 here did not touch the other space');
  const rec: MemberRecord = { id: 'abcdef0123', name: 'A', createdAt: '', status: 'suspended', ownerConfirmed18At: '', memberConfirmed18At: '', limits: { messagesPerDay: 0, voice: true, pictures: true, models: [] } as unknown as MemberRecord['limits'] };
  assert.equal(memberRouteCheck(rec, 'PATCH', ['memories', '1'])?.status, 403, 'a paused member cannot pin');
  assert.equal(memberRouteCheck(undefined, 'PUT', ['memory', 'settings'])?.status, 401);
  // Export carries pinned / uses (backups copy the whole database).
  mem.markUsed([n.id], TODAY);
  importAll(other.app, exportAll(app));
  const back = other.mem.list({ pinned: true });
  assert.deepEqual(back.map((m) => [m.content, m.pinned, m.useCount, m.lastUsedOn]), [['Alex likes chess.', true, 1, TODAY]]);
});

test('11: the reply saves meta.memoryPicks next to memoryIds; the panel helper is unchanged', async (t) => {
  const { app, mem } = setup(t);
  add(mem, 'fact', "Alex's dog is a beagle named Biscuit.", daysAgo(4));
  add(mem, 'decision', 'Alex and Sara agreed on tests before every push.', daysAgo(200));
  const conv = app.store.createConversation();
  app.script.push(text('Biscuit!'));
  for await (const _ of runTurn(app, conv.id, "what's my dog's name?")) void _;
  const last = app.store.messages(conv.id).at(-1)!;
  const ids = last.meta!.memoryIds as number[];
  const picks = last.meta!.memoryPicks as { id: number; sure: string; words?: string[]; policy: string }[];
  assert.deepEqual(picks.map((p) => p.id), ids);
  assert.equal(picks[0].sure, 'medium');
  assert.deepEqual(picks[0].words, ['dog', 'name']);
  assert.match(picks[0].policy, /^d[0-9a-f]{8}$/);
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /Each note ends with why it came to mind and how sure that is\. Lean on 'high', treat 'low' as background\./);
  assert.match(sys, /\(2026-10-20\) Alex's dog is a beagle named Biscuit\. \[why: words "dog", "name"; sure: medium\]/);
  assert.match(sys, /decided together: go by it unless told otherwise\) Alex and Sara agreed on tests before every push\. \[why: standing decision; sure: low\]/);
  const src = readFileSync(join(ROOT, 'web/her-panel.js'), 'utf8');
  assert.match(src, /export function memoryIdsOfLastTurn\(msgs\) \{\n  const from = msgs\.findLastIndex\(\(m\) => m\.role === 'user'\) \+ 1;/);
});

test('12: notes: false (voice calls, her day) → no bracket text and no "how to read" line', (t) => {
  const { mem } = setup(t);
  add(mem, 'fact', "Alex's dog is a beagle named Biscuit.", daysAgo(4));
  const inj = selectMemories(mem, { userText: 'dog', conversationId: 'c', oldestHistoryId: 0, budgetChars: 3000, policy: NORMAL, today: TODAY, notes: false });
  assert.match(inj.text, /Biscuit\.$/m);
  assert.doesNotMatch(inj.text, /\[why:|sure:/);
  assert.equal(inj.picks.length, 1, 'picks are still recorded');
  const live = readFileSync(join(ROOT, 'src/live.ts'), 'utf8');
  const life = readFileSync(join(ROOT, 'src/life.ts'), 'utf8');
  assert.match(live, /selectMemories\([^;]*notes: false/);
  assert.match(life, /selectMemories\([^;]*notes: false/);
});

test('13: 10,000 notes ranked in under 50 ms (with slack)', (t) => {
  const { mem } = setup(t);
  mem.db.exec('BEGIN');
  for (let i = 0; i < 10_000; i++) add(mem, i % 7 === 0 ? 'decision' : 'fact', `Alex note ${i} about ${['garden', 'chess', 'tea', 'trumpet', 'Denver'][i % 5]} and work.`, daysAgo(i % 900));
  mem.db.exec('COMMIT');
  const cands: Candidate[] = mem.listAll().map((m, i) => (i % 3 ? { memory: m, standing: true } : { memory: m, words: ['garden'] }));
  rankMemories(mem, { query: 'garden chess', conversationId: 'c', oldestHistoryId: 0, policy: NORMAL, today: TODAY }); // warm up
  // PL2d (C5): the clock is fixed (TODAY) and the time measured is this process's CPU time, the median
  // of 5 runs, so a full suite running beside it (other processes on the same cores) no longer counts.
  // Wall time under the full suite's load was up to ~980 ms for the same work.
  const cpuMs = () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  };
  const runs: number[] = [];
  let ranked: unknown[] = [];
  let r2: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    const c0 = cpuMs();
    ranked = scoreCandidates(cands, NORMAL, TODAY, 2);
    r2 = rankMemories(mem, { query: 'garden chess', conversationId: 'c', oldestHistoryId: 0, policy: NORMAL, today: TODAY });
    runs.push(cpuMs() - c0);
  }
  const ms = runs.sort((a, b) => a - b)[2];
  assert.ok(ranked.length > 3000 && r2.length > 0);
  console.log(`# ranked 10,000 notes in ${ms.toFixed(1)} ms of CPU (median of 5)`);
  assert.ok(ms < 150, `ranked 10,000 in ${ms.toFixed(1)} ms of CPU (target 50, slack for a slow machine)`);
});

test('14: older callers keep working: fadeDays maps to a half-life, Memory[] related still counts', (t) => {
  const { mem } = setup(t);
  const oldF = add(mem, 'fact', 'Alex played trumpet in high school.', '2025-01-05');
  const near = add(mem, 'fact', 'Alex has a small hound.', daysAgo(2));
  const inj = selectMemories(mem, { userText: 'hello', conversationId: 'x', oldestHistoryId: 0, budgetChars: 3000, fadeDays: 120, today: '2026-10-25', related: [mem.get(near.id)!] });
  assert.ok(!inj.ids.includes(oldF.id));
  assert.equal(inj.picks.find((p) => p.id === near.id)!.meaning, true);
  // No `today`: nothing fades (as before).
  assert.ok(selectMemories(mem, { userText: 'hello', conversationId: 'x', oldestHistoryId: 0, budgetChars: 3000, fadeDays: 120 }).ids.includes(oldF.id));
});

test('15 (UI): the panel reads why/sure from meta.memoryPicks with no extra request; pin buttons; Settings decay; pinned filter', async () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US'; const currentIdentity = () => ({ name: 'Sara' });";
  const src = web('her-panel.js')
    .replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub)
    .replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  const m = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'old', meta: { memoryIds: [9], memoryPicks: [{ id: 9, sure: 'high' }] } },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: '', meta: { memoryIds: [3], memoryPicks: [{ id: 3, sure: 'high', words: ['dog'], meaning: true }], toolCalls: [{}] } },
    { role: 'assistant', content: 'done', meta: { memoryIds: [3, 4], memoryPicks: [{ id: 3, sure: 'low' }, { id: 4, sure: 'low', standing: 'decision', old: true }, { id: 5, sure: 'bogus' }] } },
  ];
  const picks = m.memoryPicksOfLastTurn(msgs);
  assert.deepEqual([...picks.keys()], [3, 4], 'the last turn only; the first note wins; unknown sureness ignored');
  assert.equal(m.whyWords(picks.get(3)), 'matched “dog” · close in meaning');
  assert.equal(m.whyWords(picks.get(4), (k: string) => `[${k}]`), 'came to mind on its own ([decision]) · older, may be out of date');
  assert.equal(m.whyWords({ sure: 'low', standing: 'fact', pinned: true }), 'pinned');
  assert.equal(m.whyWords({ sure: 'low', fuzzy: true }), 'similar words');
  const js = web('her-panel.js');
  const load = js.slice(js.indexOf('async function loadMemories'), js.indexOf('function memOpen'));
  assert.equal((load.match(/ui\.ctx\.api\(/g) ?? []).length, 1, 'still one request (the notes), only when opened');
  assert.match(js, /ui\.ctx\.api\(`\/memories\/\$\{m\.id\}`, \{ method: 'PATCH', body: \{ pinned: next \} \}\)/);
  const html = web('index.html');
  assert.match(html, /<option value="custom">Custom \(you pick how fast\)<\/option><\/select><\/label>\s*<label id="mem-halflife-row" hidden>[\s\S]*?class="tip"[\s\S]*?<input id="mem-halflife" type="range" min="7" max="1095"/);
  assert.match(html, /<p id="mem-decay" class="muted small"><span>How fading works:<\/span> <button type="button" class="tip"/);
  assert.match(html, /<option value="pinned">Pinned \(never fade\)<\/option>/);
  const app = web('app.js');
  assert.match(app, /params\.set\('pinned', '1'\)/);
  assert.match(app, /decay: \{ halfLifeDays: Number\(\$\('#mem-halflife'\)\.value\) \}/);
  // The words in the app match the server's explanation (same numbers).
  assert.ok(app.includes("A note's weight halves every {days} days since it happened or was last used."));
  assert.match(explainPolicy({ halfLifeDays: 30, reuseWeight: 0.1, minStanding: 0.5 }), /^A note's weight halves every 30 days since it happened or was last used\./);
  for (const css of ['her-panel.css', 'ui-tidy.css']) assert.doesNotMatch(web(css).split('Phase 76')[1]?.split('\n\n')[0] ?? '', /#[0-9a-f]{3,8}\b/i, 'tokens only');
  // v9 here; later phases bump it again (Phase 77: v10).
  assert.ok(Number(/sara-shell-v(\d+)/.exec(web('sw.js'))?.[1]) >= 9);
});
