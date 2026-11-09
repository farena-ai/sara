# Watch a file

*Planner → Routines → Watch a file.* Sara reads the new lines of one file and tells you when a line
has a word you picked. She only reads. She never restarts, edits, deletes or fixes anything by
herself. If you want her to do something about an alert, ask her in the chat like any other
request, with your normal approvals.

## Turning one on

1. **Where:** one of your workspaces, or *Sara's own log* (offered only when `SARA_LOG_FILE` is set).
2. **File:** the path inside that workspace, for example `logs/app.log`.
3. **Words to look for:** up to 5, each 2 to 80 characters, for example `ERROR` or `disk full`.
   They are plain text, not patterns (`a.b*` matches exactly `a.b*`). *Ignore upper and lower
   case* is optional.
4. **How often:** every 5 minutes to once a day (15 minutes by default). *Check now* checks
   straight away (at most once every 10 seconds) and shows any earlier matching lines in the last
   256 KB as a preview.
5. **Alert cards go to:** which of your own chats gets the card. By default it is your most
   recent chat. Only your own chats are offered (never a guest's chat or a group room).
6. **Also send to Telegram / Discord** (off by default): shown only for a bridge that is linked
   to you. On, each alert also goes to your own Telegram chat with her or your Discord direct
   messages, never a group, a server channel or anyone else.

Both can be changed later under *Where alerts go* on the watch.

Only lines added **after** you turn it on count, so you don't get a flood of old ones.

## What you get

- A card in the chat (*Watch: app.log*) quoting the line, cut to 300 characters, with secrets
  scrubbed. It also sends a notification. *Ask about this* puts your own question about that
  line in the message box. If your chat model may run in the cloud, you are asked first.
- With *Also send to* on, the same alert (the same cut, scrubbed line and *+N more*) goes to your
  Telegram or Discord too. It is part of the same alert, so the limits below count it once.
- At most one alert per watch every 10 minutes and 12 a day across all watches. During quiet
  hours, and between alerts, new lines are held and arrive later as one alert (*+3 more*).
- When the same line comes back within 6 hours (numbers, times and paths aside), it counts up
  (*seen 14× since 09:12*) instead of sending another alert.
- If the log is rotated or truncated, the new file is read from the start. If more than 256 KB
  arrived at once, only the newest 256 KB are read and the watch says the rest was skipped.

## Limits

5 watches on and 10 in total. A watch ends after 30 days unless you turn it on again (*Turn on*
renews it). After Sara restarts, every watch is paused until you turn it on again. If the file is
missing or can't be read for 3 checks in a row, the watch pauses and tells you once. Alerts are
kept for 14 days, up to 200 per watch.

*Stop* ends checks immediately and keeps the alerts. *Stop and forget* deletes the watch and its
alerts.

## What can't be watched

Anything outside your workspaces (other than Sara's own log), links and files inside linked
folders, folders, devices, and files that hold keys or Sara's own data (`.env*`, `id_*`, `*.pem`,
`.secrets/`, `.ssh/`, `store.db`, the vault). Each check makes sure of this again, so a file that
is swapped for a link is refused. Remote files, system journals, regex and whole folders are not
supported.

## Who and privacy

Only you, the owner. Household members, the demo, guests and other apps (the `/v1` and MCP keys)
can't see or change watches. She has no tool to make one: she can suggest one, but you turn it
on. Checking uses no model and costs nothing. Matched lines stay on your server: the chat card is
an app note that the model never reads. A line reaches a model only when you ask about it, and
only that line. With *Nothing leaves this computer* on, only local models see it.
