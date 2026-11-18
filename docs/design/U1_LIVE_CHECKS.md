# U1.2 + U1.4: live account checks and the two-server pair check

Roadmap: [ROADMAP_U.md](ROADMAP_U.md) U1.2, U1.4. User guide: [../CHECKS.md](../CHECKS.md) (last section).

**What existed.** Loopback stand-ins for every mail kind (`test/mail-imap-fake.ts`, `test/mail-fake.ts`,
`test/mail-graph-fake.ts`), per-feature unit tests (multimail, mail-accounts, calendar-links, s9a, s9b,
t5), and one-off live drivers in the agents' scratch folder (msgpop, t5remote). Nothing an owner could run
again, nothing that walked every account kind or every cross-server flow in one go, no real-account path.

**What was built.**
- `scripts/checks-lib.ts`: `CheckRun` (steps pass / fail / skip with a plain detail, never throws; a
  report under `outputs/checks/<name>-<local date>.md`; `secret()` values scrubbed from console and file),
  `check`, `until`, `throwawayEnv`, and `RealCfg` + `missingParts` for `.secrets/test-accounts.json`.
- `scripts/check-accounts.ts`: an in-process Sara wired like `main.ts` (Google + later Google accounts,
  `MailAccounts` with IMAP/Graph/CalDAV, `CalendarLinks`, the Gmail / mail_* / calendar router tools) on a
  loopback port; accounts are added and removed through the Settings HTTP routes (Google and Microsoft
  sign-ins through their real connect → callback routes), mail and calendar work goes through real chat
  turns (`POST /api/conversations/:id/messages`, a scripted model step per turn, every approval card
  OKed over `/api/approvals/:id`). `--real` (spawned automatically when the secrets file exists, without
  the loopback override) repeats the flows on the owner's test accounts; sends only to the same address.
- `scripts/check-pair.ts`: two in-process servers (own temp folders, port 0) with a `Messenger`, S9b
  support and T5 repair on a fake T1 world (a crashed add-on), driven only over HTTP.

**Bugs found and fixed (tests first, `test/u1-checks.test.ts`).**
1. Settings → Remove on a later Google account (`DELETE /api/google/accounts/:id`) signed it out but
   kept its mail-view choices (left out of the combined inbox, calendar picks, calendar default, the
   default mailbox), so the next Google account to take that slot inherited them. The route now removes
   through `MailAccounts.remove`, which forgets them.
2. A new calendar event's confirmation ("Added … Thu 6:00 PM") re-read the asked wall time in the
   *server's* time zone and showed it in the owner's: wrong whenever they differ (a UTC VPS and an owner in
   Chicago). The event itself was right (TZID). `calendarWhen` now shows offset-less wall times as asked.

**Harness notes.** One chat per turn: a long chat gets tidied and the tidy-up eats a scripted model step.
Requests log on `console.info` (muted in the scripts). Reports are under `outputs/` (gitignored).

**Not covered.** A real Google *browser* sign-in (the real run takes a saved refresh token instead),
Microsoft Graph with a real tenant (needs the owner's Microsoft app; Outlook is checked over IMAP),
the web pages themselves (no UI changed).
