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
- **Next step:** keep the engines loaded. sherpa-onnx ships `sherpa-onnx-offline-websocket-server` for
  hearing (that should save about 1 s). Her voice needs a resident process too. Both fit behind
  `LocalVoiceEngine`.
- Cloud engines were not measured: no paid services were used.
