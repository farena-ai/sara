# V5.2 Privacy ledger (design, one page)

ROADMAP_V item 32: "count each outgoing request in net-guard by destination host and purpose
(model, search, mail, hub...), never bodies; a *What left this server* page per day". Acceptance:
fake requests show under the right destination; private local mode shows zero.

## What existed
- `src/net-guard.ts`: the one way out (`netFetch`, `openWebSocket`, `checkOutbound` before raw
  sockets), private local mode, and a 50-row in-memory list of *blocked* attempts
  (`blockedRecently`, shown on the On this computer page).
- `src/audit-trail.ts` (who changed what, hash chain), `src/egress-run.ts` (refusals of sandboxed
  runs into the audit trail), `src/trust-report.ts` (sources her tools read), `src/hub.ts`
  ("Show what's sent" for the daily check-in), Settings → Privacy & system → Privacy (`dh-privacy`).
- Nothing counted the requests that *did* leave.

## What was built
- **Hook in the guard** (net-guard stays import-free): `setOutboundRecorder(fn)`; `netFetch`,
  `netFetchPeer` (LAN agents) and `openWebSocket` report `{target, bytes}`; blocked attempts report
  `{target, blocked: true}`; `noteOutbound(target, what)` is called right after `checkOutbound` at the
  raw-connection sites (mail sockets, Apple push, `src/ws.ts`, web_fetch hops, git clone, SSH port
  check, plugin connections). The size is the request body's length when it can be told without
  reading it (string, bytes, URLSearchParams, Blob); streams/forms count as "size unknown".
- **`src/privacy-ledger.ts`** `PrivacyLedger`: per owner-local day (settings time zone), one row per
  destination host: purpose, count, bytes, unsized count, first/last time; plus a *stopped* count per
  host. Loopback hosts are not "leaving" and are never counted, so private local mode shows zero
  left. Never a path, query, header, body or who asked. 30 days, 300 hosts a day (the rest in one
  row), `<owner data>/privacy-ledger.json` (0600, written at most every 15 s and on shutdown).
- **Purpose** = caller label (`your mail server` → mail, `a plugin connection` → add-ons…), then the
  owner's own hints from settings (`ledgerHints`: provider base URLs → model, search URL → search, the
  hub → makers; subdomains included), then a table of well-known services, then home network
  (`isLanHost`), else *other*. Purposes: model, search, web, mail, notifications, chat-apps, voice,
  makers, github, add-ons, home-network, other.
- **Route** `GET /api/private-local/ledger[?day=YYYY-MM-DD]` (today, list of days, groups, stopped,
  private-local state) and `DELETE` (Clear the list): inside the existing owner-only, audited
  `private-local` family, so no household-isolation/AUDITED churn.
- **Web**: a *What left this server* section (top-level `<h3>` with a tip) at the end of Settings →
  Privacy: day picker (Today + days with data), summary line, one card per purpose with a plain
  "why" line and its hosts (count, size, last time), a dashed *Stopped before leaving* card, Clear
  the list. `web/privacy-ledger.js` (host names via textContent), styles in `web/hub.css`, help
  section `#privacy-ledger`, strings in 5 languages.

## Not covered
- Sandboxed jobs reaching out through the EC9 egress proxy and add-on programs' own traffic (they
  have their own allowlist/refusal rows in the audit trail), helper programs Sara starts (Ollama's
  own downloads, CLI agents, winget), and loopback servers that reach out for her (a local Ollama
  pulling a model). The page says what it counts: requests this server sent.
- Household members: the ledger is server-wide and owner-only (the process has one guard).
