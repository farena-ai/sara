// W3.2: what an MCP key may use. A key made with scopes lists and runs only the tools in them;
// a key made before scopes (no list) keeps everything it had. Import-free on purpose (auth.ts,
// mcp-server.ts and the routes all read it).

export const MCP_SCOPES = ['ask', 'memory', 'reminders', 'library', 'planner'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** The /mcp tools in each scope (every tool belongs to exactly one; a test keeps this complete). */
export const SCOPE_TOOLS: Readonly<Record<McpScope, readonly string[]>> = {
  ask: ['ask_sara'],
  memory: ['search_memory', 'list_facts', 'list_recent_conversations', 'remember_fact'],
  reminders: ['list_reminders', 'add_reminder'],
  library: ['search_library'],
  planner: ['get_today', 'list_tasks', 'add_task', 'complete_task', 'update_task', 'delete_task', 'list_notes', 'read_note', 'add_note', 'update_note', 'delete_note'],
};

/**
 * Scopes from a request: undefined = not given (everything, as before scopes); known ones only, in
 * the fixed order, no repeats. An empty list is refused (a key that can do nothing is a mistake).
 */
export function cleanScopes(v: unknown): McpScope[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v.map(String) : String(v).split(/[\s,]+/);
  const out = MCP_SCOPES.filter((s) => list.includes(s));
  if (!out.length) throw new Error('Pick at least one thing this app may use.');
  return out;
}

/** Whether a key with these scopes may list and run a tool (no scopes = an older key: yes). */
export function scopeAllows(scopes: readonly McpScope[] | undefined, tool: string): boolean {
  if (!scopes) return true;
  return scopes.some((s) => SCOPE_TOOLS[s].includes(tool));
}
