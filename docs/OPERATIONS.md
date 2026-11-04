# Operating Sara

Open **Settings → Data & health → Operations** with an owner sign-in. Press **Refresh operations**
to see current evidence. Household members, the demo and device-code app credentials cannot read
protected measurements. This page does not call a model, send a bot message or perform a restore.

## What the numbers mean

| Evidence | Meaning and limit |
|---|---|
| Public `/api/health` | The HTTP process answered `{ok:true}`. It does not prove inference, storage or delivery. |
| Database | A read-only SQLite query worked. This is not an integrity scan or a restore test. |
| Storage | Available space could be measured; below 1 GB is a warning. Unsupported probes remain unavailable. |
| Model | Provider and default model are configured. This does not prove a successful reply. |
| Native bridges | Enabled Telegram/Discord adapters report running. This does not prove message delivery. |
| Backup | A local backup exists in the server-data backup area. A file is not proven service recovery. |
| Offsite restore | Last recorded offsite test result/time, if configured. An old record does not prove current recoverability. |
| Queues | Current-space counts by fixed states for pending inputs, jobs, teams and native deliveries. Other private spaces are not enumerated. |
| Database bytes | SQLite page count times page size; does not include WAL, attachment or backup bytes. |
| Memory / event-loop delay | Shared Node process measurements; other companions/household servers in that process may contribute. |

HTTP totals/error classes and peak in-flight count cover this HTTP server since its start. Response
p50/p95/max use the most recent 512 completed or aborted responses. An operation's own request may
still be in-flight when its snapshot is taken. Long-lived event streams count on finish/abort;
WebSocket upgrades are excluded. HTTP duration is full-response duration, **not model first-token
latency**. Process event-loop delay uses a separate histogram since this monitor started.
A restart resets these in-memory measurements. Existing Health history and run receipts remain
available; no remote telemetry service or new scheduled check is installed.

Every normal HTTP response gets a freshly generated **X-Request-Id**. A matching structured log
entry contains only that UUID, fixed route family, status and duration; raw URL/query/body/headers
and conversation/user identifiers are absent. Incoming request IDs are not trusted. Existing run
receipts have their own run IDs; this does not claim end-to-end distributed request/run tracing.
Logs use the existing rotation/redaction policy. Avoid posting whole owner logs publicly.

## Keeping delivery history manageable

Use **Recovery → Archive old deliveries**. Enter an explicit UTC cutoff in the shown format,
preview the eligible count, then confirm a batch. Each batch handles at most 500 records; repeat
with the same cutoff if more remain. Editing the cutoff requires a new preview. There is no
background archive and no destructive default date.

Only acknowledged or human-resolved records with old transport and resolution timestamps and no
review payload are eligible. Unresolved held/failed/uncertain records, in-flight attempts and live
queued work stay visible. Archive compacts destination, platform-reference and reason details;
it preserves logical identity, deduplication keys, original transport state and human evidence.
The **Archived** filter retrieves these minimal records. Normal **All** excludes archived records.

This is metadata archival, **not deletion or database shrinking**. SQLite rows and logical keys
remain to prevent repeated effects. Backups retain them. There is no automatic expiration,
VACUUM, promise of constant storage size or exactly-once delivery. See [Recovery](RECOVERY.md).

## Repeatable local qualification

Use a source checkout with Node 24+ and development dependencies already installed:

```sh
npm run check
node scripts/qualify-operations.ts --output outputs/qualification/operations.json
```

The v2 live-window workload command creates its own temporary synthetic server and data. It accepts an output
file only; it cannot target your installed server or owner data. It runs eight clients/400 metadata
requests, 10,000 terminal delivery records plus 100 unresolved controls, an 8 MiB resumable upload and
a real backup during read load. It restores that backup separately and checks integrity and held
records. It does not complete document extraction, invoke a model or send an external message.
Fixture data is retained in OS temporary storage for failure inspection; the report has no tokens
or data path. Normal repository tests clean their own separate test fixtures.

The report separates fixture preparation and offline restore time from the live upload/read/backup/archive
window. Its monitor starts after seeding and is sampled before offline restore, without idle padding.
The original v1 candidate failed Linux delay gates and was never published; thresholds are unchanged.
The report includes OS/Node/CPU-count/memory, profile/sample counts, latency percentiles, unexpected
errors, process memory high-water growth, event-loop delay, queue counts and backup/upload/archive
timings. Gates: zero unexpected errors; metadata p95<=500ms; loop-delay p95<=100ms; RSS growth<=256MiB;
all 10,000 terminal records archived; all 100 unresolved reviews preserved; verified backup/upload;
zero provider calls. Missing evidence fails qualification. These are **synthetic engineering
regression gates**, not supported user capacity, model throughput, SLA or production RTO/RPO.
Results vary by machine and competing work; retain failures and investigate before release.

The locally invoked browser command is `node scripts/check-browser.mjs`; configure
`SARA_PLAYWRIGHT_MODULE` to an existing compatible Playwright package entry if it is not installed
in the checkout. It uses a synthetic loopback fixture, screenshots and machine-readable results.
Browser tooling and its browser engine must already be available; missing tooling is an error,
not a silent pass. No Actions/CI or background browser task is enabled. Browser fixtures do not
substitute for a novice study, screen-reader acceptance or physical native/phone checks.

## Incident and recovery drill

1. Check liveness separately from owner Operations. Record version, time, request ID and the fixed
   failed category. Never paste provider secrets, tokens or private chat contents into a ticket.
2. If a model is only configured, use a separate explicit test reply under your normal provider
   policy. If a bridge is running but delivery is uncertain, inspect the destination and Recovery;
   never repeatedly retry an uncertain external effect.
3. Before updating/restarting, stop or finish active work, make a backup and retain the previous
   build plus restore instructions. For storage pressure, inspect attachments/backups/log rotation;
   archive does not free all database bytes. Do not remove unresolved receipts to make a chart green.
4. Test restores to a new isolated location. Do not boot a restored live bot account against the
   network. Verify every owner/companion/member database and encryption key, attachment access,
   held work and an outbound-disabled boot before considering a production restore.
5. Repository synthetic drill: `node --test test/q4-qualification.test.ts test/q3-crash.test.ts
   test/q3-backup.test.ts test/q3-isolated-boot.test.ts` (one command line). It checks real process
   crashes, four-space restore, archived deduplication and offline production-entry-point boot.
6. Record measured restoration time and recovery point for your own defined workload. Lab timings
   do not cover hardware loss, offsite outage, paid inference or physical power-loss behavior.

Operational policy, actual availability/data-loss targets, long-running soak tests and independent
security/accessibility assessment remain deployment-specific decisions. Business workspaces are
a separate product/security design; household access is not a shortcut to organization roles.

## Backup responsiveness and shutdown

Manual API, the existing automatic tick and Safetycheck snapshot creation run in worker threads,
serialized per canonical server-data root. Worker messages contain trusted paths/configuration and
manifests, never archive contents or credentials. Same-second manual requests receive distinct
complete archives. Shutdown closes backup admission and waits for accepted worker jobs; it does not
start a new timer/service. Existing archive/encryption/restore and offline CLI formats are unchanged.
Concurrent automatic pruning skips files that disappeared during listing; real I/O errors remain errors.

This moves snapshot/compression work off the HTTP event loop; it cannot eliminate underlying disk
contention or make every SQLite/filesystem/crypto operation nonblocking. Existing offsite test-restore
and cryptographic maintenance retain their separate path. A process killed externally can still leave
partial work; use normal backup/restore checks and do not infer a production recovery SLA.

## Release qualification sample — 2.63.1

Synthetic 8-client/400-request profile v2, 10,000 terminal and 100 unresolved deliveries, 8 MiB upload,
backup during reads, archive and separately timed restore. No real model or external delivery.

| Environment | HTTP p95 / max | Loop-delay p95 | Process high-water RSS growth | Backup / separate restore |
|---|---|---|---|---|
| Windows x64, Node 24.20.0, 32 logical CPUs | 16.17 / 25.52ms | 31.31ms | 100.01MiB | 137.69 / 38.86ms |
| Linux x64 shared host, Node 24.22.1, 8 logical CPUs | 24.07 / 49.36ms | 83.95ms | 114.19MiB | 611.35 / 49.46ms |

Both runs passed the original gates with zero unexpected errors, all 100 unresolved reviews retained,
all 10,000 eligible records archived and backup/upload verified. These observations describe a short
synthetic profile, not supported production capacity, model latency or an availability guarantee.
Earlier unpublished 2.63.0 profile v1 failed Linux loop-delay gates (including a quiet 222 ms result);
it included offline restore in the histogram and exposed real blocking backup work. It was held,
worker creation implemented and v2's window corrected, with thresholds unchanged. v1/v2 lag values
are not directly comparable because the window differs. Reproduce on your own deployment before
setting workload or recovery promises; sustained-load and physical user acceptance remain separate.
