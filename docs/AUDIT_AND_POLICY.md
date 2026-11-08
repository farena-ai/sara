# Audit trail and policy (admin guide)

For the person who runs a Sara server for a household or a small team: the owner is the admin.
Design and limits: [ops/EC45_DESIGN.md](ops/EC45_DESIGN.md).

## The audit trail

**Settings → Household → Audit trail** (owner only, in the web app).

- One row per sensitive change, sign-in, decided approval card and background run, for you, every
  companion and every household member: when, who (you, a household member, an app with a device
  code, Sara herself), what (`settings.change`, `tools.change`, `login.do`, `approval.decided`,
  `policy.change`, `run.job`…), the target (a tool, a provider id), where (web, phone app, desktop app,
  Telegram, Discord…), the outcome (done, refused, failed, waiting) and the policy revision in force.
- Rows hold **field names, never values**: "settings.change: ownerName", never the name itself. No
  keys, tokens, passwords or chat text. The only free text is an approval card's short summary, with
  secrets hidden, and it is shown and exported only when you tick **Include message content**.
- **Filters:** who, what, where, outcome, from and to.
- **Check the chain:** every row is linked to the one before with SHA-256, and the newest link is
  kept apart. An edited, removed or reordered row, or newest rows cut off, shows the first bad row.
- **Export JSONL / Export CSV:** a ZIP with the matching rows and `manifest.json` (row count, first and
  last row, SHA-256 of the data file, the chain head, whether the chain checked out, and an HMAC-SHA256
  signature made with a key kept in this server's encrypted vault). Exporting is itself a row.
- **Keep the audit trail** for 30 days, 90 days, a year (default) or until you change it. A row
  still waiting (an unsettled delivery) and everything after it are never deleted.

The file is `<data>/audit/trail.jsonl` (plus `head.json`, `settings.json`); backups include it.
Apps signed in with a device code and household members cannot read it.

## The policy

**Settings → Household → Policy** (owner only, in the web app). Pins apply to you, every
companion and every household member. They only make things stricter:

| Pin | Effect |
| --- | --- |
| Allowed model providers | Other kinds can't be added, picked as a default or route, or used (chat, jobs, chat apps, the API). |
| Commands / Tool servers (MCP) | The most those tools may do: *Always ask* or *Never allow* (hidden from her). Beats your own setting, a tool server's "Everything" choice and *Always allow this tool*. Single tools can be pinned in the JSON file. |
| Turn off Always allow | No *Always allow this tool* on approval cards; computer use can't be *Always allowed*. |
| Keep adult mode off | Turns it off everywhere now; it can't be turned on. |
| No internet for her commands | Shell commands run without network. |
| Keep private local mode on | *Nothing leaves this computer* can't be turned off (if it is off now, the safety check-up says so). |
| Sara Store | *Signed Store items only* (no community items) or *No installs*. |
| Audit trail retention | Fixes how long the trail is kept. |
| Turn off shared links | No one can share a conversation as a link, and existing links stop opening while it is on. See [SHARING.md](SHARING.md). |
| Program installs | *Ask first* (Sara always shows the commands and waits) or *Off* (Sara never installs programs add-ons need). See [PREREQUISITES.md](PREREQUISITES.md). |
| Require the container sandbox | Commands and add-on jobs run only in a container (Podman or Docker); without a working one they are refused. JSON: `"containerSandbox": true`. See [SANDBOX_AND_EGRESS.md](SANDBOX_AND_EGRESS.md). |
| Only these sites for sandboxed work | Sandboxed work with internet reaches only the listed sites (empty: none). JSON: `"egressAllowlist": ["registry.npmjs.org"]`. Refusals are `egress.refused` rows. |
| Crews | *Off*: no crews can be made, run, scheduled or started by mail. See [CREWS.md](CREWS.md). |
| Overnight memory tidy | *Models on this computer only* or *Off*. See [MEMORY_TIDY.md](MEMORY_TIDY.md). |

A pinned setting shows **Set by your admin** in Settings. The server refuses a change with
"Set by your admin (*policy name*). Change the policy first." (HTTP 409, `policy.key` names the pin),
whoever asks, you included: change the policy first. Every policy change and import is one audit row
(`policy.change` / `policy.import`) listing the pins that changed and the new revision.

**Export JSON / Import JSON** copy a policy to another server (`sara-policy.json`; importing
replaces every pin). Unknown fields and loosening values are refused. The safety check-up has a
**Your admin's policy** row that lists settings left looser than a pin from before it was set.

The file is `<data>/policy.json`. A damaged file is read as the strictest policy until it is fixed.
Without a policy nothing changes: a personal install works exactly as before.

## Business instances

The business profile keeps its own operator-pinned model policy and metadata audit
([BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md)); this page is about personal and household servers.
