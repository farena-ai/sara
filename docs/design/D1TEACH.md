# D1 Teach by showing (ROADMAP_V wave 7)

Do a task once in your browser; Sara turns the steps into a skill or an automation draft you review.

## What existed (extended, not rebuilt)
- `extension/` (U4.25): paired MV3 extension, `activeTab` + `scripting` only, page helpers injected on
  click (`lib/extract.js`, `lib/fields.js`). `SaraFields.classify` already knows which fields are
  never touched (passwords, cards, one-time codes, SSN).
- `src/routes/extension.ts` + `src/extension.ts`: extension-scoped token routes (`/api/ext/*`), the
  owner's switches in `<space>/extension.json` (`on`, `forms`), Settings → Devices and sign-in →
  Browser extension (`web/browser-ext.js`).
- `src/form-fill.ts` `fieldKind`: the server's own never-kinds (password / card / id-number / code).
- Skills (`src/skill-store.ts` `save`, source `learned` = on trial until checked) and the Skills page's
  "Skills she learns" section with "Waiting for you" (`web/learned-skills.js`) and the draft editor
  (`web/skills.js` `editDraft`).
- Automations (`src/automations.ts` `create`/`setEnabled`, `task` action = a written instruction).
- Her testing browser tools (`browser_open/click/type/read`), which a taught skill tells her to use.

## What D1 adds
1. **Extension: Watch me do this** (`extension/lib/teach.js`, plain script like fields.js).
   - Start in the popup → the recorder is injected into the tab; the badge shows `REC`.
   - Records clicks (buttons, links, checkboxes), typed values (on `change`), picks in drop-downs,
     and page loads (address without the query string or hash). Each step keeps a target description
     (tag, role, id, name, label, visible text, a short CSS path), never the page's HTML.
   - **Never recorded:** any field `SaraFields.classify` calls `never` gives a step "you type this
     yourself" with no value, read nowhere (the recorder does not even read `.value`). Hidden fields
     and `file` inputs are ignored. At most 60 steps; values capped at 200 characters.
   - Steps live in `storage.session` (gone when the browser closes); the background worker re-injects
     the recorder after a page load in the same tab when the browser allows it.
   - Stop → review in the popup: untick steps, name it, say what it's for → **Send to Sara**, or
     **Replay here** (runs the steps on the current tab; "you type this" steps are left for you),
     or **Discard**.
2. **Server** (`src/teach.ts`, routes ride the existing families: no new route group).
   - `POST /api/ext/teach` (extension token, switch `teach`): `cleanTeaching` re-checks every step
     (`fieldKind` never-kinds and the password type drop the value again, control characters out,
     long digit runs masked), keeps it in `<space>/taught.json` (at most 20, newest first).
   - `skillDraftOf` writes a SKILL.md draft: what for, the start address, numbered steps in words with
     a selector hint, "ask the person to type it" for secret steps, and how to do it with the testing
     browser tools.
   - `GET /api/skills/taught`, `POST /api/skills/taught/:id {action: skill|automation|discard, draft?}`:
     skill = saved through `SkillStore.save` as a skill you made (you reviewed it; origin `taught`);
     automation = an Automations entry created **switched off** (weekly, a `task` step that follows
     the skill), so you set when it runs and switch it on yourself.
3. **Web**: Settings → Skills & tools → Skills → "Skills she learns" gets **Shown in your browser**
   (the recordings waiting: steps, Save as a skill / Edit first / Make an automation / Delete);
   Devices and sign-in → Browser extension gets the switch **Let it record steps you show it**.

## Acceptance
- Unit: the recorder on a fake DOM records click/type/pick, never a password/card/code value (and
  never reads it), replays on a second fake page by id, name, label or text; the server cleaning,
  drafts, routes, switches and limits.
- Live: the unpacked extension in Chromium records a fake shop flow (search, pick, a password field),
  the server shows no password anywhere, Replay here runs it on a fresh fake page, the Settings section
  saves the skill and an automation draft; shots light/dark × 1440/390.
