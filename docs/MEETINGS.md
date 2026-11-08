# Meetings and meeting notes

Sara can listen to a meeting and write the notes: a **summary**, the **decisions** and the **action
items** with who does them and by when. The notes are kept in her Library, and each action item can
become a to-do in your Planner when you press *Add*. Two ways in, both in the Library window under
**Meetings…** (owner only):

- **A meeting room** in Sara, for people in the same room (or on another call with a Sara device on
  speaker).
- **Notes from a recording**: a recorded call or meeting, for example a Discord voice call you
  recorded, or a memo from your phone.

Joining a Discord voice channel herself is not built yet; see [Discord voice](#discord-voice) below.

## Consent first

- **Only you start a meeting.** Household members, the demo and shared links can't.
- Starting a room needs the tick *Everyone in the room knows Sara will listen and take notes*. When it
  starts, the screen shows and Sara says out loud: *"Hi everyone, I'm Sara, an AI. I'm listening and
  taking notes for this meeting."* That notice is also the first line of the transcript.
- Another of your signed-in devices (a phone on the table, a tablet) can open the same meeting. It
  shows the same notice, and its microphone opens only after **I understand, start my microphone**.
  Everyone sees "*Phone joined. Sara is listening and taking notes.*" in the transcript.
- A recording needs the tick *Everyone in this recording knew it was recorded and agreed to notes*.
  Only give her recordings of people who agreed.
- **End and write the notes** stops every microphone; the transcript says she stopped listening.

## In the room

Each device listens hands-free like a call (it notices when someone starts and stops talking). What
was said goes to your Sara server, is turned into text with your hearing engine (*Settings → Voice →
Speech to text*) and shows up as a line, named by the device. If someone calls her by name ("Sara,
what did we decide about the place?"), she answers in a sentence or two from what was said, and that
device speaks it. She answers one thing at a time, at most 20 times in a meeting, and she doesn't use
tools or do things during a meeting: tasks go into the notes.

The safety rules of the chat apply: a line about sexual content involving minors is left out of the
transcript ("Left out by the safety check") and never answered.

## Notes from a recording

**Choose File**, give it a name and tick the consent box. WAV recordings can be up to 100 MB and 3
hours; Sara cuts them into one-minute pieces to hear them. MP3, OGG/Opus, M4A and WebM can be up to
25 MB and need a hearing engine that reads them (Grok voice or a speech API). She hears the whole
recording, then writes the notes. Lines are named *Recording* (she doesn't tell voices apart).

## The notes

One model call (the model picked for writing in *Settings → Models → Which model does what*) writes the
summary, decisions and action items from the transcript, only from what was said: an owner or date
nobody named is shown as *Not said*. The notes are a document in her Library, *Meeting notes - <name> -
<date>.md*, and stay there even when the meeting is deleted. **Write the notes again** asks again (for
example after changing the model).

**Add to Planner** (or **Add all to Planner**) makes a to-do for an action item, with its date when one
was said ("Friday" is the Friday after the meeting, at 17:00). Nothing goes to the Planner until you
press it, and each item is added once.

## What is kept, and where

| What | Kept |
|---|---|
| The sound | **Not kept**: heard and dropped. Tick *Keep the recording* to keep it with the meeting until you delete it (*Download the recording*). |
| The transcript | In her own database on your server, with the meeting, until you delete the meeting. Never sent to chat apps. |
| The notes | A document in her Library. |
| Audit rows | `meeting.start`, `meeting.join`, `meeting.file`, `meeting.end`, `meeting.notes`, `meeting.todos`, `meeting.recording` (a download), `meeting.delete`; ids only, never the words. |

**Delete this meeting** removes the transcript and the recording (not the Library notes). Under a legal
hold it is refused. Sara keeps the last 50 finished meetings and forgets older ones.

**Private local mode** (*Nothing leaves this computer*): meetings work only with the hearing engine on
this computer and a model on this computer; otherwise *Meetings…* says why it can't start.

**Turning it off:** an admin can pin *Turn off meetings* in the policy (*Settings → Household →
Policy*, JSON `"meetings": false`). New rooms, joins, sound and recordings are then refused by the
server; notes already written stay readable. See [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md).

## Discord voice

Sara does not join Discord voice channels yet. Since March 2026 Discord requires every voice
connection, bots included, to use its end-to-end encryption (DAVE, built on MLS) on top of its voice
gateway, UDP transport encryption and Opus audio. Doing that well means either a large amount of
cryptography code in Sara or native add-on libraries that would have to be built for every platform
Sara runs on. Until that is decided, record the call (Discord's own clients, OBS or a recording bot
you trust) with everyone's agreement and use **Notes from a recording**. Sara's Discord chat bridge
(text, voice notes, files) is not affected.

## For developers

- Server: `src/meetings.ts` (`Meetings`, tables `meetings` and `meeting_lines`; `splitWav`,
  `addressed`, `parseNotes`), routes `src/routes/meetings.ts` (`/api/meetings…`), policy pin
  `meetings` in `src/policy-profile.ts`.
- Web: `web/meetings.js`, `web/meetings.css` (reuses `Mic`, `Call`, `Speaker` from `web/voice.js`).
- Tests: `test/ec19-meetings.test.ts`, `test/ec19-routes.test.ts`, `test/ec19-ui.test.ts` (WAV clips made
  in `test/fixtures/ec19-audio.ts`, a fake hearing engine and a scripted model).
- Design: [ops/EC19_DESIGN.md](ops/EC19_DESIGN.md).
