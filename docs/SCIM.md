# Provisioning with SCIM 2.0 (business instances)

Your identity provider (Microsoft Entra ID, Okta, or any SCIM 2.0 client) can create, update,
disable and remove accounts on a business instance automatically. Personal and household servers
have no SCIM address. Design: [ops/EC1617_DESIGN.md](ops/EC1617_DESIGN.md).

## Turn it on

1. Sign in as an organization administrator → Organization administration → **Provisioning (SCIM)**.
2. Tick **Turn on provisioning** and press **Create a new token**. Copy the token now: it is shown
   once. Sara keeps only its SHA-256 in the operator vault. A new token stops the old one at once.
3. In your provider use the **SCIM address** `https://<your instance>/scim/v2` and the token:
   - **Entra ID:** Enterprise applications → New application → Create your own application
     (non-gallery) → Provisioning → Automatic. Tenant URL = the SCIM address, Secret Token = the
     token → Test Connection → assign people and groups → Start provisioning.
   - **Okta:** your Sara app → General → App Settings → enable SCIM provisioning. Provisioning tab:
     SCIM connector base URL = the SCIM address, unique identifier `userName`, actions *Push New
     Users*, *Push Profile Updates*, *Push Groups*, authentication *HTTP Header* with the token.

## What happens

| Provider does | Sara does |
| --- | --- |
| Create user | A new account and organization membership (member). The person signs in with company sign-in the first time without an invitation (their email must equal the SCIM `userName` or work email) and confirms 18+. |
| Update user | Name, email and external id are updated. Fields Sara does not keep (department, manager, roles, password) are accepted and dropped; a password is never stored. |
| Disable (`active: false`) | The account is closed and every session ends **at once** (open pages and streams too). |
| Re-enable | The membership opens again; old sessions and passkeys stay invalid and workspace access must be granted again, as for any re-enabled account. |
| Delete user | Membership removed, company sign-in link dropped; the account's old audit rows stay. |
| Group membership | Groups listed under Company sign-in → *Administrator groups* (by display name, external id or id) make people organization administrators; everyone else provisioned is a member. The last active administrator is never demoted. |

SCIM only manages accounts it created. The person who set up the instance and everyone you invited
yourself are never changed by SCIM.

## Supported protocol

`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`, `/Users` and `/Groups` (GET, POST, PUT,
PATCH, DELETE). Filters: `userName eq "…"`, `externalId eq "…"` (users), `displayName eq "…"`,
`externalId eq "…"` (groups); paging with `startIndex`/`count` (at most 200). PATCH accepts
`add`/`replace`/`remove` in any case, paths such as `active`, `name.familyName`,
`emails[type eq "work"].value`, `members`, `members[value eq "…"]`, or a value object; Entra's
string booleans (`"False"`) are understood. No bulk, sort, ETags or password changes.

Limits: 1,000 requests a minute per instance, 20 wrong tokens a minute per address (then 429 with
`Retry-After: 60`), 64 KiB bodies, 5,000 users, 500 groups, 5,000 members per group.

## Request sequences tested

`test/ec16-scim.test.ts` replays what the providers send:

- **Entra ID:** `GET /Users?filter=userName eq "<random guid>"` (must be an empty list) → `POST
  /Users` with the enterprise extension → `GET /Users/<id>` and by filter → `PATCH` with `Replace`
  on `emails[type eq "work"].value` and `name.familyName` → `POST /Groups` → `GET /Groups?
  excludedAttributes=members&filter=displayName eq "…"` → `PATCH` group `Add`/`Remove` members →
  `PATCH` `Replace displayName` → `PATCH` user `active` `"False"` → `DELETE /Groups/<id>` →
  `DELETE /Users/<id>`.
- **Okta:** `GET /Users?filter=userName eq "…"&startIndex=1&count=100` → `POST /Users` (with a
  password, which is dropped) → `PUT /Users/<id>` → `POST /Groups` → `PATCH` members `add`,
  `remove` with `members[value eq "…"]` → `PUT /Groups/<id>` → `PATCH` `replace` value object
  (rename) → `PATCH` `{active:false}` and back to `true`.

A run against real tenants is an owner check (`docs/OWNER_CHECKS.md`).

## Audit

Every change is one row in the organization audit (ids only, never names, emails or tokens):
`scim.configure`, `scim.token`, `scim.user.create`, `scim.user.update`, `scim.user.deactivate`,
`scim.user.delete`, `scim.group`, `scim.refused` (a wrong token).
