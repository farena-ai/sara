# Installing Sara

Sara runs on one server (Linux, Windows 10/11 or macOS 13+) for one owner. You need about 1 GB of
disk for Sara itself, more for optional local voice (1.3 GB) and subscription programs (0.5 GB). A
GPU is only needed if you want to run models locally with Ollama. How big a machine you need:
[REQUIREMENTS.md](REQUIREMENTS.md). Which model to pick: [CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md).

New to this? These pages help too: [what it costs](COSTS.md), [what leaves your server](PRIVACY.md),
[your phone](PHONE.md), [moving to a new computer](MOVING.md), the
[security checklist](SECURITY_CHECKLIST.md) for after installing, and the [FAQ and glossary](FAQ.md).

## 1. Install

### The easy way: one command

Needs a Linux server (or a spare computer) running systemd: Debian/Ubuntu, Fedora/RHEL/Alma/Rocky,
Arch or openSUSE, on x86_64 or arm64. Copy this line into its terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
```

(This works once the repository is public. Until then, copy Sara to the server and run
`sudo bash deploy/get-sara.sh --source <that folder or .tar file>`.)

It downloads Sara into `/opt/sara-src`, checks the copy, and then asks a few questions. Each one
shows a suggestion in [brackets]: just press Enter to take it.

1. **How will you reach her?**
   - **Tailscale** (suggested when Tailscale is installed and signed in on this machine): a private
     address that only your own devices can open, from your phone anywhere, with HTTPS done for you.
     If your Tailscale network hasn't turned on HTTPS certificates yet, it tells you the one switch
     to press in the Tailscale admin page.
   - **Just this computer** (suggested otherwise): open her on this machine, or from your own
     computer through an SSH tunnel (below).
   - **My own web address**: asks your web address (like `sara.example.com`) and an email for
     certificate notices, checks that the address points at this machine, installs Caddy (after
     asking) and sets up HTTPS for you. Point the address at the server and open ports 80 and 443
     first (`sudo ufw allow 80,443/tcp`).
   - **My home network**: other devices at home can open `http://<this machine>:7860`. This is plain
     HTTP, so anyone on that network could see your sign-in: only use it on a network you trust.
2. **Safer shell for her coding tools?** [Y] installs bubblewrap, so her shell only sees her
   workspace. (Not asked when bubblewrap is already installed.)
3. **Voice on this server?** [n] downloads local speech recognition and voices (about 650 MB), so
   speech never leaves the server. (x86_64 only: on arm64 the question is skipped and cloud voices
   work in Settings → Her → Voice. Also skipped when local voice is already installed.)
4. **Port** [7860], then a summary and **Go ahead?** [Y].

At the end it prints your **one-time owner token** and the address to open. Keep the token in a
password manager.

Change how you reach her any time:

```sh
sudo sara access                 # how you reach her now, and the address
sudo sara access tailscale       # or: local | lan | domain --domain sara.example.com --email you@example.com
```

Switching away from Tailscale removes Sara from `tailscale serve`; switching away from your own web
address takes Sara's site out of Caddy (Caddy stays installed).

**No questions** (scripts, automation): `--yes` takes every suggestion, and these options set
answers: `--access tailscale|local|domain|lan`, `--domain NAME`, `--email ADDRESS`, `--port N`,
`--sandbox` / `--no-sandbox`, `--voice` / `--no-voice`, `--source PATH`. For example:

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash -s -- --yes --access domain --domain sara.example.com --email you@example.com
```

The only system packages it installs are `git`, `curl` and `ca-certificates` (when missing) and
what you choose (`bubblewrap`, `caddy`, `bzip2` for voice), from your distribution, asking first.
Run it again any time: it updates the copy in `/opt/sara-src` and keeps your data.

### Step by step (manual)

The same install by hand:

```sh
# Debian/Ubuntu
sudo apt install git curl ca-certificates bubblewrap
# Fedora/RHEL/Alma/Rocky
sudo dnf install git curl ca-certificates bubblewrap

sudo git clone https://github.com/farena-ai/sara /opt/sara-src
sudo /opt/sara-src/deploy/install.sh
```

Containers and hosts without systemd: use [Docker Compose](#docker-compose).

`bubblewrap` is optional but recommended: with it, her shell runs in a sandbox that can only see her
workspace (Ubuntu 24.04 needs one extra step, see [Troubleshooting](#troubleshooting); the one-command
installer does that step for you).

Keep the checkout in root-owned `/opt/sara-src` exactly as above. Updates run `git` as root in that
folder, and git (rightly) refuses to do that in a folder another user owns, so a checkout in your
home folder can install Sara but can't update her. The installer warns you and prints the command
that moves it.

The installer:

- creates a `sara` system user and a systemd service (`sara`), hardened and resource-limited;
- installs her own Node.js (a pinned version, checked against its SHA-256) into `/opt/sara/node`;
  your system Node.js, if any, is neither used nor touched (`SARA_USE_SYSTEM_NODE=1` uses a
  system Node.js 24+ instead);
- keeps your data in `/var/lib/sara` and settings in `/etc/sara/sara.env`;
- installs the `sara` admin command;
- on the first install, prints your **one-time owner token**. Keep it in a password manager.

Lost the token? `sudo sara reset-token` prints a new one (it also signs out every browser). If the
installer didn't show it: `sudo journalctl -u sara | grep -A1 'owner token'`.

#### Signing in the first time

With "just this computer" (and after a manual install), Sara listens only on the server itself
(`127.0.0.1:7860`), so nobody else can reach her until you set up HTTPS. For the first sign-in:

- **On the server's own desktop:** open http://127.0.0.1:7860.
- **From your computer** (a VPS, a headless box): open an SSH tunnel, then browse to it locally:

  ```sh
  ssh -L 7860:127.0.0.1:7860 you@your-server
  # leave that running and open http://localhost:7860
  ```

- **From your phone:** use Tailscale or your own web address (`sudo sara access`), or set up HTTPS
  by hand (section 2).

Don't set `SARA_HOST=0.0.0.0` to "make it reachable": that serves Sara, sign-in included, as plain
HTTP to the whole network. Use the tunnel or HTTPS.

To remove Sara again: `sudo sara uninstall`. It makes a last backup and keeps your data in
`/var/lib/sara` (installing again picks it up); `sudo sara uninstall --delete-data` removes the data
too, after saving a last backup in `/root`. The source copy in `/opt/sara-src`, the testing browser
in `/opt/sara-browser` and any packages the installer added (bubblewrap, Caddy, bzip2) stay. Remove
them with `sudo rm -rf /opt/sara-src* /opt/sara-browser` (and your package manager).

### Docker Compose

Needs Docker Engine with the Compose v2 plugin (the `docker compose` command): install it from
Docker's official instructions, https://docs.docker.com/engine/install/ (the distribution's own
`docker-compose` package is often the old v1).

```sh
sudo git clone https://github.com/farena-ai/sara /opt/sara-src && cd /opt/sara-src
sudo docker compose up -d                       # Sara on her own, or:
sudo docker compose --profile ollama up -d      # Sara + a local Ollama (--profile goes before up)
sudo docker compose logs sara | grep -A1 'owner token'
```

Sign in exactly as above (SSH tunnel to port 7860, or HTTPS). Instead of the long token you can also
set her up in the browser within an hour of the first start: **Set up Sara** asks for the short
setup code that is in the same log (`sudo docker compose logs sara | grep 'setup code'`), then shows
your owner token once (the one printed in the log stops working). Day-to-day commands, run in
`/opt/sara-src`:

```sh
sudo git pull && sudo docker compose up -d --build                # update
sudo docker compose exec sara node src/main.ts --backup           # back up now (kept in the volume, /data/backups)
sudo docker compose exec sara ls /data/backups                    # list backups
sudo docker compose cp sara:/data/backups/<name>.tar.gz .         # copy one off the server's volume
sudo docker compose exec sara node src/main.ts --doctor           # deeper checks
sudo docker compose exec sara node src/main.ts --reset-token      # new owner token, then:
sudo docker compose restart sara
```

Restore (Sara must be stopped; the current data is kept aside inside the volume):

```sh
sudo docker compose stop sara
sudo docker compose run --rm --no-deps -v "$PWD/sara-backup.tar.gz:/restore.tar.gz:ro" \
  sara node src/main.ts --restore /restore.tar.gz
sudo docker compose start sara
```

(An encrypted `.enc` off-server copy also needs `-e SARA_BACKUP_PASSPHRASE` on the `run` line; it
asks nothing, so type `read -rs SARA_BACKUP_PASSPHRASE; export SARA_BACKUP_PASSPHRASE` first.)

- **Behind an HTTPS proxy:** create a `.env` file next to `docker-compose.yml` with
  `SARA_SECURE_COOKIES=1` and `SARA_TRUST_PROXY=1`, then `sudo docker compose up -d`.
- **Ollama on the same machine (not in Docker):** the base URL in Settings is
  `http://host.docker.internal:11434/v1`. Ollama must listen on more than loopback for that
  (`OLLAMA_HOST=0.0.0.0`; keep port 11434 closed in your firewall). With `--profile ollama` it is
  `http://ollama:11434/v1`.

Docker covers chat, tools, memory, planner, bridges and push. Local voice and the subscription
programs are native-install features for now. **Isolation is weaker than native:** containers
can't use bubblewrap, so her shell commands and MCP servers run as a separate `sara-tools` user
that can't read Sara's data (keys, database) but otherwise sees the container's whole file system
(with bubblewrap they see only their workspace). The server keeps only the few Linux capabilities
it needs to start them as that user, and `no-new-privileges` is on.

### Windows: one installer for her server and the app

`Sara-Setup-<version>.exe` (from the [release page](https://github.com/farena-ai/sara/releases/latest))
installs Sara's server, her own private Node.js and the Sara desktop app together, on Windows 10 or
11 (64-bit). Nothing else is needed; it doesn't touch any Node.js you already have. Or it installs
only the app, to use a Sara that runs somewhere else (below).

**The installer isn't code-signed yet**, so Windows SmartScreen says "Windows protected your PC".
Choose **More info → Run anyway**. (Check the download against the SHA-256 on the release page if
you like: `certutil -hashfile Sara-Setup-<version>.exe SHA256`.)

The first page asks **How do you want to use Sara?**

- **Run Sara on this computer**: her server and the app (the questions below).
- **Connect to a Sara somewhere else**: only the Sara app, for a Sara that already runs on another
  computer or server. No administrator is needed and nothing else is installed (no server, no
  Node.js, no service, no `sara` command, no data folder, no firewall rule). It asks **Where is your
  Sara?**: type the address you open her at in a browser, like `sara.example.com` (HTTPS is assumed;
  addresses at home like `192.168.1.20:7860`, `*.local` and Tailscale's `100.x` addresses use plain
  HTTP). Then open Sara and sign in with a code: on a phone or computer where you're already signed
  in, Settings → Data & health → Devices and sign-in → **Add a phone or computer**. Moved, or a different Sara?
  Right-click her icon next to the clock → **Connect to a different Sara…**. If she can't be reached,
  the app says so, with the address, *Try again* and *Change address*.

Running Sara on this computer asks three more things; the usual answer is already chosen:

1. **How should Sara run?**
   - *From when the computer starts, as a Windows service* (recommended; needs an administrator).
     The service is called **Sara** and runs as its own limited account, `NT SERVICE\Sara` (not
     SYSTEM), starting a little after boot; Windows restarts it if it ever fails. Her data is in
     `C:\ProgramData\Sara`, readable only by that account, administrators and Windows itself. The
     program is in `C:\Program Files\Sara`.
     Choosing it starts the installer again as administrator (Windows asks).
   - *Only while I'm signed in* (no administrator). The program goes to
     `%LOCALAPPDATA%\Programs\Sara`, her data to `%LOCALAPPDATA%\Sara\data`, and her server starts
     when you sign in (a "Sara server" entry under Settings → Apps → Startup). It runs in the
     background without a window.
2. **How will you reach her?**
   - *Tailscale* (chosen when Tailscale is installed and signed in): a private HTTPS address like
     `https://pc.tail1234.ts.net` that works on your own devices anywhere. Sara sets it up with
     `tailscale serve` (on another HTTPS port, e.g. `:10443`, if you already serve something on 443).
     If the installer says HTTPS is off: open https://login.tailscale.com/admin/dns and press
     **Enable HTTPS**.
   - *Just this computer*: `http://127.0.0.1:7860`.
   - *My home network*: plain HTTP on this computer's network address (the installer warns you;
     anyone on that network could read what you send). As a service, a Windows Firewall rule for her
     port on private networks is added; in signed-in mode Windows asks once whether to allow Node.js:
     choose Allow on private networks.
   - *My own web address*: Windows has no web server built in, so you set up HTTPS yourself (any
     web server or tunnel that forwards `https://your-address` to `http://127.0.0.1:7860`, with
     streaming and WebSockets passed through: see [section 2](#2-reach-her-securely-https)). Sara
     is then set to trust that proxy and use secure cookies.
3. **Port** (7860, or the next free one if something uses it).

The last page shows **your owner token** with a Copy button (keep it in a password manager: it is
shown only once), the address to open, and that **she asks before every command** she runs (Windows
has no sandbox). **Open Sara** starts the app already pointed at `http://127.0.0.1:<port>`, so you
only paste the token.

**The `sara` command** (open a new terminal after installing; for a service install, open it as
administrator):

```
sara status              is she running, how she runs, her address, data size, last backup
sara doctor              deeper checks
sara backup [file]       back up now (default: <data>\backups)
sara backups             list backups
sara restore <file>      stops her, restores (current data kept aside), starts her
sara reset-token         a new owner token (signs out every browser), then restarts her
sara logs [N]            the last lines of her logs
sara access [how]        how you reach her; change it: local | tailscale | lan | domain --domain D [--port N]
sara start | stop | restart
sara update              opens the download page
sara uninstall [--delete-data]
```

**Updating:** run a newer `Sara-Setup.exe`. The first page already has what you installed chosen. It
stops her, makes a backup (`<data>\backups`), replaces the program and starts her again; her data,
settings, how she runs and how she's reached stay as they are. An app-only install stays app-only;
choosing *Run Sara on this computer* instead turns it into a full install (the app then opens the
Sara on this computer). To go from a full install to the app only, uninstall first (her data stays).

**Uninstalling:** Settings → Apps → Sara → Uninstall (or `sara uninstall`). It stops and removes the
service (or the sign-in entry), takes her out of `tailscale serve` if it set that up (Tailscale itself
stays), and removes the program, the app, the shortcut and the `sara` command. **Her data stays**
unless you tick *Also delete her data*; then a last backup goes to your Desktop first
(`Sara-last-backup-<date>.tar.gz`, it contains her keys: keep it private). Installing again later
picks up data that was kept. Uninstalling an app-only install removes the app, its shortcut, its
settings and its sign-in on this computer; the Sara it connects to isn't touched.

**Scripted installs:** `Sara-Setup-<version>.exe /VERYSILENT /ALLUSERS` (service) or
`/CURRENTUSER` (signed-in only), plus `/ACCESS=local|tailscale|lan|domain`, `/DOMAIN=sara.example.com`,
`/PORT=7860`, `/DATA=<folder>` (`/MODE=service|user` is accepted together with the matching
`/ALLUSERS`/`/CURRENTUSER`). The token is then in `<data>\first-token.txt` until the first sign-in.
The app only: `Sara-Setup-<version>.exe /VERYSILENT /MODE=remote /SERVER=sara.example.com` (no
`/ALLUSERS`).
Silent uninstall: `unins000.exe /VERYSILENT [/DELETEDATA=1]` in the program folder.

## 2. Reach her securely (HTTPS)

The easiest way is `sudo sara access tailscale` or `sudo sara access domain --domain
sara.example.com` (section 1), which set all of this up for you. To do it by hand, or with a web
server you already run, put an HTTPS reverse proxy in front on the same server and tell Sara she is
behind it. You need a domain name pointing at the server, and ports 80 and 443
open (for example with ufw: `sudo ufw allow 80,443/tcp`; keep 7860 closed).

**Step 1 — tell Sara** (works on a fresh install and any time later; it only changes those two
settings in `/etc/sara/sara.env` and restarts her):

```sh
sudo SARA_BEHIND_PROXY=1 /opt/sara-src/deploy/install.sh
```

**Step 2 — the proxy.** Pick one.

**Caddy** (gets and renews certificates by itself):

```
sara.example.com {
    reverse_proxy 127.0.0.1:7860 {
        flush_interval -1
    }
}
```

Caddy passes live voice calls (WebSocket) through on its own.

**nginx** (certificate with certbot: `sudo apt install certbot python3-certbot-nginx`, then
`sudo certbot --nginx -d sara.example.com`):

```nginx
# once, in the http { } block (for example /etc/nginx/conf.d/websocket.conf):
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    server_name sara.example.com;
    listen 443 ssl;  # certbot adds the certificate lines
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:7860;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;          # live replies (server-sent events) arrive as they're written
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_http_version 1.1;       # live voice calls (WebSocket, /api/live/)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`client_max_body_size 20m` is enough for big documents too: the app sends files over 8 MB in 8 MB
pieces that resume after a dropped connection (Phase 74, [LIBRARY.md](LIBRARY.md#uploads-stream-to-disk)).
Raise it only if other programs send her single files bigger than 20 MB through the proxy.

**Apache** on Debian/Ubuntu (certificate with certbot: `sudo apt install certbot
python3-certbot-apache`):

```sh
sudo a2enmod proxy proxy_http proxy_wstunnel headers ssl
```

`/etc/apache2/sites-available/sara.conf`:

```apache
<VirtualHost *:80>
    ServerName sara.example.com
</VirtualHost>
<VirtualHost *:443>
    ServerName sara.example.com
    ProxyRequests Off
    ProxyPreserveHost On
    ProxyPass "/.well-known/acme-challenge/" "!"
    ProxyPass "/api/live/" "ws://127.0.0.1:7860/api/live/" timeout=3700 retry=0
    ProxyPass "/" "http://127.0.0.1:7860/" timeout=600 retry=0 flushpackets=on
    ProxyPassReverse "/" "http://127.0.0.1:7860/"
    RequestHeader set X-Forwarded-Proto "https"
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
    # certbot adds the SSLEngine/SSLCertificate lines
</VirtualHost>
```

```sh
sudo a2ensite sara && sudo systemctl reload apache2
sudo certbot --apache -d sara.example.com
```

(cPanel servers: `deploy/apache-proxy.conf` has the same lines and where they go.)

Then open `https://sara.example.com`.

## 3. First start

1. Open your address, sign in with the owner token (or, on a new server, **Set up Sara** with the
   setup code from her log: see "The first sign-in" under [Other ways to install](#other-ways-to-install)),
   read and accept the disclosure.
2. The **setup guide** opens: your name → keep Sara or make your own companion (name, she/he/they,
   relationship, vibe) → connect a model. It finds Ollama on the server by itself; otherwise paste
   an API key (OpenAI, Anthropic, xAI, OpenRouter, Ollama Cloud), point it at Ollama on another
   computer, or choose to sign in with a subscription afterwards.
3. Say hi. Everything is in Settings later: **Her** (name, personality, relationship, look,
   voice), **Models**, **You**, **Abilities**, **Connections**, **Data & health**.
4. Go through the [security checklist](SECURITY_CHECKLIST.md) (five minutes).

The native installer suggests `bubblewrap` if it is missing: with it, her shell runs in a sandbox
that can only see her workspace (`sudo apt install bubblewrap` or `sudo dnf install bubblewrap`,
then `sudo systemctl restart sara`).

### Ollama Cloud

Two ways, and both keep their model lists current by themselves (new models marked *New*, retired
ones gone; see [Choosing a model](CHOOSING_A_MODEL.md#model-lists-stay-current-by-themselves)):

- **Through an Ollama you run** (on the server or another computer): sign that Ollama in once with
  `ollama signin` on that computer. Sara then offers every Ollama Cloud model under *Ollama Cloud
  (added when you pick one)* and adds a model to that Ollama the first time you use it. Switch
  this off or on per provider in *Settings → Models → Model providers → Include all Ollama Cloud
  models*.
- **With an API key**: add the *Ollama Cloud (API key)* provider and paste a key from
  ollama.com. Its list comes straight from Ollama Cloud.

Sara checks each list once a day. Nothing is sent anywhere for this but the list request itself
(Ollama's public catalog at `https://ollama.com/v1/models` needs no key).

## 4. Optional extras

- **Phones**: step by step in [PHONE.md](PHONE.md). In short: open Sara on your phone (the web
  app works now; the iPhone and Android apps are coming soon to the App Store and Google Play),
  then in Settings → Data & health → Devices and sign-in press **Add a phone or computer** and scan
  the code: no typing the token.

| Extra | How |
|---|---|
| **Subscriptions** (ChatGPT plan, Claude Pro/Max, SuperGrok/X Premium+) | `sudo /opt/sara-src/deploy/install-agents.sh`, then Settings → Models → Subscriptions |
| **Local voice** (speech recognition + voices on your server) | `sudo /opt/sara-src/deploy/install-voice.sh` |
| **Phone app + notifications** | Open Sara on your phone → *Add to Home Screen*; Settings → Connections → Phone and notifications |
| **Telegram / Discord** | Settings → Connections → Telegram / Discord (create a bot, paste its token, link yourself) |
| **Web search** | Settings → Abilities → Web search (Brave, Tavily, Ollama or SearXNG) |
| **MCP tools** | Settings → Abilities → Other programs (MCP) ("Start from": Email or Calendar presets) |
| **Browser for testing** (she previews, clicks through and screenshots the web apps she builds) | Linux: `sudo /opt/sara-src/deploy/install-browser.sh` (~120 MB download, ~275 MB in `/opt/sara-browser`); Windows uses Microsoft Edge; macOS uses Chrome, Edge or Chromium if installed. Then restart Sara. `sara doctor` and **Run full check** also show whether it was found and how to install it |

The installers download only pinned versions and check each download against its checksum (Node.js,
the voice models and the testing browser by SHA-256 in the scripts; the subscription programs
through npm's lockfile). These extras scripts install no system packages (the one-command
installer and `sudo sara access domain` install only what's listed in section 1, after asking).

**Browser for testing (Linux).** `deploy/install-browser.sh` downloads Google's official *Chrome for
Testing* headless shell (a pinned version, checked against the SHA-256 in the script) from
`storage.googleapis.com` and unpacks it into `/opt/sara-browser`; `--remove` takes it out again.
It needs a few common system libraries (NSS, ATK, GBM, xkbcommon, ALSA); the script lists any that
are missing instead of installing them. Sara runs it inside the same bubblewrap sandbox as her
commands, with a throwaway profile, and all its traffic goes through Sara, which lets it reach only
her own previews (and public sites when web tools are on). Previews need "Allow internet access for
shell commands" on (her dev server must share the server's network to be reachable). Set
`SARA_BROWSER=/path/to/chrome` to use another Chromium-family browser.

## Demo server (optional)

A second, public copy of Sara for people to try (and for app-store review). It runs the same code
with its own data folder and port, as its own `sara-demo` user that can't read your real Sara's
data or settings. Visitors press **Try the demo**: each gets private conversations that are never
saved and disappear after a few hours, settings are read-only, adult mode is off, and there's a
daily message limit (`SARA_DEMO_DAILY`, default 300 messages a day for everyone together).

```sh
sudo /opt/sara-src/deploy/install-demo.sh        # port 7861 (or: install-demo.sh <port>); prints its token
```

Point a web address at `127.0.0.1:7861` through your proxy exactly as in step 2 (for example
`demo.sara.example.com`), then give it a model: edit `/var/lib/sara-demo/settings.json`
(providers, `defaultProviderId`, `defaultModel`, `"setupDone": true`) and run
`systemctl restart sara-demo`. Its owner token works as a reviewer sign-in. `sara update` restarts
the demo too.

**Live calls in the demo (for app review).** Calls are off in the demo unless you set a reviewer
code in `/etc/sara/sara-demo.env`: `SARA_DEMO_CALL_CODE=<a code you give App Review>`. A visitor who
taps the call button is asked for the code once (remembered for that demo session); each call lasts
up to 5 minutes, and all demo calls together get `SARA_DEMO_CALL_MINUTES_PER_DAY` minutes a day
(default 30). One demo call runs at a time. The voice comes from the demo's own Grok sign-in (your
Grok subscription's usage): sign it in once as the demo user, for example
`sudo runuser -u sara-demo -- env HOME=/var/lib/sara-demo/agents/grok /opt/sara-agents/bin/grok login`.
Restart the demo after editing the file.

## More than one person on one server (optional)

Since 2.0 the owner can invite other adults (a partner, a flatmate, a grown-up child) to use the
same server, each with their own companions and a private space the owner can't read: **Settings →
Household → People on this server**. Nothing to install; the owner chooses which models each person
may use and a daily limit. Not on the demo server. See [HOUSEHOLD.md](HOUSEHOLD.md). For complete
separation (each with their own owner and server settings), use several Saras instead, below.

## Several Saras on one server (optional)

For a family, a small team or a hosting provider: several separate Saras on one Linux server, each
with her own owner, data, settings, port, service and admin command. Nothing is shared between them
except the server itself (and, if you use them, Tailscale, Caddy, local voice and the subscription
programs). One install, as described above, is still the normal case and works exactly as before.

Give each extra Sara a name (2 to 32 lowercase letters, digits or dashes, starting with a letter,
for example `work`):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash -s -- --instance work
# or, from the copy you already have:
sudo /opt/sara-src/deploy/install.sh --instance work            # add --port N to choose the port
/opt/sara-src/deploy/install.sh --dry-run --instance work       # only shows what it would create
```

Everything follows from the name:

| | First Sara | Sara called `work` |
|---|---|---|
| Admin command | `sudo sara …` | `sudo work …` |
| Service | `sara` | `work` |
| Program | `/opt/sara` | `/opt/work` |
| Data and backups | `/var/lib/sara` | `/var/lib/work` |
| Settings | `/etc/sara/sara.env` | `/etc/work/work.env` |
| Port | 7860 | the next free one (7861, 7862, …) |

The installer refuses a name that is already someone's account or a program on the server, and a
port that is in use or belongs to another Sara. `sudo sara instances` lists every Sara with her port
and whether she's running. Running the installer again for a name that exists keeps her data,
settings and port.

**Reaching each one.** Each Sara has her own `sudo <name> access`:

- **Your own web address:** give each her own address (`sara.example.com`, `work.example.com`). Each
  gets her own block in the Caddyfile; changing one never touches the others. With Apache or nginx,
  add one site per address and point it at that Sara's port.
- **Tailscale:** the server has one Tailscale name, so the first Sara uses `https://<name>` and the
  others get their own HTTPS port on it (`https://<name>:8443` and up; `sudo work access` shows it).
- **Just this computer / home network:** each on her own port.

**Updates and backups.** `sudo work update` backs up, updates and restarts only `work`; the other Saras keep running and get their update when you update them. Each
Sara makes her own daily backups in her own data folder; `sudo work backup` backs up now. The source
copy in `/opt/sara-src` is shared. Local voice and the subscription programs are downloaded once for
the whole server; to turn them on for another Sara, run their installer for her (it reuses what is
already there): `sudo /opt/sara-src/deploy/install-voice.sh --instance work` or
`sudo /opt/sara-src/deploy/install-agents.sh --instance work`.

**Ollama on a shared server.** Every Sara here talks to the same Ollama. If that Ollama is signed in
to ollama.com, its cloud models run on that account and are billed to it, so they are **off** for
every Sara except the first one (Settings → Models → the Ollama provider → *Use Ollama Cloud
models*). Leave it off for Saras you host for other people, and give them their own models (their own
Ollama, or a cloud key of their own).

**Removing one.** `sudo work uninstall` removes only that Sara (her data stays in `/var/lib/work`
unless you add `--delete-data`). The other Saras are left as they are.

## 5. Keeping her healthy

```sh
sudo sara status            # running? data size, last backup
sudo sara doctor            # deeper checks: database, testing browser, every model provider, backups, off-server copy
sudo sara update            # backs up first, pulls, reinstalls, restarts, checks health (rolls back if it fails)
sudo sara check-updates     # is there a newer version?
sudo sara backup [file]     # back up now
sudo sara restore <file>    # stop, restore (current data is kept aside), start; .enc copies ask for the passphrase
sudo sara reset-token       # new owner token (signs out every browser)
sudo sara logs -f           # follow the log
sudo sara access [how]      # how you reach her (tailscale, local, domain, lan)
```

Or from the app: **Settings → Data & health → Updates** (same steps, done by the root-owned
`sara-updater` helper that `install.sh` sets up; Sara herself never gets admin rights).

Backups run daily (the last 7 are kept) in `/var/lib/sara/backups`. **They contain your keys.**
Settings → Data & health → Backups → *Off-server copy* puts an encrypted copy (your passphrase, AES-256-GCM)
of each daily backup in a folder (e.g. a mounted drive) or S3-compatible storage (Backblaze B2,
Cloudflare R2, AWS S3, Wasabi). Keep the passphrase in your password manager: without it the copies
can't be opened. Settings → Data & health → Health shows the model, disk space, backups, memory, sandbox,
bridges and MCP servers at a glance; *Run full check* is the same as `sara doctor` and also reports
whether the testing browser was found and how to install it when it is missing.

## Upgrading

**Native install:** `sudo sara update`, or Settings → Data & health → Updates. Every update:

1. makes a backup (in `/var/lib/sara/backups`),
2. gets the new version and reinstalls it (your data and `sara.env` are not touched),
3. restarts her and checks that she answers,
4. puts the previous version back by itself if she doesn't.

Upgrading from any older 0.x straight to the newest works: her database is brought up to date on
the first start (tested from 0.26 and 0.30 to the latest, with conversations, memories, tasks,
reminders and settings all kept). There's nothing to do in between. That includes going from 0.x
to 1.0: update as usual.

**Which versions get fixes:** only the latest release. There are no long-term branches, so keep
her updated (`sudo sara check-updates` tells you when there's something new). The full policy is
in [SECURITY.md](../SECURITY.md#supported-versions).

To go back by hand: `sudo sara restore /var/lib/sara/backups/<the backup from before the update>`
restores the data; `cd /opt/sara-src && sudo git checkout <older tag> && sudo ./deploy/install.sh`
restores the code.

**Docker:** `cd /opt/sara-src && sudo git pull && sudo docker compose up -d --build`. Take a backup
first (`sudo docker compose exec sara node src/main.ts --backup`), see the Docker section above.

**What she keeps where** (all in `/var/lib/sara`, or the `sara-data` volume): `sara.db` (conversations,
memories, plans), `secrets.enc` and `master.key` (your keys, encrypted; the key file opens them),
`settings.json`, `persona.json`, `library/`, `uploads/`, `workspaces/`, `backups/`. A backup holds all
of it; `node_modules` and similar rebuildable folders in workspaces are left out.

## Configuration reference

`/etc/sara/sara.env` (restart after editing: `sudo systemctl restart sara`):

| Variable | Default | Purpose |
|---|---|---|
| `SARA_HOST` / `SARA_PORT` | `127.0.0.1` / `7860` | Listen address. Keep `127.0.0.1`: `0.0.0.0` serves plain HTTP (your sign-in included) to the whole network. (`sara access lan` sets `0.0.0.0` for you on purpose) |
| `SARA_ACCESS` / `SARA_PUBLIC_URL` | (none) | How she's reached (`local`, `tailscale`, `domain`, `lan`) and her address; written by the installer and `sara access` |
| `SARA_SECURE_COOKIES` | `0` | `1` behind HTTPS |
| `SARA_TRUST_PROXY` | `0` | `1` behind a reverse proxy on this machine |
| `SARA_SETUP` | `code` | First sign-in in the browser on a new server: `code` (the setup code from her log), `browser` (no code; **only** behind a proxy that makes people sign in first, as Umbrel's does), `off` (owner token only) |
| `SARA_SETUP_MINUTES` | `60` | How long after each start browser setup stays open on a server nobody has signed in to yet (5–1440) |
| `SARA_DATA` | `/var/lib/sara` | Data directory |
| `SARA_MASTER_KEY` | file in data dir | 32-byte base64 key for the secret vault |
| `SARA_SANDBOX` | `auto` | `bwrap` (recommended), `seatbelt` (macOS), `none` |
| `SARA_VOICE_DIR` | `/opt/sara-voice` | Set by `install-voice.sh` |
| `SARA_AGENTS_DIR` | `/opt/sara-agents` | Set by `install-agents.sh` |
| `SARA_CLAUDE_BIN` / `SARA_GROK_BIN` | (found on the PATH) | Where the Claude Code / Grok program is, if not in `SARA_AGENTS_DIR` or on the PATH |
| `SARA_BROWSER` | (found by itself) | Path to a Chromium-family browser for testing previews |
| `SARA_REPORT_TO` | the developer's report inbox | Where a reply you report with ⚑ is also sent (`https://sara.backstagecoding.com/api/public/report`). `off` = never send reports anywhere; they stay on your server |
| `SARA_PRIVATE_LOCAL` | unset | Phase 67: `1` = *Nothing leaves this computer* is always on (can't be turned off in the app); `start` = on until the owner turns it off in Settings → Models → On this computer. Only this computer (`127.0.0.1`, `::1`, `localhost`) is reached. See [PRIVATE_LOCAL.md](PRIVATE_LOCAL.md) |
| `SARA_PERSONA` | `persona/sara.json` | The character file a new install starts from |
| `SARA_BACKUP_PASSPHRASE` | (none) | Passphrase for restoring an encrypted `.enc` off-server copy without being asked (Docker, Mac) |
| `SARA_TOOLS_USER` | (none; `sara-tools` in Docker) | A separate user her commands run as when there's no bubblewrap (set by the Docker image) |
| `SARA_LOG_FORMAT` | `text` | How her log lines look on the console (the journal, `docker logs`): `text` (the message, as always) or `json` (one JSON object per line: `t`, `level`, `msg`). See [Logs](#logs) |
| `SARA_LOG_LEVEL` | `info` | Quietest lines kept: `debug`, `info`, `warn` or `error`. Applies to the console and every log file |
| `SARA_LOG_FILE` / `SARA_LOG_MAX_MB` / `SARA_LOG_KEEP` | (none) / `10` / `5` | An extra log file (in `SARA_LOG_FORMAT`), rotated by Sara herself when it reaches the size, keeping that many older files (`.1` newest) |
| `SARA_DEMO` / `SARA_DEMO_DAILY` | (off) / `300` | Demo server mode and its daily message limit (set by `install-demo.sh`) |
| `SARA_DEMO_CALL_CODE` / `SARA_DEMO_CALL_MINUTES_PER_DAY` | (off) / `30` | Demo: reviewer code that unlocks live calls (unset = no calls in the demo), and call minutes a day for everyone |

Installer-only (read by `deploy/install.sh`, not by Sara): `SARA_USE_SYSTEM_NODE=1` (use a system
Node.js 24+ instead of her own) and `SARA_BEHIND_PROXY=1` (sets `SARA_SECURE_COOKIES` and
`SARA_TRUST_PROXY` for an HTTPS proxy, see section 2).

### Windows and macOS (server)

The server also runs on Windows 10/11 and macOS (Apple silicon and Intel); the installers for those
systems set it up together with the desktop app. What differs from Linux:

- **Commands she runs:** macOS uses the system's own sandbox (`sandbox-exec`): only the workspace is
  writable, and your whole home folder (documents, photos, mail, keys) and her data folder are
  hidden. Windows has no
  sandbox, so the shell and background-job tools ask you before every command (you can still set a
  tool to *Allowed* in Settings → Abilities → Tools and approvals).
- **Updates:** Settings → Data & health → Updates checks the newest release and links its download
  page; running the new installer updates Sara in place.
- **Local voice** (piper/whisper) is Linux only for now: use Grok or OpenAI voice.
- **Windows:** see [Windows: one installer](#windows-one-installer-for-her-server-and-the-app) above.
- **Installer variables:** `SARA_DATA` (data folder), `SARA_PORT`, `SARA_ACCESS` (`local`,
  `tailscale`, `domain` or `lan`) and `SARA_PUBLIC_URL` (the address to open on a phone; shown with a
  QR code in Settings → Data & health → Health), `SARA_INSTALLED=1` (admin hints then say `sara …`).
- **Admin flags** (wrapped by the `sara` command): `node src/main.ts --version`, `--status`,
  `--doctor`, `--backup [file]` (add `--no-workspaces` to leave her coding workspaces out),
  `--restore <file>`, `--reset-token`, and `--tailscale-status` (JSON: installed, running, DNS name,
  HTTPS address). There is no `--help`: any flag not listed here (including `--help`) starts the
  server instead, so stick to these.

### Mac

Only the app, for a Sara on another computer or server? Step-by-step guide to hand to someone:
[MAC_APP_REMOTE.md](MAC_APP_REMOTE.md).

One download, `Sara-<version>.dmg`, holds the Sara app with her server and its own Node inside
(Apple silicon and Intel, signed and notarized). macOS 13 or newer; no administrator rights are
needed.

1. Open the DMG and drag **Sara** onto **Applications**, then open Sara from Applications. (Opened
   straight from the DMG, she offers to move herself first.)
2. **How do you want to use Sara?** *Run Sara on this Mac* (her server runs on this Mac while you're
   signed in) or *Connect to a Sara somewhere else* (type the address of a Sara on another computer
   or server, then sign in with a code from Settings → Data & health → Devices and sign-in → *Add a
   phone or computer*). *Run Sara on this Mac* asks two things, with the usual answers already picked (if
   Sara's switch under System Settings → General → **Login Items** → *Allow in the Background* is
   off, the app opens it: turn on **Sara**):
   - **How you'll reach her.** *Tailscale* is suggested when Tailscale is installed and signed in on
     the Mac: Sara shares herself on your tailnet with HTTPS (`tailscale serve`) and shows the
     address. If your tailnet hasn't got HTTPS certificates yet, turn them on once at
     https://login.tailscale.com/admin/dns. Otherwise *Just this Mac*. *My home network* lets phones
     at home open her over plain HTTP (anyone on that network could read it; your Mac may ask whether
     "node" may accept incoming connections). *My own web address* needs a domain, HTTPS and port
     forwarding: the app opens [section 2](#2-reach-her-securely-https) and sets her up for this
     Mac until then.
   - **Port**, 7860 unless something else uses it (the sheet checks).
   Or choose **Connect to a Sara somewhere else instead**.
3. Sara shows your **owner key** once, with *Copy*: keep it in a password manager. Then she opens
   her sign-in page in the app; paste the key. (The Mac app calls the owner token the **owner
   key**: they are the same thing.) On a Mac, commands she runs are kept in a sandbox
   (`sandbox-exec`): they can change files only in her workspace, and can't see her data or your
   home folder (documents, photos, mail, keychains, SSH keys).

Where things are: her data in `~/Library/Application Support/Sara` (yours, not root's), her logs in
its `logs` folder (`sara.log`; `service.log` for starts and stops), this Mac's settings in
`service/server.env`. launchd runs her through the app (`SMAppService`) as a LaunchAgent, while you're
signed in; Sara never runs as root. (Versions before 0.55 could also start her "from startup" as a
LaunchDaemon; that option was removed, and updating moves such a Mac to the agent by itself.)

**Menu bar → Sara on this Mac:** status and address, *Stop / Start*, *Back up now*, *Open data
folder*, *Change how you reach her…*, *New owner key…*, *Install command line tool…*, *Connect to a
Sara somewhere else instead…* (she stops here; her data stays in `~/Library/Application
Support/Sara` until `sara uninstall --delete-data`) and *Uninstall…*. Connected to a Sara somewhere
else, it has *Set up Sara on this Mac…* instead. The saved servers and *Add a Sara…* are in *Your
Saras* next to it (docs/desktop.md → The menus). The command line tool is `~/.local/bin/sara` (no sudo): `sara status`,
`version`, `doctor`, `logs [N]`, `backup [file]`, `restore <file>`, `reset-token`, `token` (shows the
one-time owner key if it hasn't been used yet), `access tailscale|local|lan`, `stop`, `start`,
`setup [--access …] [--port N]`, `uninstall [--delete-data]`. On a Mac,
`restore` doesn't ask for a passphrase: for an encrypted `.enc` copy, set it first
(`read -rs SARA_BACKUP_PASSPHRASE; export SARA_BACKUP_PASSPHRASE`).

**Upgrading:** drag the new Sara onto Applications (Replace) and open it. She makes a backup
in her `backups` folder (`before-<version>-….tar.gz`), then runs the new version with the same data
and settings.

**Uninstalling:** *Sara on this Mac → Uninstall…* stops her, removes her from Login Items and removes her
Tailscale address if she set one. A last backup goes to your Desktop first. Her data stays (set her
up again and she remembers everything) unless you tick *Also delete her data*. Then drag Sara to the
Trash.

## Logs

Sara saves a copy of its console output at `<data>/logs/sara.log` (for a systemd installation, `<data>` is `/var/lib/sara`). Each line is a JSON object with a timestamp, level and message. When the log exceeds 5 MB, Sara rotates it and keeps up to five older files (`sara.log.1` through `sara.log.5`). Settings → Data & health shows recent problems from it and offers it as a download.

On a systemd installation, you can also check the service journal with `sudo journalctl -u sara`. For recent startup problems, `sudo sara logs` is the simplest place to start. Logs may contain information about your setup, so check them before sharing.

**What is never in her logs:** your messages and her replies, memories, documents and tool output are not logged. Every line, on the console and in every log file, first has your saved keys and anything shaped like a key or token replaced (`[REDACTED]`, `[hidden]`). The owner token and the setup code are printed once at start-up straight to the console (so on a server they are in the journal or `docker logs`), never into `sara.log` or `SARA_LOG_FILE`. See [PRIVACY.md](PRIVACY.md#her-logs).

**Options for servers** (set them in `/etc/sara/sara.env`, the Docker Compose `environment:`, or the environment you start her with; restart her after a change):

| Setting | What it does |
|---|---|
| `SARA_LOG_FORMAT=json` | The console gets one JSON object per line (`{"t":"…","level":"warn","msg":"…"}`) for log collectors (Loki, Vector, Datadog, `jq`). Default `text`: the message as before (journald and Docker add their own timestamps) |
| `SARA_LOG_LEVEL=warn` | Leaves out quieter lines everywhere. `debug` shows extra detail, `info` is the default, `error` only failures |
| `SARA_LOG_FILE=/var/log/sara/sara.log` | Also writes every line to this file (text lines with a timestamp and level, or JSON with `SARA_LOG_FORMAT=json`). Sara rotates it herself: at `SARA_LOG_MAX_MB` (default 10) it becomes `sara.log.1`, older ones move up to `SARA_LOG_KEEP` (default 5) and the oldest is deleted. The folder must be writable by her user (`sudo mkdir /var/log/sara && sudo chown sara /var/log/sara`) |

- **systemd (Linux):** the console goes to the journal, which rotates and limits itself (`journalctl --disk-usage`; limits in `/etc/systemd/journald.conf`, `SystemMaxUse=`). Nothing else is needed; `SARA_LOG_FORMAT=json` makes `journalctl -u sara -o cat | jq` work.
- **Docker:** logs stay on the console (`docker compose logs sara`). Limit their size with Docker's own log options, for example `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }` under the `sara` service. `SARA_LOG_FILE` is rarely needed in a container; if you use it, put it inside `/data`.
- **Windows and macOS:** the service already writes `<data>/logs/sara.log` (and `service.log` on Windows); the options above work there too.

## Troubleshooting

- **"Sara is NOT answering"**: `sudo sara logs` shows why; most often a port clash or a bad edit in
  `/etc/sara/sara.env`.
- **Can't open it from my computer**: `sudo sara access` shows how she's reached. With "just this
  computer", use the SSH tunnel (section 1), or switch: `sudo sara access tailscale`.
- **Tailscale address doesn't open**: the device you open it on must be signed in to the same
  Tailscale account, and HTTPS certificates must be on for your tailnet
  (https://login.tailscale.com/admin/dns → Enable HTTPS). Then `sudo sara access tailscale` again.
- **Own web address: no certificate**: the address must point at this server and ports 80 and 443
  must be open; `sudo journalctl -u caddy -n 50` shows why Caddy couldn't get one.
- **Replies arrive all at once**: your proxy buffers responses; turn buffering off (see above).
- **Signed in, but thrown out again right away (behind HTTPS)**: Sara doesn't know she's behind a
  proxy. Run `sudo SARA_BEHIND_PROXY=1 /opt/sara-src/deploy/install.sh`.
- **Settings → Data & health → Updates says it can't update / `git` "dubious ownership"**: the checkout isn't
  root's. Move it: `sudo mv ~/sara /opt/sara-src && sudo chown -R root:root /opt/sara-src && sudo
  /opt/sara-src/deploy/install.sh`.
- **Tool sandbox says `none`**: install `bubblewrap` (`apt install bubblewrap` / `dnf install
  bubblewrap`), then `sudo systemctl restart sara`. Without it she asks you before every command,
  and hand-off to Claude Code / Grok Build is unavailable.
- **Ubuntu 24.04: bubblewrap installed but the sandbox still fails** ("setting up uid map:
  Permission denied"): Ubuntu's AppArmor blocks unprivileged user namespaces unless a program has
  a profile allowing them. The narrow fix is a profile for bubblewrap only:

  ```sh
  sudo tee /etc/apparmor.d/bwrap <<'EOF'
  abi <abi/4.0>,
  include <tunables/global>
  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  EOF
  sudo apparmor_parser -r /etc/apparmor.d/bwrap && sudo systemctl restart sara
  ```

  (The blunt alternative, `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, turns the
  restriction off for every program on the server, which gives up a kernel attack-surface
  protection; prefer the profile.)
- **"This system isn't running systemd"**: the native install needs systemd as the init system
  (it isn't in most containers). Use Docker Compose.
- **"Couldn't download Node.js"**: the server can't reach nodejs.org (check its internet
  connection, DNS and any outgoing firewall), then run the installer again.
- **Notifications don't arrive on iPhone**: they only work from the Home Screen app (iOS 16.4+).

### Troubleshooting on Windows

Open a terminal (for a service install, *Run as administrator*) and start with `sara status`.

- **She doesn't start, or the address doesn't open**: `sara logs` shows the last lines of her logs.
  The files are in her data folder's `logs` folder (`sara.log`, and `service.log` for starts and
  stops): `C:\ProgramData\Sara\logs` for a service install, `%LOCALAPPDATA%\Sara\data\logs` for
  "only while I'm signed in". `sara restart` tries again.
- **The port is in use**: the installer picks the next free port when 7860 is taken, so check the
  address `sara status` prints. To move her, repeat how you reach her with a new port, for example
  `sara access tailscale --port 7870` (or `local`, `lan`).
- **The service won't start**: open *Services* (`services.msc`), find **Sara** and look at its
  status; `sara logs` usually says why (a damaged settings file names your newest backup). Running
  the installer again repairs the program and keeps the data.
- **Lost the owner token**: `sara reset-token` makes a new one and restarts her (every browser is
  signed out). After a silent install the first token is in `<data>\first-token.txt` until the
  first sign-in.
- **Tailscale address doesn't open**: the device must be signed in to the same Tailscale account,
  and HTTPS certificates must be on (https://login.tailscale.com/admin/dns → **Enable HTTPS**).
  Then `sara access tailscale` again.
- **Phones at home can't reach her ("My home network")**: as a service the installer adds a
  Windows Firewall rule for private networks; in signed-in mode, Windows asked once whether to
  allow Node.js. If you pressed Cancel, allow it in *Windows Security → Firewall & network
  protection → Allow an app through firewall*, private networks only. Your Wi-Fi must be set to
  *Private* in Windows.
- **"Windows protected your PC"** when installing: the installer isn't code-signed yet; choose
  **More info → Run anyway**.

### Troubleshooting on macOS

Install the command line tool from the menu bar (*Sara on this Mac → Install command line tool…*), open
Terminal and start with `sara status`.

- **She doesn't start, or the address doesn't open**: `sara logs` shows the last lines of
  `~/Library/Application Support/Sara/logs/sara.log` and `service.log`. *Sara on this Mac → Stop /
  Start* in the menu bar (or `sara stop` then `sara start`) tries again.
- **She doesn't start after setup ("waiting for your OK")**: turn on **Sara** in System Settings →
  General → **Login Items** → *Allow in the Background*.
- **The port is in use**: pick another port in *Sara on this Mac → Change how you reach her…* (the
  sheet checks that it's free).
- **Lost the owner key** (the owner token): `sara token` shows it if it was never used; otherwise
  `sara reset-token` (or *New owner key…* in the menu bar) makes a new one and signs every browser
  out.
- **Tailscale address doesn't open**: same as on Linux and Windows: same Tailscale account on the
  device, and HTTPS on at https://login.tailscale.com/admin/dns. Then `sara access tailscale`.
- **Phones at home can't reach her**: when macOS asked whether "node" may accept incoming
  connections, it needs **Allow**. Check System Settings → Network → Firewall → Options.
- **A command she runs fails with "Operation not permitted"**: that's the sandbox doing its job (she
  can only change files in her workspace and can't see your home folder). Put the files she needs
  in her workspace.

## Other ways to install

Maintainers: see [PACKAGING.md](PACKAGING.md) for how each one is made and submitted.

**Available now:**

- **Docker image:** `docker pull ghcr.io/farena-ai/sara:latest`, the same image the Docker Compose
  file above builds, for linux/amd64 and linux/arm64 (Raspberry Pi 4/5, Apple-silicon and other
  ARM servers) since 1.1.0.
- **Homebrew** (Mac): `brew install --cask farena-ai/tap/sara` (the app, signed and notarized).
- **TrueNAS SCALE** (24.10 and newer): *Apps → Discover Apps → ⋮ → Install via YAML* with
  `packaging/truenas/docker-compose.yml` (see `packaging/truenas/README.md`).
- **Proxmox VE:** a helper script that makes a Debian 12 container with Sara in it, run on the
  Proxmox host: `bash -c "$(curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/packaging/proxmox/sara.sh)"`
  (checked for syntax; not yet run on a Proxmox host, see its README).
- **Home Assistant integration** through HACS: *HACS → ⋮ → Custom repositories*, add
  `https://github.com/farena-ai/sara-home-assistant` as an *Integration*, then install **Sara**. Or by hand:
  copy `integrations/home-assistant/custom_components/sara` (see [HOME_ASSISTANT.md](HOME_ASSISTANT.md)).

**Waiting for review** (submitted and passing each store's own checks; listed here as available
once accepted):

- **winget** (Windows): `winget install BackstageCoding.Sara` (installs for you, without an
  administrator; run the installer yourself for a Windows service).
- **CasaOS / ZimaOS:** *Sara* in the App Store.
- **Umbrel:** *Sara* in the Umbrel App Store.
- **Unraid:** *Sara* in Community Applications (template: `farena-ai/unraid-templates`); approved,
  and it appears once Community Applications next refreshes its list.
- **HACS store:** Sara in HACS's own list, so the custom-repository step isn't needed.

**The first sign-in** works the same way for every container install (Docker, TrueNAS, Unraid,
CasaOS, Proxmox's container): open her address within an hour of the first start and Sara offers
**Set up Sara**. Type the 8-character **setup code** from her log (the app's log view in your
dashboard; look for "setup code"), and she shows your owner token once to save. On Umbrel there is
no code: Umbrel's own login already checked it's you, so it's one click. The setup code is new at
every start, works only until someone has signed in, and only from this machine or your home
network; missed the hour, restart the app for a new one. The owner token from the log works too, as
before. Why this is safe: [THREAT_MODEL.md](THREAT_MODEL.md), "First sign-in in the browser".

## Linux hands (desktop computer, CU8 draft)

Use your desktop user's visible terminal, Node 24 and an installed Chrome/Chromium:

```sh
sara hands --server https://sara.example.com
# A checkout also works without the admin wrapper:
node desktop/linux/cli.ts --server https://sara.example.com
```

Do not use sudo. Approve browser use locally and the displayed code in the signed-in `/device`
page, with fresh identity confirmation. This is browser mode; Linux whole-screen capture/input,
global hotkeys and keep-awake are unavailable. `--checks` offers a separate read-only system check-up
opt-in. Keep the terminal visible; `stop` or Ctrl+C stops and disconnects. See [Linux hands in the
desktop guide](desktop.md#linux-hands-cu8-implementation-draft) for storage warnings, saved logins,
optional manager CLIs, restrictions, and the remaining Ubuntu X11/Wayland acceptance checks.
