// R1C test fixture: a temp companion with a git workspace, run records and fake write/read tools.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeChecks } from '../src/diagnostics.ts';
import { PROJECT_NOW_MARK } from '../src/project-now.ts';
import { ProjectKnowledgeStore } from '../src/projectknow.ts';
import type { ChatRequest } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

export const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=alex@example.invalid', '-c', 'user.name=Alex', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, stdio: 'pipe' });

export function projectFixture(t: { after: (fn: () => void) => void }) {
  const temp = tempDir();
  const clock = { now: new Date('2026-11-06T14:00:00Z') };
  const app = makeApp(temp.dir, clock);
  app.runs = new RunStore(app.store.db, () => clock.now);
  app.projects = new ProjectKnowledgeStore(app, app.store.db);
  const ws = workspaceDir(temp.dir, 'main');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(ws, 'src', 'auth.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'src', 'session.ts'), 'export const s = 1;\n');
  git(ws, 'init', '-q', '-b', 'main'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  app.projects.get('main');
  const writes: string[] = [];
  app.tools.add({ spec: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } }, defaultPermission: 'auto', summarize: a => `write ${String(a.path)}`, async run(a) { writes.push(String(a.path)); writeFileSync(join(ws, String(a.path)), String(a.content)); return 'written'; } });
  app.tools.add({ spec: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, defaultPermission: 'auto', summarize: a => `read ${String(a.path)}`, async run() { return 'contents'; } });
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-06T12:00:00Z', toolPermissions: { write_file: 'auto', read_file: 'auto' } } as never);
  t.after(() => { closeChecks(app); app.store.close(); temp.cleanup(); });
  return { app, clock, ws, dir: temp.dir, writes };
}

/** A run of another chat, recorded the way the recorder does (one step, its touched files). */
export function otherRun(app: TestApp, conversationId: string, files: string[], o: { endedAt?: string; at?: string } = {}): number {
  const id = app.runs!.open({ kind: 'turn', conversationId, title: 'synthetic' });
  app.runs!.writeStep(id, 0, {}, o.at ?? o.endedAt ?? app.now().toISOString(), null, { calls: [], tools: [], files, contradictions: [] });
  if (o.endedAt) app.store.db.prepare("UPDATE runs SET status = 'ok', ended_at = ? WHERE id = ?").run(o.endedAt, id);
  return id;
}

export const noteOf = (r: ChatRequest | undefined): string => (r?.messages ?? []).map(m => (typeof m.content === 'string' ? m.content : '')).find(c => c.startsWith(PROJECT_NOW_MARK)) ?? '';
