# Support link: one owner helps another (S9b)

Roadmap: [ROADMAP_S.md § S9b](design/ROADMAP_S.md). Built on an S9a link ([MESSAGES.md](MESSAGES.md)):
two owners whose Sara servers are linked can help each other. The helped owner gives a **help pass**;
with it, the helper's Sara can **look** at the helped Sara (health, errors, logs with private things
removed, settings without keys) and **suggest** a fix. **Nothing changes without the helped owner's
OK**, and there is no shell, no file access and no remote computer use. Owner only (household members
and kid mode never; not on the demo).

## Using it

- **Link first**: Messages → *Link a server* (one-time code), as for messages. The support link uses the
  same link and its keys; there is no second code.
- **Helped side** (Hank): open the one-to-one chat with the helper → **Ask Sam for help** → pick
  *1 hour*, *1 day* or *7 days*, optionally say what's wrong → **Give a help pass**. The chat shows
  *Sam has a help pass until …* with **Revoke** (any time). A new pass ends the old one.
- **Helper side** (Sam): the chat shows *Hank gave you a help pass until …* and **Look at Hank's Sara**:
  what looks wrong (findings), models, health, self-test, recent errors, versions and apps, and the last
  log lines. **Ask Sara to explain** opens a new chat with that summary in the box (unsent).
  **Suggest a fix**: one setting from the list below with its new value, and/or a plain note.
- In a chat with her, the helper can also just ask (*"what's wrong with Hank's Sara?"*): the
  `support_look` tool asks once per pass, then reads and summarizes; `support_propose` asks every time.
- **Approval card** (helped side): *Sam suggests:* a table with each setting, its value now and after,
  and the note. **Approve** applies exactly that; **Decline** changes nothing. A note-only suggestion has
  **Done** / **Dismiss**. Suggestions also show above the chat list and as a notification.
- **Help log** (both sides, under the strip): every pass, revoke, look, suggestion and answer.
  Each also writes an audit row (Settings → Privacy & system → Audit trail): owner actions as
  `support.do`/`support.remove`, the other server's looks and suggestions as `support.look` /
  `support.propose` (`who: link:<name>`), refused ones with outcome *refused*.

What can be suggested (the allowlist): default model service, default model, backup models, seconds before
a backup takes over (10-600), the jobs Auto picks a model for, how much of a chat she reads, the
overnight memory tidy (on/off), inner life (on/off). Never keys, permissions, tools, adult mode, private
mode, sharing, shell or computer use.

## Design (one page)

| | |
|---|---|
| Code | `src/support.ts` (SupportLink: passes, proposals, log, wire, allowlist, findings), `src/routes/support.ts` (owner API, peer endpoint, the report and its scrubber), `src/tools/support.ts` (`support_look`, `support_propose`), `web/support.js` (the strip, cards, look and fix panels; called from `web/messages.js`). |
| Storage | Its own `<data>/support.db` (passes, proposals, log, replay ids), opened with the owner's Messenger and closed with it. No message text, no report is stored. |
| Wire | `POST /msg/v1/support/{pass,revoke,look,propose,answer}` with `sara-sup-link`, `sara-sup-time`, `sara-sup-sig` = Ed25519 (the S9a link's keys) over `support \n link \n time \n op \n sha256(body)`. The scope word and the op are signed, so an S9a message signature never passes here, a support signature never passes on `/msg/v1/inbox`, and a `look` signature can't be reused as a `propose`. 5 min skew, body ids remembered (409), community links never count. Only for the owner (404 for members and the demo). |
| Pass | Helped side: `sp_passes` row (1, 24 or 168 h); `look`/`propose` from the other side need a pass that is not expired or revoked on *this* side (403 otherwise, audited). The helper's copy only drives its buttons and tool. |
| Report | Read-only and built per look: versions + update state (Updater), health checks (`healthReport` minus the data folder), the self-test without consent flags (nothing is written), turn errors (`turnerror` notices: class + scrubbed text), provider errors (`callTrouble`), tool errors (tool name + time only), the last 80 log lines, settings (allowlisted values + a shape of which keys are set, providers with `key: true/false`, no addresses), model status, app versions (`AppInstalls`). |
| Redaction | Each log line / error text: hidden whole if it names a medical or intimate topic (`categoryOf`, src/movein/text.ts) or repeats any four words in a row from the last 400 chat messages or the latest private messages; otherwise the redactor (vault values, key shapes) + the hub diagnostics scrubber (emails, long tokens, paths, IPs) + quoted text cut. Then every string in the report goes through the scrubber once more. |
| Proposals | Helper: path on the allowlist and value shape checked; helped: `cleanChange` checks again against its own settings (known provider ids, model name shape, 10-600 s, booleans). Stored as a pending card with the exact diff; Approve writes exactly that patch with `settings.update`, then the helper is told (`answer`). A card is answered once (409). |
| Tools | Owner's companions only (main.ts, next to the Messenger), hidden without a held pass, off in private chats and private local mode (OFFSERVER_TOOL / lean OFF), lean family `support`. `support_look` asks once per pass (`prepare` → `auto` after the first run on that pass); `support_propose` always asks. |

## Limits and gaps

- The helper reads the report on their own server: a look is only as private as that owner's Sara.
- The four-word filter can hide harmless log lines that happen to share words with a chat (over-hiding
  on purpose). It only knows the last 400 chat messages and recent private messages.
- Settings outside the allowlist can only be suggested as a plain note the helped owner follows.
- An expired pass is shown as ended; there is no reminder before it ends.
- Never checked across two real machines or over the internet; loopback only (as S9a).
