# WhatsApp (2.55.0)

Text her on WhatsApp. Sara uses Meta's **official** WhatsApp Business service (the Cloud API) with a
Meta account and a phone number **you** own. There is no Sara account, relay or hub in between:
Meta calls your Sara directly, and Sara calls Meta directly. The design is
[design/WHATSAPP.md](design/WHATSAPP.md).

WhatsApp comes with Sara as a plugin and stays **off until you add it**. Unofficial WhatsApp Web
clients are refused: Meta bans the numbers they use.

## Before you start: Meta's rules

Since January 2026, Meta's WhatsApp Business terms forbid offering a general-purpose AI assistant on
WhatsApp as a product. Sara is your own companion on your own account, but Meta decides how its
terms apply and can restrict an account or a number. So the setup card asks you to tick
*I understand and want to go ahead* first. Use a number you can afford to lose, keep her to yourself
and people you choose, and read the
[WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms).

## What you need

- A Facebook account (a personal one is fine).
- Your phone with WhatsApp.
- About 30 minutes at a computer (Meta's console is hard to use on a phone).
- A public https address for Sara. Step 7 helps: Tailscale Funnel, or your own tunnel or domain.

Start with **Meta's free test number**. It can only write to up to 5 numbers you list, which is all
you need.

## The ten steps

Settings → Connections → **WhatsApp**. Each step turns ✓ when Sara has checked it; the right column
shows the Meta screen you need and *This screen looks different?* if Meta has moved things.

1. **Add WhatsApp to Sara**: read its card, press Install, turn it on for her.
2. **Make a Meta app**: developers.facebook.com/apps → Create app → *Connect with customers through
   WhatsApp* → pick or create a business portfolio → Create app.
3. **Copy two numbers**: API Setup → the *Phone number ID* and the *WhatsApp Business Account ID*.
4. **Let your phone talk to the test number**: API Setup → To → Manage phone number list → add your
   number and the code WhatsApp sends you.
5. **Make a key that doesn't expire**: Business settings → System users → Add (sara, Admin) → Assign
   assets (the app and the WhatsApp account, Full control) → Generate token → expiry *Never* →
   `whatsapp_business_messaging` and `whatsapp_business_management`. The key goes into Sara's vault
   and is never shown again.
6. **Copy the app's secret**: App settings → Basic → App secret. Sara uses it to check that every
   message really comes from Meta (`X-Hub-Signature-256`). It stays in the vault; the WhatsApp
   plugin never sees it.
7. **Give Meta a way in**: *Open the public door* runs `tailscale funnel --bg --https=8443
   --set-path=/hook …`. **Only `/hook/` is public**; the app itself stays on your tailnet. (A second
   Sara on the same computer uses port 10000.) Or paste your own tunnel or domain address.
8. **Connect Meta to Sara**: paste the *Callback URL* and *Verify token* into your app's Webhook
   settings → Verify and save → subscribe to **messages**. Sara answers Meta's handshake and shows
   *Meta reached Sara at …*. *Fix it* subscribes the app if Meta isn't sending.
9. **Say hello**: press *Link my WhatsApp* and send `/link 123456` (the code it shows, valid 10
   minutes) to her number. That is how she knows which chat is you.
10. **Test**: checks the key, the number, Meta reaching Sara and the link, and says what to fix. It
    sends nothing to anyone.

When something is wrong, the step turns red with one line saying what to fix (an expired key, the
two IDs swapped, a missing permission, Meta knocking with another verify token, a bad signature, the
app not subscribed, the test number's list, a closed door, and more), plus *Details*.

## The 24-hour window

Chats **you** start are free. Meta only lets her write first within **24 hours of your last
message**. Outside that window, her reminders and other first messages stay in the app; write to her
on WhatsApp to reopen it. The page says how long the window has left. Sara keeps no paid template
"nudge" unless you turn it on (it is off).

## How it behaves

- **Text, pictures and files** both ways (a 25 MB cap). Voice notes she hears through speech-to-text
  (Settings → Voice); she answers in text.
- **While she works**: WhatsApp can't edit messages, so she shows *typing…*, and a long job gets one
  *Working on it* line with a ⏹ Stop button, then her answer.
- **Who can reach her**: only you. Other people only if you tick *Let other people talk to her* and
  list their numbers (`+1 555 …`); they talk to her as partners: no tools, nothing private, the AI
  notice first. Anyone else gets one short notice and is then ignored. An empty list means nobody.
- **No groups, no calls, no voice replies.**
- **A changed identity** (a new phone, or someone else using your number) pauses her tools in
  WhatsApp until you press *It's me* on the page.
- **Pacing**: she stays well inside Meta's limits (a few messages a second, hourly and daily caps)
  and backs off when Meta says to.
- **Nothing leaves this computer** pauses WhatsApp; Meta keeps your messages up to 7 days.

## Privacy

WhatsApp chats pass through Meta's servers, unlike Signal's end-to-end path. Sara stores your chats
in her own database like any other chat app.

## For coders

`plugins/whatsapp/` (`main.mjs`, `http1.mjs` HTTP/1.1 over the socket broker, `webhook.mjs`,
`format.mjs`, `pace.mjs`, `diagnose.mjs`); the `meta` verify kind in `src/webhook-verify.ts`; the
`bridge` delivery mode in `src/webhooks.ts`; the reply window in `src/plugins/bridge-db.ts`
(`bridge_windows`); the setup routes in `src/plugins/whatsapp-setup.ts`; the page in
`web/whatsapp.js`. Tests: `test/phase122.test.ts` with the stand-in Graph API and fake Meta sender
in `test/whatsapp-fake.ts` (also runnable on its own: `node test/whatsapp-fake.ts --graph 7891
--media 7892 --control 7893 --dir <folder>`).
