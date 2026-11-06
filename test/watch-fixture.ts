// E4 (docs/ops/E4_DESIGN.md): a watch rig shared by test/watch-*.test.ts. One workspace "proj"
// under a fresh SARA_DATA, a fake clock at a weekday noon (UTC, outside the default quiet hours) and
// a recording stand-in for the owner's push notifications.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Watches } from '../src/watch.ts';
import { makeApp, tempDir } from './helpers.ts';

export function watchRig(t: TestContext, start = '2026-11-04T12:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(start) };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'UTC' });
  const ws = join(dir, 'workspaces', 'proj');
  mkdirSync(ws, { recursive: true });
  const pushes: { title: string; text: string; conversationId: string; tag: string }[] = [];
  app.push = { notifyOwner: async (title: string, text: string, conversationId: string, tag: string) => void pushes.push({ title, text, conversationId, tag }) } as never;
  const w = new Watches(app, app.store.db);
  app.watches = w;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const file = (name: string, text = '') => {
    const p = join(ws, name);
    writeFileSync(p, text);
    return p;
  };
  const append = (name: string, text: string) => appendFileSync(join(ws, name), text);
  const add = (name: string, patterns: string[] = ['ERROR'], extra: Record<string, unknown> = {}) => w.create({ root: 'workspace', workspace: 'proj', path: name, patterns, ...extra });
  /** Moves the clock on and runs the scheduler's watch step. */
  const later = (min: number) => {
    clock.now = new Date(clock.now.getTime() + min * 60_000);
    return w.due(clock.now);
  };
  return { app, w, ws, dir, clock, pushes, file, append, add, later };
}
