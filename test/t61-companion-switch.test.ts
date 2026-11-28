// T61 (owner, 2026-11-28): with more than one companion, her face and name at the bottom left open a
// list to switch between them; with one companion it still opens her page. Checked in a browser on a
// local server with two companions (the switch reloads the app as the other one).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('T61: the bottom-left face opens the companion list when there is more than one', () => {
  const html = read('web/index.html');
  assert.match(html, /<button id="open-sara"[^>]*>.*<\/button>\n\s*<div id="side-companion-menu" class="companion-menu side-companion-menu" role="menu" hidden><\/div>/);
  const app = read('web/app.js');
  // One companion: her page, as before. More: the list.
  assert.match(app, /if \(\(state\.companions\?\.companions\.length \?\? 0\) < 2\) return void openSara\(\);/);
  // Both menus are built from the same items, and the side one adds her page and the manage link.
  assert.match(app, /function companionItems\(d\)/);
  assert.match(app, /\$\('#side-companion-menu'\)\.replaceChildren\(\.\.\.companionItems\(d\), sideItem\(t\('Her page'\)/);
  assert.match(app, /menu\.replaceChildren\(\n\s*\.\.\.companionItems\(d\),/);
  // Alt+H and #view=her still open her page directly (the button may now open a list).
  assert.match(app, /KeyH: \(\) => void openSara\(\)/);
  assert.match(app, /her: \(\) => void openSara\(\)/);
  // Escape closes it; the names in it are never rewritten to the current companion's name.
  assert.match(app, /if \(e\.key === 'Escape'\) \{\n\s*e\.stopPropagation\(\);\n\s*closeSideCompanions\(true\);/);
  assert.match(read('web/naming.js'), /'#side-companion-menu'/);
  assert.match(read('web/v4.css'), /\.side-companion-menu \{ top: auto; bottom: calc\(100% \+ 6px\);/);
});
