# Running Sara for other people (admin guide)

For the owner of a household server, or the administrator of a business instance. The owner is the
admin of a household server. Public summary: [SECURITY_OVERVIEW.md](SECURITY_OVERVIEW.md).

## Where things are

| Task | Household / personal server | Business instance |
| --- | --- | --- |
| Who may sign in | Settings → Household → People on this server (invites, pause, remove) | Organization administration (invitations, roles, SCIM) |
| Sign-in with your provider (OpenID Connect) | Settings → Connections → Devices and sign-in → **Sign in with your provider** ([SIGN_IN_SSO.md](SIGN_IN_SSO.md)) | Organization administration → Company sign-in ([BUSINESS.md](BUSINESS.md)) |
| What members' companions may do with tools | People on this server → **Tools for household members** (below) | Business chat has no tools |
| Rules for everyone, you included | Settings → Household → Policy ([AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)) | The operator's model policy ([BUSINESS_OPERATIONS.md](BUSINESS_OPERATIONS.md)) |
| Audit export | Settings → Household → Audit trail: JSONL, CSV or JSON, signed | Organization administration → Audit export: CSV or JSON |
| Undo what she changed | Settings → Privacy & system → Reports → **Action timeline**: Revert per row, each person their own ([TIMELINE.md](TIMELINE.md)) | Not in the business instance |
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

## Sign-in with your provider on household and personal servers (V0.8)

Since V0.8 every server can offer OpenID Connect next to the owner token, passkeys and pairing codes
(owner decision 2026-11-18, replacing the R7 "business only" rule). Households that already run
authentik, Keycloak, Pocket ID or Authelia, or use Google or Microsoft accounts, turn it on in
Settings → Connections → Devices and sign-in → **Sign in with your provider**. Full guide:
[SIGN_IN_SSO.md](SIGN_IN_SSO.md).

- **No lock-out.** The owner token, passkeys and pairing codes always work; nothing in this section
  can turn them off. A broken provider only hides one button.
- **Who is who.** Each person (owner, members, kids) lists the emails (verified by the provider) and
  groups that are them. Nobody maps to the owner unless you add an email or an owner group. Optional
  role groups (owner, member, kid) gate sign-ins: a member or kid signs in only while in their group.
  The first sign-in links the provider account; a second account with the same email does not take
  over (Unlink in Settings first).
- **New members** (off by default): an allow-list of emails or groups, with your 18+ confirmation and
  the person's own at sign-in. Kids are never made automatically; a parent or guardian invites them.
- **Checks**: PKCE, state with a SameSite=Lax binding cookie, nonce, issuer, audience/azp, expiry with
  an allowed clock difference (0–300 s, default 60), RS256/ES256 only, JWKS cached and refetched once
  when an unknown key id appears. The owner's sign-in goes through new-device approval like a passkey.
- **Sign-out** of a session that came from the provider also opens the provider's end-session page.
- Private local mode accepts only a provider on this computer or the home network. The client secret
  lives in the owner's vault; `<data>/sso.json` holds the rules, links and sign-in records.

## Checking company sign-in (business)

**Test connection** reads the provider's discovery document and keys. **Test sign-in** runs the whole
sign-in in a new tab, even before company sign-in is turned on: PKCE, state, nonce, the ID-token
signature against the provider's keys, issuer, audience and expiry, then your domain and group
rules. **Show the test result** says whether you would be let in and with which role, your email
domain and the groups the provider sent (so you can copy Entra group IDs). Nobody is signed in or
linked by a test; it is one `sso.test` audit row.
