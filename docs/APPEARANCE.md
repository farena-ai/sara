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
| **Glass blur** | The frosted blur behind the header, sidebar, message box and windows. *Auto* keeps it on, except in Firefox, where blurring the moving page made long chats slow (see [Performance](PERFORMANCE.md)). *Off* keeps the same colors with solid panels. | Auto |
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

## Default looks: she, he and they

Sara ships three built-in characters, each with the full picture set a look has (portrait, five mood
portraits, small avatars, a blink and four mouth shapes per mood, and face landmarks for the animated
picture):

| | Pictures | Who |
|---|---|---|
| **Default (she)** | `web/sara-portrait.jpg`, `web/sara/…` | Sara: auburn-brown waves, freckles, cream sweater |
| **Default (he)** | `web/looks/he/…` (same paths) | a man in his early 30s: short tousled dark brown hair, light stubble, moss-green sweater |
| **Default (they)** | `web/looks/they/…` (same paths) | an androgynous adult in their late 20s: messy black jaw-length shag, small hoops, mustard sweater |

Until you make or pick a look of your own, the one that matches her pronouns shows (**Default look:
Matches the pronouns**, in *Settings → Her → Look*), or the one you pick there by name. A custom look
always wins: it is never replaced, and going back to the default look shows the chosen default again.
When you change her pronouns while a default look shows, the app asks once whether to use the matching
one; the pictures change at once, without a reload. The sign-in page and companions other than the
main one are unchanged (Sara's portrait, or the companion's initial).

How they were made (2026-11, Grok Imagine through Hermes' image tool, painterly style matched to
Sara's portrait): a first portrait as an edit of Sara's portrait (same room, lamp, plants, synth,
light and framing, a different person: *"Repaint this exact picture as a different person, keeping the
identical art style, … The person is now a friendly adult man in his early 30s: short dark brown hair
neatly tousled, light stubble, warm brown eyes, a kind relaxed closed-mouth smile, … a cozy moss-green
chunky knit sweater. Original character, not resembling any real person."*; for they: *"… a truly
androgynous, gender-ambiguous adult in their late 20s …"*, then *"… a messy jaw-length shag of black
hair with soft wispy bangs …, a small silver hoop earring …"*). Every mood and every blink/mouth frame
was then made from that portrait with exactly the prompts `src/look.ts` uses for a new look
(EXPRESSION_EDIT, BLINK, MOUTH_EDIT), so a default animates like any made look. The frames were
registered to their mood portrait (scale and shift, checked visually), scaled to 512 px (avatars
160 px) at the same JPEG quality as Sara's, and the landmarks in `sara/face.json` were measured on the
portrait and refined from where the blink and mouth frames differ (the same method reproduces Sara's
own landmarks within half a percent). Both sets together are about 2.6 MB.

## Her name and pronouns everywhere

The app is written for "Sara" (she/her). When you rename her or pick other pronouns, every built-in
word about her follows, in all six languages, on every screen, in the help page, notifications,
the installed app's name and her own character sheet; text you or she wrote is never rewritten.
"Sara" stays where it names the product (*the Sara app for Windows*, *Sara Store*, *Update Sara*,
*Sara 3.3.0*, *Sara Classic*). How it works, for translators and developers:

- `src/identity.ts` is the one place that knows her name and pronouns (shared by the server and the
  page). English: `personalize()` rewrites the name and she/her/hers/herself. Other languages:
  `personalizeTranslation()` swaps the name, picks a `{p, select, she {…} he {…} other {…}}` variant
  where grammar needs one (adjectives and participles that agree with her), fixes agreement right after
  her name or pronoun (French *doit-elle → doit-il*, *s'est arrêtée → s'est arrêté*; Italian, Spanish
  and Portuguese participles) and, only in strings whose English speaks of her, the strong pronouns
  (French *elle/lui*, Spanish *ella/él*, Italian *lei/lui*, Portuguese *ela/ele, dela/dele*; for they, her
  name). German "sie" is also "they", "it" and formal "you", so German only changes a sentence that
  starts with her; use `{p, select, …}` where a German string needs it.
- `web/naming.js` renders all page text and every `t()` string through it, and re-renders text built
  in code when she is renamed (no reload). The help page does the same (`web/help-i18n.js`).
- A translation that needs a gendered word for her: write it as `{p, select, she {prête} he {prêt}
  other {prêt·e}}` (French they takes the inclusive form; other languages use the masculine).
- `test/name-everywhere.test.ts` keeps it that way: no hand-made renames in web code, no companion
  words in raw markup, well-formed pronoun choices in every language.
