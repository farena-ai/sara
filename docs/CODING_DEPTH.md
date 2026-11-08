# Coding depth: task worktrees, language servers, co-authored commits, the Workspace

Four things that make her a steadier coding partner. All of them are the owner's only (household
members and the demo don't get them).

## A worktree per task

In a coding conversation on a git repository, she can start the task in its own **git worktree**:
a new branch `sara/<task>` checked out in `<repository>/.sara-worktrees/<task>`. Your main checkout
stays exactly as it was (the folder is added to the repository's `.git/info/exclude`, so `git
status` stays clean). From then on her file and command tools in that conversation work in the
worktree, and she is told so at the start of every reply.

- Ask her (*"do this in its own branch"*) or use **Project page → Workspace → Start in a worktree**.
  Starting one asks you first (tool `worktree_start`).
- When the task is done, finish it in one of three ways (tool `worktree_finish`, or the buttons on
  the Workspace tab):
  - **Merge**: merges the branch into the branch it started from, in the main checkout, then removes
    the worktree and the branch. It refuses while the worktree has uncommitted changes, while the
    main checkout has uncommitted changes or sits on another branch, and on a conflict (the merge is
    stopped, nothing changes).
  - **Open PR**: pushes the branch (your GitHub token, only to `https://github.com/…`) and opens a
    pull request through your GitHub connection. The title and body are drafted from the commits and
    the changed files (tool `github_draft_pr` shows the draft); you can edit the title before it
    opens. The worktree stays for follow-up changes; **Done with the PR** removes it and keeps the
    branch.
  - **Discard**: deletes the worktree and its branch. If anything is uncommitted or not merged
    anywhere, you are told exactly what (files and commits) and asked again. Her discard always asks,
    even if you let `worktree_finish` run on its own.
- Removal is Windows-safe: every link inside the worktree (for example a `node_modules` junction) is
  unlinked first, so a delete can never reach the folder it points to.

## Language servers

If a language server is installed and on `PATH`, she can ask it about your code (read only, no
approval needed): `code_diagnostics` (errors and warnings in a file), `code_definition`,
`code_references` and `code_hover`. None is bundled; install the ones you want:

| Language | Program |
| --- | --- |
| TypeScript / JavaScript | `typescript-language-server` (npm `typescript-language-server typescript`) |
| Python | `pyright-langserver` (npm `pyright`) |
| Go | `gopls` |
| Rust | `rust-analyzer` |

A server starts on first use per project and language, stops after 5 minutes idle, at most four run
at once, each request has a 15-second limit, and Node-based servers get a 1.5 GB memory limit (on
Linux any server is stopped past it). Servers get a clean environment, never Sara's keys. Without a
server she says so and falls back to reading and searching. **Settings → Coding → GitHub → Her
commits** lists which servers this computer has.

## Co-authored commits

Her commits end with `Co-authored-by: Sara <sara@noreply.sara.invalid>` (her current name, an
address that reaches nobody), so GitHub shows who helped. Change the name and email, or turn it off,
in **Settings → Coding → GitHub → Her commits**.

## The Workspace tab

**Project page → Workspace** (projects with a workspace):

- **Folder**: the main checkout or one of her task worktrees.
- **Files** and a plain **editor** with line numbers (Ctrl+S saves). If she or a command changed the
  file since you opened it, Save tells you instead of writing over it. Secret files (`.env`, keys)
  are hidden and can't be edited here; git's own settings neither.
- **Problems**: the language server's errors for the open file, when one is installed.
- **Terminal**: one command at a time, up to 2 minutes, in her sandbox and with her shell's network
  rule. It is off when commands are off (Settings → Tools → shell, or your admin's policy).
- **Chat**: a coding conversation for this workspace. Each message carries the open file as an
  `@file` reference; she asks before changing anything, and her approval requests appear right in the
  panel.
