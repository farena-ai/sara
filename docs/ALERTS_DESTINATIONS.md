# Where alerts go

You choose where Sara's alerts and the results she posts on her own end up. For example, all stock
alerts can go to a chat called "Stock alerts" inside your "Stock Alerts" project, instead of whichever
chat you were in when you set each watch up.

## Using it

- **In chat:** "put my stock alerts in the Stock Alerts project", "send automation results here",
  "also send my sports alerts to Telegram". If the project doesn't exist yet, she asks first (a
  pick-an-answer card), then shows an approval card before she makes it. She tells you what changed in
  one sentence ("Your 4 stock alerts now post to Stock Alerts › Stock alerts").
- **When you make a watch:** "tell me when AAPL goes above 400 and post it in my Stock Alerts project".
- **In Settings → You → Automations → Where alerts go:** one row per kind, each with a place picker.
  A change there applies to the ones you already have too.
- **On one item:** every watch and automation on the same page shows *Posts to: …* with **Change**, for
  that item only. *Use the setting for all of these* removes the item's own choice.

## Places

| Place | What happens |
|---|---|
| Where it was set up (default) | Same as before: the chat the watch or reminder was made in, or the item's own chat (automations, goals, Travel, From your inbox). Research only sends the notification. If that chat was deleted, a chat named after the kind is used ("Stock alerts"), not whichever chat comes first. |
| A chat just for these | A chat named after the kind, made the first time something arrives. |
| A chat in a project | A chat named after the kind inside the project you pick, made on first use. |
| One of my chats | One of your own 1:1 chats with her here. |
| Only my chat apps | Nothing new here: Telegram/Discord (and the notification) only. Not offered for reminders and the briefing: those always keep a message here. |

Telegram and Discord switches send each alert to your own chat with her there as well. They show up
only once that app is set up. A message that the app already copies there ("mirror") isn't sent twice.

Kinds: Stock alerts, Sports and odds, Mail watches, Product watches, Automations, Research, Goals,
Travel, From your inbox, Reminders, Morning briefing.

## Safety

- She never posts alerts to a group, a room, a chat with someone else (partner), a private chat, or a
  chat in another app. The "here" and chat choices accept only your own 1:1 web chats.
- Each household member's space has its own settings, chats and projects, so one person's choices
  never reach another person's space.
- Making a project always needs your OK.

## Design (one page)

- `src/destinations.ts` is the shared module. A destination is
  `{ where: origin | chat | project | dedicated | apps, conversationId?, projectId?, telegram?, discord? }`.
  It is stored in `settings.alerts`: `feeds` (the default per kind), `items` (one item's own choice,
  keyed like the Automations page: `live:12`, `product:3`, `auto:5`, `goal:2`) and `made` (chats it
  created, per kind and project).
- `alertPlace(app, feed, { item, origin })` decides the chat, and `postAlert(...)` writes the message
  and sends it to the chosen apps. Each producer passes its own `origin` (today's behavior). Producers
  that use it: live watches (`src/live-watch.ts`), product watches (`src/shopping/watch.ts`),
  automations (their steps still run in the automation's own chat; what it tells you and a one-line
  result go to the chosen place), research done notices, S3 goal nudges and weekly summaries, S6 travel
  alerts, the inbox helper, reminders and the morning briefing.
- Pictures from her (`src/own-photos.ts`, stored in `photos.own.dest`) use the same chat placing
  (`placeChat`), the same owner-chat rule (`ownerWebChat`) and the same app check (`appReady`). How
  pictures behave hasn't changed.
- Moving a kind: `setFeedDest(feed, dest, alsoExisting)`. With `alsoExisting`, the items' own choices
  are cleared. Without it, each existing item is pinned to where it posts now, so only new ones move.
  Existing watches keep "where it was set up" until you change something (no migration step).
- Chat tool `alerts_route { feed | item, to, also_existing, off, create_project }`: matches project
  names and chat titles loosely ("stocks alert" finds "Stock Alerts"). With `create_project`, it asks
  first (approval card). It is in the `alerts` lean family.
- API: `GET/PUT /api/automations/alerts` (the list of kinds, chats, projects, apps; set a kind's
  default or one item's place). `GET /api/automations` items carry `postsTo`, `dest` and `feed`.
- Bridges: `sendOwnText(text)` on Telegram and Discord (the owner's own DM only).

What existed before: the destination picker for her pictures (3.13.1), each watch's
`conversation_id`, the producers' own chats (Automation: …, Goal: …, Travel, From your inbox), and
Telegram/Discord mirroring. Those were reused and extended.
