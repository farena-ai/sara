# Her at work

The same companion can help you at work, in Slack, Microsoft Teams or any work chat you choose, without
your work and your personal life ever mixing. Settings → Her → **At work**.

## Turning it on

1. Connect Slack ([SLACK.md](SLACK.md)) or Teams ([TEAMS.md](TEAMS.md)) first.
2. Open Settings → Her → At work and tick **Use a work profile**.
3. Tick the chats that are work: Slack and Microsoft Teams are ticked already. Matrix, Email, Discord
   work channels and Telegram work groups can be ticked too. Her chats in the app are never work chats.
4. If you like, give her a **Name at work** (for example *Ava from IT*) and a **Tone at work**: friendly
   and professional, formal, or brief and to the point. Press **Save**.

The name people see on Slack or Teams is the bot's own name set there; the work name is how she
introduces herself and signs her AI disclosure in work chats.

## What changes in a work chat

* **Memory**: work chats have their own memory. What she learns at work stays at work; your personal
  chats, notes, "last time", looking back (*recall*) and "lately in your other conversations" never reach
  a work chat, and work never reaches your personal chats. A chat that was a work chat once keeps its
  notes at work even if you later turn the profile off or untick that app.
* **Tools**: only her work tools: research (web search, reading pages), files in the **work
  workspace** (default `work`, never your own workspace), the calendar when Google is connected, and
  commands only if you tick **Commands**. Her album, pictures, outfits, plans, reminders, your computer,
  your servers, mail and the smart home stay out.
* **No companion features**: no moods or inner life, no diary or her day, no romance, no adult content
  (whatever Adult mode says), no role-play or games, no pictures of herself, no reminders or follow-ups
  about your private life. Her honesty rule stays: asked sincerely, she says she is an AI assistant.
* Your personal chats are unchanged.

## Copying a note across

Under **Work memories**, pick *Work notes* or *Personal notes*, find the note and press **Copy to
personal** or **Copy to work**. That makes a copy in the other space; the original stays where it is.
It is the only way a note crosses over. Each copy is one row in the audit trail (names only).

## For admins: work mode on a business server

On a server run for a business, Settings → Household → Policy → **Keep work mode on everywhere** pins
work mode: every chat on the server is a work chat, for every companion, the app included. The work
profile shows *Set by your admin* and can't be turned off, not even by the owner, until the policy
changes (the server refuses it). Her inner life, messages and pictures on her own stop. The pin only
tightens, like every other policy pin, and every policy and profile change is in the audit trail.

## Limits

One workplace per server (no per-tenant profiles). Her library documents stay out of work chats. Real
Slack and Teams checks are owner checks (`docs/OWNER_CHECKS.md`, EC26).
