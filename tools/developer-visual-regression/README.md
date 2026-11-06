# Owned Visual Regression fixture capture

This repository-only utility renders the trusted checked-in `owned.html` fixture. It is not part of the native plugin, does not accept live URLs or projects, and does not connect to a desktop, CDP endpoint, personal profile or browser SDK bridge.

Use an already installed compatible Playwright **local `index.mjs` module file** and its already installed matching browser directory. No install or browser download is performed. All three variables are required; missing module/browser configuration refuses before import or browser launch. There is no user-directory or cache fallback.

POSIX-shell example (replace the placeholders with your own authorized local paths):

```sh
SARA_PLAYWRIGHT_MODULE='<absolute-path-to-playwright/index.mjs>' \
PLAYWRIGHT_BROWSERS_PATH='<absolute-path-to-installed-matching-browsers>' \
VISUAL_REGRESSION_OWN_BROWSER=1 \
node tools/developer-visual-regression/capture-owned.mjs
```

These assignments apply only to that command; do not change global environment settings. The browser uses sandboxed ephemeral headless contexts, blocked network requests and only trusted owned HTML. Preserve existing fixtures and capture evidence before regeneration. The utility writes six actual PNGs (1200×800 and 390×844; baseline/candidate/control) and `outputs/developer-addons/visual-regression/browser-capture.json`, binding the HTML and image SHA-256 values. Expected seed: 960 changed pixels, rectangle x32/y96/width40/height24, with zero changed pixels for controls. Re-run the scoped SDK/manager/package tests and `verify.ts` after capture.

No runtime PNG contract changes are implied: the plugin remains offline, bounded exact RGB/RGBA8 comparison, without broader PNG support or live capture capability. Qualification is not publication.
