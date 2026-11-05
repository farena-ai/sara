// Manual, offline qualification against a selected source/package payload. All writes are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppContext } from '../src/chat.ts';
import type { CheckpointView, ProjectCheckpoint } from '../src/project-checkpoints.ts';

if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
  console.error('Usage: node qualify-project-checkpoints.ts <source-payload>');
  process.exit(2);
}

const payload = realpathSync(resolve(process.argv[2]));
assert.ok(existsSync(join(payload, 'src', 'project-checkpoints.ts')), 'source-payload must contain src/project-checkpoints.ts');
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'sara-checkpoint-probe-')));
function inside(...parts: string[]): string {
  const path = resolve(fixture, ...parts);
  const rel = relative(fixture, path);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'fixture path must remain contained');
  return path;
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const imports: { path: string; sha256: string }[] = [];
async function load<T>(name: string): Promise<T> {
  const path = realpathSync(join(payload, 'src', name));
  const rel = relative(payload, path);
  assert.ok(!rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'selected module must be inside payload');
  imports.push({ path: `src/${name}`, sha256: hash(readFileSync(path)) });
  return import(pathToFileURL(path).href) as Promise<T>;
}
const started = performance.now();
console.error(`Synthetic fixture retained: ${fixture}`);
try {
  const { Store } = await load<typeof import('../src/store.ts')>('store.ts');
  const { ProjectKnowledgeStore } = await load<typeof import('../src/projectknow.ts')>('projectknow.ts');
  const { checkpointSection } = await load<typeof import('../src/project-checkpoints.ts')>('project-checkpoints.ts');
  const { Vault } = await load<typeof import('../src/vault.ts')>('vault.ts');
  const { createBackupAsync } = await load<typeof import('../src/backup-async.ts')>('backup-async.ts');
  const { restoreBackup } = await load<typeof import('../src/backup.ts')>('backup.ts');
  const { uploadOffsite, downloadNewestOffsite, decryptBackup, isEncrypted } = await load<typeof import('../src/offsite.ts')>('offsite.ts');
  const worker = join(payload, 'src', 'backup-worker.ts');
  imports.push({ path: 'src/backup-worker.ts', sha256: hash(readFileSync(worker)) });
  const now = new Date('2026-11-05T12:00:00Z');
  let providerCalls = 0;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  const noNetwork: typeof fetch = async () => { networkCalls++; throw new Error('Qualification must not call the network'); };
  globalThis.fetch = noNetwork;
  const source = inside('source');
  const restored = inside('restored');
  const layouts = ['', 'companions/synthetic', 'members/synthetic', 'members/synthetic/companions/synthetic'];
  const input = (logic: string) => ({ logic, blockers: ['Synthetic blocker.'], nextSteps: ['Review the synthetic parser.'] });
  function open(home: string, member: boolean) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const store = new Store(join(home, 'sara.db'), () => now);
    // A minimal fresh application context: no provider registry, server, scheduler or installed data.
    const app = {
      store, dataDir: home, now: () => now,
      ...(member ? { member: true } : {}),
      providerFactory: () => { providerCalls++; throw new Error('Qualification must not call a provider'); },
    } as unknown as AppContext;
    app.projects = new ProjectKnowledgeStore(app, store.db);
    return { app, store, projects: app.projects, vault: new Vault(home) };
  }
  type Opened = ReturnType<typeof open>;
  type Scope = { workspace: string; view: CheckpointView; sources: { kind: string; conversation: string; message: number; checkpoint: number }[] };
  const expected: { member: boolean; conversation: string; message: number; key: Buffer; scopes: Scope[] }[] = [];
  const sourceCheckpointRows: number[] = [];
  const restoredCheckpointRows: number[] = [];
  function physicalRows(context: Opened, member: boolean): number {
    const db = context.store.db;
    if (!member) for (const workspace of ['alpha', 'beta']) {
      const count = Number(db.prepare('SELECT count(*) AS n FROM project_checkpoints WHERE workspace=? AND path=?').get(workspace, '.')!.n);
      assert.equal(count, 5, 'physical checkpoint row count must match five-record history');
    }
    const total = Number(db.prepare('SELECT count(*) AS n FROM project_checkpoints').get()!.n);
    assert.equal(total, member ? 0 : 10, 'physical checkpoint total must match the exact eligible scopes');
    return total;
  }
  function denied(context: Opened): void {
    const cp = context.projects.checkpoints;
    assert.throws(() => cp.view('alpha', '.'), /own coding space/);
    assert.throws(() => cp.save('alpha', '.', input('Forbidden member save.'), 0, null), /own coding space/);
    assert.throws(() => cp.clear('alpha', '.', 0), /own coding space/);
    assert.equal(context.store.db.prepare('SELECT count(*) AS n FROM project_checkpoints').get()!.n, 0);
  }
  try {
    for (const [i, layout] of layouts.entries()) {
      const home = join(source, layout);
      const member = i >= 2;
      const context = open(home, member);
      try {
        const conv = context.store.createConversation({ mode: 'chat' });
        const message = context.store.addMessage(conv.id, 'user', `SYNTHETIC_SPACE_${i}`);
        context.vault.set('synthetic-checkpoint-proof', `SYNTHETIC_VAULT_${i}`);
        const scopes: Scope[] = [];
        if (member) denied(context);
        else for (const workspace of ['alpha', 'beta']) {
          const dir = join(home, 'workspaces', workspace);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'package.json'), '{"name":"synthetic-checkpoint-project"}');
          writeFileSync(join(dir, 'proof.txt'), `SYNTHETIC_WORKSPACE_${i}_${workspace}`);
          context.projects.get(workspace);
          const cp = context.projects.checkpoints;
          let current: ProjectCheckpoint | null = null;
          for (let revision = 0; revision < 8; revision++) current = cp.save(workspace, '.', input(`SYNTHETIC_${i}_${workspace}_EDITOR_${revision}`), current?.id ?? 0, null);
          const sources: Scope['sources'] = [];
          if (workspace === 'alpha') for (const kind of ['edit', 'forget', 'delete', 'conversation']) {
            const sourceConv = context.store.createConversation({ mode: 'coding', workspace });
            const sourceMessage = context.store.addMessage(sourceConv.id, 'user', `Synthetic source for ${kind}.`);
            current = cp.save(workspace, '.', input(`SYNTHETIC_${i}_${workspace}_${kind}`), current!.id, sourceConv.id);
            assert.equal(current.sourceThroughMessageId, sourceMessage.id);
            sources.push({ kind, conversation: sourceConv.id, message: sourceMessage.id, checkpoint: current.id });
          }
          const view = cp.view(workspace, '.');
          assert.equal(view.history.length, 5, 'checkpoint history must retain five records');
          assert.ok(view.history.some(record => record.sourceConversationId === null));
          scopes.push({ workspace, view, sources });
        }
        sourceCheckpointRows.push(physicalRows(context, member));
        expected.push({ member, conversation: conv.id, message: message.id, key: readFileSync(join(home, 'master.key')), scopes });
      } finally { context.store.close(); }
    }
    const archive = inside('sara-2026-11-05-checkpoint-manual.tar.gz');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let manifest;
    try { manifest = await createBackupAsync(source, archive, { saraVersion: 'synthetic-E1-qualification', includeWorkspaces: true, now }); }
    finally { clearInterval(timer); }
    assert.ok(ticks > 0, 'actual snapshot worker must permit main-loop progress');
    assert.equal(manifest.includesWorkspaces, true);
    const folder = inside('separate-folder');
    mkdirSync(folder);
    const cfg = { kind: 'folder' as const, path: folder, keep: 2 };
    const passphrase = 'SYNTHETIC-E1-QUALIFICATION-PASSPHRASE';
    const storedName = await uploadOffsite(archive, cfg, { passphrase }, noNetwork);
    const downloaded = await downloadNewestOffsite(cfg, {}, noNetwork);
    assert.equal(downloaded.name, storedName);
    assert.ok(isEncrypted(downloaded.data));
    assert.throws(() => decryptBackup(downloaded.data, 'SYNTHETIC-INCORRECT-PASSPHRASE'));
    const tampered = Buffer.from(downloaded.data);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBackup(tampered, passphrase));
    const plain = decryptBackup(downloaded.data, passphrase);
    assert.deepEqual(plain, readFileSync(archive));
    const downloadedArchive = inside('downloaded.tar.gz');
    writeFileSync(downloadedArchive, plain, { mode: 0o600 });
    assert.equal(existsSync(restored), false);
    const recovery = restoreBackup(downloadedArchive, restored, now);
    assert.deepEqual(recovery.manifest, manifest);
    for (const [i, layout] of layouts.entries()) {
      const home = join(restored, layout);
      const context = open(home, expected[i].member);
      try {
        restoredCheckpointRows.push(physicalRows(context, expected[i].member));
        assert.equal(Object.values(context.store.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
        assert.deepEqual(readFileSync(join(home, 'master.key')), expected[i].key);
        assert.equal(context.vault.get('synthetic-checkpoint-proof'), `SYNTHETIC_VAULT_${i}`);
        assert.equal(context.store.getConversation(expected[i].conversation)!.mode, 'chat');
        assert.equal(context.store.db.prepare('SELECT content FROM messages WHERE id=?').get(expected[i].message)!.content, `SYNTHETIC_SPACE_${i}`);
        if (expected[i].member) {
          denied(context);
          const conv = context.store.getConversation(expected[i].conversation)!;
          assert.equal(checkpointSection(context.app, conv, {}), undefined);
          continue;
        }
        const cp = context.projects.checkpoints;
        for (const scope of expected[i].scopes) {
          assert.deepEqual(cp.view(scope.workspace, '.'), scope.view);
          assert.equal(readFileSync(join(home, 'workspaces', scope.workspace, 'proof.txt'), 'utf8'), `SYNTHETIC_WORKSPACE_${i}_${scope.workspace}`);
        }
        const alpha = expected[i].scopes[0];
        const beta = expected[i].scopes[1];
        const currentSource = alpha.sources.at(-1)!;
        const conv = context.store.getConversation(currentSource.conversation)!;
        const section = checkpointSection(context.app, conv, {})!;
        assert.ok(section.includes(alpha.view.current!.logic));
        assert.match(section, /Historical, unverified/);
        assert.doesNotMatch(section, /SYNTHETIC_\d_beta/);
        assert.ok(section.length <= 3000);
        assert.equal(checkpointSection(context.app, conv, { external: true }), undefined);
        assert.throws(() => cp.save('beta', '.', input('Foreign source.'), beta.view.current!.id, conv.id), /own non-private coding conversation/);
        assert.throws(() => cp.view('alpha', 'unknown'), /not found/);
        assert.throws(() => cp.clear('alpha', '.', alpha.view.current!.id - 1), /changed/);
        for (const sourceRecord of alpha.sources) {
          if (sourceRecord.kind === 'edit') context.store.updateMessageContent(sourceRecord.message, 'Corrected synthetic source.');
          if (sourceRecord.kind === 'forget') context.store.updateMessageMeta(sourceRecord.message, { forgotten: true });
          if (sourceRecord.kind === 'delete') context.store.deleteMessagesFrom(sourceRecord.conversation, sourceRecord.message);
          if (sourceRecord.kind === 'conversation') context.store.deleteConversation(sourceRecord.conversation);
          assert.equal(context.store.db.prepare('SELECT id FROM project_checkpoints WHERE id=?').get(sourceRecord.checkpoint), undefined);
        }
        const editor = cp.view('alpha', '.');
        assert.equal(editor.history.length, 1);
        assert.equal(editor.current!.sourceConversationId, null);
        const forgotten = alpha.sources.find(record => record.kind === 'forget')!;
        assert.throws(() => cp.save('alpha', '.', input('Forgotten source.'), editor.current!.id, forgotten.conversation), /forgotten content/);
        cp.clear('alpha', '.', editor.current!.id);
        assert.deepEqual(cp.view('alpha', '.'), { current: null, history: [] });
        assert.deepEqual(cp.view('beta', '.'), beta.view);
      } finally { context.store.close(); }
    }
    for (const [i, layout] of layouts.entries()) {
      const context = open(join(restored, layout), expected[i].member);
      try {
        if (expected[i].member) denied(context);
        else {
          assert.deepEqual(context.projects.checkpoints.view('alpha', '.'), { current: null, history: [] });
          assert.deepEqual(context.projects.checkpoints.view('beta', '.'), expected[i].scopes[1].view);
        }
      } finally { context.store.close(); }
    }
    assert.deepEqual(restoredCheckpointRows, sourceCheckpointRows);
    assert.equal(providerCalls, 0);
    assert.equal(networkCalls, 0);
    const report = {
      passed: true, node: process.version, platform: process.platform, arch: process.arch,
      payload, fixture, imports, appClock: now.toISOString(), appScopeBinding: 'dataDir is each separate restored database home; member=true for both member layouts; rootDir unset',
      spaces: 4, eligibleCheckpointSpaces: 2, memberSpacesDenied: 2, workspaceScopes: 4,
      historyRecordsPerScope: 5, checkpointRecordsRestored: restoredCheckpointRows.reduce((total, count) => total + count, 0),
      physicalCheckpointRows: { layoutOrder: layouts, beforeBackup: sourceCheckpointRows, afterRestore: restoredCheckpointRows }, encryptedFolderCopy: true,
      snapshotWorker: true, snapshotWorkerTicks: ticks, archiveSha256: hash(plain), encryptedSha256: hash(downloaded.data),
      wrongPassphraseRejected: true, tamperRejected: true, vaultsAndMasterKeysRestored: 4,
      sourceCascades: ['edit', 'forget', 'delete messages', 'delete conversation'], foreignScopeDenied: true, scopedClear: true, mutationPersistenceAfterSecondReopen: true,
      providerCalls, networkCalls, durationMs: Math.round(performance.now() - started),
      limits: 'Synthetic offline module-level application contexts and real worker snapshot/encrypted local-folder transfer only. Local tar.gz is plaintext; confidentiality is supplied by existing offsite scrypt/AES-256-GCM. No real off-host destination, provider, server, GUI, owner data or production recovery proof. All synthetic fixtures retained.',
    };
    writeFileSync(inside('report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally { globalThis.fetch = originalFetch; }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(inside('failure.json'), JSON.stringify({ passed: false, payload, fixture, imports, message }, null, 2) + '\n');
  console.error(message);
  process.exitCode = 1;
}
