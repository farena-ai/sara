// E4 slice 1: which files may be watched. Only plain files inside one of the owner's workspaces (or
// Sara's own SARA_LOG_FILE); never links, linked folders, secrets, Sara's data, folders or devices;
// a file swapped for a link between checks is refused at the next check.
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WatchError } from '../src/watch.ts';
import { watchRig } from './watch-fixture.ts';

const refused = (f: () => unknown, re?: RegExp) => assert.throws(f, (e: unknown) => e instanceof WatchError && e.status === 400 && (!re || re.test(e.message)));

/** A link, or a skip where the system won't make one (Windows without the right). */
function link(t: TestContext, target: string, at: string, type: 'file' | 'junction'): boolean {
  try {
    symlinkSync(target, at, type);
    return true;
  } catch {
    t.diagnostic(`no ${type} links here`);
    return false;
  }
}

test('watch paths: outside the workspace, Sara’s data and unknown workspaces are refused', (t) => {
  const r = watchRig(t);
  writeFileSync(join(r.dir, 'outside.log'), 'x\n');
  refused(() => r.add('../outside.log'));
  refused(() => r.add('../../store.db'));
  refused(() => r.add(join(r.dir, 'outside.log')));
  refused(() => r.w.create({ root: 'workspace', workspace: 'nope', path: 'a.log', patterns: ['ERROR'] }));
  refused(() => r.w.create({ root: 'workspace', workspace: '../proj', path: 'a.log', patterns: ['ERROR'] }));
  refused(() => r.w.create({ root: 'elsewhere', path: '/var/log/syslog', patterns: ['ERROR'] }));
  assert.equal(r.w.list().length, 0);
});

test('watch paths: secrets (.env, id_rsa, store.db, vault, .secrets/) are refused', (t) => {
  const r = watchRig(t);
  mkdirSync(join(r.ws, '.secrets'));
  for (const name of ['.env', '.env.production', 'id_rsa', 'store.db', 'vault.json', 'vault', 'key.pem', '.secrets/token.log']) {
    r.file(name, 'ERROR\n');
    refused(() => r.add(name), undefined);
  }
});

test('watch paths: folders, missing files and devices are refused', (t) => {
  const r = watchRig(t);
  mkdirSync(join(r.ws, 'sub'));
  refused(() => r.add('sub'));
  refused(() => r.add('missing.log'));
  if (process.platform !== 'win32') {
    process.env.SARA_LOG_FILE = '/dev/null';
    t.after(() => delete process.env.SARA_LOG_FILE);
    refused(() => r.w.create({ root: 'log', patterns: ['ERROR'] }));
  }
});

test('watch paths: a link, or a file under a linked folder, is refused', (t) => {
  const r = watchRig(t);
  const out = join(r.dir, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'a.log'), 'ERROR\n');
  if (link(t, join(out, 'a.log'), join(r.ws, 'link.log'), 'file')) refused(() => r.add('link.log'));
  if (link(t, out, join(r.ws, 'linked'), 'junction')) refused(() => r.add('linked/a.log'));
});

test('watch paths: a folder swapped for a link between checks is refused at the next check', (t) => {
  const r = watchRig(t);
  mkdirSync(join(r.ws, 'logs'));
  r.file('logs/a.log', 'fine\n');
  const w = r.add('logs/a.log');
  const out = join(r.dir, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'a.log'), 'fine\nERROR secret outside\n');
  renameSync(join(r.ws, 'logs'), join(r.ws, 'logs-old'));
  if (!link(t, out, join(r.ws, 'logs'), 'junction')) return;
  const c = r.w.check(w.id);
  assert.equal(c.ok, false);
  assert.deepEqual(c.matched, []);
  assert.equal(r.w.alerts(w.id).length, 0);
});

test('watch paths: Sara’s own log (SARA_LOG_FILE) is allowed; a stored path is the real absolute path', (t) => {
  const r = watchRig(t);
  const logFile = join(r.dir, 'logs', 'sara.log');
  mkdirSync(join(r.dir, 'logs'));
  writeFileSync(logFile, 'start\n');
  process.env.SARA_LOG_FILE = logFile;
  t.after(() => delete process.env.SARA_LOG_FILE);
  const w = r.w.create({ root: 'log', patterns: ['ERROR'] });
  assert.equal(w.rootKind, 'log');
  assert.ok(w.path.endsWith('sara.log'));
  assert.ok(r.w.roots().log);
  r.file('ok.log', '');
  const v = r.add('ok.log');
  assert.equal(v.rootKind, 'workspace');
  assert.ok(/[\\/]workspaces[\\/]proj[\\/]ok\.log$/.test(v.path), v.path);
});
