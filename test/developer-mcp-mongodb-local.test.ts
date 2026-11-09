import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const supervisor = new URL('../tools/developer-mcp-mongodb/qualify-owned.py', import.meta.url);
test('MDB-LOCAL: authenticated actual upstream/host row, plan, ACL and lifecycle acceptance', {skip: process.env.MONGODB_LOCAL_QUALIFY !== '1', timeout: 240000}, () => {
  assert.ok(existsSync(supervisor), 'missing actual owned local fixture qualification runner');
  const result = spawnSync('python3', [fileURLToPath(supervisor)], {env: process.env, encoding: 'utf8', timeout: 210000, windowsHide: true});
  assert.equal(result.status, 0, 'owned qualification failed; inspect private sanitized receipt');
  const receipt = JSON.parse(readFileSync(new URL('../outputs/developer-addons/mcp-mongodb/local-resume-result.json', import.meta.url), 'utf8'));
  assert.equal(receipt.status, 'pass');
  for (const id of ['MDB-ROWS','MDB-SCHEMA','MDB-INDEX-EXPLAIN','MDB-ACL-WRITE','MDB-ACL-OUT','MDB-ACL-MERGE','MDB-ACL-FOREIGN-COLLECTION','MDB-ACL-CROSSDB','MDB-JS','MDB-BOUNDS','MDB-SARA-LIFECYCLE','MDB-RECONNECT','MDB-STALE','MDB-DISABLE','MDB-CLEANUP']) assert.ok(receipt.passed.includes(id), `Missing actual acceptance ${id}`);
  assert.equal(receipt.cleanup.activeProcesses, 0);
  assert.equal(receipt.cleanup.fixtureRemoved, true);
  assert.equal(receipt.cleanup.listenerClosed, true);
});
