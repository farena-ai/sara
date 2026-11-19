# Live views in chat

She can put a small checklist, table or chart right in the chat that keeps itself up to date: a
packing list you tick off, this week's to-dos, the numbers one of your kept apps saves.

## Ask for one
- "Make me a packing checklist for Lisbon." A checklist you can tick appears in the chat.
- "Show my Home to-dos as a checklist." It lists the open Planner to-dos of that project. Tick one
  and the task is done in the Planner; finish a task anywhere else and it shows ticked here within
  a few seconds.
- "A chart of my runs" (or "a table of …") when one of your [My apps](MY_APPS.md) saves the numbers:
  whatever the app saves next shows up in the chart.
- To change one she made with her own data, just tell her ("add sunscreen", "tick the charger").

The card says **Live** while it updates. It checks every few seconds while you look at it, slower
after ten minutes, and not at all while the page is hidden.

## Where they live
Library → **My apps…** → **Live views in chats** lists every live view, where its data comes from,
**Open the chat** and **Remove**. Removing one stops it in every chat at once.

## What a live view can and can't do
- It runs in a sandbox, like My apps: it never gets your Sara sign-in, can't read the chat page,
  Sara's data or storage, and can't reach the internet.
- It can only read its own list, tick its own rows, and (for a small page she wrote) save its own
  data. A list over Planner to-dos can only tick the to-dos it shows.
- Each household member's live views stay in their own space.

Details for developers: [design](design/LIVE_CANVAS.md), [threat model](THREAT_MODEL.md).
