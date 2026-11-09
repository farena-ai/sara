// Q-ADDONS (2026-11-07): Playwright and Chrome DevTools tool servers look for an installed Chrome at
// its system path; in the Linux sandbox that folder must be visible, read-only, or they report
// "Chrome not found" although it is installed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpBrowserBinds } from '../src/tools/mcp.ts';

test('installed browser folders are mounted read-only into tool-server sandboxes; missing ones are not', () => {
  const present = new Set(['/opt/google/chrome']);
  const binds = mcpBrowserBinds((p) => present.has(p));
  assert.deepEqual(binds, [{ src: '/opt/google/chrome', dest: '/opt/google/chrome', rw: false }]);
  assert.deepEqual(mcpBrowserBinds(() => false), []);
  for (const b of mcpBrowserBinds(() => true)) assert.equal(b.rw, false, `${b.src} stays read-only`);
});
