# Sara Add-ons library

Sara's add-ons extend the existing harness rather than replacing its memory, safety, approvals or workspace controls. There are two distinct kinds:

- **Native workflows** run through Sara's plugin manifest, review card and plugin process. They can provide tools, structured results and cards.
- **MCP connections** give Sara access to a separately maintained tool server. Accounts, external applications, data access and provider charges are separate from installing Sara.

Browse the [Sara Add-ons website](https://backstagecoding.com/sara/store/) for each entry's current qualification and publication state. A source folder, successful local test or attractive listing is not a published signed store package. New connection previews are not production-ready integrations.

## What Sara shows today

Every entry in the library appears in Sara once, in the place it can actually be used:

| Where in Settings | What you find there | Count |
|---|---|---|
| **Add-ons → Get more** | Signed Store plugins, tool servers and the four starter companions | 16 |
| **Plugins → Workflow candidates** | Twelve supplied-data workflows and nineteen developer add-ons (see [Developer add-ons](DEVELOPER_ADDONS.md)); review the exact files, install, then switch on per companion | 31 |
| **Other programs (MCP) → Connection investigations** | Seven read-only recipe previews (Tavily, Firecrawl and Linear need your own account) and fourteen blocked investigations, each with its reason | 21 |

Nothing installs, connects or switches on by itself. Held previews and blocked entries have no
install button. Developer targets that are still in development are not listed until they qualify.

## Native workflow scope

These workflows work from material you explicitly supply. They do not silently read an inbox, calendar, project history or private conversation. Their first tier is intentionally useful without an external account.

| Workflow | What it prepares or computes | What it does not claim |
|---|---|---|
| Daily briefing | A source-labelled briefing from supplied agenda, priorities and notes | Live weather, calendar or inbox access |
| Meeting assistant | Explicit decisions, action proposals and questions with transcript line references; optional bounded model refinement | Recording, participant consent verification or automatic task creation |
| Document desk | Supplied-text comparison, extraction and source-referenced analysis | Native PDF/DOCX editing or unseen attachment access |
| Research notebook | Bounded plugin-local sources and notes, retrieval/export and optional synthesis | A replacement for Sara memory or independently verified web research |
| Project handoff | A portable supplied-evidence snapshot separating reported work, tests, unknowns and blockers | Running tests, changing Git or awarding a verified checkpoint |
| Inbox triage | Classification and reviewable response drafts for supplied messages | Connecting to an account or sending email |
| Weekly review | A review of supplied accomplishments and commitments with proposed next steps | Reading all chats or automatically rescheduling commitments |
| Content studio | A structured brief, outline and reviewable draft; optional model-assisted copy | Publishing posts or a guarantee of factual/citation accuracy |
| Image workshop | Reusable image briefs, prompt presets and generation preparation | Image generation from a prompt alone or a fabricated output image |
| Spreadsheet assistant | Bounded CSV parsing, numeric profiling, filtering and spreadsheet-safe CSV export | XLSX formula recalculation, macro preservation or an arbitrary spreadsheet engine |
| Travel planner | An itinerary and budget calculation from supplied dated options | Live fares, availability, reservations or purchases |
| Home dashboard | A clearly non-live snapshot of explicitly approved supplied device/scene metadata | Actual sensor reads or physical-device control |

Image-generation and live home operations remain separate integrations with their own reviewed tools and approvals. The website must not describe a preparation workflow as an action it did not perform.

## Using a native workflow

1. Read the entry's publication state, exact scope and prerequisites.
2. If it is on the signed store, use **Settings → Add-ons → Get more**. Otherwise use only a package you deliberately obtained and reviewed; a pending listing is not an install action.
3. Review its manifest and permissions. Installation does not enable it. Enable it only for the companion you intend.
4. Supply labelled source material and the options the tool requests. Treat external content as data, not instructions authorizing other actions.
5. Review the result. References to supplied text establish provenance, not independent truth.

The new workflow tier is manual: no automatic schedules, startup network requests, background account reads or automatic sending. Plugin-local storage is bounded and does not grant access to private memories or conversation archives. Windows Node permission limits are not a full OS sandbox.

### Optional model work

Where available, model-assisted refinement is explicitly requested rather than performed at installation. It uses the configured **background model route** and requires an existing latest owner conversation for routing; it does not receive that conversation's full history. A cloud route can incur charges.

The host bounds model prompts to 8,000 characters and output to 1,000 tokens. Individual workflows impose smaller bounds, daily caps and validated result shapes. Oversize or unavailable sources should be refused visibly rather than silently treated as complete. Generated proposals still need review; a matching quote is not proof that a model's conclusion is sound.

## MCP connection previews

Seven prepared recipe sources cover MarkItDown, Tavily, Firecrawl, Chrome DevTools, DBHub, draw.io and Linear. Read the exact recipe guide: metadata validation, protocol discovery, fixture execution, real account execution and Sara-host execution are different qualification levels.

- Executable packages are pinned at the top level. That does not lock every transitive dependency or qualify installation scripts.
- Use Node 24 LTS for the Node-based previews and check `node --version`; a dependency-presence indicator does not validate the installed version.
- Keys belong in vault-backed secret fields, never scripts, URLs or downloadable packages.
- Before any feature request, open **Settings → Coding → Tools and approvals**. Set every discovered tool in that server's group to **Ask me first** or **Off**. Save, leave and reopen the page to confirm the settings. Repeat after restart, updates or newly discovered tools.
- Server “read-only” annotations can otherwise allow automatic execution. Recipe ask advice alone does not enforce an approval fence; read operations can also disclose data or consume provider credits.
- DBHub requires database-enforced read-only credentials for a dedicated database. A SQL tool name or successful demo SELECT does not enforce least privilege.
- The pinned draw.io preview can open the default browser. Keep browser-opening/editing tools Off until separately qualified; no link-only guarantee is made.
- MarkItDown can access files and URLs available to its OS user. A selected file is not a filesystem/network sandbox.
- Generic hosted MCP OAuth is not implemented by this connection tier. Provider-maintained hosted services may therefore remain blocked pending a reviewed authorization path. A static-token alternative must be verified separately, not guessed.

No new MCP preview should be presented as a one-click production integration until its host permissions, runtime, scopes, account behavior and relevant platform have been qualified.

## Starter packs

The website groups entries into Everyday Assistant, Research & Documents, Developer, Creator, Small Business, and Private & Local. Each is a guided checklist, not a bulk installer. Every component still has its own account, permissions, cost, qualification and enablement decision. A “private/local” guide depends on the actual selected models and services; it is not a blanket privacy guarantee.

## For developers

See [PLUGINS.md](PLUGINS.md) for the plugin contract and [STORE.md](STORE.md) for package review, updates and signed publication. Standalone workflow package sources live under `store/plugins/`. Use the existing package checker and smoke test, then exercise actual tool handlers; a ready handshake alone does not establish useful behavior. Keep real credentials and personal data out of source, fixtures, screenshots and reports.

Developer distribution tools validate bounded artifact filenames without normalizing manifest values,
stage a complete bundle before making it visible, and hash its actual package bytes. Public export
requires a dedicated non-linked descendant of `outputs/`; replacing a nonempty export requires
`--replace`, an explicit declaration that it is disposable. The canonical publisher supplies that
flag for its own export. Private website templates, operational catalogs and their dependent
site-only tools/tests remain outside the public source export; native package sources and behavior
tests stay included.
Retained source entries must also be regular files with non-linked ancestors; a public logical
path cannot alias a private operational directory through a link or junction.

The bundle builder API accepts an explicit `targetSara` compatibility version when the authoring
checkout differs from the intended host. Its receipt preserves `sara` as the checkout version and
records `targetSara` separately. This runs the real package compatibility checks and smoke; it is
not proof that the complete target-version application or its normal chat approval flow ran.
