# Browser extension: store listings (owner steps)

V0.7. Everything the Chrome Web Store, Edge Add-ons and Firefox Add-ons ask for, ready to paste. Agents
never publish and never make accounts: uploading is yours. The extension itself is described in
[EXTENSION.md](EXTENSION.md); its privacy policy is [EXTENSION_PRIVACY.md](EXTENSION_PRIVACY.md).

| Store | Account | Cost | Upload |
|---|---|---|---|
| Chrome Web Store | Google account → Chrome Web Store developer account | **$5 one-time fee** (you pay it) | `sara-chrome-<v>.zip` |
| Edge Add-ons | Microsoft account → Partner Center (Edge program) | free | `sara-edge-<v>.zip` |
| Firefox Add-ons (AMO) | Firefox account | free | `sara-firefox-<v>.zip` (+ `sara-extension-source-<v>.zip` if asked) |

## 0. Make the files (each release)

    node scripts/pack-extension.ts

Writes `outputs/extension/` (gitignored), with `<v>` = the version in `package.json` (e.g. 3.24.0;
stores need a higher version for every update, which each Sara release gives):

- `sara-chrome-<v>.zip`, `sara-edge-<v>.zip` (same files; background service worker),
  `sara-firefox-<v>.zip` (background script, add-on id `sara-extension@backstagecoding.com`,
  `data_collection_permissions`, Firefox 140+), `sara-extension-source-<v>.zip` (the source and
  `BUILD.md` for AMO reviewers);
- `listing/<locale>.txt`: name, summary and long description per language (en, es, fr, de, pt_BR, it).
  The texts live in `extension/_locales/*/messages.json` (`extName`, `appDesc`, `storeDescription`).

Pictures (committed, private paperwork folder) in **`docs/store/extension/`**:

| File | Size | Used by |
|---|---|---|
| `screenshot-1-ask.png`, `screenshot-2-fill.png`, `screenshot-3-pair.png`, `screenshot-4-summary.png` | 1280x800 | Chrome, Edge, Firefox |
| `screenshot-*-640x400.png` | 640x400 | Edge (either size works) |
| `promo-440x280.png` | 440x280 | Chrome small promo tile, Edge small promo tile |
| `promo-640x400.png` | 640x400 | spare tile / social |
| `promo-1400x560.png` | 1400x560 | Chrome marquee, Edge large promo tile (both optional) |
| `logo-300.png` | 300x300 | Edge store logo |

They come from a throwaway Sara with made-up data (a plant-care page, "Alex Rivera", `sara.example.com`).

## Texts for every store (English; other languages in `listing/<locale>.txt`)

- **Name:** Sara: your own AI in the browser
- **Summary (≤132):** Ask Sara about the page you are on, save it to her Library, or let her fill a
  form after you approve it.
- **Description:** paste `listing/en.txt` → *Description*.
- **Category:** Chrome: **Productivity → Workflow & Planning** (or *Tools*). Edge: **Productivity**.
  Firefox: **Other** (AMO has no Productivity group; add *Search Tools* only if you want a second).
- **Website / homepage:** https://github.com/farena-ai/sara
- **Support:** https://github.com/farena-ai/sara/issues (email if a field needs one: sara@backstagecoding.com)
- **Privacy policy URL:** https://github.com/farena-ai/sara/blob/main/docs/EXTENSION_PRIVACY.md
  (works once this branch is in the public repo: publish the public copy first, or paste the file's
  text where a store accepts text instead of a URL.)
- **Language:** English default; add es, fr, de, pt-BR, it from `listing/`.
- **Single purpose:** Sara connects the browser to the user's own, self-hosted Sara AI companion so the
  user can ask about, summarize or save the page they are on, or have a form on it filled with their own
  details after approving each value.
- **Remote code:** No. All code is in the package; no remote scripts, no `eval`.

### Permission justifications (one by one; the minimum the four actions need)

| Permission | Why it is needed | Why nothing smaller works |
|---|---|---|
| `activeTab` | Read the tab you are on, only when you click the toolbar button or a right-click entry. | No standing access to any site; the grant ends when you leave the tab. |
| `scripting` | Inject the page helpers (`lib/extract.js`, `lib/fields.js`, `lib/teach.js`) into that tab after the click: one reads the readable text, one lists form fields and types approved values, one records or replays the steps of Watch me do this. | `activeTab` alone can't run code in the page; no content scripts are declared, so nothing runs on pages by itself. |
| `storage` | Keep your Sara's address, the device token and your "off on this site" list, plus a hand-over from the right-click menu to the popup. | Nothing is synced; it stays in this browser. |
| `contextMenus` | The two right-click entries: "Ask Sara about the selection" and "Save this page to Sara's Library". | No other way to add them. |
| `http://*/*`, `https://*/*` (optional host permission) | Asked once at pairing **for your Sara's address only** (e.g. `https://sara.example.com/*`), so the extension can call your own server. It is never asked for any other site. | Your server's address is yours to choose, so it can't be listed in advance; it is optional, so nothing is granted at install (checked live in a fresh profile). |

Reviewer note (paste into Chrome's *Justification* / Edge's *Notes for certification* / AMO's *Notes to
reviewer*):

> Sara is a self-hosted AI companion (open source, https://github.com/farena-ai/sara). To try the extension
> you need your own Sara: `git clone https://github.com/farena-ai/sara && cd sara && docker compose up -d`
> (or the Windows installer from the latest release), open it at http://localhost:7860 and finish the short
> setup. Then click the extension, type `localhost:7860`, press Connect, allow the address, and approve the
> shown code in Sara (Settings → Connections → Devices and sign-in). The extension talks only to that
> server, reads a page only when clicked (Watch me do this: only the steps in that tab until Stop, reviewed
> before sending), never fills or records passwords, cards or codes, and never submits forms.
> No analytics, no remote code. Source zip with build steps attached (AMO).

### Data-use disclosures

**Chrome → Privacy practices tab** (what the extension handles; it goes only to the user's own server):

| Data type | Tick? | Why |
|---|---|---|
| Personally identifiable information | **Yes** | Name, email, address from the user's My details are typed into a form after approval. |
| Health information | No | |
| Financial and payment information | No | Card fields are never filled. |
| Authentication information | **Yes** | The device token for the user's own Sara, kept in extension storage. Passwords are never read or filled. |
| Personal communications | **Yes** | The question the user types to their own Sara. |
| Location | No | |
| Web history | **Yes** | The address and title of the page the user clicks on (one page, on click). |
| User activity | **Yes** | Only after the user presses Watch me do this, in that one tab until Stop: what they clicked and typed (never password, card, code or ID values), reviewed by the user before it is sent. No keystroke-by-keystroke logs, no scrolling or mouse movement. |
| Website content | **Yes** | The readable text of the page the user asks about or saves. |

Tick all three certifications: not sold or transferred to third parties; not used for anything unrelated
to the single purpose; not used for creditworthiness or lending.

**Edge → Properties:** *Does your extension access, collect or transmit personal information?* **Yes**
→ privacy policy URL above. Category Productivity. Mature content: No.

**Firefox:** the manifest already declares `data_collection_permissions` (required:
`websiteContent`, `browsingActivity`, `websiteActivity` for Watch me do this); Firefox shows them at install. In the AMO form, answer that the
add-on sends data only to a server the user chooses (their own Sara), link the privacy policy, and pick
**Firefox** (desktop) only: Firefox for Android has no right-click menus and is untested.

## Chrome Web Store, step by step

1. Sign in at https://chrome.google.com/webstore/devconsole with the Google account that should own it,
   accept the developer agreement and **pay the $5 one-time registration fee**. Verify the contact email.
2. **New item** → upload `outputs/extension/sara-chrome-<v>.zip`.
3. **Store listing:** description from `listing/en.txt`, category, language; screenshots
   `docs/store/extension/screenshot-1…4.png` (1280x800); small promo tile `promo-440x280.png`;
   marquee `promo-1400x560.png` (optional). The icon comes from the zip. Add the other languages from
   `listing/*.txt` (name and summary come from the zip's `_locales`).
4. **Privacy practices:** single purpose, the five permission justifications above (the host one under
   *Host permission justification*), Remote code: No, the data table, the three certifications, the
   privacy policy URL.
5. **Distribution:** Public (or Unlisted for a first test), all regions. **Submit for review**; a few days.

## Edge Add-ons, step by step

1. Sign in at https://partner.microsoft.com/dashboard/microsoftedge with a Microsoft account and register
   for the Microsoft Edge program (**free**; individual account is fine).
2. **Create new extension** → upload `outputs/extension/sara-edge-<v>.zip`.
3. **Availability:** Public, all markets.
4. **Properties:** category Productivity, privacy policy: Yes + URL, website and support links above.
5. **Store listings** (English, then add es/fr/de/pt-BR/it): description from `listing/<locale>.txt`,
   store logo `logo-300.png`, small promo tile `promo-440x280.png`, screenshots (1280x800 or the
   640x400 copies), large promo tile `promo-1400x560.png` (optional).
6. **Submit**, with the reviewer note in *Notes for certification*. Review takes up to 7 business days.

## Firefox Add-ons (AMO), step by step

1. Sign in at https://addons.mozilla.org/developers/ with a Firefox account (**free**); accept the
   distribution agreement.
2. **Submit a New Add-on** → *On this site* (listed) → upload `outputs/extension/sara-firefox-<v>.zip`.
   Compatible with **Firefox** only (untick Android). The automatic check should pass (web-ext lint ran
   clean: 0 errors, 0 warnings).
3. *Do you need to submit source code?* The code is not minified or transpiled, so **No** is correct;
   if a reviewer asks anyway, upload `sara-extension-source-<v>.zip` (its `BUILD.md` says how to rebuild).
4. Listing: name, summary and description from `listing/en.txt` (add the other languages after the first
   version is in), categories (Other), support site, license **MIT**, privacy policy (paste the text of
   `docs/EXTENSION_PRIVACY.md` or the URL), screenshots from `docs/store/extension/`, the reviewer note.
5. **Submit Version**. Listed add-ons are signed by Mozilla for free.

## What to send back

The listing URLs (or "pending review") per store and any reviewer message. Never send passwords or
payment details. The agents then add the store links to EXTENSION.md and the README.

## What was checked here

- `node --test test/v0stores.test.ts test/u4ext-extension.test.ts`: manifests per store, version from
  package.json, every zip's file list, the source zip, the texts' lengths per store and language, this
  page's permission list, the picture sizes.
- `web-ext lint` (Mozilla's linter, run from a scratch folder) on the Firefox zip: 0 errors, 0 warnings,
  0 notices.
- Live, in Playwright Chromium with the unzipped Chrome store build in a **fresh profile**: no host
  access granted at install; Connect calls the browser's permission prompt for the Sara address and does
  nothing until it is answered (headless shows no prompt, so it waits; no code is fetched and nothing is
  granted silently); without the toolbar click the page can't be read. Pairing, ask, summarize, save,
  fill after approval (password left empty, form never sent) and a **household member** pairing with
  their own space on a real throwaway server (the page landed in the member's Library, not the owner's).
- Not done here (needs a person at a real browser): clicking *Allow* in the real permission prompt;
  Firefox and Edge by hand (load the zips via `about:debugging` / `edge://extensions`).
