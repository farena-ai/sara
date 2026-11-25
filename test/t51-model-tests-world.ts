// T51: a small world for the model tests follow-ups: a server with scripted models on the owner's own
// hardware (one right, one wrong, one that errors) and a subscription one, and the HTTP routes.
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { TASKS } from '../src/model-test-tasks.ts';
import { ModelTests, testTiming } from '../src/model-tests.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';
import { BAD, GOOD } from './t49-model-tests-fixtures.ts';

testTiming.warmMs = 5_000;

export interface World {
  app: TestApp;
  tests: ModelTests;
  clock: { now: Date };
  dir: string;
  base: string;
  token: string;
  lists: Record<string, string[]>;
  /** Calls per model. */
  calls: Record<string, number>;
  /** Waits for the run, then closes the server and the database (as a restart would). */
  close: () => Promise<void>;
}

class Scripted implements Provider {
  readonly config: ProviderConfig;
  readonly #w: World;
  constructor(config: ProviderConfig, w: World) {
    this.config = config;
    this.#w = w;
  }
  async listModels(): Promise<string[]> {
    return this.#w.lists[this.config.id] ?? [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.#w.calls[req.model] = (this.#w.calls[req.model] ?? 0) + 1;
    const prompt = String(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
    if (prompt === 'Reply with OK.') return yield { type: 'text', text: 'OK' };
    if (req.model === 'broken:8b') throw new Error('500 model crashed');
    if (req.model === 'blank:8b') return;
    const task = TASKS.find((t) => t.kind === 'chat' && t.prompt === prompt)?.id ?? '?';
    const a = (req.model === 'weak:8b' ? BAD : GOOD)[task] ?? { text: '?' };
    if (a.text) yield { type: 'text', text: a.text };
    for (const call of a.calls ?? []) yield { type: 'tool_call', call };
  }
}

export async function world(t: { after: (fn: () => void | Promise<void>) => void }, opts: { dir?: string; keep?: boolean; token?: string } = {}): Promise<World> {
  const own = opts.dir ? { dir: opts.dir, cleanup: () => {} } : tempDir();
  const clock = { now: new Date('2026-11-24T10:00:00Z') };
  const app = makeApp(own.dir, clock);
  const w = { app, clock, dir: own.dir, lists: { home: ['good:8b', 'weak:8b', 'broken:8b', 'blank:8b'], sub: ['sub-model'] }, calls: {} } as unknown as World;
  app.providerFactory = (config) => new Scripted(config, w);
  app.settings.update({
    providers: [
      { id: 'home', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', local: true },
      { id: 'sub', label: 'Plan', kind: 'chatgpt', baseUrl: '' },
    ],
    defaultProviderId: 'home',
    defaultModel: 'good:8b',
    ownerName: 'Alex',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
  w.tests = app.modelTests = new ModelTests(app);
  const auth = new OwnerAuth(own.dir, () => clock.now);
  // A second server on the same data keeps the owner's token from the first.
  w.token = opts.token ?? auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  w.close = async () => {
    if (closed) return;
    closed = true;
    await w.tests.idle();
    server.close();
    app.store.close();
  };
  t.after(async () => {
    await w.close();
    if (!opts.keep) own.cleanup();
  });
  return w;
}

export async function api(w: World, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(w.base + path, { method, headers: { authorization: `Bearer ${w.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

/** Two or three models of the home provider on some jobs. */
export const models = (names: string[], jobs: string[]) => ({ scope: { kind: 'models', models: names.map((model) => ({ providerId: 'home', model })) }, jobs });
