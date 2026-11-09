// E7 (A2): one choice for a whole tool server ("Always allow the safe ones"), never past its
// destructive tools. Each MCP tool is safe (read-only, or only makes outputs), destructive
// (installs, downloads, restarts, removes, trains, rents machines, reports, edits nodes) or other.
import { mcpToolName } from './tools/mcp.ts';
import type { Permission } from './tools/types.ts';

export type ServerPolicy = 'ask' | 'safe' | 'all' | 'never';
export const SERVER_POLICIES: readonly ServerPolicy[] = ['ask', 'safe', 'all', 'never'];
export type ToolKind = 'safe' | 'destructive' | 'other';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** Tools known to only make outputs (tested recipes); keyed by the server's name. */
const KNOWN_SAFE: Record<string, readonly string[]> = {
  comfyui: ['visualize_workflow', 'enqueue_workflow', 'generate_image', 'queue', 'get_image', 'get_history', 'batch', 'apps', 'run', 'describe_tool'],
};

/** Never switched on by a server choice (a person sets these one by one, if at all). */
const DESTRUCTIVE: readonly RegExp[] = [
  /^install_/, /^download_/, /^restart_/, /_remove$/, /^remove_/, /^delete_/, /_delete$/, /^uninstall_/,
  /^node_pack$/, /^apply_manifest$/, /^train_/, /^runpod/, /^report_issue$/, /^bisect$/, /^node_snapshot$/,
  /^comfy_cli$/, /^call_tool$/, /^update_/, /^upgrade_/,
];

export function toolKind(server: string, tool: string, annotations?: ToolAnnotations): ToolKind {
  if (annotations?.destructiveHint === true || DESTRUCTIVE.some((re) => re.test(tool))) return 'destructive';
  if (annotations?.readOnlyHint === true) return 'safe';
  if (KNOWN_SAFE[server]?.includes(tool)) return 'safe';
  if (/^(get|list)_/.test(tool) && annotations?.readOnlyHint !== false) return 'safe';
  return 'other';
}

/**
 * The permission a server choice gives one tool. `current` is the tool's own setting now (or
 * undefined). Destructive tools: Ask sets ask, Never sets never; the other choices keep `current`
 * (ask when it has none). Ask = the old default: read-only tools run on their own, the rest ask.
 */
export function policyPermission(policy: ServerPolicy, kind: ToolKind, current: Permission | undefined, readOnly: boolean): Permission {
  if (policy === 'never') return 'never';
  if (kind === 'destructive') return policy === 'ask' ? 'ask' : (current ?? 'ask');
  if (policy === 'ask') return readOnly ? 'auto' : 'ask';
  if (policy === 'all') return 'auto';
  return kind === 'safe' ? 'auto' : 'ask';
}

export interface ServerTool {
  name: string;
  annotations?: ToolAnnotations;
}

/** Which tools a choice covers, for the Settings row (raw tool names). */
export function coverage(server: string, tools: readonly ServerTool[]): { safe: string[]; other: string[]; destructive: string[] } {
  const out = { safe: [] as string[], other: [] as string[], destructive: [] as string[] };
  for (const t of tools) out[toolKind(server, t.name, t.annotations)].push(t.name);
  return out;
}

/** Applies a server choice to the per-tool settings (keyed by full tool name). */
export function applyServerPolicy(perms: Record<string, Permission>, policy: ServerPolicy, server: string, tools: readonly (ServerTool & { key: string })[]): Record<string, Permission> {
  const next = { ...perms };
  for (const t of tools) {
    const ro = t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true;
    next[t.key] = policyPermission(policy, toolKind(server, t.name, t.annotations), perms[t.key], ro);
  }
  return next;
}

/** The tools a running server lists, with their full names. */
export interface McpLike {
  get(name: string): { tools: readonly ServerTool[] } | undefined;
}
export function serverTools(mcp: McpLike | undefined, server: string): (ServerTool & { key: string })[] {
  return (mcp?.get(server)?.tools ?? []).map((t) => ({ name: t.name, annotations: t.annotations, key: mcpToolName(server, t.name) }));
}

/** For ToolRegistry.policyFor: a server's remembered choice for a tool without its own setting. */
export function policyResolver(settings: () => { mcpPolicy?: Record<string, ServerPolicy>; mcpServers?: { name: string }[] }, mcp: McpLike | undefined): (name: string) => Permission | undefined {
  return (name) => {
    if (!name.startsWith('mcp_')) return undefined;
    const s = settings();
    if (!s.mcpPolicy) return undefined;
    for (const [server, policy] of Object.entries(s.mcpPolicy)) {
      if (!SERVER_POLICIES.includes(policy)) continue;
      const t = serverTools(mcp, server).find((x) => x.key === name);
      if (t) return policyPermission(policy, toolKind(server, t.name, t.annotations), undefined, t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true);
    }
    return undefined;
  };
}
