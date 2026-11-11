# What you may need to do yourself

Sara's installers and apps do almost everything for you. These are the few things they can't do,
because they need your accounts, your permission on the computer, or an administrator on a server.
Each one says when it applies, so skip anything that isn't you.

## Everyone

| When | What to do |
|---|---|
| First start | Pick her AI service in setup. A cloud service needs a key: setup links to the page where you get it. A local model (Ollama) needs nothing else. |
| Using Sara from your phone or away from home | Install **Tailscale** (free) on this computer and on your phone, and sign in to both with the same account. Then Settings → Devices and sign-in → **Use Sara away from home** checks the rest. If it says HTTPS is off, open https://login.tailscale.com/admin/dns and turn on **HTTPS Certificates** once. More: [AWAY_FROM_HOME.md](AWAY_FROM_HOME.md). |
| Connecting email | Gmail, Yahoo, iCloud, AOL and most others: make an **app password** in your email account (the Email page shows the steps), then press **Check it**. Outlook.com: 3 steps to register a free sign-in in your Microsoft account; the Email page walks you through it. More: [EMAIL.md](EMAIL.md). |

## Windows

| When | What to do |
|---|---|
| Installing | The installer isn't code-signed yet, so Windows may say "Windows protected your PC". Click **More info → Run anyway**. |
| Letting Sara use this computer | In the Sara app: Settings → **Computer use** → switch on **Let Sara use this computer**. If Sara runs on another computer or a server, approve the request there when it asks. |

## Mac

| When | What to do |
|---|---|
| Running Sara on this Mac | If macOS asks, turn on **Sara** under System Settings → General → Login Items → *Allow in the Background*. |
| Letting Sara use this Mac | Allow **Sara** under System Settings → Privacy & Security → **Screen Recording** and **Accessibility** (and Input Monitoring if asked), then quit and reopen Sara. |

## Linux server (you run your own server)

| When | What to do |
|---|---|
| Your own web server (Apache, nginx, cPanel) sits in front of Sara | Let WebSockets through, or voice calls and the Windows/Mac app's computer use can't connect. **Apache 2.4.47+:** add `upgrade=websocket` to the end of the `ProxyPass "/" "http://127.0.0.1:7860/" …` line. **cPanel:** that line lives in your include under `/etc/apache2/conf.d/userdata/ssl/2_4/<user>/<domain>/`; then run `/scripts/rebuildhttpdconf && systemctl reload httpd`. **nginx:** add the `Upgrade` and `Connection` lines from [INSTALL.md](INSTALL.md#2-reach-her-securely-https). Caddy and `tailscale serve` already do this. |
| The browser add-on's card says **Needs your server admin** | Sara usually fetches what her browser needs by herself. If she can't, the card shows the exact command with a Copy button, for example `sudo dnf install -y alsa-lib at-spi2-atk at-spi2-core mesa-libgbm` (AlmaLinux/RHEL) or `sudo apt-get install -y libasound2 libatk-bridge2.0-0 libatspi2.0-0 libgbm1` (Debian/Ubuntu). More: [BROWSER.md](BROWSER.md). |
| An add-on says it needs a newer **Python** | Only if an add-on you use asks for it. Install a newer Python *next to* the system one (`sudo dnf install -y python3.12` on AlmaLinux/RHEL 8). Never replace or remove the system `python3`: the system and cPanel depend on it. |
| Sara asks for **bubblewrap** (the safe box her tools run in) | `sudo dnf install -y bubblewrap` or `sudo apt-get install -y bubblewrap`. The one-command installer offers this for you. |
| Docker | The image doesn't include the browser's libraries. To use the browser add-on, build a small image on top of Sara's with the `apt-get` line above. More: [BROWSER.md](BROWSER.md#docker-image). |

Everything else (updates, backups, her browser, her own Node) Sara handles by herself. If a screen
ever asks you for something that isn't on this page, that's a bug: tell us on GitHub.
