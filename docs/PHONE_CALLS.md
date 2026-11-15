# Phone calls, Discord voice and car-mode errands (R5)

Voice that does things: Sara can answer and place real phone calls in her own voice, take messages,
make an errand's call, and run errands hands-free from car mode. **It ships switched off.** No phone
number is bought by Sara and nothing calls anyone until the owner brings a provider account, sets it
up and turns it on.

## Setting it up (Settings → Connections → Phone and notifications → Phone calls)

1. A provider account with a voice number: Twilio, or a provider with the same API (the provider
   address field takes another API base). Paste the **account SID** and **auth token**: they go to
   the vault (`bridge:phone`), are never shown again and are checked on every webhook.
2. **Her phone number** (the number from the provider) and **your number** (always gets through;
   "call me" calls it).
3. **Public address of this server**: the https address where the provider reaches Sara (a tunnel
   or reverse proxy). Sara shows the webhook to paste into the number's settings:
   `https://<address>/tel/twilio/voice` (POST, "A call comes in"). Status updates go to
   `/tel/twilio/status`; audio uses the Media Stream WebSocket `/tel/twilio/stream`.
4. Her voice must make phone audio: the voice on this server, an OpenAI-compatible speech API (asked
   for WAV) or ElevenLabs (asked for 16 kHz PCM). Grok voice makes MP3 only, which a phone line
   can't play here. Hearing (speech-to-text) must be on.
5. Optional: **People who get through** (name, number per line), **Record calls she places**
   (off by default), **Longest call** (10 minutes by default, 1 to 60), **Your price per minute**
   (from your provider's price list; used only for the estimate on each call's card, never looked up).
6. **Switched on.** The test call to your number stays disabled until everything above is set.

Until then every path says what is missing: the settings list, the chat tool ("Phone calls aren't
ready, so nothing was called" with the number and a script), the errand step (the old hand-over:
the number and what to say), and the webhooks (404 without credentials; calls are rejected while
switched off).

## Calls in

- The provider's webhook is checked with its signature (HMAC-SHA1 over the public URL and the form,
  `X-Twilio-Signature`). A one-time token (2 minutes) ties the Media Stream to the call.
- **Screening:** your own number talks with her with her tools (car-mode limits: short spoken
  answers, no computer use or long tasks; approvals by saying "approve" or "no", PC-only cards wait
  for the computer). People on the list and your emergency contact (My details) talk with her
  without tools or private details. Everyone else is screened: she says who she is, asks who is
  calling and what it's about, and the message lands in the chat ("Phone message from …") with a
  notification.

## Calls out

- From an **errand's call step** (docs/ERRANDS.md) or **"call X"** in chat (tool `phone_call`, lean
  family `calls`, off in private chats and private local mode, owner only).
- Each call asks first on its own card, always (`asksFirst`, never "always allow"): the number, what
  she will say, the longest it may last, the cost estimate and whether it is recorded.
- One call at a time. The length is capped on both sides (her timer and the provider's TimeLimit).
- **Recording** only with the setting on, and only after she says "this call is recorded"; the
  provider is asked to record once that line has played.
- **"Stop"** (or "hang up", "goodbye"; six languages) on the line hangs up. The page can hang up too.
- The transcript and a short summary go to the errand (the step is done with the provider's call id
  as evidence; no answer asks again) or to the chat where the call was asked for.

## Audio

The Media Stream carries 8 kHz G.711 μ-law in 20 ms frames. Sara converts it to 16 kHz WAV for her
hearing and her voice back to μ-law (src/phone-audio.ts). Speech turns are found by loudness (0.7 s of
quiet ends a turn); talking over her clears what she was still saying. She hangs up after about 15 s
of silence.

## Other providers (SIP, WebRTC)

`src/telephony.ts` is the adapter interface: verify a webhook, answer with a media stream, reject,
place, hang up, record, and the stream's messages. A SIP trunk or WebRTC gateway (a PBX, a SIP
provider's media API) would be a second implementation of the same interface; it is not built in,
and choosing "SIP or WebRTC" says so.

## Discord voice (Settings → Chat apps → Discord → Voice channel)

Joining a channel is one gateway message (op 4, Voice State Update) on the existing bridge
connection, but the audio needs Discord's voice transport (a second WebSocket, UDP, encryption and
the Opus codec). Sara ships without dependencies and has no Discord or Opus library, so only the
interface (`src/discord-voice.ts`) is built: pick the server and channel now; the switch stays off
and Join explains why.

## Car mode errands

- Say "start an errand: get my Acme refund" in car mode: her `errand_start` card is answered by
  saying "approve" (or "no"). Spoken approvals follow the phone rule (`phoneMayApprove`): computer
  use and cards with a choice to make wait for the computer ("That one needs you at the computer").
- "How are my errands going?": she knows each open errand's state in one spoken line ("your refund
  is waiting on Acme Store").

## Not verified yet

No real provider account, number or phone network was used: everything was tested with a fake
provider (real signatures and TwiML, simulated webhooks, a fake Media Stream sending PCM frames as
μ-law). Real-world turn-taking on a noisy line, the provider's recording behavior and price per
minute need a live test when the owner sets it up.
