# What computer do I need?

Sara herself is small. What needs a big machine is running AI models yourself, and that part is
optional: with a cloud model or a subscription, a small server is enough.

## Sara on her own

| | Minimum | Comfortable |
|---|---|---|
| Memory (RAM) | 1 GB free | 2 GB or more |
| CPU | 1 core (x86_64 or arm64) | 2 cores |
| Disk | 1 GB for Sara and her own Node.js, plus her data | 10-20 GB, so backups have room |
| System | Linux with systemd (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), Docker, Windows 10/11 (64-bit) or macOS 13+ | |

Measured: a fresh Sara 0.54 with no model connected used about **100 MB of memory** (97 MB
working set) sitting idle on Windows, and her data folder was about 1 MB. She grows with what you
give her: the library, workspaces and photos take the most space, and the last 7 daily backups
are kept, each about the size of her data. On Linux the service is allowed up to 4 GB of memory
(`MemoryMax` in `deploy/sara.service`); she normally uses far less, more while she reads large
documents or runs builds.

**Is a Raspberry Pi or a small VPS enough?** For Sara with a cloud model or a subscription: yes,
any 64-bit Raspberry Pi with 2 GB or more (on a 64-bit OS) or a VPS with 2 GB of memory. Local
voice is x86_64 only for now, so not on a Pi. Running AI models on a Pi is too slow to be useful.

## Add-ons

| Add-on | Extra disk | Extra memory | Notes |
|---|---|---|---|
| **Local voice** (speech recognition and voices on the server) | about 1.3 GB (650 MB download) | plan on about 1 GB more while she speaks or listens (not measured exactly) | Linux x86_64 only; runs on the CPU |
| **Testing browser** (she tests the web apps she builds; shared with the Browser add-on) | about 280 MB in her data folder's `cache/browsers` (110 MB download, fetched by Sara on first use) | a few hundred MB while it runs, as a rough guide (one per conversation, closed after 5 idle minutes) | Windows uses Edge and macOS uses Chrome, Edge or Chromium if installed; see [BROWSER.md](BROWSER.md) |
| **Subscription programs** (Claude Code, Grok) | about 0.5 GB | a little while one runs | Linux native installs |
| **Her coding projects** | what the projects need | what their builds and tests need | `node_modules` and similar folders are left out of backups |

## Running models yourself (Ollama)

This is the part that needs real hardware. A GPU's own memory (VRAM) decides which models fit:
see the table in [CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md). In short:

- **8 GB VRAM:** small models (up to about 8B) for chat and quick jobs.
- **16 GB VRAM:** 14-20B models: good chat and tools.
- **24-32 GB VRAM:** 27-32B models: a strong coding partner (the published results used one
  RTX 5090).
- **Mac with Apple silicon:** the main memory is shared with the GPU, so 32 GB or more is a good
  start.
- **Meaning search only** (`nomic-embed-text`): runs fine on a CPU, no GPU needed.

Ollama can run on the same computer as Sara or on another one (for example a gaming PC at home)
that Sara reaches over Tailscale or your home network. The model files need disk space too:
roughly the same as the VRAM figure (a 27B 4-bit model is about 17 GB on disk).

## Your network

- To reach her from your phone away from home you need **HTTPS**: Tailscale (no ports to open) or
  your own web address (ports 80 and 443 open). See [PHONE.md](PHONE.md).
- Her own bandwidth use is small: text, and pictures and voice when you use them. Cloud models and
  live calls need a steady connection.
