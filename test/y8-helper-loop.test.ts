// Y8: team helpers get the protections of her own turns (src/team.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../src/providers/types.ts';
import { EMPTY_HELPER_NOTE, HELPER_HISTORY, trimHelperHistory } from '../src/team.ts';

test('Y8 helpers: old tool results are shortened, the newest stay whole, nothing else is touched', () => {
  const big = 'x'.repeat(12_000);
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'your part' }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: {} }] });
    messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: `${i}:${big}` });
  }
  const before = messages.reduce((n, m) => n + m.content.length, 0);
  assert.equal(trimHelperHistory(messages), 10 - HELPER_HISTORY.keepFull);
  const tools = messages.filter((m) => m.role === 'tool');
  for (const t of tools.slice(0, 4)) {
    assert.ok(t.content.length < HELPER_HISTORY.clipTo + 80);
    assert.match(t.content, /\[\.\.\. shortened: \d+ more characters were here\]$/);
    assert.match(t.content, /^\d:x/, 'its start is kept');
  }
  for (const t of tools.slice(4)) assert.equal(t.content.length, big.length + 2, 'the newest six are whole');
  assert.ok(messages.reduce((n, m) => n + m.content.length, 0) < before / 1.5);
  assert.equal(messages[0]!.content, 's');
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 10, 'the calls themselves stay, so every result still has its call');
  assert.equal(trimHelperHistory(messages), 0, 'a second pass changes nothing');
  assert.match(EMPTY_HELPER_NOTE, /your last reply was empty/);
});
