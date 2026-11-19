# W5.2 Local-only mode, proven

One switch, **Local-only mode: nothing leaves this computer** (Settings → Models & usage → On this
computer), that guarantees nothing leaves the server except what the person explicitly allows, plus a
test that proves it on a real server.

## What existed (reused, not rebuilt)
- Phase 67 private local mode: `src/private-local.ts` (state, `SARA_PRIVATE_LOCAL`, `whatWouldLeave`)
  and `src/net-guard.ts` (`netFetch`, `openWebSocket`, `checkOutbound`, `assertOnline`, the global
  fetch wrap, Ollama egress rules). Every feature already pauses or refuses through it; many pages say
  so ("Paused (Nothing leaves this computer)").
- `test/private-local.test.ts`: the source scan (no `fetch(`, raw socket or `dgram` in src/ outside the
  guard) and per-feature refusals.
- V5.2 privacy ledger (`src/privacy-ledger.ts`, Settings → Privacy → What left this server), fed by the
  net guard: per day, per host, counts and sizes, plus "Stopped before leaving".

## What W5.2 adds
- **Allowed while it's on** (`LOCAL_ALLOWS` in net-guard): a fixed list, each off by default, each its
  own checkbox with a tip:
  - `updates`: only `https://github.com/farena-ai/sara/releases/…` and
    `https://api.github.com/repos/farena-ai/sara/releases/…` (https, no user:password). Other GitHub
    paths, other repos and look-alike hosts stay blocked. Also lets `assertOnline(…, 'updates')` (the
    Linux root updater), `POST /api/update` and the open page's hourly check through.
  - `model-downloads`: Ollama on this computer may `/api/pull`; its web search and cloud models stay
    blocked. Ollama makes that connection itself, so the ledger records it as `registry.ollama.ai`.
  Saved in `<data>/private-local.json` (`allow`), applied with `setLocalAllow`. Route:
  `PUT /api/private-local {allow: [...]}` (owner only, changes nothing else); GET adds `allow`,
  `allowable`, and `allowed: true` on the matching "What would leave" row. `/api/session` carries
  `localAllow`; the ledger answers `localAllow` and the page shows "Local-only mode is on. Allowed: …"
  with a link to the switch.
- Plain words where a feature can't work local-only: the briefing now says the weather was not
  checked because Local-only mode is on (it used to say "not set up"); the download button says
  "tick Model downloads above, or turn Local-only mode off".

## The proof (`test/w5-local-day.test.ts`)
- `test/fixtures/w5-net-trap.ts` is loaded with `--import` (through `NODE_OPTIONS`, so every Node
  program the server starts gets it too) UNDER the net guard: `net.Socket#connect` (covers TLS,
  HTTP/1, HTTP/2, undici fetch and WebSocket), `tls.connect`, `dns.lookup`/`resolve*`/`Resolver`,
  `dgram#send` and `fetch`. Anything not on this computer is refused before a byte is sent and logged
  with a stack; loopback is allowed only to the test's own ports (a real Ollama or the owner's Sara on
  this PC is refused too).
- A real `src/main.ts` server starts with `SARA_PRIVATE_LOCAL=start`, a fake model on loopback, and
  settings that would normally reach out (briefing weather, a web search service).
- Control: allow update checks, run one; the trap must catch github.com and the ledger must count it
  (the trap is not blind). Take the allowance back, clear the ledger and the log.
- The day over HTTP: chat (2 turns), memory, reminders (one fires), planner + Today, Library upload,
  photo folder scan + picture description, voice, the briefing, an automation run, health entries.
- Asserts: zero trap hits for other computers (a failure prints each path's stack and says to route it
  through the net guard) and ledger `{count: 0, bytes: 0, places: 0}`. What the guard stopped
  (today: `api.open-meteo.com`) is printed as a diagnostic. A second test checks the trap itself
  catches raw sockets, TLS, DNS, UDP multicast and fetch.

## Limits
- Non-Node programs she starts (git, ssh, curl) are not trapped; in this mode they are refused or
  told to stay offline (`PRIVATE_LOCAL_ENV`, `test/private-local.test.ts`), and on Windows her
  commands can't be fully cut off from the internet (the Settings page says so).
- The browser and the OS are outside Sara.
