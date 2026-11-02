# "Hey Sara" on desktop and Android: a wake word that runs on the device (design, Phase 126, version 2.59.0)

> **As built (2.59.0), 2026-11-02.** Server side (`src/wake.ts`, `src/wake-pack.ts`,
> `src/routes/wake.ts`: phrases and keyword lines from the model's own `en.phone`, device records
> switched on only by the device, the first-to-hear claim, `POST /api/wake/turn` in her "Hey Sara"
> conversation with the AI notice first and crisis resources in full, day counters, household and
> demo rules), part C (`src/voice-install.ts`, `sara voice install`, pinned SHA-256, `tar.exe`,
> refused in private local mode), the Settings → Her → Hey Sara page, and the Windows app
> (`desktop/windows/src/wake.cpp`: the pinned pack checked on every load, WASAPI 16 kHz capture,
> the keyword spotter, the tray dot, Talk to Sara on Ctrl+Alt+Space, pause while locked,
> `Sara.exe --test-wake`). Android ships the microphone foreground service (`WakeService.java`:
> Talk, Pause 1 h, Stop, the restart notice) and the **Talk to Sara** Quick Settings tile
> (`WakeTile.java`); the sherpa-onnx JNI libraries and the on-phone keyword detector are **not in
> this build** (deferred to 2.59.x with Mac and Linux), so Android has push-to-talk only. The pack
> mirror (`wake-pack-1`) is not published yet: devices fall back to the pinned upstream tarballs.

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.58.0 (Phases 115–125 released, the Sara Store live), plus the public feature pages of Hermes
Agent and OpenClaw that GAP_REVIEW cites, the docs of the wake-word engines and the platform rules
(sources in §20). It is a ground-up design: no code, schema, prompt or wording is taken from Hermes
Agent, OpenClaw or any engine's sample apps; this file names only their **features**. Zero new npm
runtime dependencies. No new run engine and no new kind of model call: a wake turn is an ordinary
turn in an ordinary conversation, heard by the hearing the owner already set up (`speech.transcribe`)
and spoken by the voice he already set up (`/api/voice/speak`). The one new heavy thing, the
keyword spotter, is **sherpa-onnx**, the same upstream (and the same pinned release, v1.13.8) that
`deploy/install-voice.sh` already installs for her local voice; it is an optional download the person
approves on each device, checked against a SHA-256 baked into the app, or (where a store forbids
downloaded code) a part of the signed app.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP line he approved:

- *Phase 126 (2.59.0):* "\"Hey Sara\" on desktop and Android (#17)."

And the gap review's pitch he said yes to (GAP_REVIEW §2, gap G17 in §1):

- **#17 · "Hey Sara", hands-free** (G17, M–L). *Pitch:* "say 'Hey Sara' to the computer or the Android
  phone and talk." *Fits:* "the desktop apps' quick ask window and the live call path (`live.ts`,
  `voice.ts`); the phone's assistant entry (Phase 72). Detection must run on the device (the OS speech
  services or a small model shipped with the native app, not an npm package)." *Simple UI:* "off by
  default; one switch per device with a clear 'listening for Hey Sara' dot; saying 'stop' ends it."
  Risk note (G17): "Always-on microphone: off by default, on-device detection only, nothing sent until
  after the wake phrase, a visible 'listening' indicator, one switch off."

(GAP_REVIEW §4 numbered this release 124 / 2.57.0; the ROADMAP moved it to **126 / 2.59.0** when the
Sara Store took two phases. This file follows the ROADMAP.)

**The brief for this design (from the parent, on the owner's behalf):**
1. *Read first:* the voice stack (`src/voice.ts`, `src/live.ts` with its engines and `seesImages`,
   speech-to-text and text-to-speech providers, the local voice, and **why "Local voice isn't
   available on Windows yet" is printed at start-up**); the desktop apps (`desktop/windows`,
   `desktop/mac`, the tray); the Android app; the iPhone app's status; push notifications; private
   local mode; the household rules; the safety layer (the AI disclosure in voice, crisis handling in
   voice); GAP_REVIEW #17 and how Hermes Agent, OpenClaw and others do wake words.
2. *Research, cited:* engines with no npm runtime dependency, or that run as an optional local
   model/binary the person installs (openWakeWord, Porcupine, Vosk, whisper.cpp streaming); Android's
   hotword limits (no "Hey Google"-style always-on for a third-party app except a foreground service
   with the microphone notification); battery and privacy; the browser's limits.
3. *Decide:* where the wake word runs (on the device only; no audio to the server until woken); the
   visible "listening" indicator; push-to-talk and a global hotkey on the desktop; false wakes; the
   per-device opt-in; custom wake words; household mode (whose Sara answers); the
   Windows/macOS/Linux/Android split, and the iPhone (likely not possible; say so).
4. *The document includes:* UI at 1440/390, tables and routes, the Done-when list for
   `test/phase126.test.ts`, owner to-dos (real-device checks: the Android emulator vs a real phone, a
   real microphone), risks, blocking questions with defaults. Every setting has a ? tip.

**Goal:** on his Windows PC, across the room, he says "Hey Sara, remind me to call Mum at six". A soft
two-note chime, the small quick-ask window slides in showing *Listening…* and her face, the words
appear as he says them are heard, she answers in her own voice ("Done: six o'clock, call Mum"), the
window fades, and the tray icon's dot goes back from bright to dim. Until the chime, **not one sample
of sound left the PC**; the detection ran on 1 % of one CPU core in a 5 MB model he downloaded once
after reading what it is. On his Android phone in his pocket, the same phrase works with the screen
off because the app runs a foreground service whose notification says *Listening for "Hey Sara"* with
**Pause** and **Stop**, and Android shows its own green microphone dot. When she reads her crisis
resources he can hear all of them, and her AI notice is spoken at the start, exactly as on a call.
When his partner, a household member, says "Hey Mira" to her own laptop, **her** companion answers in
**her** space; his Sara never hears it. And on the iPhone the doc says plainly why there is no "Hey
Sara" (Apple doesn't let an app listen in the background), and points to "Hey Siri, ask Sara".

**The rule of this track: build on what is there.** The desktop apps already have the pieces a wake
word needs except the detector: a tray / menu-bar icon, a global shortcut that opens the quick-ask
window (`RegisterHotKey` on Windows, Carbon `RegisterEventHotKey` on the Mac), a quick-ask page that
records his voice and sends it to the server's `/api/voice/transcribe` (`desktop/shared/quick-ask.html`
l. 437–460), microphone permission handling in WebView2 and WKWebView, and native notifications. The
Android app already has a microphone foreground service (`CallService`, `foregroundServiceType=
"microphone"`), the digital-assistant entry (`ACTION_ASSIST` → `window.saraAssist()`, Phase 72), the
"Call Sara" shortcut, the session cookie read natively (`CookieManager` in `CallService`) and
notifications with actions. The server already has hearing (`Speech.transcribe`), her voice
(`/api/voice/speak`), live calls (`/api/live/<conv>`), the safety layer for voice, household spaces
and private local mode. This phase adds **one native detector per app** (a thin wrapper around
sherpa-onnx's C API on Windows and macOS, its JNI on Android, its command-line tool on Linux), **one
"wake turn" route** that strings the existing hearing, turn and voice together with the safety layer
in the spoken order, **one small per-person file** (`wake.json`) for phrases and devices, and one
optional fix that this phase needs: **local hearing on Windows and macOS servers** (Part C), so "Hey
Sara" works while *Nothing leaves this computer* is on.

**Two word clashes to avoid.** "Wake" already means three things: `/wake` in Hermes Agent's slash
commands (a different feature, GAP_REVIEW [H3]), a webhook event that "may wake its plugin"
(`webhooks.ts` `#wake`), and a `/loop` tick that "wakes her on the reminder scheduler's existing
15-second tick" (`loops.ts` l. 3). This phase calls its feature **Hey Sara** in every word
the person sees (with her name substituted when she has another one: *Hey Mira*), and **wake** only in
code (`src/wake.ts`, `wake.json`, `/api/wake/*`, the `wake` channel). And "listening" is already an
activity label in the chat (`ACTIVITY_LABEL.listening`, "Listening", while the mic button records);
this phase keeps that word for the moment after the phrase and calls the always-on state
**asleep, waiting for "Hey Sara"** in code and *Listening for "Hey Sara"* on screen (the two are told
apart by the dot: dim vs bright, §4.6).

Contents: 1 what exists today (and why local voice says Windows isn't supported) · 2 how Hermes Agent,
OpenClaw and the others do it; the engines; the platform rules · 3 the shape and shared building
blocks · 4 part A: the detector on the device · 5 part B: the wake turn on the server · 6 the
platforms one by one (Windows, macOS, Linux, Android, iPhone, the browser) · 7 part C: local hearing
on Windows and macOS · 8 the UI at 1440 and 390 · 9 ? tips · 10 tables and files · 11 routes ·
12 Done when (`test/phase126.test.ts`) · 13 owner to-dos · 14 safety and privacy · 15 household
isolation · 16 reuse vs build · 17 risks · 18 the phase at a glance · 19 blocking questions with
defaults · 20 key choices in short · 21 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Voice engines | `src/voice.ts` (315 lines): `SttEngine = 'off'\|'local'\|'openai'`, `TtsEngine = 'off'\|'local'\|'openai'\|'elevenlabs'\|'xai'`; `LocalVoiceEngine` runs sherpa-onnx CLI tools as child processes from a `voice.json` manifest (Parakeet 110M speech-to-text, Kokoro and Piper voices); `defaultEngines()` starts both **off** where `localVoiceSupported()` is false | Her ears and mouth on the server, no npm dependency | A wake turn is heard by `stt` and spoken by `tts` as set here; nothing new on that side |
| Hearing | `src/speech.ts` `Speech.transcribe(audio)` (WAV in; local, OpenAI-compatible or xAI `xaiTranscribe` with keyterms); `POST /api/voice/transcribe` (`routes/voice.ts` l. 250) | Turns a WAV into text; the error when local is missing names the platform (l. 180) | The wake turn calls `transcribe` directly; `keyterms` can carry her name so "Sara" is spelled right |
| Her voice | `POST /api/voice/speak`, `speechText`, `spokenText` (`spoken.ts` strips Markdown, links, stage tags) | Text → audio in the chosen voice | Speaks the disclosure, the crisis lines and the reply, in that order (§5.5) |
| Live calls | `src/live.ts` (796 lines): `LiveEngine` with `GrokEngine` (`seesImages = false`) and `OpenAiEngine` (`seesImages = true`); `LiveCall` speaks the AI notice when `disclosureDue` (l. 487), runs `detectCrisis` on every final transcript and sets `CRISIS_SYSTEM_NOTE` (l. 551), stops a blocked reply; `/api/live/<conv>` WebSocket (`routes/live.ts`), owner only, same origin, member voice switch checked | Realtime voice, tools off | *Wake starts a call* (§5.3) opens exactly this; `seesImages` doesn't matter (no camera on a wake) |
| Classic calls | `web/voice.js` (hands-free call mode with interruption, 16 kHz WAV), the 📞 button; `voice.calls = 'live'\|'classic'` | A call through her normal turn, tools on | The wake turn is a one-question classic exchange done by the device, not the page |
| The local voice and its start-up line | `src/platform.ts` l. 89–97: `localVoiceSupported(platform) = platform === 'linux'`; `localVoiceMissing()` → "Local voice isn't available on {Windows} yet: use Grok or OpenAI voice"; `main.ts` l. 389–390 (voice dir `/opt/sara-voice` on Linux, `<data>/voice` elsewhere) and l. 1255 (`console.log('Local voice: …')`) | See fact 1 | Part C |
| Voice installer | `deploy/install-voice.sh`: bash, `[[ $EUID -eq 0 ]]`, `[[ "$(uname -m)" == x86_64 ]]`, `sha256sum`, `tar -xjf`; pinned `sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2` and three model tarballs with SHA-256s; writes `voice.json` and the instance's env file | The only way to get local voice | The pattern for the wake pack: pinned upstream URL + SHA-256, unpack beside, move into place when whole |
| Windows app | `desktop/windows/src/main.cpp` (3,254 lines, Win32 + WebView2, no frameworks): tray icon (`Shell_NotifyIconW`, dark menu, "Now" section), quick-ask window (`kQuickClass`, served at `<server>/__sara_desktop/quick-ask`), global shortcut (`RegisterHotKey`, `kHotkeyId`, choices Alt+Shift+S / Ctrl+Alt+S / Ctrl+Shift+Space / Ctrl+Alt+Space / Alt+Shift+A, "taken" detection), toasts (`toast.h`), `PermissionRequested` that allows the microphone only for the server in use and only for the quick-ask path (l. 1619–1626, 2704–2711), `desktop.ini` for app prefs; `hands*.cpp` (computer use) | A native shell with a tray, a shortcut and a mic-capable page | The detector, the dot on the tray icon and the talk shortcut live here (§6.1) |
| Mac app | `desktop/mac/Sources/*.swift` (AppKit + WKWebView): `QuickAsk.swift` (⌥⇧S by default, Carbon `RegisterEventHotKey`, no Accessibility permission), menu-bar icon with mood tooltip, `Notify.swift`; `Info.plist` `NSMicrophoneUsageDescription`; `Sara.entitlements` `device.audio-input`; hardened runtime when signed (`build.sh` `--options runtime`), **no** `disable-library-validation`; `LSMinimumSystemVersion` 13.0 | Same as Windows | Library validation decides that the Mac bundles the engine instead of downloading it (§6.2) |
| Linux "desktop" | No desktop shell. `desktop/linux/*.ts` is `sara hands` (computer use) run by the desktop user from a terminal, with its own D-Bus client (`dbus.ts`, no packages), AT-SPI and portals; device tokens of kind `hands` | A pattern for a user-session helper | `sara wake` follows it (§6.3) |
| Android app | `android/` (Java, **no libraries**, about 100 KB, `minSdk 26`, `targetSdk 36`): `CallService` (live call audio natively, `foregroundServiceType="microphone"`, 24 kHz PCM, `AcousticEchoCanceler`, `NoiseSuppressor`, reads the session cookie through `CookieManager`), `LiveInbox` (`remoteMessaging` foreground service for instant notifications), `ACTION_ASSIST` filter (Phase 72) → `window.saraAssist()` (taps the mic), the `com.backstagecoding.sara.CALL` shortcut, `BootReceiver` (`BOOT_COMPLETED`), `Notify` (channels, actions), permissions already declared: `RECORD_AUDIO`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` | A phone app with a microphone service | The wake service is a second microphone service in the same app (§6.4); Play's rule on downloaded code decides that the engine ships inside the app |
| iPhone app | `ios/Sara` (Swift, no libraries): `AskSaraIntent` (Phase 72: "Ask Sara" in Siri and Shortcuts, its own "Siri" conversation, safety on the server), CallKit calls, APNs; SOURCE_OF_TRUTH: iPhone 0.24.0 build 3 **in App Store review**; the next update waits for it | Siri is the iPhone's way in | §6.5: no wake word; "Hey Siri, ask Sara" is the answer |
| Push | `src/push.ts` (Web Push, VAPID + RFC 8291, end-to-end encrypted, paused in private local mode), `src/apns.ts`, Android `LiveInbox` / `InboxJob` | Notifications to every device | Not used to wake anything; the "Hey Sara stopped on {device}" note uses the normal event path (§4.10) |
| Private local mode | `src/private-local.ts`, `src/net-guard.ts` (one choke point for outgoing requests); `whatWouldLeave` lists "Cloud voices, hearing and live calls" as paused (l. 135–153) | On Windows and macOS **hearing is then off entirely** (no local engine) | Fact 3; Part C |
| Household | `src/household.ts`: each member their own data folder, companions, devices; `MemberLimits.voice` (l. 49); `memberRouteCheck` refuses `live`, `calls`, `voice` (non-GET) and `video` when voice is off for them ("Voice is switched off for you on this server. Ask the owner.", l. 559) | Whose Sara is whose | `wake` joins the same list (§15) |
| Devices and sign-in | `src/auth.ts`: `sessions` (each signed-in device, `deviceLabel(ua)`, `lastSeen`, kinds `app`/`browser`/`api`/`hands`/…), `devices()`, *Sign out* per device | A device is a session | The per-device record is keyed by the session id; signing a device out ends its Hey Sara (§4.9) |
| The safety layer in voice | `src/safety.ts`: `DISCLOSURE_INTERVAL_MS` 3 h, `disclosureDue`, `disclosureText`, `CRISIS_RESOURCES`, `detectCrisis`, `CRISIS_SYSTEM_NOTE`, `detectMinorSexualContent`, `MINOR_BLOCK_REPLY`; `VOICE_ROOM_CHANNELS = {'alexa','home-assistant'}` with `voiceRoomNote` ("speakers in a room are shared places", docs/VOICE_ASSISTANTS.md) | Mandatory, per turn | §14.1: the spoken order, and desktop speakers count as a room by default |
| Quick ask | `desktop/shared/quick-ask.html` (555 lines): one page for both desktop apps; same-origin with the server, same sign-in; refuses until the AI notice was accepted in the main window; mic button → 16 kHz WAV (≤ 2 min) → `/api/voice/transcribe` → asked like typed text; one new conversation per quick question | The desktop's small window | The woken state is a mode of this page (§4.6, §8.1) |
| The Android assistant | `MainActivity.takeRing` l. 989 (`ACTION_ASSIST` → `saraAssist`), `web/app.js` l. 6101 (`saraAssist` waits for the mic, then clicks it) | Push-to-talk on the phone today | Stays the phone's push-to-talk (§4.8) |

What does **not** exist: any always-on listening anywhere; any native audio capture on the desktop
(the desktop apps record only inside the web view, through `getUserMedia`); any way for a device to
tell the server it listens; any wake-word model or keyword list; any speech-to-text on a Windows or
macOS server that doesn't send the audio to a cloud API; and any route that takes a recording and
answers with her spoken reply in one go (the quick-ask page and `web/voice.js` do it in three calls).

Six code facts change the design:

1. **Why "Local voice isn't available on Windows yet".** It isn't sherpa-onnx: upstream publishes
   Windows x64/arm64 and macOS universal2 builds of the same v1.13.8 release Sara pins for Linux
   (release assets `sherpa-onnx-v1.13.8-win-x64-shared-MD-Release*.tar.bz2`,
   `…-osx-universal2-shared*.tar.bz2`, published 2026-09-10). It's the **installer**: the only way in
   is `deploy/install-voice.sh`, a bash script that demands root, x86_64 and `sha256sum`, and writes a
   Linux env file; and `platform.ts` then hard-codes `localVoiceSupported = linux`, which makes
   `defaultEngines()` start hearing and her voice **off** on Windows and macOS and makes `main.ts`
   print the line at every start. So the fix is a cross-platform installer, not a new engine (Part C).
2. **The desktop apps can't capture sound outside the web view.** Everything audio today is
   `getUserMedia` inside WebView2/WKWebView, which needs the page (the quick-ask window) open. A wake
   word needs a native capture that runs with every window hidden, in the tray: WASAPI on Windows,
   `AVAudioEngine` on the Mac. Both are system APIs (no packages). The quick-ask page stays the place
   where the woken exchange is shown.
3. **On Windows and macOS, private local mode means no hearing at all.** `stt` is `off` or `openai` there;
   with *Nothing leaves this computer* on, `openai` is blocked by `net-guard.ts`. A wake word that
   then wakes and can't hear would be worse than none. Either Part C lands (local hearing), or the
   device pauses Hey Sara with a plain reason while the mode is on (§4.10). Both are designed; §19 Q1
   decides whether Part C is in this release.
4. **Desktop speakers are a room.** docs/VOICE_ASSISTANTS.md already says "speakers in a room are
   shared places" and treats Alexa and Home Assistant turns with `voiceRoomNote` (never explicit;
   private matters only if he brings them up). A PC that answers out loud across the room is the same
   situation; a phone at his ear is not. So the `wake` channel is a room channel **unless the person
   marks the device as just theirs** (§5.6).
5. **Play forbids downloading native code; Apple's hardened runtime forbids loading it.** Google Play's
   Device and Network Abuse policy: "Don't use third-party SDKs in your app that download executable
   code (like dex or .so files) from outside Google Play". The Mac app is signed with the hardened
   runtime and has no `disable-library-validation` entitlement, so a downloaded unsigned dylib won't
   load. So the engine library is **downloaded** only where that's allowed (Windows, Linux) and
   **bundled** in the signed app elsewhere (Mac, Android); the **model** (data, about 5.4 MB) is a
   download everywhere (§4.2).
6. **Android 14+ won't start a microphone service from the background or from boot.** A
   `microphone` foreground service can't be created while the app is in the background, and apps
   targeting Android 14+ can't launch one from a `BOOT_COMPLETED` receiver (the app targets 36). So
   Hey Sara on the phone starts from a visible screen (the switch, the notification's *Resume*), and
   after a reboot or an update it **asks** to be resumed with a notification instead of starting by
   itself (§6.4).

### 1.1 The measurement (real numbers, 2026-11-02, this PC)

**Method.** In the Hermes scratch folder (deleted afterwards): the upstream
`sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts.tar.bz2` (19,164,933 bytes, SHA-256
`876e6b89…cb5d3`) and the keyword model `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`
(32,885,699 bytes, SHA-256 `68447f4f…616a6`), unpacked with **Windows' own `tar.exe`**
(`C:\Windows\System32\tar.exe -xjf`, which reads bzip2: this matters for Part C). Six test sentences
were spoken by the Windows speech synthesizer (System.Speech, 16 kHz mono 16-bit WAV), plus the
model's two LibriSpeech English test files (6.6 s and 16.7 s of read speech). The keyword list was
written **by hand from the model's own lexicon** (`en.phone`: `HEY HH EY1`, `SARA S EH1 R AH0`), with a
second spelling `S AA1 R AH0` added; the int8 encoder and joiner, chunk 16 (320 ms), one thread,
`sherpa-onnx-keyword-spotter.exe`, boosting score 1.5, trigger threshold 0.25.

| Clip | Says | Result |
|---|---|---|
| t0 | "Hey Sara, what is the weather tomorrow?" | **HEY_SARA** at 0.20–0.64 s |
| t3 | "Okay. Hey Sara. Remind me to call Mum at six." | **HEY_SARA** at 1.48–1.92 s |
| t1 | "I met Sarah at the station yesterday and we had coffee." | nothing (her name without "hey" doesn't wake) |
| t2 | "Hey, say that again please." | nothing |
| t5 | "The sarong was hanging on the chair, hey." | nothing |
| t4 | "Sara, stop." | nothing; with a `STOP` line added (`S T AA1 P`), **STOP** at 1.12–1.44 s |
| en_0, en_1 | 23.3 s of read English (LibriSpeech) | nothing |

**Speed:** real-time factor 0.009–0.011 on every clip (e.g. 0.146 s to process 16.7 s), on one thread
of an AMD Ryzen 9 9950X: about **1 % of one core** while listening. **Size on a device:** int8
encoder 4,599,656 + decoder 759,829 + int8 joiner 86,629 + `tokens.txt` 1,928 bytes = **5.4 MB**; the
English lexicon `en.phone` (3,330,061 bytes, 126,052 words) is only needed where phrases are turned
into keyword lines (the server, §5.8). The Windows engine is `sherpa-onnx-c-api.dll` (2,882,048) +
`onnxruntime.dll` (17,136,128) + `onnxruntime_providers_shared.dll` (10,752) = **20 MB**.

**What this does not show:** a real microphone, a real room, other voices, accents, music or TV in the
background, a phone's CPU, or battery. A synthesized voice is the easy case. These are owner to-dos
(§13) and the reason the sensitivity setting exists (§4.7). It does show the three things the design
rests on: the engine runs on Windows from the upstream release with no build step, a phrase can be
turned into a keyword line from the lexicon by plain text lookup (no Python tool), and "stop" can be a
second keyword in the same detector.

---

## 2. How Hermes Agent, OpenClaw and the others do it, and where Sara differs

**Hermes Agent** ([H14]). "Hey Hermes" runs in the CLI, the TUI and the desktop app; one switch
(`wake_word.enabled`, or `/wake on`), **off by default**; detection "entirely on-device"; "no audio
leaves your machine until you actually speak a command". On the phrase it pauses the detector (freeing
the mic), starts a **fresh session** by default (`start_new_session: true`), records one utterance with
voice mode's silence detection, transcribes it and answers; then the listener resumes. Engines:
openWakeWord through `pyopen-wakeword` with a bundled `hey_hermes.tflite` (the default), **sherpa**
("any phrase, zero training"), and Porcupine ("requires an access key", a custom `.ppn`). One
`sensitivity` 0–1 "consistent across all engines", `confirmation_frames` for openWakeWord, an input
device picker, and a *remote desktop* mode where the desktop app captures and feeds PCM to the backend
(`capture: client`). On the desktop a whole-utterance "stop" (or "never mind", "goodbye", "cancel",
"that's all") ends the conversation, while "stop the docker container" still goes through. The toggle
refuses to arm without a speech-to-text and a text-to-speech provider. Not in the messaging gateway.

**OpenClaw** ([O16], [O25]). Wake words are **one global list owned by the Gateway** (at most 32
triggers, each ≤ 64 characters; defaults `openclaw`, `claude`, `computer`), synced to every node, with
**routing** from a trigger to an agent or session. Each node has a local on/off. Recognition is
**on-device and foreground-only** on Android ("requires Android on-device speech recognition"), and
pauses while Talk, dictation or voice notes own the audio. On macOS (26.2+), an always-on Apple Speech
recognizer with **on-device recognition only** ("never falls back to network recognition"), a 0.55 s
pause required after the trigger, 2 s / 5 s silence windows, a 120 s hard stop, a 350 ms debounce,
an overlay with the partial text, and **push-to-talk by holding Right Option** (needs Accessibility /
Input Monitoring).

**Alexa, Siri, Google.** The phone makers' own assistants use privileged system paths: on Android,
`AlwaysOnHotwordDetector` became a **system API** in Android 12 ([A3]) and the CDD describes
`HotwordDetectionService` as the mechanism "for secure always-on hotword detection without mic access
indication" ([A4]), open only to the preinstalled assistant; on iPhone, "Hey Siri" is Siri's alone.

**Where Sara differs, on purpose:**

| | Hermes Agent | OpenClaw | Sara (this design) |
|---|---|---|---|
| Where it runs | The machine running the agent (CLI/TUI/desktop) | Each node app | Each **device app** (Windows, Mac, Android) and `sara wake` on Linux; never on the server, which may be another machine |
| Engine | openWakeWord (default), sherpa, Porcupine | The OS speech recognizer | **sherpa-onnx keyword spotting only**, the same upstream as her local voice; one engine, one tuning, the same on every platform |
| Phrase | One model per phrase; "phrase" is cosmetic | Any words, one global list | *Hey {her name}* by default; up to 4 phrases per person, each tied to one of **their** companions (§4.4) |
| Off by default | Yes | Yes (per node) | Yes, and **per device**: switching it on is only possible on the device itself (§4.9) |
| After the phrase | New session | Overlay, send after silence | A chime and the window/notification; one question in her **Hey Sara** conversation (or a live call, if chosen) |
| Mobile | No | Android foreground-only | Android **with the screen off**, through a visible foreground service (§6.4) |
| Stop | Whole-utterance stop words | Dismiss / hard stop | "Stop" said **while she speaks** cuts her off (a second keyword), plus whole-utterance stop words, Esc, the notification (§4.5) |
| Several devices | n/a | n/a | One answers: the first claim wins (§5.4) |
| Household | n/a | Routes to agents | The device's signed-in person; their companions; never another person's (§15) |
| Safety | n/a | n/a | The AI notice spoken first; crisis resources spoken in full; the minors block; room rules on speakers (§14) |

### 2.1 The engines (no npm runtime dependency; optional local model or binary)

| Engine | What it is | Licence and terms | Custom phrase | Fits Sara? |
|---|---|---|---|---|
| **sherpa-onnx keyword spotting** ([E1], [E2]) | "Open vocabulary keyword spotting": a tiny streaming transducer (3–3.3M parameters) that can only decode the given keywords; per keyword a *boosting score* and a *trigger threshold*; C API (`SherpaOnnxCreateKeywordSpotter`, `SherpaOnnxCreateKeywordStreamWithKeywords`), JNI for Android, Swift, WebAssembly, CLI tools (`sherpa-onnx-keyword-spotter`, `-alsa`, `-microphone`) | Apache-2.0 (code); models published by the same project (model licence to be confirmed per model card, §17 R3) | **Yes, by text**: a phrase becomes phone tokens from the model's lexicon, no retraining | **Chosen.** Same pinned release as `install-voice.sh`; measured in §1.1 |
| **openWakeWord** ([E3]) | A shared feature/embedding model plus a small per-phrase classifier; ONNX or TFLite; Python package; optional Silero VAD; default threshold 0.5; *custom verifier models* for fewer false wakes | Code Apache-2.0; **all pre-trained models CC BY-NC-SA 4.0** (non-commercial) | Needs **training** a model per phrase (a Colab notebook, "< 1 hour") | No: Sara has paid tiers; a non-commercial model licence and per-phrase training rule out custom words for beginners; needs onnxruntime anyway |
| **Porcupine** (Picovoice) ([E4], [E5]) | Commercial engine; type a phrase in the Console and get a platform-specific `.ppn` in seconds | Needs an **AccessKey** for every use, "verifies that your usage is within the limits of your account"; "a B2B company… no dedicated free or paid plans for personal or non-commercial use"; a one-time free trial; billed per monthly active device | Yes (Console, per platform) | No: a key per install, a vendor account, usage limits and a closed binary contradict "written from scratch, nothing to sign up for" |
| **Vosk** ([E6]) | Offline speech recognition (Kaldi), Apache-2.0, 50 MB models, Android/iOS/desktop; a recognizer can be given a **grammar** (a list of phrases plus `[unk]`) | Apache-2.0 | Yes (grammar words must be in the model's vocabulary) | Not chosen: a full recognizer running all the time costs far more CPU and 10× the download for the same job; a second native stack beside sherpa |
| **whisper.cpp** ([E7], [E8]) | `whisper-stream` "samples the audio every half a second and runs the transcription continuously" ("a naive example"); `command` has a *guided mode* that classifies speech into a list of commands | MIT | Yes (any text) | Not as a detector: running Whisper every 0.5 s is a heavy, constant load (and drains a laptop); fine as the **hearing** after the wake, which Sara already gets from Parakeet |
| **The OS recognizers** | Android `SpeechRecognizer` (on-device where the phone has the language pack), Apple Speech with on-device recognition (OpenClaw's choice), Windows' `Windows.Media.SpeechRecognition` with a list constraint | System | Any words | Not chosen for 2.59.0: different on every platform (three tunings, three sets of bugs), not on every phone or on the emulator, Apple's needs macOS 26.2 for OpenClaw's path while Sara supports 13+, and a continuous full recognizer draws more power than a 5 MB spotter. Kept as §19 Q9 |
| **Web Speech API** ([W1]) | `SpeechRecognition` in the browser | "On some browsers, like Chrome… your audio is sent to a web service for recognition"; a newer `processLocally` flag asks for on-device | Any words | No: see §6.6 |

### 2.2 The platform rules that decide the split

- **Android.** Third-party apps can't use the system hotword path (`AlwaysOnHotwordDetector` is a
  system API since Android 12, [A3]; the no-indicator `HotwordDetectionService` is for the system
  assistant, [A4]). What a normal app *can* do is a **foreground service of type `microphone`** with a
  visible notification, while Android shows its microphone privacy dot ([A1]). Since Android 14 such a
  service can't be created while the app is in the background, "with a few exceptions" ([A1], [A2]),
  and apps targeting Android 14+ "are not allowed to launch a microphone foreground service from a
  `BOOT_COMPLETED` broadcast receiver" ([A5]). Play: no downloading of `.so`/dex from outside Google
  Play ([A6]); and every foreground service type must be declared with its use in the Play Console.
- **iPhone.** "Multitasking apps may only use background services for their intended purposes: VoIP,
  audio playback, location, task completion, local notifications" (App Review 2.5.4, [I1]), and apps
  "must request explicit user consent and provide a clear visual and/or audible indication when
  recording" (2.5.14, [I1]). An app that keeps the microphone open in the background to wait for a
  phrase is not one of those purposes. A foreground-only wake word (screen on, app open) is allowed
  but of little use on a phone; Siri already has "Ask Sara".
- **macOS.** Hardened runtime + library validation (fact 5); microphone through the TCC prompt
  (`NSMicrophoneUsageDescription` exists); the system shows an **orange dot** in the menu bar while any
  app records. Global hotkeys through Carbon need no permission (the quick-ask shortcut already uses
  it); a *hold* hotkey needs key-up events, which Carbon gives too (`kEventHotKeyReleased`).
- **Windows.** No store rule (the app is installed by our installer); Settings → Privacy → Microphone
  lets the person deny desktop apps the mic, and the taskbar shows a **microphone-in-use icon**;
  `RegisterHotKey` gives key-down only (no hold without a low-level keyboard hook, which Sara won't
  install: antivirus tools flag them and they see every key).
- **Linux.** No shell; PipeWire or PulseAudio let two programs read the microphone at once; GNOME and
  KDE show a microphone indicator for apps using the portal/PipeWire.
- **Browsers.** `getUserMedia` needs a secure context and an open page; background tabs are throttled;
  the browser shows its own recording indicator on the tab. A page can't listen after it's closed.

---

## 3. The shape

```
 device (Windows app · Mac app · Android app · `sara wake` on Linux)            Sara's server
 ┌──────────────────────────────────────────────────────────────┐            ┌──────────────────────────────┐
 │ mic ─▶ 16 kHz ring buffer ─▶ sherpa-onnx keyword spotter      │  nothing   │                              │
 │            (asleep: dim dot)        │ "HEY_SARA" (label → who) │  leaves    │ GET  /api/wake/config        │
 │                                     ▼                          │◀───────────│  phrases → keyword lines     │
 │   chime · bright dot · window/notification "Listening…"       │            │  pack manifest, sensitivity  │
 │   POST /api/wake/claim ───────────────────────────────────────┼──────────▶ │  first claim wins (§5.4)     │
 │   record until silence (≤ 15 s), "stop" ends it               │            │                              │
 │   POST /api/wake/turn  (WAV) ─────────────────────────────────┼──────────▶ │ transcribe → runTurn in her  │
 │   ◀── {heard, spoken:[disclosure?, crisis?, reply], …} ───────┼─────────── │ "Hey Sara" conversation      │
 │   POST /api/voice/speak per piece, play; "stop" cuts her off  │            │ (safety layer, room rules)   │
 │   back to asleep (dim dot)                                    │            │                              │
 │   PUT /api/wake/device  (on/off, pack, counters; no audio)    │──────────▶ │ wake.json (per person)       │
 └──────────────────────────────────────────────────────────────┘            └──────────────────────────────┘
```

Three parts, one release:
- **Part A · the detector on the device** (§4, §6): a pack (engine where allowed + model), a capture
  loop, the keyword spotter, the indicator, the chime, push-to-talk, stop, false-wake handling, the
  per-device switch.
- **Part B · the wake turn on the server** (§5): `src/wake.ts` and `src/routes/wake.ts`: the phrases
  and their keyword lines, the device records, the claim, and `POST /api/wake/turn`.
- **Part C · local hearing on Windows and macOS servers** (§7): `sara voice install`, a Node port of
  `install-voice.sh`, so private local mode keeps Hey Sara working and the start-up line goes away.

### 3.1 Shared building blocks (built once, used by every platform)

- **W1 · The wake pack manifest** (`src/wake-pack.ts`, a constant, and a copy compiled into each app):
  one entry per platform/architecture with each file's URL, size and SHA-256, the licence lines and
  the upstream version. Files are listed **one by one** (no archive), so no device ever unpacks
  anything: `encoder.int8.onnx`, `decoder.onnx`, `joiner.int8.onnx`, `tokens.txt` for everyone, plus
  `sherpa-onnx-c-api.dll`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll` for Windows x64/arm64
  and `sherpa-onnx-keyword-spotter-alsa` + its `.so` files for Linux x64/arm64. Hosted as Sara release
  assets (GitHub, `wake-pack-1/…`) and mirrored on backstagecoding.com/sara/wake/ (the static site the
  store already uses); both are byte-identical copies of the pinned upstream files, re-checked by
  `scripts/wake-pack.mjs` at release time against the upstream tarballs' SHA-256 (§17 R4).
- **W2 · The keyword lines** (`src/wake.ts phraseLines(text, lexicon)`): a phrase (2–4 words) → one line
  per spelling, `"HH EY1 S EH1 R AH0 :1.5 #0.25 @W1"` (tokens, boost, threshold, a label `W1…W4` the
  server maps to a companion). Upper-cases, splits on spaces, looks each word up in the lexicon (all
  spellings it lists; at most 4 lines per phrase), and refuses words it can't find with a plain reason.
  The built-in *Hey Sara* lines are constants (no lexicon needed); every other phrase needs the
  lexicon on the server (§5.8). The **stop lines** (`S T AA1 P @STOP`, plus the phrase's name + stop)
  are constants too.
- **W3 · The device state machine** (the same seven states, written once per app in its language,
  tested on the server side through the routes and on each app by its own small test):
  `off → asleep → woken → hearing → thinking → speaking → asleep`, plus `paused(reason)`. Rules shared by
  every app: the detector is fed only while `asleep` (and listens for `STOP` only while `speaking`);
  `woken` lasts at most 5 s without speech; `hearing` at most 15 s, ending after 0.8 s of silence;
  nothing is recorded in `asleep`; the ring buffer before the phrase is 0 s (the recording starts at
  the phrase's last token + 0.1 s, so words said **before** "Hey Sara" are never sent).
- **W4 · The silence detector** (energy floor with a slow-moving noise estimate): the same rule
  `CallService` (Java, `floor = 0.006f`, `loudMs`) and `web/live.js` (`this.floor = 0.006`) already use,
  ported to C++ and Swift. No neural voice-activity model.
- **W5 · The chime**: two short sine tones generated in code (no audio files; 120 ms + 120 ms, −18 dB,
  rising for "listening", falling for "going back to sleep"), switchable off per device.
- **W6 · The wake turn** (`POST /api/wake/turn`, §5.5): WAV in → transcript → the stop-word check →
  a normal turn in the right conversation → the pieces to speak, in order.

### 3.2 Where data lives

| What | Where | Why there |
|---|---|---|
| The person's phrases, where turns go, follow-up, chime default | `settings.json` of that person, key `wake` | Ordinary per-person settings, exported and backed up with the rest |
| Devices that listen (state, pack version, last wake, counters) | `<person's data>/wake.json` (atomic write, `writeFileAtomic`) keyed by **session id** | Device state, not a setting: changes often, never synced to other people; one small file like `private-local.json` |
| The lexicon (for custom phrases) | `<data>/voice/wake-lexicon/en.phone` (3.3 MB, owner-approved download, SHA-256 checked) | The server makes the keyword lines once; devices stay simple |
| The pack on a device | Windows `%LOCALAPPDATA%\Sara\wake\1\`; Mac `~/Library/Application Support/Sara/wake/1/` (model only; the engine is in the app); Android the app's private `files/wake/1/` (model only); Linux `~/.local/share/sara/wake/1/` | Per user, not writable by other users; versioned folder so an update never half-replaces a pack |
| The device's own switch | Windows `desktop.ini` (`[wake] on=1`), Mac `UserDefaults`, Android `SharedPreferences`, Linux `~/.config/sara/wake.json` | The switch belongs to the device; the server can turn it **off**, never on (§4.9) |
| What he said | His message in her **Hey Sara** conversation (like a voice note's transcript) | The transcript is the record; the audio isn't kept |
| The audio | **Nowhere.** The detector's buffer is overwritten every 320 ms; the woken recording lives in memory, is sent once and dropped; the server transcribes from memory and keeps no file | §14.2 |

### 3.3 Settings shape (per person; `wake` added to the settings the person may change; the owner's server-wide gate in `OWNER_SETTINGS`)

```ts
interface WakeSettings {
  /** Up to 4 phrases, each for one of this person's companions. Default: [{ text: 'Hey ' + her name, companion: current }],
   *  falling back to 'Hey Sara' when her name isn't in the lexicon and the lexicon isn't installed. */
  phrases: { text: string; companionId: string }[];
  /** Where a Hey Sara exchange goes: her own "Hey Sara" conversation (default), the one open on that device, or a new one each time. */
  talksIn: 'own' | 'open' | 'new';
  /** What the phrase starts: one question (default) or a live call (needs live calls set up). */
  starts: 'question' | 'call';
  /** After her answer, keep listening this many seconds for a follow-up without the phrase (0 = off; 0 by default). */
  followUpSeconds: 0 | 5 | 8;
  /** Sensitivity for new devices (each device can override): relaxed | normal | strict. */
  sensitivity: 'relaxed' | 'normal' | 'strict';
}
/** Owner only, server-wide (OWNER_SETTINGS): may devices signed in to this server listen at all? Members too? */
interface WakeServer { allowed: boolean /* true */; members: boolean /* true: members may switch it on for their own devices */ }
```

Per device (kept on the device and reported to the server): `on`, `sensitivity`, `chime`,
`personal` (this device is just mine: not a room, §5.6), `onlyCharging` (Android), `micId` (desktop),
`talkShortcut` (desktop).

---

## 4. Part A · the detector on the device

### 4.1 Scope

In: the pack and its download; native capture; the keyword spotter; the states, the indicator and the
chime; the woken recording; "stop"; push-to-talk and the talk shortcut; false wakes; sensitivity; the
per-device switch and the remote *off*; pauses (calls, her own voice, battery, the screen lock,
private local mode without local hearing). Out: speaker recognition (whose voice it is, §19 Q7), a
wake word in the browser (§6.6), the iPhone (§6.5), training custom models, languages without a
lexicon (§4.4).

### 4.2 The pack: what is downloaded, where from, and how it's checked

| Platform | Engine library | Model (5.4 MB) | Total download |
|---|---|---|---|
| Windows x64 / arm64 | **Downloaded** (20 MB x64; about 14 MB arm64), loaded with `LoadLibraryExW(<full path>, LOAD_WITH_ALTERED_SEARCH_PATH)` after the SHA-256 check **every time it loads** (not only after the download) | Downloaded | ≈ 25 MB |
| macOS (universal) | **In the signed app** (`Contents/Frameworks/libsherpa-onnx-c-api.dylib`, `libonnxruntime.dylib`; the app grows by about 18 MB, §17 R6); the hardened runtime forbids loading a downloaded one | Downloaded | 5.4 MB |
| Android arm64-v8a / armeabi-v7a / x86_64 | **In the APK** (`jniLibs/<abi>/libsherpa-onnx-jni.so` + `libonnxruntime.so`; per-ABI APKs so a phone gets one ABI; §17 R5, §19 Q4); Play forbids downloaded `.so` files | Downloaded | 5.4 MB |
| Linux x64 / arm64 | **Downloaded** (`sherpa-onnx-keyword-spotter-alsa` + `.so`s), run as a child process of `sara wake` | Downloaded | ≈ 25 MB |

The consent card (before any byte is fetched) says, in plain words: what it is ("a small speech model
that only knows the words *Hey Sara* and *stop*"), who made it (the sherpa-onnx project, k2-fsa,
Apache-2.0; link), the size, where it goes on this device, that it runs only on this device, that it
can be removed in one tap (*Remove Hey Sara from this device* deletes the folder), and that nothing is
fetched while *Nothing leaves this computer* is on (then *Add from a file…* takes the same files from
a folder, with the same checks; §6.1). Every file's SHA-256 is compared with the manifest compiled
into the app; a mismatch deletes the file and says "The download didn't match what Sara expects, so
it wasn't kept. Try again later." A pack folder is used only when **all** its files match. The
manifest's version (`wake-pack-1`) changes only with a Sara release; a new version downloads into a
new folder and the old one is deleted after the new one checks out.

### 4.3 Capture and detection

- **Format:** 16 kHz mono float, the model's own rate (`sampling_rate=16000, feature_dim=80`). Desktop
  capture through WASAPI shared mode (Windows: `IAudioClient` with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`
  asks Windows to convert to 16 kHz mono) and `AVAudioEngine` input tap + `AVAudioConverter` (Mac);
  Android `AudioRecord` with `MediaRecorder.AudioSource.VOICE_RECOGNITION` at 16 kHz (no echo
  canceller in `asleep`; `AcousticEchoCanceler` while she speaks, as `CallService` does); Linux: the
  spotter reads ALSA (`default`, which PipeWire/Pulse provide) itself.
- **Detector:** one keyword stream, chunk 16 (320 ms latency), one thread, int8 encoder/joiner; the
  keyword lines from `/api/wake/config`; `SherpaOnnxCreateKeywordStreamWithKeywords` so new phrases
  apply without reloading the model. A detection gives a label (`W1…W4`, `STOP`) and token timestamps.
- **Sensitivity** maps to the two numbers per line: *Relaxed* boost 2.0 / threshold 0.20, *Normal*
  1.5 / 0.25 (measured in §1.1), *Strict* 1.0 / 0.35. Starting values; tuned by the owner's real-room
  checks (§13) before release.
- **Mic choice (desktop):** *System default* or a named input; a "Listening, but hearing silence" check
  (no level above the floor for 10 minutes while the system says the mic is on) shows a hint on the
  device card, the way Hermes Agent documents its Windows "Microphone Array" trap ([H14]).

### 4.4 Phrases: the default, custom words, and which companion answers

- **Default:** *Hey {her name}* for the companion open on that device when the switch is first turned
  on. "Sara" is built in. Another name needs the lexicon (§5.8); if it isn't installed, the card
  offers it ("To use *Hey Mira*, Sara needs a 3 MB English word list on your server. Download it?")
  or *Hey Sara* meanwhile.
- **Custom:** Settings → Voice → *Hey Sara* → *Words that wake her*: up to **4 phrases per person**, each
  pointing to one of **that person's** companions (*Hey Mira* → Mira, *Hey Sara* → Sara, *Okay
  Captain* → the coding companion). Rules, checked by `POST /api/wake/phrase-check` and shown before
  saving: 2–4 words; at least 6 sounds in total ("Hey Al" is too short: "Short phrases wake her by
  mistake. Try *Hey Alfred*."); every word in the lexicon; not one of the stop words; not another
  phrase of the same person; not a wake word the phone/OS owns ("Hey Google", "Alexa", "Hey Siri",
  "Hey Cortana", "Ok Google"), which would wake two assistants at once.
- **Languages:** the model is English + Chinese. *Hey Sara* works for most accents because it's
  matched by sound; custom words must be English words the lexicon knows (126,052 words, many names
  included). German, Spanish, French, Italian and Portuguese phrases are refused with "Custom wake
  words in {language} need a model Sara doesn't have yet: use English words, or *Hey Sara*." (§19 Q8.)
- **One detector, many phrases:** all of the person's phrases are in one keyword list; the label says
  which companion. On a wake for another companion than the one open, the device switches to her
  (the desktop page's `switchCompanion`, the Android app's companion switch), so **she** answers.

### 4.5 After the phrase: woken, hearing, thinking, speaking

1. **Woken** (0–5 s): the chime (rising), the indicator goes bright (§4.6), the desktop shows the
   quick-ask window in *listening* mode with her face for **that** companion and a live level bar;
   Android shows a heads-up notification "Listening…" (no full-screen intent; nothing over the lock
   screen except the notification). The device sends `POST /api/wake/claim` (§5.4); if another device
   of his got there first, this one goes back to sleep quietly (falling chime off; "Answered on {Living
   room PC}" for 2 s in the window). No speech within 5 s → back to sleep, nothing sent, counted as a
   *wake with nothing said* (§4.7).
2. **Hearing** (≤ 15 s): records from the end of the phrase until 0.8 s of silence (W4). Esc, the
   window's ✕ or the notification's *Cancel* drops the recording; nothing is sent.
3. **Thinking**: the WAV goes to `POST /api/wake/turn` (§5.5). The window shows "Thinking…" and then
   what she heard (*"remind me to call Mum at six"*). A whole-utterance stop word ("stop", "cancel",
   "never mind", "that's all", "goodbye", "nothing", and the same in the app's six languages, from a
   table next to `COMMAND_WORDS`) ends the exchange **on the server** without a turn; "stop the timer"
   is a normal request.
4. **Speaking**: the device plays the pieces in order (§5.5) through `/api/voice/speak`. While she
   speaks, the detector listens for **`STOP` only** (and *{her name} stop*): saying "stop" cuts her off
   at once, as on a call; Esc and the notification's *Stop* do the same. Her own voice can't wake her:
   the phrase lines are not in the list while she speaks, and for 600 ms after.
5. **Back to asleep**: the falling chime (if on), the dot goes dim. With *follow-up* set (5 or 8 s),
   the window stays and the device listens for speech **without** the phrase that long, the bright
   dot still on; a follow-up is the next turn in the same conversation.

If her hearing or her voice isn't set up, the switch can't be turned on and says which one is missing
(the same rule as Hermes Agent's "refuses to arm", [H14]): "Hey Sara needs her hearing and her voice:
Settings → Voice." Her text reply still shows in the window when only her voice fails mid-way.

### 4.6 The "listening" indicator: always visible while the mic is open

| State | Windows | Mac | Android | Linux |
|---|---|---|---|---|
| `asleep` (waiting for the phrase) | Tray icon with a **dim** dot in the corner (a second icon resource, not a balloon); tooltip "Listening for 'Hey Sara' · Pause"; Windows' own microphone-in-use icon in the taskbar | Menu-bar icon with a dim dot; macOS's orange dot | Ongoing notification (low importance, silent): *Listening for "Hey Sara"* with **Pause 1 h** and **Stop**; Android's green microphone dot | A desktop notification at start (`org.freedesktop.Notifications` through `dbus.ts`) + the terminal line "Listening for 'Hey Sara' (Ctrl+C stops)"; the desktop's own mic indicator |
| `woken` / `hearing` | Dot **bright**; the quick-ask window in listening mode (§8.1) | Same | Heads-up "Listening…" with *Cancel* | Notification "Listening…" |
| `thinking` / `speaking` | Window shows heard text, then her reply as it's spoken | Same | Notification shows heard text and her reply, *Stop* | Notification text |
| `paused(reason)` | Grey dot; tooltip says why ("paused during your call", "paused: hearing is off while *Nothing leaves this computer* is on") | Same | Notification: "Hey Sara is paused: {reason}" with *Resume* (or none while on battery saver) | Terminal line |
| `off` | No dot; no capture at all (the audio device is closed, so the OS indicator disappears too) | Same | No notification, service stopped | Process ended |

The dot is never animated (no attention-seeking), never hidden by a setting, and the tray/menu tooltip
always offers *Pause*. "Visible" includes the OS's own indicator: Sara never tries to suppress or
avoid it, and never records through a path that would hide it.

### 4.7 False wakes and how they're handled

1. **Two-word phrase, sound-matched:** "Sara" alone doesn't wake her ("I met Sarah…", §1.1); "hey"
   alone doesn't.
2. **Sensitivity** per device (§4.3): starts at *Normal*.
3. **Nothing said → nothing sent:** woken with no speech in 5 s goes back to sleep; recording that
   transcribes to nothing (or under 2 characters, or only filler like "um") ends with "I didn't catch
   that" shown (not spoken) and **no turn, no model call** (§5.5 step 2).
4. **"That wasn't for you":** the stop words end it without a turn (§4.5 step 3).
5. **Counters, not recordings:** each device counts per day *wakes*, *wakes with nothing said*,
   *stopped at once*, *answered*. Kept 14 days in `wake.json`. When *nothing said + stopped at once*
   reaches 5 in a day, the device card suggests *Strict* ("She woke up 6 times today without being
   asked. Make her harder to wake?") once a week at most.
6. **Pauses where false wakes are likely or costly** (§4.10): during his calls and voice notes, while
   she speaks, while media plays on Android with `AudioManager.isMusicActive()` **only if** he chose
   *Pause while music plays* (off by default: some people want "Hey Sara, pause the music").
7. **Several devices:** the claim (§5.4) stops two devices from answering the same phrase.
8. **No second-stage cloud check:** Sara doesn't send the phrase audio to the server to double-check it
   (that would send sound from before he meant to talk). The transcript of what follows is the only
   check, and an empty one costs nothing.

### 4.8 Push-to-talk and the global hotkey (works without the pack)

- **Desktop talk shortcut:** a second global shortcut, *Talk to Sara*, default **Ctrl+Alt+Space**
  (Windows) / **⌃⌥Space** (Mac), chosen from the same list the quick-ask shortcut uses (they can't be
  the same; "taken by another app" detection as today). Press once: the same `woken → hearing` flow
  starts (chime, window, recording) with **no keyword spotter at all**, so it needs no download;
  press again (or stop talking) to send. Mac: holding it works too (key-up from Carbon); Windows:
  press-press only (§2.2). The quick-ask shortcut (Alt+Shift+S) keeps opening the typing window.
- **Tray / menu bar:** *Talk to Sara* item; and *Listen for "Hey Sara"* ✓ (the device switch), *Pause
  for 1 hour*, *Hey Sara settings…*.
- **Android:** unchanged ways in (the digital-assistant gesture, *Call Sara* shortcut), plus a **Quick
  Settings tile** *Talk to Sara* (`TileService`, API 24+, no library) that opens the same native
  listening flow; and the ongoing notification gets a *Talk* action while Hey Sara is on.
- **Push-to-talk is the fallback everywhere:** if the pack isn't installed, the device is paused, or
  the person never wants an always-on mic, the shortcut, the tile and the assistant gesture give the
  same exchange on demand.

### 4.9 The per-device opt-in, and one switch off

- **Off by default on every device**, and after every fresh install. Turning it on is possible **only on
  the device** (tray/menu item, the device's Settings page, the Android switch), because only the device
  can show the consent card and the OS permission prompt. The server can't switch a device on, and
  `PUT /api/wake/device` refuses `on: true` coming from any session other than that device's own.
- **The first switch-on** shows: the consent card for the pack (§4.2) if needed, then a one-screen
  explanation (what's heard, what's sent, the dot, how to stop; §8.1), then the OS microphone prompt.
- **One switch off, from anywhere:** the device's own switch; *Stop listening* on that device's row in
  Settings → Voice → *Hey Sara* → *Devices* (any of his sessions can do it); *Turn off everywhere*
  (the owner: every device of every person on the server, through `WakeServer.allowed = false`;
  a person: all of their own devices). A remote off reaches the device through its next
  `/api/wake/config` poll (every 60 s while listening, and on every `/api/events` `wake` event when
  the app's event connection is up), so it takes effect within a minute.
- **Signing a device out** (Settings → Data & health → Devices) ends its Hey Sara: its session id is
  gone, its `/api/wake/config` answers 401, the device stops listening and closes the mic.
- **Uninstalling or removing the pack** stops it for good; *Remove Hey Sara from this device* deletes
  the pack folder and the device record.

### 4.10 Pauses (listening stops and the mic closes, with a reason shown)

| Pause | When | Ends |
|---|---|---|
| A call or voice note on this device | A live/classic/video call, the mic button, a voice note recording, the Android `CallService` running | When it ends (+1 s) |
| Her speaking (on this device) | §4.5 step 4: only `STOP` is listened for | 600 ms after she stops |
| The screen is locked (desktop) | Windows `WTS_SESSION_LOCK`, Mac screen lock: **on by default** (*Keep listening while locked* off) | Unlock |
| Battery | Android Battery Saver, or below 20 %; *Only while charging* if chosen; Windows/Mac on battery saver | Charging / saver off |
| No hearing | Her hearing is off, or cloud-only and *Nothing leaves this computer* is on (fact 3) | The cause is fixed (Part C installs local hearing) |
| The server is unreachable | `/api/wake/config` fails 3 times | It answers again (the detector doesn't run for a server that can't answer) |
| Paused by him | *Pause for 1 hour* (tray, notification) | After the hour, or *Resume* |
| Another person's Sara on this device | The app switched to another server/person (Phase 68 multi-server) | Hey Sara follows the server in use; each server's switch is separate |
| Remote off | §4.9 | Only by switching on again on the device |

---

## 5. Part B · the wake turn on the server

### 5.1 Scope

In: `src/wake.ts` (phrases, keyword lines, the lexicon, device records, counters, the claim) and
`src/routes/wake.ts`; `POST /api/wake/turn`; the `wake` channel and the *Hey Sara* conversation; the
safety layer in the spoken order; room vs personal; household; private local mode. Out: a new speech
engine; any server-side listening; tools that change what a wake turn may do (it is an ordinary
everyday turn: tools ask as always).

### 5.2 Who and where

- **Who:** the person the device's session belongs to: the owner, or a household member in their own
  space. The server never guesses from the voice (§19 Q7).
- **Which companion:** the one the phrase's label maps to (`W1…W4` → `companionId`, from *that*
  person's `wake.phrases`). A label the server doesn't know (a stale list on the device) → 409 with the
  current config, and the device reloads.
- **Which conversation** (`talksIn`): **own** (default): one conversation per companion called
  *Hey Sara* (*Hey Mira*), channel `wake`, everyday mode, found by channel, made on first use; it
  shows in the list like the *Siri* conversation `AskSaraIntent` makes; **open**: the conversation open
  on that device (sent by the device; must be this person's, not private/partner/group/off the record,
  else **own**); **new**: a new everyday conversation each time, titled by the usual titler.

### 5.3 What the phrase starts

- **One question** (default): §5.5.
- **A live call** (`starts: 'call'`, only offered when live calls are available): the device opens the
  existing `/api/live/<conv>` call in the *Hey Sara* conversation (desktop: the main window's
  `startLiveCall`; Android: `CallService.start` **from the wake service itself**, which is already a
  foreground microphone service, so no background start is needed). Everything about live calls
  holds: the AI notice spoken at the start when due, crisis handling, the minors block, no tools,
  `LIVE_IDLE_MS` 5 min, `LIVE_MAX_MS` 60 min. Saying "stop" or "goodbye" on a call is the call's own
  business (the call path already ends on hang-up; §19 Q6 asks whether "goodbye" should hang up).

### 5.4 The claim: one device answers

`POST /api/wake/claim {deviceId, label, score, at}` → `{ok: true, claim: id}` or
`{ok: false, by: "Living room PC"}`. The first claim for the person wins; any other claim from the same
person within **1.5 s** loses. A claim expires after 20 s (or when its turn ends). Only one person's
devices compete (a member's laptop never "takes" the owner's wake). Offline-tolerant: a device that
can't reach the server doesn't answer at all (§4.10). The rule mirrors calls (`calls.ts`: "the first
one to answer opens a live call"). Arbitration by `score` is not used (each engine's score is relative
to its own room; first-come is predictable).

### 5.5 `POST /api/wake/turn`: hearing → turn → what to say, in order

Request: `Content-Type: audio/wav` (16 kHz mono 16-bit, ≤ 15 s, ≤ 600 KB), headers `X-Sara-Wake-Claim`,
`X-Sara-Wake-Label`, optional `X-Sara-Wake-Conversation` (for `open`). Owner/member session cookie,
same-origin rules as the other routes (the Android app sends the cookie natively, as `CallService`
does). Steps:

1. **Checks:** the claim is this device's and live; voice allowed for this person (`MemberLimits.voice`);
   `WakeServer.allowed`; the AI notice accepted on this server (`disclosureAccepted`; otherwise 403
   "Read and accept the AI notice in Sara first", the device pauses with that reason); the demo
   answers 404.
2. **Hear:** `speech.transcribe(wav, {keyterms: [her name]})`. Empty / filler → `{heard: '', ended:
   'nothing'}`; no turn, no model call. A stop word alone → `{ended: 'stop'}`; no turn.
3. **The turn:** an ordinary `runTurn` in the conversation from §5.2 with the transcript as his message
   (`meta.via: 'wake'`, `meta.device: label`), the same path the quick-ask page uses
   (`POST /conversations/:id/messages`), so the safety layer, approvals, budgets, private local mode
   and household rules are exactly today's. Tools that ask for approval still ask: the device shows
   "She needs your OK in Sara" and the normal approval notification/toast fires; nothing is approved
   by voice (§19 Q5).
4. **What to say, in order** (the response `spoken` list):
   1. `{kind: 'disclosure', text}` when this turn showed the AI notice (`disclosureDue` at the start of
      a session and every 3 h, as everywhere): spoken **first**, in her voice, before anything else;
   2. `{kind: 'crisis', text}` when this turn raised a crisis note: the **whole** `CRISIS_RESOURCES`
      text, spoken in full and also shown (window / notification); never shortened by `spokenText`;
   3. `{kind: 'reply', text}`: her reply through `spokenText` (no Markdown, links read as "a link",
      long lists cut to the first 5 items with "…and more in Sara"); a reply replaced by the minors
      block is spoken as `MINOR_BLOCK_REPLY`; a reply over 1,200 characters is spoken up to the last
      sentence before it, and the window says "The rest is in Sara".
5. **Response:** `{heard, conversationId, companionId, spoken: [...], open: boolean}` (`open` true when
   the reply has something that needs a screen: an approval card, a file, a picture, a board card).
   The device then calls `POST /api/voice/speak` for each piece (the existing route; her chosen voice,
   tone, *follows mood*).

**Barge-in and stop during her reply** never lose the safety pieces: the disclosure and crisis
pieces are also stored as the conversation's `notice` rows (as today), so they are in the thread even
if he says "stop" over them; after a crisis piece is cut off, the window/notification keeps the
resources visible until dismissed.

### 5.6 Rooms and personal devices

- The `wake` channel joins `VOICE_ROOM_CHANNELS` **by default on desktop devices** (speakers in a room,
  fact 4): `voiceRoomNote` applies (never explicit whatever Adult mode says; his private matters only
  if he brings them up), exactly like Alexa and Home Assistant.
- **This device is just mine** (per device, `personal: true`; the default on Android, off on desktop):
  the exchange is his normal private conversation with her (as the Android assistant and Siri are
  today, docs/VOICE_ASSISTANTS.md). The tip says when to use it ("headphones, or your own room").
- The room note is decided per turn from the device record (the `X-Sara-Wake-*` headers resolve the
  device); a personal device in a room is his choice, explained in the ? tip.
- Private, partner, group and off-the-record conversations are never the target (§5.2), so a Hey Sara
  exchange can't read out a private chat in a room.

### 5.7 Private local mode, cost and budgets

- **Private local mode:** detection is always local. The wake turn is allowed only when **both** her
  hearing and her voice talk on this computer (`talksHere`-style check: `stt === 'local'` with the
  engine present, `tts` local, or OpenAI-compatible at a loopback address); otherwise
  `/api/wake/config` returns `paused: 'private-hearing'` and every device pauses with "Hey Sara is
  paused while *Nothing leaves this computer* is on, because her hearing uses the internet. Install
  hearing on this computer (Settings → Voice) to keep it." The turn's model follows the mode as any
  turn does. Pack and lexicon downloads are refused while the mode is on (the device checks
  `privateLocal` in the config before fetching; the server's lexicon fetch goes through `netFetch`).
- **Cost:** a wake turn is one transcription + one everyday turn + one to three speech calls, the same
  as a quick-ask voice question today. No extra model call (no wake verification, no summary). A
  false wake with nothing said costs nothing. Usage rows carry `purpose: 'wake'` so Settings → Usage
  can show "Hey Sara: 14 questions, $0.03 today".
- **Members:** their turns are billed like their other turns (their `costPerDay`, `messagesPerDay`);
  `voice: false` refuses the routes (§15).

### 5.8 The lexicon and the keyword lines

- `GET /api/wake/config` returns, per phrase: `{label, companionId, name, lines[]}` plus the stop
  lines. Lines are made by `phraseLines` (W2) when a phrase is saved, and cached in `wake.json`.
- *Hey Sara* (and *Sara stop*) lines are constants: works with no lexicon.
- Any other phrase needs `en.phone` on the server: Settings → Voice → *Hey Sara* → *Use other words*
  offers the download (3.3 MB, SHA-256 pinned in `wake-pack.ts`, from the same mirror), owner-approved;
  members can use it once the owner has it (they can't start the download: it's server-wide).
- Words not in the lexicon are refused with the word named. No guessing of spellings.

### 5.9 Events

One new hub event kind, `wake` (to the person's own sessions only): `{device, state: 'on'|'off'|
'paused', reason?}`, so the Settings device list updates live and a remote *off* reaches a listening
device at once when its event connection is open. Never carries text or audio.

---

## 6. The platforms one by one

### 6.1 Windows (the Windows app, `desktop/windows`)

- New `wake.cpp`/`wake.h` (C++ like `hands*.cpp`): WASAPI capture thread (shared mode, 16 kHz mono via
  autoconvert, event-driven, 20 ms buffers), the ring buffer, `LoadLibraryExW` of the verified
  `sherpa-onnx-c-api.dll` (function pointers by `GetProcAddress`; the DLL folder added with
  `AddDllDirectory` so `onnxruntime.dll` resolves from the pack folder only, never the PATH), the
  state machine (W3), the silence detector (W4), the chime (W5, `waveOut` from a generated buffer).
- The download uses WinHTTP (a system library, `winhttp.lib`; new to the app, which talks to the
  server only through WebView2 today) into `%LOCALAPPDATA%\Sara\wake\1\`; SHA-256 with `BCryptHash`
  (CNG, system; `bcrypt.h` is already used by `hands.cpp`). *Add from a file…* opens a folder picker and copies the
  files in after the same checks.
- Tray: the icon variants (`IDI_SARA_DOT_DIM`, `_BRIGHT`, `_GREY` in `sara.rc`), the menu items
  (§4.8), the tooltip. The quick-ask window gets `saraQuick.listen({label, companion})`,
  `saraQuick.heard(text)`, `saraQuick.say(pieces)`, `saraQuick.wakeEnd(reason)` and the page posts
  `{m:'qa', a:'wake', what: 'cancel'|'stop'|'open'}`; the page calls `/api/wake/turn` and
  `/api/voice/speak` itself (same-origin, the sign-in it already has), so **the native side never
  holds the cookie**. The recording reaches the page as base64 through `PostWebMessageAsJson` (≤ 15 s
  × 32 KB/s ≈ 480 KB).
- Session lock: `WTSRegisterSessionNotification` (`WM_WTSSESSION_CHANGE`). The Windows **service**
  (`service.cpp`, the server as a service) is untouched: the detector runs only in the signed-in
  user's tray app.
- Microphone privacy: when Windows denies the mic (`E_ACCESSDENIED` from `Activate`), the device card
  says "Windows is blocking the microphone for desktop apps: Settings → Privacy & security →
  Microphone" with a button that opens `ms-settings:privacy-microphone`.

### 6.2 macOS (the Mac app, `desktop/mac`)

- New `Wake.swift`: `AVAudioEngine` input tap → `AVAudioConverter` (16 kHz mono float) → the bundled
  `libsherpa-onnx-c-api.dylib` through a small C bridging header (the app is already Swift + C
  interop for Carbon); the state machine, silence detector and chime as on Windows.
- The engine dylibs are signed with the app (Developer ID, hardened runtime, notarized); the model is
  downloaded with `URLSession` into Application Support, SHA-256 with CryptoKit (`SHA256`, system).
- Menu bar: icon variants, the same items; `QuickAsk.swift` gets the same page calls as Windows.
- Talk shortcut via Carbon with `kEventHotKeyReleased` for hold-to-talk. Screen lock via
  `com.apple.screenIsLocked` distributed notification.
- macOS 13+ (the app's minimum); nothing needs macOS 26.

### 6.3 Linux (`sara wake`, a user-session helper like `sara hands`)

- `desktop/linux/wake.ts` (Node, no packages), started by the desktop user: `sara wake` (pairs like
  `sara hands`: a device code approved in Settings, a device token of kind `wake`, kept in the user's
  secret store through `secrets.ts`; never run as root or as a service).
- It downloads the Linux pack (§4.2, `fetch` + `node:crypto` SHA-256), runs
  `sherpa-onnx-keyword-spotter-alsa` as a child process with the keyword lines in a temp file
  (rewritten on every config change; the child restarted), reads its detections from stdout, then
  records the question with `pw-record` or `parecord` or `arecord` (the first one found; 16 kHz mono
  raw), calls the same routes with its token, and plays her pieces with `pw-play`/`paplay`/`aplay`.
- Indicator: the desktop notification (D-Bus, `dbus.ts`), the terminal line, the desktop's own mic
  indicator; *Pause* and *Stop* as notification actions where the desktop supports actions.
- It's the "for people who like a terminal" option and is labelled so in Settings; no tray icon in
  2.59.0 (§19 Q10).

### 6.4 Android (`android/`)

- New `WakeService` (Java, `foregroundServiceType="microphone"`, the permission is already declared):
  `AudioRecord` → the bundled `libsherpa-onnx-jni.so` through a tiny hand-written JNI wrapper class
  (`Kws.java`, declaring the native methods the upstream JNI exports) → the state machine; the
  ongoing notification on a new channel *Hey Sara* (low importance), the heads-up for *Listening…*
  on a second channel (high importance, short), actions *Pause 1 h*, *Stop*, *Talk*.
- **Starts only from a visible screen** (fact 6): the switch in the app, the notification's *Resume*,
  the Quick Settings tile. After a reboot or an app update, `BootReceiver` (which already exists)
  **doesn't** start it; it posts "Hey Sara is off since your phone restarted. Tap to turn it back on."
  (a normal notification whose tap opens the app, which starts the service while visible).
- The woken exchange runs **in the service, natively**: record, `POST /api/wake/turn` with the session
  cookie (`CookieManager.getCookie`, as `CallService`), `POST /api/voice/speak`, play with
  `AudioTrack`; the heads-up notification shows heard text and the reply. No activity is launched
  from the background (Android blocks that); *Open in Sara* in the notification opens the
  conversation. `starts: 'call'` hands over to `CallService` from inside the running microphone
  service.
- Battery: *Only while charging* (off by default), pause below 20 % and in Battery Saver; the
  notification says so when paused. No wakelock is taken: an active `AudioRecord` keeps the capture
  running (to be confirmed on a real phone, §13).
- Concurrent capture: when another app records (a phone call, a voice recorder, another assistant),
  Android silences Sara's capture; the service notices a run of exact zeros and shows "paused while
  another app uses the microphone".
- **The emulator** (`emulator-5554`, x86_64 image): the x86_64 ABI of the engine is included in debug
  builds so the flow can be tested there with the emulator's virtual microphone (host audio input);
  its CPU and battery numbers are meaningless, and the owner's real phone
  (the owner's own phone) is **never** used by agents: real-phone checks are the owner's (§13).
- Play Console: the microphone foreground-service declaration needs a short video of the feature
  and the reason ("hands-free assistant the user turns on; visible notification; stops with one
  tap"). That's an owner to-do (§13).

### 6.5 iPhone: not possible, said plainly

There is no "Hey Sara" on iPhone and this phase doesn't build one. iOS doesn't let an app keep the
microphone open in the background to wait for a phrase: background modes are only for "their intended
purposes" (VoIP calls, audio playback, …; App Review 2.5.4, [I1]), and a wake word is not one of them;
"Hey Siri" is Siri's only. A wake word that works only while Sara is open on screen would be allowed
but isn't worth it on a phone. What the iPhone has instead: **"Hey Siri, ask Sara"** (`AskSaraIntent`,
built in Phase 72, shipping with the iPhone update that waits on App Store review), the **Action
button** or **Back Tap** running the *Ask Sara* shortcut, and live calls with CallKit. Settings →
Voice → *Hey Sara* says this in one line on an iPhone ("On iPhone, say *Hey Siri, ask Sara*; Apple
doesn't let apps listen for their own name.").

### 6.6 The browser and the home-screen app (PWA): push-to-talk only

No wake word in the browser in 2.59.0: a page can only listen while it's open (background tabs are
throttled, and a closed tab can't listen at all), Chrome's `SpeechRecognition` sends audio to a web
service unless the newer `processLocally` is available ([W1]), and a WebAssembly build of the spotter
(upstream has `build-wasm-simd-kws.sh`) would only help while the tab stays open and visible. The web
app keeps its mic button (push-to-talk) and points to the desktop and Android apps: "Hey Sara works in
the Windows, Mac and Android apps." (§19 Q11.)

---

## 7. Part C · local hearing on Windows and macOS servers

### 7.1 Why it's in this phase

Fact 3: with *Nothing leaves this computer* on, a Windows or Mac server can't hear at all, so Hey Sara
would be paused for exactly the people who care most about privacy, and the start-up line "Local voice
isn't available on Windows yet" stays a dead end. The engine exists for both systems (fact 1); only
the installer and one function are missing.

### 7.2 What changes

- **`sara voice install`** (new `src/voice-install.ts`, also behind a button in Settings → Voice:
  *Install hearing and voices on this computer*, owner only): the same pinned items as
  `install-voice.sh` (Parakeet 110M, Kokoro v0.19, Piper hfc_female, with their SHA-256s) plus the
  platform's sherpa-onnx v1.13.8 bundle (`win-x64-shared-MD-Release`, `win-arm64-…`,
  `osx-universal2-shared`), each with a pinned SHA-256; downloaded with `fetch` through `netFetch`
  (so private local mode refuses it, with the reason), checked with `node:crypto`, unpacked with the
  **system `tar`** (`C:\Windows\System32\tar.exe` reads `.tar.bz2`, measured in §1.1; macOS
  `/usr/bin/tar`), into `<data>/voice/.partial` and moved into place when whole (the shell script's
  rule), then `voice.json` written as the shell script writes it. ≈ 650 MB, shown before it starts;
  runs as a background job with progress (the jobs list) and can be cancelled.
- **`platform.ts`:** `localVoiceSupported` becomes "Linux x64, or Windows/macOS where
  `<voice dir>/voice.json` exists or can be installed (x64, arm64)"; `localVoiceMissing` on
  Windows/macOS says "not installed yet (Settings → Voice → Install hearing and voices on this
  computer, about 650 MB)" instead of "isn't available"; `defaultEngines()` keeps hearing and voice off
  until it's installed, then the install sets `stt/tts: 'local'` **only if** they were `off` (a person
  who chose OpenAI keeps it).
- **`LocalVoiceEngine`:** spawns `.exe` names on Windows (`sherpa-onnx-offline.exe`, …) with the DLLs
  beside them; nothing else changes (it already spawns the CLI by full path).
- **The Mac server** runs as the signed-in user (Phase 46d): the downloaded upstream binaries must run
  under Gatekeeper; files fetched by Node carry no quarantine flag, but Apple Silicon requires every
  binary to be signed (at least ad hoc). Whether upstream's are, is an owner check (§13); if not, the
  installer ad-hoc signs them (`codesign -s - <file>`), which the person's Mac allows for their own
  files (§17 R7).
- **Linux** keeps `install-voice.sh` (root, `/opt/sara-voice`, shared between instances); `sara voice
  install` on Linux prints "Use: sudo ./deploy/install-voice.sh" so there is one Linux path.

---

## 8. The UI at 1440 and 390

### 8.1 Settings → Voice → *Hey Sara* (the web app, 1440 wide; also inside the desktop apps' main window)

A new card under *Calls* in Settings → Voice. The top block is **this device**; the list below is
every device of this person.

```
┌ Hey Sara ───────────────────────────────────────────────────────────────────────────────────────┐
│  Say "Hey Sara" and talk, without touching anything. Off until you turn it on, on each device. (?) │
│                                                                                                  │
│  THIS DEVICE · Windows PC "FRANK-DESK"                                                           │
│  [ ● Listen for "Hey Sara" on this computer ]  (?)        ◐ dim dot = waiting · ● bright = hearing │
│     Needs a 25 MB download (speech model + engine, from the sherpa-onnx project). [What is it?]   │
│  Microphone  [ System default ▾ ]  (?)        How easily she wakes  [ Normal ▾ ]  (?)             │
│  [✓] Chime when she starts and stops listening (?)    [ ] This computer is just mine (?)         │
│  [✓] Pause while the screen is locked (?)             Talk shortcut [ Ctrl+Alt+Space ▾ ]  (?)     │
│  Today: woke 7 times · answered 6 · nothing said 1              [Try it]  [Remove from this PC]   │
│                                                                                                  │
│  WORDS THAT WAKE HER  (?)                                                                        │
│   "Hey Sara"  → Sara                                                         [Edit] [Remove]     │
│   "Hey Mira"  → Mira                                                         [Edit] [Remove]     │
│   [+ Add words]   (custom words need a 3 MB English word list on your server: [Download])        │
│                                                                                                  │
│  WHEN SHE WAKES                                                                                  │
│   She answers in  [ her "Hey Sara" conversation ▾ ]  (?)     The phrase starts [ one question ▾ ] (?) │
│   Keep listening after her answer  [ Off ▾ ]  (?)                                                │
│                                                                                                  │
│  YOUR DEVICES                                                                                    │
│   ● FRANK-DESK (Windows) · listening · pack 1 · last woke 10:42          [Stop listening]        │
│   ● Pixel (Android) · paused: battery saver · last woke yesterday       [Stop listening]        │
│   ○ MacBook (Mac) · off                                                  (switch on on the Mac)  │
│   [Turn off everywhere]  (?)                                                                     │
│                                                                                                  │
│  On iPhone, say "Hey Siri, ask Sara": Apple doesn't let apps listen for their own name. (?)       │
│  In a browser, use the 🎙 button: a web page can't listen when it's closed. (?)                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- In the web app in a browser, *THIS DEVICE* says "This browser can't listen for Hey Sara: use the
  Windows, Mac or Android app" (no switch). The block exists only inside the native apps
  (`window.saraShell`, `window.SaraPhone`).
- *Try it*: listens for 20 s and shows each detection with its label and the level meter, without
  waking her (no claim, no turn): the way to tune sensitivity.
- Owner only, at the bottom of the card: *Allow Hey Sara on this server* ✓ and *Members may use Hey
  Sara on their own devices* ✓ (?).
- Grey states say why in the row (paused reasons from §4.10).

**First switch-on (the explanation screen, before the download and the OS prompt):**

```
┌ Before Sara listens ─────────────────────────────────────────────────────────────┐
│  ● While this is on, this computer's microphone is open, and a small speech model  │
│    on this computer listens only for "Hey Sara" and "stop".                         │
│  ● Nothing you say is sent anywhere until you say "Hey Sara". Then what you say     │
│    next goes to your Sara server to be heard and answered, like a voice message.     │
│  ● You'll see a dot on Sara's tray icon whenever the microphone is open, and        │
│    Windows shows its microphone icon too.                                            │
│  ● Say "stop", press Esc, or choose Pause in the tray at any time.                  │
│  ● Download: 25 MB from the sherpa-onnx project (Apache-2.0), checked before use.  │
│                                        [Not now]   [Download and turn on]           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**The quick-ask window, woken (desktop; 420 px wide, as today):**

```
┌───────────────────────────────────────────┐
│ (face) Sara  ● Listening…           [✕]   │
│ ▁▂▅▇▅▂▁▂▃▅▃▂  (level)                      │
│                                           │
│ You: remind me to call Mum at six         │
│ Sara: Done: six o'clock, call Mum. 🔊     │
│                                           │
│ Say "stop" or press Esc · [Open in Sara]  │
└───────────────────────────────────────────┘
```

### 8.2 At 390 (the phone; the Android app's Settings page and its notifications)

```
┌ Hey Sara ──────────────────────────┐
│ Say "Hey Sara" and talk.      (?)  │
│ [ ● Listen on this phone ]    (?)  │
│ Download 5 MB · Apache-2.0 [Info]  │
│ Wakes  [ Normal ▾ ]           (?)  │
│ [ ] Only while charging       (?)  │
│ [✓] Chime                     (?)  │
│ [✓] This phone is just mine   (?)  │
│ Today: woke 3 · answered 3         │
│ [Try it]          [Remove]         │
│ ─────────────────────────────────  │
│ Words that wake her           (?)  │
│  "Hey Sara" → Sara        [Edit]   │
│  [+ Add words]                     │
│ ─────────────────────────────────  │
│ She answers in [Hey Sara ▾]   (?)  │
│ Starts  [one question ▾]      (?)  │
│ Follow-up  [Off ▾]            (?)  │
│ ─────────────────────────────────  │
│ Your devices                       │
│  ● This phone · listening          │
│  ● FRANK-DESK · listening  [Stop]  │
│ [Turn off everywhere]         (?)  │
└────────────────────────────────────┘

Notification shade:
┌────────────────────────────────────┐
│ (S) Sara · Listening for "Hey Sara"│
│ Say "Hey Sara" any time.           │
│ [Talk]   [Pause 1 h]   [Stop]      │
└────────────────────────────────────┘
Heads-up after the phrase:
┌────────────────────────────────────┐
│ (S) Sara · Listening…              │
│ "what's on tomorrow"               │
│ [Cancel]                           │
└────────────────────────────────────┘
```

At 390 inside the web app on a desktop browser window that narrow, the card shows the same blocks
stacked; the device table becomes one row per device with the action under the name. All controls
keep the 44 px touch size and the existing `kit.css` styles (no new components except the dot glyph).

---

## 9. ? tips (each ≤ 260 characters; added to `web/tips.json` / `data-tip`)

| Control | Tip |
|---|---|
| *Hey Sara* (card) | "Say her name and talk, hands-free. A small model on the device listens only for the words; nothing is sent until you say them. Off until you turn it on, separately on each device." |
| *Listen for "Hey Sara" on this computer* | "Opens the microphone and listens for “Hey Sara” on this computer only. A dot on her tray icon shows when the mic is open. Switch it off here, in the tray, or from any of your devices." |
| The download line / *What is it?* | "A 5 MB speech model (and on Windows a 20 MB engine) from the sherpa-onnx project, Apache-2.0. Sara checks every file before using it. Remove it any time." |
| *Microphone* | "Which microphone to listen with. If she never wakes, pick your microphone by name: some PCs default to one that hears nothing." |
| *How easily she wakes* | "Relaxed wakes on a quieter or less clear “Hey Sara”, but more often by mistake. Strict needs a clear phrase. Use *Try it* to see what she hears." |
| *Chime* | "Two soft notes when she starts listening and when she stops, so you know without looking." |
| *This computer is just mine* | "Off: she treats this like a speaker in a room (never explicit, your private things only if you raise them). On: a normal private chat with her, for headphones or your own room." |
| *This phone is just mine* | Same text with "phone"; default on. |
| *Pause while the screen is locked* | "Stops listening when you lock the computer, and starts again when you unlock it." |
| *Talk shortcut* | "Press it to talk without saying her name, even with Hey Sara off. Press again to send, or just stop talking. Mac: you can also hold it while you talk." |
| *Only while charging* | "Listens only while the phone charges, for bedside or desk use. Saves battery." |
| *Words that wake her* | "Up to 4 phrases, each for one of your companions: “Hey Mira” wakes Mira. Use two or more words, English words only for now. “Hey Sara” always works." |
| *Add words* (lexicon note) | "Other words need a 3 MB English word list on your server so Sara can work out how they sound. Downloaded once, checked, kept on your server." |
| *She answers in* | "Her “Hey Sara” conversation keeps all your spoken questions together. Or use the one open on this device, or a new one each time." |
| *The phrase starts* | "One question: you ask, she answers, she goes back to listening. A live call: a full voice call starts, until you hang up (needs live calls)." |
| *Keep listening after her answer* | "Listens a few seconds more for a follow-up without her name. The dot stays bright while it does. Off by default." |
| *Your devices* / *Stop listening* | "Turns Hey Sara off on that device within a minute. Only the device itself can turn it back on." |
| *Turn off everywhere* | "Turns Hey Sara off on all your devices (owner: on everyone's). Each device has to be switched on again by hand." |
| *Allow Hey Sara on this server* (owner) | "Off: no device signed in to this server can use Hey Sara. Push-to-talk still works." |
| *Members may use Hey Sara* (owner) | "Lets the people in your household switch it on for their own devices. Their companions answer them; you never hear their questions." |
| *Try it* | "Listens for 20 seconds and shows when it hears your words, without asking her anything. Good for choosing how easily she wakes." |
| iPhone line | "iPhone apps can't listen for their own name. Say “Hey Siri, ask Sara”, or put *Ask Sara* on the Action button." |
| Browser line | "Web pages can only listen while they're open. Use the 🎙 button here, or the Windows, Mac or Android app for Hey Sara." |
| *Install hearing and voices on this computer* (Part C) | "Downloads her own hearing and voices (about 650 MB) so they work without the internet, and with “Nothing leaves this computer” on. Checked before use." |

---

## 10. Tables and files (additive; no new SQLite table)

| File / key | Shape | Notes |
|---|---|---|
| `settings.json` → `wake` (per person) | `WakeSettings` (§3.3) | Exported, backed up, imported as settings are |
| `settings.json` → `wakeServer` (owner) | `{allowed: true, members: true}` | In `OWNER_SETTINGS`; members can't see or change it |
| `<person data>/wake.json` | `{v: 1, phrases: {[label]: {text, companionId, lines[], madeAt}}, devices: {[sessionId]: {platform, label, on, paused?, pack?, sensitivity, personal, lastWake?, lastSeen, days: {[date]: {wakes, nothing, stopped, answered}}}}, claims: (memory only)}` | Atomic writes; `days` kept 14 days; a device whose session is gone is dropped on the next read |
| `<data>/voice/wake-lexicon/en.phone` | upstream file | Server-wide (one copy), SHA-256 checked on load |
| Conversations | one per companion, `channel: 'wake'`, title *Hey {name}*, everyday mode | Found by channel; normal messages; `meta.via: 'wake'`, `meta.device` on his messages |
| Usage rows | `purpose: 'wake'` on the transcription, the turn and the speech | Settings → Usage groups them |
| Device-side | §3.2 | Not on the server |

## 11. Routes (owner or member, their own space; partners, group rooms and the demo get 404; same-origin and session rules as `/api/voice/*`)

| Method and path | Body / answer | Who |
|---|---|---|
| `GET /api/wake` | `{settings, server?, devices[], lexicon: {installed}, privateLocal, iphoneNote}` | Person (owner also sees `server`) |
| `PUT /api/wake` | `Partial<WakeSettings>` → re-makes keyword lines for changed phrases; 400 with a reason per bad phrase | Person |
| `PUT /api/wake/server` | `{allowed?, members?}` | Owner |
| `POST /api/wake/phrase-check` | `{text}` → `{ok, lines?, why?}` | Person |
| `POST /api/wake/lexicon` | starts the 3.3 MB download (job); 409 in private local mode | Owner |
| `GET /api/wake/config` | for the calling device: `{on: allowedForThisDevice, paused?, phrases: [{label, companionId, name, lines}], stop: lines, sensitivity, pack: manifest entry, privateLocal, pollSeconds: 60}` | The device's session (or `wake` device token on Linux) |
| `PUT /api/wake/device` | `{on, platform, label, pack?, sensitivity, personal, counters?}`; `on: true` only from the device's own session | The device |
| `POST /api/wake/device/:sessionId/off` | remote off | Any session of the same person; owner for everyone (`/api/wake/server` for all) |
| `DELETE /api/wake/device/:sessionId` | forget a device record | Same |
| `POST /api/wake/claim` | `{label}` → `{ok, claim}` / `{ok: false, by}` | The device |
| `POST /api/wake/turn` | WAV → §5.5 | The device holding the claim |
| `POST /api/voice/install` (Part C) | starts `sara voice install` as a job; `GET /api/voice` gains `install: {state, progress}` | Owner |

Members: `memberRouteCheck` gets `wake` in the list of route families refused when `voice` is off
(the same rule as `live`/`calls`/`video`), and `wakeServer.members === false` refuses `PUT
/api/wake/device {on:true}` and `/api/wake/turn` for members with "Hey Sara is off for members on this
server. Ask the owner."

---

## 12. Done when (`test/phase126.test.ts`, plus the existing suites green)

Server and shared logic are tested in `test/phase126.test.ts` with a fake hearing (returns a set
transcript), the recording stand-in model the earlier phases use, a fixture lexicon (20 lines of the
real `en.phone` format) and fake devices (sessions). The native parts get their own small checks
(listed after), run by the existing desktop/Android build scripts, not by `npm test`.

**Keyword lines and phrases**
1. `phraseLines('Hey Sara')` returns the two built-in lines (`HH EY1 S EH1 R AH0`, `HH EY1 S AA1 R AH0`)
   with the label and the *Normal* boost/threshold, without any lexicon.
2. With the fixture lexicon, `phraseLines('hey mira')` → `HH EY1 M IH1 R AH0 :1.5 #0.25 @W2`;
   punctuation and case are ignored ("Hey, Mira!").
3. A word not in the lexicon → refused, naming the word; nothing saved.
4. Rules: 1 word refused; 5 words refused; fewer than 6 sounds refused with the *longer phrase* hint;
   a stop word refused; "Hey Google" / "Alexa" / "Hey Siri" / "OK Google" / "Hey Cortana" refused;
   a duplicate of another phrase of the same person refused; a 5th phrase refused.
5. Sensitivity *Relaxed/Normal/Strict* changes only the `:boost #threshold` parts, to the values in §4.3.
6. A phrase in German/Spanish/French/Italian/Portuguese words (fixture lexicon has none) → the
   language message from §4.4.
7. Renaming a companion doesn't change her saved phrase; deleting a companion removes her phrases and
   the next config has no line for her label.

**Config, devices, switches**
8. `GET /api/wake/config` from a fresh session: `on: false`, the phrases with lines, the stop lines,
   the pack entry for the reported platform, `pollSeconds: 60`.
9. `PUT /api/wake/device {on: true}` from the device's own session → stored; from another session of
   the same person → 403 ("Only that device can turn Hey Sara on").
10. `POST /api/wake/device/:id/off` from any session of the same person → the device's next config has
    `on: false`; a `wake` event `{state:'off'}` reaches the person's sessions and no one else's.
11. *Turn off everywhere* (person) turns off all of that person's devices; the owner's
    `PUT /api/wake/server {allowed:false}` makes every config `on: false` with reason `server-off`.
12. Signing a device out (auth `sessions` removal) → its `/api/wake/config` answers 401 and its record
    is dropped on the next `wake.json` read.
13. `wake.json` keeps `days` for 14 days only; counters add up per day; the *Strict* hint flag is set at
    5 *nothing + stopped* in a day and not again within 7 days.

**The claim**
14. Two devices of the same person claim within 1.5 s → the first gets `ok`, the second `{ok:false,
    by: <first label>}`; after 1.5 s a new claim succeeds.
15. A claim expires after 20 s; a turn without a live claim → 409.
16. Devices of two different people (owner and a member) claim at the same moment → both `ok`.

**The wake turn**
17. A WAV whose fake transcript is "remind me to call Mum at six" → a turn runs in her *Hey Sara*
    conversation (made on first use, `channel: 'wake'`, everyday mode), his message has
    `meta.via: 'wake'`; the response's last piece is `{kind:'reply'}`.
18. `talksIn: 'open'` with a private / partner / group / off-the-record conversation id → falls back to
    *own*; with a normal conversation of his → that one; another person's id → *own* (never theirs).
19. `talksIn: 'new'` → a new conversation each time.
20. Empty transcript, "um", or a single character → `{ended:'nothing'}`, **no turn and no model call**
    (the stand-in model saw no request).
21. Each stop word alone (six languages) → `{ended:'stop'}`, no turn; "stop the timer" → a normal turn.
22. The label maps to the right companion: a `W2` wake for Mira runs in Mira's store, not Sara's.
23. Over 15 s or 600 KB → 413; not WAV → 415; no claim header → 400.
24. `meta.purpose: 'wake'` on the usage rows of the transcription, the turn and each speech.

**Safety, in the spoken order**
25. First wake turn of a session (or 3 h after the last notice): `spoken[0]` is
    `{kind:'disclosure', text: disclosureText(her name, the app language)}`, and the notice row is in
    the conversation, as for typed turns.
26. A transcript that `detectCrisis` flags → `spoken` has `{kind:'crisis', text: CRISIS_RESOURCES}`
    **in full** before the reply, the system prompt carried `CRISIS_SYSTEM_NOTE`, the
    `crisis_referral` safety event is recorded, and the crisis text is not passed through `spokenText`
    shortening.
27. A reply the minors check blocks → the reply piece is exactly `MINOR_BLOCK_REPLY`; the blocked text
    appears nowhere in the response.
28. On a desktop device with `personal: false` the turn's system prompt carries `voiceRoomNote` (the
    `wake` channel counts as a room) and Adult mode on doesn't lift it; with `personal: true` it
    doesn't; Android devices default to `personal: true`.
29. The AI notice not yet accepted on this server → `/api/wake/turn` 403 and config `paused:
    'disclosure'`.
30. A tool that asks for approval → the turn waits as today, the response has `open: true`, nothing is
    approved by the wake path.

**Privacy and household**
31. Private local mode on with cloud hearing → config `paused: 'private-hearing'`, `/api/wake/turn` 409
    with the reason, `POST /api/wake/lexicon` 409; no outgoing request in `blockedRecently()` except the
    refused ones.
32. Private local mode on with local hearing and voice (the fake engine marked local) → turns work.
33. A member's device: phrases, devices, the conversation and the usage are in the member's space; the
    owner's `GET /api/wake` doesn't list them; the member's `GET /api/wake` doesn't list the owner's.
34. Member with `voice: false` → every `/api/wake/*` except `GET /api/wake` answers 403 with the
    member voice message; `wakeServer.members: false` → `PUT /api/wake/device {on:true}` and turns 403.
35. Partners, group-room sessions and the demo server → 404 on every `/api/wake/*` route.
36. No route stores audio: after 20 turns, nothing new under `<data>` but `wake.json`, the store and
    usage (a directory listing before/after).
37. `GET /api/wake/config` and the `wake` events contain no message text.

**Part C**
38. `voice-install.ts` with a fake fetch and fake `tar`: refuses a file whose SHA-256 differs (and
    deletes it); never moves a partial folder into place; writes `voice.json` in the shell script's
    shape; sets `stt/tts` to `local` only when they were `off`.
39. `localVoiceMissing('win32')` without an install says "not installed yet (Settings → Voice → Install
    hearing and voices…)", and `localVoiceSupported('win32')` is true once `voice.json` exists; Linux
    text unchanged.
40. `sara voice install` on Linux prints the `install-voice.sh` line and exits 0 without downloading;
    in private local mode it refuses before any request.

**Settings and tips**
41. Every new control in §8 has a ? tip from §9 (the existing tips test that checks every
    `data-tip` / `tips.json` id covers the new ids).
42. The *Hey Sara* card renders at 1440 and 390 without horizontal scroll (the existing layout check
    for Settings cards, given the new card's ids).

**Native checks (outside `npm test`; run by the build scripts and recorded in the release notes)**
- Windows: `Sara.exe --test-wake <folder> <wav>` loads the verified pack, feeds the WAV, prints the
  detections (the §1.1 clips as fixtures: t0 and t3 wake, t1, t2, t5 don't, t4 stops); refuses a pack
  with one byte changed.
- Mac: the same through `Sara --test-wake` (the app's test flag pattern, `testLog`).
- Android: an instrumented check on **emulator-5554 only** feeding the same WAVs to `Kws.java`.
- Linux: `sara wake --test <wav>`.

## 13. Owner to-dos

| # | What | Why it needs the owner |
|---|---|---|
| 1 | **A real microphone, a real room** on the Windows PC: say "Hey Sara" from 1 m, 3 m and across the room, with music on, with TV talk on; 30 tries each; note wakes/misses; then an hour of normal life (calls, YouTube) counting false wakes, at *Normal* and *Strict* | The §1.1 numbers are a synthesized voice; the sensitivity values (§4.3) are starting guesses |
| 2 | The same on the Mac (built-in mic) | Different capture and mic |
| 3 | **A real Android phone** (his own, by hand; agents use **only emulator-5554**, never the owner's own phone): screen off in a pocket and on a desk; battery drain over 2 h with Hey Sara on vs off (Settings → Battery), target ≤ 2 % per hour; does capture keep running in Doze without a wakelock? | The emulator has no real mic, CPU or battery; agents must not use his phone |
| 4 | Android after a reboot and after an app update: the "tap to turn it back on" notification appears; no crash | Boot rules differ by maker |
| 5 | The Play Console microphone foreground-service declaration (video + text), and the Data safety form ("audio: processed on device; sent to your own server only after the wake phrase") | His Play account |
| 6 | Accept the bigger Android app (engine inside, ≈ 9 MB per ABI) and the bigger Mac app (≈ 18 MB), or pick the add-on route (§19 Q4) | Release size is his call |
| 7 | Read the model card / licence of `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` and confirm it's OK for a paid product (§17 R3) | Licence call |
| 8 | Part C on this Windows PC: run *Install hearing and voices on this computer*, then a voice note and a Hey Sara turn with *Nothing leaves this computer* on | Real 650 MB download, real service account |
| 9 | Part C on the Mac: do the upstream binaries run, or are they killed for missing signatures (then the ad-hoc signing step is needed, §7.2) | Needs his Mac |
| 10 | Two devices in one room (PC + phone): only one answers | Real timing |
| 11 | A household member's laptop with her own companion: "Hey Mira" wakes hers, never his | Needs a second person/account |
| 12 | Say whether the iPhone line in Settings is right, and whether to add an *Ask Sara* Action-button tip to the iPhone app update | Store review timing |

---

## 14. Safety and privacy across the phase

### 14.1 The mandatory layer, spoken

- **The AI notice in voice:** the same `disclosureDue` rule as every channel (start of a session, every
  3 hours), decided per turn on the server; in a wake exchange it is the **first thing she says**,
  before the answer, in her voice, and it's in the thread. On a live call started by the phrase, the
  call's own disclosure (`LiveCall` l. 487) applies unchanged. Asked sincerely "are you a real
  person?", she says she's an AI, as always (that's her instructions, untouched).
- **Crisis in voice:** `detectCrisis` runs on the transcript as on typed text; the resources are
  spoken **in full** and shown on screen / in the notification until dismissed; "stop" can cut the
  audio but not remove them from the screen or the thread; the follow-up window (if on) stays open so
  he can keep talking; the next wake turns in that session carry `CRISIS_SYSTEM_NOTE` as typed turns
  do.
- **The minors block:** unchanged; a blocked reply is spoken as the fixed refusal only.
- **Rooms:** desktop speakers count as a room by default (§5.6), with the existing `voiceRoomNote`.
- Nothing in this phase can loosen the layer: no setting skips the spoken disclosure, shortens the
  crisis text, or turns the room rule off for a desktop except his own *just mine* switch.

### 14.2 Privacy

- **On-device detection only.** The detector's audio never leaves the device and is never written to
  disk; the 320 ms chunks are overwritten. The server has no route that accepts audio except the
  existing ones and `/api/wake/turn`, which requires a live claim (i.e. a detection just happened).
- **Nothing before the phrase.** The recording starts after the phrase's last token; there is no
  pre-roll.
- **No audio kept anywhere.** The WAV is transcribed in memory and dropped (test 36).
- **Counters, not content.** Device records hold counts and times, never text.
- **The OS indicators are never avoided** (§4.6).
- **Private local mode:** downloads refused; turns only with hearing and voice on this computer.
- **Off means off:** the audio device is closed (not muted) in `off` and `paused`.

### 14.3 The leak paths, and what closes each

| Path | Closed by |
|---|---|
| A tampered or swapped engine DLL on Windows (DLL planting) | Full-path `LoadLibraryExW` after a SHA-256 check at every load; `AddDllDirectory` to the pack folder only; the pack folder is per user |
| A tampered download | SHA-256 from the manifest compiled into the app (not fetched); both mirrors are just copies |
| Someone else's voice waking his Sara in a shared room | Room rules on desktops by default; the answers go to his *Hey Sara* conversation, which he can read; no approvals by voice; §19 Q7 for voice matching |
| A TV saying "Hey Sara, delete my files" | Ordinary everyday turn: destructive tools ask for approval on screen; nothing is approved by voice (§5.5 step 3) |
| A remote attacker turning on the mic | `on: true` only from the device itself; the server can only turn devices off |
| A member's device answering for the owner | Sessions are per person; claims, phrases and conversations are per person (§15) |
| Her reply read aloud in a room containing his private chat | Private / partner / group / off-the-record conversations are never the target (§5.2) |
| A recording sent without a wake (a bug in the device) | The server refuses turns without a live claim; claims are short-lived; counters would show it |

### 14.4 Threat model additions (`docs/THREAT_MODEL.md` in the release)

A *Hey Sara* section: assets (the microphone, the transcript), entry points (`/api/wake/*`, the pack
files, the device switch), the rules above, and what is out of scope (someone with the device
unlocked in their hands can turn it on, like any app; speaker spoofing, §19 Q7).

---

## 15. Household isolation

- The device answers for **the person signed in on it**: the owner's PC → the owner's companions; a
  member's laptop → that member's companions, in that member's data folder. Phrases, devices, claims,
  conversations and counters live in that person's space; the owner can't read a member's phrases or
  questions, and members never see the owner's.
- **Whose Sara answers when two people share one room:** each device answers its own person; if both
  say "Hey Sara" and both have a listening device, both answer (they're different Saras). The card
  suggests different phrases when a member adds "Hey Sara" and the owner also uses it: "Others in
  your household also use *Hey Sara*. A different phrase (*Hey Mira*) avoids both answering."
  (It knows only that the phrase is in use on the server, not by whom.)
- **One shared computer, two people** (one Windows user each): Sara's desktop app and its tray run per
  Windows user, each with their own sign-in, so each user's session listens for their own person.
  On the **same** Windows user with two people: it's one person's device; the room rule applies.
- The owner's gates: *Allow Hey Sara on this server*, *Members may use Hey Sara*, and the existing
  per-member `voice` switch, which turns off Hey Sara with the rest of voice.
- Members can't download the lexicon (server-wide); they can use it once the owner has it.

---

## 16. Reuse vs build

| Need | Reused | Built new |
|---|---|---|
| Speech engine | sherpa-onnx v1.13.8 (already pinned for local voice) | The wrapper per app (C++, Swift, JNI class, CLI driver) |
| Hearing, her voice | `Speech.transcribe`, `/api/voice/speak`, `spokenText` | — |
| The turn | `runTurn` through the messages path; approvals, budgets, private local mode | The `wake` channel and its conversation |
| Safety | `disclosureDue`, `CRISIS_RESOURCES`, `detectCrisis`, `MINOR_BLOCK_REPLY`, `voiceRoomNote` | The spoken order (§5.5) |
| Desktop UI | Quick-ask window and page, tray/menu, global shortcuts, toasts, `PermissionRequested` | Native capture, the dot icons, the listening mode of the page, the talk shortcut |
| Android | `CallService` patterns (cookie, audio, notifications), `BootReceiver`, assistant entry | `WakeService`, `Kws.java`, the tile |
| Linux | `sara hands` pairing/token pattern, `dbus.ts`, `secrets.ts` | `wake.ts` driver |
| Downloads | `install-voice.sh`'s pinning and "move into place when whole" | `wake-pack.ts`, `voice-install.ts` |
| Calls | `/api/live`, `CallService`, the "first to answer" rule of `calls.ts` | The claim |
| Settings | Settings → Voice card patterns, `tips.json`, device list | The *Hey Sara* card |

Not built: speaker recognition, a wake word in the browser or on iPhone, model training, a server-side
listener, any npm package.

---

## 17. Risks

| # | Risk | Likelihood / impact | What we do |
|---|---|---|---|
| R1 | False wakes in a real room (TV, podcasts, people named Sarah saying "hey") | Medium / medium | Two-word phrase, sensitivity, nothing-said costs nothing, counters and the *Strict* hint, owner checks §13.1 before release |
| R2 | Misses (accents, distance, laptop mics) | Medium / medium | *Relaxed*, the mic picker, *Try it*; push-to-talk always works |
| R3 | The model's licence turns out unsuitable | Low / high | Owner check §13.7 before release; fall back to `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (English, BPE tokens; then custom words need a tokenizer: §19 Q8) |
| R4 | Mirrored files drift from upstream | Low / high | `scripts/wake-pack.mjs` re-downloads upstream tarballs, compares, and fails the release on any difference |
| R5 | Android app size grows from ~0.1 MB to ~9 MB per ABI; "about 100 KB" in the README becomes false | Certain / low | Per-ABI APKs; README updated in the release; §19 Q4 offers the add-on app instead |
| R6 | Mac app grows ~18 MB (universal dylibs) | Certain / low | Accepted, or arm64+x64 slices only for what we ship |
| R7 | Upstream Mac binaries (Part C) aren't signed → killed on Apple Silicon | Medium / medium | Ad-hoc sign after the hash check; owner check §13.9 |
| R8 | Battery drain on phones | Medium / high | Pause rules, *Only while charging*, measurement §13.3 with a 2 %/h target; if missed, ship Android as "while charging" by default |
| R9 | Play rejects the microphone foreground service declaration | Low / high | Clear user-started feature, visible notification, Stop; the declaration text and video prepared; Android Hey Sara can ship in a later app update without blocking the server release |
| R10 | Echo: her voice re-triggering, or "stop" not heard over her | Medium / low | Phrase lines off while she speaks; `STOP` only; echo canceller on Android; Esc / notification Stop |
| R11 | Two devices answering | Low / low | The claim (§5.4) |
| R12 | Concurrent mic use breaks a call in another app | Low / medium | Sara pauses on its own calls; Android silences background capture for others; Windows/Mac shared mode doesn't block others |
| R13 | Private local mode on Windows/Mac without Part C makes Hey Sara useless | Certain if Part C is cut | Part C in this release (§19 Q1), else the clear pause reason |
| R14 | The Linux helper is fragile across desktops (ALSA vs PipeWire, notification actions) | Medium / low | Labelled "for terminal users"; three recorder fallbacks; documented |
| R15 | Scope: three native apps + server + Part C in one release | High / medium | Split order in §18: server + Windows first, then Android, Mac, Linux; Part C independent |
| R16 | Spoken replies leak something on a desktop in a room | Low / medium | Room rule by default; private chats never the target |

---

## 18. The phase at a glance

| Step | What | Where |
|---|---|---|
| 1 | `wake.ts`, `wake-pack.ts`, `routes/wake.ts`, settings, `wake.json`, the `wake` channel and conversation, the spoken order, room rule, household, private local; `test/phase126.test.ts` 1–37, 41–42 | `src/` |
| 2 | Part C: `voice-install.ts`, `platform.ts`, `LocalVoiceEngine` `.exe` names, the Settings button; tests 38–40 | `src/` |
| 3 | Windows: `wake.cpp`, tray icons, quick-ask listening mode, talk shortcut, `--test-wake` | `desktop/windows`, `desktop/shared` |
| 4 | Android: `WakeService`, `Kws.java`, jniLibs per ABI, notifications, tile, boot notice, emulator check | `android/` |
| 5 | Mac: `Wake.swift`, bundled dylibs, menu bar, `--test-wake` | `desktop/mac` |
| 6 | Linux: `sara wake` | `desktop/linux` |
| 7 | Settings card, tips, docs (VOICE_ASSISTANTS, PRIVACY, THREAT_MODEL, PHONE, desktop.md), `scripts/wake-pack.mjs`, the mirrored pack | `web/`, `docs/`, `scripts/` |
| 8 | Owner checks §13 | — |

---

## 19. Blocking questions (with the defaults the parent applies if the owner is away)

| # | Question | Default |
|---|---|---|
| Q1 | Include Part C (local hearing and voices on Windows and macOS servers, ≈ 650 MB optional download) in 2.59.0? | **Yes.** Without it Hey Sara pauses under *Nothing leaves this computer* on Windows/Mac, and the start-up line stays |
| Q2 | Which platforms ship in 2.59.0? | **Server, Windows and Android** in 2.59.0; **Mac and Linux** in the same release if they're ready, else a 2.59.x follow-up (they don't block the release) |
| Q3 | The engine: sherpa-onnx keyword spotting only, or also the OS recognizers? | **sherpa-onnx only** (one engine, one tuning) |
| Q4 | Android: engine inside the Sara app (≈ 9 MB per ABI, per-ABI APKs), or a separate *Sara Hey* add-on app from Play? | **Inside the app**, model downloaded. The add-on doubles store work and needs a cross-app audio hand-off |
| Q5 | May approvals ever be given by voice ("yes, run it")? | **No.** Approval cards stay on screen |
| Q6 | On a live call started by the phrase, does "goodbye" hang up? | **No** in 2.59.0; hang up as today (button / notification) |
| Q7 | Speaker recognition (only his voice wakes his Sara)? | **No** in 2.59.0 (later, local, opt-in); room rules cover shared spaces |
| Q8 | Custom words in languages other than English? | **No** in 2.59.0 (the model is English + Chinese); *Hey Sara* works for all |
| Q9 | Keep the OS recognizers (Android on-device `SpeechRecognizer`, Apple Speech) as a later "no download" option? | **Later**, not in 2.59.0 |
| Q10 | Linux: tray icon (StatusNotifierItem over D-Bus) now, or notifications only? | **Notifications only**; tray later |
| Q11 | A wake word in the browser/PWA while the tab is open (WebAssembly spotter)? | **No** |
| Q12 | The default phrase when she has another name | ***Hey {her name}*** if the lexicon knows it, else *Hey Sara* until the lexicon is downloaded |
| Q13 | Where wake turns go by default | **Her own *Hey Sara* conversation** per companion |
| Q14 | Follow-up listening after her answer | **Off** by default (5 or 8 s on offer) |
| Q15 | Pause while the screen is locked (desktop) | **On** by default |
| Q16 | Desktop counts as a room by default | **Yes**; *This computer is just mine* switches it; Android defaults to *just mine* |
| Q17 | Chime on by default | **Yes** |
| Q18 | Members may use Hey Sara by default | **Yes** (with the existing per-member voice switch) |
| Q19 | Host the pack on backstagecoding.com as well as GitHub release assets | **Yes**, both, byte-identical, hash pinned in the apps |

---

## 20. Key choices in short

- **On the device only.** Detection runs in the Windows, Mac and Android apps (and `sara wake` on
  Linux), never on the server; nothing is sent until the phrase, and the recording starts **after** it.
- **One engine:** sherpa-onnx keyword spotting (Apache-2.0), the upstream Sara already pins for local
  voice; measured here at 1 % of one core, 5.4 MB model, 2/2 hits and 0/5 false wakes on test clips.
  Not openWakeWord (non-commercial models, per-phrase training), not Porcupine (keys, vendor account),
  not Vosk or whisper.cpp (full recognizers, heavy for an always-on job).
- **Optional, checked downloads** where allowed (the model everywhere; the engine on Windows and
  Linux), **in the signed app** where the platform requires it (Mac library validation, Play's rule on
  downloaded code). SHA-256 pinned in the app; removable in one tap.
- **Visible always:** a dim/bright dot on the tray and menu-bar icon, an ongoing notification on
  Android, the OS's own mic indicators never avoided; a chime.
- **Push-to-talk everywhere,** with no download: *Talk to Sara* shortcut (Ctrl+Alt+Space / ⌃⌥Space),
  the tray item, Android's assistant gesture and a Quick Settings tile.
- **Stop:** "stop" while she speaks (a second keyword), whole-utterance stop words, Esc, the
  notification. False wakes cost nothing when nothing is said; counters suggest *Strict*.
- **Per-device opt-in;** only the device can switch itself on; any of his devices (or the owner,
  server-wide) can switch it off.
- **Custom words:** up to 4 phrases per person, each for one of their companions; English words from
  the model's lexicon, turned into keyword lines on the server.
- **The wake turn** is an ordinary turn in her *Hey Sara* conversation; the AI notice spoken first,
  crisis resources spoken in full, the minors block, and **desktop speakers treated as a room**.
- **Household:** the device's signed-in person and their companions only; claims and data per person.
- **Platforms:** Windows, Android (screen off, foreground service, resumes by tap after reboot), Mac,
  Linux (terminal helper); **iPhone not possible** (no background listening for apps: "Hey Siri, ask
  Sara"); browsers push-to-talk only.
- **Part C** fixes the root of "Local voice isn't available on Windows yet": a cross-platform
  installer for the same pinned sherpa-onnx voice bundle, so private local mode keeps hearing.

---

## 21. Sources

Read 2026-11-02 unless noted. Upstream release data from the GitHub API for
`k2-fsa/sherpa-onnx` tags `v1.13.8` and `kws-models`.

**Hermes Agent and OpenClaw** (GAP_REVIEW's [H14], [O16])
- [H14] Wake Word ("Hey Hermes") — https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word
- [H3] Slash commands (`/wake`) — https://hermes-agent.nousresearch.com/docs/reference/slash-commands
- [O16] Voice wake (global wake words, routing, nodes) — https://docs.openclaw.ai/nodes/voicewake
- [O25] Voice Wake & Push-to-Talk (macOS) — https://docs.openclaw.ai/platforms/mac/voicewake

**Engines**
- [E1] sherpa-onnx keyword spotting (open vocabulary, boosting score, trigger threshold) — https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- [E2] sherpa-onnx KWS pre-trained models (zh-en 3M 2025-12-20, gigaspeech 3.3M) — https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html ; repository and licence (Apache-2.0), C API `sherpa-onnx/c-api/c-api.h`, CMake targets `sherpa-onnx-keyword-spotter(-alsa,-microphone)` — https://github.com/k2-fsa/sherpa-onnx ; releases — https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8 , https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models
- [E3] openWakeWord (Apache-2.0 code; pre-trained models CC BY-NC-SA 4.0; training; verifier models) — https://github.com/dscripka/openWakeWord
- [E4] Porcupine Wake Word (AccessKey, Console-trained `.ppn`, platform-specific) — https://picovoice.ai/docs/porcupine/
- [E5] Picovoice FAQ (monthly active users, one-time free trial, no personal/non-commercial plans) — https://picovoice.ai/docs/faq/general/
- [E6] Vosk (offline recognition, Apache-2.0, 50 MB models, grammar) — https://alphacephei.com/vosk/ , https://github.com/alphacep/vosk-api , `vosk_recognizer_new_grm` — https://docs.rs/vosk-sys/latest/vosk_sys/fn.vosk_recognizer_new_grm.html
- [E7] whisper.cpp `stream` ("a naive example… every half a second") — https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream
- [E8] whisper.cpp `command` (guided mode) — https://github.com/ggml-org/whisper.cpp/tree/master/examples/command

**Android**
- [A1] Foreground service types required (Android 14; microphone is while-in-use) — https://developer.android.com/about/versions/14/changes/fgs-types-required
- [A2] Restrictions on starting a foreground service from the background — https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- [A3] Android 12 release notes (`AlwaysOnHotwordDetector` became `@SystemApi`) — https://source.android.com/docs/whatsnew/android-12-release
- [A4] Android 12 CDD (`HotwordDetectionService`, "always-on hotword detection without mic access indication") — https://source.android.com/docs/compatibility/12/android-12-cdd
- [A5] Android 15 foreground service type changes (no microphone FGS from `BOOT_COMPLETED`) — https://developer.android.com/about/versions/15/changes/foreground-service-types , https://developer.android.com/about/versions/15/behavior-changes-15
- [A6] Google Play Device and Network Abuse policy (no downloading dex/.so from outside Play) — https://support.google.com/googleplay/android-developer/answer/9888379

**Apple**
- [I1] App Review Guidelines 2.5.4 (background services for intended purposes) and 2.5.14 (consent and indication when recording) — https://developer.apple.com/app-store/review/guidelines/

**Web**
- [W1] MDN `SpeechRecognition` (server-based in Chrome; `processLocally`) — https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition

**Sara's own code and docs** (read at 2.58.0, commit `5e8a039`): `src/voice.ts`, `src/live.ts`,
`src/speech.ts`, `src/platform.ts`, `src/main.ts` (l. 389–390, 1254–1255), `src/safety.ts`,
`src/household.ts`, `src/auth.ts`, `src/private-local.ts`, `src/net-guard.ts`, `src/push.ts`,
`src/calls.ts`, `src/routes/voice.ts`, `src/routes/live.ts`, `deploy/install-voice.sh`,
`desktop/windows/src/main.cpp`, `desktop/mac/Sources/QuickAsk.swift`, `desktop/mac/Info.plist`,
`desktop/mac/Sara.entitlements`, `desktop/mac/build.sh`, `desktop/shared/quick-ask.html`,
`desktop/linux/*.ts`, `android/app/src/main/AndroidManifest.xml`, `android/app/build.gradle`,
`android/.../CallService.java`, `android/.../MainActivity.java`, `android/README.md`,
`ios/README.md`, `ios/Sara/AskSaraIntent.swift`, `web/app.js` (`saraAssist`, voice init),
`web/live.js`, `web/voice.js`, `web/index.html` (Settings → Voice), `web/tips.json`,
`docs/VOICE_ASSISTANTS.md`, `docs/HOUSEHOLD.md`, `docs/SOURCE_OF_TRUTH.md`, `docs/ROADMAP.md`
l. 1382, `docs/design/GAP_REVIEW.md` §1 G17, §2 #17, §4, Sources.

**The measurement (§1.1)** was run on this PC (Windows 11, AMD Ryzen 9 9950X) in the Hermes scratch
folder with the upstream files named there; the folder was deleted afterwards. No server was started
and no port was used.
