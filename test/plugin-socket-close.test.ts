// 2.55.2 fix: a plugin's socket that closes after the plugin stopped (or while Sara shuts down,
// after the store closed) logged into a closed database from a socket event: an uncaught exception
// that could take Sara down. Found by test/phase122b under load.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

test('plugin sockets: the closing log line can never throw out of a socket event', () => {
  const manager = readFileSync(join(ROOT, 'src', 'plugins', 'manager.ts'), 'utf8');
  const net = readFileSync(join(ROOT, 'src', 'plugins', 'net.ts'), 'utf8');
  assert.match(manager, /log: \(kind, text\) => \{\s*try \{\s*this\.store\.log\(/, 'the broker log callback is guarded');
  const gone = net.slice(net.indexOf('#gone(h: Held'), net.indexOf('#gone(h: Held') + 600);
  assert.match(gone, /try \{\s*this\.#d\.log\(/, '#gone guards its log and send');
});
