# Language practice (W4.3)

Library → **Learn a language…** is a few minutes a day of practice in Spanish, French, German,
Portuguese, Italian or English. Everything you hear and say stays on this computer: her local voice
for that language speaks, and the local hearing on this computer listens. No cloud voice or cloud
hearing is ever used here.

## Setting it up

- **I'm learning**: the language you practice. Meanings are shown in the language Sara uses for you
  (learning English in English shows Spanish meanings).
- **My level**: Beginner (A1), Elementary (A2) or Intermediate (B1). It picks the sentences and keeps
  her replies at that level in Talk practice.
- **Cards a day**: 5, 10 or 20 cards per session at most.

Each language and level gets its own study set ("español · A1"), made from a built-in bank of everyday
sentences. It is a normal Study set: it shows in Library → Study, on the Today tile and in the daily
"cards due" reminder, and it exports to Anki like any other set.

## A session

1. **Cards**: the sentence, then Show meaning and Again / Hard / Good / Easy. Spaced repetition
   (SM-2, the Study engine) brings hard cards back sooner.
2. **Listen**: Play (or Slower) says a sentence in her local voice for the language; Show the words
   shows it with its meaning.
3. **Say it back**: Hear it, then Say it and speak. With the multilingual hearing installed you see
   your words while you speak. Each word is marked right, close (with what she heard) or not heard,
   and you get one gentle tip ("Very close. Listen to “favor” once more and say it again.").
   Accents and capital letters are forgiven, extra words never cost points.

The chips on top show your streak (days with practice: cards or sentences), the words you know (words
you said right plus the words of learned cards), learned cards and sentences said today.

## Talk practice

**Practice talking** opens Talk with Sara in a chat called "Practice: español" (one per language).
In that chat she answers only in the language you learn, in one or two short sentences at your
level, asks a question back, and adds at most one gentle correction ("You could say: …"). Talk
hears you in that language and speaks with the local voice for it. Typed messages in that chat get
the same treatment.

## What you need on this computer

- A local voice for the language (Settings → Voice; Piper voices are named by language).
- Local hearing in the language: English uses the normal local hearing; Spanish, French, German,
  Portuguese and Italian need the multilingual hearing (`sara voice install --languages`, W0.3).
- Without them the page says so plainly: cards always work, listening needs the voice, Say it back
  and Talk practice need both.
- A household member whose voice is turned off gets cards and progress only.

## Details

- State per person: `<dataDir>/lang-learn.json` (prefs, practice days, words said right, the
  practice chat per language). Cards live in the person's own study tables.
- Routes ride the `study` family: `GET|PUT /api/study/lang`, `POST /api/study/lang/say|hear|score|talk|warm`.
  `POST /api/voice/speak {local: true}` is the Talk-practice voice: local only, 409 when the language
  has no local voice.
- Code: `src/lang-learn.ts` (bank, scoring, engine), `src/lang-learn-note.ts` (state file and her
  practice-chat note, read by chat.ts), `web/lang-learn.js` (page), `web/talk.js` (`learnLang`).
