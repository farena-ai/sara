# Visual Regression

Compare supplied PNG image pairs offline with Sara's `compare` tool. Detect exact changed pixels across desktop and phone viewport labels without capturing personal windows. This plugin does **not** launch a browser, accept URLs or paths, discover files, take screenshots, inspect a desktop, or execute a workspace. Users need their own authorized capture pipeline. Supplied images themselves can contain sensitive information; only submit images you are authorized to process.

## Input

`schema.json` is the complete closed nested schema. Supply `{ "pairs": [{ "viewport": "desktop", "baseline": "<base64 PNG>", "candidate": "<base64 PNG>" }] }`. One or two pairs; viewport is exactly `desktop` or `phone`, each at most once. These are labels, not a claim that the plugin independently verifies how an image was captured. PNG dimensions within each pair must match. A dimension mismatch refuses the entire invocation; it is never an unchanged verdict.

Limits before image decoding: 60000 serialized UTF-8 input bytes; canonical base64 strings at most 13336 characters and PNG files at most 10000 bytes each. Width 1–1280, height 1–960, at most 1000000 pixels per image and 4000000 pixels over all supplied images. At most 64 chunks per PNG. Every chunk length, order and CRC is checked before inflate. Only IHDR, contiguous nonempty IDAT and final empty IEND are admitted. **8-bit RGB/RGBA, noninterlaced only.** Palette, grayscale, 16-bit, interlaced, APNG and all ancillary chunks (including text, transparency and color profiles) refuse. Unsupported ordinary PNG files must be explicitly converted by the user's owned pipeline; this plugin never silently strips or changes them.

Inflate uses Node's native `zlib.inflateSync` with **maxOutputLength equal to the validated exact scanline size**, at most 4000960 bytes per image. Short/long expansion, invalid filters, truncated streams, unconsumed compressed bytes and trailing file bytes refuse. Checked decoded-byte and pixel dimensions precede output buffer allocation. Processing is synchronous and bounded, not a preemptive wall-clock or OS sandbox guarantee. The standalone runtime has no npm dependencies. Test-only independent oracle is pngjs 7.0.0 (MIT), scoped and locked with scripts disabled; not shipped in this plugin.

## Evidence and privacy

The result contains fixed viewport labels, pair indices, dimensions, exact changed-pixel counts, total pixels, SHA-256 hashes of supplied PNG files, and a single bounding rectangle enclosing all changed pixels (or null). RGBA bytes are compared exactly; RGB gets opaque alpha. No perceptual threshold, anti-alias suppression, gamma/color-profile management, visual significance score or automatic pass tolerance. Differences in invisible RGB channels still count. Encoded file hashes may differ when decoded pixels are identical.

No original pixels, source text, filenames, paths, screenshots or diff heatmaps are emitted. Hashes, dimensions and rectangles are still potentially identifying metadata, not a universal confidentiality guarantee. Native errors are generic and do not echo supplied values. No persistence or independent broker calls. Source images are transient process input, not proof that the caller's chat/history is private or unrecorded.

Output refuses above 8000 content bytes or a 12000-byte serialized envelope; no clipping. Invocation-scoped `result.card`, not a separate card broker call. Six locales: en, es, fr, de, pt-BR, it. Fixed protocol keys, labels and numbers stay literal.

## Qualification, not publication

Qualification uses exclusively owned synthetic HTML rendered headlessly at 1200×800 and 390×844, DPR 1, network blocked, animations disabled and no text font dependency. It verifies 960 seeded changed pixels and exact rectangle (32,96,40,24), plus unchanged controls, through the actual restricted SDK and registered PluginManager tool. Default tests read checked fixture PNGs only; they never launch a browser. Opt-in fixture capture requires `VISUAL_REGRESSION_OWN_BROWSER=1` and a preinstalled compatible browser; no browser download or personal profile.

Authoring checkout 2.67.0; official package compatibility target 2.68.0. This does not qualify a complete 2.68 application, chat approval, Settings discovery, other OS fences, automatic audit, signed publication, or Store readiness promotion. See the repository's qualification report for exact hashes, receipts and remaining parent-owned gates.

The images under `shots/` are labelled synthetic result previews generated from actual handler output, **not Sara application screenshots or supplied image pixels**.
