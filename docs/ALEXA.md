# Talk to her through Alexa

Sara can answer on an Amazon Echo (or any Alexa device or the Alexa app) through **your own Alexa
skill**. You make the skill once in Amazon's free developer console and leave it in
**Development** mode: then only the Amazon account that made it (and the people in that Amazon
household, if you share it) can use it. Nothing is published and Amazon doesn't review it.

Sara answers it herself, with her own memory and character. There is no Amazon or third-party
software in Sara for this: her server checks every request's signature by Amazon's published rules
before it reads a word.

> Needs: a Sara server reachable from the internet over **HTTPS with a certificate from a trusted
> authority** (your own domain behind a reverse proxy, Tailscale Funnel, or Cloudflare Tunnel). Amazon
> won't call a plain `http://` address, a self-signed certificate or a private Tailscale-only
> address. Not on the demo server, and paused while **Nothing leaves this computer** (private
> local mode) is on, because Alexa runs at Amazon.

## 1. Make the skill (once, about 15 minutes)

1. Open **https://developer.amazon.com/alexa/console/ask** and sign in with the Amazon account
   your Echo uses (a developer account is free; accept the terms the first time).
2. Press **Create Skill**.
   - **Skill name:** anything, for example *Sara* (only you see it).
   - **Primary locale:** **English (US)** (the interaction model Sara gives you is English; see
     "Other languages" below).
   - Type of experience: **Other** → model **Custom** → hosting **Provision your own**.
   - Template: **Start from Scratch**. Press **Create Skill** (top right) and wait for it.
3. In Sara: **Settings → Connections → Apps and services → Other apps → Talk to her through Alexa** → **Download the
   interaction model** (`sara-alexa-model.json`; the same file is in this repository as
   `integrations/alexa/interaction-model.en-US.json`).
4. Back in the console, left side: **Build → Interaction Model → JSON Editor**. Select all the text
   there, delete it, paste the whole downloaded file (or drag the file onto the editor), press **Save**,
   then **Build skill** (top). Building takes a minute.
   - The invocation name in the file is **sara companion** (Alexa wants two words or more). To use
     another one, change it under **Invocation → Skill Invocation Name** (lower case, two words or
     more, for example *juno at home*) and build again, or download the model with
     `/api/alexa/model?invocation=juno%20at%20home`.
5. Left side: **Endpoint**. Choose **HTTPS**. In **Default Region** type her address with `/alexa`
   at the end, for example `https://sara.example.com/alexa` (Sara shows it on the same settings page
   with a **Copy** button). Below it choose **My development endpoint has a certificate from a
   trusted certificate authority**. Press **Save** (top).
6. Still in the console, go back to **Your skills** (top left link "Alexa Skills Console"), find the
   skill and press **View Skill ID** under its name. Copy the id (`amzn1.ask.skill.…`).
7. In Sara, paste it into **Skill ID** (it saves when you leave the box). Requests for any other
   skill id are refused, so someone else's skill pointed at your address gets nothing.
8. Console: **Test** tab → switch **Skill testing is enabled in** from *Off* to **Development**.
   The skill now works on every Echo signed in to that Amazon account.

## 2. Link your Alexa to her (each person, once)

1. In Sara: **Settings → Connections → Apps and services → Other apps → Talk to her through Alexa → Make a link code**.
   You get six digits that work **once, for 10 minutes** (only a hash is kept on the server).
2. Say: **"Alexa, ask sara companion to link code 1 2 3 4 5 6"** (your digits). Or open the skill
   ("Alexa, open sara companion") and say "link code" and the digits.
3. She answers "Linked", says she is an AI companion, and you're talking with her.

The link connects that **Amazon account** (Alexa's user id, kept only as a hash) to **one person and
one companion**: whoever made the code, and the companion that was open when they made it. In a
household (docs/HOUSEHOLD.md) every member makes their own code from their own Sara; their Alexa
then reaches only their own space and companion, never the owner's. Linked Alexas are listed on the
same page (when linked, when last used) with **Unlink**. A removed or paused member's Alexa answers
nothing. Wrong codes are counted: after 5 wrong tries from one Alexa account (or 30 from anywhere)
in 10 minutes, linking pauses.

Note: Alexa gives a skill one user id per *Amazon account*, not per voice. Two people sharing one
Amazon account on one Echo reach the same linked person. Use separate Amazon accounts (Amazon
Household profiles count) to keep them apart.

## 3. Talking

- "Alexa, open sara companion" → "Sara here, your AI companion. What would you like to say?"
- Then just talk. Start with **"tell her"** when Alexa might think you mean something else
  ("tell her I'm home"). Questions and sentences that start with *what, how, why, who, where, when,
  can you, do you, are you, I, I'm, my, let's, please, remind me, good…* work as they are.
- "Alexa, ask sara companion what should I cook tonight" works in one go.
- The session stays open for a follow-up; say **stop** (or nothing) to end it. **Help** explains.

She keeps a conversation of her own called **Alexa** (one per linked Alexa) that you can read and
continue in the app.

### What always applies

- **AI notice:** spoken at the start of every Alexa session and at least every 3 hours ("Sara here,
  your AI companion"), and the full notice when her own 3-hour rule is due, like in the app. If you
  sincerely ask whether she's a person, she says plainly that she's an AI.
- **Crisis help** is spoken when someone may be in crisis (988 is US-only; she also gives
  findahelpline.com), and the **block on anything sexual involving minors** holds.
- **A speaker in a room is a shared place:** she keeps it non-explicit **whatever Adult mode says**,
  keeps your private matters out unless you bring them up there, and answers in a few spoken
  sentences (no lists, links or emoji).
- **Your private, imported and group chats never reach her Alexa turns** (the same rule as other
  apps: docs/OTHER_APPS.md). Her tools are off there unless you allow other apps to use them; an
  action that needs your OK waits in the Sara app.

### Time

Alexa gives a skill about 8 seconds. After 1.5 seconds she has Alexa say **"One moment"** (Amazon's
progressive response). If her answer still isn't ready after 6 seconds, she says **"I need a little
more time for that. Ask me again in a moment"** and keeps working; ask again ("what did you find?")
and she gives the kept answer. To answer inside the time more often, tick **Answer Alexa with the
quick model** (it uses the *Quick replies* model from Settings → Models & usage → Which model does what) or
use a fast model for her.

## How Sara checks a request (for the curious)

Every `POST /alexa` is checked before anything is read, following Amazon's "verify the request was
sent by Alexa" rules:

1. `SignatureCertChainUrl` must be `https://s3.amazonaws.com[:443]/echo.api/…` (compared after
   normalising, so `/echo.api/../` tricks fail).
2. The certificate chain is downloaded (cached until it expires), every certificate on the path must
   be inside its dates, the first must name **echo-api.amazon.com** in its subject alternative names,
   each must be signed by the next, and the path must end at a root certificate **Node itself
   trusts** (Node's built-in Mozilla list, `tls.rootCertificates`; Sara ships no certificates of her
   own). Tested with Amazon's real published chain: it chains to *Amazon Root CA 1*.
3. The `Signature-256` header must be a valid RSA SHA-256 signature of the exact request body by that
   certificate.
4. The request's timestamp must be within 150 seconds.
5. The skill id must be the one you pasted.

A request that fails any of these gets HTTP 400 and runs nothing. The tests sign requests with a
certificate authority they make themselves; that test root is passed to the code only inside the
tests and there is no setting to turn checking off.

## Other languages

Sara's downloadable model is English (US) and also works for the other English locales (add the
locale in the console → **Language settings**, paste the same model). For Spanish, French, German,
Italian or Portuguese (Brazil): add that locale, paste the model and translate the sample phrases
(keep the intent and slot names). She answers in the language you speak to her in.

## When it doesn't work

- **"There was a problem with the requested skill's response":** Sara refused the request. Her log
  says why (`Alexa: refused a request (…)`): usually a different skill id (paste it again) or
  private local mode.
- **Alexa says the skill isn't available / no answer at all:** the endpoint must be the public
  `https://…/alexa` address with a trusted certificate. Test it from the console's **Test** tab.
- **"This Alexa isn't linked":** make a code in Sara and say "link code …" within 10 minutes.
- **She takes too long:** see Time above.
