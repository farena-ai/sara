# Backups and the monthly test restore

A backup only counts once it has been restored. Sara makes a backup every day (Settings → Privacy &
system → Backups), can copy it off the server ([RECOVERY.md](RECOVERY.md) has the restore drill and
the readiness page), and since U5.31 she **tests a restore by herself once a month**.

## What you see

**Settings → Privacy & system → Backups → Test restores**

- **Test a restore every month** (on by default). Once a month, at a quiet hour (3 to 6 AM in your
  time zone), on her hourly maintenance check.
- **Also test the newest off-server copy** (shown once off-server copies work). The copy is
  downloaded, unlocked with your passphrase and checked the same way.
- **Test a restore now** runs it at once (one at a time).
- The last results: passed / failed / skipped, when, which copy, how long it took, and the reason in
  plain words.

A failed test restore sends you one notification and shows up as a self-repair problem (Settings →
Privacy & system → Health) until a later test passes. A skipped test (no backup yet, not enough
free disk space) is not a failure.

## What a test restore does

1. Picks the newest backup on this computer (and, if wanted, downloads the newest off-server copy
   into `<data>/tmp/restore-offsite-…` and decrypts it there).
2. Checks free disk space first: it needs about three times the backup's size. Otherwise it is
   skipped with the reason.
3. Restores it into a throwaway folder inside her own data folder (`<data>/tmp/restore-drill-…`),
   never over the live data and never in the system temp folder (the copy holds her keys).
4. Checks it read-only:
   - every file the backup lists came back, and each one's SHA-256 matches the list stored in the
     backup itself (`sara-backup-sums.json`, written by every backup since U5.31);
   - every database opens and passes `PRAGMA integrity_check`;
   - chats, messages and memories in the copy match the counts taken when the backup was made
     (within 1 % or 2 rows);
   - the vault opens with the copy's own key; only the number of entries is kept, never a name or
     a value.
5. Deletes the throwaway folder (also when a check fails or the check process dies).

Unlike **Run a restore drill** on the Readiness page, the monthly test does not start the copy: it
is lighter and needs no free port. Run the drill before a move or an upgrade.

## Design (one page)

| Part | Where |
|---|---|
| Counts at backup time + per-file hash list | `createBackup` in `src/backup.ts` (`manifest.counts`, last tar entry `sara-backup-sums.json`; `inspectBackup`/`restoreBackup` return `sums`, the list is never restored as a file). Older backups have no list: the hash step is skipped, everything else still runs. |
| The checks | `drillCopy` in `src/restore-drill.ts` (EC28), now with steps `hashes` and `counts` and a checks-only mode (`runRestoreDrill({ boot: false, file })`, child arg `--no-boot`). It still runs in a child process, so a big restore never blocks the server. |
| Schedule, rows, notice | `src/restore-test.ts`: `restoreTestDue` (on, a backup exists, the last run 30 days old, local hour 3–5), `runRestoreTest` (local, then off-server; disk-space guard; rows kept in `settings.restoreTest.history`, newest 24; one `backup.restore-test` audit row each; owner push notice on a failure), `restoreTestSummary` (for Settings and the U5.34 server dashboard). Called from the hourly backup maintenance tick in `src/main.ts`, next to the weekly off-server test. |
| Self-repair | `detectProblems` in `src/repair.ts`: problem `backup:restore-test` (level 1, high, page `dh-backups`) while the newest finished test of a source failed. |
| API (owner only) | `GET /api/backups/restore-test` (summary), `PUT` `{on, offsite}`, `POST` = Test a restore now (202; 409 while one runs). |
| Web | Section in `dh-backups` (web/index.html) + `web/restore-test.js`. |

Settings (`settings.json`): `restoreTest: { on: true, everyDays: 30, hour: 3, offsite: true, history: [...] }`.
