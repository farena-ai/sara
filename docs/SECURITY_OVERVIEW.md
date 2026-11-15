# Security overview

One page for people deciding whether to run Sara for a household or a small business. Details are in
the linked documents. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Where the data lives

- **On your server, in one folder** (`SARA_DATA`): the SQLite databases (`sara.db` per companion and
  per household member), uploaded files, the library, settings and the audit trail. Nothing is kept
  by us. Household members each get their own folder (`members/<id>/`); the app never shows one
  person's chats, memories or files to another, the owner included ([HOUSEHOLD.md](HOUSEHOLD.md)).
- **Business mode** is a separate instance with its own data root, its own sign-in and per-workspace
  databases ([BUSINESS.md](BUSINESS.md)).

## Encryption

- **Secrets** (model keys, mail passwords, sign-in tokens of other services) are in the vault,
  encrypted with AES-256-GCM. The key is `master.key` in the data folder, or `SARA_MASTER_KEY` from
  the environment, or a reference to an external secret store ([AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)).
- **Backups that leave the server** are encrypted with your passphrase first (scrypt + AES-256-GCM).
  Local backups stay in the data folder and hold its keys: protect the disk.
- **In transit:** use HTTPS for anything beyond this computer (the installer offers Tailscale or a
  reverse proxy). Disk encryption is up to the operating system.

## Sign-in

- The owner: passkeys, an owner token and optional two-step sign-in. Apps get their own device codes,
  which can't change sign-in settings, devices, the audit trail or the policy. New-device approval can
  make a remote sign-in wait for the owner's OK.
- Household members: one-time invites, their own token and passkeys; they reach only a fixed list of
  routes in their own space.
- Business: per-person passkeys, plus company sign-in through OpenID Connect (Microsoft Entra ID,
  Okta, Google Workspace, Keycloak) with PKCE, nonce and ID-token signature checks, domain and group
  rules, session checks at the provider and SCIM provisioning. The person who set up the instance
  keeps a break-glass passkey.

## Approvals and limits

- Tools that act (send, buy, change, delete, run commands) ask first by default; the card says what
  will happen. Read-only tools run on their own. Payments in Sara's browser ask every time, and are
  never made for household members.
- The owner's **policy** pins settings for everyone and only tightens ([AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)).
- **Tools for household members** set which tool families each member's companions may use, which
  always ask, and a daily cap for paid tools ([ADMIN.md](ADMIN.md)). All of this is checked on the
  server, not in the app.

## Network egress

- Sara contacts only what you set up: your model providers, the services you connect, web searches
  you allow. The full list is in [PRIVACY.md](PRIVACY.md) ("What leaves your server").
- **Nothing leaves this computer** (private local mode) stops everything that would leave, including
  cloud models. Her commands can run without internet access, in a container, and with an egress
  allowlist of hosts ([OPERATIONS.md](OPERATIONS.md), [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)).
- Addresses on your own network are refused by default for anything a web page or a model can
  choose.

## What leaves the server

Only what [PRIVACY.md](PRIVACY.md) lists, and only once you set it up: the text you send to the model
you picked, searches, connected services, off-server backups, an anonymous daily check-in you can turn
off (version and feature switches, never content), and problem reports you choose to send. Logs never
hold message contents and hide known secrets.

## Updates and signing

- Updates come only from published releases of the public repository; Sara never updates herself.
  Only the newest release gets security fixes.
- The macOS app is signed and notarized; the update notice is signed. The Windows installer is not
  code-signed yet ([INSTALL.md](INSTALL.md)).

## Records and recovery

- An append-only, hash-chained **audit trail** of sign-ins, settings changes, approvals and background
  work, with a check of the chain and a signed export (CSV, JSON or JSONL, message content left out
  unless asked). Business mode has its own audit with a CSV/JSON export.
- **Retention** per kind (chats, memories, files, run history, logs, inbox scans) and a **legal
  hold** that stops every deletion ([DATA_RIGHTS.md](DATA_RIGHTS.md)).
- Daily backups and a **restore drill** that restores the newest backup into a throwaway copy and
  checks it (every file back, database integrity, the vault opens, the copy starts) without touching
  the live data ([RECOVERY.md](RECOVERY.md)).
- The **trust report** sets what she said against what her records show ran ([TRUST_REPORT.md](TRUST_REPORT.md)).

## Incidents

Report privately through GitHub's *Report a vulnerability* on the repository, or email
**sara@backstagecoding.com** with "Security" in the subject ([SECURITY.md](../SECURITY.md)). Fixes ship
as a new release with notes in the changelog.
