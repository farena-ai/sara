// 3.0.3 fresh-eyes pass: the small layout and flow fixes found by walking every page as a new user.
// Sara Classic stays as it was: every new rule is scoped to the V4 palettes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const V4 = ':where(:root:not([data-palette="classic"]))';

test('fresh: the bars above the composer sit in its column (desktop and phone)', () => {
  const css = read('web', 'v4.css');
  assert.ok(css.includes(`${V4} :is(#activity, .editing-bar, .offrecord-bar, .jobs-strip, #attachments) { max-width: 780px; width: calc(100% - 48px); }`));
  assert.ok(css.includes(`${V4} :is(#activity, .editing-bar, .offrecord-bar, .jobs-strip, #attachments) { width: calc(100% - 16px); }`));
  // Same numbers as the composer they line up with.
  assert.match(css, /#composer \{ max-width: 780px; margin: 0 auto 18px; width: calc\(100% - 48px\);/);
});

test('fresh: an icon followed by bare words keeps a gap (zero specificity, V4 only)', () => {
  assert.ok(read('web', 'v4.css').includes(':where(:root:not([data-palette="classic"]) button:has(> svg.ic:first-child:only-child)) { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }'));
});

test('fresh: the header pill ends a long model and folder name in an ellipsis', () => {
  assert.ok(read('web', 'v4.css').includes(`${V4} #conv-settings-btn > #conv-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`));
});

test('fresh: with More open the places list scrolls, so the sidebar footer stays above the phone bar', () => {
  assert.ok(read('web', 'v4.css').includes(`${V4} #side-nav.more-open { min-height: 0; overflow-y: auto; scrollbar-width: thin; }`));
});

test('fresh: file pickers wear the V4 button', () => {
  assert.ok(read('web', 'v4.css').includes(`${V4} input[type="file"]::file-selector-button {`));
});

test('fresh: every dot on the memory map is a colour its legend names', () => {
  const js = read('web', 'memory-map.js');
  assert.doesNotMatch(js, /acc2/);
  assert.match(js, /ctx\.fillStyle = n\.fading \? col\.dim : n\.hub \|\| n\.pinned \? col\.acc : col\.ink;/);
});

test('fresh: Library ways in one row, Memory labels on one line, Team and Evals tidy', () => {
  const html = read('web', 'index.html');
  assert.match(html, /<div class="lib-ways">\s*<p class="small"><button id="lib-feed-together"[\s\S]*?id="lib-meetings-open"[\s\S]*?<\/p>\s*<\/div>/);
  const css = read('web', 'v4-pages.css');
  assert.ok(css.includes(`${V4} #library .lib-ways { display: flex; flex-wrap: wrap;`));
  assert.ok(css.includes(`${V4} #memory .mem-add { grid-template-columns: minmax(0, 1fr) auto auto auto; }`));
  // The Team page's empty list draws one dashed panel, not one inside another.
  assert.ok(css.includes(':is(.empty, .lib-empty, .is-empty:not(.team-cols), #lib-summary:not(:empty), .ev-empty, .fd-empty)'));
  assert.ok(css.includes(`${V4} #evals :is(.ev-new, .ev-past) { padding: 14px 16px; }`));
  assert.ok(css.includes(`${V4} #avatar-ap-link { margin-left: 12px; }`));
});

test('fresh: Webhooks shows one New webhook button when there are none yet', () => {
  const js = read('web', 'hooks.js');
  assert.match(js, /const top = \$\('#hk-new'\)\?\.closest\('\.add-row'\);\s*if \(top\) top\.hidden = !state\.hooks\.length;/);
});

test('fresh: + New in a chat that is still empty stays in it', () => {
  const js = read('web', 'app.js');
  const fn = /async function newConversation\(projectId = null, offRecord = false\) \{([\s\S]*?)\n\}/.exec(js)![1];
  const guard = fn.indexOf("!state.messages?.length && !$('#messages')?.querySelector('.msg')");
  assert.ok(guard > 0, 'the empty-chat guard is there');
  assert.ok(guard < fn.indexOf("api('/conversations', { method: 'POST'"), 'and it runs before a chat is created');
  assert.match(fn, /if \(!offRecord && cur && cur\.id === state\.currentId && !cur\.offRecord && \(cur\.projectId \?\? null\) === \(projectId \?\? null\)/);
});

test('fresh: Operations shows local times and setup starts in the name field', () => {
  const ops = read('web', 'operations.js');
  assert.match(ops, /\[t\('Since'\), when\(data\.since\)\], \[t\('Sampled at'\), when\(data\.sampledAt\)\]/);
  assert.match(read('web', 'setup-wizard.js'), /suShow\(1\);\s*\$\('#setup'\)\.showModal\(\);\s*\/\/[^\n]*\n\s*\$\('#su-owner'\)\.focus\(\);/);
});

test('fresh: Sara Classic is untouched (every fresh-pass rule is V4-scoped)', () => {
  for (const f of ['v4.css', 'v4-pages.css']) {
    const css = read('web', f);
    const blocks = css.split('/* Fresh pass').slice(1);
    assert.ok(blocks.length > 0, f);
    for (const b of blocks) {
      const rules = b.slice(b.indexOf('*/') + 2).split('\n').filter((l) => l.includes('{') && !l.trim().startsWith('@media') && !l.trim().startsWith('/*'));
      const first = rules[0] ?? '';
      assert.ok(first.includes(':root:not([data-palette="classic"])'), `${f}: ${first.slice(0, 80)}`);
    }
  }
});
