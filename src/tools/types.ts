import type { ToolSpec } from '../providers/types.ts';
import type { SandboxInfo } from './sandbox.ts';

export type Permission = 'auto' | 'ask' | 'never';
export const PERMISSIONS: readonly Permission[] = ['auto', 'ask', 'never'];

export interface ToolContext {
  /** Absolute path of the conversation's workspace directory (created if missing). */
  workspaceDir: string;
  signal: AbortSignal;
  sandbox: SandboxInfo;
  /** Allow web_fetch to reach private/loopback addresses (off by default). */
  allowPrivateNetwork?: boolean;
  /** Conversation the call came from (planner tools deliver reminders there). */
  conversationId?: string;
  /** The companion's name (git commits in the workspace are made under it). */
  companionName?: string;
  /** Attach a stored picture (upload id) to Sara's reply (share_photo / take_photo). */
  attachImage?: (uploadId: string) => void;
  /** Phase 49: a picture the model looks at together with this tool's result (upload id). */
  showModel?: (uploadId: string) => void;
  /** Phase 49: a screenshot for the proof strip on her final message (upload id). */
  attachProof?: (uploadId: string) => void;
  /** Phase 49: whether this turn's model can see pictures. */
  canSee?: boolean;
  /** Phase 49: a short description of a picture from the owner's picture (vision) model, if set. */
  describeImage?: (img: { mime: string; data: string }) => Promise<string | undefined>;
  /** Phase 49: the testing browser may open public web addresses (web tools allowed, not private). */
  webAllowed?: boolean;
  /**
   * Phase 87: this turn's model runs on the owner's own hardware (a local provider, not an Ollama
   * cloud model). Pictures of the owner's screen marked "local models only" (and everything in
   * private local mode) go to the model only when this is true.
   */
  modelLocal?: boolean;
  /** Phase 87: a step thumbnail for the run record (320 px JPEG, already redacted on the device). */
  recordThumb?: (img: { mime: string; data: Buffer }) => void;
  /** Phase 87: the run this call belongs to (sent to the hands with each op). */
  runId?: number;
}

export interface Tool {
  spec: ToolSpec;
  defaultPermission: Permission;
  /** Hidden from the model when this returns false (e.g. not configured). */
  isAvailable?: () => boolean;
  /**
   * Runs commands the model writes (shell, background jobs, coding agents). Without a sandbox these
   * ask the owner before every run unless the owner explicitly chose otherwise (Phase 46).
   */
  runsCommands?: boolean;
  /**
   * Phase 73: calls that ask the owner first even when the tool is set to run on its own (the
   * "ask first" list: e.g. ssh_run with rm -rf, shutdown, a changed firewall).
   */
  asksFirst?: (args: Record<string, unknown>) => boolean;
  /**
   * Count-first tools (gmail_organize): work out what the call would touch before the approval
   * point, e.g. count the matching emails. `summary` replaces the card's line, `detail` adds a
   * structured section to the card, `ask` makes this call ask even when the tool is allowed, and
   * `refuse` ends the call with that text (nothing asked, nothing changed).
   */
  prepare?: (args: Record<string, unknown>, ctx: { signal: AbortSignal; conversationId?: string; replay?: boolean }) => Promise<Prepared>;
  /** Source label for the settings UI, e.g. "built-in" or "MCP: github". */
  source?: string;
  /** Short human-readable description of a call, for the activity log and approval cards. */
  summarize(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** What a count-first tool found before asking (see Tool.prepare). */
export interface Prepared {
  summary?: string;
  detail?: ApprovalDetail;
  ask?: boolean;
  refuse?: string;
  /** Phase 88: a computer-use card (what she would do where; the answers it offers). */
  computer?: ComputerApproval;
  /** Phase 88: told how the owner answered the card ("Allow for this task", "Always on this site"). */
  answered?: (allowed: boolean, how?: string) => void;
}

/** Extra structured content for an approval card (drawn by the web app; every value is plain text). */
export type ApprovalDetail = GmailApproval;

/** Phase 88: a computer-use card: what she wants to do where, and the answers it offers. */
export interface ComputerApproval {
  kind: 'computer';
  /** click / type / select / keys / upload; Phase 90: login (sign in with a saved login, `name` = its name) */
  action: string;
  site: string;
  computer: string;
  /** What she acts on ("button “Place order”"), plain text. */
  target: string;
  /** The target's role and name (the page words it in the app's language). */
  role?: string;
  name?: string;
  /** The text she would type (secrets never; cut to 200 characters). */
  text?: string;
  /** Payments and account settings ask every time (no "for this task", no "always"); so does a saved login (Phase 90). */
  risk: 'normal' | 'send' | 'payment' | 'account' | 'login';
  why: string;
  /** The answers on this card besides Don't: once, task, always. */
  choices: ('once' | 'task' | 'always')[];
}

export type GmailApproval = {
  kind: 'gmail';
  action: string;
  count: number;
  /** The count stopped at the cap: there are at least this many. */
  capped: boolean;
  cap: number;
  query: string;
  /** What the date words were read as (e.g. "up to the end of Oct 1, 2026"). */
  dates?: string;
  label?: string;
  samples: { from: string; subject: string; date?: string }[];
  /** It will run as a background task (progress above the chat, can be stopped). */
  background: boolean;
  /** Trash and spam ask every time. */
  alwaysAsks: boolean;
  /** For an undo: what it reverses. */
  undoOf?: string;
};

/** An error whose message is shown to the model as the tool result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`Missing required argument "${key}".`);
    return '';
  }
  if (typeof v !== 'string') throw new ToolError(`Argument "${key}" must be a string.`);
  return v;
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number.`);
  return n;
}

/** Keeps the head and tail of long output so both the start and the end (errors) survive. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(-half)}`;
}
