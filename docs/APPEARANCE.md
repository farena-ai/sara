# Appearance

*Settings → You → Appearance* sets how the app looks on each device. Since 2.77.0 the default is a
calm, dense, precise look made for long work sessions; the earlier rose and violet look is kept
as *Sara Classic*.

| Setting | What it does |
|---|---|
| **Palette** | Graphite (default), Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast, or Sara Classic. |
| **Night or Day** | Night, Day or *Follow the system*. Every palette has both. |
| **Colour** | The palette's own accent, eight presets, or any colour you pick. Sara adjusts its shade so text on it stays readable. |
| **Layout** | *Comfortable* or *Compact* (fits more on screen). |
| **Decoration** | Glows, glass and moving light. On for Sara Classic, off for the others. |
| **Her picture** | How big her portrait is in chats and Settings. |
| **Use on all my devices** | A new device starts with the same look. Each device can still change it. |

Every palette meets WCAG AA contrast for text and the accent colour (checked by
`test/v1-theme.test.ts`). The look is applied before the page first paints, so there is no flash,
and *Reduce motion* in your system settings is respected.

Outside Sara Classic each chat turn shows who wrote it, when, and how long she took; the header
shows one *model · workspace* chip with a small meter of how full the conversation is; Settings
opens as a full-height panel listing every page; usage and a run's model calls are tables; and the
sidebar lists your projects above the conversations. Sara Classic keeps its earlier layout.

When you first open 2.77.0 after using an earlier version, a one-time notice offers
**Switch back to Sara Classic**. You can change palettes any time.
