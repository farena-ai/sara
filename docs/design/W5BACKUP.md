# W5.3 Backups you can carry (one page)

**Existed before:** daily local backups with retention (`src/backup.ts`, Settings → Backups), one
off-server copy encrypted with a passphrase to a folder or S3 (`src/offsite*.ts`, Phase 8/30), the
restore drill and the monthly test restore (`src/restore-drill.ts`, `src/restore-test.ts`, U5.31),
`--restore <file>` on the command line, S9a server links (`src/messages.ts`) with signed peer scopes
(`src/support.ts`), a QR maker (`src/qr.ts`) and the PDF writer's WinAnsi text (`src/documents/pdf.ts`).

**New (W5.3):** a recovery key you hold on paper, carry copies to drives and linked Saras sealed with
it, and a guided restore on a new computer. Nothing here replaces the off-server copy; both run.

| Part | Where |
|---|---|
| Recovery key | `src/carry-key.ts`: 16 random bytes + 2 checksum bytes = 18 words from a 256-word list (`WORDS`). `keyFromWords` accepts any case, commas, dashes or the QR text (`sara-recovery:1:<w-w-…>`); a mistyped word fails the checksum. The key lives in the vault (`backup:recovery`). |
| Sealed file (`.sara`) | `SARACRY1` + key fingerprint (8) + salt (16) + IV (12) + AES-256-GCM body + tag (16) at the end. Key = HKDF-SHA256(recovery key, salt). Header is the GCM AAD. A wrong key is told apart from a changed file by the fingerprint; any changed byte fails the tag. Sealed/opened as streams, never all in memory. |
| Recovery sheet | `src/carry-sheet.ts` builds a one-page PDF (words in a numbered grid, QR of the QR text, date, how to restore). Shown **once**: `GET /sheet` and `/sheet.pdf` answer 410 after "I printed it". A new sheet = a new key; copies made before keep needing the old sheet. Carry copies start only after the sheet is confirmed. |
| Carry copies | `src/carry.ts` `carryTick` on the hourly backup tick (`src/main.ts`, after the daily backup): each target (`settings.carry.targets`) gets the newest local backup when due (`every` day/week), sealed, `keep` newest kept. Folder targets: a drive picked from `listDrives()` (Windows letters, `/Volumes`, `/media`, `/run/media`, `/mnt`) or any full path; copies go to `<drive>/Sara backups/`. An unplugged drive is "waiting", never an error. |
| Another Sara | Peer scope `carry` on the S9a link (`POST /msg/v1/carry/{begin,part,end,list,drop}`, signed like S9b, 4 MB parts). Only sealed bytes cross; the holder never gets the key. The holder opts in per link with a size cap (`settings.carry.hold`), sees and can download/remove what it holds in `<data>/carry-held/<link>/`. |
| Restore on a new computer | `POST /restore` (a path on a drive, found by `GET /restore/found`) or `/restore/upload` → `POST /restore/:id/check {words}` (opens with the key, then the U5.31 checks-only drill on the opened copy) → `POST /restore/:id/stage` puts it in `<data>/restore-staged/`; `applyStagedRestore` runs it at the next start before anything opens the data (old data kept in `before-restore-*`). CLI: `--restore <file.sara>` with `SARA_BACKUP_KEY="<words>"`. |
| API (owner only, `backups` family) | `src/routes/carry.ts`, mounted before admin's `/api/backups`. |
| Web | Sections on Settings → Backups (`web/carry.js`, loaded from `loadBackups`). |

Settings: `carry: { sheet: {madeAt, confirmedAt, fp}, targets: [{id, kind, path|link, every, keep, last}], hold: {<link>: {on, maxMb}} }`.
