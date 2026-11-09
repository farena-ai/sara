// R1C1: a goal check carries the workspace manifest of its round; a later change makes it stale.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { goalsFor } from '../src/goals.ts';
import { projectNowSection } from '../src/project-now.ts';
import { workspaceRef } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { call, ROOT, text } from './helpers.ts';
import { git, projectFixture } from './project-now-fixture.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PKG = { name: 'r1c', version: '1.0.0', scripts: { test: `node -e "const s=require('fs').readFileSync('state','utf8').trim();console.log('ℹ pass 1');console.log('ℹ fail '+(s==='green'?0:1));process.exit(s==='green'?0:1)"` } };

async function until<T>(f: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

test('a goal check row gets its basis from its run; a stale green check is labelled stale and never "verified"', async (t) => {
  const f = projectFixture(t);
  writeFileSync(join(f.ws, 'package.json'), JSON.stringify(PKG));
  writeFileSync(join(f.ws, 'state'), 'red');
  git(f.ws, 'add', '-A'); git(f.ws, 'commit', '-q', '-m', 'goal fixture');
  f.app.settings.update({ timeZone: 'UTC' } as never);
  const auth = new OwnerAuth(f.dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app: f.app, auth, webDir: join(ROOT, 'web'), info: { version: VERSION, revision: null, startedAt: f.app.now().toISOString() } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { f.app.goals?.abortChecks(); await new Promise<void>(r => server.close(() => r())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const conv = f.app.store.createConversation({ mode: 'coding', title: 'Make it green' });
  f.app.script.push([call('w1', 'write_file', { path: 'state', content: 'green' })], text('Wrote the state file.'));
  const created = await api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const goal = await until(() => { const g = goalsFor(f.app).current(conv.id); return g?.state === 'done' ? g : undefined; });
  const row = f.app.store.db.prepare('SELECT run_id, ok, basis FROM goal_checks WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goal.id) as { run_id: number; ok: number; basis: string | null };
  assert.equal(row.ok, 1);
  const runRef = f.app.store.db.prepare('SELECT workspace_ref FROM run_steps WHERE run_id = ? AND workspace_ref IS NOT NULL ORDER BY idx DESC LIMIT 1').get(row.run_id) as { workspace_ref: string };
  assert.ok(row.basis, 'the check row stores a basis');
  assert.deepEqual(JSON.parse(row.basis!), JSON.parse(runRef.workspace_ref), 'the basis is the manifest its run took');
  const fresh = await api('GET', `/conversations/${conv.id}/goal`);
  assert.equal(fresh.json.goal.lastCheck.basisLabel.state, 'current');
  // Someone edits the project after the green check.
  writeFileSync(join(f.ws, 'src', 'auth.ts'), 'export const a = 42;\n');
  const stale = await api('GET', `/conversations/${conv.id}/goal`);
  assert.equal(stale.json.goal.lastCheck.basisLabel.state, 'stale');
  assert.ok(stale.json.goal.lastCheck.basisLabel.changed.includes('src/auth.ts'));
  const section = projectNowSection(f.app, conv, { now: await workspaceRef(f.ws) }) ?? '';
  assert.match(section, /goal check tests[^\n]*: passed, stale/);
  assert.doesNotMatch(section, /verified/i);
  assert.doesNotMatch(section, /passed, ran on [^\n]*current/);
  assert.equal(goalsFor(f.app).current(conv.id)!.state, 'done', 'labels never change the goal state');
  // Old rows (written before R1C) have no basis and show as unknown.
  f.app.store.db.prepare('UPDATE goal_checks SET basis = NULL').run();
  assert.equal((await api('GET', `/conversations/${conv.id}/goal`)).json.goal.lastCheck.basisLabel.state, 'unknown');
});
