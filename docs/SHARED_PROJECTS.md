# Shared projects (U4.26)

Share a project with a friend whose Sara is linked to yours under **Messages** (S9a). You choose who
(one friend or several), what they may do (**Can view** or **Can edit**) and what is shared (notes,
to-dos, files, and, off by default, chats of that project). Changes go both ways over the same signed
link and catch up when either server was offline.

## Using it

- **Share:** open a project → **Shared with friends** → *Share this project* → pick the friend, what
  they may do and what is shared → *Send the invitation*. More friends: *Invite* on the same card.
- **Accept:** your friend sees the invitation in **Settings → Connections → Phone and notifications →
  Shared projects** (and a phone notice) and presses *Accept*. A project of the same name appears in
  their projects; the card there shows the shared items.
- **Work together:** add notes, to-dos, files (up to 2 MB, from your computer) and, if chats are
  shared, a chat of the project (a scrubbed transcript; *never* private, adult or other-app chats).
  Viewers only look. The card's **Activity** says who did what.
- **Ask Sara:** inside a chat of the shared project, ask about it ("what's on our shared to-do list?").
  She reads her own server's copy with `shared_project_read`; in any other chat, in private chats and
  for other apps, group chats or outside requests she can't.
- **Notices:** *Quiet* (default) only counts changes on the card and in Settings; *Tell me about every
  change* sends one phone notice per batch; *Nothing* turns both off.
- **End it:** the owner can change a friend's role, *Remove* a friend or *Stop sharing*; a friend can
  *Leave*. The friend's copy stops updating and stays as a read-only last copy until they delete it.

## Design (one page)

**What existed and was reused.** S9a links (`src/messages.ts`: Ed25519 keys per link, `peer`,
`privateKeyFor`, `peerFetch`, `whenClosed`), S9b's signed-call format and replay check
(`signSupport` / `SupportLink.verify` in `src/support.ts`, new scope word `sproj`), Planner projects,
notes and to-dos (`src/planner.ts`), the project page (`#project-page`), the Library (files from it),
the redactor (chat transcripts), the reminder tick (`ReminderScheduler.tick`), Web Push (T4 notices),
the `pm` live event, `unshareableChat` mirrors Ask's hidden-chat rule. EC11 conversation share links
(`src/share.ts`) are public snapshots and stay separate.

**Storage.** `<data>/shared-projects.db` + `<data>/shared-projects/<sha256>` (file bytes), owner space
only. Tables: `shares` (side host/guest, local project id, my role, kinds, status, notices),
`members` (per friend: role, status, `acked` = last event seq they confirmed), `items` (one row per
shared item with `version`, `at`, `by`, `deleted`), `log` (events to send), `activity`. Shared items
never enter the planner, memory, Ask or the Library: the host's project notes/to-dos are *copied* in
when a kind is turned on; everything else of either owner stays where it is.

**Sync.** Every local change writes an event `{item, kind, title, body, done, sha, version, base,
at, by, deleted}` to `log`. The host is the hub: each friend pushes its own events to the host; the
host applies them and re-logs them so every other friend gets them. Each push carries `last` and the
reply acknowledges it; unacknowledged events are resent on the next change or reminder tick, so a
server that was offline catches up in order. The host's pushes also carry the friend's current role,
the shared kinds and the name. Turning a kind off removes those items everywhere (delete events).

**Conflicts: last writer wins** per item, by `version`, then time, then name, the same answer on both
sides. A file changed on both sides while apart (`base` older than the current version) keeps the losing
edit as a "(conflict copy, Name)" file, made only by the side that held the losing edit, so there is
exactly one copy. Notes and to-dos simply take the winner.

**Wire.** `POST /msg/v1/sproj/{invite|answer|leave|remove|events}` with headers signed over
`sproj\n<link>\n<time>\n<op>\n<sha256(body)>` (5-minute skew, replay ids remembered). A message,
support or repair signature never passes here. Ops carry data only: there is no read, look or run op,
so the other server (or its Sara) can never read anything that was not shared, ask your Sara anything
or act on your server. Body limit 8 MB, files up to 2 MB.

**Roles are enforced where events arrive.** The host refuses events from a viewer, from a removed or
departed friend, and for kinds that are not shared (403); a friend's server refuses events from anyone
but the host and from an ended share. The pages also refuse locally (403 / 409), but the receiving check
is the one that counts. A 403 on push marks the member removed (host) or the share ended (friend).

**Privacy and modes.** Owner only: household members, kid mode and the demo have no Messenger, so the
engine, routes (403), peer endpoint (404) and tool do not exist for them. Private local mode stops all
sending and the peer endpoint answers 403. The tool is in `PEOPLE_TOOLS` (never offered to other apps,
group chats or outside requests) and answers only in a non-private chat whose project is the shared one.

**Files.** `src/shared-projects.ts` (engine), `src/routes/shared-projects.ts` (API + peer endpoint),
`src/tools/shared-projects.ts` (`shared_project_read`), `web/shared-projects.js` (card + Settings list),
tests `test/u4-shared-projects.test.ts` (two in-process servers).

**Limits / not yet.** Changing a shared note does not change the host's original planner note (and the
reverse); files are whole-file (no merging), 2 MB each; one host per share (the host relays); chats are
snapshots taken when shared (`PATCH …/items/:id {refresh:true}` on the sharing side updates one), not live.
