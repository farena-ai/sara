// EC6 slice 4: Library → Research. Static checks (no build step): the section and its entry button
// with a ? tip, no inline styles, every control with a label and a tip (<= 260 characters), the
// three buttons of a working run, the downloads, and the reasons shown for pages that failed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('ec6 ui: Research lives in the Library with tips, plain controls and no inline styles', () => {
  const html = web('index.html');
  const js = web('research.js');
  assert.match(html, /<button id="lib-research-open" type="button" class="ghost small" data-owner-only>Research a question…<\/button> <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button>/);
  assert.match(html, /<section id="lib-research" hidden>[\s\S]*?<div id="lib-r-body"[\s\S]*?<\/section>/);
  assert.doesNotMatch(js, /style=|\.style\./);
  const fields = [...js.matchAll(/field\(t\('[^']*'\), \w+, t\('((?:[^'\\]|\\.)*)'\)\)/g)];
  assert.equal(fields.length, 4, 'question, a step, its searches, pages');
  for (const m of fields) assert.ok(m[1].length <= 260, m[1]);
  assert.equal([...js.matchAll(/document\.createElement\('(input|select|textarea)'\)/g)].length, 4, 'no control without a field');
  // 3.1.2: the run's buttons (Pause, Resume, Write the report now…) live in web/research-card.js, shared with the chat card.
  const card = web('research-card.js');
  for (const path of ['/start', '/stop', '/plan']) assert.ok(js.includes(`${path}\``), path);
  for (const path of ['/start', '/write-now', '/stop', '/pause', '/resume', '/skill', '/budget']) assert.ok(card.includes(`${path}\``), path);
  assert.doesNotMatch(card, /style=|\.style\./);
  assert.match(js, /export\?format=pdf/);
  assert.match(js, /export\?format=docx/);
  assert.match(js, /s\.reasonText/);
  assert.match(card, /t\('Write the report now'\)/);
  assert.match(web('library.js'), /openResearch\(\)/);
  assert.match(html, /<link rel="stylesheet" href="\/research\.css">/);
  assert.doesNotMatch(web('research.css'), /!important/);
});
