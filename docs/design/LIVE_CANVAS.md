# D3 Live canvas in chat (2026-11-18)

ROADMAP_V D3: she can post a small interactive view (checklist, table, chart) in the chat that
stays current with where its data lives, and runs sandboxed with no Sara session.

## What existed (reused, not rebuilt)
- `src/my-apps.ts` (V3.1): token-in-path serving `/myapp/<space>/<token>/`, `APP_CSP` (CSP sandbox
  without allow-same-origin, `connect-src 'self'`), no cookies read, 404 for unknown tokens, per-space
  folders, member routing in `main.ts` `spaceByCredential` via `myAppSpace`.
- `src/preview.ts` / `web/mcp-apps.js` (C3): sandboxed chat frames (`sandbox="allow-scripts"`),
  postMessage only from `origin === 'null'` frames that are ours.
- `src/cards.ts` + `web/result-cards.js`: tool result cards stored in the tool message's meta.
- `analyze_table` chart card (static, from one result) and `doc_checklist` (contract checklists in a
  document): both are one-off snapshots, not live.

## What D3 adds
- `src/canvas.ts`: `CanvasStore` per space (`<space>/canvas/canvas.db`). A canvas = kind
  (`checklist` | `table` | `chart` | `html`), title, its own data, and a **source**:
  - `own`: the data she gave; she changes it with `canvas_update`, the person ticks items.
  - `tasks`: Planner to-dos (optionally one project): ticking a row completes the task; a task done
    anywhere else shows ticked within seconds.
  - `app`: one data name of a kept My app (`appData`): what the app saves shows up here.
- Served at `/myapp/<space>/cv<22-char token>/` by the same `serveMyApp` door (one dispatch line), so
  member routing, the CSP and "no cookies" come for free. Files: `index.html` (built by Sara),
  `_sara/canvas.js` (Sara's renderer, `web/canvas-frame.js`), `_state?rev=` (204 when unchanged),
  `_tick` (POST, checklist only), `_save` (POST, html canvases with an own source only).
- Model-written HTML (`kind: 'html'`) follows the My apps rules: static only, capped (200 KB), served
  under `APP_CSP`, gets the small `saraCanvas` helper (`onData`, `save`) and nothing else.
- Tools (`src/tools/canvas.ts`, lean family `canvas`): `canvas_post`, `canvas_update`, `canvas_list`.
  `canvas_post` returns a `canvas` card (id only; the address is fetched by the page through
  `/api/library/canvases/:id`, so a shared chat never leaks the write token).
- Chat card `web/canvas-card.js`: a frame with `sandbox="allow-scripts"`, the theme in the address
  hash, height from the frame's `postMessage` (accepted only from that frame, origin `null`, capped).
- Library → My apps gains a "Live views" list (open its chat, remove).

## Live updates
The frame polls `_state?rev=<rev>` every 3 s while visible (15 s after 10 minutes, paused when
hidden); `rev` is a short hash of the state, so an unchanged view costs a 204. No Sara events reach
the frame (it has no session); the source is read fresh on every poll.

## Security (acceptance: "its script cannot read the page")
- Opaque origin twice (iframe sandbox + CSP sandbox): no `parent.document`, no Sara cookies, no
  storage; the cookie is SameSite=Strict and never read on `/myapp/` anyway, so `fetch('/api/…')`
  from the frame is a 401. `connect-src 'self'`: nothing goes to other sites.
- The token is the only key, bound to one canvas in one space; removing the canvas kills it.
- Ticking a `tasks` row can only complete/reopen tasks that the source lists.

## Out of scope
Share links for canvases, editing cells in the frame, charts other than bar/line.
