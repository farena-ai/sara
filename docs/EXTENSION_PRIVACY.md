# Sara browser extension: privacy policy

Applies to the "Sara" extension for Chrome, Edge and Firefox. Last updated: 2026-11-18.

**In short:** the extension talks to **your own Sara** server and to nothing else. It sends a page to
your Sara only when you click one of its buttons. The makers of the extension never receive your data:
there are no analytics, no ads, no tracking and no servers of ours in between.

## What it sends, and where

Everything goes only to the one Sara server you pair the extension with (the address you type when you
connect, for example `https://sara.example.com`). Sara is software you or your household run yourselves.

| When you… | It sends to your Sara |
|---|---|
| Click **Ask Sara about this page** or **Summarize** | The page's address and title, the text you selected, the page's readable text (at most 20,000 characters) and your question |
| Click **Save page to Library** | The page's address, title and readable text |
| Click **Fill this form** | The form's field labels, names and types and the choices of drop-down lists (never the values typed into them) |
| Click **Watch me do this**, then **Send to Sara** | The steps you did in that tab while it watched: what you clicked (its visible text or label), what you typed or picked (never passwords, payment cards, codes or ID numbers: only that you typed one), and each page's address without the part after `?` or `#` |
| Right-click selected text → **Ask Sara** | The selected text and the page's address |
| Connect | A short pairing request with a name for this browser (for example "Sara for Chrome on Windows") |

It never reads a page by itself, in the background or on a schedule: only the tab you are on, at the
moment you click (the browser's `activeTab` permission), or, after you press **Watch me do this**,
that one tab until you press **Stop**. On a site you switch **Off on this site**, nothing is read or
sent at all.

## What it never does

- It never fills or sends passwords, payment card details, one-time or verification codes, or social
  security / government ID numbers. Those fields are skipped in the page and refused again by Sara.
- It never submits a form: you see every proposed value, untick or change any, approve, and then press
  the form's own button yourself.
- It does not collect browsing history, keystrokes, mouse movement, location or cookies. While **Watch
  me do this** runs it keeps only the steps listed above, and only for that tab.
- It does not load or run code from the internet; all of its code ships inside the extension.
- It does not sell, share or transfer data to anyone. There is no third party involved.

## What it keeps in your browser

In the browser's own extension storage: your Sara's address, the device token Sara gave it when you
approved the pairing, your list of sites where it is switched off, and the steps of a **Watch me do
this** recording until you send or discard it (session storage, gone when the browser closes).

## What your Sara keeps

Your Sara stores what you ask and her answers as a chat, and pages you save as Library documents, under
your own account on your own server, like anything else you do in Sara. You can read and delete them
there at any time. Form values come from **My details** in Sara and are typed into the page only after
you approve them. Steps you send from **Watch me do this** wait in *Settings → Skills* until you save
them as a skill or automation, or delete them.

## Turning it off

- **Disconnect** in the extension's popup forgets the token and removes its access to your Sara's
  address at once.
- In Sara, **Settings → Connections → Devices and sign-in** lists the extension as "browser extension";
  **Sign out** there ends its access too. The same page has switches to turn the extension, form
  filling or step recording off.
- Removing the extension from the browser deletes everything it kept in the browser.

## Children

The extension is not meant for children. Child accounts in a Sara household cannot use it: Sara refuses
the extension for them.

## Changes

If this policy changes, the new version is published at this address with a new date, and the change is
listed in Sara's changelog.

## Contact

Questions or concerns: open an issue at https://github.com/farena-ai/sara/issues (or see SECURITY.md
in the same repository for private security reports).
