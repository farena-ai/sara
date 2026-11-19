# V3.4 "Fix this issue" (one page)

ROADMAP_V V3.4 (item 24, EXISTS · M). Acceptance: against a fake GitHub and a local repo, a fake
model's fix opens a PR only after approve (test/v3-fixissue.test.ts).

## What existed (kept, extended)
- Phase 40 `src/issues.ts`: watched repositories, `ensureClone` (repo in its own `gh-owner-name`
  workspace), `startFromIssue` → a team task with a workflow; tool `work_on_issue`; Team → From a
  GitHub issue list (web/app.js `loadTeamIssues`).
- `src/team.ts`: coder → tester (failed run = back to the coder, up to `MAX_FIXES`) → reviewer, the
  plan and pull-request checkpoints, `#pullRequest` (commit, push, open, her review posted via
  `src/codereview.ts`).
- C13 `src/worktrees.ts` (task worktrees, `markPr`), Phase 80 sandbox tries of helper commands
  (`src/sandbox-run.ts`), `src/tools/github.ts`.
- Missing (VAUDIT 24): one place on a repository's issue list that starts it, a worktree, and a card
  showing what is about to go to GitHub.

## What V3.4 adds
- `startFromIssue` makes a C13 worktree per issue (`workflow.worktree`), so the main checkout stays
  clean and several issues run at once; Team and `work_on_issue` get it too. `taskDir()` runs every
  helper in it; `#pullRequest` commits on the worktree's branch (no new branch), passes the issue's
  repo to `github_open_pr` (works whatever the remote URL is) and `markPr`s the worktree.
- `src/fix-issue.ts`: `fixIssue` (fixed plan coder → tester → reviewer, no plan stop, the
  pull-request stop always on), `fixList` (issues + each one's latest fix), `fixView` states
  (working / ready / pr / stopped …), `prCard` (numstat + new files against the base, the tester's
  last shell receipt, the reviewer's verdict, fix rounds), `answerFix` (open / not-now only at the
  card), and an `onCheckpoint` hook on TeamManager that posts the card text in the issue's chat.
- Routes inside the owner-only `github-watch` family: `GET/POST /api/github-watch/fix`,
  `GET /api/github-watch/fix/:id`, `POST /api/github-watch/fix/:id/open|not-now`.
- Web: a "Fix an issue" section on Settings → GitHub (web/fix-issue.js), polls every 5 s only while
  a fix works and the page is on screen.
- Test seam: `issueDeps.cloneUrl` (a local bare repository in tests).

## Rules
- Nothing goes to GitHub before Open the pull request (checked: 0 POST /pulls before, 1 after).
- Issue text is information only (goal wording); issue bodies are not sent to the page.
- Owner only (403 for members/demo). One live fix per issue.
