# Slack (unreleased, EC1)

Talk to her in **Slack**: in her DMs, and in the channels you choose when someone mentions her. You
create a small Slack app of your own from a manifest the Slack card shows; it's free and takes about 10
minutes. There is no Sara account, relay or hub in between, and **no public address**: Slack's *Socket
Mode* lets Sara connect out to Slack over a WebSocket, so nothing on the internet has to reach Sara. The
design is [ops/EC1_DESIGN.md](ops/EC1_DESIGN.md).

Slack comes with Sara as a plugin and stays **off until you add it**.

## What you need

- A Slack workspace where you may add apps (a free workspace of your own works).
- Slack open on a computer.
- About 10 minutes.

## The four steps

*Settings → Chat apps → Slack* and press **Start**, then **Add Slack** on the short step that says what
it can reach (slack.com only). Each step turns ✓ only when Sara has checked it.

1. **Create the Slack app.** Press *Copy the manifest*, open api.slack.com/apps → *Create New App* →
   *From a manifest* → pick your workspace → *JSON* → replace everything with the manifest → *Next* →
   *Create*. The manifest turns on Socket Mode and interactivity (for the Allow/Deny buttons), adds
   `/sara`, and asks only for what she uses: `app_mentions:read`, `chat:write`, `im:history`,
   `im:read`, `im:write`, `files:read`, `files:write`, `users:read`, `channels:read`, `groups:read`,
   `commands`, `reactions:write`.
2. **Make the two tokens and paste them.** *Basic Information → App-Level Tokens → Generate Token and
   Scopes*, any name, scope `connections:write` → copy the `xapp-…` token. Then *Install App →
   Install to Workspace → Allow* → copy the *Bot User OAuth Token* (`xoxb-…`). Paste both and press
   *Save and check*. Sara checks the shapes first (a token in the wrong box is caught before anything is
   sent), then asks Slack (`auth.test` with the bot token, `apps.connections.open` with the app-level
   token). Both are kept encrypted in Sara's vault and never shown again; a token Slack refuses isn't
   kept.
3. **Link your Slack account.** Press *Link my Slack* and send her `link` and the code in her DM in Slack
   (Apps → her app → Messages). `/sara link` and the code works too.
4. **Test.** Checks both tokens, Socket Mode, the live connection and the link. Sends nothing to anyone.

## What she does there

- **Her DM is your own chat:** tools, memory, pictures and files both ways (20 MB each), a progress
  message she edits on long jobs with a **⏹** button that stops her, a 👀 on a message that steers her.
- **Approvals:** when she needs your OK for a tool, her message has **Allow** and **Deny**. Only you can
  answer (Sara checks your Slack user id and that the request was sent to that chat); anyone else is told
  so privately and nothing changes. Afterwards the buttons become *Allowed.* or *Denied.*
- **Threads:** a reply in a thread of her DM is its own session; she answers in that thread.
- **Channels:** invite her (`/invite` and her name), then press **Answer here** next to the channel on the
  Slack card. She answers only when mentioned, in the mention's thread, as in any room: no tools and
  nothing private, unless *Owners can use her tools in groups* is on (then your own mentions are work).
  Channels you haven't switched on are ignored.
- **Commands:** `/sara help`, `/sara new`, `/sara stop` and the other chat commands ([CHATS.md](CHATS.md)).
- **Other people:** someone else who DMs her gets one line, then nothing; with *Let other people talk to
  her* and your list they talk to her as partners (no tools, nothing private, the AI notice first; their
  pictures only, never other files). Strangers' files are never downloaded.
- **Reminders:** *Send reminders and messages she starts to my Slack DM too* sends them to your DM, never
  to channels.

## When something is wrong

Every failure is one plain sentence on the card with the fix: a token in the wrong box, a token Slack
didn't accept, a token Slack ended (the app was removed or the token revoked: she stops and tells you
once, no reconnect loop), Socket Mode off, a missing permission (paste the manifest again and reinstall),
not in that channel, Slack asking her to slow down (she waits what Slack says and sends the same message
again), a file too big, and Slack not reachable. A dropped connection reconnects by itself (1, 2, 4 … up
to 60 s; Slack's own refresh at once).

## Disconnecting and removing

*Disconnect* revokes her bot token at Slack and removes both tokens from Sara. Removing the plugin
(Settings → Plugins) deletes both tokens from the vault too. To remove the app from your workspace:
api.slack.com/apps → her app → *Install App* → *Remove* (the app-level token goes with the app).

## Who can read it

Slack keeps the messages in your workspace, so whoever runs it (your company) can read them. For private
chats use [Signal](SIGNAL.md). In private local mode ("Nothing leaves this computer") Slack pauses.

## Testing with a stand-in Slack

`test/fixtures/slack/fake.mjs` is a stand-in Slack written from Slack's public API docs (the Web API and
the Socket Mode WebSocket on a test certificate); `test/ec1-slack.test.ts` runs the real plugin against
it through Sara's socket broker. No Slack workspace has been tried yet: see
[OWNER_CHECKS.md](OWNER_CHECKS.md).
