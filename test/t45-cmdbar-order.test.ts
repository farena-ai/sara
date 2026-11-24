// T45 E5: the order of Ctrl K. The group with the best fitting row leads (typing "bigger text"
// shows the setting before chats that only mention those words); rows that fit equally go by what
// you picked most recently; Ask stays last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

type Row = { key: string; label: string; sub?: string; words?: string; fit?: number };
type Group = [string, Row[]];
/** web/command-bar.js in Node: its naming.js import becomes a small stand-in, icons.js loads by file URL. */
const bar = () => {
  const stub = 'const t = (s) => s;';
  const src = readFileSync(join(ROOT, 'web', 'command-bar.js'), 'utf8')
    .replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub)
    .replace(/from '\.\/icons\.js';/, `from '${pathToFileURL(join(ROOT, 'web', 'icons.js')).href}';`);
  assert.ok(src.includes(stub), 'command-bar.js imports naming.js');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`) as Promise<{
    fitOf: (q: string, x: Row) => number;
    pick: (list: Row[], q: string, n?: number, recent?: string[]) => Row[];
    orderGroups: (groups: Group[], q: string, recent?: string[]) => Group[];
  }>;
};
/** The groups that have rows, as the bar draws them. */
const ids = (groups: Group[]) => groups.filter(([, items]) => items.length).map(([id]) => id);

test('T45 Ctrl K: "bigger text" shows the setting before chats that mention it', async () => {
  const c = await bar();
  const q = 'bigger text';
  // What the bar had for it: two chats found by their messages, the everyday-words answer, Ask.
  const groups: Group[] = [
    ['places', []],
    ['projects', []],
    ['convs', [{ key: 'conv:1', label: 'Reading glasses', sub: 'can you make the text bigger text please' }, { key: 'conv:2', label: 'Phone setup', sub: '… bigger text on the lock screen …' }]],
    ['settings', [{ key: 'settings:you-appearance', label: 'Appearance', sub: 'You', fit: 5 }, { key: 'settings:you-chat', label: 'Text size in chat', sub: 'You → Chat' }]],
    ['actions', []],
    ['ask', [{ key: 'ask', label: 'Ask Sara: “bigger text”' }]],
  ];
  assert.deepEqual(ids(c.orderGroups(groups, q)), ['settings', 'convs', 'ask']);
});

test('T45 Ctrl K: the best fitting group leads; equal groups keep the usual order; Ask is last', async () => {
  const c = await bar();
  const place: Group = ['places', [{ key: 'place:planner', label: 'Planner' }]];
  const conv: Group = ['convs', [{ key: 'conv:9', label: 'Trip plan' }]];
  const setting: Group = ['settings', [{ key: 'settings:x', label: 'Plan the day' }]];
  const ask: Group = ['ask', [{ key: 'ask', label: 'Ask Sara: “plan”' }]];
  // "plan": Planner and "Plan the day" start with it (4), "Trip plan" has it as a later word (3).
  assert.deepEqual(ids(c.orderGroups([ask, conv, setting, place], 'plan')), ['settings', 'places', 'convs', 'ask'], 'by fit, then as given');
  assert.deepEqual(ids(c.orderGroups([place, conv, setting, ask], 'plan')), ['places', 'settings', 'convs', 'ask']);
  // A chat whose title is what was typed beats a setting that only has the word somewhere.
  const weak: Group = ['settings', [{ key: 'settings:y', label: 'Morning briefing', sub: 'Routines', words: 'trip weather' }]];
  assert.deepEqual(ids(c.orderGroups([['places', []], weak, ['convs', [{ key: 'conv:9', label: 'Trip plan' }]], ask], 'trip')), ['convs', 'settings', 'ask']);
  // Equal fit: the group with a row you picked recently goes first.
  assert.deepEqual(ids(c.orderGroups([place, setting, ask], 'plan', ['settings:x'])), ['settings', 'places', 'ask']);
  // Ask alone is still shown.
  assert.deepEqual(ids(c.orderGroups([['places', []], ask], 'zzz')), ['ask']);
});

test('T45 Ctrl K: inside a group, the best fit first, then what you used most recently', async () => {
  const c = await bar();
  const list: Row[] = [
    { key: 'a', label: 'Trip to Rome' },
    { key: 'b', label: 'Trip to Oslo' },
    { key: 'c', label: 'Old road trip' },
    { key: 'd', label: 'Groceries' },
  ];
  assert.deepEqual(c.pick(list, 'trip').map((x) => x.key), ['a', 'b', 'c'], 'no history: as given, a better fit first');
  assert.deepEqual(c.pick(list, 'trip', 6, ['b']).map((x) => x.key), ['b', 'a', 'c'], 'Oslo was picked last time');
  assert.deepEqual(c.pick(list, 'trip', 6, ['c', 'b']).map((x) => x.key), ['b', 'a', 'c'], 'recent use never lifts a weaker fit over a better one');
  assert.deepEqual(c.pick(list, 'trip', 2, ['b']).map((x) => x.key), ['b', 'a']);
  assert.equal(c.fitOf('bigger text', { key: 's', label: 'Appearance', fit: 5 }), 5, 'a source may say how well its row fits');
  assert.equal(c.fitOf('plan', { key: 'p', label: 'Planner' }), 4);
});

test('T45 Ctrl K: the app marks an everyday-words answer as the best fit', () => {
  // The wiring in app.js (its search needs the Settings pages of a real page, so a source check).
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /const plain = everydayFor\(q\)[\s\S]{0,700}?\.map\(\(x\) => \(\{ \.\.\.x, fit: 5 \}\)\);/);
});
