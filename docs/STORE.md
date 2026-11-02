# The Sara Store

The Sara Store is a public shelf of add-ons for Sara: plugins and tool servers (MCP). The Sara team
makes, checks and signs everything on it. You can see it at
<https://backstagecoding.com/sara/store/>.

Nothing from the store switches on by itself. Every add-on shows you what it can do before you add it,
and you switch it on yourself, one companion at a time.

## What's on the shelf (Sara 2.57)

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

## Adding something in Sara 2.57

- **A plugin:** download its `.zip` from its store page, then in Sara go to **Settings → Abilities →
  Plugins → Add a plugin** and pick the file. The review card says **From the Sara Store · Made by the
  Sara team** when the file is exactly the one on the shelf. Read the card, then press Install. It is
  installed switched off; switch it on for a companion on its card.
- **A tool server:** its store page shows the command and the settings to fill in. Add it in
  **Settings → Abilities → Other programs (MCP)**, then press Test.

From Sara 2.58 the store opens inside Sara (**Settings → Abilities → Get more**), so you can add things
there in one step.

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

## Making your own

Plugins: see [PLUGINS.md](PLUGINS.md). Tool servers: see [OTHER_APPS.md](OTHER_APPS.md). Submitting to
the store opens with Sara 2.58; submissions are reviewed by the Sara team.
