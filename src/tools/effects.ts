// fixreceipts (docs/handoffs/2026-11-19-fixreceipts.md): does a tool CHANGE something, or only read?
// One answer for the whole server, worked out from what each tool already says about itself, so the
// claim checker (src/receipts.ts) never needs a hand list that new tools fall out of:
//   1. `changes: true | false` on the tool (its own say; use it when the rules below can't tell);
//   2. add-on tools (`mcp_…`) change things (as before);
//   3. `interruptible` tools and the built-in read-only names (src/pending.ts) only read;
//   4. a tool that asks first changes something (the V5.1 timeline's own rule);
//   5. otherwise the verb in its name: `purchase_add`, `canvas_update`, `upkeep_log` change;
//      `purchases_list`, `health_read`, `trip_status` read (the last word first). Anything else is undecided, and
//      test/fixreceipts.test.ts fails on it until the tool says `changes`.
// ToolRegistry.add notes every tool's effect, so the checker can ask by name (receipts carry names).
import { interruptible } from '../pending.ts';
import type { Tool } from './types.ts';

export type ToolEffect = 'changes' | 'reads';

/** Read-only tools the checker always knew (they never back an action claim). */
export const READ_ONLY = /^(?:read_file|list_dir|search|web_search|web_fetch|gmail_read|gmail_search|gmail_thread|gmail_needs_answer|mail_read|mail_search|mail_thread|mail_needs_answer|mail_accounts|mail_add_account|mail_folders|calendar_events|github_list|github_read|home_status|job_status|browser_read|recall|find|ssh_servers)$/;

/** Name words that change something (any part of the name). */
const CHANGE_WORDS = new Set(
  ('write edit post update add set save make create remove delete forget log mark send start stop pay paid import export record revise fill keep undo done move comment answer ' +
    'assign follow unfollow settle enable disable cancel reply apply click type keys scroll drag select upload open navigate login run commit push branch checkpoint handoff ' +
    'note todo remind change invoice stage share return limit react draft organize call fix finish sign replace append report category tune task outfit route rule')
    .split(/\s+/),
);
/** Name words that only read or look (checked after the change words). */
const READ_WORDS = new Set(
  'list get read search find status look lookup due summary summarize quote scores schedule standings lines stats math history preview devices tabs logs windows files location screen labels senders info folders accounts suggestions pipeline subscriptions balance followed news needs thread now top playlists playing near guide context review checklist calendar map refs deps definition references hover diagnostics agents checkup show'.split(/\s+/),
);

/** By name alone: the verb rule (step 5). */
export function effectByName(name: string): ToolEffect | undefined {
  if (name.startsWith('mcp_')) return 'changes';
  if (READ_ONLY.test(name) || interruptible(name)) return 'reads';
  const words = name.toLowerCase().split(/[_\W]+/).filter(Boolean);
  // The last word first ("invoice_list" reads, "list_share" changes), then any word, change first.
  const last = words.at(-1) ?? '';
  if (CHANGE_WORDS.has(last)) return 'changes';
  if (READ_WORDS.has(last)) return 'reads';
  if (words.some((w) => CHANGE_WORDS.has(w))) return 'changes';
  if (words.some((w) => READ_WORDS.has(w))) return 'reads';
  return undefined;
}

/** A tool's effect from its own metadata (steps 1-5); undefined = it doesn't say and the name can't tell. */
export function toolEffect(tool: Tool): ToolEffect | undefined {
  const name = tool.spec.name;
  if (typeof tool.changes === 'boolean') return tool.changes ? 'changes' : 'reads';
  if (name.startsWith('mcp_')) return 'changes';
  if (READ_ONLY.test(name) || interruptible(name, tool)) return 'reads';
  if (tool.defaultPermission !== 'auto') return 'changes';
  return effectByName(name);
}

const KNOWN = new Map<string, ToolEffect>();

/** ToolRegistry.add: remember what this tool does (the last registration of a name wins). */
export function noteToolEffect(tool: Tool): void {
  const e = toolEffect(tool);
  if (e) KNOWN.set(tool.spec.name, e);
  else KNOWN.delete(tool.spec.name);
}

/** The effect of a tool by name: what its registration said, else the name rule. */
export function effectOf(name: string): ToolEffect | undefined {
  return KNOWN.get(name) ?? effectByName(name);
}

/** True when a successful call of this tool changed something (backs "I did it" claims). */
export function toolChanges(name: string): boolean {
  return effectOf(name) === 'changes';
}
