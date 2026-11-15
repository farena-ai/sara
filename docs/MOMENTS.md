# Our moments

Since 1.10 (Phase 70) Sara keeps a shared photo album with you: **Our moments** in the sidebar.
It grew out of the scrapbook (Phase 9): every photo in your conversations, the ones you sent her
and the ones she sent you, plus the moments you keep with ♡, each with a short caption she writes
in her own voice. Each companion has her own album.

## What's in it

| Comes in by itself | When |
|---|---|
| Photos you send her and pictures she sends you | **Add photos → All photos** (the default) |
| Photos in messages you keep with ♡ (and her own kept moments, as words) | **All photos** or **Only kept moments** |
| Nothing | **Off** (add photos yourself with 🖼 under a photo) |

Never by themselves: private conversations, group chats, other people's chats (Telegram, Discord
partners), shared work channels (`…-work`), adult channels (`…-nsfw`), imported history and other
apps' conversations (`/v1`, MCP, Home Assistant). You can add a photo from a private conversation or
a group chat with 🖼 under it; photos from other people's chats and other apps can't be added at all.

Her screenshots from coding tools are not moments. Inside jokes stay in the scrapbook.

### After the update (backfill)

The first time the server runs 1.10, about 30 seconds after start-up (start-up never waits for
it), the album picks up every existing photo and kept moment from the conversations above. Only
the newest 40 get a caption by themselves; the rest show **Write the missing captions** (40 more
per press), so a large history never runs up a bill or keeps a local model busy for hours. Switching
**Add photos** back to *All photos* after *Off* does the same for the photos sent in between.

## Her captions

When a photo comes in she writes one or two short sentences as her memory of the moment: what you
two were talking about (the six lines before the photo and two after), in her own personality and
the language you talk in. Photos **from you** go to the *Looking at pictures* model (Settings →
Models & usage → Which model does what) when one can see pictures (Ollama reports it; other providers by
model name), so she can say what's in them; otherwise the caption comes from the conversation only.
Pictures **she** took use the scene she asked for.

- **In the background, a few at a time:** three captions a minute at most, after the server has
  been up for 30 seconds. Each call is metered as `moments` in Settings → Models & usage → Usage.
- **Cost note:** the album says which model writes them: *on your own hardware (free)*, *through your
  plan* (subscriptions), or *a paid model, about $X per 100 captions* (from your price table; if the
  price isn't known it says so).
- **Edit or regenerate:** press ⋯ on a photo. The caption saves when you leave the box (marked
  *Your words*); **Let her write a new one** asks again.
- **Facts only:** she's told to use only the conversation (and the picture), never to invent
  places, people or feelings. The place she names (only when the conversation or picture says it)
  fills the *Places* album; "is this the two of you" fills *Us*.
- **Safety:** if the conversation around a photo trips the minors block, nothing is sent to a model
  and the photo gets no caption; a caption that trips it is thrown away (*Held back by the safety
  check*), and so is a typed caption. With Adult mode off, an explicit caption is dropped and the
  photo counts as adults-only.

## Albums

| Album | What's in it |
|---|---|
| **All** | Everything, grouped by month, with **On this day** at the top when there is one |
| **Us** | Kept moments and photos of the two of you |
| **Places** | Photos where she could tell the place, grouped by place |
| **Her looks** | Pictures she sent, grouped by the outfit she wore (newer pictures; older ones under *Earlier pictures*) |
| Your own | Make one with **+ New album**, then tick it in a photo's ⋯ window. Rename or delete it (its photos stay) |

Any photo can be an album's cover (⋯ → *Cover of*); otherwise the newest photo is.

## On this day

When there is a photo from this day a year ago or more (or, if not, exactly a month ago), the album
shows it at the top and the **Today** page shows an *On this day* card. Click a photo to see it large.

## She can bring one up

Her `moments` tool lets her look through the album (`find`, by words or "on this day") and bring
one up with its photo (`show`: "remember this?"). Rules, enforced in code:

- at most **once a day** without being asked (asking about photos or memories doesn't count);
- never in group chats, shared work channels, other people's chats or other apps' turns (the tool
  isn't offered there);
- photos you added by hand from a private conversation only come up in private conversations;
- adults-only photos only while Adult mode is on.

## Seeing them large, saving and sharing

Clicking a photo opens the large picture view (zoom, swipe, arrows) with her caption under it.
**Save** names the file after the caption; **Share** (phones and some desktops) sends the photo with
the caption as its text.

## Removing and deleting

- **Remove from moments**: only takes it out of the album (and your albums). The message and the
  photo stay in the conversation, and it doesn't come back by itself. 🖼 under the photo brings it back.
- **Delete photo everywhere** (asks first): takes the photo out of every message (their words stay), the scrapbook, her list of pictures she took and the album,
  then deletes the file. It can't be undone (except from a backup).
- Deleting a conversation removes its photos from the album.

## Privacy

- Per companion: each album lives in that companion's own database.
- Only the signed-in owner sees it (`/api/moments`). There are no MCP tools or resources and no
  `/v1` route for it, API keys can't read `/api`, and her `moments` tool is left out of other apps'
  turns; tests check all of this (`test/phase70.test.ts`).
- Adults-only photos are hidden while Adult mode is off, and always in the phone apps (store rules).
- The demo server refuses the album and shows no *On this day* card.
- Backups include it (it's in `sara.db`, and the photos in `uploads/`). The JSON export
  (Privacy & system → Move in and export) doesn't, like the scrapbook.
- Captions go to the model that writes them: see [PRIVACY.md](PRIVACY.md).

## For developers

`src/moments.ts` (store, sync/backfill, caption job, worker, tool, delete everywhere), routes in
`src/server.ts` (`/api/moments…`, the `onThisDay` part of `/api/today`), the worker started in
`src/main.ts`, the page in `web/moments.js`, the caption line in `web/lightbox.js`.
