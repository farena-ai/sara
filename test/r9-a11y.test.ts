// R9 "Polish for everyone": the accessibility checker (web/a11y-check.js) on static HTML, no browser.
// Each rule is proven on small fragments, then the app's own pages must stay clean: images with alt,
// named buttons and links, labelled inputs, heading order, theme colors at WCAG AA in light and dark,
// a visible focus ring, the skip link and the polite live region for new messages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkContrast, checkHtml, contrast, hasFocusVisible, parseColor, PAIRS, themeVars } from '../web/a11y-check.js';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const rules = (html: string) => checkHtml(html).map((f: { rule: string }) => f.rule);

test('R9.A1 each rule finds its problem and accepts the fix', () => {
  assert.deepEqual(rules('<img src="a.png">'), ['img-alt']);
  assert.deepEqual(rules('<img src="a.png" alt=""><img src="b.png" role="presentation">'), []);
  assert.deepEqual(rules('<button type="button"></button>'), ['button-name']);
  assert.deepEqual(rules('<button type="button"><svg aria-hidden="true"></svg></button>'), ['button-name']);
  assert.deepEqual(rules('<button type="button" aria-label="Close"><svg aria-hidden="true"></svg></button><button>Save</button><div role="button" title="Open"></div>'), []);
  assert.deepEqual(rules('<span id="n">Name</span><button aria-labelledby="n"></button>'), []);
  assert.deepEqual(rules('<a href="/x"></a>'), ['link-name']);
  assert.deepEqual(rules('<input id="q" placeholder="Search">'), ['control-label']);
  assert.deepEqual(rules('<label for="q">Search</label><input id="q"><label>Name <input></label><input aria-label="Tag"><select title="Kind"></select><input type="hidden"><textarea aria-label="Note"></textarea>'), []);
  assert.deepEqual(rules('<section class="settings-page"><h2>A</h2><h4>B</h4></section>'), ['heading-order']);
  assert.deepEqual(rules('<dialog><h3>A</h3><h4>B</h4><h3>C</h3></dialog><dialog><h2>D</h2></dialog>'), []);
  // Hidden things are not read out: not checked.
  assert.deepEqual(rules('<div hidden><img src="x"></div><template><button></button></template><span aria-hidden="true"><input></span>'), []);
});

test('R9.A2 colors: WCAG math and the theme pairs', () => {
  assert.equal(Number(contrast(parseColor('#000')!, parseColor('#fff')!).toFixed(1)), 21);
  assert.equal(Number(contrast(parseColor('#777')!, parseColor('#fff')!).toFixed(2)), 4.48);
  const fake = ':root { --surface-0: #ffffff; --text-1: #111; --text-2: #aaa; }\n:root[data-theme="dark"] { --surface-0: #000; --text-1: #eee; --text-2: #888; }';
  assert.deepEqual(checkContrast(fake, 'light').map((f: { where: string }) => f.where), ['light: --text-2 on --surface-0']);
  assert.deepEqual(checkContrast(fake, 'dark'), []);
});

test('R9.A3 theme.css meets AA in light and dark', () => {
  const css = web('theme.css');
  for (const theme of ['light', 'dark']) {
    const vars = themeVars(css, theme);
    const computed = PAIRS.filter(([f, b]) => vars[f] && vars[b]).length;
    assert.ok(computed >= 10, `${theme}: ${computed} pairs computed`);
    assert.deepEqual(checkContrast(css, theme), [], theme);
  }
});

test('R9.A4 the app pages have no findings', () => {
  for (const page of ['index.html', 'offline.html', 'pair.html', 'download.html', 'device.html']) assert.deepEqual(checkHtml(web(page)), [], page);
});

test('R9.A5 keyboard and screen reader basics stay', () => {
  const html = web('index.html');
  const css = [...html.matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)"/g)].map((m) => web(m[1])).join('\n');
  assert.ok(hasFocusVisible(css), 'a visible focus ring');
  assert.match(html, /<a id="skip-main" class="skip-main" href="#chat">/);
  // The skip link is the first thing a keyboard reaches.
  const body = html.slice(html.indexOf('<body>'));
  assert.equal(body.indexOf('<a id="skip-main"'), body.search(/<(?:button|a |input|select|textarea)/), 'skip link first');
  assert.match(html, /<main id="chat"/);
  assert.match(html, /<div id="messages" aria-live="polite"/);
  // The automation templates: the gallery is a labelled list, the template card a named region.
  assert.match(html, /id="atm-gallery"[^>]*role="list"[^>]*aria-labelledby="atm-tpl-h"/);
  const js = web('automations.js');
  assert.match(js, /setAttribute\('role', 'region'\)/);
  assert.match(js, /setAttribute\('aria-live', 'polite'\)/);
});
