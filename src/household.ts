// Phase 71: household mode. More than one person on one server, each with a space of their own
// (docs/HOUSEHOLD.md, docs/THREAT_MODEL.md → Household mode). The owner's space is the data folder
// itself (unchanged); each member's space is a complete data folder in members/<id>/ with its own
// sign-in (owner.json), settings, databases and files, built by the same code as the owner's
// companions. This module holds what is household-wide: the member list and invites
// (household.json, code hashes only), the member's view of shared settings and keys, the per-member
// policy (models, limits), the route allowlist for member spaces, and the small registries that
// sign-in needs before anyone is known (pairing codes, passkey challenges).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { SettingsStore, type Settings } from './settings.ts';
import type { Vault } from './vault.ts';

export const MEMBERS_DIR = 'members';
export const HOUSEHOLD_FILE = 'household.json';
/** Member tokens carry their member id, so a sign-in can be routed before it is checked. */
export const MEMBER_TOKEN_PREFIX = 'sara_m.';
/** A removed member can still download their data for this long, then the space is deleted. */
export const LEAVING_DAYS = 7;
/** How long an invite works (hours), as offered in the app. */
export const INVITE_HOURS = [1, 24, 72, 168] as const;
/** Pick-list values for the daily limits (0 = no limit). */
export const MESSAGE_LIMITS = [0, 20, 50, 100, 200, 500] as const;
export const COST_LIMITS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
/** Up to this many members on one server (plus pending invites). */
export const MAX_MEMBERS = 20;
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_LEN = 16;
const MEMBER_ID_RE = /^[a-f0-9]{10}$/;

export interface ModelPick {
  providerId: string;
  model: string;
}

export interface MemberLimits {
  /** The owner's models this member may use (the first is their default). */
  models: ModelPick[];
  /** Their own messages a day, all companions together (0 = no limit). */
  messagesPerDay: number;
  /** Estimated dollars a day from the token meter (0 = no limit). */
  costPerDay: number;
  /** Voice notes, read-aloud and live calls (they cost the owner). */
  voice: boolean;
  /** Pictures from her and new looks (they cost the owner). */
  pictures: boolean;
}

export type MemberStatus = 'active' | 'suspended' | 'leaving';

export interface MemberRecord {
  id: string;
  name: string;
  createdAt: string;
  status: MemberStatus;
  /** For 'leaving': when the space is deleted. */
  deleteAfter?: string;
  ownerConfirmed18At: string;
  memberConfirmed18At: string;
  limits: MemberLimits;
}

interface InviteRecord {
  id: string;
  hash: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  ownerConfirmed18At: string;
  limits: MemberLimits;
}

interface HouseholdFile {
  members: MemberRecord[];
  invites: InviteRecord[];
}

export type InviteView = Omit<InviteRecord, 'hash'>;

export class HouseholdError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalizeInviteCode = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newInviteCode(): string {
  let s = '';
  while (s.length < INVITE_LEN) for (const b of randomBytes(INVITE_LEN)) if (b < 248 && s.length < INVITE_LEN) s += INVITE_ALPHABET[b % 31];
  return s.match(/.{4}/g)!.join('-');
}

/** Limits from a request, checked (models must be among `available`). */
export function cleanLimits(v: unknown, available: ModelPick[], base?: MemberLimits): MemberLimits {
  const r = (v ?? {}) as Record<string, unknown>;
  const cur: MemberLimits = base ?? { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true };
  let models = cur.models;
  if (r.models !== undefined) {
    if (!Array.isArray(r.models)) throw new HouseholdError(400, en('Models must be a list.'));
    models = [];
    for (const m of r.models.slice(0, 40)) {
      const pick = { providerId: String((m as ModelPick)?.providerId ?? ''), model: String((m as ModelPick)?.model ?? '').trim().slice(0, 200) };
      if (!pick.providerId || !pick.model) continue;
      if (!available.some((a) => a.providerId === pick.providerId && a.model === pick.model)) throw new HouseholdError(400, en('That model is not set up on this server.'));
      if (!models.some((x) => x.providerId === pick.providerId && x.model === pick.model)) models.push(pick);
    }
  }
  const pick = (x: unknown, list: readonly number[], d: number) => {
    if (x === undefined) return d;
    const n = Number(x);
    if (!list.includes(n)) throw new HouseholdError(400, en('Pick one of the offered limits.'));
    return n;
  };
  return {
    models,
    messagesPerDay: pick(r.messagesPerDay, MESSAGE_LIMITS, cur.messagesPerDay),
    costPerDay: pick(r.costPerDay, COST_LIMITS, cur.costPerDay),
    voice: r.voice === undefined ? cur.voice : r.voice === true,
    pictures: r.pictures === undefined ? cur.pictures : r.pictures === true,
  };
}

/** household.json: the members and the pending invites (only the invite codes' hashes). */
export class HouseholdStore {
  readonly dataDir: string;
  readonly #path: string;
  readonly #now: () => Date;
  #file: HouseholdFile;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.dataDir = dataDir;
    this.#path = join(dataDir, HOUSEHOLD_FILE);
    this.#now = now;
    this.#file = existsSync(this.#path) ? (JSON.parse(readFileSync(this.#path, 'utf8')) as HouseholdFile) : { members: [], invites: [] };
    this.#file.members ??= [];
    this.#file.invites ??= [];
  }

  #save(): void {
    writeFileAtomic(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`, 0o600);
  }

  /** Members' folder (validated id; never joined from a request without this check). */
  dirOf(id: string): string {
    if (!MEMBER_ID_RE.test(id)) throw new HouseholdError(400, en('No such member.'));
    return join(this.dataDir, MEMBERS_DIR, id);
  }

  members(): MemberRecord[] {
    return structuredClone(this.#file.members);
  }

  get(id: string): MemberRecord | undefined {
    const m = this.#file.members.find((x) => x.id === id);
    return m ? structuredClone(m) : undefined;
  }

  invites(): InviteView[] {
    this.sweepInvites();
    return this.#file.invites.map(({ hash: _h, ...v }) => ({ ...v }));
  }

  /** Drops expired invites. */
  sweepInvites(): void {
    const now = this.#now().getTime();
    const before = this.#file.invites.length;
    this.#file.invites = this.#file.invites.filter((i) => Date.parse(i.expiresAt) > now);
    if (this.#file.invites.length !== before) this.#save();
  }

  /** A new invite (the code is returned once and only its hash kept). The owner confirms 18+. */
  invite(input: { name: unknown; hours: unknown; confirm18: unknown; limits: MemberLimits }): { code: string; invite: InviteView } {
    if (input.confirm18 !== true) throw new HouseholdError(400, en('Confirm that this person is 18 or older.'));
    const name = String(input.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) throw new HouseholdError(400, en('Type their name (only you see it).'));
    const hours = Number(input.hours ?? 24);
    if (!(INVITE_HOURS as readonly number[]).includes(hours)) throw new HouseholdError(400, en('Pick how long the invite works.'));
    if (!input.limits.models.length) throw new HouseholdError(400, en('Pick at least one model they may use.'));
    this.sweepInvites();
    if (this.#file.members.length + this.#file.invites.length >= MAX_MEMBERS) throw new HouseholdError(400, en('Up to {n} people besides you on one server.'));
    const code = newInviteCode();
    const now = this.#now();
    const rec: InviteRecord = { id: randomBytes(6).toString('hex'), hash: sha256(normalizeInviteCode(code)), name, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(), ownerConfirmed18At: now.toISOString(), limits: input.limits };
    this.#file.invites.push(rec);
    this.#save();
    const { hash: _h, ...invite } = rec;
    return { code, invite };
  }

  revokeInvite(id: string): boolean {
    const before = this.#file.invites.length;
    this.#file.invites = this.#file.invites.filter((i) => i.id !== id);
    if (this.#file.invites.length === before) return false;
    this.#save();
    return true;
  }

  #findInvite(code: string): InviteRecord | undefined {
    this.sweepInvites();
    const h = Buffer.from(sha256(normalizeInviteCode(code)));
    return this.#file.invites.find((i) => {
      const b = Buffer.from(i.hash);
      return b.length === h.length && timingSafeEqual(b, h);
    });
  }

  /** What the join page shows for a code (or undefined: wrong, used or expired). */
  checkInvite(code: string): { name: string; expiresAt: string } | undefined {
    const i = this.#findInvite(code);
    return i ? { name: i.name, expiresAt: i.expiresAt } : undefined;
  }

  /**
   * Uses an invite (once): the member confirms 18+, a member record and an empty folder are made.
   * The caller creates the member's sign-in in that folder and builds the space.
   */
  redeem(code: string, confirm18: unknown): { member: MemberRecord; dir: string } {
    if (confirm18 !== true) throw new HouseholdError(400, en('Confirm that you are 18 or older to join.'));
    const inv = this.#findInvite(code);
    if (!inv) throw new HouseholdError(404, en('That invite is wrong, was already used, or has expired. Ask for a new one.'));
    let id = randomBytes(5).toString('hex');
    while (this.#file.members.some((m) => m.id === id)) id = randomBytes(5).toString('hex');
    const now = this.#now().toISOString();
    const member: MemberRecord = { id, name: inv.name, createdAt: now, status: 'active', ownerConfirmed18At: inv.ownerConfirmed18At, memberConfirmed18At: now, limits: inv.limits };
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#file.invites = this.#file.invites.filter((i) => i !== inv);
    this.#file.members.push(member);
    this.#save();
    return { member: structuredClone(member), dir };
  }

  #mutate(id: string, fn: (m: MemberRecord) => void): MemberRecord {
    const m = this.#file.members.find((x) => x.id === id);
    if (!m) throw new HouseholdError(404, en('No such member.'));
    fn(m);
    this.#save();
    return structuredClone(m);
  }

  setLimits(id: string, limits: MemberLimits): MemberRecord {
    return this.#mutate(id, (m) => {
      m.limits = limits;
    });
  }

  rename(id: string, name: unknown): MemberRecord {
    const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n) throw new HouseholdError(400, en('Type their name (only you see it).'));
    return this.#mutate(id, (m) => {
      m.name = n;
    });
  }

  setStatus(id: string, status: 'active' | 'suspended'): MemberRecord {
    return this.#mutate(id, (m) => {
      if (m.status === 'leaving') throw new HouseholdError(409, en('This person is being removed.'));
      m.status = status;
    });
  }

  /** Removal step one: export-only access for LEAVING_DAYS, then deletion. */
  markLeaving(id: string): MemberRecord {
    return this.#mutate(id, (m) => {
      m.status = 'leaving';
      m.deleteAfter = new Date(this.#now().getTime() + LEAVING_DAYS * 86_400_000).toISOString();
    });
  }

  /** Members whose export window is over. */
  due(): MemberRecord[] {
    const now = this.#now().getTime();
    return this.members().filter((m) => m.status === 'leaving' && m.deleteAfter && Date.parse(m.deleteAfter) <= now);
  }

  /** Deletes a member's record and folder for good (the caller stopped their space first). */
  deleteMember(id: string): void {
    const dir = this.dirOf(id);
    if (!this.#file.members.some((m) => m.id === id)) throw new HouseholdError(404, en('No such member.'));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    this.#file.members = this.#file.members.filter((m) => m.id !== id);
    this.#save();
  }
}

/** The members' folders that exist and are listed (others are ignored). */
export function memberDirs(dataDir: string, h: HouseholdStore): { member: MemberRecord; dir: string }[] {
  const root = join(dataDir, MEMBERS_DIR);
  if (!existsSync(root)) return [];
  const names = new Set(readdirSync(root));
  return h.members().filter((m) => names.has(m.id)).map((m) => ({ member: m, dir: h.dirOf(m.id) }));
}

// ---------------------------------------------------------------------------------------------
// What a member sees of the owner's settings and keys
// ---------------------------------------------------------------------------------------------

/**
 * Settings only the owner has (server, accounts, bridges, tools, imports). A member's settings never
 * contain them, and a member's change never writes them.
 */
export const OWNER_SETTINGS: readonly (keyof Settings)[] = ['providers', 'prices', 'mcpServers', 'search', 'offsite', 'backup', 'discord', 'telegram', 'home', 'githubWatch', 'helpers', 'teamLimits', 'jobBudget', 'turnBudgets', 'sandboxGate', 'securityPass', 'threatModel', 'redteam', 'computerUse', 'evalSchedule', 'shellNetwork', 'modelLists', 'modelAutoSwitch', 'safetyClassifier', 'claimJudge', 'toolPermissions', 'alexa', 'presence', 'libraryLimits', 'plugins'];

/**
 * A member's settings: their own file, with the owner's providers (for the server code that runs
 * their models; the routes show them filtered) and prices layered in, read-only. Model choices are
 * kept only when they are among the member's allowed models; otherwise the first allowed one.
 */
export class MemberSettings extends SettingsStore {
  readonly #owner: SettingsStore;
  readonly #limits: () => MemberLimits;

  constructor(dir: string, owner: SettingsStore, limits: () => MemberLimits) {
    super(dir);
    this.#owner = owner;
    this.#limits = limits;
  }

  override get(): Settings {
    const own = super.get() as unknown as Record<string, unknown>;
    for (const k of OWNER_SETTINGS) delete own[k];
    const o = this.#owner.get();
    const allowed = this.#limits().models;
    const ok = (p?: { providerId: string; model: string }) => Boolean(p && allowed.some((a) => a.providerId === p.providerId && a.model === p.model));
    const out = { ...own, providers: o.providers, ...(o.prices ? { prices: o.prices } : {}), ...(o.libraryLimits ? { libraryLimits: o.libraryLimits } : {}), toolPermissions: {}, otherApps: { ...((own.otherApps as Settings['otherApps']) ?? {}), tools: false, changes: false } } as Settings;
    const first = allowed[0];
    if (!ok(out.defaultProviderId && out.defaultModel ? { providerId: out.defaultProviderId, model: out.defaultModel } : undefined)) {
      out.defaultProviderId = first?.providerId;
      out.defaultModel = first?.model;
    }
    if (out.companionModel && !ok(out.companionModel)) delete out.companionModel;
    if (out.routes) for (const [k, r] of Object.entries(out.routes)) if (!ok(r ?? undefined)) delete (out.routes as Record<string, unknown>)[k];
    if (out.defaultFallbacks) out.defaultFallbacks = out.defaultFallbacks.filter(ok);
    return out;
  }

  override update(patch: Partial<Settings>): Settings {
    const mine: Record<string, unknown> = { ...patch };
    for (const k of OWNER_SETTINGS) delete mine[k];
    if (Object.keys(mine).length) super.update(mine as Partial<Settings>);
    return this.get();
  }
}

/**
 * The owner's vault as a member's companions see it: read-only, and only the keys their allowed
 * models need, plus the voice and picture keys while those are switched on for them.
 */
export function memberVault(vault: Vault, limits: () => MemberLimits): Vault {
  const allowedKey = (name: string): boolean => {
    const l = limits();
    if (name.startsWith('provider:')) {
      const id = name.slice('provider:'.length);
      return l.models.some((m) => m.providerId === id) || l.voice || l.pictures;
    }
    if (name.startsWith('voice:')) return l.voice;
    if (name === 'images:xai') return l.pictures;
    return false;
  };
  const refuse = () => {
    throw new HouseholdError(403, en('Only the owner of this server can change keys.'));
  };
  return new Proxy(vault, {
    get(target, prop) {
      if (prop === 'get') return (name: string) => (allowedKey(name) ? target.get(name) : undefined);
      if (prop === 'has') return (name: string) => allowedKey(name) && target.has(name);
      if (prop === 'values') return () => [];
      if (prop === 'set' || prop === 'delete') return refuse;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The member's policy: models and limits, checked before every model call
// ---------------------------------------------------------------------------------------------

/** Midnight (server time) today, as an ISO string. */
export function dayStart(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export class MemberPolicy {
  readonly id: string;
  readonly #household: HouseholdStore;
  readonly #apps: () => AppContext[];
  readonly #now: () => Date;

  constructor(household: HouseholdStore, id: string, apps: () => AppContext[], now: () => Date = () => new Date()) {
    this.#household = household;
    this.id = id;
    this.#apps = apps;
    this.#now = now;
  }

  record(): MemberRecord | undefined {
    return this.#household.get(this.id);
  }

  limits(): MemberLimits {
    return this.record()?.limits ?? { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false };
  }

  /** Throws when this model isn't one the owner allowed for this member. */
  checkModel(providerId: string, model: string): void {
    if (!this.limits().models.some((m) => m.providerId === providerId && m.model === model)) throw new Error(`The owner of this server hasn't made ${model} available to you. Pick one of your models in Settings → Models.`);
  }

  /** Their own messages today and the estimated cost today (all their companions). */
  today(): { messages: number; usd: number } {
    const since = dayStart(this.#now());
    let messages = 0;
    let usd = 0;
    const seen = new Set<unknown>();
    for (const app of this.#apps()) {
      if (seen.has(app.store.db)) continue;
      seen.add(app.store.db);
      messages += Number((app.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?").get(since) as { n: number }).n);
      usd += app.usage?.summary(since).total.usd ?? 0;
    }
    return { messages, usd: Math.round(usd * 1e4) / 1e4 };
  }

  /** Throws when the member is paused or over a daily limit (before any model call). */
  checkBudget(): void {
    const r = this.record();
    if (!r || r.status !== 'active') throw new Error('Your account on this server is paused. Ask the owner.');
    const l = r.limits;
    if (!l.messagesPerDay && !l.costPerDay) return;
    const t = this.today();
    if (l.messagesPerDay && t.messages > l.messagesPerDay) throw new Error(`You've reached today's limit of ${l.messagesPerDay} messages on this server. It starts again at midnight.`);
    if (l.costPerDay && t.usd >= l.costPerDay) throw new Error(`You've reached today's spending limit on this server ($${l.costPerDay}). It starts again at midnight.`);
  }
}

/** The owner's view of one member's usage: messages a day and estimated cost by model (no content). */
export function memberUsage(apps: AppContext[], now: Date, days = 7): { days: { day: string; messages: number }[]; byModel: { model: string; provider: string; usd: number; tokens: number; calls: number }[]; usd: number; tokens: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const counts = new Map<string, number>();
  const models = new Map<string, { model: string; provider: string; usd: number; tokens: number; calls: number }>();
  let usd = 0;
  let tokens = 0;
  const seen = new Set<unknown>();
  for (const app of apps) {
    if (seen.has(app.store.db)) continue;
    seen.add(app.store.db);
    const rows = app.store.db.prepare("SELECT created_at FROM messages WHERE role = 'user' AND created_at >= ?").all(start.toISOString()) as { created_at: string }[];
    for (const r of rows) {
      const d = new Date(r.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const s = app.usage?.summary(start.toISOString());
    if (!s) continue;
    usd += s.total.usd;
    tokens += s.total.tokens;
    for (const m of s.byModel) {
      const k = `${m.providerId}\u0000${m.model}`;
      const cur = models.get(k) ?? { model: m.model, provider: m.providerLabel, usd: 0, tokens: 0, calls: 0 };
      cur.usd += m.usd;
      cur.tokens += m.tokens;
      cur.calls += m.calls;
      models.set(k, cur);
    }
  }
  const out: { day: string; messages: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ day: key, messages: counts.get(key) ?? 0 });
  }
  return { days: out, byModel: [...models.values()].map((m) => ({ ...m, usd: Math.round(m.usd * 1e4) / 1e4 })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens), usd: Math.round(usd * 1e4) / 1e4, tokens };
}

// ---------------------------------------------------------------------------------------------
// Routes a member's space answers (everything else: 403 ownerOnly)
// ---------------------------------------------------------------------------------------------

/** Route families (first part after /api/) a member may use in their own space. */
export const MEMBER_ROUTES: ReadonlySet<string> = new Set([
  'session', 'logout', 'disclosure', 'household',
  // their own sign-in, devices and apps
  'security', 'passkey', 'two-step', 'owner-token', 'devices', 'device', 'pair',
  // talking
  'conversations', 'live', 'events', 'approvals', 'uploads', 'video', 'calls', 'voice', 'tags', 'find', 'reports',
  // Phase 78: the run view of their own turns (their space's own database)
  'runs',
  // her
  'persona', 'look', 'sara', 'character', 'gallery', 'companions', 'groups', 'adult', 'photos',
  // memory and life
  'memories', 'memory', 'scrapbook', 'moments', 'story', 'together',
  // planner and days
  'projects', 'tasks', 'notes', 'reminders', 'planner', 'places', 'today', 'briefing', 'review', 'leave-by', 'checklist', 'setup',
  // library
  'library',
  // Phase 96: their own skills (trusting a workspace's project skills and server folders stay the owner's)
  'skills',
  // their settings and data
  'settings', 'providers', 'usage', 'export', 'push', 'phone', 'safety', 'other-apps',
  // Phase 72: their own Alexa links (codes and unlinking in their space; the skill id stays the owner's)
  'alexa',
  // Phase 87: computer use on their OWN computers. The routes answer 403 ownerOnly unless the owner
  // switched on "Let household members use computer use" (src/routes/hands.ts checks it each time).
  'hands', 'computer',
]);

/** Families a member may write to only partly: GET-only for members. */
const MEMBER_READ_ONLY: ReadonlySet<string> = new Set(['providers', 'setup', 'safety', 'usage']);
/** Phase 83: the run routes that branch, compare or change something (owner-only inside the member family `runs`). */
export const BRANCH_ACTIONS: ReadonlySet<string> = new Set(['branch', 'diff', 'use', 'apply', 'discard', 'stop']);
/** While being removed: only what's needed to take their data and leave. */
const LEAVING_ROUTES: ReadonlySet<string> = new Set(['session', 'logout', 'household', 'export']);

/**
 * Whether a member's request may go on. Returns an error message (and ownerOnly) or undefined.
 * `parts` are the path parts after /api/.
 */
export function memberRouteCheck(rec: MemberRecord | undefined, method: string, parts: string[]): { status: number; message: string; ownerOnly?: boolean } | undefined {
  const [a, b] = parts;
  if (!rec) return { status: 401, message: en('Sign in first.') };
  if (rec.status === 'suspended' && a !== 'session' && a !== 'logout') return { status: 403, message: en('Your account on this server is paused. Ask the owner.') };
  if (rec.status === 'leaving' && !LEAVING_ROUTES.has(a)) return { status: 403, message: en('Your account is being removed: download your data in Settings → Your account.') };
  if (!MEMBER_ROUTES.has(a)) return { status: 403, message: en('Only the owner of this server can use this.'), ownerOnly: true };
  if (MEMBER_READ_ONLY.has(a) && method !== 'GET') return { status: 403, message: en('Only the owner of this server can use this.'), ownerOnly: true };
  // Household admin is the owner's; a member only has their own account (me…).
  if (a === 'household' && b !== 'me') return { status: 403, message: en('Only the owner of this server can use this.'), ownerOnly: true };
  // Phase 83: time-travel (branch, compare, use, apply, discard, stop) is the owner's; a member's run view stays read-only.
  if (a === 'runs' && ((parts[2] && BRANCH_ACTIONS.has(parts[2])) || parts[4] === 'branch')) return { status: 403, message: en('Only the owner of this server can use this.'), ownerOnly: true };
  // Phase 96: trusting project skills is the owner's (members have no workspaces of their own).
  if (a === 'skills' && b === 'trust-project') return { status: 403, message: en('Only the owner of this server can use this.'), ownerOnly: true };
  const l = rec.limits;
  if (!l.voice && (a === 'live' || a === 'calls' || (a === 'voice' && method !== 'GET') || a === 'video')) return { status: 403, message: en('Voice is switched off for you on this server. Ask the owner.') };
  if (!l.pictures && ((a === 'look' && method !== 'GET') || a === 'photos')) return { status: 403, message: en('Pictures from her are switched off for you on this server. Ask the owner.') };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Sign-in registries shared by every space (before anyone is known)
// ---------------------------------------------------------------------------------------------

const PAIR_MS = 10 * 60_000;
/** Pairing codes: one per space at a time; the front router finds the space by the code. */
export class PairRegistry {
  readonly #codes = new Map<string, { space: string; expires: number }>();
  #hash(code: string): string {
    return createHash('sha256').update(String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
  }
  issue(space: string, code: string, now = Date.now()): number {
    for (const [k, v] of this.#codes) if (v.space === space || v.expires < now) this.#codes.delete(k);
    const expires = now + PAIR_MS;
    this.#codes.set(this.#hash(code), { space, expires });
    return expires;
  }
  /** Which space a code was made in (without using it). */
  spaceOf(code: string, now = Date.now()): string | undefined {
    const v = this.#codes.get(this.#hash(code));
    return v && v.expires > now ? v.space : undefined;
  }
  /** Uses the code, only in the space it was made in. */
  take(space: string, code: string, now = Date.now()): boolean {
    const h = this.#hash(code);
    const v = this.#codes.get(h);
    if (!v || v.space !== space || v.expires < now) return false;
    this.#codes.delete(h);
    return true;
  }
  clear(space: string): void {
    for (const [k, v] of this.#codes) if (v.space === space) this.#codes.delete(k);
  }
}

/**
 * Reads a small JSON body so the front router can see who it is for, then gives the same bytes to
 * the server that answers (its JSON reader iterates the request).
 */
export async function peekJson(req: IncomingMessage, max = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) break;
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  (req as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<Buffer> })[Symbol.asyncIterator] = async function* () {
    if (buf.length) yield buf;
  };
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One cookie's value from a request (a garbled cookie is ignored). */
export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The member id inside a member token (`sara_m.<id>.<secret>`), if it is one. */
export function memberOfToken(token: unknown): string | undefined {
  const s = String(token ?? '');
  if (!s.startsWith(MEMBER_TOKEN_PREFIX)) return undefined;
  const id = s.slice(MEMBER_TOKEN_PREFIX.length).split('.')[0];
  return MEMBER_ID_RE.test(id) ? id : undefined;
}
