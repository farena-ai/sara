// 3.49.2: a long relationship section in an old agent's persona files no longer stops a move-in.
// Found importing the owner's OpenClaw companion (2026-11-27): the draft kept up to 600 characters for
// "Relationship, in your words", the sheet takes 400, and the whole import stopped on it, while the page
// silently showed the review again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { draftPersona } from '../src/movein/text.ts';
import { RELATIONSHIP_NOTE_MAX, validatePersona } from '../src/persona.ts';
import { ROOT } from './helpers.ts';

test('3.49.2: a long relationship section fits the sheet; what does not fit becomes her notes', () => {
  const base = JSON.parse(readFileSync(join(ROOT, 'persona', 'sara.json'), 'utf8'));
  const lines = Array.from({ length: 12 }, (_, i) => `- Between us, thing number ${i + 1}: we talk late at night and she remembers how his day went.`);
  const d = draftPersona('SOUL.md', [{ path: 'files/home/SOUL.md', name: 'SOUL', text: `# Robin\n\nRobin is warm and quick.\n\n## Relationship\n${lines.join('\n')}\n` }] as never, base, { ownerName: 'Alex', adultOn: false, scrub: (s: string) => s });
  const note = String(d.sheet.relationshipNote ?? '');
  assert.ok(note.length > 0 && note.length <= RELATIONSHIP_NOTE_MAX, `${note.length} characters`);
  // The sheet passes the same check the import uses.
  assert.doesNotThrow(() => validatePersona(d.sheet));
  // Nothing is lost: the lines that did not fit are her notes.
  // (a file with no personality section gives its first notes to the personality list, as before)
  const everywhere = [note, ...d.notes.map((n) => n.text), ...d.sheet.personality].join('\n');
  for (let i = 1; i <= 12; i++) assert.match(everywhere, new RegExp(`thing number ${i}:`), `line ${i} is kept`);
  assert.ok(d.notes.some((n) => /thing number 12/.test(n.text)), 'the last line is a note');
  // A long summary handed in from elsewhere is cut to what the sheet takes.
  const long = draftPersona('SOUL.md', [{ path: 'files/home/SOUL.md', name: 'SOUL', text: '# Robin\n\nRobin is warm.\n' }] as never, base, { ownerName: 'Alex', adultOn: false, scrub: (s: string) => s, summaryOverride: 'x'.repeat(2000) });
  assert.doesNotThrow(() => validatePersona(long.sheet));
});

test('3.49.2: the review says when the last Import stopped (it no longer just shows the review again)', () => {
  const page = readFileSync(join(ROOT, 'web', 'movein.js'), 'utf8');
  assert.match(page, /if \(pv\.error\) root\.append\(errorCard\(t\('The move-in stopped and nothing was saved: \{why\}'/);
  const server = readFileSync(join(ROOT, 'src', 'movein', 'index.ts'), 'utf8');
  assert.match(server, /error: s\.error \?\? null,\n {6}notes:/);
  assert.match(server, /s\.state = 'importing';\n {4}s\.line = 'Moving in';\n {4}delete s\.error;/);
});
