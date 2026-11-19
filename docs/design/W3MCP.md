# W3.2 MCP everywhere (one page)

## What already existed (extended, not duplicated)
- **MCP client** (`src/tools/mcp.ts`, `McpManager`): stdio/HTTP servers, sandbox (bubblewrap/seatbelt/tools
  user), granted folders (`folders`, Q-ADDONS), egress allowlist, private-local no-network, MCP Apps (C3),
  two presets (email, calendar), per-server policy (E7) and per-tool permissions (Tools and approvals).
- **Settings → Skills & tools → Other programs (MCP)** (`ab-mcp`): custom add/edit, Store recipes, discovery.
- **Sara as an MCP server** (`src/mcp-server.ts`, Phase 57): streamable HTTP at `/mcp` (dual-era), the
  stdio bridge `clients/mcp/sara-mcp.ts`, API keys (`kind: 'api'`) made in Settings → Other apps (`co-apps`)
  with snippets for Claude Code / Claude Desktop / Cursor, write tools behind "Let other apps change things"
  and her approval cards.

## What W3.2 adds
1. **Catalog of popular free MCP servers** (`src/mcp-catalog.ts`, data only): filesystem, git, fetch,
   sqlite, time, memory, sequential thinking, Playwright browser, GitHub (remote, the person's own token).
   Each entry: pinned package, source repo, license, runner (npx / uvx / remote), whether it needs a
   folder or a file, whether it needs the internet, and plain "what it can touch" lines.
   - `GET /api/mcp/catalog` lists them (+ installed, runner found on this computer).
   - `POST /api/mcp/catalog/:id` without `confirm` returns the **approval card** (exact command, folder,
     internet on/off, what it can do, source, license); with `confirm: true` installs it through the
     normal `mcpServers` path (vault secrets, sandbox, `McpManager.start`).
   - **Sandbox**: `folders` = only the chosen folder (files elsewhere are not mounted under bubblewrap/
     seatbelt); new `McpServerConfig.network: false` = no network (the private-local env + `--unshare-net`
     / seatbelt no-net), set for every entry that doesn't need it.
   - **Per-tool permissions** after install: each installed catalog card lists its tools with
     Allow / Ask / Off (the existing `PUT /api/tools {permissions}`).
2. **Scoped MCP keys**: an API key can carry scopes `ask`, `memory`, `reminders`, `library`, `planner`
   (`src/mcp-scopes.ts`); `/mcp` lists and runs only tools in the key's scopes (old keys = all, unchanged).
   New tools `list_reminders` / `add_reminder` (reminders scope; add follows her `remind` approval rule).
   Create with scope boxes and revoke in Settings → Other apps; each key shows its scopes.
   **Kids never** (`/mcp` and `/v1` answer 403 in a child's space, and a child can't make a key);
   household members already have their own space, auth and keys, so they only reach their own data.

## Non-goals
No new route group (catalog rides `/api/mcp`, keys ride `/api/devices/api-key` + `/api/other-apps`), no new
Settings page (a section on `ab-mcp`), no publishing, no sign-ups.
