// X0: every SQLite file in the data folder is snapshotted for a backup, not only sara.db. Before, the
// side databases (messages.db, health.db, journal.db, photos.db ...) were copied as raw bytes while
// open, with their -wal/-shm beside them: rows still in the write-ahead log could be lost or torn.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBackup, inspectBackup, restoreBackup } from '../src/backup.ts';
import { tempDir } from './helpers.ts';

function openWal(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  return db;
}

test('X0 backup: side databases are snapshotted whole while they are open and being written', () => {
  const src = tempDir();
  const dst = tempDir();
  const open: DatabaseSync[] = [];
  try {
    mkdirSync(join(src.dir, 'people', 'deep'), { recursive: true });
    mkdirSync(join(src.dir, 'workspaces', 'proj'), { recursive: true });
    const main = openWal(join(src.dir, 'sara.db'));
    main.exec('CREATE TABLE conversations (id INTEGER); CREATE TABLE messages (id INTEGER); CREATE TABLE memories (id INTEGER)');
    open.push(main);
    for (const rel of ['messages.db', 'health.db', 'people/deep/journal.db']) {
      const db = openWal(join(src.dir, ...rel.split('/')));
      // Rows that live only in the write-ahead log (never checkpointed), and the file stays open.
      const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
      for (let i = 0; i < 500; i++) ins.run(`row ${i} of ${rel}`);
      open.push(db);
    }
    writeFileSync(join(src.dir, 'notes.db'), 'not a database, just a file with that ending');
    const proj = openWal(join(src.dir, 'workspaces', 'proj', 'app.db'));
    proj.prepare('INSERT INTO t (v) VALUES (?)').run('her project file');
    open.push(proj);

    const out = join(src.dir, 'backups', 'b.tar.gz');
    createBackup(src.dir, out, { saraVersion: 'test' });
    const names = inspectBackup(out).entries.map((e) => e.path);
    for (const rel of ['messages.db', 'health.db', 'people/deep/journal.db']) {
      assert.ok(names.includes(rel), `${rel} is in the backup`);
      assert.ok(!names.includes(`${rel}-wal`) && !names.includes(`${rel}-shm`), `${rel}: no loose write-ahead files`);
    }
    assert.ok(names.includes('notes.db'), 'a file that only looks like a database is copied as it is');
    assert.ok(names.includes('workspaces/proj/app.db'), 'project files in her workspaces are copied as files');

    restoreBackup(out, dst.dir);
    for (const rel of ['messages.db', 'health.db', 'people/deep/journal.db']) {
      const db = new DatabaseSync(join(dst.dir, ...rel.split('/')), { readOnly: true });
      try {
        assert.equal((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 500, `${rel}: every row came back`);
        assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      } finally {
        db.close();
      }
    }
  } finally {
    for (const db of open) db.close();
    src.cleanup();
    dst.cleanup();
  }
});
