# Readiness and recovery

**Settings → Data & health → Readiness and recovery** answers two questions: is this install ready
for real use, and is there interrupted work to review? The page is the owner's only (not the demo,
household members or apps signed in with a device code).

## Readiness: ready, needs attention or not ready

The top of the page has one verdict and one row per area, each with one fix (a button that opens
the right page, runs the drill, checks the model again, or a command to copy). It only reads: the
one outside call is listing the default model provider's models (free, cached for a minute).

| Area | Ready when | Needs attention | Not ready |
|---|---|---|---|
| Backups | a backup on this computer from the last 48 h, automatic backups on | older, or automatic off | no backup |
| Restore drill | a drill passed in the last 30 days | the last pass is older | never ran, or the last failed |
| Off-computer copy, Updates, HTTPS and who can reach her, Sign-in, Policy | the safety check-up row is green (or an amber you accepted) | amber | red |
| Disk space | 5 GB or more free | under 5 GB or unknown | under 1 GB |
| Model | set up and it answered the model list | not checked yet | none set up, or it does not answer |
| Chat apps | every one switched on is connected (none is fine) | one is not connected | — |
| Paused work | nothing interrupted or uncertain | jobs, teams or deliveries wait below | — |
| Monitoring and audit | the audit trail verifies and metrics are on | metrics off (fine for one person) | the trail is missing or broken |

## The restore drill

**Run a restore drill** proves that the newest backup on this computer really restores. Sara:

1. restores it into a throwaway folder inside her own data folder (`tmp/restore-drill-…`), never
   over the live data and never in the system temp folder (the copy holds her keys);
2. checks every database in it (`PRAGMA integrity_check`) and counts chats, messages and memories;
3. opens the vault with the copy's own key (or `SARA_MASTER_KEY`), keeping only the number of entries;
4. starts the copy on this computer only (`127.0.0.1`, a free port) in drill mode: private local mode
   (nothing leaves the computer) and no workers, chat apps, plugins, tool servers or backups. It
   waits for the health answer and checks that the copy asks for sign-in;
5. stops it and deletes the folder.

The result shows the measured time (restore, checks and start) and the data loss: how old the
backup was, which is what a restore now would lose. It is kept on the page, and one row goes into
the audit trail (`readiness.drill`). Only one drill runs at a time. It needs free space for about
twice the backup. The off-computer copy keeps its own weekly test restore (Backups).

## Interrupted work

Open this page after a restart or uncertain send. Recovery never
runs an old command or resends a message by itself. Use an owner sign-in; household members, the
demo and apps signed in with a device code cannot open protected recovery data.

Optional business workspaces were released in 2.64.0 and use a separate encrypted backup/recovery path.
Personal restore refuses business archives before initializing its target. Business restore keeps
access closed pending fresh individual sign-in/passkeys and explicit grant/spending reconciliation;
the personal Recovery page does not perform that work. See [Business workspaces](BUSINESS.md) and
the [business operator handbook](BUSINESS_OPERATIONS.md).

## Background jobs: review a restart

For a supported interrupted or budget-stopped job, **Review restart** shows the original request
and the interruption warning. **Copy** keeps it for review; **Use in chat** places it in the empty
original conversation. It never presses Send. Existing drafts, attachments, edits and running
conversations are preserved; copy the preview if it cannot safely be placed in chat.

A new command starts from the beginning. Previous file changes or external effects may already
exist; check them first. The command's timeout is real, but a generic shell process has no model
token/dollar cap. A delegated agent request proposes a fresh bounded model budget, separate from
old usage. Current tools, safety checks, sandbox/network rules and approvals apply after you Send.
No old credentials, generated agent shell, runtime callbacks or previous approval are reused.

Some older jobs, in-process tasks and protected/corrupt requests cannot produce a review draft.
Their output/status remains evidence; start a new request manually. A recovery preview is historical
data, not trusted instructions. **Continue with more budget** from an older job client refuses
unsafe replay and directs you to review instead.

## Teams and chat goals: explicit continuation

Interrupted teams stay held after startup. Review the unfinished step and its old receipts, then
acknowledge that effects may already have happened before choosing **Resume team**. Completed
steps stay complete. Unfinished work re-enters current policy, limits and fresh workflow checkpoints.
A stopped task remains stopped; current privacy/safety restrictions can refuse recovery. Interrupted
pull-request publication needs manual reconciliation when its previous outcome could be uncertain.

Chat goals already retain their round/check/budget state and come back paused. Their existing
**Resume** action uses the ordinary guarded turn path. Recovery does not grant unattended execution
or bypass crisis, tool or spending holds.

## Native message delivery

Native bridge receipts appear in the server's main companion Recovery view, where its bot connections live. Other companions show their own recovery records; the screen does not silently query another space.

The native Telegram and Discord outbox records message creation: text parts, photos/files/albums,
voice and progress-message creation. **Unresolved** lists held/problems first; **All history** and
**Load more** let you inspect retained records without losing older unresolved work.

| State | What it proves / what to do |
|---|---|
| Queued | Saved before dispatch. After restart it is held, with no automatic resend. |
| Attempted | A send started; its result is not yet durable. |
| Platform acknowledged | A valid platform message id was saved. This does not mean a person read it. |
| Failed | A definite rejection, including exhausted explicit rate-limit refusals. Review the cause before a new request. |
| Outcome unknown | The message may have arrived. Check the destination before sending anything again. |

An explicit rate-limit refusal can retry within existing bounds during the same process. Timeouts,
connection loss, server failures, invalid acknowledgments and acknowledgment-storage failures do
not retry. Uncertain voice/photo delivery does not fall back to duplicate text. Discord's supported
short-window nonce protection supplements this; it is not a permanent exactly-once guarantee.

**Review** shows retained text/caption and attachment metadata where available. It does not retain
file bytes or guarantee an old attachment still exists. Check and attach the file yourself. There is
no direct resend action. A new send goes through the normal authorized chat/bridge flow.

Human resolution records that you checked and marked received, not received or dismissed. It keeps
the original transport state distinct; your confirmation is not a platform acknowledgment. Review
payloads are encrypted in the space's database, bound to its stable recovery identity. They are
removed after acknowledgment or human resolution; unresolved held/unknown payloads remain protected.
Lists expose metadata, not decrypted text or credentials. A missing key or invalid payload refuses
review safely.

## Coverage and backup

Plugin bridges, ephemeral interaction callbacks, edits/deletes, typing/menu requests and arbitrary
shell, browser, SSH, MCP or mail effects are outside the native delivery ledger. Do not read a native
receipt as proof that every external integration is duplicate-safe.

A normal backup includes recovery tables and the encryption key material for every stored space.
Keep backups private: they contain keys. Excluding workspaces now applies to owner, companion,
household member and member-companion workspaces. Restore to an isolated copy first and inspect
held/unknown work before reconnecting services; a restored snapshot cannot know what happened after
that snapshot was taken. See [moving/backup guidance](MOVING.md).

Q3 qualification includes local stand-in transport crash tests and a restored production-entry-point
boot with networking blocked. These fixture measurements are not an enterprise recovery-time or
power-loss durability certificate. Device/account and physical usability acceptance remain separate.

## Archive resolved history

In Recovery, **Archive old deliveries** requires an explicit canonical UTC cutoff, a non-mutating
preview and a confirmed batch of at most 500. Only acknowledged or human-resolved old records with
no review payload qualify. Both transport and human-resolution evidence must predate the cutoff.
Unresolved uncertainty, held/failed records without resolution, live queued work and attempts are
protected. Editing the cutoff invalidates its preview; server eligibility is checked again.

**Archived** shows minimal historical evidence; **All** shows unarchived history. Archive clears
destination/platform-reference/reason details but retains identities, logical keys, original state,
attempts, dates and human decisions. It never retries, deletes rows or shrinks the database.
Deduplication and encrypted unresolved reviews survive backup/restore. No automatic cleanup runs.
For measurements, maintenance and a synthetic incident drill, see [Operations](OPERATIONS.md).

Development qualification also checks full unresolved metadata across repeated backups, and an
encrypted folder-copy restore across owner, companion, member and member-companion spaces.
Encryption failure is refused; a readable review alone is insufficient evidence that its original
unknown state and duplicate protection survived. See Operations for the manual, isolated commands
and their limits. Physical offsite recovery and production recovery targets still need separate proof.
