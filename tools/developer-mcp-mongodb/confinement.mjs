// Fixture-only settings for the exact audited upstream inventory; not a Store recipe.
export function fixtureControls(names) {
  const allowed = ['collection-schema', 'explain', 'find'];
  if (!Array.isArray(names) || new Set(names).size !== names.length || allowed.some(n => !names.includes(n)) || names.some(n => typeof n !== 'string' || !/^[a-z][a-z0-9-]+$/.test(n))) throw new Error('Invalid upstream tool inventory');
  const disabled = [...new Set(['connect','create','update','delete','atlas','atlas-local','assistant', ...names.filter(n => !allowed.includes(n))])].sort();
  return {allowed, disabled, env: {
    MDB_MCP_DISABLED_TOOLS: disabled.join(','), MDB_MCP_READ_ONLY: 'true',
    MDB_MCP_DISABLE_SERVER_SIDE_JS: 'true', MDB_MCP_TELEMETRY: 'disabled',
    MDB_MCP_MAX_DOCUMENTS_PER_QUERY: '5', MDB_MCP_MAX_BYTES_PER_QUERY: '8192',
    MDB_MCP_TIMEOUT_MS: '5000', MDB_MCP_QUERY_COUNT_TIMEOUT_MS: '1000',
    MDB_MCP_LOGGERS: 'stderr', MDB_MCP_MCP_CLIENT_LOG_LEVEL: 'emergency',
    MDB_MCP_ALLOW_REQUEST_OVERRIDES: 'false', MDB_MCP_TRANSPORT: 'stdio',
  }};
}
