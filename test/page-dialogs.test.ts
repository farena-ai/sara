// 3.22.1: every <dialog> and <form> in the page is closed (the U4-A merge dropped the Money dialog's
// closing tags, which hid Settings, Health, Family and every later window inside it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('index.html: dialogs and forms are balanced, and each top-level place closes before the next opens', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const count = (re: RegExp) => (html.match(re) ?? []).length;
  assert.equal(count(/<dialog[\s>]/g), count(/<\/dialog>/g), 'every <dialog> is closed');
  assert.equal(count(/<form[\s>]/g), count(/<\/form>/g), 'every <form> is closed');
  for (const id of ['money', 'health', 'family', 'trips', 'goals']) {
    const at = html.indexOf(`<dialog id="${id}"`);
    if (at < 0) continue;
    const close = html.indexOf('</dialog>', at);
    const next = html.indexOf('<dialog', at + 1);
    assert.ok(close > 0 && (next < 0 || close < next), `#${id} closes before the next dialog opens`);
  }
});
