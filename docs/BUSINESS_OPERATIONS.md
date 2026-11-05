# Business installation operations

**For Sara 2.64.0 and later.** Use a separate business instance, operating-system
identity, data root and browser hostname. This guide does not authorize converting a personal
instance or restoring over existing data. [Business workspaces](BUSINESS.md) explains the user flow.

## Operator authority and prerequisites

The installation operator controls storage, credentials and recovery through a trusted local
console. Organization administration is a separate application role and grants neither this
operator capability nor automatic workspace content access. The host operator can access disk.

Use Node 24+. Set `SARA_DATA` to the intended business root and `SARA_PROFILE=business`; serving
also requires the exact `SARA_BUSINESS_ORIGIN`. Use an HTTPS hostname, or `http://localhost:<port>`
for local evaluation. Literal IP addresses are unsuitable for browser passkeys. A reverse proxy
must preserve the configured Host; forwarded client attribution needs explicit trusted-proxy setup
as described in BUSINESS.md. Never reuse personal credentials or mount personal data here.

Stop this business runtime before offline operator commands. Its exclusive writer fence refuses
another supported writer; do not delete a lock file to force entry. A separate personal instance
does not need to stop. Recovery assumes reliable local SQLite locking, directory ownership and a
filesystem supporting hardlinks. Network-filesystem/distributed-lock behavior is not certified.

Business setup is a separate manual source/container workflow. The native setup wizard, stock
Compose file, Linux personal installer and generic `sara backup/restore/update` commands configure
personal instances; they are not business provisioning or coherent business recovery commands.
Use the explicit `--business-*` entrypoints below and your own separate business service/data/origin.
Existing marked business roots fail closed when a personal command is selected accidentally.

## Configure an allowed model

Create a locally protected JSON file with `policy` and optional `keys`. Keys remain in the separate
encrypted business Vault; the input file can itself contain secrets, so protect it independently.
Never put a key or passphrase in command arguments, request URLs, shared messages or Git.

```text
node src/main.ts --business-configure <local-policy-and-keys.json>
node src/main.ts --business-status
```

The main command works with packaged source; a full source checkout also has
`node scripts/configure-business-models.ts <business-root> <local-policy-and-keys.json>`.
No browser role can configure provider keys. Default unconfigured state permits no model calls.

Example input: replace the workspace UUID, endpoint and model with this installation's approved
values. The example permits only declared zero-cost local inference; it grants no paid allowance.

```json
{
  "policy": {
    "version": 1,
    "privateLocal": true,
    "allowCloud": false,
    "instanceAllowanceNanoUsd": 0,
    "maxConcurrent": 2,
    "models": [{
      "id": "local",
      "provider": {
        "id": "local",
        "kind": "openai-compatible",
        "label": "Local model",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "local": true,
        "needsKey": false
      },
      "model": "your-installed-model",
      "cloud": false,
      "inputNanoUsdPerToken": 0,
      "outputNanoUsdPerToken": 0,
      "maxInputTokens": 24000,
      "maxOutputTokens": 1000,
      "maxOutputBytes": 32768,
      "deadlineMs": 30000,
      "tone": "professional"
    }],
    "workspaces": {
      "00000000-0000-4000-8000-000000000001": {"modelId":"local","allowanceNanoUsd":0}
    }
  }
}
```

Find the intended workspace UUID in its browser URL or operator status. For a key-requiring provider,
set `needsKey:true` and add `"keys":{"local":"your-private-key"}` outside `policy` in the protected
input file. Only OpenAI-compatible and Anthropic API adapters are supported. Cloud inference needs
both explicit model `cloud:true` and installation `allowCloud:true`; private-local restrictions
still apply. Configure the final endpoint: business requests refuse redirects and never silently
select a fallback. `local:true` is an operator declaration of self-hosting; private-local mode
additionally restricts destinations to literal loopback/localhost.

| Field | Accepted bounds |
|---|---|
| Models / workspace bindings | At most 16 unique models and 1,000 workspace bindings |
| `maxConcurrent` |1–16 pending calls per instance |
| `maxInputTokens` / `maxOutputTokens` |1024–131072 /1–32768 |
| `maxOutputBytes` / `deadlineMs` |64–131072 bytes /100–120000 milliseconds |
| Prices / allowances | Nonnegative safe integers, at most 10^15 nanoUSD units |
| `tone` | `professional`, `concise` or `friendly` |

Configuration input is bounded to 256KiB; key values to 8,192 characters. Provider URLs reject
credentials, queries and fragments, and require HTTPS except literal loopback HTTP. Limits are
validated before configuration is accepted; there is no subscription/CLI-provider adapter.

Prices and allowances are nonnegative integer nano-US dollars: 1USD =1,000,000,000 units. They are
lifetime allowances without an automatic calendar reset. Each call reserves its configured maximum
against installation and workspace ceilings before inference. Unknown/interrupted usage stays
held; settlement requires valid bounded usage. Provider pricing/invoice honesty cannot be proved
by a local allowance ledger. A configured destination is not evidence of successful inference.

## Update a business instance

Use the business operator's source/container workflow; the personal `sara update` command is not
a business updater. Plan a quiet window, stop only the business runtime gracefully, and take an
explicit `--business-backup` while keeping its archive/passphrase private. Preserve the previous
code/image and configuration, then install the verified release source or pinned container version
and restart with the same dedicated identity, business data root and exact origin. Do not point
personal/native setup at that data or replace credentials/policy with defaults.

Check hostname-bound health, individual sign-in, workspace roles, destination and original request
states after restart. Interrupted requests remain held; an update never authorizes regeneration.
Choose any real inference smoke within this installation's approved provider/budget policy.
If recovery is needed, preserve the failed root and use the fresh-target encrypted restore procedure
below, including current-person/grant/new-policy reconciliation. A prior snapshot cannot establish
today's permissions or charges; copying it over live data is not a supported rollback shortcut.

## Review an ordinary spending pause

A missing usage report, interrupted connection or crash can hold requests and pause new spending.
This is separate from disaster restore: do not reset accounts or restore a backup just to review
an ordinary pause. Stop the business runtime, verify `SARA_DATA`, then inspect:

```text
node src/main.ts --business-status
```

Status supplies the current `pauseId`, reason, held/unknown counts, known charges, full unknown
reserved exposure, total conservative exposure and exact current `policyHash`. These describe the
entire ledger, not just the last request. Offline status conservatively holds crash-left pending
work and initializes legacy pause metadata under the fence; it is not a purely read-only command.
An old pause's detection timestamp is not evidence of when the provider incurred usage.

Review operational/provider evidence and create a protected acceptance file:

```json
{
  "pauseId":"exact current pause UUID from status",
  "policyHash":"exact current SHA256 from status",
  "acknowledgement":"operator-accepted-uncertainty",
  "unrecordedExposureNanoUsd":50
}
```

The additional amount is optional (default 0); 50 is only a synthetic nanoUSD example. It can add
conservative exposure but cannot reduce/refund it. Choose it using the actual installation's
evidence and policy. Existing unknown requests retain their full maximum reserves regardless.

```text
node src/main.ts --business-resume-pause <local-acceptance.json>
```

This transaction records acceptance and reopens only **new** admission. Existing held UUIDs remain
held and never regenerate; charges/reserves, identities, passkeys, sessions, grants, content and
provider configuration remain intact. A new explicit request still needs available allowance.
Ordinary recovery may retain the exact currently approved policy because no snapshot rollback
occurred. Repeated/terminal holds do not invent a new pause, but new uncertainty creates a fresh
pause ID. Replaying an old file cannot clear that later pause; altered/lowered acceptance is refused.

Restart normally after acceptance. If uncertainty recurs, obtain fresh status and review it again.
The ordinary command cannot bypass active archive recovery or its first generation/new-policy
acceptance. After a fully accepted restore, later ordinary pauses use this command normally.

## Create and inspect a recovery generation

Create a protected passphrase file using the installation's secret-handling process. The passphrase
must be 10–1024 characters; the file is bounded to 4,096 bytes. Keep recovery custody separate from
the archive. Do not use a sample passphrase from documentation.

```text
node src/main.ts --business-backup <archive-outside-data-root> --passphrase-file <local-file>
node src/main.ts --business-status
```

The backup closes admission, drains accepted work, snapshots the control database and every
registered workspace plus scoped authentication/operator key material into one generation, then
validates and packages/encrypts it in a worker. Source key/Vault consistency and configured required
secrets are checked; missing or mismatched material is refused rather than repaired. Archives are
published exclusively and never overwrite another archive. Live WAL/SHM/journal/fence files are
excluded. Personal restore refuses the separate business archive before initializing its target.

Initial bounds: 1,000 workspaces, 256MiB staged total, 128MiB per file, 10,000 files/directories and 512MiB
archive/unpacked limits. These are admission caps, not a maximum-size performance certification.
Audit storage and organization records are retained; there is no automatic content deletion.

Abrupt process death can leave a private plaintext staging directory or an encrypted partial/link.
Preserve and inspect it before deliberate cleanup. No cleanup watcher is installed. A complete
archive with an extra hardlink is refused until the operator verifies/removes the leftover link.

## Recover one person's sign-in

Verify the person through the organization's actual process. Stop the business runtime and issue
an individual one-use code, transferring it privately to that person:

```text
node src/main.ts --business-reenroll <identity-uuid>
```

For a deliberately disabled identity, add `--reactivate` explicitly. Codes expire after 30 minutes;
another issuance invalidates the previous code and that identity's old credentials. Restart the
business instance normally; the person chooses **Recover my sign-in**, redeems the code and
enrolls a fresh individual passkey before protected access is allowed. Coworkers' sessions,
credentials, grants and spending state remain unchanged. An active person's current live grants
can remain; ordinary account recovery does not create a disaster generation.

A disabled/removed organization account still needs a currently authorized organization admin to
reapprove it after fresh enrollment. That transaction closes its retained workspace grants; each
intended workspace manager must separately regrant access. Old cookies stay invalid. A workspace
without an active manager retains its custody boundary; no organization-admin content superuser
is created. This individual flow does not use reconcile/complete/resume-spending commands.

## Restore an archive with access closed

Use a nonexistent isolated target with real existing ancestors, outside another personal/business
profile. Never restore over a running or populated instance.
The selected business operating-system identity must be able to create a temporary sibling stage
and the fresh target in its parent directory. Prefer a private recovery parent owned by that
identity; keep application source and launch configuration protected separately. A root-owned,
nonwritable parent will correctly refuse an unprivileged restore before promotion.

```text
node src/main.ts --business-restore <archive> --target <fresh-isolated-root> --passphrase-file <local-file>
```

Validation precedes target creation; the profile marker is published last. A failed/interrupted
promotion can leave an incomplete, closed target. Preserve it for inspection and use a different
fresh target for the next attempt. Point `SARA_DATA` to the restored root for subsequent commands.

Restore rotates identity epochs, removes old credential references, revokes invitations, closes
organization/workspace grants and holds unfinished work/spending. Records and prior grants remain
for explicit review. An old backup may predate a real revocation or charge; its membership and
allowance are not evidence of current authority or current provider usage.

```text
node src/main.ts --business-status
node src/main.ts --business-reenroll <selected-identity-uuid>
node src/main.ts --business-reconcile <grant-plan.json>
```

Use explicit `--reactivate` only for a disabled identity that should return. Reconciliation can
select only prior grants at the same or lower role; it cannot invent content membership. Include
an existing organization admin and a manager for every reopened workspace. Omitted grants remain
closed. Replace the placeholders in this plan with the exact generation/IDs from status:

```json
{
  "generation":"generation UUID",
  "organization":[{"identityId":"existing UUID","role":"orgadmin"}],
  "workspaces":[{"workspaceId":"existing UUID","identityId":"existing UUID","role":"manager"}],
  "usage":"keep-held",
  "policy":"disabled"
}
```

Organization roles are `orgadmin|user`; workspace roles are `manager|contributor|viewer`.
Start only the isolated recovery instance with its configured hostname/origin. Each selected
person redeems their code and enrolls a fresh passkey. Content/management remain closed. Stop it
again before completion; completion requires every selected person's current-epoch enrollment:

```text
node src/main.ts --business-complete <generation-uuid>
node src/main.ts --business-configure <newly-approved-policy-and-keys.json>
node src/main.ts --business-status
node src/main.ts --business-resume-spending <acceptance.json>
```

Completion enables only reconciled grants. Model spending stays paused until a newly written
policy revision and exact generation/policy hash are explicitly accepted. Example acceptance
(500 is only a synthetic nanoUSD example, not a recommended estimate):

```json
{
  "generation":"exact generation UUID",
  "policyHash":"new exact SHA256 from status",
  "acknowledgement":"operator-accepted-uncertainty",
  "unrecordedExposureNanoUsd":500
}
```

Choose additional conservative exposure from current provider/accounting evidence. Existing
held reservations, charges and request identities remain; this does not settle an invoice, refund
usage or regenerate work. Identical acceptance is a no-op, reductions/changed acceptance are
refused, and replay cannot clear a later spending pause. Then start the isolated instance normally
and perform installation acceptance before any production decision.

## Evidence and limits

Audit records are bounded metadata. Control/content mutations commit with their audit; filesystem
authentication/configuration records are durable intents, not atomic proof the file operation
succeeded. Audit is not immutable against the host operator. Already delivered browser/provider
data cannot be recalled.

Synthetic browser, crash and recovery checks do not establish hardware-passkey/screen-reader
acceptance, root-resistant isolation, sudden-power-loss atomicity, workload capacity or production
RPO/RTO. Choose provider approvals, real spending ceilings, backup location/key custody and recovery
targets for each installation, then measure them. No external-effect tools, automatic replay,
guests/SSO, bulk content export, corporate retention or compliance certification is added by B1.

Snapshot staging resolves the operating system temporary directory to its canonical path, including
macOS system aliases. Business data and archive contents still reject links and escaped paths.
