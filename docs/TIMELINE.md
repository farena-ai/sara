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
- **Why did you do this?** (W5.5) opens two short lines under the change:
  - what started it: your message (with the time you sent it), an automation by name (and whether its
    schedule, an email or an upcoming event ran it), a trigger, a webhook, a repeat you set in that
    chat, a goal, a worker's job, an errand, a Handle it plan step, another app or an outside
    request, or your own click;
  - why no card was shown, when none was: Always allow everything was on, you allowed it once ahead
    or for this task, you set that tool to run on its own, or the tool never asks first. If there was
    a card, it says you said yes on it.
  **Show the chat turn** opens that chat at the message. The reason is saved with the row at the
  moment of the change, so it is never worked out later; changes from before this existed say
  "From before this was recorded."
- Right after she changed something, ask her **"why did you do that?"** (also "¿por qué hiciste
  eso?", "pourquoi tu as fait ça ?", "warum hast du das gemacht?", "por que você fez isso?",
  "perché l'hai fatto?"). She answers from the same saved reason, without asking a model. If nothing
  was recorded since your last message, she answers normally.

Reverting is recorded in the audit trail. Nothing here calls a model. Design notes:
[design/V5TIMELINE.md](design/V5TIMELINE.md).
