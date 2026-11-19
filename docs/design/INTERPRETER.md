# V4.2 Live interpreter (design, one page)

Two people who don't share a language talk through Sara: each turn is heard, translated and spoken
in the other language, and the transcript is saved.

## What existed (grep first)
- `web/talk.js` + `src/talk.ts` (U4.24 Talk with Sara): the hands-free turn loop on top of the classic
  call (`web/voice.js` `Call`: energy VAD, SpeechGate, barge-in, `Speaker` sentence queue, streaming
  hearing V0.2). The interpreter rides this loop instead of a second one.
- `src/speech.ts` `Speech.speak/transcribe`: every voice engine (local Piper/Kokoro + Parakeet, OpenAI
  speech API, ElevenLabs, Grok voice). Only Grok voice took a language; local voices had none.
- `src/cheap.ts` `cheapCall`: small model calls with a local-first route, daily ledger, usage purpose.
- `src/lang-text.ts` `clearLang` (six languages by function words).
- No translation feature existed (i18n.ts only translates the app's own strings).

## What is built
- `src/interpreter.ts`: `INTERP_LANGS` (20 codes), prefs per person (`<dataDir>/interpreter.json`:
  `a`, `b`, `cloud`), `guessSide` (script + `clearLang`, else the hint, else the other side of the last
  turn), `translateTurn` (one `cheapCall`, local model first; a cloud model only when the person
  allows it; the words are fenced as data; JSON answer `{from, text}` so the model can correct the
  side), and `InterpreterLog` (one JSON file per session under `<dataDir>/interpreter/`, newest 100
  kept, plain-text export).
- Routes in the existing `talk` family (`src/routes/interpreter.ts`, dispatched from phone-calls.ts):
  `GET/PUT /api/talk/interpret`, `POST …/start`, `POST …/turn`, `POST …/end`, `GET/DELETE …/:id`,
  `GET …/:id/text`. Members use it with their own data dir; `limits.voice === false` → 403.
- Voice in a language: `/api/voice/speak {lang}` → `Speech.speak(…, {lang})`: Grok voice gets the
  language, a local voice whose id/label names the language is picked (`voiceForLang`), OpenAI and
  ElevenLabs read any language. `/api/voice/transcribe?lang=auto` drops the talk-language hint.
- Web: `web/interpreter.js` (`InterpreterSession`, no DOM, unit-tested; page wiring). Talk with Sara
  gets an **Interpreter** button: the talk screen turns into a big two-sided screen (the far half
  upside down on a phone so the other person reads it across the table), a language picker per half,
  "My turn" buttons as a hint. Settings → Sara → Voice → Interpreter: the two languages, the cloud
  switch, Start, and the saved transcripts (open, download, delete).

## Rules
- Translation never runs as a chat turn: no memory, no tools, nothing in her chats.
- Local first; with no local model and the cloud switch off, the turn says so and shows the words.
- Strings via t()/en() in 5 languages; language names come from `Intl.DisplayNames`.

## Acceptance
`test/v4-interpreter.test.ts`: fake hearing (scripted transcribe) and fake voice translate both
directions through the routes and the web session; the transcript file holds every line.
