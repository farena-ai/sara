import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createBackupAsync, asyncAutoBackupTick } from '../src/backup-async.ts';
import { restoreBackup, listBackups } from '../src/backup.ts';
import { Vault } from '../src/vault.ts';
import { tempDir, makeApp, ROOT } from './helpers.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';

test('worker backup restores four spaces and keys while HTTP and timers stay responsive', async () => {
    const { dir, cleanup } = tempDir();
    const source = join(dir, 'source');
    const spaces = ['', 'companions/fixture', 'members/member', 'members/member/companions/fixture'];
    const server = createServer((_req, res) => res.end('ok'));
    try {
        for (const [i, rel] of spaces.entries()) {
            const home = join(source, rel);
            mkdirSync(home, { recursive: true });
            const db = new DatabaseSync(join(home, 'sara.db'));
            db.exec('CREATE TABLE marker(value TEXT)');
            db.prepare('INSERT INTO marker VALUES (?)').run(`space-${i}`);
            db.close();
            new Vault(home).set('fixture', `synthetic-secret-${i}`);
        }
        writeFileSync(join(source, 'large.bin'), randomBytes(16 * 1024 ** 2));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        let ticks = 0;
        const timer = setInterval(() => ticks++, 2);
        let done = false;
        const file = join(dir, 'backup.tar.gz');
        const job = createBackupAsync(source, file, { saraVersion: 'fixture' }).then(m => { done = true; return m; });
        try {
            assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'ok');
            assert.equal(done, false, 'HTTP completes while real compression is still running');
            assert.equal((await job).saraVersion, 'fixture');
            assert.ok(ticks > 2);
        } finally { clearInterval(timer); await job; }
        const restored = join(dir, 'restored');
        restoreBackup(file, restored);
        for (const [i, rel] of spaces.entries()) {
            const home = join(restored, rel);
            const db = new DatabaseSync(join(home, 'sara.db'));
            try { assert.equal(db.prepare('SELECT value FROM marker').get()?.value, `space-${i}`); }
            finally { db.close(); }
            assert.equal(readFileSync(join(home, 'master.key'), 'utf8'), readFileSync(join(source, rel, 'master.key'), 'utf8'));
            assert.equal(new Vault(home).get('fixture'), `synthetic-secret-${i}`);
        }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});

test('same-root manual and automatic work serializes; failure cannot poison the queue', async () => {
    const { dir, cleanup } = tempDir();
    try {
        const source = join(dir, 'source');
        mkdirSync(source);
        const db = new DatabaseSync(join(source, 'sara.db'));
        db.exec('CREATE TABLE marker(value TEXT)');
        db.close();
        const now = new Date();
        const failed = createBackupAsync(source, source);
        const manual = createBackupAsync(join(source, '.'), join(dir, 'manual.tar.gz'));
        const autos = [1, 2, 3].map(() => asyncAutoBackupTick(source, { auto: true, keep: 1 }, now, 'fixture'));
        await assert.rejects(failed, /BACKUP_FAILED/);
        await manual;
        const names = await Promise.all(autos);
        assert.equal(names.filter(Boolean).length, 1);
        assert.equal(listBackups(source).length, 1);
        assert.equal(await asyncAutoBackupTick(source, { auto: false, keep: 1 }, now, 'fixture'), undefined);
        assert.ok(await asyncAutoBackupTick(source, { auto: true, keep: 1 }, new Date(now.getTime() + 25 * 3600_000), 'fixture'));
        assert.equal(listBackups(source).length, 1);
    } finally { cleanup(); }
});

test('parallel same-second manual API backups keep compatible names and distinct complete archives', async () => {
    const { dir, cleanup } = tempDir();
    const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
    const auth = new OwnerAuth(dir);
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/api/backups`;
        const responses = await Promise.all([1, 2, 3].map(() => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken}` } })));
        assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
        const made = await Promise.all(responses.map(r => r.json()));
        assert.equal(new Set(made.map(m => m.name)).size, 3);
        assert.ok(made.some(m => m.name === 'sara-2026-11-04-12-00-00.tar.gz'));
        for (const m of made) {
            const restored = join(dir, `restored-${m.name}`);
            restoreBackup(join(dir, 'backups', m.name), restored);
            assert.equal(new Vault(restored).get('fixture'), undefined);
            assert.equal(readFileSync(join(restored, 'master.key'), 'utf8'), readFileSync(join(dir, 'master.key'), 'utf8'));
        }
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        app.store.close();
        cleanup();
    }
});

test('shutdown closes admission while an actual child worker finishes a restorable archive', async () => {
    const { dir, cleanup } = tempDir();
    const moduleUrl = new URL('../src/backup-async.ts', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { randomBytes } from 'node:crypto';
        const { createBackupAsync, asyncAutoBackupTick, awaitBackupJobs, beginBackupShutdown } = await import(${JSON.stringify(moduleUrl)});
        const dir = process.argv[1];
        const source = join(dir, 'source');
        mkdirSync(source);
        writeFileSync(join(source, 'marker.txt'), 'shutdown-fixture');
        writeFileSync(join(source, 'payload.bin'), randomBytes(16 * 1024 ** 2));
        await awaitBackupJobs();
        let finished = false;
        const first = createBackupAsync(source, join(dir, 'complete.tar.gz')).then(() => { finished = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(finished, false);
        const closing = beginBackupShutdown();
        await assert.rejects(createBackupAsync(source, join(dir, 'late.tar.gz')), /BACKUP_SHUTTING_DOWN/);
        await assert.rejects(asyncAutoBackupTick(source, { auto: true, keep: 1 }, new Date(), 'fixture'), /BACKUP_SHUTTING_DOWN/);
        await closing;
        assert.equal(finished, true);
        await first;
        assert.equal(existsSync(join(dir, 'late.tar.gz')), false);
        process.exit(0);
    `;
    try {
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir], { timeout: 15000 });
        const restored = join(dir, 'restored');
        restoreBackup(join(dir, 'complete.tar.gz'), restored);
        assert.equal(readFileSync(join(restored, 'marker.txt'), 'utf8'), 'shutdown-fixture');
        assert.equal(readFileSync(join(restored, 'payload.bin')).length, 16 * 1024 ** 2);
    } finally { cleanup(); }
});

test('automatic worker pruning tolerates concurrent listings without hiding real filesystem errors', async () => {
    const { dir, cleanup } = tempDir();
    try {
        const source = join(dir, 'source');
        const backups = join(source, 'backups');
        mkdirSync(backups, { recursive: true });
        for (let i = 0; i < 1500; i++) {
            const file = join(backups, `sara-fixture-${String(i).padStart(4, '0')}-auto.tar.gz`);
            writeFileSync(file, 'synthetic-old-archive');
            utimesSync(file, 0, 0);
        }
        let finished = false;
        const job = asyncAutoBackupTick(source, { auto: true, keep: 1 }, new Date(), 'fixture').finally(() => { finished = true; });
        const failures: string[] = [];
        try {
            while (!finished) {
                try { listBackups(source); }
                catch (err) { failures.push((err as NodeJS.ErrnoException).code ?? 'unknown'); }
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        } finally { await job; }
        assert.deepEqual(failures, [], 'normal worker retention must not make readers fail');
        assert.equal(listBackups(source).length, 1);
        const invalidRoot = join(dir, 'invalid');
        mkdirSync(invalidRoot);
        writeFileSync(join(invalidRoot, 'backups'), 'not-a-directory');
        assert.throws(() => listBackups(invalidRoot), (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOTDIR');
    } finally { cleanup(); }
});
