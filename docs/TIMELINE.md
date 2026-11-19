# Action timeline: see and undo what she changed

Settings → Privacy & system → Reports → **Action timeline** (search "undo" or "revert").

Everything Sara changed for you is listed there, newest first, for 90 days: files in a chat's
workspace, the name she calls you and other settings, mail she sorted, events she added to your
calendar, to-dos, notes and reminders, and anything else she asked your OK for. Each household member
sees only their own.

- **Revert** puts a change back. Press it, then **Yes, revert**. The row then says when it was reverted.
  - Files go back to how they were just before that change. Later file changes in the same chat go
    back too; the files as they were are kept as a snapshot, so nothing is lost.
  - Mail moves are reversed for exactly the emails that change touched (within 30 days).
  - An added event is removed from the calendar; an added to-do or reminder is removed; a to-do she
    checked off is open again; a note gets its earlier text (a deleted note comes back).
  - The name she calls you goes back, unless you changed it again since.
- Changes that can't be undone say why, in plain words: a sent message can't be unsent, a deleted
  event can't be brought back from here, a change of text size or color lived on one device (use Undo
  on its chat card there).
- **Show** picks one kind (Files, Settings, Mail, Calendar, Planner, Other); **Show older** loads more.
- **Open the chat** jumps to the conversation where she made the change.

Reverting is recorded in the audit trail. Nothing here calls a model. Design notes:
[design/V5TIMELINE.md](design/V5TIMELINE.md).
