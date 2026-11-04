# Questions and answers

## Common questions

**Is Sara a real person?**
No. Sara is software: an AI companion. The app always shows an "AI companion" badge, repeats the
notice regularly, and she tells you she's an AI whenever you sincerely ask. See
[DISCLOSURES.md](DISCLOSURES.md).

**Does it cost anything?**
Sara is free (MIT license). You pay for the model she uses, if it's a cloud model, and for the
computer she runs on. [COSTS.md](COSTS.md) explains how to work out your own numbers.

**Which model should I use?**
[CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md) has concrete picks for your GPU, cloud options and what
each job is.

**What computer do I need?**
For Sara with a cloud model, a small server or a spare computer with 2 GB of memory is enough.
Running models yourself needs a GPU. Details: [REQUIREMENTS.md](REQUIREMENTS.md).

**Does anything I say leave my server?**
Your messages go to the model you choose (a local model keeps them on your hardware). A few
features contact other services once you turn them on. Every connection, and how to turn it off:
[PRIVACY.md](PRIVACY.md).

**Can I use her on my phone?**
Yes: the web app works on any phone now, and the iPhone and Android apps are coming soon to the
App Store and Google Play. Step by step: [PHONE.md](PHONE.md).

**I lost my owner token.**
On the server: `sudo sara reset-token` (Windows: `sara reset-token`; Mac: `sara reset-token` or
*New owner key…* in the menu bar). It prints a new one and signs every browser out. On a Mac,
`sara token` shows the first token if it was never used.

**How do I back her up, or move her to another computer?**
She backs up every day by herself (the last 7 are kept). For a copy somewhere else, set up the
off-server copy in Settings → Data & health → Backups. Moving: [MOVING.md](MOVING.md).

**How do I update her?**
Linux: `sudo sara update` or Settings → Data & health → Updates. Windows and Mac: run the newer
installer (Updates links the download). Only the latest version gets fixes
([SECURITY.md](../SECURITY.md#supported-versions)).

**Can she do things without asking me?**
Reading tools run by themselves. Anything that runs commands, sends things, spends money or
reaches other people asks you first, unless you change it in Settings → Abilities → Tools and
approvals. On Windows she asks before every command.

**Can other people talk to her?**
Only if you allow it, on Telegram or Discord. Those are *partner chats* (see below).

**Can I have more than one companion?**
Yes: Settings → Her → Companions. Each has her own name, character, look, voice, conversations and
memories.

**Something's wrong. Where do I start?**
`sudo sara status` and `sudo sara doctor` on the server (`sara status` / `sara doctor` on Windows
and Mac), then Troubleshooting in [INSTALL.md](INSTALL.md#troubleshooting). Or ask her: she knows
her own settings.

## Glossary

**Owner token** (the Mac app calls it the **owner key**): the long password printed when Sara is
installed. Whoever has it is the owner. Sara keeps only a scrambled copy (a hash). Keep it in a
password manager.

**Device code / pairing code**: a short code (10 minutes, one use) to sign in a phone, computer or
app without typing the owner token.

**Two-step sign-in**: with it on, the owner token also needs a 6-digit code from an authenticator
app. **Passkey**: sign in with your fingerprint, face or device PIN instead.

**Companion**: her, or any of the characters you made, each with her own memories. **Helper**: a
short-lived worker with one job (researcher, coder, tester, reviewer, writer, designer) that she
hands part of a bigger task to when her team is working. Helpers aren't companions and don't
remember you.

**Private conversation**: a conversation that only uses models on your own hardware and no
off-server tools (no web, mail, GitHub, MCP), and whose commands get no internet. Unlike *off the record*, it
is saved like any other conversation.

**Off the record** (🕶): a conversation that's never saved and never remembered: it's not in
backups and it's gone when you close it or the server restarts. No tools or photos there.

**Partner chat**: a chat with someone other than you, on Telegram or Discord. She tells them she's
an AI, keeps it separate from your chats, uses no tools there and shares nothing about you.

**Adult mode**: the switch that allows adult content (Settings → You → Adult mode). Off by
default, can only be turned on in a web browser, with an "I am 18 or older" confirmation. The
block on sexual content involving minors applies whatever the setting.

**Background model**: the model for behind-the-scenes work ("Memory and summaries" in Settings →
Models → Which model does what): noting what matters, summaries, learning from documents. A fast,
cheap or local model is fine.

**Meaning search**: finding things said in other words, using an embedding model such as
`nomic-embed-text`. Without it she searches by words.

**Sandbox**: the walls around commands she runs. On Linux, bubblewrap limits the command's view
of the system; on a Mac, macOS's own sandbox does a similar job. Native Windows commands are not
OS-isolated, so she asks before every command.

Health reports execution isolation separately from approval policy: **asking first is not
isolation**. A warning about an unavailable sandbox can therefore appear even when every command
needs approval. Keep those approvals on; for isolated trials, use a supported isolation driver
in Coding → Tools and approvals. A copy-and-diff trial alone is not OS isolation.

**Workspace**: the folder for a coding project, where she reads, writes and runs things.

**Approval card**: the box where she asks your OK before a risky step (Allow / Deny).

**Provider**: a service or program that runs models: Ollama, OpenAI, Anthropic, xAI, OpenRouter or
a subscription.

**Bridge**: her connection to Telegram or Discord.

**MCP**: a standard way to give her extra tools from other programs (Settings → Abilities → Other
programs (MCP)).

**Tailscale**: a free app that makes a private network of your own devices, so you can reach her
securely from anywhere.
