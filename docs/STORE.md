# The Sara Store

The Sara Store is a public shelf of add-ons for Sara: plugins, skills, tool servers (MCP) and, from
2.60, companions ([PACKS.md](PACKS.md)). The Sara team makes, checks and signs everything on it. You can see it at
<https://backstagecoding.com/sara/store/>.

Nothing from the store switches on by itself. Every add-on shows you what it can do before you add it,
and you switch it on yourself, one companion at a time.

## What's on the shelf

| Add-on | What it is | What it does |
| --- | --- | --- |
| Weather alerts | plugin | Warns you the evening before a storm on a day you might be outside. |
| Focus | plugin | 25 minutes on, 5 off: she keeps quiet while you focus and tells you when to stretch. |
| Home scenes | plugin | Say "movie night" and she sets the lights the way you saved it in Home Assistant. |
| GitHub digest | plugin | Every morning: new issues, reviews waiting for you and failed checks on your repos. |
| Reading list | plugin | Send her links or feeds: she keeps a reading list and gives you a weekly pick. |
| Webhook notes | plugin | Other programs can drop notes to her over a webhook. |
| ComfyUI | tool server | Runs your ComfyUI workflows to make and change pictures on your computer. |
| Blender | tool server | Lets her look at and change your open Blender scene. |
| Browser (Playwright) | tool server | Opens web pages in a browser on your computer, reads them and fills in forms. |
| GitHub | tool server | Reads and works on your GitHub issues, pull requests and code. |
| Files | tool server | Reads and writes files in one folder you choose. |
| Docs (Context7) | tool server | Looks up current documentation for programming libraries. |

## Adding something (Sara 2.58)

Open **Settings → Abilities → Get more**. Search or pick an add-on on a shelf, read its page (what it
does, what it can do in Sara's own words, pictures, versions, the checks it passed), then press **Get**:

- **A plugin** shows the same review card as **Add a plugin**, with **From the Sara Store** on it.
  Press Install. It is installed switched off; switch it on for a companion on its card.
- **A skill** shows the skills import review (every file and script). Scripts never run on their own.
- **A tool server** shows its own card: the exact program it runs (and its Windows form), where its
  code comes from, what it needs, whether it runs fenced in, and the fields to fill in. Keys go to the
  vault. Nothing starts until you press **Add and start**; then Sara runs **Test**.

**My add-ons** lists everything you added from outside, with updates. An update is never applied on its
own: it shows what changed, and if it asks for more (a new web address, a new permission) you see
exactly that before you say yes. **Go back** returns to the version you had.

If a new add-on is being checked by the Sara team, it says **Being checked** and can't be installed for
now. Add-ons nobody has reviewed yet are hidden unless you switch on **Show add-ons nobody has reviewed
yet**, and each still shows its full card.

## Privacy

- Once a day Sara downloads the store's public list. It is the same file for everyone. Sara sends no
  account, no cookie, no install id and nothing about you, your companions or your add-ons. The
  request has only `User-Agent: Sara`.
- Sara checks the list's signature against two keys built into Sara. A list that doesn't check out is
  thrown away, and Sara keeps the last good one.
- To switch it off: **Settings → Data & health → Privacy → Sara Store**. Your add-ons keep working.
- Sara never asks the store in the demo, in private local mode, or for household members.

## When an add-on is pulled

If something on the shelf turns out to be harmful, the Sara team pulls it. The next time Sara reads
the list, an add-on you installed that matches it is switched off, and its card says **Pulled from the
Sara Store** with the reason. Nothing is deleted: you can read why and remove it, or switch it back on
if you still trust it.

## Offline

Without internet Sara shows the list she last checked and says when it was from. If the list is more
than a day past its end date, you can still look but installs from the store wait until Sara can check
again. Everything you already added keeps working.

## Reporting a problem

On an add-on's page or in My add-ons, press **Report this**, pick what's wrong and say what happened.
Only what you write is sent (keys and passwords are taken out), plus its own log lines if you tick that
box and have read them. The Sara team reads every report.

## Companions (Sara 2.60)

The **Companions** shelf lists companion packs: Juniper, Rowan, Vesper and Jax first. **Get** opens her
card; **Add her** makes a new companion and changes nobody you have. In 2.60, packs rated Explicit are
not listed on the store (they work as files, see [PACKS.md](PACKS.md)), and fan characters and
real people are never listed. A Sara older than 2.60 doesn't show this shelf at all.

## Making your own and sending it to us

Plugins: see [PLUGINS.md](PLUGINS.md). Tool servers: see [OTHER_APPS.md](OTHER_APPS.md). Companions:
**⋯ → Share her → Send to the Sara Store** (see [PACKS.md](PACKS.md)).

1. Check it: `sara pack <folder>` on a server (or **Get more → Submit yours → Check it** in the app).
   It checks the manifest and permissions, looks for keys left in the files, runs a fenced smoke test
   with no network, and checks the screenshots and `CHANGES.md`. Nothing is sent.
2. Send it: `sudo sara submit <folder> --name "Your name"` (or **Send to the Sara team** in the app).
   Sara shows exactly what is sent (the package, its report, the name you chose, an email if you add
   one, your author key's public half, and this Sara's install id, version and system) and asks first.
3. Your **author key** signs what you send, so only you can send updates to your add-ons. It is made
   once and kept in this Sara's vault and backups.
4. **My submissions** shows where it is and the Sara team's replies. Submissions are reviewed by the
   Sara team before anything is listed.
