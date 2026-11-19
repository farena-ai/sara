# Search help

Type a word or a question and Sara's help answers from what it already knows: every **How do I…?**
answer, every setting and its tip, every section of the guide and the user docs. It works in English,
Spanish, French, German, Brazilian Portuguese and Italian, and nothing leaves your server: the search
runs in your browser over an index that ships with Sara.

## Where to find it

- **In the app:** open **Help** (the **?** in the sidebar) and type under **Search help**.
- **In the guide:** the search box at the top of [the guide](../web/help.html) (`/help` on your server).
  On a phone it sits above the guide's menu.

## What a result does

| Result | What it opens |
|---|---|
| **How do I…?** | The answer with its steps. **Show me** opens the right Settings page with that answer open and points at the control. |
| **Setting** | The Settings page; **Show me** points at that control. |
| **Guide** | That section of the guide. |
| **Docs** | The section in a reader; **Whole page** opens the full document. |

Some answers have a short clip: press **▶ Watch it** to play it in place. The same clips are linked under
their answers in [How do I…?](HOW_DO_I.md) and play from the **How do I…?** box at the top of each
Settings page.

## Languages

Answers, settings, tips and the guide come in your language when a translation exists. Anything not
translated yet shows in English with an **In English** mark; the docs are written in English and are
always marked that way in the other languages. English words also find translated answers, so "backup"
works in a Spanish app too.

## For maintainers

- `node scripts/help-index.ts` writes the index: `web/help-index/<lang>.json` (answers, pages, tips and
  guide sections, translated with `web/i18n/<lang>.json`) and `web/help-index/docs.json` (user docs, one
  entry per section; developer docs and private docs are left out). Run it at release, after
  `npm run guide`; `--check` says whether it is out of date. test/w2-help.test.ts checks every How do I
  answer is in it and every link opens a real place.
- `node scripts/howto-clips.ts` makes the clips: a throwaway in-process server with a fake model and no
  accounts, Playwright screenshots of each step (the page, the answer, Show me), stitched into small WebM
  files with ffmpeg (`PLAYWRIGHT=<playwright/index.mjs> FFMPEG=<ffmpeg>`; without ffmpeg it keeps the
  frames). It writes `docs/media/howto/*.webm` and `docs/media/clips.json`; then run `npm run guide` and
  `node scripts/help-index.ts`. The ten clips are about 0.6 MB together (the limit is 15 MB).
- The server serves only `/docs/media/clips.json` and `/docs/media/howto/<name>.(webm|gif|png)`.
