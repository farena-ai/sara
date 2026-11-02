# Safety check-up

**Settings → Data & health → Safety check-up** (owner only) looks at how Sara is set up and says, in
plain words, what could let someone in or lose your data. It only reads: no model call, nothing sent
anywhere. Nothing changes until you tap a fix, and a fix can only make things safer.

The top line is one of: **Looks safe**, **Mostly safe · N things to tighten** or **Fix these first ·
N things could let someone in or lose your data**. Red rows come first, then amber ones; fine rows are
folded. Each row has a **?** that says why it matters.

## The 17 checks

| Check | Red / amber when | Fix |
|---|---|---|
| Open without sign-in | the demo listens beyond this computer; Ollama listens on every network | guided (the `OLLAMA_HOST` setting for your system) |
| Who can reach her | `SARA_HOST` is every network but she was set up for this computer | guided (`sudo sara access local` / the tray's Access menu) |
| HTTPS off this computer | phones reach her over plain HTTP | guided (Tailscale) |
| Owner token | older than a year, or its age is unknown (amber) | **Make a new owner token** (asks for the current one; every device signs out; passkeys and two-step stay) · can't be undone |
| Sign-in lock | reached from other devices with no passkey or two-step | guided (Devices and sign-in) |
| Old devices and keys | API or agent keys unused for 3 months | **Sign them out** (untick any to keep) · can't be undone |
| Backups | automatic backups off (red), newest older than 2 days | **Turn automatic backups on** · undo any time; **Back up now** |
| Off-computer copy | none (amber), or failing / no passphrase (red) | guided (Backups) |
| Tools that run without asking | a command tool on auto with no sandbox (red); a tool you moved from Ask to auto | **Ask me first again** (only those tools) · undo any time |
| Sandbox | no sandbox and her commands can reach the internet | **Turn command internet off** · undo any time; bubblewrap on Linux (guided) |
| Adult mode lock | adult mode on with no passkey or two-step (red when others use this server) | guided |
| Chat apps open to strangers | Telegram or Discord open to anyone, any bot answered, your tools in groups | **Only me**, **No other bots**, **No tools in groups** · undo any time |
| Weak webhooks | a GitHub/Stripe hook checked only by its address (red when it runs a skill or plugin) | **Pause this hook** · undo any time; guided signature |
| Agents and the hub | agent keys never used or about to expire | **Remove unused agent keys** · can't be undone |
| Secrets in her notes | a memory, note, recipe or people note holds a vault secret (red) or a key-shaped string | **Hide them** · undo for 30 days (the original is kept encrypted in the vault) |
| Up to date | a newer version is out (red when its notes start with `Security:`) | guided (Updates); skipped in private local mode |
| Data folder | other users can read it (Linux, macOS) | **Make it private** (`chmod 700`) · undo any time |

## How fixes stay safe

- Each fix re-checks first, then passes a **tighten-only gate** in code: every key has one allowed
  direction (approvals only towards Ask/Never, chat-app openings only off, backups only on, hooks only
  paused, sessions only removed, folder bits only removed, notes only masked). Anything else is refused
  before a byte is written, and no fix can touch adult mode, private local mode, the hub check-in,
  providers, the safety classifier or how she is reached.
- Every fix is logged with its *before*. **Undo** (under Recent fixes) puts back only that fix's keys,
  and only if you haven't changed them since. There is no *Fix all*.
- *I know, don't warn me* (amber only, in the row's ⋯) moves a check to Fine with a note. Red can't be hidden.

## Elsewhere

- **Today** shows one line, "N safety problems · Open check-up", only when a check is red.
- **Backup check** routine: once a week (on the hourly backup timer) the check-up runs quietly and
  posts one notice only when something got worse.
- **Command line:** `sara doctor` ends with a Safety section and the verdict; `sara doctor --safety`
  prints only the check-up with each fix and command, and exits 0 (safe), 1 (tighten) or 2 (fix first).
  The command line never changes anything.
- Ask her "is my setup safe?": she can read the report (`safety_report`) but can't fix anything.

Not in 2.54: household members' own devices in *Old devices* (sign them out on the Household page),
and a live probe of a local model server on your network (the check reads its settings).
