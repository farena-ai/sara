# Start here: I just installed it, now what?

Eight small steps, about ten minutes, from the first sign-in to a Sara that feels like yours. Nothing
here needs a terminal after the install. Coming to write code with her? Read [For coders](FOR_CODERS.md)
instead (the first three steps are the same).

For recent explicit tiredness/frustration cues, their privacy controls and how automatic follow-ups
recognize an answer, see [Recent cues and follow-ups](ATTUNEMENT.md). Check its release status before
expecting development-candidate behavior on an older installation.

For the development candidate's owner controls and saved-context retention, see
[Session continuity](SESSION_CONTINUITY.md). Check its release status before expecting it on
an older installation.

> Not installed yet? [Install Sara](INSTALL.md) first (Linux, Docker, Windows, macOS or a NAS), and
> check [what computer you need](REQUIREMENTS.md).

<p align="center"><a href="https://www.youtube.com/watch?v=DTAIW75y7i4&list=PLGtrs9BqXtM8&index=1"><img src="https://i.ytimg.com/vi/DTAIW75y7i4/mqdefault.jpg" alt="Video: Set up Sara, one minute" width="320"></a><br><sub>Prefer to watch? <a href="https://www.youtube.com/watch?v=DTAIW75y7i4&list=PLGtrs9BqXtM8&index=1">Set up Sara</a> in one minute.</sub></p>

## 1. Sign in

Open the address the installer printed. A new server asks for the short **setup code** from her log
(the terminal, the desktop app, or `docker compose logs sara`); she then shows your owner token once, so
put it in your password manager. Read the short note about what Sara is, and press *I understand*.

## 2. Tell her your name, and what you're here for

<img src="screenshots/first-run.webp" alt="Setup step 1 of 4: a box with the name Alex and three cards for what you will mostly do with her: Company, Coding or Both (picked)" width="520">

She asks **what you will mostly do with her**: *Company* (talk, plan your day, remember things),
*Coding* or *Both*. It only changes what she shows you first; every feature stays available, and you can
change it later in *Settings → You → About you*.

## 3. Keep Sara, or make your own

Keep Sara as she is, pick a ready-made character, or choose *Make my own* for a guided five-minute
*Create your companion* right after setup. All of it can be changed later in *Settings → Her*.

## 4. Connect a brain

<img src="screenshots/connect-brain.webp" alt="Setup step 3 of 4, Connect a brain: four choice cards (On this computer, Another computer at home, In the cloud, My subscription), Found Ollama on this computer with 2 models, and a Picked for you card with the local model gemma4:12b and Connected" width="520">

The "brain" is the AI model she thinks with. She looks for one on this computer (Ollama), suggests a
model and checks that it answers: **Connected ✓**. No graphics card? *My subscription* uses a plan you
already pay for (ChatGPT, Claude, SuperGrok), or add a cloud key. Help choosing:
[Choosing a model](CHOOSING_A_MODEL.md) and [what it costs](COSTS.md).

Skipped this step? Open **Settings → Models → Default model → Connect an AI model** to return
to the guided choices. You do not need to repeat your name or companion setup. The chooser tests
that the model answers before you confirm it as the default. Cancelling keeps your current default
and chat draft; connections you explicitly saved with **Use it** or **Connect** stay saved.

## 5. Say hello

The last setup step has three starters (*Tell me about yourself*, *Plan my day with me*, *What can you
do?*), or just type. After her first reply she offers a short six-stop tour.

<img src="screenshots/companion.webp" alt="A chat: Alex asks Sara to put a calmer week on the planner; Sara shows two To-do added cards and a Reminder set card, answers warmly, and a quiet line under her reply says what she did" width="760">

Ask for things in plain words ("remind me at 9 to call the dentist"): they come back as cards, and the
line under her reply says what she did.

## 6. Make her yours

<img src="screenshots/dials.webp" alt="Settings, Name and personality: the personality dials (Warmth, Patience, Emotional depth, Starts conversations, Shows affection…), each with its end words, the word for where it sits, a number and a line in her voice" width="760">

*Settings → Her → Name and personality*: every dial shows where it sits and a line in her voice that
changes as you move it, so you hear the difference before you chat. Every step of every dial is in
the app's guide (Help → *Shaping your companion*).

## 7. Finish *Getting started* on Today

<img src="screenshots/getting-started.webp" alt="Today: Good morning, Alex with her portrait and mood, and a Getting started list (2 of 7 done) with Connect a brain, Say hello, Make Sara your own, Pick her voice, Put her on your phone, Turn on a routine and Keep a copy somewhere else" width="760">

*Today* is where she opens. Its main button starts with **Connect an AI model**, then **Try a message** until a completed reply. Model configuration is not a live connection test. Before that reply, optional customization, voice and phone choices sit under **Optional setup**; expand it any time. Hiding Getting started and your saved Today layout still work.

Its **Getting started** list ticks itself off as you go: her voice, Sara on
your phone ([Your phone](PHONE.md)), a morning briefing and a backup off this server. Each card opens the
right page with its answer ready.

Want her to do something on a schedule? **Planner → Routines** has ready-made ones (a morning
briefing, a reminder to stretch, a weekly review, a price watch…), each with what it costs before you
turn it on ([Routines](ROUTINES.md)). And once you're set up, *Settings → Data & health → Safety
check-up* tells you in plain words if anything could let someone in ([Safety check-up](SAFETY_CHECKUP.md)).

Need a setting? Search at the top of Settings (for example, *backup*, *voice* or *permissions*). Results show a short description and where the page lives. Open one, then **Back to results** to keep your query. Keyboard users can use **Skip to main content** to reach Today or chat; help buttons work with Enter or Space.

## 8. Talk to her from your phone's apps

She can answer you in the chat apps you already use, with the same memories: **Telegram** (the easiest:
make a bot with @BotFather in two minutes, paste its key in *Settings → Chat apps → Telegram*), Discord,
Signal, WhatsApp, Matrix, iMessage and email. Each one has a setup card that says what you need, about
how long it takes and what it costs, then checks every step and ends with a test message on your phone.
Type `/` in any of them for her commands ([Chats and commands](CHATS.md)).

Two more things worth a look once you're set up: **Settings → Add-ons → Get more**, the Sara Store
(plugins, skills, tool servers and companions, each through a review card; nothing switches on by itself),
and **Settings → Her → Hey Sara** in the Windows app, to say her name and talk hands-free
([Hey Sara](HEY_SARA.md)).

## When you're stuck

<img src="screenshots/howto.webp" alt="The How do I…? box at the top of Name and personality, open: How do I change her name?, How do I make her my own? and How do I go back to how she was?" width="760">

- Every page has a **How do I…?** box at the top, with numbered steps and a **Show me** button. All 205
  answers in one list: [How do I…?](HOW_DO_I.md).
- Every setting has a **?** with an example; or simply ask her how something works.
- [Questions and answers](FAQ.md), the [how-to videos](VIDEOS.md), and
  [report a problem from inside Sara](SUPPORT.md).
