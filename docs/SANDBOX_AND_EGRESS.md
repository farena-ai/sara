# Container sandbox and allowed sites

Settings → Coding → **Tools and approvals** → *Isolation* and *Sites sandboxed work may reach*.
Owner only. Design: [ops/EC89_DESIGN.md](ops/EC89_DESIGN.md).

## Where her commands run

| Choice | What it does |
| --- | --- |
| **Automatic** (default) | Linux: bubblewrap. Mac: the macOS sandbox. Where neither exists (Windows, Linux without bubblewrap): a container, if Podman or Docker works and its image is on this computer; otherwise commands run directly and she asks before every one. |
| **This computer's own sandbox** | Never a container (today's behaviour). |
| **A container (Podman or Docker)** | Shell commands, the sandbox gate's tries and add-on jobs run in a throwaway container. Without a working engine, the computer's own sandbox is used and Settings says why. |

A container sees only the workspace (or the add-on job's disposable copy) at `/workspace`: not Sara's
data, your home folder or the rest of the system. Its root is read-only, it has no capabilities and no
new privileges, at most 512 processes and 2 GB of memory, and no network unless the command has it.
Rootless Podman is used before Docker. The image is the sandbox gate's image (default `node:24-slim`);
**Sara never downloads it**: run `podman pull node:24-slim` (or `docker pull …`) once yourself.

- **No engine?** *Install Docker for me* opens the one-click install (Docker Desktop on Windows and
  Mac shows the manual steps). After installing, start it and press **Look again**: no restart needed.
- **What stays outside containers:** tool servers (MCP), the plugin processes themselves, the testing
  browser and the coding agents (Claude Code, Grok Build) keep the computer's own sandbox; the image
  does not contain them.
- **Approvals do not change:** *Ask me first* still asks. On Windows, commands stop asking every time
  only because they are now isolated, exactly as with bubblewrap on Linux.
- **Health is honest:** Settings, `sara doctor` and the safety check-up say *isolated* only for
  bubblewrap, the macOS sandbox, the separate tools user or a container that really works.

## Sites sandboxed work may reach

*Any site* is today's behaviour. **Only the sites listed below** limits every command, sandbox try,
add-on job and (with bubblewrap or the macOS sandbox) tool server that has internet to these sites.
An empty list means no internet at all for them.

One site per line: `registry.npmjs.org`, `*.github.com` (its subdomains), `api.example.com:8443`
(another port; without a port 80 and 443 are allowed). No IP addresses, no single-word names. A name
that resolves to a private or loopback address is refused, so the sandbox can never reach Sara's own
server or your network through the list.

**Keys stay outside:** `api.example.com key=egress:example` makes Sara add the saved secret
`egress:example` as `Authorization: Bearer …` when a program sends plain `http://api.example.com/…`
to the proxy; Sara forwards it over HTTPS. The key never enters the sandbox. (HTTPS requests from inside
cannot get a key: Sara does not break TLS.)

**How it is enforced** (Settings shows the line for this computer):

| Sandbox | Commands | Add-on jobs |
| --- | --- | --- |
| Container | enforced: an internal network whose only way out is a proxy container | same |
| bubblewrap | enforced: no network in the sandbox except a bridge to the proxy | same |
| macOS sandbox | enforced: only the proxy's local port | (jobs use the Node fence) |
| None (Windows without an engine) | **not enforced**: only programs that honour proxy settings use it | enforced by a Node guard in the job (not an OS boundary) |

Every refused site is one `egress.refused` row in the audit trail (per site, per run), with the site
and port, never the request. Add-on jobs on the Node fence (Windows) now also get **no network at all**
when their plan does not ask for it (before, only proxy settings).

## For the admin (policy pins)

Household → Policy: **Require the container sandbox** (commands and add-on jobs run only in a container;
without a working engine they are **refused**, never run unisolated) and **Only these sites for
sandboxed work** (the listed sites are in force whatever the owner chooses; an empty list means no
internet for them). Both only tighten; the routes refuse other choices with *Set by your admin*. See
[AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md).
