# V3.1 My apps (design)

ROADMAP_V V3.1 (item 21). User doc: [../MY_APPS.md](../MY_APPS.md).

## What existed
- `src/preview.ts`: token-scoped, sandboxed live previews of apps her jobs run (12 h, job-bound).
- `src/share.ts`: read-only expiring share links for conversations (expiry presets reused).
- `src/worktrees.ts`, `src/sandbox-run.ts`: coding workspaces and sandboxed runs.
- Missing: keeping an app after the job ends, versions, Undo, data, a page to find them.

## What was built
- `src/my-apps.ts` `MyApps` (one sqlite per space folder, `<space>/my-apps/apps.db`): `apps`
  (name, current version, open token, share token + until), `versions` (files as base64 JSON, note,
  bytes; 30 kept, never the shown one dropped), `data` (per-app JSON values). keep / edit (merge on
  the shown version, `remove`) / undo (highest version below the shown one) / restore / rename /
  remove / share / unshare / data get-set-delete. Limits in `APP_LIMITS`.
- Serving: `serveMyApp` at `/myapp/<space>/<token>/…`, dispatched in `src/server.ts` next to
  `/preview` (before the cross-origin guard, never on the demo). `main.ts` `spaceByCredential`
  routes the address to the named space (`myAppSpace`). CSP sandbox without allow-same-origin +
  `connect-src 'self'`, no cookies read or set. Every HTML page gets `_sara/data.js`
  (`web/myapp-data.js` filled with the app's root): `appData.get/set/remove/keys/readOnly`.
- Routes: `/api/library/apps[/:id[/undo|restore|share]]` inside the Library family (dispatched
  before the "library is not available" check), so members work and no route-group churn.
- Tools (`src/tools/my-apps.ts`): `app_keep`, `app_edit`, `app_undo`, `app_read`, `app_list`
  (auto, undoable; reads interruptible); lean family `myapps` with six-language words.
- Web: Library → **My apps…** (`#lib-apps`, `web/my-apps.js`): card per app with Open, Look here
  (sandboxed iframe), Undo last change, Versions… (Go back to this), Rename, Delete, share link
  with expiry, Copy, Stop sharing. `#view=apps`.

## Choices
- Static files only, so "no server code from the model" holds by construction.
- Share tokens are stored in plain (like the open token) so the owner can copy the link again;
  revoking replaces/clears it at once. Share links are read-only.
- No Settings page: nothing to configure; tips sit on the Library entry and the view heading.

## Acceptance
- build → keep → edit → Undo restores the previous version: `test/v3-apps.test.ts` (store,
  routes, tools, served page) and the live check (`<scratch>/v3apps/live.ts`: real chat turns call
  app_keep/app_edit, Undo clicked in the Library, page title back to version 1, data kept).
- The app never gets the Sara session: CSP sandbox without allow-same-origin, no Set-Cookie, the
  token is refused as a bearer; live: inside the app `document.cookie` and storage throw
  SecurityError, `/api` is blocked by CORS, `https://example.com` by `connect-src`.
