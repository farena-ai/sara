// 3.0.3 (owner): coding chats drop her mood line from the header; the AI notice stays as the short pill.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('coding chat: the header marks coding chats and chats in a coding project', () => {
  assert.match(read('web', 'app.js'), /\$\('#main'\)\.classList\.toggle\('coding-chat', c\.mode === 'coding' \|\| Boolean\(c\.projectId && \(state\.projects \?\? \[\]\)\.find\(\(p\) => p\.id === c\.projectId\)\?\.workspace\)\);/);
});

test('coding chat: no mood line; the AI badge is never removed, only shortened', () => {
  const css = read('web', 'style.css');
  assert.ok(css.includes('#main.coding-chat #sara-status { display: none; }'));
  assert.ok(css.includes('#main.coding-chat #chat-head .ai-badge:not(#_) { gap: 0; padding: 0 8px; font-size: 0; }'));
  assert.ok(css.includes('#main.coding-chat #chat-head .ai-badge::before { content: "AI";'));
  assert.ok(css.includes('#main.coding-chat:lang(de) #chat-head .ai-badge::before { content: "KI"; }'));
  for (const f of ['style.css', 'v4.css', 'v4-pages.css', 'look.css']) assert.doesNotMatch(read('web', f), /coding-chat[^{]*\.ai-badge[^{]*\{[^}]*display: none/, f);
  // The badge keeps its words for screen readers and its title.
  assert.match(read('web', 'index.html'), /<span class="ai-badge" title="Sara is an AI companion">AI companion<\/span>/);
  assert.match(read('docs', 'DISCLOSURES.md'), /a short "AI" pill on narrow phones and in coding\s+chats/);
});
