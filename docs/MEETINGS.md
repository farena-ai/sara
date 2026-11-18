# Meetings and meeting notes

Sara can listen to a meeting and write the notes: a **summary**, the **decisions**, the **action
items** with who does them and by when, and the **open questions**. The notes are kept in her
Library, each action item can become a to-do in your Planner when you press *Add*, and when the
meeting matches an event in your calendar she drafts a **follow-up email** for each group of
attendees that waits for you to press *Send*. Three ways in, all in the Library window under
**Meetings…** (owner only; also `#view=meetings` and the Today tile):

- **Record this computer** (the Windows and Mac apps): your microphone and the computer's sound, so a Zoom,
  Teams or Meet call on this computer is captured without a bot joining it.
- **A meeting room** in Sara, for people in the same room (or on another call with a Sara device on
  speaker).
- **Notes from a recording**: a recorded call or meeting (WAV, MP3, M4A, MP4, WebM, OGG), for example
  a Discord voice call you recorded, or a memo from your phone.

**Why no meeting bot:** joining Zoom, Teams or Meet as a participant needs each company's registered
bot programme (Zoom Meeting SDK app review, a Microsoft Teams bot registered in Azure with media
permissions, Google Meet's Media API in limited preview), often paid, per-server sign-ups that
Sara's owners would each have to make. Recording on your own computer captures the same call with
nothing to register, and the people on the call hear about it from you.

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

## Record this computer (Windows and Mac apps)

In the Windows app, **Meetings… → Record this computer** records the default microphone (left
channel) and everything the computer plays (right channel, Windows WASAPI loopback) as a 16 kHz
stereo WAV in the app's data folder. Tick *Everyone on the call knows it is recorded and agreed*
first. With **Settings → Voice → Meetings → Remind me to tell everyone** on (the default) the card
shows the line to say (*"I'm recording this call so my assistant can take notes. Is that OK?"*) and
Sara says it out loud when the recording starts; say it on the call yourself, since your microphone
is what the others hear. **Stop and write the notes** hands the file to the page, which sends it to
your Sara server in parts and asks the app to delete its copy (leftovers are deleted after a week).
**On a Mac** (U2.7) it is the same card: the microphone (left) and the Mac's own sound through
ScreenCaptureKit (right; the Sara app's own sound is left out) in `~/Library/Application Support/<app>/meetings`.
macOS asks once for the microphone and once for **Screen & System Audio Recording** (System Settings → Privacy
& Security). Without that second permission only your microphone is recorded and the card says how to allow
it. Phones don't record this way; use a recording or a room there.

## Who said what

Lines are named **Speaker 1**, **Speaker 2**… and carry their time in the recording.

- A recording from the Windows or Mac app is split **by channel**: you (the microphone) are Speaker 1,
  everyone on the call (the computer's sound) is Speaker 2. Crosstalk goes to the louder side.
- Any other recording (an upload, one microphone) is split **by voice** when *Better speaker
  separation* is on (Settings → Voice → Meetings, on by default): a free add-on (about 40 MB, downloaded
  the first time a meeting needs it) makes a voice print of every second and a half of speech on this
  computer, and Sara groups the prints into up to **8 speakers**. A new voice in a later part of a long
  upload gets the next number; a voice already heard keeps its number. A change of speaker without a
  pause is caught too.
- When two people sound very alike they may be kept as one speaker: a line in the transcript says so,
  and you rename the speaker if you know who it was. More than 8 voices: the extra ones join the most
  alike speaker (also said in the transcript).
- Without the add-on (switched off, still downloading, not available on the system, *Nothing leaves
  this computer* on before it was downloaded, or it stopped) the recording is split **by pauses**: turns
  are cut at pauses and grouped into at most two voices by their pitch. Two similar voices stay
  Speaker 1. *Download now* and *Remove* are next to the switch. Details: [design](design/U3SPEAK.md).
- **Rename** a speaker (*Dana*) and every line follows, and so does an action item owned by that
  label.
- **Search the transcript** filters the lines; when the recording is kept, press a line's time to
  play it from there.

## Hearing: on this computer first

Meetings are heard with the hearing engine on your Sara server whenever it's installed, even if chat
uses a cloud speech service. A cloud engine (your Speech API or Grok voice) hears meetings only when
**Settings → Voice → Meetings → Let a cloud engine hear meetings** is on; otherwise *Meetings…* says
why it can't start. Private local mode still allows only the engine on this computer. Long
recordings are cut into parts of about ten minutes in your browser (MP3, M4A, MP4 and WebM are
turned into WAV there first), so up to 3 hours works with any engine.

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

**Choose File**, give it a name and tick the consent box. Recordings can be up to 3 hours in WAV,
MP3, M4A, MP4, WebM or OGG; your browser sends them in parts of about ten minutes, and she hears
each turn and names the speakers (see *Who said what*). She hears the whole recording, then writes
the notes. The file's time tells her when the meeting was, for the calendar match.

## The notes

One model call (the model picked for writing in *Settings → Models & usage → Which model does what*) writes the
summary, decisions and action items from the transcript, only from what was said: an owner or date
nobody named is shown as *Not said*. The notes are a document in her Library, *Meeting notes - <name> -
<date>.md*, and stay there even when the meeting is deleted. **Write the notes again** asks again (for
example after changing the model).

**The calendar event:** when the recording's time (the Windows app's start, a file's time, a room's
start and end) overlaps an event in any of your calendars, the notes show it and its attendees.
Calendars are not read in private local mode.

**Follow-up emails:** for a matched event with attendees other than you, she writes one email per
group (people of one organisation together, free-mail addresses each on their own; up to 4 groups).
Each waits on the meeting page with its To, Subject and Message to edit, and **Send**, **Save as a
draft** (into your mailbox's drafts) or **Dismiss**. Nothing is sent until you press Send; in
private local mode Send and Save are refused. They are counted on the Today tile until handled.

**Today:** the *Meetings* tile lists action items due within a week that aren't in the Planner yet,
and how many follow-up emails wait.

**Ask her:** *meeting_list* and *meeting_summarize* (read only) let her answer "what did we decide
in the launch sync?" or "what do I owe after yesterday's call?" in chat.

**Add to Planner** (or **Add all to Planner**) makes a to-do for an action item, with its date when one
was said ("Friday" is the Friday after the meeting, at 17:00). Nothing goes to the Planner until you
press it, and each item is added once.

## What is kept, and where

| What | Kept |
|---|---|
| The sound | **Not kept**: heard and dropped. Tick *Keep the recording* to keep it with the meeting until you delete it (*Download the recording*). |
| The transcript | In her own database on your server, with the meeting, until you delete the meeting. Never sent to chat apps. |
| The notes | A document in her Library. |
| Audit rows | `meeting.start`, `meeting.join`, `meeting.file`, `meeting.end`, `meeting.notes`, `meeting.todos`, `meeting.recording` (a download or the first play), `meeting.rename`, `meeting.draft` (send, save, dismiss), `meeting.prefs`, `meeting.delete`; ids only, never the words. |
| The Windows or Mac app's recording | In the app's data folder (`meetings\rec-*.wav`; on a Mac `Application Support/<app>/meetings`) until the page has sent it, then deleted; leftovers after a week. |

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

S2 design (one page): the browser, not the server, turns any recording into 16-bit WAV parts
(`decodeAudioData` + `OfflineAudioContext` at 16 kHz; a WAV is cut as is), so the server needs no
codec and every engine gets WAV. The server diarizes each part without a model
(`src/meeting-audio.ts`: 20 ms frame energy; stereo = louder channel; mono = pause-cut turns
clustered by autocorrelation pitch, two voices only when 20% apart, voice centres carried across
parts) and hears each turn (padded 0.15 s, max 45 s). Notes add `questions`, `event` (all calendars
via `calendarSources`/`allEvents`, best overlap) and `drafts` (attendee groups by domain, one
writing-model call, a plain fallback). Risks: pitch clustering is weak for similar voices (labels
are renamable); loopback also records notification sounds; a 3-hour WAV is ~350 MB through the
browser in ten-minute parts. Tests: `test/s2-meetings.test.ts` (synthetic tone voices, stereo
channels, fake calendar and mailbox, scripted model), `test/s2-meetings-routes.test.ts` (routes,
Range playback, static UI and desktop checks).

- S2 routes: `PUT /api/meetings/prefs`, `POST /api/meetings/upload`, `POST /api/meetings/:id/part?i=`,
  `POST /api/meetings/:id/speakers`, `POST /api/meetings/:id/drafts/:i`,
  `GET /api/meetings/:id/recording?play=1` (inline, Range).
- Windows app: `desktop/windows/src/meeting-rec.cpp` (WASAPI capture + loopback), bridge message
  `meetingRec` (`start`, `status`, `stop`, `discard`) in `main.cpp`; the file returns as a WebView2
  file handle (`{meetingFile:true}` → `sara-meeting-file` event).
- Mac app: `desktop/mac/Sources/MeetingRec.swift` (AVAudioEngine microphone + ScreenCaptureKit audio, the same
  16 kHz stereo mix), bridge `meetingRec` (`start`, `status`, `stop`, `discard`, `read`) in `AppU2.swift`. WebKit
  can't hand a page a file handle, so the page gets a file-like object (`window.__saraMeetingFile`) whose
  slices it reads from the app in 1 MiB base64 pieces by a one-time token; the page reads each ten-minute part
  only when it sends it.

- Server: `src/meetings.ts` (`Meetings`, tables `meetings` and `meeting_lines`; `splitWav`,
  `addressed`, `parseNotes`), routes `src/routes/meetings.ts` (`/api/meetings…`), policy pin
  `meetings` in `src/policy-profile.ts`.
- Web: `web/meetings.js`, `web/meetings.css` (reuses `Mic`, `Call`, `Speaker` from `web/voice.js`).
- Tests: `test/ec19-meetings.test.ts`, `test/ec19-routes.test.ts`, `test/ec19-ui.test.ts` (WAV clips made
  in `test/fixtures/ec19-audio.ts`, a fake hearing engine and a scripted model).
- Design: [ops/EC19_DESIGN.md](ops/EC19_DESIGN.md).
