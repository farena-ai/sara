// Fixed manual lab: only fresh synthetic profiles, no provider or owner-data target.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentFixture } from '../helpers/business-content.ts';
import { restoreBusinessBackup } from '../../src/business/backup.ts';
import { openBusinessProfile } from '../../src/business/profile.ts';
import { createBusinessRuntime } from '../../src/business/runtime.ts';

if (!process.env.SARA_B4_OUTPUT) throw new Error('SARA_B4_OUTPUT must name a private synthetic evidence directory.');
const output = resolve(process.env.SARA_B4_OUTPUT); mkdirSync(output, { recursive: true });
const lab = mkdtempSync(join(realpathSync(output), 'lab-'));
const report: { version: number; pass: boolean; checks: Record<string, unknown>[]; limits: string[]; error?: string } = {
  version: 1, pass: false, checks: [], limits: [
    'Fresh synthetic profiles and loopback APIs only; no model inference, real accounts or owner data.',
    'Full byte/mode/mtime equality covers one quiescent supported writer, not atomic concurrent filesystem adversaries.',
    'Local encrypted archive and closed fresh-target restore; no physical passkeys, production custody, power-loss or RPO/RTO proof.',
  ],
};
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
save();
const f = await contentFixture('localhost');
let recovered: ReturnType<typeof createBusinessRuntime> | undefined;
function snapshot(root: string) {
  const entries: { path: string; mode: number; mtimeMs: number; size?: number; bytes?: Buffer }[] = [];
  function visit(path: string, relative: string) {
    const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
    entries.push({ path: relative, mode: stat.mode, mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { size: stat.size, bytes: readFileSync(path) } : {}) });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? relative + '/' + name : name);
    else assert.ok(stat.isFile());
  }
  visit(root, ''); return entries;
}
const manifest = (entries: ReturnType<typeof snapshot>) => entries.map(({ bytes, ...entry }) => ({ ...entry,
  ...(bytes ? { sha256: createHash('sha256').update(bytes).digest('hex') } : {}) }));

try {
  const workspace = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Synthetic integration workspace' });
  await f.seed(workspace.id, 'Synthetic integrated content');
  const manager = f.add('Synthetic manager'), contributor = f.add('Synthetic contributor'), viewer = f.add('Synthetic viewer'), outsider = f.add('Synthetic outsider'), orgAdmin = f.add('Synthetic ungranted administrator');
  f.grant(workspace.id, manager, 'manager'); f.grant(workspace.id, contributor, 'contributor'); f.grant(workspace.id, viewer);
  f.runtime.control.setOrganizationMember(f.admin.principal, orgAdmin.principal.identityId, { role: 'orgadmin' });
  const invitation = f.runtime.control.createInvite(manager.principal, { scope: 'workspace', workspaceId: workspace.id, role: 'viewer', subject: outsider.principal.identityId });
  f.runtime.configureModels({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 0, maxConcurrent: 1,
    models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Synthetic unused destination', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false },
      model: 'synthetic-unused-model', cloud: false, inputNanoUsdPerToken: 0, outputNanoUsdPerToken: 0, maxInputTokens: 1024, maxOutputTokens: 64, maxOutputBytes: 1024, deadlineMs: 1000, tone: 'professional' }],
    workspaces: { [workspace.id]: { modelId: 'local', allowanceNanoUsd: 0 } } });

  const before = snapshot(f.dir);
  const cli = spawnSync(process.execPath, ['src/main.ts', '--business-check'], { cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: f.dir, SARA_BUSINESS_ORIGIN: f.runtime.origin, SARA_PORT: new URL(f.runtime.origin).port },
    encoding: 'utf8', timeout: 20_000 });
  writeFileSync(join(output, 'business-check.stdout.json'), cli.stdout || ''); writeFileSync(join(output, 'business-check.stderr.log'), cli.stderr || '');
  const after = snapshot(f.dir);
  writeFileSync(join(output, 'before-tree.json'), JSON.stringify(manifest(before), null, 2));
  writeFileSync(join(output, 'after-tree.json'), JSON.stringify(manifest(after), null, 2));
  assert.equal(cli.error, undefined); assert.equal(cli.status, 0); assert.deepEqual(after, before, 'Configuration inspection must preserve every byte/mode/mtime and directory entry');
  const configuration = JSON.parse(cli.stdout);
  assert.equal(configuration.version, 1); assert.equal(configuration.status, 'configuration-only');
  for (const id of ['access', 'usage-recovery', 'credentials', 'inference', 'backup', 'availability']) assert.equal(configuration.checks.find((check: { id: string }) => check.id === id)?.status, 'unverified');
  report.checks.push({ id: 'readonly-cli', pass: true, unchanged: true, entries: before.length, status: configuration.status }); save(); console.log('PASS real read-only CLI leaves full tree unchanged');

  const path = `/api/business/workspaces/${workspace.id}/invites`;
  const allowed = await f.request(path, manager); assert.equal(allowed.status, 200);
  const rows = await allowed.json(); assert.equal(rows.length, 1); assert.equal(rows[0].id, invitation.id); assert.equal(rows[0].state, 'pending');
  assert.equal(JSON.stringify(rows).includes(invitation.code), false);
  const statuses: number[] = [];
  for (const session of [contributor, viewer, outsider, orgAdmin]) {
    const response = await f.request(path, session); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found.' }); statuses.push(response.status);
  }
  const anonymous = await fetch(f.runtime.origin + path, { headers: { origin: f.runtime.origin } }); assert.equal(anonymous.status, 401); statuses.push(anonymous.status);
  const wrongOrigin = await f.request(path, manager, undefined, { origin: 'https://wrong.invalid' }); assert.equal(wrongOrigin.status, 403); statuses.push(wrongOrigin.status);
  report.checks.push({ id: 'scoped-invites', pass: true, denied: statuses.length, statuses }); save(); console.log('PASS scoped inventory authorization and six forbidden requests');

  const archive = join(output, 'generation.enc');
  const generation = await f.runtime.backup(archive, 'synthetic B4 archive passphrase');
  assert.equal(readFileSync(archive).subarray(0, 8).toString(), 'SARABUS1');
  await f.runtime.close();
  const target = join(lab, 'fresh-restored');
  const restored = await restoreBusinessBackup(archive, target, 'synthetic B4 archive passphrase'); assert.equal(restored.generation, generation.generation);
  recovered = createBusinessRuntime({ profile: openBusinessProfile(target), origin: f.runtime.origin });
  await new Promise<void>(ready => recovered!.server.listen(Number(new URL(f.runtime.origin).port), '127.0.0.1', ready));
  for (const session of [f.admin, manager, contributor, viewer, outsider, orgAdmin]) assert.equal(recovered.auth.principal(session.value), undefined);
  assert.throws(() => recovered!.control.previewInvite(invitation.code));
  assert.equal(recovered.control.database.prepare("SELECT count(*) AS n FROM workspace_members WHERE status='active'").get()?.n, 0);
  assert.equal(recovered.control.database.prepare("SELECT count(*) AS n FROM organization_members WHERE status='active'").get()?.n, 0);
  assert.equal(recovered.control.database.prepare("SELECT value FROM business_meta WHERE key='recovery_mode'").get()?.value, 'reconcile');
  assert.throws(() => recovered!.models.plan(workspace.id), /recovery/);
  assert.equal((await f.request('/api/business/me')).status, 401);
  assert.equal((await f.request(path)).status, 503, 'Recovery guard closes scoped routes before authentication');
  report.checks.push({ id: 'encrypted-restore', pass: true, closed: true, workspaceCount: generation.workspaceIds.length, archivedFiles: generation.files.length });
  report.pass = true; save(); console.log('PASS encrypted fresh-target restore closes old cookies, invitations, grants and spending');
} catch (error) {
  // Preserve synthetic failure state before supported close changes WAL/fence metadata.
  cpSync(f.dir, join(lab, 'failed-source'), { recursive: true });
  report.error = error instanceof Error ? error.message : 'Synthetic integration failed'; save(); process.exitCode = 1;
  console.error(report.error);
} finally { await recovered?.close(); await f.close(); save(); }
