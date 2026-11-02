// 2.51.0 fix (found while designing Phase 119, docs/design/RECALL.md §2): his upcoming reminders were put
// in her instructions in any turn with the remind/todo tools, including his turns in a work room, where
// other people read her replies. The agenda now stays out of work rooms and partner turns.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const chat = readFileSync(join(import.meta.dirname, '..', 'src', 'chat.ts'), 'utf8');

test('agenda privacy: his reminders never reach her instructions in a work room or a partner turn', () => {
  const line = chat.split('\n').find((l) => /^\s*agenda: /.test(l));
  assert.ok(line, 'the agenda line exists');
  assert.match(line, /!isWorkChannel\(conv\.channel\)/, 'left out of work rooms');
  assert.match(line, /!conv\.partner/, 'left out of partner turns');
  assert.match(line, /!opts\.outside/, 'still left out of outside apps');
});
