import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SettingsStore} from '../src/settings.ts';
import {McpManager, mcpToolName} from '../src/tools/mcp.ts';
import {ToolRegistry} from '../src/tools/registry.ts';
import type {Permission} from '../src/tools/types.ts';
const admissionPath = new URL('./fixtures/developer/mcp-mongodb/admission.json', import.meta.url);
test('MDB-ADMISSION-01: oversized vendor archive leaves MongoDB noninstallable and unqualified', () => {
  assert.ok(existsSync(admissionPath), 'missing explicit MongoDB blocked admission record');
  const record = JSON.parse(readFileSync(admissionPath, 'utf8'));
  assert.equal(record.target, 'MongoDB');
  assert.equal(record.status, 'blocked-engine-download-budget');
  assert.equal(record.installable, false);
  assert.equal(record.productionQualified, false);
  assert.equal(record.engine.version, '8.0.34');
  assert.ok(record.engine.contentLength > record.downloadBudgetBytes);
  assert.equal(record.engine.downloaded, false);
  assert.deepEqual(record.executedAcceptanceIds, []);
});
test('MDB-POLICY-01: real Sara saves Ask/Off and disabled configuration never starts a command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-mongodb-policy-'));
  const registry = new ToolRegistry([]);
  const sandbox = {mode: 'none' as const, network: false, detail: 'No subprocess; disabled configuration test only'};
  const manager = new McpManager(registry, {dataDir: home, sandbox, secrets: () => ({})});
  try {
    const permissions: Record<string, Permission> = {};
    for (const name of ['find', 'collection-schema', 'explain']) permissions[mcpToolName('mongodb-fixture', name)] = 'ask';
    for (const name of ['connect', 'disconnect', 'aggregate', 'aggregate-db', 'insert-many', 'drop-database', 'atlas-create-cluster', 'unreviewed-new-tool']) permissions[mcpToolName('mongodb-fixture', name)] = 'never';
    const config = {name: 'mongodb-fixture', enabled: false, transport: 'stdio' as const, command: 'mongodb-qualification-must-not-execute', args: []};
    new SettingsStore(home).update({mcpServers: [config], toolPermissions: permissions});
    const saved = new SettingsStore(home).get();
    assert.deepEqual(saved.toolPermissions, permissions);
    assert.equal(saved.mcpServers![0].enabled, false);
    for (const [name, permission] of Object.entries(permissions)) assert.equal(registry.permission(name, saved.toolPermissions), permission);
    const state = await manager.start(saved.mcpServers![0]);
    assert.notEqual(state.status, 'ready');
    assert.equal(state.error, '');
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(new SettingsStore(home).get().toolPermissions, permissions);
  } finally {
    manager.stopAll();
    rmSync(home, {recursive: true, force: true});
    assert.equal(existsSync(home), false);
  }
});
