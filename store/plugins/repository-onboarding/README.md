# Repository Onboarding

Maps a staged repository and reproduces its documented build, without inventing commands.

1. With the plugin switched off, stage a copy of the repository in its data folder under
   `projects/<name>/` (plain files; no links). Stage only code you trust to run.
2. `onboard` with `operation: "map"`. Nothing runs. You get the file count, languages by extension,
   top-level folders, `package.json` manifests (name, version, engines, scripts, dependency counts),
   lockfiles, Markdown docs, the README's documented prerequisites (each *met*, *missing* or
   *unverified*) and the commands shown in shell code blocks of its **Build** section, each with
   its own `planSha` bound to the staged files.
3. `onboard` with `operation: "build"`, one listed `command` exactly as shown and its `planSha`.
   A command that is not in the Build section, or any missing checkable prerequisite (a listed
   file, a Node version), refuses before anything runs. Otherwise Sara shows you the command and
   runs it only after you allow it, in a disposable copy that is deleted afterwards. The receipt
   has the real exit code, the end and SHA-256 of its output, and the files it created or changed
   in the copy. Nothing is written back.

Prerequisites Sara cannot check (for example "a Unix shell") are listed as unverified, not assumed.
`npm` builds run only where Sara has an OS sandbox (bubblewrap on Linux); elsewhere they are held,
not built or failed. The Developer Workbench `repo_map` tool is separate and unchanged.

Fence: on Linux with bubblewrap the job is OS-sandboxed without network; on Windows and elsewhere
it is not OS-sandboxed (Node's permission model only, limited to the copy, `node` only).
