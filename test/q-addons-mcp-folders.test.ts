// Q-ADDONS: a folder the owner picks for a Store tool server (the Files recipe's FOLDER) must be
// reachable inside the tool sandbox. Under bubblewrap the server saw only its own folder, so the
// Files server refused to start on Linux ("None of the specified directories are accessible").
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { recipeConfig } from '../src/store/install.ts';
import { parseRecipe } from '../src/store/format.ts';
import { mcpBinds, validateMcpConfig } from '../src/tools/mcp.ts';
import { ROOT, tempDir } from './helpers.ts';

const files = parseRecipe(JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'filesystem.json'), 'utf8')).mcp);

const scratch = (t: TestContext) => { const d = tempDir(); t.after(d.cleanup); return d.dir; };

test('Q-ADDONS: a recipe folder field becomes a folder grant of the server config, kept through validation', (t) => {
  const dir = scratch(t);
  const pick = join(dir, 'notes');
  const cfg = recipeConfig(join(dir, 'data'), files, 'files', { FOLDER: pick });
  assert.deepEqual(cfg.folders, [pick]);
  assert.deepEqual(validateMcpConfig({ ...cfg }, 'files').folders, [pick], 'saved settings keep it');
  assert.equal(validateMcpConfig({ transport: 'stdio', command: 'npx', folders: ['relative/path', '/'] }, 'x').folders, undefined, 'only real absolute folders, never the whole disk');
});

test('Q-ADDONS: the sandbox binds an existing granted folder at its own path, never Sara’s data or a missing folder', (t) => {
  const dir = scratch(t);
  const data = join(dir, 'data');
  const pick = join(dir, 'notes');
  mkdirSync(pick, { recursive: true });
  mkdirSync(join(data, 'vaultish'), { recursive: true });
  const cfg = { name: 'files', enabled: true, transport: 'stdio' as const, command: 'npx', args: [], folders: [pick, join(data, 'vaultish'), join(dir, 'gone')] };
  assert.deepEqual(mcpBinds(cfg, data), [{ src: pick, dest: pick, rw: true }]);
  assert.deepEqual(mcpBinds({ ...cfg, folders: undefined }, data), []);
});
