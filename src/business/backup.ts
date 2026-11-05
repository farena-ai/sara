import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { BusinessProfile } from './profile.ts';
import type { BusinessControlStore } from './store.ts';
import { openWorkspaceDatabase } from './workspaces.ts';
import { appendAudit, initializeAudit } from './audit.ts';
import { validId } from './policy.ts';
import { validateBusinessOperatorSnapshot } from './model-config.ts';

export const BUSINESS_ARCHIVE_MAGIC = 'SARABUS1';
export const BUSINESS_BACKUP_MAX = 512 * 1024 * 1024;
export const BUSINESS_STAGE_MAX = 256 * 1024 * 1024;
export interface BusinessManifest { format: 'sara-business-backup'; version: 1; generation: string; createdAt: string; workspaceIds: string[]; files: { path: string; size: number; sha256: string }[] }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function checkedFiles(root: string): string[] {
  const files: string[] = []; let bytes = 0; let directories = 0;
  function walk(dir: string, prefix: string) {
    if (++directories > 10000 || prefix.length > 512 || prefix.split('/').length > 10) throw new Error('Generation exceeds directory bounds.');
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir) throw new Error('Unsafe generation directory.');
    for (const name of readdirSync(dir)) {
      const path = join(dir, name); const relative = prefix + name; const info = lstatSync(path);
      if (info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Unsafe generation file.');
      if (info.isDirectory()) walk(path, relative + '/');
      else {
        if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024 * 1024 || files.length >= 10000 || (bytes += info.size) > BUSINESS_STAGE_MAX) throw new Error('Generation exceeds file bounds.');
        files.push(relative);
      }
    }
  }
  walk(resolve(root), ''); return files.sort();
}
function stamp(path: string, generation: string) {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS business_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL)'); db.prepare('INSERT OR REPLACE INTO business_snapshot VALUES(1,?)').run(generation); }
  finally { db.close(); }
}
/** Closed admission plus the root writer fence supplies one logical generation across SQLite files. */
export async function stageBusinessGeneration(profile: BusinessProfile, control: BusinessControlStore): Promise<{ stage: string; manifest: BusinessManifest }> {
  return control.identities.lifecycle.snapshot(async () => {
    const stage = mkdtempSync(join(realpathSync(tmpdir()), 'sara-business-generation-'));
    try {
      const generation = randomUUID();
      const workspaceIds = control.database.prepare('SELECT id FROM workspaces ORDER BY id').all().map(row => String(row.id));
      if (workspaceIds.length > 1000) throw new Error('Too many workspaces for bounded generation.');
      workspaceIds.forEach(validId);
      // Use SQLite snapshots even after drain: never copy live SQL/WAL bytes.
      const business = join(stage, 'business'); mkdirSync(business, { mode: 0o700 });
      appendAudit(control.database, { action: 'backup.stage' });
      await backup(control.database, join(business, 'business.db'));
      stamp(join(business, 'business.db'), generation);
      for (const id of workspaceIds) {
        const dir = join(business, 'workspaces', id); mkdirSync(dir, { recursive: true, mode: 0o700 });
        const db = openWorkspaceDatabase(profile, id);
        try { await backup(db, join(dir, 'content.db')); } finally { db.close(); }
        stamp(join(dir, 'content.db'), generation);
      }
      copyFileSync(join(profile.root, 'profile.json'), join(stage, 'profile.json'));
      for (const name of ['auth', 'operator']) {
        const source = join(profile.businessDir, name); if (!existsSync(source)) continue;
        for (const path of checkedFiles(source)) {
          if (!/^[\w./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid generation path.');
          const target = join(business, name, ...path.split('/')); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(join(source, ...path.split('/')), target);
        }
      }
      if (existsSync(join(profile.businessDir, 'model-policy.json'))) copyFileSync(join(profile.businessDir, 'model-policy.json'), join(business, 'model-policy.json'));
      const manifest = await worker({ operation: 'seal', stage, manifest: { format: 'sara-business-backup', version: 1, generation, createdAt: new Date().toISOString(), workspaceIds } });
      return { stage, manifest };
    } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  });
}

export function validateBusinessGeneration(stage: string): BusinessManifest {
  const manifest = JSON.parse(readFileSync(join(stage, 'BUSINESS_BACKUP.json'), 'utf8')) as BusinessManifest;
  if (manifest.format !== 'sara-business-backup' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.workspaceIds)) throw new Error('Invalid business generation.');
  validId(manifest.generation); manifest.workspaceIds.forEach(validId);
  if (manifest.workspaceIds.length > 1000 || new Set(manifest.workspaceIds).size !== manifest.workspaceIds.length) throw new Error('Invalid workspace registry.');
  const actual = checkedFiles(stage).filter(path => path !== 'BUSINESS_BACKUP.json');
  if (actual.length !== manifest.files.length || new Set(manifest.files.map(file => file.path)).size !== actual.length) throw new Error('Generation file set mismatch.');
  for (const file of manifest.files) {
    if (!actual.includes(file.path) || /(?:-wal|-shm|-journal)$/.test(file.path) || !/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('Generation file set mismatch.');
    const data = readFileSync(join(stage, ...file.path.split('/')));
    if (file.size !== data.length || file.sha256 !== sha(data)) throw new Error('Generation hash mismatch.');
  }
  const marker = JSON.parse(readFileSync(join(stage, 'profile.json'), 'utf8'));
  if (marker.profile !== 'business' || marker.version !== 1) throw new Error('Invalid business profile.');
  function database(path: string, inspect: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length || db.prepare('SELECT generation FROM business_snapshot WHERE singleton=1').get()?.generation !== manifest.generation) throw new Error('Database generation mismatch.');
      inspect(db);
    } finally { db.close(); }
  }
  const identities = new Map<string, number>();
  const credentials: { identityId: string; epoch: number; id: string }[] = [];
  database(join(stage, 'business', 'business.db'), db => {
    const ids = db.prepare('SELECT id FROM workspaces ORDER BY id').all().map(row => String(row.id));
    if (JSON.stringify(ids) !== JSON.stringify(manifest.workspaceIds)) throw new Error('Workspace generation mismatch.');
    for (const row of db.prepare('SELECT id,auth_epoch FROM business_identities').all()) { validId(row.id); identities.set(String(row.id), Number(row.auth_epoch)); }
    for (const row of db.prepare('SELECT credential_id,identity_id,auth_epoch FROM business_credential_refs').all()) credentials.push({ identityId: String(row.identity_id), epoch: Number(row.auth_epoch), id: String(row.credential_id) });
  });
  for (const id of manifest.workspaceIds) database(join(stage, 'business', 'workspaces', id, 'content.db'), db => {
    const rows = db.prepare('SELECT profile,workspace_id,schema_version FROM content_scope').all();
    if (rows.length !== 1 || rows[0].profile !== 'business' || rows[0].workspace_id !== id || rows[0].schema_version !== 1) throw new Error('Workspace scope mismatch.');
    for (const row of db.prepare('SELECT actor_id FROM messages UNION SELECT actor_id FROM content_authorship').all()) if (!identities.has(String(row.actor_id))) throw new Error('Unknown content actor.');
  });
  for (const path of actual) {
    if (path === 'profile.json' || path === 'business/business.db' || path === 'business/model-policy.json' || /^business\/operator\/(master.key|secrets.enc)$/.test(path)) continue;
    const content = /^business\/workspaces\/([^/]+)\/content.db$/.exec(path);
    if (content && manifest.workspaceIds.includes(content[1])) continue;
    const auth = /^business\/auth\/([^/]+)\/(\d+)\/([\w.-]+)$/.exec(path);
    if (!auth || !identities.has(auth[1]) || Number(auth[2]) > identities.get(auth[1])!) throw new Error('Unexpected generation file.');
    const scope = JSON.parse(readFileSync(join(stage, 'business', 'auth', auth[1], auth[2], 'scope.json'), 'utf8'));
    if (scope.profile !== 'business' || scope.identityId !== auth[1] || scope.authEpoch !== Number(auth[2])) throw new Error('Authentication scope mismatch.');
  }
  for (const credential of credentials) {
    if (!identities.has(credential.identityId) || credential.epoch > identities.get(credential.identityId)!) throw new Error('Stale authentication reference.');
    const auth = JSON.parse(readFileSync(join(stage, 'business', 'auth', credential.identityId, String(credential.epoch), 'owner.json'), 'utf8'));
    if (auth.legacy || !Array.isArray(auth.sessions) || !Array.isArray(auth.passkeys) || !auth.passkeys.some((key: { id?: unknown }) => key.id === credential.id)) throw new Error('Missing authentication reference.');
  }
  validateBusinessOperatorSnapshot(join(stage, 'business'));
  return manifest;
}

function worker(operation: object): Promise<BusinessManifest> {
  return new Promise((resolveResult, reject) => {
    const thread = new Worker(new URL('./backup-worker.ts', import.meta.url), { workerData: operation }); let result: BusinessManifest | undefined;
    thread.on('message', message => { if (message.ok) result = message.manifest; else reject(new Error('Business archive operation failed.')); });
    thread.on('error', () => reject(new Error('Business archive worker failed.')));
    thread.on('exit', code => { if (code === 0 && result) resolveResult(result); else reject(new Error('Business archive worker did not complete.')); });
  });
}
export async function createBusinessBackup(profile: BusinessProfile, control: BusinessControlStore, file: string, passphrase: string): Promise<BusinessManifest> {
  if (passphrase.length < 10 || passphrase.length > 1024 || existsSync(file)) throw new Error('Provide a fresh archive path and a valid passphrase.');
  const target = relative(profile.root, resolve(file));
  if (target !== '..' && !target.startsWith('..' + sep) && !isAbsolute(target)) throw new Error('Store archives outside the business data root.');
  const { stage } = await stageBusinessGeneration(profile, control);
  try { return await worker({ operation: 'pack', stage, file: resolve(file), passphrase }); }
  finally { rmSync(stage, { recursive: true, force: true }); }
}
/** Restore is worker-only and promotes a validated generation exclusively to a nonexistent target. */
export async function restoreBusinessBackup(file: string, target: string, passphrase: string): Promise<BusinessManifest> {
  if (existsSync(target) || passphrase.length < 10 || passphrase.length > 1024) throw new Error('Business restore requires a fresh nonexistent isolated target and valid passphrase.');
  for (let parent = dirname(resolve(target)); ; parent = dirname(parent)) {
    if (!existsSync(parent) || lstatSync(parent).isSymbolicLink()) throw new Error('Restore ancestors must be existing real directories.');
    if (['profile.json', 'owner.json', 'sara.db', 'household.json'].some(name => existsSync(join(parent, name)))) throw new Error('Restore cannot be nested in an existing profile.');
    if (parent === dirname(parent)) break;
  }
  return worker({ operation: 'restore', file: resolve(file), target: resolve(target), passphrase });
}

export function closeRestoredAccess(stage: string): void {
  const db = new DatabaseSync(join(stage, 'business', 'business.db'));
  try {
    initializeAudit(db); db.exec('BEGIN IMMEDIATE');
    db.exec(`DROP TABLE IF EXISTS recovery_prior_organization; DROP TABLE IF EXISTS recovery_prior_workspace;
      CREATE TABLE recovery_prior_organization AS SELECT * FROM organization_members;
      CREATE TABLE recovery_prior_workspace AS SELECT * FROM workspace_members;
      UPDATE business_identities SET auth_epoch=auth_epoch+1;
      UPDATE organization_members SET status='disabled',revision=revision+1;
      UPDATE workspace_members SET status='removed',revision=revision+1;
      UPDATE workspaces SET status='held',policy_revision=policy_revision+1;
      UPDATE workspace_invites SET revoked_at=COALESCE(revoked_at,unixepoch()*1000);
      DELETE FROM business_credential_refs;
      DELETE FROM business_disclosures;
      UPDATE business_model_requests SET state='held' WHERE state='pending';
      INSERT OR REPLACE INTO business_model_state(key,value) VALUES ('paused','recovery');
      INSERT OR REPLACE INTO business_meta(key,value) VALUES ('recovery_mode','reconcile');`);
    db.exec("INSERT OR REPLACE INTO business_meta(key,value) SELECT 'recovery_generation',generation FROM business_snapshot WHERE singleton=1;");
    const policy = join(stage, 'business', 'model-policy.json');
    db.prepare("INSERT OR REPLACE INTO business_meta(key,value) VALUES ('recovery_policy_hash',?)").run(existsSync(policy) ? sha(readFileSync(policy)) : 'unconfigured');
    db.exec("INSERT OR REPLACE INTO business_meta(key,value) SELECT 'recovery_policy_generation',generation FROM business_snapshot WHERE singleton=1;");
    appendAudit(db, { action: 'recovery.restore' }); db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
