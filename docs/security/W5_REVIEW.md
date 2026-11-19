# Security review W5.1: what ROADMAP_V and ROADMAP_W added

ROADMAP_W W5.1. The second outside-facing review (the first is `docs/SECURITY_REVIEW_U5.md`, U5.33),
following its method: read each feature's code and tests, write the attack as a failing test
(`test/w5sec.test.ts`, commit bfcb1a51), fix where the flaw is, keep the feature. Everything ran on
throwaway in-process servers with fake models and fake fetchers; no real host was touched.
Always allow everything stays as permissive as the owner asked for the person who turned it on.

## How it was reviewed

For each surface: who may reach it (owner, household member, kid, hosted friend, team role, demo,
device key, token-only visitor), token scope and replay, CSRF on state-changing routes, address
fetches (SSRF, redirects, DNS names), path handling, XSS in public and shared pages, words from other
people reaching tools without a card (web pages, mail, MCP answers, visitors, linked servers),
crypto, kid-mode escapes, and what leaves through public links.

## Findings (most severe first)

| # | Severity | Finding | Impact | Fix | Test |
|---|----------|---------|--------|-----|------|
| 1 | High | A hosted friend (W2.3) manages their own model providers, and the address was any http(s) URL. | The server fetches `<address>/models` and `/chat/completions` and shows errors and answers to the friend: a friend could read this computer's own services, the owner's home network or cloud metadata (169.254.169.254). | `PUT /api/providers/:id` in a hosted space runs `checkPublicTarget` (public addresses only, names resolved and checked, no user:password; http allowed). `SARA_HOSTED_LOCAL_MODELS=1` lets the owner share a model server on this computer itself (loopback only, never the network or metadata). The owner's own providers are unchanged. | `W5.1 SSRF` (2 tests) |
| 2 | Medium | The family screen's "Everyone" Talk (W4.5) ran the owner's app off the record with no tools and no memory, but the owner's library, people cards, planner, agenda, recall and folder were still there. | Anyone at the wall screen (guests, a sitter) heard answers built on the names of the owner's kept documents (and passages on a document cue). People cards and planner were one code change away. | The guest proxy also hides `people`, `library`, `planner`, `agenda`, `life`, `recall`, `vectors`, `projects`, `skills`, learning, research, recipes, working style, scrapbook and more, and gets its own empty `dataDir` (`<data>/family-screen-guest`). Kids still talk in their own space. | `W5.1 family screen` |
| 3 | Medium | Memory lane share links (W4.2) sent the picked photos byte for byte. | Phone photos carry EXIF GPS (often the home), time and camera serial: a public link gave them to anyone with it. | `stripImageMeta` (`src/image-meta.ts`): JPEG APP1–APP15 (except ICC and Adobe) and comments, PNG `eXIf`/`tEXt`/`zTXt`/`iTXt`/`tIME`, WebP `EXIF`/`XMP ` (VP8X flags cleared); pixels copied unchanged, an unreadable picture is left out. Used by `laneShare`. | `W5.1 memory lane` |
| 4 | Medium | Always allow everything (W0.7) promised that requests from other people still ask, but a web page, an email or an MCP answer a tool brought in during the person's own turn kept the switch's no-card pass. | A hostile page or email ("ignore the owner and delete …") could make any tool, including payments and destructive commands, run without a card in that turn. | `outsideWordsTool` in `src/chat.ts`: after `web_fetch`, mail and Gmail reads/searches, `inbox_suggestions` or any `mcp_*` tool, the switch stops skipping cards for the rest of that turn; normal permissions (auto tools) are unchanged, the person's own requests still run without cards. | `W5.1 Always allow` |
| 5 | Low | A linked friend's sealed backups (W5.3 holder) were limited by size, but only finished copies counted. | A friend's server (or its stolen key) could start many uploads under different names and fill the disk past the size the owner agreed to. | `begin` counts uploads in progress; one left for a day is given up and its room freed. | `W5.1 carry holder` |
| 6 | Low | Public records (W4.6) checked the paid-broker list, sign-in-only sites and robots.txt on the search result's address only. | A free-looking page that redirects to a paid broker or a sign-in site was read and cited. | The address the page ended on is checked again (broker, sign-in, robots.txt of that site) before anything is read from it. | `W5.1 records` |

## Reviewed, no change needed

- **Receptionist (V3.5, W3.5):** per-address limits, wrong-id limiter, page token, honeypot; the model has
  no tools and no memory; visitor text is fenced; payment links are the owner's https links only, drawn
  as text links; follow-up drafts wait for the owner's OK; `frame-ancestors` only from cleaned origins.
- **My apps shares and live canvas (V3.1, D3):** token-only address (128-bit), `CSP sandbox` without
  `allow-same-origin` (opaque origin, no cookies, no API), read-only share tokens, expiry, revoke; a canvas
  `tasks` tick only touches rows its source lists. No canvas token appears in tool text or share snapshots.
- **Teach by showing (D1):** passwords, card numbers, codes and ID fields never stored; drafts need review.
- **Wear OS (D2):** short codes from the watch, claimed only by a signed-in person, a watch-kind token with
  scope `ask`, per-address and global caps.
- **Legacy access (V5.3):** hashed token, timing-safe check, stage machine, proof to widen, rate limits,
  escaped page, documents by id only from the chosen list.
- **Offline outbox keys, caregiver (V5.4), timeline revert (V5.1):** keys validated; caregiver view built in
  code from consented parts only; timeline and revert are per space.
- **Continue here (W1.3):** per space, same-origin JSON only, drafts clipped, nothing calls a model.
- **Hosted friends (W2.3):** own settings file and vault key, refused families, owner sees totals only.
- **MCP catalog and scoped keys (W3.2):** owner-only; pinned packages; folder sandbox; scopes enforced on
  `tools/list`, `tools/call` and `resources/*`. By design (docs/OTHER_APPS.md) `/v1` chat and `ask_sara`
  follow the "let other apps use tools" setting, not the MCP scopes.
- **Team workspace (W3.3):** every write re-checks the workspace role; nobody decides their own request;
  over-limit spending needs an administrator.
- **Handle it (W4.1):** sign-in, submit and payment stop for the person even with Always allow.
- **Family screen tokens (W4.5):** 6-character codes, 10 minutes, once, per-address wrong-code limit; the
  token only opens `/api/family-screen/*` and is kept as a hash; kids talk in their own space with no tools.
- **Health coach (W4.4), local-only allowances (W5.2):** computed in code from the person's own log; the
  allowances are fixed https prefixes (Sara's GitHub release page) and named switches.
- **Carry crypto (W5.3):** 128-bit sheet key, HKDF-SHA256 per copy with a random salt, AES-256-GCM with a
  random IV, the header bound as AAD, the tag checked before the file is renamed into place.
- **Help media (W2.5):** a fixed pattern of names under `docs/media` only. **Add-on kit host (W3.1):** a
  throwaway data folder on 127.0.0.1 with a scripted model.
- No `innerHTML` in any V/W page script; public pages escape everything they show.

## Left as they are (noted)

- Finding 1 checks the address when it is saved; a name that changes to a private address later (DNS
  rebinding) is not re-checked per call. Providers saved before this fix are not re-checked.
- Always allow does not hold after `web_search` snippets or browser/computer-use pages: computer use is
  the part the owner asked to run freely, and its own limits (password fields, banking, admin prompts) stay.
- A mail account (IMAP/SMTP host) in a member's or hosted friend's space may name any host; the protocol
  answers are not shown back, so it is not a readable SSRF.
- Records: the redirected page's bytes are fetched before they are thrown away (nothing is kept or cited).
