# Business workspaces

**Business workspaces in Sara 2.64.0.** Business mode is optional and runs as a separate instance
of Sara. Its engineering qualification does not replace acceptance on your actual installation.
Installation operators should use the [configuration and recovery handbook](BUSINESS_OPERATIONS.md).

## Using the business desk

Open the exact hostname supplied by your installation operator and sign in with your individual
passkey. New colleagues choose **Accept an invitation**, paste their private code, review the
inviter, workspace and role, then accept and create their own passkey. New accounts require adult
confirmation. Codes are never put in links and do not become a shared team password.

The setup form explains the next step for each mode. **Set up this instance** needs the host
operator's 8-character setup code, your name and adult confirmation. **Recover my sign-in** needs
the complete private recovery code and adult confirmation; it keeps the existing account name.
Signed-in invitation acceptance uses the current account and hides the name/adult controls.
New-account names must contain 1–80 characters without control characters. Paste the complete
invitation/recovery code, including its dot. Invalid fields stay editable; unavailable, expired or
revoked invitations have the same safe refusal. Ask the issuing administrator or operator for a
new code rather than repeatedly trying the old one.

Organization administrators see an ordered guide: name the organization, create a workspace,
invite new organization accounts, then have workspace managers separately invite those active
accounts to shared content. Managers see the corresponding workspace steps. These guides do not
grant additional access. Allowed models, provider credentials, spending configuration and private
backup/recovery rehearsal remain the host operator's responsibility. A configured model destination
does not demonstrate successful inference or verified backup custody.

Choose a workspace from the selector. Its name, your role and the listed audience stay visible.
**View only** lets you read conversations/documents; sending and sharing remain unavailable.
Organization administration and workspace membership are separate: being an organization admin
does not reveal another workspace's content.

For a shared conversation, choose an existing title or start a new one, write your message, and
optionally select up to eight documents using the checkboxes. Review the audience and actual model
destination, then acknowledge the AI disclosure and choose **Send to workspace**. Confirmation
expires after three hours. Messages are bounded to 8KiB of UTF-8 text; selected context must also
fit the operator's configured input limit. A configured destination is not proof of a working model.

You can switch workspaces while an accepted request finishes; its answer belongs only to its
original workspace/conversation. Drafts and document selections stay with their actor, browser
session, workspace and conversation across reloads and switches. Signing out or losing access
clears protected views and session drafts. The conversation view shows the latest 200 messages;
older records are retained, not automatically deleted.

After another tab enrolls a passkey, or this tab regains focus, the desk rechecks the current
server-derived sign-in and access state. An unchanged identity and browser session keep scoped
message drafts, selected documents and original pending request IDs; refresh does not resend them.
Management refresh also updates colleague rows and eligible invitation recipients while keeping
typed fields, unsaved role choices and the currently displayed private invitation code. Each row
shows its current server access separately from unsaved choices. An ineligible recipient is cleared
for an explicit new choice, never silently replaced with another colleague.
A changed cookie, expired sign-in or revoked account clears protected state. Background tab hints
cannot reopen a sign-in already closed in this tab: sign in explicitly or reload the page.

If a request becomes uncertain, use **Check original request**. This is a read-only lookup and
cannot start inference. An uncertain original keeps its UUID/payload binding even when a check
finds no record yet; another attempt needs an explicit Send of that same original. Confirmed fresh
input/limit refusals leave the draft editable so you can shorten it or remove selected documents.
Pending/held work cannot silently regenerate. A spending hold needs operator review,
and reloading or checking again does not clear it. Closing a tab or losing its connection can
interrupt accepted work; do not assume an absent answer means no usage occurred.

Under **Documents**, choose a UTF-8 text/Markdown file up to 32KiB, review its destination/audience,
then share it explicitly. No link fetching, Office/PDF extraction or personal-library search runs.
Managers use **Workspace members** to choose existing active colleagues and scoped roles.
Organization admins invite new accounts separately. Access removal names the person/scope before
confirmation and retains records; the UI does not offer casual organization self-offboarding.
Managers can inspect their workspace's bounded metadata audit without message/file contents.

## What stays separate

Business has its own data root, service account, browser origin, identities, authentication keys
and provider configuration. It may share a physical host with a personal instance, but does not
import personal companions, household sessions, conversations, memories or provider credentials.
Use a fresh directory and a dedicated operating-system account; never point it at personal data.

Business content belongs to the organization and is shared only with explicit workspace members.
Organization administration does not silently grant content access. A host administrator can
technically access server storage; membership privacy is an application boundary, not encryption
against the person running the machine.

## Separate-instance startup and identity

The profile is selected with `SARA_PROFILE=business`. `SARA_DATA` must name a fresh separate root;
`SARA_BUSINESS_ORIGIN` is the exact public origin, and `SARA_PORT` must not conflict with another
instance. Example environment for an isolated local evaluation (choose your own fresh directory):

```powershell
$env:SARA_PROFILE = 'business'
$env:SARA_DATA = Join-Path $env:TEMP ('sara-business-evaluation-' + [guid]::NewGuid())
$env:SARA_HOST = '127.0.0.1'
$env:SARA_PORT = '7865'
$env:SARA_BUSINESS_ORIGIN = 'http://localhost:7865'
node src/main.ts
```

Run a separate terminal for personal Sara; do not reuse the business environment there. Business
data has a profile marker and cannot be opened as a personal instance. Existing personal roots,
unknown populated roots and paths escaping the selected root are refused rather than converted.
HTTPS is required for a non-loopback public origin; use the deployment's own reverse proxy and
dedicated origin. No installer/service configuration is changed by this source-only feature.
Open that exact configured hostname in the browser. Passkeys need a hostname: `localhost` works
for local evaluation, while a literal IP address is unsuitable for browser passkey enrollment.
Binding the listener to 127.0.0.1 is fine; it does not change the configured browser origin.

Behind a reverse proxy, forwarded client addresses are trusted only when explicitly configured
with `SARA_TRUST_PROXY=1`. Prefer a dedicated `SARA_PROXY_SECRET` (or private
`business/proxy-secret`) supplied by the proxy's `X-Sara-Proxy` header. The proxy must replace
untrusted forwarded headers and the backend listener must not be directly exposed. Without trusted
proxy configuration, forwarded headers are ignored. This controls rate-limit attribution, not
identity or workspace permissions; it never makes a request authenticated.

Initial setup uses a short-lived one-time code printed to the administrator's console. Keep it
private. Each user establishes their own sign-in; the personal owner token and household/API/device
credentials do not authenticate to the business instance. Joining requires adult confirmation.
Passkeys are scoped to the business origin and identity; registering or authenticating a credential
does not grant workspace access by itself.

## Initial scope

B1 implements independent identity, workspace permissions, scoped content, shared chat/documents,
conservative recovery and the business desk. Synthetic engineering qualification is complete;
acceptance on a real installation remains separate. Shared workspaces come first; private business
workspaces, guests, enterprise SSO and action-taking integrations are later work.

Model providers and spending ceilings are configured by the instance operator. Cloud use requires
explicit configuration; no paid provider is silently selected. Conversation content is sent to
the selected provider when inference is requested. A configured model is not proof of inference.

Removing access retains organization records without automatic deletion or reassignment.
Routine lost-sign-in recovery affects only that individual and requires a fresh passkey; coworkers'
sessions and credentials remain intact. A disabled person needs separate organization approval
after fresh enrollment, then workspace-manager approval for each workspace. Old content grants
do not silently revive when organization access is reapproved.

## Workspace permissions

B1 distinguishes organization administration from workspace membership:

| Role | Scope |
|---|---|
| Organization administrator | Invite/disable organization accounts, manage access policy and create new workspaces. Existing workspace content still requires explicit membership. |
| Workspace manager | Manage this workspace's membership and invitations to existing active colleagues; can use its chat/documents when those features are enabled. |
| Contributor | Use shared chat and add documents when enabled; cannot change the audience. |
| Viewer | Read authorized workspace content; cannot send or upload. |

New people first accept an organization-admin-issued invitation and confirm they are adults.
Workspace managers then grant/invite those active identities to a workspace. Codes are shown once,
expire, can be revoked and are consumed once; an existing user must accept while signed in as the
intended account. Invitation secrets are submitted in POST bodies, not code-bearing request URLs.
Logging out does not invalidate invitations already issued, but issuer access/role changes do.

Organization administrators and workspace managers can return to **Recent invitations** in their
respective management screen. The list shows the latest 100 invitations for that exact scope,
newest creation first, with role, expiry and current status. Older invitations can still exist;
this bounded list is not a complete historical register. Organization administration lists only
organization invitations; a workspace list requires current manager access to that workspace.
Names appear only when the account is already visible in the current roster or invitation
pick-list; otherwise the desk shows **Unlisted account**.

**Pending** means the invitation currently passes the same eligibility checks as preview and
acceptance. Expiry, revocation, changes to the issuer's authority or sign-in credentials, loss of
recipient access, or an existing membership row can make an unused invitation unavailable.
The list distinguishes **Expired**, **Revoked** and **Invalidated**. **Accepted** means the code
was used; it does not prove the recipient still has access. Revoking an accepted code does not
remove membership: manage current access separately in the roster.

Any current administrator or manager for that scope can revoke its pending invitations, including
ones another authorized colleague issued. **Refresh invitations** and ordinary same-session focus
refresh update the list without resetting unsaved access choices, private creation code, message
drafts or original pending requests. The private code is shown only immediately after creation;
leaving that view removes it, and the inventory cannot recover it. Send it privately at creation.
No automatic reissue, acceptance, email, bulk revocation or membership removal runs.

Ordinary workspace removal/demotion cannot remove its final active manager. Organization-wide
offboarding still revokes access immediately, even for a sole workspace manager; it preserves
records and existing other-member grants. It does not make an organization admin the new content
owner/member. Re-enrollment after organization removal/suspension requires fresh controlled
authentication; old cookies are not revived. No automatic deletion or reassignment runs.

The business desk provides setup, invitations, passkey sign-in/recovery, workspace switching,
shared chat/documents and authorized access management. Its synthetic browser qualification is
separate from physical user acceptance and release approval.

The scoped read layer supports authorized workspace conversations, documents and search.
Scope checks apply after asynchronous retrieval and before returning data. Readers can see the
active shared audience; only managers can look up eligible existing colleagues for invitations.
These read-only views do not grant membership-management or organization-administration authority.
Event connections carry fixed metadata, close on logout/access loss/expiry and have bounded counts.
B1 supports shared text conversations and UTF-8 plain-text/Markdown documents
(32KiB decoded maximum). Viewers cannot send or upload. Responses are buffered and checked before
sharing; there are no tools, external actions, URL extraction or personal companion imports.

The operator configures an explicit model destination and separate encrypted business credentials
with `SARA_DATA` set to its separate root and `node src/main.ts --business-configure <operator-json-file>`.
Treat that
input file as secret when it contains keys. No browser role can change provider keys or spending
policy. Configuration is absent by default, so an unconfigured instance cannot run model calls.
The configuration schema and operator procedure are in [Business installation operations](BUSINESS_OPERATIONS.md).

Before sending, users acknowledge the selected destination and the AI disclosure. Disclosure is
required for each actor/browser session and again after three hours. Cloud inference requires
explicit operator approval. Business requests refuse redirects and do not retry or select a paid
fallback automatically. Operator limits are integer nano-US dollars (1USD =1,000,000,000 units),
with separate installation/workspace lifetime allowances and a maximum reservation before every
call. Unknown usage or interrupted work retains a conservative hold and pauses spending; a retry
returns the recorded request state rather than generating again. This is not an invoice guarantee
against a dishonest provider. Recovery/reconciliation and the browser workflow have passed
synthetic engineering qualification; real installation acceptance remains separate.

Backups contain authentication/encryption material and must be protected. Real backup custody,
spending ceilings and workload/recovery targets are per-installation settings, not universal
product promises. A restore must not silently re-enable old access grants.

This guide documents the implemented onboarding contract and separate manual operator entrypoint.
Choose installation-specific controls and complete user acceptance before a production decision.

## Recovery safeguards

Business backups use a separate encrypted format. They capture the control database, every
registered workspace, authentication material and operator keys as one validated generation.
The runtime closes admission and drains accepted work before staging; packaging runs in a worker.
Only one supported writer may own a business root. Offline operator commands require stopping that
business instance; they never require stopping a separate personal instance.

Restore requires a fresh isolated target and keeps access closed. Old cookies, invitations,
membership grants and model policy do not become active automatically. The operator must verify
current identities, arrange individual passkey re-enrollment and explicitly reconcile prior grants.
Old backups cannot prove that a person still has permission today. A new model policy and explicit
spending review are separate; held requests and conservative usage exposure remain, without replay
or a silent refund. Organization administration alone does not grant this filesystem recovery power.

Managers can read a bounded metadata audit for their own workspace. Audit records omit message
contents, titles, filenames, keys and raw errors. Authentication/configuration filesystem changes
have durable intent records, which do not prove the file operation succeeded. Audit is not protected
against the host operator editing disk. Backup limits and recovery custody must be checked against
the actual installation; laboratory recovery is not a production recovery-time promise.

For repeatable synthetic first-use, invitation, read-only configuration and closed-restore checks,
operators can run the [manual business qualification](BUSINESS_OPERATIONS.md#repeat-the-manual-synthetic-qualification)
from a complete source checkout. It retains machine-readable child receipts and failed logs in a
new private evidence directory for each attempt. Browser automation uses virtual passkeys;
physical authenticator, screen-reader, colleague usability and installation-specific recovery
acceptance still need real people at the intended hostname.
