// Safe Markdown parser used for chat replies (web/markdown.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain JS module shared with the browser
import { inline, parse, plain } from '../web/markdown.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { t: string; [k: string]: any };
const tags = (nodes: N[]) => nodes.map((n) => n.t);

test('blocks: paragraphs, headings, lists, quotes, fences, rules', () => {
  const doc = parse('# Plan\n\nFirst line\nsecond line\n\n- one\n- two\n  - nested\n1. a\n2. b\n\n> quoted\n\n```ts\nconst x = 1;\n```\n---\nend') as N[];
  assert.deepEqual(tags(doc), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr', 'p']);
  const ul = doc[2] as unknown as { items: { sub: N[] }[] };
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[1].sub[0].t, 'ul', 'indented item nests');
  assert.deepEqual(doc[5], { t: 'code', lang: 'ts', text: 'const x = 1;', open: false });
  assert.equal(plain((doc[1] as unknown as { kids: N[] }).kids), 'First line\nsecond line');
});

test('an unclosed fence while streaming is an open code block (no copy button yet)', () => {
  const doc = parse('Here:\n```py\nprint(1)') as N[];
  assert.equal(doc[1].t, 'code');
  assert.equal(doc[1].open, true);
});

test('inline: code, bold, italic, strike, links; snake_case and stray stars stay text', () => {
  assert.deepEqual(tags(inline('use `a*b` and **bold** or *it* ~~no~~')), ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'del']);
  assert.equal(plain(inline('my_var_name and 2 * 3 * 4')), 'my_var_name and 2 * 3 * 4');
  assert.deepEqual(tags(inline('my_var_name')), ['text']);
  const link = inline('see [docs](https://x.com/a?b=1).')[1] as N;
  assert.equal(link.t, 'a');
  assert.equal(link.href, 'https://x.com/a?b=1');
  const bare = inline('go to https://example.com/page, then') as N[];
  assert.equal(bare[1].href, 'https://example.com/page', 'trailing comma not part of the link');
});

test('unsafe links are never links', () => {
  for (const s of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/relative)']) {
    assert.ok(!tags(inline(s)).includes('a'), s);
  }
  // HTML is just text.
  assert.equal(plain(inline('<img src=x onerror=alert(1)>')), '<img src=x onerror=alert(1)>');
});

test('long conversations: history is budgeted, old tool output shortened, a note says so', async () => {
  const { buildHistory } = await import('../src/chat.ts');
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    conversationId: 'c',
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: `${i}:${'x'.repeat(1000)}`,
    createdAt: '',
  }));
  const all = buildHistory(msgs);
  assert.equal(all.messages.length, 40);
  assert.equal(all.dropped, 0);
  const cut = buildHistory(msgs, 10_000);
  assert.ok(cut.messages.length < 12 && cut.messages.length > 5, String(cut.messages.length));
  assert.equal(cut.messages.at(-1)!.content.startsWith('39:'), true, 'newest kept');
  assert.equal(cut.firstKeptId, 40 - cut.messages.length + 1);
  const withTool = [
    { id: 1, conversationId: 'c', role: 'user' as const, content: 'go', createdAt: '' },
    { id: 2, conversationId: 'c', role: 'assistant' as const, content: '', createdAt: '', meta: { toolCalls: [{ id: 't', name: 'shell', arguments: {} }] } },
    { id: 3, conversationId: 'c', role: 'tool' as const, content: 'y'.repeat(30_000), createdAt: '', meta: { toolCallId: 't', name: 'shell' } },
    ...msgs.slice(0, 14).map((m) => ({ ...m, id: m.id + 3, content: 'short' })),
  ];
  const t = buildHistory(withTool, 5_000);
  const tool = t.messages.find((m) => m.role === 'tool');
  assert.ok(tool && tool.content.length < 2_000 && tool.content.includes('shortened'), 'old tool output shortened before dropping messages');
});

// V1 audit: a markdown table in a reply was shown as raw "| a | b |" text.
test('V1: tables become a table node (header, alignment, inline cells); a lone pipe line stays text', () => {
  const doc = parse('Compare:\n\n| Option | Risk | Runtime |\n|:---|---|---:|\n| Await `finish` | Low | 1.2 s |\n| Retry \\| loop | **Medium** | 2.9 s |\nafter') as N[];
  assert.deepEqual(tags(doc), ['p', 'table', 'p']);
  const t = doc[1];
  assert.deepEqual(t.align, ['left', '', 'right']);
  assert.deepEqual(t.head.map((c: N[]) => plain(c)), ['Option', 'Risk', 'Runtime']);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(tags(t.rows[0][0]), ['text', 'code'], 'inline markdown inside cells');
  assert.equal(plain(t.rows[1][0]), 'Retry | loop', 'an escaped pipe stays in the cell');
  assert.deepEqual(tags(t.rows[1][1]), ['strong']);
  // Rows shorter than the header are padded; longer ones are cut to the header; a line without a pipe ends the table.
  const ragged = parse('a | b\n--|--\n1 |\n1 | 2 | 3') as N[];
  assert.equal(ragged[0].t, 'table', 'outer pipes are optional');
  assert.deepEqual(ragged[0].rows.map((r: N[][]) => r.length), [2, 2]);
  // Not a table: no separator line, or a paragraph that only mentions a pipe.
  assert.deepEqual(tags(parse('| just | text |\nnext line') as N[]), ['p']);
  assert.deepEqual(tags(parse('use a | b in the shell') as N[]), ['p']);
  // While streaming, the header alone stays a paragraph until the separator arrives.
  assert.deepEqual(tags(parse('| a | b |') as N[]), ['p']);
  assert.match(plain([t]), /Option\tRisk\tRuntime\nAwait finish\tLow\t1.2 s/);
});

test('V1: tables are drawn with real table elements, alignment as classes (no inline style), scrollable on a phone', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8');
  assert.match(src, /case 'table': \{/);
  assert.match(src, /wrap\.className = 'md-table';/);
  for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td']) assert.ok(src.includes(`'${tag}'`), tag);
  assert.doesNotMatch(src, /\.style\./, 'alignment through classes, never inline styles');
  const css = ['style.css', 'look.css'].map((f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.match(css, /\.msg \.md \.md-table \{[^}]*overflow-x: auto;/);
  assert.match(css, /\.msg \.md \.md-table \.ta-right \{ text-align: right;/);
});
