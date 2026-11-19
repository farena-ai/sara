// W0.7 (docs/design/ROADMAP_W.md, docs/ALWAYS_ALLOW.md): "Always allow everything", one switch per
// person. While it is on, every command, desktop, browser and computer-use action she takes for THIS
// person runs without an approval card, including the kinds that otherwise always ask (payments,
// account and security settings, saved logins, destructive commands, the browser's own settings).
//
// What it never changes (these are limits, not approvals):
//   - she never types into a password field or types text shaped like a key (the device refuses too);
//   - blocked windows/tabs, banking and password managers stay hidden, admin prompts stay the person's;
//   - requests from other people (outside requests, other apps, forwarded mail, a linked server) still
//     ask: the switch covers what this person asks her to do, never what someone else asks;
//   - kids can never turn it on; household adults only when the owner allows it for them;
//   - every action still goes to the Action timeline (src/timeline.ts) with its undo, and to the audit trail.
// On the person's own computer the Sara app confirms it once on its own card (a phone can't relax a
// computer): the server sends `allowAll` (a key) + `allowAllMs` with each desktop op and command.
//
// Turning it on needs the owner's (or member's) password, code or passkey again (ctx.confirmIdentity)
// and the one-time warning (`warned: true`). Optional time limit: 1 hour, 1 day, or until turned off.
// Pure state in <dataDir>/always-allow.json; expiry is checked when asked (no timers).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import { en } from './i18n.ts';
import { policy } from './policy-profile.ts';

export const ALWAYS_FOR = ['1h', '1d', 'off'] as const;
export type AlwaysFor = (typeof ALWAYS_FOR)[number];
export const alwaysFor = (v: unknown): AlwaysFor => (v === '1h' || v === '1d' ? v : 'off');
const FOR_MS: Record<AlwaysFor, number | null> = { '1h': 3600_000, '1d': 24 * 3600_000, off: null };
/** How long a computer keeps its own confirmation when there is no end time (it asks again after). */
export const DEVICE_MAX_MS = 7 * 24 * 3600_000;

interface AlwaysFile {
  on: boolean;
  since?: string;
  until?: string | null;
  for?: AlwaysFor;
  warned?: boolean;
  ended?: { at: string; why: 'you' | 'time' | 'policy' };
}
export interface AlwaysView {
  on: boolean;
  since: string | null;
  until: string | null;
  for: AlwaysFor;
  warned: boolean;
  /** May this person turn it on here? */
  may: boolean;
  /** Why not (shown under the switch). */
  why: string | null;
  role: 'owner' | 'member' | 'kid';
  ended: { at: string; why: string } | null;
}

/** The bits of the app this needs (the real AppContext fits). */
export interface AlwaysApp {
  dataDir: string;
  now: () => Date;
  member?: { id?: string; child?: () => unknown; limits?: () => { alwaysAllow?: boolean } } | undefined;
  demo?: boolean;
  offRecord?: boolean;
}

const fileOf = (app: AlwaysApp) => join(app.dataDir, 'always-allow.json');
function read(app: AlwaysApp): AlwaysFile {
  try {
    if (!existsSync(fileOf(app))) return { on: false };
    const j = JSON.parse(readFileSync(fileOf(app), 'utf8')) as AlwaysFile;
    return j && typeof j === 'object' ? j : { on: false };
  } catch {
    return { on: false };
  }
}
function write(app: AlwaysApp, f: AlwaysFile): void {
  const p = fileOf(app);
  writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 1), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
const roleOf = (app: AlwaysApp): AlwaysView['role'] => (app.member ? (app.member.child?.() ? 'kid' : 'member') : 'owner');
const who = (app: AlwaysApp) => (app.member ? 'member' : 'owner');

/** May this person use the switch? Kids never; adults only when the owner allows it for them. */
export function mayAlwaysAllow(app: AlwaysApp): { ok: boolean; why?: string } {
  if (app.demo || app.offRecord) return { ok: false, why: en('Not available here.') };
  const role = roleOf(app);
  if (role === 'kid') return { ok: false, why: en('Not available in kid mode.') };
  if (role === 'member' && app.member?.limits?.().alwaysAllow !== true) return { ok: false, why: en('The owner has not allowed this for you. Ask them to turn it on for you in Settings → Household.') };
  if (!policy().alwaysAllowOn) return { ok: false, why: en("Your admin's policy doesn't allow Always allowed on this server.") };
  return { ok: true };
}

function end(app: AlwaysApp, f: AlwaysFile, why: 'you' | 'time' | 'policy'): AlwaysFile {
  const out: AlwaysFile = { on: false, for: f.for, warned: f.warned, ended: { at: app.now().toISOString(), why } };
  write(app, out);
  audit({ action: 'always_allow.off', target: 'always-allow', role: who(app), who: why === 'you' ? who(app) : 'system', channel: 'web', outcome: 'ok', keys: [why] });
  return out;
}

/** The live state (an expired or no-longer-allowed switch is turned off here). */
function live(app: AlwaysApp): AlwaysFile {
  const f = read(app);
  if (!f.on) return f;
  if (f.until && Date.parse(f.until) <= app.now().getTime()) return end(app, f, 'time');
  if (!mayAlwaysAllow(app).ok) return end(app, f, 'policy');
  return f;
}

export function alwaysAllowOn(app: AlwaysApp | undefined): boolean {
  if (!app?.dataDir) return false;
  try {
    return live(app).on;
  } catch {
    return false;
  }
}

export function alwaysAllowView(app: AlwaysApp): AlwaysView {
  const f = live(app);
  const may = mayAlwaysAllow(app);
  return { on: f.on, since: f.on ? (f.since ?? null) : null, until: f.on ? (f.until ?? null) : null, for: f.for ? alwaysFor(f.for) : '1h', warned: f.warned === true, may: may.ok, why: may.why ?? null, role: roleOf(app), ended: f.ended ?? null };
}

export class AlwaysAllowError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Turn it on (the route has already checked the password/passkey) or off. On needs the one-time
 * warning (`warned`). Re-turning it on with another time limit starts a new stretch.
 */
export function setAlwaysAllow(app: AlwaysApp, o: { on: boolean; for?: unknown; warned?: boolean; channel?: string }): AlwaysView {
  const f = live(app);
  if (!o.on) {
    if (f.on) end(app, f, 'you');
    return alwaysAllowView(app);
  }
  const may = mayAlwaysAllow(app);
  if (!may.ok) throw new AlwaysAllowError(403, may.why ?? en('Not available here.'));
  if (o.warned !== true && f.warned !== true) throw new AlwaysAllowError(400, en('Always allow everything needs the warning first.'));
  const span = alwaysFor(o.for);
  const now = app.now();
  const ms = FOR_MS[span];
  write(app, { on: true, since: now.toISOString(), until: ms ? new Date(now.getTime() + ms).toISOString() : null, for: span, warned: true });
  audit({ action: 'always_allow.on', target: 'always-allow', role: who(app), who: who(app), channel: o.channel ?? 'web', outcome: 'ok', keys: [`for:${span}`] });
  return alwaysAllowView(app);
}

/**
 * What a computer needs to know (it confirms the switch once on its own card): a key for this
 * stretch and how long it lasts. {} when the switch is off.
 */
export function alwaysAllowArgs(app: AlwaysApp | undefined): { allowAll?: string; allowAllMs?: number } {
  if (!app || !alwaysAllowOn(app)) return {};
  const f = read(app);
  const since = Date.parse(f.since ?? '') || 0;
  const left = f.until ? Date.parse(f.until) - app.now().getTime() : DEVICE_MAX_MS;
  return { allowAll: `aa:${app.member?.id ?? 'owner'}:${since.toString(36)}`, allowAllMs: Math.max(60_000, Math.min(DEVICE_MAX_MS, left)) };
}

/** One audit row for an action that ran without a card because the switch is on. */
export function noteAlwaysAllowed(app: AlwaysApp, tool: string, summary: string, channel = 'web'): void {
  try {
    audit({ action: 'approval.always_allow', target: tool, role: who(app), who: who(app), channel, outcome: 'ok', keys: ['always-allow'], content: summary.slice(0, 300) });
  } catch {
    /* the audit trail is best effort here; the timeline still has the row */
  }
}
