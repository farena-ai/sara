// Y4: what changes from turn to turn comes last in her instructions, so the long first part is the
// same bytes on every turn and a model's cache can reuse it. Measured on the owner's server before:
// 768 of about 16,000 instruction tokens were reused across turns (the clock sat that far in).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/persona.ts';
import { makeApp, tempDir } from './helpers.ts';

test('Y4 instructions: two turns that differ in time, mood, memory and day share everything before "Right now"', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T12:00:00Z') });
  try {
    const tools = ['recall', 'web_fetch', 'web_search', 'ask_choice', 'make_document', 'automation_create', 'pc_run', 'settings_guide', 'goal_create'];
    const base = { ownerName: 'Alex', timeZone: 'UTC', tools };
    const one = buildSystemPrompt(app.persona, { ...base, now: new Date('2026-11-23T12:00:00Z'), inner: 'Calm and focused.', day: 'Coffee, then a walk.', memories: '- (Nov 20) Alex likes tea.', dates: '- Nov 30: dentist' });
    const two = buildSystemPrompt(app.persona, { ...base, now: new Date('2026-11-23T18:47:00Z'), inner: 'A little tired.', day: 'Coffee, a walk, then dinner out.', memories: '- (Nov 23) Alex ran 5 km.', dates: '- Dec 1: lease renewal', language: 'Reply in Spanish.', safetyNotes: ['Be gentle.'] });
    const at = one.indexOf('## Right now');
    assert.ok(at > 0, 'the section exists');
    assert.equal(two.indexOf('## Right now'), at, 'at the same place in both');
    assert.equal(one.slice(0, at), two.slice(0, at), 'everything before it is identical');
    assert.ok(at > one.length * 0.5, `the shared first part is most of the instructions (${at} of ${one.length} characters)`);
    // The guidance for her tools is in the shared part; the parts that change come after it, in this order.
    for (const h of ['## What you can do', '## Automations', '## Staying in character', '## Boundaries']) assert.ok(one.indexOf(h) >= 0 && one.indexOf(h) < at, `${h} is in the shared part`);
    const order = ['## Right now', '## How you feel', '## Your day', '## What you remember from before', '## Coming up', '## Language', '## Important for this reply'].map((h) => two.indexOf(h));
    assert.ok(order.every((i) => i >= at), 'what changes comes after');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in a fixed order, the safety notes last');
    assert.ok(two.trimEnd().endsWith('- Be gentle.'), 'the notes for this reply are the last thing she reads');
  } finally {
    app.store.close();
    cleanup();
  }
});
