// 3.0.3 (owner): Your story's From/To default to the past year; a saved choice is kept.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { storyRange, yearBefore, STORY_RANGE_KEY }: any = await import(pathToFileURL(join(ROOT, 'web', 'story-range.js')).href);

test('story range: the past year by default, also on a new install', () => {
  assert.deepEqual(storyRange('2026-11-09', null), { from: '2025-11-09', to: '2026-11-09' });
  assert.equal(yearBefore('2028-02-29'), '2027-02-28');
  assert.equal(yearBefore('2026-01-01'), '2025-01-01');
});

test('story range: a saved choice wins; a broken one falls back', () => {
  assert.deepEqual(storyRange('2026-11-09', { from: '2026-03-01', to: '2026-06-30' }), { from: '2026-03-01', to: '2026-06-30' });
  assert.deepEqual(storyRange('2026-11-09', { from: '2026-07-01', to: '2026-06-30' }), { from: '2025-11-09', to: '2026-11-09' });
  assert.deepEqual(storyRange('2026-11-09', { from: 'x', to: '2026-06-30' }), { from: '2025-11-09', to: '2026-11-09' });
  assert.equal(STORY_RANGE_KEY, 'sara.storyRange');
});

test('story range: the window uses it and remembers a change; no first-day clamp', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const load = app.slice(app.indexOf('async function loadStory()'), app.indexOf('async function openStory()'));
  assert.match(load, /const range = storyRange\(d\.today, saved\);/);
  assert.doesNotMatch(load, /d\.firstDay/);
  assert.match(app, /for \(const id of \['#story-from', '#story-to'\]\) \$\(id\)\.addEventListener\('change', \(\) => localStorage\.setItem\(STORY_RANGE_KEY/);
});
