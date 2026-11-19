# W3.3 Team workspace (business mode)

One page. Business mode only (`SARA_PROFILE=business`); the personal app and its home members are untouched.

## What existed (reused, not rebuilt)

- Organization roles `orgadmin`/`user` and workspace roles `manager`/`contributor`/`viewer` with
  `BusinessPolicy.authorizeWorkspace` (src/business/policy.ts). Workspaces already are the shared
  projects: each has its own membership and its own content database.
- SSO (EC2/V0.8, src/business/sso.ts): administrator and member groups mapped at every sign-in and
  session check; break-glass owner never changed.
- Audit (src/business/audit.ts): control audit + per-workspace audit, R7 CSV/JSON export with a date range.
- C16 team pages and the `BusinessWorkspaces.pages()` write helper (revalidated role + audit row in
  one transaction).

## What W3.3 adds

- **Team roles** (src/business/team.ts): `owner` = the account that set the instance up (organization
  administrator, break-glass), `admin` = organization administrator, `member` = organization user,
  `guest` = an organization user marked in `business_team_guests`. `TEAM_MATRIX` is the single
  permission table; the Team tab shows it and the tests pin it.
- **Guests only read**: one check in `authorizeWorkspace` refuses every non-read action for a guest,
  whatever their workspace grant. Guests also never see the team inbox or approvals (404, like a
  workspace they are not in).
- **SSO groups → roles**: new `guestGroups` next to administrator/member groups. Precedence admin >
  member > guest; nobody in a listed group is refused (as before). `ssoGroupRole` is pure and tested;
  `syncTeamGuest` keeps the mark in step at sign-in and every session check.
- **Team inbox** per workspace (`team_inbox`, `team_replies` in the workspace content database): add a
  message (paste), assign to a non-guest member of the workspace, reply as the team. A manager's reply
  is ready at once; anyone else's creates a `reply` approval for a manager. Business mode has no mail
  sending: the person who sends the approved reply from their mail marks it **sent**.
- **Approvals routed by role** (`team_approvals`): spending requests up to the organization's spend
  limit (`business_team_settings`, default $500, set by admins) need a workspace manager; over it an
  admin/owner who is in the workspace (not view only). Nobody decides their own request; a request is
  decided once (409 after).
- **Audit export who/what**: `actor=<id>`, `action=<action or first word>` and `workspaces=1` (adds
  every workspace's metadata rows with a `source` column). Without `workspaces=1` the old export is
  byte-for-byte the same shape. New audit actions: `team.role`, `team.settings`, `inbox.add|assign|
  reply|done|sent`, `approval.request|decide`. Rows never hold message text.

## Routes

`GET /api/business/team` (role, matrix, spend limit; roster for admins) · `POST /api/business/team/people/:id {role}` ·
`POST /api/business/team/settings {spendLimitCents}` · `GET|POST /api/business/workspaces/:w/inbox` ·
`GET /inbox/:id` · `POST /inbox/:id/assign|reply|done` · `POST /inbox/:id/replies/:rid/sent` ·
`GET /workspaces/:w/team-people` · `GET|POST /workspaces/:w/approvals` · `POST /approvals/:id/decide {approve}`.

## UI

Business desk → **Team** tab (web/business-team.js): your role, Team inbox + Approvals side by side
(stacked on phones), the matrix (role chips on phones), and for admins Team roles + Spend limit.
Organization administration → Audit export gains Who / What / Include workspace activity; Company
sign-in gains Guest groups. Every control has a tip; strings in 5 languages.

## Not done (honest limits)

- No mail intake or sending in business mode: messages are pasted, replies copied out and marked sent.
- Spend approvals are records only; nothing is paid or charged.
