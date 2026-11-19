# My apps

Small web apps she builds for you (a plant-watering tracker, a packing list, a score keeper, a
quiz for the kids) can be kept on your own Sara server, with every version and a little saved data.

## Keep one
1. In a chat, ask: "Make me an app to track watering my plants." She builds it.
2. Try it, then say "keep it". She keeps it as version 1 (`app_keep`).
3. Open the Library and press **My apps…**. Each app shows its version, size and how much it saved.

## Change it, or go back
- Tell her what to change ("make the title bigger"); each change is a new version (`app_edit`).
- **Undo last change** goes back one version. **Versions…** lists them all; **Go back to this**
  shows any older one. Editing after that builds on the version shown.
- Undo and older versions change the app's files only: what the app saved stays.

## Use and share it
- **Open** opens it in a new tab; **Look here** shows it inside the Library.
- **Share a link** makes a read-only address that works for an hour, a day, a week, a month or until
  you stop it. People with the link see the app and its saved data but can't change it.
  **Stop sharing** ends it at once.
- **Rename** and **Delete** (every version and its saved data) are on the same card.

## What an app can and can't do
- It is only pages, styles, scripts, pictures and fonts: nothing she writes runs on the server.
- It runs in a sandbox: it never gets your Sara sign-in, can't read Sara's data or reach the
  internet. It can only keep its own small data (up to 100 names, 1 MB) with
  `appData.get/set/remove/keys`.
- It is served by your own server only (the address is on your Sara). Each household member keeps
  their own apps in their own space.

Details for developers: [design](design/MY_APPS.md), [threat model](THREAT_MODEL.md).
