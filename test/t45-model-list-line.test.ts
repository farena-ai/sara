// T45 E5: "Model list: checked 2 h ago ↻ Refresh" on a phone. The status and its Refresh button
// are one piece that stays together; the button's own words never break. A layout rule, so this is
// a small check of the markup and the CSS (no browser here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('T45 model list line: the status and Refresh are one piece that does not break apart', () => {
  const js = web('app.js');
  assert.match(js, /const checked = el\('span', 'provider-checked'\);\s*checked\.append\(status, refresh\);/);
  assert.match(js, /line\.append\(el\('span', '', `\$\{t\('Model list'\)\}: `\), checked\);/);
  const css = web('style.css');
  const group = /\.provider-checked \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(group, /display: flex/);
  assert.match(group, /min-width: 0/, 'a long status may wrap inside it');
  assert.doesNotMatch(group, /flex-wrap: wrap/, 'the button stays on the status line');
  const button = /\.provider-checked > button \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(button, /white-space: nowrap/);
  assert.match(button, /flex: none/);
  // The line itself may still wrap between the label and that piece.
  assert.match(css, /\.provider-models, \.provider-switches \{[^}]*flex-wrap: wrap/);
});
