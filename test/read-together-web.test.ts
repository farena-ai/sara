// E5b: the Read together view. Static checks (no build step): no inline styles, every string
// through t() and translated, the Follow and Stop tips within 260 characters, positions and hashes
// only in what the browser sends, and the browser hash equal to the server's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LANGS } from '../scripts/i18n-extract.ts';
import { textHash } from '../src/read-together.ts';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('read together web: the view sits in the chat with Follow (off), Share, Stop and their tips', () => {
  const html = web('index.html');
  const panel = /<section id="rt-panel"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.ok(panel, 'the panel is in index.html');
  assert.ok(html.indexOf('id="rt-panel"') < html.indexOf('id="messages"'), 'above the messages, inside the chat');
  assert.match(panel, /<input id="rt-follow" type="checkbox">/, 'Follow is off by default');
  assert.doesNotMatch(panel, /rt-follow"[^>]*checked/);
  for (const id of ['rt-share', 'rt-stop', 'rt-now', 'rt-note', 'rt-private', 'rt-text']) assert.match(panel, new RegExp(`id="${id}"`));
  const tips = [...panel.matchAll(/class="tip" data-tip="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tips.length, 3, 'Stop, Follow and (E6) Feed');
  for (const tip of tips) assert.ok(tip.length <= 260, tip);
  assert.match(tips[0], /can.t be unsent/);
  assert.match(tips[1], /^Off by default/);
  assert.doesNotMatch(panel, /style=/);
  assert.match(html, /<button id="lib-doc-together" type="button" class="ghost small" title="[^"]{20,260}" hidden>Read together<\/button>/);
});

test('read together web: no inline styles, strings through t(), and only positions and hashes are sent', () => {
  const js = web('read-together.js');
  assert.doesNotMatch(js, /style=|\.style\.|innerHTML/);
  assert.doesNotMatch(js, /(textContent = |note\()['"`]/, 'user-visible text goes through t()');
  assert.doesNotMatch(js, /\btext: /, 'the text itself is never sent');
  assert.match(js, /sha256Hex\(text\)/);
  assert.match(js, /1500/);
  assert.match(js, /5000/);
  // Every string is translated in each language.
  const keys = [...js.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(keys.length >= 8);
  for (const lang of LANGS) {
    const dict = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of keys) assert.ok(dict[k], `${lang}: ${k}`);
  }
  // Wiring: the Library button (text/Markdown kept documents) and the chat switch.
  assert.match(web('library.js'), /\$\('#lib-doc-together'\)\.hidden = !\(d\.keep && !d\.readOnly && d\.status === 'ready' && \['text', 'markdown'\]\.includes\(d\.kind\)\)/);
  const app = web('app.js');
  assert.match(app, /initReadTogether\(\{ api, current: \(\) => state\.currentId \}\)/);
  assert.match(app, /readTogetherSwitched\(conv\.id\)/);
});

test('read together web: the browser hash is the server hash (NFC, UTF-8) and excerpts join the same way', async () => {
  const src = web('read-together.js').replace("import { t } from './naming.js';", 'const t = (s) => s;');
  const m = (await import(`data:text/javascript,${encodeURIComponent(src)}`)) as { sha256Hex: (s: string) => string; excerptOf: (t: string[], a: number, b: number) => string };
  for (const s of ['', 'Plug the heater in.', 'Café ✓ 😀 e\u0301', 'x'.repeat(55), 'y'.repeat(64), 'long '.repeat(900)]) assert.equal(m.sha256Hex(s), textHash(s));
  assert.equal(m.excerptOf(['abcdef'], 1, 4), 'bcd');
  assert.equal(m.excerptOf(['abc', 'mid', 'xyz'], 1, 2), 'bc\n\nmid\n\nxy');
});

test('read together web (E6b): the Feed tab has an address, Open, Reload, an item list and one tip', () => {
  const html = web('index.html');
  const panel = /<section id="rt-panel"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  for (const id of ['rt-tab-doc', 'rt-tab-feed', 'rt-doc-pane', 'rt-feed-pane', 'rt-feed-url', 'rt-feed-go', 'rt-feed-reload', 'rt-feed-items']) assert.match(panel, new RegExp(`id="${id}"`), id);
  const pane = /<div id="rt-feed-pane"[\s\S]*?<ul id="rt-feed-items"[^>]*><\/ul>/.exec(panel)?.[0] ?? '';
  const tips = [...pane.matchAll(/class="tip" data-tip="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tips.length, 1, 'one ? tip on the Feed tab');
  assert.ok(tips[0].length <= 260, tips[0]);
  assert.match(tips[0], /only when you press Open or Reload/);
  assert.match(pane, /<input id="rt-feed-url" type="url"/);
  assert.match(pane, /id="rt-feed-reload"[^>]*hidden/, 'Reload appears once a feed is open');
  assert.doesNotMatch(panel, /style=|<iframe|<img/);
  assert.match(html, /<button id="lib-feed-together" type="button" class="ghost small" title="[^"]{20,260}" data-owner-only>Read a feed together<\/button>/);
});

test('read together web (E6b): items are drawn as text, links open only on a click, only keys and hashes are sent, no timers fetch', () => {
  const js = web('read-together.js');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|createElement\('(img|iframe)'\)|\.src = /);
  assert.match(js, /title\.textContent = item\.title/);
  assert.match(js, /rel = 'noopener noreferrer'/);
  assert.match(js, /\^https\?:\\\/\\\//, 'only http(s) links become links');
  assert.match(js, /\{ source: 'feed', rev: open\.feed\.rev, key: item\.key, textSha: item\.textSha \}/);
  assert.doesNotMatch(js, /setInterval/);
  // The feed is fetched in one place only, by Open or Reload.
  assert.equal([...js.matchAll(/\/feed`/g)].length, 1);
  assert.match(js, /\$\('#rt-feed-go'\)\.addEventListener\('click', \(\) => void loadFeed\(\$\('#rt-feed-url'\)\.value\)\)/);
  assert.match(js, /\$\('#rt-feed-reload'\)\.addEventListener\('click', \(\) => void loadFeed\(open\?\.feed\?\.url\)\)/);
  assert.match(web('library.js'), /openReadFeed\(\)/);
});
