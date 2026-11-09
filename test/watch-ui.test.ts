// E4 slice 3: the Watch a file card and the chat card. Static checks (no build step): no inline
// styles, every ? tip within 260 characters, the chat renders watch notices as their own card and
// "Ask about this" only fills the message box (it never sends by itself).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('watch ui: the card lives in Planner → Routines and the chat shows watch notices as cards', () => {
  const html = web('index.html');
  const js = web('watches.js');
  const app = web('app.js');
  assert.match(html, /<h3 id="rt-watch-h">Watch a file <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<div id="rt-watch"/);
  assert.doesNotMatch(js, /style=|\.style\./);
  // Every control of the add form goes through field(label, input, ? tip).
  const fields = [...js.matchAll(/(?:field|add)\(t\('[^']*'\), \w+, t\('((?:[^'\\]|\\.)*)'\)\)/g)];
  assert.equal(fields.length, 6, 'where, file, words, case, how often, the card\'s chat');
  for (const m of fields) assert.ok(m[1].length <= 260, m[1]);
  // E4 follow-up: one "Also send to" switch per linked bridge, each with its tip, off unless the watch has it.
  assert.match(js, /add\(b === 'telegram' \? t\('Also send to Telegram'\) : t\('Also send to Discord'\), cb, BRIDGE_TIPS\[b\]\(\)\)/);
  for (const m of js.matchAll(/(?:telegram|discord): \(\) => t\('((?:[^'\\]|\\.)*)'\)/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.match(js, /cb\.checked = Boolean\(w\?\.alsoTo\?\.includes\(b\)\)/, 'off by default');
  assert.equal([...js.matchAll(/document\.createElement\('(input|select)'\)/g)].length, 7, 'no control without a field');
  assert.match(app, /m\.kind === 'watch'\) \{\s*\/\/[^\n]*\n\s*els\.push\(watchNotice\(m\)\)/);
  assert.match(app, /content\.startsWith\('watch:'\)\) append\(watchNotice/);
  // Ask about this: his own words in the message box; nothing is sent for him.
  const ask = /export async function askAbout[\s\S]*?\n}\n/.exec(js)![0];
  assert.match(ask, /r\.cloud && !confirm\(/);
  assert.doesNotMatch(ask, /send\(|\/messages|method: 'POST', body: \{ content/);
  assert.match(web('routines.js'), /void loadWatches\(\);/);
});
