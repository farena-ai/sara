# Where do you text?

The quickest way to talk to Sara from the app you already use. Open **Settings → Connections → Apps
and services**. The **Where do you text?** card is at the top.

1. Tap **iPhone** or **Android**. The apps that are easiest on your phone move to the front and say
   *Easiest for you*. Apps that can't work on your phone say why (iMessage needs an iPhone and a Mac).
2. Tap the app you text in every day: Messages on iPhone, WhatsApp, Signal, Telegram, Discord, Element
   or another Matrix app, Slack, Microsoft Teams, or email. Sara shows what you need for it.
3. Press **Set it up**. That app's own page opens with what Sara can fill in already. For Matrix that is
   a suggested Matrix ID for her (like `@sara-alex:matrix.org`). For iMessage it is the BlueBubbles
   address you tested. The page then walks you through each step and checks each one with you.

## Once it is set up

- The tile shows **Connected** when her chat with you is linked, or **Started** while steps are left.
- **Check** runs the app's own checks and shows each one as a plain ✓ or ✕ line, with the fix for the
  first one that fails. It sends nothing to anyone.
- **Send me a test** (Matrix, iMessage, WhatsApp) sends one short message from her into *your* linked
  chat, so you can see it arrive on your phone. Nobody else gets it. If your chat isn't linked yet, it
  tells you to finish the link step first. The Matrix page has the same button next to **Test**.

## Is my Mac reachable? (iMessage)

Before you add anything, type BlueBubbles' address with its port (like `192.168.1.20:1234`) and press
**Test it**. Sara knocks once on BlueBubbles' `ping`. She sends no password and only tries this
computer, or with the switch, your home network or Tailscale. An internet address is never tried here.
The answer is one sentence. *BlueBubbles answers* means go ahead (the password is checked in step 4).
The other answers are: nothing answers there, too slow, something else is on that port, or not a local
address.

## Not here yet

- WhatsApp and Signal need a phone number of their own. Their setup pages work, but Sara's own tests
  run them only against stand-in servers.
- Sara doesn't look for your Mac on the network by itself yet: type its address.

See also: [Matrix](MATRIX.md), [iMessage](IMESSAGE.md), [Chats in Telegram and Discord](CHATS.md).
