# Check her edits, and attach with @ (2.53.0)

Two things that make Sara more precise when you code together.

## Check her edits

After Sara changes a file, **your project's own** type checker or linter looks at it, and she reads
the errors in the same reply, before she tells you she's done.

- **Which checkers.** Only tools your project already has, found from its files: `tsc` (a
  `tsconfig.json` and `node_modules/typescript`), `pyright` or `mypy` (their config and the project's
  own install; pyright wins when both are set up), `cargo check --offline` (`Cargo.toml` and `cargo` on
  the PATH), `go vet` (`go.mod` and `go`), and `eslint` (an ESLint config and `node_modules/eslint`).
  Sara never runs `npx`, `pip`, `cargo install` or `go install`, and never installs a missing checker:
  Settings shows the install command as text to copy.
- **The OK per project.** The first time she changes a file in a project, nothing runs: a card asks
  *Check her edits here*, *Not now* (asked again another day) or *Never in this project*. The card
  names the exact command and says which checkers run code from your project (an ESLint config, mypy
  plugins, Rust build scripts). On Windows it says they run directly on this computer (no sandbox).
- **What she reads.** Only new errors in the files she changed are written out (≤ 20), the rest is a
  count; an error her change caused in another file (a renamed export) is named with its first line.
  The block is part of the tool result, so the run record and replays see it too.
- **Before she says "done".** If her own new errors are left, the app tells her once more (up to 2 times
  per reply, inside the reply's budget). Whatever is left is on the reply: *⚠ 2 type errors left*. A
  clean result shows *✓ types clean (tsc)*. Say "leave the errors, it's WIP" and she isn't reminded.
- **Bounded.** Her next step waits up to 20 s; a check is stopped after 60 s; output is capped at 400 kB;
  one check per step and per project; network off; no model call.
- **Off.** Settings → Abilities → **Check her edits** (the switch, the limits, and per project *On /
  Off / Ask*, a tick per checker, *Run now*, *Problems*). In Telegram or Discord: `/problems`,
  `/problems check`, `/problems off`, `/problems on`.
- **Goals.** *Types check* is a check you can pick for *Keep going until it's done*.
- **Not in this version.** Language servers (typescript-language-server, pyright-langserver, gopls,
  rust-analyzer) are not used: the project's own command runs instead.

## Attach with @

Type `@` in the message box and pick **A file**, **A folder**, **My changes**, **This branch**,
**Problems** or **A web page**. Or type them:

| You type | She gets |
|---|---|
| `@file:src/app.ts` · `@file:src/app.ts:40-60` · `@file:src/app.ts:42` | the file (numbered lines), those lines, or 5 lines around one |
| `@file:"docs/My notes.md":3-9` | a path with spaces, in quotes |
| `@folder:src` | the folder's file list (≤ 200) |
| `@diff` · `@diff:staged` | your uncommitted (or staged) changes |
| `@branch` · `@branch:feature/x` | the branch's commits and diff against the default branch |
| `@problem` · `@problem:src/a.ts` | the latest problems from the checks |
| `@url:https://…` | the page as text, through the same guard as her web tool |

- Read **once**, when you send. Chips under your message show what was attached; *What she got* shows
  the exact text. Older messages keep a one-line note instead of the whole text.
- **Safe by design:** only your own messages in your own chats and work rooms; only the chat's
  project folder (no `..`, no links out); never secrets (`.env`, keys, `.git/`, `.npmrc`…); every text is
  scrubbed of keys and fenced as information, not instructions. `@url` never runs in private chats or
  with private local mode on, and never reaches private network addresses.
- **Caps:** one reference ≤ 40,000 characters (ask for a range); all of a message's references ≤ half
  of her memory for the chat (the biggest are dropped first, with a note).
- **Chat apps:** type the same forms in Telegram, Discord, Signal or email. If one can't be attached,
  she says so in one line before her answer. `/help refs` lists them.
