# Other agents (A2A)

Phase 100 (ST5, 2.33.0; design: [STAPLES.md §8](design/STAPLES.md)). Sara speaks the open
**Agent2Agent protocol, version 1.0** ([specification](https://a2a-protocol.org/latest/specification/),
normative `a2a.proto`), written from the specification with no SDK. She works in two directions:

- **Server.** Other agents ask her things, within what you allow them.
- **Client.** She asks other agents.

Everything is in **Settings → Connections → Other agents**. A2A is off until you switch on
*Let other agents reach her*.

## Sara as a server (other agents ask her)

| | |
|---|---|
| Discovery | `GET /.well-known/agent-card.json`. A thin public card: the name is "Sara" unless you tick *Show her name*, no skills, and a Bearer key is required. It returns 404 while A2A is off, on the demo, and in a household member's space. |
| Extended card | `GetExtendedAgentCard` / `GET /a2a/v1/extendedAgentCard` lists only the skills you offered *that* agent, plus `ask`. |
| JSON-RPC 2.0 | `POST /a2a/v1/rpc`. Methods: `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks` (paging, `historyLength`, `includeArtifacts`), `CancelTask`, `SubscribeToTask` (SSE), `GetExtendedAgentCard`. `Create/Get/List/DeleteTaskPushNotificationConfig` answer `PushNotificationNotSupportedError` (-32003). |
| HTTP+JSON | `/a2a/v1/message:send`, `/message:stream`, `/tasks`, `/tasks/{id}`, `/tasks/{id}:cancel`, `/tasks/{id}:subscribe`, `/extendedAgentCard`. Errors use `google.rpc.Status` with `ErrorInfo.reason` (`TASK_NOT_FOUND`, `VERSION_NOT_SUPPORTED`, …). |
| Version | The `A2A-Version` header must be `1.0`. If it is empty or any other value, she answers `VersionNotSupportedError` (-32009) on both bindings. |
| Auth | `Authorization: Bearer <agent key>` only. An agent key is a device of kind `a2a` (src/auth.ts) with an expiry (180 days by default). It works on `/a2a` only; `/api`, `/v1` and `/mcp` refuse it. A cookie, the owner token, API keys and hands tokens are refused on `/a2a` (401, `-32010`). |
| States | `SUBMITTED → WORKING → COMPLETED` covers the normal path. The other states: `INPUT_REQUIRED` (she asks one clear question back), `AUTH_REQUIRED` (she waits for your OK on an approval card), `REJECTED` (budget, minors block, or you declined), `FAILED` (time or token budget, with the partial answer as artifact *Partial answer*), `CANCELED`. |
| Parts | `text`, `data` (JSON, shown to her as text) and `raw` (base64, at most 2 MB, images/PDF/text only, saved to the conversation's uploads, never executed). A `url` part is **never fetched**: she is told "The agent linked: … (not opened)". At most 8 parts and 64 KB of text per message. |
| Streaming | Yes: the Task first, then status updates and artifact chunks (`append`, `lastChunk`), ending with the final state. |
| Push notifications | No (the card says so). |

**What she does with a request.** Each context becomes one conversation `a2a:<peer>:<contextId>`
on the `a2a` channel, in the built-in **Agents** project. It is titled with who asks and what they
asked first. Her turn runs with an **OutsidePolicy** (src/chat.ts):

- The peer's words are wrapped as `<untrusted source="agent …">` (closing tags in their text are
  removed), and a system note tells her they are data, not instructions.
- She has no inner state, library, agenda, dates or follow-ups. She knows you only by the
  *She answers for* label ("its owner" if empty).
- Memory is `none` by default. *Share notes that aren't private* allows only the facts that other
  apps may see (`sharedWithApps`). Private, partner, imported, adult and group chats never count.
- Tools: only the ones you ticked (*web* = web search/fetch, *todo* = to-dos). Everything that
  changes something shows you an approval card, even if that tool normally runs on its own.
  *Always allowed* never applies.
- The safety layer runs as on every turn: AI disclosure (the first answer in a context starts
  "This is <name>, an AI assistant, answering for <operator>."), crisis resources, and the minors
  block (`REJECTED`). Every message she sends carries `metadata: { ai: true, agent, operator }`.
- These chats never feed her notes, *elsewhere* quotes, `/v1` or MCP.

**Limits per agent** (*What it may do* under ⋯):

| Limit | Default |
|---|---|
| Tasks per day | 200 |
| Tokens per day | 100,000 |
| Dollars per day | $0.50 |
| Requests per minute | 20 |
| Tokens per task | 30,000 |
| Minutes per task | 5 |

When a limit is reached, the agent gets `REJECTED` with the reason. Tasks are counted in
`budget_ledger` under the source `a2a:<peer>`.

## Sara as a client (she asks other agents)

1. **Add an agent she can ask:** paste its address or card URL. She fetches the card through
   src/net-guard.ts (SSRF rules apply; in private local mode only this computer, or your home
   network if you tick *Allow agents on my network*). She checks the required fields and picks its
   1.0 JSON-RPC (or HTTP+JSON) interface. She verifies JWS signatures when the key is in the header
   (ES256 / EdDSA).
2. She shows a **review card**: name, host, provider, where it answers, sign-in, skills, signature
   and warnings. Nothing is stored until you press **Add**. The card's hash is kept; *Check its card
   again* shows a changed card for a new review. A redirect is never followed silently.
3. Paste the agent's key. It goes to the vault as `a2a:<peer id>`, never to a log or the database.

**Her tools:**

| Tool | Approval | What it does |
|---|---|---|
| `a2a_agents` | auto | Lists the agents she can ask |
| `a2a_send(peer, text, data?, skill?, wait?)` | **asks** | The card shows exactly what goes to whom |
| `a2a_status(task)` | auto | Checks a task |
| `a2a_reply(task, text)` | **asks** | Answers the agent when it is `INPUT_REQUIRED` |
| `a2a_cancel(task)` | auto | Cancels a task |

Before anything leaves, she runs two checks on the outgoing text:

- She compares it with your private, partner, imported, adult and group conversations (6-word
  overlap). If it matches, she refuses: "that came from a private conversation".
- She removes secrets from it (src/redact.ts).

Answers come back as untrusted text. **After an agent's answer arrives in a turn, every tool that
changes something asks you for the rest of that turn**, so a peer's words can't run anything you
haven't seen.

She follows a task by streaming when the agent offers it, otherwise by `GetTask` polling with
backoff. A task still open after her turn becomes a **board card** *Waiting on <agent>*. It moves to
Done with the agent's artifacts as receipts. You can also **assign any board card** to an agent
(`peer:<id>` in the assignee pick-list):

- The card's title and notes go to the agent.
- Its question (`INPUT_REQUIRED`) shows up as a *Waiting on you* card that you answer on the board.
- *Stop* cancels the task at the agent.
- Stop in her chat cancels the agent's task too.

## Tables (the owner's sara.db)

| Table | What it holds |
|---|---|
| `a2a_peers` | id, label, direction in/out, device id of the inbound key, card URL / card / hash, companion, policy JSON, status, last seen |
| `a2a_tasks` | id (ours for inbound, the peer's for outbound), peer, direction, context, state, conversation, board card, status message |
| `a2a_artifacts` | task, artifact id, name, parts |
| `budget_ledger` | (shared) per-source daily tokens / dollars / runs |

## Owner routes

`GET/PUT/POST /api/agents`, `POST /api/agents/fetch-card`, `POST /api/agents/:id/key` (rotate an
inbound key, or paste an outbound one), `PUT /api/agents/:id/policy`, `POST /api/agents/:id/recheck`,
`POST /api/agents/:id/card` (accept a changed card), `GET /api/agents/:id/tasks`,
`DELETE /api/agents/:id`.

All of these are owner-only:

- Household members get 403 `ownerOnly`.
- Apps signed in with a device code are refused.
- The demo has none of them.

## Checking a server

`SARA_A2A_URL=http://127.0.0.1:7860 SARA_A2A_KEY=<agent key> node scripts/a2a-conformance.ts` checks
a running server against the shapes the specification requires:

- the card fields
- the JSON-RPC envelope and error codes
- the version header
- a streamed message (every event one of task / message / statusUpdate / artifactUpdate)
- get, list paging, cancel, and subscribe on a terminal task
- the REST error shape

Without a URL and key it skips with the reason.

## Setting it up between two servers

1. On the server that will answer: switch on *Let other agents reach her*. Under *Give an agent a
   key*, name the other agent, tick what it may do, and copy the key.
2. On the server that will ask: under *Add an agent she can ask*, paste the first server's address
   (its card is at `/.well-known/agent-card.json`). Look at the card, paste the key, and press
   **Add**.
3. Ask her in chat ("ask Bob's Sara …"), or assign a board card to the agent. Each message waits
   for your OK.

Your server must be reachable from the other agent, for example over Tailscale or your own HTTPS
address. Plain http is only for this computer or your home network.
