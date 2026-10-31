import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppContext } from '../src/chat.ts';
import { loadPersona } from '../src/persona.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { SettingsStore } from '../src/settings.ts';
import { Store } from '../src/store.ts';
import { ApprovalBroker, ToolRegistry } from '../src/tools/registry.ts';
import { createWebSearchTool } from '../src/tools/search.ts';
import { searchConfig } from '../src/integrations.ts';
import { Vault } from '../src/vault.ts';
import { Redactor, vaultSecretValues } from '../src/redact.ts';
import { SnapshotStore } from '../src/snapshots.ts';
import { UploadStore } from '../src/uploads.ts';
import { Scrapbook } from '../src/scrapbook.ts';
import { MemoryStore } from '../src/memory.ts';
import { createPlannerTools, PlannerStore } from '../src/planner.ts';
import { EventHub } from '../src/events.ts';
import { InnerStore } from '../src/inner.ts';
import { LifeStore } from '../src/life.ts';

export const ROOT = resolve(import.meta.dirname, '..');

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sara-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (err) {
          // Read-only folders inside (installed plugins are 0555): a non-root user must make them
          // writable before they can be removed.
          if ((err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
          makeTreeWritable(dir);
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      } catch (err) {
        // Windows: a child process that is still exiting can hold the folder for a moment longer.
        // It's a temp folder; leaving it is harmless and isn't what the test checks.
        if (process.platform !== 'win32' || !/EPERM|EBUSY/.test(String((err as NodeJS.ErrnoException).code ?? err))) throw err;
      }
    },
  };
}

export const text = (...parts: string[]): StreamEvent[] => parts.map((t) => ({ type: 'text', text: t }));
export const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: 'tool_call', call: { id, name, arguments: args } });

/**
 * Scripted model. Each entry in `script` is one model step; when the script runs out it replies
 * with the default text. All requests are recorded.
 */
export class FakeProvider implements Provider {
  readonly config: ProviderConfig;
  readonly requests: ChatRequest[];
  readonly script: StreamEvent[][];
  constructor(config: ProviderConfig, script: StreamEvent[][], requests: ChatRequest[]) {
    this.config = config;
    this.script = script;
    this.requests = requests;
  }
  async listModels(): Promise<string[]> {
    return ['fake-small', 'fake-large'];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const step = this.script.shift() ?? text('Hey', ' you', '.');
    for (const ev of step) {
      // Like a real provider: a cancelled request stops the stream.
      if (req.signal?.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : new Error('aborted');
      yield ev;
    }
  }
}

export type TestApp = AppContext & { requests: ChatRequest[]; script: StreamEvent[][]; providerCalls: number };

export function makeApp(dir: string, clock: { now: Date }): TestApp {
  const requests: ChatRequest[] = [];
  const script: StreamEvent[][] = [];
  const vault = new Vault(dir);
  const app: TestApp = {
    store: new Store(join(dir, 'sara.db'), () => clock.now),
    settings: new SettingsStore(dir),
    vault,
    persona: loadPersona(join(ROOT, 'persona', 'sara.json')),
    now: () => clock.now,
    dataDir: dir,
    tools: new ToolRegistry(),
    approvals: new ApprovalBroker(),
    sandbox: { mode: 'none', network: true, detail: 'tests' },
    redactor: new Redactor(() => vaultSecretValues(vault.values())),
    snapshots: new SnapshotStore(dir, () => clock.now),
    uploads: new UploadStore(dir),
    requests,
    script,
    providerCalls: 0,
    providerFactory: (config) => {
      app.providerCalls++;
      return new FakeProvider(config, script, requests);
    },
  };
  app.tools.add(createWebSearchTool(() => searchConfig(app.settings, app.vault)));
  app.memory = new MemoryStore(app.store.db, () => clock.now);
  app.planner = new PlannerStore(app.store.db, () => clock.now);
  app.events = new EventHub();
  app.inner = new InnerStore(app.store.db, () => clock.now);
  app.life = new LifeStore(app.store.db);
  app.scrapbook = new Scrapbook(app.store.db);
  for (const t of createPlannerTools({ planner: app.planner, now: () => clock.now, timeZone: () => app.settings.get().timeZone })) app.tools.add(t);
  return app;
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

export async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const c of req as AsyncIterable<Buffer>) s += c.toString('utf8');
  return s;
}

export async function collectText(it: AsyncIterable<StreamEvent>): Promise<{ text: string; calls: StreamEvent[] }> {
  let t = '';
  const calls: StreamEvent[] = [];
  for await (const ev of it) {
    if (ev.type === 'text') t += ev.text;
    else calls.push(ev);
  }
  return { text: t, calls };
}

/** Phase 50: A fake embeddings server: words of the same concept share a dimension (so meaning ≠ words). */
export async function fakeEmbedder(t: { after: (fn: () => void) => void }): Promise<string> {
  const CONCEPTS: [number, RegExp][] = [
    [0, /\b(pdf|document|documents|pages?|scan)\b/gi],
    [1, /\b(greet|greeting|hello|welcome|salute)\b/gi],
    [2, /\b(count|counter|tally|add|increment)\b/gi],
    [3, /\b(upper|shout|loud|capital)\w*/gi],
    [4, /\b(deploy|release|ship|publish|production)\w*/gi],
    [5, /\b(flaky|random|intermittent|retry|unstable)\w*/gi],
  ];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { input: string[] };
    const data = body.input.map((s, index) => {
      const v = new Array(8).fill(0.01);
      for (const [dim, re] of CONCEPTS) v[dim] += (s.match(re) ?? []).length;
      return { index, embedding: v };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function makeTreeWritable(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) makeTreeWritable(p);
      else chmodSync(p, 0o600);
    }
  } catch {
    /* best effort */
  }
}
