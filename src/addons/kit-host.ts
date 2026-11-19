// W3.1 (docs/ADDON_KIT.md): the throwaway Sara the add-on kit's harness boots in its own process.
// `sara-addon test --sara <checkout>` and `sara-addon dev --sara <checkout>` import this file. It
// makes a fresh data folder, stages the add-on folder through the real PluginManager (review card,
// trust, install, settings, switch on for the companion), and runs its tools as registered Sara
// tools. `listen` also serves the web app on 127.0.0.1 with a scripted model, for a look in the
// browser. It never touches a running Sara, its data, the network or a real model.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OwnerAuth } from '../auth.ts';
import type { AppContext } from '../chat.ts';
import { createReleaseCache } from '../download.ts';
import { EventHub } from '../events.ts';
import { appInfo } from '../health.ts';
import { InnerStore } from '../inner.ts';
import { LifeStore } from '../life.ts';
import { MemoryStore } from '../memory.ts';
import { fromFolder, type PackageFile } from '../packages.ts';
import { loadPersona } from '../persona.ts';
import { createPlannerTools, PlannerStore } from '../planner.ts';
import { PLUGIN_LIMITS, PluginManager } from '../plugins/manager.ts';
import { pluginToolName, type PluginManifest } from '../plugins/manifest.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../providers/types.ts';
import { Redactor, vaultSecretValues } from '../redact.ts';
import { Scrapbook } from '../scrapbook.ts';
import { createSaraServer } from '../server.ts';
import { SettingsStore } from '../settings.ts';
import { SnapshotStore } from '../snapshots.ts';
import { Store } from '../store.ts';
import { ApprovalBroker, ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import { UploadStore } from '../uploads.ts';
import { Vault } from '../vault.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const SARA_VERSION: string = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
/** Not part of the add-on (the kit's pack leaves them out too: packages/sara-sdk/src/addon/files.ts). */
const NOT_PACKED = new Set(['tests', 'test', 'out', 'node_modules', '.git', '.github', '.vscode', '.idea', 'jsconfig.json', 'tsconfig.json', '.gitignore', '.DS_Store', 'Thumbs.db']);

export interface KitCard {
  title: string;
  lines: string[];
  image?: string;
  link?: string;
  buttons?: { label: string; tool: string; args?: Record<string, unknown> }[];
}
export interface KitHost {
  label: string;
  info: string[];
  manifest: PluginManifest;
  /** With `listen`: the address and the throwaway's owner token (sign in with it on that page). */
  url?: string;
  token?: string;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content?: string; card?: KitCard; error?: string }>;
  sent(): unknown[];
  stop(): Promise<void>;
}
export interface KitHostOptions {
  folder: string;
  fakes?: { settings?: Record<string, unknown>; secrets?: Record<string, string> };
  /** Serve the web app on 127.0.0.1 (port 0 = any free port). */
  listen?: boolean;
  port?: number;
}

/** The add-on folder's files as Sara would install them (tests, build output and editor files left out). */
export function addonFiles(folder: string): PackageFile[] {
  return fromFolder(folder, PLUGIN_LIMITS).filter((f) => !NOT_PACKED.has(f.path.split('/')[0]));
}

/**
 * The scripted model of the throwaway server: "/try <tool> {json}" calls the add-on's tool (the
 * approval card still asks); anything else gets a line saying so. Then it repeats the tool's result.
 */
class KitModel implements Provider {
  readonly config: ProviderConfig;
  readonly #prefix: string;
  constructor(config: ProviderConfig, prefix: string) {
    this.config = config;
    this.#prefix = prefix;
  }
  async listModels(): Promise<string[]> {
    return ['add-on-kit'];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const msgs = req.messages;
    let lastUser = -1;
    msgs.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
    });
    const tool = msgs.slice(lastUser + 1).find((m) => m.role === 'tool');
    if (tool) {
      yield { type: 'text', text: `Your add-on answered: ${String(tool.content ?? '').slice(0, 1500)}` };
      return;
    }
    const said = typeof msgs[lastUser]?.content === 'string' ? (msgs[lastUser].content as string) : '';
    const m = /\/?try\s+([a-z][a-z0-9_]*)\s*(\{[\s\S]*\})?\s*$/i.exec(said.trim());
    if (m) {
      const name = `${this.#prefix}${m[1]}`;
      let args: Record<string, unknown> = {};
      try {
        args = m[2] ? (JSON.parse(m[2]) as Record<string, unknown>) : {};
      } catch {
        yield { type: 'text', text: 'That JSON did not parse.' };
        return;
      }
      if (req.tools?.some((t) => t.name === name)) {
        yield { type: 'tool_call', call: { id: `kit-${Date.now()}`, name, arguments: args } };
        return;
      }
      yield { type: 'text', text: `I wasn't offered ${name} in this chat. Is the add-on switched on?` };
      return;
    }
    yield { type: 'text', text: "This throwaway Sara has no real model. Type /try <tool> {\"arg\": \"value\"} to call your add-on's tool." };
  }
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what} (waited ${ms / 1000} s).`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Boots the throwaway Sara with the add-on installed and switched on. Call stop() when done. */
export async function bootAddonHost(o: KitHostOptions): Promise<KitHost> {
  const folder = resolve(o.folder);
  const dir = mkdtempSync(join(tmpdir(), 'sara-addon-kit-'));
  mkdirSync(dir, { recursive: true });
  const now = () => new Date();
  const vault = new Vault(dir);
  const app = {
    store: new Store(join(dir, 'sara.db'), now),
    settings: new SettingsStore(dir),
    vault,
    persona: loadPersona(join(ROOT, 'persona', 'sara.json')),
    now,
    dataDir: dir,
    companionId: 'main',
    tools: new ToolRegistry(),
    approvals: new ApprovalBroker(),
    sandbox: { mode: 'none', network: false, detail: 'add-on kit harness' },
    redactor: new Redactor(() => vaultSecretValues(vault.values())),
    snapshots: new SnapshotStore(dir, now),
    uploads: new UploadStore(dir),
  } as unknown as AppContext;
  app.memory = new MemoryStore(app.store.db, now);
  app.planner = new PlannerStore(app.store.db, now);
  app.events = new EventHub();
  app.inner = new InnerStore(app.store.db, now);
  app.life = new LifeStore(app.store.db);
  app.scrapbook = new Scrapbook(app.store.db);
  for (const t of createPlannerTools({ planner: app.planner, now, timeZone: () => app.settings.get().timeZone })) app.tools.add(t);
  const pm = new PluginManager({
    db: app.store.db,
    dataDir: dir,
    vault,
    sandbox: app.sandbox,
    events: app.events!,
    scrub: (s) => s,
    fence: 'node-only',
    lookup: async () => {
      throw new Error('The add-on kit harness has no network.');
    },
    httpGet: async () => {
      throw new Error('The add-on kit harness has no network.');
    },
  });
  app.pluginManager = pm;
  pm.attach('main', app);
  let server: ReturnType<typeof createSaraServer> | undefined;
  const stop = async () => {
    try {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server?.closeAllConnections?.();
      await pm.stopAll();
    } finally {
      app.store.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Windows can hold a folder a moment after the add-on process exits; it's a temp folder.
      }
    }
  };
  try {
    const review = pm.stage(addonFiles(folder), { kind: 'folder', where: folder });
    const id = review.manifest.id;
    await pm.approve(review.id, { trust: true });
    const values: Record<string, unknown> = { ...(o.fakes?.settings ?? {}), ...(o.fakes?.secrets ?? {}) };
    if (Object.keys(values).length) await pm.putSettings(id, 'main', values);
    await pm.setEnabled(id, 'main', true);
    const manifest = review.manifest;
    const names = manifest.permissions.tools.map((t) => pluginToolName(id, t));
    await until(() => names.every((n) => app.tools.get(n)?.isAvailable?.() !== false && Boolean(app.tools.get(n))), 15_000, `${manifest.name} didn't get ready in the throwaway Sara`);
    const info = names.map((n) => `${n} (${app.tools.permission(n, {}) === 'ask' ? 'asks first' : app.tools.permission(n, {})})`);
    const host: KitHost = {
      label: `Sara ${SARA_VERSION} (throwaway, in this process): installed ${id} ${manifest.version} through the review card, switched on for main; Node permission flags, no OS sandbox here`,
      info: [`tools: ${info.join(', ') || '(none)'}`],
      manifest,
      async callTool(name, args) {
        const tool = app.tools.get(pluginToolName(id, name));
        if (!tool) return { error: `no tool ${name}` };
        const cards: Record<string, unknown>[] = [];
        const ctx: ToolContext = { workspaceDir: dir, sandbox: app.sandbox, signal: AbortSignal.timeout(35_000), conversationId: 'addon-kit', attachCard: (c: unknown) => cards.push(c as Record<string, unknown>) } as ToolContext;
        try {
          const content = await tool.run(structuredClone(args), ctx);
          const c = cards[0];
          if (!c) return { content };
          // The host's card names buttons by their registered tool; the add-on knows its own names.
          const card: KitCard = { title: String(c.title ?? ''), lines: (c.lines as string[]) ?? [] };
          if (c.image) card.image = String(c.image);
          if (c.link) card.link = String(c.link);
          if (Array.isArray(c.buttons)) card.buttons = (c.buttons as { label: string; tool: string; args?: Record<string, unknown> }[]).map((b) => ({ label: b.label, tool: b.tool.replace(/^.*__/, ''), ...(b.args ? { args: b.args } : {}) }));
          return { content, card };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      sent: () => pm.store.logs(id).map(({ kind, detail }) => ({ kind, detail })),
      stop,
    };
    if (o.listen) {
      app.settings.update({ providers: [{ id: 'kit', label: 'Add-on kit (scripted)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'add-on-kit', needsKey: false }], defaultProviderId: 'kit', defaultModel: 'add-on-kit', ownerName: 'Developer', disclosureAcceptedAt: now().toISOString() } as never);
      app.providerFactory = (config: ProviderConfig) => new KitModel(config, `${id.replace(/-/g, '_')}__`);
      const auth = new OwnerAuth(dir, now);
      const token = auth.newToken!;
      // No release lookups from a throwaway: the harness never goes on the network.
      const releases = createReleaseCache({ fetch: async () => { throw new Error('The add-on kit harness has no network.'); } });
      server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: appInfo(ROOT), releases });
      await new Promise<void>((r) => server!.listen(o.port ?? 0, '127.0.0.1', r));
      host.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      host.token = token;
    }
    return host;
  } catch (err) {
    await stop();
    throw err;
  }
}
