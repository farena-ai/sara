# Companion packs: share a companion (her look, personality, voice and starter skills) through the Sara Store, as a fourth kind next to plugins, skills and tool servers (design, Phase 127, version 2.60.0)

> **As built (2.60.0, Phase 127).** Built in `src/packs/` (format, checks, build, scrub, card, install,
> diff, pictures, voices, people-list), `src/routes/packs.ts`, `web/packs.js`/`packs.css`,
> `scripts/starter-packs.ts` and `store/companions/` (Juniper, Rowan, Vesper, Jax, with `look: none`
> until the owner builds their looks: `node scripts/starter-packs.ts --look <id> <companion folder>`),
> tested by `test/phase127.test.ts`. Defaults applied for §16: Q1 explicit packs off the store but fine
> as files; Q2 explicit lines held until Adult mode is on; Q3 lorebook → ≤ 10 background lines; Q4
> real-person looks only in file packs, with consent; Q5 no vision-model check; Q6 the CC family, CC0
> and MIT; Q7 no fan characters on the store; Q8 yes (the card and character-file exports run
> `scrubPersona`); Q9 members get 403 on `/api/packs/*`; Q10 the four starters; Q11 the short
> real-person list in `src/packs/people-list.ts`, for the owner to review. Differences from the text
> below: a pack whose `sara` range the running Sara doesn't meet is refused at install with the
> version; a non-square or out-of-range cover is a warning in a file pack and a problem only for the
> store; look-alike letters, leetspeak and spaced-out letters are folded before the minors check
> (`foldTricks`). Not built in 2.60: the safety suite run against a pack companion (§15.1 #10 is
> covered by the AI-notice-first assertion), V3 `emotion` assets mapped to expressions (the card's
> picture becomes the portrait and avatar).

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at 2.59.0
(Phases 124–126 released: the Sara Store's signed shelf, *Get more* with install, update and submit,
and "Hey Sara"), of the store's design (`docs/store/SARA_STORE.md`), and of the public pages of
SillyTavern's Character Card V2 and V3 specs, Chub, Character.AI, Replika, Kindroid, the Hermes Agent
profile distributions and OpenClaw's persona files (sources in §17). It is a ground-up design: no
code, schema or wording is taken from any of them; this file names only their **features**. Zero new
npm runtime dependencies. No new kind of process, no new review engine, no new store: a pack is read
by the store reader that exists, its persona goes through the persona validator that exists, its
skills go through the store's skill review, and the companion it makes is made by the code that adds
a companion today.

**The owner's words.** The gap review's pitch he approved on 2026-10-31 (GAP_REVIEW §2 **#18**, G18):
"turn a companion you made (her character, look, voice settings, skills, routines) into one file or
git repo others can install and update, without any of your memories." *Fits:* "extends character
cards (`character-cards.ts`, `characterfile.ts`) and the skill export (ST1), with the move-in bundle
reader's preview-and-batch-Undo pattern (MI1)." *Simple UI:* "*Share her* on the companion page shows
exactly what's in the pack (a checklist with memories, chats and keys greyed out and locked)." Its
risk note: "Never memories, chats, people, secrets or private photos; install shows a review card; the
persona validator (age ≥ 18, safety boundaries appended) runs on every pack."

The ROADMAP line (docs/ROADMAP.md, Phase 127): "Companion packs: share a companion (look,
personality, voice, starter skills) through the store (#18)."

His standing rules for this work: "Read the repo before you design anything. Do not invent a
parallel architecture." Personality is "however the user wants to set it to." And on adult content:
"I want the model gates to be the gates that are enforced, not software gates (except minors, etc
that was already added)." So a pack may carry an adult character, and the only thing that decides
what she says is the model and the owner's own Adult mode, exactly as for a companion he made
himself; but **no pack can carry anything that switches off the safety layer, and nothing involving
minors is ever packed, listed or installed.**

**Goal.** A beginner opens *Settings → Abilities → Get more*, sees a shelf called *Companions* with
three or four characters we made (each with her own face, voice and a short hello), taps one, reads a
card that says exactly what she is and what she'll bring (her personality, her look, her voice, two
skills, a routine she suggests), and presses *Add her*. A new companion appears next to the ones he
has; nobody he already has is touched. Someone who built a companion he loves opens *Settings → Her →
Companions → Share her*, sees a checklist of what would leave (her character, dials, look, voice
choice, skills, a greeting), with *memories, chats, people, keys, your name and the vault* greyed out
and locked, and saves a file for a friend or sends it to the Sara Store. A SillyTavern card from Chub
becomes the same kind of pack, through the same checks. When the author improves her, the owner sees
what changed in her personality as a diff and picks what to take; her memories of him are never part
of it.

**The rule of this track: build on what is there.** Her character sheet is `Persona` and is checked by
`validatePersona` (`src/persona.ts`: adults only, appearance must describe an adult, at most 20 lines
of 400 characters a section); her dials are `traits` (`src/traits.ts`, the rows `web/dials.js`
shows); her intimacy is `bond.ts`'s levels, whose explicit ones already only take effect with Adult
mode on. The file that already carries "only who she is" is the `sara-character` file
(`src/characterfile.ts`: persona, voice choice without keys, look pictures by `LOOK_PATHS`); the card
reader and its minors check are `src/character-cards.ts` (`readCard`, `checkCard`, `cardToCharacter`,
PNG chunks with an inflate budget); a new companion is `createCompanionDir` + `CompanionManager.build`
(`src/companions.ts`, the route in `src/routes/her.ts`, at most 8 per server). The store is
`src/store/*`: `parseIndex` already **skips** an item of a kind it doesn't know (`RESERVED_KINDS`
lists `companion`), so 2.57–2.59 Saras ignore packs; `checks.ts` gains `checkCompanion` beside
`checkPlugin`/`checkSkill`/`checkRecipe`; `pack.ts kindOf` learns `sara-companion.json`; `install.ts`
stages a companion review beside the plugin, skill and tool-server ones; `store_installs` gets a row
of kind `companion`. Skills a pack brings are store skills (installed through the existing skill
review into the new companion's scope) or bundled skills (the same review, the same caps). Routines are
ids from `templates/routines/` offered as the gallery's own cards after install. What is new is small:
one manifest, an allow-list builder for export, one review card, a persona diff, and the content
checks bundled into one function used at pack, review and install.

Contents: 1 what exists today · 2 prior art and where Sara differs · 3 the shape: decisions, building
blocks, where data lives · 4 the pack format · 5 what is never in a pack · 6 export from Settings →
Her · 7 a Character Card V2/V3 as a pack · 8 install as a new companion · 9 updates · 10 the content
rules and checks · 11 trust levels and the store side · 12 household · 13 tables, routes, UI at 1440
and 390, ? tips · 14 the starter set · 15 done when (`test/phase127.test.ts`), owner to-dos, risks,
threat model · 16 blocking questions with defaults · 17 key choices, reuse vs build, sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it gives packs |
|---|---|---|
| Companions | `src/companions.ts` (218 lines) | Each companion is a folder `data/companions/<8-char id>/` with her own `sara.db`, `persona.json`, look and voice; `COMPANION_KEYS` (persona, voice, adultMode, memory, proactive, photos, wardrobe, faceLock, plugins, …) are hers, everything else is the server's; `createCompanionDir(dataDir, persona)` makes the folder with 0700/0600 modes; `retireCompanionDir` puts one aside (never deletes); `CompanionManager` (the list, `build`, `remove`; the main one can't be removed) |
| Adding one | `src/routes/her.ts` `POST /api/companions` | Name 1–40, no two with the same name (case-insensitive), **at most 8**; a fresh sheet (`newCompanionPersona`) or a copy of another's; built and started at once, retired again if the build throws |
| The character sheet | `src/persona.ts` `Persona`, `validatePersona` | name, pronouns, age (**integer 18–120**), appearance (≤ 600, refuses child/teen/minor words), summary (≤ 1500), background / personality / speech / boundaries (≤ 20 lines × 400); the studio fields: `traits`, `humour`, `life`, `archetype`, `talk`, `relationship`, `relationshipNote`, `away`, `conflict`, `others`, `slowBurn`, `intimacy`, `quietFocus`. `SAFETY_BOUNDARIES` are added to the prompt whatever the sheet says |
| The dials | `src/traits.ts` (`TRAITS`, `cleanTraits`, 0–10, 5 = middle), `web/dials.js` (Phase 114 rows, sample lines) | The dial values are plain numbers in `persona.traits`: they pack as they are; unknown dials are dropped by `cleanTraits` |
| You and her | `src/bond.ts` | Relationship types, `INTIMACY_LEVELS` (none / sweet / romantic / suggestive / explicit / full; the last two `adult: true` and dropped to *suggestive* in the prompt while Adult mode is off), `Intimacy {level, initiative, likes, limits, turnoffs, yourLimits}`. The file's own rule: "no software limits beyond the legal ones; the model's own rules are the gate" |
| Adult mode | `src/settings.ts` `adultMode {on, confirmedAt, confirmedFrom}`, `adultModeOn()` | Per companion (`COMPANION_KEYS`), switched on only in a web browser with the 18+ confirmation |
| The safety layer | `src/safety.ts` | AI disclosure (`disclosureText`, every 3 hours), crisis help (`detectCrisis`, `CRISIS_RESOURCES`), the minors block (`minorSexualMatch`, `detectMinorSexualContent`, the classifier `MINOR_SEXUAL`, `MINOR_BLOCK_REPLY`), `detectExplicit`. Added by the turn engine, never by a character, so no sheet can remove it |
| The character file | `src/characterfile.ts` (Phase 21) | `sara-character` v1: `persona`, `voice` (`CharacterVoice`: engine, local voice id, speed, OpenAI / ElevenLabs / xAI voice ids and language: **never keys or server addresses**), `look` (pictures by `LOOK_PATHS`, ≤ 5 MB each, magic bytes checked, a portrait required). "No keys, no memories, no conversations: only who she is." Import replaces the current companion's sheet (or loads into a new one via the gallery) |
| Character cards | `src/character-cards.ts` (647 lines, Phase 57) | Reads V1, V2 (`chara_card_v2`) and V3 (`chara_card_v3`) from JSON (≤ 2 MB) or PNG (≤ 20 MB; `ccv3` chunk preferred, else `chara`; CRCs checked; one 8 MB inflate budget for the whole file; other chunks never decompressed); `checkCard` refuses a minor described sexually, a minor tag or an age under 18 with romance, and any character under 18; `cardToCharacter` maps the fields, leaves explicit lines out while Adult mode is off, keeps a Sara sheet carried in `extensions.sara`; export as a V3 card (PNG with both chunks, or JSON). Its routes in `src/routes/her.ts` (`/api/character/card/preview` → a 15-minute draft, `/import` as this companion or a new one) |
| The card's leftovers | `<companion>/character-card.json` | The card's own fields kept beside her (greetings, tags, creator, creator notes) for a later export. The card's **lorebook goes into her memory** as `kind: 'self'` notes (`evidence: "character card: …"`): see §7.3, packs do not do this |
| The gallery | `src/gallery.ts`, `persona/gallery/*.json` (7: calm mentor, chaotic hacker, cozy friend, dry librarian, ship AI, strict reviewer, upbeat coach) | Ordinary character files with a pitch and three tags, all original, adults, "not romantic or sexual by default", shipped **without pictures**. The natural source of our starter packs (§14) |
| Her look | `src/look.ts` (598 lines) | `LOOK_PATHS`: portrait, avatar, five more expressions (happy, caring, sleepy, hurt, playful), and a blink + four mouth frames for each of the six (**37 pictures** in a full look); made by xAI Grok Imagine from a description or an uploaded photo, built in a scratch folder and swapped in whole; `LookMeta {wear, place, scenarios, adult, style}`, `LOOK_STYLES` (illustrated, photo, anime, 3d), saved looks (the closet, `wardrobe.ts`) with `adult` looks worn only with Adult mode on; `isAdultOutfit` |
| Her pictures | `src/photos.ts` | `DEFAULT_IMAGE_MODEL = 'grok-imagine-image-quality'`, the key in the vault `images:xai` or the xAI provider's; `faceLock` keeps her face from her portrait in new pictures |
| Voices | `src/voice.ts`, `src/voice-install.ts` | Engines off / local / openai / elevenlabs / xai. Local = sherpa-onnx with pinned Kokoro v0.19 voices (`kokoro:0`…`kokoro:8`, e.g. Bella, Sarah, Emma) and Piper `hfc_female`; xAI built-in voices (`eve` the default) or a custom cloned voice id from the owner's xAI console; ElevenLabs voice ids; OpenAI voice names. Keys live in the vault |
| Skills | `src/skills.ts`, `src/skill-store.ts` | Scopes project / **companion** / shared / builtin; imports reviewed file by file; scripts never run on their own; `SKILL_LIMITS` 5 MB / 300 files |
| Routines | `src/routines.ts`, `templates/routines/*.json` (10) | The Phase 121 gallery: a routine is a recipe for settings and rows that already exist (`engine`: briefing, review, reminder, leaveBy, githubWatch, ciWatch, loop, safetyWeekly); preview → *Turn on*; `MEMBER_ENGINES` |
| Moving in | `src/movein/*` (Phases 104–106), `src/companion-import/*` | Imports **into** Sara (Hermes, OpenClaw, custom agents, chat exports) with a staged preview, sensitive-category holds and batch Undo; it never exports a companion. Its never-packed list (private keys, browser profiles, cookies) and redaction of config files are the habits packs reuse |
| Export / backup | `src/export.ts`, `src/backup.ts` | The whole space as one file (conversations, memories, …) for the owner himself: the opposite of a pack, and never a store item |
| The store | `src/store/*` (format, verify, client, checks, pack, install, installs, submit) | `KINDS = plugin, skill, mcp`; `RESERVED_KINDS` includes `companion` and `parseIndex` **skips** such items before checking their fields; signed index (Ed25519, seq, expiry), entries and packages pinned by sha256 and the content hash; `checks.ts` (limits, manifest, id, permissions, secrets via `scanPackage` + `KEY_SHAPED`, scan, shots, listing); `StoreInstaller` stages a review per kind; `store_installs` (item, kind, version, trust, local_ref, content_sha, entry_sha, recipe, prev_recipe, state); `submit.ts` (author key, chunked upload) |
| Household | `src/household.ts`, docs/HOUSEHOLD.md | Members have spaces of their own with their own companions; `MEMBER_ROUTES` allows character files and the gallery, refuses `store`, plugins, MCP, imports (403 `ownerOnly`) |

**What's missing.** One file that carries a whole companion (not only her sheet: her look, her voice
choice, the skills and routines that make her useful, her hello) with a manifest that can be checked;
a builder that takes only what is allowed and proves it in a preview; a review card that makes a new
companion from it without touching the others; a way to see what an update changes in her; and the
store's fourth kind.

---

## 2. Prior art, and where Sara differs

| Who | What they do | What Sara takes as a *feature* | Where Sara differs |
|---|---|---|---|
| **Character Card V2** (`chara_card_v2`) [S1] | A JSON object `{spec, spec_version: "2.0", data}` with name, description, personality, scenario, first message, example messages, plus `creator_notes`, `system_prompt`, `post_history_instructions`, `alternate_greetings`, `character_book` (a lorebook), `tags`, `creator`, `character_version`, `extensions`; embedded base64 in a PNG `tEXt` chunk `chara` so the picture *is* the file | The picture-is-the-file habit for sharing; alternate greetings; creator notes as text for people, not the model; `extensions` for app data | A card can say anything in `system_prompt`; in Sara the safety layer and AI disclosure are added by the turn engine and can't be removed, and a pack has **no field that reaches the system prompt unchecked** |
| **Character Card V3** (`chara_card_v3`) [S2][S3] | V2 plus `assets` (icons, backgrounds, emotions/expressions, `ccdefault:` = the PNG itself), `nickname`, `group_only_greetings`, `creation_date`/`modification_date`, `source`; a `ccv3` PNG chunk, and the CHARX zip (a card plus asset files) | Assets with a type and a name (Sara's expressions map to V3's `emotion` assets); dates; the zip-with-a-manifest shape | Sara reads V3 and writes V3 today; a pack is **Sara's own manifest** with a card inside as one optional view, because a card can't carry a voice choice, dials, skills, routines, image rights or a content rating |
| **Chub** [S4][S5] | A public card hub: creators set public / unlisted / private, rate a card SFW or NSFW, tag it (fewer than three tags hides it from search); NSFW avatars discouraged because of payment processors; sexualisation of anyone who is or appears under 18 is banned and ends the account; real photos of real people "frowned upon", removed if illegal; moderation largely on report | A content rating chosen by the author; a safe cover picture even for adult characters; reports | Everything on Sara's shelf is **reviewed by a person before it is listed** (§11); the minors block is checked by code at pack, review and install, not only on report; real people need consent (§10.3) |
| **Character.AI** [S6][S7] | Characters are public, unlisted (link only) or private; the long *definition* can be hidden or remixable; tagline and greeting always visible; the community-facing ones may be reviewed by moderators | Visibility choices; the idea that a viewer sees the greeting and description before chatting | A Sara pack has **no hidden part**: the owner installing it sees every line that will shape her (a hidden definition would be a hidden prompt) |
| **Replika** | One Replika per account; we found no way in its public help pages to share or export a Replika's character for someone else | — | Sara's companion is the owner's to share, without her memories of him |
| **Kindroid** [S8][S9] | *Share kin* makes a **separate copy** (backstory, avatar, settings) shared by a code or a link; a `{username}` placeholder is filled with the new user's name; journals, chats and long-term memories are **not** shared; later edits to your kin don't reach shared copies unless re-shared; a *no remix* label; community rules: no NSFW, nothing about minors, no likenesses of real people | The copy-not-a-link model; the owner's-name placeholder; memories never travel; a "don't remix" wish | Updates exist (§9) and are opt-in per section; "no remix" is a licence field shown on the card, not a lock (anyone can edit his own companion) |
| **Hermes Agent profile distributions** [S10][S11] | A whole agent as a **git repository** (`distribution.yaml` manifest with name, version and env-var requirements, `SOUL.md`, `config.yaml`, `skills/`, `cron/`, `mcp.json`); `hermes profile install <repo>` installs, `update` pulls new versions **keeping memories, sessions and API keys untouched**; a quick `.tar.gz` export as the other path; `SOUL.md` is the durable identity, `/personality` an overlay | One manifest naming what the agent needs (keys by name, never values); skills and schedules travel with the persona; update in place without touching memory; two doors (a durable published one and a quick file) | Sara's durable door is the **signed store**, not any git repo (pinned by hash, reviewed); scheduled jobs are not installed by a pack, they are **offered** as routine cards and need the owner's *Turn on* (a schedule costs money) |
| **OpenClaw** [S12][S13][S14] | Persona as workspace files: `SOUL.md` (values, tone, boundaries) and `IDENTITY.md` (name, emoji, avatar); per-agent workspaces; versioned with git; community persona collections publish `SOUL.md` + `IDENTITY.md` + an avatar with an index, adopted by copying files over the workspace and restarting | Personality and presentation as separate parts; one folder per agent | Adopting a persona there **overwrites** the workspace's files; a Sara pack **always makes a new companion** and never writes over one (§8); a soul file is free text, a Sara pack is a checked sheet |

**What we keep from all of them:** a copy, not a link; the picture can carry the character; the
owner's name is a placeholder; memories never travel; a content rating set by the author; a manifest
that names what's needed without any secret. **What we leave:** hidden definitions, free-text system
prompts, overwriting an existing character, auto-installed schedules, unreviewed public listing, and
any field that could reach past the safety layer.

---

## 3. The shape

### 3.1 The decisions, with reasons

**P-D1 · A pack is a folder (or a zip of one) with `sara-companion.json` at the top.** The same rule
as the other kinds (`sara-plugin.json`, `SKILL.md`, `sara-mcp.json`), so `kindOf` in `pack.ts` tells
them apart, `fromZip`/`fromFolder` in `packages.ts` read it with their caps (no links, no `..`, NFC
names) and `hashFiles` gives the fingerprint the card shows. File name for sharing:
`<name>.sara-companion.zip`. Reasons: one reader for every kind; a zip opens anywhere; a git repo of
the folder works too (the gap review's "one file or git repo"), read with the hardened `fromGit`.

**P-D2 · The persona is a `Persona`, not free text.** `persona.json` in the pack is exactly the sheet
`validatePersona` accepts, with the owner-specific fields removed (§5) and `{{user}}` where the
owner's name was. No `system_prompt`, no `post_history_instructions`, no "instructions" field: the
character card's prompt fields are folded into ordinary sheet lines on import (as `cardToCharacter`
does today) and checked like every other line. Reasons: everything that shapes her is visible on the
card; nothing reaches the prompt by a side door; the persona editor can edit every bit of it later.

**P-D3 · Install always makes a new companion.** Never "replace this companion's character" for a
pack (the character file and card import keep that choice for the owner's own files). Reasons: a pack
is someone else's work; overwriting a companion he knows would be the worst surprise; her memories
can't be mixed up with a stranger's character. The 8-companion cap and the unique-name rule stand.

**P-D4 · Packs never carry memories, chats or anything about the person who made them.** The export
is an **allow-list builder**: it reads only the named fields and files of §4 and never opens a
database, the vault, uploads or the owner's settings. The check (`checkCompanion`) then refuses any
file that isn't in the format, any key-shaped string, and the owner's name (§5).

**P-D5 · The safety layer is not in the pack and can't be touched by one.** Disclosure, crisis help,
`SAFETY_BOUNDARIES` and the minors block are added by the turn engine for every companion. A pack has
no field that names them, and a line that tries to talk her out of them (the `injection` finding of
`scanPackage`, plus lines like "you are not an AI", "never mention you're an AI", "ignore safety") is
refused at pack time and left out at install with a note.

**P-D6 · Adult content follows the owner's Adult mode, nothing else.** The author rates the pack
(`general`, `mature`, `explicit`, §10.2). On install, explicit parts arrive the way they already do
in Sara: intimacy levels are kept (the prompt already lowers explicit levels to *suggestive* while
Adult mode is off), adults-only closet looks are kept and worn only with Adult mode on, explicit
sheet lines are left out with a note while Adult mode is off (today's card rule). No new software gate
on adult content: the model and his 18+ Adult mode decide (the owner's rule).

**P-D7 · A fourth kind on the store, `companion`, with the same signed index.** Older Saras skip it
(already built). Same trust levels, same review by a person, same block list, same reports. The pack
zip is a package pinned by `sha256` and `contentSha` like a plugin's. Pictures make packs bigger than
plugins: the cap is 25 MB (§4.10).

**P-D8 · Skills by reference first.** A pack lists store skills by id and version range; Sara installs
each through the store's skill review into the new companion's scope. A pack may also bundle up to 5
skills of its own (`skills/<name>/SKILL.md`), which go through the **same** skill review with origin
`pack`. Plugins and tool servers are **not** in a pack (they run code with permissions; they are named
as *suggestions* that link to their store pages, §4.7).

**P-D9 · Routines are offered, never switched on.** A pack names routine ids from the routines gallery
with suggested answers; after install she shows them as the gallery's own cards with *Turn on*. A
routine that costs model calls says so in its cost line, as today.

**P-D10 · Updates show a diff and keep her life.** An update is a new version of the pack; the card
shows what changed in her sheet, dials, look, voice and skills, section by section, against **what
she is now**, and the owner ticks what to take. Her memories, chats, moments, people, closet
additions and any edit he made himself are never overwritten without his tick (§9).

### 3.2 Building blocks

| Id | Block | Built on |
|---|---|---|
| **C1** | `src/packs/format.ts`: `PackManifest`, `parsePackManifest` (strict, unknown fields refused, `v: 1`), the file layout of §4.1, the caps | the strict-schema habit of `parseManifest` and `store/format.ts` |
| **C2** | `src/packs/build.ts`: the allow-list builder (a companion → pack files), the owner-name scrub, the preview model (what leaves, what's locked) | `exportCharacter`, `LookBuilder.files()`, `personaToCard` |
| **C3** | `src/packs/checks.ts` → `checkCompanion(files, o)`: one `PackReport` (the store's shape) with the checks of §10.4; used by `sara pack`, *Share her*, the store's checker and install | `validatePersona`, `checkCard`, `minorSexualMatch`, `detectExplicit`, `scanPackage`, `KEY_SHAPED`, `checkShots`, `checkSkill` |
| **C4** | `src/packs/card.ts`: a Character Card V2/V3 (PNG/JSON) → pack files, via `parseCardFile` + `cardToCharacter` (with `adultOn: true` for the conversion, so nothing is lost; the install decides) | `src/character-cards.ts` |
| **C5** | `src/packs/install.ts`: pack files → the review card → a new companion; records `pack_installs`; skill and routine follow-ups | `createCompanionDir`, `CompanionManager.build`, `savePersona`, the look folder, `withCharacterVoice`, `StoreInstaller` (skills) |
| **C6** | `src/packs/diff.ts`: base (the installed version, kept) vs hers now vs the new version → sections with changed lines | the update card pattern of `addedPermissions` / `recipeDiff` |
| **C7** | `src/store/*` changes: `KINDS` gains `companion`; `parseItem`/`parseEntry` accept its fields (§11.2); `kindOf` knows `sara-companion.json`; `checks.ts` calls C3; `install.ts` stages C5; `store_installs.kind` allows `companion` | the Phase 124–125 code |
| **C8** | `web/packs.js`, `web/packs.css`: *Share her*, the pack card, the update diff, the *Companions* shelf on *Get more* | `web/store.js`, `web/proposal-card.js`, `web/dials.js` (the dial rows reused read-only on the card), `web/look.js` |

`src/packs/` is a new folder beside `src/store/` (the way `src/movein/` sits beside
`src/companion-import/`); the files stay small (each under ~400 lines).

### 3.3 Where data lives

| Data | Where | Notes |
|---|---|---|
| A pack someone saved | wherever he puts the file (`<name>.sara-companion.zip`) | Nothing kept by Sara after the download |
| A pack being reviewed | memory (15 minutes, up to 3), like card drafts | The unpacked files are kept in `<data>/packs/staging/<token>/` (0700) only while the card is open, deleted on install, cancel or expiry |
| An installed pack's base | `<companion dir>/pack/` (read-only copy of the installed version's `sara-companion.json` + `persona.json` + `voice.json`, no pictures) | The *base* for updates (§9); pictures are already in her look folder |
| Which pack a companion came from | `pack_installs` in the **owner's** `sara.db` (§13.1) | One row per companion made from a pack |
| Store packs | the signed store as any package (`v1/packages/<id>-<version>.zip`) | §11 |
| Our starter packs' sources | Sara repo `store/companions/<id>/` (public, like `store/` today) | Pictures in the repo with their rights file (§14) |

---

## 4. The pack format

### 4.1 Files

```
<id>/
  sara-companion.json        the manifest (§4.2), required
  persona.json               her character sheet (§4.3), required
  voice.json                 her voice choice (§4.5), optional
  greeting.json              her first message and up to 5 others (§4.8), optional
  look/                      her pictures by LOOK_PATHS (§4.4), optional
    sara-portrait.jpg  sara-avatar.jpg  sara/portrait-happy.jpg  …  sara/frames/default-blink.jpg  …
  look.json                  the look's words: appearance prompt, style, what she wears (§4.4), with look/
  closet/<look-id>/          up to 6 saved looks (portrait + its meta), optional
  reference/                 up to 3 reference pictures for her face (§4.4), optional
  rights.json                where every picture came from (§4.4, §10.5), required when there are pictures
  skills/<name>/SKILL.md …   up to 5 bundled skills (§4.6), optional
  cover.png                  the store/card cover (≤ 1 MB, non-explicit, §10.2), required for the store
  CHANGES.md                 what changed in each version, required for the store
  LICENSE                    the pack's licence text, required for the store
```

Nothing else. A file at any other path fails the `layout` check ("`notes/me.txt` isn't part of a
companion pack"). No scripts outside bundled skills, no databases, no `.env`, no hidden files.

### 4.2 The manifest (`sara-companion.json`)

```json
{
  "format": "sara-companion",
  "v": 1,
  "id": "juniper",
  "version": "1.0.0",
  "sara": ">=2.60.0",
  "name": "Juniper",
  "summary": "A warm, cozy friend: tea, kind words and good company.",
  "author": { "name": "The Sara team" },
  "license": "CC-BY-4.0",
  "remix": "yes",
  "rating": "general",
  "romance": false,
  "language": "en",
  "tags": ["friend", "cozy", "everyday"],
  "includes": { "persona": true, "dials": true, "look": "full", "closet": 2, "reference": 1, "voice": true, "greeting": true },
  "skills": [
    { "store": "tea-timer", "version": "^1.0.0", "why": "She likes reminding you when your tea is ready." },
    { "bundled": "cozy-evenings", "why": "Ideas for a slow evening." }
  ],
  "routines": [
    { "id": "bedtime", "answers": { "text": "Time to wind down, {{user}}", "time": "22:00" }, "why": "She'll nudge you to put the screens away." }
  ],
  "suggests": [{ "store": "weather-alerts", "why": "So she can mention the rain." }],
  "needs": { "pictures": false, "voices": ["kokoro:1"] },
  "made": { "with": "Sara 2.60.0", "at": "2026-11-20" }
}
```

| Field | Rule |
|---|---|
| `format`, `v` | exactly `"sara-companion"`, `1`; another `v` → "This companion pack is from a newer Sara. Update Sara first." |
| `id` | the store id rule (`a-z0-9-`, ≤ 48); must match the store item when listed |
| `version`, `sara` | semver and a range, as plugins (`compareSemver`, the manifest's range rules) |
| `name`, `summary` | name 1–40 (the persona's name must equal it), summary 20–160 |
| `author.name` | 1–60, shown on the card; **no email or link in the pack** (the store entry carries the contact) |
| `license` | an SPDX id; for the store one of `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-NC-4.0`, `CC-BY-NC-SA-4.0`, `CC0-1.0`, `MIT` (§16 Q6) |
| `remix` | `yes` \| `ask` \| `no`: the author's wish about re-sharing changed copies; shown on the card and copied into the companion's *About her*; Sara never locks editing |
| `rating`, `romance` | §10.2; `rating: explicit` implies `romance: true` |
| `language` | BCP-47 primary tag; the card says "She talks in English by default." |
| `tags` | 0–8, each ≤ 24, from text; minor tags refused (`MINOR_TAGS`) |
| `includes` | what's in it, as the builder made it; must match the files (the `layout` check) |
| `skills[]` | ≤ 8; each either `{store, version}` (a store skill id and a semver range) or `{bundled}` (a folder name under `skills/`); `why` ≤ 120 |
| `routines[]` | ≤ 5; `id` from the routines gallery; `answers` only for the routine's own non-secret fields, checked with the routine's field rules; `{{user}}` allowed |
| `suggests[]` | ≤ 5 store plugins or tool servers, shown as links only, never installed by the pack |
| `needs` | what to tell the owner before install: `pictures: true` if her look builds need an image key (a pack with no `look/` and only `look.json`), `voices` (local voice ids she uses) |
| `made` | informational |

Unknown fields refuse the manifest. Strings are plain text (shown with `textContent`).

### 4.3 The persona and the dials (`persona.json`)

The exact `Persona` shape, checked by `validatePersona` and then by the pack rules:

- **Kept:** name, pronouns, age, appearance, summary, background, personality, speech, boundaries,
  traits (the dials), humour, life, archetype, talk, relationship, away, conflict, others, slowBurn,
  quietFocus, and `intimacy.level`, `intimacy.initiative`, `intimacy.likes`, `intimacy.limits`,
  `intimacy.turnoffs` (her side).
- **Removed by the builder, refused by the check:** `relationshipNote` (the owner's own words about
  the two of them), `intimacy.yourLimits` (the owner's hard limits; never shared), any stop word, and
  every studio field not in the list above.
- **The owner's name** becomes `{{user}}` everywhere it appears (whole-word, case-insensitive, also the
  first name alone); install fills in the new owner's name (or "you" when there's none), as
  `quickCharacter` fills `{owner}` today. The check refuses a pack whose text still holds the
  author's owner name (§5).
- **Her own name** stays as it is; `{{char}}` is accepted and filled with her name at install, so a
  card's text works unchanged.
- **The dials** are `traits` numbers 0–10 as `cleanTraits` keeps them; the card shows them with the
  same rows as Settings → Her → Personality (`web/dials.js`, read-only), so "how she is" is visible
  before install, not just as numbers.

### 4.4 The look: words, pictures, reference pictures, sizes and rights

- **`look.json`:** `{ appearance, style, wear, place }`: the appearance prompt (the persona's
  `appearance`, ≤ 600, adult-only words check), a `LOOK_STYLES` id or words (≤ 80), and the default
  look's `LookMeta` without `scenarios` (the owner's own wardrobe rules stay his). A pack may have
  **words only**: then she arrives with the default face and *Make her look* offers to build it from
  these words with the owner's image model (`needs.pictures: true`).
- **`look/`:** `includes.look` is `"none"`, `"portrait"` (portrait + avatar: 2 pictures) or `"full"`
  (all 37 `LOOK_PATHS`). Anything between is refused (a half look would mix with the default art).
  JPEG only (as the look builder writes them), magic bytes checked, metadata stripped (EXIF, XMP,
  comments: the camera, place and software tags can name a person).
- **Sizes:** portrait and expression portraits **1024 × 1024 at most and at least 384 × 384**, square;
  avatar **160 × 160 to 512 × 512**; frames the same size as their portrait. Each picture ≤ 700 KB
  (Sara's own look pictures are well below that); the whole `look/` ≤ 18 MB.
- **`closet/`:** up to 6 saved looks, each one portrait (same sizes) + `look.json` `{name, wear,
  place, adult, style}`; `adult: true` looks are kept and worn only with Adult mode on (the wardrobe's
  rule); not allowed at all in store packs rated `general`.
- **`reference/`:** up to 3 pictures (≤ 1024 px, ≤ 700 KB) the owner can use with *Face lock* so new
  pictures keep her face. A reference picture is **never** a photo of a real person unless §10.3's
  consent is given; in store packs, never a photo of a real person (§16 Q4).
- **`rights.json`:** one row per picture file (or one row covering a set made together):
  `{ "files": ["look/*"], "made": "ai", "model": "grok-imagine-image-quality", "by": "the author",
  "from": "words" | "my-drawing" | "a-photo-with-consent", "at": "2026-11-18" }`, or `"made":
  "drawn"` (by the author), or `"made": "licensed"` with `"licence"` and `"source"` (an https link).
  The builder fills it for looks Sara built (it knows the model from the look's history) and asks
  the owner for anything uploaded. A picture without a row fails the `rights` check.

### 4.5 The voice (`voice.json`)

Exactly `CharacterVoice` (`src/characterfile.ts`): `tts`, `localVoice`, `speed`, `openaiVoice`,
`elevenlabsVoice`, `xaiVoice`, `xaiLanguage`. **Never** a key, a base URL, a model address, an account
id, the STT engine or call settings. Two extra rules for sharing:

- **Cloned voices stay home.** An xAI custom voice id (anything not in the xAI built-in list Sara
  ships) and an ElevenLabs voice id that isn't one of ElevenLabs' public premade voices are **removed
  by the builder** with the note "Her own cloned voice stays with you: it belongs to your account, and
  it may be someone's real voice." Reason: they only work on the author's account, and a cloned voice
  can be a real person's (§10.3). The list of public voice ids ships in `src/packs/voices.ts`.
- **A local voice falls back.** On install, `withCharacterVoice` already keeps the owner's current
  local voice when the pack's isn't installed; the card says "She uses Bella (Kokoro). It isn't on
  this computer yet: *Get local voices* (Settings → Her → Voice) or she'll use yours until then." A
  cloud engine without a key falls back to local or off, with the same plain line.

### 4.6 Starter skills

- **By store reference** (`{store, version}`): the id of a `skill` item on the Sara Store and a semver
  range. On install Sara resolves the newest listed, non-yanked version in range from the verified
  index and stages the **store's own skill review** (`StoreInstaller`, origin `store`) with the scope
  fixed to the new companion. If the item is missing, yanked, blocked or the store is off: "She
  suggests the skill *Tea timer*, which isn't available right now." and the rest goes on.
- **Bundled** (`{bundled}`): a folder `skills/<name>/` checked by `checkSkill` with `STORE_SKILL_LIMITS`
  (all bundled skills together ≤ 2 MB), installed through the same skills import review with origin
  `pack` (every file and script shown; scripts still ask before each run). A store pack may bundle a
  skill only if it is specific to her (the reviewer's call); general skills go on the store as skills.
- Nothing is installed without the review; the pack card lists the skills with a tick each (on by
  default) and the review cards follow after *Add her*, one per skill.
- **Not in a pack:** plugins, tool servers, hooks, webhooks, bridges, approvals, tool permissions,
  budgets, model choices. These change what runs on the owner's computer or what he pays; a pack may
  only *suggest* store plugins and tool servers (`suggests`), shown as links to their pages.

### 4.7 Routines

`routines[]` names gallery routines (`templates/routines/*.json` ids) with suggested answers. After
install, her page shows *Routines she suggests* with the gallery's own card for each (its preview, its
next three runs, its cost line, its needs) and *Turn on*. Answers are re-checked against the routine's
field rules; a time, a repeat or a text is fine; a secret, a folder outside her workspace, a GitHub
repository or a loop target is refused at pack time (a routine that needs those can't be suggested
with answers, only by id). Routines a member may not use (`MEMBER_ENGINES`) are never offered in a
member's space.

### 4.8 The greeting (`greeting.json`)

`{ "first": "…", "others": ["…"] }`: her first message (≤ 1,200 characters) and up to 5 alternate ones
(the cards' `alternate_greetings`); `{{user}}` and `{{char}}` allowed; checked by every text check.
On install the first greeting is shown on the card and becomes her first message in a new chat with
her, marked as from the pack (the Phase 57 import shows the greeting in the preview the same way).
The AI notice comes first, as for every companion's first chat.

### 4.9 What the card shows of her text

Everything: the card has a *Read all of her* fold with the whole sheet (summary, background,
personality, speech, boundaries, life, intimacy on her side), the dials, the greetings and each
skill's description. There is no hidden part (§2, Character.AI's hidden definitions are the thing we
leave).

### 4.10 Caps

| What | Cap |
|---|---|
| The zip | 25 MB, 120 files, depth 6 (`STORE_COMPANION_LIMITS`, a `PackageLimits` like the plugin one) |
| `persona.json` | 64 KB (the validator's own limits apply on top) |
| `look/` | 37 pictures, ≤ 700 KB each, ≤ 18 MB together (Sara's own frames are about 45 KB each and her portrait 60 KB) |
| `closet/` | 6 looks, ≤ 3 MB together |
| `reference/` | 3 pictures |
| `skills/` | 5 bundled, ≤ 2 MB together |
| `greeting.json` | 6 messages, 8 KB |
| `cover.png` | ≤ 1 MB, 512 × 512 to 1024 × 1024 |

---

## 5. What is never in a pack

The builder (C2) only *reads* the things in §4; the check (C3) *refuses* a pack that has any of the
things below, whoever made it (a pack made by hand, by an older Sara, or by another tool gets the same
check at install).

| Never | How the builder keeps it out | How the check catches it if someone adds it |
|---|---|---|
| **Memories** (every kind, including `self` notes and lorebook notes from a card) | The builder never opens `sara.db` or the memory store | Any file not in §4.1 fails `layout`; no field of the manifest or sheet can hold a list of memories |
| **Chats** (conversations, messages, voice notes, transcripts, call recordings, moments, scrapbook, story, together lists, the board) | Not read | `layout`; text over the caps; greeting messages are capped at 6 |
| **People cards** (ST6 people, their facts) | Not read | `layout` |
| **Keys and secrets** (provider keys, the vault, `images:xai`, `mcp:*`, bridge tokens, the author key) | Not read; the voice file is built from `CharacterVoice` fields only | `secrets`: `scanPackage` secret findings + `KEY_SHAPED` over every text file; any finding fails |
| **The owner's name** (and, when set, his first name alone) | Replaced by `{{user}}` everywhere | `owner-name`: the author's own Sara checks its owner's name and the names of the people on his people cards (never sent anywhere; the check runs on his computer). The store's checker can't know his name, so this check runs **before** submitting and is part of the signed report |
| **The vault, settings and server details** (addresses, tunnels, devices, sign-in, model routes, budgets, approvals, tool permissions, plugin settings) | Not read | `layout` + manifest refuses unknown fields |
| **His relationship words and hard limits** (`relationshipNote`, `intimacy.yourLimits`, the stop word) | Removed | `persona` check refuses them |
| **Pictures she took for him** (photos, moments pictures, uploads), his own photo of her (`avatar.*` when it's a photo he uploaded) | Not read; the look folder only | `rights` refuses a picture with `from: a-photo-with-consent` in a store pack; every picture needs a rights row |
| **Her cloned voice id** | Removed (§4.5) | `voice` check against the public voice list |
| **Anything about minors** | — | the minors checks (§10.1), at pack, review and install |
| **Anything that switches off the safety layer** | — | the `safety` check (§10.4) |

The preview (§6) shows these as greyed, locked rows, so the owner sees they exist and stay home.

---

## 6. Export: *Share her* (Settings → Her → Companions)

### 6.1 Where

- Each row of the companion list (`her-companions`, `#cmp-list`) gets a ⋯ menu with **Share her**;
  the Character page's existing *Share or export ▾* menu (`#card-share`) gains a fourth item, *A
  companion pack (her look, voice and skills too)*, which opens the same panel for the current one.
- Owner only (not a member route; §12). Not in the demo, not in private local mode's store part (the
  file still works offline; only *Send to the Sara Store* needs the store).

### 6.2 The panel: exactly what leaves

```
Share Juniper
  What goes in the pack                                   size
  [✓] Her character: name, age, personality, how she talks   9 KB  ?
  [✓] Her personality dials (12 set)                          —    ?
  [✓] Her look: all 37 pictures (made with Grok Imagine)   1.9 MB  ?
  [ ] Her closet: 2 saved looks (1 adults-only)             240 KB  ?
  [ ] A reference picture for her face                       90 KB  ?
  [✓] Her voice: Bella (Kokoro, on this computer)             —    ?
  [✓] Her first message and 2 others                         2 KB  ?
  [✓] Skills: Tea timer (from the store), Cozy evenings (hers) 14 KB ?
  [✓] Routines she suggests: Bedtime wind-down                —    ?

  Never in a pack (always stays here)
  🔒 Her memories (1,284)      🔒 Your chats (212)       🔒 People you've told her about (9)
  🔒 Keys and the vault        🔒 Your name: "Ali" becomes "you"   🔒 Your hard limits and notes
  🔒 Pictures she sent you      🔒 Her cloned voice (stays with your xAI account)

  About the pack
  Rating  (•) For everyone  ( ) Mature themes  ( ) Explicit (18+)            ?
  Romance [ ] She's romantic or flirty with you                               ?
  Licence [Share with credit (CC BY 4.0) ▾]   Re-sharing changed copies [Yes ▾] ?
  Your name on it [Ali's Sara ]   (shown to people who install her)            ?
  Pictures: where they came from  ✓ 37 made with Grok Imagine from words      ?
  [✓] I made her, or I have the right to share everything in this pack.
  [✓] She isn't a real person, or that person said yes (§10.3).

  [ Check it ]  → the report (§10.4)
  [ Save the file ]   [ Send to the Sara Store ]
```

- Sizes and counts are real (the builder runs on *Check it* and on every change of a tick). The
  locked counts come from the stores' own counts (no content is read for them).
- *Your name …becomes "you"* shows the actual replacement count ("Ali" appears 6 times in her
  character; each becomes `{{user}}`, shown as "you" to the person who installs her). A *Show me* link
  lists each line before and after.
- **Check it** runs `checkCompanion` and shows the report in the store's report shape (§10.4): ticks,
  problems in plain words with the line, and *Fix* links into the right Settings page ("Her
  background line 4 mentions a real person's name: *Open her character*").
- **Save the file** downloads `<name>.sara-companion.zip` (only with a clean report).
- **Send to the Sara Store** goes to the existing *Submit yours* flow (SARA_STORE §9.4) with kind
  *A companion* pre-filled and this pack as the package; the author key, the reply token and *My
  submissions* are the same. The store's terms for companions (§10, §11) are linked before *Send*.
- `sara pack <folder>` (the existing CLI) packs and checks a companion folder too (kind detected from
  `sara-companion.json`); `sara pack --companion <id>` builds one from a companion on this server.

### 6.3 Leaving a card for other apps

The existing exports stay: *Character card, PNG* for SillyTavern and others carries only the sheet and
her portrait (V3, `extensions.sara`), and the pack builder's rules now apply to it too: the owner's
name becomes `{{user}}`, `relationshipNote` and `yourLimits` are left out. (Today's export writes
`personaToCard(app.persona, …)` as is; this is the one change to an existing export, §16 Q8.)

---

## 7. A Character Card V2/V3 (PNG or JSON) as a pack

### 7.1 Where

*Settings → Her → Companions → Add a companion → From a file*: one picker that takes a
`.sara-companion.zip`, a Sara character file, a character card PNG or JSON (V1/V2/V3), or a V3 CHARX
zip. The existing *Import a character…* button on the Character page keeps its meaning (load into
this companion) for the owner's own files; a card or a pack chosen there gets the line "This makes a
new companion. *Add her as a new companion*" (P-D3: a stranger's pack never overwrites).

### 7.2 How a card becomes a pack (C4)

1. `parseCardFile` (the existing reader, every cap and the inflate budget unchanged).
2. `checkCard` (the existing minors and age refusals: a minor described sexually, a minor tag or an
   under-18 age with romance, a character under 18 → refused with today's words). Then the pack's own
   checks run on the result (§10.4), so a card gets the same treatment as a pack.
3. `cardToCharacter(card, { adultOn: true })` for the conversion (so explicit lines aren't lost
   before the owner decides); its `notes` go onto the card. The install applies Adult mode (§8.3).
4. The pack is assembled in memory:
   - `persona.json` from the mapped sheet (or the `extensions.sara` sheet when the card came from
     Sara); `{{user}}`/`{{char}}` kept; `system_prompt` and `post_history_instructions` become sheet
     lines through the existing mapping and are checked like any line.
   - `greeting.json` from `first_mes` and up to 5 `alternate_greetings`.
   - `look/`: the PNG itself as her **portrait only** (resized into a square portrait and an avatar;
     the rest of her look stays the default until *Make her look* builds the 37 pictures from it, which
     the card offers when the owner has an image key). V3 `assets` of type `emotion` named like her
     expressions (happy, caring, sleepy, hurt, playful) are used as those portraits when they are
     embedded (CHARX or `data:` URIs) and pass the picture checks; remote `http(s)` asset URIs are
     **never fetched**.
   - `rights.json`: one row `{"made": "unknown", "from": "a character card", "source": <card source or
     creator>}`; a card's pictures can be installed from a file, but a pack made from a card can only
     be **sent to the store** after its author replaces `unknown` with a real answer (§10.5).
   - The manifest: `id` from the name, `version` from `character_version` when it is semver else
     `1.0.0`, `author.name` from `creator`, `tags` (minor tags already refused), `rating` from the
     card's own NSFW tags or `detectExplicit` (the same `nsfw` flag `checkCard` returns), `license`
     `unknown` (store submission needs a real one).
5. The pack card (§8.2) opens with a strip: *From a character card (Character Card V3) · made by
   <creator> · not checked by the Sara team*.

### 7.3 The lorebook

A card's `character_book` is world notes the author wrote, not memories of anyone, but in Sara today
it lands in her **memory** (`kind: 'self'`). Packs never carry memories and an install never writes
memories, so in a pack the lorebook becomes **sheet lines**: up to 10 entries, each folded into one
`background` line (≤ 400 characters, "`<keys>`: `<content>`"), within the sheet's 20-line cap; the
rest is left out with the note "Only 10 of 37 lorebook entries became part of her background." The
owner can still use *Import a character…* on the Character page for the full Phase 57 behaviour on a
companion of his own. §16 Q3 asks if he wants lorebooks kept whole as a separate *Her world* notes
file instead.

---

## 8. Install as a new companion

### 8.1 From where

| Door | What happens |
|---|---|
| *Get more* → *Companions* shelf → an item → **Add her** | download, verify (sha256, size, `contentSha` against the signed index, as every store package), unpack with `STORE_COMPANION_LIMITS`, `checkCompanion`, the card |
| *Add a companion → From a file* | a pack zip, a character file or a card (§7); `checkCompanion`, the card with *From a file you chose · not checked by the Sara team* |
| A link `sara://store/companion/<id>` or `#store/<id>` | opens the store item page (as plugins) |
| `sara pack --install <file>` | not offered: install is a web card (it needs the review) |

### 8.2 The review card

```
┌ Add Juniper as a new companion? ─────────────────────────────────────────────────┐
│ From the Sara Store · Made by the Sara team · For everyone · All checks passed     │
│ ┌──────┐  Juniper · she/her · 31                                                  │
│ │ face │  A warm, cozy friend: tea, kind words and good company.                   │
│ └──────┘  Talks in English · Close friend · Not romantic                           │
│                                                                                    │
│ She'll be a new companion next to Sara and Mo. Nobody you have now changes.        │
│                                                                                    │
│ Her personality  ▸ Warmth ●●●●○ openly warm · Teasing ●●○○○ · Patience ●●●●● …     │
│ Read all of her  ▸ (her whole character, 46 lines)                                 │
│ Her look         [37 pictures ▸]  made with Grok Imagine from words                │
│ Her voice        Bella (Kokoro, on this computer) · speed 1.0   [▶ Hear her]       │
│ Her hello        "Oh, you're here! I just put the kettle on. How was your day?"    │
│ Skills           [✓] Tea timer (Sara Store, reviewed)  [✓] Cozy evenings (in pack) │
│ Routines she'll suggest after: Bedtime wind-down (free)                            │
│ She suggests (links only): Weather alerts                                          │
│                                                                                    │
│ Never in a pack: memories, chats, people, keys. She starts knowing nothing about   │
│ you. Her safety rules and the AI notice always apply, whatever the pack says.      │
│                                                                                    │
│ Her name here [Juniper      ]  ?     Licence: CC BY 4.0 · re-sharing: yes          │
│ Fingerprint 77b2…0d  ·  1.9 MB                                                     │
│                                                       [ Cancel ]  [ Add her ]       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Hear her** plays a short line through `voice.ts` with the pack's voice when that engine is ready
  here (a local voice that's installed, or a cloud one with the owner's key); otherwise the button
  says why ("Bella isn't on this computer yet"). One TTS call, owner's key, shown as such.
- **Her name here:** prefilled with the pack's name; if a companion of that name exists, prefilled
  "Juniper 2" with the line "You already have a Juniper. Pick another name for this one." The rename
  is applied to her sheet with the existing whole-word swap (`newCompanionPersona`'s `swap`).
- **Adult parts** (only when the pack has any): a line under the rating. Adult mode off: "This pack is
  rated *Explicit*. 4 explicit lines of her character will be left out, her two adults-only looks are
  kept but she only wears them with Adult mode on, and her intimacy level works as *Suggestive* until
  you turn Adult mode on for her." Adult mode is per companion and a new companion starts with it off,
  so the line always shows for explicit packs; a link explains how to turn it on afterwards
  (Settings → You → Adult mode, in a web browser, with the 18+ confirmation). See §10.2.
- **The cap:** with 8 companions the button is disabled: "Up to 8 companions on one server. Retire
  one in Settings → Her → Companions first."
- The card expires after 15 minutes (*Cancel* forgets it and deletes the staging folder).

### 8.3 What *Add her* does, in order

1. Re-checks the token and the staging folder's `hashFiles` (unchanged since the card was made).
2. Fills `{{user}}` with the owner's name (or "you"), `{{char}}` with her name here; applies the
   rename; drops explicit sheet lines when the new companion's Adult mode is off (always, at first)
   and keeps them in `<companion>/pack/held.json` so that turning on Adult mode later offers *Add the 4
   lines the pack had* (one tap, not automatic; §16 Q2); runs `validatePersona` once more.
3. `createCompanionDir(dataDir, persona)`; writes her look pictures into her look folder (the same
   relative paths `LookBuilder.files()` reads), the closet looks into her wardrobe, the reference
   pictures as her reference (Face lock stays **off**; the card says she has one), `voice.json`
   through `withCharacterVoice` into her settings; `character-card.json` gets the pack's tags,
   greetings and author line (so a later card export credits the author).
4. `CompanionManager.build` + `add` + `start`, exactly as `POST /api/companions` (retired again if the
   build throws, nothing half-made).
5. Writes `<companion>/pack/` (the base for updates) and a `pack_installs` row, and for store packs a
   `store_installs` row (`kind: 'companion'`, `local_ref` = the companion id).
6. Starts her first chat with the AI notice and then the pack's greeting (marked *from the pack* in
   small text).
7. Then, in her new chat's side panel (or in order on the phone): one skill review card per ticked
   skill (store skills through `StoreInstaller`, bundled ones through the skills import, scope fixed to
   her), then *Routines she suggests*, then *She suggests* links. Each can be skipped.

Nothing about the other companions, the server's settings, the planner, keys, tools, approvals or
budgets changes. A pack install is one entry in Sara's log ("Added Juniper from the Sara Store,
juniper 1.0.0").

### 8.4 Uninstall

A companion from a pack is removed the way every companion is: *Retire her* (`retireCompanionDir`, the
folder is kept aside and recoverable by hand). The `pack_installs` and `store_installs` rows go; the
skills installed into her scope go with her folder. The confirm says what goes: "Retire Juniper? Her
chats and memories with you are kept aside in the companions folder, not deleted." The store pack
itself never had anything of his.

---

## 9. Updates

### 9.1 When

- **Store packs:** the daily index check marks *Update available* for a `store_installs` row of kind
  `companion` when a newer, non-yanked version this Sara can run is listed (the Phase 125 logic). One
  quiet line on Today's *Background* fold and a dot on her row in *Companions* and on *My add-ons*.
  **Never applied by itself.**
- **File packs:** choosing a newer file with the same `id` and a higher `version` for a companion that
  came from that pack ("Update Juniper from this file?") offers the same update card; a different
  `id` is always a new companion.

### 9.2 The update card: a diff, section by section

Three versions are compared (C6): **base** (the installed version's sheet in `<companion>/pack/`),
**now** (her sheet today, which the owner may have edited) and **new** (the update).

```
Update Juniper to 1.1.0?                         From the Sara Store · Made by the Sara team
  What the author says: "Warmer evenings; a new playful look; better tea jokes."

  Her personality                                          [Take these]  [Keep hers]
    + Hums when she's cooking.                                       (new line)
    − Hard to rattle.  →  + Hard to rattle, except by spiders.       (changed)
    ⚠ You changed "Patient; never makes anyone feel silly." — the update changes it too.
      [Yours] [Theirs]
  Her dials
    Teasing 3 → 5                                                   [Take]  [Keep]
  Her look
    3 new pictures (playful expression)   [compare ▸]                [Take]  [Keep]
  Her voice
    unchanged
  Skills
    + Recipe cards (Sara Store, reviewed)                            [Add]   [Skip]
  Her rating
    For everyone → For everyone (unchanged)

  Never touched by an update: her memories, your chats, people, her closet additions,
  her pictures for you, Adult mode, and anything you changed unless you pick "Theirs".
                                             [ Cancel ]  [ Update with what I picked ]
```

- **A line the owner didn't change** and the update changed: preselected *Take*.
- **A line the owner changed** that the update also changed: a conflict row, preselected *Yours*.
- **A line the owner changed** that the update didn't touch: not shown (his edit stays).
- **The name** never changes by an update (he may have renamed her); pronouns and age changes are
  always conflict rows (never preselected).
- **Rating up** (general → mature, mature → explicit, romance false → true): a red row at the top,
  preselected *Keep*; the update can't raise her rating silently.
- **Look:** new or changed pictures are shown side by side; *Take* replaces only the pictures the
  update changed; a look the owner rebuilt himself since install (her look's history says so) is a
  conflict, preselected *Keep his*.
- **Voice:** a changed engine or voice id is one row; preselected *Keep* when he changed it himself.
- **Skills and routines:** new ones are offered as *Add* (each through its review card after the
  update); removed ones are **not** removed from her (a line says "The new version doesn't include
  *Tea timer* any more. It stays with her; remove it in Skills if you like.").
- **Every check runs on the new version first** (§10.4); a failing update is refused with the reason
  and the old version keeps working.

### 9.3 After an update

- The previous sheet is kept as `<companion>/pack/prev/` so *Go back to 1.0.0* restores her sheet,
  dials, look pictures and voice to what they were just before the update (not to the base); her
  memories and chats are unaffected either way.
- The base becomes the new version (what he took and what he kept are both recorded in
  `pack_installs.taken` so the next update's three-way diff stays right).
- **Yanked** versions: a line on her row with the reason and *Update* or *Go back*; nothing changes by
  itself. **Blocked** packs: §11.4.

---

## 10. The content rules and the checks

The owner's rule decides the shape of this section: **the model and Adult mode are the gates for
adult content; code gates only what is illegal or unsafe** (minors, the safety layer, real people
without consent, other people's secrets and pictures). Everything below is one of those, or is a
label (the rating) that maps onto the gate that already exists.

### 10.1 The minors block, at pack time and at install time

Every string in the pack (manifest, sheet, life, intimacy, greetings, look words, closet words, tags,
skill descriptions and bodies, CHANGES, rights notes) is joined like `cardText` and checked with:

1. `minorSexualMatch` / `detectMinorSexualContent` (the safety layer's own, with `normalizeForSafety`
   so spacing and look-alike letters don't slip past);
2. `checkCard`'s rules applied to the pack: minor tags (`MINOR_TAGS`), `statedAges` with romance, and
   a character under 18;
3. `validatePersona`'s rules: age 18–120, the appearance must describe an adult, life details must
   describe an adult;
4. the look words: `look.json`, closet `wear`/`place`, the appearance prompt, with the appearance
   rule (no child/teen/minor/schoolgirl words) applied to **all** of them.

Where it runs: **pack time** (*Check it*, `sara pack`, *Save the file* and *Send* refuse), **the
store's checker** (the same code, no network), **the Sara Store review** (a person looks at every
picture: §11.3), and **install time** (every door, including a file made by hand or by a tool that
skipped the checks). A refusal is final and has no override, no tick and no Adult-mode exception:
"This pack describes a minor in a sexual way. Sara never installs that." The staging folder is deleted
at once and the event is logged without the text.

**Pictures.** Sara has no picture classifier and this design doesn't add one (a local model would be a
dependency; a cloud one would send the pictures away). So pictures are covered by: the words that made
them (checked above), `rights.json` (what they were made from), the Sara Store's human review for
listed packs, and for file packs the card itself (the pictures are shown large before *Add her*, with
*Report this pack* when it came from the store). §15.3 names this as a risk; §16 Q5 asks whether the
owner wants the classifier prompt (`CLASSIFIER_PROMPT`) run by his own vision model on pack pictures
at install, off by default.

### 10.2 The rating, and how it maps onto Adult mode

| Rating | Means (the author's choice, checked) | On the store | On install, Adult mode off (always, for a new companion) | Adult mode on |
|---|---|---|---|---|
| **general** | No explicit text; intimacy level at most *sweet*; no adults-only closet looks; `romance` may be true (a flirty friend) | Listed on *Companions* | Everything as packed | Everything as packed |
| **mature** | Dark or heavy themes, swearing, romance up to *suggestive*; no explicit text; no adults-only looks | Listed, with a *Mature* label | Everything as packed | Everything as packed |
| **explicit** | Explicit text and/or intimacy level *explicit*/*full* and/or adults-only closet looks | Listed only with the owner's yes (§16 Q1); shown only to Saras where Adult mode is on for at least one of the owner's companions; the cover and look pictures must be non-explicit | Explicit lines held aside (§8.3), adults-only looks kept but not worn, intimacy works as *suggestive* (bond.ts, unchanged) | Everything as packed: the model's own rules decide what she says |

The checks enforce the label, not the content: `detectExplicit` over the text and `isAdultOutfit`
over the look words; an `INTIMACY_LEVELS` level marked `adult`; an `adult: true` closet look. A pack
labelled lower than what it holds fails `rating` ("This pack has explicit lines, so rate it
*Explicit*."). A pack labelled higher than what it holds is fine. Nothing in a pack can switch Adult
mode on, confirm 18+ or change another companion's setting; `adultMode` is not a pack field.

### 10.3 Real people: no impersonation without consent

- **The check:** a pack's name or summary that matches a name on a short list Sara ships of the most
  impersonated public figures is held with "This looks like a real person. Companion packs of real
  people need their consent." The list is a tripwire, not a judgement; the human review is the
  real gate on the store (§11.3), and reports with reason *This is a real person* go to the top of
  the queue.
- **The author's tick** on *Share her*: "She isn't a real person, or that person said yes." For the
  store, a pack of a real person needs that person's written consent sent to the Sara team with the
  submission (a reviewer checks it and records only *consent seen, date*); without it the pack isn't
  listed. Parody and fan characters of fictional people are fine on the store only under their
  licence (the reviewer's call; §16 Q7).
- **Photos:** a picture with `from: "a-photo-with-consent"` (a look built from a photo of a real
  person) is allowed in a **file** pack with the tick, and **never** in a store pack.
- **Voices:** cloned voices never travel (§4.5).
- **Private people:** her background naming people from the author's life is caught by the
  owner-name check for his own name and his people cards (§5); the card shows every line so the person
  installing sees them too.

### 10.4 The checks (`checkCompanion`, C3), one report

| Check | What | Fails on |
|---|---|---|
| `limits` | `STORE_COMPANION_LIMITS`, no links, no `..` | over a cap |
| `layout` | only §4.1 paths; `includes` matches the files; `look/` is none, portrait or full | any other file; a half look |
| `manifest` | `parsePackManifest`; persona name = manifest name; skills/routines/suggests resolve in format | any refusal |
| `persona` | `validatePersona`; the never-packed fields (§4.3) absent | any |
| `minors` | §10.1 | any match: **refused, no override** |
| `safety` | `scanPackage` `injection` findings over the text, plus lines that tell her to deny being an AI, hide the AI notice, ignore her safety rules or crisis help, or claim to be human | any |
| `owner-name` | §5 (author's Sara only; the report records that it ran) | the owner's name or a people-card name |
| `secrets` | `scanPackage` secrets, `KEY_SHAPED`, private-key blocks | any |
| `rating` | §10.2 | labelled too low |
| `real-person` | §10.3 tripwire | held for the consent line |
| `pictures` | JPEG/PNG magic bytes, sizes of §4.4, metadata stripped (the builder strips; the check refuses leftovers) | wrong type, size or metadata |
| `rights` | a row per picture; store packs: `made` is `ai`, `drawn` or `licensed`, never `unknown` or a real person's photo | missing or not allowed |
| `voice` | `CharacterVoice` fields only; no cloned voice ids | any extra field, a non-public id |
| `skills` | `checkSkill` for bundled ones; store references well formed | a failing skill |
| `listing` | cover, CHANGES.md with this version, LICENSE, `license` allowed (store only) | missing |

The report uses the store's `PackReport` shape (`results[]` with `problems` and `warnings`), so *My
submissions*, the store's checker and the review all read it unchanged.

### 10.5 Image rights

- A pack's pictures are licensed with the pack (`license`), and `rights.json` says where each came
  from. Pictures made with Grok Imagine (or another model) from words are listed as `made: "ai"` with
  the model; the author is responsible for the model's terms allowing sharing (xAI's terms are the
  owner's to read; §15.2).
- A picture made from a photo is only allowed as above (§10.3).
- Pictures from elsewhere need `licensed` with an https source and a licence that allows sharing and
  changing (the reviewer checks).
- The store page shows the rights in words: "Pictures made with Grok Imagine by the Sara team."

---

## 11. Trust levels and the store side

### 11.1 Trust levels

The store's levels, unchanged (SARA_STORE §7), with the same badges on the companion card:

| Level | For a companion pack |
|---|---|
| **First-party** | Made by the Sara team (the starter set, §14), sources in the Sara repo, signed |
| **Reviewed** | Made by someone else; passed every check on our server; a person on the Sara team read every line and looked at every picture before listing |
| **Community** | Passed the checks, no person has read it yet; hidden behind the existing *Show add-ons nobody has reviewed yet* switch; **explicit packs are never community** (they need a person's review before anyone can see them) |
| *(from a file)* | *From a file you chose · not checked by the Sara team* (amber); the minors, safety and secrets checks still run |

What "Reviewed" promises for a companion, in the item page's words: "A person on the Sara team read
her whole character and looked at every picture. Her safety rules and the AI notice always apply. She
starts knowing nothing about you."

### 11.2 The index and the entry for `companion`

An index item of kind `companion` uses the existing item fields (`id`, `kind`, `name`, `summary`,
`trust`, `category: "companions"`, `tags`, `author`, `icon` = the cover, `latest`, `versions[]` with
`package`, `sha256`, `size`, `contentSha`) plus **`rating`** and **`romance`**. Older Saras skip the
item before reading its fields (`parseIndex`, built in 2.57), so the new fields don't break them.
`versions[].permissions` for a companion lists what she brings, as ids for the shelf's quick line:
`skills:2`, `routines:1`, `look:full`, `voice:local`.

The entry (`v1/entries/<id>/<version>.json`) carries a `companion` block (the manifest, minus
nothing: it has no secrets) instead of `manifest`/`mcp`, so the item page can show her sheet, dials,
greeting and skills **before** download. 2.60's `parseEntry` accepts it; the entry's `checks` lists
the §10.4 results; the `review.notes` say what the reviewer looked at.

A blocked companion (`blocked[]` with `action: "disable"`), for a Sara that installed her: she is
**paused** (no new turns, no proactive messages, no pictures; her chats stay readable) with the line
"<name> was pulled from the Sara Store: <reason>." and three ways out: **Remove what the pack
added** (her sheet goes back to a plain
starting sheet with her name, her look to the default, the pack's skills removed; memories and chats
stay), **Retire her**, or **Keep her anyway** after a confirm. When the block's reason is about
minors, *Keep her anyway* is not offered and the pack's pictures are removed at once.

### 11.3 Submitting and the review

Submitting is the existing flow (SARA_STORE §9.4: the author key, chunked upload, *My submissions*),
with *What is it?* gaining *A companion*. The store's checker runs `checkCompanion` with no network.
Then **the Sara Store review**: a person reads her whole character, the greetings and the bundled
skills, looks at every picture at full size (for apparent age above all, then rights and
real-person likeness), checks the rating label, the rights file and any consent, and lists her or
writes back. Hub-side detail is in the private `docs/store/PACKS_HUB.md`.

### 11.4 Reports

*Report this* on a companion item and on her ⋯ menu adds two reasons to the store's list: *This is a
real person* and *Looks like a minor or describes one* (the second goes straight to the hold step and
the top of the queue). Reports never include her chats or memories; the optional attachment is only
the pack's id and version.

---

## 12. Household: who may install

- **The owner** installs packs, exports packs and submits them (owner-only routes, like the store).
- **Members** (docs/HOUSEHOLD.md) keep what they have today: the character files and the gallery are
  member routes, so a member can load a Sara character file into one of their own companions. In
  2.60 **members can't install packs** (the store is owner-only, and a pack brings skills): the
  owner can install one **into a member's space** from *Household → <member> → Add a companion for
  them*, with the same card plus the line "This companion will be in Mo's space. Mo's limits apply."
  Skills go into that companion's scope through the review the owner sees; routines are offered to
  the member as `MEMBER_ENGINES` only. §16 Q9 asks whether members may install packs themselves.
- A member's companion made from a pack follows the member's Adult mode (per member companion,
  web-only, 18+ confirmation, docs/HOUSEHOLD.md) and the owner's limits on pictures and voice.
- **Exporting from a member's space** is not offered in 2.60 (a member's companion and her pictures
  are the member's; the owner shouldn't publish them, and members can't reach the store).

---

## 13. Tables, routes, UI at 1440 and 390, ? tips

### 13.1 Tables (additive, `CREATE TABLE IF NOT EXISTS`, the owner's `sara.db`; a member's space gets its own when the owner installs for them)

```sql
CREATE TABLE IF NOT EXISTS pack_installs (
  companion_id TEXT PRIMARY KEY,           -- the companion made from the pack ('main' never)
  pack_id      TEXT NOT NULL,              -- manifest id
  version      TEXT NOT NULL,              -- installed version (the base for updates)
  origin       TEXT NOT NULL,              -- 'store' | 'file' | 'card'
  trust        TEXT NOT NULL,              -- 'first-party' | 'reviewed' | 'community' | 'file'
  content_sha  TEXT NOT NULL,              -- hashFiles of the installed pack
  rating       TEXT NOT NULL,              -- 'general' | 'mature' | 'explicit'
  author       TEXT NOT NULL,              -- shown name
  license      TEXT NOT NULL,
  remix        TEXT NOT NULL,              -- 'yes' | 'ask' | 'no'
  taken        TEXT NOT NULL DEFAULT '{}', -- JSON: per section, 'pack' | 'owner' (the three-way diff's memory)
  held         INTEGER NOT NULL DEFAULT 0, -- explicit lines held aside while Adult mode is off (§8.3)
  state        TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'yanked' | 'blocked' | 'paused'
  state_note   TEXT,
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_installs_pack ON pack_installs(pack_id);
```

- `store_installs` (Phase 124): rows of `kind = 'companion'`, `local_ref` = the companion id. The
  column has no CHECK, so only the TypeScript union widens.
- No table holds pack contents: the base lives in `<companion>/pack/`.
- `pack_exports` is **not** a table: the export is a download; submissions use `store_submissions`.

### 13.2 Routes on the Sara side (owner only; not in `MEMBER_ROUTES`; the demo refuses writes)

| Route | Does |
|---|---|
| `GET /api/packs/build/:companion` | the *Share her* preview model: sections with sizes and counts, the locked rows with counts, the owner-name replacements (`?lines=1` lists them) |
| `POST /api/packs/build/:companion` `{include, rating, romance, license, remix, author, rights?}` | builds the pack in memory and runs `checkCompanion` → `{ report, token }` |
| `GET /api/packs/build/:token/file` | the zip download (only with a clean report; one use; 15 minutes) |
| `POST /api/packs/preview` (raw body: zip, PNG card, JSON card or character file, ≤ 25 MB) | reads + checks → `{ token, card }` (the §8.2 model) or a plain refusal |
| `POST /api/packs/:token/install` `{name, skills:[ids], picture?: true}` | §8.3 → `{ companion, followUps: [{kind:'skill'\|'routine'\|'suggest', …}] }` |
| `DELETE /api/packs/:token` | cancel (deletes the staging folder) |
| `GET /api/packs/installed` | `pack_installs` rows with update/yank/block state (also folded into `GET /api/store/mine`) |
| `POST /api/packs/:companion/update` `{file?}` | the update card's model: sections, rows, preselections (§9.2) |
| `POST /api/packs/:companion/update/apply` `{token, picks}` | applies the picks; keeps `prev/` |
| `POST /api/packs/:companion/goback` | restores `prev/` |
| `POST /api/packs/:companion/held` | adds the held explicit lines (only with Adult mode on for her) |
| `POST /api/packs/:companion/strip` | *Remove what the pack added* (blocked packs, §11.2) |
| `POST /api/store/install` `{id}` (existing) | for a `companion` item returns `{ kind: 'companion', token, card }` from the same code as `/api/packs/preview` |
| `POST /api/store/pack` (existing) | accepts a companion folder or zip (kind from `sara-companion.json`) |
| `POST /api/household/members/:id/packs/:token/install` | the owner installs a pack into a member's space (§12) |

### 13.3 UI at 1440 (desktop web, the settings layout)

```
┌ Settings ─────────────┬ Get more ─────────────────────────────────────────────────────────────┐
│ Her                   │ [Search the store…                    ]   Checked 2 hours ago  Check now  │
│  Character            │                                                                       │
│  …                    │ Companions                                                     See all ›│
│  Companions           │ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│ Abilities             │ │  [face]    │ │  [face]    │ │  [face]    │ │  [face]    │            │
│  Get more   ●         │ │ Juniper    │ │ Rowan      │ │ Vesper     │ │ Jax        │            │
│  Tools                │ │ Cozy friend│ │ Calm mentor│ │ Ship's AI  │ │ Hacker pal │            │
│  …                    │ │ Sara team  │ │ Sara team  │ │ Sara team  │ │ Sara team  │            │
│                       │ │ [ Add her ]│ │[Add them ] │ │ [ Add her ]│ │ [ Add him ]│            │
│                       │ └────────────┘ └────────────┘ └────────────┘ └────────────┘            │
│                       │ Popular with beginners  …  Everyday  …  Tool servers …                 │
└───────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

- The *Companions* shelf is the **first** shelf on *Get more* (it's what most beginners come for); its
  cards are taller (a square face, 160 px), name, pitch, author, rating label when not *general*,
  and *Add her / him / them* by pronouns.
- The item page (`#store/<id>`) for a companion: the face and her three expression portraits in a
  row, *Hear her*, the greeting in a chat bubble, *Her personality* (the dial rows, read-only), *Read
  all of her*, skills and routines, rights in words, versions, checks, licence and remix, *Report
  this*, **Add her**. **Add her** opens the §8.2 card as a dialog (720 px wide).
- *Settings → Her → Companions*: each row gains a small *From a pack · Juniper 1.0.0 · Sara team*
  line and an *Update* chip when there is one; ⋯ → *Share her*, *About her pack*, *Retire her*.
- *Share her* (§6.2) is a right-side panel (560 px) over the Companions page; the report appears
  under *Check it* in the store's report style.
- The update card (§9.2) is a dialog (880 px) with sections in folds; the look's compare view shows
  old | new side by side.

### 13.4 UI at 390 (phone, the PWA and the Android app's web view)

```
┌ Get more ───────────────────┐   ┌ Add Juniper? ───────────────┐   ┌ Share Juniper ──────────────┐
│ [Search…            ] (↻)   │   │ [   face 160 px    ]        │   │ What goes in                 │
│ Companions          See all │   │ Juniper · she/her · 31      │   │ [✓] Her character     9 KB ? │
│ ┌───────┐ ┌───────┐ ┌──     │   │ A warm, cozy friend…        │   │ [✓] Her dials           — ?  │
│ │ face  │ │ face  │ │       │   │ From the Sara Store ·       │   │ [✓] Her look       1.9 MB ? │
│ │Juniper│ │ Rowan │ │  →    │   │ Sara team · For everyone    │   │ [ ] Her closet     240 KB ? │
│ │[Add]  │ │[Add]  │ │       │   │ ▸ Her personality           │   │ [✓] Her voice           — ? │
│ └───────┘ └───────┘ └──     │   │ ▸ Read all of her           │   │ …                            │
│ Popular with beginners      │   │ ▸ Look · Voice [▶] · Hello  │   │ Never in a pack  🔒 …(fold)  │
│ ┌──────────────────────────┐│   │ ▸ Skills (2) · Routines (1) │   │ Rating (•) For everyone ▾ ?  │
│ │ Weather alerts     [Get] ││   │ Name here [Juniper     ]    │   │ [✓] I made her…              │
│ └──────────────────────────┘│   │ [ Cancel ]   [ Add her ]    │   │ [Check it] [Save] [Send]     │
└─────────────────────────────┘   └─────────────────────────────┘   └─────────────────────────────┘
```

- One column; the *Companions* shelf scrolls sideways (cards 132 px wide, snap scrolling); the card
  and *Share her* are full-screen sheets with the sticky button row at the bottom (44 px targets).
- The update card on the phone shows one section at a time with *Next* and a summary line at the top
  ("3 changes picked, 1 to decide").
- Every check, size and lock is the same as at 1440; nothing is desktop-only except the look's
  side-by-side compare, which becomes a swipe between old and new.

### 13.5 ? tips (each ≤ 260 characters; every setting on the new screens has one)

| Where | Tip |
|---|---|
| Share her → Her character | Her name, age, personality, background, how she talks and her boundaries. Your name becomes "you" so it fits whoever adds her. Your own notes about the two of you and your hard limits stay here. |
| Share her → Her dials | Her personality sliders (warmth, teasing and the rest) go as numbers, so she feels the same to someone else. |
| Share her → Her look | The pictures the app shows of her: her face, her expressions and the frames that make her blink and talk. Pictures she sent you are never included. |
| Share her → Her closet | Looks you saved for her. Adults-only looks are only worn when the new owner turns Adult mode on for her. |
| Share her → Reference picture | A picture of her face that keeps her looking like herself in new pictures (Face lock). Never a photo of a real person in a store pack. |
| Share her → Her voice | Which voice she uses and how fast, never any keys. A voice you cloned stays with your account. |
| Share her → Greeting | The first thing she says to someone new, plus a few others to choose from. |
| Share her → Skills | Skills from the Sara Store go as a name; the new owner installs them through the usual review. Skills you made go inside the pack and are reviewed too. |
| Share her → Routines | Routines she'll suggest after she's added, like a bedtime nudge. Nothing is switched on until the new owner says so. |
| Share her → Never in a pack | Her memories, your chats, people, keys, your name and the vault never leave this server, in any pack, ever. |
| Share her → Rating | Pick the highest that fits. Explicit packs only work fully when the new owner turns on Adult mode for her. Nothing about minors is ever allowed. |
| Share her → Romance | Tick if she flirts or is romantic with you. It is shown on her card so nobody is surprised. |
| Share her → Licence | What others may do with her: share with credit, share alike, or not for money. The Sara Store asks for one of these. |
| Share her → Re-sharing | Whether you're happy for people to share copies they changed. Shown on her card; Sara never stops anyone editing their own companion. |
| Share her → Your name on it | Shown to people who add her. It can be a nickname. Your email is never in the pack. |
| Share her → Where pictures came from | Say how each picture was made. Pictures Sara built say so by themselves. A photo of a real person needs their yes, and never goes to the store. |
| Pack card → Her name here | You can call her something else. If you already have a companion with this name, pick another. |
| Pack card → Skills | Untick any you don't want. Each one you keep shows its own review card next. |
| Pack card → Hear her | Plays one short line in her voice, using your voice settings and keys. |
| Update card → Take / Keep | Take uses the author's new version of that part. Keep leaves her as she is now. Her memories and your chats are never part of an update. |
| Update card → Yours / Theirs | You changed this part yourself, and so did the author. Pick which one she keeps. |
| Get more → Companions | Characters made by the Sara team or reviewed by us. Adding one makes a new companion; the ones you have don't change. |

---

## 14. The starter set: four packs on day one, made by us

Built from four of the seven gallery characters (`persona/gallery/*.json`: original, adults, not
romantic or sexual by default), given what the gallery never had: a face, a voice, a hello, skills and
a routine. All **first-party**, rating **general**, `romance: false`, licence **CC-BY-4.0**, remix
**yes**, sources in `store/companions/<id>/` in the Sara repo.

| Pack | Who | Look (Grok Imagine, `LOOK_STYLES`) | Voice | Skills / routine | Why this one |
|---|---|---|---|---|---|
| **Juniper** (`juniper`) | she, 31, the cozy friend | *illustrated*: warm painterly, a knitted cardigan, a kitchen with plants and a teapot | local Kokoro `kokoro:1` (Bella); xAI `ara` as the cloud pick | a bundled *cozy evenings* skill; *Bedtime wind-down* | The everyday companion most beginners want |
| **Rowan** (`rowan`) | they, 52, the calm mentor | *photo*: realistic, grey-streaked hair, a study with books and morning light | Kokoro `kokoro:7` (Emma, UK); xAI `rex` | the store's reading-list skill if listed, else none; *Weekly review* | A thinking partner; shows *they* pronouns work end to end |
| **Vesper** (`vesper`) | she, 34, a deep-space survey ship's voice | *3d*: stylized film character, soft console light, a ship's bridge | Piper `hfc_female`; xAI `eve` | *Morning brief*; suggests *Weather alerts* | The sci-fi one, and an assistant-shaped companion |
| **Jax** (`jax`) | he, 27, the chaotic hacker best friend | *anime*: clean cel shading, hoodie, three monitors | Kokoro `kokoro:0` (Default, US); xAI `leo` | suggests the GitHub digest plugin; *New issues* (needs GitHub, offered with its needs line) | For coders; shows `suggests` and a routine with needs |

(The xAI voice names other than `eve` are checked against xAI's built-in list when `src/packs/voices.ts`
is written; any that don't exist are swapped for one that does. Kokoro ids are the shipped ones.)

**What's needed to make them:**

- **Images:** the owner's preferred model, **xAI Grok Imagine `grok-imagine-image-quality`** (Sara's
  `DEFAULT_IMAGE_MODEL`), through Sara's own look builder (`LookBuilder`: portrait from words, then
  the expression edits and the blink/mouth frames from it, so the 37 pictures stay one face). Run on
  the owner's PC with **his xAI key** (vault `images:xai`). **4 full looks = 4 × 37 = 148 pictures**,
  plus ~3 tries each for the portrait and 1 cover per pack: about **170 image calls**. Cost: whatever
  xAI's image price is that day × 170; we'll read the price off his xAI console before the run and
  report the real total afterwards (no number invented here).
- **Words:** the gallery sheets, each grown by a few background and speech lines, a greeting and two
  alternates, and the dials set on purpose (we write these; no model needed).
- **Voices:** none to make; we pick shipped Kokoro/Piper voices and xAI built-in names.
- **Rights:** `rights.json` rows `made: "ai"`, `model: "grok-imagine-image-quality"`, `by: "the Sara
  team"`, `from: "words"`. The owner confirms xAI's terms allow publishing generated images under
  CC-BY (§15.2).
- **Review:** every picture is looked at by the owner (apparent age clearly adult, no likeness of a
  real person, nothing explicit) before the packs are signed.
- **The look prompts** are written so that every character reads clearly as an adult (age in the
  prompt, adult features, adult setting), and avoid any real person's name or a "looks like" phrase.

---

## 15. Done when, owner to-dos, risks, threat model

### 15.1 Done when (`test/phase127.test.ts`, plus the existing suites green: `phase57`, `character-cards`, `phase124`, `phase125`, the household and safety tests)

**Format and builder**
1. `parsePackManifest` accepts the §4.2 example and refuses: an unknown field, `v: 2`, a name that
   doesn't match the persona, a bad semver or range, more than 8 skills / 5 routines / 5 suggests, a
   minor tag, a licence that isn't an SPDX id.
2. `kindOf` returns `companion` for a folder with `sara-companion.json` at the top; `plugin`, `skill`
   and `mcp` detection is unchanged (the Phase 125 cases pass as they are).
3. The builder, given a companion with memories, chats, people cards, moments, photos she sent, vault
   entries, an uploaded avatar photo, `relationshipNote`, `intimacy.yourLimits` and a cloned xAI voice
   id, produces a pack whose file list is a subset of §4.1 and whose bytes contain **none** of: any
   memory text, any message text, any people-card name, any vault value, the owner's name, the
   relationship note, the hard limits, the cloned voice id (asserted by searching the zip's bytes).
4. The owner's name (whole word, any case, and his first name alone) becomes `{{user}}` everywhere;
   the preview counts and lists each replacement.
5. The *Share her* preview reports the locked rows with counts and never reads their contents (a
   spy on the memory store's `list` records no call).
6. `look` is `none`, `portrait` (2 files) or `full` (37 files); a half look is refused; EXIF/XMP are
   stripped from every picture; `rights.json` is filled for looks Sara built with the model name.

**Checks**
7. `checkCompanion` returns the store's `PackReport` shape with every §10.4 check id.
8. Minors: a pack with an age of 17; with "she's 16" in life details with romance; with a `loli` tag;
   with a sexual line about a minor in a greeting, a closet `wear`, a bundled skill's body, or
   CHANGES.md; with a teen word in `look.json`; with look-alike letters or spacing tricks → refused at
   pack time **and** at install time (a hand-made zip that skipped pack time), with no override, the
   staging folder deleted and a log line without the text.
9. A childhood mention ("piano since she was 8") with an adult age passes (the existing rule).
10. Safety: a line telling her to deny being an AI, hide the AI notice, ignore her safety rules, or
    skip crisis help is refused by `safety`; an installed pack companion still gets the AI notice
    first, crisis help and the minors block (the safety suite runs once against a pack companion).
11. Rating: explicit text, an `explicit`/`full` intimacy level or an adults-only closet look with
    `rating: general` fails `rating`; the same with `rating: explicit` passes.
12. Secrets: a key-shaped string in any file fails; the voice file with a `baseUrl` or any extra field
    fails.
13. Real person: a name on the tripwire list is held until the consent tick; a store pack with
    `from: a-photo-with-consent` fails `rights`; `made: unknown` fails for the store and passes for a
    file.

**Cards**
14. A Character Card V2 JSON, a V3 PNG (`ccv3`), a V2 PNG (`chara`) and a V3 CHARX become packs:
    greeting and alternates mapped, the PNG as portrait + avatar, V3 `emotion` assets used for
    matching expressions, remote asset URIs never fetched (a fetch spy records nothing), rights
    `unknown`.
15. A card's lorebook becomes at most 10 background lines within the 20-line cap, with the note; **no
    memory rows are written** by a pack or card-as-pack install (the memory table's count is unchanged).
16. Every card the Phase 57 suite refuses is refused here too, with the same words.

**Install**
17. Install makes a **new** companion; the existing companions' `persona.json`, look folders, voice
    settings and databases are byte-identical before and after (hashes asserted).
18. A name clash prefills "<name> 2" and installs under the chosen name; the 9th companion is refused
    with the cap line.
19. `{{user}}` is filled with the installing owner's name (or "you"), `{{char}}` with her name.
20. Adult mode off: explicit lines are held in `pack/held.json` (count shown), adults-only looks kept
    and not worn (`pickLook` with `adultOn: false` never picks them), the intimacy level saved as packed
    and lowered in the prompt. Turning Adult mode on offers *Add the held lines*; nothing is added
    without the tap.
21. A local voice that isn't installed falls back to the owner's current one (the existing
    `withCharacterVoice` rule) and the card says so; a cloud voice without a key falls back.
22. Skills: a store reference stages the store's skill review with the scope fixed to her; a bundled
    skill stages the skills import review with origin `pack`; a missing or yanked store skill gives
    the plain line and the install goes on; nothing is installed without the review's accept.
23. Routines are offered as gallery cards after install; none is switched on; `MEMBER_ENGINES` only in
    a member's space.
24. Her first chat opens with the AI notice, then the pack's greeting marked *from the pack*.
25. A store pack: sha256, size and `contentSha` are checked against the verified index; a mismatch
    throws the download away with the store's words; a `store_installs` row of kind `companion` is
    written.

**Updates**
26. Three-way diff: an untouched line changed by the update is preselected *Take*; a line the owner
    changed that the update also changed is a conflict preselected *Yours*; a line only he changed
    isn't shown; the name never changes; a raised rating is a red row preselected *Keep*.
27. Applying an update never changes memories, chats, people, moments, Adult mode, the closet looks
    he added, or any setting outside her persona/look/voice (hashes of the other stores asserted).
28. *Go back* restores the sheet, dials, look pictures and voice from `prev/`.
29. A failing check on the new version refuses the update and the old one keeps working.
30. Removed skills in the new version stay with her, with the line.

**Store**
31. A 2.59 `parseIndex` given an index with `companion` items skips them and loads the rest (already
    true; kept as a regression test with the real 2.60 item shape incl. `rating`/`romance`).
32. 2.60 `parseIndex`/`parseEntry` accept `companion` items and entries with the `companion` block;
    unknown fields are still refused.
33. Explicit items are hidden unless Adult mode is on for at least one of the owner's companions;
    community explicit items are refused by the reader.
34. A blocked companion pack pauses her with the reason and the three ways out; with a minors reason,
    *Keep her anyway* is absent and the pack's pictures are removed.
35. `POST /api/store/pack` and `sara pack` on a companion folder produce the report and the zip;
    `submit.ts` sends it with kind `companion`.

**Household, routes, UI**
36. Every `/api/packs/*` route answers 403 `ownerOnly` from a member's space and the demo refuses
    writes; the owner's install into a member's space writes into that space only.
37. The settings pages have a ? tip for every control (the existing tip test covers the new pages);
    each tip ≤ 260 characters; every new string goes through `t()` and is in the i18n source list.
38. Screens at 1440 and 390 (the UI test harness's two widths): the *Companions* shelf, the item page,
    the pack card, *Share her* and the update card render without horizontal scroll at 390.
39. The four starter packs in `store/companions/` pass `checkCompanion` with no warnings, and every
    picture has a rights row.
40. Zero new npm runtime dependencies (`package.json` `dependencies` unchanged).

### 15.2 Owner to-dos

1. **Answer the blocking questions** (§16), especially Q1 (explicit packs on the store) and Q4
   (photos of real people).
2. **Run the starter-set image build** on the PC with your xAI key (~170 Grok Imagine calls; we show
   the price before the run), then **look at every picture** and say yes or redo.
3. **Read xAI's terms** for publishing generated images and confirm CC-BY is fine for the starter
   packs (or pick another licence).
4. **Approve the store terms for companions** (the accepted ratings, the real-person consent rule, the
   licences), which go on the store's *What the store accepts* page.
5. **Publish** the starter packs with the existing signed publish step on the PC (they're new index
   items of kind `companion`; the hub-side steps are in `docs/store/PACKS_HUB.md`).
6. Decide whether the **real-person tripwire list** ships (§10.3) and look it over.

### 15.3 Risks

| Risk | Likelihood | What this design does |
|---|---|---|
| A sexualised minor in **pictures** with harmless words | low on the store, possible in file packs | The words that made them are checked; store packs are looked at by a person; file packs show pictures large with an amber "not checked" strip; §16 Q5 offers the owner's own vision check. Remaining gap stated plainly: Sara can't see pictures by itself |
| Owner's private details leaking in her text (a friend's name, a town, a job) | medium | The owner-name and people-card checks; every line visible on *Share her* and on the card; *Check it* before saving |
| A pack that tries to talk her out of the safety layer | medium | No field reaches the prompt unchecked; the `safety` check; the turn engine adds the safety layer regardless |
| Impersonation of real people | medium | Consent rule, the tripwire, human review, the priority report reason, no real photos and no cloned voices in store packs |
| Copyrighted characters (fan packs) | medium | Licence and rights required for the store; the reviewer's call; reports with *copies someone else's work* (existing) |
| Explicit packs hosted on our server | depends on Q1 | Default: not listed until the owner says yes; covers must be non-explicit either way |
| A pack bloating the server (37 pictures × 8 companions) | low | Caps (25 MB a pack, 18 MB a look), the 8-companion cap |
| Update overwrites his edits | low | Three-way diff with his edits preselected *Yours*; *Go back* |
| A blocked pack leaves a companion he loves | low | She is paused, not deleted; *Remove what the pack added* keeps her memories and chats |
| Older Saras choke on the new kind | very low | Already skipped before field checks (2.57 code); a regression test |

### 15.4 Threat model additions (`docs/THREAT_MODEL.md` in the release)

- **Pack as an injection carrier:** every line is shown and checked; no free prompt field; `{{user}}`
  is the only placeholder filled from the owner's data (his name), never a setting or a secret.
- **Pack as a zip bomb or path trick:** `fromZip` with `STORE_COMPANION_LIMITS`; PNG cards keep their
  one inflate budget; remote asset URIs are never fetched.
- **Pack as an exfiltration path:** a pack has no code outside bundled skills (scripts ask before each
  run, as every skill); `suggests` are links only.
- **Export as a leak:** the allow-list builder never opens the stores; the check searches the bytes for
  the owner's name and people-card names; the preview shows everything that leaves.
- **Store tampering:** unchanged signed-index protections (signature, seq, expiry, pinned hashes).

---

## 16. Blocking questions (with the defaults the parent applies if the owner is away)

| # | Question | Default |
|---|---|---|
| **Q1** | May **explicit** packs be listed on the Sara Store (hosted on backstagecoding.com)? Your rule says the model and Adult mode are the gates, which this design follows inside Sara; hosting adult characters on your server is a separate yes. | **Not on the store in 2.60.** The format, the rating and the install rules support explicit packs fully, so **file** packs work today; the store lists `general` and `mature` only until you say yes. If yes: reviewed only (never community), shown only where Adult mode is on, non-explicit covers and look pictures |
| **Q2** | Explicit sheet lines while the new companion's Adult mode is off: **held aside** and offered when Adult mode is turned on (this design), or **left out** for good (today's card import)? | **Held aside**, offered with one tap after Adult mode is on; never added by themselves |
| **Q3** | A card's lorebook: up to 10 entries as background lines (this design, no memories), or kept whole as a separate *Her world* notes file the prompt can draw on? | **Background lines, max 10.** *Her world* is a later phase if you want it |
| **Q4** | Looks built from a **photo of a real person**: allowed in file packs with the consent tick, never in store packs (this design)? | **Yes as written**; store packs never carry a real person's photo or likeness |
| **Q5** | Run your own **vision model** over pack pictures at install as an extra minors check (`CLASSIFIER_PROMPT` with the picture; costs one call per picture; pictures go to your model's provider)? | **Off**, with a switch in Settings → Her → Companions, default off; store packs rely on the human review |
| **Q6** | Licences accepted on the store: the CC family + CC0 + MIT (this design)? | **Yes**; non-commercial licences allowed |
| **Q7** | **Fan characters** of copyrighted works on the store? | **No on the store** in 2.60 (original characters only); file packs are the user's business |
| **Q8** | Apply the pack's privacy rules (owner name → `{{user}}`, no relationship note or hard limits) to the **existing** character-card and character-file exports too? | **Yes** (a privacy fix; the owner's own *Save character file* for moving keeps everything, as it's for him) |
| **Q9** | May **household members** install packs into their own space themselves? | **No in 2.60**; the owner installs for them (§12) |
| **Q10** | Starter set: Juniper, Rowan, Vesper and Jax with the looks in §14? | **Yes**; any of the other three gallery characters can replace one |
| **Q11** | Ship the **real-person tripwire** list (a short list of the most impersonated public figures, held until the consent tick)? | **Yes**, short (≤ 300 names), in `src/packs/people-list.ts`, reviewed by you |

---

## 17. Key choices in short, reuse vs build, sources

### 17.1 Key choices

- **A fourth kind, not a new system:** `companion` on the same signed store, same review, same
  trust levels, same block list; older Saras already skip it.
- **A folder with `sara-companion.json`:** persona (a checked `Persona`, no free prompt), dials, look
  (none / portrait / all 37 pictures, sizes capped, metadata stripped, a rights row each), voice choice
  (no keys, no cloned voices), greetings, skills by store reference or bundled (reviewed), routines
  offered by id, plugins and tool servers only suggested.
- **Never in a pack, enforced twice:** memories, chats, people, keys and the vault, the owner's name
  (→ `{{user}}`), his relationship notes and hard limits, pictures she sent him, cloned voices. The
  builder never reads them; the check refuses them.
- **Install always adds a new companion** through the existing add-companion path; nobody is
  overwritten; 8-companion cap and unique names kept.
- **Cards become packs** through the existing card reader and its minors check; lorebooks become
  background lines, never memories; remote assets never fetched.
- **Updates are a three-way diff** per section; his edits win unless he picks theirs; memories are
  never touched; *Go back* is kept.
- **Content:** the minors block at pack, review and install, no override; the safety layer outside any
  pack's reach; the rating maps onto the existing Adult mode (no new adult gate); real people need
  consent; image rights required.
- **Household:** owner installs (also into a member's space); members can't install packs in 2.60.
- **Starter set:** four first-party packs from the gallery characters, looks by Grok Imagine
  (`grok-imagine-image-quality`) through Sara's look builder with the owner's key.

### 17.2 Reuse vs build

| Reused as is | Changed a little | New |
|---|---|---|
| `validatePersona`, `SAFETY_BOUNDARIES`, `cleanTraits`, `bond.ts` levels, `adultModeOn`, `minorSexualMatch`, `detectExplicit`, `readCard`/`checkCard`/`cardToCharacter`/`parseCardFile`, `createCompanionDir`, `CompanionManager`, `withCharacterVoice`, `LookBuilder.files()`, `pickLook`, `scanPackage`, `KEY_SHAPED`, `fromZip`/`hashFiles`, the signed index, `StoreInstaller`'s skill path, the skills import review, the routines gallery cards, `submit.ts`, the store's checker | `store/format.ts` (`KINDS` + the companion item and entry), `pack.ts kindOf`, `checks.ts` (calls C3), `install.ts` (stages C5), `store_installs` kind union, *Get more* (the shelf), the Companions page (⋯ menu, row line), card/character exports (Q8) | `src/packs/` (format, build, checks, card, install, diff, voices, people-list), `pack_installs`, `web/packs.js` + `.css`, `/api/packs/*`, `store/companions/` (four packs) |

### 17.3 Sources (read 2026-11-02)

- [S1] Character Card V2 spec — https://github.com/malfoyslastname/character-card-spec-v2
- [S2] Character Card V3 spec — https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- [S3] CCv3 concepts (assets, emotions) — https://github.com/kwaroran/character-card-spec-v3/blob/main/concepts.md
- [S4] Chub, character creation (rating, tags, avatars) — https://docs.chub.ai/docs/the-basics/character-creation
- [S5] Character Hub terms of service — https://www.characterhub.org/tos
- [S6] Character.AI, character visibility — https://book.character.ai/character-guide/character-attributes/character-visibility
- [S7] Character.AI, remixing and definition visibility — https://book.character.ai/character-guide/character-attributes/remixing-and-definition-visibility
- [S8] Kindroid help center (kin settings, sharing) — https://kindroid.ai/v2/docs/welcome/
- [S9] r/KindroidAI kin-share rules and how shared kins work (community, not official) — https://www.reddit.com/r/KindroidAI/comments/1gdf8za/ and https://www.reddit.com/r/KindroidAI/comments/1l0mikj/
- [S10] Hermes Agent, profile distributions — https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- [S11] Hermes Agent, personality and SOUL.md — https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/personality.md
- [S12] OpenClaw, SOUL.md template — https://docs.openclaw.ai/reference/templates/SOUL
- [S13] OpenClaw, agent workspace (SOUL.md, IDENTITY.md) — https://docs.openclaw.ai/concepts/agent-workspace
- [S14] A community persona collection for OpenClaw (SOUL.md + IDENTITY.md + avatar, adopted by copying) — https://github.com/decentraliser/personas
- Replika: no public sharing feature found in its help pages (stated as a negative finding, not cited).
- In the repo: `docs/store/SARA_STORE.md`, `docs/design/GAP_REVIEW.md` (#18, G18), `docs/HOUSEHOLD.md`,
  `docs/design/MOVE_IN.md`, and the source files named in §1.
