// 3.4.2: adding to a note never drops what is already in it; every change keeps the version before
// it (history / restore); a save that would erase most of a note is refused unless replace: true.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createPlannerTools, NOTE_TRASH_DAYS, PlannerStore } from '../src/planner.ts';
import type { ToolContext } from '../src/tools/types.ts';

const TZ = 'America/Chicago';

function setup(start = '2026-11-11T16:41:00Z') {
  const clock = { now: new Date(start) };
  const planner = new PlannerStore(new DatabaseSync(':memory:'), () => clock.now);
  const tools = createPlannerTools({ planner, now: () => clock.now, timeZone: () => TZ });
  const note = tools.find((t) => t.spec.name === 'note')!;
  const ctx = { workspaceDir: '.', signal: new AbortController().signal } as unknown as ToolContext;
  const run = (args: Record<string, unknown>) => note.run(args, ctx);
  return { clock, planner, note, run };
}

const RESULTS = [
  'CBC 2026-10-02: WBC 6.1, hemoglobin 14.2, platelets 250.',
  'Lipid panel 2026-10-02: LDL 131, HDL 48, triglycerides 160.',
  'A1C 2026-10-02: 5.9 percent.',
  'Thyroid 2026-10-02: TSH 2.1.',
  'Vitamin D 2026-10-02: 22 ng/mL (low), start 2000 IU daily.',
];

test('note add: five results to one note, all five kept, each in its own dated section', async () => {
  const { planner, run, clock } = setup();
  const first = await run({ action: 'add', title: 'Medical records', text: RESULTS[0] });
  assert.match(first, /^Saved note #1 "Medical records", updated /);
  for (const r of RESULTS.slice(1)) {
    clock.now = new Date(clock.now.getTime() + 60_000);
    // By id or by the same title (any case, close enough): never a new note, never a lost entry.
    await run(r === RESULTS[2] ? { action: 'add', title: 'medical records', text: r } : { action: 'add', id: 1, text: r });
  }
  const n = planner.note(1)!;
  assert.equal(planner.notes().length, 1, 'one note');
  assert.equal(n.title, 'Medical records');
  for (const r of RESULTS) assert.ok(n.body.includes(r), `kept: ${r}`);
  assert.match(n.body, /— 2026-11-11 10:41\n/, 'dated in the owner zone');
  assert.equal((n.body.match(/^— 2026-11-11 /gm) ?? []).length, 5);
  assert.equal(planner.noteVersions(1).length, 4, 'each add kept the version before it');
});

test('note add: a close title finds the note; a new title makes a new note', async () => {
  const { planner, run } = setup();
  await run({ action: 'add', title: "Frank's medical records", text: 'one' });
  await run({ action: 'add', title: 'medical records', text: 'two' });
  assert.equal(planner.notes().length, 1);
  await run({ action: 'add', title: 'Garden plan', text: 'tomatoes' });
  assert.equal(planner.notes().length, 2);
  await assert.rejects(run({ action: 'add', id: 99, text: 'x' }), /No note #99/);
  await assert.rejects(run({ action: 'add', id: 1 }), /text/);
});

test('note save with an id that would erase most of a note is refused; the note is intact', async () => {
  const { planner, run } = setup();
  await run({ action: 'save', title: 'Medical records', body: RESULTS.join('\n') });
  const before = planner.note(1)!;
  await assert.rejects(run({ action: 'save', id: 1, title: "Frank's medical records, added as he shares them. History mentioned before: knee surgery in 2019 and more.", body: RESULTS[4] }), (e: Error) => {
    assert.match(e.message, /This would erase \d[\d,]* characters already in note #1\. To add, use action add\. To really rewrite it, read it first and send the whole new text with replace: true\./);
    return true;
  });
  assert.deepEqual(planner.note(1), before, 'nothing changed');
  assert.equal(planner.noteVersions(1).length, 0);
  // Keeping the old text and adding to it is fine without replace (an edit, not an erase).
  await run({ action: 'save', id: 1, body: `${RESULTS.join('\n')}\nNew: ferritin 80.` });
  assert.ok(planner.note(1)!.body.endsWith('ferritin 80.'));
  assert.equal(planner.note(1)!.title, 'Medical records', 'no title given: the old title stays');
});

test('note save on an update: a long title is ignored, a short one is used', async () => {
  const { planner, run } = setup();
  await run({ action: 'save', title: 'Labs', body: 'a\nb' });
  await run({ action: 'save', id: 1, title: 'x'.repeat(81), body: 'a\nb\nc' });
  assert.equal(planner.note(1)!.title, 'Labs');
  await run({ action: 'save', id: 1, title: 'Lab results', body: 'a\nb\nc' });
  assert.equal(planner.note(1)!.title, 'Lab results');
});

test('replace: true rewrites; the old version is in history and restore brings it back', async () => {
  const { planner, run } = setup();
  await run({ action: 'save', title: 'Medical records', body: RESULTS.join('\n') });
  const out = await run({ action: 'save', id: 1, body: 'Short summary only.', replace: true });
  assert.match(out, /^Saved note #1 "Medical records"/);
  assert.equal(planner.note(1)!.body, 'Short summary only.');
  const hist = await run({ action: 'history', id: 1 });
  const v = planner.noteVersions(1);
  assert.equal(v.length, 1);
  assert.equal(v[0].reason, 'replace');
  assert.equal(v[0].body, RESULTS.join('\n'));
  assert.match(hist, new RegExp(`version ${v[0].id}\\b`));
  const back = await run({ action: 'restore', id: 1, version: v[0].id });
  assert.match(back, /Restored note #1/);
  assert.equal(planner.note(1)!.body, RESULTS.join('\n'));
  assert.equal(planner.noteVersions(1).length, 2, 'the restore kept the short text too');
  await assert.rejects(run({ action: 'restore', id: 1, version: 999 }), /No version 999/);
});

test('delete keeps the note for 30 days: restore brings it back with its id; after that it is gone', async () => {
  const { planner, run, clock } = setup();
  await run({ action: 'save', title: 'Medical records', body: 'BP 120/80' });
  const del = await run({ action: 'delete', id: 1 });
  assert.match(del, /^Deleted note #1 "Medical records"\./);
  assert.match(del, /30 days/);
  assert.equal(planner.note(1), undefined);
  assert.match(await run({ action: 'history' }), /#1 "Medical records"/, 'history without id lists recently deleted notes');
  const v = planner.noteVersions(1);
  assert.equal(v[0].reason, 'delete');
  await run({ action: 'restore', id: 1, version: v[0].id });
  assert.equal(planner.note(1)!.body, 'BP 120/80');
  assert.equal(planner.note(1)!.title, 'Medical records');
  // Deleted again, then 31 days later: the copy is cleared.
  planner.deleteNote(1);
  clock.now = new Date(clock.now.getTime() + (NOTE_TRASH_DAYS + 1) * 86_400_000);
  planner.pruneNoteVersions();
  assert.equal(planner.noteVersions(1).length, 0);
});

test('every change keeps a version: API-style saves too, with a reason', () => {
  const { planner } = setup();
  const n = planner.saveNote({ title: 'T', body: 'one' });
  planner.saveNote({ id: n.id, title: 'T', body: 'two' });
  planner.addToNote({ id: n.id, text: 'three', heading: '— 2026-11-11 10:41' });
  assert.deepEqual(
    planner.noteVersions(n.id).map((v) => [v.reason, v.body]),
    [
      ['add', 'two'],
      ['edit', 'one'],
    ],
  );
});

test('note tool description makes add THE way to add, and says how to rebuild a note', () => {
  const { note } = setup();
  assert.match(note.spec.description, /use add, never save with id/);
  assert.match(note.spec.description, /If a note lost things, rebuild it from the chat with add/);
  const props = (note.spec.parameters as { properties: Record<string, unknown> }).properties;
  for (const p of ['text', 'replace', 'version']) assert.ok(p in props, p);
  assert.deepEqual((props.action as { enum: string[] }).enum, ['add', 'save', 'search', 'read', 'list', 'history', 'restore', 'delete']);
});
