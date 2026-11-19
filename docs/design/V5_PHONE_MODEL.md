# V5.6 Phone fallback model: design (one page)

**Goal.** While the server is away, the Android app can give a short answer from a small model
that runs on the phone. The answer is marked **Offline answer** and is synced into the chat when the
server is back. Acceptance: with the server down, the app answers from the local model and the
reply is synced later.

## What existed (extended, not duplicated)
- Feature 4 / R9 offline copy (docs/OFFLINE.md): `web/offline-store.js` (encrypted copy + outbox,
  `queue`/`mark`), `web/offline-view.js` (the offline view, Waiting to send bubbles),
  `web/offline-sync.js` (`flushOutbox`, sent once per `clientKey`), `web/offline-hook.js` (the
  Settings section *Offline on this device*), `src/offline-keys.ts` + the messages route in
  `src/server.ts` (duplicate keys answered with `{duplicate:true}`).
- The Android app's dlopen engine pattern (C17 Hey Sara: `fetch-wake-libs.sh`, `cpp/kws.c` builds as
  a stub without the engine's header) and its `SaraPhone` JavaScript bridge.

## What is new
1. **Engine on the phone (Android only).** `android/fetch-llm-libs.sh` puts a pinned llama.cpp
   build (MIT) into `jniLibs/` (gitignored): the official `android-arm64` release (SHA-256 pinned),
   and with `--emulator` an x86_64 build from the pinned source with the NDK. `cpp/llm.c` is Sara's
   small JNI shim (dlopen, so a checkout without the engine still builds: the feature then says
   "not on this phone"). `LocalModel.java`: model file, download, answer, off switch.
2. **The model.** One pinned choice: Qwen2.5 0.5B Instruct, Q4_K_M (Apache-2.0, ~490 MB, speaks
   all six languages), downloaded only when the person taps *Download* in Settings, straight from
   Hugging Face (public file, no account), resumable, checked against its SHA-256 before use.
   *Remove* deletes it. Nothing is downloaded by default.
3. **Answering.** In the offline view a message to a kept chat goes to the outbox as before; if the
   phone model is ready and on, the page asks it (`web/offline-answer.js`: the last 6 kept messages
   + the question, at most 160 words out, "say it waits for the server" when it needs tools,
   the internet or her memory). The answer shows under the message as *Offline answer · from the
   small model on this phone*; it is saved with the outbox item (encrypted like the rest).
4. **Sync.** `flushOutbox` sends `offlineAnswer: {text, model, at}` with the message. The server
   (`src/offline-answer.ts`) stores the message and the answer (`meta.offlineAnswer`) and does
   **not** run a second turn, so nothing is answered twice; the same key sent again is a duplicate
   as before. In the chat the answer carries the *Offline answer* chip and **Ask Sara again**
   (the existing retry route: she answers it properly with the full model).
5. **Who.** Off-the-record chats are never kept, so never answered. A child's account: the phone
   never asks the model (the page knows from `/api/me`) and the server ignores an offline answer
   from a child's device (the message then gets a normal turn).

## Settings
Settings → Connections → Devices and sign-in → *Offline on this device* gains **Answers while
offline**: the switch, the model's state (not downloaded / downloading 41% / ready, 490 MB), and
Download / Remove. Outside the Android app it shows "Only in the Android app" (shown, not hidden).

## Not done (on purpose)
No iPhone (no TestFlight here), no tools/memory for the small model, no streaming of its answer,
no GPU backends. The phone model never sees anything the offline copy doesn't already keep.
