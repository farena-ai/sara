# Sara for VS Code

Sara, your self-hosted companion and coding partner, in a panel in VS Code: the same companion
with the same memory and personality as in the web app, talking to **your own Sara server**.

## Sign in

1. Run **Sara: Sign in** (Command Palette) and type your server's address.
2. VS Code shows a short code. Approve it in Sara: **Settings → Connections → Devices and
   sign-in** (or open the link it offers while you're signed in to Sara in a browser).
3. Done. The editor is listed there like a phone; signing it out there ends it. The token is kept
   in VS Code's secret storage.

## Use it

- The **Sara** icon in the activity bar opens the chat panel.
- **Sara: Ask about selection** sends your question with the selected lines.
- **Sara: Explain this file** sends the open file.
- **Sara: Send file to her library** keeps a document (PDF, Word, text…) in her library.

What goes with a question: the file's name relative to the workspace, its language, the line
numbers and the code, cut at `sara.maxContextChars` characters (12,000 by default). The panel
shows exactly what was sent (open "Sent with it"). Files that look like secrets (`.env`, keys,
credentials) are never sent.

Approvals she needs (running a command, for example) show in the panel with Allow / Decline.

No packages, no build step, no telemetry. The panel has a strict Content-Security-Policy and loads
no remote scripts.
