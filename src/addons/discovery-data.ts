// Curated public metadata for pinned local candidates and inert connection previews.
// Content identities do not confer signatures, trust or installation authority.
export const discoveryData ={
  "candidates": [
    {
      "id": "daily-briefing",
      "kind": "plugin",
      "name": "Daily briefing",
      "summary": "Assemble a source-labelled agenda and priority briefing from supplied context.",
      "description": "Assemble an on-demand briefing from explicitly supplied agenda, priorities and notes. No live account reads.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply labelled agenda, priorities or notes, including any date/timezone/freshness you want preserved.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool brief (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "One section per supplied source, exact nonblank lines and ID:L<n> references. Reports live calendar, weather and inbox as unchecked. Does not rank by invented urgency or infer today.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "brief",
      "contentSha": "2a9db3d86e77a8ebf8b57c0b3176b70e27a1c8a1e34e05f22064a0a276706208"
    },
    {
      "id": "meeting-assistant",
      "kind": "plugin",
      "name": "Meeting assistant",
      "summary": "Extract labelled meeting decisions and proposed actions with transcript line evidence.",
      "description": "Extract explicitly labelled decisions, actions and questions from a supplied transcript with line references. Never records or creates tasks.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply notes/transcript yourself. You are responsible for permission to share participants’ material.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool extract (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "Recognizes explicit Decision:, Action:, Question: prefixes case-insensitively. Preserves every other nonblank line as unclassified. Actions parse one owner= and one valid ISO due= field; missing, duplicate or ambiguous metadata stays unset. No recording, transcription service, attendee verification or task creation.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "extract",
      "contentSha": "e439efadff9554b59fa3b81a889c19463f69613b008f2c5065e983efd286972d"
    },
    {
      "id": "document-desk",
      "kind": "plugin",
      "name": "Document desk",
      "summary": "Compare or extract supplied text with original source labels and exact line references.",
      "description": "Compare two supplied texts by exact lines or extract literal query matches, keeping source labels and line references. No file conversion.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply plain text from documents with distinct IDs and accurate labels. Convert PDFs/Office documents separately if needed.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool inspect (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "compare requires exactly two sources and returns onlyLeft, onlyRight and shared exact lines. It is a line-set comparison, not semantic or ordered diff. extract requires query (1–200 characters) and returns case-insensitive literal matches from 1–12 sources. It reads no files and invents no pages.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "inspect",
      "contentSha": "89d765f8a241f1db2bc00b146d1d0e2f676f359f4703338f44ffabd15b335e9e"
    },
    {
      "id": "research-notebook",
      "kind": "plugin",
      "name": "Research notebook",
      "summary": "Maintain a bounded source notebook with dedupe, explicit CRUD, export and cited model proposals.",
      "description": "Keep a bounded, explicitly supplied source notebook: CRUD, exact-content dedupe, Markdown export and optional quote-checked synthesis. No web retrieval.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply sources/notes explicitly. No browser, search account or connector is required; no URLs are fetched.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool notebook (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "One per-companion plugin-local notebook, not conversation memory. put/get/list/delete/export/synthesize. Same exact kind/text/URL/reference list is deduplicated; a changed existing ID needs overwrite:true. Notes can reference existing source IDs; referenced sources cannot be deleted or changed into notes. Export returns indented-source Markdown as tool text, not a file. Selected synthesis is read-only and never saves model output.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "notebook",
      "contentSha": "c684fc420b3c6fdbe4cf915f6fac84bfd57e07edff6bea7fa0d09c1a9b3e2e4a"
    },
    {
      "id": "project-handoff",
      "kind": "plugin",
      "name": "Project handoff",
      "summary": "Build a handoff that distinguishes supplied evidence, unverified test claims, pending work and blockers.",
      "description": "Build an evidence-tagged handoff from supplied changed, tested, pending and blocker context. Does not scan projects or award verification.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply selected project context as labelled sources with role changed, tested, pending or blockers.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool snapshot (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "Groups exact evidence lines by role, lists missing sections and explicitly marks every claim user-supplied, not independently verified. Does not scan a workspace, Git, sessions or private memory; does not run tests, certify deployment or create a checkpoint.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "snapshot",
      "contentSha": "66dc8ac5d0a2b0be8068fd8d6b1609daf3c0d6d6d32d93b7feb6e73fbf69ff89"
    },
    {
      "id": "weekly-review",
      "kind": "plugin",
      "name": "Weekly review",
      "summary": "Separate done, pending and blocked commitments into a review and proposed next plan.",
      "description": "Turn supplied accomplishments and explicitly done, pending or blocked commitments into a proposed next plan. Never changes tasks or calendars.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/",
      "documentation": "https://backstagecoding.com/sara/",
      "qualification": "Pinned source scope: Real permission-limited process handlers and deterministic host/model fixtures passed; checkPlugin ready and official smoke package checked. Not live account/model or deployed UI evidence.",
      "prerequisites": [
        "Sara >=2.65.0; manually reviewed/enabled native plugin",
        "Supply accomplishments (possibly empty) and a commitments array with explicit done, pending or blocked statuses.",
        "Optional model: latest owner conversation, configured background route and explicit metered-use invocation"
      ],
      "permissions": [
        "Own tool review (ask)",
        "Native cards",
        "Optional model: 4 calls/day, 12000 tokens/day",
        "Plugin-local KV only; no workspace, network, hooks, schedules, memory or external-tool calls"
      ],
      "limitations": [
        "Preserves user-reported accomplishments and status, separates done/pending/blocked, and proposes pending work in supplied order. Blocked items need resolution, not automatic scheduling. Empty context is refused. No calendar, task system, week dates, timezone, deadlines or completion status inferred.",
        "Supplied text max 5000 UTF-16 code units; model prompt max 7800. Serialized output max 60000 code units AND UTF-8 bytes; split sources or get notebook entries individually on refusal, never partial JSON.",
        "Model quality unverified; quotes do not verify interpretation. Generated text rejects ill-formed Unicode/forbidden controls; empty proposals explicitly report no-observations with translated warnings. No model result is saved.",
        "Source URL identifies Sara’s website, not a published download for this local candidate.",
        "Windows Node limits are not a full sandbox. Screenshots are labelled synthetic fixture previews, not live product acceptance.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Deterministic mode has no provider cost. Optional existing background model route may be cloud/billed; max 4 calls and 12000 metered tokens/day per plugin, 700 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "review",
      "contentSha": "30d254b70bba5666e6658feef20db553d5beeb7eea4b2fbed5955ab294fda581"
    },
    {
      "id": "inbox-triage",
      "kind": "plugin",
      "name": "Inbox triage",
      "summary": "Classify supplied messages and prepare unsent reply drafts. No mailbox connection or sending.",
      "description": "Classify supplied messages and prepare unsent reply drafts. No mailbox connection or sending. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data"
      ],
      "permissions": [
        "Adds workflow tool (ask)"
      ],
      "limitations": [
        "Supplied messages only; no connected mailbox.",
        "Keyword priorities and template replies require owner review; never sends.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "f7a59018afa23fa169abec45fabd3ffe07cdb3b074e202c13a5ce098cd5f84c4"
    },
    {
      "id": "content-studio",
      "kind": "plugin",
      "name": "Content studio",
      "summary": "Create reviewable drafts from a brief, locally or by explicit model request. Export text, never publish.",
      "description": "Create reviewable drafts from a brief, locally or by explicit model request. Export text, never publish. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data",
        "Configured existing background model route, latest owner conversation and budget only for useModel:true"
      ],
      "permissions": [
        "Adds workflow tool (ask)",
        "Model: 4 calls/day, 12000 tokens/day"
      ],
      "limitations": [
        "Local mode is a starter layout, not researched prose.",
        "Optional model draft has not been exercised against a real provider.",
        "No publishing or file-writing permission.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit.",
        "Optional model requests use the existing background route only when explicitly requested, with latest owner conversation routing. Host ceiling: 8000 prompt characters and 1000 output tokens; stricter workflow limits and manifest daily caps still apply. Cloud/provider costs may apply."
      ],
      "cost": "Local starter is free of model calls. Explicit useModel:true uses the owner background route and may incur provider charges; 4 calls/day, 12000 tokens/day; max 600 output tokens/request.",
      "privacy": "hybrid",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "4eba2d5aabecacff31a43c0c9cb1681e271793654ac70fc8171d56e517104023"
    },
    {
      "id": "image-workshop",
      "kind": "plugin",
      "name": "Image workshop",
      "summary": "Prepare and save structured image briefs, presets and prompts. Preparation only: no image generation.",
      "description": "Prepare and save structured image briefs, presets and prompts. Preparation only: no image generation. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data"
      ],
      "permissions": [
        "Adds workflow tool (ask)",
        "Own plugin-data read/write; one saved image brief through host KV"
      ],
      "limitations": [
        "Preparation only; no native image-generation tool or SDK discovery API.",
        "A saved prompt is not a generated image.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit.",
        "Version-1 canonical preset only; corrupt/old state preserved and refused. Save/clear claims require acknowledgement and matching validated readback. No stored generated/image field is trusted."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "c3246dc309a725e4f3d6d5c585b7c89b211ee2ad50c001eab55eed9370444a1a"
    },
    {
      "id": "spreadsheet-assistant",
      "kind": "plugin",
      "name": "Spreadsheet assistant",
      "summary": "Validate and profile supplied CSV, filter rows and export formula-safe CSV text. No XLSX or formula evaluation.",
      "description": "Validate and profile supplied CSV, filter rows and export formula-safe CSV text. No XLSX or formula evaluation. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data"
      ],
      "permissions": [
        "Adds workflow tool (ask)"
      ],
      "limitations": [
        "CSV text only, not XLSX or formula evaluation.",
        "50 data rows, 12 columns, 12000 source characters; numeric subset uses JS floating point.",
        "Apostrophe protection changes risky cells, including negative-number export.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "77bfa3b90c61eceeaf2673dca9eb7dcdc0656fad79fd6de468181fa4f869d1a5"
    },
    {
      "id": "travel-planner",
      "kind": "plugin",
      "name": "Travel planner",
      "summary": "Arrange confirmed supplied options into a dated itinerary and budget. Estimates only, never live quotes or bookings.",
      "description": "Arrange confirmed supplied options into a dated itinerary and budget. Estimates only, never live quotes or bookings. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data"
      ],
      "permissions": [
        "Adds workflow tool (ask)"
      ],
      "limitations": [
        "Supplied confirmed options only; no live quotes, availability or bookings.",
        "Calendar dates only; all supplied amounts must use one currency and be line totals.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit.",
        "Supported only USD/EUR/GBP/CAD/AUD/BRL/CHF:2 decimals; JPY/KRW:0; KWD/BHD/OMR:3. Exact integer minor-unit budget decisions; unsupported codes/precision refused."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "9c9959b1f4f29bcf34adbe949fc5e3a0e39749c5cd738aba8587d84a00d88a3a"
    },
    {
      "id": "home-dashboard",
      "kind": "plugin",
      "name": "Home dashboard",
      "summary": "List approved supplied device and scene metadata as a non-live snapshot. Preparation only, no home control.",
      "description": "List approved supplied device and scene metadata as a non-live snapshot. Preparation only, no home control. Manual, supplied-data workflow. Local candidate; publication pending.",
      "status": "in-testing",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Windows Node 24.20.0: permission-limited handlers pass 83/83 batch tests including 30 locale cases. Real PluginManager synthetic acceptance passes 18/18 across all twelve workflows: staging, explicit enablement, registered execution, result cards and disablement. Not full chat-approval, live provider/account or OS-sandbox qualification. Package checks are reported separately.",
      "prerequisites": [
        "Sara >=2.65.0 / Node >=24",
        "Owner review and enablement per companion",
        "Explicit supplied data"
      ],
      "permissions": [
        "Adds workflow tool (ask)"
      ],
      "limitations": [
        "Non-live supplied snapshot only; no Home Assistant connection inside this plugin.",
        "No host tools or device/scene control; broker approval timeout mismatch is not bypassed.",
        "Ready descriptions, native cards and generated prose support es/fr/de/pt-BR/it; protocol IDs/enums and supplied text unchanged. AI-drafted translations await human skim.",
        "Output capped at 3800 characters; reduce batch if it will not fit."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "workflow",
      "contentSha": "03673f78bf34878885d53643bc7aafffa6dc4c77b72a991b006da050758ef8e0"
    },
    {
      "id": "secret-scanner",
      "kind": "plugin",
      "name": "Secret scanner",
      "summary": "Detect credential patterns in explicitly supplied text files; return locations and value-free finding IDs. No automatic disk scan.",
      "description": "Find credential-pattern locations without returning secret values or source snippets.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Small documented pattern set, not entropy analysis, provider validation or a guarantee that no secrets remain.",
        "1–12 supplied files; 32768 UTF-16 units per file, 65536 aggregate UTF-8 bytes, 120 findings; no automatic disk/history scan.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "711494a247fdf7866e0fbe2a27c5338d8cdd3b45cc9836ff9df8a1581968befd"
    },
    {
      "id": "license-auditor",
      "kind": "plugin",
      "name": "License auditor",
      "summary": "Audit npm lockfile v2/v3 license metadata and SPDX expressions against an explicit allow/deny policy. Unknowns require review; not legal advice.",
      "description": "Turn npm lockfile license metadata into allow, deny or review decisions under your explicit SPDX policy.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Metadata policy assessment only; not source-license inspection, license compatibility or legal advice.",
        "Lockfile v2/v3 only: 65536 UTF-8 bytes and 60 installed paths; missing/custom metadata requires review.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "aac24b2fa7259f1a0ef0fbae60ff77a90ad9c9d2ab2f91d84f59f09dfdfbb87d"
    },
    {
      "id": "sbom-builder",
      "kind": "plugin",
      "name": "SBOM builder",
      "summary": "Build a deterministic CycloneDX 1.5 npm inventory from supplied lockfile v2/v3, including nested identities, purls and SRI hashes. No dependency install.",
      "description": "Produce a deterministic CycloneDX 1.5 npm inventory with nested identities, purls and checked SRI metadata.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Inventory only; no complete dependency graph, vulnerability scan, install or build. Hashes describe supplied metadata, not fetched artifact bytes.",
        "65536 UTF-8 bytes of lock JSON and 60 installed paths; workspace links refused and oversized output refuses.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "3fadff50b47d9e86b0740b5534e976ecf084e396053e000b2dfb0c3debe2621b"
    },
    {
      "id": "artifact-provenance-verifier",
      "kind": "plugin",
      "name": "Artifact provenance verifier",
      "summary": "Verify supplied artifact bytes using SHA-256, Ed25519, a pinned public-key fingerprint and expected identity. Local envelope v1 only, not Sigstore/SLSA.",
      "description": "Check supplied artifact bytes against the expected identity, digest and explicitly pinned Ed25519 signer.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Local envelope v1 only, not Sigstore, SLSA, transparency-log or publisher identity certification.",
        "Trust the expected signer fingerprint and identity separately; no network discovery or artifact download.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "befcfaab8f61ebccc8334adf50e03d4c0c6589b0a6fa22be6c457af5ebcdaade"
    },
    {
      "id": "coverage-explorer",
      "kind": "plugin",
      "name": "Coverage Explorer",
      "summary": "Read supplied LCOV, source and changed ranges; identify untested changed branches.",
      "description": "Identify untested changed branches with LCOV and supplied-source line citations.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Does not run tests or collect coverage; missing and unknown branch evidence is not treated as covered.",
        "LCOV limited to 100000 characters, 20 sources of 30000 characters and 100 changed ranges; contradictory function summaries refuse.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "907d35a9291b66c3115769c5c71937727585b61b6b8753fb0db73370e85c788d"
    },
    {
      "id": "log-explorer",
      "kind": "plugin",
      "name": "Log Explorer",
      "summary": "Search supplied structured and line logs with redacted messages and file/time citations.",
      "description": "Locate matching log events with redacted messages, file/line spans and timestamp evidence.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Supplied artifacts only, not a connected logging service. Pattern/literal redaction cannot guarantee detection of arbitrary secrets or encodings.",
        "At most 20 files, 100000 characters per file and 150000 aggregate; requested results at most 100. Pagination or uncertain timestamps makes completeness false.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "4d443b6983722697c6bc7a8a053781426b0339a78f5a1c18f5eb0cb3735bad76"
    },
    {
      "id": "incident-workbench",
      "kind": "plugin",
      "name": "Incident Workbench",
      "summary": "Assemble a cited chronology from supplied deployment, metric, alert and operator evidence; never infer causes.",
      "description": "Build a cited UTC incident chronology from correlated deployments, metrics, alerts and operator notes.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Chronology is not causation: cause and recovery claims remain cited claims; no inferred root cause or remediation execution.",
        "At most 20 files, 150000 aggregate characters and 100 requested events. Missing timezone, partial pages and unordered evidence remain explicit.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "a3eaa16e1cc364e1606d980a3145f4a14d79ad87120f7255bc072430a910f091"
    },
    {
      "id": "environment-config-doctor",
      "kind": "plugin",
      "name": "Environment Config Doctor",
      "summary": "Validate explicitly supplied dotenv or JSON against typed rules; return rule indices, never values or digests.",
      "description": "Identify missing and invalid configuration by rule index without exposing names, values or digests.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "No environment/vault import or file scan; output cannot erase secrets already supplied to host history.",
        "Conservative dotenv subset or flat scalar JSON only; no interpolation or multiline quoted dotenv. Malformed and duplicate decoded JSON keys refuse.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "e4cff7fd214625cbead09745efdbd3fb6f53ff7ae87839ec9bba83895f8d6de0"
    },
    {
      "id": "database-fixture-studio",
      "kind": "plugin",
      "name": "Database Fixture Studio",
      "summary": "Generate seeded synthetic relational rows and executable SQLite SQL from a bounded schema. No database connection or personal-data import.",
      "description": "Generate seeded synthetic relational rows plus SQLite DDL/INSERT text for repeatable test fixtures.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Does not connect to or populate a database, import personal rows or execute the generated SQL.",
        "6 tables, 12 columns per table, 100 rows per table and 200 total rows; unsupported constraints, cycles and impossible bounds refuse.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "bd09b7af7116ca6cc2df96bbe27d76e6b9dfc030787937c6159ccaff95cc1f00"
    },
    {
      "id": "data-contract-validator",
      "kind": "plugin",
      "name": "Schema and Data Contract Validator",
      "summary": "Validate explicit payloads and compare bounded JSON Schema draft-07 or Protobuf contracts using pinned libraries. Unsupported constructs are refused.",
      "description": "Compare bounded JSON Schema or Protobuf contracts and actually validate supplied payloads with pinned libraries.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Deliberately bounded JSON Schema draft-07 and flat Protobuf subset; unsupported refs, composition, imports and complex messages refuse. Not full standard compatibility.",
        "Contracts up to 16384 characters each; 20 payloads of 8192 characters. Wire compatibility does not imply JSON-name compatibility.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "809b4ad8ef8d1181bb545d7a6fa4f3b0f62d2b3c5122ade358d70e4cace4c407"
    },
    {
      "id": "change-impact-analyzer",
      "kind": "plugin",
      "name": "Change Impact Analyzer",
      "summary": "Map one changed function to statically resolved callers, packages and supplied tests. Explicit source snapshot only; no execution or runtime coverage claim.",
      "description": "Trace one changed function to statically resolved callers, packages and candidate supplied tests using AST evidence.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Static reachability, not executed tests or runtime coverage. Dynamic calls, escaping callbacks and unsupported resolution make the report incomplete.",
        "24 files, 8192 UTF-8 bytes per file and 32768 total source bytes. JS/JSX/TS/TSX ES modules only; no tsconfig aliases, CJS or project execution.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "845446ca51bb982389707127b8f69e9609b934d03258d8c8fde0f07956791958"
    },
    {
      "id": "architecture-guard",
      "kind": "plugin",
      "name": "Architecture Guard",
      "summary": "Check directed static module imports against explicit forbidden imports and layer rules; return evidenced dependency-cycle witnesses. Supplied source only, never execute a project.",
      "description": "Check directed module dependencies against explicit layer policy and return evidenced cycle witnesses.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds analyze tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Incomplete graphs return an unknown policy verdict, never a safe verdict. One witness per cyclic component, not all possible cycles.",
        "24 supplied files and 32768 total source bytes; static ES-module subset only, including type dependencies. No project config execution or automatic discovery.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "analyze",
      "contentSha": "bfb96872b64a0ea440903d60c590829cc72a8af6c00f85dba20316cdd0f72a79"
    },
    {
      "id": "sql-migration-reviewer",
      "kind": "plugin",
      "name": "SQL Migration Reviewer",
      "summary": "Rehearse bounded additive SQLite DDL in disposable memory with synthetic rows and rollback evidence. No live database or workspace access.",
      "description": "Execute admitted additive SQLite DDL in disposable memory, verify rollback and return schema/count/hash evidence.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "Node SQLite with working setAuthorizer enforcement; Node 24.20.0 was exercised. Unsupported runtimes refuse."
      ],
      "permissions": [
        "Adds rehearse tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "SQLite-only closed additive grammar, not a production migration safety, locking, performance or cross-dialect assessment. No live database or apply operation.",
        "8192 SQL UTF-8 bytes, 512 tokens and 8 statements; baseline at most 8 tables and 400 synthetic rows. No hard in-process wall-clock or OS sandbox guarantee.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "rehearse",
      "contentSha": "a130a2c3eac7daa967839a90ed5e9c1b93d93756f8516f623900b03972677f06"
    },
    {
      "id": "visual-regression",
      "kind": "plugin",
      "name": "Visual Regression",
      "summary": "Compare supplied PNG pairs offline at desktop/phone sizes. Exact pixels only; no capture or URL access. Supplied images may be sensitive.",
      "description": "Compare supplied PNG pairs by exact decoded RGBA8 pixels, changed-pixel count and bounding rectangle.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds compare tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Exact pixel equality only, not perceptual significance, anti-alias tolerance or color management; invisible RGB changes count. No capture, browser or URL access.",
        "One or two pairs; RGB/RGBA8 noninterlaced PNG only, no ancillary chunks; 10000 bytes per PNG and 60000 serialized input bytes. Unsupported ordinary PNGs require explicit external conversion.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "compare",
      "contentSha": "87eda29c956f198f0352d2aa4585618dd82bc30d93cce30834ff948280e4f4fe"
    },
    {
      "id": "localization-qa",
      "kind": "plugin",
      "name": "Localization QA",
      "summary": "Check flat catalogs, named placeholders and supplied owned-fixture render measurements. No live capture or workspace access.",
      "description": "Find missing keys and named-placeholder mismatches; derive overflow only from supplied owned-fixture measurements.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds check tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "No live capture or translation-quality verdict. Absent render evidence is not-measured; coherent measurement hashes are not authenticated capture proof.",
        "32 keys, 512 UTF-16 units per value, 24000 UTF-8 bytes per raw catalog; combined escaped request must fit 65536 UTF-16 units. Named-v1 only, not ICU or printf validation.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "check",
      "contentSha": "e1fba1dfb62738cf60b80e80ecfdb859b523c4622d640074b1851ab007795b6e"
    },
    {
      "id": "accessibility-auditor",
      "kind": "plugin",
      "name": "Accessibility Auditor",
      "summary": "Analyze supplied HTML offline. Structural findings only; no live capture, rendering or WCAG verdict. HTML may be sensitive.",
      "description": "Find bounded HTML5 structural and naming-uncertainty issues with source offsets and AST references.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds audit tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Static findings, not confirmed rendered violations, complete accessible-name computation or WCAG conformance. Contrast, focus, layout and dynamic states require browser review.",
        "6000 UTF-16 input units / 24KB UTF-8; 512 tree nodes, depth 32 and 64 findings. Default browser evidence is recorded owned-fixture evidence, not a fresh/live capture.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "audit",
      "contentSha": "b010936d96d1e7cf48d1d6d8a92e36412aed0dd08fefd732a4679bea882b2e42"
    },
    {
      "id": "build-cache-inspector",
      "kind": "plugin",
      "name": "Build Cache Inspector",
      "summary": "Measure an operator-staged native-home cache and preview pruning. No changes or selected-project access.",
      "description": "Measure actual staged TypeScript cache files and produce an immutable pruning preview without applying it.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages ordinary TypeScript build outputs in its own native data home; keep staging quiescent and retain the local ordinal mapping."
      ],
      "permissions": [
        "Adds inspect tool (Ask)",
        "Own plugin-data read only; no writes or selected-project access.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Own native data home only, not selected-project or full-owner-cache access. No deletion, apply, compiler execution or hit-rate inference; logical bytes are not guaranteed disk recovery.",
        "Trusted quiescent staging required; 128 files, 256 entries, depth 8 and 16MiB hash reads. Not hostile-writer race-proofing or NTFS alternate-stream enumeration; refusals use fixed English text.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "inspect",
      "contentSha": "6ab10645c5107600e58fe9039e678c3344fa8d6e532f4bb2e1c00e0d6a8f5e6b"
    },
    {
      "id": "api-contract-guard",
      "kind": "plugin",
      "name": "API Contract Guard",
      "summary": "Compare bounded OpenAPI JSON contracts offline.",
      "description": "Identify breaking request/response changes in supplied OpenAPI JSON using directional acceptance rules and document pointers.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with Sara 2.70.0 on Windows (Node 24.20.0) and Linux (Node 24.22.1): registered tool execution, invocation cards, refusal and disablement checks passed against the exact approved package bytes. Linux default bubblewrap package smoke also passed. These are bounded add-on checks, not full-app or ordinary chat-approval acceptance. Signed availability is shown separately from the publication snapshot.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model."
      ],
      "permissions": [
        "Adds compare tool (Ask)",
        "No filesystem read/write grants; explicit supplied inputs only.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Fail-closed OpenAPI 3.0/3.1 JSON subset, not a full OpenAPI/JSON Schema validator. No YAML, remote refs, composition, security requirements or model interpretation.",
        "Document-pointer evidence only, not file/hash or executed API evidence. Per-document 256KiB and 128 findings; the real host combined argument limit also applies.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "0.1.0",
      "tool": "compare",
      "contentSha": "c39908850908954074398dc6282136eb6a35e75a088de0f8b5473472547ec4ee"
    },
    {
      "id": "http-webhook-workbench",
      "kind": "plugin",
      "name": "HTTP and Webhook Workbench",
      "summary": "Send a loopback HTTP request and optionally replay once. Calls can have effects. Sensitive fields are redacted.",
      "description": "Send bounded HTTP requests through Sara's existing socket broker to an explicitly configured local developer service; compare actual responses from an optional single replay. This is not a public webhook listener.",
      "status": "tested",
      "costTier": "unconfirmed",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Qualified with actual Sara 2.70.0 modules: 26/26 focused tests passed on Windows Node 24.20.0 (node-only) and Linux Node 24.22.1 (default bubblewrap fixture lifecycle). Both exercise an owned loopback listener, actual replay, redaction, response refusals, result cards and disablement; source, archive and manager-approved runtime bytes match across platforms. Actual 2.70.0 chat approval with a scripted provider also passed: denial sent zero requests, approval sent the request plus replay and returned a redacted card. Timing admission witnesses use mocked monotonic time, not delayed real TCP handshakes. This does not claim generic OS sandbox safety, a real provider/account or owner UI acceptance. Signed availability is determined separately by the current Store snapshot.",
      "prerequisites": [
        "Sara >=2.70.0 <3.0.0; Node 24+",
        "Review installation trust, configure endpoint as literal 127.0.0.1:port, and explicitly enable for the intended companion; request tool defaults Ask.",
        "Use an owned, authorized local developer service and synthetic data. Tool arguments may be retained by host history or shared with its configured model; redaction cannot erase already-supplied arguments."
      ],
      "permissions": [
        "Adds request tool (Ask). Loopback calls can have side effects, including modifying or deleting data.",
        "Existing Sara socket broker only: settings-selected literal 127.0.0.1:port, local non-TLS connection. No direct network SDK bypass, public/LAN host access or workspace/filesystem grants.",
        "Reads configured endpoint setting; no model/provider calls, memory store, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only; private-local mode blocks the broker."
      ],
      "limitations": [
        "GET/POST/PUT/PATCH/DELETE/HEAD only; empty or object/array JSON bodies and simple origin-form paths. No URL queries, percent escapes, fragments, redirects, chunking, compression, informational responses or streaming.",
        "4096 UTF-8 request-body bytes, 8192 response-body bytes, 4096 response-header bytes and 12288 total response bytes; at most 12 headers of 512 ASCII characters. Shared 20-second monotonic invocation budget includes both connections, responses and optional replay; at most two requests.",
        "Replay explicitly repeats the approved method once; duplication may repeat non-idempotent side effects. No automatic retries or rollback: response refusal or timeout does not undo an already-sent request.",
        "Bounded sensitive-field/known-value redaction only, not arbitrary secrets, encoded secrets or personal data detection. Do not put secrets in paths or public headers. Duplicate decoded JSON keys and redacted-key collisions visibly refuse; no new secret manager or saved recordings.",
        "Linux bubblewrap qualification covers this actual brokered fixture lifecycle, not general hostile-code isolation. Chat acceptance used a scripted model, not a paid provider or real owner account. Check the current signed Store for installation availability."
      ],
      "cost": "The plugin itself makes no model/provider calls, but does make local HTTP requests. The configured local service may incur its own costs; review that service separately.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "request",
      "contentSha": "cafef41c0d07665c6f676f049024e5d0dd2cda92d24bbfced230f02d50db7d45"
    }
,
    {
      "id": "performance-regression-lab",
      "kind": "plugin",
      "name": "Performance Regression Lab",
      "summary": "Run staged baseline and candidate benchmarks interleaved in a fenced context and report regressions from raw samples.",
      "description": "Measure staged baseline and candidate benchmark scripts with interleaved warm-up and samples, return every raw sample and call a regression only when the interval clears your threshold.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Tested on Windows (Node 24.20.0) against the current development source: official package smoke, real manager approval, explicit enablement, registered execution on synthetic staged fixtures, invocation cards and disablement passed for the exact package bytes. Not Linux, signed-release or ordinary chat-approval acceptance.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages self-contained baseline.js and candidate.js benchmark scripts in its own native data home; stage only code you trust."
      ],
      "permissions": [
        "Adds compare tool (Ask)",
        "Own plugin-data read only; no writes or selected-project access.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Runs staged scripts in a Node vm context inside the permission-limited plugin process; Node vm is not a security boundary and Windows node-only mode is not an OS sandbox. No compilers, commands or project access.",
        "5–60 samples per side, 20 s worst case, 256 KiB per script. Noisy or underpowered runs are inconclusive without a percentage; one machine's timings do not predict other hardware.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "compare",
      "contentSha": "d020d786c5ee513488d2e03e4a44c2c5450065d26f2695aa2cdf5ff486312bef"
    },
{
      "id": "code-migration-studio",
      "kind": "plugin",
      "name": "Code Migration Studio",
      "summary": "Preview an AST-based import rename in an operator-staged workspace and apply only the approved hash-bound patch.",
      "description": "Preview a scope-aware AST rename of one named import across explicitly selected files, then apply only that exact hash-bound patch and verify every written file.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Tested on Windows (Node 24.20.0) against the current development source: official package smoke, real manager approval, explicit enablement, registered execution on synthetic staged fixtures, invocation cards and disablement passed for the exact package bytes. Not Linux, signed-release or ordinary chat-approval acceptance.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages a disposable copy of the project in its own native data home; compile and test the migrated copy before taking changes back."
      ],
      "permissions": [
        "Adds migrate tool (Ask)",
        "Reads and writes only its own plugin data (the staged workspace copy); no main-workspace or selected-project access.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "One versioned codemod (rename-named-import v1) for .js/.mjs files; namespace imports, re-exports, dynamic imports, reassignment and name conflicts refuse. Not TypeScript or general refactoring.",
        "Up to 32 selected files of 256 KiB; links, unselected files, stale hashes and syntax errors refuse without writes. The plugin runs no compiler or tests itself.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "migrate",
      "contentSha": "b9c701b12d67bda7633c863ffa44f286ab582a2ba1c1d13e1596a534bb5de63c"
    },
{
      "id": "build-reproducibility-inspector",
      "kind": "plugin",
      "name": "Build Reproducibility Inspector",
      "summary": "Build a staged fixture twice in fenced contexts, compare artifact hashes and explain timestamp or path nondeterminism.",
      "description": "Run a staged fixture build twice in fresh contexts with different clocks and build roots, compare per-file and tree hashes and explain timestamp or path differences from the artifacts.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Tested on Windows (Node 24.20.0) against the current development source: official package smoke, real manager approval, explicit enablement, registered execution on synthetic staged fixtures, invocation cards and disablement passed for the exact package bytes. Not Linux, signed-release or ordinary chat-approval acceptance.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages build.js and a source folder in its own native data home; stage only build code you trust."
      ],
      "permissions": [
        "Adds inspect tool (Ask)",
        "Own plugin-data read only; no writes or selected-project access.",
        "No network, model, shell, delegated tools, schedules or independent card posts. Invocation-scoped result cards only."
      ],
      "limitations": [
        "Runs a staged JavaScript build function in Node vm contexts inside the permission-limited plugin process, not compilers, package managers or child processes; Node vm is not a security boundary.",
        "64 source files of 1 MiB total and 64 outputs of 4 MiB. Only clock and build-root variation is explained; other differences stay unexplained with the first differing byte.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "inspect",
      "contentSha": "f60aab7f3aed849ad2700e237f87da6109b55b13faf1ac329c82d1ae5fccc951"
    },
{
      "id": "test-doctor",
      "kind": "plugin",
      "name": "Test Doctor",
      "summary": "Run one exactly named test of a staged project in a disposable copy and point at its failing assertion and the source it calls.",
      "description": "Run one exactly named test of a staged project once in a disposable copy you approve, read the real test report and point at the failing assertion, its expected and actual values and the source it calls.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Tested on Windows (Node 24.20.0) against the current development source: official package smoke, real manager approval, explicit enablement, registered execution on synthetic staged fixtures, invocation cards and disablement passed for the exact package bytes. Not Linux, signed-release or ordinary chat-approval acceptance.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages the project as plain files under projects/<name> in its own native data home; stage only code you trust to run."
      ],
      "permissions": [
        "Adds diagnose tool (Ask)",
        "Own plugin-data read only; no writes or selected-project access.",
        "Each run asks Sara for one job you approve: node in a disposable copy of its staged project, no network; the copy is deleted afterwards. No model, shell or delegated tools."
      ],
      "limitations": [
        "Not OS-sandboxed on Windows or macOS: Node's permission model limits the job to the disposable copy (no child processes). OS-sandboxed with bubblewrap on Linux.",
        "Node test files only, one exactly named test per run. Timeouts, todo (expected) failures and non-assertion errors get no root cause; the called source is located by import name, not proven to be the fix.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "diagnose",
      "contentSha": "eaa0f3634a34a5e7bcc6e0cc54bd7954b4e6c30fbac270d65d2b33a1718b1346"
    },
{
      "id": "flaky-test-lab",
      "kind": "plugin",
      "name": "Flaky Test Lab",
      "summary": "Repeat one exactly named test of a staged project in a disposable copy and tell flaky from stable failures, with every seed's outcome.",
      "description": "Repeat one exactly named test of a staged project up to 20 times in one job you approve, keep every seed's outcome and duration, and call it flaky only when it both passed and failed.",
      "status": "tested",
      "costTier": "local-only",
      "source": "https://backstagecoding.com/sara/store/",
      "documentation": "https://backstagecoding.com/sara/store/",
      "qualification": "Pinned source scope: Tested on Windows (Node 24.20.0) against the current development source: official package smoke, real manager approval, explicit enablement, registered execution on synthetic staged fixtures, invocation cards and disablement passed for the exact package bytes. Not Linux, signed-release or ordinary chat-approval acceptance.",
      "prerequisites": [
        "Sara >=2.68.0 <3.0.0; Node 24+",
        "Review installation trust and explicitly enable for the intended companion; tool access defaults Ask.",
        "Supply only authorized, bounded inputs; tool arguments may be retained in host review/history or shared with its configured model.",
        "With the plugin disabled, a trusted operator stages the project as plain files under projects/<name> in its own native data home; stage only code you trust to run."
      ],
      "permissions": [
        "Adds repeat tool (Ask)",
        "Reads and writes only its own plugin data (the staged workspace copy); no main-workspace or selected-project access.",
        "Each run asks Sara for one job you approve: node in a disposable copy of its staged project, no network; the copy is deleted afterwards. No model, shell or delegated tools."
      ],
      "limitations": [
        "Not OS-sandboxed on Windows or macOS: Node's permission model limits the job to the disposable copy (no child processes). OS-sandboxed with bubblewrap on Linux.",
        "2–20 repetitions as fresh module imports seeded through globalThis.SARA_FLAKY_SEED; state outside the module is shared between repetitions. Stopped, timed-out or incomplete runs give no verdict.",
        "Local qualification is separate from signed release and current availability; check Sara after publication."
      ],
      "cost": "No model or API requests. Local machine resources only.",
      "privacy": "local",
      "version": "1.0.0",
      "tool": "repeat",
      "contentSha": "53fc914fc8b50a90c4962c21317c06496ce2bf9afed091da0834de35a90893de"
    }
  ],
  "investigations": [
    {
      "id": "markitdown",
      "kind": "mcp",
      "name": "MarkItDown",
      "summary": "Convert a selected document to Markdown.",
      "description": "Convert a selected document to Markdown. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://raw.githubusercontent.com/microsoft/markitdown/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/microsoft/markitdown/HEAD/README.md",
      "qualification": "Pinned source scope: Windows direct stdio discovery and synthetic local TXT/HTML conversion passed with explicit prerelease dependency handling. Sara-host installation and OS-enforced file/network bounds remain unqualified.",
      "prerequisites": [
        "uvx, Python >=3.10 and OS-level restricted execution for any local files or network access"
      ],
      "permissions": [
        "Can read local files and fetch supplied URLs",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Synthetic conversions only; no broad filesystem fence is promised. UV_PRERELEASE=allow is explicit because unchanged dependency resolution failed; transitive dependencies remain unlocked.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Local code is free; optional cloud/model services cost extra.",
      "privacy": "hybrid",
      "recipePreview": {
        "transport": "stdio",
        "command": "uvx",
        "args": [
          "markitdown-mcp==0.0.1a8"
        ],
        "environment": [
          {
            "name": "UV_PRERELEASE",
            "publicValue": "allow",
            "purpose": "Allows prerelease dependencies required by this preview pin. This is not a transitive lock; review the resolved dependency inventory before use with real files."
          }
        ],
        "substitutions": [],
        "secrets": [],
        "guide": [
          "Requires uvx and Python >=3.10. Runtime fixtures used existing Python 3.12; other interpreter/platform combinations remain unqualified.",
          "This prerelease dependency policy is explicit: UV_PRERELEASE=allow was required for resolution. Dependencies are not transitively locked; use only isolated preview execution pending a reviewed lock policy.",
          "Use a separate restricted OS user or sandbox; this tool can read files available to its user.",
          "Approve each conversion. Prefer sanitized data URIs until filesystem/network bounds are verified.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "notion",
      "kind": "mcp",
      "name": "Notion",
      "summary": "Search and edit shared Notion pages.",
      "description": "Search and edit shared Notion pages. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://raw.githubusercontent.com/makenotion/notion-mcp-server/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/makenotion/notion-mcp-server/HEAD/README.md",
      "qualification": "Pinned source scope: Official local server is no longer maintained or supported; preferred hosted OAuth is not implemented by Sara.",
      "prerequisites": [
        "Notion account and OAuth consent"
      ],
      "permissions": [
        "Reads and writes workspace pages under granted scopes",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official local server is no longer maintained or supported; preferred hosted OAuth is not implemented by Sara.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Notion account and plan limits apply.",
      "privacy": "external"
    },
    {
      "id": "tavily",
      "kind": "mcp",
      "name": "Tavily",
      "summary": "Search the web and extract page content.",
      "description": "Search the web and extract page content. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "needs-account",
      "costTier": "provider",
      "source": "https://raw.githubusercontent.com/tavily-ai/tavily-mcp/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/tavily-ai/tavily-mcp/HEAD/README.md",
      "qualification": "Pinned source scope: Windows initialize/tools-list answered; no authenticated vendor feature or Sara-host execution.",
      "prerequisites": [
        "Tavily account and API key"
      ],
      "permissions": [
        "Sends queries and URLs to Tavily; crawl/search may consume credits",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "No authenticated search or extraction executed.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "API credits and plan limits apply; no paid calls made.",
      "privacy": "external",
      "recipePreview": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "tavily-mcp@0.2.22"
        ],
        "environment": [],
        "substitutions": [],
        "secrets": [
          {
            "key": "TAVILY_API_KEY",
            "purpose": "Your own Tavily API key, kept in the vault. Searches, extraction, crawling and research can consume provider credits."
          }
        ],
        "guide": [
          "Use Node 24 LTS; confirm node --version before setup. The dependency check detects presence, not the runtime version.",
          "Add your own API key in the vault-backed secret field.",
          "Test only checks connection/tool discovery. Review credit limits before approving a search or crawl.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "firecrawl",
      "kind": "mcp",
      "name": "Firecrawl",
      "summary": "Scrape selected public pages into readable documents.",
      "description": "Scrape selected public pages into readable documents. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "needs-account",
      "costTier": "provider",
      "source": "https://raw.githubusercontent.com/mendableai/firecrawl-mcp-server/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/mendableai/firecrawl-mcp-server/HEAD/README.md",
      "qualification": "Pinned source scope: Windows initialize/tools-list answered; no authenticated vendor feature or Sara-host execution.",
      "prerequisites": [
        "Firecrawl account and API key"
      ],
      "permissions": [
        "Sends target URLs and scrape options to Firecrawl; may run billable jobs",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "No authenticated scrape, crawl or browser execution.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Provider credits and plan limits apply; no paid calls made.",
      "privacy": "external",
      "recipePreview": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "firecrawl-mcp@3.37.0"
        ],
        "environment": [],
        "substitutions": [],
        "secrets": [
          {
            "key": "FIRECRAWL_API_KEY",
            "purpose": "Your own Firecrawl key, kept in the vault. Calls can spend credits or start jobs. Set and verify every host tool permission before use; recipe advice alone does not force approval."
          }
        ],
        "guide": [
          "Use Node 24 LTS; this pinned package requires Node >=22.0.0. Confirm node --version before setup; dependency presence does not check its version.",
          "Add your own API key. No provider key or paid call was used in qualification.",
          "Review every tool, especially monitor, crawl and interact tools. Discovery is not authenticated scraping qualification.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "chrome-devtools",
      "kind": "mcp",
      "name": "Chrome DevTools",
      "summary": "Inspect and automate a separate test Chrome browser.",
      "description": "Inspect and automate a separate test Chrome browser. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/HEAD/README.md",
      "qualification": "Pinned source scope: Windows direct stdio discovery and four isolated headless loopback-browser fixture calls passed. No real account, external navigation, upload or Sara-host execution.",
      "prerequisites": [
        "Node 24 LTS and Google Chrome; verify the installed runtime version explicitly"
      ],
      "permissions": [
        "Reads browser content, network requests and console; can navigate and execute JavaScript",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Only isolated browser profiles are appropriate; telemetry and CrUX disabled in recipe.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed.",
        "Only an owned loopback page was navigated and inspected with an isolated temporary profile. Real sites, signed-in profiles and uploads remain unqualified. Recipe workspace uses ${home}."
      ],
      "cost": "Server code is free; visited sites may have their own charges.",
      "privacy": "hybrid",
      "recipePreview": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "chrome-devtools-mcp@1.12.0",
          "--isolated",
          "--headless",
          "--no-usage-statistics",
          "--no-performance-crux",
          "--workspace",
          "${home}"
        ],
        "environment": [
          {
            "name": "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS",
            "publicValue": "1",
            "purpose": "Keeps the pinned tool from checking npm for updates while it runs. Review and update the pin separately."
          }
        ],
        "substitutions": [
          {
            "key": "${home}",
            "purpose": "Replace with a dedicated disposable workspace folder; never your whole home folder."
          }
        ],
        "secrets": [],
        "guide": [
          "Use Node 24 LTS. Upstream accepts ^20.19.0, ^22.12.0 or >=23. Confirm node --version; dependency presence does not validate this range.",
          "Uses a separate temporary Chrome profile, not your personal signed-in browser.",
          "Telemetry and CrUX lookups are disabled; filesystem tools are restricted to this server folder.",
          "Only an owned loopback page was navigated and inspected in an isolated headless browser. No external site, signed-in profile, upload or real-user page was tested.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "serena",
      "kind": "mcp",
      "name": "Serena",
      "summary": "Explore symbols and refactor a chosen code project.",
      "description": "Explore symbols and refactor a chosen code project. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "mixed",
      "source": "https://raw.githubusercontent.com/oraios/serena/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/oraios/serena/HEAD/README.md",
      "qualification": "Pinned source scope: Current official docs explicitly advise against MCP marketplace installs; initialization and project bounds not qualified.",
      "prerequisites": [
        "uv, Python 3.13, explicit initialization and language dependencies"
      ],
      "permissions": [
        "Project reads/writes, language servers, optional shell execution",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Current official docs explicitly advise against MCP marketplace installs; initialization and project bounds not qualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Open-source LSP mode; optional JetBrains plugin is paid.",
      "privacy": "local"
    },
    {
      "id": "dbhub",
      "kind": "mcp",
      "name": "DBHub",
      "summary": "Explore a dedicated database using SQL tools.",
      "description": "Explore a dedicated database using SQL tools. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://raw.githubusercontent.com/bytebase/dbhub/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/bytebase/dbhub/HEAD/README.md",
      "qualification": "Pinned source scope: Windows initialize/tools-list and bundled in-memory demo SELECT returned fixture_value=7. Real DSN, database-enforced read-only credentials and authenticated databases remain unqualified.",
      "prerequisites": [
        "Node 22.5+, dedicated test database and database-enforced read-only credentials; no administrator or production DSN"
      ],
      "permissions": [
        "SQL can read and modify database records; DSNs may contain credentials",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Never treat execute_sql as universally read-only; no real database access authorized.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed.",
        "Demo fixture execution is not database read-only enforcement qualification. SQL remains in ask advice, never auto advice."
      ],
      "cost": "Server code is free; remote database hosting may cost.",
      "privacy": "hybrid",
      "recipePreview": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@bytebase/dbhub@1.5.1",
          "--transport",
          "stdio"
        ],
        "environment": [],
        "substitutions": [],
        "secrets": [
          {
            "key": "DSN",
            "purpose": "Connection string for a dedicated test database using enforced read-only credentials. Stored in the vault; never use a production administrator DSN."
          }
        ],
        "guide": [
          "Use Node 24 LTS; this pinned package requires Node >=22.5.0. Confirm node --version before setup; dependency presence does not check its version.",
          "Provision database-enforced read-only credentials before adding this server.",
          "Never connect a production administrator DSN. SQL tools are not automatically approved.",
          "Only a bundled in-memory demo SELECT was executed, not a real database connection.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "supabase",
      "kind": "mcp",
      "name": "Supabase",
      "summary": "Inspect a development Supabase project.",
      "description": "Inspect a development Supabase project. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://raw.githubusercontent.com/supabase-community/supabase-mcp/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/supabase-community/supabase-mcp/HEAD/README.md",
      "qualification": "Pinned source scope: Hosted setup requires OAuth absent in Sara; current self-host handler rejects legacy 2025 protocol; local CLI alternative unqualified.",
      "prerequisites": [
        "Supabase account, development project and OAuth consent"
      ],
      "permissions": [
        "SQL and management tools can modify projects; use project scoping and read_only=true",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Hosted setup requires OAuth absent in Sara; current self-host handler rejects legacy 2025 protocol; local CLI alternative unqualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Supabase plan and resource costs apply.",
      "privacy": "external"
    },
    {
      "id": "figma",
      "kind": "mcp",
      "name": "Figma",
      "summary": "Read design context for an approved Figma file.",
      "description": "Read design context for an approved Figma file. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
      "documentation": "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
      "qualification": "Pinned source scope: Remote server requires OAuth not implemented in Sara; desktop alternative needs an eligible running app and is unqualified.",
      "prerequisites": [
        "Figma account and OAuth consent"
      ],
      "permissions": [
        "Exposes design/file context permitted by account",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Remote server requires OAuth not implemented in Sara; desktop alternative needs an eligible running app and is unqualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Figma account, seat and rate limits apply.",
      "privacy": "external"
    },
    {
      "id": "drawio",
      "kind": "mcp",
      "name": "draw.io",
      "summary": "Prepare editable diagrams and diagram references.",
      "description": "Prepare editable diagrams and diagram references. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "in-testing",
      "costTier": "mixed",
      "source": "https://raw.githubusercontent.com/jgraph/drawio-mcp/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/jgraph/drawio-mcp/HEAD/README.md",
      "qualification": "Pinned source scope: Windows initialize/tools-list answered; local fixture executed; no authenticated vendor feature or Sara-host execution.",
      "prerequisites": [
        "Node 24 LTS; keep browser-opening and diagram-editing tools Off until separately qualified"
      ],
      "permissions": [
        "Can open a browser; loads editor assets and optional shape/icon services",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "No Sara inline MCP Apps renderer is claimed; tool server preview only.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed.",
        "Reference retrieval only. Version 1.10.1 can open the default browser and ignores DRAWIO_BROWSER; no link-only guarantee is made. External icon lookup is off, but editor/shape/layout downloads are not an offline guarantee."
      ],
      "cost": "Tool server is free; hosted LLM costs are separate.",
      "privacy": "hybrid",
      "recipePreview": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@drawio/mcp@1.10.1"
        ],
        "environment": [
          {
            "name": "DRAWIO_ICON_SERVICE_URL",
            "publicValue": "off",
            "purpose": "Disables external icon supplementation. Editor assets, shape indexes and optional layout code may still require network downloads."
          }
        ],
        "substitutions": [],
        "secrets": [],
        "guide": [
          "Use Node 24 LTS; confirm node --version before setup. The dependency check detects presence, not the runtime version.",
          "This pinned release opens diagram URLs in your default browser. It has no supported browser-disable flag. Set open_drawio_* and set_page to Off; only reference retrieval was exercised.",
          "Only XML-reference retrieval was exercised. Opening/rendering diagrams and page edits remain unqualified.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "google-workspace",
      "kind": "mcp",
      "name": "Google Workspace",
      "summary": "Work with explicitly authorized Workspace documents.",
      "description": "Work with explicitly authorized Workspace documents. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://raw.githubusercontent.com/googleworkspace/cli/HEAD/README.md",
      "documentation": "https://raw.githubusercontent.com/googleworkspace/cli/HEAD/README.md",
      "qualification": "Pinned source scope: Official CLI investigated; no verified current MCP launch contract or bounded recipe in this qualification.",
      "prerequisites": [
        "Google Cloud project, enabled APIs, scoped credentials and gws CLI"
      ],
      "permissions": [
        "Potential Gmail, Drive, Calendar and document reads/writes by selected APIs",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official CLI investigated; no verified current MCP launch contract or bounded recipe in this qualification.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Google account, Workspace/API quotas and plan charges apply.",
      "privacy": "external"
    },
    {
      "id": "microsoft-365",
      "kind": "mcp",
      "name": "Microsoft 365",
      "summary": "Investigate governed Microsoft 365 agent tools.",
      "description": "Investigate governed Microsoft 365 agent tools. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview",
      "documentation": "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview",
      "qualification": "Pinned source scope: Official Agent 365 documentation distinguishes Work IQ MCP and Microsoft-hosted tool servers. Tenant identity, Entra scopes/audience, admin governance and a Sara-compatible authenticated connection remain unqualified.",
      "prerequisites": [
        "Microsoft 365 tenant and Agent 365 administrator setup"
      ],
      "permissions": [
        "Tenant-scoped business information and possible writes",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official Agent 365 documentation distinguishes Work IQ MCP and Microsoft-hosted tool servers. Tenant identity, Entra scopes/audience, admin governance and a Sara-compatible authenticated connection remain unqualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Tenant, licensing and service limits apply.",
      "privacy": "external"
    },
    {
      "id": "slack",
      "kind": "mcp",
      "name": "Slack",
      "summary": "Search approved Slack messages and draft replies.",
      "description": "Search approved Slack messages and draft replies. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://docs.slack.dev/ai/slack-mcp-server/",
      "documentation": "https://docs.slack.dev/ai/slack-mcp-server/",
      "qualification": "Pinned source scope: Official MCP requires confidential OAuth client credentials and consent; Sara has no OAuth lifecycle.",
      "prerequisites": [
        "Slack app identity, confidential OAuth and admin consent as required"
      ],
      "permissions": [
        "Searches messages and may send messages or manage canvases/files",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official MCP requires confidential OAuth client credentials and consent; Sara has no OAuth lifecycle.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Slack account, plan and API limits apply.",
      "privacy": "external"
    },
    {
      "id": "linear",
      "kind": "mcp",
      "name": "Linear",
      "summary": "Find issues and prepare project updates.",
      "description": "Find issues and prepare project updates. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "needs-account",
      "costTier": "provider",
      "source": "https://linear.app/docs/mcp",
      "documentation": "https://linear.app/docs/mcp",
      "qualification": "Pinned source scope: Official static Bearer HTTP path documented; no account or remote protocol execution.",
      "prerequisites": [
        "Linear account and restricted personal API key"
      ],
      "permissions": [
        "Reads and may mutate issues, projects and comments within token permissions",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official HTTP endpoint supports static Bearer API keys; account execution not performed.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Linear account and plan limits apply.",
      "privacy": "external",
      "recipePreview": {
        "transport": "http",
        "url": "https://mcp.linear.app/mcp",
        "secrets": [
          {
            "key": "LINEAR_API_KEY",
            "purpose": "Use a restricted Linear API key. It is sent only as an Authorization header, not in the URL. OAuth login/refresh is not implemented here.",
            "header": "Authorization",
            "prefix": "Bearer "
          }
        ],
        "guide": [
          "Create a restricted API key in Linear and review the granted workspace/project access.",
          "This is the documented static Bearer path, not OAuth. No account was connected or issue changed.",
          "After Test, inspect discovered tools and set explicit approval permissions before using them.",
          "After discovery, open Settings → Coding → Tools and approvals. Set every tool in this server's group to Ask me first or Off before sending any request.",
          "Save, leave and reopen the page; read back every tool setting. Repeat after restart, update or newly discovered tools. Stop if settings cannot be confirmed."
        ]
      }
    },
    {
      "id": "atlassian",
      "kind": "mcp",
      "name": "Atlassian Jira / Confluence",
      "summary": "Retrieve permitted Jira and Confluence context.",
      "description": "Retrieve permitted Jira and Confluence context. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
      "documentation": "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
      "qualification": "Pinned source scope: Official HTTP endpoint supports admin-enabled personal API tokens (Basic) or service-account API keys (Bearer), as well as OAuth. Tenant enablement, scopes and actual tool protocol are unqualified; no install recipe offered.",
      "prerequisites": [
        "Atlassian Cloud site, admin policy and authentication setup"
      ],
      "permissions": [
        "Can read and change issues or pages within granted scopes",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official HTTP endpoint supports admin-enabled personal API tokens (Basic) or service-account API keys (Bearer), as well as OAuth. Tenant enablement, scopes and actual tool protocol are unqualified; no install recipe offered.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Atlassian account, plan and usage limits apply.",
      "privacy": "external"
    },
    {
      "id": "home-assistant",
      "kind": "mcp",
      "name": "Home Assistant",
      "summary": "Inspect or control devices explicitly exposed to an assistant.",
      "description": "Inspect or control devices explicitly exposed to an assistant. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "mixed",
      "source": "https://www.home-assistant.io/integrations/mcp_server/",
      "documentation": "https://www.home-assistant.io/integrations/mcp_server/",
      "qualification": "Pinned source scope: Current docs describe OAuth PKCE and metadata-document identities; no real home or token flow qualified.",
      "prerequisites": [
        "Running Home Assistant, configured MCP integration and scoped access"
      ],
      "permissions": [
        "Can control physical devices; main endpoint supports read-only configuration",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Current docs describe OAuth PKCE and metadata-document identities; no real home or token flow qualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Self-hosted software is free; hardware/cloud subscriptions are separate.",
      "privacy": "local"
    },
    {
      "id": "obsidian",
      "kind": "mcp",
      "name": "Obsidian",
      "summary": "Investigate notes access without exposing an entire vault.",
      "description": "Investigate notes access without exposing an entire vault. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "unconfirmed",
      "source": "https://obsidian.md/help/Extending+Obsidian/Obsidian+URI",
      "documentation": "https://obsidian.md/help/Extending+Obsidian/Obsidian+URI",
      "qualification": "Pinned source scope: Community Local REST API plugin now documents built-in Bearer HTTP MCP. It is not an Obsidian-maintained MCP server; no plugin, TLS trust, synthetic vault or permission isolation was qualified.",
      "prerequisites": [
        "A separate synthetic vault and reviewed connector"
      ],
      "permissions": [
        "Vault file reads/writes could expose private notes",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Community Local REST API plugin now documents built-in Bearer HTTP MCP. It is not an Obsidian-maintained MCP server; no plugin, TLS trust, synthetic vault or permission isolation was qualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "App and optional services have their own terms.",
      "privacy": "local"
    },
    {
      "id": "sentry",
      "kind": "mcp",
      "name": "Sentry",
      "summary": "Investigate errors in an approved development project.",
      "description": "Investigate errors in an approved development project. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://mcp.sentry.dev/",
      "documentation": "https://mcp.sentry.dev/",
      "qualification": "Pinned source scope: Official hosted connector documented; OAuth and authenticated project tools unqualified in Sara.",
      "prerequisites": [
        "Sentry account, organization authorization and OAuth"
      ],
      "permissions": [
        "Error events can contain personal data and stack traces; tool-specific writes possible",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Official hosted connector documented; OAuth and authenticated project tools unqualified in Sara.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Sentry account and plan limits apply.",
      "privacy": "external"
    },
    {
      "id": "cloudflare",
      "kind": "mcp",
      "name": "Cloudflare",
      "summary": "Investigate account-scoped Cloudflare tools.",
      "description": "Investigate account-scoped Cloudflare tools. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
      "documentation": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
      "qualification": "Pinned source scope: Multiple provider-maintained servers have distinct permissions; no blanket install or account authorization qualified.",
      "prerequisites": [
        "Cloudflare account, selected server and authorization"
      ],
      "permissions": [
        "Some servers read account data; others can provision/change resources",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Multiple provider-maintained servers have distinct permissions; no blanket install or account authorization qualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Product plan limits and metered resource charges apply.",
      "privacy": "external"
    },
    {
      "id": "docker",
      "kind": "mcp",
      "name": "Docker MCP Toolkit",
      "summary": "Investigate a separately administered MCP container gateway.",
      "description": "Investigate a separately administered MCP container gateway. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://docs.docker.com/ai/mcp-catalog-and-toolkit/",
      "documentation": "https://docs.docker.com/ai/mcp-catalog-and-toolkit/",
      "qualification": "Pinned source scope: Docker host access explicitly forbidden in this run; no gateway or digest was executed/qualified.",
      "prerequisites": [
        "Docker Desktop/Toolkit and reviewed per-server image configuration"
      ],
      "permissions": [
        "Docker daemon/gateway control may expose host mounts and networks",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Docker host access explicitly forbidden in this run; no gateway or digest was executed/qualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "Docker Desktop eligibility and individual service charges apply.",
      "privacy": "local"
    },
    {
      "id": "gitlab",
      "kind": "mcp",
      "name": "GitLab",
      "summary": "Investigate repository and issue tools for a test project.",
      "description": "Investigate repository and issue tools for a test project. Available capabilities depend on the provider and the explicitly granted permissions.",
      "status": "blocked",
      "costTier": "provider",
      "source": "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
      "documentation": "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
      "qualification": "Pinned source scope: Current official source documents OAuth mcp scope or fine-grained PAT with MCP Execute permission; legacy/project/group tokens are rejected. Instance eligibility, fine-grained token and tools remain unqualified.",
      "prerequisites": [
        "Eligible GitLab instance/account and feature setup"
      ],
      "permissions": [
        "Repository and issue reads/writes depending on tools and user authority",
        "Review tool permissions explicitly; read access does not authorize writes or spend.",
        "Sara can auto-allow server-annotated read-only tools; inspect and explicitly set host permissions before use. Recipe advice alone is not an approval fence."
      ],
      "limitations": [
        "Current official source documents OAuth mcp scope or fine-grained PAT with MCP Execute permission; legacy/project/group tokens are rejected. Instance eligibility, fine-grained token and tools remain unqualified.",
        "No authenticated vendor feature execution or other operating-system qualification is claimed."
      ],
      "cost": "GitLab instance, tier and Duo feature eligibility apply.",
      "privacy": "external"
    }
  ],
  "packs": [
    {
      "id": "everyday-assistant",
      "name": "Everyday assistant",
      "summary": "A calmer start. A clearer week.",
      "description": "Bring your agenda, focus time and weekly reflection together. Start with a single manual workflow; add calendar access only when you need it.",
      "items": [
        "daily-briefing",
        "focus",
        "weekly-review",
        "weather-alerts"
      ],
      "alternatives": [
        "home-dashboard",
        "travel-planner"
      ],
      "setup": [
        "Choose the companion you want to work with; nothing is enabled for other companions.",
        "Start with Focus from Settings → Add-ons → Get more. Read its permission review before installing, then enable it yourself.",
        "For upcoming briefing and review workflows, read each qualification page and wait for signed publication before store installation.",
        "If using calendar features, authorize your existing Google integration separately and confirm the timezone.",
        "Run one manual, bounded request. Check missing sources and approve each host-tool request individually."
      ],
      "privacy": "Hybrid when weather or calendar services are used. Focus keeps its timer state locally. Model-backed requests use your configured background route.",
      "cost": "No pack purchase or automatic subscription. Your selected model, weather and calendar providers may have quotas or usage costs."
    },
    {
      "id": "research-documents",
      "name": "Research & documents",
      "summary": "From source material to something useful.",
      "description": "Build a document desk and a traceable research notebook. Keep selected material, inspect citations, and save only the outputs you approve.",
      "items": [
        "document-desk",
        "research-notebook",
        "markitdown",
        "filesystem",
        "reading-list"
      ],
      "alternatives": [
        "tavily",
        "firecrawl",
        "obsidian",
        "notion"
      ],
      "setup": [
        "Choose a dedicated working folder with non-sensitive test documents, not a whole disk or Sara's data folder.",
        "Review Files on this computer and grant only that folder; writes still require approval.",
        "Read the MarkItDown prerequisite and qualification record before preparing its runtime. Do not run a server merely because it appears in this checklist.",
        "Keep documents in Sara's library or provide selected text explicitly; current-chat-only attachments and conversation history are not automatically available to plugins.",
        "Review source/page citations and truncation notices. Approve a Markdown save only after inspecting the draft."
      ],
      "privacy": "Local conversion is distinct from model privacy: summaries follow your model route. Web search and remote fetches disclose queries and requested URLs to those providers.",
      "cost": "Local runtimes use your hardware. Search, crawling and configured model providers may charge; no keys or paid accounts are created by this pack."
    },
    {
      "id": "developer",
      "name": "Developer workspace",
      "summary": "Understand the code. Leave a clean handoff.",
      "description": "Connect explicit project evidence, current library documentation and a separately scoped browser. Keep source changes and GitHub actions under individual approval.",
      "items": [
        "project-handoff",
        "github",
        "context7",
        "playwright",
        "filesystem"
      ],
      "alternatives": [
        "chrome-devtools",
        "serena",
        "gitlab",
        "sentry",
        "docker"
      ],
      "setup": [
        "Select a disposable project folder and a separate browser profile for the first run.",
        "Review Files, GitHub, Docs and Playwright individually in Sara. Authorize only the repositories and paths required.",
        "Read runtime requirements and the exact command on each tool-server page before Add and start; run Sara's Test.",
        "Provide specific source paths to Project handoff when its signed package becomes available. It does not read an active project checkpoint or run tests for you.",
        "Review changed, tested, unverified and blocked sections against real evidence; do not treat a generated summary as a test pass."
      ],
      "privacy": "Hybrid: local folders and browser automation can be sensitive; GitHub and documentation queries reach external services. Model-backed handoffs use your configured background route.",
      "cost": "Repository/provider plan limits and configured model usage may apply. Browser and code runtimes require your own hardware."
    },
    {
      "id": "creator",
      "name": "Creator studio",
      "summary": "Shape the brief. Keep control of the output.",
      "description": "Work from a written brief into drafts, image-workflow preparation and 3D tools. This is an intentional creative workspace, not an automatic publishing pipeline.",
      "items": [
        "content-studio",
        "image-workshop",
        "comfyui",
        "blender"
      ],
      "alternatives": [
        "figma",
        "drawio"
      ],
      "setup": [
        "Write a short brief, intended audience, source references and output constraints.",
        "Prepare your own ComfyUI or Blender instance if needed; read the associated server's code and allowed operations.",
        "Check each workflow's publication and qualification state. A prompt or queued job is not a generated image.",
        "Review exact ComfyUI server/tool names and approve the run explicitly; keep output receipts and handle failed or long jobs as pending.",
        "Inspect drafts and actual generated files before manually sharing them. No social, email or cloud publication is included."
      ],
      "privacy": "Hybrid unless every model and image runtime is local. Local GPU generation does not make a cloud text-model route local.",
      "cost": "Your hardware/GPU use and configured text/image provider costs apply. This checklist buys no model credits and starts no jobs."
    },
    {
      "id": "small-business",
      "name": "Small-business desk",
      "summary": "Prepare the work. Review every decision.",
      "description": "Organize supplied meeting notes, inspect bounded inbox messages and validate explicit CSV data. Owner-side preparation only: not a certified business/team integration or an unattended operator.",
      "items": [
        "meeting-assistant",
        "inbox-triage",
        "spreadsheet-assistant",
        "weekly-review"
      ],
      "alternatives": [
        "google-workspace",
        "microsoft-365",
        "slack",
        "linear",
        "atlassian"
      ],
      "setup": [
        "Use synthetic notes, messages and CSV files for the first run; confirm consent before processing other people's information.",
        "Read each entry's qualification and publication state. Supply notes yourself; there is no ambient meeting recording.",
        "Authorize only the existing Google scopes required for inbox/calendar features. Hosted MCP OAuth support is not implied.",
        "Review message IDs, task proposals, numeric checks and unresolved questions. An inbox draft is never sent automatically.",
        "Approve host tools individually and save only reviewed output. Independently verify business-critical calculations and decisions."
      ],
      "privacy": "External email/calendar and model processing can include confidential information. Apply your organization's data and consent policy; no enterprise certification is claimed.",
      "cost": "Existing service subscriptions and metered model usage may apply. The pack creates no accounts or paid subscriptions."
    },
    {
      "id": "private-local",
      "name": "Private & local",
      "summary": "A smaller data boundary, by design.",
      "description": "Start with a local timer, a tightly scoped folder and local document conversion. Add spreadsheet work only after reviewing its qualification. Local is a configuration you verify, not a badge that overrides your model or network settings.",
      "items": [
        "focus",
        "filesystem",
        "markitdown",
        "spreadsheet-assistant"
      ],
      "alternatives": [
        "obsidian"
      ],
      "setup": [
        "Select an actually local model route, if using model-backed features; verify that no cloud fallback is configured.",
        "Prepare a dedicated sample folder and review the filesystem server's read/write boundaries.",
        "Review the pinned local conversion runtime and its qualification before starting it; downloading dependencies initially requires network access.",
        "Use explicit CSV input for deterministic spreadsheet calculations; do not assume XLSX recalculation or macro support.",
        "Check outbound access, permissions and private-mode restrictions for each component. Never weaken Sara's privacy mode to make a recipe run."
      ],
      "privacy": "Intended for local processing after dependency setup, subject to exact runtime/network configuration. Model privacy still follows the selected route. A recipe listing does not override Sara private-mode restrictions.",
      "cost": "Local hardware, storage and energy costs apply. No promise of zero cost, no subscription and no automatic cloud fallback."
    }
  ]
} as const;
