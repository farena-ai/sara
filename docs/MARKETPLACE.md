# Shared by friends: the community marketplace (U4.27)

People in a Messages community, or two linked friends, share useful things with each other: skills,
prompt or workflow templates, automations, team recipes and links to Sara Store add-ons. Each Sara
checks every item itself before anything is installed, shows exactly what installing does, and asks.

Where: **Settings → Skills & tools → Get more → Shared by friends** (owner only).

## What you can share

| Kind | What crosses | What installing does |
|---|---|---|
| Skill | the SKILL.md text only (name, description, steps); never its files | adds the skill **on trial** (she uses it only for a strong match; switch it off in Skills) |
| Template | a prompt or workflow in plain words | adds it as a skill on trial |
| Automation | its definition (name, when, steps) | adds it **paused**; nothing runs until you turn it on |
| Team recipe | its plan (helpers, steps, delivery), through the team-recipe importer | adds the recipe; a team run still shows its plan and asks |
| Store add-on | only its Store id | opens it in Get more, where the Store shows its own signed review card |

Nothing executable crosses: no scripts, files or code, no keys or settings values.

Each listing has a name, a description, a version, the author's server name, the permissions it needs
(tool names and setting names it works best with) and a content hash.

## Checks (on the receiving server, before every install)

- **Content hash**: recomputed here over everything shown (id, kind, text, version, author,
  permissions, payload); a mismatch refuses the item. Install sends the hash you reviewed: if the item
  changed since, it asks you to review it again.
- **No secrets**: the redactor's key-shaped patterns and `name = value` secrets anywhere in the item.
- **No hard-limit tools**: the team-run hard limits (commands, sign-ins, settings, deletes…) plus the
  computer, mail sending, the vault and skill saving; tools that run commands on this server too.
- **No protected settings**: keys, sign-ins, privacy and private local mode, adult mode, household and
  kid settings, policy, models and providers, updates, sharing, support/repair, Messages, mail.
- **Size caps**: 80-char name, 600-char description, 24,000-char skill text, 32,000-char payload,
  20 tools, 20 settings.
- **Tools exist** here; automations use only time, calendar or email triggers and notify, task or
  email-draft steps (never "send without asking"); team recipes never use the computer.
- **Store links** only to an item in this server's own signed Store list.

The sender runs the same checks with its own tools before anything leaves (a secret never leaves),
and the keeper checks shape, size, secrets, hard limits and protected settings again.

## Updates, ratings, reports

- Share again with a new version number to update. Everyone who installed it gets a notice; nothing
  changes until they review and install the new version (skills start on trial again, automations
  stay paused).
- Stars (1-5) and a short comment, one per server per item.
- Report: the community's owner (or, on a friend shelf, the friend who shares) sees the report and can
  remove the listing. Authors can withdraw their own.

## Privacy and who can use it

- Owner only: household members, kid spaces and the demo have no Messenger, so no marketplace (403).
- Private local mode: nothing is fetched from or sent to other servers; the peer endpoint refuses.
- Only server names, item text, ratings and reports travel; comments and reports pass the redactor.

## Design (one page)

- **Built on S9a** (src/messages.ts), no new handshake: every call is signed with the link's own
  Ed25519 key under the scope word `market` and the op (`market\n<link>\n<time>\n<op>\n<sha256(body)>`),
  so message, support or repair signatures never pass here; body ids are remembered (replay → 409).
  `Messenger.linkInfo(link)` (new, small) gives any link's kind and community.
- **Keeper**: a community's shelf lives on its host (the community's owner); a friend shelf lives on the
  server of the friend who shares. The keeper derives the place from the calling link (a member's link →
  its community; a direct link → that friend's shelf), never from the body.
- **Peer ops** `POST /msg/v1/market/<op>`: `list`, `get`, `publish` (community members), `withdraw`,
  `rate`, `report`, `subscribe`; `notice` goes keeper → subscriber when a new version is out.
- **Owner API** `/api/market…` (src/routes/market.ts): places, browse, items, publish, review, install,
  rate, report, remove, dismiss report.
- **Storage**: its own `market.db` in the data folder (listings, ratings, reports, subscribers,
  installs, seen ids), closed with the Messenger.
- **Installers reuse what exists**: `SkillStore.save` (source imported) + `setLearned(trial)`,
  `Automations.create/patch` + `setEnabled(false)`, `TeamRecipes.importJson` (drops unknown and
  hard-limit tools, the computer, foreign models, redacts secrets), Get more's own Store search.
- **Code**: src/market.ts (checks, keeper, wire, installers), src/routes/market.ts, web/market.js,
  section in web/index.html (Get more), styles in web/store.css; tests in test/u4-market.test.ts
  (three in-process servers: a community host, a member, a linked friend).
