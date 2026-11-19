# W5.5 — "Why did you do this?" on every action

**Spec (ROADMAP_W W5.5):** every action timeline row gets "why did you do this?" with the message and
rule that triggered it. User doc: [../TIMELINE.md](../TIMELINE.md).

## What existed
- V5.1 action timeline (`src/timeline.ts`, `action_timeline` table, `noteAction` from chat.ts for
  every tool that changes something, `toolChanges` rule shared with the claim checker), web
  `web/timeline.js` in Settings → Reports. Handle it, her weekly check-in and What she knows write
  rows directly.
- The W1.2 nudge "Why did I get this?" toggle (same UI pattern reused here).
- W0.7 Always allow (`allowAllSkipped` in chat.ts + its audit row), "Allow for this task" /
  standing OKs (`prep.auto`), allowed-once-ahead loop keys, per-tool "Always allow this tool"
  (`toolPermissions[name] = 'auto'`).
- Starters: automations, errands / Handle it, event triggers, webhooks (all through
  `app.runTracked`), goals and loops (`opts.persist`), workers and team helpers (team.ts runs tools
  itself, no timeline rows before this).

## What was built
- `src/action-why.ts` (no server imports): `ActionCause` (kind + label/step/how + messageId/at/text
  of the chat turn), `ActionRule`, `ruleOf` (fixed order: card > always-allow > allow-once > task >
  tool-on > auto-tool), `whyLines` (en() keys shared by web and chat), `asksWhyThat` (whole-message
  matcher, six languages).
- `action_timeline.why` (TEXT JSON, added with `ALTER TABLE` on old tables; NULL = an older row →
  "From before this was recorded."). `record({ why })`, `noteAction({ why })`.
- chat.ts: `TurnOptions.cause` and `PersistTurn.label`; the turn's cause is built once (opts.cause,
  persist, outside request, other app, else the person's own message with its id, time, text and
  channel); the rule per call from the real gate variables. Starters pass their cause: automations
  (name + trigger kind), errands (goal + step; Handle it when `facts.handleKind`), triggers,
  webhooks, goals (`g.text`), loops (`l.prompt`). team.ts and the automation email step now call
  `noteAction` too; Handle it, know and her-week rows carry their cause.
- `GET /api/timeline` adds `whyLines` per row; web row: "Why did you do this?" toggle
  (`aria-expanded`/`aria-controls`) + "Show the chat turn" (`openTurn` → `jumpToMessage`).
- Chat: "why did you do that?" right after an action (rows in this chat since his previous message,
  newest 3) → a deterministic answer from those rows (`whyAnswer`, trOwner), meta `why.rows`; no
  rows → the normal model turn (nothing to read, so nothing made up).

## Limits
- Rows only exist for changes (read-only tools are skipped, as before).
- The person's words in the cause are clipped to 160 characters and stay in the same space's
  sara.db as the chat itself.
