# V5.1 Action timeline with Revert (design, one page)

Roadmap: [ROADMAP_V.md](ROADMAP_V.md) V5.1 (item 31). User doc: [../TIMELINE.md](../TIMELINE.md).

## What existed (reused, not rebuilt)
- `src/snapshots.ts`: a workspace snapshot before every chat-mode `write_file` / `edit_file` / `shell`
  (chat.ts), restore with a safety snapshot. No list outside the coding page.
- Mail: `mail_organize` / `gmail_organize` keep 30-day undo records; `mail_undo` / `gmail_undo` (and the
  result card's Undo) reverse exactly those emails.
- Calendar: `calendar_add` returns the event id; `calendar_remove` deletes by id (Google and mailbox calendars).
- Planner (`src/planner.ts`): to-dos, reminders, notes with version history and a 30-day trash.
- `change_setting` (`src/everyday-settings.ts`): the card's Undo for device settings; the name she
  calls you is server-side.
- Per-feature Undo (safety check-up, cost autopilot, memory tidy, self-code rollback) and
  `src/audit-trail.ts` (who did what, no undo). Those stay where they are.

Missing was one place that lists what she changed and puts it back.

## What V5.1 adds
- `src/timeline.ts`: a registry + per-space table `action_timeline` in that space's `sara.db`
  (members get their own). Two calls in chat.ts: `timelineBefore()` just before a tool runs and
  `noteAction()` after a successful run (not in replays). Rows keep 90 days / 2000 rows.
- What gets a row: a tool with a describer (`registerAction(tool, describe, before?)`), or any tool
  that asks first (`defaultPermission !== 'auto'`). Quiet auto tools without a describer are reads
  and are skipped (to-do list, note search, web search…).
- Each row: kind (files, settings, mail, calendar, planner, other), the tool's summary plus an
  optional plain line (`title` en() key + params, translated in the web), and either an `undo`
  (`{type, …}`) or a `never` reason said plainly (en() key).
- Reverters (`registerRevert(type, fn)`): `snapshot` (restore), `owner-name` (refuses when changed
  again since), `tool` (runs the existing undo tool directly: mail_undo, gmail_undo, calendar_remove;
  its `prepare` refusals are honored), `task-delete`, `task-status`, `task-restore`, `note-restore`,
  `note-delete`, `reminder-cancel`, `reminder-add` (refuses a time in the past).
- Revert claims the row first (no double run on two clicks), unclaims on failure, writes an
  audit-trail row `timeline.revert`. Revert is the person's own click, so no second approval card.
- Routes `/api/timeline` (GET list `?kind&limit&before`, POST `/:id/revert`; 404/409 with plain
  reasons); family in `MEMBER_ROUTES`.
- Web: hosted page `dh-timeline` "Action timeline" under Privacy & system → Reports (SETTINGS3
  section, tips, kind filter, Show older, two-step Revert with a files warning, Open the chat),
  `web/timeline.js`, search words undo/revert, 2 How do I answers.

## Labeled, not reverted (said on the row)
Sent messages; deleted or edited calendar events (no earlier copy kept); device-only settings (undo on
that device's chat card); shell/file changes in coding mode without a chat snapshot; undos themselves;
any asking tool without a describer ("no undo yet").

## Adding an undo for a new feature
```ts
registerAction('my_tool', ({ args, output, before }) => ({ kind: 'other', undo: { type: 'my-undo', id: … }, title: en('Did {x}'), params: { x } }), (args, app) => /* read before it runs */);
registerRevert('my-undo', async (u, app) => { … }); // throw TimelineError(409, en('…')) when it can't
```
Then translate the en() strings (i18n-extract finds them).
