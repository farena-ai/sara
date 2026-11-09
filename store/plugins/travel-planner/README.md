# Travel planner

Arrange confirmed supplied options into a dated itinerary and budget. Estimates only, never live quotes or bookings.

**Local candidate · publication pending.** MIT; Sara >=2.65.0; dependency-free Node 24+ package.

## Use

Add this folder with Sara’s normal Add-ons review flow, review permissions and enable per companion. Installing does not enable it. Windows uses Node permission limits, not a full sandbox. No changes to host safety, approvals, vault or privacy policy. Invoke `travel_planner__workflow` explicitly with supplied data.

```json
{
  "start": "2026-12-01",
  "end": "2026-12-03",
  "currency": "USD",
  "budget": 300,
  "preferences": "Museums and walking",
  "options": [
    {
      "id": "o1",
      "date": "2026-12-02",
      "title": "Museum",
      "amount": 25,
      "source": "Owner supplied price list fixture",
      "checked": "2026-11-01",
      "confirmed": true
    }
  ]
}
```

## Bounds and prerequisites

Trip spans 1–31 inclusive calendar days. No timezone-aware flight routing. At most 8 owner-confirmed options, each with unique id, date, title, finite nonnegative amount, source description, checked date and confirmed:true. Supported currency contract only: USD/EUR/GBP/CAD/AUD/BRL/CHF (2 decimals), JPY/KRW (0), KWD/BHD/OMR (3). Unknown codes and excessive fractional precision are rejected, not rounded. No exchange rates. Totals assume each option amount is a trip line total, not a nightly/per-person rate. Estimates may be stale; no live quotes, availability check, booking, payments or calendar changes. Empty options expose unplanned dates. Preferences are recorded, not automatically verified against options.

All workflows reject unknown fields and malformed types. Total input at most 24000 JSON characters; output at most 3800 characters to fit Sara’s display contract. Reduce the supplied batch if output would exceed this; JSON is never silently truncated. No schedules, hooks, recordings, notifications, direct network or private conversation access. Only image-workshop persists one brief; all other output is transient channel text. Use clear to delete a valid stored preset; corrupt or unsupported stored data is preserved and refused, including clear/save, for separate repair/export.

## Localization and evidence

Ready descriptions, native result cards and generated explanatory prose support es/fr/de/pt-BR/it using the actual channel language (plus English fallback). Package-local `labels.json`, `locale.mjs` and `native.mjs` use the unmodified current SDK init lifecycle, before ready. Protocol keys, enums/status codes, identifiers, filenames and supplied/model text stay unchanged; generated reply/layout/prompt scaffolding is localized without walking/replacing source strings. Optional model drafting requests the caller language; the returned draft is preserved, not machine-translated or language-certified. Translations are AI-drafted; a human linguistic skim remains pending. No settings labels/tips are declared. `shots/1.png` now renders actual French fixture result/card payloads, explicitly labelled **FIXTURE PREVIEW — NOT LIVE PRODUCT UI**, not Sara UI or live accounts.

Run from the Sara repository: `node --test test/addons-workflows.test.ts`. Channel tests execute actual Node permission-limited handlers through the production plugin-host shim with minimal environment; host KV/model/card replies are explicit fixtures, not production manager routing/approval/budget qualification or paid inference. Package qualification and scope limits: `docs/ops/ADDONS_WORKFLOWS_QUALIFICATION.md`.


## Review correction contract

The actual ready schema is published in `schema.mjs`: nested required fields, bounds, enums/patterns and `additionalProperties:false`. Cross-field/calendar/uniqueness/CSV/result-expansion rules are in the registered tool description and runtime validator. String and serialized channel limits count JavaScript UTF-16 code units; no silent truncation. Successful handlers emit a native review card; denied card presentation does not undo a valid structured result or acknowledged KV change. Technical failures are localized to bounded diagnostics in the five supported locales.

Budget and each line amount are 0–10000000, with at most 8 options. Parse the decimal number representation into integer minor units, sum/compare/subtract integers, and convert only for returned numbers. No epsilon or universal cents rounding. The largest accepted sum is 80000000000 minor units (3-decimal currencies), safely below the safe-integer limit. Exact USD 0.1+0.2 with budget 0.3 returns total 0.3, remaining 0, overBudget false.
