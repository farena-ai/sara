// Leftovers (2026-11-14): small web fixes from earlier rounds, each checked here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chartCard } from '../src/cards.ts';
import { markdownTable, runQuery, tableFromGrid } from '../src/table-query.ts';
import { stoppedByPerson } from '../web/step-words.js';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('Leftover 2: a command the person stopped reads "Stopped", not "Didn\'t work"', () => {
  // The server's own words for a stopped command (src/chat.ts), for the owner or by name.
  const chat = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
  assert.match(chat, /stopped this command before it finished\.\\n\$\{output\}/);
  assert.equal(stoppedByPerson({ status: 'error', output: 'The owner stopped this command before it finished.\nExit code 130' }), true);
  assert.equal(stoppedByPerson({ status: 'error', output: 'Alex stopped this command before it finished.\n' }), true);
  assert.equal(stoppedByPerson({ status: 'error', stopped: true, output: '' }), true);
  // A real failure, or an ok step that merely mentions it, stays as it was.
  assert.equal(stoppedByPerson({ status: 'error', output: 'Error: exit code 1' }), false);
  assert.equal(stoppedByPerson({ status: 'ok', output: 'The owner stopped this command before it finished.' }), false);
  assert.equal(stoppedByPerson({ status: 'error', output: 'Exit 1\nThe owner stopped this command before it finished.' }), false);
  assert.equal(stoppedByPerson(undefined), false);
  // The step line (live and history), its one-line summary and the run view all use it.
  const steps = web('steps.js');
  assert.match(steps, /import \{ stoppedByPerson \} from '\.\/step-words\.js'/);
  assert.equal((steps.match(/stoppedByPerson\(/g) ?? []).length >= 2, true);
  assert.match(web('run-view.js'), /stoppedByPerson\(x\) \? t\('Stopped: \{what\}'/);
  assert.match(web('look.css'), /\.step\.stopped \.step-verb \{ color: var\(--text-2\); \}/);
});

test('Leftover 3: the Ctrl+Enter hint is hidden on phones (touch or narrow screens)', () => {
  const html = web('index.html');
  assert.match(html, /<span class="muted small">She stops at once and reads it\.<span class="kbd-hint"> Ctrl\+Enter\.<\/span><\/span>/);
  assert.doesNotMatch(html, /reads it\. Ctrl\+Enter\.<\/span>/);
  assert.match(web('busy.css'), /@media \(pointer: coarse\), \(max-width: 720px\) \{ \.kbd-hint \{ display: none; \} \}/);
});

test('Leftover 4: the folded "She was saying…" shows the first ~80 characters', () => {
  const busy = web('busy.js');
  const src = /export function sayingPreview\(text, n = 80\) \{[\s\S]*?\n\}/.exec(busy)?.[0];
  assert.ok(src, 'sayingPreview is in web/busy.js');
  const sayingPreview = new Function(`${src.replace('export ', '')}; return sayingPreview;`)() as (s: unknown) => string;
  assert.equal(sayingPreview('  Short   reply\nhere '), 'Short reply here');
  const long = 'I was going to say that the tests on the second server pass now, and the deploy is ready to go whenever you are.';
  const p = sayingPreview(long);
  assert.ok(p.length <= 81 && p.endsWith('…'), p);
  assert.equal(p, 'I was going to say that the tests on the second server pass now, and the deploy…');
  assert.equal(sayingPreview('x'.repeat(200)), `${'x'.repeat(80)}…`);
  assert.equal(sayingPreview(undefined), '');
  // The fold puts it on the toggle; folded, only the toggle shows; open, the preview hides.
  assert.match(busy, /tg\.append\(' ', ctx\.el\('span', 'saying-preview', preview\)\)/);
  const css = web('busy.css');
  assert.match(css, /\.msg\.was-saying\.collapsed > :not\(\.saying-toggle\) \{ display: none; \}/);
  assert.match(css, /\.msg\.was-saying:not\(\.collapsed\) \.saying-preview \{ display: none; \}/);
});

test('Leftover 10: a grouped analyze_table result comes with a bar chart card', () => {
  const tbl = tableFromGrid('sales.csv', [['Region', 'Amount'], ['North', '120'], ['South', '80.5'], ['North', '30'], ['East', '0'], ['West|Coast', '10']]);
  const query = { groupBy: ['Region'], aggregates: [{ fn: 'sum' as const, column: 'Amount' }] };
  const out = `${markdownTable(runQuery(tbl, query))}\nComputed by analyze_table from sales.csv: 5 of 5 rows matched the filters.`;
  const card = chartCard({ file: 'sales.csv', query }, out);
  assert.ok(card && card.kind === 'chart', out);
  assert.equal(card.label, 'Region');
  assert.match(card.title, / by Region$/);
  assert.deepEqual(new Map(card.rows.map((r) => [r.label, r.value])), new Map([['North', 150], ['South', 80.5], ['East', 0], ['West|Coast', 10]]));
  // No grouping, a single group, or a negative value: no chart (the table is enough).
  assert.equal(chartCard({ query: { aggregates: [{ fn: 'sum', column: 'Amount' }] } }, out), undefined);
  assert.equal(chartCard({ query }, '| Region | sum |\n| --- | --- |\n| North | 1 |'), undefined);
  assert.equal(chartCard({ query }, '| Region | sum |\n| --- | --- |\n| North | 1 |\n| South | -2 |'), undefined);
  // Many groups: the first 20, and how many more.
  const many = `| G | n |\n| --- | --- |\n${Array.from({ length: 25 }, (_, i) => `| g${i} | ${i} |`).join('\n')}`;
  const big = chartCard({ query }, many);
  assert.ok(big && big.kind === 'chart' && big.rows.length === 20 && big.more === 5);
  // The web draws it: bars as SVG rects (no inline style), the numbers beside them, theme colors.
  const cards = web('result-cards.js');
  assert.match(cards, /function chart\(c\)/);
  assert.match(cards, /search, chart,/);
  assert.doesNotMatch(cards.slice(cards.indexOf('function chart(c)'), cards.indexOf('function search(c)')), /style/);
  assert.match(web('look.css'), /\.rc-chart-bar rect \{ fill: var\(--accent-solid\); \}/);
});
