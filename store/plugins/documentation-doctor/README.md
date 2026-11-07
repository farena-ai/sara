# Documentation Doctor

Checks a staged project's documentation and runs one documented command only when you ask.

1. With the plugin switched off, stage a copy of the project in its data folder under
   `projects/<name>/` (plain files; no links). Stage only code you trust to run.
2. `docs` with `operation: "check"`. Nothing runs. You get every broken local link (missing file,
   missing heading anchor, outside the project) with its file and line, the external links (listed,
   never fetched), and the commands shown in `sh`/`bash`/`shell`/`console` code blocks, each with
   its own `planSha` bound to the staged files.
3. `docs` with `operation: "run"`, one listed `command` exactly as shown and its `planSha`. Sara
   shows you that command and runs it only after you allow it, in a disposable copy that is deleted
   afterwards. You get its real exit code, the end of its output and the files it changed in the copy.

Only `node` and `npm` commands without shell syntax (`;`, `&&`, pipes, redirections, `$`, globs)
are runnable. Comments, inline code and prose in the documentation are never turned into commands,
and nothing runs automatically. `npm` commands run only where Sara has an OS sandbox (bubblewrap on
Linux); elsewhere they are reported as held, not as passed or failed.

Fence: on Linux with bubblewrap the job is OS-sandboxed without network; on Windows and elsewhere
it is not OS-sandboxed (Node's permission model only, limited to the copy, `node` only).
