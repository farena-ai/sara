# The Sara Store's first shelf

These are the sources of the add-ons the Sara team lists in the Sara Store
(<https://backstagecoding.com/sara/store/>). They are MIT, like `examples/`, and each one is also a
test fixture: `test/phase124.test.ts` runs the store's checks (`src/store/checks.ts`) on every item
and starts every plugin with a fake channel.

```
store/
  shelf.json            which items are listed, in this order, and their shelf (category)
  plugins/<id>/         sara-plugin.json, main.mjs, sara-plugin.mjs, icon.png, shots/, CHANGES.md
  mcp/<id>.json         a tool-server recipe: the exact command, pinned version, fields and tips
  mcp/shots/            <id>-1.png (screenshot), <id>.icon.png
```

Day one (Sara 2.57.0): six plugins (Weather alerts 2, Webhook notes 2, Home scenes, GitHub digest,
Reading list, Focus) and six tool servers (ComfyUI, Blender, Browser (Playwright), GitHub, Files on
this computer, Docs (Context7)).

Rules for every item (the same checks run for everyone who submits):

- Plugins: a valid `sara-plugin.json` with a `?` tip on every setting, at least one screenshot in
  `shots/` (PNG, JPEG or WebP, at most 1 MB), a `CHANGES.md` section for the version, no key-shaped
  strings, and no address in the code that isn't in `permissions.network`.
- Tool servers: the command is `npx`, `uvx`, `docker` or `node`, never a shell; versions are exact
  (`name@1.2.3`, `name==1.2.3`, a commit, or an image digest); only `${setting:<field>}` and `${home}`
  templates; every field has a tip. `tested` lists only the computers we really ran it on.

The screenshots show an example of what each add-on puts in Sara. The shelf is built and signed on
the Sara team's computer; the signed list is what Sara checks before it trusts anything here.
