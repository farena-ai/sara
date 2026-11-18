# Pictures

Pictures of her (portraits, new photos, pictures she sends on her own) are in [PHOTOS.md](PHOTOS.md).
This page covers your own pictures: editing them and making short clips on your own computer.

## Editing pictures and short video

*U4.28. Owner only. Free: it runs on your own ComfyUI; nothing is uploaded to a service.*

Sara edits pictures from your Library and makes short video clips with
[ComfyUI](https://www.comfy.org/) running on your computer, through the same ComfyUI tool server
(`comfyui-mcp`) that **Pictures from her** uses. Add it once in **Settings → Skills & tools → Tool
servers**; ComfyUI must be running.

### What you can do

Open **Library → Pictures and video…**, or open a picture in the Library and choose **Edit picture…**.

| Edit | How | Needs in ComfyUI |
| --- | --- | --- |
| Change a part | Paint over it with the brush, describe what goes there (or leave it empty to remove it) | A picture model (checkpoint) |
| Extend the edges | Pick a side; she continues the scene 256 pixels that way | A picture model |
| Upscale | 2×, 4× or 4K (the long side becomes 3840) | An upscale model (e.g. 4x-UltraSharp); without one it is a plain resize, and she says so |
| Remove the background | One click | The ComfyUI-RMBG node; if it is missing she names it and how to install it |
| Change the style | Describe the style and set **How much may change** (a touch to nearly new) | A picture model |

Each result is a **new Library item**. The original is never changed: the editor's **Versions** row
shows the original and every edit, and the **Before and after** slider compares the last edit with the
picture it came from. Only the painted part changes when you paint (the rest keeps its own pixels).

**Short video.** In **Pictures and video**, describe the clip, optionally pick a Library picture to
start from, choose 2, 3 or 5 seconds and **Make the clip**. Clips are saved as animated WebP files in
the Library. Each job shows what it is doing (sending, waiting for ComfyUI, working, saving) and how
long it has been running; **Cancel** stops it in ComfyUI too.

Only video models that are already installed are offered:

- **Wan 2.1** text-to-video (1.3B or 14B, with the umt5 text encoder and the Wan 2.1 VAE) and
  image-to-video (480p/720p, plus the CLIP vision H file).
- **LTX-Video 0.9** (a checkpoint plus the T5 XXL text encoder), from words or a picture.
- **Your own workflow**: any video workflow you saved inside ComfyUI (Settings → Pictures from her →
  Video recipe). Sara fills its first prompt box and its Load Image nodes.

Other video models found (Wan 2.2, LTX-2, Hunyuan Video) are named with that way out. **Nothing is
ever downloaded**: if a model is missing, she tells you what to add in ComfyUI.

### In chat

Ask in your words: "remove the person on the left", "make it 4k", "extend it to the right", "make it
look like a watercolor", "make a short video of waves at sunset". She edits the picture you name (or
your newest Library picture), shows the result and keeps it in the Library. A chat ask uses a rough
area (left, right, top, bottom, center); for an exact area, paint it in the editor. A clip she can't
finish in a few minutes keeps going in **Pictures and video**.

### Settings

**Settings → Sara → Pictures from her → Editing and short video**: the ComfyUI status, the picture
model edits use, the video recipe (automatic or one of your saved workflows) and the clip length.

### Safety

The same picture rules as everywhere in Sara:

- **Kid mode** has none of it (no tools, no page; the routes are the owner's).
- Never anything sexual involving minors.
- Explicit pictures and clips from words only when adult mode is on.
- **Never a sexual or nude edit of a real photo** (or a clip started from one), with or without adult
  mode: a photo may show a real person.
- With **Nothing leaves this computer** on, ComfyUI must be on this computer (a tool server pointing
  at another computer is refused).

Household members don't get it: ComfyUI and its tool server are the owner's.

### Design (one page)

- **Engine** `src/media-studio.ts` (`MediaStudio`, one per owner space, `app.media`): reads
  `list_local_models` (cached a minute) into *caps* (what each edit and video recipe can do with what
  is installed, and why not); builds API-format workflows (`editWorkflow`, `videoWorkflow`,
  `fillOwnVideo`); runs a job: upload the picture (and mask) with `upload_image` from a private temp
  folder (deleted right after), `enqueue_workflow` (or `generate_image remove_background`), poll
  `queue status` + `get_history` (`readComfyHistory` with clip files too), fetch with `get_image`
  into the temp folder only, then `LibraryStore.add` + `setRead` (kind `image`/`video`, no picture
  model reads it) and a `media_versions` row (family = the original). Jobs live in memory (last 40,
  three at a time); cancel aborts and calls `queue cancel_queued` + `cancel`.
- **Rules** `mediaAskProblem` runs before anything is sent (kid, minors, adult mode, real photo);
  private local mode checks the tool server's `COMFYUI_URL`/URL is loopback.
- **Routes** `src/routes/media.ts` (`/api/media…`, owner only, not in the demo): caps/jobs/prefs,
  items, edit, video, job, cancel, versions, the file inline.
- **Tools** `src/tools/media.ts`: `picture_edit` (region mask from `regionMask`, waits up to 5
  minutes, attaches the result) and `video_make` (waits up to 4 minutes); lean family `media`; not in
  `KID_TOOLS`.
- **Web** `web/media-studio.js`: Library sub-view `#lib-media`, editor `#mx-editor` (a canvas over
  the picture for the brush; the mask is an off-screen white-on-black PNG at the picture's own size),
  versions strip, before/after slider, Settings section `#mx-settings`.
- **Tests** `test/u4media.test.ts` with recorded `comfyui-mcp@0.52.206` answers (no ComfyUI needed).
