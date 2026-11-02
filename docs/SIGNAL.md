# Signal

Text Sara on Signal the way you text her on Telegram. Signal comes with Sara as a plugin: it talks to
**your own signal-cli** (a free program that runs a Signal account on a computer), and Sara holds
the connection to it. Design: [design/BRIDGES3.md](design/BRIDGES3.md) §4.

## What you need

1. **A number for her** that can get an SMS or a call (a spare SIM, a prepaid or VoIP number you
   own). Your own number works only for a quick try in Note to Self mode (below).
2. **signal-cli** (github.com/AsamK/signal-cli; it needs Java 25) on the machine that runs Sara, kept
   up to date: releases older than about three months stop working with Signal's servers.
3. Either install Signal on a spare phone with her number and run `signal-cli link -n Sara` (scan the
   code in that phone's *Linked devices*), or register the number with `signal-cli -a +… register`
   (solve the captcha if asked) and `verify` the code. Set her name:
   `signal-cli -a +… updateProfile --given-name Sara`.
4. Start the daemon, ideally as a service so it starts with the computer (a linked signal-cli drops
   after 30 days without running):

   ```
   signal-cli -a +15551234567 daemon --tcp 127.0.0.1:7583 --receive-mode=manual --no-receive-stdout --ignore-stories --ignore-avatars --ignore-stickers
   ```

   `--receive-mode=manual` keeps messages on Signal's servers while Sara is down. In Docker, run a
   signal-cli service on Sara's compose network, use `signal-cli:7583` as the address and switch on
   *signal-cli runs on another machine on my network*.
5. Protect signal-cli's data folder (`~/.local/share/signal-cli/`): it holds her account's keys.
   signal-cli's daemon has **no password**: keep it on 127.0.0.1 (or a private Docker network).

## In Sara

1. *Settings → Connections → Signal → Add Signal*. Read the card (*Comes with Sara*; it connects to a
   program on this computer at the address you give it), press *Install* (on Windows tick *I trust
   this plugin's author*), and switch it on for her (Settings → Plugins). It runs for one companion.
2. *Signal settings*: the address (default `127.0.0.1:7583`) and her number. Press *Test*: each step
   gets a ✓ or the fix. Nothing is sent to anyone.
3. *Link my Signal* gives a 6-digit code for 10 minutes. Send `/link 123456` to her number from your
   own Signal. She answers *Linked*. Your Signal account id and your safety number are remembered.

## What she does there

- **Your chat:** everything an owner chat has: tools, memory, pictures and files, commands (`/new`,
  `/stop`, `/status`, `/model`, `/steer`, `/queue`, `/btw` …), typing dots while she works.
- **Long jobs:** one progress message after 10 seconds, edited at most 7 times (Signal allows 10
  edits a message) at least 15 seconds apart, then its final line. Send `/stop` to stop. A message
  you send while she works gets a 👀 and is used at the next step (or waits its turn). A job longer
  than 5 minutes sends one *Still working* line and the whole answer when it's done.
- **Your safety number:** if it changes (a new phone, or someone who took over your number), she
  answers that chat without tools or memory and says why, until you press *It's me* in the plugin's
  settings (Sara then trusts the new key in signal-cli) or *Unlink*.
- **Other people:** off by default. A stranger gets one line (*I only chat with the person who runs me
  here.*) and nothing more. With *Let other people talk to her there* they get her partner chat: no
  tools, no memory, nothing private or sexual, the AI notice first.
- **Groups:** she answers only when she's mentioned or someone replies to her (or her name is said, if
  you switch that on), and only in groups you're in; others start off and have *Leave this group*.
  With *Owners can use her tools in groups* your calls there can use her tools. *Keep up with this
  room* (the room cards) works as on Telegram. Replies in a group quote the message she answers.
- **Pace:** at most one message a second per chat, 20 a minute per group, 60 an hour and 400 a day.
  She only writes to someone who wrote to her in the last 24 hours: she never writes first. If Signal
  rate-limits her, that chat pauses for an hour (all chats for 6 hours after 3 in a day) and you get
  one notification; solve the captcha with signal-cli `submitRateLimitChallenge` yourself.
- **Read receipts** are off unless you switch them on. **Disappearing messages:** her replies follow
  the chat's timer on phones; Sara keeps her own copy of the conversation, like every chat.
- **Private local mode** (*Nothing leaves this computer*) pauses Signal: the connection closes and
  messages wait on Signal's servers.

## Note to Self mode (a quick try)

Link signal-cli to your own account (`signal-cli link`, scan with your phone) and switch on *It's
linked to my own Signal*. She then answers only in your Note to Self, each reply starting "🤖 Sara:".
She can't talk to anyone else this way, because she would be writing as you.

## Not yet

Calls, stories, stickers out, view-once pictures, voice-note transcription, registering a number from
Sara, the signal-cli REST wrapper, and sending your reminders to Signal.

## Signal's terms

Signal's terms forbid bulk and auto-messaging and accounts made by automated means. Sara answers people
who wrote first, at a human pace, never registers accounts and never writes first to anyone. Signal
may still limit accounts that act like bots: use a number you can lose.
