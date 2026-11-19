// W5.5 (docs/design/W5WHY.md): "Why did you do this?" on every timeline row. The cause (what started
// the action) and the rule (why no card was shown) are stored with the row at the moment of the
// action; old rows say so plainly; "why did you do that?" in chat answers from the stored row only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { asksWhyThat, ruleOf, whyLines, OLD_ROW } from '../src/action-why.ts';
import { setAlwaysAllow } from '../src/always-allow.ts';
import { runTurn, type ChatEvent, type TurnOptions } from '../src/chat.ts';
import { ActionTimeline, timelineOf } from '../src/timeline.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-19T15:00:00Z');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function tool(name: string, permission: 'auto' | 'ask'): Tool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    defaultPermission: permission,
    summarize: () => `${name} ran`,
    async run() {
      return 'done';
    },
  };
}

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.tools.add(tool('shelf_add', 'auto'));
  app.tools.add(tool('shelf_move', 'ask'));
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
  });
  return app;
}

async function act(app: TestApp, name: string, words: string, opts: TurnOptions = {}, convId?: string) {
  const conv = convId ?? app.store.createConversation().id;
  app.script.push([call('c1', name, {})], text('Done.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv, words, undefined, opts)) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true);
  }
  return { conv, evs, row: timelineOf(app).list({ limit: 1 })[0]! };
}

test('W5.5: a row keeps the message that started it and the rule that let it run', async (t) => {
  const app = setup(t);
  // An auto tool: no card, because the tool runs on its own by default.
  const a = await act(app, 'shelf_add', 'put the dentist on my calendar');
  const user = app.store.messages(a.conv).find((m) => m.role === 'user')!;
  assert.equal(a.row.why?.cause.kind, 'message');
  assert.equal(a.row.why?.cause.messageId, user.id, 'links to the chat turn');
  assert.equal(a.row.why?.cause.text, 'put the dentist on my calendar');
  assert.equal(a.row.why?.cause.at, user.createdAt);
  assert.equal(a.row.why?.rule, 'auto-tool');
  // An ask tool answered on its card.
  const b = await act(app, 'shelf_move', 'move it to friday');
  assert.equal(b.evs.filter((e) => e.type === 'approval').length, 1);
  assert.equal(b.row.why?.rule, 'card');
  // The person set the tool to run on its own.
  app.settings.update({ toolPermissions: { shelf_move: 'auto' } });
  const c = await act(app, 'shelf_move', 'move it to monday');
  assert.equal(c.row.why?.rule, 'tool-on');
  // Always allow everything skipped its card.
  app.settings.update({ toolPermissions: {} });
  setAlwaysAllow(app as never, { on: true, warned: true });
  const d = await act(app, 'shelf_move', 'move it to tuesday');
  assert.equal(d.evs.filter((e) => e.type === 'approval').length, 0);
  assert.equal(d.row.why?.rule, 'always-allow');
  // The lines the web and chat show come from the stored row.
  const keys = whyLines(d.row.why).map((l) => l.key);
  assert.ok(keys.includes('You asked at {time}: “{text}”'), keys.join(' | '));
  assert.ok(keys.includes('No card was shown because Always allow everything was on.'));
});

test('W5.5: automations, loops and other starters are named; old rows say so', async (t) => {
  const app = setup(t);
  const r = await act(app, 'shelf_add', 'Add the weekly sync.', { cause: { kind: 'automation', label: 'Monday sync', how: 'schedule' } });
  assert.deepEqual({ kind: r.row.why?.cause.kind, label: r.row.why?.cause.label, how: r.row.why?.cause.how }, { kind: 'automation', label: 'Monday sync', how: 'schedule' });
  assert.ok(typeof r.row.why?.cause.messageId === 'number', 'still links to its chat turn');
  const loop = await act(app, 'shelf_add', 'tick', { persist: { kind: 'loop', id: 3, n: 1, label: 'check the oven' } });
  assert.equal(loop.row.why?.cause.kind, 'loop');
  assert.equal(loop.row.why?.cause.label, 'check the oven');
  // A row written before W5.5 (no why column at all) reads as such.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE action_timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, conversation_id TEXT, tool TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, undo TEXT, never TEXT, reverted_at TEXT, revert_note TEXT, title TEXT, params TEXT)');
  db.prepare("INSERT INTO action_timeline (at, tool, kind, summary) VALUES (?, 'x', 'other', 'old')").run(NOW.toISOString());
  const tl = new ActionTimeline(db, () => NOW);
  const old = tl.list()[0]!;
  assert.equal(old.why, undefined);
  assert.deepEqual(whyLines(old.why).map((l) => l.key), [OLD_ROW]);
  const fresh = tl.record({ tool: 'y', kind: 'other', summary: 'new', why: { cause: { kind: 'click' } } });
  assert.equal(fresh.why?.cause.kind, 'click');
  db.close();
});

test('W5.5: rules are picked in a fixed order', () => {
  assert.equal(ruleOf({ approved: true, allowAll: true, ahead: false, task: false, set: 'ask', ownerSet: false }), 'card');
  assert.equal(ruleOf({ approved: false, allowAll: true, ahead: false, task: false, set: 'ask', ownerSet: false }), 'always-allow');
  assert.equal(ruleOf({ approved: false, allowAll: false, ahead: true, task: false, set: 'ask', ownerSet: false }), 'allow-once');
  assert.equal(ruleOf({ approved: false, allowAll: false, ahead: false, task: true, set: 'ask', ownerSet: false }), 'task');
  assert.equal(ruleOf({ approved: false, allowAll: false, ahead: false, task: false, set: 'auto', ownerSet: true }), 'tool-on');
  assert.equal(ruleOf({ approved: false, allowAll: false, ahead: false, task: false, set: 'auto', ownerSet: false }), 'auto-tool');
});

test('W5.5: "why did you do that?" answers from the stored row, no model call, six languages', async (t) => {
  const app = setup(t);
  const a = await act(app, 'shelf_add', 'put the dentist on my calendar');
  const asked: ChatEvent[] = [];
  const before = app.script.length;
  for await (const ev of runTurn(app, a.conv, 'Why did you do that?')) asked.push(ev);
  assert.equal(app.script.length, before, 'no model call');
  const reply = asked.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
  assert.match(reply, /put the dentist on my calendar/);
  assert.match(reply, /runs on its own/);
  const stored = app.store.messages(a.conv).at(-1)!;
  assert.equal(stored.role, 'assistant');
  assert.equal((stored.meta as { why?: { rows: number[] } } | undefined)?.why?.rows[0], a.row.id);
  // A chat with no recorded action: the model answers as usual (nothing to read, so no made-up cause).
  const other = app.store.createConversation();
  app.script.push(text('I only answered you.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, other.id, 'why did you do that?')) evs.push(ev);
  assert.equal(app.script.length, before, 'the model was asked');
  for (const s of ['why did you do that?', 'Sara, why did you do that', 'why did you do this?', 'Why did you change that?', '¿Por qué hiciste eso?', 'pourquoi tu as fait ça ?', 'Warum hast du das gemacht?', 'Por que você fez isso?', 'perché l\'hai fatto?'])
    assert.ok(asksWhyThat(s, 'Sara'), s);
  for (const s of ['why did you do that to the essay in your answer about rome and the empire?', 'why is the sky blue', 'what did you do?']) assert.ok(!asksWhyThat(s, 'Sara'), s);
});

test('W5.5: every starter passes its cause; the web shows Why did you do this?', () => {
  assert.match(read('src/automations.ts'), /cause: \{ kind: 'automation'/);
  assert.match(read('src/errands.ts'), /cause: /);
  assert.match(read('src/event-triggers.ts'), /cause: \{ kind: 'trigger'/);
  assert.match(read('src/webhooks.ts'), /cause: \{ kind: 'webhook'/);
  assert.match(read('src/goals.ts'), /label: g\.text/);
  assert.match(read('src/loops.ts'), /label: /);
  assert.match(read('src/team.ts'), /noteAction\(/);
  assert.match(read('src/handle-it.ts'), /kind: 'handle'/);
  const web = read('web/timeline.js');
  assert.match(web, /t\('Why did you do this\?'\)/);
  assert.match(web, /aria-expanded/);
  assert.match(web, /openTurn/);
});
