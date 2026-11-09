# Sara and Home Assistant

Sara and Home Assistant work both ways. Each direction is set up on its own; you can use either
or both.

## 1. Sara controls your home

Sara reads the state of your home and, with your OK, changes things (lights, switches, locks,
covers, climate, scenes, scripts).

1. In Home Assistant: your profile → **Security → Long-lived access tokens → Create token**.
2. In Sara: **Settings → Add-ons → Home Assistant**. Enter your Home Assistant address (for
   example `http://homeassistant.local:8123` or your Nabu Casa address) and the token.

The token is kept in Sara's encrypted vault. Reading states runs on its own; anything that changes
something asks you first, every time. Names in Home Assistant are treated as information only,
never as instructions to her. See [PRIVACY.md](PRIVACY.md) for what this sends.

## 2. Home Assistant talks to Sara

The **Sara integration for Home Assistant** (in [`integrations/home-assistant/`](../integrations/home-assistant/README.md),
installable with HACS) makes Sara:

- a **conversation agent** for Assist and voice satellites (Settings → Voice assistants);
- an action, **`sara.send_message`**, that asks her something from an automation and returns her
  reply;
- **`notify.sara_note`**, for notes she answers in her own time;
- a **last reply** sensor (its state is when she last answered; her words are in its `text`
  attribute, which Home Assistant doesn't keep in its history).

It signs in like the terminal client and the VS Code extension ([clients.md](clients.md)): Home
Assistant shows a code, you approve it in Sara under **Settings → Connections → Devices and
sign-in** (or on the `/device` page), confirming with your owner token, two-step code or passkey.
Home Assistant then has its own device token, listed as "Home Assistant"; sign it out there to end
it. That token only reaches Home Assistant's own conversations (titled "Home Assistant" in Sara):
not your other chats, settings or memory pages. Like other apps, Home Assistant conversations
don't bring up things from your private chats, and her tools stay off there unless you allow
other apps to use them (Settings → Connections → Other apps). `sara.send_message` only works in
conversations the integration started.

Her safety layer runs on the Sara server and is the same as in her own apps: the AI disclosure
is shown (and must be accepted once during setup), crisis resources still appear, and replies her
safety checks replace arrive replaced. When she asks for an approval during a Home Assistant
conversation, Home Assistant can't answer for you: it declines and her reply says what she wanted
to do, so you can ask again in the Sara app.

Install and options: [integrations/home-assistant/README.md](../integrations/home-assistant/README.md).

**Voice rooms (2.1):** a Home Assistant voice satellite or speaker is a shared room, like a group
channel: Sara keeps Home Assistant conversations non-explicit whatever Adult mode says, keeps your
private matters out unless you bring them up there, and answers in a few spoken sentences. From
integration 0.3.0 the words Home Assistant speaks have markdown, link addresses and emoji left out
(the conversation in Sara keeps her full reply).

## 3. Assist voice satellites and Google Home / Nest speakers

**Listening** goes through Home Assistant's Assist: Home Assistant → **Settings → Voice
assistants** → your assistant (or **Add assistant**) → **Conversation agent: Sara**. Then a Home
Assistant Voice Preview Edition, an ESPHome satellite, the Home Assistant phone or watch app, or a
wall tablet with Assist sends what you say to Sara and speaks her reply with that assistant's
text-to-speech.

**Google Home and Nest speakers** can't listen for Sara (Google closed its voice apps for third
parties in 2023, and "Hey Google" always goes to Google). They can **speak** for her: Home
Assistant's **Google Cast** integration finds them as `media_player` entities, and any
text-to-speech in Home Assistant can play on them. Two ways to use that:

- **Presence** (below): her greetings announced on a Nest speaker.
- **An automation or script**, for example a morning summary on the kitchen speaker
  (`sara.send_message` returns `reply`, and from 0.3.0 `spoken`, the same words ready for a speaker):

  ```yaml
  sequence:
    - action: sara.send_message
      data:
        text: "Give me a two-sentence summary of my day."
      response_variable: sara
    - action: tts.speak
      target:
        entity_id: tts.google_translate_en_com
      data:
        media_player_entity_id: media_player.kitchen_nest
        message: "{{ sara.spoken }}"
  ```

Her safety layer runs before any of it: the AI notice when due, crisis resources, the minors
block. A speaker reads exactly the reply the conversation in Sara shows.

## 4. Presence: she notices what happens at home

With direction 1 connected, **Settings → Add-ons → Home Assistant → Presence** (per companion,
off until you switch it on) lets her react when someone gets home or leaves (`person.…` or
`device_tracker.…`), at bedtime (a switch or `input_boolean` turning on, or a time while someone is
home) or when a light goes on in the morning. She says one short line of her own as a message on
your devices, an announcement on a Home Assistant speaker (`tts.speak` on a `media_player`, for
example a Nest), or both; announcements start with the AI notice every 3 hours. Each kind at most
once every few hours (3 by default), never in the quiet hours of *Calls from her*. Sara polls only
the chosen entities once a minute. Members of a household have no Home Assistant in 2.0, so presence
is the owner's. More: [VOICE_ASSISTANTS.md](VOICE_ASSISTANTS.md).

## Both at once

With both set up, you can say to a voice satellite "Sara, is the garage door open?" and she reads
it through direction 1. Changes she'd make that way need an approval, which Home Assistant
declines (see above): approve changes in the Sara app, or let Home Assistant's own assistant
handle device commands and use Sara for conversation.

## Switches on Today (2.7.1)

The Today page's Home tile shows your favourite devices (picked on that device). Lights, switches, fans,
`input_boolean`s and blinds / shades / shutters / curtains / awnings get an on/off switch: that's you
acting directly, so there is no approval card. Locks, alarms, climate, media players, garage doors, gates,
doors, windows and anything whose name sounds like one (garage, gate, door, lock, alarm, siren, security,
safe, vault) only show their state with *Ask Sara*, so her approval rules apply. Owner only; not on the
demo. API: `POST /api/home/entities/<entity_id>/toggle` → `{ id, name, state, was }`.
