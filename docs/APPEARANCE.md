# Appearance

*Settings → You → Appearance* sets how the app looks on each device. Since 2.77.0 the default is a
calm, dense, precise look made for long work sessions; the earlier rose and violet look is kept
as *Sara Classic*. The defaults below are the owner's choice (unreleased, branch `hermes/v3`).

The page has three groups, *Theme*, *Layout and text* and *Chat behaviour*, with a live preview on the
right (on a computer) that follows every change at once. **Reset to defaults** puts this device back to
the defaults below (it asks first); Ctrl+K → *Reset the look to the defaults* does the same.

| Setting | What it does | Default |
|---|---|---|
| **Palette** | Graphite, Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast, or Sara Classic (the cards). A palette is a full preset: picking one also sets its colour back to the default (Violet; Sara Classic its rose), and you can change the colour after. | Graphite |
| **Night or Day** | Night, Day or *Follow the system*. Every palette has both. | Follow the system |
| **Colour** | The swatches: the palette's own colour (*Theme colour*), eight presets, or any colour you pick (+). Sara adjusts its shade so text on it stays readable. | Violet (Sara Classic: its rose) |
| **Decoration** | *Full*: soft glass on the sidebar, header and windows, a faint glow on the main button and a very slow, faint light behind the app. *Reduced*: flat. Your system's *Reduce transparency* turns it off; High contrast stays solid. | Full |
| **Her picture** | The presence orb, *Her portrait, animated* (she breathes, blinks, glances, moves her lips while she speaks and shows what she is doing and her mood), *Her portrait, still*, *Your picture* (the one uploaded on her page) or *A 3D model (.vrm)*. This device only. | Presence orb |
| **Her picture in work views** | How big her portrait is in chats and Settings. | Small |
| **Layout** | *Comfortable* or *Compact* (fits more on screen). | Comfortable |
| **Text size in chat** | Small, Normal, Large or Larger. | Normal |
| **Her replies appear** | As fast as they arrive, or typed like a person. | As fast as they arrive |
| **Sessions shown** | How many sessions each project lists before *See more*. | 5 |
| **Use on all my devices** | A new device starts with the same look. Each device can still change it. | |

Defaults apply to every choice you never made on a device; anything you picked stays. Sara Classic
keeps its own earlier defaults (Night, its rose colour, decoration on, her large picture), so it looks
exactly as before for anyone who picks it.

Every palette meets WCAG AA contrast for text and the accent colour (checked by
`test/v1-theme.test.ts`). The look is applied before the page first paints, so there is no flash,
and *Reduce motion* in your system settings is respected.

Outside Sara Classic each chat turn shows who wrote it, when, and how long she took; the header
shows one *model · workspace* chip with a small meter of how full the conversation is; the sidebar
starts with *Go to* (Today, Planner, Library, Add-ons…), then your projects, then the conversations;
Settings opens on *All settings* (every page under its group, one click away) with *Settings › group ›
page* above each page; usage and a run's model calls are tables. Sara Classic keeps its earlier layout.

When you first open 2.77.0 after using an earlier version, a one-time notice offers
**Switch back to Sara Classic**. You can change palettes any time.

## Her picture

*Her picture* chooses how she appears in the new look (Sara Classic keeps its own portrait). A
picture shows round with a thin ring that follows what she is doing (listening, thinking, speaking).

- **Presence orb** (default): the glass orb.
- **Her portrait, animated:** her portrait comes alive. She breathes, blinks every few seconds, now and
  then looks aside or tilts her head; while she listens she looks at you, while she thinks she looks up
  and away, and while her voice plays her lips follow it. Her mood shows too: sleepy has heavy lids and
  slow breaths, happy smiling eyes, hurt looks down. In the chat header and the sidebar (small) she only
  breathes and blinks; her panel, Today, her page and calls show everything. The blinks and mouth
  shapes are real drawn pictures of her (the frames every look has), so a new look animates the same way.
  Anyone who had picked *Her portrait* before gets the animated one.
- **Her portrait, still:** the same picture without motion.
- **Your picture:** the picture you uploaded on her page. It breathes with the ring at once; **Fit the
  face** (drag three dots onto the eyes and the middle of the mouth) adds blinks and glances. Uploading a
  new picture clears the fit.
- **A 3D model (.vrm):** **Choose a .vrm file** (VRM 0.x or 1.0, up to 50 MB, for example from VRoid
  Studio). The file stays in this browser and is never uploaded; it is checked first (a self-contained
  .vrm only: nothing is fetched from elsewhere, nothing in it runs). She blinks, looks around, moves her
  lips with her voice and shows her mood through the model's expressions. The model's name, author and
  licence show under the setting: use a model you are allowed to use. The 3D engine (three.js and
  three-vrm, both MIT) loads only when a model is chosen.

**Background motion: Off** and your system's *Reduce motion* show one still picture (her mood) and
the ring; nothing animates. The animation pauses when the tab is hidden or the picture is off screen,
and runs at most 30 frames a second.
