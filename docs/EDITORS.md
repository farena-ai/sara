# Sara in your code editor (Zed, JetBrains and other ACP editors)

Editors that speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) can use Sara
as their coding agent: you chat with her in the editor's agent panel, she reads and edits the files
of the folder you have open, runs commands in the editor's terminal, and **asks you in the editor**
before she changes a file or runs a command. It is the same Sara as in the web app: her character,
memory, approval rules and safety checks all apply.

Sara speaks ACP **protocol version 1** (schema release `schema-v1.29.1`, November 2026).

## 1. Install `sara-chat` and sign in

`sara acp` runs on the computer where the editor runs and connects to your Sara server.

- On a computer that only talks to Sara: install the terminal client (Node 24 or newer):
  `npm install -g ./clients/cli` from a copy of Sara, then use `sara-chat acp`.
- On the computer that runs the Sara server (installed from source or the desktop app), `sara acp`
  does the same thing.

Sign in once (it shows a short code; approve it in Sara, Settings → Devices and sign-in):

```sh
sara-chat acp login https://your-sara-address
```

This uses the same sign-in as `sara-chat`; with several servers, add `--server <name>` to the
editor's arguments. Instead of signing in you can give the editor the environment variables
`SARA_URL` and `SARA_TOKEN` (a device token); never commit them to a repository.

## 2. Zed

Agent panel → **+** → Add Custom Agent, or edit `settings.json` (`%APPDATA%\Zed\settings.json` on
Windows, `~/.config/zed/settings.json` elsewhere):

```json
{
  "agent_servers": {
    "Sara": {
      "type": "custom",
      "command": "sara-chat",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open the agent panel, choose **+ → Sara** and ask away. If Zed can't find `sara-chat`, use the
full path (`where sara-chat` on Windows, `which sara-chat` elsewhere). When you're not signed in yet,
Zed offers **Sign in to Sara**, which runs the login in a terminal.

## 3. JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, GoLand…)

AI Chat → ⋮ → **Add Custom Agent** opens `~/.jetbrains/acp.json`. Add Sara under `agent_servers`
with the **full path** (JetBrains doesn't use your shell's PATH):

```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "Sara": {
      "command": "/usr/local/bin/sara-chat",
      "args": ["acp"]
    }
  }
}
```

On Windows the command is the `sara-chat.cmd` file npm installed, for example
`C:\\Users\\you\\AppData\\Roaming\\npm\\sara-chat.cmd`. Pick **Sara** in AI Chat's agent list.

Other ACP editors (Neovim plugins, Emacs, Obsidian and others): start `sara-chat acp` the same way.

## What happens in the editor

- **Each thread is a coding chat in Sara**, titled after the editor and the folder (`Zed: my-app`).
  It also shows in the web app, and the editor can reopen it later.
- **Files:** she reads files through the editor, so she sees unsaved changes too. Her edits are
  written by the editor and shown as a diff. Listing and searching look at the folder on disk.
- **Approvals in the editor:** every write and every command asks first (*Allow once*, or *Allow
  edits in this folder for this session* / *Always allow this exact command for this session*, or
  *Reject*). The "always" choices last until the editor closes the agent. Anything her own rules say
  to ask about (for example commands, set in Settings → Coding) shows as the same question in the
  editor, and answering it there is the answer in Sara.
- **Commands** run in the editor's terminal, in the folder you have open.
- **Never touched:** files outside the open folder, `.env` files, keys, certificates and credential
  files (she can't read, list or write them).
- **Stop** in the editor stops her reply on the server too.
- If the editor doesn't offer its files, she works in her own workspace on the server (a workspace
  named after the folder), as in the web app.
- Turns from an editor share like other apps: her notes from private, imported and adult
  conversations stay out of them.
- The first time, the editor shows Sara's AI disclosure; reply **I agree** to go on.

## For admins

- **Policy:** Settings → Household → Policy → *Turn off editors* refuses new editor sessions and
  editor turns on this server (pin `"editors": false`, see [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)).
- **Audit trail:** every new editor session writes one `editor.session` row (who, which editor,
  which chat). Approvals answered in the editor are recorded like any other approval.
- Household members and the public demo can't use editors (owner only).

## Troubleshooting

- *Authentication required*: run `sara-chat acp login https://your-sara-address` in a terminal.
- *The agent doesn't start*: run `sara-chat acp --help` in a terminal; use the full path in the
  editor's settings.
- Nothing is printed to the editor except protocol messages; problems go to the editor's agent log.
