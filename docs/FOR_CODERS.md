# For coders: Sara as your coding partner

Sara writes, runs and tests code in a workspace per project, asks before anything risky, and shows
what actually ran. This page gets you from install to a first green test run, then to the parts coders
use most. New to Sara altogether? [Start here](START_HERE.md) covers the same first steps in more detail.

<p align="center"><a href="https://www.youtube.com/watch?v=7i48NiAq-jw&list=PLGtrs9BqXtM8&index=4"><img src="https://i.ytimg.com/vi/7i48NiAq-jw/mqdefault.jpg" alt="Video: Coding with Sara" width="320"></a><br><sub>Prefer to watch? <a href="https://www.youtube.com/watch?v=7i48NiAq-jw&list=PLGtrs9BqXtM8&index=4">Coding with Sara</a>.</sub></p>

## The short version

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start          # http://127.0.0.1:7860; the token is in the output
```

Node 24+, zero runtime dependencies, no build step. Other ways to install: [docs/INSTALL.md](INSTALL.md).

1. **Pick *Coding*** in step 1 of the setup. Step 3 suggests a model that is good at code (a **Good for
   coding** chip; it prefers a capable model on your own computer) and puts *My subscription* (Claude
   Code, Codex or Grok Build) first when you are already signed in.
2. **Open a project:** *+ Project* in the sidebar, with a workspace folder. Start a conversation in it
   (or tap *Look at my project*, *Fix a failing test* or *Start a new project* on the last setup step).
3. **Choose how she runs code** in *Settings → Coding → Tools and approvals*: she asks first, and
   risky commands can run in a throwaway sandbox copy first.
4. **Ask for something real**, and watch the cards: files changed, tests passed or failed, and every
   command waiting for your **Allow**.
5. **Connect GitHub** (*Settings → Coding → GitHub*) for issues and pull requests.
6. **Use her from your editor or terminal:** `sara-chat`, the VS Code panel, MCP for Claude Code and
   Cursor, or the OpenAI-compatible address ([clients](clients.md), [other apps](OTHER_APPS.md)).
7. **Set a budget** (*Settings → Coding → Budgets*) so a long task stops where you want.

After interruption, use **Settings → Data & health → Readiness and recovery**. A job restart is a reviewed new
request, not continuation from a shell instruction offset. Team completed steps are preserved, but
unfinished effects need explicit review; publication may require manual reconciliation. Current
approval/privacy rules still apply. [Recovery details](RECOVERY.md).


## Pending approvals when settings change (2.66)

An Allow applies to the action in its original chat context. Before it starts, Sara checks the
current tool permission and the chat's workspace, privacy and other execution settings again.
Turning a tool off or changing that context stops the stale action, including team helpers and
applying a sandbox copy. Start a new request in the intended context to continue. Valid unchanged
approvals and scoped grants keep their usual behavior.

Use Stop for work already running. Review completed file changes in project history before
choosing an available undo action.

## What a coding turn looks like

<img src="screenshots/ask-first.webp" alt="A coding chat in the habit-tracker workspace: Sara asks before running node --test, with Try it in a copy and Deny in the chat and in her panel, which says Waiting for your OK" width="860">

She explains the plan, writes the files (they grow live in the chat while the model streams them), and
stops on an approval card before running a command. The same Allow / Deny sits in her panel and, in the
Windows and Mac apps, in a notification.

<img src="screenshots/coding.webp" alt="A coding chat in the habit-tracker workspace: a Tests failed card (5 passed, 1 failed), what she remembered about the same error, the file she changed, a Tests passed card with 6 passed, her explanation with the diff, and the security pass and threat model" width="860">

A real run on a local model (qwen3.8 27B on Ollama): the first test run caught a rounding bug in her own
code; she fixed it and all six tests passed. The line under each reply (*Looked through the files ·
Wrote a file ×2 · +4 more*) opens to every command and its output.

## While you code

<img src="screenshots/work-dials.webp" alt="Settings, Coding projects: the How she is while you code dials (Banter while working, Celebrations, Teasing about bugs) with a sample line each, Quiet when I'm focused, and the workspace picker" width="760">

*Settings → Coding → Coding projects* sets how chatty she is while working (with a sample line for
each step), *Quiet when I'm focused*, and what she knows about each project.

## Project checkpoints

Project checkpoints are included in the 2.67.0 public release.

In **Settings → Coding → Coding projects**, open **Project checkpoint** beside a repository's
notes. Keep the current logic, any blockers and one to three next steps. Save before changing tasks
or starting a new coding chat. You can also ask Sara to save a checkpoint in an ordinary owner coding
conversation; she uses `project_checkpoint`, not a background summarizer.

The newest checkpoint can give a fresh coding chat in the same unambiguous project its context,
even after a restart or chat compaction. With several nested repositories, ask her to read the
checkpoint for the particular project path. It is a historical handoff: file state and test results
still need checking. Saving it runs no commands and carries no earlier approvals forward.

The editor shows the saved content and up to five recent versions. **Replace** saves a new version;
**Clear** removes that project's checkpoint history after confirmation. If another tab saved first,
your draft stays put. Review it before explicitly reloading the saved checkpoint. Removing a
checkpoint does not rewrite earlier chat messages or run records that already showed its text.

Checkpoints stay in this companion's local data and backups, scoped to workspace and project.
They become context for the model selected for allowed coding chats, under the normal provider
policy; **Nothing leaves this computer** still supports local checkpoint storage. Private and
off-record chats, shared/group/external-app requests, household members, the demo and business mode
do not use this owner feature. Keep passwords and keys in Secrets, not a checkpoint.

A checkpoint derived from a conversation is removed if its source chat is deleted or a covered
message is edited, removed or forgotten. After forgetting source messages, use a fresh coding chat
or enter a reviewed checkpoint yourself in the editor. Compaction alone preserves the checkpoint.

## Project now: other chats and current checks

In an owner coding chat on one project, Sara sees a short **Project now** note before every step,
and the chat shows **Also active on this project** under its header when another of your coding
chats on the same workspace ran within the last 2 hours (or is running): its title, how long ago,
and the files it touched (`*` = this chat touched the file too). Click the title to open that
chat. Only titles, times and paths are shown, never message text. It is a note: nothing is locked,
merged or asked again, and editors outside Sara show up on her next step, not instantly.

Check results now say what they ran on. In **Settings → Coding → Check her edits** and on the goal
chip a result reads `ran on a1b2c3d + 2 changed files, current`, or `stale since 14:02: HEAD
a1b2c3d → 9f8e7d6, 3 files changed (…)`, or `basis unknown` (older results, git errors, or very
large/many changed files). Sara is told that a stale or unknown result is not proof and that she
must re-run the check before saying it passes. A checkpoint adds `Files changed since saved: N`.
Private, off-record, group and other-app chats, household members, the demo and business mode
never get this.

## Checks after her edits, and @-references (2.53)

After she changes a file, your project's own `tsc`, pyright, mypy, `cargo check`, `go vet` or ESLint
looks at it and she reads the new errors in the same reply (each project asks once; nothing is
installed). Type `@` to hand her a file or a few lines, your changes (`@diff`), the branch, the current
problems or a web page. Full guide: [CHECKS.md](CHECKS.md).

## Web pages: look, fix, look again

When she works on a web page she runs it, opens the preview in her testing browser and takes
screenshots at desktop and phone width. Her reply is marked unverified if she says she checked it at
phone width without a phone screenshot (phone = `phone` or a width up to 480px; desktop = the default
or 1024px and up), or says it's fixed or looks right now without a screenshot or a passing
`browser_check` after her last edit. Marked, never blocked; approvals are unchanged.

## Long jobs: goals, repeats and steering (2.49–2.61)

- **Keep going until it's done:** `/goal make the tests pass` (or *+ → Keep going until it's done…*), then
  pick what has to pass under *Done when*: the project's tests, its build or lint, a command you type or a
  reviewer model. She works in rounds and **Sara runs the check after each one**, not she; a red check
  sends the real failure into the next round, and editing a test to go green ends as *done, review it*.
  Full guide: [GOALS.md](GOALS.md).
- **Repeats:** `/loop every 10m for 2h: check the deploy and tell me if it's red`. Every repeat has an end
  time, a cap on checks and a daily budget, and stays quiet while nothing changes. Planner → *Repeats*
  lists them.
- **The limits** are three presets in *Settings → Coding → Keep going and repeats*: *Careful*, *Normal*
  (the defaults) and *Long jobs* (20 rounds, 4 hours, 2,000,000 tokens), each spelled out in rounds, time,
  tokens and dollars; your own numbers stay under *Fine-tune*.
- **Steer her while she works:** what you type mid-turn offers *Tell her now* (she reads it before her
  next step, like `/steer`), *After this* (`/queue`) or *Just asking* (`/btw`, a side answer that isn't
  saved). The loop guard stops her when she repeats the same failing step.

## Big tool sets: the short tool list and /compact (2.56)

With several MCP servers she gets only the tools that fit each step (measured: a fresh install from 11,871
to 5,471 tokens a step, with four servers from 23,476 to 5,438) and looks up the rest with *find tools*;
every call still goes through your approvals. `/tools` shows what she has (`/tools all`, `/tools +github`).
`/compact` (or *Tidy this chat*) folds the older part of a long chat into a summary; your last turns stay
word for word and *Undo* brings it back. Private chats only ever use a model on this computer. Details:
[TOOLS_AND_COMPACT.md](TOOLS_AND_COMPACT.md).

## Get tools from the Store (2.57–2.61)

*Settings → Add-ons → Get more* is the signed Sara Store: tool servers such as a browser (Playwright),
GitHub, files on this computer and current docs (Context7), plus plugins and skills. A tool server's card
shows the exact command (and its Windows form), what it needs and what it can reach; keys go to the vault
and nothing switches on by itself. `sara pack` checks your own plugin, skill or tool server before you
submit it. Guide: [Store guide](STORE.md); servers over SSH: [SSH.md](SSH.md) (connect
from a chat with one card since 2.52.1).

## Commands you can type

Type `/` at the start of the message box for this list; the same commands work in Telegram, Discord and the
other chat apps ([CHATS.md](CHATS.md)). The table is generated from the app's own list.

<!-- appmenu:start -->
| Command | What it does | Who sees it in the app |
|---|---|---|
| `/goal` | Keep going until it’s done: a goal for this chat that only a check you pick can end | You, in your own chats |
| `/loop` | Repeat something in this chat on a timer, until a time or a condition | You, in your own chats |
| `/compact` | Tidy the older part of this chat into a summary (undo, show) | You, in your own chats |
| `/tools` | Which tools she has in this chat (all, lean, +name, -name) | You, in your own chats |
| `/when` | Reminders for when a person or topic comes up (list, add, forget) | You, in your own chats |
| `/learn` | Learn a topic or a website, with sources (add daily, weekly or monthly to keep it fresh) | You, in your own chats |
| `/continue` | Pick up our chat from your other app here | You, in your own chats |
| `/btw` | A quick side question while she works (not saved) | You and household members |
| `/queue` | Queue a message for when she has finished | You and household members |
| `/steer` | Tell her something now: she reads it before her next step | You and household members |
| `/stop` | Stop her current reply | You and household members |
| `/new` | Start a fresh session (the last one is kept) | You and household members |
| `/reset` | Clear a stuck reply and listen again | You and household members |
| `/status` | Model, how full this chat is, and budget | You and household members |
| `/model` | Pick the model for this session | You, in your own chats |
| `/remember` | Save a note in her memory | You, in your own chats |
| `/problems` | The latest type errors in this chat’s project (check, on, off) | You, in your own chats |
| `/help` | What you can do here | You and household members |
| `/bug` | Report a problem to the people who make Sara | You and household members |
| `/idea` | Suggest something to the people who make Sara | You and household members |
<!-- appmenu:end -->

## The harness, in one list

| | Where | More |
|---|---|---|
| Workspace per project: files, shell, git, background jobs, live previews she tests in a headless browser | the chat chip (workspace · model · mode) | guide: *Coding help* |
| Asks before risky steps; commands tried in a sandbox copy first | *Tools and approvals* | guide: *Commands tried in a sandbox first* |
| Checks her plans against your rules ("never push to main") | automatic | guide: *She checks her plans…* |
| A team of helpers: plan → build → test → review, from an issue to a reviewed pull request | *Team* | guide: *Sara leads a team* |
| Security pass, threat model and red-team mode, each with a fix branch | *Findings* | [results](RESULTS.md) |
| Run snapshots, branch from any step, evals on your own tasks | *Show the run* under a reply, *Evals* | guide: *Show the run* |
| Budgets she keeps (tokens, steps, dollars) | *Budgets* | guide: *Budgets for her replies* |
| Skills, plugins, MCP servers, the Store; webhooks | *Add-ons*; *Connections* | [skills](SKILLS.md), [plugins](PLUGINS.md), [webhooks](WEBHOOKS.md) |
| Your other servers over SSH, with her own key | *Servers over SSH* | [SSH](SSH.md) |
| Hand-off to Claude Code, Codex or Grok Build | *Subscriptions* | [choosing a model](CHOOSING_A_MODEL.md) |

Every page in the app has a **How do I…?** box; the coding ones are in the list at
[How do I…?](HOW_DO_I.md) under *Settings → Coding*. Benchmarks, with the honest reading:
[RESULTS.md](RESULTS.md). The code itself: [ARCHITECTURE.md](ARCHITECTURE.md) and
[EXTENDING.md](EXTENDING.md).
