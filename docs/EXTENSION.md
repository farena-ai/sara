# Sara in your browser (extension)

U4.25. A small browser extension for Chrome, Edge and Firefox (Manifest V3) that talks to **your own
Sara** and nothing else. On the page you are on:

- **Ask Sara about this page**: she gets the address, the text you selected and the page's readable
  text (read in your browser, capped at 20,000 characters; Sara reads up to 12,000). Her reply shows
  in the popup with **Continue in Sara** to go on in that chat.
- **Summarize**: the same, asking for a short summary.
- **Save page to Library**: a Markdown document with the page's text and its address, kept in her Library.
- **Fill this form**: Sara proposes values from *Settings → You → My details*. The popup shows them
  field by field; untick or change any, then **Approve and fill**. Nothing is typed before you approve,
  and the form is never sent: you check it and press its button yourself.
- **Right-click** selected text → *Ask Sara about "…"*; right-click a page → *Save this page to Sara's Library*.
- **Off on this site**: a switch in the popup; on that site nothing is read or sent (the menu does nothing there).

- **Watch me do this** (teach by showing): do a task once in this tab while Sara watches; she keeps
  the steps, you review them, then **Send to Sara** for a skill or automation, or **Replay here**. See
  [Watch me do this](#watch-me-do-this) below.

## Hard limits

- **Never filled:** password fields, payment card fields (number, expiry, CVC, name on card), one-time /
  2FA / verification codes and SSN / government ID numbers. The extension checks this in the page and
  again right before typing, and Sara's server refuses them too (the same rules as `pc_fill_form`).
  Such fields are sent to Sara as a label only, never with a value.
- **Data goes only to your paired Sara.** No analytics, no other servers, no remote code. The extension
  asks for one host permission at pairing: your Sara's address. It reads a page only when you click
  (the `activeTab` permission), never in the background.
- Private local mode on the server: the extension waits (Sara refuses it until the mode is off).
- Kid spaces never get the extension. Household members pair it with their own space; it sees only their
  own Library and My details.

## Watch me do this

1. On the page where the task starts, open Sara's extension and press **Watch me do this**. The
   button shows **REC** while it watches this one tab.
2. Do the task as usual: search, click, type, pick, go to the next page. Sara keeps what you clicked
   (its visible text or label), what you typed or picked, and each page's address **without** the
   part after `?` or `#` (that part can hold sign-in tokens).
3. Open the extension again and press **Stop**. The steps are listed: untick any you don't want,
   name it and say what it's for.
4. **Replay here** runs the ticked steps on this tab again (it opens the first page if the tab is
   elsewhere). **Send to Sara** puts them in *Settings → Skills & tools → Skills → Shown in your
   browser*. **Discard** forgets them.
5. In Sara: **Save as a skill** (or **Edit first** in the skill editor), **Make an automation** (the
   skill plus an Automations entry that stays off until you set when it runs), or **Delete**.

Never recorded: password fields, payment card fields, one-time / 2FA codes and SSN / ID numbers (the
same rules as form filling), and long runs of digits. Those steps say "you type this yourself", with no
value; Sara's server drops any value for them again, and Replay never types into them. Hidden and file
fields are left out. Steps stay in the browser's session storage until you send or discard them (they
are gone when the browser closes) and **Off on this site** keeps a site out of a recording. After a page
load the browser may stop the recorder on the new page; then the popup says *Paused* and one click on
Sara's button there goes on. The owner (or a household member, in their own space) can switch recording
off in *Settings → Connections → Devices and sign-in → Browser extension → Let it record steps you show it*.

## Install (unpacked; nothing is published)

The extension is **not published** to any store yet. Everything the Chrome Web Store, Edge Add-ons and
Firefox Add-ons ask for (zips, texts in six languages, permission justifications, data disclosures,
pictures, step-by-step) is ready in [STORE_LISTINGS.md](STORE_LISTINGS.md); the privacy policy is
[EXTENSION_PRIVACY.md](EXTENSION_PRIVACY.md). Uploading is the owner's step.

Build the zips (optional; you can also load the `extension/` folder directly):

    node scripts/pack-extension.ts

They land in `outputs/extension/` (`sara-chrome-<version>.zip`, `sara-edge-<version>.zip`,
`sara-firefox-<version>.zip`, `sara-extension-source-<version>.zip`, and `listing/` texts); the version
is Sara's, from `package.json`.

**Chrome / Edge:** open `chrome://extensions` (Edge: `edge://extensions`), switch on **Developer mode**,
click **Load unpacked** and pick the `extension/` folder (or an unzipped copy of the chrome or edge zip).

**Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick
`manifest.json` inside an unzipped copy of the firefox zip. A temporary add-on is removed when Firefox
closes; a permanent install needs a signed add-on (Mozilla signs listed add-ons for free). Firefox 140 or
newer (its built-in data consent screen lists what the extension sends: page content and the page address).

## Pair it

1. Click the Sara button in the toolbar, type her address (for example `https://sara.example.com`) and
   press **Connect**. Allow the browser to reach that address.
2. The popup shows a short code. In Sara open **Settings → Connections → Devices and sign-in** (or the
   link in the popup), check that the code matches and approve it (Sara asks for your token, two-step
   code or passkey).
3. Done: it is listed under *Devices and sign-in* as **browser extension**. **Sign out** there revokes it
   at once; **Disconnect** in the popup does the same from the browser.

Its token can only reach the extension's own routes (`/api/ext/*`): no chats list, memories, settings or
devices. In Settings → Connections → Devices and sign-in → **Browser extension** you can switch it off, or
switch off only form filling.

## How it works (one page)

| Part | Where | What |
|---|---|---|
| Popup | `extension/popup.{html,js,css}` | Pairing, the four actions, the fill approval card, the per-site switch. |
| Page readers | `extension/lib/extract.js`, `lib/fields.js` | Injected into the tab only after a click: readable text (article/main, no scripts, menus, forms or hidden parts) and the form fields (never-fill rules, filling only approved refs). |
| Shared | `extension/lib/common.js` | Server address, per-site list, caps, the only network calls (to the paired Sara, token, no cookies). |
| Menu | `extension/background.js` | Right-click entries; opens the popup with what was picked. |
| Strings | `extension/_locales/{en,es,fr,de,pt_BR,it}` | Browser-native i18n. |
| Server | `src/extension.ts`, `src/routes/extension.ts` | Device scope `extension`; `GET /api/ext/state`, `POST /api/ext/ask` (an *extension* chat per ask, run as an outside app, the page fenced as outside content), `POST /api/ext/save`, `POST /api/ext/fill` (plan from My details via `src/form-fill.ts`); `GET/PUT /api/extension` for the two switches. |
| Pairing | existing device-code flow (`src/device-flow.ts`) | The same short code and approval as the terminal app and VS Code, with its own scope. |

What existed and was reused: the device-code sign-in and Devices list (Phase 52), My details and the
never-fill form rules (N4 `pc_fill_form`), the Library, outside-app turns (`externalTurn`), the Shortcuts
rate limiter (R4) and the audit trail.
