# Getting it right the first time (N1)

Three small things that make Sara's answers more dependable: the right model per job (Auto), a
"did it work?" check after every change she makes, and a weekly look at how her replies went.

## Auto: the right model per job

**Settings → Models & usage → Which model does what** has **Auto (recommended)** for Talking, Coding (tools
and long tasks), Looking at pictures and Web research. Auto picks from what is connected, by a small
score per model:

- **Tools:** can it use tools (Ollama's capabilities; a model that refused tools here counts as no)?
- **Pictures:** for the picture job, only models that can see.
- **Speed here:** the middle time to the first word over this computer's recent replies (the run
  history); a reply that gave up waiting counts as slow. A big model on the processor (no graphics
  card) with no measurements yet sinks, the bigger the further.
- **Recent errors:** models that failed lately drop (one failure counts a little, many count a lot).
- **Strength:** tools and long tasks prefer strong models; talking prefers quick ones. Remixes
  (abliterated, raw Hugging Face pulls) are never the first choice.
- **Private:** a private chat (without its own Private model) and *Nothing leaves this computer* only
  ever pick models on this computer, and never fall back to a cloud model.
- **Spend limit:** when the day or month limit is reached, pay-per-use models are skipped.

The best two make the job's chain. If the first errors, says nothing after the empty-reply retry,
or hasn't said its first word in 45 seconds, the second answers once and a small note says so
("Slowpoke (nimble-flash) gave no answer within 45 seconds, so Speedy (steady-model) took over.").
Under each reply the model shows as "model (Auto)" with the reason in its tooltip ("Auto for
talking: first word in 2 s here, can use tools."). Her own model (per companion) still wins for
talking.

New installs start on Auto for all four jobs (when the first model provider is added). Existing
installs keep their choices; the model fitness notice (Settings → Models & usage, the full check) offers
**Use Auto (recommended)** with Undo. `GET /api/model-jobs/auto` shows what Auto would pick now.

## "Did it work?" after every change

After a tool that changes something succeeds, a read-back adds one line to its result: `Verified: …`
or `Could not verify: …`. Read-only tools get nothing.

| Tool | Check |
|---|---|
| write_file / edit_file | reads the file back (sha256): the same as written / the new text is there |
| fill_document | its own report (every field filled, read back from the copy) |
| make_document / invoice_make | the document number is in her documents |
| gmail_draft / gmail_send | reads the draft or sent email back from Gmail by its id |
| mail_draft / mail_send (Outlook, IMAP) | the mail server returned the saved item's id |
| calendar_add (Google, Outlook) | reads the event back from the calendar |
| todo | reads the task back from the planner (or that it's gone) |
| change_setting | reads the saved name back (device settings apply on the device: not verified) |
| pc_run | exit code 0 |
| desktop actions | the existing fresh look after the action |

"Done", "saved", "sent", "added", "filled" in her reply need a verified receipt: when every
changing tool behind the claim said *Could not verify*, the reply gets the usual gentle correction
(src/receipts.ts) and she says what wasn't confirmed instead.

## How she did (weekly, owner only)

**Settings → Privacy & system → Health → How she did** counts, for the last 7, 14 or 30 days, from her run
history on this computer: replies, failed replies, slow replies (over a minute), empty replies,
backup models that took over, desktop actions refused or done on a changed window, and changes she
could not check; the top five failure reasons (error class) with links to the chats; and tips. The
weekly review message gets a small card with the counts and *Open How she did*. Household members
never see it (`/api/quality` is owner-only).

Not sent to the support hub: the hub's ticket schema has no field for it (see
`docs/ops/HUB_TICKET_SCHEMA_NOTE.md`), so sending would need a hub change. Noted in the backlog.

Code: `src/auto-route.ts`, `src/verify-action.ts`, `src/quality.ts`; tests `test/n1-*.test.ts`.
