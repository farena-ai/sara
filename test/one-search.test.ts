// 3.0.3 (owner): one search entry and one her-panel toggle outside Classic; Ctrl K everywhere.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const V4 = ':where(:root:not([data-palette="classic"]))';

test('one search: wider screens keep the top bar search and the header panel toggle only', () => {
  const css = read('web', 'v4.css');
  assert.ok(css.includes(`@media (min-width: 761px) {\n  ${V4} :is(#sidebar .side-search, #chat-head #cmd-open, #v4-strip #v4-glance-btn) { display: none; }\n}`));
  // Phones: the top bar shows only while something runs, so the header icon is the search there; the drawer keeps its box.
  assert.ok(css.includes(`@media (max-width: 760px) {\n  ${V4} #v4-strip #v4-cmd { display: none; }\n}`));
  // Specificity: two ids beat the header's `#chat-head .head-icon` display rule.
  assert.match(read('web', 'her-panel.css'), /#chat-head \.head-icon \{/);
});

test('one search: Classic is untouched and Ctrl K still opens the bar', () => {
  for (const f of ['v4.css']) for (const line of read('web', f).split('\n').filter((l) => /side-search|#cmd-open|#v4-glance-btn|#v4-cmd \{ display: none/.test(l) && /display: none/.test(l))) assert.ok(line.includes(V4), line);
  const cmd = read('web', 'command-bar.js');
  assert.match(cmd, /\(e\.key === 'k' \|\| e\.key === 'K' \|\| e\.code === 'KeyK'\)/);
  // The tour points at whichever search shows.
  const tours = read('web', 'tours.js');
  assert.match(tours, /\{ when: \(\) => !topSearch\(\), before: sidebar\(false\), sel: '#cmd-open', title: t\('Search and go'\)/);
  assert.match(tours, /\{ when: \(\) => topSearch\(\), before: sidebar\(false\), sel: '#v4-cmd', title: t\('Search and go'\)/);
  // The bar's "search messages" action only where the sidebar box shows.
  assert.match(read('web', 'app.js'), /if \(usable\(\$\('\.side-search'\)\)\) add\('search', 'search'/);
});
