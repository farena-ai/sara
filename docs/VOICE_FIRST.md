# Talk with Sara (voice-first mode)

ROADMAP_U U4.24. Press the talk button next to the message box and just talk. Sara listens all the
time, answers out loud sentence by sentence, and shows a live transcript. Talk over her and she stops.
Say "goodbye" or press **End** to finish. The button works in the browser, the Windows and Mac apps and
the phone web app: it is the same page everywhere.

## What you see and hear

- **One button** (speech-bubble icon, "Talk with Sara") opens a calm panel. On a phone the panel fills
  the screen. It shows the status (Listening, Hearing you, Thinking, Speaking, Waiting for your OK), the
  transcript (you, her, and short notes) and **Mute** and **End**.
- **Talking over her** stops her voice and her reply right away. What you said goes next.
- **Short fillers.** If she hasn't started answering 0.7 s after you stop talking, she says a short
  "Mm-hm." or "One moment." The four lines are made once when the talk starts, so they play at once.
  You get one filler per turn, and none when hearing finds no words (a cough).
- **Approvals by voice.** When something needs your OK, the card moves onto the talk panel and she says
  "Say yes to go ahead, or no to cancel." A plain yes or no answers it (the same words as car mode, in
  six languages). Saying yes or no never stops the turn that is waiting. The card stays tappable.
- **Hard limits (unchanged).** Money (pay, buy, transfer, wallet), passwords, sign-ins, vaults and her
  hands on the computer are never approved by voice. For those she says "This one needs a tap." The
  server enforces it (`voiceMayApprove` / `VOICE_NEVER_TOOL` in `src/phone-actions.ts`), and the same
  rule now covers car mode and phone calls.
- **Goodbye.** "Goodbye", "bye Sara", "thanks, bye", "that's all for now", "adiós", "au revoir",
  "tschüss", "tchau", "ciao" or "arrivederci", said on its own, ends the talk. Inside a longer request
  ("say goodbye to my sister in an email") it is just words to her. The word is never sent to her.

## Settings (Settings → Sara → Voice → Talk with Sara)

| Setting | Default | What it does |
| --- | --- | --- |
| Short "Mm-hm" while she thinks | on | the filler line |
| Answer her cards by saying yes or no | on | off: every card needs a tap |
| Saying "goodbye" ends the talk | on | off: only End stops it |

Hearing and her voice are the ones chosen above on the same page: on this server (sherpa-onnx Parakeet
and Piper/Kokoro) or a speech service (speech API, ElevenLabs, Grok voice). **Hey Sara → The phrase
starts → Talk with Sara** opens a talk in the window of the app that heard the phrase.

## Privacy, household and kids

- **Nothing leaves this computer** (private local mode): the talk only starts when hearing and her voice
  are both on this server. Otherwise it explains why and stays closed. The model is the one private local
  mode already picks.
- **Household members** talk in their own space with their own cards. `POST /api/talk/answer` is a member
  route that only answers cards in the member's own turn, and it refuses (403) when the owner switched
  voice off for that member.
- **Kid mode:** the same limits. Kid tools stay gated as always. A child answers only their own cards,
  and the voice hard limits apply.

## One-page design

```
mic ─► Mic (AudioWorklet) ─► Call (web/voice.js)                    ─► her voice
         energy VAD (noise floor ×3)      ▲ barge-in: talking over       Speaker: sentence by sentence,
         + SpeechGate (ZCR 120–4500/s)    │ her stops Speaker + turn     2 sentences synthesized ahead
         └ end of speech (900 ms) ─► TalkSession (web/talk.js) ─────────► filler at +0.7 s (prefetched)
              /api/voice/transcribe        goodbye? → end
                                           card waiting + yes/no? → POST /api/talk/answer (no turn stop)
                                           else → send(text, talk: true) ─► runTurn (talk note, no
                                                                            private thinking)
             stream events ─► talkEvent: tokens → transcript; approval → card onto the panel + spoken hint
```

- **VAD:** the existing classic-call energy VAD (adaptive noise floor, 160 ms of speech to start, 900 ms
  of quiet to end, a higher bar while she speaks) plus a new `SpeechGate`: a WebRTC-style check of the
  zero-crossing rate over 30 ms windows. Mains hum (too few crossings) and hiss, fans or keyboards (too
  many) never start an utterance. No onnxruntime/Silero is vendored in Sara, so no model is downloaded.
- **Server:** `talk: true` on a message adds `talkNote` (short spoken sentences, no markdown, a short
  first sentence) and turns off private thinking for the turn. `src/talk.ts` holds the prefs
  (`VoiceSettings.talk`) and the note. `/api/talk/answer` shares car mode's `voiceAnswer`.
- **What existed and was reused:** the classic call (Mic, Call, Speaker with barge-in and streaming
  sentence TTS), car mode's spoken approve/decline (`voiceAnswer`, `approvalCommand`), the phone rule
  (`phoneMayApprove`), Hey Sara's `starts` setting, the hearing and voice engines, and the approval cards.

## Latency (measured on this PC, 2026-11-18)

Measured from the end of your words to the first sound of her reply. Local hearing (Parakeet 110M
through the sherpa-onnx CLI), Sara's real `runTurn` with the talk note through Ollama on the RTX GPU,
and local Piper `hfc_female`. Five turns after a warm-up (`scratch/u4voice/latency.ts`):

| Model | Hearing | First sentence | Her voice (1st sentence) | Total, median (best–worst) |
| --- | --- | --- | --- | --- |
| gemma4:12b, thinking on (before) | ~1.1 s | 1.5–22.8 s | ~0.85 s | 8.7 s (3.6–12.6) |
| gemma4:12b, talk turn (thinking off) | 1.0–1.6 s | 0.95–1.2 s | 0.8–1.4 s | **3.2 s** (2.8–4.2) |
| qwen3.5:9b, talk turn | 1.2–1.5 s | 0.34–0.65 s | 0.8–1.1 s | **2.5 s** (2.3–3.2) |

- **The target (first audio under 1.5 s) is met only by the filler**, which plays 0.7 s after you stop.
  Her real answer starts after 2.3–3.2 s.
- The model is no longer the bottleneck. Hearing and her voice each start a new sherpa-onnx process
  that loads its model on every call (about 0.8–1.2 s each).
- U5 (below) keeps the engines loaded: same PC, same models, **0.42 s** median with qwen3.5:9b.
- Cloud engines were not measured: no paid services were used.

## Engines stay loaded (U5)

The local hearing (Parakeet) and her local voice (Piper/Kokoro) now stay in memory between calls, so
neither reloads its model for every sentence.

- **How:** `deploy/voice/sara-voice-worker.c` is a ~120-line program on the sherpa-onnx C API (the same
  library the voice tools use). One process per model: one for hearing, one per voice (at most two voices
  kept). Sara talks to it over stdin/stdout, one job per line (`src/voice-warm.ts`, `WarmWorker`), so
  nothing listens on the network. (The stock `sherpa-onnx-offline-websocket-server` was tried first and
  dropped: it always binds `0.0.0.0` and has no voice side.)
- **When:** started on first use, or when Talk opens (`POST /api/voice/warm`). Stopped after the idle
  time: **Settings → Sara → Voice → Talk with Sara → Keep hearing and voice loaded** (Off, 10 minutes
  (default), 30 minutes, 1 hour; owner only, for the whole server). Off frees the memory right away.
- **Safety nets:** jobs run one at a time per worker; a job that takes over 60 s kills the worker; a crash
  fails only that job and the next one starts a fresh worker; three failures within 5 minutes pause the
  worker for 10 minutes; it won't start with less than 512 MB free; it restarts after 2000 jobs. **Any**
  worker trouble falls back to the old one-shot tools, so voice keeps working.
- **Where the helper comes from:** `deploy/install-voice.sh` (Linux) builds it when a C compiler is
  there (`cc`); without one, Sara uses the one-shot tools as before. `sara voice install` on Windows and
  macOS does not build it yet (no compiler on those machines): until a release ships a prebuilt helper,
  those servers keep the one-shot path. Build by hand: `cc -O2 -o <sherpa>/bin/sara-voice-worker
  deploy/voice/sara-voice-worker.c -I<sherpa>/include -L<sherpa>/lib -lsherpa-onnx-c-api` (on Windows,
  MSVC `cl /O2 /MD … sherpa-onnx-c-api.lib`). It must be built against the same sherpa-onnx release.
- **Memory (this PC):** about 190 MB for hearing and 110–150 MB for the Piper voice while loaded.
- **Not done:** partial transcripts while you speak. The installed Parakeet model is offline-only; that
  needs a streaming (online) model, which isn't installed.

### Measured (this PC, 2026-11-18, `scripts/voice-latency.ts`, 5 turns after a warm-up, two runs each)

| Model | Path | Hearing | First sentence | Her voice (1st sentence) | Total, median (best–worst) |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:9b | one-shot (before) | 0.81–0.92 s | 0.27–0.51 s | 0.68–1.0 s | **1.93 s / 1.98 s** (1.81–2.32) |
| qwen3.5:9b | loaded (U5) | 0.03–0.04 s | 0.26–0.36 s | 0.03–0.11 s | **0.36 s / 0.42 s** (0.33–0.55) |
| gemma4:12b | one-shot (before) | 0.87–1.4 s | 0.82–1.1 s | 0.68–1.0 s | **2.80 s** (2.39–3.15) |
| gemma4:12b | loaded (U5) | 0.03–0.04 s | 0.86–5.9 s | 0.03–0.25 s | **1.03 s** (0.95–6.14; the worst is the model) |

The engines' own time is now under 0.15 s per turn; what's left is the model. Loading both takes about
1–1.6 s, which happens while Talk opens. The one-shot numbers are lower than in U4.24 (1.9 vs 2.5 s)
because the PC was quieter; both rows here were run back to back.
