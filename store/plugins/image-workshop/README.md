# Image workshop

Prepare and save structured image briefs, presets and prompts. Preparation only: no image generation.

**Local candidate · publication pending.** MIT; Sara >=2.65.0; dependency-free Node 24+ package.

## Use

Add this folder with Sara’s normal Add-ons review flow, review permissions and enable per companion. Installing does not enable it. Windows uses Node permission limits, not a full sandbox. No changes to host safety, approvals, vault or privacy policy. Invoke `image_workshop__workflow` explicitly with supplied data.

```json
{
  "action": "prepare",
  "brief": "A ceramic vase",
  "style": "product",
  "aspect": "1:1",
  "avoid": "logos",
  "seed": 42
}
```

## Bounds and prerequisites

Actions: prepare, save, load, clear. One saved brief in the plugin’s own KV store. Brief 600, avoid 200 characters; styles product/illustration/cinematic; aspect 1:1/16:9/9:16; optional integer seed 0–2147483647. Seed records intent, not a guarantee of generator reproducibility. Prepare does not save; clear removes only this plugin’s saved brief. There is NO native image generation tool or tool-discovery SDK. Configure a reviewed image MCP separately; verify its exact registered tool name, schema, approval and actual output before running outside this plugin. No fake URLs or generated previews.

All workflows reject unknown fields and malformed types. Total input at most 24000 JSON characters; output at most 3800 characters to fit Sara’s display contract. Reduce the supplied batch if output would exceed this; JSON is never silently truncated. No schedules, hooks, recordings, notifications, direct network or private conversation access. Only image-workshop persists one brief; all other output is transient channel text. Use clear to delete a valid stored preset; corrupt or unsupported stored data is preserved and refused, including clear/save, for separate repair/export.

## Localization and evidence

Ready descriptions, native result cards and generated explanatory prose support es/fr/de/pt-BR/it using the actual channel language (plus English fallback). Package-local `labels.json`, `locale.mjs` and `native.mjs` use the unmodified current SDK init lifecycle, before ready. Protocol keys, enums/status codes, identifiers, filenames and supplied/model text stay unchanged; generated reply/layout/prompt scaffolding is localized without walking/replacing source strings. Optional model drafting requests the caller language; the returned draft is preserved, not machine-translated or language-certified. Translations are AI-drafted; a human linguistic skim remains pending. No settings labels/tips are declared. `shots/1.png` now renders actual French fixture result/card payloads, explicitly labelled **FIXTURE PREVIEW — NOT LIVE PRODUCT UI**, not Sara UI or live accounts.

Run from the Sara repository: `node --test test/addons-workflows.test.ts`. Channel tests execute actual Node permission-limited handlers through the production plugin-host shim with minimal environment; host KV/model/card replies are explicit fixtures, not production manager routing/approval/budget qualification or paid inference. Package qualification and scope limits: `docs/ops/ADDONS_WORKFLOWS_QUALIFICATION.md`.


## Review correction contract

The actual ready schema is published in `schema.mjs`: nested required fields, bounds, enums/patterns and `additionalProperties:false`. Cross-field/calendar/uniqueness/CSV/result-expansion rules are in the registered tool description and runtime validator. String and serialized channel limits count JavaScript UTF-16 code units; no silent truncation. Successful handlers emit a native review card; denied card presentation does not undo a valid structured result or acknowledged KV change. Technical failures are localized to bounded diagnostics in the five supported locales.

KV stores only the bounded canonical version-1 preset `{version:1,brief,style,aspect,avoid,seed}` with no other fields; seed is null or an integer 0–2147483647. Load validates required shape/version/types/limits and reconstructs prompt/explanation with generated:false. Stored generated/image/prompt/unknown fields are refused, never trusted. Old/unversioned, oversized or corrupt records are reported and preserved without overwrite. Save/clear require exact `{ok:true}` acknowledgement and matching validated readback before saved/cleared claims. Mutations are serialized in-process, not cross-process transactions. No generator, image URL or image receipt is invented.
