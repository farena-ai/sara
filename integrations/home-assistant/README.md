# Sara for Home Assistant

Talk to your own [Sara](https://github.com/farena-ai/sara), the self-hosted AI companion, from
Home Assistant: as a voice and Assist conversation agent, from automations, and with notes she
answers in her own time.

> Sara is an AI, not a person. Her safety layer (the AI disclosure, crisis resources, the hard
> blocks) runs on your Sara server and applies here exactly as in her own apps.

<!-- Screenshots: config flow with the sign-in code · Assist talking to Sara · the Sara device page -->

## What you get

| | |
|---|---|
| **Conversation agent** | Choose Sara in **Settings → Voice assistants** for Assist or a voice satellite. Each Assist conversation goes into its own "Home Assistant" conversation in Sara (or one shared conversation, in the options). |
| **`sara.send_message`** | Ask her something from an automation or script; her reply comes back as the action's response (`reply`, `spoken`, `conversation_id`; `spoken` is the reply without markdown or emoji, ready for a speaker, since 0.3.0). A `conversation_id` you pass must be one this integration made (one it returned before); leave it out to use her "Home Assistant" conversation. |
| **`notify.sara_note`** | Send her a note ("the front door opened"). She answers in her own time, in her "Home Assistant" conversation, like her other messages (and as a notification on your phone, if that's on). |
| **Last reply sensor** | `sensor.sara_last_reply`: when she last replied through Home Assistant; her words are in the `text` attribute, which Home Assistant's history (recorder) leaves out. |

Approvals: when she wants to run a command or change a device and asks for your OK, Home
Assistant can't answer for you. It declines, and her reply says what she wanted to do, so you can
ask her again in the Sara app.

## Install

Needs Home Assistant 2025.6 or newer and a Sara server Home Assistant can reach.

### With HACS

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/farena-ai/sara-home-assistant`, type
   **Integration**.
2. Find **Sara** in HACS, **Download**, then restart Home Assistant.

### By hand

Copy `custom_components/sara` into the `custom_components` folder of your Home Assistant
configuration (next to `configuration.yaml`) and restart Home Assistant.

## Set up

1. **Settings → Devices & services → Add integration → Sara.**
2. Enter your Sara address as you open it in a browser (for example `http://192.168.1.20:7860`
   or `https://sara.example.com`).
3. Home Assistant shows a code like `K7QM-3XTP`. In Sara, open **Settings → Connections →
   Devices and sign-in** (or the `/device` page), type the code, confirm it's you (owner token,
   two-step code or passkey) and press **Approve**. Home Assistant continues by itself.
4. The first time, Sara's AI disclosure is shown: accept it to continue.

Home Assistant gets its own device token (`sara_dev.…`, Sara keeps only a hash) with limited
access: it can only talk with her in the conversations Home Assistant made itself. It can't read
your other conversations, her memories, files or settings, sign in other apps or change anything.
Her tools stay off in Home Assistant turns unless you allow other apps to use them (Sara →
Settings → Connections → Other apps), and those turns leave out what she knows from private
conversations. It's listed in Sara under **Devices and sign-in** as "Home Assistant"; signing it
out there ends it, and Home Assistant then asks you to sign in again. Removing the integration
signs it out of Sara. Set up with an older version? Home Assistant asks you to sign in once more
to switch to the limited access.

Addresses on your own network (`192.168.…`, `10.…`, `172.16–31.…`, `….local`, `localhost`) default
to `http://`; anything else defaults to `https://`, so the token never crosses the internet in
the clear.

### Options

- **Companion**: which companion answers, when your Sara server has more than one.
- **Tell her where you're talking from**: adds the voice device and its area to what you say
  ("[Said to Home Assistant (Kitchen speaker in the Kitchen)] …"). Off by default.
- **One conversation for everything**: all of Home Assistant in one "Home Assistant" conversation
  in Sara instead of one per Assist conversation.

## Examples

```yaml
# Ask her something and speak the answer
- action: sara.send_message
  data:
    text: "Anything I should remember before I leave?"
  response_variable: sara
- action: tts.speak
  target:
    entity_id: tts.home_assistant_cloud
  data:
    media_player_entity_id: media_player.hallway
    message: "{{ sara.spoken }}"

# Tell her something happened
- action: notify.send_message
  target:
    entity_id: notify.sara_note
  data:
    title: Front door
    message: "The front door opened at {{ now().strftime('%H:%M') }}."
```

Google Home and Nest speakers: Google ended custom voice apps for them, so talk to her through an
Assist voice satellite and let her answer on a Nest speaker with Google Cast and `tts.speak` (as
above). Assist answers are spoken without markdown or emoji since 0.3.0. More:
[docs/VOICE_ASSISTANTS.md](https://github.com/farena-ai/sara/blob/main/docs/VOICE_ASSISTANTS.md).

## The other direction

Sara can also read and control your home (with your OK for anything that changes something):
**Settings → Abilities → Home Assistant** in Sara, with a long-lived access token. See
[docs/HOME_ASSISTANT.md](https://github.com/farena-ai/sara/blob/main/docs/HOME_ASSISTANT.md).

## Privacy

Home Assistant sends Sara what you say to her (and, if you turn it on, the device and area you
said it from). Nothing goes anywhere else: Sara's own settings decide which model answers.
Diagnostics downloads never include the device token.

## Development

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv -r requirements_test.txt
.venv/bin/python -m pytest          # tests/ with a fake Sara server (Linux or macOS: Home Assistant needs fcntl)
# if tests/test_init.py can't import hassil.fuzzy: install the hassil and home-assistant-intents
# versions pinned in .venv/lib/python3.13/site-packages/homeassistant/package_constraints.txt
# against a real throwaway Sara:
SARA_LIVE_URL=http://127.0.0.1:7880 SARA_LIVE_OWNER_TOKEN=... .venv/bin/python -m pytest tests/test_live_sara.py -s
```

Brand images ship with the integration in `custom_components/sara/brand/` (`icon.png` 256×256,
`icon@2x.png` 512×512): Home Assistant 2026.3 and newer shows them from there, and HACS checks for
them. The top-level `brand/` folder has the same two files for the older
[home-assistant/brands](https://github.com/home-assistant/brands) route (`custom_integrations/sara/`),
which that repository now calls legacy.

## License

MIT, see [LICENSE](LICENSE).
