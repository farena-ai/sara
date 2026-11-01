# Getting help: report a problem from inside Sara

Something broke, or you'd like Sara to do something new? You can tell the people who make Sara
without leaving the app, without a GitHub account, and see our answer in the app.

## Report a problem or suggest something

- Open **Help** (the **?** at the bottom of the sidebar) → **Report a problem** or **Suggest
  something**.
- Or type **`/bug`** or **`/idea`** in a chat with her. Anything after the command becomes the title
  (`/bug reminders come an hour late`).
- When something fails, the error notice in the chat has a **Report this** link: it opens the same
  form with the error filled in.

The form has four fields:

| Field | What to put |
|---|---|
| What is it | A problem, an idea or a question |
| Title | One short line, up to 120 characters |
| What happened | What you did, what you expected, what happened instead. Leave out passwords and private details |
| Email for a reply (optional) | Only if you'd also like an answer by email. Replies always show in *My reports* |

### Diagnostics (optional)

Press **Add diagnostics** and Sara builds them **on your own server** and shows them to you **in full**,
each part with its own tick box:

- version and platform (Sara's version, Windows/Mac/Linux, how she was installed, the app language);
- the error (when you came from *Report this*);
- the steps of the failed reply: the names of the tools she used and whether each worked, never what
  they read or wrote;
- which settings are on, as a list of setting names with on/off or a count, never their values;
- the last 200 lines of her log (owners only; household members never send the server's log).

Before you see them, and again before anything is sent, Sara replaces keys and tokens (the ones you
saved, and anything shaped like a key), email addresses, internet addresses and the names of your
folders (only a file name is kept: `~/…/notes.txt`). Untick any part you'd rather keep. Nothing is
sent until you press **Send**.

A small puzzle runs while sending (it keeps spam away); it takes a moment and nothing freezes.

### In Telegram or Discord

`/bug` or `/idea` on its own answers with where the full form is (with a link when your server has a
public address). `/bug <what happened>` sends a quick report **without diagnostics** after you tap
**Allow** on the confirm card. Only you (the owner) can do this; other people in a chat can't.

## My reports

**Help → My reports** lists what you sent: its number (like `SARA-1234`), its status (*New*, *Looked at*,
*Being worked on*, *Waiting for you*, *Fixed*, *Closed*), the version that fixes it, and our replies.
You can answer under each one. Sara asks for news only while *My reports* is open; it doesn't check in
the background. Replies show as plain text.

Each person on a household server has their own reports, kept in their own space.

## The anonymous daily check-in

Once a day Sara sends a tiny anonymous check-in so we can support you and plan features: a random
install ID made on your server, the version, the kind of computer (Windows, Mac or Linux), how she was
installed, the app language, how many companions and household members there are, which features are
switched on, and whether your models run locally or in the cloud. No names, chats, memories, file
paths, addresses, model names or keys. We don't keep your IP address.

- The first time you open Sara you see a short notice about it, with **Show what's sent** and
  **Turn off**. Nothing is sent before that notice has been shown.
- **Settings → Data & health → Privacy**: the **Anonymous daily check-in** switch, **Show what's
  sent** (the exact text the next check-in would send) and **Reset the install ID** (a new random ID,
  so later check-ins can't be linked to earlier ones).
- It is never sent from the demo, from household members' spaces (the server checks in once for
  everyone), or while **Nothing leaves this computer** is on.
- Now and then the answer carries a short note (a new version, a known problem). It shows once as a
  small banner you can close.

The full list of everything that can leave your server is in [PRIVACY.md](PRIVACY.md).

## When it can't send

| You see | Why | What to do |
|---|---|---|
| Reports can't be sent while “Nothing leaves this computer” is on | Private local mode blocks every connection off this computer | Turn it off for a moment (Settings → Models → On this computer), send, turn it on again |
| Too many reports today | A few reports a day per server keeps spam away | Try again tomorrow, or add to your earlier report in *My reports* |
| The support desk didn't answer | The desk or your internet is down | Try again later; nothing was lost on your side |
