# Video calls

A video call is a normal call with her (live or classic, as described under *Voice and calls* in the
help guide)
where you see her **moving picture full size** while you talk: her current look, outfit and place,
with her lips following her voice, blinking, breathing and small head movements. You can also show
her **your camera**, if you want to. It is off until you turn it on.

## Starting one

- **🎥** next to **📞** at the bottom of a conversation starts a video call. During a voice call,
  **🎥 Video** under her picture switches to video, and **⤡** (top right of the video screen) goes back
  to the small view; the call goes on.
- When she rings you, **🎥 Video** answers with video (**Answer** answers with voice only).
- The video screen has a call timer, **Mute** (your microphone), **Camera**, **Sound** (her voice on or
  off), **Captions** (what you both say, as text) and **End**. It fits a phone held upright and a desktop
  window. With *reduce motion* set on your device, her picture moves less (no head sway, a calmer
  mouth).
- Not in group chats (calls are one to one) and not in conversations with other people.

Her face follows her mood, and for a moment what she is saying (a laugh, a caring word, teasing).
That last part reads English words and emoji; in other languages her mood alone sets it.

The **AI notice** is part of every call, as in the chat: at the start of a call when it's due and
every 3 hours, on the video screen as well as in the chat, and the screen always shows an
*AI companion* label. She answers honestly if you sincerely ask whether she is an AI, crisis help
is shown on the call screen, and the hard block on sexual content involving minors applies to
everything said on the call.

## What she knows and can do on a call

On a call she has what she has when you type in the same chat: her memories, this conversation,
*Lately in your other conversations*, your project checkpoint, your tools and approvals, and Adult
mode only where text has it (never in a room like Home Assistant or Alexa). A household member's
call has that member's own rules, never the owner's.

- **Classic call:** a tool that needs your OK shows its card on the call screen and she says
  *"I need your OK for that. It is on your screen."* Only a tap answers it. Talking over her, hanging
  up, or two minutes without a tap cancels it (she says so); nothing runs after the call.
- **Live call:** her tools are offered to the voice service, which only asks; Sara's server decides
  with your auto/ask/never rules and runs it. Cards work the same way: a tap, never a spoken "yes".
  A tool starts only after your words are final. Each result is noted in the chat. Commands, her
  hands on your computer and SSH stay in the chat. On a voice service without tool calling the call
  screen says *On this voice, ask me in the chat to use tools* and offers **Switch to classic**.

## Your camera (optional)

Press **📷 Camera** to turn it on. A small self-view appears with a red **● Camera on** label; press
again (*Camera off*) to turn it off. Ending the call turns it off.

What happens to the picture depends on who answers on this call:

| Call | Can she see your camera? |
|---|---|
| Live call with **OpenAI** | Yes: a still picture goes to OpenAI's Realtime service in the call. |
| Live call with **Grok voice** | No: Grok's realtime voice doesn't take pictures. The camera is a self-view only and the screen says so. |
| Classic call, a model that can look at pictures (for example `gemma4`, `qwen2.5vl`, `llava`, GPT-4o, Claude, Gemini) | Yes: the newest picture goes with what you say (every sentence while it is under 30 seconds old). |
| Classic call, a model that can't (or Sara can't tell) | No: self-view only; the screen says which model and how to pick one that can (*Settings → Models → Which model does what → Looking at pictures*). |

Sara asks Ollama which of its models take pictures (Ollama lists *vision* for them); for other
providers it goes by known model names.

**How often she looks:** *Settings → Her → Voice → On video calls she looks*: only when you press
**👀 Look at this**, or every 5, 10 (the default), 20 or 30 seconds. **Look at this** sends a picture
now and asks her what she thinks. *Camera pictures per call* caps a call at 20, 40, 60 (default) or
120 pictures. Both are per companion and save by themselves. The server enforces the same limits
(and never more than one picture every 3 seconds), so a page or app can't send more.

### What is sent where

- The app takes a still from the camera, shrinks it to at most **512 pixels** on its long side and
  sends it as a JPEG to **your Sara server** (the one you're using), only while the camera is on and
  only when she can see it. Nothing is sent for a self-view.
- **Live call (OpenAI):** the server passes it straight to the call, with a short note that it is from
  your camera. **Classic call:** the server keeps only the newest picture **in memory** for up to 30
  seconds (a newer one replaces it) and gives it to the model with what you say in that time, then
  drops it.
- **Nothing is recorded or saved**: not in the conversation, not in uploads, not in backups. The
  conversation keeps only what was said. If you want a picture kept, send it as a photo in the chat.
- Her reply about it is saved like any other reply.

### When the camera is refused

The server refuses camera pictures (and the screen says why):

- on the **demo server**;
- in **group chats** and conversations with other people;
- when **Nothing leaves this computer** is on and the model (or live voice service) isn't on this
  computer, and in **private conversations** with a model that isn't on your own hardware;
- for an hour after a **safety block** in that conversation (the check on sexual content involving
  minors), and for the rest of a live call after one. There is no picture classifier in Sara: what
  is checked is everything said about the pictures, by you and by her, with the same rules as the
  chat; a block also stops the camera;
- after the per-call cap, or more often than the setting allows.

## Phones and computers

- **Web app** (any browser with a camera and microphone, over HTTPS or `localhost`): everything above.
- **Android app:** the app asks for the camera the first time you turn it on (the microphone as
  before). A video call runs inside the app's page, not as the background call service, so keep the
  app open during a video call; voice calls still go on with the screen off.
- **iPhone app:** iOS asks for the camera the first time (the camera is used only for photos you send
  and, if you turn it on, video calls). As on Android, a video call runs in the app's page; the
  locked-screen call screen (CallKit) is for voice calls.
- **Windows app:** the camera and microphone are allowed for your Sara server only (WebView2).
- **Mac app:** macOS asks for the camera the first time (the microphone as before); allowed for your
  Sara server only.

## For developers

- Server: `src/video.ts` (limits, the JPEG check, who may get pictures, what models see, the
  in-memory video sessions), routes `GET /api/video/<conversation>`, `POST …/start`, `POST …/end`,
  `POST …/frame` (`image/jpeg`, `?ask=1` for *Look at this*) in `src/server.ts`; `liveFrame` on a
  message (`src/chat.ts`, never stored); `LiveCall.frame()` and the video note in `src/live.ts`
  (`/api/live/<conversation>?video=1`, or `{type:'video'}` to switch a voice call).
- Web: `web/video-call.js` (the screen), `web/video-logic.js` (timer, picture size, pacing,
  expressions, captions; tested in Node), `web/presence.js` and `web/mouth.js` (her face).
- Tests: `test/phase69.test.ts`.
