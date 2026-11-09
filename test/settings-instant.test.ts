// 3.0.3 (owner decision): Settings opens on the click and fills in as its data arrives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const fn = (src: string, head: string) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, head);
  return src.slice(i, src.indexOf('\n}\n', i));
};

test('settings: the dialog shows before any page data is asked for', () => {
  const body = fn(read('web', 'app.js'), 'async function openSettings(');
  const show = body.indexOf("$('#settings').showModal()");
  const load = body.indexOf('await loadSettingsPages(');
  assert.ok(show > 0 && load > show, 'showModal comes before the load');
  assert.ok(body.indexOf("settingsLoading('all')") < show, 'pages are marked loading before the dialog shows');
  assert.match(body, /settingsLoading\('rest'\)/, 'core pages fill in first');
  assert.match(body, /finally \{[\s\S]*settingsLoading\(''\)/, 'loading always ends, also on an error');
  assert.match(body, /setTimeout\(\(\) => run === settingsLoad && settingsLoading\(''\), 15000\)/, 'a loader that never answers is capped');
  assert.match(body, /catch \(err\) \{\s*\$\('#settings-error'\)\.textContent/, 'a failed load is said in the dialog, which stays open');
});

test('settings: loading pages are inert and the core and tools reads go out together', () => {
  const src = read('web', 'app.js');
  const mark = fn(src, 'function settingsLoading(');
  assert.match(mark, /p\.inert = wait/);
  assert.match(mark, /aria-busy/);
  assert.match(src, /const OWN_LOADER_PAGES = new Set\(\['ab-store'\]\)/);
  const load = fn(src, 'async function loadSettingsPages(');
  assert.match(load, /const tools = isMember\(\) \? null : loadTools\(\);[\s\S]*await Promise\.all\(\[api\('\/settings'\), loadProviders\(\), loadYours\(\)\]\)/);
  assert.ok(load.indexOf('onCore()') < load.indexOf('await tools'));
  assert.doesNotMatch(load, /await loadTools\(\)/);
});

test('settings: the skeleton keeps the layout and is still under reduced motion', () => {
  const css = read('web', 'style.css');
  assert.ok(css.includes('.settings-page.st-loading > * { visibility: hidden; }'));
  assert.match(css, /\.settings-page\.st-loading::after \{[^}]*position: absolute;[^}]*animation: st-shimmer/);
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { .settings-page.st-loading::after { animation: none; } }'));
  assert.ok(css.includes(':root[data-motion="off"] .settings-page.st-loading::after { animation: none; }'));
});
