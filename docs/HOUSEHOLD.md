# Household mode: more than one person on one Sara

Sara 2.0 lets the owner of a server invite other adults (a partner, a flatmate, a grown-up child) to
use the same Sara server. Each person gets **their own space**: their own companions, conversations,
memories, planner, notes, library, moments, scrapbook, looks, devices, API keys and notifications.
The owner keeps running the server and pays for the models; the owner **can't read** anyone else's
space.

> Part 1 is the user guide. Part 2 is the design (what is shared, what is isolated, and why it holds).
> The attack cases and how each is blocked are in [THREAT_MODEL.md → Household mode](THREAT_MODEL.md#household-mode-phase-71).
> Pinning rules for everyone and the audit trail: [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md).

---

## Part 1 · User guide

### Who is who

| | The owner | A member |
|---|---|---|
| Who | The person who installed Sara (today's single owner, nothing changes for them) | An adult the owner invited |
| Signs in with | The owner token, passkeys, two-step, paired devices (as before) | Their own member token (shown once when they join), then passkeys, two-step and paired devices of their own |
| Companions | Their own, as before | Their own (a fresh Sara to start with; up to 8) |
| Models | Sets up providers, keys and subscriptions | Uses the models the owner picked for them; never sees a key |
| Server settings, updates, backups, private local mode, instances | Yes | No |
| Shell, workspace files, background jobs, browser, GitHub, Google, Home Assistant, MCP, agent bridges, Telegram/Discord | Yes | No (off for members in 2.0) |
| Servers over SSH (2.2) | Yes | No: the owner's servers and keys; members' spaces have no SSH tools and `/api/ssh` answers 403 |
| Chat, voice notes, live calls, pictures, library, planner, moments, scrapbook, group chats with their own companions, personality and look studios | Yes | Yes (voice and pictures can be switched off per member, since they cost the owner money) |
| Reads another person's conversations, memories, companions or moments | No | No |

### Inviting someone (owner)

1. **Settings → Household → Invite someone.**
2. Type their name (only a label for you), choose how long the invite works (1 hour to 7 days),
   which models they may use, and an optional daily limit (messages a day, dollars a day).
3. Tick **This person is 18 or older**. Sara is for adults; there is no age check beyond this and the
   member's own confirmation.
4. Press **Make invite**. You get a link and a code, **shown once**. Send them privately. The invite
   works **once** and stops at its expiry time. Pending invites are listed until used, expired or
   revoked.

### Joining (member)

1. Open the link (or the sign-in page → **I have an invite** → type the code).
2. Confirm **I am 18 or older**.
3. Sara shows **your member token once**. Save it in a password manager: it is how you sign in on
   other browsers and apps. Your browser is signed in already.
4. Accept the AI notice for your companion, like every new user, and start talking.
5. Optional: **Settings → Your account → Devices and sign-in** to add a passkey, two-step sign-in, or
   pair a phone.

The phone and desktop apps, VS Code, `sara-chat` and the MCP bridge sign a member in exactly like the
owner (member token on the sign-in page, a pairing code or QR from your own Devices page, or a device
code you approve while signed in as yourself). They only ever see your space. Your API keys for other
apps (`/v1`, `/mcp`) are made on your own Devices page and only reach your companions.

### What the owner sees about members

Only what's needed to manage the bill: each member's name, status, when they joined, **messages a
day** and an **estimated cost per model** (from the token counts). Never their conversations,
memories, companions' names or characters, moments, documents, devices or settings.

Said plainly: Sara's app gives the owner no way to read your space. But whoever runs a server can
technically read its disk (and the owner's server backup contains every space, encrypted when it
leaves the server). If that matters to you, run your own Sara.

### Limits (owner)

Per member, in Settings → Household (saved as you change them):

- **Models they may use**: any of the owner's chat models. A member's companions use the first one
  unless the member picks another of them. Every model call made for the member (replies,
  memory notes, captions, summaries) is checked against this list.
- **Messages a day** (none, 20, 50, 100, 200, 500): their own messages to their companions.
- **Cost a day** (none, $0.10 … $10): estimated from the token meter and the price table; local
  models count as $0. When reached, their companions pause until midnight (server time zone).
- **Voice** (voice notes, read-aloud, live calls) and **Pictures from her** (her photos, new looks)
  on or off.

### Suspend, remove, delete (owner)

- **Suspend**: they can't use Sara until you resume them (they see a short note). Nothing is deleted.
- **Remove**: they are signed out everywhere and can only sign in to **Your account** to download
  their data, for **7 days**; then their space is deleted for good. **Delete now** skips the wait
  (for example when they already have their export).

### Your account (member)

**Settings → Your account**: who you are on this server, your limits, sign-in and devices, **Download
my data** (one JSON file with every companion's conversations, memories, planner and more), and
**Delete my account** (asks for your member token or two-step code; deletes your whole space at once).

### Adult mode

Per member, per companion, exactly as for the owner: off by default, switched on only in a web
browser with the member's own 18+ confirmation, never from the apps and never on the demo. The owner
can't switch it on or off for a member. The minors block, crisis help, the AI notice and the honesty
rule apply to everyone, whatever any setting says.

### The demo server

Household mode is off on the demo server (the server refuses every household route).

---

## Part 2 · Design

### One space per person, one folder per space

```
<data>/                         the owner's space: exactly the layout Sara has today (no migration)
<data>/household.json           members (name, status, limits) and pending invites (code hashes only)
<data>/members/<id>/            a member's space: a complete Sara data folder of its own
    owner.json                  the member's sign-in (token hash, session secret, passkeys, devices, API keys)
    settings.json               the member's own settings (never the owner's server settings)
    sara.db                     their first companion's database
    persona.json, uploads/, library/, look files …
    companions/<id>/            their other companions (the Phase 31 machinery)
    groups.json                 their group chats (only their own companions)
```

A space is built by the same code that builds the owner's companions (`buildCompanion` in
`src/main.ts`, through `buildSpace`), so every store, worker and route a member uses is the same
code, pointed at the member's folder. Nothing is filtered with a `WHERE member = …` clause: a
member's request is served by objects that **only have their own folder**.

With no members, nothing changes: `household.json` and `members/` don't exist, the front server routes
every request to the owner's companions as in 1.x, and every 1.x test passes unchanged.

### Who is asking (front router)

`src/main.ts`'s front server resolves the **person first**, then the companion inside that person's
space (`pickCompanion`, as in Phase 31):

1. A session cookie, a device token (`sara_dev.<id>.…`) or a member token (`sara_m.<member>.…`)
   that a member's `owner.json` knows → that member's space. Each space has its own HMAC session
   secret, so a cookie can verify in exactly one space.
2. Sign-in requests with no credential yet are routed by what they carry: a member token on
   `/api/login`, a pairing code issued for a member (`/api/pair/redeem`), a member's passkey id
   (`/api/passkey/signin`). The front reads these small JSON bodies (≤ 64 KB) and hands the same
   bytes on.
3. Everything else → the owner's space (as today). An owner credential never verifies anywhere else,
   and a member credential that reaches the owner's space (it can't, but if it did) fails the owner's
   checks: 401.

Inside a space, the server for each companion is the normal `createSaraServer`, built with
`member` set. Every route still checks sign-in against **that space's own** `owner.json`, so routing
is a convenience and the space's own auth is the gate: a wrong route gives 401/403/404, never data.

### What is shared, read-only or owner-controlled

| Shared thing | How a member reaches it |
|---|---|
| Model providers and their keys | `MemberSettings` shows the owner's providers **filtered to the models allowed for this member**, without addresses or key status. `MemberVault` returns only allowed providers' keys and the voice/picture keys (when that switch is on), and refuses every write. `resolveProvider` (the one place every model call goes through) checks the model and the daily limits (`app.member`) |
| Model lists, prices | Read-only (filtered) |
| Local voice engine, subscriptions as models | Used by the member's turns when the owner allowed that model / voice |
| Private local mode | Server-wide: it applies to members too; only the owner switches it |
| Log, redactor, sandbox detection | Server-wide; the log never holds message text (unchanged rule) |
| The owner's Microsoft app (M1 mail) | Read only: a member's *Sign in with Microsoft* uses it; their mailboxes, tokens and app passwords are in their own vault (`members/<id>/mail`), never the owner's. Google's sign-in is not shared (members add Gmail with an app password). The policy pin `memberMail: false` switches members' mail off. See [EMAIL.md](EMAIL.md#who-can-use-it) |
| Device-code requests, pairing codes, passkey challenges | One registry for the server; the code itself grants nothing; the person who approves or makes it decides whose space the token belongs to |

Everything else (stores, memory, planner, library, moments, scrapbook, uploads, look, approvals,
events, push subscriptions, usage meter, reminders, workers, group rooms) is per space.

### What a member's server refuses

A member's server answers only an **allowlist** of route families (`MEMBER_ROUTES` in
`src/household.ts`): sign-in and devices of their own, conversations and live calls, events, persona
and studios, look and pictures, voice, memories, planner (projects, tasks, notes, reminders, places),
today/briefing/review, library, moments, scrapbook, story, together, find, uploads, reports, usage
(their own), export, settings (their own keys), providers (read-only, filtered), adult mode,
companions, group chats, character files and the gallery, push and phone helpers, their own
mailboxes (`mail`, except setting up the Microsoft app), Your account.
Every other family (backups, updates, doctor, logs, status, health history, access, private local
mode switch, local models, subscriptions, providers' writes, tools and approvals settings, search,
MCP, bridges, GitHub, Google, Home Assistant, workspaces, jobs, previews, team, code map, coding
projects, starters, recipes, history and companion imports, other-apps switches, household admin)
answers **403** with `ownerOnly: true`. The tool registry of a member's companion is built from a
safe list only (planner, scrapbook, moments, recall, library, personality tuning, pictures, shared
lists, closet, settings guide); the built-in file, shell and web-fetch tools and every
server-acting tool are never added.

### Limits and money

`app.member` (a `MemberPolicy`) is set on every AppContext of a member space:

- `checkModel(providerId, model)`: the model is in the member's allowed list (else a plain error).
- `checkBudget()`: today's own messages (all their companions) and estimated cost (their usage
  tables) are under the owner's limits. Called before every model call, so background work stops too.
- `voice` / `pictures` switches: voice routes and picture tools are refused when off.

### Removal and deletion

Remove = status `leaving` with `deleteAfter` (7 days): all sign-ins keep working only for the
`/api/household/me…`, export, session and sign-out routes. A sweep deletes the folder when the time
is up; Delete now / Delete my account do it at once: workers stopped, databases closed, the folder
removed (`rmSync` with retries), the record dropped. Invites are single-use: the hash is removed when
redeemed or revoked, and expired ones are swept.

### Backups and exports

The owner's server backup includes every space (`members/*/sara.db` and `members/*/companions/*/sara.db`
are snapshotted with `VACUUM INTO` like the owner's); restore puts everything back. The off-site copy
is encrypted with the owner's passphrase as before. A member's **Download my data** is
`exportAll` over each of their companions in one JSON file. The owner's own export covers only the
owner's space.

### Safety and disclosure

Every member turn goes through the same `runTurn`: `SAFETY_BOUNDARIES`, the AI notice at first use,
each session start and every 3 hours (per companion, per space, so each member gets their own), the
honesty rule, crisis resources (988 marked US-only) and the minors block. Members confirm 18+ when
they join; the owner confirms it when inviting. Adult mode is per member companion, web-only, with
the member's own confirmation.

### Not in 2.0 (deferred, on purpose)

- Rooms with companions of different people (group chats stay within one person's companions).
- Powerful tools for members (shell, files, jobs, browser, accounts, MCP): off, no per-member opt-in yet.
- Members importing ChatGPT/Claude history or other companion apps' chats (owner only for now).
- Telegram/Discord bridges for members.
- A member's own off-site backup (their export file is the way to take data with them).
- Smart-home presence (2.1): it reads the owner's Home Assistant, which members don't have, so it is
  the owner's only.

### Alexa (2.1)

Each member links their own Alexa: Settings → Connections → Other apps → *Talk to her through Alexa*
→ **Make a link code** in their own space. The code (and later every request from that Amazon
account) is tied to the member's space and the companion that was open, so their Alexa only ever
reaches their own companion; the owner's list doesn't show it. The skill itself and its ID are the
owner's (one skill per server). A paused or removed member's Alexa answers nothing, and deleting a
member removes their links.
