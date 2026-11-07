import { randomUUID } from 'node:crypto';
import { policy } from './policy-profile.ts';
import { createBackupAsync } from './backup-async.ts';
// Phase 121 part B (docs/design/BEGIN.md §5, 2.54.0): the safety check-up. Seventeen read-only
// checks over what `sara doctor`, the settings, the vault, the hooks and the owner file already know
// (no model call, no network: the update check reads the updater's cached status), a verdict in
// words, and one-click fixes that can only tighten: every fix is a small change set over known keys
// that passes `tightensOnly` (a fixed direction table) before anything is written, and is logged
// with its *before* so it can be undone. Fixes that touch the way in (bind, HTTPS, Tailscale, the
// local model server) are guided: they show the page or the exact command and change nothing.
//
// Tables (additive, the owner's main companion store.db): safety_runs, safety_fixes (§5.13).
// Vault keys: safety-undo:<fixId>:<n> (the original text of a note whose secret was hidden; 30 days).
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BACKUPS_DIR, backupName, DEFAULT_BACKUP, listBackups } from './backup.ts';
import type { AppContext } from './chat.ts';
import { runDoctor } from './doctor.ts';
import { isOllamaDaemon } from './model-catalog.ts';
import { en, trOwner } from './i18n.ts';
import { privateLocalOn } from './net-guard.ts';
import { DEFAULT_OFFSITE, OFFSITE_PASS_VAULT } from './offsite.ts';
import { accessInfo } from './platform.ts';
import { homeConversation } from './presence.ts';
import { identityOf } from './persona.ts';
import { KEY_SHAPED, vaultSecretValues } from './redact.ts';
import { adultModeOn, type Settings } from './settings.ts';
import type { SandboxInfo } from './tools/sandbox.ts';
import type { Permission, Tool } from './tools/types.ts';
import { weakKind, type Hook } from './webhooks.ts';

export type CheckStatus = 'green' | 'amber' | 'red' | 'skip';
export type Verdict = 'safe' | 'tighten' | 'fix-first';
export type UndoKind = 'any-time' | '30-days' | 'none';
export interface FixOffer {
  id: string;
  label: string;
  kind: 'one-click' | 'guided';
  undo: UndoKind;
  /** What it changes, in words (the inline confirm). */
  changes: string;
  /** Guided: the page it opens (settings:…) and/or the exact command for this computer. */
  open?: string;
  command?: string;
  /** S6: the devices/keys it would sign out (the owner may untick). */
  items?: { id: string; label: string }[];
  /** The token fix: asks for the current token first. */
  needsToken?: boolean;
}
export interface SafetyCheck {
  id: string;
  title: string;
  status: CheckStatus;
  line: string;
  why: string;
  detail?: string;
  /** Amber the owner marked "I know, don't warn me" (counts as fine). */
  accepted?: string;
  fixes: FixOffer[];
}
export interface SafetyReport {
  verdict: Verdict;
  title: string;
  words: string;
  fine: number;
  total: number;
  at: string;
  checks: SafetyCheck[];
}

/** The owner-file view the checks and the token / sign-out fixes use (src/auth.ts OwnerAuth). */
export interface SafetyAuth {
  readonly tokenAt: string | undefined;
  readonly twoStepOn: boolean;
  passkeys(): unknown[];
  devices(): { id: string; label: string; createdAt: string; lastSeen: string; kind: string }[];
  expiresOf(id: string): string | undefined;
  signOut(id: string): number;
  rotateToken(current: string, opts?: { clearPasskeys?: boolean }): string;
  verifyToken(token: string): boolean;
}

export interface SafetyDeps {
  app: AppContext;
  auth?: SafetyAuth;
  /** The server's data folder (the doctor's). */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sandbox?: SandboxInfo;
  /** The updater's cached status (no network). */
  updateStatus?: () => { state?: string; latest?: string; changes?: string[] } | undefined;
  /** Every companion app in the owner's space (the secrets scan); default: just `app`. */
  companions?: () => AppContext[];
  /** Household members' devices, with the member's name (S6). */
  memberDevices?: () => { member: string; id: string; label: string; lastSeen: string; signOut: () => void }[];
  /** Household members exist (S11 red). */
  members?: () => number;
  version?: string;
  now?: () => Date;
}

const DAY = 86_400_000;
export const UNDO_DAYS = 30;
export const MASK = '[hidden: looked like a key]';
const SQL = `CREATE TABLE IF NOT EXISTS safety_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, verdict TEXT NOT NULL, checks TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS safety_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, check_id TEXT NOT NULL, fix_id TEXT NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, undo TEXT NOT NULL, undo_until TEXT, undone_at TEXT, undo_of INTEGER
);`;

export class SafetyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ the tighten-only gate (§5.4)

export interface Change {
  key: string;
  before: unknown;
  after: unknown;
}
const RANK: Record<Permission, number> = { auto: 0, ask: 1, never: 2 };
const OFF_ONLY = /^(telegram\.allowOthers|telegram\.ownerWorkInGroups|discord\.allowServers|discord\.answerBots|discord\.ownerWorkInServers|shellNetwork)$/;
/** Nothing a fix may ever touch, whatever the direction. */
const FORBIDDEN = /^(adultMode|privateLocal|hub|providers|prices|safetyClassifier|claimJudge|routes|access|safety\b|safety\.|disclosure|defaultProviderId|defaultModel)/;
/** Each key's only allowed direction. Anything else (or the other way round) throws before writing. */
export const DIRECTIONS: readonly [RegExp, (before: unknown, after: unknown) => boolean][] = [
  [/^toolPermissions\.[\w:.@/-]+$/, (b, a) => (a === 'ask' || a === 'never') && RANK[a as Permission] > (RANK[b as Permission] ?? 3)],
  [OFF_ONLY, (b, a) => b === true && a === false],
  [/^backup\.auto$/, (b, a) => b === false && a === true],
  [/^backup\.now$/, (b, a) => b === 'none' && a === 'made'],
  [/^hooks\.[\w-]+\.enabled$/, (b, a) => b === true && a === false],
  [/^(session|agentKey|memberDevice)\.[\w:.-]+$/, (b, a) => b === 'present' && a === 'removed'],
  [/^folder\.mode$/, (b, a) => typeof b === 'number' && typeof a === 'number' && (a & ~b) === 0 && a !== b],
  [/^owner\.token$/, (b, a) => b === 'old' && a === 'new'],
  [/^text\.\d+\.\w+\.\w+\.\d+$/, (b, a) => typeof b === 'string' && typeof a === 'string' && a !== b && a.includes(MASK) && keepsOnlyOriginal(b, a)],
];
/** The redacted text keeps nothing but pieces of the original, in order, around the masks. */
function keepsOnlyOriginal(before: string, after: string): boolean {
  let at = 0;
  for (const piece of after.split(MASK)) {
    const i = before.indexOf(piece, at);
    if (i < 0) return false;
    at = i + piece.length;
  }
  return true;
}

export class GateError extends SafetyError {
  constructor(message: string) {
    super(422, message);
  }
}

/** Throws unless every change is on the table and goes the safe way. Nothing is written by it. */
export function tightensOnly(changes: readonly Change[]): void {
  if (!changes.length) throw new GateError(en('This fix changes nothing.'));
  for (const c of changes) {
    if (FORBIDDEN.test(c.key)) throw new GateError(`A fix can't change ${c.key}.`);
    const rule = DIRECTIONS.find(([re]) => re.test(c.key));
    if (!rule) throw new GateError(`A fix can't change ${c.key}.`);
    if (!rule[1](c.before, c.after)) throw new GateError(`That change to ${c.key} would make Sara less safe.`);
  }
}

// ------------------------------------------------------------------ reading and writing the keys

function readKey(d: SafetyDeps, key: string): unknown {
  const s = d.app.settings.get();
  const [a, b] = key.split('.');
  if (a === 'toolPermissions') return d.app.tools.permission(key.slice('toolPermissions.'.length), s.toolPermissions);
  if (a === 'telegram') return (s.telegram as Record<string, unknown> | undefined)?.[b] === true;
  if (a === 'discord') return (s.discord as Record<string, unknown> | undefined)?.[b] === true;
  if (a === 'shellNetwork') return s.shellNetwork !== false;
  if (key === 'backup.auto') return { ...DEFAULT_BACKUP, ...s.backup }.auto !== false;
  if (a === 'hooks') return d.app.hooks?.store.get(b)?.enabled === true;
  if (key === 'folder.mode') return statSync(d.dataDir).mode & 0o777;
  return undefined;
}
function writeKey(d: SafetyDeps, key: string, value: unknown): void {
  const app = d.app;
  const s = app.settings.get();
  const [a, b] = key.split('.');
  if (a === 'toolPermissions') app.settings.update({ toolPermissions: { ...(s.toolPermissions ?? {}), [key.slice('toolPermissions.'.length)]: value as Permission } });
  else if (a === 'telegram') app.settings.update({ telegram: { ...(s.telegram ?? {}), [b]: value } as Settings['telegram'] });
  else if (a === 'discord') app.settings.update({ discord: { ...(s.discord ?? {}), [b]: value } as Settings['discord'] });
  else if (a === 'shellNetwork') app.settings.update({ shellNetwork: Boolean(value) });
  else if (key === 'backup.auto') app.settings.update({ backup: { ...(s.backup ?? {}), auto: Boolean(value) } });
  else if (a === 'hooks') app.hooks?.store.update(b, { enabled: Boolean(value) });
  else if (key === 'folder.mode') chmodSync(d.dataDir, Number(value));
  else throw new GateError(`A fix can't change ${key}.`);
}

// ------------------------------------------------------------------ the store

export class SafetyLog {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SQL);
  }
  addRun(at: string, by: string, r: SafetyReport): void {
    this.db.prepare('INSERT INTO safety_runs (at, by, verdict, checks) VALUES (?, ?, ?, ?)').run(at, by, r.verdict, JSON.stringify(r.checks.map((c) => ({ id: c.id, status: c.status, line: c.line }))));
    this.db.prepare('DELETE FROM safety_runs WHERE id NOT IN (SELECT id FROM safety_runs ORDER BY id DESC LIMIT 30)').run();
  }
  lastRun(): { at: string; by: string; verdict: Verdict; checks: { id: string; status: CheckStatus; line: string }[] } | undefined {
    const r = this.db.prepare('SELECT * FROM safety_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return r ? { at: String(r.at), by: String(r.by), verdict: String(r.verdict) as Verdict, checks: JSON.parse(String(r.checks)) } : undefined;
  }
  fix(id: number): FixRow | undefined {
    const r = this.db.prepare('SELECT * FROM safety_fixes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toFix(r) : undefined;
  }
  recent(limit = 10): FixRow[] {
    return (this.db.prepare('SELECT * FROM safety_fixes ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toFix);
  }
  addFix(at: string, check: string, fix: string, before: unknown, after: unknown, undo: UndoKind, undoUntil: string | null, undoOf: number | null = null): number {
    return Number(this.db.prepare('INSERT INTO safety_fixes (at, check_id, fix_id, before, after, undo, undo_until, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(at, check, fix, JSON.stringify(before), JSON.stringify(after), undo, undoUntil, undoOf).lastInsertRowid);
  }
  setBefore(id: number, before: unknown): void {
    this.db.prepare('UPDATE safety_fixes SET before = ? WHERE id = ?').run(JSON.stringify(before), id);
  }
  undone(id: number, at: string): void {
    this.db.prepare('UPDATE safety_fixes SET undone_at = ? WHERE id = ?').run(at, id);
  }
}
export interface FixRow {
  id: number;
  at: string;
  checkId: string;
  fixId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  undo: UndoKind;
  undoUntil: string | null;
  undoneAt: string | null;
  undoOf: number | null;
}
const toFix = (r: Record<string, unknown>): FixRow => ({ id: Number(r.id), at: String(r.at), checkId: String(r.check_id), fixId: String(r.fix_id), before: JSON.parse(String(r.before)), after: JSON.parse(String(r.after)), undo: String(r.undo) as UndoKind, undoUntil: (r.undo_until as string | null) ?? null, undoneAt: (r.undone_at as string | null) ?? null, undoOf: r.undo_of === null || r.undo_of === undefined ? null : Number(r.undo_of) });

export function safetyLogFor(app: AppContext): SafetyLog {
  const a = app as AppContext & { safetyLog?: SafetyLog };
  a.safetyLog ??= new SafetyLog(app.store.db);
  return a.safetyLog;
}

// ------------------------------------------------------------------ the secrets scan (S15)

/** Stored text of hers that is scanned (never conversations, uploads or the library). */
const SCAN: readonly { table: string; col: string; what: string }[] = [
  { table: 'memories', col: 'content', what: en('a memory') },
  { table: 'notes', col: 'body', what: en('a note') },
  { table: 'recipes', col: 'steps', what: en('a recipe') },
  { table: 'person_facts', col: 'content', what: en('a people note') },
  { table: 'people', col: 'notes', what: en('a people note') },
];
export interface SecretHit {
  key: string;
  companion: string;
  what: string;
  id: number;
  inVault: boolean;
}
function undoTexts(d: SafetyDeps): Set<string> {
  const out = new Set<string>();
  for (const f of safetyLogFor(d.app).recent(500)) if (f.fixId === 'hide' && !f.undoneAt) for (const v of Object.values(f.before)) if (typeof v === 'string' && v.startsWith('vault:')) {
    const t = d.app.vault.get(v.slice(6));
    if (t) out.add(t);
  }
  return out;
}
function secretValues(d: SafetyDeps): string[] {
  const skip = undoTexts(d);
  return [...new Set(vaultSecretValues(d.app.vault.values()))].filter((v) => typeof v === 'string' && v.length >= 8 && !skip.has(v));
}
export function scanSecrets(d: SafetyDeps): SecretHit[] {
  const apps = d.companions?.() ?? [d.app];
  const known = secretValues(d);
  const hits: SecretHit[] = [];
  apps.forEach((app, ci) => {
    for (const t of SCAN) {
      let rows: { id: number; text: string }[] = [];
      try {
        rows = app.store.db.prepare(`SELECT id, ${t.col} AS text FROM ${t.table}`).all() as { id: number; text: string }[];
      } catch {
        continue; // no such table in this companion
      }
      for (const r of rows) {
        const text = String(r.text ?? '');
        if (!text || text.includes(MASK) && !known.some((k) => text.includes(k)) && !KEY_SHAPED.some((re) => re.test(text.split(MASK).join(' ')))) continue;
        const inVault = known.some((k) => text.includes(k));
        if (inVault || KEY_SHAPED.some((re) => re.test(text))) hits.push({ key: `text.${ci}.${t.table}.${t.col}.${Number(r.id)}`, companion: identityOf(app.persona).name, what: t.what, id: Number(r.id), inVault });
      }
    }
  });
  return hits;
}
/** The text with every vault secret and key-shaped string replaced by the mask. */
export function maskSecrets(text: string, known: string[]): string {
  let out = text;
  for (const k of [...known].sort((a, b) => b.length - a.length)) out = out.split(k).join(MASK);
  for (const re of KEY_SHAPED) out = out.replace(new RegExp(re.source, `${re.flags}g`), MASK);
  return out;
}
function textAt(d: SafetyDeps, key: string): { app: AppContext; table: string; col: string; id: number; get: () => string | undefined; set: (v: string) => void } {
  const [, ci, table, col, id] = key.split('.');
  const app = (d.companions?.() ?? [d.app])[Number(ci)];
  const t = SCAN.find((x) => x.table === table && x.col === col);
  if (!app || !t) throw new SafetyError(409, en('That note is gone.'));
  return {
    app,
    table,
    col,
    id: Number(id),
    get: () => (app.store.db.prepare(`SELECT ${col} AS text FROM ${table} WHERE id = ?`).get(Number(id)) as { text: string } | undefined)?.text,
    set: (v: string) => void app.store.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(v, Number(id)),
  };
}

// ------------------------------------------------------------------ the checks (S1, §5.3)

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|\[::1\])$/i;
const ALL = /^(0\.0\.0\.0|::|\[::\]|\*)$/;

function guide(platform: NodeJS.Platform, what: 'access' | 'ollama' | 'bwrap'): string {
  if (what === 'access') return platform === 'win32' ? en('Sara tray icon → Access → This computer only') : 'sudo sara access local';
  if (what === 'ollama') return platform === 'win32' ? 'setx OLLAMA_HOST 127.0.0.1' : platform === 'darwin' ? 'launchctl setenv OLLAMA_HOST 127.0.0.1' : 'sudo systemctl edit ollama  # Environment="OLLAMA_HOST=127.0.0.1"';
  return 'sudo apt install bubblewrap   # or: sudo dnf install bubblewrap';
}

/** Runs every check (read-only, no model, no network). */
export async function runSafetyCheck(d: SafetyDeps, by: 'page' | 'cli' | 'weekly' | 'her' = 'page', o: { log?: boolean } = {}): Promise<SafetyReport> {
  const app = d.app;
  const s = app.settings.get();
  const T = (text: string, params?: Record<string, unknown>) => trOwner(text, s, params);
  const env = d.env ?? process.env;
  const platform = d.platform ?? process.platform;
  const now = d.now?.() ?? app.now();
  const out: SafetyCheck[] = [];
  const add = (c: Omit<SafetyCheck, 'fixes'> & { fixes?: FixOffer[] }) => out.push({ fixes: [], ...c });
  const access = accessInfo(env);
  const host = String(env.SARA_HOST ?? '127.0.0.1').trim();
  const docker = env.SARA_DATA === '/data' && platform === 'linux' && env.SARA_DOCKER === '1';
  const devices = d.auth?.devices() ?? [];
  const lock = Boolean(d.auth && (d.auth.passkeys().length > 0 || d.auth.twoStepOn));
  // The doctor's shared rows (backups, off-server copy) are read from runDoctor, never re-implemented.
  const doc = await runDoctor({ dataDir: d.dataDir, settings: { get: () => ({ ...s, providers: [] }) } as never, vault: app.vault, now, ...(d.sandbox ? { sandbox: d.sandbox } : {}), tools: app.tools, platform, browser: () => ({ found: true, how: '' }) as never });
  const row = (name: string) => doc.find((x) => x.name === name);

  // S1 open-door
  const ollamaHost = String(env.OLLAMA_HOST ?? '').trim().replace(/:\d+$/, '');
  const demoOpen = env.SARA_DEMO === '1' && !LOOPBACK.test(host);
  const ollamaOpen = ALL.test(ollamaHost) || s.providers.some((p) => isOllamaDaemon(p) && (() => { try { return ALL.test(new URL(p.baseUrl).hostname); } catch { return false; } })());
  add({ id: 'open-door', title: T(en('Open without sign-in')), status: demoOpen || ollamaOpen ? 'red' : 'green', line: demoOpen ? T(en('The demo lets anyone in without signing in, and it listens on every network.')) : ollamaOpen ? T(en('Your local model server (Ollama) answers anyone on your network, with no password.')) : T(en('Nothing on this computer lets people in without signing in.')), why: T(en('A server that answers without a password lets anyone nearby use it, and your money or your data with it.')), ...(ollamaOpen ? { fixes: [{ id: 'ollama-local', label: T(en('Show me how')), kind: 'guided', undo: 'none', changes: T(en('Make Ollama answer this computer only, then check again.')), command: guide(platform, 'ollama') }] } : {}) });

  // S2 bind
  const bindAll = ALL.test(host) && !docker;
  const meant = access.mode && access.mode !== 'local';
  add({ id: 'bind', title: T(en('Who can reach her')), status: bindAll && !meant ? 'red' : bindAll && access.mode === 'lan' ? 'amber' : 'green', line: bindAll && !meant ? T(en('Sara listens on every network this computer is on, but she was set up for this computer only.')) : bindAll && access.mode === 'lan' ? T(en('Sara listens on your home network, as you chose.')) : docker ? T(en('Running in Docker: the port mapping in your compose file decides who can reach her.')) : T(en('Sara listens only where you set her up to.')), why: T(en('Listening on every network means other computers can reach the sign-in page. Only do that on purpose.')), ...(bindAll ? { fixes: [{ id: 'access-local', label: T(en('Show me how')), kind: 'guided', undo: 'none', changes: T(en('Set her back to this computer only (changing this from the page could lock you out).')), command: guide(platform, 'access') }] } : {}) });

  // S3 https
  const plain = Boolean(access.warning);
  add({ id: 'https', title: T(en('HTTPS off this computer')), status: plain && access.mode === 'domain' ? 'red' : plain ? 'amber' : 'green', line: plain ? T(en('Phones reach her over plain HTTP: someone on the same Wi-Fi could read your chats.')) : T(en('Other devices reach her over HTTPS, or only this computer does.')), why: T(en('Without HTTPS, what you send can be read by anyone on the same network. Tailscale gives you HTTPS with no setup.')), ...(plain ? { fixes: [{ id: 'tailscale', label: T(en('Set up Tailscale')), kind: 'guided', undo: 'none', changes: T(en('Opens the Phone page with the Tailscale steps.')), open: 'settings:co-phone' }] } : {}) });

  // S4 token
  if (d.auth) {
    const at = d.auth.tokenAt;
    const old = !at || now.getTime() - Date.parse(at) > 365 * DAY;
    add({ id: 'token', title: T(en('Owner token')), status: old ? 'amber' : 'green', line: !at ? T(en("We don't know when your owner token was made. Making a new one is quick.")) : old ? T(en('Your owner token is over a year old.')) : T(en('Your owner token was made {days} day(s) ago.'), { days: Math.floor((now.getTime() - Date.parse(at)) / DAY) }), why: T(en('The owner token opens everything. A new one now and then means an old copy somewhere stops working.')), ...(old ? { fixes: [{ id: 'new-token', label: T(en('Make a new owner token')), kind: 'one-click', undo: 'none', needsToken: true, changes: T(en('Every device signs out, this one too. The new token is shown once: save it in your password manager.')) }] } : {}) });
  }

  // S5 two-step
  if (d.auth) {
    const away = (access.mode !== null && access.mode !== 'local') || devices.some((x) => x.kind === 'browser' || x.kind === 'app') && devices.filter((x) => x.kind === 'browser' || x.kind === 'app').length > 1;
    add({ id: 'two-step', title: T(en('Sign-in lock')), status: !lock && away ? 'amber' : 'green', line: lock ? T(en('A passkey or two-step sign-in protects your owner token.')) : away ? T(en('Anyone with your owner token can sign in. A passkey or a 6-digit code stops that.')) : T(en('Only this computer signs in, so a passkey is optional.')), why: T(en('A passkey or a code from your phone means a copied token alone is not enough to get in.')), ...(!lock && away ? { fixes: [{ id: 'open-devices', label: T(en('Add a passkey')), kind: 'guided', undo: 'none', changes: T(en('Opens Devices and sign-in.')), open: 'settings:dh-devices' }] } : {}) });
  }

  // S6 devices
  if (d.auth) {
    const cut = now.getTime() - 90 * DAY;
    const stale = devices.filter((x) => {
      if (x.kind === 'a2a') {
        const exp = d.auth!.expiresOf(x.id);
        return (exp && Date.parse(exp) < now.getTime()) || Date.parse(x.lastSeen) < cut;
      }
      if (x.kind === 'hands' || x.kind === 'home-assistant') return false;
      return Date.parse(x.lastSeen) < cut;
    });
    const members = (d.memberDevices?.() ?? []).filter((x) => Date.parse(x.lastSeen) < cut);
    const items = [...stale.map((x) => ({ id: `session.${x.id}`, label: x.kind === 'api' ? T(en('an API key “{label}”'), { label: x.label }) : x.label })), ...members.map((x) => ({ id: `memberDevice.${x.member}:${x.id}`, label: `${x.label} (${x.member})` }))];
    add({ id: 'devices', title: T(en('Old devices and keys')), status: items.length ? 'amber' : 'green', line: items.length ? T(en("{n} device(s) or key(s) haven't been used for 3 months: {list}."), { n: items.length, list: items.map((x) => x.label).slice(0, 5).join(', ') }) : T(en('Every signed-in device was used in the last 3 months.')), why: T(en('A device you no longer use can still get in if someone finds it. Signing it out costs nothing.')), ...(items.length ? { fixes: [{ id: 'sign-out', label: T(en('Sign them out')), kind: 'one-click', undo: 'none', items, changes: T(en('Signs out the devices and keys listed. They can sign in again.')) }] } : {}) });
  }

  // S7 backups
  const bk = { ...DEFAULT_BACKUP, ...s.backup };
  const back = row('Backups');
  add({ id: 'backups', title: T(en('Backups')), status: bk.auto === false ? 'red' : back?.status === 'ok' ? 'green' : 'amber', line: bk.auto === false ? T(en('Automatic backups are off.')) : back?.status === 'ok' ? T(en('Automatic backups are on; the newest is recent.')) : T(en('Automatic backups are on, but the newest is more than 2 days old.')), why: T(en('A backup is how you get her back after a broken disk or a bad update.')), fixes: bk.auto === false ? [{ id: 'auto-on', label: T(en('Turn automatic backups on')), kind: 'one-click', undo: 'any-time', changes: T(en('Sara makes a backup every day and keeps the last ones.')) }] : back?.status === 'ok' ? [] : [{ id: 'back-up-now', label: T(en('Back up now')), kind: 'one-click', undo: 'none', changes: T(en('Makes a backup now, on this computer.')) }] });

  // S8 offsite
  const off = { ...DEFAULT_OFFSITE, ...s.offsite };
  const offRow = row('Off-server copy');
  const offBad = off.kind !== 'off' && (!app.vault.has(OFFSITE_PASS_VAULT) || offRow?.status === 'fail');
  add({ id: 'offsite', title: T(en('Off-computer copy')), status: off.kind === 'off' ? 'amber' : offBad ? 'red' : 'green', line: off.kind === 'off' ? T(en('If this computer is lost, so are all of her backups.')) : offBad ? T(en("The copy off this computer isn't working: {detail}"), { detail: offRow?.detail ?? '' }) : T(en('A copy of her backups is kept off this computer.')), why: T(en('A fire, a theft or a dead disk takes the backups on the same computer with it.')), ...(off.kind === 'off' || offBad ? { fixes: [{ id: 'open-backups', label: T(en('Set it up')), kind: 'guided', undo: 'none', changes: T(en('Opens Backups.')), open: 'settings:dh-backups' }] } : {}) });

  // S9 approvals
  const sbNone = (d.sandbox ?? app.sandbox)?.mode === 'none';
  const moved = app.tools.list().filter((t) => app.tools.defaultFor(t) !== 'auto' && t.defaultPermission !== 'auto' && app.tools.permission(t.spec.name, s.toolPermissions) === 'auto');
  const cmd = app.tools.list().filter((t) => t.runsCommands && app.tools.permission(t.spec.name, s.toolPermissions) === 'auto');
  const redTools = sbNone ? cmd : [];
  const list = [...new Set([...redTools, ...moved].map((t) => t.spec.name))];
  add({ id: 'approvals', title: T(en('Tools that run without asking')), status: redTools.length ? 'red' : moved.length ? 'amber' : 'green', line: redTools.length ? T(en('She can run commands without asking, and this computer has no sandbox: {tools}.'), { tools: list.join(', ') }) : moved.length ? T(en('You set {tools} to run without asking.'), { tools: list.join(', ') }) : T(en('Tools that act for you ask first.')), why: T(en('Without a sandbox, a command she runs can touch every file you can. Asking first means you see each one before it runs.')), ...(list.length ? { fixes: [{ id: 'ask-again', label: T(en('Ask me first again')), kind: 'one-click', undo: 'any-time', changes: T(en('Sets {tools} back to Ask.'), { tools: list.join(', ') }) }] } : {}) });

  // S10 sandbox
  const net = s.shellNetwork !== false;
  const sbAmber = sbNone && (platform === 'linux' || net && cmd.length > 0);
  add({ id: 'sandbox', title: T(en('Sandbox')), status: sbNone && platform === 'linux' || sbNone && net && cmd.length ? 'amber' : 'green', line: !sbNone ? T(en('Her commands run in a sandbox.')) : sbAmber && net ? T(en('Her commands could reach the internet and there is no sandbox.')) : sbAmber ? T(en('There is no sandbox for her commands on this computer.')) : T(en('No sandbox on this computer; her commands ask first.')), why: T(en('A sandbox keeps her commands inside her workspace. Without one, asking first is the guard.')), fixes: sbAmber ? [...(net ? [{ id: 'net-off', label: T(en('Turn command internet off')), kind: 'one-click' as const, undo: 'any-time' as const, changes: T(en('Her commands can no longer reach the internet (builds that download need it back).')) }] : []), ...(platform === 'linux' ? [{ id: 'bwrap', label: T(en('Show me how')), kind: 'guided' as const, undo: 'none' as const, changes: T(en('Install bubblewrap, then restart Sara.')), command: guide(platform, 'bwrap') }] : [])] : [] });

  // S11 adult-lock
  const adult = adultModeOn(s);
  const others = (d.members?.() ?? 0) > 0 || devices.filter((x) => x.kind === 'browser' || x.kind === 'app').length > 1;
  add({ id: 'adult-lock', title: T(en('Adult mode lock')), status: adult && !lock ? (others ? 'red' : 'amber') : 'green', line: adult && !lock ? T(en('Adult mode is on and anyone who gets your token sees it. Add a sign-in lock.')) : adult ? T(en('Adult mode is on and a sign-in lock protects it.')) : T(en('Adult mode is off.')), why: T(en('A passkey (it uses your device PIN) or two-step sign-in means a copied token alone does not open adult chats.')), ...(adult && !lock ? { fixes: [{ id: 'open-devices', label: T(en('Add a passkey')), kind: 'guided', undo: 'none', changes: T(en('Opens Devices and sign-in.')), open: 'settings:dh-devices' }] } : {}) });

  // S12 bridges
  const tg = (s.telegram ?? {}) as Record<string, unknown>;
  const dc = (s.discord ?? {}) as Record<string, unknown>;
  const open = tg.allowOthers === true || dc.allowServers === true;
  const bots = dc.answerBots === true && !(Array.isArray(dc.botAllowList) && dc.botAllowList.length);
  const groups = tg.ownerWorkInGroups === true || dc.ownerWorkInServers === true;
  const nsfw = (Array.isArray(tg.nsfwChatIds) && tg.nsfwChatIds.length > 0) || (Array.isArray(dc.nsfwChannelIds) && dc.nsfwChannelIds.length > 0);
  const bFix: FixOffer[] = [];
  if (open) bFix.push({ id: 'only-me', label: T(en('Only me')), kind: 'one-click', undo: 'any-time', changes: T(en('Only you can talk to her in Telegram and Discord.')) });
  if (bots) bFix.push({ id: 'no-bots', label: T(en('No other bots')), kind: 'one-click', undo: 'any-time', changes: T(en('She stops answering other bots in Discord.')) });
  if (groups) bFix.push({ id: 'no-group-tools', label: T(en('No tools in groups')), kind: 'one-click', undo: 'any-time', changes: T(en('Your tools stop working for you in groups and servers.')) });
  add({ id: 'bridges', title: T(en('Chat apps open to strangers')), status: open && nsfw ? 'red' : open || bots || groups ? 'amber' : 'green', line: open ? T(en('Anyone who finds your bot can talk to her, and you pay for it.')) : bots ? T(en('She answers any bot in Discord.')) : groups ? T(en('Your tools work for you in group chats, where others can see.')) : T(en('Only you talk to her in chat apps.')), why: T(en('Strangers talking to her spend your money and see a labelled AI that knows you. Only me keeps the bots yours.')), fixes: bFix });

  // S13 hooks
  const hooks: Hook[] = app.hooks?.store.all() ?? [];
  const weak = hooks.filter((h) => h.enabled && weakKind(h.verify) && (h.sender === 'github' || h.sender === 'stripe' || h.action.kind === 'skill' || h.action.kind === 'plugin'));
  const weakRed = weak.filter((h) => h.action.kind === 'skill' || h.action.kind === 'plugin');
  add({ id: 'hooks', title: T(en('Weak webhooks')), status: weakRed.length ? 'red' : weak.length ? 'amber' : 'green', line: weak.length ? T(en('The hook “{name}” accepts anything sent to its address; the sender can sign its messages.'), { name: weak[0].name }) : T(en('Every webhook checks who sent it.')), why: T(en('A hook without a signature check believes anyone who knows its address. GitHub and Stripe can sign theirs.')), fixes: weak.length ? [{ id: 'pause', label: T(en('Pause this hook')), kind: 'one-click', undo: 'any-time', changes: T(en('Pauses {names}.'), { names: weak.map((h) => `“${h.name}”`).join(', ') }) }, { id: 'open-hooks', label: T(en("Switch to the sender's signature")), kind: 'guided', undo: 'none', changes: T(en('Opens Webhooks.')), open: 'settings:co-hooks' }] : [] });

  // S14 links
  const keys = devices.filter((x) => x.kind === 'a2a').filter((x) => {
    const exp = d.auth?.expiresOf(x.id);
    return (exp && Date.parse(exp) - now.getTime() < 14 * DAY) || (x.lastSeen === x.createdAt && now.getTime() - Date.parse(x.createdAt) > 30 * DAY);
  });
  add({ id: 'links', title: T(en('Agents and the hub')), status: keys.length ? 'amber' : 'green', line: keys.length ? T(en('Agent key(s) never used or about to expire: {list}.'), { list: keys.map((x) => x.label).join(', ') }) : T(en('No unused agent keys. The anonymous check-in is your choice in Data & health → Privacy.')), why: T(en('An agent key nobody uses is one more way in. The check-in sends no personal data; it is your choice in Privacy.')), ...(keys.length ? { fixes: [{ id: 'remove-keys', label: T(en('Remove unused agent keys')), kind: 'one-click', undo: 'none', items: keys.map((x) => ({ id: `agentKey.${x.id}`, label: x.label })), changes: T(en('Removes the agent keys listed.')) }] } : {}) });

  // S15 secrets
  const hits = scanSecrets(d);
  const anyVault = hits.some((h) => h.inVault);
  add({ id: 'secrets', title: T(en('Secrets in her notes')), status: anyVault ? 'red' : hits.length ? 'amber' : 'green', line: hits.length ? T(en('{n} of her notes contain something that looks like a password or key: {list}.'), { n: hits.length, list: [...new Set(hits.map((h) => `${T(h.what)} (${h.companion})`))].slice(0, 4).join(', ') }) : T(en('None of her notes holds a password or key.')), ...(hits.some((h) => !h.inVault) ? { detail: T(en("If this was a real password, change it where it's used.")) } : {}), why: T(en('Notes and memories are sent to the model and kept in backups. Keys belong in the vault, where they are encrypted.')), ...(hits.length ? { fixes: [{ id: 'hide', label: T(en('Hide them')), kind: 'one-click', undo: '30-days', changes: T(en('Replaces each secret with a mask. The original is kept encrypted for 30 days so you can undo.')) }] } : {}) });

  // S16 version
  if (privateLocalOn()) add({ id: 'version', title: T(en('Up to date')), status: 'skip', line: T(en("Can't check for updates offline (nothing leaves this computer).")), why: T(en('Only the newest version gets security fixes.')) });
  else {
    const u = d.updateStatus?.();
    const avail = u?.state === 'available';
    const sec = avail && /^security:/i.test(String(u?.changes?.[0] ?? ''));
    add({ id: 'version', title: T(en('Up to date')), status: sec ? 'red' : avail ? 'amber' : 'green', line: avail ? T(en('Version {latest} is out (you have {version}). Only the latest gets security fixes.'), { latest: u?.latest ?? '?', version: d.version ?? '?' }) : T(en('No newer version found at the last check ({version}).'), { version: d.version ?? '?' }), why: T(en('Only the newest version gets security fixes. Sara never updates by herself.')), ...(avail ? { fixes: [{ id: 'open-updates', label: T(en('Open Updates')), kind: 'guided', undo: 'none', changes: T(en('Opens Updates.')), open: 'settings:dh-updates' }] } : {}) });
  }

  // S17 folder
  if (platform === 'win32') add({ id: 'folder', title: T(en('Data folder')), status: 'skip', line: T(en('Windows keeps her data folder in your user profile.')), why: T(en('Other users on this computer should not read her data.')) });
  else {
    let mode = 0o700;
    try {
      mode = statSync(d.dataDir).mode & 0o777;
    } catch {
      /* gone */
    }
    const opened = (mode & 0o077) !== 0;
    add({ id: 'folder', title: T(en('Data folder')), status: opened ? 'amber' : 'green', line: opened ? T(en('Other users on this computer can read her data folder.')) : T(en('Only Sara can read her data folder.')), why: T(en('Other users on this computer should not read her data.')), ...(opened ? { fixes: [{ id: 'private', label: T(en('Make it private')), kind: 'one-click', undo: 'any-time', changes: T(en('Only Sara can read her data folder (chmod 700).')) }] } : {}) });
  }

  // Accepted ambers count as fine (red can't be hidden).
  // EC5: settings looser than the admin's policy (drift). Only when a policy pins something.
  if (policy().get().rev) {
    const drift = policy().drift(s, { privateLocal: privateLocalOn(), tool: (n) => app.tools.get(n) });
    const name = policy().get().name || 'Policy';
    add({ id: 'policy', title: T(en('Your admin\'s policy')), status: drift.length ? 'amber' : 'green', line: drift.length ? T(en('Some settings are looser than the policy “{name}” allows: {list}.'), { name, list: drift.map((x) => `${x.key} (${x.items.slice(0, 3).join(', ')})`).join('; ') }) : T(en('Every setting is within the policy “{name}”.'), { name }), why: T(en('Pinned rules are enforced anyway; a looser setting left over from before the policy is shown here so you can tidy it.')), ...(drift.length ? { fixes: [{ id: 'open-policy', label: T(en('Open the policy')), kind: 'guided', undo: 'none', changes: T(en('Opens Household → Policy.')), open: 'settings:dh-policy' }] } : {}) });
  }
  const accepted = s.safetyCheck?.accepted ?? {};
  for (const c of out) if (c.status === 'amber' && accepted[c.id]) c.accepted = accepted[c.id];
  const report = verdictOf(out, now, s);
  if (o.log !== false) {
    safetyLogFor(app).addRun(now.toISOString(), by, report);
  }
  return report;
}

function verdictOf(checks: SafetyCheck[], now: Date, s: Settings): SafetyReport {
  const T = (text: string, params?: Record<string, unknown>) => trOwner(text, s, params);
  const counted = checks.filter((c) => c.status !== 'skip');
  const red = counted.filter((c) => c.status === 'red').length;
  const amber = counted.filter((c) => c.status === 'amber' && !c.accepted).length;
  const fine = counted.length - red - amber;
  const verdict: Verdict = red ? 'fix-first' : amber ? 'tighten' : 'safe';
  const title = verdict === 'safe' ? T(en('Looks safe')) : verdict === 'tighten' ? T(en('Mostly safe')) : T(en('Fix these first'));
  const words = verdict === 'safe' ? T(en('{fine} of {total} checks are fine.'), { fine, total: counted.length }) : verdict === 'tighten' ? (amber === 1 ? T(en('One thing to tighten. It isn\'t urgent.')) : T(en('{n} things to tighten. None of them is urgent.'), { n: amber })) : red === 1 ? T(en('One thing could let someone in or lose your data.')) : T(en('{n} things could let someone in or lose your data.'), { n: red });
  return { verdict, title, words, fine, total: counted.length, at: now.toISOString(), checks };
}

// ------------------------------------------------------------------ fixes (S2, §5.4)

/** The change set a one-click fix makes, from the check as it is now. */
function buildChanges(d: SafetyDeps, check: SafetyCheck, fixId: string, body: { items?: unknown }): Change[] {
  const app = d.app;
  const s = app.settings.get();
  const c = (key: string, after: unknown): Change => ({ key, before: readKey(d, key), after });
  const pick = (offer: FixOffer) => {
    const all = offer.items ?? [];
    const want = Array.isArray(body.items) ? new Set(body.items.map(String)) : undefined;
    return all.filter((x) => !want || want.has(x.id));
  };
  const offer = check.fixes.find((f) => f.id === fixId)!;
  switch (`${check.id}/${fixId}`) {
    case 'approvals/ask-again': {
      const sbNone = (d.sandbox ?? app.sandbox)?.mode === 'none';
      return app.tools.list().filter((t: Tool) => app.tools.permission(t.spec.name, s.toolPermissions) === 'auto' && ((t.runsCommands && sbNone) || (t.defaultPermission !== 'auto' && app.tools.defaultFor(t) !== 'auto'))).map((t) => c(`toolPermissions.${t.spec.name}`, 'ask'));
    }
    case 'bridges/only-me':
      return [...(readKey(d, 'telegram.allowOthers') ? [c('telegram.allowOthers', false)] : []), ...(readKey(d, 'discord.allowServers') ? [c('discord.allowServers', false)] : [])];
    case 'bridges/no-bots':
      return [c('discord.answerBots', false)];
    case 'bridges/no-group-tools':
      return [...(readKey(d, 'telegram.ownerWorkInGroups') ? [c('telegram.ownerWorkInGroups', false)] : []), ...(readKey(d, 'discord.ownerWorkInServers') ? [c('discord.ownerWorkInServers', false)] : [])];
    case 'backups/auto-on':
      return [c('backup.auto', true)];
    case 'backups/back-up-now':
      return [{ key: 'backup.now', before: 'none', after: 'made' }];
    case 'sandbox/net-off':
      return [c('shellNetwork', false)];
    case 'hooks/pause':
      return (app.hooks?.store.all() ?? []).filter((h) => h.enabled && weakKind(h.verify) && (h.sender === 'github' || h.sender === 'stripe' || h.action.kind === 'skill' || h.action.kind === 'plugin')).map((h) => c(`hooks.${h.id}.enabled`, false));
    case 'folder/private': {
      const before = readKey(d, 'folder.mode') as number;
      return [{ key: 'folder.mode', before, after: before & 0o700 }];
    }
    case 'devices/sign-out':
    case 'links/remove-keys':
      return pick(offer).map((x) => ({ key: x.id, before: 'present', after: 'removed' }));
    case 'secrets/hide': {
      const known = secretValues(d);
      return scanSecrets(d).map((h) => {
        const before = textAt(d, h.key).get() ?? '';
        return { key: h.key, before, after: maskSecrets(before, known) };
      });
    }
    case 'token/new-token':
      return [{ key: 'owner.token', before: 'old', after: 'new' }];
  }
  throw new SafetyError(400, en('Unknown fix.'));
}

export interface FixResult {
  ok: true;
  fixId: number;
  undo: UndoKind;
  check: SafetyCheck;
  token?: string;
}

/** One fix, the owner's tap: re-run the check, build the change, the gate, write, log. */
export async function applyFix(d: SafetyDeps, checkId: string, fixId: string, body: { current?: unknown; items?: unknown } = {}): Promise<FixResult> {
  const app = d.app;
  const now = (d.now?.() ?? app.now()).toISOString();
  const rep = await runSafetyCheck(d, 'page', { log: false });
  const check = rep.checks.find((c) => c.id === checkId);
  if (!check) throw new SafetyError(404, en('Unknown check.'));
  const offer = check.fixes.find((f) => f.id === fixId);
  if (!offer && GUIDED.has(checkId)) throw new SafetyError(400, en('This one is guided: Sara shows you where or what to type, and changes nothing herself.'));
  if (check.status === 'green' || check.status === 'skip' || !offer) throw new SafetyError(409, en('This check is already fine.'));
  if (offer.kind === 'guided') throw new SafetyError(400, en('This one is guided: Sara shows you where or what to type, and changes nothing herself.'));
  // The token: the current one, then a new one (keeps passkeys and two-step; signs every device out).
  if (offer.needsToken) {
    const cur = typeof body.current === 'string' ? body.current.trim() : '';
    if (!cur) throw new SafetyError(400, en('Type your current owner token first.'));
    if (!d.auth?.verifyToken(cur)) throw new SafetyError(403, en('That is not the current owner token.'));
    tightensOnly(buildChanges(d, check, fixId, body));
    const token = d.auth.rotateToken(cur, { clearPasskeys: false });
    for (const x of d.auth.devices()) if (x.kind === 'browser' || x.kind === 'app') d.auth.signOut(x.id);
    const id = safetyLogFor(app).addFix(now, checkId, fixId, { 'owner.token': 'old' }, { 'owner.token': 'new' }, 'none', null);
    return { ok: true, fixId: id, undo: 'none', check: (await runSafetyCheck(d, 'page', { log: false })).checks.find((c) => c.id === checkId)!, token };
  }
  const changes = buildChanges(d, check, fixId, body);
  tightensOnly(changes);
  const log = safetyLogFor(app);
  const undoUntil = offer.undo === '30-days' ? new Date(Date.parse(now) + UNDO_DAYS * DAY).toISOString() : null;
  const undo = offer.undo;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const id = log.addFix(now, checkId, fixId, {}, {}, undo, undoUntil);
  let n = 0;
  for (const ch of changes) {
    if (ch.key.startsWith('text.')) {
      const t = textAt(d, ch.key);
      const vk = `safety-undo:${id}:${n++}`;
      app.vault.set(vk, String(ch.before));
      t.set(String(ch.after));
      before[ch.key] = `vault:${vk}`;
      after[ch.key] = ch.after;
    } else if (ch.key.startsWith('session.') || ch.key.startsWith('agentKey.')) {
      d.auth?.signOut(ch.key.slice(ch.key.indexOf('.') + 1));
      before[ch.key] = 'present';
      after[ch.key] = 'removed';
    } else if (ch.key.startsWith('memberDevice.')) {
      d.memberDevices?.().find((x) => `memberDevice.${x.member}:${x.id}` === ch.key)?.signOut();
      before[ch.key] = 'present';
      after[ch.key] = 'removed';
    } else if (ch.key === 'backup.now') {
      await createBackupAsync(d.dataDir, join(d.dataDir, BACKUPS_DIR, backupName(new Date(now)).replace('.tar.gz', `-${randomUUID()}.tar.gz`)), { saraVersion: d.version ?? 'dev', includeWorkspaces: false });
      before[ch.key] = 'none';
      after[ch.key] = 'made';
    } else {
      writeKey(d, ch.key, ch.after);
      before[ch.key] = ch.before;
      after[ch.key] = ch.after;
    }
  }
  log.setBefore(id, before);
  log.db.prepare('UPDATE safety_fixes SET after = ? WHERE id = ?').run(JSON.stringify(after), id);
  const again = (await runSafetyCheck(d, 'page', { log: false })).checks.find((c) => c.id === checkId)!;
  return { ok: true, fixId: id, undo, check: again };
}
/** Checks whose only fixes are guided. */
export const GUIDED: ReadonlySet<string> = new Set(['open-door', 'bind', 'https', 'two-step', 'offsite', 'version', 'adult-lock', 'policy']);

/** Undo: the *before* back for that fix's keys only, if each still equals *after*. */
export function undoFix(d: SafetyDeps, fixRowId: number): { ok: true } {
  const app = d.app;
  const log = safetyLogFor(app);
  const f = log.fix(fixRowId);
  const now = (d.now?.() ?? app.now());
  if (!f || f.undoOf !== null) throw new SafetyError(404, en('Fix not found.'));
  if (f.undo === 'none') throw new SafetyError(409, en("This fix can't be undone."));
  if (f.undoneAt) throw new SafetyError(409, en('This fix was already undone.'));
  if (f.undo === '30-days' && f.undoUntil && Date.parse(f.undoUntil) <= now.getTime()) throw new SafetyError(409, en("30 days have passed: this can't be undone any more."));
  for (const [k, a] of Object.entries(f.after)) {
    const cur = k.startsWith('text.') ? textAt(d, k).get() : readKey(d, k);
    if (JSON.stringify(cur) !== JSON.stringify(a)) throw new SafetyError(409, en("You've changed it since; nothing was undone."));
  }
  if (f.undo === '30-days') for (const v of Object.values(f.before)) if (typeof v === 'string' && v.startsWith('vault:') && !app.vault.has(v.slice(6))) throw new SafetyError(409, en("30 days have passed: this can't be undone any more."));
  for (const [k, b] of Object.entries(f.before)) {
    if (k.startsWith('text.')) {
      const vk = String(b).slice(6);
      textAt(d, k).set(app.vault.get(vk) ?? '');
      app.vault.delete(vk);
    } else writeKey(d, k, b);
  }
  const at = now.toISOString();
  log.undone(f.id, at);
  log.addFix(at, f.checkId, f.fixId, f.after, f.before, 'none', null, f.id);
  return { ok: true };
}

/** Hourly: the 30-day originals of hidden secrets are deleted (Undo then says it can't). */
export function sweepUndo(app: AppContext, now: Date = app.now()): number {
  let n = 0;
  for (const f of safetyLogFor(app).recent(1000)) {
    if (f.undo !== '30-days' || f.undoneAt || !f.undoUntil || Date.parse(f.undoUntil) > now.getTime()) continue;
    for (const v of Object.values(f.before)) if (typeof v === 'string' && v.startsWith('vault:') && app.vault.has(v.slice(6))) {
      app.vault.delete(v.slice(6));
      n++;
    }
  }
  return n;
}

/** "I know, don't warn me" (amber only). */
export async function acceptCheck(d: SafetyDeps, checkId: string, accept: boolean): Promise<void> {
  const app = d.app;
  const rep = await runSafetyCheck(d, 'page', { log: false });
  const c = rep.checks.find((x) => x.id === checkId);
  if (!c) throw new SafetyError(404, en('Unknown check.'));
  if (accept && c.status !== 'amber') throw new SafetyError(400, en('Only amber checks can be hidden; red problems stay on the list.'));
  const cur = app.settings.get().safetyCheck ?? {};
  const accepted = { ...(cur.accepted ?? {}) };
  if (accept) accepted[checkId] = app.now().toISOString();
  else delete accepted[checkId];
  app.settings.update({ safetyCheck: { ...cur, accepted } });
}

// ------------------------------------------------------------------ the weekly quiet check (S3, §5.8)

const SEV: Record<CheckStatus, number> = { skip: -1, green: 0, amber: 1, red: 2 };
/** Run from the hourly backup timer: once a week, only a check that got worse posts (one notice + push). */
export async function weeklySafetyTick(d: SafetyDeps): Promise<{ ran: boolean; worse: string[] }> {
  const app = d.app;
  const s = app.settings.get();
  const cfg = s.safetyCheck ?? {};
  const now = d.now?.() ?? app.now();
  if (!cfg.weekly) return { ran: false, worse: [] };
  if (cfg.last?.at && now.getTime() - Date.parse(cfg.last.at) < 7 * DAY - 60_000) return { ran: false, worse: [] };
  const rep = await runSafetyCheck(d, 'weekly');
  const prev = cfg.last?.statuses ?? {};
  const worse = rep.checks.filter((c) => c.status !== 'skip' && !c.accepted && prev[c.id] !== undefined && SEV[c.status] > SEV[prev[c.id]] && (c.status === 'red' || prev[c.id] === 'green'));
  const fresh = app.settings.get().safetyCheck ?? {};
  app.settings.update({ safetyCheck: { ...fresh, last: { at: now.toISOString(), statuses: Object.fromEntries(rep.checks.map((c) => [c.id, c.status])) } } });
  if (worse.length) {
    const text = trOwner(en('Safety check-up: {list}. Open Settings → Data & health → Safety check-up.'), s, { list: worse.map((c) => c.line.replace(/[.!]$/, '')).join(' · ') });
    const conv = homeConversation(app) ?? app.store.listConversations().find((c) => !c.partner) ?? app.store.createConversation({ title: identityOf(app.persona).name });
    const msg = app.store.addMessage(conv.id, 'assistant', text, { app: true, safetyCheck: { worse: worse.map((c) => c.id) } });
    app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'job' });
    await app.push?.notifyOwner(identityOf(app.persona).name, text, conv.id, 'safety-check').catch(() => {});
  }
  return { ran: true, worse: worse.map((c) => c.id) };
}

/** Today: one *Needs you* line only when the last run has a red row (amber never reaches Today). */
export function todaySafetyLine(app: AppContext): { red: number; line: string } | null {
  const last = safetyLogFor(app).lastRun();
  const red = last?.checks.filter((c) => c.status === 'red').length ?? 0;
  if (!red) return null;
  return { red, line: trOwner(en('{n} safety problem(s) · Open check-up'), app.settings.get(), { n: red }) };
}

// ------------------------------------------------------------------ the CLI (§5.7)

const PAGE_NAMES: Record<string, string> = { 'dh-devices': 'Data & health → Devices and sign-in', 'dh-backups': 'Data & health → Backups', 'dh-updates': 'Data & health → Updates', 'co-phone': 'Connections → Phone', 'co-hooks': 'Connections → Webhooks' };
export function formatSafety(r: SafetyReport, o: { fixes?: boolean } = {}): string {
  const icon = { green: '✓', amber: '!', red: '✗', skip: '-' } as const;
  const lines = r.checks.map((c) => {
    const head = `${icon[c.status]} ${c.title.padEnd(31)} ${c.line}${c.accepted ? ' (you chose this)' : ''}`;
    if (!o.fixes || c.status === 'green' || c.status === 'skip') return head;
    const fx = c.fixes.map((f) => `    → ${f.label}: ${f.changes}${f.command ? `\n      ${f.command}` : ''}${f.open ? `\n      (in Settings: ${PAGE_NAMES[f.open.replace('settings:', '')] ?? f.open.replace('settings:', '')})` : ''}`);
    return [head, ...fx].join('\n');
  });
  return lines.join('\n');
}
export function verdictLine(r: SafetyReport): string {
  return `${r.title}: ${r.words}${r.verdict === 'safe' ? '' : ' Fix them in Settings → Data & health → Safety check-up, or run: sara doctor --safety'}`;
}
export const exitCodeOf = (v: Verdict): number => (v === 'safe' ? 0 : v === 'tighten' ? 1 : 2);

// ------------------------------------------------------------------ her read-only tool (§5.9)

export function createSafetyReportTool(deps: () => SafetyDeps): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'safety_report',
      description: "Read the owner's safety check-up: the verdict and one line per check (read-only; you can't fix anything: point the owner at Settings → Data & health → Safety check-up).",
      parameters: { type: 'object', properties: {} },
    },
    isAvailable: () => !deps().app.member,
    summarize: () => 'Read the safety check-up',
    async run() {
      const r = await runSafetyCheck(deps(), 'her');
      return `${r.title}: ${r.words}\n${r.checks.filter((c) => c.status !== 'skip').map((c) => `- ${c.title} (${c.accepted ? 'accepted' : c.status}): ${c.line}`).join('\n')}\nFixes are only on the page (Settings → Data & health → Safety check-up); you can't apply them.`;
    },
  };
}
