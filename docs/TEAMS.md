# Microsoft Teams (unreleased, EC7)

Talk to her in **Microsoft Teams**: in her personal chat, and in the channels and group chats you choose
when someone mentions her. You make a free **Azure Bot** in your own Microsoft 365 organization and
upload a small **Teams app package** that Sara builds for it. There is no Sara account, relay or hub in
between. The design is [ops/EC7_DESIGN.md](ops/EC7_DESIGN.md).

Teams comes with Sara as a plugin and stays **off until you add it**.

## What you need

- A Microsoft 365 organization where you may add custom apps in Teams (or a Teams admin who allows it).
- An Azure account in that organization. The bot's **Free (F0)** tier is enough: Teams messages cost nothing.
- **A public https address for Sara** (see below). Unlike Slack, Teams can't be reached by a connection
  Sara opens: Microsoft sends every message to the bot's *messaging endpoint*.
- About 20 minutes at a computer.

## Teams must reach Sara: the two cases

- **Sara has a public https address** (your own domain from the installer, `SARA_HOOK_URL`, or the
  public door already open): nothing else is needed. The card shows the full *messaging endpoint* to
  paste into the bot.
- **No public address** (Sara only on your home network or Tailscale): Teams can't reach this computer.
  It needs a public https address that forwards `/hook/` to Sara. Either press **Open the public door**
  on the card (Tailscale Funnel, free; only `/hook/` becomes public, the app stays private), or paste the
  address of a tunnel you run (Cloudflare Tunnel or another https proxy that forwards `/hook/`).

Either way only one secret path is public, and **Sara checks Microsoft's signature on every call**
before the plugin sees it (the Bot Framework token: Microsoft's published keys, the issuer, your App ID
as the audience, the time, the Teams endorsement and the Bot Connector address). A call that fails is
refused with 401 and counted on the card.

## The seven steps

*Settings → Chat apps → Microsoft Teams* and press **Start**, then **Add Microsoft Teams** on the short
step that says what it can reach. Each step turns ✓ only when Sara has checked it.

1. **Make the Azure Bot.** portal.azure.com → *Create a resource* → *Azure Bot* → *Create* → any bot
   handle → *Pricing tier: Free (F0)* → *Type of App: Single Tenant* → *Create new Microsoft App ID* →
   *Review + create* → *Create* → *Go to resource*.
2. **Copy three values and paste them.** On the bot: *Settings → Configuration* → copy *Microsoft App ID*
   and *App Tenant ID*; *Manage Password → Certificates & secrets → New client secret → Add* → copy the
   **Value** (not the *Secret ID*; Azure shows the value only once). Paste the three and press **Save and
   check**: Sara asks Microsoft for a token. The secret goes to Sara's vault and never comes back to the
   page; a refused secret isn't kept.
3. **Give Teams a way in** (the two cases above).
4. **Paste the messaging endpoint and add Teams.** *Configuration → Messaging endpoint* → paste the
   address from the card → *Apply*; then *Channels → Microsoft Teams → Agree → Apply*. This step turns ✓
   when the first signed call from Teams arrives (after step 5).
5. **Add her in Teams.** **Download the Teams app package** (`sara-teams.zip`: a manifest naming your
   bot, her icon at Teams' two sizes), then in Teams *Apps → Manage your apps → Upload an app → Upload a
   custom app* → pick the zip → *Add* → *Open* and say hello. No *Upload a custom app*? Your Teams admin
   must allow custom apps (*Teams admin center → Teams apps → Setup policies → Upload custom apps*).
6. **Link your Teams account.** Press **Link my Teams** and send her `link` and the code in her chat.
   That's how Sara knows which Teams account is you.
7. **Test.** Checks the three values, a token from Microsoft, the public address, a signed call from Teams
   and the link. Sends nothing to anyone.

## Using it

- **Her personal chat** is your own chat with her: tools, memory, pictures and files.
- **Approvals:** when she needs your OK for a tool, an Adaptive Card shows **Allow** and **Deny**. Only you
  can answer (Sara checks it); anyone else is told *Only the owner can answer that.* The card then says
  *Allowed.* or *Denied.*
- **While she works:** one progress card she updates, with ⏹ to stop her.
- **Channels and group chats:** add her app to the team, mention her once there (she stays quiet), then
  press **Answer here** on the card. She answers mentions in their thread, without tools or anything
  private, unless *Owners can use her tools in groups* is on.
- **Files:** your files (from OneDrive) and pasted pictures reach her, 20 MB each. Hers arrive in your
  personal chat as a card: tap **Allow** and Teams puts the file in your OneDrive. In channels she can't
  send files (that would need Microsoft Graph and SharePoint permissions); she says so.
- **Pace:** at most 3 messages at once then 1 a second per chat, 600 an hour, 3,000 a day; when Teams asks
  her to slow down she waits as long as it says.
- **Errors in plain words:** a wrong App ID, directory or secret, an expired secret, no public address,
  no call yet, unsigned calls: each is one sentence with its fix on the card.

## Who can read it

Teams keeps the messages in your Microsoft 365 organization, so whoever runs it (your company) can read
them. For private chats use Signal.

## Removing it

**Disconnect** on the card removes the client secret from Sara. Settings → Plugins → Microsoft Teams →
**Remove** deletes the plugin, its secret and its public hook address. To end it at Microsoft too, delete
the client secret (or the Azure Bot) in the Azure portal and remove her app in Teams.

## Not in this version

Government and other national clouds, Microsoft Graph (channel files, reading history), meetings,
message extensions, tabs, messaging people who never wrote to her, and organization-wide publishing by
an admin.
