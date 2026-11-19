# How Sara comes across (W1.4)

One personality drives her writing, voice and face. Settings → Sara → Name and personality →
*How Sara comes across*.

## What existed (and where each surface picked its style before)

| Surface | Before W1.4 | Store |
|---|---|---|
| Chat text style | persona.json (`speech`, `talk`, dials, humour) → system prompt | persona.json |
| Humanizer | S11 Writing style Natural / As written + voice card → `writingNote` | `writing_prefs` (per space) |
| Email drafts | the model wrote the body; only the S11 note; **no sign-off anywhere** | none |
| Voice (Talk, voice notes, calls) | `Speech.speak` read `settings.voice` | `settings.voice` (companion key) |
| Briefing audio | read `settings.voice` itself (`v.localVoice, v.speed`) | same, second reader |
| Receptionist (V3.5) | fixed greeting `Hi! I can answer…`, no tone at all | reception settings |
| Her picture (A1/V4d) | per-device `localStorage sara.herPicture`; nothing per person | browser only |

Disagreements: the receptionist ignored her personality entirely; briefing audio had its own copy of the
voice read; a new device always showed the orb whatever the person had chosen elsewhere; email drafts had
no sign-off rule.

## Design

- **One source per person = the existing persona store.** persona.json (per companion, per household
  member space) gains a small `style` block: `signOff` (≤ 80 chars, ≤ 2 lines), `greet`
  (`warm|casual|brief|formal`), `face` (`orb|portrait|still|own`). Validated by `validatePersona`
  (`src/persona-style-file.ts`, import-free), carried by the character file (`scrubPersona` keeps it and
  swaps the owner's name for `{{user}}`). Voice stays in `settings.voice` and the humanizer level stays in
  `writing_prefs`: no second store.
- **One resolver:** `src/persona-style.ts` `personaStyle(app)` → name, text rules, voice
  (`herVoice`: engine, id, local voice, speed), humanizer, voice card, sign-off, greeting style (default
  from *How she talks*: texting → casual, thoughtful → warm, brief → brief), face.
- **Every surface reads it:** `writingNote` adds the sign-off line (only when one is set);
  `Speech.speak` takes voice id/speed from `herVoice`; `briefingSpeaker` too; the receptionist's default
  greeting and a tone line come from `greet` (a greeting typed on the receptionist page still wins);
  the web reads `face` from `GET /api/persona/style` and uses it on devices without their own pick
  (`document.documentElement.dataset.herFace`, read by `herPictureMode` in web/v4-picture.js).
- **Routes** (existing `persona` family, members get their own): `GET/PUT /api/persona/style`,
  `POST /api/persona/style/preview {sentence}` (no model call).
- **UI:** a top-level h3 section above the Character file card (not folded): sentence box, a preview of
  chat bubble / voice + Play / email line with sign-off / receptionist greeting, then sign-off, greeting
  style, picture, writing. Saves on change. `web/comes-across.js` (`hca-` ids).

## Tests

`test/w1-persona.test.ts`: validation, resolver, email sign-off note (S11 unchanged without one),
receptionist greeting + tone, Speech uses the same voice/speed, preview, routes + character file, and a
source check that every surface imports `persona-style.ts`.
