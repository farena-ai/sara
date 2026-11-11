# Your other servers over SSH (2.2, easy Connect in 2.52.1)

Sara can work on servers you name over SSH: check a disk, read a log, restart a service, pull and
deploy a project. You give her the address and your user name; she makes **her own key for that
server**, looks at it, and picks the easiest way to put her key there. She keeps only her key: a
password or a cPanel token is used once to install it and then forgotten. Every command still goes
through her approval rules.

Settings → Abilities → **Servers over SSH** (owner only).

## How it works

Sara doesn't speak the SSH protocol herself. She runs the **OpenSSH client that comes with the
operating system** (`ssh`, `ssh-keygen`, `ssh-keyscan`): built into macOS and Windows 10/11, and the
`openssh-client` package on Linux (installed almost everywhere; the Docker image includes it). The
programs are started with an argument list, never through a shell, and always with the same safe
options:

| Option | Why |
|---|---|
| `-F none` | Your own `~/.ssh/config` (aliases, proxies, forwarding) is ignored |
| `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<data>/ssh/known_hosts/<id>`, `HostKeyAlias=sara-<id>`, `HostKeyAlgorithms=<the approved type>`, `UpdateHostKeys=no` | Only the host key you approved for that server is accepted |
| `IdentitiesOnly=yes`, `-i <her key>`, `IdentityAgent=none` | Only her key for that server; your SSH agent and your own keys are never offered |
| `BatchMode=yes` | With a key, nothing can stop and wait for a typed answer |
| `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes` | Nothing is forwarded either way |
| `ControlMaster=no`, `ControlPath=none`, `PermitLocalCommand=no` | No shared connections, no local commands |
| `ConnectTimeout=15`, `ServerAliveInterval=15` | A dead server doesn't hang her |

The command you approve is passed to the server as one argument and run by the server's shell, as
with `ssh server 'command'`. Output is shown with the exit code (long output keeps its start and
end, about 16,000 characters).

## Connect a server (2.52.1)

1. **Address and user name.** Type them under *Connect a server*, or paste what your host gave you:
   `example.com`, `alex@example.com:2222`, `ssh -p 2222 alex@example.com`, or your cPanel link
   (`https://example.com:2083`). The port is optional: *Port: Sara finds it*. Or ask her in chat
   ("connect my server example.com, user alex"): she looks at it and sends you **one link** to that
   server's last step.
2. **Sara looks** (a short checklist, nothing secret is sent):
   - finds the name (DNS);
   - finds the SSH port: the one you gave, else **22, 2222, 21098, 18765, 65002, 7822**, one short
     connect each (at most 7), reading only the server's first line (`SSH-2.0-…`). A web server on
     that port is reported as "it answers, but it isn't SSH";
   - reads the server's **ID card** (host key) with `ssh-keyscan`; it waits for your yes;
   - asks which sign-in methods it allows: one `ssh` run with every method switched off, so the
     server answers `Permission denied (publickey,password)` with its list. No password, no key;
   - looks for **cPanel** on port 2083 (an anonymous HTTPS look at the certificate and the
     `Server: cpsrvd` header);
   - makes **her own key** (ed25519) now, so every path has her public line. It is made once and
     kept until you press *Replace Sara's key*; a failed try never deletes it.
3. **The ID card, then the way in.** *Is this really your server?* Sara remembers the host key and
   refuses the server if it ever changes (trust on first use, as OpenSSH does; *How can I check it?*
   says how to compare it if you can). Right after your yes, **Sara quietly tries her own key**
   (the same BatchMode sign-in as *Test connection*): if someone already added it (an admin, an
   earlier try), she says *Connected* and there is no way in to pick. She tries it again whenever
   you reopen a server that isn't connected yet (*Reconnect*, the chat's link) and when she looks
   at it again. A miss records nothing on the card. Otherwise the recommended way is **one box
   with one big button** (*Easiest way for this server*), the others a short *Other ways* list:

| Sara found | Recommended | Also offered |
|---|---|---|
| cPanel on 2083, a cPanel user | **Use a cPanel token** | copy and paste; the password if the server takes one |
| cPanel on 2083, user `root` (or `id -u` said 0) | **Add Sara's key yourself** (WHM steps), or the password once if the server takes one | copy and paste; **never** a cPanel token |
| No cPanel, passwords allowed | **Type the password once** | copy and paste |
| No cPanel, keys only | **Add Sara's key yourself** | a cPanel token |
| No SSH port | the fix-it box: the ports tried, *Find the port*, *Set the port* | — |

**root and cPanel (3.4.1).** cPanel API tokens belong to cPanel accounts; root signs in to WHM. So
for user `root`, or any user whose last test showed uid 0, Sara never recommends or offers the token
path, and the server refuses a token for root before any request (*A cPanel token doesn't work for
root*, with *Add Sara's key yourself*). The paste path shows the WHM steps instead: **WHM →
Security Center → Manage root's SSH Keys → Import Key**, then **Authorize**, plus the one-line
terminal command.

### (a) A cPanel token

In cPanel: **Security → Manage API Tokens → Create**, name it `sara`, set the expiry to tomorrow,
**Create**, **Copy**, paste it into the *cPanel token* box and press **Install my key**. Sara then
calls exactly four cPanel functions over HTTPS on port 2083, with the token only in the
`Authorization: cpanel <user>:<token>` header (never in a URL): `Tokens::list` (is the token for
this user?), `SSH::importkey` (her public line as `sara-<id>`), `SSH::authkey` with
`action=authorize` (the step that's easy to miss by hand), and, unless you untick it,
`Tokens::revoke` for the token called `sara`. Any other function is refused in code before a
request. The certificate must be valid **for the name**; if it is for another name (common on
shared servers: `server123.host.com`), no token is sent and Sara offers that name instead. The token
is never written to disk, the vault, a log, the chat or an error text. There is no WHM / root
token path (see *root and cPanel* above). Something pasted that doesn't look like a token (32
capital letters and digits) gets *That doesn't look like a cPanel token* with a button for *Add
Sara's key yourself*.

`SARA_CPANEL_PORT` changes cPanel's port (default 2083) for a host that moved it.

### (b) The password once

Only offered when the server lists `password` or `keyboard-interactive`. One try per press (cPHulk
and CSF block an address after repeated failures). See *The password rule* below.

### (c) Add Sara's key yourself

Her public key with a **Copy** button and the clicks for your host: cPanel (*SSH Access → Manage
SSH Keys → Import Key*, then **Manage → Authorize**), SiteGround (*Devs → SSH Keys Manager*, port
18765), Hostinger (*Advanced → SSH Access*, port 65002), or one line for a terminal or web console:

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA… sara@home-20261101' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Then **I've added it: check now**. While this way is open Sara also checks by herself every 5
seconds for 4 minutes (the quiet try: a miss records nothing), and at once when you come back to
the page, so adding the key in another window and coming back just works.

## When something fails

Every failure shows a plain-language box under the button you pressed, with the buttons that fix
it; the raw `ssh` text is behind *Details* (passwords and tokens scrubbed). Her tools say the same
words.

| Code | What Sara says |
|---|---|
| `DNS` | I can't find that name |
| `PORT_CLOSED` / `TIMEOUT` | Nothing answers SSH / it didn't answer (the ports tried; try another port, or wait if your host blocked this computer) |
| `NOT_SSH` | The port answers, but it isn't SSH |
| `HOSTKEY_CHANGED` | Stop: a different ID card (a hard stop until you trust the new one) |
| `PASSWORD_OFF` | This server doesn't accept passwords at all |
| `WRONG_PASSWORD` | The server said no to that password |
| `KEY_NOT_ACCEPTED` | The server doesn't accept Sara's key yet (on cPanel: **Authorize**) |
| `WRONG_USER` | No cPanel user by that name, or the token isn't for it |
| `NO_SHELL` | The key works, but shell access is off (WHM → Manage Shell Access) |
| `JAILED` | Connected, with a limited shell (a note, not a failure) |
| `TWO_STEP` | The server wants a code after the key |
| `TOO_MANY` | The server cut the connection; wait a few minutes |
| `CERT_NAME` / `CERT_BAD` / `NO_CPANEL` / `BAD_TOKEN` / `CPANEL_FAILED` | The cPanel path's own answers |

## The card

*Test connection* (a checklist: name, port, same ID card, her key, a command runs, jailed or not),
*Reconnect*, and under **More**: *Edit* (name, user, port without removing; a new port keeps the ID
card only if the server shows the same one there), *Replace Sara's key* (a new key installed with
the current one, checked, then the old line removed: no password needed), *Clean up old Sara keys*
(when the test finds more than one `sara@<instance>-` line: removes only her stale lines and
cPanel's matching `sara-*.pub` files), *Forget the password*, *Remove Sara's key*, *Remove server*.

## The password rule

- You type the password **once**, in the password box on the settings page (`type=password`,
  `autocomplete=off`). Never in the chat: if you type one there by mistake, it is replaced with
  `[REDACTED]` before the message is stored, shown again or sent to a model, and she tells you to
  use the settings page.
- The password reaches `ssh` through **`SSH_ASKPASS`**: a tiny helper in a private `0700` folder
  prints the password from a `0600` file and deletes it as it reads it; the folder is removed right
  after. It is never on a command line, never in an environment variable, never in a log. The
  server's error text is scrubbed of it.
- She uses **her own key** for the server, made when you pressed Connect (ed25519, no
  passphrase, comment `sara@<instance>-<date>`), at `<data>/ssh/keys/<id>_ed25519` (`0600`; on
  Windows the file's inherited permissions are removed), and **installs it** in
  `~/.ssh/authorized_keys` on the server: `~/.ssh` is made `700` and the file `600`, a missing last
  newline is fixed, and the line is added only if it isn't there yet. Then she signs in with the key
  to check it works.
- She tells you plainly, in the chat that added the server and on the settings page: that she made
  an SSH key for that server, the full path of the private key on the Sara server, the public key
  line she installed, that she uses the key from now on, and that she **did not keep the password**.
- **Saving the password** happens only if you ask for it in so many words. She first warns that it
  is a security risk (anyone who gets into Sara, or a copy of her data with its master key, could
  sign in to that server with it, and anywhere else that password works; a key opens only this one
  server and can be revoked), and asks for an explicit yes. Then you tick *Save the password for
  future sessions*, tick *I understand the risk* and confirm once more. It is stored **encrypted**
  in her vault (`secrets.enc`, AES-256-GCM, like her API keys) and *Forget the password* removes
  it with one click. A saved password is used only when she has no key for that server.

## Using a key you already have

Paste a private key the server already accepts (the text file that starts with `-----BEGIN OPENSSH`), or give
the full path of a key file **on the computer Sara runs on**. She copies it to
`<data>/ssh/keys/<id>_imported` (`0600`) and signs in with it to check. Keys protected by a
passphrase can't be used (she would have to keep the passphrase): that includes keys cPanel's
*Generate a New Key* made; use the cPanel token or copy and paste instead.

## Every command asks first

`ssh_run` asks you before every command by default, like her shell. You can let it run on its own
in Settings → Coding → Tools and approvals; even then, commands on the **ask-first list** always
wait for your OK: deleting recursively (`rm -r`, `rm -f`), shutting down or rebooting, disks
(`mkfs`, `dd of=`, `fdisk`), users and passwords, firewalls, `systemctl stop/disable`, recursive
`chmod/chown`, piping a download into a shell, anything touching `authorized_keys`,
`/etc/passwd`, `/etc/shadow`, `/etc/sudoers` or `sshd_config`, writing into system folders,
dropping databases, force pushes, removing containers, `kill -9`. Adding a server, revoking a key,
forgetting a password and removing a server always ask.

## A changed host key

If a server shows a different host key than the one you approved, `ssh` refuses and so does she:
nothing runs, she tells you, and the card shows **Host key changed** with the new fingerprint. If
you know why (a reinstall, a new machine at that address), check the new fingerprint and trust it;
otherwise someone may be between you and the server. She never works around it.

## Revoking and removing

- **Revoke her key**: she signs in with it one last time and removes **exactly her line** from
  `~/.ssh/authorized_keys` (an exact whole-line match; your other keys and look-alike lines stay;
  the file is rewritten in place so its owner and permissions stay), then deletes the key files
  here. A key you gave her is only deleted here: it's yours to remove from the server.
- **Remove**: revokes her key first (for keys she made), then forgets the server, its host key and
  any saved password.

## What is stored where

| What | Where |
|---|---|
| Server list (name, address, port, user, approved fingerprint and key type, her key's path and public line, when it was last used, the last problem) | `<data>/ssh/servers.json` (`0600`) |
| Approved host keys, one file per server | `<data>/ssh/known_hosts/<id>` |
| Her keys | `<data>/ssh/keys/<id>_ed25519` (+ `.pub`), keys you gave her `<id>_imported` |
| A saved password (only if you asked) | the encrypted vault `secrets.enc`, name `ssh:password:<id>` |
| The one-time password helper | `<data>/ssh/tmp/r-*` for the few seconds of the sign-in, then deleted |

The data folder is in her backups, so her keys are too (like her API keys). Data export
(Settings → Data) doesn't include them.

## Who can use it

- **Only the owner**, in her own chats with the owner. Not people in your household (members'
  spaces have no SSH tools and the `/api/ssh` routes answer 403), not the demo server (no SSH at
  all), not group chats, shared work channels or private (off-the-record) chats.
- **Never other apps**: the `ssh_*` tools are taken out of every turn that comes from the
  OpenAI-compatible API (`/v1`), MCP (`ask_sara`), Home Assistant or Alexa, even when you allow her
  tools for other apps; the MCP server's own tools have nothing of it.
- **Nothing leaves this computer** (private local mode): she only reaches servers on this computer
  (`127.0.0.1`, `::1`, `localhost`), like every other connection; anything else, including other
  machines on your home network, is refused before any connection is made. (Decision: the mode
  promises that nothing leaves the computer, and a LAN server is another computer.)

## Her tools

| Tool | Default | What it does |
|---|---|---|
| `ssh_servers` | runs on its own | Lists the servers with fingerprint, key and password status |
| `ssh_connect` | asks | Looks at a server (port, ID card, sign-in methods, cPanel, her key) and gives you one link to finish on the Connect page; it never takes a password or token |
| `ssh_run` | asks (risky commands always ask) | Runs one command, shows output and exit code |
| `ssh_forget_password` | asks | Forgets a saved password |
| `ssh_revoke_key` | asks | Removes her line from the server, deletes the key here |
| `ssh_remove_server` | asks | Revokes her key, then forgets the server |

Copying files up and down (scp/sftp) is not part of 2.2.

## Limits

- Installing and revoking her key needs a POSIX shell on the server (Linux, macOS, BSD; the usual
  case). Windows servers running OpenSSH with `cmd.exe` as the shell can be used with a key you give
  her, but she can't install her own there.
- JavaScript can't wipe a string from memory: the password is copied into a buffer that is zeroed
  after use and the request's copy is dropped, but the runtime may keep a copy until it is garbage
  collected.
- Commands run as the user you gave her, with that user's rights. Prefer a normal user with `sudo`
  for the few things that need it over `root`.

Code: `src/ssh.ts` (the manager), `src/tools/ssh.ts` (her tools and the ask-first list),
`src/ssh-easy.ts` (address parsing, the port greeting, cPanel calls, diagnoses), `web/ssh.js` (the
settings page), tests in `test/phase73.test.ts` and `test/ssh-easy.test.ts` (the fake OpenSSH in
`test/ssh-fake.ts`). Design: [design/SSH_EASY.md](design/SSH_EASY.md).
