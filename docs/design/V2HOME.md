# V2.3 Home Assistant in one click, scenes by voice

ROADMAP_V V2.3 (item 17). One page; lean on what exists.

## What already existed
- `src/tools/home.ts`: `home_status` (reads on its own) and `home_control` (every change asks; lock,
  unlock, covers, climate, scenes, scripts). `cleanHomeUrl`, `HOME_VAULT` (token in the vault).
- `src/routes/connections.ts` `/api/home`: GET tests the saved address (`/api/config`), PUT saves
  address + token. `/api/home/entities` (+ Today's switch), `/api/home/presence`.
- `src/home-switch.ts`: `SENSITIVE` names (lock, door, alarm, garage...), `sceneAllowed` (Today's
  picked scenes run without a card), `haCall`.
- Settings → Connections → Apps and services → Home Assistant (`ab-home`): address, token, Save and
  test, Presence. `integrations/home-assistant/` (Sara as HA's conversation agent), docs/HOME_ASSISTANT.md.
- Voice: Talk with Sara (`opts.talk`), car mode, phone calls; `voiceMayApprove` (spoken yes rules).

## What V2.3 adds
1. **Find it for me** (`src/home-discover.ts`, `GET /api/home/discover`): one mDNS question for
   `_home-assistant._tcp.local` (PTR, unicast reply asked, sent from a random port to
   224.0.0.251:5353, 2.5 s). Answers (PTR/SRV/TXT/A) become `{url, name, version}`; the address is
   `http://<ipv4>:<port>` (a `.local` name often doesn't resolve on Windows), else the TXT
   `internal_url`/`base_url`. Nothing is sent but the question; the token never leaves on discovery.
   The page fills the address field with the first one found (a picker when there are several).
2. **Test token** (`POST /api/home/test {url?, token?}`): checks the typed address and token without
   saving (empty token = the saved one): name, version and how many scenes/scripts there are, or a
   plain reason (refused token, unreachable, not Home Assistant).
3. **Say it to start** (`src/home-voice.ts`, `GET/PUT /api/home/voice`, `settings.home.voice`):
   the home's scenes and scripts listed with a switch and the words to say (default: the name,
   "Movie night"). In a spoken turn (Talk with Sara, car mode, a phone call) from the owner, the words
   alone ("Hey Sara, movie night", "start movie night", "movie night please") run it at once: no model
   call, no card, she answers "Movie night is on." (an owner pressing a button he set up, like Today's
   picked scenes). Typed text never runs it; other people, apps and Home Assistant's own channel never do.
4. **Locks and alarms keep asking**: anything named like a lock, door, alarm or garage (`SENSITIVE`)
   can't be picked for voice (refused by the route, shown greyed with the reason), and a
   `home_control` card that locks, unlocks, opens a lock or touches an alarm (`homeTapOnly`) is never
   answered by a spoken yes: `voiceMayApprove` (and web/talk.js) want a tap.

## Not done (on purpose)
- No new tile or Settings page: sections on `ab-home`. No routines-gallery engine: these "routines"
  are Home Assistant's own scenes/scripts; the gallery stays recipe-based.
- No mDNS listener, no repeated scanning: one question when the person presses Find.
- Private local mode keeps the old rule (Home Assistant through netFetch).

## Tests
`test/v2-home.test.ts` with `test/fixtures/fake-ha.ts` (a fake Home Assistant: REST + an mDNS
responder on loopback answering the real packet): found → tested → saved → a scene runs by a spoken
turn (no model call), typed text doesn't, a lock can't be picked and its card wants a tap.
