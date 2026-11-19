# Translating Sara

The web app (and so the phone and desktop apps, which load the same pages) speaks English plus
Spanish (`es`), French (`fr`), German (`de`), Portuguese (Brazil) (`pt-BR`) and Italian (`it`).
This page is for anyone who wants to fix a word, keep a language complete, or add a new one.

## How it works

- **English is the source.** Every built-in string is written in English in `web/index.html`,
  `web/*.js`, `web/tips.json`, `web/help.html` and, for text the server makes, `src/`.
- **One file per language:** `web/i18n/<lang>.json`, a flat object keyed by the English text itself
  (trimmed, spaces collapsed). There is no build step and no list of made-up key names to keep in
  sync. If the English changes, the old key shows up as unused and the new one as missing, so you
  can see exactly what to update.
- In the browser, `web/naming.js` swaps text nodes and the `placeholder`, `title`, `aria-label`,
  `alt` and `data-tip` attributes. Code builds text with `t('English text', { name: … })`.
- **Translate first, then personalize.** In English, `personalize()` rewrites "Sara/she/her" to the
  companion's name and pronouns. Pronoun rules don't carry over to other languages (German "sie" is
  also "they", Spanish drops the subject, adjectives agree in gender), so in other languages only
  the name is swapped. **Write translations with the name "Sara" or neutral wording, not with
  pronouns for her.** Example: German "Sara antwortet…" rather than "Sie antwortet…".
- Text the owner or the companion wrote (messages, memories, notes, titles, look backs) is never
  translated.
- The AI disclosure is legally required and has its own reviewed texts in `src/i18n.ts`
  (`DISCLOSURE`). The crisis resources stay English (988 is a US line).

## Text the server makes (Phase 61)

Server text the owner sees uses the **same** `web/i18n/<lang>.json` files, keyed by the English.
Two ways, depending on where the text ends up:

- **Shown by the web app** (API errors, Today and Health lines, job cards, "a backup model took
  over" notices, default names like "Another app"): the server keeps sending English, so older apps
  and other clients still work, and the app translates it with `t()`. A fixed text is its own key
  (mark it with `en('…')` in `src/` so the extractor finds it; `new HttpError(400, '…')` with a plain
  string is found too). Text with values is sent as a template plus values: an `HttpError` with
  `{ params }` adds `errorKey` and `params` to the JSON error; notices carry `key`/`params`; Health
  checks carry `detailKey`/`params`. `serverText()` in `web/naming.js` picks the right one.
- **Leaving the server as plain text** (push notifications, Telegram and Discord messages to the
  owner, conversation titles made by the server, model-switch and job messages she sends):
  `tr(text, lang, params, identity)` / `trOwner(text, settings, …)` in `src/i18n.ts` look the key up
  in the owner's app language (Settings → You → Language) and fill `{placeholders}`. Unknown keys
  and languages stay English.
- Never through `tr()`: what she says (the model's words), and the fixed texts partners see in
  Telegram/Discord (they don't share the owner's language).
- `scripts/i18n-extract.ts` (`fromServer`) collects the first argument of `tr()`, `trOwner()` and
  `en()`, plain-string `HttpError` messages and `errorKey: '…'` in every `.ts` file under `src/`,
  so a new server text without translations fails the i18n test like any other string.
- Write the companion as "Sara" in server keys too: `tr()` swaps the name (and, in English only,
  the pronouns) like the app does.
- **Errors with values from engines (W0.2):** throw them with `enf('There is no app "{name}".',
  { name })` instead of a template literal. The text stays English for the model and logs, and
  `send()` (src/http.ts) finds the template again and adds `errorKey` + `params` to any error body,
  so routes that pass `err.message` on need no change. Report lines that the page shows later carry
  `tkey` + `params` (Move-in's `keyedLine`). Plurals are two keys (`1 point differs` /
  `{n} points differ`), picked in code.
- **The guard** (`test/w0-i18n.test.ts`) fails on new English the app can't translate: an
  `error`/`message`/`reason`/`text`… field in `src/routes/*.ts` without translations, an
  `HttpError` message built with `${…}`, literal English put on the page from `web/*.js`, a web
  error helper that throws `data.error` raw instead of `serverText(data, …)`, and any text in the
  desktop quick-ask bubble (`desktop/shared/quick-ask.html`, which loads `/i18n/<lang>.json` itself).
  Technical or demo-only text goes in its allow-list with a reason.

## The rules

- **Keep placeholders:** `{name}`, `{n}`, `{date}`… must appear in the translation exactly as in the
  English (you can move them).
- **Keep markup** in help page items (`<strong>`, `<em>`, `<a href>`, `<code>`) and the `<_/>`
  marker (it stands for a code sample that isn't translated).
- **Keep untranslated:** product names (Sara, Grok, Ollama, ChatGPT, Claude, GitHub, Telegram,
  Discord…), commands, code, file names, settings that are typed in English, and the companion's
  name.
- **Safety and legal texts keep their exact meaning:** the AI disclosure, the crisis resources
  (988 is a US number: keep the text's meaning, never add local numbers), and the Adult mode 18+
  confirmation. The test checks that the numbers 988 and 18 are never changed or added.
- Use the friendly "you" form (tú / tu / du / você / tu) and the same word for the same thing
  across the whole file (look at how Settings pages and buttons are named).
- Tips (the `?` popups) should stay at most 260 characters (or as long as the English).
- Words that really are the same in your language (for example German "Team") go in the
  `"@same"` list at the top of the file, so the test knows they're left in English on purpose.

## Checking a language

```
node scripts/i18n-extract.ts                # counts per language: missing, unused, wrong {placeholders}
node scripts/i18n-extract.ts --missing de   # the missing keys of one language, as JSON to fill in
node scripts/i18n-extract.ts --keys         # every key
node --test test/i18n.test.ts               # the same checks the full test suite runs
```

The test fails when any language misses a key, keeps a stale key, changes a placeholder or markup,
leaves a sentence in English, or makes a tip too long. So a new English string needs its
translations in the same change.

New strings built from data (the server's mood words, one-word labels in label maps) that the
extractor can't see go in `web/i18n/_extra.json` (`keys`).

## Adding a language

1. Add the code to `LANGUAGES` / `LANGUAGE_NAMES` / `MARKERS` / `DISCLOSURE` in `src/i18n.ts`, to
   `LANGS` in `scripts/i18n-extract.ts` and in `web/naming.js`, and to the two pickers in
   `web/index.html` (Settings → You → Language and Talk to me in).
2. Start the file: `node scripts/i18n-extract.ts --missing xx > web/i18n/xx.json`, add
   `"@language"` and `"@same"` at the top, and translate every value.
3. Run the checks above until they pass, then the whole suite (`npm run check`).
4. Look at the app in the new language at desktop and phone width (long words wrap or get cut off
   in the sidebar and buttons; pick shorter words where needed).

## The help guide

The whole guide (`web/help.html`) is translated by `web/help-i18n.js` with the same files: the menu
and headings by their text, and every block (list item, paragraph, table cell, tip box) by its
inner HTML as the browser reads it (a bare `&` becomes `&amp;`). Keep the tags, links and `<code>`
samples exactly; menu paths (*Settings → …*) must use the translated names of the Settings pages
and buttons. `helpBlocks()` in `scripts/i18n-extract.ts` lists the same blocks, so a new or changed
paragraph shows up as missing until it is translated.
