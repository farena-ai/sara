# V2.10 Friend-to-friend scheduling (design, one page)

"Find a time with Sam": your Sara and Sam's Sara trade busy blocks only (never event titles, places or
people), propose 3 times, and the slot is agreed when both of you pick the same one.

## What existed (reused, not duplicated)
- S9a links (`src/messages.ts`): the friend's server, its key, `peer`, `privateKeyFor`, `peerFetch`.
- S9b signing (`src/support.ts` `signSupport` / `SupportLink.verify`): per-scope signatures, replay ids,
  per-link rate limit. A new scope word `ftime` means a message/support/repair/sproj signature never
  passes here and the other way round.
- Calendars: `calendarEvents`/`hasCalendar` (src/today.ts, every Google/Outlook/CalDAV calendar, MULTIMAIL),
  planner tasks with a time (same rule as the booking page: a timed task keeps half an hour busy).
- Messages place UI (web/messages.js → web/support.js strip under a one-to-one chat), the planner
  (the agreed time becomes a timed to-do, so Today and the booking page see it), push notices.
- `src/a2a.ts` (agent-to-agent tasks) was looked at: it carries free text between agents, which is
  exactly what this feature must not do, so the data-only S9a scope is used instead.

## Flow (wire = POST /msg/v1/ftime/<op>, signed with scope `ftime`)
1. Alex (asker) picks the friend, what it is about, how long (15–120 min), part of day (daytime 9–17,
   evening 17–21, any time 9–21) and how many days ahead (1–21). Op `ask` carries only that.
2. Sam sees "Alex wants to find a time" in the Messages chat: **Share my free/busy** or **Not now**.
   Sharing is Sam's consent; nothing is read before it. Sam's server reads his calendars for the range
   and sends op `busy` with `{start, end}` blocks: all-day events skipped, each block widened to the
   15-minute grid, overlaps merged, plus the hours outside the chosen part of day *in Sam's own time
   zone* (so 9 am for Alex is never 3 am for Sam). Titles, places and attendees never leave.
3. Alex's server adds its own blocks the same way and answers that call with up to 3 free times
   (first free half-hour step on different days first, at least 2 hours from now). Alex's busy blocks
   never leave his server. Both servers now show the same 3 times (or "no common free time").
4. Each person taps the time that suits them (op `pick`, changeable). When both picks match, both
   servers mark it agreed and put "<what> with <friend>" in their planner at that time.
5. Either side can call it off (op `cancel`); the friend's "Not now" is a cancel before sharing.

The receiving side checks every op: only the link the request belongs to, only the asker gets `busy`,
only one of the proposed times can be picked; busy lists are rebuilt from `start`/`end` (anything else
is dropped), at most 600 blocks, inside the asked range.

## Surfaces
- Messages → one-to-one chat → strip: **Find a time with {name}** form, request cards (share/decline,
  3 time buttons with who picked what, agreed line, call off). Rows above the chat list for requests
  waiting for you.
- Chat tool `friend_time` (ask card): "find a time with Sam for coffee next week" starts step 1;
  `status` lists requests. Off in private chats, other apps, outside requests and group chats.
- Routes (owner only): `GET/POST /api/friend-time`, `POST /api/friend-time/:id/{share|decline|pick|cancel}`,
  `DELETE /api/friend-time/:id`.
- Storage: `<data>/friend-time.db` (requests only; busy blocks are never stored on either side).

## Not in this version
- No retry queue: if the friend's server is offline the action says so and can be tried again.
- Only two people per request; recurring meetings and calendar-event creation are left to the planner /
  calendar tools.
