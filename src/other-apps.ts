// Phase 57: what the OpenAI-compatible API (/v1) and the MCP server (/mcp) share: the API key
// check, the owner's switches (her tools, changes, browser origins), CORS, the per-key rate limit,
// the dedicated conversations other apps talk in, and running one turn for them through the
// normal turn engine (so her character, memory and the whole safety layer apply).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OwnerAuth } from './auth.ts';
import { DEVICE_TOKEN_PREFIX } from './auth.ts';
import type { AppContext, ChatEvent, TurnOptions } from './chat.ts';
import type { CompanionManager } from './companions.ts';
import { minorSexualMatch, MINOR_BLOCK_REPLY } from './safety.ts';
import type { Settings } from './settings.ts';
import { en, trOwner } from './i18n.ts';

/** The name of an API key the owner didn't name (the app shows it in her language). */
export const DEFAULT_APP_NAME = en('Another app');

export interface OtherAppsSettings {
  /** Her own tools in turns from other apps (her normal approval rules still apply). Off by default. */
  tools: boolean;
  /** MCP write tools (add_task, add_note, remember_fact). Off by default. */
  changes: boolean;
  /** Browser apps on other addresses that may call /v1 and /mcp (CORS). None by default. */
  origins: string[];
}

export function otherAppsSettings(s: Settings): OtherAppsSettings {
  const o = s.otherApps ?? {};
  return { tools: o.tools === true, changes: o.changes === true, origins: Array.isArray(o.origins) ? o.origins.filter((x) => typeof x === 'string') : [] };
}

/** Allowed browser origins, checked: http(s)://host[:port] only, up to 10. Throws a plain-words error. */
export function cleanOrigins(v: unknown): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  const out: string[] = [];
  for (const raw of list) {
    const s = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`"${s.slice(0, 80)}" isn't a web address. Use the address the app runs on, like http://localhost:8000.`);
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error(`Use only the start of the address (like http://localhost:8000), not "${s.slice(0, 80)}".`);
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  if (out.length > 10) throw new Error('Up to 10 addresses.');
  return out;
}

/** A small per-key limit: `max` requests a minute (and up to 2 turns at once per key). */
export class KeyLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #running = new Map<string, number>();
  readonly #max: number;
  readonly #parallel: number;
  constructor(max = 60, parallel = 2) {
    this.#max = max;
    this.#parallel = parallel;
  }
  /** Seconds to wait, or 0 when this request may go ahead (it is counted). */
  take(key: string, now = Date.now()): number {
    const list = (this.#hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.#max) return Math.max(1, Math.ceil((list[0] + 60_000 - now) / 1000));
    list.push(now);
    this.#hits.set(key, list);
    if (this.#hits.size > 500) for (const [k, v] of this.#hits) if (!v.some((t) => now - t < 60_000)) this.#hits.delete(k);
    return 0;
  }
  /** A long turn: false when this key already has `parallel` turns running. */
  begin(key: string): boolean {
    const n = this.#running.get(key) ?? 0;
    if (n >= this.#parallel) return false;
    this.#running.set(key, n + 1);
    return true;
  }
  end(key: string): void {
    const n = (this.#running.get(key) ?? 1) - 1;
    if (n <= 0) this.#running.delete(key);
    else this.#running.set(key, n);
  }
}

export interface Caller {
  /** The device id of the API key (or device-code app). */
  id: string;
  label: string;
  kind: 'api' | 'app' | 'home-assistant';
}

/** The API key on a request (Authorization: Bearer sara_dev.…), or undefined. */
export function callerOf(req: IncomingMessage, auth: OwnerAuth): Caller | undefined {
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m || !m[1].startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
  const id = auth.deviceTokenId(m[1]);
  if (!id) return undefined;
  const kind = auth.deviceKind(id) ?? 'app';
  // Phase 87: a hands token is never another app's key (deviceTokenId refuses it already).
  if (kind === 'hands') return undefined;
  // Phase 100: an agent's key (A2A) only works on /a2a, never on /v1 or /mcp.
  if (kind === 'a2a') return undefined;
  return { id, label: auth.deviceLabelOf(id) ?? DEFAULT_APP_NAME, kind };
}

export const CORS_HEADERS = 'authorization, content-type, x-sara-conversation, x-sara-history, x-sara-companion, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id, openai-organization, openai-project, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, x-stainless-timeout';

/**
 * CORS for browser apps on other addresses (off by default). Same-site requests and requests
 * without an Origin (curl, scripts, desktop apps) pass. Returns false when the origin isn't allowed
 * (the caller answers 403); sets the CORS headers when it is.
 */
export function corsAllowed(req: IncomingMessage, res: ServerResponse, s: OtherAppsSettings): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    /* "null" */
  }
  if (host && host === req.headers.host) return true;
  if (!s.origins.includes(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-headers', CORS_HEADERS);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-protocol-version, retry-after');
  res.setHeader('access-control-max-age', '600');
  return true;
}

/** "mia" for Mia, "ana-lucia" for Ana Lucía. */
export function slugOf(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'companion';
}

export interface Who {
  id: string;
  app: AppContext;
}

/** The companions an app can talk to (model names), the routed one first. */
export function companionsOf(app: AppContext, companions?: CompanionManager): Who[] {
  const all = companions?.all().map((c) => ({ id: c.id, app: c.app })) ?? [{ id: app.companionId ?? 'main', app }];
  return all.some((c) => c.app === app) ? all : [{ id: app.companionId ?? 'main', app }, ...all];
}

/** Model ids: 'sara' (the default companion), each companion's name ('mia') and 'sara:<id>'. */
export function modelIds(app: AppContext, companions?: CompanionManager): { id: string; who: Who }[] {
  const list = companionsOf(app, companions);
  const out: { id: string; who: Who }[] = [{ id: 'sara', who: list[0] }];
  const slugs = new Map<string, number>();
  for (const c of list) slugs.set(slugOf(c.app.persona.name), (slugs.get(slugOf(c.app.persona.name)) ?? 0) + 1);
  for (const c of list) {
    const slug = slugOf(c.app.persona.name);
    if (slug !== 'sara' && slugs.get(slug) === 1) out.push({ id: slug, who: c });
    out.push({ id: `sara:${c.id}`, who: c });
  }
  return out;
}

/** Which companion a model name means (undefined = no such model). */
export function companionForModel(model: unknown, app: AppContext, companions?: CompanionManager): Who | undefined {
  const m = String(model ?? '').trim().toLowerCase();
  const ids = modelIds(app, companions);
  if (!m) return ids[0].who;
  const exact = ids.find((x) => x.id === m);
  if (exact) return exact.who;
  // "sara:mia" works too.
  const rest = m.startsWith('sara:') ? m.slice(5) : '';
  return rest ? companionsOf(app, companions).find((c) => slugOf(c.app.persona.name) === rest || c.id === rest) : undefined;
}

/** A conversation key from the app: letters, digits and a few signs, up to 64. */
export function conversationKey(v: unknown): string {
  return String(v ?? '').replace(/[^\p{L}\p{N} ._:@#-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

/**
 * The conversation another app talks in: one per API key and conversation key, on the 'api'
 * channel (OpenAI-compatible) or 'mcp' (ask_sara). Listed with her other conversations, so the
 * owner can read it, approve her actions there, or delete it.
 */
export function appConversation(app: AppContext, channel: 'api' | 'mcp', caller: Caller, key: string): string {
  const k = `${caller.id}:${key || 'default'}`;
  const found = app.store.findChannelConversation(channel, k);
  if (found) return found.id;
  // Phase 61: the app's own words in the title follow the owner's language (made once; the title is hers to rename).
  const s = app.settings.get();
  const label = caller.label === DEFAULT_APP_NAME ? trOwner(DEFAULT_APP_NAME, s) : caller.label;
  const title = channel === 'mcp' ? (key === 'changes' ? trOwner('{app}: changes (MCP)', s, { app: label }) : `${label} (MCP)`) : key && key !== 'default' ? `${label} · ${key}` : label;
  return app.store.createConversation({ title: title.slice(0, 60), channel, channelKey: k }).id;
}

export interface TurnResult {
  text: string;
  /** The AI notice or crisis resources shown before her reply (part of the reply for the app). */
  notices: string[];
  error?: string;
  /** She is waiting for the owner's OK in Sara (the turn goes on there). */
  waiting?: string;
  usage?: { input: number; output: number };
  busy?: boolean;
}

/**
 * Runs one turn for another app (through the server's runTracked: activity, approvals and Stop
 * work as in the web app). `onText` gets her words as they come, held back as soon as they look
 * like they'd fail the minors check (the turn engine then replaces them); `stopOnApproval` ends
 * the wait at the first approval (MCP tools can't sit for minutes).
 */
export async function externalTurn(
  app: AppContext,
  conversationId: string,
  text: string,
  opts: TurnOptions,
  hooks: { onNotice?: (t: string) => void; onText?: (t: string) => void; onApproval?: (summary: string) => void; stopOnApproval?: boolean } = {},
): Promise<TurnResult> {
  if (!app.runTracked) return { text: '', notices: [], error: 'This server can’t run turns for other apps.' };
  const before = app.usage?.forConversation(conversationId);
  // UX 14: what this turn adds to the conversation starts after this message.
  const lastId = app.store.messages(conversationId).at(-1)?.id ?? 0;
  const out: TurnResult = { text: '', notices: [] };
  let held = false;
  let replaced: string | undefined;
  let step = '';
  let earlyResolve: (() => void) | undefined;
  const early = new Promise<void>((r) => (earlyResolve = r));
  const run = app
    .runTracked(conversationId, text, (ev: ChatEvent) => {
      if (ev.type === 'notice' && (ev.kind === 'disclosure' || ev.kind === 'crisis')) {
        out.notices.push(ev.text);
        hooks.onNotice?.(ev.text);
      } else if (ev.type === 'token') {
        step += ev.text;
        out.text += ev.text;
        if (!held && minorSexualMatch(out.text, { fromHer: true }) && out.text.trim() !== MINOR_BLOCK_REPLY) held = true;
        if (!held) hooks.onText?.(ev.text);
      } else if (ev.type === 'replace') {
        replaced = ev.text;
      } else if (ev.type === 'tool_call' || ev.type === 'tool_result') {
        // Her words before a tool step stay; a new step starts.
        step = '';
      } else if (ev.type === 'approval') {
        out.waiting = ev.summary;
        hooks.onApproval?.(ev.summary);
        if (hooks.stopOnApproval) earlyResolve?.();
      } else if (ev.type === 'error') {
        out.error = ev.message;
      }
      // Hardening M3: another app's turn never draws on private, imported or adult-channel conversations.
    }, { ...opts, externalApp: true })
    .catch((err: Error & { status?: number }) => {
      if (err.status === 409) out.busy = true;
      out.error = err.message;
    });
  await Promise.race([run, early]);
  if (replaced !== undefined) {
    // Phase 28 rule: a reply that failed the minors check (or had her own name tag) is replaced.
    out.text = out.text.slice(0, out.text.length - step.length) + replaced;
    if (held || replaced === MINOR_BLOCK_REPLY) hooks.onText?.(held ? replaced : `\n\n${replaced}`);
  } else if (held) {
    out.text = MINOR_BLOCK_REPLY;
    hooks.onText?.(MINOR_BLOCK_REPLY);
  }
  const after = app.usage?.forConversation(conversationId);
  if (before && after && after.calls > before.calls) out.usage = { input: after.input - before.input, output: after.output - before.output };
  // UX 14: a turn that failed before she said anything leaves no trace: the app shows the error (with
  // the AI notice in it) and sends the message again, so her history keeps neither a dangling line
  // nor a notice the app never showed (it is shown again on the next turn). The web app's retry
  // replaces the failed line the same way.
  if (out.error && !out.busy && !out.waiting && !out.text.trim() && !opts.resume) {
    const first = app.store.messages(conversationId).find((m) => m.id > lastId);
    if (first) app.store.deleteMessagesFrom(conversationId, first.id);
  }
  return out;
}

/** Plain text from an OpenAI-style content (a string, or a list of parts with text). */
export function contentText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('\n');
  return '';
}
