# The browser Sara uses

Sara uses a web browser in two places:

- **Her own browser tools** (`browser_open`, `browser_click`, `browser_screenshot`, …): she opens the
  web apps she builds (and public pages when web tools are on), clicks through them and takes
  pictures. Each conversation gets a throwaway profile; all traffic goes through Sara's guard.
- **The Browser (Playwright) add-on** from the Sara Store: Microsoft's Playwright tool server
  (`@playwright/mcp`, pinned version), for coders who want Playwright's tools.

Both use **one browser**, and nobody has to install anything for it.

## Where the browser comes from

| Where Sara runs | Browser |
|---|---|
| Windows | Microsoft Edge (or Google Chrome) already on the computer. Neither there: Sara downloads one. |
| Mac | Google Chrome, Microsoft Edge or Chromium in Applications. None there: Sara downloads one. |
| Linux server or desktop | Sara downloads one (an administrator's `/opt/sara-browser` or `SARA_BROWSER` is used first when present). |

"Sara downloads one" means: the first time it is needed (adding the Browser add-on, *Get it now* on
its card, or her first `browser_open`), Sara runs **her own** Node's `npx` with the exact Playwright
version the add-on pins (`playwright-core@1.65.0-alpha-2026-10-30`, matching
`@playwright/mcp@0.0.84`) to fetch Playwright's **Chromium headless shell** into her data folder:

```
<SARA_DATA>/cache/browsers/            (PLAYWRIGHT_BROWSERS_PATH)
  chromium_headless_shell-<build>/     about 280 MB on disk, about 110 MB download
  status.json                          what the card shows
  libs/root/usr/lib64/                 Linux only, when Sara had to fetch libraries (below)
```

It is in `cache/`, so backups leave it out; deleting the folder is safe (Sara downloads it again when
needed). The download comes from Playwright's own servers (`cdn.playwright.dev`, falling back to
`playwright.download.prss.microsoft.com`), with npm for the `playwright-core` package. It never uses or needs a system Node: Sara's own Node runs it, and the
add-on's `npx` also runs on Sara's Node, so the add-on card's "It needs: node" is always met.

After the download Sara checks it:

1. **Linux: libraries.** `ldd` on the browser lists any shared library the system lacks.
2. **A launch test.** Sara starts it headless with a throwaway profile, opens `about:blank` over the
   DevTools protocol and takes a picture. It first tries with Chrome's own sandbox; only on Linux,
   and only if that fails (a service user that may not create user namespaces), it tries again with
   `--no-sandbox` and says so on the card. Both consumers already fence it: Sara's own browser runs
   inside bubblewrap like her commands, and the add-on runs inside its tool-server fence (Playwright
   itself starts Chromium without Chrome's sandbox by default).

## When a Linux server lacks libraries

The headless shell needs fewer libraries than Google Chrome (no GTK), but a bare server can still
miss a few. On a stock AlmaLinux 8 cPanel server these four are missing:

```
libasound.so.2  libatk-bridge-2.0.so.0  libatspi.so.0  libgbm.so.1   (and libgbm's libwayland-server.so.0)
```

Sara first tries to get them **without root and without changing the system**: on dnf/yum systems
(RHEL, AlmaLinux, Rocky, CentOS, Fedora) she runs `dnf download` from the distribution's own
repositories only (baseos, appstream, powertools/crb, fedora/updates; never third-party or cPanel
repositories), checks each package's signature against the system's keys (`rpm -K`), unpacks the
libraries into `cache/browsers/libs/root` (about 3 MB) and points the browser at them with
`LD_LIBRARY_PATH`. Nothing is installed on the system.

Only when that is not possible (Debian/Ubuntu, where `apt-get download` needs package lists only
root can refresh, or no network to the repositories) the card says **Needs your server admin** with
the exact command for this system and a copy button, for example:

```
sudo dnf install -y alsa-lib at-spi2-atk at-spi2-core mesa-libgbm
sudo apt-get install -y libasound2 libatk-bridge2.0-0 libatspi2.0-0 libgbm1
```

Then *Try again*. Sara never runs package managers with root for this.

## The card

The Browser add-on's Store page and its *Add* card, and *Settings → Add-ons → Other programs*, show
one status card:

| State | Card |
|---|---|
| Ready | "Ready: it uses Microsoft Edge on this computer." or "Ready: Sara downloaded the browser into her own folder and it passed a test." |
| Downloading | progress bar with percent, then "Checking what the browser needs…", "Testing the browser…" |
| Needs your server admin | the missing libraries and the one command, with *Copy*, then *Try again* |
| Not supported on this system | why: an unsupported OS or processor, or a musl Linux (Alpine) |
| Not downloaded yet | *Get it now* |

Private local mode ("Nothing leaves this computer") is respected: Sara does not download it while
it is on and the card says so.

`GET /api/prereqs/browser` returns the status; `POST /api/prereqs/browser` starts the download or
the check again (owner only, audited as `prereq.browser`).

## How the add-on is pointed at it

When Sara starts the Playwright tool server she adds, unless the owner's own arguments already
choose a browser (`--browser`, `--executable-path`, `--cdp-endpoint`, `--extension`):

- with the downloaded browser: `--browser chromium --executable-path <shell> --headless`, the
  `PLAYWRIGHT_BROWSERS_PATH` folder (read-only inside bubblewrap) and `LD_LIBRARY_PATH` when Sara
  fetched libraries;
- with Edge/Chrome on a desktop: `--browser msedge` or `--browser chrome`;
- always `--isolated` (a fresh in-memory profile each time) unless the owner set a profile.

The signed Store recipe still lists `app:Google Chrome` (older Saras need it); Saras with this change hide that requirement and the old "install Chrome there first" note because
they get the browser themselves.

## Docker image

The Docker image (`node:24-slim`, Debian) does not ship the browser's libraries (NSS, ATK, GBM,
ALSA, X11 client libraries), and `apt-get download` cannot run there without root. In a container
the card therefore says *Needs your server admin* with the `apt-get` line; installed in a running
container it is lost when the container is recreated. Neither Sara's own browser tools nor the
add-on have a browser there until the libraries are in the image. To use them, build an image
`FROM` Sara's with
`RUN apt-get update && apt-get install -y --no-install-recommends libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libgbm1 libxkbcommon0 libasound2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libdrm2 && rm -rf /var/lib/apt/lists/*`.
Even then, in the container the add-on runs as the separate tools user, which cannot read Sara's
data folder, so it does not see the downloaded browser; Sara's own browser tools do.

## Checked

- Windows 11: one click on *Add and start* → download (about 10 s here) → test → Ready; the add-on
  started with 25 tools and a scripted model opened a local page and read it through
  `browser_navigate` + `browser_snapshot`.
- AlmaLinux 8.10 (cPanel, glibc 2.28) as an unprivileged user under the same systemd hardening as
  Sara's service (NoNewPrivileges, ProtectSystem=strict, PrivateTmp, PrivateDevices): download,
  library check and launch test passed with Chrome's own sandbox; the add-on in bubblewrap and Sara's
  own browser in bubblewrap both opened a page and read it. With the four libraries above hidden,
  Sara fetched them (two rounds, about 3 MB) and the same checks passed.
