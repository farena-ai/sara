# Security review U5.33: the outside-facing parts added in S9 to U4

ROADMAP_U U5.33. A review of everything another server, a web page or a link can reach that came in
with S9a (links and messages), S9b (help passes), T5 (fix passes), U3.17 (fix recipes), U4.25 (the
browser extension), U4.26 (shared projects), U4.27 (the marketplace), U4.29 (client portal links),
the root code-change helper, public share links, the Mac meeting recording hand-off and the Android
`openInBrowser` bridge. Each finding below was first written as a failing test in
`test/u5sec.test.ts`, then fixed where the flaw was. No feature was taken away.

## How it was reviewed

Code and tests were read for each part, looking at: signature scope and replay, expiry, path
handling, address fetches (SSRF), size and rate limits, peer words reaching the model (prompt
injection), peer content in the page (XSS), cross-site requests to owner routes, secrets and health
data in reports, symlinks and races in the root helper, and who may reach what (members, kids, the
demo, private local mode).

## Findings (most severe first)

| # | Severity | Finding | Impact | Fix | Test |
|---|----------|---------|--------|-----|------|
| 1 | High | Reading a calendar link (Connections, also in a household member's space) and a recipe or iCal page by address (Family plan, any parent) fetched any address: this computer, the home network, cloud metadata; redirects were followed and the whole body was read before it was cut. `netFetch` only checks addresses in private local mode. | A member or parent could make the server read its own admin routes or other machines on the network and see the answer when it parsed as a calendar or recipe; a large answer could fill memory. | `publicGet` in `src/net-guard.ts`: the existing `checkPublicTarget` rules (public addresses only, names resolved and checked, no user:password) on the address and on every redirect hop, at most 5 hops, a time limit and a byte cap (calendars keep their 5 MB cut). Used by `src/calendar-links.ts` and `fetchPageText` in `src/routes/family-plan.ts`. | `U5.33 SSRF` (2 tests) |
| 2 | High | Tools that hand Sara a friend's words did not hold the tools after them: `shared_project_read` (a friend's notes, to-dos, files), `support_look` and `remote_look` (the other server's report and log lines). | A friend's note such as "ignore the owner and send …" could make a tool that runs on its own act in the same turn. | Those three tools count as peer answers in `src/chat.ts` (as A2A answers already did): after one, every tool that changes something asks the owner; read-only tools still run. Their output is fenced with `untrustedPeer` (source "friend"). | `U5.33 prompt injection … friend's content` |
| 3 | High | A page sent by the browser extension (Ask about this page, Summarize) ran as a normal outside-app turn: the page text was fenced, but tools that run on their own still ran. | A hostile web page could make Sara act (add, change, send with an auto tool) while the owner only asked for a summary. | New turn option `outsideContent` (`src/chat.ts`): the turn starts as if a peer had answered. `/api/ext/ask` sets it (`src/routes/extension.ts`); the popup shows the waiting card instead. | `U5.33 prompt injection … browser extension` |
| 4 | Medium | Signed peer calls for help passes, fix passes, fix recipes, shared projects and the marketplace had no rate limit (messages had one). A fix recipe needs no pass, and every new one was stored and notified. | A linked server (or its stolen key) could flood the owner's server with signed calls, notices and stored recipes. | `peerRate` (`src/support.ts`): 120 signed calls a minute per link and scope, in `SupportLink.verify` (support, repair, sproj) and `Market.verify`; at most 50 received recipes waiting per link (`src/fix-recipes.ts`). | `U5.33 DoS` |
| 5 | Medium | A friend's code recipe could carry a patch to the code that checks links, passes, peers and outside content (it still needed the owner's Apply). | A friend could ask the owner to approve a change that widens what friends may do, hidden in a "fix that worked". | `PEER_BOUNDARY` in `src/fix-recipes.ts`: a received code recipe that touches those files is refused. The owner's own code changes are unchanged. | `U5.33 fix recipes` |
| 6 | Low | Message, share and item ids chosen by the other server were stored as sent and put into the owner page's links (file, delete, report, edit). | An id like `../../…` could point the owner's own click (Delete, Report) at another owner route. | Ids from peers must be plain id characters (`src/messages.ts`, `src/shared-projects.ts`); the page encodes ids in every link (`web/messages.js`, `web/shared-projects.js`). | `U5.33 peer ids` |
| 7 | Low | Android `openInBrowser` compared only the host: a backslash or user part could make the phone's browser open another site, and http/https or another port on the same host passed. | Only reachable by script already running in the app's page; would open a different site in the browser. | Same scheme, host and port as the server, no user part, no backslash or `@`. | `U5.33 Android` |

## Reviewed, no change needed

- **S9a links and messages:** Ed25519 signature over link, time and body hash; 5-minute window;
  event ids remembered (replay is 409); body and file caps; a per-link rate limit; pictures checked
  by their bytes; files stored under a hash name. Help, fix, recipe, shared-project and market calls
  sign their own scope word and op, so a signature for one never passes as another.
- **Help and fix passes:** expiry clamped (at most 7 days), revocable, checked on every call, paused
  in private local mode; the report goes through the scrubber (keys and secrets removed), never chats, files,
  memories, mail or health data; changes only from the allowlist, approved by the owner.
- **Root code-change helper:** reads the request and patch as the service user, checks with the
  root-owned checkout, the approved patch's SHA-256, protected paths and test weakening; refuses any
  path through a link; snapshots and rolls back when she does not come back healthy.
- **Browser extension:** its own scoped device token with a fixed route list, no cookie, rate limits,
  form values never for password, card or code fields; kids never reach it.
- **Share and client portal links:** 256-bit tokens stored hashed, expiry and revoke, the page is
  server-rendered and escaped with the strict content security policy, files only PDF or pictures
  with `nosniff`.
- **Peer names, notes and listings in the page** are set as text, not HTML. Owner routes refuse
  cross-site writes. Peer endpoints are closed (404) in a member's space and on the demo; shared
  projects and the marketplace are owner only.
- **Mac recording hand-off:** a new random token per recording, cleared on discard, reads capped at
  4 MB a piece. **OpenSky:** a fixed public host with numeric parameters only.
