// 3.0.3 (owner): the store's Add/Get buttons are normal-size V4 buttons and its tabs the V4 segmented control.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const V4 = ':where(:root:not([data-palette="classic"]))';

test('store: card actions are quiet, left-aligned, normal-size buttons (touch keeps 44 px)', () => {
  const css = read('web', 'store.css');
  assert.ok(css.includes(`${V4} .sto-card > button.sto-act { align-self: flex-start; min-width: 84px;`));
  assert.match(css, /@media \(pointer: fine\) \{[^}]*\}\s*:where\(:root:not\(\[data-palette="classic"\]\)\) \.sto-card > button\.sto-act \{ height: 32px; min-height: 0; \}/);
  assert.match(css, /\.sto-card > button\.sto-act \{[^}]*background: var\(--surface-2\)/, 'not the violet fill');
  assert.match(read('web', 'store.js'), /const act = btn\(a\.label, a\.go === 'get' \? 'sto-act' : 'ghost sto-act'/);
  // Classic keeps its look: every new rule is scoped.
  for (const line of css.split('\n').filter((l) => l.includes('sto-act'))) assert.ok(line.startsWith(V4) || line.trim().startsWith(V4), line);
});

test('store: tabs match the V4 segmented tabs of the other pages', () => {
  const css = read('web', 'store.css');
  assert.ok(css.includes(`${V4} .sto-seg { display: flex; flex-wrap: wrap; gap: 2px; width: fit-content; max-width: 100%; margin: 8px 0 12px; padding: 3px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); }`));
  assert.ok(css.includes(`${V4} .sto-seg button[aria-selected="true"] { border-color: var(--acc-line); background: var(--accent-soft); color: var(--text-1); box-shadow: 0 0 14px -6px var(--acc-glow); }`));
  // The same look as web/v4-pages.css .tabs .tab.active.
  assert.match(read('web', 'v4-pages.css'), /\.tabs \.tab:is\(\.active, \[aria-selected="true"\]\) \{ border-color: var\(--acc-line\); background: var\(--accent-soft\); color: var\(--text-1\); box-shadow: 0 0 14px -6px var\(--acc-glow\); \}/);
  assert.doesNotMatch(css, /\.sto-seg button\[aria-selected="true"\] \{ background: transparent;[^}]*border-bottom-color/);
});

test('store: the item panel names a companion\'s action like its card (Add)', () => {
  assert.match(read('web', 'store.js'), /btn\(updatable \? t\('Update'\) : i\.kind === 'companion' \? t\('Add'\) : t\('Get'\), ''/);
});
