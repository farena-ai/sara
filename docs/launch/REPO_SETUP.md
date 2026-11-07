# Setting up the GitHub repository page

What to set on `github.com/farena-ai/sara` when it goes public. The parts the `gh` command can do
are in [`scripts/repo-setup.sh`](../../scripts/repo-setup.sh): it **only prints** the commands
unless you run it with `--apply`.

```sh
gh auth login                          # once, as the owner of farena-ai
bash scripts/repo-setup.sh             # shows what it would do
bash scripts/repo-setup.sh --apply     # does it
bash scripts/repo-setup.sh --apply --issues   # also opens the good first issues (once)
```

The rest (social preview, Discussions categories, the Projects board, branch protection) is a
few clicks each, described below.

## About box (the gear next to "About" on the repository page)

**Description** (273 characters; the limit is 350):

> Sara: a self-hosted AI companion with a personality you choose, who is also a real coding
> partner. Chats, remembers, plans, reads your documents, and builds and tests software in a
> sandbox, on your own server, with any model, local or cloud. MIT, zero runtime dependencies.

**Website:** `https://sara.backstagecoding.com`

**Topics** (18; GitHub allows 20):

`self-hosted` `ai-companion` `ai-assistant` `coding-agent` `llm` `local-llm` `ollama`
`openai-compatible` `mcp` `mcp-server` `home-assistant` `voice-assistant` `chatbot`
`personal-assistant` `typescript` `nodejs` `zero-dependencies` `privacy`

Tick **Releases**, untick **Packages** until the Docker image is published, untick
**Deployments**.

## Social preview

Settings → General → **Social preview** → *Edit* → *Upload an image* →
[`docs/images/brand/sara-social-preview.jpg`](../images/brand/sara-social-preview.jpg) (1280×640,
under 1 MB: Sara with the wordmark, the tagline and github.com/farena-ai/sara, matching the README
hero). GitHub has no API for this, so it is a one-time upload by the owner. The older
[`docs/social-preview.png`](../social-preview.png) stays as the alternative.

To change it, edit [`social-preview.html`](social-preview.html) and take a new screenshot at
1280×640, for example:

```sh
msedge --headless=new --hide-scrollbars --window-size=1280,640 --screenshot=docs/social-preview.png docs/launch/social-preview.html
```

## Features (Settings → General → Features)

- **Issues:** on. The issue templates in `.github/ISSUE_TEMPLATE/` (bug report, idea, and links
  for security reports and install help) appear automatically.
- **Discussions:** on (the script does this). Then, in the Discussions tab → ✏️ next to
  *Categories*, keep or create:

  | Category | Format | For |
  |---|---|---|
  | 📣 Announcements | Announcement (only maintainers post) | Releases and important news |
  | 🙏 Q&A | Question / Answer | Install and usage questions (answers can be marked) |
  | 💡 Ideas | Open-ended discussion | Feature ideas before they become issues |
  | 🙌 Show and tell | Open-ended discussion | Setups, screenshots, things people built with her |
  | 🎭 Characters | Open-ended discussion | Sharing companions and character cards (follow the code of conduct) |
  | 🦙 Local models | Open-ended discussion | Which models and settings work well, benchmark runs |
  | 💬 General | Open-ended discussion | Everything else |

  Delete *Polls* unless you want it. Pin a "Welcome, start here" post in Announcements that links
  INSTALL.md, the FAQ and the good first issues.
- **Projects:** on. **Wiki:** off (the docs live in `docs/`). **Sponsorships:** your choice.
- **Pull requests:** allow squash merging only (one tidy commit per PR); tick "Always suggest
  updating pull request branches" and "Automatically delete head branches".

## Labels

The script creates or updates these (colour in brackets):

| Label | For |
|---|---|
| `bug` (d73a4a) | Something doesn't work (used by the bug-report template) |
| `idea` (a2eeef) | A feature idea (used by the idea template) |
| `good first issue` (7057ff) | Small, well-described tasks for new contributors |
| `help wanted` (008672) | The maintainer would welcome a pull request |
| `documentation` (0075ca) | Docs, README, help text |
| `translation` (c5def5) | The app or README in another language |
| `question` (d876e3) | Better asked in Discussions → Q&A; convert it there |
| `needs info` (fbca04) | Waiting for details from the reporter |
| `security` (b60205) | Hardening (real vulnerabilities go through private advisories) |
| `benchmark` (bfdadc) | Evals, benchmarks and results |
| `area: companion` (f9d0c4) | Personality, memory, moods, story |
| `area: coding` (1d76db) | Workspace, tools, preview, team, code map |
| `area: apps` (5319e7) | Phone, desktop, VS Code, terminal, PWA |
| `area: integrations` (0e8a16) | Telegram, Discord, Home Assistant, MCP, API, Google |
| `area: voice` (e99695) | Calls, voices, speech recognition |
| `area: install` (c2e0c6) | Installer, Docker, updates, backups |
| `duplicate`, `wontfix`, `invalid` | GitHub's defaults, kept as they are |

## Good first issues

[`docs/GOOD_FIRST_ISSUES.md`](../GOOD_FIRST_ISSUES.md) lists fourteen ready-made tasks. With
`--issues` the script opens one issue for each (title from the list, the item's text as the body,
labels `good first issue` + `help wanted` + an area), skipping titles that already exist. Keep
the Markdown file as the source and close the issue when the item is done.

## Public roadmap board (Projects)

Your profile → Projects → **New project** → *Board*, name **Sara roadmap**, visibility
**Public**, then link it to the repository (repository → Projects → *Link a project*).

Fields:

| Field | Type | Values |
|---|---|---|
| Status | Single select | Ideas · Planned · In progress · Done |
| Area | Single select | Companion · Coding · Apps · Integrations · Voice · Install · Docs |
| Size | Single select | S · M · L |
| Phase | Text | e.g. "58" |

Views:

1. **Board** (default): columns by Status; cards show Area and Size.
2. **Table** "All items": grouped by Area, sorted by Status.
3. **Good first issues**: table filtered to `label:"good first issue"`.

Starting items (draft items, from [ROADMAP.md](../ROADMAP.md)):

- *Done*: one card per released phase you want to show (for example "Live preview and testing in
  a browser (0.49)", "Code map (0.50)", "Plug in anywhere: API, MCP, character cards (0.57)").
- *In progress*: "1.0 public release" (Phase 58: launch kit, release checklist, lawyer review).
- *Ideas* (the parking lot): import from other companion apps; group chats with two or more
  companions; a private local mode in the desktop apps; video calls with the moving avatar; a
  shared photo album; household mode; a smart-home presence through Home Assistant.
- *Planned*: the good first issues (add them as issues, not drafts, so contributors can
  pick them up).

Keep ROADMAP.md as the source of truth and move cards when a phase ships.

## Branch protection for `main`

Settings → Rules → Rulesets → **New branch ruleset**, name `main`, enforcement **Active**,
target the default branch:

- **Restrict deletions** and **Block force pushes**: on.
- **Require a pull request before merging**: on, 0 required approvals while you're the only
  maintainer (raise to 1 when there are more), dismiss stale approvals on new commits.
- **Require status checks to pass**: the `check` job, **after** CI is switched on (move
  `.github/workflows-disabled/check.yml` to `.github/workflows/` and enable its `push` and
  `pull_request` triggers; until then there's no check to require).
- **Require linear history**: on (works with squash merging).
- **Bypass list:** add yourself (repository admin) so releases and emergencies don't get stuck;
  use it rarely.

Also: Settings → Code security → turn on **private vulnerability reporting** (SECURITY.md and the
issue template link to it), **Dependabot alerts** (there are no runtime dependencies, but the dev
tools and GitHub Actions are covered) and **secret scanning with push protection**.
