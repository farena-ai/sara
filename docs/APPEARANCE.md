# Appearance

*Settings → You → Appearance* sets how the app looks on each device. Since 2.77.0 the default is a
calm, dense, precise look made for long work sessions; the earlier rose and violet look is kept
as *Sara Classic*. The defaults below are the owner's choice (unreleased, branch `hermes/v3`).

The page has three groups, *Theme*, *Layout and text* and *Chat behaviour*, with a live preview on the
right (on a computer) that follows every change at once. **Reset to defaults** puts this device back to
the defaults below (it asks first); Ctrl+K → *Reset the look to the defaults* does the same.

| Setting | What it does | Default |
|---|---|---|
| **Palette** | Graphite, Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast, or Sara Classic (the cards). | Graphite |
| **Night or Day** | Night, Day or *Follow the system*. Every palette has both. | Follow the system |
| **Colour** | The swatches: the palette's own colour (*Theme colour*), eight presets, or any colour you pick (+). Sara adjusts its shade so text on it stays readable. | Blue |
| **Decoration** | *Full*: soft glass on the sidebar, header and windows, a faint glow on the main button and a very slow, faint light behind the app. *Reduced*: flat. Your system's *Reduce transparency* turns it off; High contrast stays solid. | Full |
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
