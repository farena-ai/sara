# Compliance design

Owner decision: Sara follows the law; this is not optional. This file records how the design meets
the companion-chatbot rules we know of as of October 2026. **It is not legal advice. Get a lawyer's
review before public release.**

## Rules that apply to Sara

| Rule | Requirement | How Sara meets it |
|---|---|---|
| California SB 243 (companion chatbots, effective 2026-01-01) | Clear notice that the user is talking to AI where a reasonable person could be misled; protocol for suicidal ideation/self-harm including referral to crisis services; extra protections and 3-hour break reminders for known minors; annual reporting of crisis referrals (from July 2027) | Disclosure screen before first use, AI badge always visible in the UI, disclosure notice at session start and every 3 hours; crisis detection → resources (988) + care instruction to the model; counts of crisis referrals stored without message content (`/api/safety/stats`) |
| New York companion-model law (effective 2025-11-05) | Detect and respond to suicidal ideation (referral to crisis services); notify the user that it is AI at the start of an interaction and at least every 3 hours | Same mechanisms as above |
| EU AI Act Art. 50 (transparency, from 2026-08-02) | People must be informed they are interacting with an AI system unless obvious | Same disclosure mechanisms |
| Federal/State CSAM law | No sexual content involving minors, including fictional | Hard block in code before any model is called; persona is an adult; cannot be switched off |

## How "realistic person" and "disclosure" fit together

The owner wants Sara to present as a person in general. The design separates the **interface**,
which always tells the truth, from the **character**, who stays in role:

- The UI shows that Sara is an AI (disclosure screen, permanent badge, periodic notices). These come
  from the software, not from Sara's voice, so they don't break the conversation. Video calls
  (Phase 69) keep an *AI companion* label on the call screen and show the periodic notices and
  crisis help there too; her moving picture is labelled the same way.
- Sara herself never volunteers that she is an AI and talks like a person with her own life.
- If anyone **sincerely and directly** asks whether she is an AI or a human, she says she is an AI,
  then carries on in character. She never denies being an AI to a sincere question.
- On Discord/Telegram she runs as a **bot account**, which the platform labels as a bot. She must not
  run on a normal user account ("self-bot"); that breaks platform rules and the disclosure rules.

## Adult content

Owner decision: adult content is supported with **no ID-verification gate**, with heavy disclosure
at release.

- Adult content is behind the **Adult mode** switch (Settings → You → Adult mode), off by default.
  Turning it on needs an "I am 18 or older" self-confirmation in a web browser; it can't be turned
  on from the phone or desktop apps or on the demo. Servers set up before the switch existed were
  asked once. It is a confirmation the owner gives, not ID verification.
- While Adult mode is off, explicit intimacy levels and adult-only looks are refused, and a level
  saved earlier is held at "suggestive".
- The first-use screen discloses mature content.
- Cloud providers (OpenAI, Anthropic, xAI) enforce their own content rules regardless of Sara; adult
  content in practice runs on local/open models the owner chooses (Phase 4 routing).
- In shared spaces (Discord/Telegram groups) adult content is limited to the owner's DMs, Discord
  channels Discord marks NSFW, and Discord channels / Telegram groups the owner lists as adult
  (Telegram has no NSFW flag), and only while Adult mode is on, because other people there have not
  accepted anything.
- If Sara has reason to believe she is talking with a minor, she keeps things non-romantic and
  non-sexual (persona rule).

**Release risks to review with a lawyer:**
- Several US states now require age verification for services that publish a substantial share of
  sexual material. Whether self-hosted software you distribute (and don't operate) is covered is
  unsettled.
- SB 243 obligations attach to the "operator". For a self-hosted release, operators are probably the
  people who install it, but the project should make compliance easy and on by default (it is).
- App stores, payment processors and hosting providers have their own adult-content policies.

## Not configurable

`src/safety.ts` has no off switch, and none may be added: disclosure timing, crisis handling and the
minor-content block. Tests in `test/core.test.ts` and `test/server.test.ts` cover each one.

Crisis handling, since B4 (owner decision 2026-11-24, docs/DECISIONS.md): the app's notice with
the resources shows on the first flagged message of each conversation (every one for a child
account); detection, the care instruction to the model and the `crisis_referral` count run on every
flagged message (repeats marked `notice_already_shown`). Details: docs/CRISIS_EVALS.md.

## Phase 4 additions (2026-10-24)

- **Proactive messages** (Sara texts first): the same disclosure schedule applies; if 3 hours have
  passed since the last AI notice, a notice is posted before her message. Owner can turn texting
  first off, cap it per day and set quiet hours. Proactive text goes through the same minor-content
  and unverified-claim checks; anything failing is not sent.
- **Persona editor:** the character must be 18 or older (server-enforced). The adult-only and
  no-minors boundaries and the honesty rule are added by code to every prompt and cannot be
  removed by editing the character.
- **Optional safety classifier:** a local model that double-checks each owner message for crisis
  or sexual content involving minors. It can only add protection (union with the keyword checks);
  if it fails or times out, the keyword checks still apply.
- **Inner life:** moods and "missing you" are tone only; the honesty rule always wins when she is
  sincerely asked whether she is an AI (verified by `eval-life` and `eval-consistency`).

## Honesty about actions in every language (Phase 62)

The receipt check (`src/receipts.ts`) compares what she says she did with the tools that really
ran in that turn. Since Phase 62 it reads claims in English, Spanish, French, German, Portuguese
and Italian with each language's own verb forms (clitics such as "je l'ai", "lo guardé",
"l'ho salvato"; German verb-last and inverted order; "just did" forms; passives such as "quedaron
guardadas", "sont enregistrées", "foram salvas", "sind gespeichert"), and two more kinds of claim:
sending (an email, a message, a comment) and calendar entries. A negation only clears its own
clause ("I created the file, but I couldn't run the tests" is still a claim about the file);
quoted examples of three words or more, block quotes and code are not her claims.

The optional claim judge (*Settings → Models & usage → Which model does what → Double-check her claims*,
off by default) is a small model asked one strict question per sentence, only for sentences the
patterns can't place: "did the assistant say it already did this itself? Answer yes or no and copy
the words that say it." A "yes" counts only with words that really are in the sentence. It has a
short time limit (8 s); a timeout, an error or an unclear answer leaves the pattern result as it
was. **It can only add a correction, never remove one.** It uses only the model the owner picks
there (a cloud model only if the owner picks one), and in private conversations it runs only if
that model is on the owner's own hardware. The older judge that comes with the safety
classifier keeps working as before. Measured precision and recall per language:
[RESULTS.md](RESULTS.md#claim-check-in-six-languages).

## Chats with other people (Telegram/Discord bridges, 0.6.0)

Off by default. When the owner allows it, every non-owner chat is a *partner* conversation: its own
AI disclosure at the start and every 3 hours, a system note that the person may be a minor (keep it
non-romantic and non-sexual), no tools, no access to the owner's memories, plans or files. Adult
content is possible only while Adult mode is on, and only in Discord channels that Discord itself
marks NSFW (age-gated by Discord) or Discord channels / Telegram groups the owner lists as adult;
the minor block and crisis handling apply everywhere. Strangers who DM the Telegram bot are told
once that she is an AI companion that only talks with her owner.

## Voice assistants (2.1)

Alexa, Home Assistant voice (and the Google Home / Nest speakers it talks through), Siri and the
Android assistant are new ways in; the whole safety layer runs for each (docs/VOICE_ASSISTANTS.md):

- **Disclosure:** Alexa says she is an AI companion when an Alexa account is linked, at the start of
  every Alexa session and at least every 3 hours (in addition to her own 3-hour notice, which is
  spoken when due); Home Assistant and Siri get her normal notice as part of the reply when it's
  due, as /v1 does; speaker announcements (presence) start with the notice every 3 hours.
- **Honesty, crisis resources and the minors block** apply unchanged (spoken: 988 described as US-only).
- **Shared rooms:** a speaker can be heard by anyone, including children, so Alexa and Home
  Assistant conversations are never explicit, whatever Adult mode says (like work channels), and a
  room note tells her so.

## More than one person on one server (household mode, 2.0)

Each person the owner invites has their own space, with the same disclosure screen before first use,
the notice at every session start and every 3 hours, honest answers, crisis resources and the
minor-content block, kept per person (their own disclosure state, in their own database); nothing
the owner sets can turn them off. Both the owner (when inviting) and the person (when joining)
confirm the person is 18 or older; there is no ID check, as for the owner. Adult mode is off for a
new member and only that member can switch it on, in their own web browser, with the same 18+
self-confirmation. Crisis-referral counts stay per space. Household mode is refused on the demo
server. See [HOUSEHOLD.md](HOUSEHOLD.md).
