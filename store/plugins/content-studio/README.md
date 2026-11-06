# Content studio

Create reviewable drafts from a brief, locally or by explicit model request. Export text, never publish.

**Local candidate · publication pending.** MIT; Sara >=2.65.0; dependency-free Node 24+ package.

## Use

Add this folder with Sara’s normal Add-ons review flow, review permissions and enable per companion. Installing does not enable it. Windows uses Node permission limits, not a full sandbox. No changes to host safety, approvals, vault or privacy policy. Invoke `content_studio__workflow` explicitly with supplied data.

```json
{
  "brief": "Launch a community garden",
  "audience": "Neighbors",
  "tone": "warm",
  "channel": "newsletter"
}
```

## Bounds and prerequisites

Brief 600, audience 120 and tone 60 characters. Supported channels: newsletter, social, article, email. Local mode is an editorial starter layout, not original researched prose. Set useModel:true only when explicitly requesting a model draft: one call on the owner’s existing BACKGROUND route, maxTokens 600, manifest 4 calls/day and 12000 tokens/day. The route may be external and metered. Requires an existing owner conversation, configured route and available budget. Output must be nonempty and at most 1400 characters. Failures return errors, without publishing or saving. Export is copyable text, not a written file. Sources are not researched or verified.

All workflows reject unknown fields and malformed types. Total input at most 24000 JSON characters; output at most 3800 characters to fit Sara’s display contract. Reduce the supplied batch if output would exceed this; JSON is never silently truncated. No schedules, hooks, recordings, notifications, direct network or private conversation access. Only image-workshop persists one brief; all other output is transient channel text. Use clear to delete a valid stored preset; corrupt or unsupported stored data is preserved and refused, including clear/save, for separate repair/export.

## Localization and evidence

Ready descriptions, native result cards and generated explanatory prose support es/fr/de/pt-BR/it using the actual channel language (plus English fallback). Package-local `labels.json`, `locale.mjs` and `native.mjs` use the unmodified current SDK init lifecycle, before ready. Protocol keys, enums/status codes, identifiers, filenames and supplied/model text stay unchanged; generated reply/layout/prompt scaffolding is localized without walking/replacing source strings. Optional model drafting requests the caller language; the returned draft is preserved, not machine-translated or language-certified. Translations are AI-drafted; a human linguistic skim remains pending. No settings labels/tips are declared. `shots/1.png` now renders actual French fixture result/card payloads, explicitly labelled **FIXTURE PREVIEW — NOT LIVE PRODUCT UI**, not Sara UI or live accounts.

Run from the Sara repository: `node --test test/addons-workflows.test.ts`. Channel tests execute actual Node permission-limited handlers through the production plugin-host shim with minimal environment; host KV/model/card replies are explicit fixtures, not production manager routing/approval/budget qualification or paid inference. Package qualification and scope limits: `docs/ops/ADDONS_WORKFLOWS_QUALIFICATION.md`.


## Review correction contract

The actual ready schema is published in `schema.mjs`: nested required fields, bounds, enums/patterns and `additionalProperties:false`. Cross-field/calendar/uniqueness/CSV/result-expansion rules are in the registered tool description and runtime validator. String and serialized channel limits count JavaScript UTF-16 code units; no silent truncation. Successful handlers emit a native review card; denied card presentation does not undo a valid structured result or acknowledged KV change. Technical failures are localized to bounded diagnostics in the five supported locales.

Only model output is checked for well-formed Unicode, forbidden C0/C1 controls (tab/LF/CR allowed), nonempty text and <=1400 code units. Valid astral characters are accepted. Supplied material is preserved, never cleaned or normalized. One opt-in model call, max600 tokens, existing host budget/route only.
