// 2.55.2 fix (found while measuring Phase 123): on Windows every MCP server started with `npx` (the
// built-in presets) failed with "spawn npx ENOENT": spawn() without a shell can't run npm's .cmd shims.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { windowsCommand } from '../src/tools/mcp.ts';

test('windowsCommand: npx runs as node + npx-cli.js on Windows; other platforms and .exe are unchanged', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-wincmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nodeDir = join(dir, 'nodejs');
  mkdirSync(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(nodeDir, 'node.exe'), '');
  writeFileSync(join(nodeDir, 'npx.cmd'), '@echo off');
  writeFileSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
  const node = join(nodeDir, 'node.exe');
  assert.deepEqual(windowsCommand('npx', ['-y', 'pkg'], nodeDir, 'win32', node), [node, [join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '-y', 'pkg']]);
  // Found next to node.exe even when that folder isn't on PATH.
  assert.deepEqual(windowsCommand('npx', ['pkg'], '', 'win32', node)[0], node);
  assert.deepEqual(windowsCommand('npx', ['pkg'], nodeDir, 'linux', node), ['npx', ['pkg']]);
  assert.deepEqual(windowsCommand('C:/tools/server.exe', ['a'], nodeDir, 'win32', node), ['C:/tools/server.exe', ['a']]);
  // An .exe on PATH is used as is.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'uvx.exe'), '');
  assert.deepEqual(windowsCommand('uvx', ['x'], bin, 'win32', node), [join(bin, 'uvx.exe'), ['x']]);
  // Another .cmd script gets a plain error with what to do.
  writeFileSync(join(bin, 'my-server.cmd'), '@echo off');
  assert.throws(() => windowsCommand('my-server', [], bin, 'win32', node), /\.cmd script.*node/);
  // Unknown names pass through (spawn reports them as before).
  assert.deepEqual(windowsCommand('python', ['-m', 'x'], bin, 'win32', node), ['python', ['-m', 'x']]);
});
