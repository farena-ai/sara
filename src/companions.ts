// Phase 31: more than one companion on one server. Each companion is a complete Sara of her own:
// her own folder (data/companions/<id>/) with her database (conversations, memories, feelings,
// days, scrapbook), character, look and voice. The server's own things are shared: the owner's
// sign-in and devices, keys and subscriptions, models, tools, backups and notifications. The
// planner is shared or separate, as the owner chooses. The safety layer applies to every one.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import type { Persona } from './persona.ts';
import { SettingsStore, type Settings } from './settings.ts';
import { ToolRegistry } from './tools/registry.ts';
import type { Permission, Tool } from './tools/types.ts';

export const COMPANIONS_DIR = 'companions';
export const MAIN_ID = 'main';

/**
 * Settings that belong to each companion; everything else is the server's and shared. The AI
 * notice is per companion (each is a different AI character), and so is adult mode (with its own
 * 18+ confirmation).
 */
export const COMPANION_KEYS = ['persona', 'voice', 'adultMode', 'memory', 'proactive', 'calls', 'briefing', 'weeklyReview', 'leaveBy', 'disclosureAcceptedAt', 'photos', 'wardrobe', 'faceLock', 'companionModel', 'story', 'moments', 'presence', 'skillLearning', 'plugins'] as const satisfies readonly (keyof Settings)[];
type CompanionKey = (typeof COMPANION_KEYS)[number];
const isCompanionKey = (k: string): k is CompanionKey => (COMPANION_KEYS as readonly string[]).includes(k);

/** A companion's settings: her own keys from her folder, the rest from the server's settings. */
export class CompanionSettings extends SettingsStore {
  readonly #base: SettingsStore;

  constructor(dir: string, base: SettingsStore) {
    super(dir);
    this.#base = base;
  }

  override get(): Settings {
    const own = super.get() as unknown as Record<string, unknown>;
    const out = this.#base.get() as unknown as Record<string, unknown>;
    for (const k of COMPANION_KEYS) {
      if (own[k] === undefined) delete out[k];
      else out[k] = own[k];
    }
    return out as unknown as Settings;
  }

  override update(patch: Partial<Settings>): Settings {
    const mine: Record<string, unknown> = {};
    const shared: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) (isCompanionKey(k) ? mine : shared)[k] = v;
    if (Object.keys(mine).length) super.update(mine as Partial<Settings>);
    if (Object.keys(shared).length) this.#base.update(shared as Partial<Settings>);
    return this.get();
  }
}

/** A tool registry that also offers the main companion's add-on (MCP) tools, which run once. */
export class LinkedToolRegistry extends ToolRegistry {
  readonly #base: ToolRegistry;
  constructor(base: ToolRegistry) {
    super();
    this.#base = base;
  }
  #linked(): Tool[] {
    return this.#base.list().filter((t) => t.spec.name.startsWith('mcp_'));
  }
  override get(name: string): Tool | undefined {
    return super.get(name) ?? (name.startsWith('mcp_') ? this.#base.get(name) : undefined);
  }
  override list(): Tool[] {
    return [...super.list(), ...this.#linked().filter((t) => !super.get(t.spec.name))];
  }
  override get unsandboxed(): boolean {
    return this.#base.unsandboxed;
  }
  override set unsandboxed(v: boolean) {
    this.#base.unsandboxed = v;
  }
  override permission(name: string, overrides: Record<string, Permission> | undefined): Permission {
    return overrides?.[name] ?? this.defaultFor(this.get(name));
  }
  override enabled(overrides: Record<string, Permission> | undefined): Tool[] {
    return this.list().filter((t) => (t.isAvailable?.() ?? true) && this.permission(t.spec.name, overrides) !== 'never');
  }
}

export interface CompanionRecord {
  id: string;
  createdAt: string;
}

/** The extra companions' folders (the main companion is the data folder itself). */
export function companionDirs(dataDir: string): { id: string; dir: string; createdAt: string }[] {
  const root = join(dataDir, COMPANIONS_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => /^[a-z0-9-]{4,40}$/.test(n) && existsSync(join(root, n, 'companion.json')))
    .map((n) => {
      const rec = JSON.parse(readFileSync(join(root, n, 'companion.json'), 'utf8')) as CompanionRecord;
      return { id: n, dir: join(root, n), createdAt: rec.createdAt };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Makes a new companion's folder. Her character starts from `persona` (a fresh character from
 * the default sheet with her name, or a copy of another companion's) and she has no look yet.
 */
export function createCompanionDir(dataDir: string, persona: Record<string, unknown>, now = new Date()): { id: string; dir: string } {
  const id = randomUUID().slice(0, 8);
  const dir = join(dataDir, COMPANIONS_DIR, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'persona.json'), `${JSON.stringify(persona, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'companion.json'), `${JSON.stringify({ id, createdAt: now.toISOString() } satisfies CompanionRecord, null, 2)}\n`, { mode: 0o600 });
  return { id, dir };
}

/**
 * The character sheet for a new companion. Fresh: a short neutral sheet with the default's
 * personality and boundaries and no appearance yet (the owner shapes her in Settings →
 * Character and Look). A copy: the other companion's sheet with the new name.
 */
export function newCompanionPersona(base: Persona, name: string, pronouns: string, fresh: boolean): Record<string, unknown> {
  const swap = (s: string) => s.replace(new RegExp(`\\b${base.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), name);
  const p = pronouns === 'he' ? { obj: 'him', pos: 'his' } : pronouns === 'they' ? { obj: 'them', pos: 'their' } : { obj: 'her', pos: 'her' };
  if (fresh) {
    return {
      name,
      pronouns,
      age: base.age,
      summary: `${name} is the owner's companion and right hand: warm, sharp and playful, equally at home helping with work and talking about life. The owner is still getting to know ${p.obj}, and ${name} is finding ${p.pos} own way of being.`,
      background: [],
      personality: base.personality.map(swap),
      speech: base.speech.map(swap),
      boundaries: base.boundaries.map(swap),
    };
  }
  return {
    ...base,
    name,
    pronouns,
    summary: swap(base.summary),
    background: base.background.map(swap),
    personality: base.personality.map(swap),
    speech: base.speech.map(swap),
    boundaries: base.boundaries.map(swap),
  };
}

/** Puts a companion's folder aside (kept, recoverable by hand, left out of the list). */
export function retireCompanionDir(dataDir: string, id: string, now = new Date()): string {
  const from = join(dataDir, COMPANIONS_DIR, id);
  const to = join(dataDir, COMPANIONS_DIR, `.removed-${id}-${now.toISOString().replace(/[:.]/g, '-')}`);
  renameSync(from, to);
  return to;
}

/** One running companion. */
export interface Companion {
  id: string;
  app: AppContext;
  /** The request and upgrade handlers (an http.Server that never listens itself). */
  server: import('node:http').Server;
  start(): void;
  stop(): Promise<void>;
}

/** All running companions; the main one is always there. */
export class CompanionManager {
  readonly #list: Companion[] = [];
  readonly dataDir: string;
  /** Builds and starts a companion from her folder (set by main.ts). */
  build?: (id: string, dir: string) => Companion;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  add(c: Companion): void {
    this.#list.push(c);
  }

  all(): Companion[] {
    return [...this.#list];
  }

  get main(): Companion {
    return this.#list[0];
  }

  get(id: string | undefined): Companion | undefined {
    return this.#list.find((c) => c.id === id);
  }

  /** The companion a conversation belongs to. */
  byConversation(id: string): Companion | undefined {
    return this.#list.find((c) => c.app.store.getConversation(id));
  }

  /** The companion whose call is ringing (or just rang) with this id. */
  byRing(id: string): Companion | undefined {
    return this.#list.find((c) => c.app.calls?.current?.id === id);
  }

  /** The list for the app: name, face and whether she has her own look. */
  view(current: string): { id: string; name: string; current: boolean; main: boolean; ownLook: boolean }[] {
    return this.#list.map((c) => ({ id: c.id, name: c.app.persona.name, current: c.id === current, main: c.id === MAIN_ID, ownLook: c.id === MAIN_ID || Boolean(c.app.look?.custom) }));
  }

  async remove(id: string): Promise<void> {
    if (id === MAIN_ID) throw new Error('The first companion can’t be removed.');
    const i = this.#list.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('No such companion.');
    const [c] = this.#list.splice(i, 1);
    await c.stop();
    c.app.store.close();
    retireCompanionDir(this.dataDir, id);
  }
}
