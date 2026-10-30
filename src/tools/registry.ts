// Tool registry, permissions and approvals.
import { randomUUID } from 'node:crypto';
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

  permission(name: string, overrides: Record<string, Permission> | undefined): Permission {
    return overrides?.[name] ?? this.defaultFor(this.#tools.get(name));
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
export type ApprovalHow = 'override' | 'deny' | 'update' | 'apply' | 'discard' | 'real' | 'redteam' | 'task' | 'always';
export const APPROVAL_HOWS: readonly ApprovalHow[] = ['override', 'deny', 'update', 'apply', 'discard', 'real', 'redteam', 'task', 'always'];

/** Holds tool calls waiting for the owner's approve/deny click. */
export class ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #how = new Map<string, ApprovalHow>();
  readonly #timeoutMs: number;

  constructor(timeoutMs = 10 * 60 * 1000) {
    this.#timeoutMs = timeoutMs;
  }

  request(conversationId: string, signal: AbortSignal): { id: string; decision: Promise<boolean> } {
    const id = randomUUID();
    const decision = new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        const p = this.#pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => done(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { conversationId, resolve: done, timer: setTimeout(() => done(false), this.#timeoutMs) });
    });
    return { id, decision };
  }

  decide(id: string, approved: boolean, how?: ApprovalHow): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    // \"Update the note\", \"Don't\" and \"Discard\" never run the call, whatever `approved` says;
    // \"Apply\" and \"Run for real\" are the owner's explicit yes.
    if (how) this.#how.set(id, how);
    // Phase 86: "Red-team first" never runs the call either (a red-team run starts instead).
    p.resolve(how === 'update' || how === 'deny' || how === 'discard' || how === 'redteam' ? false : how === 'apply' || how === 'real' || how === 'task' || how === 'always' ? true : approved);
    return true;
  }

  /** Phase 77: the owner's answer on a contradiction card (read once, after the decision). */
  takeHow(id: string): ApprovalHow | undefined {
    const h = this.#how.get(id);
    this.#how.delete(id);
    return h;
  }

  pendingFor(conversationId: string): string[] {
    return [...this.#pending.entries()].filter(([, p]) => p.conversationId === conversationId).map(([id]) => id);
  }
}
