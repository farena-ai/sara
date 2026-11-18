// V0.5 (docs/WHATS_NEW.md): the What's new release chores inside scripts/whats-new.ts: `--prune` drops
// the translations of highlights that fell off the 8-release window (never a key something else still
// uses), and the plain list of what to translate. Pure functions plus one dry run on this tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { goneStrings, pruneLangText, translateList } from '../scripts/whats-new.ts';
import { ROOT } from './helpers.ts';

const data = (...titles: string[][]) => JSON.stringify({ format: 'sara-whats-new/1', releases: titles.map(([title, ...texts], i) => ({ version: `1.${i}.0`, date: '2026-01-01', title, items: texts.map((text, j) => ({ id: `x${i}-${j}`, kind: 'new', text })) })) });

test('V0.5 goneStrings: what was in the old file, is not in the new one and nothing else uses', () => {
  const old = data(['Old release', 'Gone line.', 'Still used by a page.'], ['Kept release', 'Kept line.']);
  const next = data(['Kept release', 'Kept line.'], ['New release', 'New line.']);
  const gone = goneStrings([old, '', 'not json'], next, new Set(['Still used by a page.', 'Kept line.', 'New line.', 'Kept release', 'New release']));
  assert.deepEqual([...gone].sort(), ['Gone line.', 'Old release']);
});

test('V0.5 pruneLangText: drops exactly those lines, keeps the file as it was written, still valid JSON', () => {
  for (const nl of ['\n', '\r\n']) {
    const raw = ['{', '"Keep me": "Guárdame",', '"Gone line.": "Línea ida",', '"Say \\"hi\\"": "Di \\"hola\\"",', '"Old release": "Versión vieja"', '}', ''].join(nl);
    const r = pruneLangText(raw, new Set(['Gone line.', 'Old release', 'Say "hi"']));
    assert.equal(r.removed, 3);
    assert.deepEqual(JSON.parse(r.text), { 'Keep me': 'Guárdame' });
    assert.ok(r.text.endsWith(`}${nl}`) && !r.text.includes(nl === '\n' ? '\r' : '\n\n'), 'same line endings');
    const same = pruneLangText(raw, new Set(['Not there']));
    assert.equal(same.removed, 0);
    assert.equal(same.text, raw, 'untouched when nothing goes');
  }
});

test('V0.5 translateList: per highlight the languages that still need it, ready-to-append lines per language', () => {
  const out = translateList({ es: ['A new line.'], fr: ['A new line.', 'Another "one".'] });
  assert.match(out, /2 strings? to translate/);
  assert.match(out, /"A new line\."  ← es, fr/);
  assert.match(out, /--- web\/i18n\/fr\.json \(append before the last }\) ---\n"A new line\.": "",\n"Another \\"one\\"\.": "",/);
  assert.equal(translateList({}), '');
});

test('V0.5 the script: --prune --dry-run on this tree lists nothing to drop and writes nothing', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/whats-new.ts', '--prune', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Prune \(dry run\): nothing to drop/);
});
