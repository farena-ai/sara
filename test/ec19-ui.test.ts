// EC19 slice 4: Library → Meetings. Static checks (no build step): the entry button and section with
// ? tips, no inline styles, every control with a label and a tip (<= 260 characters), both consent
// ticks, the spoken and shown notice, "I understand" before a device's microphone opens, the
// to-do approval buttons, the policy pin checkbox, and the room reusing the R2 hands-free call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('ec19 ui: Meetings in the Library with consent, notices, tips and no inline styles', () => {
  const html = web('index.html');
  const js = web('meetings.js');
  assert.match(html, /<button id="lib-meetings-open" type="button" class="ghost small" data-owner-only>Meetings…<\/button> <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button>/);
  assert.match(html, /<section id="lib-meetings" hidden>[\s\S]*?<div id="lib-m-body"[\s\S]*?<\/section>/);
  assert.match(html, /<link rel="stylesheet" href="\/meetings\.css">/);
  assert.doesNotMatch(js, /style=|\.style\./);
  assert.doesNotMatch(web('meetings.css'), /!important/);
  const fields = [...js.matchAll(/field\(t\('[^']*'\), \w+, t\('((?:[^'\\]|\\.)*)'\)\)/g)];
  assert.equal(fields.length, 7, 'title, keep, consent (room); file, title, keep, consent (file)');
  for (const m of fields) assert.ok(m[1].length <= 260, m[1]);
  assert.equal([...js.matchAll(/document\.createElement\('(input|select|textarea)'\)/g)].length, 1, 'one input maker');
  assert.equal([...js.matchAll(/= input\('(text|checkbox|file)'\)/g)].length, 7, 'no control without a field');
  for (const s of ["t('Everyone in the room knows Sara will listen and take notes')", "t('Everyone in this recording knew it was recorded and agreed to notes')", "t('I understand, start my microphone')", "t('Add to Planner')", "t('Add all to Planner')", "t('End and write the notes')", "t('Write the notes again')"]) assert.ok(js.includes(s), s);
  assert.match(js, /speaker\.say\(m\.announce\)/, 'the notice is spoken');
  assert.match(js, /class=?.*ms-notice|'ms-notice'/, 'and shown');
  assert.match(js, /import \{ Call, Mic, Speaker \} from '\.\/voice\.js'/);
  for (const p of ['/join', '/audio?speaker=', '/end', '/notes', '/todos', '/recording', '/meetings/file?']) assert.ok(js.includes(p), p);
  assert.match(web('library.js'), /openMeetings\(\)/);
  assert.match(html, /<input id="po-meetings" type="checkbox"> Turn off meetings <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button>/);
  assert.match(web('policy-pins.js'), /key: 'meetings', .*form: '#po-meetings', kind: 'flag', value: false/);
});
