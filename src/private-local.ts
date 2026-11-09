// Phase 67: "Nothing leaves this computer" (private local mode). The switch is server-wide: its
// state lives in <data>/private-local.json, and SARA_PRIVATE_LOCAL can set it from outside:
//   SARA_PRIVATE_LOCAL=1 (or on/true)  on, and it can't be turned off in the app;
//   SARA_PRIVATE_LOCAL=start           on until the owner turns it off (the desktop apps' first-run
//                                      choice "Private: everything on this computer").
// The guarantee itself is in src/net-guard.ts (one choke point for every outgoing request); this
// module keeps the state, says which providers count as "on this computer", and lists what is
// paused while the mode is on.
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import { join } from 'node:path';
import { isLoopbackHost, setPrivateLocal } from './net-guard.ts';
import { SUBSCRIPTION_KINDS, type ProviderConfig } from './providers/types.ts';
import type { Settings } from './settings.ts';
import { isCloudModelName } from './model-names.ts';

const FILE = 'private-local.json';

export interface PrivateLocalState {
  on: boolean;
  /** When it was last turned on (ISO time). */
  since?: string;
  /** Set by SARA_PRIVATE_LOCAL=1: the app can't turn it off. */
  locked: boolean;
}

/** SARA_PRIVATE_LOCAL → 'locked' (always on), 'start' (on until turned off), or undefined. */
export function envMode(v: string | undefined): 'locked' | 'start' | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(s)) return 'locked';
  if (s === 'start') return 'start';
  return undefined;
}

export class PrivateLocalStore {
  readonly #path: string;
  readonly #env: 'locked' | 'start' | undefined;
  #state: { on: boolean; since?: string };

  constructor(dataDir: string, env: string | undefined = process.env.SARA_PRIVATE_LOCAL) {
    this.#path = join(dataDir, FILE);
    this.#env = envMode(env);
    let saved: { on?: unknown; since?: unknown } | undefined;
    if (existsSync(this.#path)) {
      try {
        saved = JSON.parse(readFileSync(this.#path, 'utf8')) as typeof saved;
      } catch {
        saved = undefined; // damaged: fall back to the environment (or off)
      }
    }
    const on = this.#env === 'locked' ? true : saved ? saved.on === true : this.#env === 'start';
    this.#state = { on, ...(on ? { since: typeof saved?.since === 'string' ? saved.since : new Date().toISOString() } : {}) };
    // The first start with SARA_PRIVATE_LOCAL=start remembers the choice, so turning it off sticks.
    if (!saved && this.#env === 'start') this.#save();
    setPrivateLocal(this.#state.on);
  }

  get(): PrivateLocalState {
    return { on: this.#state.on, ...(this.#state.since ? { since: this.#state.since } : {}), locked: this.#env === 'locked' };
  }

  /** Saves and applies the switch. The callers check the rules (a local model, confirmation). */
  set(on: boolean): PrivateLocalState {
    if (this.#env === 'locked' && !on) throw new Error('SARA_PRIVATE_LOCAL=1 is set on this server, so private local mode stays on.');
    this.#state = on ? { on, since: this.#state.on && this.#state.since ? this.#state.since : new Date().toISOString() } : { on: false };
    this.#save();
    setPrivateLocal(on);
    return this.get();
  }

  #save(): void {
    writeFileAtomic(this.#path, JSON.stringify(this.#state, null, 2) + '\n', 0o666);
  }
}


/**
 * May this provider (and model) be used in private local mode? Only API providers whose address is
 * this computer (loopback), never the subscription programs, never an Ollama Cloud model.
 */
export function onThisComputer(config: Pick<ProviderConfig, 'kind' | 'baseUrl'>, model?: string): boolean {
  if (SUBSCRIPTION_KINDS.includes(config.kind) || !outboundAllowedAlways(config.baseUrl)) return false;
  return !(model && isCloudModelName(model));
}

/** Would this address be allowed with the mode on (whatever it is now)? */
export function outboundAllowedAlways(href: string): boolean {
  try {
    const u = new URL(href);
    return ['http:', 'https:'].includes(u.protocol) && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Can a companion with these settings talk in private local mode? Her own model (else the chat
 * job, else the default) must be on this computer, or the private-conversation model must be
 * (src/chat.ts falls back to it). Otherwise she shows as "paused in private local mode".
 */
export function talksHere(s: Settings): boolean {
  const ok = (r?: { providerId?: string; model?: string }) => {
    const p = r?.providerId ? s.providers.find((x) => x.id === r.providerId) : undefined;
    return Boolean(p && onThisComputer(p, r?.model ?? p.defaultModel));
  };
  const primary = s.companionModel ?? s.routes?.chat ?? (s.defaultProviderId ? { providerId: s.defaultProviderId, model: s.defaultModel } : undefined);
  return ok(primary) || ok(s.routes?.private);
}

/** A thing that would reach outside this computer, and whether it is set up right now. */
export interface LeaveItem {
  id: string;
  /** English (translated by the app). */
  label: string;
  /** Names (providers, servers) where it helps. */
  names?: string[];
  /** Set up right now (so it is paused while the mode is on), or false for "if you turn it on". */
  active: boolean;
}

export interface LeaveFacts {
  google?: boolean;
  github?: boolean;
  pushDevices?: number;
  apns?: boolean;
  homeToken?: boolean;
}

/**
 * Everything that would leave this computer, from the settings (and a few facts the server knows),
 * in the order the settings page shows them. All of these are paused in private local mode.
 */
export function whatWouldLeave(s: Settings, facts: LeaveFacts = {}): LeaveItem[] {
  const cloud = s.providers.filter((p) => !onThisComputer(p));
  const voice = s.voice ?? {};
  const cloudVoice = (voice.tts && !['off', 'local'].includes(voice.tts) && !(voice.tts === 'openai' && voice.openai?.baseUrl && outboundAllowedAlways(voice.openai.baseUrl))) || (voice.stt === 'openai' && !(voice.openai?.baseUrl && outboundAllowedAlways(voice.openai.baseUrl)));
  const remoteMcp = (s.mcpServers ?? []).filter((m) => m.enabled && m.transport === 'http' && !(m.url && outboundAllowedAlways(m.url)));
  const homeRemote = Boolean(s.home?.url && facts.homeToken !== false && !outboundAllowedAlways(s.home.url));
  const offsite = s.offsite?.kind === 's3';
  const items: LeaveItem[] = [
    { id: 'cloud-models', label: 'Cloud models and subscriptions', names: cloud.map((p) => p.label), active: cloud.length > 0 },
    { id: 'web', label: 'Web search and web pages', active: Boolean(s.search?.provider) || s.toolPermissions?.web_fetch !== 'never' },
    { id: 'model-lists', label: 'Daily model list checks for cloud providers', active: cloud.length > 0 },
    { id: 'updates', label: 'Checking for updates', active: true },
    { id: 'reports', label: 'Sending a reported reply to the developer (it is still kept here)', active: true },
    { id: 'telegram', label: 'Telegram', active: s.telegram?.enabled === true },
    { id: 'discord', label: 'Discord', active: s.discord?.enabled === true },
    { id: 'google', label: 'Gmail, Outlook and other mailboxes, and their calendars', active: facts.google === true },
    { id: 'github', label: 'GitHub', active: facts.github === true },
    { id: 'push', label: 'Notifications to phones and browsers', active: (facts.pushDevices ?? 0) > 0 || facts.apns === true },
    { id: 'offsite', label: 'Off-server backup copies (S3)', active: offsite },
    { id: 'pictures', label: 'Pictures of her (Grok Imagine)', active: true },
    { id: 'voice', label: 'Cloud voices, hearing and live calls', active: Boolean(cloudVoice) },
    { id: 'weather', label: 'Weather and travel times', active: Boolean(s.briefing?.place) || s.leaveBy?.enabled === true },
    { id: 'mcp', label: 'Other programs (MCP) on other computers', names: remoteMcp.map((m) => m.name), active: remoteMcp.length > 0 },
    { id: 'home', label: 'Home Assistant on another computer', active: homeRemote },
    { id: 'alexa', label: 'Alexa (your own skill; it runs at Amazon)', active: Boolean(s.alexa?.skillId) },
    { id: 'shell', label: 'Internet for her commands (builds, npm install, git push)', active: s.shellNetwork !== false },
  ];
  return items;
}
