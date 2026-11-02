# Connect a server, the easy way: Sara connects herself over SSH (design, bug fix before the next phase)

Status: design and audit, 2026-11-01; built in 2.52.1 (see *As built* below). It is a read-only study of the SSH
feature as shipped in Phase 73 (2.2) and still current at 2.51.x: `src/ssh.ts` (the manager),
`src/tools/ssh.ts` (her tools), the `/api/ssh/*` routes in `src/routes/coding.ts`, `web/ssh.js`
and the `ab-ssh` page in `web/index.html`, `docs/SSH.md`, the `ab-ssh` entries in
`web/howto.json` and the `ssh-*` tips in `web/tips.json`, and `test/phase73.test.ts`. It also walks
the page as a beginner on a throwaway Sara (screenshots in
`outputs/ui-review/ssh-audit/`, local only) and checks the official cPanel, OpenSSH and RFC
documents it relies on (§13).

It is a **bug fix**, not a roadmap feature: the owner hit a wall connecting Sara to his own cPanel
server, so it ships before the next roadmap phase. Zero new npm dependencies; Sara keeps driving the
system OpenSSH client (DECISIONS 2026-10-29: "No SSH library"); the one new network call is an
HTTPS request to the server's own cPanel, only when the owner chooses the cPanel path.

**The owner's words (2026-11-01):** "I meant with having Sara connect herself. This should be a
super simple process for even beginner type users so I am looking at how to do this through their
eyes. The process right now seems like a brick wall and could be better."

**What he hit, on his own cPanel server:**

- cPanel's *Generate a New Key* asked for a passphrase, and the key it made was never usable: cPanel
  also needs *Manage → Authorize*, which nothing told him.
- Signing in with the password failed, because the server has `PasswordAuthentication no`.

**The standing rule (owner, DECISIONS):** *she creates her own key and saves the key, not the
user/pass, unless the user explicitly asks and is warned.* Using a password or a cPanel token
**once** to install her key and then forgetting it is fine, and the page says so in plain words.

**As built (2.52.1):** shipped as designed with the Q1–Q5 defaults (the port list, Sara revokes the
token named `sara`, no WHM path, her private key stays a file, Connect in Settings plus the chat deep
link `/#view=settings:ab-ssh&server=<id>`). Code: `src/ssh-easy.ts` (parsing, greeting read, cPanel
TLS look and allow-listed calls, `DIAG` codes) and the new `SshManager` methods in `src/ssh.ts`;
tests `test/ssh-easy.test.ts` (the 13 items of §10) with the shared fake in `test/ssh-fake.ts`;
user guide `docs/SSH.md`. Differences from the text below: the greeting read nudges a silent port
with an SSH identification line after 1.5 s so a web server answers (`NOT_SSH`); the methods check
also switches off GSSAPI and host-based sign-in; `diagnose` lives in `src/ssh-easy.ts`
(`diagnoseRun`) with a thin `SshManager.diagnose` wrapper; the not-SSH, DNS and timeout cases of
the probe are stored on `probe.code` and shown as the fix-it box; extra codes `CERT_NAME`,
`CERT_BAD`, `NO_CPANEL`, `BAD_TOKEN`, `CPANEL_FAILED` cover the token path; editing the user marks
the key as not installed (it lives in the old user's `authorized_keys`); the probe's raw sockets
call `checkOutbound()` and `src/ssh-easy.ts` is on the private-local source-scan allowlist.
`SARA_CPANEL_PORT` overrides 2083. Not live-tested against a real cPanel yet (owner to-do §12).

---

## 1. What is broken today (the brick walls)

Each wall below was reproduced on a scratch Sara (`SARA_DATA` in the Hermes scratch folder, port
7888, no real server: the test address is `192.0.2.10`, a TEST-NET address that nothing answers on,
and `127.0.0.1:7888`, Sara's own web port, as "something that isn't SSH"). Screenshots are at 1440 and
390 px wide: `outputs/ui-review/ssh-audit/<name>-1440.png` and `-390.png`.

| # | Brick wall | What the beginner sees | Why (code) | Screenshot |
|---|---|---|---|---|
| W1 | **The form asks for things a beginner can't know.** Name, address, port (pre-filled 22), user, and "With a password / With a key" before anything is checked. | Five fields and a choice. Nothing says "the user is your cPanel user name", or that most shared hosts don't use port 22. | `web/index.html` `#ssh-add`; tips say the port is "almost always 22". | `02-add-form`, `03-add-filled` |
| W2 | **One message for every way the first check can fail.** No answer in time, nothing listening, a web server on that port: all say "Couldn't read the host key of X:22. Is the server on, and is SSH running on that port?" (11 s for a silent address). | A technical sentence with no next step; no "try 2222 / 18765"; no button to change the port. | `SshManager.scan` turns every `ssh-keyscan` failure into `SCAN_FAILED`. | `04-after-check-hostkey`, `06-wrong-port` |
| W3 | **The sign-in box is empty after a failed check.** Pressing *Sign in* on that card opens "Sign in to my cpanel" with nothing under it: no fingerprint, no password box, no "read it again" button. | A heading and nothing to do. The only way on is *Remove* and type it all again with another port (the port can't be edited). | `fillSignin` hides the fingerprint box when there is no pending key, and the password and key boxes until the host key is trusted. There is no edit route. | `05-signin-dead-end` |
| W4 | **The host key step is written for sysadmins.** "Compare it with the fingerprint the server shows for itself (on the server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub, or ask its hosting company)." | A beginner can't run a command on a server they can't get into yet; "ask the hosting company" is a support ticket. They press *It matches* without checking. | `#ssh-fp-box` copy. | `07-hostkey` |
| W5 | **Password sign-in is a guess.** Sara never looks at which sign-in methods the server allows. On a server with `PasswordAuthentication no` (his case, and every SiteGround account) the password box is still offered, and the failure reads "my cpanel refused the sign-in for sara." | The beginner retypes the password, then resets it in cPanel, then gives up. Nothing says "this server doesn't take passwords at all". | `#explain` maps every `Permission denied (...)` to one sentence and throws the method list away, though OpenSSH prints it: `Permission denied (publickey).` | `08-password-box` (the failure text is quoted from code; no server was contacted) |
| W6 | **"With a key" asks for a private key.** The only alternative to a password is to paste a *private* key, or the path of one on the Sara computer. Her own public key is never shown, so the owner can't add it himself (in cPanel *Import Key*, or `authorized_keys`). | The safe path (give the server her public key) doesn't exist; the unsafe one (hand her your private key) is the only one offered. | `importKey` only; a key is made only inside `loginWithPassword`. | `09-key-box` |
| W7 | **A cPanel key can't be used.** cPanel's *Generate a New Key* asks for a passphrase (required unless the host set the *SSH Keys* strength to 0), and Sara refuses keys with a passphrase. Even without one, a key generated in cPanel works only after *Manage → Authorize*. | "I can't use that key: it is protected by a passphrase…" — and the owner has done exactly what cPanel told him. | `importKey` runs `ssh-keygen -y -P ''`; cPanel docs §13 [C3]. | (described; the import needs a real key the server accepts) |
| W8 | **No shell, no explanation.** A cPanel account with *Disabled Shell* or `/bin/false` (or `noshell`) accepts the key and then closes; a jailed shell works but has fewer commands. Today it shows the last lines of `ssh`'s error or "ssh ended with exit code 1". | A key that "works" and a server that "doesn't". | `#explain` has no case for it. | (described) |
| W9 | **Test has no diagnosis.** *Test* says "Couldn't sign in to X: <raw stderr>". Wrong user, key removed from the server, DNS name typo, port closed: the same shape. | Raw OpenSSH text, e.g. after a password try: "ssh: connect to host 192.0.2.10 port 22: Connection timed out" (15 s). | `test()` returns `stderr.slice(0, 300)`; `#explain` falls through to the last stderr lines. | `11-password-failed` |
| W10 | **Mobile.** At 390 px the add form sits under an empty-state card and the How-do-I box; the status line that explains a failure is below the fold, far from the button that caused it. | The button "does nothing". | layout | `04-…-390`, `06-…-390` |

Plus three smaller ones found reading the code:

- **The chat path is no easier.** `ssh_connect` adds the server and tells the model to send the
  owner to Settings to compare a fingerprint and type a password. The owner asked her to connect
  herself; she hands the hard part back.
- **A key she made is replaced every time** the owner signs in with a password again
  (`loginWithPassword` → `#makeKey` drops the old files), so an old line stays in
  `authorized_keys` forever, and the card never shows that there are two.
- **Wording:** "Sign in", "Check the host key", "Revoke her key", "Remove" sit side by side with no
  order; the page lead talks about "one password sign-in", which is the path that fails most often on
  shared hosting.

What works and stays: the OpenSSH options (`sshOptions`), the per-server `known_hosts` with
`HostKeyAlias` and `StrictHostKeyChecking=yes`, the one-time password through `SSH_ASKPASS`, the
install and revoke scripts (exact line, 700/600, no duplicates), the vault rule for passwords, the
ask-first list, owner-only and private-local rules, and the fake-OpenSSH test harness.

---

## 2. The one flow: *Connect a server*

One button, one form, one place. The page lead becomes: **"Give Sara the address of a server and the
user name. She makes her own key, looks at the server, and picks the easiest way in. She keeps only
her key: a password or a cPanel token is used once to install it and then forgotten."**

### 2.1 What the owner types (step 1 of 3)

| Field | Today | New |
|---|---|---|
| Address | `#ssh-host` | **Server address** — accepts what people paste: `example.com`, `203.0.113.5`, `user@example.com`, `user@example.com:2222`, `ssh -p 2222 user@example.com` (the command a host's welcome email gives), `https://example.com:2083` (a cPanel link: the host and "this is cPanel" are taken from it). Parsing is in code (`parseAddress`), shown back before going on: *"Server example.com, user alex, port: I'll find it."* |
| User | `#ssh-user` | **User name** — hint changes with what she found: on cPanel *"your cPanel user name (top right in cPanel)"*. Pre-filled from the pasted address. |
| Port | `#ssh-port`, pre-filled 22 | **Hidden by default.** "Port: Sara finds it" with a *Set the port myself* link. |
| Name | required-looking first field | Optional, after success: defaults to the host's first label (`example`). Rename on the card. |
| With a password / With a key | radio, first thing | **Gone from the form.** Sara picks the path after the probe (§2.3); the owner can still choose another path on the result screen. |

Button: **Connect** (not "Check the host key").

### 2.2 What Sara does (step 2 of 3: "Looking at example.com…")

A short live checklist, each line ticking as it finishes (each with a plain line under it on
failure, §4). Everything here is read-only and sends no secret.

1. **Finds the name** — `dns.lookup` (Node built-in). Fails → *DNS* diagnosis.
2. **Finds the SSH port** — tries, one after another with a 4 s limit each, the port the owner gave,
   else **22, 2222, 21098, 18765, 65002, 7822** (§11 lists who uses which) and stops at the first that
   answers with an SSH greeting (`SSH-2.0-…` within the first line; `net.connect`, read ≤255 bytes,
   close — Sara reads the greeting, she does not speak SSH). A port that answers with something else
   ("HTTP/1.1 400") is reported as *"port 7888 answers, but it is a web server, not SSH"*. At most 7
   short connects per Connect press; never a range scan.
3. **Reads the host key** — `ssh-keyscan -p <found port>` as today (`scan`), kept as *pending*.
4. **Asks which sign-in methods it allows** — one `ssh` run with every client method switched off
   (`PubkeyAuthentication=no`, `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`,
   `BatchMode=yes`) and the *pending* host key in a throw-away `known_hosts` with
   `StrictHostKeyChecking=yes`. OpenSSH then only sends the `none` request, and the server's
   `SSH_MSG_USERAUTH_FAILURE` comes back as the last line on stderr:
   `alex@example.com: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).` (RFC 4252 §5.1
   and §5.2: the reply carries "authentications that can continue"). Code parses the list in the
   parentheses. `password` or `keyboard-interactive` in it → a password can work; only `publickey`
   → passwords are off. Nothing is typed, no key is offered; the only thing the server learns is the
   user name, which it would learn anyway. (OpenSSH prints that line at `LogLevel=ERROR`, which is
   already the option Sara uses.)
5. **Checks for cPanel** — only when the host looks like a web host (the greeting, the port, or the
   pasted link): an HTTPS `GET /` to **port 2083** through `netFetch` (private local mode applies),
   4 s limit, certificate checked. cPanel answers from its own web server `cpsrvd`; the signs are the
   `Server: cpsrvd` header, a redirect to `/cpsess…`, or the cPanel login page title. Port 2087
   answering the same way means WHM (a reseller or the server's root). A port 2083 with a
   certificate that doesn't match the name is recorded as *cPanel, certificate for <other name>*
   (§2.4 a).
6. **Makes her key** — `ssh-keygen -t ed25519 -N ''` as today, but **now, before any sign-in**, so the
   public line exists for every path (fixes W6). Made once per server and kept until the owner
   replaces it; a failed attempt no longer deletes it.

Result: a `probe` record on the server (§7, §9) and the **result screen**.

### 2.3 The result screen (step 3 of 3): host key, then the easiest path

**Top: the host key, in plain words** (§3). Then one recommended path as a big card, the others as
small links ("Other ways"):

| Probe found | Recommended | Also offered |
|---|---|---|
| cPanel on 2083 (any auth methods) | **(a) Use a cPanel token** | (c) Copy and paste in cPanel · (b) password if allowed |
| Not cPanel, password or keyboard-interactive allowed | **(b) Type the password once** | (c) Paste one line |
| Not cPanel, publickey only | **(c) Add Sara's key** (per host type, §2.4 c) | (a) if the owner says it's cPanel after all |
| No SSH port found | **Fix-it screen**: *"I couldn't find SSH on example.com"* with the ports tried, *Set the port myself*, and per-host hints ("Shared hosting? SSH is often off until you switch it on: cPanel → Security → SSH Access, or ask your host") | — |

Every card says the same sentence about secrets: **"Sara keeps only her own key. The password /
token is used once to install it, then forgotten. Nothing is saved unless you ask, and you'll be
warned first."**

### 2.4 The three paths

**(a) cPanel token — "Let Sara install her key through cPanel"**

What the owner does (3 clicks, shown as numbered steps with a *Open cPanel* button that opens
`https://<host>:2083/` in a new tab):

1. In cPanel: **Security → Manage API Tokens → Create.**
2. Name it `sara`, choose **Specify an expiration date** and pick tomorrow, press **Create**.
3. Press **Copy**, come back, paste it into the *cPanel token* box here (a password-type box), press
   **Install my key**.

What Sara does, with `Authorization: cpanel <user>:<TOKEN>` in a header (never in the URL), over
HTTPS to `https://<host>:2083`:

1. `GET /execute/Tokens/list` (UAPI) — proves the token and user match (401 → *"That token isn't for
   user alex, or it was revoked"*) without changing anything.
2. `SSH::importkey` (cPanel API 2: `/json-api/cpanel?cpanel_jsonapi_user=<user>&cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=SSH&cpanel_jsonapi_func=importkey&name=sara-<id>&key=<her public line>`)
   — puts her public key in the account's key list under the name `sara-<id>`. cPanel has no UAPI
   function for this; API 2 is the documented one and API tokens run API 2 functions [C1][C2].
3. `SSH::authkey` with `key=sara-<id>&action=authorize` — the step the owner missed by hand: it
   writes her line into `~/.ssh/authorized_keys` [C1].
4. The token is dropped (buffer zeroed; never written to disk, the vault, a log, the chat or
   `servers.json`). Optionally (default **on**, §12 Q2) she first revokes it herself:
   `GET /execute/Tokens/revoke?name=sara` — so the owner has nothing to clean up.
5. She signs in with her key and runs the shell check (§4.2). Done screen.

If the certificate on 2083 doesn't match the name the owner typed (common: shared servers have a
certificate for the server's own host name, e.g. `server123.host.com`), Sara does **not** send the
token. She says: *"cPanel's certificate is for server123.host.com, not example.com. Use that name
for cPanel?"* — one button switches the API calls to that host name (the SSH address stays). If no
name matches, path (a) is closed and (c) is recommended. No "ignore certificate" switch.

**(b) Password once — "Type the password once"**

Only offered when the probe listed `password` or `keyboard-interactive`. The existing
`loginWithPassword` (askpass helper, install script, key check, vault rule) with two changes: it uses
the key made in §2.2 step 6 instead of making a fresh one, and a refused password is told apart from
"passwords are off" (§4). Under the box: *"Used once to install Sara's key, then forgotten."* The
*Save the password* checkbox moves behind an *Advanced* link and keeps today's two-step warning
(`SAVE_PASSWORD_WARNING`, confirm box, confirm dialog). One try per press: no automatic retries
(cPanel's cPHulk and CSF block an address after repeated failures, §11).

**(c) Copy and paste — "Add Sara's key yourself"**

Her public line, a **Copy** button, and the click-by-click steps for the host type she detected
(picked automatically, with a "Different host?" menu):

- **cPanel** (any host): *Security → SSH Access → Manage SSH Keys → Import Key.* Name: `sara`.
  Leave the private key box empty, paste into **Public Key**, press **Import**. Go back, find
  `sara` under *Public Keys*, press **Manage → Authorize**. ("Authorize is the step everybody
  misses: without it the key does nothing.") [C3]
- **SiteGround** (Site Tools): *Devs → SSH Keys Manager → Import*, paste the public key. SSH port
  18765 [S1].
- **Hostinger** (hPanel): *Advanced → SSH Access → SSH keys → Add SSH key*, paste. Port 65002 [S3].
- **A server with a web console** (DigitalOcean, Hetzner, Linode, AWS Lightsail…): open the
  provider's console for the server and paste **one line**.
- **A computer at home** (Raspberry Pi, Linux box, Mac): open a terminal on it, paste **one line**.

The one line (built in code from the validated public line, the same quoting as `installScript`):

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA…  sara@home-20261101' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Then **"I've added it — check now"**: signs in with her key and reports with §4's words. No
polling in the background.

**Advanced: "Use a key I already have"** stays as a small link under *Other ways* (today's
`importKey`), with one line added: *"A key cPanel generated with a passphrase can't be used here;
use the cPanel token or copy-paste instead."*

---

## 3. The host key, in plain words

Today: a fingerprint, a sysadmin command to compare it with, and *It matches: trust this host key*
(W4). A beginner can't check it and clicks anyway. New wording, by case:

**First time (the normal case):**

> **Is this really your server?** Every server has an ID card (its *host key*). Sara will remember
> this one and refuse to talk to example.com if it ever changes, so nobody can pretend to be it later.
> ID: `SHA256:1HrV…X4Zb0` · *How can I check it?*
>
> **[Yes, remember it and continue]**

*How can I check it?* opens: "If you can, compare with what your host shows: cPanel → Security →
SSH Access does not show it, so ask your host's support for the *SSH host key fingerprint (SHA256)*,
or on the server run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. Most people skip this for a
server they just set up: the main protection is that Sara remembers it from now on."

Decision recorded here: trust on first use stays (it is what OpenSSH does), but it is **said
honestly** instead of asking for a check nobody can do. For path (a), the cPanel API over verified
HTTPS is a second channel: Sara compares nothing there today (cPanel's API doesn't expose the SSH
host key to a user account), so no extra claim is made.

**Changed:**

> **Stop: example.com is showing a different ID card.** It was `SHA256:1HrV…` and now it is
> `SHA256:9Qp…`. This happens when a server is reinstalled or moved to a new machine, and also
> when someone is in between you and it. Sara stopped and didn't sign in.
> **[I reinstalled or moved it: trust the new one]** (asks once more) · **[Leave it stopped]**

The trust endpoint and the "changed" confirmation stay exactly as they are (`trust`, FP_MISMATCH,
HOSTKEY_CHANGED); only the words and the layout change.

---

## 4. *Test connection* and plain-language diagnostics

### 4.1 One diagnosis function

`diagnose(server, run, probe?)` in `src/ssh.ts` replaces the three sentences of `#explain`. It reads
the `ssh` exit code, stderr (scrubbed as today) and stdout markers, plus the last probe, and returns
`{ code, title, fix, actions[] }`. `test`, `exec` (code 255), `loginWithPassword`, the cPanel path and
the paste check all use it; the card shows `title` + `fix` + buttons; the tools say the same words.
Raw stderr goes behind *Details* (scrubbed).

| Code | How Sara knows | What she says (title — fix) | Buttons |
|---|---|---|---|
| `DNS` | `Could not resolve hostname`, or `dns.lookup` ENOTFOUND | **I can't find "exmaple.com".** Check the spelling. If it's your website's name, try the server name from your host's welcome email. | Edit address |
| `PORT_CLOSED` | `Connection refused` | **Nothing answers SSH on port 22.** Shared hosts often use another port (2222, 21098, 18765, 65002). Or SSH may be switched off for your account. | Find the port · Set the port |
| `TIMEOUT` | `Connection timed out` / `Operation timed out`, keyscan timeout | **example.com didn't answer.** The address may be wrong, a firewall may block SSH, or your host may have blocked this computer's address after failed sign-ins (cPanel's cPHulk does this). Wait 15 minutes, or ask your host to unblock <public IP>. | Try again · Set the port |
| `NOT_SSH` | the greeting probe got non-`SSH-` bytes | **Port 7888 answers, but it isn't SSH** (it looks like a web server). | Find the port |
| `HOSTKEY_CHANGED` | `HOSTKEY_FAIL` as today | §3 "Stop" box. | as §3 |
| `PASSWORD_OFF` | probe methods without `password`/`keyboard-interactive`, or `Permission denied (publickey)` on a password try | **This server doesn't accept passwords at all** (it only takes keys). That's normal and safer. Let Sara add her key another way. | Use a cPanel token (if cPanel) · Add Sara's key |
| `WRONG_PASSWORD` | methods allowed password, `Permission denied (…password…)` after one try | **The server said no to that password.** Check it (cPanel and SSH use the cPanel password on most hosts). Several wrong tries can get this computer blocked for a while. | Try again |
| `KEY_NOT_ACCEPTED` | key try, `Permission denied (publickey…)` | **The server doesn't accept Sara's key yet.** On cPanel: Manage SSH Keys → find `sara` → **Manage → Authorize**. Otherwise check the line is in `~/.ssh/authorized_keys` of user alex. *(It can also mean the user name is wrong: SSH servers don't say which.)* | Show the steps again · Check now · Edit user |
| `WRONG_USER` | cPanel API 401 for that user, or `Invalid user` in the cPanel API reply | **There is no cPanel user "alex" on this server.** Your cPanel user name is at the top right of cPanel. | Edit user |
| `NO_SHELL` | signed in (`LogLevel=VERBOSE` line `Authenticated to … using "publickey"`, read only in the test call) but no `sara-ok` marker; stdout/stderr `Shell access is not enabled on your account`, or exit 1 with no output (`/bin/false`, `nologin`: `This account is currently not available`) | **Sara's key works, but this account isn't allowed to run commands** (shell access is off). In WHM: Account Functions → **Manage Shell Access** → choose *Jailed Shell* (or *Normal Shell*) for alex. On shared hosting: switch on SSH in your host's panel or ask support. | Test again |
| `JAILED` (a note, not a failure) | test prints `$0`/`$SHELL`; `jailshell` in it | **Connected, with a limited shell (jailshell).** Most file and website commands work; system commands (sudo, services) don't. | — |
| `TWO_STEP` | partial success, or `keyboard-interactive` after `publickey` | **The server wants a second step (a code) after the key.** Sara can't type codes. Ask your host to allow key-only sign-in for this user. | — |
| `TOO_MANY` | `Too many authentication failures`, `Connection closed by … [preauth]` straight after connect | **The server cut the connection.** It may be limiting sign-ins; wait a few minutes. | Try again |
| `PRIVATE_LOCAL`, `NO_SSH_PROGRAM` | as today | as today | — |
| `UNKNOWN` | anything else | **Something else went wrong.** + scrubbed last line | Details · Try again |

### 4.2 What *Test connection* does

One press, a short checklist (same component as §2.2): name found → port answers SSH → same host key
→ her key accepted → a shell runs (`echo sara-ok; echo "$0"`) → (cPanel) jailed or not. The first
failing line shows its diagnosis; the others stay grey. On success: **"Connected. Sara can work on
example.com."** with *last checked* on the card. `test` keeps its route and return shape and adds
`code`, `title`, `fix`.

---

## 5. Keys: fix, replace, remove

| Action (card menu) | What happens | Asks first |
|---|---|---|
| **Reconnect** (shown when the test says `KEY_NOT_ACCEPTED` or `PASSWORD_OFF`) | Re-opens step 3 with the same key and host key; owner picks a path again. | no |
| **Replace Sara's key** | New ed25519 key; installs it **with the current key** (`installScript` over `exec`), checks it, then removes the old line (`revokeScript`). No password or token needed. If the old key no longer works, falls back to Reconnect with the new key. | yes |
| **Clean up old Sara keys** (shown when the test finds more than one `sara@<instance>-` line) | Lists her lines on the server (`grep -n 'sara@<instance>-' ~/.ssh/authorized_keys`, comments only, shown to the owner), removes the ones that aren't her current key, exact-line matches only. Never touches other lines. On cPanel also deletes `~/.ssh/sara-*.pub` key files that cPanel's import left, by exact name. | yes |
| **Remove Sara's key** (today *Revoke her key*) | As today: removes exactly her line, deletes it here. Also removes cPanel's `~/.ssh/sara-<id>.pub` when path (a) made it. | yes |
| **Edit** (name, user, port) | New `PATCH /api/ssh/servers/:id`. A new port or user keeps the host key only if a new keyscan matches it; a new host is a new server. | no |
| **Remove server** | As today (removes her key first, then forgets everything). | yes |

`loginWithPassword` no longer makes a fresh key each time (the source of stray lines): it reuses the
server's key unless the owner pressed *Replace*.

---

## 6. In chat: "connect to my server"

`ssh_connect` keeps its name and *ask* permission. It now runs §2.2 (add, find the port, host key,
methods, cPanel, her key) and answers with what she found and **one link to the result screen**:
*"example.com runs cPanel and doesn't take passwords. The easiest way: make a cPanel token (3 clicks)
and paste it on this page, and I'll install my own key. [Connect example.com]"*. The link opens
Settings → Servers over SSH at that server's step 3 (`/#view=settings:ab-ssh&server=<id>`).

Secrets stay out of the chat: `redactTypedPassword` learns cPanel tokens (32 upper-case letters and
digits after "token", "api token", "cpanel token" — cPanel's format [C2]) and replaces them before
the message is stored or sent; she then says the token was not read and links the page. She never
asks for a password or token in chat, and no tool takes one (the cPanel path is a Settings action,
not a tool), so the model never sees one.

---

## 7. Where credentials live

| What | Where | Kept? |
|---|---|---|
| **Her private key** (one per server) | `<data>/ssh/keys/<id>_ed25519`, `0600`, Windows ACL locked (`#lockDown`) — as today | Yes. The only SSH credential she keeps. |
| Her public line | `servers.json` and `<id>_ed25519.pub` | Yes (not secret) |
| Approved host key | `<data>/ssh/known_hosts/<id>` | Yes |
| Probe result (port, methods, cPanel yes/no, shell kind, when) | `servers.json` `probe` | Yes (not secret) |
| A password typed once | askpass `0600` file for the seconds of one sign-in, then deleted | **No** — unless the owner ticks *Save* under Advanced and confirms the warning; then the vault (`ssh:password:<id>`, AES-256-GCM) as today |
| A cPanel token | process memory for the 2–4 requests, buffer zeroed | **Never.** No "save the token" option exists. |

The page says it in one line under every path: **"Sara keeps her own key for this server, on this
computer. Your password or token is used once and not kept."** The card shows *Key: Sara's own
(made 1 Nov 2026)* and *Password: not kept*.

Whether her private key should also move into the encrypted vault (written to a `0600` temp file
only for each `ssh` run) is §12 Q4; the default keeps today's file, because `ssh -i` needs a file
for the whole of a long command and the data folder is already the protected place for her keys.

---

## 8. Household and safety rules (unchanged unless listed)

- Owner only. Members' spaces have no SSH tools and `/api/ssh/*` answers 403, including the new
  probe, cPanel, edit, replace and cleanup routes. The demo has no SSH. Group chats, shared work
  channels, private chats and other apps (`/v1`, MCP, Home Assistant, Alexa) never get `ssh_*`.
- Private local mode: the probe, the greeting reads, the keyscan **and the cPanel HTTPS calls** are
  refused for anything that isn't this computer, before any connection (`#checkReach`, `netFetch`).
- **New:** the probe touches at most 7 ports with one short connect each, then one keyscan and one
  methods check: no range scans, no repeated passwords. Password tries: one per press. These limits
  keep hosting firewalls (cPHulk, CSF) from blocking the owner's address.
- **New:** the cPanel token goes only to `https://<host>:2083` (or the certificate's host name the
  owner accepted) with a valid certificate, in a header, never in a URL, a log, a receipt, an error
  text or a model's context. Error texts from cPanel are scrubbed of it like passwords are today.
- **New:** the only cPanel functions Sara calls are `Tokens::list`, `SSH::importkey`,
  `SSH::authkey` and `Tokens::revoke` — listed in code as a fixed allow-list; nothing else can be
  sent with the token.
- Every command on the server still asks first; the ask-first list is unchanged.
- Approvals and receipts: installing, replacing, cleaning up and removing her key write a receipt
  line ("Installed Sara's key on example.com through cPanel"), never the key or token.

---

## 9. Code changes (for the builder; nothing here is built)

- `src/ssh.ts`: `parseAddress`; `probe(id)` (DNS, greeting on the port list, keyscan, methods check,
  cPanel check) with injectable `connect`/`lookup`/`fetch` for tests; `ensureKey(id)` (make once,
  keep); `pasteCommand(publicLine)`; `installViaCpanel(id, token, { apiHost?, revokeToken })`;
  `checkKey(id)`; `diagnose(...)`; `replaceKey(id)`; `listOwnLines(id)` and `cleanupOwnLines(id)`;
  `update(id, {name,user,port})`. `SshServer` gains `probe?` and `connectedVia?: 'cpanel' |
  'password' | 'paste' | 'imported'`. `loginWithPassword` uses `ensureKey`.
- Routes (`src/routes/coding.ts`, owner-only like today): `POST /api/ssh/servers` (now add + probe),
  `PATCH /api/ssh/servers/:id`, `POST …/:id/probe`, `POST …/:id/cpanel` `{ token, apiHost? }`,
  `POST …/:id/check`, `POST …/:id/replace-key`, `POST …/:id/cleanup`. `test` adds `code/title/fix`.
- `web/ssh.js` + `#ab-ssh` in `web/index.html`: the three-step Connect panel (address → checklist →
  result with host key and path cards), the card menu, the diagnosis box. Same CSS tokens; at 390 px
  the status sits right under the button that caused it (W10).
- `src/tools/ssh.ts`: `ssh_connect` runs the probe and returns the plan + deep link;
  `ssh_servers` lines add the diagnosis title.
- `redactTypedPassword`: cPanel token pattern.
- Docs: `docs/SSH.md` rewritten around *Connect a server*; `web/howto.json` `ab-ssh` steps; tips for
  the new fields; six-language strings (the builder's i18n pass).

---

## 10. Done when (`test/ssh-easy.test.ts`)

**Stand-in server:** `test/phase73.test.ts` has no real SSH server; it injects a **fake OpenSSH**
(`FakeSsh`: a `CommandRunner` that plays `ssh`, `ssh-keygen`, `ssh-keyscan` against an in-memory
`authorized_keys`, host key and password). The new test reuses that pattern (moved to
`test/ssh-fake.ts` so both files share it) and adds: a configurable **methods list** (the `none`
reply), shell kind (`bash` / `jailshell` / `noshell` / `/bin/false`), "user exists", and refused /
timed-out / not-SSH ports. Port greetings use a **real local TCP listener** (`net.createServer` on
`127.0.0.1:0` writing `SSH-2.0-OpenSSH_9.6\r\n`, another writing `HTTP/1.1 400`), and cPanel is a
fake `fetch` (`setNetTransport`) that answers `cpsrvd`, `Tokens::list`, `importkey`, `authkey`,
`revoke`, 401 and a wrong certificate. No real server, no network.

1. **Address parsing:** `alex@example.com:2222`, `ssh -p 2222 alex@example.com`,
   `https://example.com:2083` give host/user/port/cPanel hint; junk is refused with today's
   `BAD_HOST`/`BAD_USER` words.
2. **Port finding:** with the owner's port blank, the probe finds the listener on a non-22 port from
   the list; it never tries more than 7 ports; a non-SSH greeting gives `NOT_SSH`; nothing answering
   gives `PORT_CLOSED` or `TIMEOUT` with the ports it tried.
3. **Methods:** the fake's `Permission denied (publickey).` → `PASSWORD_OFF` and path (c) or (a)
   recommended, the password box not offered; `(publickey,password)` → path (b) offered. The methods
   check runs with all client methods off, `BatchMode=yes`, and a throw-away known_hosts holding the
   pending key; no password file or key is passed.
4. **Her key before sign-in:** after Connect, `servers.json` has her public line and the private key
   file exists (`0600`); `pasteCommand` returns exactly the documented one line; a failed attempt
   does not delete the key; a second password sign-in reuses it (no second line on the fake server).
5. **cPanel path:** the fake cPanel sees `Authorization: cpanel alex:<token>` as a header and the
   token in **no** URL; calls are exactly `Tokens::list`, `importkey` (name `sara-<id>`, her public
   line), `authkey` (`action=authorize`), `Tokens::revoke` (when on); her line ends up authorized;
   the key check passes. The token appears in no file under the data folder, no log, no receipt, no
   stored message, no vault entry, no error text (searched byte-for-byte). A 401 gives `WRONG_USER`
   wording; a certificate for another name sends no token and offers that name; any function outside
   the allow-list throws before a request.
6. **Paste path:** "check now" before the line is there → `KEY_NOT_ACCEPTED` with the cPanel
   Authorize hint; after the fake adds the line → connected.
7. **Diagnoses:** each row of §4.1 is produced from the fake's stderr/stdout (DNS, refused, timeout,
   not SSH, host key changed, password off, wrong password, key not accepted, wrong user via cPanel,
   no shell — both the cPanel message and the silent `/bin/false` —, jailed note, two-step, too many);
   no raw OpenSSH text in `title`/`fix`; the password and token never appear in `Details`.
8. **Host key:** first-use wording and changed wording render from the view; trust still needs the
   exact pending fingerprint; a changed key still blocks `exec`.
9. **Keys:** *Replace* installs the new line with the old key, verifies, removes the old line, and
   leaves the owner's own lines; *Clean up* removes only `sara@<instance>-` lines that aren't
   current; *Remove* removes her line and the `sara-<id>.pub` file; *Edit* changes the port without
   losing a matching host key.
10. **Who:** members get 403 on every new route; the demo has none; private local mode refuses a
    non-loopback probe and the cPanel call before any connect/fetch; `ssh_connect` from `/v1`/MCP is
    still filtered out.
11. **Chat:** a pasted 32-character cPanel token after "token" is `[REDACTED]` before storage;
    `ssh_connect` returns the plan and the deep link, and no tool schema has a token or password
    field.
12. **Phase 73 still passes** unchanged (except tests that asserted a fresh key per password
    sign-in, updated to the "made once" rule).
13. **UI (ui-check at 1440 and 390):** Connect form has two fields; the checklist and the result
    screen render for cPanel / password / paste / not-found; the status sits under its button at
    390; no horizontal scroll.

---

## 11. Hosts, ports and quirks (what the probe and the steps rely on)

| Host type | SSH port | Quirk | Source |
|---|---|---|---|
| Plain Linux VPS / home server | 22 | Often `PasswordAuthentication no` on cloud images | — |
| cPanel (generic) | 22 by default; host's choice | *Generate a New Key* asks for a passphrase unless the host set the SSH Keys strength to 0; a generated or imported key works only after **Authorize**; shell can be *Normal*, *Jailed* or *Disabled* (WHM → Account Functions → Manage Shell Access); disabled shows "Shell access is not enabled on your account" | [C3] [C4] [C5] |
| HostGator shared/reseller | **2222** | cPanel 2083, WHM 2087 | [S2] |
| Bluehost shared | 22 | Shell access must be switched on in the Bluehost portal first; account verification may be required | [S4] |
| Namecheap shared (and managed VPS) | **21098** | SSH on request for some plans | [S5] |
| SiteGround | **18765** | Key only (no passwords); own Site Tools, not cPanel | [S1] |
| Hostinger | **65002** | SSH only on Premium and higher plans; hPanel, not cPanel | [S3] |
| A2 Hosting | **7822** | cPanel | [S6] (third-party page; confirm) |
| Any cPanel server | — | cPHulk / CSF can block an address after repeated failed sign-ins: one try per press | [C4] (shell access page); general cPanel behavior |

---

## 12. Owner to-dos, risks, blocking questions

### Owner to-dos (after the build, on his own server)

1. On the cPanel server that failed: run *Connect a server* with only the address and user. Expect:
   "doesn't take passwords", cPanel found, token path recommended.
2. Make a token (expiry tomorrow), paste it, confirm: cPanel → *Manage SSH Keys* shows `sara-<id>`
   **authorized**, and *Manage API Tokens* no longer lists `sara` (if Q2 stays on).
3. *Test connection* → "Connected", and the jailed / normal shell note matches WHM.
4. *Remove Sara's key* → the key is gone from cPanel's list too.
5. Delete the passphrase key he made in cPanel by hand earlier (Manage SSH Keys → Delete), since
   nothing uses it.

### Risks

| Risk | Mitigation |
|---|---|
| `SSH::importkey` with only a **public** key: the docs show a private-key example; cPanel's UI import accepts a public key alone [C3] but the API page doesn't say so explicitly | Owner to-do 2 confirms it. Fallback in code: if `importkey` errors, Sara switches to path (c) with cPanel steps pre-filled. |
| API 2 is deprecated [C1] | cPanel states no UAPI equivalent exists; the four calls sit behind one function so a future UAPI replacement is a one-place change. |
| A token is a full-access credential for that cPanel account while it lives | Header-only, HTTPS with a valid certificate, allow-listed functions, never stored, revoked by Sara when Q2 is on; the steps tell the owner to set expiry to tomorrow. |
| Probing a few ports could look like scanning to a host's firewall | 7 connects max, one at a time, only on Connect / Find the port. |
| The methods list can be incomplete (servers MAY omit methods, and `Match` blocks can allow passwords for some users only) [R1] | Treated as a recommendation, not a lock: "Other ways" always lists every path. |
| `LogLevel=VERBOSE` for the no-shell check prints more to stderr | Used only in the test call; stderr scrubbed and kept behind *Details*. |
| Trust on first use | Said honestly (§3); a changed key still stops everything. |

### Blocking questions (with the default the build uses if there's no answer)

- **Q1. Port list for "Sara finds it":** 22, 2222, 21098, 18765, 65002, 7822. *Default: yes, that list.*
- **Q2. Sara revokes the cPanel token herself when she's done** (needs the token named `sara`, as the
  steps say). *Default: on, with a line "Sara deleted the token for you".*
- **Q3. WHM / root (port 2087) path:** the WHM API can install root's keys, but a root token is a
  server-wide credential. *Default: no WHM path; root servers use the password-once or paste path.*
- **Q4. Her private key in the vault** instead of a `0600` file. *Default: keep the file (today's
  behavior, needed by `ssh -i`); revisit if backups should never hold a usable key.*
- **Q5. Where *Connect a server* lives:** Settings → Abilities → Servers over SSH only, or also a
  *Connect a server* button on the Coding page. *Default: Settings, plus the chat deep link.*

---

## 13. Sources

- [C1] cPanel API 2 — `SSH` module, `SSH::authkey` (authorize/deauthorize; "no equivalent UAPI
  function exists"), `SSH::importkey`: https://api.docs.cpanel.net/cpanel-api-2/cpanel-api-2-modules-ssh ,
  …/cpanel-api-2-functions-ssh-authkey , …/cpanel-api-2-functions-ssh-importkey
- [C2] How to Use cPanel API Tokens (header `Authorization: cpanel username:APITOKEN`, port 2083,
  tokens run UAPI and API 2): https://docs.cpanel.net/knowledge-base/security/how-to-use-cpanel-api-tokens/ ;
  Manage API Tokens (*cPanel » Home » Security » Manage API Tokens*, expiry, copy once):
  https://docs.cpanel.net/cpanel/security/manage-api-tokens-in-cpanel/ ; API Tokens in cPanel:
  https://api.docs.cpanel.net/cpanel/tokens
- [C3] cPanel SSH Access (Generate a New Key: passphrase unless *SSH Keys* strength is 0; Import
  Key; "You must authorize new keys before you attempt to use them"):
  https://docs.cpanel.net/cpanel/security/ssh-access/
- [C4] WHM Manage Shell Access (Normal / Jailed / Disabled; `/bin/false` to stop SFTP):
  https://docs.cpanel.net/whm/account-functions/manage-shell-access/ ; VirtFS Jailed Shell:
  https://docs.cpanel.net/knowledge-base/accounts/virtfs-jailed-shell/
- [C5] "Shell access is not enabled on your account":
  https://support.cpanel.net/hc/en-us/articles/360050489653-Shell-access-is-not-enabled-on-your-account
- [R1] RFC 4252 §5.1 (`SSH_MSG_USERAUTH_FAILURE`, "authentications that can continue") and §5.2
  (the `none` request): https://www.rfc-editor.org/rfc/rfc4252.txt
- [S1] SiteGround: key-only SSH on port 18765:
  https://www.siteground.com/kb/which_ports_are_open_on_siteground_shared_servers
- [S2] HostGator ports (SSH shared/reseller 2222, cPanel 2083, WHM 2087):
  https://www.hostgator.com/help/article/commonly-used-port-numbers ; enabling shell:
  https://www.hostgator.com/help/article/how-do-i-get-and-use-ssh-access
- [S3] Hostinger: port 65002: https://www.hostinger.com/tutorials/ssh-connection-refused/ ,
  https://www.hostinger.com/support/5634587-how-to-solve-the-most-common-errors-in-ssh-at-hostinger/
  (hPanel menu path in §2.4 c to confirm when building)
- [S4] Bluehost SSH access: https://www.bluehost.com/help/article/ssh-access
- [S5] Namecheap port 21098:
  https://www.namecheap.com/support/knowledgebase/article.aspx/1016/89/how-to-access-a-hosting-account-via-ssh/
- [S6] A2 Hosting port 7822 (third-party): https://jblevins.org/log/ubuntu-vps
- Code read: `src/ssh.ts`, `src/tools/ssh.ts`, `src/routes/coding.ts` (`a === 'ssh'`), `web/ssh.js`,
  `web/index.html` (`ab-ssh`), `web/howto.json` (`ab-ssh`), `web/tips.json` (`ssh-*`),
  `docs/SSH.md`, `docs/DECISIONS.md` (2026-10-29 SSH), `test/phase73.test.ts`.
- Screenshots (local, gitignored): `outputs/ui-review/ssh-audit/01-empty` … `11-password-failed`,
  each at `-1440.png` and `-390.png`. `11-password-failed` shows raw OpenSSH text reaching the owner:
  "ssh: connect to host 192.0.2.10 port 22: Connection timed out".
