# Hey Sara

Say "Hey Sara" and talk, hands-free, in the Sara app for Windows, Mac or Android, or with
`sara wake` on a Linux desktop. A small keyword model
on the device listens only for her words. Nothing is sent to your server until you say them, the
recording starts after the phrase (nothing from before it is kept), and the audio is never stored:
your server turns it into text in memory and drops it.

Hey Sara is **off** until you switch it on, on each device, from that device.

## Switch it on

1. Open Sara in the Windows, Mac or Android app, then **Settings → Her → Hey Sara** (Linux: see
   below).
2. Under **This device**, switch on **Listen for "Hey Sara"**. Windows asks once to download the
   keyword pack (about 50 MB, checked against a SHA-256 fingerprint built into Sara; a download
   that doesn't match is thrown away).
3. Windows shows its microphone icon while Sara listens and the tray icon gets a dot: dim while
   she waits for her name, bright while she listens to you, grey when paused. Android shows its
   own microphone dot and a "Listening for 'Hey Sara'" notification with **Talk**, **Pause 1 h**
   and **Stop**. The Mac shows its orange microphone dot and a check mark on **Listen for “Hey
   Sara”** in the menu-bar menu (click it to stop).

The Mac and Android apps carry the listening engine inside the signed app; the phone gets the 5 MB
speech model from **your own Sara server** (checked against fingerprints built into the app), the Mac
from the sherpa-onnx project (checked the same way).

## Android: battery

Listening all the time uses some battery. In Settings → Hey Sara on the phone you can choose **Only
while charging** (bedside or desk) or **Only while Sara is open**. It also pauses by itself on
Battery Saver, below 20 % battery, and while another app uses the microphone; the notification says
why. Paused means the microphone is closed.

## Linux

In a terminal, as your desktop user (no sudo): `sara wake --server https://your-sara-address`. The
first time it shows a code to approve in Sara (Settings → Connections → Devices and sign-in). It
downloads the engine (about 25 MB, checked), gets the model from your server, and listens through
your desktop's microphone (PipeWire, PulseAudio or ALSA; `--device` picks another ALSA device). The
terminal says when it listens; **Ctrl+C** stops it and switches Hey Sara off on that computer.

Hey Sara needs her hearing: either your server's local hearing (**Settings → Voice → Install
hearing and voices on this computer**, or `sara voice install` in a terminal) or a hearing service
you set up in Settings → Voice.

## Talk without the phrase

- **Windows:** press **Ctrl+Alt+Space** (change it in Settings → Hey Sara) or pick **Talk to
  Sara** in the tray menu. No download is needed.
- **Android:** add the **Talk to Sara** tile to Quick Settings, or tap **Talk** on the
  notification.

## What happens when she wakes

- She answers in her own **"Hey Sara"** conversation, so the answers are easy to find later.
- If several of your devices hear you, the first one answers and the others stay quiet.
- The first spoken words are the notice that she is an AI. If what you said sounds like you are
  in danger, the crisis resources are read in full before anything else.
- Say **"stop"** while she speaks and she stops. The text stays on screen.
- On a computer, Hey Sara answers as if others could hear (nothing explicit), unless you mark the
  device as **Personal**.

## Pausing

- Hey Sara pauses while the screen is locked (you can change that per device).
- **Pause 1 h** in the tray or the notification closes the microphone for an hour.
- After a phone restart Hey Sara stays off; a notification asks you to switch it back on.
- **Stop listening on all my devices** in Settings switches every device off at once.
- **Never in my quiet hours** (Settings → Hey Sara, off by default): her phrase doesn't wake her in
  the quiet hours of Settings → Calls from her, on any device, and the microphone closes. Pressing
  Talk still works.

## Household

People in your household can use Hey Sara on their own devices when the owner allows it
(Settings → Hey Sara → This server). Their own companions answer them; nobody else hears their
questions.

## Not yet

- Linux on ARM computers, and a tray icon on Linux.
- Saying "stop" to interrupt her on Android (use Stop on the notification).
- Words other than English.
