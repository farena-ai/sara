# W5.4 Kid mode v2 (one page)

## What existed (R8, U4.21-U4.23, W4.5, V5.4)
- `src/family.ts`: the `child` profile on a household member (age band 6-9/10-12/13-17, bedtime,
  minutes a day in 5-minute blocks, safe search, shop allowlist), `childRouteCheck` (routes a child
  may never use), `childSettings` (adult mode off), `KID_TOOLS` allowlist + `gateKidTools`,
  `kidOffLimits` + `KID_OFF_REPLY`, `kidNote` (her tone by band, homework hints), `topicsOf` and the
  parents' topics-and-minutes summary (never words), `kidPause` (bedtime / time used up).
- Family → Kids tab (`web/family.js`): the owner sets the profile; "What they talked about".
- W4.5 family screen: a kid's Talk turn in their own space (`kidSafe`). V5.4 caregiver consent:
  consent kept with the person, view built in code, withdrawing hides at once. N5b phone actions:
  signed one-use notification tokens (`/api/phone/act`).

## What v2 adds (extends the above; no new place, page or route family)
- **Age bands** `under-8`, `8-12`, `13-17` (old `6-9`/`10-12` are read as `under-8`/`8-12`). Each
  band has defaults (`BAND_DEFAULTS`): tools, tone (`simple`/`friendly`/`respectful`), content
  strictness (`strict`/`standard`), minutes a day, bedtime, study buddy. A new profile or a band
  change takes the band's defaults; the parent adjusts any of them. Tools are a subset of
  `KID_TOOLS`; `gateKidTools` also hides tools the parent turned off. Never for kids, whatever is
  asked or approved: adult content, money, computer use, Always allow, public records (not in
  `KID_TOOLS`, refused in requests).
- **School-safe content**: under 13 she explains and coaches and never writes essays, stories or
  reports to hand in; teens get help improving their own work. Study buddy style: asks what they
  think first, one hint at a time, a quick check question. Strict adds scary/gory asks to the
  kind "not here".
- **Time limits**: a friendly wind-down note to her when 10 minutes or less are left; extra minutes
  per day (`kid_extra`); the kid's bar shows time left and **Ask for 15 more minutes**.
- **Requests** (`src/kid-mode.ts`, table `kid_requests`): the kid asks (bar button, or her
  `kid_ask_parent` tool when they ask for something that is off) for more time, a tool, or
  something else; every parent gets a push with **Approve / Decline** (phone action kind `kid`)
  and the dashboard lists them. Approve: +15 minutes, the tool added to the profile (owner), or
  an answer only. Off-limits asks can't become requests.
- **Parent dashboard** (Family → Kids → Dashboard): today's time and limit with **+15 minutes**,
  7 days of minutes and topics in plain words, flagged moments (`kid_flags`: kept off, a worry,
  personal details shared; counts only, never words), requests with Approve/Decline.
- **Transcript view** (V5.4-style transparency): off by default. A parent may turn it on; the
  kid's bar then says "A parent can read your chats here" (and when they last looked), and her note
  tells her so she answers honestly. Only then may a parent read the chats; turning it off hides
  them at once.

## Routes (inside `/api/family`, member route; parents only unless noted)
`GET kids/:id/dashboard`, `POST kids/:id/extra {minutes}`, `GET kids/:id/chats[?c=]`,
`POST requests/:rid {approve}`, kid: `GET me/kid`, `POST me/requests {kind, tool?, what?}`;
the profile keeps `PUT kids/:id/profile` (owner). Phone: `/api/phone/act` kind `kid`.
