# Her voice in the home: Alexa, Google, Siri, your phone's assistant and presence

Sara 2.1 can be reached through the voice assistants already in your home, and can notice what
happens there through Home Assistant. Each way is optional and set up on its own.

| Way in | What you get | Set up | Works today |
|---|---|---|---|
| **Alexa** (Echo, Alexa app) | "Alexa, open sara companion", then talk to her | Your own Alexa skill in development mode ([ALEXA.md](ALEXA.md)) | Yes, built into Sara (`/alexa`) |
| **Android: default digital assistant** | Long-press home / the assistant gesture opens her listening | Phone settings → Default apps → Digital assistant app → Sara | Yes (Android app) |
| **Google Home / Nest speakers** | Her replies and announcements spoken on them | Through Home Assistant ([HOME_ASSISTANT.md](HOME_ASSISTANT.md)) | Yes, via Home Assistant |
| **Home Assistant voice** (Voice PE, ESPHome satellites, the HA app) | Sara as the conversation agent | Home Assistant integration | Yes (since 1.x) |
| **Siri** (iPhone) | "Ask Sara" → say your message → her reply in Siri | Nothing: comes with the iPhone app | Built and compiled; ships with the next iPhone app update |
| **Siri / Shortcuts on a Mac** | A Shortcut that asks her through her API | A Shortcut with an API key (below) | Yes (no native Mac intent yet) |
| **Presence** | She notices you got home, left, bedtime, morning lights | Settings → Add-ons → Home Assistant → Presence | Yes, via Home Assistant |

## The same rules everywhere

- **She says she is an AI**: on Alexa at the start of every session and every 3 hours; through Home
  Assistant and Siri her normal 3-hour notice is part of the reply; a speaker announcement starts
  with it every 3 hours. Asked sincerely, she always says she is an AI.
- **Crisis resources** and the **block on anything sexual involving minors** apply to every way in.
- **Speakers in a room are shared places.** Alexa and Home Assistant (voice satellites and the
  speakers it talks through) are treated like a shared channel: never explicit, whatever Adult mode
  says, and your private matters stay out unless you bring them up there. Your own phone (the
  Android assistant, Siri on your iPhone) is your normal conversation with her.
- **Private, imported and group chats** never reach Alexa or Home Assistant turns.
- Nothing here is available on the demo server. Alexa and Google need the internet, so they pause
  while **Nothing leaves this computer** is on; a Home Assistant on the same computer keeps working.

## Alexa

See [ALEXA.md](ALEXA.md): create the skill (Custom, your own endpoint `https://<her address>/alexa`,
a certificate from a trusted authority), paste the interaction model Sara gives you and the skill
ID, then link each person's Alexa with a one-time code. Sara verifies every request's signature by
Amazon's rules (no Amazon SDK), routes each linked Alexa to that person's own space and companion,
and keeps a conversation called **Alexa** you can read in the app. Alexa allows about 8 seconds:
she says "one moment", and if she needs longer she says so and keeps the answer for your next ask.

## Android: Sara as your phone's assistant

1. Install the Sara Android app and sign in ([PHONE.md](PHONE.md)).
2. Phone settings → **Apps → Default apps → Digital assistant app → Default digital assistant app**
   → **Sara** → OK. (Android shows its usual note that an assistant app may read the screen; Sara
   doesn't ask for the screen and reads nothing from it.)
3. Long-press the home button, swipe up from a bottom corner (gesture navigation) or press the
   assistant key: Sara opens and starts listening if voice is set up (Settings → Voice: she needs
   "hearing"), or puts the cursor in the message box. Tap the mic again to send.

Limits, said plainly: **"Hey Google" can't be replaced.** The hotword belongs to Google's own app on
the phone; Android doesn't let another app listen for a wake word in its place, so Sara opens from
the long press / gesture / assistant key, not by voice. Turning Sara back off: pick Google (or None)
in the same setting.

## Google Home and Nest speakers (through Home Assistant)

Google doesn't let anyone add their own voice apps to Google Home any more (Conversational Actions
were shut down in 2023), so a Nest speaker can't send what you say to Sara. What works:

- **Listening** happens through Home Assistant's own Assist: a Home Assistant Voice Preview
  Edition, an ESPHome satellite, the Home Assistant app on your phone or watch. Make **Sara** that
  assistant's *conversation agent* (Home Assistant → Settings → Voice assistants).
- **Speaking** can happen on Google Home and Nest speakers: Home Assistant sees them as media
  players (the **Google Cast** integration finds them on your network) and can say Sara's words on
  them with a text-to-speech service. Use it for Presence announcements (below), or in an
  automation: `sara.send_message` (her reply comes back as a response variable) followed by
  `tts.speak` on `media_player.<your nest>`. Details and an example: [HOME_ASSISTANT.md](HOME_ASSISTANT.md).

## Siri (iPhone)

The iPhone app has an **Ask Sara** App Intent: say **"Ask Sara"** (or "Talk to Sara"), Siri asks
"What do you want to tell her?", and her reply comes back as Siri's answer. It is also an action
in the **Shortcuts** app (with a Message field), so it fits in your own shortcuts and automations.
It uses the server the app is using now and that server's sign-in (with several Saras, switch in
the app first), and talks in a conversation of her own called **Siri**. Status: built and compiled
for the iPhone simulator; it reaches iPhones with the next App Store update of the app.

## Siri and Shortcuts on a Mac

The Mac app is a small native wrapper built without Xcode's project system, so it doesn't carry
App Intents yet. Until it does, a Shortcut can ask her through her **OpenAI-compatible API**
(works on Mac, iPhone and iPad, with or without the app):

1. In Sara: Settings → Connections → Other apps → **Create an API key** (name it "Shortcuts").
2. Shortcuts app → new shortcut named **Ask Sara**:
   - **Ask for Input** (Text, prompt "What do you want to tell her?")
   - **Get Contents of URL**: `https://<her address>/v1/chat/completions`, Method **POST**,
     Headers `Authorization` = `Bearer <your key>`, Request Body **JSON**: `model` = `sara`,
     `messages` = an Array with one Dictionary (`role` = `user`, `content` = *Provided Input*).
   - **Get Dictionary Value** `choices` → **Get Item from List** (First Item) → **Get Dictionary
     Value** `message.content`, then **Show Result** (or **Speak Text**).
3. "Hey Siri, Ask Sara" runs it. The AI notice and safety rules apply as for every app (docs/OTHER_APPS.md).

## Presence (through Home Assistant)

**Settings → Add-ons → Home Assistant → Presence**, per companion, off until you switch it on:

- Pick the **people or phones** to watch (`person.…` or `device_tracker.…` from Home Assistant),
  and what she reacts to: **getting home**, **leaving**, **bedtime** (a switch or input_boolean
  turning on, or a time while someone is home) and **a light going on in the morning** (inside a
  window you choose).
- She reacts with one short line of her own: **a message** (a notification on your devices), **an
  announcement** on a Home Assistant speaker (`tts.speak` on a `media_player`: a Google Home, Nest,
  Sonos or Voice PE), or both. Announcements start with the AI notice every 3 hours, and are
  written for a room others may hear (never explicit, no private details).
- **At most once every few hours per kind** (1 to 12 hours, 3 by default) and **never in the quiet
  hours** of *Calls from her* (Settings → Voice → Calls from her). **Try it now** says a line at once.
- Sara asks Home Assistant for just those entities once a minute (its REST API; no websocket
  client). Nothing is kept but the time each kind last fired; the line she said is in your
  conversation like any message.
- **Household:** members have no Home Assistant in 2.0, so presence is the owner's only.

## Matter and SmartThings (evaluated, not built)

- **Matter** is a standard for devices (lights, plugs, sensors) talking to a controller; it has no
  voice-assistant or conversation side, and a Matter controller needs Thread/Wi-Fi commissioning
  that Home Assistant already does well. Sara gains nothing by being a Matter controller herself:
  connect Matter devices to Home Assistant, and Sara sees and controls them (and their presence
  sensors) through it.
- **SmartThings** has a cloud API with a personal access token (devices, scenes, presence via the
  SmartThings app's location mode). It would be a second smart-home bridge doing what the Home
  Assistant bridge already does, and SmartThings can be added to Home Assistant with its official
  integration. Recommendation: no direct SmartThings code; use it through Home Assistant. Revisit if
  owners ask for it without Home Assistant.

## Privacy

What each way sends: [PRIVACY.md](PRIVACY.md). In short: Alexa sends what you say (as text) to
Amazon and Amazon sends it to your server; her reply goes back through Amazon to the speaker.
Siri turns your voice into text on Apple's side. Home Assistant and Presence stay between your
server and your Home Assistant (and Google's speakers only receive the audio Home Assistant sends
them). The attack surface of the Alexa endpoint: [THREAT_MODEL.md](THREAT_MODEL.md).
