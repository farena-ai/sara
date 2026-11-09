# Document desk

Compare or extract supplied text with original source labels and exact line references.

## What it actually does

compare requires exactly two sources and returns onlyLeft, onlyRight and shared exact lines. It is a line-set comparison, not semantic or ordered diff. extract requires query (1–200 characters) and returns case-insensitive literal matches from 1–12 sources. It reads no files and invents no pages.

**Prerequisite:** Supply plain text from documents with distinct IDs and accurate labels. Convert PDFs/Office documents separately if needed.

## Try it with supplied fixture context

Tool: `document_desk__inspect` (declared local tool `inspect`, permission `ask`). Example arguments:

```json
{
  "mode": "compare",
  "sources": [
    {
      "id": "old",
      "label": "Old draft",
      "text": "Shared clause\nOld delivery term"
    },
    {
      "id": "new",
      "label": "New draft",
      "text": "Shared clause\nNew delivery term"
    }
  ]
}
```


Extraction example: `{"mode":"extract","query":"delivery","sources":[{"id":"contract","label":"Supplied clause","text":"Delivery after review."}]}`. No semantic matching or page-number reconstruction.

## Local candidate, not a public release

Built locally · publication pending. MIT. Requires Sara >=2.65.0 and Node 24 through Sara’s native plugin host. This package is independent: all runtime imports and the unchanged Sara SDK are inside its folder. No install scripts, npm dependencies, account credentials or vendor code.

## Install and invoke manually

In **Settings → Add-ons → Plugins**, add this folder or its checked package, read the permission review, then enable it for the intended companion. Installation does not enable anything. Windows uses Node permission limits, **not a full OS sandbox**; only install authors you trust. Invoke the declared tool on demand with permission **ask**. There are no hooks, schedules, jobs, bridges, workspace reads or external-tool permissions.

## Optional model refinement: explicit and potentially billed

The deterministic workflow needs **no model/account**. To request model observations, pass `refine:true` (notebook: use `operation:"synthesize"`). This invokes exactly one `sara.model` request on Sara’s existing **background** route, requires a latest owner conversation for routing, may send the supplied source text to a configured cloud provider, and may cost money at that route’s pricing. A translated disclosure card is posted before the request; the explicit invocation is the opt-in, **not a second approval button**. The manifest caps each plugin at **4 calls / 12000 metered tokens per day**, each request asks for **700 output tokens**, with no retry or fallback provider. Host accounting/route policies still apply.

Input is refused before the broker if the constructed prompt exceeds **7800 characters**, leaving margin below its 8000-character truncation limit. Model responses must be bounded JSON with up to five `{text,source,quote}` proposals; every source ID and exact quote must exist in the supplied context. Quote presence is checked, **interpretation is not verified**. Proposals remain explicitly unverified and cannot alter deterministic results, claim completed actions or fabricate accepted citations. Generated proposal text must be well-formed Unicode without C0/C1 controls except tab, LF and CR; valid astral Unicode is accepted. Supplied evidence/IDs are preserved literally, not repaired or normalized. Empty proposals return `modelOutcome:"no-observations"` with a translated warning/card, not a useful-refinement claim. Neither failure nor no-observations saves model output. The selected model controls proposal quality. Model/budget errors, malformed or oversized responses and unsupported evidence return a clear error and do not modify notebook storage. No live model or paid calls were used to qualify this package.

`language` optionally selects model response language; otherwise Sara’s caller channel language is used. Names, descriptions, card labels/counts and model disclosure are translated into es/fr/de/pt-BR/it, with English fallback. Structured protocol keys and deterministic diagnostics remain English; original source text is preserved. There are no settings, so no untranslated setting labels or missing ? tips.

## Bounds and trust

Source-based tools accept **1–12 sources**, each `{id,label,text}`; IDs match `[a-z][a-z0-9_-]{0,31}`, labels are at most 80 characters, combined source text at most **5000 characters**, and each source at most **80 lines**. Meeting input is at most 5000 characters/80 lines. Weekly commitments are at most 20 entries, 300 characters each, and combined accomplishment/commitment context at most 5000 characters. Oversized context is **refused, not silently truncated or claimed fully processed**. Unknown fields, wrong types, duplicate IDs and empty required context are refused even if invoked outside Sara’s schema validator.

Sources are untrusted data, not instructions or authority for additional access. The plugin does not read conversation archives, other companions, private sessions, uploads, vault secrets or a second memory service. It has no direct/brokered network access and performs no account, messaging, publishing, calendar or task actions. Source IDs and line references identify supplied material; they are not independently verified external citations. Successful structured output is complete JSON tool content, capped at **60000 UTF-16 code units AND 60000 UTF-8 bytes after serialization** (including escaping, labels and references), safely below the native tool channel’s 64 KiB cutoff. Larger reports fail explicitly: split the supplied context or get individual notebook entries instead of a full export; no partial JSON or successful summary card is returned. The limit also applies to notebook list/get/export and model results; the native card gives bounded counts and evidence. A long card evidence line can be visually shortened to 200 characters; the full original quote remains in tool content.

## Evidence and screenshots

`test/addons-knowledge.test.ts` drives the actual permission-limited Node subprocess through Sara’s unchanged SDK and real `plugin-host.mjs`, with deterministic host KV/card/model **stand-ins**, not real provider/account execution. It exercises actual handlers, not only readiness. The official store checker and smoke packer are separate checks; neither claims semantic model quality or live product acceptance.

`shots/1.png` is prominently labelled **FIXTURE PREVIEW · NOT LIVE PRODUCT UI**, rendered in local headless Chrome from actual synthetic process/card output. It is not a screenshot of a deployed Sara installation, real meeting or account. The full process receipts, RED/GREEN logs, screenshot provenance and pack reports are under `outputs/addons/knowledge/`; Review-fix RED/GREEN receipts, refreshed subprocess evidence and package checks are under `outputs/addons/knowledge-fixes/`; historical `knowledge/` artifacts are not refreshed source packages. Registered schemas now enumerate nested fields and limits; cross-field/aggregate rules remain runtime-validated and documented in descriptions. Qualification summary: `docs/ops/ADDONS_KNOWLEDGE_QUALIFICATION.md`. Cross-platform runtime, live background route quality, human acceptance and public signing/publication remain unverified.
