// Tool registry, permissions and approvals.
import { randomUUID } from 'node:crypto';
import { policy } from '../policy-profile.ts';
import { BUILTIN_TOOLS } from './builtin.ts';
import type { Permission, Tool } from './types.ts';

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = BUILTIN_TOOLS) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): void {
    this.#tools.set(tool.spec.name, tool);
  }

  remove(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  #unsandboxed = false;
  /**
   * Phase 46: commands run without a sandbox (Windows, or none found). Tools that run commands
   * then ask the owner first by default; an explicit choice in Settings still wins.
   */
  get unsandboxed(): boolean {
    return this.#unsandboxed;
  }
  set unsandboxed(v: boolean) {
    this.#unsandboxed = v;
  }

  /** The permission a tool has when the owner hasn't chosen one. */
  defaultFor(tool: Tool | undefined): Permission {
    if (!tool) return 'never';
    if (tool.runsCommands && this.unsandboxed && tool.defaultPermission === 'auto') return 'ask';
    return tool.defaultPermission;
  }

  /** E7 (A2): a tool server's remembered choice for its tools that have no setting of their own. */
  policyFor?: (name: string) => Permission | undefined;

  /** EC5: the admin's ceiling (src/policy-profile.ts) beats the owner's setting, the server choice and Always allow. */
  permission(name: string, overrides: Record<string, Permission> | undefined): Permission {
    return policy().clamp(name, overrides?.[name] ?? this.policyFor?.(name) ?? this.defaultFor(this.#tools.get(name)), this.get(name));
  }

  /** Tools the model may see (anything not set to "never"). */
  enabled(overrides: Record<string, Permission> | undefined): Tool[] {
    return this.list().filter((t) => (t.isAvailable?.() ?? true) && this.permission(t.spec.name, overrides) !== 'never');
  }
}

interface Pending {
  conversationId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Phase 77: how the owner answered a card that said "This goes against something you decided":
 * Do it anyway ('override'), Don't ('deny') or Update the note ('update'). Plain cards have none.
 * Phase 80: a "Ran in a sandbox" card: Apply to my workspace ('apply'), Discard ('discard') or Run
 * for real ('real'). A plain Allow on that card (bridges, older apps) applies the diff.
 */
/** Phase 86: 'redteam' = "Red-team first" on the ship card (the action does not run; a red-team run starts). */
/** Phase 88: 'task' = "Allow for this task", 'always' = "Always on this site" on a computer-use card (both allow). */
/** E7 (A1): 'tool' = "Always allow this tool" on a plain card (allows; the tool is then Always allowed). */
export type ApprovalHow = 'override' | 'deny' | 'update' | 'apply' | 'discard' | 'real' | 'redteam' | 'task' | 'always' | 'tool';
export const APPROVAL_HOWS: readonly ApprovalHow[] = ['override', 'deny', 'update', 'apply', 'discard', 'real', 'redteam', 'task', 'always', 'tool'];

/** Holds tool calls waiting for the owner's approve/deny click. */
export class ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #how = new Map<string, ApprovalHow>();
  /** Requests that ended unanswered (their turn, task step or call ended, or the wait ran out). */
  readonly #expired = new Map<string, number>();
  /** 3.0.3: the expired requests whose wait ran out (nobody answered in time), not ended by their caller. */
  readonly #timedOut = new Set<string>();
  readonly #timeoutMs: number;
  /** 3.0.3: told when a conversation's waiting approvals change (the sidebar's needs-you dot). */
  readonly #listeners = new Set<(conversationId: string) => void>();

  constructor(timeoutMs = 10 * 60 * 1000) {
    this.#timeoutMs = timeoutMs;
  }

  request(conversationId: string, signal: AbortSignal): { id: string; decision: Promise<boolean> } {
    const id = randomUUID();
    const decision = new Promise<boolean>((resolve) => {
      const done = (v: boolean, ended = false, late = false) => {
        const p = this.#pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        signal.removeEventListener('abort', onAbort);
        if (ended) this.#expire(id);
        if (late) this.#timedOut.add(id);
        this.#changed(conversationId);
        resolve(v);
      };
      // The wait belongs to its caller: when the caller ends, the request ends with it at once.
      const onAbort = () => done(false, true);
      if (signal.aborted) {
        this.#expire(id);
        resolve(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { conversationId, resolve: done, timer: setTimeout(() => done(false, true, true), this.#timeoutMs) });
      this.#changed(conversationId);
    });
    return { id, decision };
  }

  /** 3.0.3: listen for waiting approvals starting or ending (returns the unsubscribe). */
  onChange(fn: (conversationId: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #changed(conversationId: string): void {
    for (const fn of this.#listeners) {
      try {
        fn(conversationId);
      } catch {
        /* a listener never breaks an approval */
      }
    }
  }

  #expire(id: string): void {
    const t = Date.now();
    for (const [k, at] of this.#expired)
      if (t - at > this.#timeoutMs || this.#expired.size > 500) {
        this.#expired.delete(k);
        this.#timedOut.delete(k);
      }
    this.#expired.set(id, t);
  }

  /** 'waiting', 'expired' (its caller ended or the wait ran out; a late answer runs nothing) or 'unknown'. */
  state(id: string): 'waiting' | 'expired' | 'unknown' {
    return this.#pending.has(id) ? 'waiting' : this.#expired.has(id) ? 'expired' : 'unknown';
  }

  /** 3.0.3: true when this request was refused because nobody answered within the wait (not a "no"). */
  timedOut(id: string): boolean {
    return this.#timedOut.has(id);
  }

  decide(id: string, approved: boolean, how?: ApprovalHow): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    // \"Update the note\", \"Don't\" and \"Discard\" never run the call, whatever `approved` says;
    // \"Apply\" and \"Run for real\" are the owner's explicit yes.
    if (how) this.#how.set(id, how);
    // Phase 86: "Red-team first" never runs the call either (a red-team run starts instead).
    p.resolve(how === 'update' || how === 'deny' || how === 'discard' || how === 'redteam' ? false : how === 'apply' || how === 'real' || how === 'task' || how === 'always' || how === 'tool' ? true : approved);
    return true;
  }

  /** Phase 77: the owner's answer on a contradiction card (read once, after the decision). */
  takeHow(id: string): ApprovalHow | undefined {
    const h = this.#how.get(id);
    this.#how.delete(id);
    return h;
  }

  /** 3.0.3: how many approvals wait in each conversation. */
  pendingByConversation(): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of this.#pending.values()) out.set(p.conversationId, (out.get(p.conversationId) ?? 0) + 1);
    return out;
  }

  pendingFor(conversationId: string): string[] {
    return [...this.#pending.entries()].filter(([, p]) => p.conversationId === conversationId).map(([id]) => id);
  }
}
