// U3.17/U3.18 test helper: two in-process Sara servers linked over S9a, each with a T1 engine over a fake
// world (a crashed add-on, a repeated tool failure) and a fake T3 self-code whose changes the test moves
// through their life (working → proposed → applying → applied → undone …), calling the real hook
// `onCodeStatus` exactly like main.ts's SelfCode deps do.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { Messenger } from '../src/messages.ts';
import { onCodeStatus, remoteRepairOf } from '../src/remote-repair.ts';
import { Repair, type RepairEnv } from '../src/repair.ts';
import type { ChangeStatus, CheckReport, CodeChange } from '../src/self-code.ts';
import { setSelfCode } from '../src/self-code.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

export const clock = { now: new Date('2026-11-16T12:00:00Z') };

export function fakeRepair(app: TestApp, o: { addon?: boolean } = {}) {
  const st = {
    addons: o.addon === false ? [] : [{ id: 'weather', name: 'Weather', version: '1.0.0', status: 'crashed', enabled: true }],
    skills: new Map<string, string>(),
    toolErrors: [1, 2, 3].map((i) => ({ at: new Date(clock.now.getTime() - i * 60_000).toISOString(), tool: 'web_fetch' })),
    jobs: [] as { id: number; label: string; startedAt: string }[],
  };
  const env: RepairEnv = {
    now: () => clock.now,
    settings: { get: () => app.settings.get() as never, update: (p) => app.settings.update(p as never) },
    audit: () => {},
    health: () => [{ name: 'Memory', ok: true, detail: 'ok' }],
    history: () => ({ turns: 10, failed: 0 }),
    turnErrors: () => [],
    toolErrors: () => st.toolErrors,
    trouble: () => [],
    jobs: { running: () => st.jobs, stop: (id) => ((st.jobs = st.jobs.filter((j) => j.id !== id)), true) },
    addons: {
      list: () => st.addons,
      restart: async () => {},
      setEnabled: async (id, on) => {
        const a = st.addons.find((x) => x.id === id)!;
        a.enabled = on;
        a.status = on ? 'crashed' : 'stopped';
      },
    },
    grow: { skill: (d) => (st.skills.set(d.name, d.body), { name: d.name, scope: 'companion' }), removeSkill: (_s, n) => void st.skills.delete(n) },
  };
  return { env, st, rep: new Repair(env, new DatabaseSync(':memory:')) };
}

/** A fake T3: start() makes a 'working' change; move() walks it through its life and fires the hook. */
export function fakeSelfCode(app: TestApp) {
  const changes = new Map<number, CodeChange>();
  const adopted: { request: string; patch: string }[] = [];
  const at = () => clock.now.toISOString();
  const mk = (id: number, request: string): CodeChange => ({ id, createdAt: at(), updatedAt: at(), request, summary: null, status: 'working', note: null, noteKey: null, noteParams: null, files: [], checks: null, costUsd: 0, baseVersion: '1.0.0', appliedAt: null, ticket: null });
  const sc = {
    requests: [] as string[],
    adopted,
    status: () => ({ available: true }),
    start(request: string) {
      sc.requests.push(request);
      const c = mk(changes.size + 1, request);
      changes.set(c.id, c);
      return c;
    },
    get: (id: number) => changes.get(id),
    fits: () => true,
    adopt(request: string, patch: string) {
      adopted.push({ request, patch });
      const c = mk(changes.size + 1, request);
      changes.set(c.id, c);
      return c;
    },
    move(id: number, status: ChangeStatus, extra: Partial<CodeChange> = {}) {
      const c = { ...changes.get(id)!, ...extra, status, updatedAt: at() };
      changes.set(id, c);
      onCodeStatus(app, c);
      return c;
    },
  };
  setSelfCode(app, sc as never);
  return sc;
}

export const checksOk: CheckReport = { ok: true, steps: [{ name: 'typecheck', ok: true, detail: 'no errors', ms: 5 }, { name: 'related', ok: true, detail: '2 test files passed', ms: 9 }, { name: 'full', ok: true, skipped: true, detail: 'no time', ms: 0 }] };

export type PairNode = {
  app: TestApp;
  m: Messenger;
  base: string;
  dir: string;
  req: (method: string, path: string, body?: unknown) => Promise<any>;
  raw: (method: string, path: string, body?: unknown) => Promise<Response>;
  fx: ReturnType<typeof fakeRepair>;
  code: ReturnType<typeof fakeSelfCode>;
};

export async function pairNode(t: TestContext, name: string, o: { addon?: boolean } = {}): Promise<PairNode> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'small-1', needsKey: false }] as never, defaultProviderId: 'fake', defaultModel: 'small-1', fallbackAfterSec: 60 });
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  app.messages = m;
  const fx = fakeRepair(app, o);
  app.repair = fx.rep;
  const code = fakeSelfCode(app);
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await remoteRepairOf(app)?.idle();
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { app, m, base, dir: tmp.dir, req, raw, fx, code };
}

export async function linkPair(a: PairNode, b: PairNode): Promise<{ aLink: string; bLink: string }> {
  const had = new Set(a.m.links().map((l) => l.id));
  const { code } = await a.req('POST', '/api/messages/invite', { url: a.base });
  const joined = await b.req('POST', '/api/messages/join', { code, url: b.base });
  return { aLink: a.m.links().find((l) => !had.has(l.id))!.id, bLink: joined.chat.linkId };
}

/** `a` (helped) asks `b`; `b` accepts. */
export async function fixPass(a: PairNode, b: PairNode, aLink: string, scope: string) {
  const r = await a.req('POST', '/api/remote-repair/requests', { link: aLink, problem: 'the weather add-on', hours: 24, scope });
  const held = (await b.req('GET', '/api/remote-repair')).held.find((p: any) => p.status === 'asked');
  assert.ok(held);
  await b.req('POST', `/api/remote-repair/passes/${held.id}/accept`, { accept: true });
  return { given: r.pass.id as string, held: held.id as string };
}

export async function until<T>(f: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((ok) => setTimeout(ok, 15));
  }
  throw new Error(`timed out: ${what}`);
}
