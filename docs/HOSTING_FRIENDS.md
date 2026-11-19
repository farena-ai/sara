# Host a Sara for a friend (W2.3)

Give a friend their own Sara on your server. It is not a household membership: no shared boards, no
Family, no shared sign-in rules or member tools. They bring their own model and set their own spending
limit. You see only how much they use it, and you can pause or remove it.

## For the owner

1. **Settings → Household → People on this server → Host a Sara for a friend.**
2. Type their name (a label only you see), pick how long the invite works, tick **This person is 18 or
   older**, and press **Make invite link**. Send them the link (or the QR code) privately. It works once.
3. Their card shows **On / Paused / Closing** and their totals for the last 7 days: messages, tokens and
   about how much it cost. Nothing else.
4. **Pause** stops their Sara at once (they see "paused", nothing is deleted); **Turn back on** undoes it.
5. **Remove** gives them 7 days to download their data (Settings → Your account → Download my data); they
   get a notification on their devices (if they turned notifications on). After that, or with **Delete now**, their space is deleted.

## For the friend

1. Open the link, tick **I am 18 or older**, press **Join**. Save the token you're shown.
2. **Settings → Household → Your account → Your model:** the address of any OpenAI-compatible service
   (OpenRouter, OpenAI, Ollama Cloud, or a model on your own computer), your API key and the model's name.
3. **Your spending limit:** dollars per day and per month (0 = no limit). At the limit, paid calls stop.
4. **Download my data** takes everything with you at any time.

## What the owner can and can't see

- **In the app (screens and API): only** your name, whether your Sara is on, and your 7-day totals. Not
  your chats, memories, notes, library, project names, which models you use, or your keys. The owner's
  per-person export/delete (Data rights) and usage reports don't include your space.
- **Your keys** (your model's API key, your mailboxes) are sealed with a key file of your own
  (`members/<id>/keys/master.key`), not the server's key, and are not in the owner's vault.
- **Plainly:** whoever runs a server can technically read its disk, including your key file and your
  database, and the server's backups contain your space. Sara has no screen or route that shows it to
  them, but it isn't encryption the owner can't get around. Host only for people who trust you, or run
  your own server.
- Your Sara runs with the safe tool set household members get: no commands, coding tools or computer use
  on the owner's machines, no add-ons or MCP servers of your own (the owner runs the server).

## Design (one page)

- **Exists and reused:** household member spaces (`src/household.ts`, Phase 71): `members/<id>/` with its
  own sign-in, databases, companions, the front router (`spaceByCredential`), invites (hash-only codes,
  18+ twice), pause, the 7-day export window and deletion, member route rules (`memberRouteCheck`), the
  safe tool set, push notifications per space. Spend limits (C8, `/api/spend`), providers
  (`/api/providers`), Vault (AES-256-GCM with a key file). Separate Linux instances (`deploy/lib-instance.sh`,
  "Shelton") stay the option for full separation; they need root, so they're not offered from the app.
- **New:** a `hosted: true` flag on the member and invite record.
  - `HouseholdStore.members()` = household only; `hosted()` = friends; `everyone()` = both (start-up,
    removal sweep). Boards, Family, sign-in rules, member tools, app updates and safety counts all read
    `members()`, so friends are out of every shared feature with no further edits.
  - `src/hosted.ts`: `HostedSettings` (their own file incl. providers/prices/model lists; server-wide keys
    such as MCP servers, plugins, backups and shell network are dropped), `hostedVault` (own key file),
    `hostedView` (the owner's totals-only row).
  - `memberRouteCheck`: friends may also write `providers`, `usage` and `spend`; `family`, `boards`,
    `columns`, `hands`, `computer` and `alexa` are refused. `MemberPolicy.checkModel` lets their own models
    through; pause/limits still apply.
  - Owner routes `/api/household/hosted[...]`: `POST invites`, `GET`, `GET/PUT :id` (status, name),
    `POST :id/remove` (export window + notification), `DELETE :id` (after Remove only). Member controls
    (`/api/household/members/:id`) answer 404 for friends.
  - `src/main.ts`: friends' spaces get `HostedSettings`/`hostedVault`, their mail vault uses their key, and
    they are left out of Data rights spaces and usage report sources.
- **Tests:** `test/w2-friend.test.ts` (store, routes, policy, settings, keys, owner view) and
  `test/w2-friend-isolation.test.ts` (real server, two fake models: the friend's turn goes only to their
  model with their key; 27 owner routes checked for the friend's marker, key, model and address).
