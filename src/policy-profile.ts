// EC5 (docs/ops/EC45_DESIGN.md): policy profiles. The owner (the admin of a household or a
// business-run instance) pins settings in one file, `<data>/policy.json`. Pins only tighten. They
// are enforced on the server (the routes, provider resolution and the tool permission resolver);
// Settings only shows them as "Set by your admin". Every change is one audit row (EC4).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit, RETENTION_CHOICES } from './audit-trail.ts';
import { EgressError, parseAllowlist, type EgressInput } from './egress.ts';
import { writeFileAtomic } from './fs-util.ts';
import { HttpError } from './http.ts';
import type { ProviderKind } from './providers/types.ts';
import type { Permission, Tool } from './tools/types.ts';

export type Ceiling = 'ask' | 'never';
export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-compatible', 'anthropic', 'chatgpt', 'claude-code', 'grok-cli'];
export interface PolicyPins {
  /** Provider kinds that may be used (missing = any). */
  providers?: ProviderKind[];
  /** The most a tool may be allowed: per tool name, `group:commands` or `group:mcp`. */
  tools?: Record<string, Ceiling>;
  /** false: no "Always allow this tool", no "Always allowed" computer use. */
  alwaysAllow?: false;
  adultMode?: false;
  /** false: her commands never get internet access. */
  shellNetwork?: false;
  /** true: private local mode stays on (nothing leaves this computer). */
  privateLocal?: true;
  /** off: no Store installs; official: signed Store shelf only (no community items). */
  store?: 'off' | 'official';
  auditRetentionDays?: (typeof RETENTION_CHOICES)[number];
  /** PRQ: installing programs add-ons need (Settings → Add-ons): ask first, or off. */
  programInstalls?: 'ask' | 'off';
  /** EC8: commands and plugin jobs only in a container (refused when no engine works). */
  containerSandbox?: true;
  /** EC9: sandboxed work reaches only these hosts (an empty list: none). */
  egressAllowlist?: EgressInput[];
  /** EC11: false = no shared conversation links (new ones refused, existing ones stop answering). */
  sharing?: false;
  /** EC12: off: no crews are made, run, scheduled or started by mail. */
  crews?: 'off';
  /** EC13: local: the overnight memory tidy uses only models on this computer; off: no tidy. */
  memoryTidy?: 'local' | 'off';
  /** EC10: server keys (providers, bridges, sign-in, voice…) only as references to external sources. */
  externalSecrets?: true;
  /** EC14: false = no editors (ACP): new editor sessions and editor-linked turns are refused. */
  editors?: false;
  /** EC17: true = the whole-server legal hold stays on (no delete path runs, retention waits). */
  legalHold?: true;
  /** EC17: false = no per-person delete from Retention and legal hold. */
  personDelete?: false;
  /** EC21: false = no code mode (run_code) for anyone on this server. */
  codeMode?: false;
}
export type PinKey = keyof PolicyPins;
export const PIN_KEYS: readonly PinKey[] = ['providers', 'tools', 'alwaysAllow', 'adultMode', 'shellNetwork', 'privateLocal', 'store', 'auditRetentionDays', 'programInstalls', 'containerSandbox', 'egressAllowlist', 'sharing', 'crews', 'memoryTidy', 'externalSecrets', 'editors', 'legalHold', 'personDelete', 'codeMode'];
export interface Policy {
  version: 1;
  name: string;
  rev: number;
  updatedAt: string | null;
  pins: PolicyPins;
}

const TOOL_KEY = /^(group:commands|group:mcp|[a-z][\w-]{0,99})$/;

/** Exact check of a policy (as sent or imported): unknown keys and loosening values are refused. */
export function validatePolicy(input: unknown): { name: string; pins: PolicyPins } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'A policy must be a JSON object.');
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['version', 'name', 'rev', 'updatedAt', 'pins', 'kind'].includes(k)) throw new HttpError(400, 'Unknown policy field {key}.', { params: { key: k } });
  if (o.version !== undefined && o.version !== 1) throw new HttpError(400, 'This policy file is from a newer Sara.');
  const name = String(o.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Policy';
  const p = (o.pins ?? {}) as Record<string, unknown>;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'pins must be an object.');
  const pins: PolicyPins = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    switch (k) {
      case 'providers':
        if (!Array.isArray(v) || !v.length || v.some((x) => !PROVIDER_KINDS.includes(x as ProviderKind))) throw new HttpError(400, 'providers must list at least one provider kind.');
        pins.providers = [...new Set(v as ProviderKind[])];
        break;
      case 'tools': {
        if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'tools must map tool names to ask or never.');
        const t: Record<string, Ceiling> = {};
        for (const [name, c] of Object.entries(v as Record<string, unknown>)) {
          if (!TOOL_KEY.test(name) || (c !== 'ask' && c !== 'never')) throw new HttpError(400, 'tools must map tool names to ask or never.');
          t[name] = c;
        }
        if (Object.keys(t).length) pins.tools = t;
        break;
      }
      case 'alwaysAllow':
      case 'adultMode':
      case 'shellNetwork':
      case 'sharing':
      case 'editors':
      case 'personDelete':
      case 'codeMode':
        if (v !== false) throw new HttpError(400, '{key} can only be pinned off.', { params: { key: k } });
        pins[k] = false;
        break;
      case 'privateLocal':
      case 'legalHold':
        if (v !== true) throw new HttpError(400, '{key} can only be pinned on.', { params: { key: k } });
        pins[k] = true;
        break;
      case 'store':
        if (v !== 'off' && v !== 'official') throw new HttpError(400, 'store must be off or official.');
        pins.store = v;
        break;
      case 'programInstalls':
        if (v !== 'ask' && v !== 'off') throw new HttpError(400, 'programInstalls must be ask or off.');
        pins.programInstalls = v;
        break;
      case 'containerSandbox':
        if (v !== true) throw new HttpError(400, '{key} can only be pinned on.', { params: { key: k } });
        pins.containerSandbox = true;
        break;
      case 'externalSecrets':
        if (v !== true) throw new HttpError(400, '{key} can only be pinned on.', { params: { key: k } });
        pins.externalSecrets = true;
        break;
      case 'egressAllowlist':
        try {
          parseAllowlist(v);
        } catch (err) {
          if (err instanceof EgressError) throw new HttpError(400, err.message);
          throw err;
        }
        pins.egressAllowlist = (v as EgressInput[]).map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : { host: x.host.trim().toLowerCase(), ...(x.key ? { key: x.key } : {}) }));
        break;
      case 'crews':
        if (v !== 'off') throw new HttpError(400, '{key} can only be pinned off.', { params: { key: k } });
        pins.crews = 'off';
        break;
      case 'memoryTidy':
        if (v !== 'local' && v !== 'off') throw new HttpError(400, 'memoryTidy must be local or off.');
        pins.memoryTidy = v;
        break;
      case 'auditRetentionDays':
        if (!(RETENTION_CHOICES as readonly unknown[]).includes(v)) throw new HttpError(400, 'Pick 30, 90 or 365 days, or keep everything.');
        pins.auditRetentionDays = v as PolicyPins['auditRetentionDays'];
        break;
      default:
        throw new HttpError(400, 'Unknown policy field {key}.', { params: { key: k } });
    }
  }
  return { name, pins };
}

const RANK: Record<Permission, number> = { auto: 0, ask: 1, never: 2 };
const EMPTY: Policy = Object.freeze({ version: 1, name: '', rev: 0, updatedAt: null, pins: Object.freeze({}) }) as Policy;

export class PolicyStore {
  readonly #file: string | undefined;
  #cur: Policy;
  /** main.ts: bring every companion's and member's settings in line after a change. */
  onApply?: (p: Policy) => void;

  constructor(dataDir?: string) {
    this.#file = dataDir ? join(dataDir, 'policy.json') : undefined;
    this.#cur = EMPTY;
    if (this.#file && existsSync(this.#file)) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8'));
        const v = validatePolicy(raw);
        this.#cur = { version: 1, name: v.name, rev: Number(raw.rev) || 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, pins: v.pins };
      } catch (err) {
        // A damaged policy must not quietly open everything: keep the strictest reading.
        console.warn(`policy: ${(err as Error).message}; every pin is on until it is fixed.`);
        this.#cur = { version: 1, name: 'Damaged policy', rev: 1, updatedAt: null, pins: { alwaysAllow: false, adultMode: false, shellNetwork: false, store: 'off', tools: { 'group:commands': 'ask', 'group:mcp': 'ask' } } };
      }
    }
  }

  get(): Policy {
    return this.#cur;
  }
  get pins(): PolicyPins {
    return this.#cur.pins;
  }
  pinned(key: PinKey): boolean {
    return this.#cur.pins[key] !== undefined;
  }

  /** Saves a new policy (the admin's change or an import): one audit row with the pins that changed. */
  set(input: unknown, by: { who?: string; channel?: string; how?: 'change' | 'import' } = {}): Policy {
    const v = validatePolicy(input);
    if (!this.#file) throw new HttpError(404, 'Not available');
    const before = this.#cur.pins as Record<string, unknown>;
    const after = v.pins as Record<string, unknown>;
    const changed = PIN_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const next: Policy = { version: 1, name: v.name, rev: this.#cur.rev + 1, updatedAt: new Date().toISOString(), pins: v.pins };
    writeFileAtomic(this.#file, JSON.stringify(next, null, 2) + '\n');
    this.#cur = next;
    audit({ action: by.how === 'import' ? 'policy.import' : 'policy.change', target: `rev${next.rev}`, who: by.who ?? 'owner', role: 'owner', channel: by.channel ?? 'web', keys: changed });
    try {
      this.onApply?.(next);
    } catch (err) {
      console.warn(`policy: ${(err as Error).message}`);
    }
    return next;
  }

  /** The policy as a file to keep or import elsewhere. */
  exportFile(): Record<string, unknown> {
    const { name, rev, updatedAt, pins } = this.#cur;
    return { kind: 'sara-policy', version: 1, name, rev, updatedAt, pins };
  }

  /** The refusal every route gives for a pinned value (409, names the policy). */
  refusal(key: PinKey): HttpError {
    const name = this.#cur.name || 'Policy';
    return new HttpError(409, 'Set by your admin ({policy}). Change the policy first.', { params: { policy: name }, policy: { name, rev: this.#cur.rev, key } });
  }
  /** Throws the refusal when `loosens` is true and the key is pinned. */
  guard(key: PinKey, loosens: boolean): void {
    if (loosens && this.pinned(key)) throw this.refusal(key);
  }

  /** The strictest ceiling that applies to a tool (its own name, its group), if any. */
  ceiling(name: string, tool?: Pick<Tool, 'runsCommands'>): Ceiling | undefined {
    const t = this.#cur.pins.tools;
    if (!t) return undefined;
    const all = [t[name], tool?.runsCommands ? t['group:commands'] : undefined, name.startsWith('mcp_') ? t['group:mcp'] : undefined].filter(Boolean) as Ceiling[];
    return all.sort((a, b) => RANK[b] - RANK[a])[0];
  }
  /** A permission held to its ceiling: the ceiling beats the owner's setting and Always allow. */
  clamp(name: string, p: Permission, tool?: Pick<Tool, 'runsCommands'>): Permission {
    const c = this.ceiling(name, tool);
    return c && RANK[c] > RANK[p] ? c : p;
  }
  providerAllowed(kind: string): boolean {
    const allowed = this.#cur.pins.providers;
    return !allowed || allowed.includes(kind as ProviderKind);
  }
  checkProvider(p: { kind: string; label?: string }): void {
    if (!this.providerAllowed(p.kind)) throw this.refusal('providers');
  }
  /** EC11: shared conversation links are allowed (no `sharing: false` pin). */
  get sharingOn(): boolean {
    return this.#cur.pins.sharing !== false;
  }
  /** EC14: editors (ACP) may link turns to their files and terminal (no `editors: false` pin). */
  get editorsOn(): boolean {
    return this.#cur.pins.editors !== false;
  }
  /** EC21: code mode may be used (no `codeMode: false` pin). */
  get codeModeOn(): boolean {
    return this.#cur.pins.codeMode !== false;
  }
  get alwaysAllowOn(): boolean {
    return this.#cur.pins.alwaysAllow !== false;
  }

  /** Settings looser than a pin (for the safety check-up): pin keys with what drifted. */
  drift(s: { providers?: { id: string; kind: string }[]; toolPermissions?: Record<string, Permission>; adultMode?: { on?: boolean }; shellNetwork?: boolean; store?: { on?: boolean; community?: boolean }; isolation?: { backend?: string }; egress?: { mode?: string } }, o: { privateLocal?: boolean; tool?: (name: string) => Pick<Tool, 'runsCommands'> | undefined; sandboxMode?: string } = {}): { key: PinKey; items: string[] }[] {
    const p = this.#cur.pins;
    const out: { key: PinKey; items: string[] }[] = [];
    const add = (key: PinKey, items: string[]) => void (items.length && out.push({ key, items }));
    if (p.providers) add('providers', (s.providers ?? []).filter((x) => !this.providerAllowed(x.kind)).map((x) => x.id));
    if (p.tools) add('tools', Object.entries(s.toolPermissions ?? {}).filter(([n, v]) => this.clamp(n, v, o.tool?.(n)) !== v).map(([n]) => n));
    if (p.adultMode === false && s.adultMode?.on) add('adultMode', ['on']);
    if (p.shellNetwork === false && s.shellNetwork !== false) add('shellNetwork', ['on']);
    if (p.privateLocal && o.privateLocal === false) add('privateLocal', ['off']);
    // EC8/EC9: the pin is enforced anyway; drift says the owner's own choice (or this computer) differs.
    if (p.containerSandbox && (s.isolation?.backend !== 'container' || (o.sandboxMode && o.sandboxMode !== 'container'))) add('containerSandbox', [o.sandboxMode && o.sandboxMode !== 'container' ? 'no-engine' : 'backend']);
    if (p.egressAllowlist && s.egress?.mode !== 'allowlist') add('egressAllowlist', ['open']);
    return out;
  }
}

// ---- the server's one policy (set by main.ts; tests set their own). Unset = no pins. ----
let current = new PolicyStore();
export function setPolicy(p: PolicyStore): void {
  current = p;
}
export function policy(): PolicyStore {
  return current;
}
