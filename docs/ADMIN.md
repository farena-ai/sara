# Running Sara for other people (admin guide)

For the owner of a household server, or the administrator of a business instance. The owner is the
admin of a household server. Public summary: [SECURITY_OVERVIEW.md](SECURITY_OVERVIEW.md).

## Where things are

| Task | Household / personal server | Business instance |
| --- | --- | --- |
| Who may sign in | Settings → Household → People on this server (invites, pause, remove) | Organization administration (invitations, roles, SCIM) |
| Company sign-in (SSO) | Not offered (see below) | Organization administration → Company sign-in ([BUSINESS.md](BUSINESS.md)) |
| What members' companions may do with tools | People on this server → **Tools for household members** (below) | Business chat has no tools |
| Rules for everyone, you included | Settings → Household → Policy ([AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)) | The operator's model policy ([BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md)) |
| Audit export | Settings → Household → Audit trail: JSONL, CSV or JSON, signed | Organization administration → Audit export: CSV or JSON |
| How long data is kept, legal hold | Settings → Household → Retention and legal hold ([DATA_RIGHTS.md](DATA_RIGHTS.md)) | Per workspace content hold ([BUSINESS.md](BUSINESS.md)) |
| Prove a backup restores | Settings → Privacy & system → Recovery → **Run a restore drill** ([RECOVERY.md](RECOVERY.md)) | The operator's recovery rehearsal ([BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md)) |
| A reviewer's summary | Settings → Household → Trust report ([TRUST_REPORT.md](TRUST_REPORT.md)) | |

## Tools for household members

Settings → Household → People on this server → **Tools for household members**. Pick **Everyone**
or one person in *Rules for*, then for each tool family:

- **Computer use** (Sara on their own computers, when you let members use computer use),
  **Sending email** (from their own mailboxes), **Web search and reading**, **Errands**,
  **Automations**: *Allowed as usual*, *Always ask first* (every step shows them a card, even ones
  that normally run on their own) or *Off* (the tools are not offered and a call to them is
  refused). For one person, *Same as everyone* follows Everyone.
- **Every tool asks first**: every tool step asks them, except loading tool descriptions.
- **Paid tools, at most** a dollar amount a day: a hard cap, past it paid tools stop until midnight
  and nobody can allow one more call. Their daily spending limit for models (set on the invite) still
  applies. With an admin policy cap, the lower one counts.
- **Never for members**, whatever you choose: purchases and payments (in computer use, Sara refuses
  to press Pay, Buy or Place order and hands them the page), commands and coding tools.

The rules are kept in `<data>/member-tools.json` and checked on the server every time a tool's
permission is read: when the tool list is made, before a call runs and again after a card is
answered. A member's own settings ("Always allow this tool"), a hand-made request or a model that
calls a tool it wasn't offered can't get past them. Changing them writes one `member-tools.change`
row to the audit trail. A damaged file turns every family off for members until you save again.

## Why there is no single sign-on for households

Company sign-in needs an organization's identity provider (Entra ID, Okta). A household has none,
and its members join with a one-time invite and their own passkey or token, which the owner can pause
or remove at once. So OpenID Connect is offered only in business mode; household and personal servers
are unchanged. (R7 decision.)

## Checking company sign-in (business)

**Test connection** reads the provider's discovery document and keys. **Test sign-in** runs the whole
sign-in in a new tab, even before company sign-in is turned on: PKCE, state, nonce, the ID-token
signature against the provider's keys, issuer, audience and expiry, then your domain and group
rules. **Show the test result** says whether you would be let in and with which role, your email
domain and the groups the provider sent (so you can copy Entra group IDs). Nobody is signed in or
linked by a test; it is one `sso.test` audit row.
