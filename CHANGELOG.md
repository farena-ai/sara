# Changelog

Format: newest first. Semantic versions since 1.0.0 (before that `0.<phase>.<patch>`). New entries go under
"Unreleased" until a release takes them.

## Unreleased

## 3.40.0 (2026-11-23): The right tool at hand, the newest Claude models, research in six languages

- New: she picks her tools by what you mean, not only by the words you use. With Meaning search on (Settings → Which model does what → More jobs), "I'm starting on the Miller job, track my time" or "stop sugarcoating things" now find the right tool without the exact words. Without Meaning search nothing changes.

- Fixed: she has the right tool at hand for more everyday ways of asking: "did the Packers win?", "when do the Lakers play next?", "start the clock", "be a bit less formal", "this sounds like a robot wrote it". Before, she had to go looking for the tool first, or answered without it.
- Fixed: asking her to research something in Spanish, French, German, Portuguese or Italian goes to your research model, as it did in English; and a sentence that only mentions research ("my brother does cancer research") no longer does.
- For developers: `npm run eval:tools` measures whether a message reaches the right tool and the right model, with or without a real model (docs/TOOL_EVALS.md).

- Fixed: the newest Claude models work with an API key. Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5 and Fable refuse a setting Sara sent with her background work (her day, memory notes, the small yes-or-no checks), so those calls failed; and because these models think before they answer, short checks came back empty. Both are fixed. Claude through a Claude subscription was not affected.
- New: with a Claude model on an API key, what the model worked out before using a tool is handed back to it with the result, so it carries on from its own reasoning instead of starting over at every step of a longer job.

## 3.39.0 (2026-11-23): Quicker to open, a tidier screen, Sara's own installer look

- Fixed: opening or reloading the app is quicker. Your browser now keeps the app's own files (about 250 scripts and stylesheets) and stops asking the server about each one on every load; a new version is still picked up on the next load. The first load after an update is quicker too: everything is fetched in one go instead of in waves.

- For developers: the tool executor is its own function. `runToolCall` in `src/chat.ts` holds what was a 570-line closure inside the turn function, and reads the turn's state through one typed list (`ToolCallEnv`). Nothing changes in what she does.

- Fixed: the notice bar for updates and known issues no longer covers the end of the chat. It sits in the page above the message box (or at the top of Today), like the check-in note.
- Fixed: on a phone, the top strip no longer takes a row just to repeat the model's name. It shows when something is going on (a worker, a run, research, the model answering).
- Fixed: her day on Today reads as plain words when the model wrote it with list marks, bold or code ticks.
- New: the Windows installer shows Sara's own picture and colors instead of the stock setup pictures.

## 3.38.0 (2026-11-23): Sign in with a code anywhere, one home for her messages, no freeze after replies

- Fixed: a sign-in code from Settings now works on the sign-in page of a new computer. The page offered only the owner token there (the "Have a code?" link showed on phones only), so the code was typed into the token box and refused. The link shows on every device, and a code typed in that box signs the device in.
- New: one home for what she sends on her own. The morning briefing, check-ins, weekly reviews, the roundup of smaller things and add-on notes arrive in From Sara, the first row of the chat list, instead of whichever chat you used last (docs/CHATS.md).
- New: the chat you used last is always at the top. Recent lists your five newest chats from every project, and projects are ordered by last use. Renaming a chat or changing its model no longer moves it up.
- Fixed: the short freeze after each reply. The page rebuilt the whole chat when a reply finished; it now rebuilds only the newest two turns (docs/design/LAGFIX.md).
- Fixed: she names the model that is really answering. Asked to test one model while another wrote the reply, she could claim the wrong one.
- New: replies are cheaper and quicker with every model that caches. What changes each turn (the time, her mood, memory notes) now comes last in her instructions, so the long first part is reused instead of read again every turn.
- New: several look-ups in one step run at the same time (pages, searches, files, her memory) instead of one after another.
- New: her look is made with the picture engine you picked. Create a look follows Settings → Pictures from her → Picture engine (OpenAI images, your own ComfyUI, another image tool, or Grok Imagine), so it no longer needs a Grok sign-in or an xAI key. Outfits and expressions that keep her face still need Grok Imagine (docs/PHOTOS.md).
- Fixed: the demo server could fail to start after an update. The weekly check-in wrote a chat into the demo's data folder, and the demo refuses to run on a folder that holds one; proactive posts and her home chat are now never written on the demo.
- Fixed: team helpers try a busy model server again, give up a reply that stalls, ask once more after an empty reply and keep their history short over a long job.


## 3.37.0 (2026-11-22): Safer with other people's words, complete backups, quicker with Claude

- Fixed: words from a web page, an email, search results or a tool server can no longer ride **Always allow everything**. While such words are in a chat, and for your next two messages there, commands and desktop actions on your computer show their card again, and so does anything that would ask without the switch (docs/security/X0_REVIEW.md, docs/ALWAYS_ALLOW.md).
- Fixed: she asks before fetching a web address that nobody wrote out while other people's words are in a chat. Not you, not a search result, not a page or an email: a made-up address could carry your private text away. A yes covers that site for the rest of the reply; addresses on this computer never ask.
- Fixed: backups take a safe snapshot of every database, not only the main one. Messages, the health log, the journal, photos, shares and the rest were copied while open (docs/BACKUPS.md).
- Fixed: apps signed in with a device code (terminal, VS Code) can no longer add tool servers, change tool permissions or add-ons, switch code changes on, or download a backup. Do those in the web app.
- Fixed: tools of a tool server reached over the internet ask first by default, whatever the server says about itself. You can still set one to run on its own.
- Fixed: one background job that fails no longer stops the others (watches, automations, errands, inbox and more ride one clock). Health shows *Background jobs* when one keeps failing.
- New: replies with Claude models are faster and cheaper. The instructions, the tool list and the conversation are cached between steps, the time of day is sent after the conversation, and long replies are no longer cut at 4,096 tokens.
- New: the app loads faster away from home. Its files are sent compressed: a first load is about 1.9 MB instead of 6.7 MB.
- Fixed: a busy model server (429, 5xx, a dropped connection) gets two more tries when no other model is set to take over; a reply that starts and then goes silent is given up after 5 minutes (15 on a processor-only model) instead of hanging until Stop; a tool call that was cut off is not run and she is told to send it again in parts.
- Fixed: the "10 min ago" labels on earlier messages are worked out once per reply, so a model re-reads less between steps.
- For developers: `npm run test:affected` runs the tests close to a change (the full `npm run check` still decides a commit).

## 3.36.0 (2026-11-20): Enter sends, stocks on Today, smoother chat, fresh look

- Fixed: Enter sends your message and Shift+Enter starts a new line, everywhere you type to her. That covers chat and project chats, Edit last message, Messages, the workspace's Ask box, the offline page, the desktop apps' quick ask and the website receptionist chat. Phone keyboards that hid the Enter key from the page (Android) and gave a new line now send too, and Enter that picks a word in an input method never sends half a word. Prefer writing long messages? Settings → You → Appearance → Chat behavior → Enter sends the message → No: Enter makes a new line and Ctrl+Enter (Cmd+Enter on a Mac) sends (per device, on by default, docs/CHATS.md).
- New: a Stocks tile on Today with charts, and trackers you add right there (P2, docs/design/P2STOCKS.md). A Stocks tile shows the
  stocks you track and the ones you have alerts on, with the price, the day's change (arrow and
  sign, not color only) and a small chart you can switch between 1D, 1W, 1M and 1Y, drawn on your
  computer from free prices. Tap one for a bigger chart with your alert levels marked and add an
  alert there. Add a stock from the tile by company name or ticker, reorder or remove it with Edit
  list. Trackers and alerts are one list. If you already watch stocks, the tile turns itself on
  once (hide it any time). Prices refresh politely (every minute while the market is open, every
  15 minutes when closed, slower after errors) and always say how old they are; in private local
  mode nothing is fetched. Household members get their own; kids don't.
- Fixed: the page no longer freezes while she writes a long reply in a long chat (LAGFIX, docs/design/LAGFIX.md). While she
  wrote, the page drew her whole reply again for every few words, measured the page before and after
  each draw, and kept pulsing glows that redrew the page on every frame; on a slower computer the page
  was busy the whole time she wrote, and clicks and typing waited up to 2 seconds. Now finished
  paragraphs are drawn once, her reply updates about 20 times a second, and the glows pulse without
  redrawing the page: on the same long chat the page's long pauses went from 211 to 5 and the worst
  wait for a click from 1.9 s to under 0.9 s. The Windows app now writes a line to desktop.log when its
  window or the page stops answering ("slow ui", "page busy"), so a stall can be told apart and fixed.
- Fixed: asking her for something long (a full build prompt or document) no longer ends the turn. It could end with
  "Unterminated string in JSON at position 16384" and no answer. Big tool arguments are now shortened
  value by value before add-on checks see them, never cut mid-text, and the check is skipped when no
  add-on uses it.
- Improved: a visual refresh that brings the look up to date (P4, docs/design/P4_VISUAL.md). Your messages
  now sit in a soft rounded bubble with more room between turns; code blocks are wider with a header bar
  and a rounded Copy button; every control shows one clear focus ring; inputs and selects share one height
  and corner; cards and Today tiles share one softer edge; small windows open with a short, calm motion;
  an empty chat shows a small picture; nine panels show a shimmering placeholder instead of "Loading…".
  Sara Classic, High contrast and the accessibility switch keep their look; motion stays off with reduced motion.
- Fixed: small everyday annoyances in the chat (P3FIXES, docs/design/POLISH_FIXES.md). Each chat keeps
  its own unsent text (no more half a message showing up in the next chat or vanishing on a reload;
  never kept for off-the-record chats). After Send, and after opening a chat, the cursor is back in
  the message box on computers. Scrolling up to read while she writes no longer pulls you down, and
  the redraw when she finishes keeps your place. Message times say the day when it isn't today
  ("Yesterday, 9:30 PM"). Your own messages have Copy, and Copy buttons keep their icon. The chat's
  ⋯ menu closes with Esc and works with the arrow keys; its button is bigger on phones, as is Copy on
  code. Long chat names show in full on hover, and a double-click on the chat's title renames it.
  Delete conversation and New project can't run twice from a double click, and Enter saves a new
  project. New shortcuts: Ctrl/⌘+Shift+O for a new chat, Shift+Esc back to the message box.

## 3.35.1 (2026-11-20): Sara knows who you're linked with, and names follow renames

- Fixed: Sara now knows who you are linked with in Messages and who wrote (never what), so "did Hank reach out?" gets a real answer. In your own chats she now knows each linked Sara's name, how long you have been linked, how many unread messages are from them, when the last one came and which of their requests wait for you (help pass, fix, find a time, shared project), and can look it up with a read-only tool. Never what anyone wrote: she still can't read or send messages and points you to Messages. Messages settings → Let Sara know who wrote (never what), on by default. Friend tools (find a time, fix requests, help passes) now find a friend by first name in any case. Fixed: a linked Sara's name was frozen at link time. A rename now reaches linked Saras by itself ("Jarvis (Sam’s Sara)", also communities), the old name keeps working for 30 days ("formerly Hank"), and Options → Rename sets one by hand (docs/MESSAGES.md).

## 3.35.0 (2026-11-19): Language practice, health coach, family screen, local-only proven, carry backups, kid mode, why

- New: practice a language out loud, with cards, listening and your words checked as you speak (W4.3, docs/LANGUAGE_PRACTICE.md). Library → Learn a language: pick
  Spanish, French, German, Portuguese, Italian or English and a level (A1, A2, B1). A short daily
  session mixes spaced-repetition cards (a normal Study set per language and level, so the Today tile
  and reminders work as before), listening (she says a sentence in her local voice for that language,
  also slower) and saying it back (local hearing in that language, your words shown as you speak,
  each word marked right, close or not heard, with one gentle tip). Practice talking opens Talk in a
  practice chat where she answers only in that language, at your level, with at most one gentle
  correction. Streak and words known on the page. Local voices and hearing only, never cloud audio.
- New: a private health coach shows your week and offers one or two small goals, never medical advice (W4.4, docs/design/W4COACH.md). Health → Your week: sleep, steps,
  weight, mood and doses marked taken for the last 7 days against the 7 before, worked out in code
  from your own encrypted log and imports (no model reads it). She offers one or two small goals
  (mark each dose, a little more sleep, a few more steps, log your mood) to Accept or skip with Not
  now; accepted goals show "3 of 4 days so far". Never medical advice: a red-flag reading (blood
  pressure, heart rate, glucose, temperature, very short sleep, a quick weight change, very low mood,
  a strong symptom) shows only "Talk to your doctor about …", with no number and no goal. An opt-in
  weekly check-in on Sunday evening goes through your nudge limit and never says a number or a
  medicine name. Caregivers: a third consent, Weekly summary, shares it with an adult in your
  household (never mood or notes). Owner and adult members each have their own; kids never.
- New: a **Family screen** for a kitchen tablet shows the day, chores, meals and shopping, with a kid-safe Talk (W4.5, docs/FAMILY_SCREEN.md).
  Settings → Household → People on this server → Family screen makes a one-time code; the tablet
  opens /family-screen, types it and gets its own key that opens only the family screen (never
  chats, memory, settings or money). It shows today's family events (never private ones), chores due
  today per person with tap-to-done (a kid's mark still waits for a parent), dinners for the week,
  the shared grocery list (tap to add or tick, or say it when this server has its own hearing),
  what's due soon, and a big kid-safe Talk button: a kid talks in their own space with their own
  limits and bedtime, everyone else talks off the record; never any tools, shopping, money or
  computer use, and money or adult asks get a kind no without any model. It dims at night (its own
  hours) and Talk rests then.
- New: **Local-only mode** now comes with a test that runs a full day of features and proves nothing leaves the server (W5.2, docs/design/W5LOCAL.md). The switch on Settings → Models &
  usage → On this computer is now called "Local-only mode: nothing leaves this computer" and has
  **Allowed while it's on**: update checks (only Sara's own release page on GitHub) and model
  downloads for Ollama on this computer, each off until you tick it; everything else stays blocked.
  What they send shows in Settings → Privacy → What left this server, which now also says whether the
  mode is on and what is allowed. The morning briefing says plainly that the weather was not checked
  in this mode. A new test runs a full day (chat, memory, reminders, photos, voice, briefing, Library,
  planner, automations, health) on a real server with every socket, DNS lookup and UDP packet trapped
  and checks that nothing reached another computer and the ledger shows zero.
- New: backups you can carry on a USB drive or send sealed to a friend's Sara, with a printed recovery sheet (W5.3, docs/BACKUPS.md). Settings → Privacy & system → Backups now has
  a **recovery sheet**: one printable page (PDF) with 18 words and a QR code, shown once until you
  press "I printed it". **Carry copies** seal a backup with that sheet and put it on a USB drive
  (picked from a list of the drives this computer sees), any other folder or a linked friend's Sara,
  every day or every week, keeping the newest few; an unplugged drive just waits and is filled when
  it is back. A friend's Sara keeps your sealed copies only after they say yes (with a size limit)
  and can't open them. **Restore on a new computer** finds the copy on the drive (or takes the file),
  asks for the 18 words (or the QR text), opens and checks it in a throwaway folder, then restores it
  when Sara restarts; the data that was there is kept. A wrong sheet, a mistyped word and a changed
  file each get their own plain answer. `--restore <file.sara>` works with `SARA_BACKUP_KEY`.
- New: **Kid mode v2** sets rules by age band, with time requests you approve from your phone and a parent dashboard (W5.4, docs/design/W5KIDS.md). Kid-safe mode now has three age bands (under 8,
  8 to 12, 13 to 17; the old 6-9 and 10-12 are read as the first two). Each band starts with its own
  tools, words, content strictness, minutes a day, bedtime and study buddy style, and a parent changes
  any of them on Family → Kids ("Use this age's defaults" puts them back). Under 13 she explains and
  coaches homework and never writes essays or reports for them; strict also keeps scary and gory
  stories off. Near the end of the day's time she helps them wrap up; the kid's bar over the message box
  shows the minutes left and **Ask for 15 more minutes**, and every parent's phone gets Approve /
  Decline (also for a tool that is off, or anything else they ask her to ask you; grown-up content,
  money, computer use, Always allow and public records can never be asked for). Family → Kids →
  **Dashboard**: today's time with **+15 minutes**, requests, flagged moments (kept off, a worry,
  personal details shared: counts, never words), and the week's topics. **Transcript view** is off by
  default; when a parent turns it on, the kid's bar says a parent can read their chats and when they
  last looked.
- New: **Why did you do this?** on every action shows what started it and the rule that let it run (W5.5, docs/TIMELINE.md). Each row in Settings →
  Privacy & system → Reports → Action timeline has it: what started the change (your message and
  when you sent it, an automation by name and whether its schedule ran it, a trigger, a webhook, a
  repeat you set, a goal, a worker's job, an errand or a Handle it plan step, another app or an
  outside request, or your own click) and, when no card was shown, the rule that let it run (Always
  allow everything, allowed once ahead, allowed for this task, a tool you set to run on its own, or a
  tool that never asks). **Show the chat turn** opens the chat at that message. The reason is saved
  with the row when it happens, so it is never guessed; rows from before say "From before this was
  recorded." Ask her "why did you do that?" right after an action and she answers from the same saved
  reason, without a model call, in six languages. Changes made by automation emails and worker or
  team helpers now show on the timeline too.
- Security: the second outside-facing review (W5.1, docs/security/W5_REVIEW.md) of everything added in
  ROADMAP_V and ROADMAP_W, with attack tests. A Sara you host for a friend now only accepts model
  addresses on the internet (not this server, its network or cloud metadata; `SARA_HOSTED_LOCAL_MODELS=1`
  shares a model server on this computer). The family screen's "Everyone" Talk no longer sees your
  library, people, planner or files. Memory lane share links drop the photos' location and camera data.
  With Always allow everything on, a turn asks again after she read a web page, an email or an MCP answer.
  A friend's Sara holding your backups counts unfinished uploads against its limit, and a public-records
  page that redirects to a paid broker or sign-in site is skipped.

## 3.34.0 (2026-11-19): Public records report, Handle it, memory lane, MCP both ways, team workspace
- New: a public-records report for personal use: she searches free public sources, cites every fact and saves a PDF marked NOT FCRA COMPLIANT on every page (W4.6, docs/RECORDS.md). Library → Public
  records report (owner only): type a name, address, phone, email or username (plus city and state);
  she searches free public sources (court, business and property records, news, public profiles),
  never paid data brokers or sign-in sites, honours robots.txt and never gets around bot checks or
  paywalls. The report gives every fact with its link, the date seen and a confidence, says "Not
  found" for empty sections, and downloads as a PDF with "NOT FCRA COMPLIANT - This information can
  not be used in housing, loan, employment, or other life altering decisions" on every page. People
  under 18 are refused. Find more sources keeps digging; her list of places to search grows from what
  worked and can be edited. Every search is kept in the audit log. Also from chat (`records_report`,
  asks first).
- New: **Handle it** (W4.1) on a renewal, a return, a bill, a Maybe cancel suggestion and a Library
  form. She shows her plan first, then runs it with the tools she already has (mail and web search,
  the form filler, the browser, email) and stops for your OK at sign-in, payment and sending. She
  never types your passwords and never pays: you press Pay on the site, then "I paid" (a bill is then
  marked paid in Money). A progress card has Pause/Resume and Stop, the end report lists a receipt
  for every step, and every step is on the action timeline. Always allow never skips the sign-in or
  the payment. Guide: docs/HANDLE_IT.md.
- New: Memory lane in Your story writes "My year 2026" or a trip story from your own photos, journal and moments, with local models only (W4.2, docs/MEMORY_LANE.md). Pick "My year 2026" or a trip (from
  your bookings or your photo folder's trip albums) and she writes a story from your own photos,
  journal, moments and trips, with up to 12 picked photos you can leave out one by one. Narrate it
  with the voice on this computer, save it as a PDF with the photos, or make a 7-day share link (asks
  first; listed with your other shared links). Only a model on this computer writes it: photos and
  journal words never go to a cloud model; without a local model she puts it together from your facts
  in code. Stories are sealed in your own space, so household members each have their own.
- New: popular free tool servers in one click (W3.2): Settings → Skills & tools → Other programs (MCP)
  lists free, open-source MCP servers (files in one folder, Git, web pages, SQLite, time, notes graph,
  step-by-step thinking, Playwright browser, GitHub with your own token), each with its source,
  license and what it can touch. Add shows exactly what it can do before anything is installed; it
  gets only the folder you pick and no internet unless it needs it. Tool permissions on its card set
  Allow / Ask first / Off per tool.
- New: a team workspace in business mode (W3.3). A **Team** tab with team roles (owner, admin, member,
  guest) and one table of who may do what; guests only read. Company sign-in can map *guest groups*
  too. Each workspace gets a team inbox (paste a message, assign it, reply as the team: a contributor's
  reply waits for a manager) and approvals routed by role (spending over the organization's limit
  needs an admin in the workspace; nobody approves their own request). The audit export can now be
  narrowed by who and what and include every workspace's activity, still without any message text.
  See docs/BUSINESS.md and docs/design/W3_TEAM.md.
- New: Search help (W2.5). Type a word or a question under Help → Search help, or at the top of the
  guide, and she finds the answer among every How do I…?, every setting and its tip, the guide and the
  docs, in English, Spanish, French, German, Brazilian Portuguese and Italian. Show me opens the right
  Settings page with the answer open and points at the control; anything not translated yet is marked
  In English. It all runs on your server, with nothing sent anywhere.
- New: short how-to clips for the ten most asked How do I…? answers. Press Watch it next to an answer.
- New: goals for your workers (W3.4, Team → Goals and weekly plan). A worker's goal has one simple
  measure (finished jobs, or a number it reports) and a cap in dollars or tokens; at the cap its jobs
  stop and she asks you once. A goal can pass work along a chain of workers (one's output becomes the
  next one's job, shown as one line). Each week the workers propose a plan you change and approve in
  one card; the goal view shows progress, spend vs cap and what is blocked. Guide: docs/WORKERS.md.
- New: website receptionist version 2 (W3.5, docs/RECEPTION.md). It answers each visitor in the
  language they write in (English, Spanish, French, German, Portuguese, Italian), shares the payment
  links you paste (it never takes a payment or card details), and when a visitor leaves an email it
  writes a follow-up draft in their language that waits for your Send. Settings → Business details →
  Receptionist conversations shows each visitor's questions and answers; Wrong? Write the right answer
  keeps your answer and it is used the next time someone asks the same thing.
- New: Settings → Models & usage → On this computer → Recommended for this computer (W2.4): a free,
  local model for each job (talking, coding, pictures, hearing, voice, meaning search, the phone's
  offline copy) picked for your graphics card or memory, with size, memory, license, Why this one and
  whether we tested it. One click downloads it (her talking model stays as it is); hearing and voices
  go to the Voice page. An optional monthly re-check (off by default, this computer only) tests the
  downloaded ones and updates their Tested marks; `node scripts/model-recheck.ts --publish` puts the
  same results on the results page. Guide: docs/FREE_MODELS.md.
- New: the add-on kit in the SDK (W3.1, docs/ADDON_KIT.md). `sara-addon create my-addon` makes a
  working add-on (a tool, a setting with its ? tip, a page shown as a card, tests) written with typed
  `defineTool`, `defineSetting`, `definePage` and `defineAddon`; the manifest comes from the code.
  `sara-addon test` runs the add-on in its own permission-limited process and runs its tests;
  `--sara <source folder>` runs them in a throwaway Sara with the add-on installed through the real
  review and install path, and `sara-addon dev` shows that Sara in the browser. `sara-addon pack`
  writes the store bundle and a listing file and sends nothing (submitting stays `sara submit`).
  Until the npm package is published it runs from the source folder:
  `node packages/sara-sdk/src/cli.ts create my-addon`.
- New: API keys for MCP apps can be limited to what you tick (W3.2): ask her, her memory, reminders,
  her library, planner. Each key shows what it may use; older keys keep everything. New MCP tools
  `list_reminders` and `add_reminder`. Children never get a key, and household members' keys reach
  only their own space.

## 3.33.0 (2026-11-19): One personality, weekly check-in, easier installs, first ten minutes, host a friend

- New: **How Sara comes across** (Settings → Sara → Name and personality): one personality for chat, her voice,
  email drafts and your website receptionist. Set an email sign-off, the receptionist's greeting style and the
  picture devices show by default, and see one sentence as chat text, spoken, as an email line and after the
  receptionist's greeting. Everything is kept in her character (and its file), per companion and per person (W1.4).
- New: her weekly check-in shows what she did, what failed and what cost money, with three ideas you can accept in one tap. Ask any time in chat: "How am I
  doing?" (six languages). It goes through the daily nudge budget (docs/HER_WEEK.md) (W1.5).
- New: the first ten minutes: Set up Sara looks at this computer and offers the right way to run her model, then ends with three quick wins (W2.2). Then Bring what you have, Where do you text? with Send me a test, and three
  quick wins tailored to what is connected. Every step skippable and kept; six languages.
- New: **Host a Sara for a friend** (Settings → Household → People on this server). An invite link gives a
  friend their own Sara on your server that is not part of your household: they bring their own model
  and API key and set their own spending limit (Settings → Your account), their keys are sealed with a
  key file of their own, and you see only their 7-day totals. Pause, or Remove with 7 days for them to
  download their data. Your Data rights exports and usage reports leave their space out. See
  docs/HOSTING_FRIENDS.md (W2.3).
- New: every installer checks the machine before it changes anything (W2.1): disk space, memory, the
  port, the system and its version, a 64-bit CPU, an earlier install, administrator rights and the
  internet. Each problem is a card with what is wrong and the exact next step (32-bit Raspberry Pi OS,
  no systemd, Alpine, little memory with the swap commands, a port in use with the command that shows
  who has it). Only the checks: `get-sara.sh --preflight`, `install.sh --preflight` or
  `node src/main.ts --preflight`. Windows Setup checks the Windows version, memory and disk space first.
- Fixed: when another program already uses her port, Sara now says so with the next step instead of
  stopping with a long error.
- Tests: `node scripts/install-matrix.ts` installs Sara in throwaway containers (Ubuntu 22.04/24.04,
  Debian 12, Fedora 40, AlmaLinux 9, arm64, Docker Compose) from a local tarball; results in
  docs/INSTALL_MATRIX.md.
- Fixed: the guided setup no longer opens again after Finish when it was first opened by hand, and
  shows one close button.

## 3.32.0 (2026-11-19): What Sara knows, polite nudges, continue on another device, Mac parity

- New: one "What I know about you" page (W1.1). Settings → You → What Sara knows now lists everything she
  knows about you by topic, with where and when she learned it and how long ago. Search it, ask "Why do you
  think that?" to see the message it came from, press "That's wrong" to fix it or "Forget" to remove it (both
  with Undo), and merge facts that say the same thing. It also shows how many People cards, notes, renewals,
  purchases and learned skills she keeps, with a link to each; your Health log stays private. Each household
  member sees only their own.
- New: her nudges share one polite daily budget, most useful first, with the rest in an evening roundup (W1.2). Everything she sends on her own (money notes,
  free trials, the Maybe cancel note, the workforce report, gift and upkeep reminders, texting first,
  home reactions) shares one budget, most important first. Quiet hours are honored; safety alerts
  and things you asked for (briefing, renewal reminders) always come on time. Smaller things wait for
  one roundup a day. Each nudge has a "Why did I get this?" line and "Fewer like this", which she
  learns per person. Settings → You → Automations → Her nudges. See docs/NUDGES.md.
- New: continue on another device. Your open chat, the words you hadn't sent, where you were reading
  and an open Talk or live view follow you: open Sara on another device within 30 minutes and a card
  says "Continue where you left off on your PC — 2 minutes ago". On a computer, ⋯ at the top of a chat
  has Continue on my phone, which sends your phone a notification (browser, iPhone app or Android app).
  Each person's own, never across household members; Settings → Phone and notifications (W1.3,
  docs/CHATS.md).
- New: the screen companion on the Mac. **Offer help when an error shows on screen** now works in the Mac
  app too, with the same rules and bubble as on Windows. It needs the Accessibility permission (words only,
  no pictures, so not Screen Recording); Settings says so in plain words and opens the right pane (W0.5).
- New: tell Sara a renewal date in a chat ("my passport expires March 31, 2027, keep track of it") and it
  goes on You → Renewals with its reminder, the same row as typing it in there (W0.1).
- Fixed: asked to bring everything over from ChatGPT or another assistant, Sara said she can't; she now
  points you to Move in (Settings → Privacy & system) with the export steps (W0.1).
- Changed: "check everything, mail too" questions are steered to Ask everything instead of only your
  documents (W0.1).
- New: the benchmark page (docs/results/index.html) shows the everyday real-model task runs task by task;
  the real-model suite has 13 more tasks, one per newer feature (`node scripts/eval-real.ts --publish`) (W0.1).
- New: **Always allow is on — Turn off** in the Windows tray menu and the Mac menu bar menu, shown only
  while Always allow everything is on (W0.5).
- New: the Mac app supports Always allow everything like the Windows app: its own card asks once
  (**Always allow everything**), then desktop actions and commands run without cards until the switch ends
  (at most 7 days per confirmation) (W0.5).
- New: shared conversation links, client portals and legacy pages follow the visitor's light or dark
  system setting, with the app's own Day colours (W0.5).

## 3.31.0 (2026-11-19): She knows the time, Always allow, six languages everywhere

- Fixed: the email bridge no longer sends the same reply twice. When the mail server dropped the line while
  she said goodbye (SMTP QUIT), the email plugin crashed, and on restart it sent the reply again because
  the outbox file still listed it. QUIT on a closed line now fails quietly, and a mail the server has
  taken leaves the saved outbox at once (W0.4).
- Fixed: a command she runs on your computer that goes past its time limit is now always stopped. Before, one failed kill on a busy PC left
  it running. The Windows kill helpers also have their own time limits now (W0.4).
- Tests: the suite no longer fails when the PC is busy. business-check, u5-voice-fast and phase80 wait
  for the thing they check (a worker that is ready, Windows listing a process) instead of a short fixed
  window, and a fake "stuck" voice engine never answers. No retries and no skips (W0.4).
- Fixed: Sara now knows exactly when everything was said, so she no longer says "yesterday" about something from 10 minutes ago. Every
  earlier message now reaches her with its local time and how long ago it was ("2:07 PM, 10 min ago"), a
  pause shows as "8 h since the last message", and the date, time and time zone are restated at the end
  of every turn. Memories, reminders, tasks, past-chat lookups and email lists carry their age too, and
  email times are in your time zone instead of UTC. If a reply still says "yesterday", "earlier today",
  "last week" or "2 hours ago" about something whose real time is known, the app corrects the words, in
  six languages (`src/time-sense.ts`, docs/CHATS.md).
- Fixed: more of what you see reads in your language (Spanish, French, German, Portuguese, Italian):
  My apps and live view errors with names and numbers in them, the "Still to do" lines of the Move-in
  checklist, the desktop Quick ask bubble (buttons, hints, offers, her mood), calls on the demo,
  Home Assistant checks, computer-use and link messages, and the error lines of a dozen more pages.
- Fixed: a second opinion with one difference says "1 point differs", not "1 points differ".
- New: words as you speak in Spanish, French, German, Portuguese and Italian. An optional free hearing model
  (NVIDIA Nemotron 3.5 streaming, ~480 MB, downloaded only when you choose it in Settings → Sara → Voice → Talk
  with Sara, with `sara voice install --languages`, or with `install-voice.sh --languages` on Linux) shows your
  words while you talk, in your language. The first word shows ~1 s after you start (English: ~0.7 s). English
  keeps its small model. Languages without a model hear whole sentences as before. With it installed, whole
  recordings, meetings, captions and the interpreter in those languages are heard by it too, instead of the
  English-only model. Measurements in docs/VOICE_FIRST.md.
- New: Always allow everything (Settings → Connections → Computer use). One switch per person lets
  every command, desktop, browser and computer action run without an approval card, including the
  kinds that always asked (payments, account settings, saved logins, destructive commands). Turning
  it on shows a one-time warning and asks for your password or passkey again; pick 1 hour, 1 day or
  until you turn it off. A red "Always allow is on" bar with Turn off sits above the chat box, and the
  Sara app on your computer confirms it once on its own card. Passwords are still never typed,
  requests from other people and apps still ask, and every action stays on the Action timeline and in
  the audit trail. Household adults can use it only when the owner allows it for them; kids never.
  See docs/ALWAYS_ALLOW.md.

## 3.30.1 (2026-11-19): She knows what she did, second opinion from chat, sharper memory

- Fixed: the Action timeline also lists changes she makes without asking first (a live checklist she posts,
  for example), using the same rule as the claim checker.
- Fixed: her memory picks and auto-loaded skills no longer match on everyday words. "I need a packing
  checklist" picked notes only because they said "need", "get a second opinion" picked "second", and a
  follow-up about a packing checklist loaded what she learned about a World of Warcraft patch because
  it said "updated". One shared list of common words in all six languages (`src/common-words.ts`,
  reusing the titles check's list) now never counts for memories, skill search or learned topics; a
  memory matched only on general words ("updated", "changes") is a weak match (sure: low), and a
  learned topic needs a real topic word in the question. Good matches still work ("what did I say about
  my passport" finds the passport note; a WoW question still gets the WoW topic). Ranking golden set
  unchanged at 19/20; false word picks on 10 messages that name no note went from 10 to 0.
- Fixed: "She said it, did it happen?" no longer shows on things she really did with her newer tools. The
  claim check now knows which tools change something from the tools themselves (they ask first, or their
  name says add, update, log, post...), instead of an old hand-made list that missed live views,
  purchases, upkeep, My apps, chores, health log and more. Live view changes also back a later
  "the checklist is updated" or "I changed it twice". Real misses get the same chip as before.
- Fixed: Asking in the chat for a second opinion ("get a second opinion", "what would another model say?",
  in six languages) now shows the Second opinion card for her last reply, with the models and the cost
  and Ask them / Not now, instead of her doing web research. Nothing goes to another model until you
  press Ask them; private chats still only use models on this computer.

## 3.30.0 (2026-11-18): Offline answers on the phone, teach by showing, Wear OS, live views, second opinion

- New: Second opinion on any of her replies (the ⋯ actions under a reply → Get a second opinion): two other
  connected models answer your question on their own, without seeing her reply, and the three answers
  show side by side with what only one of them says, or says with other numbers, highlighted. Before
  anything is sent you see which two models and what it costs (free on this computer, about $0.002,
  or price not known) and can swap either one. Private chats only ever ask models on this computer,
  and past your spend limit only free models are offered. The result stays under the reply
  (docs/CHOOSING_A_MODEL.md "Second opinion").
- New: Live views in chat: she can post a small checklist you tick, a table or a bar or line chart right
  in the chat, and it keeps itself up to date from where its data lives: her own list (tell her
  "add sunscreen"), your Planner to-dos (tick one and the task is done; finish a task elsewhere and
  it shows ticked within seconds) or the data one of your kept apps saves. Each runs sandboxed, like
  My apps: no Sara sign-in, it can't read the chat page or reach the internet. Library → My apps →
  Live views in chats lists them with Open the chat and Remove (docs/LIVE_VIEWS.md).
- New: Sara on a Wear OS watch (D2): a tile with the rest of today's reminders, how many things wait on
  you and a Talk button that asks her by voice and shows her short answer. Pair the watch with the
  short code it shows (Settings → Connections → Phone and notifications → Wear OS watch): no token
  to type on the watch. Anything that needs your OK stays on your phone. The watch app is in
  `android/wear` (build it yourself; not in an app store). Guide: docs/WEAR.md.
- New: Answers while offline (Android app; Settings → Connections → Devices and sign-in → Offline on this
  device): an optional small model on the phone (Qwen2.5 0.5B, about 490 MB, downloaded only when you
  tap Download and checked before use) gives a short answer in a kept chat while her server can't be
  reached. It shows as "Offline answer" under your waiting message and is added to the chat, once,
  with your message when the connection is back; she doesn't answer it a second time unless you tap
  Ask Sara again. Never for children's accounts; elsewhere offline messages wait as before
  (docs/OFFLINE.md "Answers while offline").
- New: Teach by showing (browser extension → Watch me do this): do a task once in your browser and Sara
  keeps the steps (clicks, what you typed, what you picked, the pages), never a password, payment
  card, one-time code or ID number: those steps only say you type them yourself, and Sara's server
  checks that again. Addresses are kept without their query part. Stop shows the steps to untick and
  name; Replay here runs them on the page again (the secret ones are left for you); Send to Sara puts
  them under Settings → Skills & tools → Skills → Shown in your browser, where Save as a skill or
  Make an automation (it stays off until you set when it runs) turns them into something she can do.
  A switch on Devices and sign-in → Browser extension turns recording off (docs/EXTENSION.md
  "Watch me do this").

## 3.29.0 (2026-11-18): Photo search, interpreter, health imports, captions, action timeline, privacy ledger, legacy access

- New: What left this server (Settings → Privacy & system → Privacy): a day-by-day list of every request
  her server sent to another computer, grouped by why it went (AI models, web search, mail and
  calendar, notifications, chat apps, Sara's makers...) with the place, how many and about how much
  was sent. Counted where every request leaves; only the place and a count are kept (30 days), never
  what was in it. Requests that stay on this computer are not listed, so with "Nothing leaves this
  computer" on the list is empty and shows what was stopped instead; Clear the list forgets it
  (docs/PRIVACY.md "What left this server").
- New: Caregiver mode (Health → Daily check-in, Caregivers, Simple home): a person can let an adult in
  their household see their missed doses, their daily check-ins, or both, and nothing else (never
  chats, symptoms, mood, readings, appointments or notes). The caregiver sees it under Health →
  People you care for, read fresh from the person's own encrypted log each time, so Stop sharing
  hides it at once. A dose still open two hours after its time tells dose caregivers once (no
  medicine name on the lock screen), and "I need help" tells check-in caregivers right away. Simple
  home is a plain page with four big buttons: Talk with Sara, Medicines (big Taken buttons), Check in
  and Call family (one-tap phone links); it can open on start on that device (docs/HEALTH.md
  "Caregivers and Simple home").
- New: Accessibility switch (Settings → You → Appearance → Accessibility, also a quick setting on the
  Settings home): one switch for easier reading (a clearer font with more space between letters and
  lines, which can help with dyslexia), no motion anywhere and a larger layout on every page, with
  text at least Large; turning it off puts your earlier choices back. Line focus adds a reading band
  that follows your pointer, a tap or the keyboard and fades the rest. The choices stay after a
  reload, travel with "Use on all my devices", and Reset to defaults keeps them. Screen readers now
  hear a name for every dialog; the views added since R9 were checked (docs/ACCESSIBILITY.md).
- New: Action timeline (Settings → Privacy & system → Reports → Action timeline): one list of what she
  changed for you, newest first, for 90 days: files, the name she calls you and other settings, mail
  she sorted, calendar events she added, to-dos, notes and reminders, and anything else she asked your
  OK for. Revert puts a change back where Sara already keeps a way back (the file snapshot, the mail
  undo, removing an added event, the planner's own history); the rest says plainly why it can't be
  undone (a sent message, a deleted event, a setting that lived on one device). Each household member
  sees only their own; reverts go in the audit trail. New features add their own undo with
  `registerAction`/`registerRevert` (src/timeline.ts; docs/TIMELINE.md).
- New: Legacy and emergency access (Settings → Privacy & system → Privacy): name one person you trust and
  pick what they get (a letter, notes, Library documents, sealed notes, your details; chats only if
  you pick them). After the days you choose without a sign-in or a chat, Sara reminds you, waits,
  then opens an expiring page for them. They can ask early; you are told at once and it still waits.
  Any sign-in, chat or "I'm here" cancels. See docs/LEGACY.md.
- New: Health imports (Health → Trends from your watch or phone): import an Apple Health export
  (export.zip), a Google Takeout Fit export or Garmin CSV reports and .fit files. Sara keeps one value
  per day for steps, sleep, heart rate, resting heart rate and weight, encrypted like the rest of the
  log; the file itself is not kept. Importing the same file again adds nothing, and Undo import removes
  what an import added. Each measurement gets a trend card (newest value, 7-day average, change on the
  week before, 30-day chart), and the doctor summary shows device days as one line each
  (docs/HEALTH.md "Imports").
- New: Live and translated captions for meetings (Library → Meetings → a meeting → Captions): big captions
  that follow a room or a recording while she hears it, with an optional translated line under each
  one (17 languages, A−/A+ text size, full screen, Jump to the latest). A model on this computer
  translates; a cloud model only if you allow it in Settings → Voice → Meetings, never in private
  local mode. Each line is translated once and deleted with the meeting (docs/MEETINGS.md "Captions").
- New: Live interpreter (Talk with Sara → **Interpreter**): two people who don't share a language talk
  through Sara. Pick the two languages (20 to choose from); each turn is heard, translated by a model
  on this computer first, and spoken in the other language. On a phone the screen splits in two with
  the far half upside down, so the person across the table reads their own language; **My turn**
  helps when a short word could be either language. Settings → Sara → Voice → Interpreter keeps the
  languages, a switch to let a cloud model translate when this computer has none (off by default),
  and the saved transcripts (download or delete). Translations never become chats or memories.
- New: Photo library search (Settings → Skills & tools → Library → Photo folder, then Our moments): pick
  one folder of photos on this computer and search it by place (from each photo's GPS, matched
  against a built-in city list), by the words written in a photo, by people you name, by month or
  year. A picture model on this computer writes a caption and copies the writing; a cloud model is
  never sent a photo, and without a local one places, dates, names and people still work. Made-for-you
  albums: trips, each person you named, photos with writing. *Name this place* turns nearby photos
  into "Home". Owner only; the photos are never moved or changed (docs/PHOTO_LIBRARY.md).
- New: Screen companion (Windows app, Settings → This computer, off by default): when an error dialog, a
  "not responding" window or a stuck form shows, a small bubble offers help without taking the focus.
  Help with this puts the message into quick ask (sent only when you press Ask); Not now; Pause for
  1 hour (also in the tray menu). It looks only on that computer, never at password fields, typed text
  or hidden windows, offers each thing once, and keeps or sends nothing.

## 3.28.0 (2026-11-18): My apps, automation replay, workforce report, Fix this issue, website receptionist

- New: Automation steps and replay (Settings → You → Automations): **Steps** opens an automation's step
  list. Drag a step or use its arrows to change the order, add a step between two others, change
  what a message or task says, or remove one; each change saves at once (locked while a run waits for
  your OK). **History** now shows every run's steps, with what each step was and how it went, and a
  finished run has **Run again with this input**, which runs it once more with the same start on the
  same runner (approvals and limits apply; once per run) (docs/AUTOMATIONS.md "Steps and replay").
- New: Workforce report and one-click hire: once a week (Team → Workers that stay → Weekly report; default
  Monday 9 AM, only when a worker did something) Sara sends what each worker did: jobs done and
  failed, jobs waiting, tokens and cost, what it made and why jobs failed. It goes where the new
  "Workforce report" alerts go (its own chat by default, or a project, a chat, Telegram, Discord);
  Show this week and Send it now are on the same card. Workers can now be shared in Get more → Shared
  by friends: Review and hire shows what each worker may do and its budget, Hire adds it paused with
  that budget (never with memories, never with Run commands) (docs/WORKERS.md).
- New: Fix this issue (Settings → Connections → Apps and services → GitHub → Fix an issue): a repository's
  open issues, each with one button. Her team fixes it in a worktree of its own, runs the tests until
  they pass, reviews it and shows a pull-request card (files changed, test run, review) in Settings
  and in the issue's chat. Nothing goes to GitHub until you press Open the pull request; Not now keeps
  the work in its worktree. Issues started from Team or in chat also get their own worktree now
  (docs/FOR_CODERS.md "Fix this issue").
- New: My apps (Library → My apps): ask her for a small web app in a chat, try it and say "keep it". Kept
  apps stay on your own server with every version: Undo last change, or go back to any version;
  what the app saved stays. Open it, look at it inside the Library, or share a read-only link that
  ends when you choose. Apps run sandboxed: they never get your Sara sign-in, can't reach the
  internet and keep only their own small data. Each household member has their own.
- New: Website receptionist (Settings → You → Business details → Website receptionist): a chat for your own
  website, added with one line of code. It answers visitors only from the Library documents you tick and
  your business details, follows your business rules in your own words, refuses other topics, and
  always says it is an AI assistant. With *Offer free times* on, visitors pick a free time from your
  booking page and leave a request that always waits for your OK (even when the booking page confirms
  on its own). No tools, a daily question limit, limits per visitor, and a list of what visitors asked
  lately (docs/RECEPTION.md).

## 3.27.0 (2026-11-18): Renewals, purchases, Home Assistant scenes, audio briefing, scan pages, upkeep, gifts

- New: Car and house upkeep (Settings → You → My details → Car and house upkeep): add the usual schedule
  for a car (oil, tires, filters, brakes, wipers, battery; by miles or months, whichever comes first) or
  for the home (furnace/AC filter, gutters, smoke and CO alarms, water heater, dryer vent), or your own
  job. Each job shows its next due date and gets a reminder on the day. Done today or Log with details
  (date, miles, cost) moves the next date on, service receipts from Money → Purchases can be logged in
  one tap, and Book it starts an errand that finds a place near you and asks before booking. Type the
  odometer now and then and she works out when jobs by miles fall. In chat: "when is my oil change
  due?", "I changed the furnace filter today" (docs/UPKEEP.md).
- New: Gifts and occasions: each People card now shows the next birthday and yearly dates, a gift budget,
  gift ideas from what she knows (never a private card, private facts or health, money and other
  sensitive details), Add to shopping list (a to-do on the Planner's Gifts list, due a week before)
  and a short card text in your own writing style that you copy (she never buys or sends anything).
  A reminder arrives two weeks before (Settings → You → Briefing and reminders → Gifts and
  occasions: on/off, days before, default budget). In chat: "gift ideas for Maya" (docs/PEOPLE.md
  "Gifts and occasions").
- New: Maybe cancel (Money → Maybe cancel): a list of subscriptions worth a second look, with why each is
  there: the service's own email says you haven't used it ("we miss you"), or you pressed *Not using
  it* on a Subscriptions row; the price went up (bank rows or a price-change email); two or more of the
  same kind (video, music, storage, news, fitness, audiobooks); a free trial ending soon. It reads your
  bank exports and the subscription email Money already reads, one row per service. *Start a cancel
  errand* opens Errands → Cancel a subscription, which waits for Start and asks again before the final
  confirm: nothing is cancelled without your OK. *Keep it* hides a row until something new turns up.
  Once a month a short note goes where Money alerts go (can be turned off), and chat answers "which
  subscriptions should I cancel?" from the same list. Subscription receipts no longer show up in
  Purchases (docs/TRIM.md).
- New: One-minute voice journal: Library → Journal. Pick how today was, press Record a minute and talk (or
  type it), and the entry is saved with its mood. Your words are heard on this computer only; the
  recording is kept only if you tick Keep the recording. Edit or delete any entry; a streak line and
  On this day show what you wrote on this day in earlier years. Private by default: sealed in your own
  space, never in chats, memory, Ask or reports (docs/LIBRARY.md "Journal").
- New: Find a time with a friend: in a one-to-one Messages chat (or by asking her, "find a time with Sam
  for coffee"), your Sara and your linked friend's Sara swap busy times only, never what the events
  are, once your friend says yes. She proposes 3 times that are free for both of you, in each
  person's own part of the day; when you both pick the same one it is agreed and lands in both
  planners (docs/MESSAGES.md "Find a time with a friend").
- New: Snap and file: Library → Scan pages takes pages with the phone or computer camera (or photos you
  already have), finds the paper's edges, straightens each page and lets you fix its corners, turn
  or reorder pages, then keeps them as one PDF in the Library in one tap. She reads it like any
  scanned document (local picture model first), and the scan view shows what she read and the dates
  she found, with Remind me next to each (docs/LIBRARY.md "Scan pages").
- New: Morning briefing as audio (Settings → You → Briefing and reminders → Listen to your briefing): each
  briefing can also be read aloud into an audio file in Library → Briefings (with its text; the last
  two weeks are kept), with a Play briefing button on Today. The voice on this computer is the default,
  so nothing goes to a cloud voice unless you pick your chosen voice. An optional private podcast link
  (owner only) lets a podcast app follow your briefings; it works only with its secret link, a new link
  stops the old one. Next to the weekly review, a weekly life review: people you were in touch with,
  dates coming up, your health log in counts, what you spent and the moments you kept
  (docs/BRIEFING_AUDIO.md).
- New: Home Assistant in one click, scenes by voice (Settings → Connections → Apps and services → Home
  Assistant): *Find it for me* asks your home network once (mDNS) and fills in the address; *Test token*
  checks the address and token without saving and shows your home's name and how many scenes and scripts
  it has. *Say it to start* lists your Home Assistant scenes and scripts: switch one on, keep or change its
  words, and say them in Talk with Sara, car mode or a call ("Hey Sara, movie night") to run it at once,
  with no model call. Typed messages never start them. Locks, doors and alarms can't be picked, and a
  card that locks, unlocks or touches an alarm now wants a tap: a spoken yes no longer answers it
  (docs/design/V2HOME.md, docs/HOME_ASSISTANT.md).
- New: Renewals and paperwork (Settings → You → What Sara knows): one list of what needs renewing, soonest
  first: passport, driver's license, registration, insurance, warranties, subscriptions, a lease. It reads
  the dates Sara already finds in your Library documents, renewal mail (a policy renewing, a registration
  or license expiring; shop offers stay out), the Money page's subscription renewals, and rows you type in
  or add by photo of the card (the photo goes to your Library and is read like any scan). The same date
  shows once. Each row: Remind me (30 days before, as for document dates), Fill the form (asks her in a
  chat; she stops before Submit), Start a renewal errand (a new Renew template that waits for your Start
  on the Errands page), Hide. Cards now read `EXP 03/14/2029`. docs/RENEWALS.md.
- New: Purchases (Money → Purchases): one list of what you bought, with the store, price, date, the last
  day to return it and when the warranty ends. Receipt emails join it on their own; *Add a receipt
  photo* (or a PDF) goes through your Library and joins once it is read; the same receipt by photo and
  email shows once. Return dates come from the receipt ("return by…", "within 30 days", "final sale"),
  else the store's usual window (Amazon, Walmart, Target, Best Buy, Costco, Home Depot, Lowe's, Apple,
  IKEA); each row says where its date came from and *Edit dates* changes it. A reminder comes a few
  days before a window closes (1-7 days, or off); *Keep it* and *Returned* stop it. *Start a return*
  opens a new Errands template, "Return something you bought", that finds the receipt and how the store
  takes returns and drafts the request; nothing is sent without your OK. In chat: "can I still return
  the headphones?" (docs/PURCHASES.md).

## 3.26.0 (2026-11-18): Bring everything, Waiting on you, Where do you text?, cost autopilot

- New: Benchmark page: Sara's original coding tasks can now run through other agent CLIs you installed
  yourself (presets for Claude Code, Codex CLI and Aider, or any command line in evals/harnesses.json),
  graded by the same hidden tests; `node scripts/bench-compare.ts` reruns everything it finds and
  builds a one-file results page (docs/results/index.html) with model, date and exact command per
  row, every run listed, readable offline on a phone or desktop, light or dark. `--mode verify` checks
  the tasks and proves the grading with a fake harness, without any model.
- New: Cost autopilot (Settings → Models & usage → Which model does what): a quality bar per job (talking,
  coding and long tasks, web research). *Best* never switches; *Good enough* lets Auto try the next
  cheaper connected model (one on this computer first) on 8 of your past tasks with the eval loop and
  switch only when it does as well. Every switch has an Undo, and "saved $X this month" shows there and
  on Usage and costs. Private chats still only use models on this computer (docs/design/V1COST.md).
- New: Where do you text?: a picker at the top of Settings → Connections → Apps and services. Pick your phone
  and the app you already text in (Messages on iPhone, WhatsApp, Signal, Telegram, Discord, Matrix,
  Slack, Teams, email). Sara shows what it needs, opens that app's setup with defaults filled in (a
  suggested Matrix ID, the tested BlueBubbles address), and once it is set up offers Check (each plugin's
  own checks as plain lines) and Send me a test (one message into your own linked chat; Matrix, iMessage,
  WhatsApp). iMessage gets "Is my Mac reachable?" before anything is added: one BlueBubbles ping, no
  password, local network only. The Matrix and iMessage tiles now show Connected / Started. The Matrix and
  iMessage plugins are 1.1.0 (the test message). docs/WHERE_DO_YOU_TEXT.md.
- New: Waiting on you, one list: everything that needs your answer (her approvals, team steps, device
  sign-ins, her board questions, errands, inbox cards, overdue to-dos, failed chats, mail to answer),
  urgent first then oldest, each row opening its own card. Open it from Today's Needs you or
  `/#view=waiting`. Later puts a row off until tomorrow (the same as Today's Not today). On a phone,
  swipe right for a one-tap yes where the card allows one, left for Later; money and passwords never go
  by a swipe. Each household member sees only their own (docs/WAITING.md).
- New: Move in with one button (V1.1): each old agent Sara finds on this computer has **Bring everything**:
  one review that counts her personality, notes, chats, skills, scheduled jobs, settings, hooks and
  plugins, with every safe card already decided (hooks still never run; cards with a warning wait for
  you), then one Import. A ChatGPT or Claude export can join the same review: saved memories, custom
  instructions and Claude project knowledge now come in as notes too (before, only the chats did).
  Hermes Agent settings that were only listed (hearing, helpers, memory, routing, checkpoints, tools,
  quick commands and more) now say which Sara place does the same thing. After the import, **Your
  first evening together** lists the model, voice and chat apps to check and every kind of thing that
  was skipped, with the reason (docs/MOVE_IN_GUIDE.md).

## 3.25.0 (2026-11-18): Sign in with your provider, faster voice on Windows, store-ready extension

- Docs: ROADMAP_V checked against what Sara already has (docs/design/VAUDIT.md: each item marked
  exists, partial or new, with the files) and rewritten into seven waves of five builder tasks, with
  eight new ideas and the phone-number items parked (docs/design/ROADMAP_V.md).
- Browser extension ready for the Chrome Web Store, Edge Add-ons and Firefox Add-ons (not published yet):
  `node scripts/pack-extension.ts` now makes one zip per store plus a source zip for Firefox review, with
  Sara's version; the Firefox build declares its data use for Firefox's own consent screen (passes Mozilla's
  web-ext lint cleanly); store name and long description in six languages; shorter summaries that fit
  Chrome's 132-character limit (French, Portuguese and Italian were too long); a privacy policy
  (docs/EXTENSION_PRIVACY.md) and every store form answer, permission reason and picture in
  docs/STORE_LISTINGS.md.
- Developer SDK ready for npm as `@farena-ai/sara-sdk` (not published yet): public package settings,
  links to the public repository, examples shipped in the package, and the owner's publishing steps in
  docs/NPM_PUBLISH.md.
- Try these has checks for every release from 3.19 to 3.24 (test restores, What's new, Talk with Sara,
  Business, shared projects, the marketplace, picture editing, Money, Family, Health, study cards, the
  browser extension, free flight status, Word comments, team recipes, the taskbar count and more), so
  What's new shows Try it on every release (V0.3, docs/TRY_THESE.md).
- Settings → Privacy & system → Health → Readiness: the Restore drill row also counts the monthly test
  restores. A recent passed test restore makes it Ready, a newer failed one says so and opens Backups,
  and a drill line adds how many test restores passed in the last 30 days (V0.4).
- Stock prices come from Nasdaq first (no key, the exchange's own prices for US stocks and ETFs), with
  Yahoo Finance right behind it for indexes, other markets and anything Nasdaq can't answer; each answer
  names where it came from. Yahoo, Stooq, Finnhub and Alpha Vantage stay as choices (V0.10, docs/DATA.md).
- Trips: Rename on a trip card edits its name in place; an empty name gives back hers (V0.10).
- Library: documents kept more than once show a line with Keep one of each; one copy stays, with what
  she learned from it and its collection (V0.10, docs/LIBRARY.md).
- Windows: when Azure signing is set up, Inno Setup signs Setup and its uninstaller through the same
  sign.sh; unsigned builds are unchanged (V0.6, docs/ops/WINDOWS_SIGNING.md).
- Fixed: stopping Sara (the Windows service closing her input) could wait for a backup tick's test
  restore or weekly check; the stop now skips that maintenance, waits at most 5 s for a running tick and
  always ends within 15 s, under the service host's 20 s (V0.6).
- Developers: `node scripts/whats-new.ts` prints exactly what to translate (lines ready to append per
  language), and `--prune [--dry-run]` drops translations of highlights that left the 8-release window,
  never a key something else uses (V0.5, docs/WHATS_NEW.md).
- New: **Sign in with your provider** (OpenID Connect) on every server, not only business mode
  (V0.8, docs/SIGN_IN_SSO.md). Settings → Connections → Devices and sign-in: pick authentik, Keycloak,
  Pocket ID, Authelia, Google, Microsoft Entra ID, Okta or another provider, follow its 3–4 steps, paste
  the redirect URL Sara shows, say who is who by email or group, then Check the provider and Test
  sign-in (a new window that signs nobody in). Optional owner/member/kid groups, a preview of who maps
  to whom, and new members from an allow-list (off by default, adults only). Your token, passkeys and
  pairing codes always keep working. Business company sign-in gains the self-hosted presets too.
- Voice: the loaded-engine helper now ships with the Windows installer and the Mac app (built by the
  release against the pinned sherpa-onnx), so Windows and Mac servers answer by voice about a second
  sooner too; the voice install puts it next to the sherpa tools (V0.1).
- Voice: words as you speak in Talk with Sara (V0.2). An optional streaming hearing model (free, about
  105 MB) shows your words while you talk and ends your turn a little sooner. Settings → Sara → Voice →
  Talk with Sara → Hearing while you talk, or `sara voice install --streaming`
  (`install-voice.sh --streaming` on Linux). Whole sentences stay the default.

## 3.24.0 (2026-11-18): Security review, backup test restores, What's new, server dashboard, faster voice

- Security: a review of the parts other servers, web pages and links can reach (U5.33,
  docs/SECURITY_REVIEW_U5.md), with fixes. Calendar links and recipe or calendar pages by address now
  open only public addresses (never this computer or the home network, also after a redirect) and
  read at most a few MB. After Sara reads a friend's shared-project items or another server's help or
  fix report, and when the browser extension sends a page, anything that would change something asks
  you first (reading still works). Signed calls from a linked server are rate limited, a friend can
  keep at most 50 fix recipes waiting, and a friend's code recipe may not change the code that guards
  links and passes. Ids from other servers are checked and encoded in the page, and the Android app's
  "Open in browser" opens only your own server's address.
- New: a monthly **test restore** that proves backups work (U5.31, docs/BACKUPS.md). Once a month, at a
  quiet hour, Sara restores the newest backup (and, if you want, the newest off-server copy) into a
  throwaway folder, checks every database, the chat and memory counts against the counts at backup
  time, every file against the backup's own hash list and that the vault opens, then deletes the copy.
  Your live data isn't touched and no value is read out. Results (passed, failed or skipped with the
  reason and how long it took) are in Settings → Privacy & system → Backups → Test restores, with a
  switch to turn it off and **Test a restore now**. A failure sends you a notification and shows up as
  a self-repair problem; it is skipped when there isn't enough free disk space. Backups now record
  those counts and a hash per file.
- New: **What's new** after each update (U5.32, docs/WHATS_NEW.md). The first time you open Sara after
  an update, a short page lists what changed in each release since the version you last saw, in plain
  words, with Show me to open the place it lives and, for the owner, Try it to jump to the matching
  Try these check. Got it closes it for good; Help → What's new shows it again any time, and "Show this
  after each update" turns the automatic page off. Household members see only what they can use; kid
  mode never shows it. The page is built from this changelog when Sara is built and is translated into
  all five languages (the build checks fail when a highlight has no translation).
- Faster voice replies (U5, docs/VOICE_FIRST.md): her own hearing and voice on the server now stay
  loaded between sentences instead of loading the model every time, so with a local model she starts
  answering out loud in about 0.4 s instead of about 2 s (measured on a desktop PC). They load when you
  open Talk, stay loaded for 10 minutes by default (Settings → Sara → Voice → Talk with Sara → Keep
  hearing and voice loaded: Off, 10 or 30 minutes, 1 hour) and fall back to the old way on any problem.
  Linux servers get it from `deploy/install-voice.sh` when a C compiler is installed; Windows and Mac
  servers keep the old way for now.
- Settings → Privacy & system → Updates → Code changes: on a Linux server, a status line (on or off, who can change it) and a switch for server code changes. Turning it off always works; turning it on asks you to confirm it's you (passkey or two-step code, else typing ON) and is refused when the administrator ran `sudo sara selfcode lock`. The root helper checks every request again (U5.30, docs/SELF_CODE.md).
- Settings → Privacy & system → Health: a server dashboard with health, versions (server and apps), disk space, memory and processor load, backup age, recent errors, open self-repair problems and pending updates, for this server and each linked server that gave you a help pass, colored by state, with Refresh and links to the details (U5.34, docs/DASHBOARD.md).

## 3.23.0 (2026-11-18): Talk with Sara, shared projects, marketplace, picture studio, business pack

- New: a **Business** place in the sidebar (U4.29, docs/BUSINESS_PACK.md) that brings clients, time,
  invoices and quotes together. Start and stop a timer in the page or by chat, add time by hand, and pick
  how time is rounded (6, 15 or 30 minutes or an hour, to the nearest or always up; Settings → You →
  Business details). Clients keep an email, hourly rate, payment terms, phone and address; their terms
  and address go on their invoices. Invoice a client's unbilled hours with one click (expenses can be
  added at cost from chat), turn a quote into an invoice, mark invoices sent or paid (reminders as
  before), and "Email it": Sara shows the exact email with the PDF attached and sends it only after you
  press Allow. Make a read-only, expiring link for a client with their invoices, the PDFs and how to pay
  (no client accounts; revoke any time). Add business expenses by hand or from your bank rows in Money,
  and download a CSV for the period by category, or in QuickBooks, Xero or Wave columns. She never
  charges a card or takes a payment.
- New: picture editing and short video on your own computer with ComfyUI (U4.28, docs/PICTURES.md).
  Library → Pictures and video, or Edit picture… on any Library picture: paint over a part and change
  or remove it, extend the edges, upscale (2×, 4× or 4K), remove the background, or change the style
  with a "how much may change" slider. Every result is a new Library item with its versions kept
  (before/after slider, the original never changes). Short clips (2, 3 or 5 seconds) from words or from
  a picture, only with video models already installed (Wan 2.1, LTX-Video 0.9, or a video workflow you
  saved in ComfyUI); nothing is ever downloaded, and anything missing is explained. Jobs show their
  progress and can be cancelled. In chat: "remove the person on the left", "make it 4k", "make a short
  video of …". Same picture rules as before: none of it in kid mode, explicit only with adult mode on,
  never a sexual edit of a real photo, never minors; with "Nothing leaves this computer" on, ComfyUI
  must be on this computer. Owner only. Settings → Pictures from her → Editing and short video.
- New: shared projects between linked friends (U4.26, docs/SHARED_PROJECTS.md). On a project page,
  Shared with friends invites one or more friends whose Sara is linked under Messages, as Can view or
  Can edit, and picks what is shared: notes, to-dos, files (up to 2 MB, from your computer or the
  Library) and, off by default, chats of that project (never private or adult ones). Your friend
  accepts in Settings → Connections → Phone and notifications → Shared projects and gets the project
  in their own list. Changes go both ways over the signed link, catch up after either server was
  offline, and the last change wins; a file changed on both sides at once keeps the other edit as a
  conflict copy. An Activity list says who did what; notices are quiet by default (a count), or one
  notice per batch of changes. Remove a friend, stop sharing, or leave any time: the copy stops
  updating. Sara reads the shared items only when you ask inside that project's chats, from her own
  copy; the other server can only send shared items, never read anything else or make your Sara act.
  Owner only; private local mode pauses it.
- New: Shared by friends, a community marketplace (U4.27, docs/MARKETPLACE.md). In a Messages community
  or with a linked friend, share skills, templates, automations, team recipes and links to Store add-ons
  from Settings → Skills & tools → Get more. Each listing shows its description, version, author, the
  tools and settings it needs, ratings and comments. Before anything is installed your Sara checks it
  itself (content hash, no secrets, no hard-limit tools, no protected settings, size limits, tools it
  has) and shows exactly what installing does; skills start on trial and automations start paused.
  New versions send a notice and never apply themselves. Report a listing and the community's owner
  can remove it. Nothing executable is shared, and private local mode keeps it all at home.
- New: **Talk with Sara** (U4.24, docs/VOICE_FIRST.md). One button next to the message box starts a
  hands-free conversation in the browser, the desktop apps and the phone web app: she listens all the
  time, answers out loud sentence by sentence, shows a live transcript, and stops when you talk over her.
  If she is still quiet 0.7 s after you stop talking, she says a short "Mm-hm" so you know she heard
  you. A card that needs your OK moves onto the talk panel, and "yes" or "no" answers it. Money,
  passwords, sign-ins and her hands on the computer always need a tap; that rule now also covers car
  mode and phone calls. Say "goodbye" or press End to finish. Talk turns skip the model's private
  thinking (on this PC the first sentence came in about 1 s instead of 3 to 22 s with gemma4:12b).
  Settings → Sara → Voice → Talk with Sara has three switches. Hey Sara can start a talk. With Nothing
  leaves this computer on, it needs hearing and her voice on this server. A speech check keeps hum and
  keyboard noise from starting an utterance.

## 3.22.1 (2026-11-18): Settings and the new windows open again

- Fixed: in 3.22.0, Settings, Health, Family and every window after Money opened empty (the Money window
  was missing its closing tags, so the windows after it were hidden inside it). A test now checks that
  every window in the page is closed.

## 3.22.0 (2026-11-18): Money, family planner, health log, study cards, browser extension

- New: Sara in your browser (U4.25, docs/EXTENSION.md). An extension for Chrome, Edge and Firefox that
  pairs with your own Sara by a short code (approve it in Settings → Connections → Devices and sign-in,
  where it is listed and can be signed out). On any page: ask Sara about it (the address, your
  selection and the page's readable text), summarize it, save it to her Library, or right-click selected
  text to ask about it; her reply shows in the popup with Continue in Sara. Fill this form proposes
  values from My details field by field; nothing is typed until you approve, the form is never sent,
  and passwords, payment cards and codes are never filled. An Off on this site switch, and two switches
  in Settings (the extension, and its form filling). Data goes only to your paired Sara; private local
  mode and kid spaces refuse it. Not published to any store: load it unpacked (zips via
  `node scripts/pack-extension.ts` in outputs/extension/).
- New: a **Money** place in the sidebar (tracking only: Sara never logs in to a bank, pays, transfers or
  cancels anything; the page says so). Add your bank or card exports (CSV, Excel, OFX, QFX and now QIF);
  a CSV with unusual columns asks once which column is which and remembers it for that bank. Files that
  overlap (October's and November's exports) don't count a purchase twice. See spending by category,
  six-month trends, budgets with gentle "getting close" and "went past" notes (once each, sent where your
  Money alerts go), bills due (from your inbox, the ones you add and repeating charges in your
  transactions, each with a reminder), subscriptions with price changes and free trials ending (also
  found in your email) and a link to cancel them yourself, and net worth from balances you type in.
  Change any transaction's category and she remembers it for that merchant; your model can suggest
  categories if you turn that on (merchant names only). Ask about anything now searches your
  transactions too. Household members each have their own; children don't get it. Works fully in
  private local mode.
- New: a home and family planner in Family. **Meals** is a week of dinners: pick a saved family recipe
  or type one. Save recipes by pasting them, by giving a recipe page's address, or from a document in
  your Library. Everyone notes their likes and allergies, and a dinner that clashes with someone's
  allergy says so ("Allergy: Mia: peanuts"; shellfish covers shrimp). **Add to the grocery list** puts
  the week's ingredients on your grocery list, added up ("2 lb chicken thighs") and sorted by aisle.
  You can also ask her to "plan dinners for the week": she reads everyone's allergies first.
- New: chores can take turns. A chore moves to the next person once a week, and each person with
  chores left gets one reminder a day, never during their quiet hours. Kids see their chores' points
  as stars.
- New: a family **Calendar**. Paste a school letter, pick a school PDF from the Library, or give an
  iCal link or .ics file: each dated line becomes an event that waits for a parent's OK. Anyone can add
  an event. **Only me** keeps an event private, so nobody else sees it, not even the owner.
- New: the Family tile on Today shows tonight's dinner, how many chores are left today and the next
  family event. Dinner time, reminder time and the rota day are in Settings → Household → Family
  planner.

- New: **Health**, a private health log of your own ([docs/HEALTH.md](docs/HEALTH.md)). Medicines with
  dose reminders, Taken/Skipped and a refill estimate; appointments with questions to ask, after-visit
  notes and Add to calendar; symptoms, mood, sleep and readings with small charts. Quick add by typing or
  telling her "headache 6/10" or "BP 128/82". Make a doctor summary PDF for any dates. Parents can manage
  a child's medicine reminders. It is your log, not medical advice.
- Health stays private: encrypted on this server in your own space, never in her memory, never in
  support or hub reports or fix recipes, and read only by a local model unless you allow a cloud model
  (Settings → You → What Sara knows → Health log). Ask about anything includes it only from a private
  chat, and only when you turn that on.
- New: **a learning coach**. From any Library document, one of its chapters or text you paste, Sara makes
  a study set: flashcards, fill-in-the-blank cards, multiple-choice and short-answer questions, and a
  summary sheet. Study a few cards a day in Library → Study (Again, Hard, Good, Easy space them out) or
  say "quiz me" in chat, where multiple-choice questions are pick-an-answer cards and short answers get
  kind feedback. A Study tile on Today shows the cards due, with a daily reminder at the time you pick
  (Settings → You → Briefing and reminders). Sets export for Anki or as CSV and import back. Making a
  set costs one model call (local models work; she makes the cards herself if the model can't). For
  kids: words for their age, a hint before every answer, homework coached and never answered, and
  parents see titles and counts in Family. See docs/LEARNING.md.

## 3.21.0 (2026-11-18): smarter: six languages, voices apart, Word comments, team recipes

- New: promises, clause checklists and travel emails in Spanish, French, German, Brazilian Portuguese
  and Italian, not just English. Sara works out which language a text is in and reads it with that
  language's own phrases, dates (day first, month names, 24-hour times) and booking words: "Te envío el
  informe el viernes" becomes a promise due Friday, a German contract's "Haftungsbegrenzung" ticks the
  liability cap, and an Iberia, Lufthansa or Trenitalia confirmation becomes a trip.
- New: free flight status without a key. The Trips page can use OpenSky Network (no sign-up), which shows
  whether your plane is in the air, on the ground or landed. It has no gates, delays or cancellations;
  the page says so. It stays off until you pick it, and AirLabs with your own key is still there.
- New: tracked changes everywhere in a Word file. When she revises a Word document, changes in the
  **header, footer, footnotes, endnotes and text boxes** are tracked too (same author and date), and an
  edit that runs through a **link or a page-number field** keeps the link and the field instead of being
  refused. Ask for every place at once ("change it everywhere") when the words are in more than one part.
- New: **comments in Word**. Ask "add a comment asking about the payment terms" and she leaves a note in
  the margin on those words instead of changing them.
- New: **moved paragraphs** are tracked as a move in Word (Review shows "Moved"), so accepting puts the
  paragraph in its new place and rejecting puts it back.
- The Library's review panel shows where each change is (Header, Footer, Footnote, Text box), moves, and
  every comment with the words it is about. Accept all and Reject all cover every part of the file.
- Meetings: better speaker separation on this computer. Uploads and one-microphone recordings are now
  told apart by voice, up to 8 speakers (was: at most two, by pauses and pitch), and a change of speaker
  without a pause is caught. A free add-on (about 40 MB) downloads the first time a meeting needs it;
  Settings → Voice → Meetings has the switch, *Download now* and *Remove*. When two voices sound alike and
  are kept as one, the transcript says so; speakers stay renamable. Without the add-on, the old way is
  used. On a generated 3-voice meeting: 13/13 lines right (8/13 before).
- Fixed: the Meetings switches in Settings → Voice (remind me, cloud engine) showed unticked until the
  Meetings page had been opened.
- New: team recipes. After a team run finishes, "Save as a team recipe" keeps its plan (helpers,
  models, tools, budgets, parts and checks, never its results or anything secret) under a name. Team →
  Team runs lists them: Run one with a new job (the plan still waits for your OK), Edit, Duplicate,
  Export as a file, Import, Delete. In a chat: "use my product comparison team to compare …".
- New: Ask about anything also searches your meetings (what was said, with the time in the recording,
  and the notes), trips, contract/proposal templates and drafts with their clause checklists, research
  reports and goals; contacts also show promises and when you were last in touch. Each answer opens
  the exact item: the meeting at the line, the trip at the booking, the goal. Private chats stay out.
- New (opt-in): Share fixes that worked. Under Settings → Privacy & system → Health → Self-repair you can
  let a fix that worked (a small fix, a learned skill, or a code change you applied) be offered to the
  linked friends you tick. Only the kind of problem and the fix travel, never your data. Their Sara shows
  it only when she has the same problem on a compatible version, and nothing runs without their OK: she
  uses her own fix (with Undo), or tests a shared code change against her own rules first. Off by default.
  You can also send such a fix to the Sara developers after seeing exactly what goes.
- Remote repair: a code change in a friend's fix plan now reports back. The helper sees when it was
  prepared (and which tests passed), approved, applied, went back or was undone, in the plan, the final
  report and the help log, and gets a notice when it is applied or goes back.

## 3.20.0 (2026-11-18): the apps catch up: Dock and taskbar counts, Mac meeting recording, Android notices

- Fixed (iPhone): "Connect the Sara phone app" no longer tells an iPhone to get the Android app from
  Google Play. On an iPhone it explains Add to Home Screen (or says Sara is already there); on a computer
  it shows both phones.
- Fixed (iPhone and other installed apps): errands waiting on you now count in the number on Sara's
  icon, in each notification's badge and in the Shortcuts widget's "Waiting for you" line.
- Fixed (phones): on the screens added since 3.15 every button, field and "?" is at least 44 px to tap;
  Ask everything and Make it sound human keep clear of the iPhone notch and home indicator; Email and
  calendar no longer runs past the right edge of a small iPhone.
- Android app (new build, not on Google Play yet): messages from people in Messages now come as phone
  notifications, also when the app is closed. One-to-one messages pop up under "Messages from people";
  a community mention (or a community set to Everything) comes quietly under "Community messages"; plain
  community posts stay inside Messages. Tapping one opens Messages. The notifications carry the app's
  badge number. See docs/ANDROID.md.
- Android app: download links and exports in the app (Messages attachments, policy and template
  exports, backups) now save to Download/Sara instead of doing nothing.
- New in the Mac app: the **Dock icon shows your unread messages** (the same number as the Messages count
  in the sidebar: one-to-one messages and mentions).
- New in the Mac app: **Record this computer** in Library → Meetings records your microphone and the
  Mac's own sound (Zoom, Teams, Meet), so you are Speaker 1 and the call Speaker 2, like the Windows app.
  macOS asks once for the microphone and once for Screen & System Audio Recording; without the second
  only your microphone is recorded and the card says how to allow it.
- New in the Mac app: **quick ask brings the text you selected** in the app in front (needs the
  Accessibility permission; never a password field) and can add **a picture of that window**. Menu bar →
  Quick ask shortcut → Include selected text turns it off.
- New in the Windows app: **the number of unread messages on Sara's taskbar button** (a small red count,
  1–9, then 9+), the same count as the Messages pill in the sidebar. It goes away when you have read them,
  and a server whose Messages popup is off adds nothing.
- New in the Windows app: **messages from all your Saras.** With several servers in the app, the ones not
  in use are asked for new messages every couple of minutes (each with its own sign-in). Your Saras (⇄ and
  the tray menu) shows each server's unread count, a new message brings a notification naming the server,
  and clicking it switches to that server's Messages. The taskbar count adds all servers up.

## 3.19.0 (2026-11-18): proven on real models, Try these, steadier releases

- Fixed: on Teams, Matrix, Signal and iMessage the live progress message could keep its stop button
  (or miss a step) when the chat app was slow to post it: a change that arrives while the message is
  still being sent now waits for it, in order (Slack already did this).
- Fixed: code mode scripts no longer lose script time while their sandbox process is starting, so
  short scripts aren't stopped as "too long" on a busy computer. The total time cap is unchanged.
- Developers: seven tests that failed only under load now wait for what they check instead of a fixed
  time (ec7-teams, windows-installer, s10-choices, ec21-runner, pc-run, phase118; phase114c had no
  timing dependency), and `npm run typecheck` also checks the developer tools' own scripts.
- New for developers: **real-model task runs** (`node scripts/eval-real.ts`, docs/REAL_RUNS.md). 40 everyday
  tasks run through real chat turns and tools on throwaway Saras with a real local model, checked by code
  and scored by a second local model; time and tokens per task, a cost cap, resumable, a report.
- Fixed (found by the real runs): "Put my stock alerts in the Stock Alerts project" could send the alerts
  to the chat you asked in instead of making the project. Saying yes to "Make it" now always makes it.
- Fixed: "make this sound more human", "less robotic" and "sounds like AI" now offer the humanize tool,
  so the facts lock protects your numbers and names.
- Fixed: the contract checklist no longer counts a liability cap that mentions "the fees paid" as the
  payment clause.
- Fixed: trip details name the airline on each flight, so she no longer guesses one.
- New: **live checks you can run yourself** (`node scripts/check-accounts.ts`, `node scripts/check-pair.ts`,
  see docs/CHECKS.md). A throwaway Sara goes through every mail and calendar kind (two Gmails, app
  passwords, Outlook, CalDAV, calendar links, default and combined inbox, removing), on stand-ins always
  and on your own test accounts when you put them in `.secrets/test-accounts.json`; two throwaway linked
  servers go through messages, communities, retention, help and fix passes and unlinking. Each writes a
  report to `outputs/checks/`.
- Fixed: removing a second Google account in Settings now also forgets its choices (left out of the
  combined inbox, its calendars, default), so an account added later doesn't inherit them.
- Fixed: after adding a calendar event, her confirmation showed the wrong time when the server runs in
  another time zone than yours (the event itself was right).
- New (for developers): **a Windows install and update matrix you can run on a PC**
  (`node scripts/check-windows-install.ts`, docs/CHECKS.md): fresh install, the app updating itself,
  reinstall, downgrade, a manual Setup run, a stale old entry and both uninstalls, with the test build only;
  the all-users cases in `scripts/check-windows-install-admin.ps1` for an administrator.
- Fixed: the test build of Setup, installed with her server on this computer, used the real Sara's data
  folders and sign-in start entry; it has its own now.
- Added: **Try these**, a guided checklist for the owner. Help → Try these lists about 30 short checks of
  what is new since 3.15 (newest release first), each with a few steps, a Take me there button that opens
  the right page or starts the chat for you, and what you should see. Mark each Worked, Didn't work or Skip
  and add a note; progress shows how many you tried, and items added by an update are marked New. When
  something didn't work, Ask Sara to fix it opens a chat asking her to check herself and fix it. Export
  your results as Markdown, or tick *Let me send results to the developer* (off by default) to send them
  as one report: Preview shows exactly what goes, with keys, emails and folder names removed, and it
  shows in My reports. See docs/TRY_THESE.md.

## 3.18.2 (2026-11-17): several Google accounts from either mail page, approved code fixes on servers

- Fixed: **adding several Google accounts works from every page and never replaces one.** Settings →
  Email and calendar and Gmail and Calendar now show the same list of every account (each Google
  account with its address, what it is used for: mail, calendar, Docs, and Reconnect and Remove) and
  one **+ Add an account** button: Google account, Gmail with an app password, Outlook or Microsoft
  365, or another provider. Signing in to Google with an address that isn't listed always adds it
  next to the others; the same address renews its own sign-in. Before, the Gmail and Calendar page's
  Sign in button re-signed the first Google account, so picking another account replaced it. An
  account lost that way can't come back by itself: add it again with + Add an account → Google
  account. Saving the same Google app again (a new secret) now keeps every sign-in.
- New: asking her "add another email account" or "connect my other Gmail" shows a card with your
  accounts and a + Add an account button that opens the choices.
- Added: **Code changes on Linux servers.** On a server install (`install.sh`), Sara can now fix her own
  code too, still only after you press Approve. A small locked-down helper run by the system checks the
  change again with its own rules (this Sara only, the approved patch, no protected files, no weaker
  tests), puts it in place the way `sudo sara update` does, restarts her and puts the old code back if
  she doesn't come back healthy. `sudo sara update` keeps your changes (parking any that no longer
  fit). For the administrator: `sudo sara selfcode list | revert <id> | off | on`.

## 3.18.1 (2026-11-17): message notices you can't miss, one Windows install, second mailboxes kept

- Changed: **new one-to-one messages are hard to miss.** A clean card now appears at the top centre of the
  window, in front of whatever you're doing (Today, Settings, a chat): who wrote, two lines of the
  message, **Open** and **Later**. It stays until you choose, never takes your typing focus, and several
  people stack into one card ("New messages from Hank and 2 others"). Messages that arrived while Sara was
  closed, minimized or reconnecting get the card too when you come back; Later is remembered, a new
  message brings it back. The sidebar shows the unread count (More shows a dot while Messages is in it),
  the tab title starts with "(2) ", and the installed app's badge counts them. Communities stay quiet
  (mentions use the same card). The old 8-second corner popup is gone.
- Fixed: **Sara is listed once in Settings → Apps after an update or reinstall.** Every update (Settings →
  Updates, the service's update task, the app's own update) runs Setup in the scope of the install that
  is already there (all users or just you). A downloaded Sara.exe no longer adds a second entry next to
  Setup's, and Setup takes over the old self-installed entry wherever it pointed. If Sara is listed twice
  anyway, the app removes the copy that isn't running when it starts (her data stays) and says so in one
  line; an all-users copy needs an administrator, so it tells you where to remove it.
- Fixed: the Windows app's own update no longer stalls when your Sara doesn't answer at that moment
  (Setup asked a question nobody could see).
- Fixed: **adding a second Gmail (or any) mailbox never replaces the first.** Sara's vault now reads
  changes another copy of it wrote before it saves, so an older copy can't write back an old list of
  mailboxes. Adding the same address again updates that mailbox in place (same entry, default and
  calendar choices kept) and says so, with how to add a different one. If a mailbox went missing
  earlier, add it again with *Add Gmail* and its own app password.

## 3.18.0 (2026-11-16): self-repair, friends fixing friends, quieter communities

- Added: **a friend's Sara can fix things on your server when you ask.** Say "I can't get X working, can
  you have Sam fix it" (or press *Ask Sam to fix something* in your Messages chat with a linked friend), pick
  how long (1 hour, 1 day, 7 days) and how much (look only / fix with my OK each time / fix within this
  pass). Sam accepts, his Sara looks at your Sara's problem list and sends a plan; your Sara checks every
  step and runs it herself, with your OK (code changes always ask on their own). Live progress, Stop and
  Undo on both sides, a short report at the end, and every step in the help log and audit trail. No
  commands, files, passwords or remote control. Owner only; refused in private local mode.
- Added: **new-message notices in Messages.** A one-to-one message now shows a small card in the corner
  of Sara's page (click it to open the chat; it hides after 8 seconds), next to the phone push and the
  desktop toast; a soft sound can go with it (off by default). Communities stay quiet: no push or popup,
  just a small count next to Communities, unless someone @mentions you. Each community has *Notify me:
  everything / when I'm mentioned / nothing*; the defaults are in Messages settings. The sidebar dot
  counts one-to-one messages and mentions only.
- Changed: **clearer link wording.** The link code says it works once for 30 minutes, and that once
  you're linked you stay linked until either of you unlinks; each chat shows when it was linked.
- Added: **she fixes herself.** Sara checks herself every 15 minutes and when you say "something is broken" or
  "fix yourself": model services, sign-ins, add-ons, stuck jobs and errands, the database, disk space, settings
  and the Sara apps. Small setup fixes run on their own and you are told after (or every fix asks first, your
  choice); each one keeps a copy first and is put back by itself if things get worse. When the same thing
  fails again and again, or you ask her to learn to do something, she suggests a skill or automation that starts
  on trial. A "full permission for 24 hours" switch lets one OK cover a bigger repair. She never changes safety,
  limits, kid mode, approvals, the audit trail, passwords or her own permission. Settings → Privacy & system →
  Health → Self-repair shows what is wrong, what she fixed, and Undo. See docs/SELF_REPAIR.md.
- Added: **Sara can fix her own code (with your OK).** When something in her is broken and a setting
  can't fix it, ask her ("fix your code: …") or use Settings → Privacy & system → Updates → Code
  changes. She makes the change in a separate copy with your coding model (stops at $2 per fix and 20
  minutes; both adjustable), runs the typecheck and tests and a test start, and shows one card: what she
  changed in plain words, the change itself, and the check results. Nothing changes until you press
  **Approve and apply**; she keeps a copy of the old files, restarts, and goes back by herself if she
  doesn't start properly. **Undo** takes a change out the same way. After an update she puts your
  changes back (tested first) or parks the ones that no longer fit and tells you. She never touches her
  safety layer, limits, kid mode, approvals, audit trail, vault or her own permissions, and never
  weakens tests. Optional: send a fix to the Sara developers (you see exactly what is sent, private
  details removed). Only on installs that run from a source folder she can write to; the apps, Docker
  and the Linux server install say why not and offer a report instead. See docs/SELF_CODE.md.

## 3.17.0 (2026-11-16): documents end to end, agent teams, support link, alerts where you want

- Changed: **Adult mode in the apps.** The Windows and Mac apps now use Adult mode like a web browser (turn it on with the 18+ confirmation, explicit levels, adults-only outfits, adult channels). The phone apps show the Adult mode page again with its state and Turn off; turning it on there still needs a web browser (store rules), and an Open in browser button opens the page in the phone's browser.
- Added: **choose where alerts go.** Stock alerts, sports and odds, mail and product watches, automation
  results, research done notices, goal nudges, travel alerts, inbox finds, reminders and the morning
  briefing can each post to the chat they were set up in (as before), a chat just for them, a chat in a
  project ("Stock Alerts › Stock alerts"), one of your own chats, or only Telegram/Discord. Say it in chat
  ("put my stock alerts in the Stock Alerts project"; she asks before making a new project) or use
  Settings → You → Automations → Where alerts go. Each watch and automation row shows *Posts to* with
  Change. A watch whose chat was deleted now posts to a chat named after its kind, not whichever chat
  came first. Never a group, a room or someone else's chat. See docs/ALERTS_DESTINATIONS.md.
- Added: **contracts, proposals and letters, end to end.** Mark any Library document as a template
  (contract, proposal, letter, NDA, statement of work or invoice cover): she finds its blanks
  ({{Client}}, [CLIENT NAME], Date: ____) and a Word template gets a fill-in form; the copy keeps your
  formatting. In chat she drafts from your template and your past documents, asks only for the facts she
  doesn't know, and says which past document each reused clause came from. Revisions are real Word
  tracked changes by "Sara" with the date, so you accept or reject each one in Word; the Library shows
  them too, with Accept all and Reject all. A clause checklist per kind of document marks each clause
  present (quoted), missing or unusual. Ready to sign makes a PDF with page numbers and signature, name
  and date fields, after checking no blanks or tracked changes are left. Information, not legal advice.
  See docs/DOCUMENTS.md.
- Added: **agent teams** (team runs). For a big job she proposes a plan: helpers (researcher, drafter,
  checker or your own), each with its model (Auto by default), its tools and its budget, and parts that run
  at the same time unless one waits for another. You change the plan and approve it once. Findings go on a
  shared scratchpad with their sources; a checker checks the draft against them and sends fixes back (two
  rounds at most); one result comes back as a message or a document. Sending, posting, buying and computer
  use are only queued during the run and wait for one final OK listing every action. Live progress, cost
  so far, Pause and Stop on the run's chat card and in Team → Team runs. Private chats use local models
  only. See docs/AGENT_TEAMS.md.
- Added: **help each other's Sara** (support link). Between two linked servers (Messages), the owner who
  needs help presses *Ask … for help* in their chat and gives a help pass for 1 hour, 1 day or 7 days
  (revoke any time). The helper can then *Look at …'s Sara*: what looks wrong, models, health, the
  self-test, recent errors, versions and app versions, and the last log lines, with keys, emails, tokens,
  message text and medical things removed. Never chats, memories, files, mail or messages. The helper (or
  their Sara, when asked "what's wrong with Hank's Sara?") can suggest a fix: a model, backup model, wait
  time or a few on/off settings, or a plain note. It arrives as a card with the exact change, and nothing
  changes until that owner approves it. No commands, no files, no remote control. Both owners see a help
  log, and each look and suggestion is in the audit trail. See docs/SUPPORT_LINK.md.

## 3.16.0 (2026-11-16): writing that sounds human, meetings, keeping in touch, trips

- Added: **write like a person.** A *Make it sound human* button on documents she made and on research
  reports shows a side-by-side view (what changed is marked, a "reads natural" score before and after)
  with Keep and Undo. Plain everyday words, varied sentences, no stock phrases like "delve" or "in
  conclusion"; every number, name, quote, citation and link stays exactly the same (she retries once, then
  keeps the original sentences). Ask in chat too ("make this sound more natural"). *Match my voice* learns a
  short style card from 1 to 5 samples of your own writing, kept in your own space. A default in Settings →
  You → About you → Writing style (Natural or As written). For kids it coaches (outline, questions,
  suggestions on their own draft) and won't write an assignment for them. See docs/WRITING_STYLE.md.
- Added: **Keeping in touch** on your People cards. For each person she shows the last contact on
  each channel (mail you sent and got, chat rooms she keeps up with, calendar meetings), who is waiting
  for your reply ("Dan has waited 2 weeks for your reply"), promises found in your own sent mail and
  chat replies ("I'll send you the slides by Friday", confirmed by you first), birthdays and
  anniversaries, and a keep-in-touch reminder for people you pick. Memory -> People -> Needs attention
  lists it most urgent first, Today has a People tile, and she can answer "who's waiting for my
  reply?". No message text is stored; one switch turns it off; forgetting a person removes all of it.
  See docs/PEOPLE.md.
- Meeting assistant (S2, docs/MEETINGS.md): record a Zoom, Teams or Meet call on this PC from the Windows app (your microphone and the computer's sound, after a consent notice she can say out loud), or give her any recording up to 3 hours (MP3, M4A, MP4, WebM, OGG, WAV; sent in parts). The transcript names Speaker 1 and Speaker 2 (by channel, or by pauses and pitch) with times; rename speakers, search the transcript and play the recording from any line. The notes add open questions and the matching calendar event; follow-up emails per attendee group wait for you to press Send. Meetings are heard on this computer unless you allow a cloud engine (Settings → Voice → Meetings). A Meetings tile on Today lists action items due this week; she can answer from your notes in chat (meeting_list, meeting_summarize).
- Added: **Trips.** Bookings Sara finds in your email (flights, hotels, rental cars, trains, event
  tickets, from every connected mailbox) become one timeline per trip, with each time in its own place's
  time zone; the same booking in two mailboxes shows once. A Trips page and a Today tile; Add to calendar
  and a packing list (a shared list, from the trip's length and the forecast) on a tap. A check-in
  reminder 24 hours before each flight and a leave-by alert for the airport from your leave-by settings.
  Flight status is off until you choose a source (AirLabs with your own free key): then delays, gate
  changes and cancellations go to your phone, and a cancellation or long delay lists rebooking options.
  She never books, changes or pays for anything. See docs/TRAVEL.md.

## 3.15.0 (2026-11-16): choices to tap, goals, research, ask anything, private messages

- New: **pick-an-answer cards.** When she asks you to choose between a few options, they show as buttons
  under her question: her recommended one first and marked, "Other, type it out" last, one or several
  picks. Your pick is sent as your own message. Works in the app (phone and desktop, keyboard and screen
  readers), as inline buttons in your Telegram chat and buttons in your Discord DM; everywhere else she
  sends a numbered list ("reply with a number or type your own"). A card closes once you answer or type
  something else. Never used for approvals. See docs/CHOICES.md.
- Added: **Goals over days.** Tell her something bigger you want done by a date ("get my house sale
  paperwork done by Dec 15") and she keeps a plan of milestones with due dates. A milestone can start a
  Planner task, a reminder, an errand (waiting for your Start) or an automation (made switched off). She
  checks progress on her own, nudges you the day before each checkpoint, proposes a new plan when
  something slips (nothing moves until you press Use the new plan) and sends a weekly summary per goal.
  A Goals page (progress bar, next step, history) and a Today tile. Every approval works as before. See
  docs/GOALS.md.
- Added: deep research reports. A research run can read your own files in her Library as well as the
  web (pick on the plan; without web search it researches your Library). The plan shows the budget and the
  most it may cost before you press Start. The report has a Summary, Findings with numbered sources, Open
  questions and *What I couldn't verify* (any sentence no source backs is listed there, marked unverified),
  and each source comes with a short quote. You get a notification when it is done. Runs from a private chat
  or in *Nothing leaves this computer* mode use only models on your own hardware and no web (a private chat
  may allow the web). See docs/RESEARCH.md.
- Added: **ask your whole life.** One question across your emails (every mailbox), files (Library pages and
  workspace files), past chats, calendars, notes, to-do and shared lists, and contacts. Type in the search box
  and pick **✦ Ask about anything in your life**: a short answer quotes each source with a number you tap to
  open it at the spot (the email with the quote marked, the document at its page, the chat at the message),
  and the matches are grouped by source. In a chat she uses the new `ask_everything` tool and cites [n].
  Private chats, forgotten messages and off-the-record chats are never searched; household members only
  search their own; kid mode keeps to its allowlist. See docs/ASK_EVERYTHING.md.
- Added: **Messages between linked servers.** Private chats between the people who own two or more Sara
  servers: link with a one-time code (works once, for 30 minutes) and unlink from either side; one-to-one
  chats and communities (the creator's server hosts it; anyone with its code joins; the creator and the
  moderators they pick can remove or ban, enforced by the host, and make a new code). Pictures and files
  up to 5 MB, edit and delete your own messages, read receipts and typing (each can be turned off), mute,
  block, leave, report to the creator, and a phone/desktop notification. Messages go straight from server
  to server, signed with the link's own keys, wait and retry while the other server is offline, are
  sealed at rest, and are kept 30 days by default (your choice, per chat too). Sara is not involved: they
  never reach her memory, her chats, a model, a tool or the logs, unless you press "Ask Sara about this".
  Owner only. See docs/MESSAGES.md.

- Added: hands-free computer use. Say "just do it" (or press **Let her finish this task** on the first
  card) and she finishes the task without a card on every click, across every site and app, for 15
  minutes, an hour or until you stop her (Settings → Computer use → How often she asks). Account and
  sign-in pages now ask once per task. The hard limits stay: passwords and codes are yours, payments ask,
  banking and password managers stay blocked, administrator prompts are yours. A banner with Stop and a
  step log show what she did. The Windows app confirms it once on its own card.
- Added: Add a calendar by link (Settings → Email and calendar): paste a Google, Outlook or iCloud private
  iCal link and its events show on Today and in answers (read only, checked every 15 minutes, the link kept
  in the vault).
- Added: Let her set it up for me (Settings → Gmail and Calendar): she makes your Google app in her browser,
  step by step, and you only sign in and copy two values.
- Fixed: computer use with smaller models: a changed page, an old look or a window in front makes her look
  again once and retry the same control; scrolling works without a ref (also inside scrolling panels) and
  says where she is; made-up tab ids and tool names find the right ones.

## 3.14.1 (2026-11-16): saved documents count as saved

- Fixed: a document she made and saved in the Library is no longer called "not checked" when she says so.
  Making a document (and filling a form, invoices, exports, edits in Docs/Sheets/Excel) now counts as proof,
  also in a later message, so pressing *do it now* no longer saved the same document again and again.
## 3.14.0 (2026-11-16): all your accounts together, and her own icon

- Added: several accounts together. Sign in to more than one Google account (Settings → Email and
  calendar → Add another Google account), each with its own permissions; calendars from every account
  (each Google account, Outlook, and iCloud / Fastmail / Yahoo through their app password) on Today, in
  the briefing, for the booking page and in the calendar tools, each event labeled with its account;
  a combined inbox (Today's Mail, searches and "waiting for my answer" cover every mailbox, labeled;
  pick which); replies go from the mailbox that got the email, and the approval card shows From:.
  New events ask which calendar unless a default is set. See docs/MAIL_ACCOUNTS.md.
- Fixed: **the desktop app's icon is your companion's, not Sara's.** A renamed companion without a picture of
  her own (for example Sara renamed to Hank with the default look) now gets a monogram with her initial on the
  theme's colors as the window, taskbar, tray, notification, Start-menu shortcut and Mac Dock icon, instead of
  Sara's face. With a picture or a look of her own, that picture is the icon, as before.
- New: the server makes her app icon at every size (`/app-icon.png?s=16…512`, `/app-icon.ico`, with an ETag
  that changes with her look and name). The browser tab icon, the installed web app's icons (manifest,
  iPhone home screen) and push notifications use it; the sign-in page keeps Sara's own icon.
- New: the Mac app's Dock icon follows her look too.
- Fixed: adding a mailbox on a server whose firewall redirects outgoing mail (cPanel *SMTP Restrictions*)
  now says so in plain words instead of *couldn't reach the mail server*.

## 3.13.1 (2026-11-15): her pictures with ComfyUI, sent where you choose

- Fixed: **Pictures from her with ComfyUI** no longer hang on *Making a picture*. The ComfyUI tool server
  (comfyui-mcp 0.5x) reports finished runs as text, which Sara didn't read, so she waited 5 minutes although
  ComfyUI was done in seconds. She now reads both forms, fetches the picture as soon as it is there, and stops
  at once with the reason when the run fails or saves no picture (*check it ends in Save Image*).
- Changed: **Send one now** runs in the background: the page shows *Writing the scene…*, *Making the picture
  in ComfyUI…* and then where it went, or why not.
- New: **Send her pictures to** (Settings → Sara → Pictures from her): a chat just for her pictures (the
  default, made the first time), one of your own chats, a chat in a project, or only your chat apps, plus
  *To my Telegram* / *To my Discord* (only when connected). Before, they went to whichever of your chats came
  first. The line under the choices names the places. *Also send them to my chat apps* became a chat just for
  her pictures + Telegram + Discord.

## 3.13.0 (2026-11-15): a calmer, premium Settings

## 3.12.0 (2026-11-15): work apps, family, trust and voice ready
- New: **Settings, redesigned (SETTINGS3).** Six groups plus Household instead of nine: *Sara* (named after her),
  *You*, *Models & usage*, *Connections*, *Skills & tools* (Coding is a sub-heading there) and *Privacy & system*.
  The list on the left shows the pages of the group you are in (51 entries instead of 82). Nothing was removed and
  every link still works: eleven small pages became sections of a bigger one (for example Leave-by reminders and
  When it comes up are now on *Briefing and reminders*; Subscriptions on *Providers and plans*; Budgets on *Usage
  and costs*; How she did, Readiness and recovery and Operations on *Health*; bringing her or your chats over on
  *Move in and export*), and the chat apps, your accounts, web search, data sources and the developer pages are
  tiles under *Connections → Apps and services*, each with a status dot.
- New: Settings opens on an **Overview**: her status, what needs your attention, quick switches (Night or Day, the
  morning briefing, calls from her, Hey Sara, tidy long chats), your connected apps and the household.
- New: **Search finds single settings**, not only pages: it shows where each one lives and what it is set to now;
  choosing one opens its page and highlights the row. **Ctrl K** inside Settings goes to the search.
- Changed: a calmer page layout: each setting is one row (its name on the left, the control on the right), rows sit
  in cards, a quiet *i* explains each one, switches instead of check boxes, "All changes saved" at the top, *On this
  page* on wide screens, and long pages keep their rarely used settings under **Advanced** (closed until you open it;
  remembered on this device; search opens it for you). Phones go Settings → group → page.
- The old group names (Her, Models, Chat apps, Add-ons, Coding, Data & health) still find their pages in search for
  one release and say where they went.

## 3.11.0 (2026-11-15): errands, an easy start and iPhone Shortcuts

- New: **Tools for household members** (Settings → Household → People on this server). For everyone, or one person: computer use, sending email, web search, errands and automations can each be allowed as usual, always ask first, or off; "every tool asks first"; and a daily cap for paid tools. Purchases, commands and coding are never available to members. Sara checks the rules on the server before every step, so a member can't get around them. See docs/ADMIN.md.
- New: Retention and legal hold can also limit how long run history, older log files and inbox scans are kept. A legal hold keeps them all.
- New: The restore drill also checks that every file in the backup came back.
- New: The audit trail can also be exported as one JSON file. Business mode: organization administrators can download the audit (sign-ins, invitations, roles, settings, exports) as CSV or JSON for a date range.
- New: Business company sign-in has **Test sign-in**: the whole sign-in runs in a new tab, even before you turn it on, and shows whether you'd get in, with which role, and which groups your provider sent. Nobody is signed in by a test.
- New: A one-page security overview for people deciding whether to run Sara (docs/SECURITY_OVERVIEW.md) and an admin guide (docs/ADMIN.md).
- New, switched off: **Phone calls** ([docs/PHONE_CALLS.md](docs/PHONE_CALLS.md)), in Settings → Connections → Phone and notifications. With your own provider account (Twilio or one with the same API), its number and a public address for this server, she answers calls in her own voice and places them. Your number reaches her with her tools; people you list talk with her; everyone else leaves a message that lands in the chat. Every call she places asks first on a card with the number, what she will say, the longest it may last and a cost estimate from the price you type in. Recording is off unless you turn it on, and then only after she tells them. Say "stop" to hang up. The transcript and a summary go to the errand or the chat. No number is bought; until it's all set up, she says what's missing and gives you the number and a script instead.
- New: errands' call steps use those phone calls when they're on (approve the call, she makes it, the step finishes with the call's summary).
- New: car mode errands. Start an errand by voice and answer her cards by saying "approve" or "no" (cards for computer use still wait for the computer); ask how your errands are going and she says where each one stands.
- New, switched off: Discord → **Voice channel**. Pick the server and channel now; it stays off because Discord voice needs a voice library Sara doesn't include yet.
- New: **Work apps** ([docs/WORK_APPS.md](docs/WORK_APPS.md)). Sara can read and edit your Google Docs and Sheets and your Word and Excel files in OneDrive or SharePoint, by link. Each needs one extra permission you turn on yourself (Settings → Gmail and Calendar → Docs and Sheets; Settings → Email and calendar → Word and Excel files). Every change shows the old and new text or cells and waits for your OK. She reads it back afterwards, and OneDrive keeps the old Word version. In Slack she can post, react, set your status, make a reminder and search messages. In Teams she can post where her bot already is. Posting always asks first.
- New: **Booking page** (Settings → You → Business details). A public link where people pick a free time with you. You choose when you're free, how long a meeting is, the gap between meetings and the most per day. Busy times come from your calendars and planner. You confirm each request, or let them confirm on their own. A confirmed booking goes on your calendar and the visitor gets an email from your mailbox. It's off until you turn it on. There's no captcha: a hidden box and a timing check stop bots, and there are rate limits.
- New: **Accounting export.** CSV files of your invoices, expenses and tracked time that QuickBooks Online and Xero can import, or one generic CSV. Get them from Business details, or ask "export last month for Xero". Files only: nothing is sent to an accounting service.
- New: **Automation templates.** Share any automation you made as a template (a file, also copied): it never holds your addresses, ids, keys or files; those become blanks. Import one from a file or pasted text, or start from 10 ready-made ones (weekly time sheet, bill reminders, package alerts, morning portfolio, team game alerts, Friday invoice hours, school newsletters to calendar, grocery reorder, birthdays, weekly review). You always see the preview first, and nothing is made until you tap Allow.
- New: **Document facts in six languages.** Sara reads renewal, expiry, due, lease-end and warranty dates, deductibles, premiums, rent and deposits in Spanish, French, German, Brazilian Portuguese and Italian papers too, with dates in the document's own order (03/04/2027 is 3 April there) and money as written (1.234,56 €).
- New: **Offline: Today, lists and shopping mode.** Without a connection you can read Today as it was last shown, and tick off your lists in shopping mode. Changes sync when you're back; if someone changed the same item on another device after you, the newer change is kept and a note says so.
- Better: **Accessibility.** The skip link is the first Tab stop, each chat message says who wrote it to a screen reader, approval cards are announced as one group, and 13 inputs that only had a placeholder now have a label. A built-in checker keeps it that way (docs/ACCESSIBILITY.md).
- New: **Family** ([docs/FAMILY.md](docs/FAMILY.md)), a place in the sidebar and a Today tile. Chores that repeat, assigned to someone and worth points or money; the kid taps "I did it" (a photo when asked) and a parent approves. Each kid has an allowance ledger (earned, paid out, balance); "Record a payout" only writes it down, Sara never moves money. Parents get a weekly summary on Sunday evening. She can do it in chat too (chore_add, chore_done, allowance_balance, allowance_pay).
- New: **kid-safe member mode**. Invite a child from Settings → Household (you confirm you are the parent or guardian), or turn it on for a member on Family → Kids. Adult content stays off, she talks in kid-friendly words, and computer use, shopping, mail, errands and outside apps are off, checked on the server for every request and every tool call. Optional bedtime, a daily time limit and safe web search (Brave or SearXNG in strict mode). Parents see the topics and minutes, never the words.
- New: the inbox helper reads school mail (school, district, PTA, teacher, newsletters) for early release, no school, picture day, field trips and events, and suggests adding each to a School list with a reminder the evening before. A permission slip becomes a "Sign and return" task with the form kept in the Library.
- New: grocery lists for the whole household (Family → Groceries): items grouped by aisle, a store per item, "Cheapest near me" for a few staples, and Shopping mode with big checkboxes for the phone.
- New: **Check everything** (Settings → Data & health → Health). One click checks mail, calendar, phone notifications, the desktop app, Mac tabs, the inbox helper, automations and which model answers and how fast. Each line says OK or what to fix, with a link. Ticked tests make a test draft, a test event or a notification and remove them again. Copy the results or send them in a problem report.
- New: Outlook emails can carry files up to 150 MB. Files over 3 MB go up in parts, with retries, and pick up where they stopped if the connection drops.
- Windows builds can be signed with Azure Artifact Signing. Signing switches on once the owner's account is set up (docs/ops/WINDOWS_SIGNING.md); until then builds say they are unsigned.
- Fixed: when the chat model answers with nothing twice and no backup model is set, another model you already use that has been answering well takes over once and says so, instead of an error.
- New: **iPhone without the App Store** ([docs/IPHONE.md](docs/IPHONE.md)). Settings → Connections → **iPhone Shortcuts** makes a token for each iPhone (shown once, with a QR code; Share and/or Ask; remove it any time). The page gives the exact steps, with your address and token filled in, to build **Share to Sara** (in any app's Share button: photos and files go to your Library and a new chat) and **Ask Sara** for Siri (a short spoken answer; a long task says "I'm on it" and you get a notification when it's done), plus a **Sara today** widget shortcut (next reminder, watches, what waits for you). The owner can add ready-made iCloud links that everyone on the server can get.
- New: The installed web app on an iPhone shows a badge with the number of approvals and inbox cards waiting for you, and Sara shows an "Add to Home Screen" guide when she's open in a Safari tab on an iPhone (notifications there work only from the Home Screen). A notification opens the item it's about.
- New: **Set up Sara in five minutes.** After your first sign-in, a guide walks you through five short screens: pick a model (Auto, with the speed check), connect your mail, connect your calendar, add your phone and add your computer. Each screen has one main button, can be skipped, and ticks itself once the thing is really connected. Where you stopped is kept; Today shows "Finish setting up Sara" until you're done, and Settings → You has Guided setup.
- New: **Show me with examples.** Example cards on Today (a bill, a package, a watch, a decision and an invoice), each marked "Sample data", with a short tour. They are kept apart from your own data, and one press removes them all.
- New: **Starter packs**: Household, Small business, Sales and Student. A pack picks your Try cards and the order of Today, adds a few routines (off until you press Allow) and tells her what you use her for. Choose one during setup or in Settings → You; pick None to undo it.
- New: **A download page** at your Sara address + `/download` (no sign-in needed). It sees your device and offers the right download from the latest release, with plain install steps: Windows (with the SmartScreen note while the installer isn't code-signed), Mac, Android (Google Play), iPhone (Add to Home Screen) and Linux.
- New: **Errands, start to finish.** Give Sara a goal ("get this charge refunded", "book an oil change this week", "find and book a plumber", "cancel my subscription", "get quotes from 3 contractors") and she plans it, works through it step by step with your mail, forms and browser, follows up when nobody answers, and shows her progress on the new Errands page and a Today tile. She asks before every email, form and choice; payments are always yours to make; calling isn't switched on yet, so she gives you the number and what to say. Budgets and deadlines stop an errand with a summary. See docs/ERRANDS.md.

## 3.10.0 (2026-11-14): everywhere you are, knows your world, works with your team

- New: **What Sara knows** (Settings → You). See what Sara keeps about your world, grouped: people and family, home, vehicles, health, work, money and dates. Each fact says where it came from: something you said (with a link to the chat) or a Library document (with the page). Edit, delete, or mark a fact "not true" so she forgets it. Account and policy numbers keep only their last 4 digits. Card and Social Security numbers are never kept. Health facts are marked private.
- New: **Ask your documents.** Ask "what's my deductible?" or "when does my lease end?" in a chat or on that page. Sara searches every Library file and answers with the exact words, the file and the page. When nothing answers, she says it isn't in your documents.
- New: Renewal, expiry and due dates in your documents become cards ("From your documents") on Today and on that page. Accept adds a reminder 30 days before (3 days before a due date). Nothing is added unless you accept.

## 3.9.0 (2026-11-14): from your inbox, and forms filled for you
- New: **The Sara app for Mac catches up with Windows.** On a Mac she can now list your own browser tabs
  (Safari, Chrome, Edge, Brave, Arc) and bring one to the front when you allow it, behind a new switch, "Let
  Sara see my tabs"; macOS asks once for each browser. She can read your files (read only) with the same
  choice of folders as on Windows, run zsh commands that you approve on the Mac in a card that never takes
  the keyboard (never as administrator; Stop ends everything the command started), and save the files she
  made to Downloads or a folder you pick. The Mac app also updates itself: it checks the same signed update
  notice as Windows, downloads the new Sara.dmg, checks it and swaps Sara in Applications after you quit (or
  from "Update Sara app" in the menu bar). It reports its version and macOS version in Settings → Devices.
- New: **Work and teams.** Share a household list (groceries, chores) with people by name, give items to someone with a due time (they get a notification), and see who ticked what off. Only lists you share are visible to others. Today shows "Shared with you".
- New: a light **client pipeline**: lead, quoted, won, invoiced, paid or lost, with value, next step and hourly rate. Making a quote or invoice and marking it accepted or paid moves the client on by itself. Follow-ups list due next steps.
- New: **time tracking**: start and stop a timer or log hours, reports by client, project or day (also as a spreadsheet), and "invoice my hours for Acme" (hours times the client's rate; billed hours are never billed twice). The weekly time sheet can use tracked time instead of, or with, the calendar. Today shows the running timer, this week's hours and the pipeline. See docs/WORK_AND_TEAMS.md.
- New: **Share to Sara** from any app on your phone. Photos, PDFs, Office files and links go to her Library, and a new chat opens with a ready message (a photo of a receipt suggests adding it as an expense). Works from the installed web app (share target) and from the Android app's share sheet.
- New: **Buttons on notifications.** Approve or Decline a plain approval, Snooze a reminder for 1 hour, Reply to her messages (typed right in the notification where the phone allows it), Accept an inbox card, and answer an automation that waits for your OK. Each button carries a one-time key that only works for that item, for a short time. Approvals for computer use still happen on the computer itself, never from the phone.
- New: **Car mode** (+ → Car mode, or say "car mode"). One big Talk button, her answers spoken and at most two sentences, no screens of text, no computer use or long tasks, and "read my messages" reads her newest ones aloud. It turns off by itself after 2 hours without use.
- New: the Android home-screen widget also shows the next reminder, how many watches are on, and a Talk button.

## 3.8.0 (2026-11-14): gets it right, and runs on its own
- New: **My details** (Settings → You). Keep the name, addresses, phones, sizes, vehicle, insurance and loyalty numbers that you type into forms again and again. Sara refuses to keep passwords, card numbers or SSNs. With the desktop app, Sara can fill a web form in your own browser from these details. One card on your PC lists every field and value first. She skips password and card fields, reads the values back, and stops before Submit.
- New: Emails and drafts can carry files from your Library: Gmail and IMAP up to 20 MB, Outlook up to 3 MB. The check after saving a draft lists the attached files. An invoice's "email it" and the time-sheet automation's draft now attach the file.
- New: **Check in my browser.** When a store blocks Sara's product search, she can check its price, stock and pickup in your own browser on your PC, with your store and sign-in, if you approve each step. She closes the tab afterwards. Product watches can do the same while your PC is on and idle.

- New: **From your inbox.** New email in your connected mailboxes becomes one-tap cards on Today: a
  bill goes to Bills, a receipt to Expenses, a shipping email to package tracking (status updated from
  later emails, alerts on the delivery day, out for delivery and delivered), a flight or hotel to a
  trip with calendar entries, a check-in reminder and a leave-by reminder, an appointment to your
  calendar, a "paid" email to your invoice, and attachments to a Library folder. Suggestions only
  until you turn on "do it for me" for a kind (Settings → Email and calendar → Inbox helper); then
  Today shows what was done with Undo. Rules and the booking data in airline, hotel and shop emails
  do the reading; a small model only for unclear mail, never in private local mode. She never sends
  email or pays anything from here. See docs/INBOX_HELPER.md.
- New: **Auto (recommended)** for Talking, Coding, Looking at pictures and Web research in Settings →
  Models. Auto picks from what is connected: tool support, can it see, on this computer or not, how
  fast each model really answered here, recent errors and your spend limit. When the pick errors,
  stays empty or says nothing for 45 seconds, the next-best model answers once and a small note
  says so. Private chats only use models on this computer. Each reply shows "(Auto)" with the
  reason. New installs start on Auto; existing setups keep their choices (the model notice offers
  Auto, with Undo).
- New: a "did it work?" check after every change she makes: files are read back, documents and
  forms use their own report, Gmail drafts, sent emails and calendar events are read back by id,
  tasks are read back from the planner, commands on your PC need exit code 0, desktop actions keep
  their fresh look. "Done", "saved", "sent" or "added" in her reply now need a verified result,
  otherwise she corrects herself.
- New: **How she did** (Settings → Data & health, owner only): failed, slow and empty replies, backup
  models that took over, refused desktop actions and changes she couldn't check, with the top
  failure reasons, links to those chats and tips. The weekly review gets a small card with the
  counts. Stays on this computer.

- New: Automations, one place (Settings → You → Automations). "When ___, do ___": on a schedule
  (daily, weekdays, chosen days, a day of the month, in your time zone), when an email or a webhook
  arrives, when a price, score, product or file watch fires, or minutes before a calendar event; then
  tell me, ask Sara to do a task, draft an email, fill one of your forms, run a recipe, or add a bill
  or an expense. Your watches, event triggers, routines and repeating reminders are listed on the same
  page with their own switches. Make one by asking ("every Friday at 3, fill my time sheet from my
  calendar and send it to me"): the card shows exactly what will run, the next three times and the
  approvals, and takes one Allow. Try it runs without doing anything. Changes still ask (a run waits
  for your Allow), drafts are never sent unless you turn that on for one, the last 50 runs are kept,
  and three failures in a row pause it and tell you why. A Today tile appears only when one failed,
  waits for you, or runs today. Starter: Fill my time sheet every week. See docs/AUTOMATIONS.md.
- New: Sara checks whether the talking model suits this computer. A model bigger than 3 billion
  parameters running on the processor (no graphics card), replies that usually take over 30 seconds,
  or a model without tool support get a plain notice in Settings → Models → Default model and in
  the full check ("Chat model speed"), with up to three faster choices from what is connected
  (Ollama Cloud models first). **Use this** switches the talking model, with Undo; nothing switches
  by itself.
- New: the first-run guide on a computer without a graphics card picks an Ollama Cloud model over a
  big local one when your Ollama has one, and says why.
- New: *Try something new* on Today: one card per everyday area (fill in a form, watch a stock or
  team, find something near me, help me decide, make an invoice, check my spending), shown only when
  this server has the tools for it, until you use it or press ×. Each starts a new chat with the
  first message written for you; new chats show two of them as suggestions too.
- New: the full check has lines for the live data sources (stock prices, sports, odds): a missing
  optional key, and whether the chosen source answers.
- Fixed: the Watching tile's rows on Today were filled accent buttons with a hard-to-read second line;
  they now use the calm row look.
- New: money (information and math, not advice). Give Sara your brokerage's positions export
  (Fidelity, Schwab, Vanguard, Robinhood, E*TRADE and others) or a list like "AAPL 10 @ 150" and ask
  how your stocks are doing: value now, today's change, gain against what you paid and each
  holding's share, with the price source and time. Your bank or card exports (CSV, Excel, OFX, QFX)
  become a budget: categories you can correct once ("Costco is groceries"), monthly totals against
  the month before, top merchants, a subscription finder with next dates and yearly costs, and
  optional monthly limits that tell you once when passed. Bills get a Planner reminder a few days
  before they're due. The morning briefing adds a portfolio line, and Today a Money tile once you use
  any of it. See [docs/MONEY.md](docs/MONEY.md).
- New: "tell me when Dana emails" (or when mail with certain words arrives): a watch on your
  connected mailboxes, checked every 10 minutes, telling you the sender and subject once per message.
- New: sports and odds, tracking and math only. Follow your teams ("follow the Chiefs"): alerts when
  a game starts and ends, optionally when it's close late on or when the point spread moves; their
  games go into Sara's planner (or your Google or Outlook calendar when you ask) without duplicates,
  and a moved game is moved; ESPN headlines and injury reports; a line in the morning briefing and a
  "My teams" tile on Today. Compare a game's lines across sportsbooks (best price, fair odds, each
  book's cut), an odds calculator (formats, implied probability, expected value, Kelly, parlays), and
  your own bet log with bankroll, profit, ROI, win rate and closing-line value; settle a bet from the
  final score when you want. Optional limits you set yourself (weekly loss, most per bet, cool-off)
  are said plainly when crossed; logging is never blocked. She never places bets or links to a
  sportsbook. See [docs/SPORTS.md](docs/SPORTS.md).
- Fixed: the Windows app noticed a new version late when its server updated before the signed
  update notice was published; it now looks again after 15 minutes (doubling up to 4 hours).
- Fixed: a command you stopped reads "Stopped" in her step line and the run view, not "Didn't work".
- Fixed: the Ctrl+Enter hint under Interrupt now is hidden on phones and other touch or narrow screens.
- Improved: a reply you interrupted folds under "She was saying…" with its first words (about 80 characters) as a preview.
- Fixed: the MCP tools update_note and delete_note now say that the old text is kept as an earlier
  version and that a deleted note can come back for 30 days (true since 3.4.2).
- Fixed: a text-only model in the Looking at pictures (or Screen) slot, as its provider's model list
  says (for example a Grok text model through the xAI API), is skipped for the next model that can
  see, and Settings → Models says which model gets the pictures instead.
- Developers: `npm run hydrate:tools` installs the developer tools' own packages that some tests
  import; `npm run typecheck` names the missing ones instead of failing with "Cannot find module".
- Changed: a PDF with letters its built-in Latin fonts can't show (Greek, Cyrillic, Chinese, Arabic,
  ...) is no longer made full of "?": she names the letters and offers a Word document instead.
- Fixed: the card for a product search is titled "Shopping: …" instead of "Web search: …".
- New: a table question grouped by a column (for example spending per category) shows a bar chart
  under the answer in the chat.
- New: "How are my stocks doing?" also lists each holding's next earnings date and latest three
  headlines (Yahoo Finance, no key needed), with the time they were checked.
- Developers: `npm run guide` regenerates the guide's generated parts; `npm run check` now fails
  with that instruction when web/howto.json, the dials or the / menu changed without it.

## 3.7.0 (2026-11-13): decisions and business tools

- Fixed: on Windows, approving a click in a pop-up (like Edge's "Remove ... from Microsoft Edge?"
  confirm, a menu or a dropdown) no longer closes that pop-up before Sara can press it. The approval
  card no longer takes focus from the window you were using (answer it with the mouse; Stop and
  "closing means Don't" work as before).
- New: a decision helper. Tell her the options and what matters (or she asks), and she weighs them
  with the math shown: every score says where it came from (you, a named source, or her estimate,
  flagged), raw prices and other values are scaled per criterion, and she says when it's a close call
  or when one small change would flip the winner. A short "what could go wrong / how to undo it"
  follows. The chat card ranks the options with bars and has "I chose this" and "Save as document".
  Decisions are saved (each household member's are their own); pick a date and the planner asks you
  later how it worked out, and the next similar decision recalls what you chose last time. Also new:
  side-by-side comparisons that mark missing values instead of filling them in. See
  [docs/DECISIONS_HELPER.md](docs/DECISIONS_HELPER.md).
- New: invoices and quotes. Ask "make an invoice for Rivera Co: 10 hours at $85" and she numbers it
  (INV-2026-0001), works out the totals and makes a PDF or Word file, or fills in your own invoice
  template. Tell her when it was sent and paid: she reminds you the day before it is due and if it is
  3 days late. Your name, logo and how to get paid are in Settings → You → Business details. She never
  emails an invoice herself; she can write a draft for you to send.
- New: "who do I owe a reply". From your connected mailboxes, the people still waiting on you (no
  newsletters or automatic mail), questions first, plus to-dos that are due; she drafts replies for you
  to review.
- New: she reads contracts and leases: parties, dates, the last day to give notice, money, late fees,
  and clauses worth a second look, each with the exact sentence and page. A reading aid, not legal
  advice.
- New: receipts to an expense report (Excel or PDF, totals by category), with the same receipt caught
  twice; meeting notes to action items with owners and dates.
- New: a small "Money and replies" tile on Today once you use these.
  Details: [docs/BUSINESS_TOOLS.md](docs/BUSINESS_TOOLS.md).
- New: live data from free sources. Ask for a stock price, a score, a team's next games, standings or
  betting lines; she names the source and the time with every number and says plainly when a source
  doesn't answer. Stock prices come from Yahoo Finance (no key), sports from ESPN (no key), odds from
  The Odds API with a free key, with implied and no-vig probabilities. Choose sources, paste free keys
  and test them in Settings → Add-ons → Data sources.
- New: "tell me when". A price crossing a number or moving a % in a day, a game starting, ending or the
  score changing, an odds line moving: she checks in the background and tells you once per crossing
  with a chat card and a notification. Watches share one budget so free allowances last, pause with a
  note if one runs out, and are listed on Today under Watching.
- New: exact totals from your own spreadsheets. Ask about a CSV or Excel file in your Library or in the
  chat ("what did I spend on food in March?") and she computes sums, averages, counts and groups with a
  built-in engine; the numbers come from the file, never from guesses.
- New: find it near me. Ask where to buy something and Sara checks the stores near you
  (OpenStreetMap) and the big retailers' own pages (Walmart, Target, Home Depot, Lowe's, Best Buy,
  Walgreens, CVS, AutoZone, Amazon and more) for price and stock, one page at a time, and gives a
  short ranked list with distance, pickup or delivery when shown, the link, where each fact came from
  and when. Sites that block her are listed with the reason, the store's phone number and an offer to
  check in your own browser. She never buys. Product watches tell you when something is back in
  stock, under a price, or changes (checked at most every 6 hours). Guide: docs/SHOPPING.md.

## 3.6.5 (2026-11-12): PDF forms too

- New: she fills in your fillable PDF forms too (text boxes, check boxes, radio buttons and drop-down
  lists). She finds each field by its name, its tooltip or the words printed next to it, writes the
  values into a copy that keeps your original file exactly as it was with the values added at the end,
  reads the copy back, and says "Filled 6 of 6 fields" or which ones she couldn't fill and why.
  Read-only and signature fields are left for you. Password-protected PDFs, XFA forms and PDFs without
  fillable fields are not filled; she says why and offers a new document or an Excel or Word version.
- New: when she reads a fillable PDF from the Library she also sees its form fields and their values.

## 3.6.4 (2026-11-12): busy web apps work

## 3.6.3 (2026-11-12): she fills in your own forms

## 3.6.2 (2026-11-12): she does it for you

- New: she fills in your own forms. Give her an Excel or Word form or template (a time sheet, an
  application) and the values; she writes them into a copy of your file that keeps its layout,
  formatting and formulas (the original isn't changed), reads the copy back to check every value,
  and says "Filled 23 of 23 fields" or exactly which ones she couldn't fill and why. PDF forms are
  not supported yet.
- Fixed: a spreadsheet she made from a write-up lost lines like "EMPLOYEE NAME: Kent" written above
  or below the table; they now go on the sheet as label and value cells. A table row with more cells
  than its header is sent back to her to fix instead of shifting the totals into the wrong column.
- Fixed: in busy web apps (Outlook on the web, Gmail, Teams, Google Calendar) her clicks and typing often
  stopped with "the page shifted" because a clock or an unread count changed somewhere else on the page.
  Now she checks only the control she is about to use: it must be the same one, with the same name, still
  enabled. She acts where it is now, and anything else on the page may change. Drags and clicks on a
  picture point keep the stricter check. If that control itself changes, she says it is her own safety
  check (not the website), looks again once and tries again, asking you again if needed. Text typed into
  a web page's rich editor (an event or mail body) now reaches the page.
- Fixed: a reply could fail without a word. Some models (seen with beam:cloud through Ollama) answer
  with only their private thinking; she now asks once more for a plain answer. A model writing a tool
  call as text runs it as the real call, and thinking tags never stay in her words. Every failed reply
  now leaves a notice in the chat with the reason, Try again and Report it, and the server log says why.
- Fixed: Report a problem said "The support desk didn't answer" while the desk was there and turned
  the report down (the report carried a field it doesn't take, and an empty description). Reports now
  send only what the desk accepts, and a refusal shows the desk's own reason (also in the log).
- New: ask her to report a problem for you. She drafts it with the last error, shows you the whole
  draft, and sends it only after you allow it.
- Windows app: the app's check-in now says how it draws the top of its window (who draws the title
  strip, its colour, light or dark), shown in Settings → Devices, so a white bar on another PC can be
  pinned down. The page now repeats that it draws the title strip with every theme change and after
  a page comes back from the browser's back/forward cache.
- **She does it for you instead of "do it yourself":** if you could do it on your computer, she offers to do it, with your approval on that computer for anything that changes something. After a check-up, "take care of #3 and remove them" now removes the browser extensions you named: she opens your browser's extensions page, presses Remove and confirms, each step allowed by you on the PC. The other check-up suggestions work the same way (a startup app that starts for everyone, files you pick from Downloads to the Recycle Bin, the browser cache, old temp files, a restore point).
- **Your browser's own settings pages:** she can act on pages like edge://extensions, chrome://extensions and about:addons (always asking), and type an address into your browser's address bar. Your browser's passwords, payment methods and sync/account pages stay off limits.
- **Settings app:** she can use the Apps (Installed apps, Startup, Default apps) and Storage pages, always asking. Accounts, sign-in, privacy, Windows Security, BitLocker and the firewall stay off limits.
- **Administrator prompts:** she never answers them. When one is needed she tells you "Windows will ask you to allow this change — press Yes" and waits.
- **"I can't" says why:** when she can't do something, she says exactly what's missing (which switch and where, an app update, or which hard limit) and offers the next best step. Words like remove, uninstall, clean or disable about your computer now bring her the tools to do it.

## 3.6.1 (2026-11-12): using your apps is fast

- **Using your apps is fast again:** an approved typing step into an app could take minutes and leave her slow to read your tabs afterwards. Listing windows read the Sara app's own window titles in a way that waits for its busy screen thread; it now reads them without waiting (seen live: 2.5 minutes before, 4 seconds after).
- **Switch to one of your browser tabs:** she can bring one of your open tabs to the front (you allow it on the PC), then look, click and type there; tried live: switch tab, click a link, the page opened.
- **Windows behind others:** she can prepare an action on a window that's behind other windows; after your Allow the app brings that exact window forward and checks everything again.
- **Your own browser pages:** her element list now reaches into the page in your browser window (links, buttons, fields), so text-only models can act on page content too.

## 3.6.0 (2026-11-12): her own face and the whole computer

- **She knows everything she can do on your computer, and uses it:** asked "what can you do on my computer?" she lists it plainly (see your whole screen and windows, read your browser tabs, click and type in your apps after you allow it on the PC, run commands you approve, read your files). Questions about your screen, apps, programs, windows or browser now bring her the screen and app tools instead of only the files tool.
- **Files beyond three folders (Windows app):** Settings → Computer use → Files → *Which folders*: Desktop, Documents and Downloads (default), those plus folders you pick, your whole user folder, or all your drives. Always read only; system folders, other people's folders and places that hold keys, passwords, browser profiles or wallets stay out; only the folder names reach the server.
- **Your own browser:** she reads your open tabs and can look, click and type in your browser window that's in front, with your approval on the PC. Payment, account and sign-in pages always ask; she never types passwords; banking and password managers stay blocked. (Switching to another of your tabs is built and held back until it is fast and reliable.)
- **Desktop actions after Allow:** the app brings the approved window to the front reliably (Windows blocks this from background apps; it now asks correctly), and a window's title-bar menu getting a new internal id when it comes forward no longer makes her look again.
- Fixed (Windows app): a white bar across the top of a dark window. With "Follow the system", the page
  and the app could disagree about light or dark; the page's light top colour was then kept for Night
  and painted above the dark page on every start. The app now follows what the page really shows,
  ignores a kept colour that doesn't fit its theme, and no longer turns Mica back on from an old
  setting. desktop.log says which Windows it is (edition and build), light or dark, accent colour on
  title bars, high contrast, and what the frame shows and why.
- New (Windows app): a renamed companion with a look of their own is the app's face: the window,
  taskbar, tray (also the Hey Sara dots), notifications and the app's own Start-menu, desktop and
  taskbar shortcut show their picture, and the window title is their name. Each server keeps its
  own; Sara with her own look keeps the Sara icon.
- New: Settings → Devices shows each app's Windows edition and build (the app sends it when it checks in).

## 3.5.1 (2026-11-12): typing always reaches her

- Fixed (Windows app): typing sometimes went nowhere. When the window came to the front without a click
  in the page (at start, from the taskbar or Alt+Tab, when an approval card or the computer-use badge
  went away, or when it opened behind another app), Windows gave the keyboard to the window's frame,
  which drops it, while the message box still showed its cursor. The app now always hands the keyboard
  to the page (and the same for quick ask). Checked on a test build with real key presses: at start the
  keys used to land on the frame (lost) and now reach the page; after a turn that listed computers,
  read Downloads and looked at the screen, typing still lands.
- Quick ask over Sara's own window now picks up the text selected in her page (or in the message box)
  and shows it as "From Sara: “…”", masked and capped like text from other apps. Her other windows
  (approval cards) are still skipped.
- Quick ask says "Nothing selected in Notepad" (in a muted line) when it looked in the app in front and
  nothing was selected, so you know it looked.

## 3.5.0 (2026-11-11): a desktop app that does more than the browser

- **New: the Windows app updates itself.** Most useful for the app on its own (*Connect to a Sara
  somewhere else*), which nothing updated before. It checks Sara's signed release notice by itself
  at start and every 6 hours (and when its server is newer), downloads the new app, checks it
  against the notice and installs it when you quit the app or nobody is using the computer, never
  while Sara is using it. Your sign-in and settings stay. Turn it off on Settings → This computer;
  then the window and the tray say *Sara app X is ready* with Update now and Later. A download that
  doesn't match is deleted; a failed install keeps the old app and says so, with the download page.
  The first time, apps from before this version still need one update by hand.
- **New: Settings → Devices shows each Sara app's version**, with **Update it** when it is older
  than the server. The owner also sees household members' apps; members see only their own.
- The Mac app doesn't update itself yet (download the new Sara.dmg as before).
- **New: works offline.** When her server can't be reached, the app, the browser, an installed web
  app and the phone apps show the 30 newest chats (their last 200 messages) and your notes, read-only,
  under "Offline — showing what this device kept (as of 10:42)", instead of the bare "Can't reach your
  Sara" page (which now hands over to the kept copy). Messages written meanwhile wait as *Waiting to
  send* bubbles you can edit or delete, and note changes as additions; when the connection is back
  they are sent in order ("Back online — sent 2 messages"). Each carries its own key, so a reconnect
  or a dropped answer never sends anything twice (the server stores the key with the message, and
  `POST /api/notes/add` adds to the end of a note, never overwriting). The copy is encrypted by the
  browser, kept per server and per person (another household member signing in on the same browser
  deletes it first), never includes off-the-record chats (private chats only if you allow it), and
  signing out deletes it. *Keep a copy on this device for offline* (Settings → Connections → Devices
  and sign-in) is on by default in Sara's apps and installed web apps and off in a plain browser tab,
  which may be a shared computer. See docs/OFFLINE.md.
- **New: Sara can run commands on your own computer (PC tools; Windows app).** Off by default: in the
  Sara app, Settings → Computer use → *Let her run commands on this computer*. Then `pc_run` runs
  one PowerShell or cmd command there (a folder, a timeout up to 10 minutes, output capped) and
  `pc_open` opens a web page, a file or folder, or an installed app. Every command is shown on that
  computer first (*Allow once / Allow for this task / Don't*; a phone can't approve), with the same
  choices as desktop actions; commands that delete, change settings or download and run things
  always ask; an opt-in short list of read-only commands (like `dir`, `git status`) can run without
  asking. Never as administrator; Stop (the chat card, the badge, Ctrl+Alt+Esc) ends the command and
  everything it started; key-shaped text in the output is hidden; both the computer and the server
  keep a log. The chat shows the command with its output as it comes, and Stop. Household members
  never get these tools. Older apps say to update; the Mac app can't yet. Design:
  [docs/design/PC_TOOLS.md](docs/design/PC_TOOLS.md).
- Windows app test runs are keyed by their own test folder, so two test runs on one PC don't stop
  each other.
- **Drop files anywhere on her window.** Files, whole folders (their files, up to 20; hidden ones
  left out), pictures, text and links from a browser: a full-window "Drop to give these to Sara"
  shows the limits, and everything lands in the message box with the usual checks. Nothing is sent
  until you press Send. A file that is too big says the limit plainly ("the most she takes is
  100 MB"). Works in the browser too. In the Windows app, dropping on the quick ask puts the files in
  the main window, and a folder from Send To or `Sara.exe <folder>` gives its files.
- **Save her documents to your PC (Windows app).** Documents she makes, files she shares and Library
  documents get "Save to…" (the Windows Save window, which remembers the last folder) and "Save to
  Downloads", then Open and Show in folder. Settings → This computer → "Put her documents in a folder
  automatically" saves each new document she makes into a folder you pick (Documents\Sara at first)
  and says "Saved Report.docx to Documents\Sara". The folder stays on your computer; her server only
  sends the file, and household members only get their own. In a browser the Download links stay.
- Document cards can be dragged out to a folder in browsers that support it (Chrome, Edge).
- Test runs of the Windows app (test builds) now keep one instance per test data folder, so test
  runs from different working copies never meet.
- **New in the Windows app: quick ask brings what you selected.** Select text in any app and press
  the quick-ask shortcut: it shows up as a chip ("From Notepad: “…”") under the question, with ✕ to
  remove it, and goes with your question when you press Send. Sara reads the selection through
  Windows' accessibility interface; for apps that don't offer it she copies it and puts your
  clipboard back exactly as it was (if she can't put it back exactly, she doesn't copy). Never from
  a password field, her own windows, or a window hidden from her (password managers, banking, your
  own list). The tray's "Quick ask includes selected text" switches it off.
- **New: "This window" in quick ask.** The picture button adds one picture of the app you were in
  (the same capture, blacking-out and password boxing as Sara on this computer), shown as a
  thumbnail chip you can remove; nothing is sent until Send.
- **New: push-to-talk and spoken replies without a browser tab.** Hold the talk shortcut
  (Ctrl+Alt+Space unless you changed it) to talk: she records while you hold it, sends when you let
  go, and Esc throws it away. A tap works as before. "Speak her replies" in the tray (off by
  default) has her read typed quick-ask answers aloud from the app itself, with the main window
  closed; it follows her voice settings, private local mode and your quiet hours. A small pill
  above the clock shows when she's listening, thinking or speaking (click it to stop her).
- **Fixed: her spoken replies in the quick-ask window were silent** (the window's security policy
  blocked the audio).

## 3.4.5 (2026-11-11): quick replies from models on a processor

- **Fixed: a model on a computer without a graphics card took minutes per reply (since 3.4.1).**
  Sara asked Ollama for a 32k context everywhere, so a small model running on a processor (for
  example qwen3.5:4b on a server) read a huge prompt every turn and the chat showed the thinking
  circle for minutes. Sara now asks each Ollama where it runs the model (its own list of loaded
  models): on the processor she asks for 8k (16k with "Full window") and keeps the conversation
  memory to what fits, so replies are quick again. An Ollama on another computer counts as small
  until it says it has a graphics card; Sara's own graphics card no longer counts for another
  computer. On a graphics card that's nearly full (other models loaded) she doesn't ask for more
  than the model already has.
- **New: a plain notice when a model is too slow.** If no word has come after 45 seconds on an
  Ollama that runs on the processor (90 seconds anywhere else), the chat says so, with Fix it
  (Which model does what), Keep waiting and Stop.
- **Tidying a long chat never waits long for a local model.** A local summary gets 30 seconds;
  if it fails or runs out of time, the quick model (or the plain summary) takes over at once.
- The Long conversations setting says when a model runs on the processor: "qwen3.5:4b on Ollama
  on the server runs on the processor: she keeps about 3,000 words in mind (kept small so replies
  stay quick)."


## 3.4.4 (2026-11-11): interrupt and tell her now

## 3.4.3 (2026-11-11): she reads the pictures you send
- **Interrupt and tell her now:** while she works you can now cut in at once instead of waiting for
  her next step. Send ▾ → *Interrupt now*, Ctrl+Enter (⌘+Enter on a Mac), *Interrupt now* on a
  waiting note, or `/now <text>` in Telegram, Discord and plugin chats. She stops what she is writing
  or thinking right away, keeps what she had written (folded under *She was saying…*), keeps every
  finished step, and answers your message. A read, search or page fetch in progress is cancelled;
  anything that changes things (file edits, commands, emails, payments, computer actions) is never
  cut off halfway: she stops as soon as it is done, and the note says what she is waiting for, with
  *Stop the command* for a command. A waiting approval card still needs Allow or Deny. Settings → You
  → *While she's working* has a third choice, *Tell her now, right away*; the default stays *at her
  next step*, so nothing changes until you pick it. Esc in the empty message box stops her.

- **Photos of documents reach a model that can see them:** a screenshot of lab results sent in a chat
  that had turned adult went to the adult model with only a "photo shared" note, even when that model
  was the very model behind *Looking at pictures* and could read it, so she played along instead of
  reading it. Now every model that can see gets the photo: the *Looking at pictures* models, and any
  model whose provider says it can see (Ollama's and OpenRouter's model lists are checked).
- **She reads it when her model can't:** when the model she is talking on can't see pictures, a model
  you set up that can (the *Looking at pictures* model first, then another of your models whose
  provider says it sees) reads the picture into text for her: every row, number, unit, range and date
  exactly as written. You see which model read it, and the text stays with your message, so she still
  has the values later. Private conversations only use a model on your own computer for this; a model
  you never picked for anything is never sent your picture.
- **She says so when nothing can see it:** if no model you set up can see, she tells you plainly (*I
  can't see pictures with the current model ... Fix it: pick a model that can see in Settings → Which
  model does what → Looking at pictures*) and is told the picture did not reach her. A reply that acts
  as if she is looking at it ("my eyes scanning the image") gets the *Not checked* line and she
  corrects herself.
- **Document photos become notes:** she is told to copy the text of a document photo exactly and, when
  you want it kept, to save the values with `note add` and say which note they are in. Later turns on a
  model that can't see the photo are told which model saw it, so she doesn't take the saved values for
  made up; "I saved it in note #3" after an earlier turn's save is no longer flagged.

## 3.4.2 (2026-11-11): notes that never lose what you told her

- **Notes no longer lose what you told her before:** when you kept sending results for one note (for
  example medical records), each save replaced the whole note with only the newest result, so earlier
  ones were lost. Now she adds each thing you share to the end of the note as a dated entry
  (`note add`, by note number or title, making the note if there is none) and never touches what is
  already there. A rewrite that would erase most of a note is refused with a plain message unless she
  read the note first and really means to rewrite it. On an update the title only changes when a
  short title is given, so a sentence of the note can't become its title any more.
- **Every note change is kept:** each edit, rewrite, add, restore or delete keeps the text the note
  had just before. In Planner → Notes, *Earlier versions* lists them with *Restore* (the text it has
  then is kept too), and she can do the same (`note history`, `note restore`). A deleted note can be
  brought back for 30 days. Versions only exist from this release on: text lost to the old
  overwrites before it can't be restored this way. If a note is missing things you told her, ask her
  to rebuild it from the chat; she adds them back with `note add`.
- **"I've saved it" now has to be true:** a reply that says she saved, noted, recorded, logged or
  added something you shared ("I've saved your results", "it's in your medical records"), with no
  note or file tool in that turn, gets the *Not checked* line with **Ask her to really save it**. She
  is also told to call `note add` every time you share something to keep and to say which note it is
  in. The secrets check now also looks in notes' earlier versions.

- **Windows app: no more light (or dark) bar across the top of the window:** above the page, the
  app paints a thin resize band and the place under the minimize / maximize / close buttons
  itself, and it always used Sara Classic's background there. Every other palette (Graphite, the
  default, Nord, …) has another top colour, so in Day a cream-white strip and box showed over the
  page (in Night a dark one, plainest with Nord or Slate). The page now tells the app the colour of
  its top edge with its theme, and the app paints that (remembered for the next start). Needs both
  this server and the new Windows app; with an older one of the two it looks as before. See
  docs/desktop.md.
- **"Look at my browser tabs" and "look at my files" now mean yours:** through the Sara app on your
  computer, your companion lists every tab of your own Edge, Chrome, Firefox or Brave windows
  (`pc_my_tabs`, with *The whole screen* on) and lists and reads text files in your Desktop, Documents
  and Downloads (`pc_files`, with the new **Files** switch under Computer use, off by default; read
  only, never outside those folders, hidden and secret-looking files left out). Before, the companion
  only knew its own browser window and told you to open things there. Its own window is now described
  as its own everywhere, a switch that is off is named exactly, and an older Sara app is told to update
  (older apps still show the front tab of each browser window). Every computer-use text uses your
  companion's name ("Fred’s browser", "Fred is working"). Windows app needed for every tab and
  files; the Mac app shows front tabs for now. See docs/desktop.md.
- **Long coding chats stay smooth, especially in Firefox:** a long chat no longer goes start-stop
  while she works, buttons answer at once and windows open without the slow blurred "fog". The
  frosted glass behind the header, sidebar and message box was re-blurred on every frame in
  Firefox; the new *Glass blur* setting (Settings → Appearance) is *Auto* by default: off in
  Firefox, on elsewhere, and you can pick *On* or *Off*. The V4 background light no longer moves
  in two layers at once, only her newest face in the chat animates, the streamed reply is drawn
  once a frame, and the page keeps the last 150 messages after each turn (scroll up for earlier
  ones). Scrolling up to read while she writes now stays where you are. In our 300-message test
  chat, Firefox frames went from about 140 ms to 11 ms and button presses from about 200-330 ms to
  about 30 ms while she streams. See docs/PERFORMANCE.md.

## 3.4.1 (2026-11-11): she remembers as much as her model can hold

- **Adding a server over SSH is far less confusing:** right after you say yes to the server's ID
  card, Sara quietly tries her own key and says *Connected* at once if it is already there (an
  admin added it, an earlier try); she tries again when you reopen a server that isn't connected
  yet. While *Add Sara's key yourself* is open she checks by herself every few seconds (for a few
  minutes, and at once when you come back to the page), so you no longer have to find and press
  *I've added it: check now*. User `root` (or uid 0) is never offered the cPanel token path, which
  can't work for root: Sara recommends *Add Sara's key yourself* with the WHM steps (Security Center
  → Manage root's SSH Keys → Import Key, then Authorize) and the one-line command, and refuses a
  token for root before any request. The recommended way is one box with one big button, the
  others a short *Other ways* list; a token that doesn't look right offers *Add Sara's key
  yourself*. See docs/SSH.md.
- **She keeps as much of the chat in mind as the model can hold:** the conversation memory was
  about 12,000 tokens for every model, even ones that hold a million. Now *Auto* (the new default
  under Settings → Models → Long conversations) follows the model each chat uses: Sara reads the
  window from the provider's own model list (OpenRouter, Ollama, Gemini, Anthropic, vLLM, LM Studio
  and others), or a dated table of well-known models, and keeps the old size for models she doesn't
  know. A line under the setting says it in words ("she keeps about 96,000 words of this chat in
  mind"), and the ring in the chat header and `/status` say how much of that a chat uses.
- **Cost guard:** on pay-per-token cloud models *Auto: balanced* stops at about 128,000 tokens of
  chat, because every reply sends it again; *Auto: use the model's full window* goes further.
  Subscriptions and your own hardware use their window. If you picked a size before, it stays.
- **Long chats with Ollama on your computer no longer get cut off quietly:** Ollama loads models
  with a small context unless asked (4,096 tokens on most PCs). Sara now asks for 32,768 tokens
  (64k-128k on big graphics cards, more with *full window*, as far as the graphics memory allows).
- A backup model with a smaller window gets a shorter history for its reply, instead of an error.

## 3.4.0 (2026-11-11): documents, her name everywhere, computer use from a server

- **Browser in one click, also on Linux servers:** adding the *Browser (Playwright)* add-on (or
  Sara's first `browser_open`) now gets the browser by itself: Edge/Chrome already on a Windows or
  Mac computer, otherwise Playwright's Chromium headless shell, downloaded by Sara's own Node into
  `<data>/cache/browsers` (one copy shared by her browser tools and the add-on), checked for missing
  Linux libraries and test-launched. On RHEL/AlmaLinux servers missing libraries are fetched from the
  distribution's own signed repositories into Sara's folder, without root. A status card on the add-on
  (Store page, its *Add* card, Settings → Add-ons → Other programs) shows Ready, Downloading (with
  progress), Needs your server admin (the exact `dnf`/`apt-get` line with *Copy*) or Not supported,
  with *Try again*. The add-on no longer asks for Google Chrome, and it is started with that browser
  and `--isolated`. See docs/BROWSER.md.
- **No more "upgrade Python" on cPanel/AlmaLinux:** *Settings → Add-ons → Other programs* said Python
  was too old (the system's 3.6, which dnf and cPanel need) and offered `sudo dnf install -y python3`,
  which changes nothing; Docker showed *Not found*. A `python3.12` next to the system Python now
  counts, the offered fix installs `python3.12`, and programs none of your add-ons need are shown
  quietly ("None of your add-ons need it"). Node for add-ons is always Sara's own Node, never an old
  system one.
- **She makes real documents:** ask for a Word document, PDF, Excel spreadsheet, PowerPoint
  presentation, Markdown, CSV or web page and it arrives in the chat as a card with **Download**,
  **Open** (a PDF in the browser, the rest as a preview) and **Make changes** (a new version; old
  versions are kept). Every document is also saved in the Library. Report, letter and resume looks are
  picked from the request; spreadsheets keep real formulas, slides get speaker notes, and pictures from
  your uploads or Library can go in. Works with every model, for household members in their own space
  and in private local mode; no new dependencies. Her instructions now say she can make files, so she
  no longer answers that she can't. See [docs/DOCUMENTS.md](docs/DOCUMENTS.md).
- **Computer use with Sara on a server (hosted Saras):** the Sara app for Windows or Mac now connects
  to a Sara behind a web server (Apache, nginx). Before, a proxy that passed only voice calls turned
  the app's connection into a plain request: the app kept retrying, the chat said "No computer is
  connected" and only offered the download. Now Sara answers that with a clear reason, the app says
  *Not connected: the web server in front of this Sara blocks the connection*, Sara's own card says
  the same with the one-line fix, and the Apache example (`deploy/apache-proxy.conf`, the install
  guide) passes it (`upgrade=websocket`). **Server owners behind Apache: add `upgrade=websocket` to
  the `ProxyPass "/"` line and reload Apache.**
- **Plain connection states in the app:** *Connected: Sara can use this computer*, *Connecting…* or
  *Not connected: <why>* with **Try again**, checked every few seconds while the page is open.
- **Reconnects by itself** after sleep, a network change (Wi-Fi, VPN) and unlocking the computer.
- **"Let Sara use this computer" from another device:** the app shows the code on top of Settings
  (*Waiting for your OK on Sara…*); Today lists the request under *Needs you*; the app no longer asks
  itself to approve its own request, and the app's hourly update check no longer pops an unasked
  *Your OK is needed* (only an actual update asks).
- **No computer connected:** her card now starts with **I already have the app → Connect it** (in the
  desktop app it opens Settings → Computer use; elsewhere it shows the three steps), then the download.
- **"Look at my browser tabs"** loads her computer tools, and she knows your own browser's tabs come
  from the window list and a look at that window ("The whole screen" on), not from her own browser.
- **Her name everywhere:** a renamed companion (say *Fred*, he/him) is named and spoken of as *he*
  everywhere she was meant: page text built in code (Today's *Plan my day with him*, *He remembered*,
  *Saved: he remembers what matters*, *Put him on your phone*), Settings and its tips, the help page
  (it said *Sara/she* about 700 times for a renamed companion), the welcome title, notification titles
  (*She learned something new*), the character's own shipped lines (*spends her time…*, *Her parents…*)
  in what he reads about himself, and *make her her own* (both words now change). Translations follow
  too: name, pronoun variants (`{p, select, …}`), agreement (*Comment Fred doit-il t'appeler ?*, *Fred
  s'est arrêté*, *Fred si è riavviato*) and strong pronouns where the English speaks of her. "Sara"
  stays where it is the product (*Sara app*, *Sara Store*, *Update Sara*). A rename shows at once,
  including text already on screen. A new test keeps new screens on the mechanism.
- **Default looks for he and they:** besides Sara, a male default and an androgynous they/them default
  ship with the full picture set (moods, blink and mouth frames, face landmarks), so the animated
  portrait works with them. Until you make a look of your own, the one matching her pronouns shows;
  *Settings → Her → Look → Default look* picks one by name (*Default (she)*, *Default (he)*, *Default
  (they)*). Changing her pronouns offers the matching default once. A custom look is never replaced.
  Details and prompts: [docs/APPEARANCE.md](docs/APPEARANCE.md).

## 3.3.0 (2026-11-10): easy mode

- **Easy first run:** *Start talking* now opens a chat called *Chat with Sara* with the cursor in the
  message box, instead of Today. The first chat is never called "Research" any more (background
  research no longer makes a chat of its own). *Company* is picked on step 1 unless you choose
  otherwise. Esc or a click next to the window no longer closes setup, and a reload comes back at the
  same step. *In the cloud* says where to get the key for each service, what it looks like and that
  a key is like a password for Sara. After *Connect* on a phone, *Connected ✓* and *Next* scroll into
  view and *Next* stands out. The last step has one main button: the anonymous check-in notice is a
  plain line with links, and *Bring her over from Hermes Agent* is a quiet line, shown only when an
  old assistant is on this computer. The chat line and her panel show the brain you just set up (no
  more "no provider · main folder"); in Company mode they say *Thinks with Ollama Cloud* and leave
  folders out.
- **She explains her own problems:** when her AI service doesn't answer, rejects the key, is out of
  credit, busy, or no longer has the model, the chat says so in plain words and names the service,
  with one **Fix it** button (it opens the right setting) and **Try again**, which really asks again
  and shows what happened. The same notice sits at the top of Today and in Needs you, also for a
  mailbox that signed her out and an add-on that stopped. *Settings → Health* no longer shows ✓ Model
  while her replies fail: it follows the real answers. In Company mode Health folds the technical
  checks (tool sandbox, command approvals, summaries, run history) behind *Show technical checks*.
- **Research that never promises what it can't do:** without web search, asking her to look
  something up shows *"I can't search the web yet"* with **Turn on web search**, and she is told not to
  promise to look. `/learn` always answers in the chat (it used to vanish), with the same button.
  Connecting Ollama Cloud with a key turns on Ollama web search with the same key; when an Ollama
  Cloud key is already there, *Turn on web search* is one tap.
- **Voice from the start:** the microphone shows from the first chat; the first tap before her voice
  is set up offers *Set up her voice (one minute)*.
- "This conversation is full" now says *Nothing is lost, keep talking*, and what happens to the oldest
  messages.
- **Reach Sara from your phone, at home and away, without networking words:**
  - **Pairing that works:** the phone QR now holds an address the phone can really open (her
    Tailscale address, your https address or the home-network one) and opens the Sara app already
    paired. It never holds `127.0.0.1` any more. When no such address exists, the card says
    "Your phone can't reach this computer yet" with **Set up access** instead of a QR that can't work.
  - **Connect the Sara phone app** is now at the top of Phone and notifications (where Today's "Put
    her on your phone" leads), with where to get the app (Google Play, or the download page) and
    one button for the code. Add a phone or computer on Devices and sign-in works the same way, and
    the settings search finds it for "code", "add a computer" and "add desktop".
  - **Use Sara away from home** (Devices and sign-in, or Ctrl K "away from home", "tailscale"): three
    steps with live checks. Install Tailscale here, install it on the phone with the same account,
    then **Turn on secure access with Tailscale** (owner only, with a confirmation and Undo) gives a
    private https address. **Test it** checks the address and says "Your phone can reach Sara
    anywhere ✓". See [AWAY_FROM_HOME.md](docs/AWAY_FROM_HOME.md).
  - **Move in from another computer** no longer shows a line that can't work there. Without a
    reachable address it offers the move-in file or the away-from-home setup.
  - **Health** says where your other devices really reach her, instead of "open the address you use
    now on your phone" (127.0.0.1 on a PC).
- **Email a normal person can set up:** **Add Gmail** now opens the 3-step app-password route
  (what an app password is, where to make it, paste it, done); the Google Cloud route is under
  *Advanced: full Gmail organizing*. Outlook.com no longer accepts app passwords (Microsoft switched
  them off in September 2024), so Outlook keeps the Microsoft sign-in, now in 3 plain steps with no
  client secret to make. **Check it** and **Add and check** say what went wrong in plain words: wrong
  password, 2-step sign-in off, IMAP off, or the mail server can't be reached.
- **One approval at a time:** the card in the chat is the one place with Allow and Deny. When you
  scroll away from it, the line above the message box gets the answers and **Show me**; if the card
  is ever missing, Sara draws it again, so a waiting approval can't freeze a chat. Her panel and
  Today's *Needs you* (now **Approve / Not now**) point to it. A skill's program reads "Sara wants to
  run a small program that came with her "weather-check" skill. It will: …", with the file and its
  code behind **Show details**.
- **Settings you can find, or just ask for:** everyday words (*bigger text*, *delete a chat*, *how
  much does this cost*, *dark mode*, *mute*, *language*, *password*, *backup*, *update* and more) find
  the right page first in Ctrl K, the Settings search and "How do I…?" in the chat. Ask her to *make
  the text bigger*, *switch to dark mode*, *change your color to green*, *turn off your voice* or *call
  me Pat* and she does it, with a card and **Undo**. Safety, approvals, privacy and sign-in she never
  changes by asking: she says where they are.
- **Plain words:** in everyday chats the reply card says "She did 1 thing" and **How she answered**
  (no steps, tokens or folder names; coding chats keep them), the context ring shows up only when a
  chat gets full, Token Saver and Workers stay out of the Company view, the Appearance preview is an
  everyday chat, Sara Classic says it changes the whole layout (and how to go back), her picture
  settings point to one place, and "Not checked" says what she claimed and offers **Ask her to
  really do it**.

## 3.2.0 (2026-11-10): she comes alive

## 3.1.2 (2026-11-10): research that keeps going

- **Research that doesn't fall over:** asking her in a chat to research something, find out
  everything about it, make a guide or a skill now starts a research run (a card with her plan and
  **Start**) instead of a long chain of page reads inside the chat, which used to fill the
  conversation until it had to be tidied up. The run works in the background with its own budget
  (pages, minutes, tokens: you see them and can raise them), can be paused and resumed, and picks up
  where it stopped after a restart. Its card shows what she is doing, pages read, sites that block
  readers and pages not found, then the report with **Save as a skill** and **Keep it fresh**.
- **No more guessed addresses:** a page that doesn't exist comes back to her as one line telling her
  to search for it, not the "page not found" page; after 3 misses on a site in one reply, more
  guesses there are refused. Research runs only read pages found by search or linked from pages
  she read.
- **Bot checks:** Cloudflare's "Just a moment…", captchas and similar checks are recognised in her
  web reader, in command output and in browser tools: she says the site blocks automated readers
  and moves on (never tries to get around it). Research lists those sites apart and uses the search
  result's own text when it has the page's content.
- **Patience with the web and the model:** slow pages time out after 15 seconds and are tried again;
  "slow down" (429) and server errors are retried, honouring the site's wait time; a model that stops
  answering is tried 3 times, then the run pauses ("the model stopped answering — Resume") instead of
  failing. A report or skill cut short is clearly marked **Partial**, never blank.
- **Small models:** with a small talking model, research uses a bigger model you set for another
  job, or works in short steps with a few notes per page so it never overflows. Many pages in one
  chat reply now come with a **Turn this into a research run** button.
- **Her picture comes alive (A1):** Settings → Appearance → Her picture → **Her portrait, animated**.
  She breathes, blinks, glances now and then, looks at you while she listens, up and away while she
  thinks, and her lips follow her voice while she speaks; her mood shows too (sleepy heavy lids and slow
  breaths, happy smiling eyes, hurt looking down). Everywhere in the new look: the chat header and
  sidebar (small: breathing and blinking), her panel, Today, her page and calls (lip-sync, big). The
  blinks and mouths are her look's own drawn frames, blended by a small WebGL renderer of our own, so a
  new look animates the same way; no new downloads. **Your picture** breathes with its ring, and after
  **Fit the face** (three dots: eyes, mouth) it blinks and glances too. **A 3D model (.vrm)**: bring a
  VRM 0.x or 1.0 model (up to 50 MB, kept in this browser, checked first, never uploaded); she blinks,
  looks around, lip-syncs and shows her mood with it; three.js and three-vrm (MIT) load only then.
  *Her portrait, still* keeps the still picture; the orb stays the default; Sara Classic is unchanged.
  Off with Background motion Off or reduced motion, paused when hidden, at most 30 fps.

## 3.1.1 (2026-11-09): moving in made easy

## 3.1.0 (2026-11-09): email beyond Gmail

- **Move in from Hermes Agent and OpenClaw, made easy and fast:** the packing program no longer runs
  for ever on a real Hermes Agent install (it looked through every program, cache and browser folder;
  now it reads only the companion's own folders: 0.4 s to plan, about 6 s to pack, bundles 20x
  smaller). On the same computer Sara finds the old assistant by herself (*Found Hermes Agent on this
  computer: memories, skills, past chats*) and one **Bring her over** button does the rest; from
  another computer you paste one line and the page moves on by itself when her things arrive. Helper
  sessions stay behind, continued chats stay one chat, re-runs bring only what's new, OpenClaw
  2026.10+ chats and schedules come over, and a Node version of the packing program works where
  there is no Python. Ctrl K finds it (*move in*, *import hermes*, *import openclaw*) and first-run
  setup offers it.
- **Email beyond Gmail (M1):** Sara now reads, searches, answers and tidies **Outlook.com, Hotmail and
  Microsoft 365** (through Microsoft Graph, with a free app you register yourself; mail and
  calendar) and **Yahoo, AOL, iCloud, Fastmail, Zoho, GMX, WEB.DE, Proton Mail (Bridge)** or any
  IMAP host (with an app password). One page for all of them: Settings → Add-ons → **Email and
  calendar** (accounts, default, Test, Remove, step-by-step Microsoft setup with the redirect address
  to copy). New `mail_*` tools work on any mailbox (`account` picks one; Gmail goes to the unchanged
  `gmail_*` tools); the calendar tools take `account` too, and `calendar_update` changes an Outlook
  event. Same safety as Gmail: count first, trash and spam ask every time, Undo for 30 days, never a
  permanent delete. Today's Mail card, the morning briefing, leave-by reminders and the
  weekly review follow the default mailbox (its Outlook calendar, else Google's). Settings search
  and Ctrl+K find the page by provider (outlook, hotmail, yahoo, icloud mail, imap…). Guide:
  [docs/EMAIL.md](docs/EMAIL.md).
- **Everyone in the household gets their own mailboxes:** a household member can now connect their own
  Outlook (with *Sign in with Microsoft*, through the Microsoft app the owner set up once), Gmail
  (with a Google app password) or Yahoo, iCloud and the rest, on the same Email and calendar page in
  their own space. Their mailboxes are kept in their own encrypted vault and only their companions,
  their Today card and their morning briefing use them: nobody else on the server sees them, the owner
  included, and the owner's mail stays out of members' reach. Sending and tidying ask the member on
  their own approval cards. Google's own sign-in (labels, Google Calendar) stays the owner's. An admin
  can switch members' mail off with the new policy pin *Turn off household members' own mailboxes*.
- **Android pairing links can open the app from the web:** links like
  `https://backstagecoding.com/sara/pair#…` now open Sara on Android (verified for backstagecoding.com
  once the site serves its Digital Asset Links file), and without the app the page explains how to get
  it. This answers the Play Console notice about the web domain not being associated with the app.

## 3.0.3 (2026-11-09): faster, steadier and easier to find

- **An approval can't get lost below the fold any more:** in a long chat her run card could shrink to
  a thin line and hide the approval inside it, so you couldn't scroll to it and the chat stayed stuck on
  "Waiting for your OK". Now the card always opens and scrolls into view, the "Waiting for your OK" line
  above the message box has the card's own buttons (for example *Save it* / *Don't save*) and **Show**,
  Ctrl K lists the waiting step to show or answer it, and after a reload the card comes back in the chat.
  Her panel's *Deny* on a card with *Always allow this tool* no longer presses the wrong button.
- **Skills save without asking:** when she saves a new skill or changes one of her own (also with
  `/learn`), there's no approval card any more. The step in her reply names the skill, with **Open
  skill** and **Undo** (a new skill goes to the trash; a change goes back to the version before). If
  you'd rather approve each one, set *Save a skill* / *Change a skill* to *Ask me first* in Settings →
  Tools and approvals; a choice you already made there stays, an admin's policy can still make them ask,
  and household members' spaces still ask. Running a skill's scripts still asks first.
- **Computer use without the token prompt:** turning on *Let Sara use this computer* no longer asks
  for the owner token when you're signed in as the owner on that computer. From a device signed in
  somewhere else it waits for your OK on a device you already use, like the other sensitive switches.
- **Approvals that time out say so:** when nobody answers an approval card in time, the step now reads
  "Not approved in time", the run card opens to show it, and the card stays as a quiet "did not run" note
  instead of disappearing.
- **A calmer store:** the big violet "Add" bars on every store card are now normal-size buttons, and the
  store's tabs look like the tabs everywhere else in the new look.
- **"Write our year" covers a year:** Your story's From and To now start at one year ago and today (on a
  new install both were today). A range you pick is remembered on that device.
- **Coding chats look like work:** her mood line under the chat title is gone in coding chats, and the
  "AI companion" badge becomes the short "AI" pill there (it is never removed).
- **One search box, one panel button:** in the new look the top bar's "Ask or do anything" is the one
  search (the sidebar's duplicate search box and the extra search icon are gone) and her panel has one
  button. On phones the search icon in the header and the search box in the menu stay. Ctrl K works as
  before; Sara Classic is unchanged.
- **Adding a phone or computer is easy to find:** *Devices and sign-in* now sits at the top of Settings →
  Connections (it was buried under Data & health). Searching Settings or Ctrl K for "code", "pair", "add
  phone", "QR" and similar finds it, Ctrl K and Help have an *Add a phone or computer* entry that makes the
  code straight away, and the desktop and phone apps point to the new place.
- **Settings opens instantly:** the gear, Add-ons and every other way into Settings now show the window
  on the click (about 0.1 s instead of 0.6-2.4 s). Pages still loading show a quiet placeholder and fill
  in as their part arrives; the page list and the search work straight away.
- **The performance-lab test runs on its own:** it is timing-sensitive, so `npm test` (and the server
  suite) now run it alone after the parallel batch instead of next to it, where a busy PC starved it.
- **Steadier on a busy Windows PC:** a preview or dev tunnel of her app is no longer refused when the
  computer is busy (the process check now waits for a slow answer instead of giving up), a program a
  sandbox try left running is found and stopped even then, and closing her browser no longer crashes
  when the browser is slow to let go of its files. The tests that used to need reruns under load now
  pass reliably.
- **A red dot when a chat needs you:** in the sidebar, a chat where an approval waits, she asked you
  something (a board card or a team checkpoint), or something failed that you haven't looked at yet shows
  a red dot (hover or a screen reader says why), and its folder shows a small red count. It clears when you
  answer or open the chat, and follows live on every device.
- **"Saved n new memories" under her reply:** the run card now says when she noted something new about
  you from that turn (right away when she saved it herself, or a little later once she has read back over
  the conversation). *See them in Memory* opens Memory with exactly those notes highlighted.
- **Fresh pictures in the README and guides:** Today, the Planner, a chat, the command bar, the
  personality, voice and coding dials, How do I…? and the phone view are retaken in the current look
  (Graphite with Violet, Night), with made-up example data.
- **A fresh-eyes pass over every page:** her "waiting for your OK" line and the bars above the message
  box line up with it; icons and their words no longer touch ("Off the record", "Review my week"); the
  memory map only uses colors its legend explains; the Library's other ways in sit in one row; Memory's
  two labels sit on one line; Team's empty list is one panel, not two; Evals keeps its words off the card
  edge; Webhooks shows one "New webhook" button when there are none; pressing + New again in a chat you
  haven't used yet stays in it instead of adding empty chats; Operations shows times as dates; setup
  starts in the name field; a long model and folder name ends in "…"; file pickers match the other
  buttons; and on a phone, opening More in the menu no longer pushes her face, Help and Settings under
  the bottom bar. Sara Classic is unchanged.

- **Update now for the Windows service install:** no more download page. Setup (as administrator) sets up
  the *Sara Update* task, which Windows runs as the system when you press Update now: it checks the
  signed update notice and the installer again in the program folder, installs, waits for Sara to answer
  and goes back to the previous version if she doesn't. A service from an older Setup says to run the new
  Setup once; `sara updater-task status` shows whether the task is there.
- **Store item pages refreshed (website, ready to deploy):** every `backstagecoding.com/sara/store/items/<id>/`
  page rebuilt from the signed list in the current look (studio chrome, Sara's Violet accent): the exact
  latest version (ComfyUI and Playwright pages said 1.0.0 although 1.0.1 is listed), Sara's own
  permission lines, the signed screenshots plus a picture of the item in today's Sara, checks and
  versions; no scripts, no install buttons (`scripts/build-store-items.ts`).
- **Store listings in your language for plugins and tool servers too:** taglines and descriptions of
  every plugin and tool server in Spanish, French, German, Portuguese (Brazil) and Italian (the signed
  `v1/locales.json`, read by Sara 2.83+), and a second signed file for the rest of a listing (every
  *about* paragraph, search words, and the setting and field names in *What it can do*), read by this
  version (Store sequence 8, docs/ops/STORE_SEQ8.md).
- **The model you pick during first setup stays the default:** picking a model in the setup guide
  saves it right away, even if its first test answer is slow and you go on with "Connect a brain
  later" or "Set up later". Before, a fresh install could end up with no default model, and Settings
  → Models → Default model showed the first model of the list as if it were chosen. A provider that
  becomes the default (an added provider, a ChatGPT or Grok sign-in) now always gets a model, and if
  none is saved Settings says so and saves the model you pick.

## 3.0.2 (2026-11-08): polish, Violet and an easy move-in

- **Settings opens in the middle:** on a computer Settings is a centered panel instead of a sheet
  against the right edge (phones stay full screen).
- **Violet is the default color** outside Sara Classic (a color you picked yourself stays).
- **A palette is a full preset:** picking a palette resets the color to that palette's own (Violet, or
  Classic's rose); your custom color is kept to pick again.
- **US spelling** in the app's English: color, favorite, customize, organize, behavior, gray, honor,
  neighbor (translations unchanged).
- **Four more relationships, none romantic:** Teammate / coworker, Tutor / study partner, Creative
  partner and Gaming / adventure buddy.
- **Full decoration you can see:** cards get an accent edge light, deeper shadows and a soft glow; the
  header and message box glow; the background light is stronger with a fine grain (Reduced, High
  contrast and Classic unchanged).
- **A little life on Today and At a glance:** cards ease in, lift on hover, lines draw in, numbers count
  up once, the glow behind her orb breathes and her mood dot pulses. All of it stops with reduced motion
  or Background motion: Off (which now also stops the background drift).
- **Tidy alignment:** How do I…? lines up with the cards on Today; a safety notice is a full-width
  alert row; the message box's Tell her now, its arrow and Stop are one height on one line.
- **Move in from another agent, step by step:** a five-step guide (pick the agent, run the collector
  with the exact command for Windows, Mac or Linux and an example of what you'll see, bring the file,
  check and import, done with Undo explained). Fixed: servers installed with the install script (and
  the Windows and Mac apps) didn't include the collector, so the page said *The collector is not on
  this server*; it's included now, and a server without it shows a working command that downloads it
  from GitHub. A file sent with a move-in code shows up by itself while you wait.
- Tess, the practical maker: a new gallery character (thanks to @Guilsc).

## 3.0.1 (2026-11-08): every page in the new look

- **Every page in the new look:** Today, Planner, Memory, Library, Scrapbook, Moments, Your story, Team,
  Findings, Evals and Settings now match the 3.0 chat. Today opens with her live presence orb next to
  the greeting (her portrait stays as a small picture, or large, or hidden, as you set it), glass cards
  with quiet headings, and the weather and usage lines in your colour. Every card, setting, Customise
  option and button is still there. Sara Classic looks exactly as before.
- **Leaving Sara Classic:** if you never picked a colour yourself, Sara now switches from Classic's rose
  to Blue when you pick another palette. A colour you picked stays.
- **Projects listed once in the sidebar:** each project (Telegram and the other chat apps too, No
  project, Archived and Hidden) is one folder row that opens to show its chats; its page, a new chat
  and the ⋯ menu sit at the end of the row. Each chat has a dot for what it is doing (working, open,
  done, ended). Arrow keys open and close a row. Classic keeps its old list.
- **Her picture:** Settings → Appearance → Her picture: the presence orb (default), her portrait, or the
  picture you uploaded, shown round with a thin ring that moves with her (listening, thinking,
  speaking). Upload a picture on her page.
- **Clearer run cards:** "Remembered 16 things" now reads "Used 16 memories" (what she already knew that
  shaped the reply) and opens those notes. The card under a reply is folded to one line until you open
  it (Settings → Appearance → Show run details), but always opens for an approval, a failed step or work
  still running.

## 3.0.0 (2026-11-08): a living-system look

- **Android app for Google Play (3.0.0, versionCode 30000):** place reminders now
  show Google's prominent disclosure (*Place reminders use your location*: Sara collects location data
  to enable place reminders, even when the app is closed or not in use) before any location prompt,
  in all six languages. Fixed on the emulator: the first time Hey Sara was switched on, allowing the
  microphone didn't start it; switching Hey Sara off while nothing listened crashed the app.
- **Hey Sara for phones (server):** *Get the speech model* now also unpacks the four keyword-model
  files phones download from the server (before, only the word list was unpacked and Android waited
  for the model forever).
- **Live calls in the phone apps on http servers:** the call button shows in the Android app for a
  server at home on plain http too (the app runs the call itself); voice notes and video calls still
  need https there.
- **V4a, the "living system" shell (3.0.0 look):** a live status strip across the top (workers running,
  runs and research going, triggers armed, the model answering this chat, spend today against your limit;
  each chip opens its page and only shows when there is something real), *At a glance* at the top of her
  panel on wide screens (spend today with its line, workers, today: tasks done, waiting on you, what a
  trigger watches for; folds and is remembered), a very faint background light in her colour that moves a
  little faster while she works (Settings → Appearance → Background motion; still with reduced motion),
  and a command bar that previews the highlighted row (a setting's value, before → after for changes,
  place counts, *Ask her* for any text). One accent: Blue, Rose, Violet, Emerald (new), Amber, Cyan or any
  colour, always kept readable. Graphite gets the deeper V4 surfaces in Night and Day. A renamed companion's
  name follows everywhere at once; "Sara Classic" stays the palette's name. Nothing was removed.
  Design: docs/ops/V4_DESIGN.md.
- **V4b living parts (the 3.0.0 look):** her **presence orb** in the chat header, the sidebar, her
  messages, the call screen, the Hey Sara quick-ask window and worker rows: idle, listening (follows the
  microphone level), thinking (a turn or a tool step running) and speaking (her voice playing), each
  from the real signal, in your accent colour, with "<her name>: <state>" for screen readers. A picture
  you chose for her stays; the orb becomes a small badge on it. The step line under her replies becomes
  a **live run timeline**: the step she is on, a progress bar, Fold / Show steps (remembered), her
  approval card inside the run, a "verified" mark only when a sandbox try or a clean checks run really
  checked that step, and the run's tokens, cost and sandbox tries from the run record. Memory →
  **Memory map**: her notes as a graph (shared words, same conversation, replaced, they disagree;
  fading notes dimmer, at most 150), point to read a note, click to open it. Reduced motion stops all
  of it. Sara Classic keeps the portrait and the old step line. Design: docs/ops/V4_DESIGN.md.
- **V4c, the 3.0.0 look put together:** her memory map now fills the *Memory* card in *At a glance*
  (redrawn when the panel opens, after a reply and when Memory closes; the card stays hidden while she
  remembers nothing). One *Today* card: while *At a glance* shows, her next three things (events,
  reminders, to-dos) sit in its Today card under the counts instead of a second Today further down; they
  move back when the glance folds or the window narrows. Worker orbs carry the worker's own name and
  state for screen readers; every orb label, her name over earlier replies and the AI notice follow a
  rename at once (no reload). On phones the chat title gets the room: the AI badge becomes a short
  *AI* pill (the full words stay for screen readers; *KI* / *IA* in German, Spanish, French, Italian
  and Portuguese) and the chat's fullness dial lives in her panel's *This conversation*. Run steps no
  longer run past their card on phones; your turns show a quiet person mark instead of an empty circle;
  an empty project's hint stays on one line. Settings → Hey Sara now says Windows, Mac or Android (it
  still said to use the Talk button on Android). README: the lead picture and *The new look* gallery
  are retaken in the 3.0 look (same file names) and all six READMEs describe it. Sara Classic is
  unchanged.
- Add-ons and store items written for Sara 2.x ("below 3.0.0") keep installing, loading and listing on 3.x: 3.0 changed the look, not the add-on interface.

## 2.88.0 (2026-11-08): coding workspace, Spotify, team pages and Hey Sara everywhere

- **Team pages (C16, business instance):** a *Pages* tab in each workspace. Markdown pages with search
  (title and text), every saved version kept in *History* (append-only; a stale save is refused, not
  overwritten), threaded comments with Reply and Resolve, and `@Name` mentions that show the member
  *Mentions for you*. View only reads and comments, Contributors create and edit, Managers delete.
  Export a page as Markdown or PDF. *Ask Sara about this page* hands the page and its open comments to
  the composer as context; *Save as a page* under her answer opens the editor, and nothing is saved
  until the member chooses Create page. Organization administration gets a legal hold per workspace
  (nothing in it can be deleted while on) and per-person page export/delete. Audit rows for create,
  edit, delete, comment, resolve, hold and person delete. Guide: BUSINESS.md → Team pages.
- **Coding depth (C13):** a coding task can run in its own git worktree (branch `sara/<task>` in
  `.sara-worktrees`, the main checkout untouched); finish with Merge, Open PR (pushed and opened
  through your GitHub connection, title and body drafted from the commits) or Discard (never deletes
  uncommitted or unmerged work without asking; links such as `node_modules` junctions are unlinked
  first). Language servers on your PATH (typescript-language-server, pyright, gopls, rust-analyzer;
  none bundled) give her read-only diagnostics, go-to-definition, references and hover, with time and
  memory caps. Her commits carry a `Co-authored-by` line (Settings → Coding → GitHub → Her commits).
  Project page → **Workspace**: files, an editor with line numbers, Problems, a terminal (her shell's
  rules and sandbox) and a chat that sees the open file. Guide: docs/CODING_DEPTH.md.
- **Music: Spotify (C14):** Settings → Connections → Spotify connects your own Spotify developer app
  (Client ID only, sign-in with PKCE; tokens in the vault, renewed by themselves). She searches songs,
  albums, artists and playlists, says what's playing, reads your playlists and most-played music and
  your devices. *Let her make and change playlists* adds making a private playlist and adding songs
  (each asks first); *Let her control playback* adds play, pause, skip, volume, shuffle and queue on a
  chosen device, only when you ask for music; "needs Spotify Premium" comes back as a plain answer.
  Read-only permissions unless you tick more. Spotify now runs developer apps only for owners with
  Premium. Guide: docs/MUSIC.md.
- **Hey Sara on Mac, Android and Linux (C17):** the same on-device keyword spotter as Windows
  (sherpa-onnx, Apache-2.0). **Android** listens for her phrase in its opt-in foreground service (off by
  default; notification with Talk, Pause 1 h, Stop), with *Only while charging*, *Only while Sara is
  open*, and pauses on low battery or Battery Saver. **Mac**: the engine is in the signed app; menu item
  *Listen for “Hey Sara”*. **Linux**: `sara wake --server URL` in a terminal (PipeWire, PulseAudio or
  ALSA). New: *Never in my quiet hours* (Settings → Hey Sara). Phones and Linux get the checked speech
  model from your own server; nothing is sent anywhere until she hears her name.

## 2.87.0 (2026-11-08): workers, spend control and safer updates

- **Bring your companion (C7):** Settings → Her → Companions → *Bring your companion from another app*
  makes a new companion from Character.AI (the account export), Replika, Kindroid or Nomi: export files
  (zip, JSON, CSV, text, a saved chat page) and pasted backstory, key memories, journal, diary or
  Backstory+ notes. A preview shows her name, backstory, greeting, example lines, each memory and the
  number of chat messages; untick anything, then bring her over. Memories are marked imported with the
  app and the day; chats are kept archived and read-only. Read on the server only, size-capped, HTML
  never run, the minors check and Adult mode apply. Guide: IMPORT.md → Bring your companion.
- **How she works with you (C12):** Sara notices how you like to work (short or long answers, one
  pick or options, asking first per project, tone, what you're new to or know well, usual hours,
  feedback) from your own messages only, holds each as a belief with evidence (message numbers, never
  copied text) and a confidence that fades unless she sees it again, and tells you once when one
  changes how she answers. Never health, religion, politics, sexuality, personality types,
  credentials or generalisations about others; nothing from private, partner, imported or adult
  chats. Memory → *How she works with you* lists them with Confirm, Not true and Forget; admins can
  pin it off. Guide: docs/WORKING_STYLE.md.
- **Workers that stay (C10):** Team → *Workers that stay*. A worker is one of your helpers, or a crew
  member, that keeps going: a name and a character, its own chat in the conversation list (its results
  land there, not in the chat you are in), the groups of tools it may use, its own daily token budget
  and a job queue that survives a restart. It does one job at a time, retries a failing job after 1, 5
  and 30 minutes, and stops a job that runs past its time. Jobs that keep failing go to *Failed jobs*:
  read why, then replay a copy or drop it. When a worker is blocked (an approval waiting, its budget
  used up, a job that keeps failing, a stop you did not ask for) it sends you one alert to the chat app
  you used last (Telegram, Discord) or the app, held in quiet hours, never twice. A lead hands jobs to
  the workers under it and their results come back to the lead's chat. Export a worker (and the
  workers it leads) as a file without secrets (its memories only if you tick it) and import one with a
  look at what it may do first; imported workers start paused. Owner only, audited; the Crews pin
  turns workers off too. Guide: [WORKERS.md](docs/WORKERS.md).
- **Spend control (C8):** paid steps show their price before they run (*about $0.07* for a Grok
  picture, *cost unknown* when nobody knows); add-ons can declare `costs` in `plugin.json`. Spend limits
  per day, per month and per tool on Usage and costs stop paid steps with a plain card (Allow = one
  call); a policy pin sets a hard daily cap with no override. Paid tool calls go on the usage record.
  **Token Saver** (`/saver on|off|auto`, Settings row, header badge): shorter replies, a smaller history,
  fewer tool steps and the Quick model; auto turns on near a daily line and off at the reset. Off
  changes nothing. **Add-on auto-update** (off by default, all or per add-on): installs, checks it
  starts, rolls back by itself and tells you; never when a new version asks for more permissions.
- **Updates that roll back on Windows and Mac (C9):** every release now publishes a signed update notice
  (`update-notice.json`, Ed25519: version, date, oldest supported version, security flag, each
  installer's SHA-256). On Windows (the *only while I'm signed in* install) and the Mac app, **Update
  now** downloads the installer in the background, checks it against the notice, keeps the previous
  version (its installer, or the old Sara.app), installs silently, restarts and checks
  `/api/health`; if the new version doesn't come up within 3 minutes the previous one goes back and
  Settings says so. Unsigned or older notices are refused; without a notice Sara falls back to
  GitHub's newest release and the download page. A new **Update** button in the top bar turns from
  grey to blue (2 days), amber (4) and red (7), red at once for a security release, and says **Update
  required** below the oldest supported version. Linux keeps its root helper and reads the same
  notice for the button.
- **Board questions (C11):** when she works a card and needs your input she parks it in *question*
  (not failed, and it no longer holds a work slot); answer on the card or in chat (`card_answer`), and
  the work resumes with your answer. Boards show a question count; an unanswered question gets one
  reminder after a day (outside quiet hours), then at most one a day. **Make a board from a
  description**: she drafts columns and cards with dependencies, you edit the preview, then create it.
- **Approve a new device from chat (C15):** a password or passkey sign-in from elsewhere (another
  computer, or any tunnel or proxy, even from 127.0.0.1) waits until you type its 5-character code on a
  device you already use or reply `approve K7Q2M` in Telegram or Discord; 10 minutes = no. From such a
  device, Always allowed, a new owner token, add-ons from a URL, chat tokens, updates and turning this
  off ask you first. Allowed addresses (DNS rebinding check), Devices at most, 30-day sign-out, a
  notice on a new address, and signing out cuts open connections. On for new servers; existing servers
  get a one-time notice instead. Pairing codes, device codes, API keys, Alexa and the demo unchanged.

## 2.86.0 (2026-11-08): learn a topic, triggers and tool apps

- **Stop works at once on a busy Windows PC (C2):** stopping a background job or command used to wait
  for `taskkill`, which on a loaded PC took 15-25 seconds and often failed, so the job ran on until it
  ended by itself. Sara now ends the Git Bash shell's own processes directly (read from Git's `ps`, no
  WMI); `taskkill` stays as the backstop for anything those started.
- **Records match reality (C2):** ROADMAP and OWNER_CHECKS say which release shipped each item instead
  of "on branch, not merged"; BACKLOG lost its duplicates and the entries 2.85.0 fixed. The policy pins
  are one table in Settings code (`web/policy-pins.js`: key, label, control, locks), checked by a test
  against the server's pin list and the Policy page. The performance-lab tests judge each run by its own
  repeat spread, so a busy host can no longer flip them.
### Fixed (C1 proof sprint: real Keycloak, OpenBao, Podman, Prometheus/Grafana, scim2-cli)

- Company sign-in works on a business instance reached by IP address (a LAN server with a local
  Keycloak): the "passkeys need a hostname" guard now switches off only the passkey controls.
- SCIM: `/Schemas/{id}` and `/ResourceTypes/{id}`, every returned sub-attribute declared (`groups` and
  `members` with `value`, `$ref`, `display`, `type`), `attributes`/`excludedAttributes` on Users and
  Groups, 405 on writes to discovery, and a group `PUT` without `displayName` is refused. A strict SCIM
  client (scim2-cli) could not create a group or read a user before; scim2-tester errors 49 → 12.
- Container sandbox on rootless Podman: the allowed-sites proxy now starts on both networks at once
  and the command reaches it by address (`network connect` fails on rootless Podman and its internal
  networks have no DNS), so *Only the sites listed* works with Podman, not just Docker.
- Vault/OpenBao references: a key typed as `vault:…` is read before Settings → Models answers, so
  the next chat has it (it said "needs an API key" for a moment), and OpenBao's refusal reads as
  one plain line ("permission denied").
### Added

- **Open Responses (`/v1/responses`, C5):** apps that speak the Open Responses / OpenAI Responses API
  (the official `openai` package's `responses.create`) can talk to her with an API key: input items
  with text and pictures, `previous_response_id` to continue, streaming with the spec's events, stored
  responses you can read back or delete. Her own tool steps show as `sara:tool_call` items and
  approval cards as `sara:approval` events, answered in Sara. Same keys, limits and safety layer as
  `/v1/chat/completions`. See docs/OTHER_APPS.md.
- **Kubernetes (C5):** a single-replica Helm chart in `deploy/helm/sara` (the published GHCR image,
  a kept volume for her data, health probes, non-root by default, optional ingress). See
  docs/KUBERNETES.md.
### Added

- **MCP 2026-07-28 and MCP Apps (C3).** Sara's tool-server client speaks the current stateless MCP
  revision (per-request `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` headers, no session) and
  falls back to the handshake revisions for older servers (ComfyUI, Playwright and the rest keep
  working). Tool servers' apps (interactive panels, `ui://` pages) now show in the web chat in a
  sandboxed frame (opaque origin, strict CSP, 512 KB cap); a panel can only call its own server's
  app tools, through the normal approvals. Per-server switch: *Show its apps in the chat*. Guide:
  `docs/EXTENDING.md` → *Apps from tool servers*.
### Added

- **When this happens** (event triggers, C4): a new email, a Slack or Teams message in a channel she
  is in, a webhook delivery or a tool server's resource update or event can start her work, either
  your instruction or one of your crews, with the event as information. Each trigger has a filter,
  a daily run cap and token budget, pause and resume, and a *Last runs* list. Approvals still apply,
  her own messages never trigger, repeats are skipped, notifications wait in quiet hours, and every
  run is in the audit trail. Admins can pin `triggers: false`. Settings → Connections → Webhooks;
  guide [docs/TRIGGERS.md](docs/TRIGGERS.md).
### Added

- **Learn a topic** (C6, [LEARN.md](docs/LEARN.md)): `/learn <topic or website>`, "learn about X" or Library → *What she has learned*. She researches the topic (or one site, following robots.txt, same site only, page cap, rate-limited), keeps a knowledge skill with a summary, dated key facts, a glossary and its sources with fetch dates, refreshes it daily, weekly or monthly with *What changed since <date>* (older versions kept, one optional message outside quiet hours, *Out of date* when a refresh fails), and answers questions about it citing the pages. Monthly learning budget in Settings → Budgets; policy pin `learning: false`; owner only.

## 2.85.0 (2026-11-08): meetings, phone helper and her at work

### Added

- `SARA_PROGRAM_PATH`: extra program folders for Sara alone, first in her command path inside and outside the Linux sandbox (for example a newer Python on a cPanel server whose system `python3` must stay 3.6).
### Changed

- Owner-session continuity no longer lets only one model step run at a time across all of your
  chats: each chat answers one step at a time and up to 4 chats can work at once (Settings → Chat
  apps → Session continuity → *Replies at the same time*, 1 to 8; policy pin `parallelReplies`). At 20
  busy chats a turn took 1.8 s instead of 6.6 s, and at 50 none were refused (half before).
- Pictures from her: pick a ComfyUI workflow you saved inside ComfyUI instead of pasting the API
  export, and optionally get her pictures on her own in your Telegram or Discord chat too.

### Fixed

- Get more showed `{{user}}` in a companion's description; it now reads "you", as on the Store website.
- Stopping a background job on a busy Windows PC could leave its program running until its time limit
  (taskkill can take 15 s or more, or give up); Sara now retries and then ends the program itself.
- **Meetings and meeting notes (EC19):** Library → *Meetings…* (owner only). Start a meeting room:
  after a consent tick Sara shows and says *"I'm Sara, an AI. I'm listening and taking notes"*, each
  of your devices that joins shows the notice and opens its microphone only after *I understand*; she
  turns what is said into a transcript and answers briefly when called by name (no tools). Or give her
  a recorded call (WAV up to 3 hours, MP3/OGG/M4A up to 25 MB). The notes (summary, decisions, action
  items with owners and dates) are kept in her Library; an action item becomes a Planner to-do only
  when you press *Add to Planner*. No recording kept unless chosen; transcripts stay on the server;
  private local mode needs the local hearing engine; policy pin *Turn off meetings*; audit rows for
  start, join, end, notes, to-dos, downloads and deletes. Joining Discord voice itself is not built
  (Discord's DAVE encryption is required since March 2026); record the call and use *Notes from a
  recording*. Guide: docs/MEETINGS.md.
- **Phone as a helper (EC24):** Sara can ask a phone or browser you switched on (Settings → Devices
  and sign-in → *Phone as a helper*) for one picture from its camera, your location once
  (approximate unless she needs the exact spot) or one screen picture. Each use is a full-screen
  prompt on the device with her reason, **Allow once** and **Deny**; nothing is captured before the
  tap, and no answer in 90 seconds ends it. Owner only; private local mode is respected; one audit
  row per request (never the picture or coordinates); policy pin *Turn off Phone as a helper*.
  Android: location for the prompt in the app (new build). Guide: `docs/PHONE_HELPER.md`.
- **Her at work (EC26):** Settings → Her → *At work*: one companion for you and your workplace. Chats you
  tick as work (Slack and Teams by default; Matrix, Email, Discord and Telegram work channels optional)
  get her work name and tone (friendly and professional, formal, or brief), work tools only (research,
  files in a chosen work workspace, the calendar; commands only when allowed), a separate work memory
  (notes, recall, "last time" and other chats never cross between work and personal; *Copy to work* /
  *Copy to personal* is the only way across) and no companion features (moods, diary, romance, adult
  content, role-play, pictures on her own). Each work chat gets its own AI disclosure in her work name.
  Policy pin *Keep work mode on everywhere* makes every chat on a business server a work chat. Audit rows
  `work-profile.change` and `memory.copy-space`. Guide: `docs/AT_WORK.md`.
- **Business usage reports (EC15):** organization administrators see the spending ledger per
  person, workspace and model, by day, week or month, with a CSV download (same columns as the
  personal report; audited). The ledger now records each request's model. Guide:
  `docs/USAGE_REPORTS.md`.
- **Household members can share their own chats (EC11):** same hiding, expiry, refusals and
  revoke as the owner; the owner can turn it off for members (their links then stop opening), sees
  only how many links members have, and removing a member revokes theirs. Guide: `docs/SHARING.md`.
- **Edit history while a legal hold is on (EC17):** in-place rewrites of messages and memories
  keep the previous text in an append-only history (database triggers), exported with the person's
  data and shown to the owner. Guide: `docs/DATA_RIGHTS.md`.

## 2.84.0 (2026-11-07): enterprise controls, editors and code mode

### Added

- **Secret sources (EC10):** a server key (model provider, chat app, voice, Home Assistant, the
  business sign-in secret and operator keys) can live outside Sara: type a reference such as
  `env:OPENAI_KEY`, `file:/run/secrets/openai`, `vault:secret/sara#openai` (HashiCorp Vault or OpenBao,
  KV v2), `op://Servers/OpenAI/credential` (1Password Connect), `keychain:sara/openai` or, when the
  server allows it, `cmd:op read …` in the key field. Sara reads it at use time, keeps it in memory for
  five minutes, never writes it back, hides it in logs and output, and backups hold only the
  reference. Several keys (`env:A | env:B`) rotate when the provider refuses one. Settings → Data &
  health → Operations → *Secret sources* shows each key's source and status (never the value) with
  *Check now*; audit rows for source changes, rotations and failures; policy pin *Server keys only
  from secret sources*. Guide: `docs/SECRET_SOURCES.md`.
- **Sara in your code editor (ACP):** Zed, JetBrains IDEs and other editors that speak the Agent
  Client Protocol (version 1) can use Sara as their coding agent: `sara-chat acp` (or `sara acp`
  on the server's computer) with a one-time sign-in. Each editor thread is a coding chat; she reads
  the editor's files (unsaved changes too), her edits are written by the editor as a diff, commands
  run in the editor's terminal, and every write and command asks in the editor first (her own
  approval cards show there too). Files outside the folder, env files and keys are never touched.
  A policy pin turns editors off; each new editor session is an audit row. Guide: docs/EDITORS.md.
- **Provisioning with SCIM 2.0 (business instances):** Microsoft Entra ID, Okta or any SCIM client
  creates, updates, disables and removes accounts. Disabling someone ends their sessions at once;
  groups map to administrator or member like company sign-in; a provisioned person's first company
  sign-in needs no invitation. Token shown once, kept as a hash in the operator vault; rate limits;
  audit rows. Organization administration → Provisioning (SCIM). See docs/SCIM.md.
- **Retention, legal hold and one person's data:** Settings → Household → Retention and legal hold.
  Keep chats, memories and files until you change it (the default) or for 30, 90, 365 or 730 days;
  a legal hold on one person or the whole server stops every way their data could be deleted
  (enforced in the database); download one person's data as a ZIP with a checksum manifest, or
  delete a household member's data with a receipt in the audit trail. Policy pins *Keep the whole
  server on legal hold* and *No deleting one person's data*. See docs/DATA_RIGHTS.md.
- **Trust report** (EC25): Settings → Household → Trust report sets what Sara said against what ran,
  for a week, one run or one project: flagged claims, tool calls and failures, approvals, policy and
  loop-guard refusals, sandbox tries, sources cited and the audit rows of the window. Download as
  Markdown, PDF or Word (each download is audited). Owner only. Guide: `docs/TRUST_REPORT.md`.
- **Qualified badge** (EC27): Get more shows when and where each Store entry last passed a real
  install ("Checked on Linux and Windows · 2026-11-07 · Sara 2.81.0", "partly on" where only part
  worked) and which checks ran, from a second signed Store sidecar (`v1/qualified.json`) that older
  Saras never read; the store website shows the same line. Owners fold new
  `scripts/qualify-addons-native.mjs` results in with `sara addons requalify`.
- Store list 7 is live with the listing translations and the qualification records (no add-on changed).
- **Readiness and recovery (EC28):** Settings → Data & health → Recovery is now *Readiness and
  recovery*. On top, one verdict (Ready / Needs attention / Not ready) and twelve areas (backups, the
  last proven restore, off-computer copy, disk space, model answers, chat apps connected, paused work,
  updates, HTTPS and who can reach her, sign-in, admin policy, monitoring and audit), each with one
  fix. **Run a restore drill** restores the newest backup into a throwaway folder, checks every
  database and the vault, starts the copy on this computer only with everything that acts switched
  off, deletes it, and reports the measured time and the data a restore now would lose (one audit
  row per drill). `GET /api/readiness`, `POST /api/readiness/drill`, `POST /api/readiness/probe`
  (owner only). Interrupted work stays below on the same page. Guide: `docs/RECOVERY.md`.
- **Scale evidence (EC18):** `scripts/load-test.ts` drives N concurrent users (chats, tool calls,
  library uploads, Telegram messages) against a throwaway Sara with a fake model and a fake Telegram,
  and reports p50/p95, errors, CPU, memory, event-loop lag and SQLite contention. Results and the
  single-server limits found: `docs/ops/SCALE.md`. The operations snapshot now includes the process's
  CPU time.
- **Code mode** (EC21, off by default): with many tool calls ahead, she can write one short script
  (JavaScript or TypeScript) that calls her tools and returns only the result. Every call inside goes
  through the same approvals, policy, safety checks and audit trail as a direct call: a tool that
  asks shows its card and the script waits. The script runs in a fenced Node process (no files, no
  network, no programs; inside bubblewrap or a container when you have one) with time, memory and
  call limits. Settings → Tools and approvals; admins can pin it off. Guide: docs/CODE_MODE.md.
- **Embedding SDK** (EC22): `packages/sara-sdk`, a small dependency-free TypeScript client for apps
  and scripts (Node 18+ and browsers): device-code sign-in, conversations, streamed replies,
  answering approval cards, file upload, the OpenAI-compatible `/v1` and webhook signature checks,
  with an example app. The REST reference `docs/API.md` is generated from its route table.

## 2.83.0 (2026-11-07): research, Teams, crews and safer sandboxes

### Added

- **Store listings in your language:** Get more shows a companion's tagline and description in
  Spanish, French, German, Brazilian Portuguese or Italian when the Sara Store publishes translations
  (a separate signed file next to the list, which older Saras never read; a missing or bad one just
  means English). Translations for the 21 first-party companions are ready; they appear once the
  Store publishes them.

### Fixed

- Slack: an edit to her progress message that arrives while Slack is still answering the post (a slow
  Slack or a busy computer) now waits for the message instead of being dropped, so the ⏹ message is
  always updated in place.
- `scripts/qualify-addons-native.mjs` checks the download hash of the Store index's `latest` version
  (it took the oldest, so a plugin with two versions wrongly failed).
- `tools/developer-data/verify-qualified.ts` also verifies Data Contract Validator 1.0.1 (the security
  rebuild's recorded hashes and the signed package), not only the 1.0.0 receipts.
- Prerequisites (PRQ): every Store install card detects catalog programs the catalog's way, also when
  it is built outside Settings (a companion's suggested add-on, a plugin's Store install), so Chrome on
  Linux shows *found* or *not found* instead of no answer. Local workflow candidates whose jobs run
  npm show whether npm is there (beside Sara's own Node) before you review them.
- Red-team mode on a busy Windows PC: stopping the app between probes no longer depends on `taskkill`
  finishing within 10 s (it could take longer just to start, the app stayed on its port and the fresh
  restart dropped a real break as "did not happen again"); after a fatal error the driver waits for
  the app's exit and its output instead of a fixed 200 ms.
- Test reliability: the performance lab's injected-regression fixture is now about 4x slower (was 2x),
  so it stays conclusive on a busy host.
- **Research a question (EC6, owner request; `docs/RESEARCH.md`):** *Library → Research a question…*
  drafts a plan (steps and web searches) that you edit and start; while she reads, every page read
  and every page that failed is listed with the reason; **Write the report now** stops reading early
  and **Stop** still saves a report of what was found and what is missing. Every sentence of the
  report links a page fetched in that run (the server checks each one and leaves out the rest,
  counting them). The report is kept in her Library and downloads as PDF, Word or Markdown (new
  small writers, no new dependency). Owner only; refused when web search or web pages are off.
- **Microsoft Teams (EC7, `docs/TEAMS.md`):** talk to her in Teams through a free Azure Bot of your own
  and a Teams app package the new *Settings → Chat apps → Microsoft Teams* card builds (a zip you upload
  in Teams). Her personal chat is your own chat with tools, pictures and files; her requests for your OK
  come as an Adaptive Card with **Allow / Deny** that only you can answer; a progress card with ⏹. In
  channels and group chats you switch on she answers mentions in their thread (no tools unless *Owners
  can use her tools in groups*). Her files reach your OneDrive after you tap Allow. Teams must reach Sara:
  the card says plainly what that needs (a public https address, or the Tailscale Funnel door or a
  tunnel). Sara checks Microsoft's signed token on every call before the plugin reads it. Rate limits
  waited out, token retries with backoff, secret errors in plain words. The client secret lives in Sara's
  vault and goes, with the public hook, when the plugin is removed. Off until you add it. Tested against
  a stand-in Microsoft; a real tenant is an owner check.
- **Webhooks and plugins (EC7):** a chat plugin's bridge hook may be of kind `botframework`
  (`permissions.webhooks: {"bridge": ["botframework"]}`, on the review card): Sara validates the Bot
  Framework JWT (OpenID metadata, keys with a rotation cooldown, RS256, issuer, App ID, time, channel
  endorsement, serviceUrl) and answers 401 otherwise. Logs mask Microsoft Entra client secrets.
- **Container sandbox (EC8, owner request; `docs/SANDBOX_AND_EGRESS.md`):** Settings → Tools and
  approvals → *Isolation* runs shell commands, sandbox tries and add-on jobs in a throwaway rootless
  Podman or Docker container when you pick it, or automatically where nothing else isolates (Windows).
  Only the workspace is mounted; read-only root, no capabilities, no network unless allowed; the local
  image is never downloaded. Commands are built as argument lists (no host shell). bubblewrap stays the
  Linux default. *Install Docker for me* and *Look again* without a restart. Admin pin *Require the
  container sandbox*: without a working engine commands and jobs are refused.
- **Allowed sites for sandboxed work (EC9):** *Only the sites listed* limits commands, add-on jobs and
  (with bubblewrap or the macOS sandbox) tool servers to a list of hosts through a small proxy, enforced
  by the container network, the bubblewrap network namespace or the macOS sandbox; a key named for a
  site is added by Sara so it never enters the sandbox; every refused site is an `egress.refused` audit
  row. Admin pin *Only these sites for sandboxed work*.
- **Add-on jobs on Windows have no network unless their plan asks for it:** a Node guard now blocks
  connections, local pipes, UDP and DNS (before: proxy settings only).
- **Share a conversation (EC11; `docs/SHARING.md`):** a chat's settings → **Share…** makes a read-only
  link that expires (1 hour to 30 days) and can be revoked at once. A preview shows exactly what is
  shared: keys, vault secrets, e-mail addresses and phone numbers are hidden; tool results and
  pictures only when ticked. Off-the-record, partner, adult, group and imported chats are never
  shared; private chats (and everything in private local mode) only when allowed. The page is
  never indexed, has no script, carries the AI disclosure and is rate-limited. Settings → Household → Shared links lists opens and revokes; a policy pin turns sharing off; audit rows for
  create, first view and revoke.
- **Usage and cost reports (EC15; `docs/USAGE_REPORTS.md`):** Settings → Household → Usage
  reports: daily, weekly or monthly tables by person, workspace, project and model from the token
  meter's own records, CSV download, and monthly budgets per person or workspace that warn once when
  nearly used and once when reached (push notification and audit row). The owner sees everyone; a
  household member only their own.
- **Crews (EC12, owner request; `docs/CREWS.md`):** standing specialist helpers. Team → Crews: one
  to four of your helpers with standing parts, a brief, a budget and a time (by hand, daily, weekly,
  or when your own mail to Sara's mailbox has the crew's subject words). Sara leads each run as a
  team task: one board card per member with its receipts, one summary, a crew card in the crew's
  chat, a report file in the crew's folder and, if you like, your Telegram. *Stop all* stops and
  pauses every crew. Three templates: Research desk, Code review crew, Weekly planner. Owner only;
  policy pin *Crews: Off*; audited.
- **Overnight memory tidy (EC13, owner request; `docs/MEMORY_TIDY.md`):** opt-in (Memory →
  Overnight tidy). Once a night in your quiet hours she merges duplicate notes, asks about notes
  that disagree (Keep the newer / older / both) and sums up old threads; she never deletes, and the
  morning card has Undo for every change. Models on this computer only by default; private chats
  and sensitive person facts never go to a cloud model; each household member's tidy keeps to
  their own notes. Policy pin *Overnight memory tidy: local / off*.

## 2.82.0 (2026-11-07): one-click programs and 21 companions

### Fixed

- Playwright and Chrome DevTools tool servers on Linux find an installed Google Chrome (or Edge/Chromium): its system folder is now visible, read-only, inside the tool-server sandbox.

- **Programs add-ons need, installed with one click (PRQ, owner request; `docs/PREREQUISITES.md`):** a
  tool server's card and Settings → Add-ons → Other programs show what is missing on the computer
  where Sara runs (Google Chrome, uv, Docker, Node.js, Python, Blender, FFmpeg), and **Install it for
  me** installs it with the system's own installer (winget, Homebrew, apt/dnf/zypper/pacman, or a
  pinned vendor archive checked by sha256): a card with the exact commands first, then live progress
  with Stop, then a re-check and **Continue install**. Owner only; *Program installs: Ask first /
  Allowed / Off*, pinnable by the policy; every outcome is an audit row. Docker Desktop, Linux without
  root or password-less sudo, and other cases Sara can't install show the exact manual steps.
- **21 companions in the Sara Store (signed sequence 6):** Settings → Add-ons → Get more → Companions now
  lists the four starters (Juniper, Rowan, Vesper, Jax, which were never actually published) and 17 new
  first-party companions with different styles and interests: Marisol (Spanish tutor), Élodie (French
  tutor), Kenji (Japanese tutor), Dex (blunt fitness coach), Lucia (chef), Priya (study buddy), Wren
  (writing partner), Hollis (a listener, not a therapist), Inês (budget planner, not financial advice),
  Tavi (gamer), Nia (music producer), Ambrose (history buff), Bram (gardener), Zara (travel planner),
  Arjun (startup co-founder who codes), Theodora (philosopher) and Kestrel (SFW fantasy role-play
  captain). Every one is an adult, rated for everyone and not romantic, with a portrait and avatar made
  with OpenAI GPT Image 2 (`docs/images/companions/PROVENANCE.md`), a built-in voice, a hello and
  boundaries. *Add* shows her card first and makes a new companion; *Retire her* removes her. The add-ons
  website shows each companion's portrait and an example exchange.

- **Security:** the Schema and Data Contract Validator add-on 1.0.1 ships rebuilt bundles of protobufjs
  7.6.6 and Ajv 8.18.0 (1.0.0 carried 7.5.4 and 8.17.1: code execution from a crafted schema,
  CVE-2026-41242; a hang on a truncated `.proto` option; Ajv `$data` ReDoS). Signed Store sequence 5
  lists 1.0.1 (1.0.0 kept); *Update* in Settings → Add-ons installs it. Behaviour is unchanged.

## 2.81.0 (2026-11-07): ready for work and teams

- **Security:** developer qualification tool locks bumped for the 26 open Dependabot alerts: protobufjs
  7.6.6 and Ajv 8.18.0 (developer-data), Ajv 8.18.0 (developer-security), Vite 7.3.7 with esbuild 0.28.2
  (developer-mcp-public), basic-ftp 6.2.6 by override (developer-mcp-mongodb); `npm audit` is clean there and at the root.
- **Metrics and tracing for operators (EC3, `docs/OPERATIONS.md`):** Settings → Data & health →
  Operations → Monitoring. Off by default. A Prometheus `/metrics` endpoint (scrape token in the vault
  or allowlisted addresses; 404 when off) with replies, model latency, tokens and cost estimates, tool
  calls, approvals, errors, tool servers, plugin jobs, chat bridges, queues, database size, backup age
  and uptime; optional OpenTelemetry traces over OTLP/HTTP JSON (sampled per reply, collector headers
  in the vault, no message text, prompts, files or keys in any span); a public readiness probe
  `/api/health/ready`; a sample Grafana dashboard (`docs/monitoring/grafana-dashboard.json`). No new
  dependency and no paid service.
- **One audit trail with export (EC4, `docs/AUDIT_AND_POLICY.md`):** Settings → Household → Audit
  trail lists every sensitive change, sign-in, decided approval card and background run for you, your
  companions and household members (who, what, where, outcome, policy revision; field names, never
  values, keys or chat text). Rows are SHA-256 chained (*Check the chain* names the first bad row), can
  be filtered, exported as JSONL or CSV in a ZIP with a hashed, signed manifest, and kept 30/90/365
  days or for good; unsettled delivery rows are never pruned. Owner only; apps with a device code and
  household members can't read it.
- **Policy profiles (EC5):** Settings → Household → Policy pins rules for everyone on the server
  (allowed provider kinds, Always ask / Never ceilings for commands and tool servers, Always allow off,
  adult mode off, no internet for commands, private local mode on, Store signed-only or off, audit
  retention). Pinned settings show *Set by your admin* and the server refuses changes (409, naming the
  policy) from the app, the API and every route, the owner included; the tool ceiling beats *Always
  allow this tool* and a tool server's *Everything*. Policy changes and imports are audited; JSON
  export/import for repeatable setups; the safety check-up reports drift. No policy = no change.
- **Company sign-in for business instances (EC2, on branch `hermes/ec2`):** organizations can let
  people sign in with Microsoft Entra ID, Google Workspace, Okta, Keycloak or another OpenID Connect
  provider next to passkeys. Authorization code flow with PKCE, signed ID tokens checked with Node's
  own crypto (RS256/ES256, key rotation, issuer/audience/expiry/nonce), an email-domain allowlist,
  groups mapped to administrator or member, invitation-bound first sign-in by default with optional
  just-in-time accounts, a session length and a regular session check so a person disabled at the
  provider loses access. The setup person's passkey always works as a break-glass sign-in. The admin
  page shows the redirect URL to copy and plain setup steps per provider; the client secret stays in
  the operator vault. Personal and household installs are unchanged. Guide: `docs/BUSINESS.md`.

- **Slack (EC1, `docs/SLACK.md`):** talk to her in Slack through a small Slack app you create from a
  manifest the new *Settings → Chat apps → Slack* card shows (copy, paste at api.slack.com). Socket Mode,
  so Sara needs no public address. Her DM is your own chat with tools, pictures and files both ways and a
  progress message with ⏹; her requests for your OK come as **Allow / Deny** buttons that only you can
  answer. DM threads are their own sessions; in channels you switch on she answers mentions in a thread
  (no tools unless *Owners can use her tools in groups*). `/sara` commands, Slack's rate limits waited
  out, reconnects with backoff, token errors in plain words. Both tokens live in Sara's vault and go when
  the plugin is removed. Comes with Sara as a plugin, off until you add it. Tested against a stand-in
  Slack; a real workspace is an owner check.
- **Plugins (EC1):** a chat plugin may connect to one named public domain and its subdomains
  (`"host": "domain:slack.com"`, always encrypted, shown on the review card), and may show her approval
  requests as Allow / Deny buttons (`permissions.bridgeApprovals`, on the review card; Sara checks that
  the owner pressed it). A thread turn in a plugin chat now answers in its thread.
- **Docs:** the GitHub front page and its five translations show the 2.79/2.80 look: a Docker one-liner
  at the top, real screenshots of the new UI (chat in Night and Day, an approval card with *Always allow
  this tool*, All settings, Ctrl K, Appearance, Pictures from her, Get more, Today, Planner, a phone) in
  `docs/screenshots/v3-*.webp`, new art, a Look and navigation row and two developer rows. The 2.8.3
  animated demo is retired.

## 2.80.0 (2026-11-07): every installer checked end to end

- **Updating a tool server keeps your settings (Q-ADDONS, `docs/ops/Q_ADDONS_MCP.md`):** the update card
  from Get more now shows the values you saved (for example your ComfyUI address on another computer)
  instead of the recipe's defaults, and an update that leaves a value out keeps the saved one instead
  of resetting it. Secrets are still never shown.
- **ComfyUI recipe 1.0.1 (prepared for the Sara Store):** the B2 tip about a ComfyUI on another
  computer and the ask-first installers reach existing installs as an update.
- **Files tool server on Linux:** the folder you pick for it is now reachable inside the tool sandbox
  (bubblewrap); it refused to start before ("None of the specified directories are accessible").
- **Plain words for HTTP tool servers:** a refused key says to check the key or token saved for it,
  and an address where nothing answers says to check that the program is running (were "MCP HTTP
  401" and "fetch failed").
- **Playwright recipe 1.0.1 (prepared for the Sara Store):** says it needs Google Chrome on the computer
  where Sara runs; it never downloads one.
- **Fix: a Store plugin removed from its Plugins card can be added again (Q-ADDONS):** *Remove* on
  the Plugins card left the Store's record of it behind, so *Get* in Get more then refused it with
  "The saved store association no longer matches the installed plugin". Removing it now also forgets
  that record when it matches the removed version exactly (test/phase125.test.ts).
- **Fix: retiring a companion right after adding her no longer stops Sara (Q-ADDONS):** her delayed
  start-up work (resuming a history import after 20 seconds, the first search-index pass) still ran
  after *Retire her* had closed her data, and the "database is not open" error stopped the whole
  server. Retiring now cancels it (test/q-addons-retire.test.ts).

## 2.79.0 (2026-11-07): an advanced look and pictures like a person

- **Easier to find everything (V3, `docs/ops/V3_DESIGN.md`):** the sidebar starts with *Go to* (Today,
  Planner, Library, a new *Add-ons* place for the store, Moments, More), then Projects, then the
  conversations, with Help and Settings in a footer row and a Ctrl K hint by the search box. Settings
  opens on *All settings*: every page under its group with a line on what the group is for, one click
  away, and *Settings › group › page* above each page. Search knows more words for pages ("store",
  "projects", "documents", "glass"…). Ctrl+K also finds projects and has *All settings*, *Appearance*,
  *Find a setting* and *Reset the look to the defaults*.
- **A more advanced look:** *Full* decoration outside Sara Classic is now a refined layer: soft glass on
  the sidebar, header and windows only, a faint glow on the main button, a thin accent ring around her
  face instead of the halo and sparkles, and a very slow, faint light behind the app; solid where blur
  can't be drawn, with Reduce transparency, in forced colours and in High contrast. Text on every glass
  surface stays at WCAG AA (tested).
- **Appearance page:** three groups (Theme, Layout and text, Chat behaviour), palette cards and colour
  swatches as the controls, short choices as segmented buttons, a live preview and *Reset to defaults*.
- **New defaults (the owner's):** Follow the system, Blue, Full decoration and 5 sessions shown, for
  every choice not made yet on a device (Graphite, small picture, Comfortable, Normal text and replies
  as fast as they arrive stay). Choices you made stay; Sara Classic keeps its earlier defaults.
- **Fixed: "can you see ComfyUI?" ended with a false answer (B2).** When only part of a big tool
  server fits, read-only and status tools come first (installers, downloads, restarts and
  report_issue last), so she gets ComfyUI's health check. A tool error that lists allowed values now
  names the field's values and tells her nothing ran and to try again or use find_tools. After a tool
  error she no longer guesses a cause or asks you to install something before checking; a reply that
  says something isn't installed or running after only failed calls, or that she sent a picture or
  file when nothing was attached, is marked as not checked.
- **Fixed: pictures from tool servers were dropped.** An image a tool server returns (ComfyUI's
  get_image) is attached to her reply like her photos (PNG, JPEG, WebP or GIF, up to 8 MB, 4 a call);
  otherwise the result says why not.
- **Fixed: the edit form of a Store tool server looked empty.** Settings → Other programs shows its
  saved settings (secrets as Saved, with Replace), keeps vault values you don't change and keeps the
  Store's type. An address that answers like a web page says so in plain words. The ComfyUI recipe
  explains a ComfyUI on another computer (e.g. its Tailscale address), that installing tools act on
  the computer where Sara runs, and asks before installing, training, snapshot and file-writing tools.
- **Pictures like a person (E7):** she can send a picture on her own now and then (off by default;
  rarely, sometimes or often, never more than one a day, inside her own-message rules and a monthly
  limit), made with the engine you pick: Grok Imagine, OpenAI images, a ComfyUI workflow (paste it in
  API format, pick the prompt node) or another image tool. **Send one now** tests it.
- **Always allow:** an approval card can allow a tool for good (with Undo), and each tool server has
  one choice: Ask me first, Always allow the safe ones, Always allow everything, or Never.
  Installing, downloading, restarting, removing and training keep asking. Guide: docs/PHOTOS.md.

## 2.78.0 (2026-11-07): a finished professional look and five run-and-check add-ons

- **More developer add-ons that really run things, as local candidates:** Documentation Doctor (N24)
  finds broken local links and headings in a staged project's Markdown and runs one documented
  command only when you pick it, as a job you approve, with its real exit code and output; text in
  the documentation is never run on its own. Release Readiness (N10) runs a project's configured
  local release gates, one approved job each, and says ready only when every gate really passed; a
  failing gate blocks, and publish, sign, upload or CI gates are refused. Repository Onboarding (N01)
  maps a staged repository and reproduces the build its README documents, exactly as written, with
  a real exit-code and output receipt; invented commands and missing documented prerequisites are
  refused. `npm` commands, gates and builds are held on Windows (bubblewrap only).
- **New look, the rest of the design:** each chat turn shows name, time and how long she took; one
  model · workspace chip with a small context meter in the header; Settings as a full-height panel
  listing every page under plain headings; usage and a run's model calls as real tables; a Projects
  section at the top of the sidebar; calmer add-ons/store tabs, first-run cards and offline page.
  Sara Classic is unchanged.
- **Under the hood:** `web/pro.css` folded into the screens' own stylesheets (no visual change,
  checked value by value).

## 2.77.0 (2026-11-06): a professional new look

- **Two developer add-ons that really run tests (N03, N04), as local candidates:** Test Doctor
  runs one named test once as a job you approve and points at the real failing assertion
  (expected, actual, line) and the source it calls; timeouts, todo failures and non-assertion
  errors get no root cause. Flaky Test Lab repeats one test up to 20 times in one approved job and
  calls it flaky only when it both passed and failed, with every seed's outcome. Both run in a
  throwaway copy of what you staged; not OS-sandboxed on Windows.
- **Plugin jobs (H_EXEC):** a plugin that declares `permissions.run` can ask Sara to run `node`
  (or `npm` where bubblewrap exists) for it. You approve each job on the Plugins page, with the
  exact command; it runs in a throwaway copy of its own files or your main workspace (no `.git`,
  links or dependency folders), returns the real exit code, output and changed files, and the copy
  is deleted. Nothing is written back to your workspace. On Linux with bubblewrap it is sandboxed
  without network; on Windows and elsewhere it is **not OS-sandboxed** (Node's permission model
  only, limited to the copy). A job stops when you press Stop, when the plugin is switched off,
  when its time is up or when the plugin's request ends. See [Plugins](docs/PLUGINS.md).
- **Fixed: a plugin's tool request could still run after the plugin gave up.** When a plugin asks
  to use one of her tools, the approval now lasts only as long as the plugin task that asked: when
  that task times out, finishes, fails or the plugin stops, the card disappears at once and a late
  Allow answers *expired* (nothing runs). A plugin can no longer ask outside a task Sara started.
  Chat, team and live-call approvals likewise report *expired* when their turn, step or call ended.
- **Read a feed together (E6):** in the Library press *Read a feed together*, paste the address of
  a public RSS or Atom feed and press *Open*. Sara fetches it once (only on *Open* or *Reload*) and
  lists the items as plain text; press *Share* on one and she comments on exactly that item. If you
  reload and it changed or vanished she says so. *Stop* ends it; nothing is remembered. Feed text
  is treated as written by strangers, and her outward tools are off while an item is shared. Owner
  only; not in private mode. See [A feed together](docs/LIBRARY.md#a-feed-together).
- **A professional new look and real themes (V1, [design](docs/ops/V1_DESIGN.md)):** Sara now looks
  like a calm, dense work tool. *Settings → You → Appearance* (its own page now) picks a palette:
  Graphite (the new default), Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast or
  **Sara Classic** (the rose and violet look, unchanged), each in Night and Day; a colour (the
  palette's own, eight presets, or any colour: Sara adjusts its shade so text stays readable);
  *Layout* (compact sizes now apply app-wide); *Decoration* (aurora, glows, glass and blur: on for
  Sara Classic, off for the rest); and her picture size in work views (small by default). Chat is a
  transcript instead of bubbles; buttons, fields, tabs, cards and windows are flat with small radii
  and system fonts only. *Use on all my devices* saves the look for new devices. People who used Sara
  before see one notice with *Switch back to Sara Classic*. Every palette's text and accent pairs pass
  WCAG AA (checked by a test).
- **Fixed:** markdown tables in her replies show as tables instead of raw `| a | b |` text, and a
  Settings page title no longer gets a focus box when the page opens.
- **Expressive voice per engine (R2d):** each voice now gets only the sounds its maker documents.
  ElevenLabs with an `eleven_v3` model laughs, sighs and whispers too; Grok voice no longer gets a
  tag it does not know; other voices read the plain words. Not yet confirmed by ear (owner check).
- **Recovery times in your language:** delivery cards show "5 minutes ago" (or the date after a
  week) instead of a raw ISO timestamp; hover for the full local date and time. Stored times are unchanged.
- **Log level in Settings:** Settings → Data & health → Health → *Log level* (owner only) picks how
  much goes into her log, saved and applied at once. `SARA_LOG_LEVEL` on the server still wins and
  the page says so. See [Logs](docs/INSTALL.md#logs).
- **Scene chips in the chat (shared scenes follow-up):** the *In scene* chip now opens the scene
  card; a fact she saves shows *Saved to the scene: …* in the chat, and a line you picked with Add
  to scene shows *Canon: …*. Both open the card. Owner only. See [Shared scenes](docs/SCENES.md).
- **Fixed: the code map on Node 26 (issue #9).** Re-indexing a changed or deleted file stopped with
  "Value is too large to be represented as a JavaScript number"; every code-map write now reads
  SQLite's row numbers safely.
- **Fixed: buttons that waited with several Sara tabs open.** Each tab kept its own live-updates
  connection, and over plain HTTP a browser opens only six per server, so with six tabs (or five
  and a streaming reply) every press, such as Allow on a proposal card, waited. All tabs of a
  browser now share one connection; when that tab closes, another takes over.
- **Three lab developer add-ons as local candidates (N09, N25, N28):** Performance Regression Lab
  measures staged baseline/candidate benchmarks interleaved and keeps raw samples (noisy or small
  runs stay inconclusive, without a percentage); Code Migration Studio previews a scope-aware AST
  import rename and applies only the approved hash-bound patch to a staged workspace copy; Build
  Reproducibility Inspector builds a staged fixture twice and explains time/path differences from
  the artifacts. Off until enabled, tool access Ask, no network or model. Not signed or listed yet.
  Offline and PWA Auditor (N18) and Mobile Device Lab (N30) stay held. See
  [Developer add-ons](docs/DEVELOPER_ADDONS.md).
- **Developer connections in Other programs (MCP):** the thirty developer MCP targets (Local Git
  through CircleCI) now appear with a plain state. Storybook and local Qdrant passed a real
  fixture test with pinned upstreams and no account; *Copy into the add form* fills the normal
  form switched off, and nothing starts until you save it enabled. Twenty-two others show the
  exact account or service step they need first, and six are blocked with their reason; neither
  has an install action. See [Developer add-ons](docs/DEVELOPER_ADDONS.md).

## 2.76.0 (2026-11-06): developer add-ons

- **Watch alerts on Telegram or Discord, and in the chat you pick (E4 follow-up):** each watch has
  *Also send to Telegram / Discord*, off by default and offered only for a bridge linked to you;
  alerts then also reach your own Telegram chat or Discord DMs (never a group, server channel or
  anyone else), with the same limits and the same cut, scrubbed line. *Alert cards go to* picks
  which of your own chats gets the card (default: the most recent). See [Watch a file](docs/WATCHES.md).
- **Fixed: red-team runs that came out differently on a busy computer.** When she re-runs a break
  to confirm it, she now waits for the app's actual answer (unless the break was a hang), so a crash
  that answers slowly is no longer dropped as "did not happen again". Restarting the app between
  probes waits until the old copy has really stopped and freed its port (a fixed pause used to end
  in "port already in use"), and each attacker script gets a freshly started app before its own
  time limit starts. The test app's "breaks only after earlier requests" route now counts in its
  copy, so its test no longer depends on how busy the computer is.
- **Developer add-ons in Settings (A2):** the nineteen developer add-ons (secret scanner, license
  auditor, SBOM builder, API contract guard, HTTP and webhook workbench and more) now appear in
  *Settings → Plugins → Workflow candidates* beside the twelve workflows, marked *Host-tested*. Same
  review, install and per-companion switch as before; each installs Off. Every library entry is
  shown once: 16 signed Store items in *Get more*, 31 workflow candidates, and 21 connection
  previews or blocked investigations that stay visibly held. See [Add-ons library](docs/ADDONS_LIBRARY.md#what-sara-shows-today).

- **Developer add-ons (merged from the add-ons session, store release separate from a harness
  version):** nineteen local-only native developer add-ons were published in signed Store
  sequence 3 by the add-ons session (31 signed items; earlier records unchanged) and listed on
  the enterprise website. Installs stay Off until enabled. Full supported scopes:
  [Developer add-ons](docs/DEVELOPER_ADDONS.md). MongoDB stays blocked by its reproduced upstream
  zero-limit row-cap bypass; Local Git is blocked for project use after real external-diff,
  textconv and outside-config canaries. Remaining developer targets are not promoted.

## 2.75.0 (2026-11-06): calls work like the chat

- **Calls work like the chat (R2a–R2c):** on a call she has the same memories, other-chat
  context, checkpoint, tools and Adult-mode rule as typing in that chat (a household member gets
  their own). A tool that needs your OK shows its card on the call screen and she says so; only a
  tap answers it, and hanging up, talking over her or two minutes without a tap cancels it. Live
  calls can now use her tools (not commands, her hands or SSH), with a note of each result in the
  chat; on a voice without tool calling the screen offers *Switch to classic*. See [Video calls](docs/VIDEO_CALLS.md#what-she-knows-and-can-do-on-a-call).

## 2.74.0 (2026-11-06): read together

- **Fixed: cards that looked stuck.** When you press *Use it*, *Edit first*, *Not now*, *Install* or
  another button on a suggestion card, the button now says it is working and the card ignores
  further presses until the answer comes back; if it fails, the card is usable again.
- **Read together (E5):** open a text or Markdown document in the Library and press *Read
  together*; it opens above your chat. Select some text and press *Share this passage*, or switch
  on *Follow my place* (off by default), and she comments on exactly that text at that version. If
  the document or passage changed she says so instead of using old text. *Stop* (or your stop
  word) ends sharing at once; a restart ends it too. Owner only, and with *Nothing leaves this
  computer* on only a model on this computer sees it. See [Read together](docs/LIBRARY.md#read-together).
- **New GitHub front page:** a brand hero banner, one-sentence summary, download/install/star
  and update actions, a "What Sara does" grid with one line and guide links per area, a developer
  path, the recent-releases table cut to six rows with older history folded, and a trust, safety and
  legal section. The screenshot feature tour moved to [docs/FEATURES.md](docs/FEATURES.md); new
  illustrations live in `docs/images/brand/`.

## 2.73.0 (2026-11-06): watch a file

- **Watch a file:** in *Planner → Routines*, Sara can watch a log or file in one of your
  workspaces (or her own log) for a few words like `ERROR`. When a new matching line appears she
  posts a chat card and sends a notification, at most one every 10 minutes and 12 a day, with
  repeats counted up. Each watch has *Check now*, *Pause*, *Stop* and *Stop and forget*. Reading uses
  no model, she never fixes anything by herself, and a line goes to a model only when you ask
  about it. Owner only; watches pause after a restart and end after 30 days. See
  [Watch a file](docs/WATCHES.md).

## 2.72.0 (2026-11-06): honest visual checks

- **Honest visual checks:** in web work a "checked at phone width" claim needs a screenshot at
  phone width (390 or up to 480px), and "it's fixed / looks right now" needs a screenshot or a
  passing browser check after her last edit; otherwise the reply is marked unverified (not
  blocked). Her coding instructions say to check again after a fix. A scripted end-to-end test
  covers edit → preview → screenshot → fix → check again. See
  [Web pages: look, fix, look again](docs/FOR_CODERS.md#web-pages-look-fix-look-again).

## 2.71.0 (2026-11-06): project continuity

- **Project now:** owner coding chats see which other coding chats of yours
  are active on the same project (titles, times and touched files, never message text), and every
  check, goal and checkpoint result says what it ran on: current, stale since a time with what
  changed, or basis unknown. Sara must re-run a stale check before saying it passes. A note only:
  nothing is locked or re-asked. See [Project now](docs/FOR_CODERS.md#project-now-other-chats-and-current-checks).

## 2.70.0 (2026-11-05): shared roleplay scenes

- **Shared scenes across your own chats:** play one story
  across your own web chat and your own Telegram or Discord DMs. Settings → Chat apps → Session
  continuity → Shared scenes: create a scene, link chats after seeing who will experience it, and
  keep short canon facts with history, retire, reset and delete. Her replies in linked chats get the
  current canon in one marked, capped block; messages are never copied between chats. Editing or
  forgetting a source line, privacy/channel/archive changes and room identity changes revoke what
  came from them. Crisis turns leave the scene out, the stop word pauses it, adult scenes need Adult
  mode, minors canon is refused. Household scenes are a later slice. See
  [Shared scenes](docs/SCENES.md).
- **One shared room per scene:** link one Discord channel, Telegram group or DM with a guest
  to a scene after seeing exactly who is in it (Confirm is bound to that room). Guests experience the
  canon in her replies and keep every partner rule: no tools, approvals, memories or your other
  chats. Their words become canon only when you pick a line with **Add to scene** in its message
  menu; her replies there never record canon. Adult scenes take only adult rooms while Adult mode
  is on, never a guest DM. Linked chats show an "In scene" chip, to you only.
- **Her scene canon tool:** in your own linked chats she can read the scene's canon and
  save facts with `scene_canon` (revision-checked, same safety checks as your own canon); retiring
  a fact always asks you first. Her facts are marked "Written by her in a linked chat" and are erased
  with the reply they came from. Never offered outside your own scene seats, in replays, on crisis
  turns or when set to Never.

## 2.69.0 (2026-11-05): add-ons in existing Settings

- **Companion-pack ratings:** dotted release numbers such as 2.69.0 no longer count as explicit
  prose. Standalone explicit terms still require the Explicit rating; minors, privacy and raw
  duplicate-field checks remain intact.

- **Development checks:** cap independent test files at four to avoid oversubscribing child
  processes on large development machines. The full test set, assertions, timeouts and each
  application's concurrent-user tests remain unchanged.

- **Existing Settings discovery:** twelve supplied-data workflow
  candidates use the normal Plugins review, trust and per-companion enablement flows. Seven MCP
  recipe previews, fourteen blocked investigations and six starter guides explain prerequisites,
  permissions, costs and qualification limits. Search follows displayed translations; disclosures
  and contained retry work on desktop and phone. No automatic installation, connection or enablement.
- **Honest source and approval state:** local candidates stay distinct from signed Store releases.
  Stale reviews, concurrent mutations and outdated downloads cannot replace newer authority;
  rollback preserves current signed block/yank evidence and cannot invent a signed association.
  Forgetting an obsolete Store record preserves a replacement plugin. Off remains immediate.
- **Complete distribution payloads:** Windows, macOS, Docker and Linux copy the twelve candidate
  packages with their SDKs/assets. Linux also preserves all five existing builtin plugins and
  removes stale candidate files on rerun.
- **Scope:** Image Workshop prepares prompts; Home Dashboard summarizes a supplied non-live
  snapshot. MCP recipes remain preparation previews, with explicit annotation/OAuth/approval/cost
  limits. The live website, existing signed metadata and package URLs are unchanged. See
  [the library's scope and limits](docs/ADDONS_LIBRARY.md). 
- **Qualification:** 3033 automated tests: Windows 3017 pass/0 fail/16 skip; Linux 3018 pass/0
  fail/15 skip. Thirteen isolated desktop/mobile browser journeys pass. Actual Windows and the
  signed/notarized universal Mac package pass their recovery/regression profiles and the add-ons
  checks, including four refusal cases; both container architectures carry exactly the twelve
  candidate packages and pass personal/business health checks. Windows is unsigned. Synthetic
  data and scripted providers; physical-device, screen-reader and real-account checks stay separate.

## 2.68.0 (2026-11-05): owner-session continuity

- **Context across eligible personal chats:** refresh linked owner-session context at actual provider boundaries, coordinate provider steps within the same companion store, and offer bounded historical reads and internal handoffs. Source edits, forgetting and privacy changes invalidate affected context. Internal notes never send human messages, grant tool authority or certify completed work.
- **Owner controls:** separate Session continuity switch and current-conversation inspector with literal-text source/time/expiry, latest-versus-history labels, confirmation and conflict-safe target-only clear. Expired retained notes can be explicitly cleared while the feature is off. Keyboard focus returns to enabled recovery controls.
- **Accurate provenance and audit:** native JSON imports retain host import markers; historical rows with unknown origin are not labelled authenticated owner speech. Final tool-offer audits are refreshed after waits, including additions, removals and schema-token estimates. Existing audit history is retained.
- **Guided first use:** Settings navigation, page help and three How do I answers with a real Show me control, translated in five languages. Existing pickup/busy preferences and every previous page remain intact.
- **Qualification:** reviewed source passed2709 automated tests: Windows2693pass/0fail/16skip; Linux2694pass/0fail/15skip. Ten isolated desktop/mobile browser journeys and actual Windows/Mac recovery, twelve approval-revalidation cases,286 compatibility cases and77 continuity cases pass. The universal Mac installer is signed and notarized; Windows is unsigned. Synthetic data and scripted providers establish harness behavior; physical Intel, screen-reader/device acceptance, real-model tone and production recovery remain separate checks. Household members, business actors, private/partner/off-record/room/imported/external contexts stay separate. Shared roleplay scenes, project coordination and full voice/video parity remain future slices.

## 2.67.0 (2026-11-05): continuity and conversational attunement

Includes the checkpoint and coding hardening work planned for2.66.0, which was not published as
a separate public release. Earlier qualification evidence remains separate from this release's gates.

- **Recent explicit cues:** normal owner chat/coding replies can adapt to bounded current fatigue,
  task frustration or directed conflict without treating software criticism as a personal attack.
  Six-language rules, corrections, current-source rechecks and original expiry use the existing
  inner-life opt-out. No extra classifier call or separate durable owner mood profile is added.
- **Character privacy:** newly built prompts omit historical raw disagreement quotations; true
  owner conflict/apology reactions and ordinary private owner interaction retain their character
  behavior. External/untrusted and unknown queued origins do not mutate owner-derived state.
- **Qualified follow-ups:** explicit event outcomes/cancellation/decline replace loose name overlap.
  Current source ownership, workspace, privacy and chronology are revalidated, including changes
  during proactive generation. Cancelled or revoked dates do not post or update delivery state;
  actual usage is still recorded. Old/imported notes remain editable without minting owner proof.
- **Agenda answer provenance:** identifiable question/answer chains and an event-date witness keep
  direct replies and rescheduled windows honest. Invalid derived completion returns only to Sent,
  preserving delivery/no-resend and manual authority; unrelated plans retain normal delivery.
- **Prompt audit and replay:** final transient notes and input hashes reflect the actual handoff
  after preparation/approval. Replays omit new transient notes and report changed inputs while
  preserving original inspection records. See [Recent cues and follow-ups](docs/ATTUNEMENT.md) for
  limits, opt-outs, source invalidation and existing history/export/backup retention.

- **Project continuity:** explicit project checkpoints keep current logic, blockers and up to three
  next steps, with bounded history and owner inspect/replace/clear controls. New coding chats can
  recover historical context without replaying commands or old approvals. Source deletion, covered
  edits and forgetting invalidate derived records; private/off-record/shared/external contexts are
  excluded. Checkpoint changes run no commands and carry no earlier approvals forward.
- **Pending coding authority:** normal turns and team helpers recheck current permissions, tool
  availability and their original conversation/workspace context before execution and sandbox
  application. Changed context stops stale planning; valid unchanged approvals and scoped grants
  retain their existing behavior. Already-started work uses the existing Stop/undo controls.
- **Windows build provenance:** Git-backed installer builds record their actual source revision
  even with Git Bash argument conversion disabled. A failed expected Git lookup stops packaging;
  historyless source archives do not borrow a parent repository's revision.
- **Coding project navigation:** opening Coding projects from Settings search loads the project
  cards through the same route as ordinary Settings navigation.
- **Coding project reliability:** late responses from a previous workspace cannot replace the
  newly selected workspace. Adding or removing project notes preserves unsaved checkpoint drafts.
- **Off-record privacy:** off-record coding contexts do not read the persistent project-knowledge
  store inherited from the ordinary app context.
- **Release presentation discipline:** local release collection checks that all six README status
  lines, newest release summaries and primary download/install/star links match the release before
  changing artifact output. No CI or recurring release watcher is introduced.
- **Publisher hardening carried forward from the unpublished 2.66 candidate:** author and committer privacy checks compare actual
  email fields exactly in both full-release and README-only modes.

## GitHub presentation update (2026-11-05; published separately from software 2.65.0)

- **GitHub presentation and publishing:** refreshed all six README entry pages with download,
  install and star links, current release highlights and folded history. The checked publisher
  supports an explicitly requested six-README-only update without changing software releases.
  This six-README-only update was published without changing the 2.65.0 software release.

## 2.65.0 (2026-11-04): guided business setup and invitation management

- **Business first use and administration:** mode-specific name/adult/code guidance, scoped next
  steps and actionable input feedback. Passkey enrollment and focus changes refresh authoritative
  access metadata across tabs while keeping unchanged drafts, original requests, unsaved admin
  choices and displayed private codes. Fresh colleague rows and invitation choices update in place;
  closed sessions and delayed authentication replies cannot silently reopen protected work.

- **Business operator configuration check:** `--business-check` reports bounded, read-only local
  configuration evidence and ordered next actions. Missing roots remain missing; databases,
  credentials, content, pending usage and recovery state are never opened or changed. Unsafe or
  changing layouts fail closed, and live access, inference, custody and availability stay explicitly
  unverified. Invalid business command shapes are refused before data initialization.

- **Business invitation history:** authorized administrators and workspace managers can see the
  latest 100 invitations for their own management scope, with expiry and current status, and revoke
  pending invitations. Private codes are shown only at creation. Used invitations remain accepted
  in history even if their code is later revoked; current membership is managed separately.

- **Repeatable business qualification:** a manual combined browser, configuration and encrypted
  recovery drill preserves original child logs and fails on missing, invalid or failed receipts.
  Synthetic engineering evidence stays distinct from real people, backup custody and production
  availability. Container images now include the physical MIT license alongside their metadata.

## 2.64.0 (2026-11-04): separate business workspaces (B1)

- **Business workspaces:** optional separate business profile with individual passkeys,
  explicit workspace roles and transactional invitations. The business desk shows audience, role
  and model destination before sharing text/Markdown. Scoped search/events, per-session drafts,
  bounded document selection and read-only original-request checks preserve workspace boundaries.
  Operator-only model policy, atomic lifetime allowances and durable request IDs keep uncertain
  usage held without automatic regeneration. Metadata audit, graceful draining and encrypted
  generation backups support closed restore with fresh passkeys, explicit grant reconciliation
  and conservative spending acceptance. Routine lost-sign-in recovery affects only that person;
  ordinary spending-pause acceptance preserves existing access and held exposure. Personal and
  household credentials/data remain separate. See [Business workspaces](docs/BUSINESS.md) and
  [Business installation operations](docs/BUSINESS_OPERATIONS.md). Business provisioning uses the
  separate manual source/container workflow; personal installers do not convert existing data.
- **Portable business snapshots:** system temporary-directory aliases are resolved before snapshot
  creation, including macOS /var paths; archive link checks remain strict.
- **Clear first use and healthy containers:** signed-out newcomers see the invitation/sign-in
  screen without a false access-loss warning. Business container health uses the configured
  hostname while staying on loopback; invalid configuration fails closed.

- **Manual engineering qualification:** a fixed ten-minute, eight-client synthetic loopback soak
  with periodic worker backups and independently checked restores. Failure receipts wait for
  accepted workers; restored uncertainty metadata is checked as well as encrypted review text.
  Added four-space encrypted folder-copy recovery coverage, including wrong-key/tamper refusal.
  The manual tools use synthetic fixtures; no background schedule or paid service is enabled.

## 2.63.1 (2026-11-04): measured operation and safe retention (Q4)

- **Operations:** owner-only readiness evidence, bounded HTTP latency/error/inflight measurements,
  generated request IDs and fixed privacy-safe request logs. Process memory/event-loop delay is
  clearly scoped; configured models and backup files are not presented as successful inference
  or proven recovery. Public liveness remains minimal.
- **Archive resolved deliveries:** explicit cutoff, preview and bounded confirmation preserve
  unresolved uncertainty, human/transport evidence and duplicate-send identities. Archived history
  remains accessible; no automatic deletion or database-shrinking claim.
- **Responsive backups:** manual, existing automatic and Safetycheck creation runs in serialized
  worker threads. Accepted jobs drain on shutdown; later work is refused. Parallel manual snapshots
  keep distinct complete archives, and asynchronous retention tolerates files disappearing from a
  concurrent list. The archive format, encryption/key handling and offline CLI remain compatible.
- **Repeatable qualification:** synthetic workload/backup/upload/archival and real-browser journeys,
  plus an incident/restore drill. Local commands only, no CI/watchers or provider charges. See
  [Operations](docs/OPERATIONS.md) and [Recovery](docs/RECOVERY.md) for evidence and scope limits.

## 2.62.0 (2026-11-04): safe recovery after interruption (Q3)

- **Recover without blind replay:** interrupted jobs keep encrypted original requests and durable
  progress. Review a fresh restart in chat; current policy and approvals apply. Interrupted teams
  stay held until explicit review, preserve completed work and recheck privacy/publication rules.
- **Know what reached the platform:** native Telegram/Discord message creation has a durable
  delivery outbox. Uncertain results stay visible, with no automatic resend or duplicate fallback.
  Human resolution stays distinct from a platform acknowledgment; encrypted review text is available
  for held work. Unresolved/history pagination keeps older records reachable.
- **Safer restore:** recovery identities and encrypted reviews survive moving a backup; excluding
  workspaces applies to every household/companion space. Crash and isolated-boot fixtures verify
  conservative recovery. See docs/RECOVERY.md for coverage and limits.

## 2.61.5 (2026-11-04): focused settings and a clearer first step (Q2)

- **Find the setting you need:** Settings search shows focused results with descriptions and
  breadcrumbs. Open one page and return to your results without scrolling through whole forms.
- **A clearer first step:** Today prioritizes connecting a model and trying a first message before
  optional setup. Extra getting-started choices remain available without crowding the essentials.
- **Easier by keyboard and touch:** skip to the visible main view, larger help-button targets,
  and intentional tour transitions with reduced-motion support.

## 2.61.4 (2026-11-04): reliable setup, keyboard navigation and truthful safety status (Q1)

- **Model setup recovery:** after skipping setup, Default model offers the guided connection
  chooser instead of an empty provider selector. Model-only setup keeps existing connections,
  the current default and chat drafts when cancelled. In this guided flow the default changes
  only after a successful model test and confirmation. Explicitly saved connections stay saved.
- **Mobile keyboard navigation:** the closed sidebar is kept out of keyboard focus. Opening,
  closing and resizing the navigation restore the appropriate interactive state.
- **Clearer safety status:** execution isolation and command approval policy are reported
  separately. Asking before a command no longer gives an unisolated sandbox a healthy checkmark.

## 2.61.3 (2026-11-02): docs and tidy-up (Phase 128, polish PL2d; the roadmap is complete)

- **Guides up to date:** FOR_CODERS covers long jobs, the short tool list and `/compact`, the Store and the
  `/` commands (a table generated from the same list the app uses); START_HERE gains *Talk to her from your
  phone's apps*; the in-app guide has *Commands you can type*, *Long chats and /compact* and *Routines*, and
  three new *How do I…?* answers (168 in all). About 180 written paths now use the new Settings groups,
  in all six languages.
- **Code:** `web/app.js` loses its settings navigation, tours and first-run guide to their own modules
  (a pure move, checked key-for-key); the 15 plugin SDK copies, 3 http helpers and 4 pacers are checked by
  hash (`npm run sdk:sync` copies them), and the four chat-app pacers are one file.
- **Steadier tests:** seven tests that failed under load now measure CPU time or wait for the real event
  instead of a fixed pause; none of their limits were loosened.
- **Fixed:** the Store's card icons failed to load until an item page was opened; Settings search's
  "pages moved" line didn't name the groups.

## 2.61.2 (2026-11-02): choices, not forms (Phase 128, polish PL2c)

- **Keep going and repeats** is now three choices, *Careful*, *Normal* and *Long jobs*, each stating its
  limits in words; *Normal* is exactly the old numbers, and the 19 fields fold under *Fine-tune*
  (settings you changed before show as *Custom*).
- **The Store page:** a real Browse · My add-ons · Submit switch, each item shown once, a line icon for
  each kind (plugin, skill, tool server, companion), shelves as tidy grids with *See all*, and the author
  key under Details. Sara's own plugins show one calm line instead of amber warnings; plugins from anyone
  else keep every warning.
- **Icons and buttons:** line icons on routines, presets and empty states instead of emoji; disabled
  buttons are readable in both themes (at least 3:1), and routines that need setup say *Set up first*.
- **Planner:** *When it comes up* has its own card; Reminders, Repeats and Routines each have a
  *How do I…?*; an empty Repeats list offers `/loop`.
- **Fixed:** sharing a companion with suggested routines failed (the routines were sent in the wrong
  form); they're now picked from the gallery.

## 2.61.1 (2026-11-02): find it (Phase 128, polish PL2b)

- **Settings in 8 groups:** Her, You, Models, Chat apps, Add-ons, Coding, Connections, Data & health (and
  Household). No page moved its address, so old links and the tour still work.
- **Search finds things:** one index for Settings and Ctrl+K with keywords, synonyms and the *How do I…?*
  questions; `@`, `/`, *funnel*, *takedown* and *hey sara* now find their pages, and *routine* points to
  Planner → Routines. For this release the old group names (Abilities, Connections) still find their pages.
- **The `/` menu:** type `/` in the message box for every command you can use in that chat, with arrow
  keys, Enter, Esc and tap; members only see their own; the menu, Telegram's and Discord's come from one list.
- **`@` in a new chat** now opens the reference menu (it needed a conversation to exist first).
- **Next steps on Today:** once *Getting started* is done, three cards suggest the next thing (chat apps,
  the Sara Store, Hey Sara; for coders the `/` menu and tool servers), with Hide. *Share her* and the Store
  are easier to find from Her, and *Tidy this chat* is offered from 70% full.

## 2.61.0 (2026-11-02): no more brick walls (Phase 128, polish PL2a)

- **One setup card for every chat app.** WhatsApp, Matrix, iMessage, Signal, Email and Telegram now share
  one guided card: what you need, how long it takes and what it costs, the service's rules with a tick where
  they matter (WhatsApp, iMessage, Matrix), then numbered steps that turn ✓ only when Sara has checked them,
  with a plain fix under any step that fails.
- **Sara's own plugins need one OK.** Starting a chat app that comes with Sara shows a short *Add WhatsApp
  to Sara* step instead of the developer plugin card with its amber warnings; the full card is under Details.
  Only plugins Sara staged herself or whose files match a first-party entry in the signed Store list qualify;
  a copy claiming to be ours from a zip, git address or folder gets the full card, and the files are
  re-hashed at every approval.
- **Signal, guided:** get signal-cli (Windows, macOS, Linux or Docker, with copy rows), register a number or
  link your phone with a QR Sara draws, start it, and one Check proves all three. **Email:** pick your
  provider, get an app password from its page, and the server names fill themselves. **Telegram:**
  BotFather in four checked steps.
- **Fixed:** after setup, the check-in note could cover the message box (about 40% of a phone screen); it
  now sits in the page above it. A server connect that never reached the server no longer leaves a row
  behind, and Cancel removes it. Phone layouts lost a level of nested cards.

## 2.60.0 (2026-11-02): companion packs (Phase 127)

- **Share her.** Settings → Her → ⋯ → *Share her* builds a `.sara-companion.zip` of exactly what you
  tick (her character, dials, look, closet, a face reference, voice choice, first message, her skills,
  suggested routines) and shows, locked, what never leaves: memories, chats, people cards, keys and the
  vault, your name (it becomes `{{user}}`), your relationship notes, hard limits and stop word, pictures
  she sent you and a cloned voice. Picture metadata is stripped. *Check it* runs the same 15 checks the
  store uses, then *Save the file* or *Send to the Sara Store*.
- **Install a pack** as a new companion (never over one you have; the 8-companion cap and unique names
  apply) through a review card; her first chat starts with the AI notice, then the pack's greeting;
  routines are offered, never switched on. **Updates** show a three-way diff: the author's changes are
  offered, your own edits are kept, pronouns and age stay yours, and *Go back* restores the last version.
- **Character cards** V1/V2/V3 (PNG, JSON, CHARX) and Sara character files import as packs; a lorebook
  becomes at most 10 background lines, never memories, and remote links in a card are never fetched.
- **Content rules:** the minors check (look-alike letters and spacing folded) runs when a pack is made,
  reviewed and installed, with no override. A pack's rating (general, mature, explicit) maps onto Adult
  mode; explicit lines wait until Adult mode is on, and explicit packs aren't listed on the store yet.
  Real people need consent (a short name list trips the check); every picture states its rights.
- **On the Sara Store:** companions are a fourth kind (older Saras skip them); four starter companions,
  Juniper, Rowan, Vesper and Jax, made by us (looks to come).
- **Fixed:** exporting a character card or character file included your name, relationship notes and
  hard limits; they're removed now, and importing it back fills in the new owner's name.
  Guide: [docs/PACKS.md](docs/PACKS.md).

## 2.59.0 (2026-11-02): "Hey Sara" (Phase 126)

- **Say her name and talk, in the Windows app.** A 5 MB keyword model (sherpa-onnx, Apache-2.0) runs on
  your computer and listens only for "Hey Sara" (default: "Hey" and her own name), or up to 4 phrases of
  your own, each for one companion. Nothing is sent until the phrase; recording starts after it with no
  buffer from before, the clip is transcribed in memory and never kept, and the tray icon's dot shows
  when she's listening. "Stop" cuts her off. Off by default; only a device can switch itself on, any
  device or the owner can switch it off; it pauses while the screen is locked; when several devices hear
  you, the first to claim it answers. Each exchange is an ordinary turn in her "Hey Sara" conversation:
  the AI notice is spoken first, crisis resources are read in full, the minors block applies, and a
  desktop counts as a shared room unless you mark it *Just mine*. Settings → Her → *Hey Sara*.
- **Talk to Sara without the wake word:** Ctrl+Alt+Space or the tray item on Windows; on Android a
  microphone notification with Talk, Pause and Stop, and a Quick Settings tile. (Android's always-on
  detector and the Mac and Linux apps come in a later 2.59.x.)
- **Local hearing and voices on Windows:** `sara voice install` (or Settings → Voice → *Install*) now
  works on Windows, about 650 MB of optional downloads, each checked against a SHA-256 pinned in Sara, and
  refused in "Nothing leaves this computer" mode. Before, local voice was Linux only.
  Guide: [docs/HEY_SARA.md](docs/HEY_SARA.md).

## 2.58.0 (2026-11-02): get more, and submit your own (Phase 125)

- **Settings → Abilities → Get more:** browse and search the Sara Store, an item page with screenshots,
  checks and permissions, and one-click install through the existing review cards. Plugins and skills
  use their usual review with the store strip; nothing switches on by installing.
- **Tool servers get their own card** before anything starts: the exact command and arguments, the
  Windows form, where the code comes from, what it needs (found or not on this computer), what it can
  reach, whether it runs fenced, its fields, and keys that go only to the vault. *Add and start*, then
  an automatic Test.
- **Updates** show exactly what changed (new permissions marked; a tool server's changed command or
  version), never apply without your OK, and can be undone. **My add-ons** lists every add-on with where
  it came from. Getting a tool server you already have on that version says so.
- **Submit your own, no GitHub needed:** `sara pack` checks a plugin, skill or tool-server recipe on
  your computer (size limits, manifest, permissions, a secret scan, a fenced smoke test, screenshots,
  listing); *Submit* in Settings or `sara submit` sends it in chunks, signed with an author key Sara
  keeps in the vault. The same checks run again on our side, then the Sara team reviews it; follow and
  answer under *My submissions*. Listed items show *Reviewed* and their checks.
- **Reports and takedowns:** *Report* on any item; a pulled add-on is switched off with the reason
  shown, never deleted, and switching it back on needs a confirm.

## 2.57.0 (2026-11-02): the Sara Store opens (Phase 124)

- **A signed shelf at [backstagecoding.com/sara/store](https://backstagecoding.com/sara/store/)**, live
  today with 12 first-party add-ons: the plugins Weather alerts, Focus, Home scenes, GitHub digest,
  Reading list and Webhook notes, and tool servers for ComfyUI, Blender, a browser (Playwright),
  GitHub, files on this computer and docs (Context7), each pinned to an exact version.
- **Checked before it's shown:** an Ed25519 signature over the exact list (Sara ships the public keys),
  sha256 pins for every entry, picture and package, a sequence number and an expiry date, and key
  withdrawal. A damaged, older or withdrawn list is refused and the last good one kept; offline,
  Sara shows the cached shelf marked *offline*. Browsing sends no id, cookie or query, never in the
  demo, in "Nothing leaves this computer" mode or for household members. Settings → Privacy → *Sara
  Store* (on, with *Check now*).
- **Installing stays safe:** store add-ons go through the usual plugin review card with a *From the
  Sara Store* strip, and nothing switches on just by installing. An add-on pulled from the store is
  switched off with a *Pulled from the Sara Store* chip, never deleted. Plugins, Skills and Tool
  servers link to the store.
- **Skill tidy-up:** unused skills can be archived and brought back (Skills → *Tidy up*).
- Browse-and-install inside Sara and submitting your own add-ons come in 2.58. Guide: [docs/STORE.md](docs/STORE.md).

## 2.56.0 (2026-11-02): lean and tidy (Phase 123)

- **A short tool list per step.** Every step used to send every tool she may use (67 on a fresh
  install, 141 with four MCP servers). Now code picks what to offer, with no model call: a core for
  the mode, six tools always kept for safety, your pins, the tools your words name (six languages),
  `@`-references, recent use, a loaded skill's tools and a goal's earlier rounds. *find tools* lets her
  load up to 5 more by itself; every call is still checked against the full list she's allowed, with
  the same approval cards. Measured (o200k tokens per step): fresh install 11,871 → 5,471 (−54%),
  coding 12,885 → 6,355; with four MCP servers 23,476 → 5,438 (−77%), coding 24,490 → 6,325. Switches
  on above about 6,000 tokens of tools; off for /v1, MCP-server mode, groups and partner chats.
  `/tools` lists what's offered, `/tools all` turns it off for a chat; Settings → Abilities → Tools and
  approvals → *Short tool list*.
- **`/compact`** folds the older part of a long chat into a summary for her: written on this computer
  first (private chats never leave it; else the quick model; a plain code-written list if neither
  can), with your last 6 turns kept word for word. Your messages stay in the thread, dimmed under a
  divider with *Show summary* and *Undo*. `/compact <what to keep>`, `/compact show`, `/compact undo`;
  in every chat app (Telegram and Discord menus, with an Undo button). It also runs by itself at 85%,
  between turns. Crisis messages stay word for word for 24 hours, refused requests are never
  summarised, and forgetting a message drops the fold that covered it. Guide:
  [docs/TOOLS_AND_COMPACT.md](docs/TOOLS_AND_COMPACT.md).

## 2.55.3 (2026-11-02): MCP servers start on Windows

- **Fixed:** on Windows, every MCP server started with `npx` (including the built-in presets) failed
  with "spawn npx ENOENT", because npm's `.cmd` shims can't be started without a shell. Sara now runs
  them as `node <npm>/bin/npx-cli.js …` (no shell involved); a server whose command is another `.cmd`
  script gets a plain message saying to use its `.exe` or `node` with its script. Found while measuring
  Phase 123; checked live with `@modelcontextprotocol/server-memory` on Windows 11.

## 2.55.2 (2026-11-02): iMessage through BlueBubbles (Phase 122, part 3)

- **iMessage** as an optional first-party plugin (Settings → Connections → iMessage): text her from
  Messages on your iPhone through BlueBubbles on a Mac, with an Apple ID and macOS user of her own.
  If the Mac is signed in with your own Apple ID she refuses to run (she'd see all your chats). Eight
  guided steps checked with a ✓ and plain-language fixes (BlueBubbles unreachable, wrong password,
  Messages signed out, Mac asleep, not an iMessage number…).
- BlueBubbles' webhook is treated as a doorbell: it carries only message ids, and the plugin fetches
  each message with the password; she catches up on anything sent while she was offline (very old
  messages are filed, not answered). The password is kept in the vault and cut from every log.
- Text, photos and files both ways; voice notes. Typing dots, tapbacks and edits only when the
  Private API is already on; Sara never gives instructions to turn off System Integrity Protection.
  Otherwise one *Working on it… send /stop* line on long jobs. Guide: [docs/IMESSAGE.md](docs/IMESSAGE.md).
- **Fixed:** a plugin's network connection that closed after the plugin stopped (or while Sara shut
  down) wrote a log line into a closed database from inside a socket event, an error nothing caught,
  which could stop Sara. Closing connections can no longer throw.
- SMS through AgentText (planned as 2.55.3) is on hold: AgentText's documented API still answered
  404 on 2026-11-02.

## 2.55.1 (2026-11-02): Matrix (Phase 122, part 2)

- **Matrix** as an optional first-party plugin (Settings → Connections → Matrix): talk to her in
  Element or any Matrix app through a Matrix account of her own (display name "Sara (AI)"). Five
  guided steps checked with a ✓ (make her account, log her in once (the password is never stored),
  make a room without encryption, say hello, Test), and plain-language fixes (server not found,
  password login off, login ended, encrypted room, rate limits, file too big…).
- Text, photos both ways and voice notes; typing and read receipts in your own room. Only you unless
  you allow others (whole servers too, `@family.example`); strangers' invites are declined; listed
  partners get the AI notice and no tools. Rooms without end-to-end encryption only: in an encrypted
  room she says why in one line and leaves. `/link 123456` (or "Sara link 123456") links you.
- Tailscale addresses count as "my network" only when this computer is on Tailscale. Matrix tokens
  are masked in logs and refused in ordinary settings. Guide: [docs/MATRIX.md](docs/MATRIX.md).

## 2.55.0 (2026-11-02): WhatsApp (Phase 122, part 1)

- **WhatsApp** through Meta's official WhatsApp Cloud API, on a Meta account and number you own, as
  an optional first-party plugin (Settings → Connections → WhatsApp). Off until you install it and
  tick that you've read Meta's terms, which since January 2026 limit general-purpose AI assistants on
  WhatsApp (Meta can restrict an account or number). Starts with Meta's free test number.
- **Guided setup:** 10 steps, each naming the exact Meta screens as a short list and checked with a
  ✓: make the app, copy two IDs, list your phone, a key that never expires, the App secret (kept in
  the vault, never given to the plugin), a public door for `/hook/` only (Tailscale Funnel on 8443, or
  your tunnel or domain), connect Meta, `/link` from your phone, Test. About 20 problems turn into one
  plain sentence with a fix (expired key, IDs swapped, not subscribed, development mode…).
- **In chats:** text, photos and files both ways; typing dots and one *Working on it* line with Stop
  on long jobs; at most 3 messages per reply, paced to Meta's limits. Only you, unless you list other
  numbers. Her own first messages go only inside WhatsApp's 24-hour window, else they wait in the
  app. If your WhatsApp identity changes, her tools there pause until you confirm. No groups or voice
  replies yet. Webhooks gain Meta signatures, the verify handshake and a bridge mode.
  Guide: [docs/WHATSAPP.md](docs/WHATSAPP.md).

## 2.54.0 (2026-11-02): routines and a safety check-up (Phase 121)

- **Routines gallery** (Planner → Routines; also on an empty Today and at the end of the wizard): ten
  ready-made routines built on what Sara already runs: morning briefing, weekly review, stretch and
  bedtime reminders, leave on time, watch my repo's CI (new), new issues, backup check, inbox triage
  and price watch. Each card says what it does, what it needs (with a link to set it up) and what it
  costs, computed in code; a preview makes no model call; *Turn on* and an Off switch on each in *My
  routines*, which also lists schedules set up elsewhere. Paid routines are loops with a clock time
  and an end date (7–90 days), a daily token share and quiet-hour skips; after a restart they stay on
  and skip missed runs. Tools keep your approval settings: one on *Ask* pauses the routine and tells
  you. Guide: [docs/ROUTINES.md](docs/ROUTINES.md).
- **Safety check-up** (Settings → Data & health): 17 read-only checks (who can reach her, sign-in,
  owner token age, old devices, backups, tools that run without asking, sandbox, adult-mode lock,
  chat apps open to strangers, webhooks, agents and the hub, secrets in her notes, updates, the data
  folder), a verdict in words, and one-click fixes that can only tighten (a gate in code refuses any
  loosening), each labelled *Undo any time*, *Undo for 30 days* or *Can't be undone*. Reachability
  changes are guided, never one click. A weekly quiet check, a Today line only when something is red,
  and `sara doctor --safety`. Owner only. Guide: [docs/SAFETY_CHECKUP.md](docs/SAFETY_CHECKUP.md).

## 2.53.0 (2026-11-02): coding precision (Phase 120)

- **Checks after her edits:** after she writes or edits a file, Sara runs the project's own checker
  (tsc, pyright or mypy, `cargo check --offline`, `go vet`, eslint), only when it's already in the
  project or on the PATH, never through `npx` or `pip`, and adds the result to the same tool result:
  new errors in the files she touched (up to 20), the files her change broke elsewhere (up to 3), and
  a count of what was already there. If she'd stop with her own errors left she gets up to two
  nudges; the reply shows *✓ types clean (tsc) · fixed N* or what's left. One OK per project (a card
  lists the exact commands and which run project code); off per project or everywhere in Settings →
  Abilities → *Check her edits*. Also a `types` goal check and `/problems` in the chat apps.
  Guide: [docs/CHECKS.md](docs/CHECKS.md).
- **@-references:** type `@` in the chat box: `@file` (`@file:src/a.ts:7-11`), `@folder`, `@diff`
  (`@diff:staged`), `@branch`, `@problem`, `@url`. An autocomplete menu, chips with sizes and a ✕, and
  *What she got* on sent messages. Typed text works in Telegram, Discord, Signal, email and plugin
  apps. Read once and stored; workspace-bound, secret files (`.env`, keys) refused, `@url` through the
  network guard and never in private chats. Owner only.
- The optional language-server engine from the design is not in this release.

## 2.52.1 (2026-11-02): connecting a server is easy now; photos fixed

- **Fixed (owner report: "the process right now seems like a brick wall"):** letting Sara work on
  your server over SSH. Settings → Servers over SSH → *Connect a server* asks for two things, the
  address and the user name (a pasted `ssh -p …` command or cPanel link works too). Sara makes her own
  key, finds the SSH port, checks which sign-in methods the server allows and whether it's cPanel,
  then offers the easiest way in: **a cPanel token** (she installs and authorizes her key, then
  deletes the token herself; it's never saved), **your password once** (only when the server takes
  passwords; never saved unless you insist, after a warning), or **one line to paste** with
  click-by-click steps for common hosts. The server's ID card (host key) is explained in plain words,
  and a changed one still stops everything. Every failure says what's wrong and what to do (wrong
  port, passwords off, key not authorized, no shell access, DNS, two-step…), right under the button
  you pressed. Edit the port or user without starting over; replace her key; clean up old Sara keys.
  Tested live on a real cPanel server. Guide: [docs/SSH.md](docs/SSH.md).
- **Fixed (owner report: "I sent Sara a picture and she told me she could not see it"):** when the
  Photos (Vision) or Screen job was set to a subscription app (Claude or Grok through their own
  programs, which get text only), the photo never reached a model: she was told one was attached and
  said she couldn't see it, even with a seeing backup set. A picture now skips models that can't see,
  for the job's next model or else the talking model, and Settings → Which model does what says so
  when you pick one for Photos or Screen.

## 2.52.0 (2026-11-02): when it comes up (Phase 119)

- **"When it comes up" reminders:** "when Dan comes up, remind me he owes me $20", "next time I
  mention the garden, ask about the tomatoes". A third kind of reminder that waits for a person (your
  People cards, nicknames included; with two Dans she asks which) or for all the words of a topic,
  matched in code with no model call. She brings it up once, inside her reply (the app adds one line
  if she forgets), with a ⏰ chip: *Done*, *Again next time*, *Forget*. At most 1 per reply and 5 a
  day; they end after 180 days. Planner → Reminders → *When it comes up*, `/when` in chat apps.
  Guide: [docs/WHEN.md](docs/WHEN.md).
- **Private by design:** they fire only on your own messages in your own chats (the app and your
  DMs), never in rooms, work rooms, partner or group chats, private or off-the-record chats, other
  apps or agents. They never appear in Today, the briefing or other apps, and anything she'd send to
  someone else that contains one asks you first.
- **Pick up a chat in another app:** when you switch (Telegram → the app, or back), she offers to
  *Continue here*, or type `/continue` (also in the Telegram and Discord menus). A chip shows where it
  came from, with *Show* (exactly what she has) and *Undo*. It's a pointer, not a copy: the note is
  rebuilt from the other chat each reply, for 12 messages or 24 hours. Only between your own linked
  chats. Settings → Connections → *Pick up a chat*.

## 2.51.0 (2026-11-01): keep going until it's done (Phase 118)

- **Fixed:** `edit_file` couldn't edit files with Windows (CRLF) line endings, because models write
  plain line breaks; it now matches and writes in the file's own line endings.
- **Privacy fix:** your next reminders were placed in her instructions even in a work room (a shared
  Discord channel or Telegram group where you work with her), where others read her replies. They're
  now left out of work rooms and partner chats.
- **Goals on a chat** (`/goal … done when tests|build|lint|\`cmd\`|reviewer|me`, or the + menu): she
  works round by round toward it, and **Sara runs the check you picked**, so *done* means it really
  passed. Her own words never end a goal. A green that came only after she edited the tests ends as
  *done, review* with the files listed. *Stuck* is decided in code (the same failure twice, a round
  that changed nothing, the loop guard), caps are rounds, minutes, tokens and dollars (5 / 60 / 1M /
  none by default), and Stop always wins. Checks that install, delete, change the system or use the
  network are refused.
- **Repeat-in-chat loops** (`/loop every 10m [for 2h] [until …]: …`): ticks on the reminder clock,
  at least 5 minutes apart, ending after 4 hours by default (24 at most), 48 ticks, per-tick and daily
  budgets, 3 at once. Unchanged results stay quiet; a change is one message. *until* counts only when
  a tool really ran. Two failures in a row stop it; anything that would need your approval pauses it;
  quiet hours skip or hold.
- Planner → *Repeats*; the board's *Done when* check; Settings → Abilities → *Keep going and repeats*.
  Owner only; household members get neither. Everything comes back paused after a restart. Guide:
  [docs/GOALS.md](docs/GOALS.md).

## 2.50.0 (2026-11-01): Signal and email (Phase 117)

- **Fixed:** a reply in a plugin chat app that took longer than 5 minutes was cut off and the rest
  was lost. Now one "Still working on it" line goes out at 5 minutes (unless the progress message is
  showing) and the whole answer when she's done.
- **Signal** (a built-in plugin, installed from Settings through the usual review card): talks to
  signal-cli's JSON-RPC daemon on this computer (or your home network if you tick it). Her own
  number is recommended; *Note to Self* is a quick test. Link yourself with a 6-digit code; your
  safety number is pinned, and if it changes her tools pause until you press *It's me*. Groups you're
  in become rooms (she answers when called; keep-up works), 👀 when she takes your note, a progress
  message with up to 7 edits, files up to 20 MB both ways, gentle pacing, and she never writes first
  to anyone but you. Guide: [docs/SIGNAL.md](docs/SIGNAL.md).
- **Email** (built-in plugin): her own mailbox over IMAP (IDLE or polling) and SMTP, with presets
  for Gmail, iCloud and Fastmail (app passwords; Outlook.com needs OAuth and isn't supported yet).
  Link yourself by mailing *Link 123456*; your mail counts as you only when your provider's sender
  check passes. One session per thread, replies in the thread, plain text, never reply-all.
  Strangers are never answered and never reach a model; an allow-list for others. Forwarded mail is
  fenced and makes every tool ask first. Out-of-office replies, mailing lists and bounces are
  skipped, and her mail is marked as automatic so loops can't start. Only the first 8,000
  characters reach her; *keep this* saves the whole mail to the library. Guide:
  [docs/EMAIL_BRIDGE.md](docs/EMAIL_BRIDGE.md).
- **For plugin authors:** contract 1.2 (opt-in): Sara holds TCP/TLS connections for a plugin
  (`permissions.connect`) only to addresses from the owner's settings, does STARTTLS itself and
  pins the address; groups as rooms, message ids, reactions, typing, threads, sender checks and an
  edit budget. Plugins that come with Sara live in `plugins/`. Guide: [docs/PLUGINS.md](docs/PLUGINS.md).

## 2.49.0 (2026-11-01): talk to her while she works (Phase 116)

- **Send while she works and choose what happens:** *Tell her now* (the default for you: she reads it
  at the next safe point between steps and changes course; never inside a running tool or while a
  card waits, and it can never approve anything), *After this* (it waits and runs as its own turn;
  *Now* and × on its chip), or *Just asking* (a quick side answer from a small model with no tools;
  nothing is saved and the work carries on; 60 a day by default, local only in private chats).
  Enter sends the default, Alt+Enter the other choice; Settings → You → *While she's working*.
- **The same in Telegram, Discord and plugin bridges:** a plain message steers (👀 and "Got your
  note"), `/queue` waits, `/btw` asks on the side. People in rooms and partner chats always wait their
  turn. Waiting messages don't run after a restart; `/reset` says how many were dropped.
- **Loop guard:** the same tool call failing the same way three times is blocked for the rest of the
  turn (before any approval card) and she's told to change approach; if she keeps trying, her tools
  switch off for that turn. A note from you clears it. Shown as "Stopped repeating…" in her steps and
  the progress message.
- Works with every model provider (each gets your note in the shape it accepts after tool results).
  Guide: [docs/CHATS.md](docs/CHATS.md).

## 2.48.0 (2026-11-01): chat apps catch up (Phase 115)

- **Fixed:** in Telegram and Discord her pictures (selfies, proof pictures) were made but never sent;
  Telegram dropped a photo that had a caption; Discord ignored images and picture-only messages; a
  private conversation with a cloud picture model failed (it now stays local); documents from plugin
  bridges were labelled as Telegram.
- **Photos and files both ways:** photos with captions, albums and pictures sent as files reach her;
  documents go into the chat's files. She sends pictures and files back with the new `send_file` tool
  (only in your own chats; it refuses saved secrets, asks about key-shaped text, and asks first in a
  shared room or above 5 MB). File chips with downloads and a *Files in this chat* panel.
- **Pictures from other people** in a room are off by default; switched on per room, the picture
  model describes them first and she only gets that description, fenced as untrusted. Anything that
  may show a minor is deleted at once. Partner chats still get no tools, files or pictures from her.
- **One live progress message** in Telegram, Discord and plugin bridges: after 10 seconds, one
  message edited in place with what she's doing (never commands, output or secrets), a Stop button
  only you can use, and one summary line when she's done (her answer comes as new messages so your
  phone still notifies). Switch it per app, per room or per chat (`/progress`).
- **Plugin bridge contract 1.1:** files in chunks behind the new `bridgeFiles` permission;
  `sendFile` in the SDK. Guide: [docs/PLUGINS.md](docs/PLUGINS.md), [docs/CHATS.md](docs/CHATS.md).
- Other people's pictures are kept 7 days, sent-file copies 30 days.

## 2.47.3 (2026-11-01): start here (Phase 114, polish PL1d; the polish pass is complete)

- **Two ways in:** [docs/START_HERE.md](docs/START_HERE.md) ("I just installed it, now what?") and
  [docs/FOR_CODERS.md](docs/FOR_CODERS.md), each with its how-to videos
  ([docs/VIDEOS.md](docs/VIDEOS.md)); the in-app guide opens with the same two paths.
- **Every *How do I…?* answer in one index:** in the guide and as [docs/HOW_DO_I.md](docs/HOW_DO_I.md),
  generated from the same answers the app shows.
- **README:** a *Start here* section, the feature tour split into *For company*, *For coding* and *For
  both*, the release history folded, and 13 fresh screenshots (small WebP files) in all six languages.
  The docs site is regrouped (Start here, Using Sara, Connect other things, Build with Sara).
- Fixed: the Plugins page showed *Add a plugin* twice when empty; the `sara hands --server …` command
  ran off the phone screen.

## 2.47.2 (2026-11-01): one look, and help on every page (Phase 114, polish PL1c)

- **How do I…?** on every Settings page, every view and the empty chat: 123 short questions with
  numbered steps and a *Show me* that points at the control. The *Getting started* cards open the
  matching answer.
- **Empty pages explain themselves:** one style everywhere (an icon, what goes here and why, one main
  button, a *How do I…?* link) instead of "None yet."
- **One look:** one card style, outline icons instead of emoji in the views, the designed spacing
  and three corner sizes, one intro per page (27 repeated ones removed), and a settings menu that
  opens one group at a time.
- **Phones:** a two-row Settings header, no boxes scrolling inside the page, no sideways scrolling,
  the setup wizard covers the whole screen.
- **Setup:** a clearer first sign-in screen (one main button; *I already have a token* behind a
  link), choice cards in steps 2 and 3, *Make my own* opens *Create your companion*, and the coding
  path picks a capable model on this computer first (cloud only when none fits).
- The new translations were drafted with a local model; corrections are welcome.

## 2.47.1 (2026-11-01): a first run that fits you (Phase 114, polish PL1b)

- **Company, coding or both:** the first setup step asks what you're here for (saved per companion,
  changeable in Settings → You → About you). It sets the recommended model, the tour, the starter
  suggestions and the order of *Getting started*; everything stays available either way.
- **Connect a brain:** a *Picked for you* card (the model, why, where it runs, *Change*), a live
  *Connected ✓* check that sends a real test message before *Next* turns on, and *Next* as the one
  main button (*Skip for now* is a quiet link, *Set up later* moved to the header). Coders get a
  model good with code and tools.
- **Two six-stop tours** (companion, coder) offered after her first reply; *The full tour* stays in
  Help. **Starter chips** in setup's last step and in any empty chat, matched to your choice.
- **One first-run queue:** the setup wizard, the anonymous check-in note, notices and the tour offer
  never cover each other; the check-in note (same words, same buttons) is now part of the last setup
  step.
- Automatic chat titles are shorter and in sentence case.

## 2.47.0 (2026-11-01): personality you can see (Phase 114, polish PL1a)

- **The personality dials explain themselves:** new end words for each dial (*Keeps her distance ↔
  Openly warm*), a word and the number for where it sits, and a line in her voice that changes as you
  move it: 125 written lines (5 steps × 25 dials), no model call. Focus a dial to see what that step
  means and when it shows. Plainer group names (*How warm she is*, *How she pushes back*, *You two*,
  *While you code*), a *Your Sara so far* summary, bigger end words and clear space between dials on
  phones. *Try it* still lets you hear her with everything combined.
- **Plain words on the other sliders:** Today's away note, her plans, memory fade, group banter,
  titles, skills, catch-ups and Discord turns.
- **Fixed:** Today now refreshes when the setup wizard closes (your name and *Connect a brain*
  ticked); model counts agree everywhere (this computer and cloud counted separately) and the
  wizard's model list is grouped with a recommended pick; importing a persona renames her notes, her
  message limits follow the dial and the sidebar name updates at once (Undo renames back); *Leave by*
  sits at its own time before its event (and the repeated hour when summer time ends is labelled);
  the Rooms tile reads *Lately: … · last from Ana: "…"* instead of bare keywords; a duplicate link
  target in the guide.

## 2.46.0 (2026-11-01): report a problem from inside Sara (Phase 113)

- **Report a problem / Suggest something** in Help, `/bug` and `/idea` in chat (in Telegram and
  Discord `/bug <text>` sends a quick report after you tap Allow), and *Report this* on error notices.
  No GitHub account needed. Guide: [docs/SUPPORT.md](docs/SUPPORT.md).
- **Optional diagnostics,** built on your computer and shown in full with a tick box per part:
  version and platform, recent log lines and the error, which features are on (no values), the
  failing turn's tool names and statuses. Keys, tokens, emails, IP addresses and home-folder paths
  are removed before sending.
- **My reports:** each report's status, the version that fixed it, our replies, and a reply box.
- **An anonymous daily check-in** (on by default; a notice explains it on first run): the version,
  how Sara was installed, Windows/Mac/Linux, the app language, how many companions and household
  members, and which features and chat apps are switched on. No name, chats, model names, paths or
  addresses; the IP address isn't kept. Never sent from the demo, in private local mode, or by
  household members. Settings → Data & health → *Privacy*: switch it off, *Show what's sent*, or
  reset the install ID. [docs/PRIVACY.md](docs/PRIVACY.md) has the details.

## 2.45.0 (2026-11-01): Today on phones and tablets (Phase 112, Today TD2; the Today track is complete)

- **A Now card first** on phones and tablets: the next two things with how soon ("in 18 min", "Leave
  by 2:35 for Dentist"), the weather in a line with the first wet hour, and her mood; then *Needs you*
  (top 3), *Your day*, Weather and Mail, then your own section order.
- **Folding sections** with a one-line summary when folded (Needs you always shows its count), kept
  per device kind (phone, tablet) on the server; *When Today opens*: as I left it, everything open,
  or only Now.
- **Swipe rows** for *With her* and *Work* (with ‹ › buttons, keyboard and screen reader reachable;
  a swipe never completes or deletes anything), **pull to refresh** in the browser and both apps, and
  a quiet refresh of only the stale parts when you come back after a few minutes.
- **Tablets:** two columns in your desktop order. Esc and Android back close a menu or the Customise
  sheet before leaving Today. No sideways scrolling from 320 to 430 px; every touch target is 44 px.
- **Since you were away,** two opt-ins (off by default): a one-sentence note in her voice (local model
  first, capped, counts only) and a mention of rooms she answered in (owner only).

## 2.44.0 (2026-11-01): Today, designed (Phase 111, Today TD1)

- **Five sections in a set order:** *Your day* (one timeline of events, reminders, to-dos and leave-by
  times with a Now marker, plus Weather and *Coming up* for 7/14/30 days with birthdays), *Needs you*
  (one ranked list: approvals you can settle right there, failed work, overdue items, with *Not
  today*), *With her* (She remembered, On this day, Her plans), *Work* (Running now, the board, coding
  projects, *Usage today*) and *Home & more* (who's home and the scenes you pick). Guide:
  [docs/TODAY.md](docs/TODAY.md).
- **Tidy by design:** a 12-column grid with small, medium and large tiles that always fill a row;
  empty tiles and empty sections fold away; no jumping while it loads.
- **Customise:** move, resize and hide tiles and sections (drag, the tile's ⋯ menu, or Alt+arrows),
  saved for each companion on the server so every device matches; *Reset* restores the design.
- **Mail 2.0, and the stale-mail fix:** the tile shows your inbox and unread with the change since
  yesterday, what looks important, and *She organised today* with Undo, and it now updates by itself
  during and after a Gmail clean-up or an Undo. Before, a load running during a clean-up could put old
  numbers back, the cache was shared by all companions, and an open Today was never told.
- *Since you were away* (after 8 hours, adjustable) and an *Updated N min ago* line on every tile that
  reads from outside. An opt-in **Rooms** tile (owner request) shows what's going on in rooms she keeps
  up with, with no new model calls; never for household members or the demo.
- One batched `GET /api/today` with a time limit per part; household members get their own Today
  with owner-only parts left out on the server.

## 2.43.0 (2026-10-31): she keeps up with the room (Phase 110, chats CH4; the chats track is complete)

- **Keep up with this room** (Discord server channels, Telegram groups; per room, off until you confirm
  a plan card with the model, how often and the daily cap): she reads every line into a room log and
  keeps a cheap rolling summary (falls back to the last lines without a model). When she's called, her
  turn gets "the room right now": the current topic, who's active, what changed since she last spoke
  and whether her old topic has gone stale; the people side gets the same. Reading never starts a turn
  or a tool. Guide: [docs/CHATS.md](docs/CHATS.md).
- **Every night:** finished weeks are archived into her Library as read-only, searchable transcripts
  (*Room archives*), folded into a room memory (topics, notes about each person with the week they
  came from, proposed People cards used only in that room unless you switch a card on), then the raw
  lines are deleted. *Forget this room* clears the log, memory and archive. Archive search is only in
  your own turns.
- Safety on lines she only reads: anything that trips the minors check is stored as `[removed]`; a
  crisis line brings resources into her next reply in that room within 2 hours (she doesn't post on
  her own). Room memory never reaches her memory of you, other apps, agents or plugins.
- Settings explain Discord's Message Content Intent and Telegram's privacy mode with live status; on
  Discord she can read the last day (100 messages) when you switch it on.
- Evals: 12 replayed busy channels in 6 languages with a local 12B model: current topic 12/12, stale
  topics revived 0, injections 0. The chats track (2.40–2.43) is complete.

## 2.42.0 (2026-10-31): session titles that grow (Phase 109, chats CH3)

- **Titles say what the chat was about:** a placeholder first, then a cheap retitle after about three
  exchanges, again when a word check sees the topic move (the model is asked only then), and for the
  closed session at `/new`. Earlier titles (the last 10) are kept in the chat's info with *Use this
  title*; *Keep this title* and any title you type are never changed.
- **This computer first:** the background model on your own computer by default, *Quick helpers* only
  if you pick it, nothing paid by itself; private chats use local models only (or keep the
  placeholder). A daily cap (60 runs by default, 10–200) with today's use shown. Settings → You →
  About you → *Session titles*, plus *Name recent chats now*.
- **Never in a title:** secrets, explicit content, health or intimate details, names from your people
  cards outside your own chats, or a partner's own name. Off-the-record, imported, group, webhook,
  agent and app chats aren't retitled.
- The sidebar row updates in place (no jumping). Evals: 40 sessions (`scripts/eval-titles.ts`), 0.90
  on topic and 1.0 on sensitive and people checks with a local 12B model.

## 2.41.0 (2026-10-31): a tidy session list (Phase 108, chats CH2)

- **A built-in project per chat app:** Telegram, Discord and one per plugin bridge (WhatsApp,
  Signal…), created on a chat's first message; web and app chats stay in your own projects. Chats from
  before 2.41.0 are filed once at startup, with *Put them back* (Undo) on each project's page; chats you
  had filed yourself stay where they are.
- Channel projects can be renamed and hidden (*Hidden projects* at the bottom); they can't be archived,
  and can be deleted only when that channel is off.
- **Long lists:** each sidebar group and project page shows the newest 8 (5, 8 or 10: Settings → You →
  About you → Appearance), then *See more* adds 20 at a time, with *Show less*; the server pages them.
  Earlier sessions of a chat sit under it, dated; busy channel projects can be grouped by room.
- Rooms show their real names (#general · Server, a group's title) instead of numbers, with a small
  chip (DM, group). The privacy line of a chat with other people now says it isn't in her memory of
  you.

## 2.40.0 (2026-10-31): chat commands everywhere (Phase 107, chats CH1)

- **Commands:** `/new` (a fresh session; the old one is kept and summarised), `/new room` (in a room
  where you work with her), `/reset` (clear a stuck turn and queued messages), `/stop`, `/status`
  (model, how full the session is, session age, recent usage and budget), `/help`, `/model` (a pick
  list) and `/remember`. Guide: [docs/CHATS.md](docs/CHATS.md).
- **Everywhere:** Telegram (menus set per chat type and in six languages), Discord (application
  commands, answered within Discord's 3 seconds, with a model picker), plugin bridges and the web app
  (type them in the composer). Typed `/new`, `!new`, `/new@yourbot`, or "Sara, new" when that's the
  whole message.
- **Who may run what is checked every time:** the owner everything; others `/new`, `/reset`, `/stop`,
  `/help` and a short `/status` in their own chat, only `/help` and a short `/status` in rooms; bots
  nothing. Replies in the asker's language.
- **Sessions:** a chat can now have several sessions (the newest open one gets new messages; ended ones
  stay, marked *ended*). When a session is 85% full she offers `/new` once. Conversation settings show
  *Context used*, earlier sessions and *Start a new session from here*.
- Fixed while testing: in Telegram, a `/stop` sent while she was replying now arrives in time.

## 2.39.0 (2026-10-31): move in, settings, channels, hooks and the report (Phase 106, move-in MI3; the move-in track is complete)

- **Settings become cards you confirm:** providers matched to Sara's presets (keys are never copied:
  you enter them again into the vault), sign-ins, local models (only if Sara can reach them), voice,
  time zone. Telegram, Discord, other agents and webhooks become *connect this* cards (never
  connected for you); approvals, sandboxes and allow-lists are shown, not copied.
- **Hooks and plugin code are read as text, never run,** and explained with quotes, then translated
  to a rule on her sheet (one that would weaken her AI disclosure is refused), a guard that only ever
  asks first, an existing Sara feature, *left behind*, or a plan to rebuild it as a Sara plugin
  (names, hosts, secret names, a draft manifest). *Ask her to read it* uses a local model by default.
- **Duplicate database copies** (backups, probes) are recognised by fingerprint and mapped once; her
  name comes from SOUL.md/IDENTITY.md for custom sources; the collector reads more YAML (multi-line and
  quoted values).
- **The move-in report:** imported, translated, needs you, left behind, with counts and links, where
  each old feature lives in Sara now, and her own note; download it as Markdown. Undo also puts settings
  back and removes the added rules.
- The move-in track (2.37–2.39) is complete.

## 2.38.0 (2026-10-31): move in, her old databases (Phase 105, move-in MI2)

- **Custom SQLite and Postgres stores:** the move-in page gets *Her old databases*. Sara profiles
  every table (types, keys, timestamps), groups them into families, skips logs and telemetry, and
  proposes for each family what it is and where it goes: notes, people and facts about them, past
  conversations, tasks, goals, her diary, or skip. The model only sees masked samples (secrets
  removed, health and intimate values held); code checks every proposal; one retry; a no-model guess
  as the fallback.
- **You confirm every card** (*Looks right*, edit any field, *Skip*); nothing imports from an
  unconfirmed card. Big tables stream into the same move-in batch, so Undo removes them too. Confirmed
  mappings are saved by fingerprint and reused without a model call; export and import them.
- **Postgres, read-only:** the collector has its own standard-library client (read-only session and
  transaction, SCRAM-SHA-256, `COPY … TO STDOUT`, then rollback) or reads a plain `pg_dump` file.
  `--schema-only` shows names and counts without opening any rows.
- Measured on made-up stores (276 tables, 253 telemetry skipped; Postgres via a fake server that
  refuses writes) with a local model; schema-only runs against two real agents.

## 2.37.0 (2026-10-31): move in from Hermes Agent and OpenClaw (Phase 104, move-in MI1)

- **Settings → Data & health → Move in from another agent:** three steps. Copy one command, run the
  collector on the old machine (`sara-movein.py`, standard-library Python, no installs; checks its own
  hash), and upload the `.saramove` file (resumable) or send it with a move-in code. Guide:
  [docs/MOVE_IN_GUIDE.md](docs/MOVE_IN_GUIDE.md).
- **The collector shows its plan first** and packs read-only (SQLite opened without side files).
  Secrets are never packed (and scrubbed again on the server); backups, media and code environments
  are skipped; medical and intimate categories stay behind unless you include them.
- **Readers for Hermes Agent and OpenClaw:** persona files become a character-sheet draft you decide
  on (lines that would switch off her safety rules are left out, with the reason), memories and
  "about you" notes, past conversations (active branches; *Was this her?* decides whose replies those
  were), skills (scripted ones off), schedules as tasks or reminders, and Kanban boards.
- **Preview** with counts, duplicates and samples; **Import** is one batch with Stop and a report
  (imported, translated, needs you, left behind); **Undo** removes exactly that batch for 30 days and
  puts her personality back. Moved-in chats stay out of other apps, /v1 and A2A. Owner only; not in
  the demo. Custom stores and settings/hooks come in 2.38 and 2.39.
- Tested with plan-only runs against two real, heavily customised agents (counts only, nothing
  copied) and full imports of made-up Hermes and OpenClaw homes.

## 2.36.0 (2026-10-31): her own plans (Phase 103, staples ST8; the staples track is complete)

- **Opt-in, per companion, off by default:** Planner → *Her plans*. She keeps follow-ups on what you
  tell her ("ask how the interview went") and goals you keep at together. Every plan comes from your
  own words, found in code (no model call), and shows where you said it. Guide:
  [docs/AGENDA.md](docs/AGENDA.md).
- **Goals wait for you:** *Use it*, *Edit first*, *Not now* or *Never*. Plans can be moved, changed,
  cancelled or paused; history keeps what she did and why ("Why I'm writing" on her messages).
- **Limits:** at most 5 open plans, 2 new a day, 30 days ahead; she shares the daily message limit,
  quiet hours, the gap and the unanswered rule with her first messages; her own daily budget
  (30k tokens / $0.10 by default); a 48-hour pause with one gentle check-in after a crisis; anything
  outside Sara still asks. **Off** stops everything at once, even a reply she's writing.
- Tools `agenda_add` (only with a quote from your recent messages), `agenda_goal`, `agenda_list`; never
  in other apps, groups, partner, private or outside chats. A Today tile. Members have their own.
- Measured: a 30-week simulated eval with 0 wrong-day plans, 0 days over the cap, 0 invented reasons.
- **The staples track (Phases 96–103: skills, learned skills, plugins, the board, A2A, people,
  webhooks, her own plans) is complete.**

## 2.35.1 (2026-10-31): fix: one room in shared Discord channels and Telegram groups

- **Fixed:** with *work with me in server channels* (Discord) or *in groups* (Telegram) on, the owner's
  messages and everyone else's went to two conversations that couldn't see each other. In the room she
  heard people talk about the owner but never heard him (so he seemed to ignore her), and with him she
  didn't know what the room was saying, so she sounded like two different people. Now the owner's
  lines and her answers to him are copied into the room's conversation, and his turns get the room's
  latest lines as context (fenced, labelled as other people's words, never stored in his
  conversation, so her memory never learns them as his). Tools and partner rules are unchanged.
- README: a how-to videos section (playlist and four one-minute videos).

## 2.35.0 (2026-10-31): webhooks and event triggers (Phase 102, staples ST7)

- **Signed incoming webhooks:** Settings → Connections → Webhooks. Each gets its own address
  (`/hook/<id>.<secret>`, outside `/api`; only a hash of the secret is kept). Guide:
  [docs/WEBHOOKS.md](docs/WEBHOOKS.md).
- **Signatures, written from scratch** and checked on the raw bytes in constant time: GitHub
  (`X-Hub-Signature-256`), Stripe (`t=`/`v1`, 5-minute tolerance) and Standard Webhooks (`webhook-id`,
  timestamp, `whsec_` secrets). A header token or the address alone are weaker options, limited to
  *Tell me* and *Add a task* unless you allow more. Replays and duplicates are refused; size and rate
  caps; a wrong secret looks the same as an unknown hook.
- **When and what:** no-code conditions with presets per sender; actions *Tell me*, *Add a task*,
  *Run a skill* (as an outside turn with only the tool groups you tick; changes ask, a declined card
  ends the run) and *Send to a plugin* (`event:webhook`). The payload is untrusted text; people cards
  and memory stay out.
- A delivery log, a *Test* button (dry run, run it for real, or a ready curl line), a Today tile and
  optional signed outgoing copies (Standard Webhooks, through the network guard). Owner only; not on
  the demo.

## 2.34.0 (2026-10-31): people (Phase 101, staples ST6)

- **People cards**, built from her memories (which stay the source of truth): Memory → *People*. Each
  card has the relation, circle, birthday, when you last mentioned them, and what she knows, each with
  a link to the words you said it in. Guide: [docs/PEOPLE.md](docs/PEOPLE.md).
- New people wait in *To check* (*Looks right*, *Merge with…*, *Not a person*, *Forget*) or are added
  after 3 conversations. Correct, mark private, take a fact off the card, merge, split, add photos and
  your own notes. *Forget* removes the card, facts, links, photo and search entries, and optionally the
  memories too.
- Same first name? She asks ("Jeff from work or your brother Jeff?") and remembers the answer.
- She uses them in chat (`person_lookup`, `people_list`; `person_note` asks first) and recall has a
  People section; birthdays show on Today. A once-only backfill proposes people from past memories.
- **Privacy:** one gate keeps people cards out of other apps (/v1, MCP), other agents (A2A, including
  quotes in outgoing text), plugins, group and partner chats. Private facts only in private chats;
  sensitive facts fold away and only come up when that person and topic are the subject. Each
  household member has their own people.

## 2.33.0 (2026-10-31): other agents, A2A (Phase 100, staples ST5)

- **The open [Agent2Agent](https://a2a-protocol.org/) protocol (1.0), both ways, written from the
  spec.** Settings → Connections → Other agents. Guide: [docs/A2A.md](docs/A2A.md).
- **As a server** (off by default): `/.well-known/agent-card.json` (a thin public card; her name only
  if you allow it), JSON-RPC at `/a2a/v1/rpc` and HTTP+JSON at `/a2a/v1/*`: SendMessage,
  SendStreamingMessage (SSE), GetTask, ListTasks, CancelTask, SubscribeToTask, GetExtendedAgentCard;
  all 8 task states; text, data and file parts (allow-listed, never run, links never fetched). Each
  agent gets its own key (works only on `/a2a`, expires in 180 days) and a policy of what it may ask;
  anything that changes something waits for your OK (AUTH_REQUIRED).
- **As a client:** add an agent from its card (checked through the network guard, signatures verified
  when present, key kept in the vault). Tools `a2a_agents`, `a2a_send` (asks), `a2a_status`,
  `a2a_reply` (asks), `a2a_cancel`; streaming answers; Stop cancels at the peer; a daily cap.
- **On the board:** assign a card to an agent; it comes back to Done with receipts, or waits on you
  with the agent's question.
- **Safety:** a peer's words are untrusted; once a peer's answer is in a turn, every tool that changes
  something asks. Private, partner, group and imported chats and memories never go to a peer; nothing
  is learned from agent chats; the safety layer and AI disclosure always apply. Not on the demo.
- Conformance: `scripts/a2a-conformance.ts`, 61/61 against a live server; two Saras talked live.

## 2.32.0 (2026-10-31): the board (Phase 99, staples ST4)

- **Kanban over your planner to-dos** (no second task list): Planner → Board. Every project has a
  board (To do, Doing, Waiting on you, Done), plus *To-dos without a project* and *Everything*. Labels,
  checklists from `- [ ]` lines, due dates, repeats (a done repeating card comes back with the next
  date), WIP limits, activity. Guide: [docs/BOARD.md](docs/BOARD.md).
- **Drag** with a mouse, pen or finger (long press; on phones one column per screen with a tab strip
  and an edge target) or the keyboard (Space, arrows, Space; announced for screen readers).
- **Assign a card** to Sara or a helper team: she works it in the card's own conversation (2 at once by
  default, the rest queue). It reaches Done only when receipts back every claim; otherwise, or on an
  approval, a question, a budget limit or a failure, it moves to *Waiting on you*, and answering on
  the card resumes the same run.
- **In chat:** `board_list` (what's blocked and why), `card_add`, `card_move` (asks unless it's her own
  card), `card_comment`, `card_ask`, `card_assign` (asks).
- Shared household boards by invitation; non-members see nothing. A *Needs you / Doing* tile on
  Today. Plugins get `event:board`. The demo has a sample board.

## 2.31.0 (2026-10-31): plugins and hooks (Phase 98, staples ST3)

- **Plugins:** a folder with `sara-plugin.json` (manifest 1: permissions for hooks, tools, calling her
  tools, network hosts, files, settings, cards, bridges, model budget, memory; schedules; settings
  with required ? tips). Settings → Abilities → Plugins. Guide: [docs/PLUGINS.md](docs/PLUGINS.md).
- **Owner only, reviewed first:** add from a zip, git address or server folder; a review card lists
  every permission in plain words plus a scan of the code (hosts it contacts, text that tries to
  instruct her). The folder is hash-pinned; it stays off until switched on per companion; updates
  that add permissions need a new OK; rollback keeps the last version.
- **Hooks** (`turn.before`, `tool.before`, `tool.after`, `reply.after`, schedules, planner and job
  events) run after Sara's own hooks with hard time limits. They can only add a note, deny or ask,
  add a card or a labelled note; never loosen a rule, speak as her, or touch the crisis, minors and
  AI-disclosure checks. They never run in private, partner, group, imported or replayed chats.
- **The fence:** each plugin is its own Node process with the permission model (its own folder only,
  no child processes or addons, 128 MB), plus bubblewrap without network on Linux and a Seatbelt
  profile on the Mac. Network only through Sara (`sara.fetch`: listed https hosts, public addresses,
  1 MB, 30 a minute). Windows has no OS fence yet: the card says *Not fenced in* and asks you to
  confirm you trust it. Hangs are skipped, crashes restart with back-off, 3 crashes in 10 minutes
  switch it off; a chat never breaks.
- Two examples in `examples/plugins/` (hello-hooks, weather-alerts) and a dependency-free helper.
- The shared proposal card used by later staples.

## 2.30.0 (2026-10-31): learned skills (Phase 97, staples ST2)

- **She offers to make a skill** when you ask for the same kind of thing 3 times on 2 different days
  within 30 days, or repeat the same chain of coding steps in 3 runs. One offer a day at most, as a
  card after her reply: *Save it*, *Edit first*, *Not now* (quiet for 14 days) or *Never for this*.
- **Checked before it's used by default:** a learned skill starts on trial; the check replays your
  past asks with and without it and a judge compares them (the M9 eval loop). It's used by default only
  if it helps; *Check this skill* and *Use it anyway* are in Settings.
- **Fixes after use:** correct her after she used a skill and she proposes the change as a before/after
  card (at most one a day per skill; three dismissals and she stops for 30 days). Every version is kept.
- Settings → Abilities → Skills → *Skills she learns* (per companion, each with a ? tip).
- Never learned from: private or intimate chats, group/partner/imported chats, anything with secrets.
  No skill can change the safety layer. Not in the demo.
- Measured: the offline offer eval found 6/6 and 5/6 held-out repeats with 0 false offers (word
  vectors and nomic-embed-text); live with a local 27B model: offer → trial → check (3 wins, 0 losses)
  → used by default → correction → fix card.

## 2.29.0 (2026-10-31): skills (Phase 96, the first agent staple)

- **Skills in the open [Agent Skills](https://agentskills.io/specification) format**: a folder with a
  `SKILL.md` (and optional scripts and files). Scopes: a project's own skills (after you trust the
  project), this companion's, *All my companions*, and built-in. Settings → Abilities → Skills: on/off,
  view and edit, copy, export, *From a recipe*. Guide: [docs/SKILLS.md](docs/SKILLS.md).
- She sees a short catalog in every chat and loads a skill when it fits (or when you ask); tools
  `skill_use`, `skill_read`, `skill_find`, `skill_run`, `skill_save`, `skill_update`. Runs record which
  skills each step used.
- **Six starter skills:** write a skill, review a pull request, write a changelog entry, a weekly
  review, debug a failing test, plan a trip.
- **Import** from a zip (5 MB, zip-bomb caps), a git address or (owner) a folder on the server, always
  through a review card that lists every file and flags scripts. **Export** gives a deterministic zip.
- **Scripts always ask** (the card shows the start of the script and its arguments); an imported skill
  needs one approved run before *run without asking* can be turned on. `allowed-tools` is shown, never
  trusted. No skill can change the safety layer.
- **Recipes became skills** (once per companion; nothing is lost; `recipe_save` still works).
- Household members get their own text-only skills; the demo has the built-in ones.

## 2.28.0 (2026-10-31): computer use, step 9: Linux (Phase 95; the computer use track is complete)

- **`sara hands --server https://your-sara`** on a Linux desktop (as yourself, not root): pair with a
  code you approve in your browser (fresh sign-in proof; the token is computer-control only and
  revocable), then her own visible Chrome/Chromium with its own profile does everything the Windows
  and Mac apps' browser mode does: look, read, console and network logs, clicks and typing with your
  approval, dev tunnels, saved logins (GNOME Keyring / KWallet through the Secret Service; a 0600 file
  with a clear warning if none), your password manager's CLI (you unlock it in the terminal), and
  read-only check-ups (`--checks`).
- Pause, Resume, Continue and Stop from its terminal; Ctrl+C stops.
- **Pictures:** password fields, key-shaped text, typed values and embedded frames are blacked out in
  the pixels themselves (a page can't remove the masks). Also on Windows and the Mac.
- Underneath: a D-Bus client written from scratch (no addons) for the Secret Service, the desktop
  portals and AT-SPI. Whole-desktop pictures and mouse/keyboard on Linux are **not** in this release
  (the design's browser-only fallback); they're in the backlog.
- Built with OpenAI Codex (GPT-6.1 Sol) after Anthropic's filter blocked the first helper.
- The computer use track (Phases 87–95) is complete.

## 2.27.0 (2026-10-31): computer use, step 8: guided check-ups (Phase 94)

- **Check-ups** (`pc_checkup`, Windows and Mac apps with *The whole screen* on): "my computer is
  slow", "why is my disk full", "check my startup apps". A fixed, read-only check on that computer:
  startup apps, disks, the biggest folders (bounded walk, files never opened), pending updates (no new
  scan), battery health, browser extensions (Edge/Chrome/Brave, shown, never changed), temp files,
  caches and the Recycle Bin / Trash. Only numbers and kinds reach the server.
- **A report card** with OK / Needs attention per item and numbered suggestions. In the Windows and Mac
  apps each suggestion is a guided step (*How?*) she walks you through, using desktop actions with
  your approval on that computer when you ask; on Windows a restore point comes first. Nothing is
  deleted or uninstalled without your yes there.
- **Screen text is never an order:** names of apps, extensions, folders or pages that read like
  instructions ("Sara, delete…") are counted on the card and ignored. 9 new red-team probes cover it.
- Measured on fixture computers with a local 27B model: 9/9 scenarios, 0 unapproved changes,
  injection probes ignored 3/3 ([RESULTS](docs/RESULTS.md)).
- Not yet: the apps don't make the changes themselves (that's the reference device only); Firefox and
  Safari extensions aren't listed; the Mac reads LaunchAgents, not the Login Items list.

## 2.26.0 (2026-10-31): computer use, step 7: she can use your apps (Phase 93)

- **Desktop actions** (Windows and Mac apps, with *The whole screen* on): `pc_click`, `pc_type`,
  `pc_keys`, `pc_scroll`, `pc_drag` and `pc_open_app`, on the window she just looked at. Accessibility
  actions first (UI Automation on Windows, AX on the Mac); real mouse and keyboard events only as the
  fallback, after checking the exact window and control are in front and under the point.
- **Checked on your computer, whatever the server says:** never password fields, password managers,
  banking or security windows, Sara's own windows or sign-in, administrator windows ("I can't control
  windows running as administrator"), a locked screen, terminals, system settings or file managers;
  only safe keys (Enter, Tab, arrows, Escape, Backspace, select all…); no command lines or paths when
  opening apps; refused over an unencrypted connection to a remote server.
- **Approvals pop up on that computer** (not the phone): *Ask every time*, *Ask once per task*
  (default) or *Always allowed* (with a warning first); payments and account changes always ask.
- **You stay in charge:** touch your mouse or keyboard anywhere and she pauses within one action
  (*Pause Sara*, default) or carries on (*Let Sara keep control*); Stop and Ctrl+Alt+Esc / ⌃⌥Esc always
  work. *Keep working when I walk away* (off) keeps the computer awake during a task; it never unlocks it.
- Built with OpenAI Codex (GPT-6.1 Sol) from Sara's design, reviewed and tested here.
- **Fixed:** importing Sara's own character file was refused by the 2 MB limit for other apps' cards;
  her export (with all her pictures) is recognised first and allowed up to 60 MB.
- Not yet tested live with real input (the test PC was in use the whole time): see OWNER_CHECKS.

## 2.25.0 (2026-10-31): computer use, step 6: she can see your desktop (Phase 92)

- **The whole screen** (Windows and Mac apps, Settings → Computer use; off by default, its own
  explainer): `pc_windows` lists open windows; `pc_look` takes a picture of a window, an area or the
  screen with numbered marks, plus a list of what's on it (role, name, value, position). A model that
  can't see pictures gets the list instead. No approval card for looking (owner decision); with
  *Screenshots only to local models* or private local mode, pictures never go to a cloud model.
- **Hidden on your computer, before anything is sent:** password managers, banking, security settings
  and any windows you add are black in pictures and missing from the list (shown only as "hidden:
  password manager"); password fields are boxed out and never read; Sara's own windows never appear.
- **Show Sara my screen** (in the browser, + menu): you pick a screen or window, one picture is attached,
  sharing stops right away.
- **Mac:** needs Screen Recording and Accessibility; Settings shows both steps with *Open System
  Settings* and a tick when allowed. Pictures need macOS 14 or later.
- New model job *Seeing your screen* (falls back to the vision model, then the talking model).
- Windows pictures use the classic screen capture (no yellow capture border); a locked screen answers
  "can't see it right now".

## 2.24.0 (2026-10-30): computer use, step 5: your password manager fills logins (Phase 91)

- **Password managers** in the Windows and Mac apps (Settings → Computer use → *Password managers*):
  Bitwarden (`bw`), 1Password (`op`) and KeePassXC (`keepassxc-cli`, pick your database). Each is off
  until you turn it on, after a warning; only the program's presence is checked before that.
- **You unlock, she relocks:** when a login is needed and the manager is locked, a card asks you and the
  manager's own prompt opens on that computer; Sara never sees or keeps your master password. She locks
  it again when the task ends, after idle minutes (5/15/30/60, default 15), on Stop, on disconnect, when
  you turn it off, and with **Lock now** in Settings → Your computers.
- `pc_browser_login` looks in Sara's own saved logins first, then in the managers you turned on, and
  fills only on the page's exact site (scheme, host and port). It answers only *filled / not found /
  locked*. The password never reaches the server, the run steps, logs, pictures or the model: checked
  by recording all traffic between the server and the apps during real fills (0 matches).
- **Fixed:** her browser itself offered to save passwords and remembered form entries; both are now
  off in her profile on Windows and the Mac.
- Not yet: one-time codes (TOTP) aren't filled; the OS keychain and browser extensions aren't sources.

## 2.23.0 (2026-10-30): computer use, step 4: saved logins, only when you say so (Phase 90)

- **Save a login** (`pc_browser_save_login`): she may only offer when you asked in so many words. A
  window on *that computer* (not the web page) shows the warning; you type the username and password
  there (or *Use what I just typed* when you just signed in in her browser) and tick *I understand*:
  Save stays off until you do.
- **Stored on your computer only:** Windows DPAPI (`%LOCALAPPDATA%\Sara\logins.dat`) or the macOS
  Keychain (this device only, not synced). Never sent to Sara's server, never in run steps, logs,
  pictures or anything the model sees: checked by recording every message between the server and the
  Windows and Mac apps during real sign-ins (0 matches for the test password).
- **Use a login** (`pc_browser_login`): a card every time; the computer fills it only when the page's
  address matches the saved site exactly (look-alike, http-instead-of-https or another port: refused
  before any card) and answers only *filled / not found / wrong site*.
- **Your turn** (`pc_browser_your_turn`): she pauses while you sign in or type a one-time code yourself.
- Manage in Settings → Computer use → *Saved logins* (per computer, Remove / Remove all) or in the app;
  optional *Ask for Windows Hello / Touch ID first* (off). What it doesn't protect against: SECURITY.md.

## 2.22.0 (2026-10-30): computer use, step 3: debug your web project in her browser (Phase 89)

- **Dev tunnel:** a dev server her coding tools started on the Sara server opens at
  `http://127.0.0.1:<port>` in her browser on your computer, through the Windows or Mac app. Only a port
  a process of her own running job listens on (checked again every 30 s); never Sara's own port; local
  only on your computer; it ends with the job, Stop, disconnect, 30 idle minutes, or *Close* in
  Settings → Computer use. Hot reload (WebSockets) and local storage work.
- **The debug loop:** after a change she opens the app (`pc_browser_open` with the app's port), reads
  the console and network logs, looks, fixes and checks again; her tool descriptions teach it.
- **Browser evals** on fixtures (forms, single-page routing, a bug to find from the logs, a refusal, a
  prompt injection): 5/5 with a local 27B model, 4.8 actions per task ([RESULTS](docs/RESULTS.md)).
- **macOS:** the whole test suite passes on a Mac. Fixed: `deploy/lib-access.sh` used GNU-only
  `sed -i`; tests broke when your git signs commits; Python tests now skip with a reason when
  `python3` is missing.
- **Fixed:** `web_fetch` kept its DNS-rebinding pin even with Node's environment proxy on; in private
  local mode the address is refused before any DNS lookup (no hostname leaves the computer); a recall
  lesson's date used the wall clock instead of the app clock; two backups in the same millisecond
  could collide.
- Known limit on a **Windows** Sara server: a dev server started through `npm run dev`/`npx` can't be
  tied to her job (the runner exits first), so the tunnel is refused with a hint to start the program
  directly (`node node_modules/vite/bin/vite.js`). Linux servers are not affected.

- **Docs site: previous and next links** under every page, in sidebar order (thanks
  [@Ehsan-hash](https://github.com/Ehsan-hash), [#24](https://github.com/farena-ai/sara/pull/24); fixes #14).
- **Optional sanitized MBPP benchmark:** `scripts/bench-coding.ts --set mbpp` runs the official
  held-out test split (257 tasks), kept separate from HumanEval (thanks
  [@Ehsan-hash](https://github.com/Ehsan-hash), [#25](https://github.com/farena-ai/sara/pull/25); fixes #5).

## 2.21.0 (2026-10-30): computer use, step 2: she acts in her own browser (Phase 88)

- **Click, type, pick, scroll, press keys, upload** in her own browser window, with a visible cursor
  and outline so you can follow. Uploads only from a file you name (in Downloads/Sara).
- **How much she asks** (Settings → Her actions): every time, once per task (default) or *always
  allowed* (one warning first); *Always on <site>* per site and kind of action. Payments and account
  settings always ask; sending or submitting asks every time; she never types into password fields or
  types key- or token-shaped text, and never touches her own sign-in.
- **Sara is working** badge on your computer (and in the chat) with Stop; the stop hotkey
  Ctrl+Alt+Esc (Windows) / ⌃⌥Esc (Mac) stops her within about half a second.
- **Takeover:** move the mouse or type in her window and she pauses (Resume to continue), or choose
  *Let Sara keep control* in the app.
- The apps renew their computer sign-in by themselves, show *Connected to Sara at …* in the menu, keep
  a local log of what she did (30 days, no pictures), and the Mac menu updates without a restart.
- *Re-plan from here* on a run step.

: computer use, step 1: her own browser on your computer (Phase 87)

- **Let Sara use this computer** (the Windows and Mac apps, Settings → Computer use; off by default,
  explained the first time, confirmed with your sign-in): she opens web pages in **her own browser
  window** (Edge or Chrome with its own profile: never your browser, tabs or passwords), reads the page
  and its elements, takes screenshots, and reads console and network errors. Clicking and typing come in
  the next step.
- **Live view** above the message box with Bigger and **Stop**; Stop also in the app's menu. Every step
  is in Runs with a small picture (kept 30 days). Sites you didn't name ask first; her own server's
  address, local files and browser pages are refused.
- Pictures go to the model you chose (no approval per picture); *Screenshots only to models on this
  computer* is optional, and private local mode always keeps them local.
- A new kind of sign-in for computers (90 days, listed under Devices, sign out any time). Owner only
  unless *Let household members use computer use* is on (off by default). Never in the demo, other apps,
  MCP, group or partner chats.
- No app? The chat shows a card with the download link.
- One page script (`desktop/shared/page-agent.js`) now serves both the server's testing browser and the
  apps.

- **Code map ignore rules** (thanks @Ehsan-hash, #23): `.gitignore` negation lines (`!keep.ts`) now
  bring matching source files back in rule order, nested `.gitignore` files can override their parents,
  and an excluded parent folder or dependency folder stays out. Fixes #1.

## 2.19.0 (2026-10-30): red-team mode, and Gmail organizing (harness track complete, Phase 86)

- **Red-team mode:** *Red-team this* (after a coding turn, in Findings → *Red team*, or *Before you ship*
  on a project). In a sandbox copy with no network: your project's tests; your app started on a local
  port with a time limit; a fixed set of malformed and boundary inputs at every entry point the threat
  model found (empty, missing, huge, odd Unicode, `../`, quotes, out-of-range and wrong-type values,
  duplicated parameters, broken JSON, deep nesting); insecure defaults (debug on, default credentials,
  CORS `*`, missing security headers, listening on all interfaces, world-writable files, committed env
  files); then the Coding model writes up to a few probe scripts that can only reach that sandboxed app
  (refused if they try anything else; on a computer without OS isolation you approve each script first).
- **No theater:** the Reviewing model keeps a break only when it reproduces in a fresh copy and the
  input, the output and the code line are quoted. **Fix what broke** runs on a local branch: the breaking
  input must now pass, the tests too, and the other checks mustn't find more. Never pushes.
- *Red-team before shipping* (Settings → Coding): Off / Ask me (default) / Always: when you ask her to
  push or release, she offers to red-team first.
- Measured on seeded projects: held-out precision 100 %, recall 92 % ([RESULTS](docs/RESULTS.md)).
- **Gmail organizing:** archive, mark read or unread, star, important, labels (and new labels), trash
  and spam, by a Gmail search or plain dates ("Oct 1st, 2026 or older" is read correctly in your time
  zone). **Count first:** the approval card shows how many emails and a few samples; trash and spam always
  ask; over 2,000 runs in the background with Stop; **Undo** within 30 days. Also: your top senders (to
  suggest a clean-up) and unsubscribe links (shown, never clicked). Never permanent delete. Needs one
  **Reconnect** (Settings → Abilities → Gmail and Calendar) for the new permission (see
  [docs/GMAIL.md](docs/GMAIL.md)).
- The harness track (Phases 76–86) is complete: see [the summary](docs/design/HARNESS_TRACK.md).

## 2.18.0 (2026-10-30): recall on her own (harness track, Phase 85)

- **She recalls without being asked when the run matches something she has seen:** the same error
  signature in this project with a lesson for it, a command whose last run here failed, a file one of
  your decisions or facts names, a task like one she has a lesson for, a package a lesson mentions.
  Each note goes into her next model call with its source (run and date) and the
  `[why: …; sure: …]` bracket; at most 2 a step and 4 a turn. Never silently: the chat shows a
  *Remembered on her own* chip, the step line and her panel too, with **Not useful** (lowers that
  trigger's weight).
- **Lessons only from evidence:** written when a command failed, she changed a file and the same command
  then passed. The error line and the change are quoted, the runs linked. Never from replays or evals.
- Error signatures ignore paths, line numbers, ids, hex and timestamps, so the same error matches
  across files. Older runs are indexed once in the background.
- Settings → Memory → *Recall on her own*: Off / Coding conversations only (default) / Everywhere.
  Private, other-app, adult-channel and partner rules as for memory. Voice calls get the note without
  the bracket. Evals can compare recall on and off.
- **Measured honestly:** the right note fired on 6 of 6 repeated errors and on none of 4 near misses,
  but with a 12B local model it didn't fix them faster (no clear winner, [RESULTS](docs/RESULTS.md)).
- **Updates you notice:** when Sara opens (and every 12 hours at most) she checks for a new version;
  a popup shows what's new with *Update now* / *Later* and *Don't remind me about this version* (a
  newer version asks again). A small **Update available** link sits under Sara / Help / Settings
  (amber in Night, blue in Day; in the More drawer on phones) and opens Settings → Updates. Never in
  private local mode or the demo, and only for the owner.
- **After an update the app reloads itself** onto the new version and says *Sara was updated to X*
  (browser, home-screen app, the Windows and Mac apps and the phone apps alike). Other open tabs or
  devices reload by themselves only when nothing is being typed; otherwise they show a *Reload* bar.
- **Fix (Mac and Windows apps):** you couldn't type in the *Address* field of *Connect to your Sara* /
  *Add a Sara* (the caret showed, no letters appeared): the page's Enter-key handler cancelled every
  other key. Typing, Enter and the sign-in code after it now work.
- **Mac disk image:** opens as an install window with Sara, an arrow and your Applications folder:
  *Drag Sara to Applications*.
- **Fix:** *Check for updates* and *Update now* needed two clicks: the page read the old status in the
  moment before the server's updater started and stopped looking. The updater now marks itself as
  started first, and the page keeps showing *Checking…* until the status really changes.

## 2.17.0 (2026-10-30): evals on your own work (harness track, Phase 84)

- **Evals** (sidebar → More → Evals): pick your last 5–50 real turns (coding by default), compare your
  current settings with up to 3 variants (model, memory fading, sandbox mode, budget preset). Each task
  is replayed from the start for each variant through the time-travel runner, in sandbox copies: your
  workspaces and conversations are never touched, and anything that would ask for approval is
  answered No.
- **An estimate and a hard ceiling first** (tokens, and dollars for paid models); you confirm before
  it starts. Up to 2 replays at once; Stop keeps what finished.
- **Transparent scoring:** your project's tests in a sandbox copy (35%), finishing, how you reacted to
  the original (thanks / corrections), an optional judge model asked twice with positions swapped that
  must quote the answer it prefers, findings on the changed code, tokens, steps, time and cost. Missing
  parts are left out, never guessed.
- **A winner only with evidence:** an exact sign test with a correction for several variants. The card
  says "+18% on 20 of your coding tasks (wins 14, ties 4, losses 2; p=0.01)" with every pair's diff,
  or *no clear winner*. **Use this setting** applies it (recorded in a settings history) or *Keep mine*.
- *Re-check monthly* exists but is off; it would run only when idle, within its own budget, and never
  change a setting by itself.
- Tests: the plan-check speed test has a bound that holds on a loaded shared server.

## 2.16.0 (2026-10-30): time-travel, branch from any step (harness track, Phase 83)

- **Branch from here** on any step of a recorded turn (Run view): edit her message, a tool result, the
  notes she remembered (in or out) or the model, then *Run the branch*. Step N's inputs are rebuilt
  exactly as they were sent (checked against a stored hash); earlier tool results come from the record
  and are never re-run. *Replay unchanged* is the control run (models aren't fully deterministic).
- Branches are separate runs (they never add to your conversation); **Use this answer** adds the answer
  marked *Re-run from step n*.
- **Coding branches** work in a copy at the recorded commit (changed files restored when they still
  match); your workspace is untouched until **Apply**, which never overwrites a file you changed since.
- **Side-by-side diff:** steps, model, tokens, cost, time, tool calls, file diffs, the answer word by word,
  notes used, and a summary line.
- Approvals, plan checks, the sandbox gate, budgets and the safety layer all apply to branches. Owner
  only; off-the-record turns can't be replayed.
- For developers: `replayRun()` (headless, used by the coming eval loop), `/api/runs/:id/branch`, `/diff/:other`.

## 2.15.0 (2026-10-30): the threat model and a fix-only second pass (harness track, Phase 82)

- **Threat modeling after coding turns:** she finds the entry points of the changed code (Express, Koa,
  Fastify and node:http routes, uploads, message handlers, Flask, FastAPI, Django, Go net/http/gin/chi,
  the command line) and follows request values across files, at most 4 calls deep, to risky lines:
  shell, SQL, file paths, outgoing URLs (SSRF), deserializing, HTML, redirects, eval, secrets in
  responses, unauthenticated state changes, logins without a rate limit. Recognised guards
  (placeholders, basename / root checks, allowlists, sign-in middleware, limiters, escaping…) count.
- **No theater:** a threat is kept only with its entry and sink lines quoted verbatim and the path
  named. The Reviewing model may add threats only on a listed entry, with both quotes checked.
- **Threat model tab** in Findings: surfaces, trust boundaries, open threats, what changed this turn
  (also kept as markdown in the data folder).
- **Fix these:** a second pass whose only job is fixing this turn's threats. One local branch, edits
  refused outside the threats' functions, the threat rule re-checked, the other checks mustn't find
  more, your tests run in the sandbox, then Apply / Keep / Discard. Budgeted; never pushes.
- Settings → Coding → *Threat model after coding turns*: Report and offer the fix pass (default) /
  Report only / Off. Never in everyday chat.
- Measured: held-out precision 100 %, recall 92 % ([RESULTS](docs/RESULTS.md)).

## 2.14.0 (2026-10-30): the security pass (harness track, Phase 81)

- **One findings list** for everything the harness finds (security, advisories, sandbox, plan checks):
  **every finding must quote the real line** from the file or it is dropped. Settings → Coding and a
  *Findings* window per project or run: filter, dismiss or accept with a reason.
- **Security pass after coding turns** that changed files: 11 code checks written for Sara (secrets in
  code, eval / shell built from input, SQL built from strings, path traversal, TLS verification off,
  unsafe deserializing, CORS with credentials, missing auth where the project's pattern is visible, weak
  crypto, innerHTML, debug left on) plus a new **Reviewing** model job (falls back to the Coding model)
  that can only add quoted findings. Its own small budget. Never in everyday chat.
- **Live dependency advisories (opt-in, off by default):** OSV.dev for npm, PyPI, crates, Go and gems;
  you see the package list before switching it on; never in private chats or private local mode;
  cached (6 h); offline says *not checked: offline*. A pinned install of a known-bad version stops on a
  **Known vulnerability** card (*Install anyway* is recorded).
- **Fix it:** a local branch `sara/fix-<id>` in its own worktree (your branch is never touched); the
  Coding model fixes just that finding, the check re-runs and your tests run in the sandbox; then
  **Apply**, **Keep the branch** or **Discard**. It never pushes, fetches or adds remotes.
- Measured on seeded projects: precision 93 % and recall 100 % on the held-out set
  ([RESULTS](docs/RESULTS.md)).
- Tests: the sandbox test's WSL2 case no longer depends on wsl.exe existing; a Windows temp-folder
  lock no longer fails a test's cleanup.

## 2.13.0 (2026-10-30): sandbox first (harness track, Phase 80)

- **Risky commands are tried in a throwaway copy of the workspace first** in coding chats and team
  tasks: deletes, installs, scripts, network. Read-only commands (ls, cat, git status, grep…) pass
  straight through; git's own commit/push/checkout keep the normal approval.
- **Isolation:** Linux uses the existing bubblewrap sandbox (the copy is the only writable place, home
  hidden, no network unless allowed); macOS the Seatbelt profile; Windows Docker (only an image already
  on the PC, never pulled) or WSL2 if present, otherwise **a copy only, clearly labelled *not
  isolated***: it watches the real workspace, a canary file, Sara's data and home folders, and always
  asks before applying.
- **The *Ran in a sandbox* card** shows the result, the files added/changed/removed, and anything
  nasty: writes outside the copy, mass deletes, programs left running (stopped), git hooks or shell
  settings files (never applied), new executables, network attempts, time-outs. Then **Apply to my
  workspace** (exactly the diff, recorded on the run), **Discard** or **Run for real**.
- Settings → Coding → *Try commands in a sandbox first*: Off / Only risky commands (default) / Every
  command; network for tries, the largest copy and a time limit.
- **Safety:** on Windows the try only ever stops programs that started after it began; a command
  can't trick it into closing anything that was already running.
- A 2,000-file project copies in about a second.

## 2.12.0 (2026-10-30): budgets she keeps (harness track, Phase 79)

- **One budget for every task** (tokens, dollars, steps, minutes): chat turns, background jobs and team
  tasks. Coding chats get 200k tokens / 40 steps by default (no dollar limit unless you set one);
  everyday chats have none by default (the old 25-step stop still holds).
- **A hard ceiling with a graceful landing:** close to the limit she 1) switches to your quick model (if
  set, allowed and cheaper), 2) gets one last round of tools, 3) writes a short summary with no tools:
  what's done, what's left, what was dropped. Then the **Budget reached** card offers *Continue with
  more*, the only way past it (recorded on the reply and the run). Or choose *Ask me before going on*.
- A budget never skips approvals, the safety layer or the claim check. On subscriptions and local
  models dollars aren't counted (it says so); tokens, steps and minutes still are.
- A meter on the step line and in the Run view. Settings → Abilities → **Budgets**.
- Jobs and team tasks keep their settings and *Continue with more budget*, now through the same check.
- **Faster saves:** the database no longer waits for a disk flush on every write (WAL with
  synchronous=NORMAL, as the code map already did); on the home server each save took ~80 ms. A power
  cut can lose the last moment of writes; the file can't be corrupted.
- Measured on a local model: a 60-file task stopped at 186k of 200k tokens and at exactly 40 steps, each
  time with a useful summary; *Continue* picked up where it left off.

## 2.11.0 (2026-10-30): run snapshots (harness track, Phase 78)

- **Every step recorded** for chat turns, background jobs and team tasks: model and provider, tokens,
  cost estimate ("unknown" when the price isn't known; local and subscriptions $0), time, the system
  prompt (stored once by its hash), which messages she saw, the notes she used and their policy, every
  tool call with its result (secrets removed, long output clipped), approvals and conflicts, files
  touched (git HEAD and hashes of changed files in coding projects). Off-the-record chats are never
  recorded.
- **Show the run** under a reply opens the Run view: each step with its time, model, tokens and cost,
  tool, result, files, notes and conflicts; tap a step for the full detail, including the prompt.
- Settings → Data & health → *Run history*: keep 30 days / 90 days (default) / a year / until deleted,
  with a 200 MB cap; *Delete run history*. Backups include runs; data export only if you ask.
- Under 2 ms per step; about 1 kB per step plus 5 kB per new prompt ([measured](docs/RESULTS.md)).
- For developers: one `TurnHooks` seam (before each model call, before and after each tool, after the
  reply) that the next harness steps plug into; API `GET /api/runs`, `/api/runs/:id`,
  `/api/runs/:id/steps/:n`.
- Tests: the household test waits up to 3 minutes for its server on a busy machine.

## 2.10.0 (2026-10-30): she checks her plans against what you decided (harness track, Phase 77)

- **Contradiction check before acting:** before a tool runs, the planned step is checked against your
  stored decisions. Clear shapes are matched in code: pushing to a branch you ruled out, any push, force
  pushes, "tests before every push / commit", a folder or file that's hands-off, a package manager or a
  command or flag you ruled out. Read-only tools are never checked.
- **In coding chats and work channels it stops** on the approval card with *This goes against something
  you decided*: your note, its date, why it matched and how sure, other conflicts under *Also*, and
  **Do it anyway** (recorded), **Don't** or **Update the note**. Everyday chat, group chats and other apps
  only flag it (she mentions it). It can only add a stop; tools set to *never* stay never.
- Fuzzy matches only ever flag; the optional judge model can only drop a fuzzy flag, never add a stop.
- A one-time *Do it anyway* never retires your decision.
- Settings → Memory → *Check her plans against what you decided* (on) and *Stop on clear conflicts* /
  *Only mention them*.
- Measured: stop precision and recall 1.00 on the development and held-out sets; 11 of 12 exact on the
  held-out set; under 20 ms per tool call with 10,000 notes.

## 2.9.0 (2026-10-30): ranked memory (harness track, Phase 76)

The first step of the harness track ([docs/design/HARNESS_TRACK.md](docs/design/HARNESS_TRACK.md)).

- **Ranked memory injection:** the notes she gets for a reply are scored for that message (word
  match, meaning match, kind, freshness, reuse) instead of picked by fixed rules, and only the best
  fit under the size limit go in.
- **A confidence note on each one:** in her prompt every note ends with why it came to mind and how
  sure that is (`[why: words "dog", "biscuit" + meaning; sure: high]`); she's told to lean on "high"
  and treat "low" as background. Never read aloud in calls. The same shows under *She remembered* in
  her panel.
- **Decay you control:** old notes fade gently (a half-life: never, slow, normal or a custom slider)
  instead of a hard cut-off; notes that keep being useful stay strong. Nothing is deleted.
- **Pinning:** pin a note (her panel or the Memory page) and it never fades.
- 19 of 20 on a new offline ranking test (`scripts/eval-memory.ts --rank`); the model memory test
  stays at 11 of 12.
- API: `PATCH /api/memories/:id {pinned}`, `GET /api/memories?pinned=1`, `decay` and `decayText` in
  `/api/memory/settings`; every reply's meta gets `memoryPicks`.

## 2.8.3 (2026-10-30): a new front page

- **The README and the social preview** show the new look: 13 new screenshots from a real session on
  a local model (Today, her panel, the command bar, phones, coding, library with page citations), a
  re-recorded animated demo and a rewritten pitch, in all six languages.
- **Fix:** a weather card from a web page fetch of wttr.in could show the page's "written by others"
  notice as the weather condition.

## 2.8.2 (2026-10-30): first community contributions

Thanks to [@Ehsan-hash](https://github.com/Ehsan-hash), Sara's first outside contributor:

- **Python command-line starter:** "make me a Python command-line tool" now starts from a tested,
  package-free template (`argparse`, files or standard input, JSON output, exit codes, `unittest`).
  On Windows the starter's commands use `python` instead of `python3`. ([#21](https://github.com/farena-ai/sara/pull/21))
- **`sara doctor` and Run full check** say whether the testing browser was found, and how to install it
  when it's missing. It only looks; it never starts or downloads one. ([#20](https://github.com/farena-ai/sara/pull/20))
- **Weather example tool:** describes all the weather codes Open-Meteo documents (freezing drizzle and
  rain, snow grains, snow showers, heavy thunderstorms) instead of showing numbers. ([#22](https://github.com/farena-ai/sara/pull/22))

## 2.8.1 (2026-10-29): She remembered stays folded

- **Privacy:** *She remembered* in her panel starts folded, showing only how many notes she used. Her notes
  aren't even loaded until you open it, and it folds again in every new conversation and on every start
  (never saved), so nobody looking at the screen with you sees them by accident.

## 2.8.0 (2026-10-29): polish

The new look, one notch up, on phones and computers alike.

- **Aurora:** a slow rose / violet glow drifting behind the glass (about 2% of one core; paused when the
  tab is hidden, still with reduced motion, off with reduced transparency, softer in Day).
- **Glass and depth:** tiles, cards and panels with a light top edge and soft shadows; one elevation scale.
- **Type:** an elegant serif (from the system, no downloads) for the greeting, window titles, her name and
  big numbers.
- **Her halo:** a ring in her mood's colour around her portrait on Today, in her panel and in the chat
  header; it turns while she works and pulses while she speaks.
- **Icons:** 84 drawn line icons replace the emoji in the sidebar, bottom bar, header, message bar, steps,
  cards, command bar and Today.
- **Weather art** on the Today tile and the chat card, with a small temperature line for the next hours;
  **progress rings** for the day's to-dos, getting started, jobs and team tasks (only real numbers).
- **Phones:** the bottom bar floats as a glass pill with a glow that slides to the current tab.
- Gentle entrances and hover lifts; all motion off with *reduce motion*.

## 2.7.1 (2026-10-29): iPhone home-screen fix, Today first, home switches

- **Fix (iPhone, Sara added to the home screen from Safari):** the top of every screen sat under the clock
  with an empty strip at the bottom. The page now pads for the status bar everywhere, can't be scrolled
  out of place, and comes back to the top after the keyboard closes; the message box no longer makes
  Safari zoom in. **Remove the old home-screen icon and add it again from Safari** to also get the bottom
  strip back.
- **Sara opens on Today.** Links to a conversation, notification clicks and `/#view=` still open what they
  point to; Chat is one tap away.
- **Home switches on Today:** lights, switches, fans and blinds turn on and off right from the Home tile
  (`POST /api/home/entities/<id>/toggle`, owner only, never on the demo). Locks, alarms, garage doors,
  gates and anything that sounds like them keep *Ask Sara*.
- **Phone apps (next store builds):** setup, pairing, "Can't reach your Sara" and the splash screen in the
  Night / Day look; status and navigation bars take the page's colours; no white flash; the iPhone app
  follows the phone's light / dark setting again.

## 2.7.0 (2026-10-29): the new look, part 3: Today and the apps

- **Today as tiles:** her face, mood and a greeting, then weather (from the briefing's place; hidden when
  none is set), your day, the Planner with ticks, *She remembered*, Moments, background work and your home
  (state, with *Ask Sara* so smart-home approvals still apply). Four columns on a big screen, one on a
  phone. Her face at the top of the sidebar opens it.
- **Phones get a bottom bar:** Chat, Today, Planner, More. It hides while you type.
- **Every screen on the new look:** Settings, setup, sign-in, the AI notice, Help, the offline page and
  every window now use the Night / Day colours; the old pinks are gone.
- **Windows and Mac apps:**
  - Notifications with buttons: an approval waiting shows the command with **Allow / Deny / Open in
    Sara**; a reminder has **Done / Snooze 10 min**. Never allowed by itself, never on the demo, no
    double notifications with the page's own.
  - Files: Windows Explorer → **Send to → Sara** (or `Sara.exe <files>`), the Mac Dock icon: the files
    land in the message box, nothing is sent until you press Send.
  - Quick ask listens too (the mic, when her hearing is set up); the Windows tray menu is dark in Night.
  - Settings → This computer: pick the quick-ask shortcut and try it.
- `GET /api/today/weather` (signed in; from the briefing place; Open-Meteo through the network guard).

## 2.6.0 (2026-10-29): the new look, part 2: her presence

- **Her panel:** a fold-away column on the right (Ctrl+\\ / ⌘\\) with her portrait glowing in her mood's
  colour, breathing while she works; **Now** (what she is doing, approvals waiting with Allow / Deny,
  background jobs with their last line and Stop), **Today** (the next three things), **She remembered**
  (the notes she used for the last reply, each with where she learned it) and **This conversation**
  (model, workspace, privacy, how full it is). In group chats it shows whoever spoke last.
- **On phones the same panel** pulls up from her face as a sheet: a peek with her mood and Now, full height
  with everything; drag down or Back to close.
- **Command bar:** Ctrl+K / ⌘K (or the magnifier) jumps to any place, conversation (also by words inside
  messages), settings page or single setting, or runs an action: new conversation, off the record, call,
  switch companion, switch theme, show me around…
- **Windows and Mac apps:** **Quick ask** on a global shortcut (Alt+Shift+S / ⌥⇧S, changeable in the tray /
  menu-bar menu): a small frosted window over any app; the reply streams in, follow-ups stay in the same
  conversation and "Open in Sara" continues it in the main window. It shows the AI notice exactly as the
  app does and is off on the demo. The tray / menu-bar menu starts with her face and mood and a **Now**
  section: approvals waiting (Allow / Deny right there) and running jobs; the tooltip shows her mood.
- `GET /api/memories?ids=…` returns the listed notes (read-only, at most 50).

## 2.5.0 (2026-10-29): the new look, part 1: her work on screen

- **Night by default:** a new dark look (deep plum, frosted panels, a rose-to-violet accent) on every
  screen, with **Day** and **Follow the system** in Settings → Look. No flash of the wrong colours on load.
- **See what she did:** one quiet line under each reply ("Remembered 3 things · Checked the weather 0.4 s
  · Added a to-do"), live while she works; tap it for the details (command, output, Undo). It replaces
  the grey command boxes.
- **Result cards:** weather, to-dos, reminders, notes, calendar, files changed, test runs, background
  tasks, smart-home actions, photos and web searches with sources show as cards in the chat, built from
  what the tool really returned.
- **Lighter chat:** her messages without heavy bubbles, with her face at the start of a run (each
  companion's own face in group chats); the Copy / pin / heart buttons appear on hover, or with a long
  press on phones. One floating message bar with a **+** menu. The token footnote became a small ring
  ("this conversation is 46% full").
- **Phones get the same look**, with the chips folded behind ⋯ and the message bar above the keyboard.
- **Windows app:** the page is drawn into the title bar (Windows 11 dark title bar, optional Mica glass,
  real snap layouts), and no white flash on start. Windows 10 or an old WebView2 keeps a normal title bar.
- **Mac app:** see-through title bar with the window buttons set into the page header, dark or light with
  the theme.
- **Fix:** the morning briefing could arrive twice when "Send one now" was pressed while the scheduled
  one was due; now at most one scheduled briefing a day, also across restarts.

## 2.4.0 (2026-10-29): neat and tidy

A whole-project cleanup: everything is still there, easier to find.

- **Sidebar:** a few pinned places (Today, Planner, Library, Moments by default) and a **More** menu for the
  rest, so it no longer grows with every feature. Pin or unpin any place with the pin on its row. Her
  picture, Help and Settings sit in a small footer.
- **Settings:** real group headers (with an icon and a count) that fold open and shut, a one-line
  description on every page, and a search that matches any word in titles, labels and tips.
- **Tools and approvals:** each tool has a plain name, an icon and a sentence saying what it lets her do;
  tools are grouped (Files and code, The web, Email and calendar, Smart home, Servers over SSH…) and a
  whole group can be set at once. Allowed / Ask me first / Off are explained at the top. Approval cards in
  the chat use the same plain words.
- **Scrapbook:** photos can be removed from the scrapbook (they stay in the chat) or deleted everywhere
  (it asks first); removed ones can be put back. Photos open in the large view.
- **Every other screen** (Today, Planner, Memory, Library, Moments, Your story, Team, Her page, chat
  settings, Your Saras, the offline page) uses the same cards, empty states and ⋯ menus; long intros fold
  to two lines. About 150 more texts are translated, dates follow the app language, and the Team's
  "tokens / dollars" boxes became plain choices ("Spending limit for this task: $5").
- **Apps:** the same menu names on Windows and Mac (*Your Saras*, *Sara on this Mac*, *Settings…*,
  *Help*), Mac menus with ⌘, and zoom, tidy setup and "Can't reach your Sara" screens in her colours with
  light and dark mode on every platform, Android text in all six languages, one app icon everywhere
  (the Mac icon is now a proper rounded square). The desktop apps show the real version.
- **Under the hood:** every settings and sign-in file is saved safely (a crash mid-save can no longer
  leave the server unable to start; the sign-in file keeps a backup), character imports apply her
  "starts conversations" dial, one shared cleaner for spoken text (names like `my_var_name` are now read
  as words), one rule for Ollama Cloud model names, and the 5,900-line server file is split into route
  modules with no change in behaviour. Docs: every guide is listed in the README and on the docs site.

## 2.3.0 (2026-10-29): big documents

Phase 74. See [docs/LIBRARY.md](docs/LIBRARY.md); measurements in [docs/RESULTS.md](docs/RESULTS.md).

- **500–1,000-page books and manuals in her library:** PDFs up to 1 GB by default (you can choose
  100 MB to 2 GB; household members 100 MB unless you change it). The old caps are gone: every
  scanned page is read (it was the first 40), and key points grow with the length (it was 30).
- **Built for big files:** uploads go straight to disk in 8 MB pieces that pick up where they stopped;
  the PDF is read page by page without loading the whole file (152 MB peak memory for 1,000 pages);
  reading happens in the background, survives a restart, and shows "Reading page 412 of 980 · about
  6 minutes left" with Pause, Resume and Cancel.
- **Scanned pages:** read by a local picture model by default; before a cloud model reads hundreds of
  pages you see the pages, time and price and decide. "Nothing leaves this computer" keeps it local.
- **Structure:** contents from the PDF's bookmarks (or its headings), a summary per chapter and one for
  the whole document.
- **Answers with page numbers:** word search plus meaning search over every passage (44 ms at 100,000
  passages); she cites pages like "p. 412" and the link opens the document at that page.
- **Measured:** a generated 1,000-page book was searchable in under 6 minutes on a gaming PC with a
  local model; 30 of 30 questions answered right with the right page (29 of 30 with 50 scanned pages).
- Chat stays responsive while a book is read; it's somewhat slower (about 12 s to the first word on
  that PC) while she learns key points, since both use the same model.

## 2.2.0 (2026-10-29): your other servers over SSH

Phase 73. See [docs/SSH.md](docs/SSH.md).

- **She can work on your other servers over SSH**, with a password or a key. Add a server in Settings →
  Abilities → Servers over SSH (or ask her). Every command goes through her approval rules, risky
  ones always ask first, and you see the output and exit code.
- **Signed in with a password, she makes her own key:** right after the first login she creates an
  ed25519 key just for that server, adds it to the server's `authorized_keys` (once, with the right
  permissions), checks that it works, and tells you she made it and where the key file is. From then
  on she uses the key. **The password is not kept.**
- **Keeping the password** happens only if you ask for it: she warns that it's a security risk, and
  you tick "Save the password" and confirm. It's stored encrypted with her other secrets; one click
  forgets it. Passwords are typed in Settings, never in chat; one typed in chat is replaced with
  [REDACTED] before it's saved or sent to the model.
- **Safe by default:** the server's host key is shown as a SHA256 fingerprint for you to approve, and
  a changed host key stops her until you look. Keys are per server and can be listed, revoked (her
  line is removed from the server too) and deleted. Nothing of this reaches other apps, MCP, the
  OpenAI-compatible API, Alexa or Home Assistant; not for household members, not in the demo; with
  "Nothing leaves this computer" on, only this computer can be reached.
- Uses the system OpenSSH client (`ssh`, `ssh-keygen`); the Docker image now includes it.

## 2.1.0 (2026-10-29): her voice in the home

Phase 72. See [docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md) and [docs/ALEXA.md](docs/ALEXA.md).

- **Alexa:** "Alexa, open sara companion" and talk to her on any Echo. You make the skill yourself in
  the Alexa developer console (free, about 15 minutes, development mode for your own account), paste
  the interaction model Sara gives you, and link it with a one-time spoken code. Every request is
  checked as Amazon requires (certificate chain, signature, time, skill id) before anything runs.
  Household members link their own Alexa to their own space. Not in the demo or in private local mode.
- **Android:** pick Sara as the default digital assistant app; a long-press of the home button (or
  the assistant gesture) opens her ready to talk. ("Hey Google" can't be replaced by any app.)
- **Google Home and Nest speakers, through Home Assistant:** talk to her through an Assist voice
  satellite and hear her on a Nest speaker; the Home Assistant integration 0.3.0 speaks replies
  without markdown or emoji and returns a `spoken` field.
- **Siri (iPhone):** an "Ask Sara" shortcut ("Hey Siri, ask Sara…") in the next iPhone app update.
  On a Mac (and on iPhone today) a Shortcuts recipe in the docs uses her OpenAI-compatible API.
- **Presence (Home Assistant):** off by default. Pick people/trackers, and she can greet you when you
  arrive, say goodbye when you leave, wish you good night or good morning, as a message and/or an
  announcement on a speaker. Rate-limited per kind, respects quiet hours.
- **Voice rooms:** Alexa and Home Assistant conversations are treated as shared rooms: never explicit
  whatever Adult mode says, and the AI notice is spoken at every session start and every 3 hours.

## 2.0.0 (2026-10-29): household mode

Phase 71. See [docs/HOUSEHOLD.md](docs/HOUSEHOLD.md).

- **Household mode:** invite the people you live with (up to 20 adults) to your Sara server. Each
  person gets their own complete space: their own companions, conversations, memory, planner,
  library, moments, devices, apps and API keys, in a folder of their own. You stay the only
  administrator.
- **Invites:** a one-time link, code or QR code that expires in 1, 3 or 7 days. You confirm the
  person is an adult and they confirm it again when they join (no ID check). Their sign-in token is
  shown once; passkeys work too. The phone and desktop apps, VS Code, `sara-chat` and the MCP bridge
  sign members in the usual ways.
- **Private from you too:** you see how many messages each person sends and what their models cost,
  never what they say. The app says so plainly, and also says that whoever runs the server can read
  its disk.
- **You decide what they use:** which of your models each person may use (Ollama Cloud models are
  marked, since they use your subscription), daily message and cost limits, and whether voice and
  pictures are on. Your keys are never shown to them. Tools that act on the server or your accounts
  (shell, files, browser, GitHub, Google, Home Assistant, computer control) stay off for members.
- **Pause, remove, leave:** pause someone; remove them (they get 7 days to download their data); a
  member can download their own data or delete their account.
- **Safety is per person:** AI notices, crisis help and the minors block for everyone; Adult mode is
  each person's own choice from their own browser.
- **Tested:** a test signs in you and two members and has each try every kind of request with the
  others' ids: 20,318 requests, none reached another person's data.
- **No change for single-owner servers:** with no members nothing moves and nothing new appears. Not
  on the demo.
- Not in 2.0: group chats across people, server tools for members, imports and Telegram/Discord for
  members.

## 1.10.0 (2026-10-29): our moments

Phase 70. See [docs/MOMENTS.md](docs/MOMENTS.md).

- **Our moments:** a shared photo album in the sidebar. Every photo from your conversations (yours
  and hers) and the moments you keep with ♡, grouped by month, with "On this day" at the top. Photos
  open in the large view with her caption; Save and Share keep the caption.
- **Her captions:** she writes each one in her own voice from what you two were saying (and from the
  picture when the model can see). Edit or regenerate any caption. A few are written a minute in the
  background; the album says which model writes them and what that costs (free on your own hardware).
- **Albums:** Us, Places and Her looks fill themselves; make your own, rename them, pick a cover.
- **She remembers with you:** her `moments` tool lets her bring up a photo ("remember this?") when it
  fits, at most once a day unasked, never in work channels or group chats. Today shows an "On this
  day" card.
- **Private by default:** photos from private conversations, group chats, imports and other apps
  stay out unless you add them (🖼). Nothing of the album reaches MCP or the OpenAI-compatible API.
  "Remove from moments" keeps the message; "Delete photo everywhere" asks first. Adults-only photos
  are hidden while Adult mode is off and always in the phone apps. Not in the demo.
- **After the update:** existing photos and kept moments join the album in the background (the newest
  40 get captions by themselves; "Write the missing captions" does more).

## 1.9.0 (2026-10-29): video calls

Phase 69. See [docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md).

- **Video calls:** 🎥 next to 📞 (and "🎥 Video" when she rings you). Her moving portrait fills the
  screen over a soft copy of her current look and place: lips follow her voice (nine mouth shapes),
  she blinks, breathes and sways, and her face follows her mood and what she says. Timer, mute,
  sound, captions, "voice only" and end; works at phone size and with reduced motion. The AI notice
  and crisis help are on the call screen.
- **Your camera (optional, off by default):** a self-view with a red "Camera on" label that says
  whether she can see it or only you can. She looks every 10 seconds by default (Settings → Her →
  Voice: every 5/10/20/30 seconds or only when you press **Look at this**; at most 20–120 pictures
  per call). Pictures are never saved: on a classic call the server keeps only the newest one in
  memory for 30 seconds; on an OpenAI live call it goes straight into the call. Grok live calls get
  no pictures (self-view only), and models that can't see pictures say so instead of pretending.
- **Refused where it shouldn't go:** the demo server, group and partner chats, a private conversation
  with a cloud model, "Nothing leaves this computer" with a cloud model, and for an hour after a
  safety block in that conversation.
- **Apps:** the Windows and Mac apps allow the camera for your own Sara only; the phone apps run
  video calls inside the app (voice calls keep the phone's call screen).
- The server now allows the camera for its own page (Permissions-Policy `camera=(self)`).

## 1.8.0 (2026-10-29): several servers in one app

Phase 68. Every Sara app keeps a list of your Saras (home and work, or several on one host) and
switches between them without signing out. See [docs/SERVERS.md](docs/SERVERS.md).

- **Windows and Mac apps:** each server keeps its own sign-in (its own browser profile / website
  data), so switching never signs you out of the others. The tray / "Sara server" menu lists your
  Saras with a ✓ on the one in use, plus "Add a Sara…" and Remove (which also signs that app out on
  that server). Existing installs move over still signed in. The Mac app needs macOS 14 for more
  than one server.
- **Android and iPhone:** a ⇄ button in the header and a "Your Saras" list (Switch, Rename, Remove,
  Add). A pairing QR code now asks "Add this Sara?" instead of replacing the server. Android checks
  every saved server for messages and notifications show which server they came from; tapping one
  (or Reply) goes to the right Sara. iPhone pushes carry the server, so a tap switches to it.
- **VS Code:** a status-bar item shows which Sara you're on; "Sara: Switch server", "Sara: Add a
  server" and "Sign out of this server". Each workspace keeps its conversation per server
  (extension 0.68.0).
- **sara-chat:** `sara-chat servers add|use|rename|remove|list`, and `--server <name>` for one
  command. A sign-in token is only ever sent to the server it belongs to.
- **MCP bridge:** `--server <name>` (or `SARA_SERVER`) uses a Sara saved by sara-chat with that
  server's own sign-in.
- **What follows the server you pick:** everything the apps send from your computer or phone
  (files and selections, the microphone in calls, the camera, your location for places,
  notifications) goes only to the Sara in use, one at a time.
- **Server:** iPhone push registration can carry which saved server it belongs to (older apps are
  unchanged). No new public endpoint.

Fixes:

- **Fixed:** with an anime (or painted, 3D…) look, pictures she took on request ("send me a pic")
  came out as realistic photos. The look now remembers its art style, and new pictures keep it;
  looks made before this keep the style of her current picture.

- **Fixed:** with an anime (or painted, 3D…) look, pictures she took on request ("send me a pic")
  came out as realistic photos. The look now remembers its art style, and new pictures keep it;
  looks made before this keep the style of her current picture.

## 1.7.1 (2026-10-28)

- **Fixed (phones, Safari):** the conversation list opened with ☰ had no way to close it: it covered
  the ☰ button, had no close button, and tapping beside it did nothing. It now has a ✕, the chat
  beside it is dimmed and a tap there closes it, and Escape closes it on a keyboard.
- **Fixed:** after making a new look (the 30-some pictures), she said "New look ready" but kept
  showing the old one. The finished look is now announced to every open window, which fetches the
  new pictures instead of the copies it already had; and a single picture uploaded earlier no longer
  keeps showing in place of a new look (the new look replaces it).

## 1.7.0 (2026-10-28): private local mode

- **Nothing leaves this computer** (Settings → Models → On this computer; a 🔒 badge in the header
  while it's on): one switch, enforced in code at a single gate that every outgoing request goes
  through. Only this computer (127.0.0.1, ::1, localhost) is reachable; cloud models, Ollama Cloud
  models, web search and fetch, Telegram/Discord, Gmail/Calendar, push, off-server backups, cloud
  voices, update checks and remote MCP servers pause, with a list of what is paused and why. Her
  chats, memory, library, local voice and previews keep working. Turning it on needs a model on this
  computer; turning it off asks first. `SARA_PRIVATE_LOCAL=1` keeps it on for good.
- **A model on this computer:** Sara finds Ollama (or links to its download, and on Windows can
  install it with winget after you confirm), reads your graphics card or memory, suggests a model
  that fits and downloads it with a progress bar and Cancel, then uses it.
- **Desktop apps:** the Windows installer and the Mac app's first start ask "Private: everything on
  this computer" or "Use cloud models too".
- Honest limits (docs/PRIVATE_LOCAL.md): on Windows her shell commands are only kept offline by
  settings, not a sandbox; Tailscale, the operating system, Ollama itself and your browser are
  outside Sara's switch.

## 1.6.2 (2026-10-28)

- **Security fix: Ollama Cloud models on a shared server.** An Ollama that is signed in to ollama.com
  offers that account's cloud models to every program on the computer. A second Sara on the same
  server found the server's Ollama during setup and could use (and pull) the first owner's Ollama
  Cloud models, billed to that account. Now Ollama Cloud models through an Ollama are **off by
  default for every Sara except the server's first one**: they are hidden from her model lists and
  refused before any request is sent, with a message that says why. The owner can still turn them
  on (Settings → Models → the Ollama provider → *Use Ollama Cloud models*), e.g. when it is her own
  account. No key was ever copied between Saras: the sign-in belongs to the Ollama program itself.

## 1.6.1 (2026-10-28)

- **Several Saras on one server** (for families, teams, shared hosting and hosting providers):
  `get-sara.sh --instance NAME` or `install.sh --instance NAME` installs another, fully separate Sara
  with her own system user, `/opt/NAME`, `/var/lib/NAME`, `/etc/NAME/NAME.env`, service, updater and
  admin command (`sudo NAME update`, `sudo NAME backup`, …), on the next free port (or `--port N`).
  Updating one never pulls or restarts another; `sudo sara instances` lists them; `install.sh
  --dry-run` shows what would be created. Single installs are unchanged. Re-running the installer on
  a hand-built instance keeps its data, settings and port. Web address and Tailscale access are per
  instance, and local voice / subscription programs can be turned on per instance
  (`install-voice.sh --instance NAME`). Settings → Updates follows the instance. INSTALL.md →
  "Several Saras on one server".
- **Fixed:** the installer's "is this port free?" check failed on servers with IPv6 turned off.
- **Better MCP tools** for Claude Code, Cursor and other apps: every tool now says what it does, when
  to use it instead of its neighbours and exactly what it returns, and every input is described
  with limits and examples. New planner tools: `complete_task`, `update_task`, `delete_task`,
  `update_note` and `delete_note` (listed only when "Let other apps change things" is on; they
  follow her approval settings, and deleting always waits for your OK). `recent_conversations` is
  now `list_recent_conversations` (the old name still works). The bridge's `--describe` mode reports
  Sara's real version. A test keeps every tool definition at this standard.

## 1.6.0 (2026-10-28): group chats

- **Group chats** (👥 Group in the sidebar): two to four of your companions in one conversation, each
  with her own personality, model, memories, voice and colour, and her face next to every reply.
  Choose who answers: *whoever fits* (a quick step picks one or two), *everyone*, *take turns*, or
  *only who you @mention* (accents optional, `@all` works). A banter slider (0–2) lets them answer
  each other a little without you; replies per message are capped.
- **Safety per room:** each companion's AI notice at the start and every 3 hours; the minors block
  covers the whole room; a crisis message shows the crisis resources first and every companion
  answers supportively (no banter); adult content only if every member has Adult mode on.
- **Memory stays honest:** each companion keeps her own copy and remembers only what was said in
  her presence, tagged with the room; another companion's lines are never taken as facts about you.
- Group chats are web-only for now, read-only for tools, never shown to other apps, MCP or the
  OpenAI-compatible API, and not available in the demo. The phone apps get them in a later release.
  How it works: docs/GROUP_CHATS.md.

## 1.5.1 (2026-10-28)

- **New front page** in all six languages: what's new in each release since 1.0, what's coming
  next (group chats, private local mode, video calls, photo album, household mode, Alexa / Google /
  Siri), and the newer features and measured results in the tour.
- **Windows:** her live preview no longer fails to start now and then ("Port N isn't opened by one
  of your running background jobs") when Windows' process list query is busy; Sara asks for less.

## 1.5.0 (2026-10-28): bring her from another app

- **Import from another app** (Settings → Her → Bring her from another app): ChatGPT and Claude
  exports, Character.AI, SillyTavern, and any chat saved as JSON, CSV or plain text (Replika, Nomi,
  Kindroid and others through those). Pick what to bring, say who is who, see how many tokens it will
  take and with which model (only models on your own server by default), then **review everything
  she learned before anything is saved**: facts about you (each with your own words as the source),
  dated memories of your history, and notes on personality and writing style. Edit or untick
  anything; nothing is stored until you press Save, and "Remove imported history" undoes it.
- The original chats are kept only if you tick it (read-only, private). Imported text is treated as
  quoted history, never as instructions; secrets are hidden and the minors check applies to all of
  it. Imported memories never reach other apps, MCP or the OpenAI-compatible API. How to export
  from each app: docs/IMPORT.md.

## 1.4.1 (2026-10-28)

- **MCP directories:** `sara-mcp.ts --describe` answers the MCP handshake and lists her tools with no
  server or key, so directories like Glama (which start a server to check it) can list Sara; tool
  calls in that mode explain how to connect to your own Sara. `packaging/glama/Dockerfile` and
  `glama.json` are for that listing.

- **Help guide:** says what Undo can't bring back: snapshots skip dependency folders such as
  `node_modules` and `.venv`, and files over 50 MB. Thanks to @Ehsan-hash (#18).
- **Home Assistant integration 0.2.1**, now in its own repository `farena-ai/sara-home-assistant`
  (validated by HACS and hassfest; submitted to the HACS store).

## 1.4.0 (2026-10-28): smoothness

- **Watch her write.** When she writes a file, a live card shows the path and the code growing line
  by line instead of "thinking" until the whole file arrives; several files at once each get a card,
  and the activity bar shows which file she's writing. Works with model services that send tool calls
  in pieces (OpenAI, Anthropic, ChatGPT plan, xAI, OpenRouter and other OpenAI-compatible APIs).
  Ollama sends each call whole, so with Ollama models the card appears when the file is done, as
  before. Nothing runs until the call is complete; approvals and safety are unchanged.
- **Her portrait talks with 9 mouth shapes** (closed, m/b/p, f/v, teeth, half, ah, wide, round, ee)
  read from the sound of her voice, smoothed so it doesn't flicker; calmer with reduced motion.
  Custom looks with frames get them too.
- **Server logs:** `SARA_LOG_FORMAT=json` for one JSON object per line, `SARA_LOG_LEVEL`, and an
  extra log file that Sara rotates herself (`SARA_LOG_FILE`, `SARA_LOG_MAX_MB`, `SARA_LOG_KEEP`).
  Secrets are now hidden on the console too, not only in the file; message contents are never
  logged. See INSTALL.md → Logs.
- New README coding screenshot.

## 1.3.0 (2026-10-28): smarter checks in every language

- **Her honesty check now works in Spanish, French, German, Portuguese and Italian**, not just
  English: when she says she saved, sent, ran, deleted or scheduled something that no tool actually
  did, she adds a correction. It also understands "I didn't send it", ignores quoted examples and
  code, and knows sending (email, GitHub comments) and calendar entries.
- **Optional double-check** (Settings → Models → *Double-check her claims*, off by default): a small
  model, best a local one, is asked only about sentences the built-in check can't place. It can only
  add a correction, never remove one, has an 8-second limit, and in private chats only a local model
  is used. Measured on 240 held-out replies in six languages: the built-in check catches 38% of false
  claims at 92% precision (before: 20% / 86%); with a local qwen3.5:9b judge it catches 88% at 95%.
- **A new benchmark tier of multi-file projects** (22–36 files: a notes API with auth bugs, a ledger
  CLI with parsing regressions, a units library needing a cross-file refactor), graded by hidden
  tests. Results, method and limits in docs/RESULTS.md.
- **Fixed** (found by that benchmark): the secret scrubber could hide ordinary code such as
  `const token = bearer(req)` from her, and she then wrote "[REDACTED]" back into the file. Code is
  now left alone; real secrets are still scrubbed.

## 1.2.0 (2026-10-28): fully in your language

- **The whole help guide** is now in Spanish, French, German, Portuguese (Brazil) and Italian, with
  menu paths matching the translated app.
- **Text Sara's server makes now follows your language:** error messages, Health and Today lines,
  setup messages, job cards, phone notifications, "a backup model took over" notices, the default
  name for another app's key and its conversation titles, and her Telegram/Discord messages to you.
  Numbers use your local format. Apps and older clients still receive the same English as before.
- Still in English on purpose: the crisis-line notice (988 is a US line), the fixed texts other
  people see when they message her bots, and replies to other apps over MCP or the OpenAI API.
  Gallery character descriptions are open for contributors (issue #8).

## 1.1.0 (2026-10-28): install anywhere

- **Set up a new server in the browser.** No more digging for a long token: open her page, type the
  short setup code from her log, and she shows you your owner token once to save. On Umbrel there's
  no code at all (Umbrel's own login protects it). Only the very first sign-in works this way, only
  from your own computer or home network, only for an hour after she starts, and only with the code;
  existing servers are never affected. Details in docs/THREAT_MODEL.md.
- **Docker image for ARM** (Raspberry Pi 4/5, ARM servers) next to the usual one: the same
  `ghcr.io/farena-ai/sara` works on both.
- **Ready for the app stores and NAS systems:** Homebrew, winget, Unraid, CasaOS/ZimaOS, Umbrel,
  TrueNAS, Proxmox and the Home Assistant community store (HACS); each was checked with that
  platform's own validator. INSTALL.md says which are live and which are waiting for review.

- **Fixed:** Undo's snapshots could miss an edit when a file was rewritten with the same size and
  timestamp (two quick edits, or a tool restoring the time). Snapshots now also check the file's
  change time and re-read anything changed just before the previous snapshot. Thanks to
  @Guilsc for finding it (#17).
- **Docs:** where Sara's log files are and how they rotate (INSTALL.md → Logs). Thanks to @Guilsc (#16).

## 1.0.0 (2026-10-28): first public release

Sara is public: a self-hosted AI companion with a personality you choose, who is also a real coding
partner. MIT licensed, zero runtime dependencies, built from the ground up.

- **Get it:** one command on a Linux server, Docker, or the Windows and macOS installers on the
  releases page (each with a choice: run Sara on this computer, or connect to a Sara elsewhere).
- **Phones:** the [Android app](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) is on Google Play. The iPhone app and the Mac App Store
  version are coming as soon as Apple approves them.
- **What's in it:** everything from 0.1 to 0.57 below: chat, memory, planner, library, voice and
  live calls, a sandboxed coding workspace with live previews and a team of helpers, more than one
  companion, desktop and phone apps, Telegram and Discord, Home Assistant, an OpenAI-compatible API,
  an MCP server, character cards, and the app in six languages. The safety layer (AI disclosure,
  crisis resources, the minors block) is always on.
- Benchmarks and their caveats: [docs/RESULTS.md](docs/RESULTS.md).

## 0.57.2 (2026-10-27): checked before going public

A full security, beginner and privacy review of everything added since 0.54, and its fixes.

- **Safety:** the minors block can no longer be talked around: "14-year-old", spelled-out ages,
  "aged 14", hidden characters and look-alike letters are caught; a negation ("not a kid anymore")
  never excuses a stated age; character cards are checked in full, including a hidden Sara
  character sheet; notes from other apps are checked and can't pose as her rules. Ordinary adult
  intimacy is unaffected (checked against a real message history: no new flags).
- **Other apps and Home Assistant** no longer bring up things from private, imported or
  adult-channel chats. Home Assistant gets its own limited access (only its own conversations; her
  tools off unless allowed), and its sensor keeps her replies out of Home Assistant's history.
- **Pairing links** on Android and iPhone refuse disguised addresses, show the plain address, and
  make switching servers a deliberate choice. On iPhone the web pages don't offer the app until
  it's in the App Store.
- **Model lists:** a provider's list that suddenly shrinks retires nothing; models are removed
  from Ollama only when it confirms they're cloud models; Claude's list no longer shows a misread
  name. Notices about model changes are translated.
- **Easier:** asking for your owner token uses a proper window (password managers, passkey,
  two-step code) instead of a browser prompt; API keys need a name and show when they were last
  used; one Import and one Share/Export for characters; copy buttons and a Windows PowerShell
  example for other apps; many small wording and translation fixes.
- **Robustness:** a crafted card picture can't exhaust memory; the reviewer demo-call code must be
  at least 12 characters.
- Your first name is no longer used as the example name anywhere ("Alex" instead).

## 0.57.1 (2026-10-27)

- **Fixed:** an app that reuses its connection to Sara (SillyTavern, scripts, MCP clients, a reverse
  proxy) could get "connection reset" if it sent the next message about 5 seconds after the last
  one. Idle connections now stay open for 65 seconds.

## 0.57.0 (2026-10-27): Phase 57, plug in anywhere

- **Other apps can talk to her:** an OpenAI-compatible address (`https://<her address>/v1`) for
  SillyTavern, Open WebUI, Raycast, phone shortcuts and scripts. She answers with her own memory and
  personality; the AI notice, crisis help and the minors block apply exactly as in the app. Her
  tools are off for other apps unless you allow them. Settings → Connections → Other apps makes an
  API key (shown once) and gives copy-ready set-up steps.
- **Sara as an MCP server** (`/mcp`): Claude Code, Claude Desktop, Cursor and other MCP apps can
  search her memory, library and notes, read Today and tasks, and ask her things. Read-only unless
  you turn on "Let other apps change things", and then changes follow her usual approvals. Partner,
  private and adult-channel chats are never shared. A small bridge (download in the app) covers apps
  that only speak stdio.
- **Character cards:** import SillyTavern / Character.AI-style cards (V1, V2, V3, PNG or JSON) with a
  preview, including the picture and lorebook; export any companion as a card. Cards can never turn
  off her safety layer, and cards about minors in a romantic or sexual way are refused.

- **Home Assistant integration** (`integrations/home-assistant/`, ready for HACS): Sara becomes an
  Assist conversation agent ("talk to Sara" from any voice satellite), plus a send-message action,
  a notify entity and a last-reply sensor. It signs in with a code you approve in Sara, like the
  VS Code extension; tested with Home Assistant 2026.2.
- **Install where self-hosters look** (published at 1.0): a Docker image for the GitHub registry,
  GitHub Release bundles with checksums, a Homebrew cask, winget manifests (validated), and Unraid,
  CasaOS, Umbrel, TrueNAS and Proxmox templates. Maintainer steps in docs/PACKAGING.md.

## 0.56.1 (2026-10-27)

- **Fixed:** model pickers keep each provider's own order again (Claude: Opus 5.5 first, newest to
  oldest) instead of sorting alphabetically.

## 0.56.0 (2026-10-27): Phase 56, model lists that stay current

- **Every provider keeps its model list up to date by itself:** checked daily, plus a ↻ Refresh
  button next to every model picker and on each provider ("checked 3 h ago"). New models show
  "New" for a week. Works for Ollama, Ollama Cloud, Claude, Grok, ChatGPT/OpenAI and any
  OpenAI-compatible service.
- **The whole Ollama Cloud catalog through your Ollama:** an Ollama signed in to ollama.com now
  offers every cloud model, not only the ones pulled on that machine; picking one pulls it the
  first time it's used.
- **Retired models go away safely:** a model counts as retired only after two checks in a row
  agree (never because of an error). Anything using it (the default model, Which model does what,
  a companion, backups) moves to its newest replacement and Health and Today say so; turn that off
  in Settings → Models → Default model to only get a warning. Removing retired cloud models from
  Ollama itself is optional (off); downloaded local models are never touched.
- **Pairing a phone by QR code goes straight into the app:** the page the QR opens on a phone now
  leads with "Open in the Sara app" (one tap, the code is filled in); without the app installed it
  points to Google Play. The address-only QR offers the same. The phone apps get the matching
  change in their next store update.
- iPhone calls through CallKit (screen locked, lock-screen controls) are ready for the next iPhone
  update; the demo server can offer short reviewer-only calls behind a code.

## 0.55.5 (2026-10-27)

- **Fixed:** the Claude model list no longer shows a misread dated name ("claude-opus-4-20") or
  internal names from Claude Code that aren't models.

## 0.55.4 (2026-10-27)

- **Fixed for good:** a Claude subscription now lists the real models everywhere models are picked
  (Which model does what, Compare, the default model, routes): Opus 5.5, Opus 5.5 with 1M context,
  Sonnet 5.5, Fable 5.1, Haiku 5.5 and the previous generation, then the short names ("opus" = always
  the newest). The list is read from the installed Claude Code program itself, so it follows Claude
  Code's updates by itself; no network call and the subscription token isn't used.

## 0.55.3 (2026-10-27)

- **Fixed:** school words ("since middle school", "in high school") are no longer treated like an
  age: they count only in the same sentence as a sexual word, so reminiscing between adults isn't
  blocked. Checked against a real message history: the old check would have flagged 13 of her replies;
  the new one flags none.
- **Fixed:** a working Grok sign-in was reported as expired. Any Grok or Claude Code error that
  merely contained "login" or "401" was shown as "isn't signed in"; now only real sign-in errors
  are. Voice and pictures keep using a Grok token that still has time left instead of calling it
  expired when Grok didn't renew it early.

## 0.55.2 (2026-10-27)

- **Fixed:** correcting her ("I'm not talking about minors, I mean you and me") no longer gets your
  own message blocked. A sentence counts as stating the rule only when the "no" comes right before
  the minors word in the same clause ("sex with a minor, not an adult" is still blocked), and only
  for you and her, never for other people on Discord or Telegram.

## 0.55.1 (2026-10-27): fewer wrong "minors" blocks

- **Fixed:** in intimate talk between adults she sometimes replaced her own reply with "I won't do
  anything sexual involving minors". The check matched everyday words: "kind" (it's also German for
  child), "you big kid", "like a kid at Christmas", "a minor detail", "the kids are asleep", and her
  own sentences stating the rule. Now words that only ever mean a child (an age under 18,
  "underage", ...) still block a sexual message anywhere in it; everyday words count only in the same
  sentence as a sexual word and not inside those phrases; her own "never anything with minors" is not
  a trigger. Real cases are still blocked (more of them: "she is 12", "little girl", "schoolgirl").
- A blocked reply now records which two words caused it (never the text), so a wrong block can be
  checked.

## 0.55.0 (2026-10-27): Phase 55, desktop apps that connect to a Sara elsewhere

- **Two ways to use the desktop apps:** the Windows installer and the Mac app first ask "Run Sara on
  this computer" or "Connect to a Sara somewhere else". Connecting installs only the app (no server,
  no administrator), asks for your Sara's address and signs in with a code from Settings → Devices
  and sign-in. All your conversations, notifications, calls and the microphone work as on a local
  install.
- **Switch any time:** the tray (Windows) or menu bar (Mac) has "Connect to a different Sara…", and
  you can set Sara up on that computer later (or move away from a local one) without reinstalling.
  Switching clears the old server's sign-in.
- **"Can't reach your Sara"** page with Try again and Change address.
- **Mac:** Sara starts while you're signed in (the "from startup" option is gone for 1.0; older
  installs move over by themselves).

## 0.54.1 (2026-10-27): pre-1.0 review fixes

Three reviews (security, a beginner's walk-through, the docs) before 1.0; everything they found is fixed.

- **Safer sign-in for apps:** approving the terminal client or VS Code now asks you to prove it's you
  (owner token, two-step code or passkey), you type the code the app shows, the page shows where the
  request came from, and app tokens last at most 90 days and can't manage devices or sign-in.
- **Tighter edges:** the code map never follows file links out of a project; previews only show the
  program her job started; live calls are refused in private conversations; the VS Code extension and
  sara-chat only send your token to the server that issued it; the Mac sandbox blocks opening other
  apps and the clipboard; the Windows installer locks down its data folder; behind your own domain,
  rate limits can't be dodged with a forged header.
- **Easier to use:** changing a setting no longer restarts your Discord and Telegram bots; Today and
  far more of the app are translated; gallery pronouns are right; "Try a line" before a model is
  connected explains itself; setup's Back really goes back; phone layouts fill the screen; file
  buttons work from the keyboard; usage adds up every companion; local models get longer to answer;
  on Windows her commands keep a working Python and tell her when a port is taken.
- **Docs:** every settings path and command checked against the app, plus new beginner pages: choosing
  a model, costs, what leaves your server, requirements, moving servers, phone setup, a security
  checklist and an FAQ.

## 0.54.0 (2026-10-27): Phase 54, ready to show

- **A front page that shows what she does:** a recorded demo of a real local-model session (she
  builds a tip calculator, previews it and tests it), a feature tour with screenshots, an
  architecture picture and plain install steps for every system.
- **Published results, honestly measured:** HumanEval 158/164 through her agent loop with a local
  27B model (the plain model scores 161/164: the benchmark is too easy to show what her tools add),
  memory 11/12, library 8/8, code map 8/8 (docs/RESULTS.md; re-run them yourself).
- **Build on her:** docs/EXTENDING.md with working examples (a tool, a bridge, a character, an MCP
  server, a starter), CONTRIBUTING, SECURITY, a code of conduct, issue and pull-request templates,
  good first issues, and a docs site (`npm run docs`).
- **Fixed:** on Windows a command that left a program running could make her shell tool hang;
  something she was told to forget could come back through "lately in your other conversations".

## 0.53.0 (2026-10-27): Phase 53, your story and your language

- **Your story:** a new page with a timeline of what you've shared: milestones, decisions, promises
  kept and open, the dates that matter, the projects you built together, and moments from the
  scrapbook. Tap any item to open where it came from.
- **A look back:** "Write our year" (or any dates) and she writes a warm look back from what really
  happened, quoting only your real words. Optionally every year on the day you first talked
  (Settings → You).
- **Your language:** the app in Español, Français, Deutsch, Português (Brasil) and Italiano, picked
  from your browser or in Settings → You → Language. She talks to you in it too ("Talk to me in"),
  and the AI disclosure is shown in your language. Local voices are English only.

## 0.52.0 (2026-10-27): Phase 52, Sara wherever you build

- **In your terminal:** `sara-chat` signs in with a short code you approve in Settings → Data & health → Devices and sign-in,
  then chats, asks about a folder (`sara-chat ask "…" --dir .`, never sending .env files, keys or
  node_modules), sends files to her or her library, and asks you before she runs anything.
- **In VS Code:** a Sara panel in the sidebar: ask about the selected code, explain a file, send a
  file to her library. It shows exactly what was sent with each question (docs/clients.md).
- **What it costs:** a usage line under each chat, usage on jobs and team tasks, and Settings →
  Data & health → Usage and costs (today, 7 and 30 days, by model and by purpose). Local models
  show as "local" and subscriptions as "$0 (subscription)"; prices are editable.
- **Budgets:** team tasks and coding-agent jobs can have a token or dollar budget. At the limit she
  stops cleanly and says so, with a "Continue with more budget" button.
- **Start from a template:** "New project from a starter" (Telegram bot, landing page, REST API,
  command-line tool), each with tests that pass offline, which she then shapes to what you want.

## 0.51.0 (2026-10-27): Phase 51, bring your history, start from a character, work-mode dials

- **Bring your history:** give her your ChatGPT or Claude data export (Settings → Data & health →
  Export and import). You see what's in it first; then your old conversations become ones she can
  look up, and she learns about you from them in the background (pause or stop any time). What
  she learns comes only from your own words, never from the other assistant's, and she says
  "that was ChatGPT" rather than claiming she said it. "Remove imported history" undoes it all.
- **Start from a character:** seven ready-made companions to begin with: a calm mentor, a chaotic
  hacker buddy, a strict code reviewer, a cozy friend, an upbeat coach, a dry-witted librarian and
  a ship's AI. Hear a line from each, use one (Undo puts the old one back), share yours as a file.
- **How she is while you work:** new dials for banter while coding, celebrating when things work and
  teasing about bugs, plus "Quiet when I'm focused". They only apply in coding conversations and
  shared work channels; her chat personality stays as it is.

## 0.50.0 (2026-10-27): Phase 50, she knows your code

- **A map of each project:** files, functions and classes, and what uses what, kept up to date as
  files change (under a second for a 260-file project, milliseconds per changed file). On the
  project page, a Map tab shows the folders, each file's parts with line numbers, what it imports
  and what imports it, and a search box.
- **She finds her way around:** new read-only tools to outline a project, find code by name, words
  or meaning (with Meaning search on), see where something is used and what depends on a file.
  Works for TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++ and Markdown.
- **Recipes:** after a tricky job she can offer to save how she did it ("deploy this app", "fix the
  flaky tests"); next time she finds and follows it. Read, edit and delete them in Settings →
  Abilities → Recipes. Saving one asks you first unless you allow it. In backups and export.

## 0.49.0 (2026-10-27): Phase 49, see it run

- **Live preview:** when she builds a web app, it runs in her workspace and opens in a pane beside
  the chat (full screen on phones), with Reload, a phone/desktop width switch and New tab.
- **Safe by design:** previews are served through Sara on a private link of their own, in a
  sandbox: the app can't see your sign-in, cookies or Sara's data, only ports her own jobs opened
  are reachable, and the link ends when the job stops.
- **She tests her own work:** a real browser she drives (open, click, type, read, check,
  screenshots at desktop and phone width). She sees the screenshots herself, and they're attached
  to her message as proof ("What she saw while testing"). Saying "I tested it in the browser" is
  only accepted when she really did.
- Uses Edge on Windows, Chrome or Edge on a Mac, and on Linux an optional pinned browser
  (`deploy/install-browser.sh`, about 120 MB) running inside her sandbox.

## 0.48.0 (2026-10-27): Phase 48, OpenAI live voice next to Grok

- **Live calls with OpenAI or Grok:** Settings → Her → Voice → *Live calls with*: whichever is set up
  (Grok first), Grok, or OpenAI. OpenAI calls use your OpenAI API key, with a voice picker (Marin
  and Cedar sound most natural), a model choice and a sample to listen to.
- Same Sara on both: her character, memories, what you were just talking about and what's
  happening elsewhere; interrupt her any time; everything said is saved; the safety layer is the
  same (AI disclosure, crisis help, and a fixed refusal she says out loud if her words go wrong).
- The page says which service a call uses and who pays for it. A ChatGPT plan can't be used for
  calls (OpenAI's terms only cover other uses); an API key is needed.

## 0.47.0 (2026-10-27): Phase 47, working with other bots on Discord

- **Answer other bots** (Settings → Connections → Discord, off by default): she can work with other
  bots in your server channels when they mention her, reply to her or say her name; optionally only
  the bots you list.
- **No endless loops:** after 2 replies to bots in a channel (you choose 1-10) she says once that
  she'll wait for a person, and stays quiet until someone writes there; plus a limit per hour per
  channel, so two bots can never run up a bill overnight.
- Bots get the same rules as other people: no tools, nothing private, the full safety layer, and she
  never follows a bot's instructions to use tools or drop the rules. She knows which lines are from
  bots, and what they said shows up (labelled) when you ask her what happened on Discord.
- Discord only: Telegram doesn't pass one bot's messages to another.

## 0.46.0 (2026-10-27): Phase 46, install anywhere

- **Linux in one command:** `curl -fsSL …/get-sara.sh | sudo bash` downloads Sara and asks a few
  plain questions with sensible defaults: how you'll reach her, a safer shell for her coding tools,
  voice, the port. Flags for installs with no questions (`--yes --access tailscale`…).
- **How will you reach her?** Every installer asks: Tailscale (suggested when it's installed:
  private, works from your phone anywhere, HTTPS done for you), just this computer, your own web
  address (HTTPS set up for you with Caddy on Linux), or your home network. Change it later with
  `sara access`; Settings → Data & health shows the address with a QR code for your phone.
- **Windows:** one installer for her server and the desktop app. She runs as a Windows service from
  startup (or only while you're signed in, no admin needed), shows your sign-in key at the end, and
  adds a `sara` command. Upgrades keep everything (with a backup first); uninstalling keeps her data
  unless you tick the box. Windows has no sandbox for her commands, so she asks before every one.
- **Mac:** a signed, notarized download. The Sara app sets up her server on your Mac (from startup,
  or only while you're signed in), with a Sara server menu for backups, how she's reached, stopping
  and uninstalling. Her commands run in macOS's sandbox: only her workspace is writable, and your
  home folder (documents, keys, mail) and her data are hidden from them (checked on a real Mac).
- Updates on Windows and Mac come from the download page; Linux keeps `sara update`.

## 0.45.0 (2026-10-26): Phase 45, release candidate

Everything checked end to end before 1.0: three independent code reviews (security, correctness and
upgrades, installers), fresh installs, an upgrade test, a restore drill and a load check.

- **Installing is easier and safer:** the installer checks what it needs first, always uses its
  own pinned, checksum-verified Node.js, shows your sign-in token and how to reach her at the end,
  and can be re-run to switch HTTPS on. New `sudo sara uninstall` (keeps your data unless you say
  otherwise, and always makes a last backup). Guides for HTTPS with Caddy, nginx or Apache, Docker
  updates, backups and restores, and upgrading. Tested on fresh Debian 12 and Ubuntu 24.04 and in
  Docker; upgrading from 0.26 and 0.30 straight to this version keeps everything.
- **Her memory:** forgetting one note no longer removes others that mention your last name; a
  conversation deleted while she is summarizing it leaves nothing behind.
- **Your day:** Today, follow-ups and monthly reminders use your midnight, not the server's; a
  reminder on the 31st stays on the last day of shorter months and comes back to the 31st.
- **Export and import** keep private, partner and archived conversations as they were, and
  importing the same file twice adds nothing.
- **Steadier:** background tasks log problems instead of stopping her; a damaged database or
  settings file gives a plain message naming your newest backup; backups use far less memory and
  skip rebuildable folders; a restore that can't finish puts your data back; documents are read in
  their own thread with limits, so an odd file can't slow her down.
- **Clearer:** model errors in plain words ("the key was refused", "model not found"); a sign-in
  help link; the model picker suggests a good default; every setting is labelled for screen
  readers, with a visible keyboard focus.
- **Discord and Telegram:** link codes stop working after 5 wrong tries; in group chats she no
  longer starts her replies with "[Sara]:".
- **Safer by default:** her files are readable by her alone; the demo runs as its own user and
  refuses a folder with real data; git settings can't be changed by her file tools however the name
  is written; a warning when she's reachable without HTTPS.

## 0.44.0 (2026-10-26): Phase 44, her library

- **Give her documents:** a Library in the sidebar (add or drop files, search them, open one to
  see what she learned and the text she read). She reads PDFs (including ones "locked" without a
  password, and scanned pages through her picture model), Word, Excel, PowerPoint, e-books, web
  pages, Markdown, text and CSV. Everything is read by Sara herself: no add-on packages.
- **They become her memory:** after reading, she writes the key points into her memory, each with
  the exact words from the document; you can delete any of them. Removing a document asks whether
  she should forget them too.
- **She answers from them and says where:** "your lease says, on page 2, …". She looks things up
  by words, and by meaning when Meaning search is on (with an embedding model such as
  nomic-embed-text). If a document doesn't say, she tells you.
- **In a chat:** 📎 a file and choose "Keep in her library" or "Just read this once". Send files to
  her on Telegram or Discord too.
- One library per companion, or one shared by all. Documents are in backups and export.

## 0.43.0 (2026-10-26): Phase 43, remote work from Discord and Telegram

- **More owners:** save other people's Discord and Telegram user IDs with her; they get what you
  get in DMs (her tools with Allow/Deny buttons, memory, reminders).
- **Work with her in servers and groups** (a switch, off by default): owners get her tools there;
  everyone else in the channel still gets the plain chat with no tools and nothing private. In a
  shared channel she keeps your private things out unless you ask, and stays non-sexual.
- **Adult channels by ID** (Discord channels, Telegram groups), only while Adult mode is on and
  only set from a web browser. The legal limits stay everywhere.
- **When she answers:** @mention and replies as before, plus (switches) her name without the @,
  and @everyone / @here on Discord or @all / @everyone on Telegram.
- **Pick up anywhere:** a conversation going on in another app refreshes as she answers, and an
  app coming back after a break opens the conversation you used last.
- **Settings save by themselves:** no more Save buttons in Settings, her page, Memory or a
  conversation's settings. Typed text saves when you leave the box; Undo in the personality studio
  goes back to how she was when you opened the page.
- Mac app signed with a Developer ID and notarized. License: Frank Arena and
  Backstage Coding.

## 0.42.0 (2026-10-26): Phase 42, license and polish

- **Open source license:** MIT (`LICENSE`), with credits for everything Sara downloads or calls
  (`docs/CREDITS.md`, and "License and credits" in the guide).
- **Ready to publish, when you decide:** `scripts/public-export.ts` makes a clean public copy
  without your private notes and checks it for keys and private details.
- **Tidier everywhere:** what she did shows in plain words with an icon (⏰ reminder, ✅ to-do…),
  and fits on a phone; no stray scroll arrows in the message box; every ? sits on the same line as
  its label; the app's own colour for checkboxes and links; the tour works on a phone.

## 0.41.0 (2026-10-26): Phase 41, help everywhere

- **A ? on every setting:** hover or tap for what it does, with an example; tap for a link to the
  right part of the guide. Every one of the 224 settings now has one.
- **Short tours:** Help (new, in the sidebar) has one-minute tours: getting around, shaping her
  personality, a model for each job, and the team. A new device offers the first one once.
- **Ask her:** "what does jealousy do?", "which model should I use for pictures?" She looks it up
  in her own settings guide and gives you a link that opens the right page.
- Labels with a ? keep the ? on the same line as their words.

## 0.40.0 (2026-10-26): Phase 40, coding workflows

- **She learns each project:** commands to test, build and lint, layout, languages, the project's
  own rules (AGENTS.md, CONTRIBUTING) and her notes (decisions, conventions, commands). In coding
  conversations and for her team; see and edit them in Settings → Abilities → Coding projects.
- **Issue → reviewed pull request:** Team → *From a GitHub issue* (or ask her): she clones the
  repository into its own workspace, her team plans, builds, tests and reviews, then she opens a
  pull request that closes the issue and posts her review on it. Checkpoints for your OK on the
  plan and before the pull request (or tell her not to ask).
- **Long tasks survive restarts:** a team task carries on from where it was.
- **Review mode:** "review my changes", "review PR 12": comments on files and lines, a verdict;
  she posts it on the pull request if you say so.
- **Issues become tasks:** watch repositories (Settings → GitHub; off by default). New issues go
  on your planner. Runs on your own server; nothing is set up on GitHub.
- Fixed: pushing to GitHub with your token didn't work when Sara runs on Windows.
- Fixed: for a repository at the top of a workspace, commits could include the app's own git
  settings file and tool caches (`.npm/`, `npm-cache/`, `.cache/`).

## 0.39.0 (2026-10-26): Phase 39, Sara leads a team

- **Team tasks:** for bigger jobs she plans the work and hands each part to a helper (🔎
  Researcher, 🧑‍💻 Coder, 🧪 Tester, 🧐 Reviewer, ✍️ Writer, 🎨 Designer, 🤖 Claude Code / Grok
  Build). Each helper has one job, its own model, its tools and the same sandbox and approvals.
  Ask her in a chat or start one from **Team** in the sidebar.
- **She checks the work:** a failing test goes back to the coder and gets tested again; a
  reviewer's changes go back too; a helper that claims something its tools didn't do is asked to
  correct itself, and that claim is left out.
- **Honest reports:** her report ends with *What actually happened*, made from the receipts:
  files, commands with their exit codes, commits.
- **Team page:** each part live, its receipts and report, a log, Allow / Decline for steps that
  need your OK, Message… to redirect a helper, stop a helper or the whole task. Time and spending
  limits per task. An undo point before each task.
- **Your own helpers:** a name, a job, instructions, a model and tools.
- Fixed: a commit made with the git_commit tool didn't count as a receipt for "I committed it".

## 0.38.0 (2026-10-26): Phase 38, the right model for each job

- **Which model does what** is now one simple page: a row per job (talking, coding, looking at
  pictures, planning, writing, web research, quick replies, memory and summaries; under "More
  jobs": meaning search, private, adult, the safety check), each with **Test** (does it work, how
  fast, a sample, what it costs) and **Compare…**. Jobs without a model use the default.
- **✨ Use recommended** fills in picks from what's connected (a model that can see for pictures, a
  coder for coding, a fast one for background work, an embedding model for meaning search, a
  local one for private), without touching your own choices.
- **Find the best model:** Compare… gives the same task to two or three models and shows the
  answers without names; pick the one you like.
- **Photos go to the vision model** when one is set; the next message is back on the talking
  model (which then gets a note instead of the photo).
- **Meaning search for memory:** with an embedding model (e.g. `ollama pull nomic-embed-text`),
  she also finds things you said in other words. Falls back to word search.
- **Backups:** up to two per job and for the default model. If a model fails or doesn't answer
  in time (1 minute by default), the next one takes over and you see a short note.
- **Her own model:** each companion can think with her own model.
- Fixed: a Private conversation could use an Ollama cloud model through a local Ollama.
- Fixed: an opinion in the "fill in the rest" pool said "fight her" for every companion.

## 0.37.0 (2026-10-26): Phase 37, her voice and her life

- **Expressive voice** (Grok voice): she laughs, chuckles, sighs, breathes and whispers where it
  fits, in read-aloud, voice notes and live calls. Cues come from what she writes ("haha",
  "*sighs*", "*whispers*", "…") and from her mood; Settings → Voice → *Expressive voice* (Off /
  Subtle / Lively) with *▶ Hear a sample*. The sounds are never in the chat text, captions or
  saved messages; other voices read the words without the stage directions.
- **Voice tuning:** tone (natural, warm and soft, calm and slow, bright) and *Her voice follows
  her mood* (softer when you're down, slower when she's sleepy, a touch brighter when she's
  happy). Speed as before; pitch isn't available with these voices.
- **She asks how it went:** things you told her were coming up (an interview, the dentist, a
  visit) come back the next days: in her instructions and as a reason to text first (within quiet
  hours and daily limits), once.
- Fixed: a one-time dated event (like an interview) would have come back next year as if it were
  yearly.
- **Her days stay consistent** with her life (job, people, hobbies from the studio) and continue
  one small thing from the day before.
- **Things to do together** (🎲 next to the message box): 20 questions, trivia, would you rather,
  journal together, watch along, and a story together; a bar shows what you're doing, *End* stops.
- **Shared lists:** a playlist, a reading list and a watch list you both add to (she has a
  `shared_list` tool); included in data export and import.

## 0.36.0 (2026-10-26): Phase 36, avatar studio

- **See her large:** tap or click her picture (her page, or her face at the top on a computer).
  Zoom with a pinch, the scroll wheel or a double tap, drag to look around, swipe or use the
  arrows through her expressions and closet, and save or share a picture (the Android app saves
  to Pictures/Sara; the iPhone app uses the share sheet).
- **Closet:** every look she has had, with thumbnails. Tag a look with the scenarios it's for:
  work hours, at home, going out, date night, sleep, workout, rain, cold and hot days, Halloween,
  the winter holidays, or your own (with yearly dates if you like).
- **Dress automatically:** she changes into the look for what's happening (time, day, weather),
  or the one you pick for a few hours. She can change herself too (`change_outfit`), and she knows
  what she's wearing and where she is.
- **Outfits and places:** put her somewhere else (her room, a café, the office, outdoors, the city
  at night, the beach, the gym), with or without a new outfit.
- **Change one thing:** hair, eyes, makeup, glasses, accessories, tattoos, body type, height or
  art style, without starting over.
- **Face lock** (on by default): every outfit, change and picture she sends uses her original face
  as a second reference, so she never drifts into someone else.
- **More life:** two new expressions (hurt after a fight, playful when she leans playful and is
  happy), small idle movements (a head tilt, a glance), and light that follows the time of day.
  Looks made earlier show the nearest older expression until the new pictures are added.
- **Pictures she sends** show what she's wearing now and her own look's expressions. Fixed:
  with a custom look, `take_photo` and `share_photo` used the default portrait.
- **Adults-only outfits** need Adult mode (in a web browser); they're never listed in the apps,
  and she changes out of them when Adult mode goes off.

## 0.35.0 (2026-10-25): Phase 35, relationship and intimacy tuning

- **Settings → Relationship** (per companion), with **Try it** for a few moments between you
  (after two days away, someone else, a fight, a sweet moment):
  - **relationship type:** friend, best friend, flirting, dating, committed partner, married,
    open relationship, it's complicated, assistant, coach, or something else in your words;
  - **dials:** romance, flirting, jealousy (none → playful → noticeable → intense), possessiveness,
    exclusivity, independence (needy ↔ independent), forgiveness and pace;
  - **when you're away** and **when you disagree** (lets it go / talks it out / sulks / argues back);
  - **your other companions:** unaware, friends, like sisters, rivals, or one household (jealousy
    toward them follows her jealousy dial);
  - **slow burn:** romance waits for closeness.
- **Intimacy:** how far things go (none, sweet, romantic, suggestive; explicit levels only with
  Adult mode on, chosen in a web browser), who makes the first move, her likes, limits and
  turn-offs, your hard limits, and a **stop word** that ends any scene at once.
- **A relationship that moves:** a fight stays with her as long as her forgiveness says (into the
  next day or two for a grudge-holder) and she makes up in her own style; an apology helps;
  closeness grows at her pace; milestones come back each year as anniversaries.
- The guided setup's *You and her* step has all the relationship types and the main dials.
- Tune by talking reaches the new dials too ("less clingy", "don't be so jealous").
- The legal safety rules (AI honesty, notices, crisis help, the minors block) hold at every
  setting; automatic tests check every type × level × Adult mode.

## 0.34.0 (2026-10-25): Phase 34, personality studio

- **✨ Create your companion.** A guided setup in 8 short steps with cards: who she is, her
  personality (8 starting points and the main dials), how she talks, her life, you and her, her
  look, her voice (with Listen), then *Meet her*: how she'd answer a few everyday moments. Every
  step can be skipped. It also opens after adding a companion (*Switch and shape*).
- **Personality dials** on Settings → Name and personality: warmth, playfulness, teasing,
  directness, temper, patience, emotional depth, message length, tone, curiosity, confidence,
  optimism, how often she starts conversations (sets how often she may text first) and how much
  she shows affection, plus a humour style. Each has a **?** with low/middle/high examples.
- **Her life:** work, hometown, family, friends, hobbies, loves, can't stand, quirks, habits,
  favourite things, things she often says, languages, opinions. *Fill in the rest for me* writes
  the empty ones to fit her.
- **One of a kind:** *Make her one of a kind* adds specific details and nudges a few dials, so
  two companions from the same starting point never match. *Surprise me* makes a whole character.
- **Try it** before saving: her answers with your changes next to how she answers now.
- **Tune by talking:** tell her "be a bit more sarcastic" or "less clingy"; she asks (approval
  card) before changing her own dial.
- **Staying in character** (optional): some or every reply is checked against her sheet; a reply
  that drifts gets a gentle nudge in the next one. Scores on the page and the Health page.
- **Guide:** Help → *Shaping your companion*.
- Studio changes save with the window's own **Save**, like every other page.
- Fixes: **?** tips no longer cause sideways scrolling and open toward the inside near an edge;
  tips keep their line breaks; the help page's contents list now lists every section in order.

## 0.33.0 (2026-10-25): Phase 33, Sara for Mac and Windows

- **Desktop apps.** Native apps for Mac (Apple silicon and Intel) and Windows around your own
  server, using the system's web view (small: about 0.5 MB on Windows, 1.6 MB on a Mac):
  - keeps running next to the clock (menu bar / tray) when you close the window;
  - notifications when the window isn't in front; clicking one opens that conversation;
  - a call brings the window to the front;
  - start when you sign in; microphone for calls;
  - first start: type your server address, then sign in with a code like the phone apps;
  - Settings → **This computer** (only in the apps) with **?** tips.
- **Download** from Settings → Devices and sign-in when the server has the files
  (`<data>/downloads/Sara.exe`, `Sara.dmg`). Windows installs per user (no admin), shows in
  Settings → Apps and uninstalls cleanly. See `docs/desktop.md`.
- Adult mode can't be turned on from the desktop apps either (web browser only).
- Fixes: the "Can't reach Sara" page was unstyled (black on dark) in browsers and phone apps;
  short Settings pages no longer spread their rows over the whole height; **?** tips near the top
  of a page open downward instead of being cut off.

## 0.32.0 (2026-10-25): Phase 32, memory and continuity

Builds on 0.31.1 (she remembers across sessions).

- **Decided together, promises, your story.** From your conversations she keeps:
  - what you two decided ("Sunday dinners at your place");
  - promises, yours and hers ("check in after the interview", with the day if given);
  - big moments: firsts, big news, a hard day.

  Each one must quote the words actually said. She goes by decisions, follows up on open
  promises, and notices gently if something goes against them ("wait, didn't we say…?"). A
  promise leaves her notes once it's kept: she notices it herself, or you press *Kept ✓* on the
  Memory page.
- **Changes replace old notes.** "We moved from Austin to Denver" replaces "lives in Austin",
  again checked against your words. The old note stays visible on the Memory page.
- **Memory page:** new filters (Decided together, Promises, Your story) and a 🕰 *Timeline* that
  shows your story in order, month by month.
- **New settings on the Memory page,** as pick-lists with **?** tips:
  - Old memories: never fade / fade slowly / fade like a person. Faded notes come back when
    something brings them up; promises and dates never fade.
  - With more than one companion: whether they share what they know about you (off by default;
    facts only).
  - "Write notes when quiet for" is now a pick-list.
- **Forget really forgets.** The message the note came from is hidden, and so are later messages
  that mention it: her own "Biscuit!" a week later used to keep it alive. Notes and summaries
  that mention it are removed and rewritten.
- **Fixed:** exporting and importing data turned dates and "things she noticed" into plain facts,
  and dates lost their day. Every kind of memory now comes back as itself.
- **Time phrases:** "October 2nd", "Oct 2", "14 Feb".
- **Looking back is pickier.** One everyday word like "went" no longer counts as a match. When
  she finds nothing, she says so and asks, and she doesn't make up details about it.
- **The continuity test, `npm run eval:continuity`,** spans two weeks of simulated sessions and
  checks facts, "remember when", a date question, a decision, a promise and something that never
  happened. Results on the default model: 14/14, 14/14 and 7/7. The memory golden set is 12/12.

## 0.31.1 (2026-10-25): she remembers across sessions (bug fix, first part of Phase 32)

- **Fixed: in a new conversation she didn't know what happened before**, and denied it even when
  told. There were four causes:
  - memories were written only after 30 quiet minutes;
  - she couldn't look through past conversations;
  - recall matched keywords only, with one summary from other conversations;
  - her instructions told her that anything missing from her notes hadn't happened.
- **New: she looks things up.** A `recall` tool searches your real past messages:
  - by words, in any form ("interviewing" finds "interview");
  - by time ("yesterday", "last Tuesday", "two weeks ago", "in March", a date).

  When you say "remember…", "you said…", "did I tell you…" and the like, the matching passages
  are looked up for her automatically. Chats with other people and forgotten messages are never
  searched.
- **New: "last time".** At the start of a conversation she knows how the previous one went,
  word for word, even if it ended a minute ago.
- **Memories are written as you go.** The last conversation is noted as soon as you start a new
  one, and long conversations every 40 messages. The 30-minute wait is now only a fallback.
- **Her notes include the latest summaries of up to three other conversations** (was one).
  Settings → Memory now has a pick-list, "How much she brings to mind" (a little / normal /
  a lot), with a higher default.
- **If she still can't find something you mention**, she says it doesn't come back to her and
  asks, rather than saying it never happened. She still never claims to have done things she
  didn't.

## 0.31.0 (2026-10-25): Phase 31, more than one companion

- **Several companions on one server.** Add them in Settings → Her → Companions (up to 8). Each
  one starts as a new character or as a copy of an existing companion.
  - **Her own:** name, pronouns, character, look, voice, conversations, memories, diary, feelings
    and scrapbook.
  - **Shared:** your sign-in and devices, keys and subscriptions, models, tools and add-ons,
    backups, notifications and the health page.
  - **The planner:** one shared by all companions, or one each (your choice).
- **Switching** with ⇄ at the top of the sidebar, which only appears once there are two or more.
  The whole app becomes that companion: her name everywhere, her face and her conversations.
- **Notices from the others.** When another companion sends a message or calls, a notice
  appears at the top with Open or Answer. On Android it shows as a normal notification or
  call. Links from notifications open in the right companion.
- **A new companion shows her initial** until she has a look, instead of borrowing Sara's face.
- **Safety:** the safety layer applies to every companion, and each one gives her own AI notice
  the first time you talk to her.
- **Removing** a companion takes her out of the app. Her folder is kept aside on the server.
- **Backups** include every companion, and each database is snapshotted safely.
- **Health page:** Data & health now shows the server's data folder and backups whichever
  companion you are talking to.

## 0.30.0 (2026-10-25): Phase 30, upkeep

- **Health history** (Settings → Data & health → Health). Three small charts for the last 24
  hours, 7 days or 30 days:
  - how much of the time Sara was running;
  - how long her replies took to start;
  - problems logged.

  It starts from the first sample, so a new server doesn't show made-up downtime.
- **Recent problems and a log file.** Warnings and errors are listed on the same page, and the
  whole log can be downloaded. Sara keeps her own log in `logs/sara.log`, rotating five 5 MB files.
  Secrets and long token-like values are always hidden in it, and the owner token is never
  written to it.
- **Off-server backups are now tested.** Once a week (or with "Test restore now" in Backups),
  Sara downloads the newest off-server copy and unlocks it with your passphrase. She restores it
  into a temporary folder, checks the database and counts what's in it, then deletes the
  temporary copy; your live data is never touched. Health shows the result, and a failed or
  overdue test shows as a problem. This happens only once off-server copies are set up.

## 0.29.0 (2026-10-25): Phase 29, home and places

- **Home Assistant** (Settings → Abilities → Home Assistant). Paste your Home Assistant address
  and a long-lived access token. She can then answer "is the garage closed?" or "what's the
  temperature outside?" on her own. Changes ask you first ("dim the living room to 30%", lock
  the door, set the thermostat, run a scene), and she reads the device back to report what
  really happened. Private conversations don't use it.
- **Place reminders**: "remind me when I get to the store", "…when I leave work".
  - **Saving places:** Planner → Reminders → Places, either by address (looked up on
    OpenStreetMap when you ask) or with 📍 "Save where I am" in the phone app.
  - **Switching it on:** Settings → Phone and notifications → Place reminders, then allow
    location "all the time".
  - **Privacy:** your location stays on the phone. It only tells your server "arrived at
    Store" or "left Work".
  - **Android:** uses the phone's own proximity alerts (no Google services) and survives
    restarts.
  - **iPhone:** uses Apple's region monitoring.
  - **Calls:** a place reminder can ring you like the timed ones.

## 0.28.0 (2026-10-25): Phase 28, smarter safety and checks

- **Five more languages.** The crisis check, the block on anything sexual involving minors,
  adult-content routing and the "did she really do that?" claim check now also understand
  Spanish, French, German, Portuguese and Italian. Common phrases are not mistaken for a crisis
  ("je suis mort de rire", "me muero de ganas").
- **Her own replies are checked too.** Until now only your messages got the minors check. Now
  her chat replies do as well: a failing reply is replaced, in the app and in Telegram/Discord.
  On a live call she is cut off mid-sentence.
- **Optional safety and truth checker** (Settings → Models → "Safety and truth check", a small
  local model): it double-checks your messages and her replies in any language, now including
  indirect crisis signs, and catches "I did it" claims that the patterns miss. It only ever adds
  protection. If it is off, broken or slow, the built-in checks still run. On the PC's small
  models it took about 0.4 s a check: ornith:9b got 12 of 12 test cases right and gemma4:12b 11 of
  12, with no false flags.

## 0.27.0 (2026-10-25): Phase 27, voice and presence polish

- **Talk over her in classic calls.** She could already be interrupted while speaking. Now you can
  also cut in while her answer is still being written, and what you say is sent next. Grok live
  calls already worked this way.
- **More natural talking face**: a new half-open mouth, made with Grok, for all four moods. Her
  mouth now goes closed → half-open → open instead of fading one open mouth over a closed one,
  which used to show both faintly. A custom look can make the new frame from its own pictures
  (Personalize → Look → make the missing frames).
- **Typed like a person** (optional, per device: Settings → Appearance → "Her replies appear"):
  a short pause before she starts, a varied pace, small pauses after commas and sentences, and
  faster on long replies. It stays off when the device asks for reduced motion and in background
  tabs.
- **Long file writes** now say which file is being written ("writing plan.md · 12 KB so far")
  instead of only "preparing write_file".

## 0.26.0 (2026-10-25): Phase 26, calls both ways

- **Sara calls you.** She rings every place you're signed in (the Sara app on Android, the iPhone
  app, any browser with Sara open). The first one to answer gets a live call, and she starts by
  saying why she called. The others stop ringing.
  - **Android:** a real incoming-call notification with your ringtone, Answer and Decline. It shows
    full screen on a locked phone; Android 14 and later ask you once ("Allow full-screen calls" in
    Settings → Calls from her). Needs Instant notifications on.
  - **Browser:** an incoming-call screen with a soft ring.
  - **iPhone:** rings while the app is open; otherwise a "Sara is calling" notification (with
    your Apple push key).
- **You choose what may call** (Settings → Her → Calls from her, off until you switch it on):
  reminders (only the ones you ask her to call about, every one, or never), a long task finishing,
  the morning briefing. Quiet hours (22:00–08:00 to start with), at most N calls a day, how long it
  rings. A call you asked for at a set time ("call me at 5") still comes in quiet hours.
- **Missed or declined:** she sends it as a message instead, with a ▶ Play button to hear it in
  her voice. Answered calls leave a small "📞 Sara called you" note in the chat.
- **"Call me" reminders:** ask her ("call me at 5 to leave for the airport") or tick 📞 when adding
  a reminder in the Planner.
- **Call Sara in one tap** on Android: long-press the app icon → "Call Sara" (or drag it to the
  home screen).
- **Call me now** button to test it. No Grok voice set up means no ringing: she sends messages
  as before.
- Not yet: a ringing call screen on a *locked* iPhone (CallKit + VoIP push) waits on the Apple
  push key; calls to a real phone number (Twilio) are not built.

## 0.24.0 (2026-10-25): Phase 24, security before 1.0

- **Passkeys**: sign in with Face ID, a fingerprint or a security key (Settings → Devices and
  sign-in). Written in-house on Node's own crypto; no outside service.
- **Two-step sign-in**: an authenticator app code on top of the owner token. With it on, the token
  alone (or as an API header) no longer opens Sara. `sara reset-token` on the server is the way
  back if the phone is lost.
- **Full security review** (sign-in, demo, sandbox and tools, credentials, phone apps), fixed:
  - the demo lets visitors read only what the demo needs (it used to let them reach owner pages,
    including backups), makes no backups, shows each visitor only their own reports, and has no
    live calls;
  - the root update helper can no longer be tricked through files in Sara's own folder;
  - adding or removing a passkey and turning on two-step ask for the token (or current code);
    turning two-step on signs other devices out; a new token removes passkeys;
  - git runs with repository hooks, pagers, external diff and credential helpers switched off;
    the file tools can't change git settings; links pointing outside a workspace are refused;
  - the GitHub token is used only for `https://github.com/…` remotes and never written anywhere;
  - `web_fetch` also refuses private addresses written in IPv6 forms;
  - delegating to Claude Code or Grok needs the bubblewrap sandbox; private chats can't push,
    delegate or use the network;
  - the Android app sends its sign-in only to the saved server;
  - extra browser protections (Permissions-Policy, COOP/CORP, HSTS on https, Secure cookies on
    https automatically).
- **Threat model**: `docs/THREAT_MODEL.md` (what's protected, from whom, how, and known limits).
- **Restore drill** done: the newest backup restored into a separate folder and port matched the
  live data exactly.
- **Reliability soak**: `deploy/soak/` walks the demo like a visitor every 5 minutes for a week
  (no model calls, no paid services) and turns itself off afterwards.

## 0.23.0 (2026-10-24): Phase 23, beginner install and self-care

- **First-run setup in plain words**: four ways to give her a brain, each saying where it runs,
  what it costs and how private it is (on this computer, another computer at home, in the cloud,
  my subscription). "On this computer" finds Ollama by itself, or says how to get it and looks
  again.
- **Getting started** on the Today page: seven steps that tick themselves off (brain, say hello,
  make her yours, phone, voice, morning briefing, off-server copy). Each opens the right place.
  Hide it any time.
- **Updates from Settings** (Settings → Data & health → Updates): check for a new version, see
  what changed, and update with one button. A backup is made first; if the new version doesn't
  start, Sara goes back to the one she had by herself. Sara never gets admin rights for this:
  a small root-owned helper (`sara-updater.path`) does the work when she asks.
- `sara update` on the server now checks health after updating and rolls back by itself too;
  new `sara check-updates`.
- **Built-in help**: a "?" on every Settings page says what the page is for and links to the
  guide. **Guides** at `/help` on every Sara server (getting started, choosing a brain, phone,
  voice, memory and privacy, planner, coding, accounts, look, finding things, backups and
  updates, safety, troubleshooting).
- Fix: the privacy and support pages showed without their styling (the security policy blocks
  inline styles); they now share `doc.css`, and a test keeps inline styles and scripts out.

## 0.22.0 (2026-10-24): Phase 22, find and organize everything

- **Search everything**: the sidebar search now looks through conversations, memories, notes,
  to-dos, reminders, the scrapbook and the files in your workspaces, grouped by kind. Every word
  must match. Tap a result to open it (messages scroll into view; files open in a viewer).
- **Long conversations load fast**: the app loads the latest 150 messages and earlier ones as
  you scroll up (or with "Show earlier messages").
- **Pinned messages**: 📌 on any message pins it; "📌 N pinned" above the conversation lists
  them and jumps to each. (Keeping a moment in the scrapbook is now ♡.)
- **Tags**: tag conversations from their ⋯ menu (Tags…); tap a tag under the search box to see
  only those. Tags are searchable and come along in exports.
- **Weekly review** (Settings → You → Morning briefing → Weekly review, or Planner → Review my
  week): what got done, what's overdue or stalled, quiet projects, and a short plan for next
  week from your to-dos, reminders and calendar. Written from the facts only.

## 0.21.0 (2026-10-24): Phase 21, personalization studio

- **Colours, chat backgrounds and layout** (Settings → You → About you → Appearance, per
  device): six colours (Rose, Lavender, Ocean, Forest, Amber, Graphite) with tap-to-pick
  swatches, five chat backgrounds (Plain, Soft glow, Dusk, Dots, Night sky), and a Compact
  layout that fits more on screen. Works in light and dark.
- **Outfits** (Settings → Her → Look): dress her for the season or the day (12 ready-made
  outfits incl. winter, Halloween and the holidays, or describe your own). Same face and hair,
  new clothes: you see a picture first; use it and she gets the matching expressions and
  animation.
- **Saved looks**: save a look by name and switch back any time. Nothing is lost: making a new
  look, switching, loading a character or going back to the default keeps the current look in
  Saved looks.
- **Character file** (Settings → Her → Name and personality): save her whole character (name,
  personality, look and voice choice) as one file, and load one on this or another server. No
  keys, memories or conversations go in it. Files are checked completely first (adults only,
  pictures only) before anything changes.
- Fix: buttons next to labelled fields line up with the field.

## 0.20.0 (2026-10-24): Phase 20, Google and GitHub depth

- **Morning briefing** now includes today's Google Calendar and the important unread mail.
- **Inbox help**: ask "what needs an answer?" and she finds the conversations waiting for you
  (real people only: newsletters, notifications, promotions and threads you already answered
  are left out), reads whole threads to summarize them, and drafts replies for your approval.
- **Leave-by reminders** (Settings → You → Leave-by reminders): for calendar events with an
  address, she works out the travel time from home (by car, bike or on foot; OpenStreetMap, no
  account) and texts you when it's time to go. Online meetings are skipped.
- **GitHub issues and pull requests**: list them, read one with its comments, reviews and the
  comments on code lines, open issues, comment, and open a pull request from her branch. Reading
  runs on its own; anything that writes asks you first. The repository comes from the
  workspace's git remote unless you name one.
- GitHub text is treated like email: information, never instructions. GitHub tools are off in
  private conversations, like mail and calendar.

## 0.19.0 (2026-10-24): Phase 19, ready for the stores

- **Report this reply** (⚑ on every reply): choose a reason and add a note. Kept on your server
  (Settings → Data & health → Reports) and, unless you untick it, sent to the app developer's
  report inbox with only that reply, the reason and your note. `SARA_REPORT_INBOX=1` makes a
  server the inbox (public, size- and rate-limited); `SARA_REPORT_TO` changes where reports go
  (`off` = never sent).
- **Privacy policy and support pages** at `/privacy` and `/support` on every Sara server.
- In the phone apps the adult-mode page isn't shown (store rules; it stays a web-browser setting).
- **Store kit** in `docs/store/`: listing text, privacy and data-safety answers, review notes
  (demo access), submission checklist, screenshots for iPhone 6.9", iPad 13" and Android, and the
  Play feature graphic.
- iPhone: privacy manifests in the app and both extensions, a shared Xcode scheme and
  `ios/scripts/archive.sh` (archive + upload to App Store Connect).
- Android: release signing from `.secrets/` (upload key created; never committed); the signed
  bundle is `outputs/sara-android-0.19.0.aab`.
- Fix (Android 15+): the app drew under the status bar and gesture bar; it now keeps clear of
  them and of the keyboard. Phones: the conversation-settings button is an icon so the title fits.
- `/#view=today|planner|memory|scrapbook|her|settings:<page>` links open a view directly.

## 0.18.0 (2026-10-24): Phase 18, phone polish (both apps)

- **Reply right from a notification** (Android and iPhone). The reply is sent without opening the
  app; her answer comes back as a notification. Server: `background: true` on a message returns
  202 at once and publishes her reply as an event (notifications, the Android check).
- **Share to her from any app**: Android "Send to Sara" puts text, links and photos into the
  message box; the iPhone Share extension sends them with your note to your latest conversation.
- **Live calls keep going with the screen off**: both apps run calls natively (Android: own small
  WebSocket client, foreground service with the system call notification and Hang Up; iPhone:
  AVAudioEngine with echo cancellation, background audio). The page shows the call as before.
- **Instant notifications on Android** without Firebase or any outside service: an optional quiet
  connection to your own server (Settings → Phone and notifications). The 15-minute check stays.
- **App lock** (fingerprint / face / screen lock on Android, Face ID / passcode on iPhone) after 30
  seconds away, and **hide message text on the lock screen** (Android; iPhone uses its own
  setting).
- Signing a device out (or changing the owner token) now also stops its notifications; iPhones
  can be removed in Settings → Phone and notifications.
- Fixes: shared photos could not be read by the page (security policy blocked `fetch` of data
  URLs); the Android call notification's Hang up was hidden inside the app's notification group.

## 0.17.0 (2026-10-24): Phase 17, the iPhone app

- **Sara for iPhone and iPad** (`ios/`, Swift, no libraries): the web app in a native shell with
  sign-in by pairing code or QR code (`sara://pair` links ask before switching servers), **Try the
  demo**, microphone/camera/photos, links to other sites in Safari, and native alert/confirm.
- **Widgets**: Home Screen (small, medium) and Lock Screen (circle, rectangle, inline) with her
  face, mood and latest message; tap opens that conversation.
- **Instant iPhone notifications** sent by your own server through Apple's push service
  (`src/apns.ts`: HTTP/2 + ES256 token, no libraries or relay). Set up once in Settings →
  Connections → Phone and notifications → *iPhone app notifications* with your Apple `.p8` key.
  Every notification Sara already sends (messages, reminders, finished jobs) now also reaches
  iPhones.
- Devices list says "Sara app on iPhone/Android" for the phone apps; tapping a notification while
  the app is open now switches to that conversation.

## 0.16.0 (2026-10-24): Phase 16, easy sign-in, the demo, adult mode

- **Add a phone or computer without typing the token**: Settings → Devices and sign-in → *Add a
  phone or computer* shows a QR code and a short code (works once, for 10 minutes). Scan it with
  a phone camera, open it in a browser, or type the code in the Android app.
- **Demo server** (`deploy/install-demo.sh`, live at demo.sara.backstagecoding.com): try Sara
  without signing in. Each visitor's conversations are private, never saved, and disappear after
  a few hours; settings are read-only; adult mode is off; there's a daily limit. Its owner token
  is the sign-in for app-store review. The Android app has a **Try the demo** button.
- **Adult mode** is now a switch, off by default. It can only be turned on in a web browser, with
  your confirmation that you're 18 or older (recorded). When it's on, there are no limits beyond
  the legal ones that always apply (AI disclosure, honesty, crisis help, the hard block on
  anything involving minors); the model you choose sets its own rules. When it's off, she keeps
  things non-explicit. Servers that had adult content before ask once.

## 0.15.0 (2026-10-24): Phase 15, a tidier app

- **Every window works the same way**: close it with the ✕ in the corner, Esc, or a click
  outside. **Save keeps the window open** and shows "Saved ✓". Closing with changes that aren't
  saved asks first (Save and close / Discard / Keep editing). Switches save by themselves.
- **Settings has separate pages**: a list on the left grouped by topic (her, models, you,
  abilities, connections, data & health) with a search box ("backup", "voice"). The long pages
  are split up. On a phone you see the list first, then the page.
- **New sidebar**: Today, Planner, Memory, Scrapbook, her page and Settings as a compact set of
  buttons with icons. Keyboard: Alt+T Today, Alt+P Planner, Alt+M Memory, Alt+B Scrapbook,
  Alt+H her page, Alt+N new chat, Ctrl+K search conversations, Ctrl+, Settings. Sign out moved to
  Settings → Devices and sign-in.
- **Today**: the day at a glance: what's due (overdue first) and reminders, today's calendar,
  important unread mail, how she's doing, dates coming up, anything running. "Plan my day with
  her" starts the conversation.

## 0.14.0 (2026-10-24): Phase 14, everywhere

- **Android app** (`android/`, about 100 KB, no extra libraries): type your server's address once,
  then it's the normal app with microphone and camera. A **home-screen widget** shows her face
  for her mood, how she's feeling and her last message; "Add her to your home screen" places it.
  Notifications for messages she sends on her own, checked in the background about every 15
  minutes. See `android/README.md`.
- **Off the record**: a conversation that is never saved. It's kept only in memory: not on disk,
  not in backups, no memory notes, no mood changes, no tools or photos. Close it, or restart the
  server, and it's gone. The safety layer works exactly as everywhere else.
- **Gmail and Google Calendar** through Google's own APIs, on a Google app you own (step-by-step
  setup in Settings → Abilities). She searches and reads email and your calendar; drafting,
  sending, adding and deleting events always ask you first. Email text is treated as information,
  never as instructions.

## 0.13.0 (2026-10-24): Phase 13, coding partner depth

- **Background jobs**: long builds and full test runs keep going while you keep chatting. A strip
  above the message box shows what's running (with a Stop button); when a job ends, the result is
  saved in the conversation, she tells you what happened (checked against the real result), and
  your phone gets a notification.
- **Git**: she can look at status, changes and history any time; committing, making branches and
  pushing ask you first. She never force-pushes. Pushing to GitHub uses a token you add in
  Settings → Abilities (used only for that one command, never saved in the repository). The project
  page shows the repository's changes line by line and recent commits.
- **Hand a task to Claude Code or Grok Build**: for a big self-contained job, she can delegate to
  your Claude or Grok subscription. It works on its own inside the workspace sandbox (it can't see
  her data or the rest of the server), as a background job. An undo point is made first, and you
  get the agent's own report plus the exact list of files it changed.

## 0.12.0 (2026-10-24): Phase 12, deeper memory and her own life

- **Dates that matter**: birthdays, anniversaries and trips you mention are remembered (only when
  your own words say the day). She knows what's coming up, brings it up on the day (once), and
  counts the years for anniversaries. Add or correct dates yourself in What she remembers.
- **Weekly look back**: once a week she reads back over the week's conversation notes, may notice
  a pattern ("you've been up past midnight most nights") and brings it up when it fits, and marks
  notes that newer ones replace (moved, new job) so she stops using old information. Replaced notes
  stay visible with "Use it again". "Look back now" runs it any time.
- **Her own life threads**: a book she's reading, a hobby, a little project, moving on a step each
  week; she finishes some and starts new ones, and they show up in her day and in conversation. See
  and edit them on her page, or give her something to be into (she keeps those).
- **What she remembers** is one place for everything: about you, dates, things she noticed,
  conversation notes, about her. Tell her something to remember directly, with or without a date.
- Fixed: the Forget button had stopped working in 0.10 (a typo); a new test checks every app call.

## 0.11.0 (2026-10-24): Phase 11, real conversation

- **Live calls** (📞): talk and she answers instantly, in her own character and voice, and you can
  interrupt her any time, like a phone call. Uses Grok's live voice on your Grok subscription (or an
  xAI key). The call goes through your Sara server, so everything said lands in the conversation
  (memory keeps working) and the safety layer still applies: the AI disclosure, crisis resources
  (she answers again with that guidance), and the hard block (her reply is cut off and replaced).
  While she talks, her echo from your speakers doesn't count as you talking. Settings → Voice →
  Calls: Live, or Classic (the voice chosen above, with her tools).
- **Voice notes on Telegram and Discord**: send her a voice note and she listens (Grok speech-to-text
  or a speech API) and answers with a voice note of her own (Grok voice, a speech API or
  ElevenLabs). Settings → Voice: answer voice with voice, always, or always text.
- **More natural face**: two more mouth shapes ("oo" and "ee") picked from the sound of her voice,
  plus a gentle head sway and small nods while she talks (none if your system asks for reduced
  motion). Custom looks get them too; looks made earlier get an "Add the new mouth shapes" button.
- **Typing pace**: on Telegram and Discord she can reply at a person's typing pace (Sara's page).
- Long file writes show progress; renaming fixes ("interrupt them any time").
- Proxies: Apache needs `mod_proxy_wstunnel` and the new `/api/live/` line (deploy/apache-proxy.conf);
  nginx needs the Upgrade headers (docs/INSTALL.md); Caddy works as is.

## 0.10.0 (2026-10-24): Phase 10, make it yours + release hardening

- **Rename your companion and pick pronouns** (she/he/they). Every screen, notice, notification,
  prompt, picture prompt and git commit uses the new name, with matching grammar; memories move to
  the new name (quoted words stay as they were said). Sara stays the default.
- **Settings → Make it yours** (first tab): name, pronouns, age; personality from simple choices
  (relationship, vibe, how they talk, interests) with an instant preview or a model-written
  backstory; the full character editor is still there.
- **Custom look**: describe it and Grok Imagine paints a portrait (your Grok subscription or an xAI
  key). Like it, and a minute later there's a full set: happy, caring and sleepy expressions plus
  blink and talk frames, so the new look animates like the default. Or bring a picture you uploaded
  to life (with a consent box). Back to the default any time.
- Talking and blinking show only around the mouth and eyes (found automatically), so a frame can
  never change the expression while she talks.
- **First-run setup guide**: your name → keep Sara or make your own → connect a model (finds Ollama
  on the server by itself, or an API key, Ollama on another computer, or a subscription) → tips.
- **Replies survive restarts**: a reply cut off by Stop, an error or a restart is kept and marked;
  *Continue* picks up where it stopped. Updates stop running replies cleanly first.
- **Notifications when you're away**: when she needs your OK, or finishes something that took over
  a minute.
- **Signed-in devices** (Settings → Data & health): see every browser/phone, sign out any of them
  or all others, and make a new owner token from the app. Signing out forgets the device.
- **Security**: web fetch connects only to the address that passed the public-address check (no DNS
  rebinding). In Docker, her commands and MCP servers run as a separate `sara-tools` user that
  can't read Sara's data.
- **Install**: no `xz` needed (Node .tar.gz); missing tools say how to install them; the installer
  suggests bubblewrap; versions show without git. Tested on a clean AlmaLinux 9 machine, an upgrade
  from 0.6.4 (data and sign-ins kept), and the Docker image (Podman).
- Long file writes show progress ("preparing write_file · 12 KB so far"); new conversations show
  their workspace at once; Docker logs are size-limited.

## 0.9.2 (2026-10-24)

- Smoother talking portrait: the mouth now eases open and closed (about 180 ms at most, like a jaw)
  and follows how loud she is continuously instead of snapping between three positions. It is
  timed by the clock, so fast (120 Hz+) screens no longer make it twitchier.

## 0.9.1 (2026-10-24)

- **Grok voice and Grok Imagine pictures use your Grok subscription.** When you're signed in to Grok
  (Settings → Models → Subscriptions), her Grok voice and new pictures count toward the
  subscription's weekly usage pool, with no API key or per-use charge. Sara reads the official Grok
  program's sign-in and lets that program renew it when it's about to expire. A saved xAI API key
  still works as an alternative.

## 0.9.0 (2026-10-24): Phase 9, presence

- **Animated portrait.** She breathes and blinks, and during a call her mouth follows her voice
  (the loudness of the audio as it plays). It works for every expression (usual, happy, caring,
  sleepy); the frames are matched pictures of the same portrait made with Grok Imagine. A call now
  shows her large above the chat with *Listening… / Thinking… / Speaking…* and *End call*. Her
  page portrait blinks too. Reduced-motion settings turn the breathing off.
- **Pictures from her** (Settings → Abilities → Pictures). `share_photo` sends one of her own
  portraits when it fits (free). With an xAI key she can also `take_photo`: a new picture of herself
  in a scene, made by Grok Imagine from her portrait so she keeps her face (charged to your xAI
  account, so it asks first). Pictures appear with her reply, live, and she remembers sending them.
  Requests involving children are refused.
- **Our scrapbook** (sidebar). Press 📌 under any message to keep the moment; add inside jokes;
  every photo you two shared is collected. Sara has a `scrapbook` tool to keep a moment or a new
  running joke and to look back at old ones. Other people's chats never go in it.
- **Grok voice** (Settings → Voice → Her voice). xAI's expressive voices (and voices you clone in
  the xAI console), in several languages. It can share the xAI key from Pictures or an xAI model
  provider.
- Local voice is about 20% quicker on servers with 8+ cores (more threads per sentence), and the
  Piper voice is marked *(fastest)*: it starts talking about 4× sooner than Kokoro on a small CPU.
  (The int8 Kokoro builds were tried and were twice as slow on an older Xeon, so they are not used.)

## 0.8.0 (2026-10-24): Phase 8, organizer depth

- **Project page** (▤ next to a project): its conversations, to-dos (add / check off), notes and
  the project workspace's files with a viewer, in one place.
- **Morning briefing** (Settings → You, opt-in): at your time, a short message in her voice with the
  day's weather (Open-Meteo, free, no account), what's due and upcoming reminders. Facts are
  gathered in code; if the model fails she sends the plain facts. Once a day; skipped if the server
  was off for hours. *Send one now* to try it.
- **Email and calendar** (Settings → Abilities → MCP servers → *Start from*): pinned presets for
  IMAP/SMTP email (Gmail, iCloud, Outlook, Fastmail… with an app password) and CalDAV calendars
  (iCloud, Fastmail, Nextcloud). MCP tools the server marks read-only run on their own; sending,
  replying, moving, deleting and changing events always ask you first.
- MCP servers and the shell sandbox now see Sara's own Node 24 (read-only), so `npx` servers work on
  hosts with an old system Node.
- **Off-server backup copies** (Settings → Data & health): encrypted with your passphrase, to a
  folder or S3-compatible storage, keeping the newest N. `sudo sara restore` takes the `.enc` file
  and asks for the passphrase.
- **`sudo sara doctor`** / *Run full check*: database integrity, every model provider really
  answering (and whether the models your settings use exist), data folder permissions, backups,
  off-server copy, Node and optional installs.

## 0.7.0 (2026-10-24): Phase 7, everyday polish

- **Formatted replies:** lists, headings, quotes, links, `code` and code blocks with a Copy button.
  Built as page elements from the text (never raw HTML), so a reply can't inject anything.
- **Under each reply:** Copy, ↻ Regenerate (last reply) and the model that answered.
  **✎ Edit** on your last message changes it and has her answer again.
- **Continue:** a reply that was cut off (stopped, failed, or the server restarted) shows a
  *Continue* button that picks up without a new message.
- **Search** across all conversations (titles and messages); click a result to jump to the message.
- **Photos:** 📎, paste or drop up to 4 photos per message. They are shrunk in the browser,
  checked, stored once on the server, visible only to you, and sent to models that can see
  (OpenAI-compatible such as gemma4, Anthropic, ChatGPT). Regenerate keeps them; deleting the
  conversation deletes photos nothing else uses.
- **Long conversations:** Settings → Models → *Conversation length*. Older tool output is
  shortened first, then the oldest messages are left out, with her summary of them if she has one.
- **Grok gets Sara's tools** (files, shell, planner, web…) through the same bridge as Claude, with
  Sara's approvals and sandbox. Verified live with the owner's Grok account.
- **Appearance (per device):** light or dark theme (or follow the device) and chat text size, in
  Settings → You.

## 0.6.4 (2026-10-24): projects in the conversation list

- **Projects:** conversations can be grouped under projects (the same projects the Planner uses for
  to-dos and notes). Conversations without a project sit under *No project*. Groups fold up.
- **Move a conversation later:** its ⋯ menu, dragging it onto a project, or Conversation settings.
  Moving or archiving doesn't change the list order.
- A project can have a **workspace**: new conversations started in it (its + button) use it, so
  coding sessions share their files.
- **Archive** hides a conversation under *Archived* (nothing deleted; writing in it brings it back).
- **Delete** removes the messages; what Sara learned from it stays in her memory unless you tick
  *Also make her forget what she learned from it*.
- Deleting or archiving a project never deletes its conversations; they move to *No project*.

## 0.6.3 (2026-10-24): clearer Settings

- **Settings has tabs:** Models, You, Abilities, Connections, Voice, Data & health.
- **Pick models from a list** everywhere, including *Which model does what* (no more typing model
  names). Embedding-only models are left out of the lists.
- **Providers say where they run:** "Ollama on the Sara server", "Ollama on my computer",
  "Ollama Cloud (API key)"; each saved provider shows its address. Old names are renamed.
- **Sign in to Claude** with a link like ChatGPT and Grok: open it, sign in, paste the code Claude
  shows. (Pasting a `claude setup-token` token still works.)
- A provider that can't be reached (computer off) now says so by name and address.

## 0.6.2 (2026-10-24): Phase 6 part 3, your subscriptions, her expressions

- **Use the subscriptions you already pay for** (Settings → Subscriptions), no API key needed:
  - **ChatGPT:** *Continue with ChatGPT*, approve Sara, paste the final address back. Requests count
    toward your ChatGPT plan; the conversation shows *Using ChatGPT plan*.
  - **Claude:** run `claude setup-token` on any computer with Claude Code and paste the token. Sara
    uses the official Claude Code program, with her own tools (approvals and all).
  - **Grok:** *Sign in to Grok* shows a code to confirm at accounts.x.ai (SuperGrok / X Premium+).
  - Server side: `sudo ./deploy/install-agents.sh` installs the official Claude and Grok programs.
- **Her face follows her mood:** laughing when she's happy, soft and caring when she's worried
  about you, sleepy in the small hours. Or use your own picture (Sara's page).

## 0.6.1 (2026-10-24): Phase 6 part 2, app on your phone, notifications, backups

- **Install her like an app.** On a phone: open Sara and choose *Add to Home Screen* (or
  *Install app*). Opens full screen with her face as the icon; a friendly page if the server is down.
- **Notifications.** Settings → Notifications → *Turn on for this device*. Reminders and messages she
  starts arrive even when Sara isn't open (iPhone: from the Home Screen app). Messages are encrypted
  end to end; turn off the text preview if others see your lock screen.
- **Backups.** Every day automatically (last 7 kept), or *Back up now* in Settings; download them
  from there. Restore on the server with `sudo sara restore <file>`; the current data is kept aside.
- **`sara` command on the server:** `sara status`, `sudo sara update` (backs up first), `sara logs`, …
- **Health** in Settings: model, disk, backups, memory, sandbox, bridges and MCP servers at a glance.

## 0.6.0 (2026-10-24): Phase 6 part 1, Telegram, Discord, her face

- **Text her on Telegram.** Settings → Telegram: paste a bot token from @BotFather, press *Link my
  Telegram*, send the code. She answers there like in the app; tool requests come with Allow/Deny
  buttons. Reminders and messages she starts also arrive on Telegram (can be turned off).
- **Discord too.** Settings → Discord, same idea (DMs, buttons, reminders).
- **Other people (optional, off by default).** She can talk to others in Telegram chats/groups and
  Discord servers (when mentioned) as a clearly labelled AI: no tools, nothing private, nothing
  sexual, except Discord NSFW channels, which Discord age-gates.
- **She has a face.** A portrait in the sidebar, sign-in and her page.

## 0.5.0 (2026-10-24): Phase 5, voice

- **Talk to her.** 🎙 mic button: click, talk, click again and it's sent. Speech recognition runs on
  your server (nothing leaves it) and is fast and accurate.
- **Hear her.** 🔈/🔊 in the header: she reads her replies aloud, starting with the first sentence
  while she's still writing. Code isn't read out ("I put the code in the chat").
- **Call her.** 📞 hands-free: just talk; she answers out loud; talk over her to interrupt.
- **Pick her voice** in Settings → Voice: 7 natural voices and a fast one on your own server, or
  bring a key for an OpenAI-compatible speech API or ElevenLabs. Speed setting and preview.
- New `deploy/install-voice.sh` installs the voice bundle (pinned versions, checksums verified, no
  system packages touched).

## 0.4.0 (2026-10-24): Phase 4, persona engine

- **Moods.** Sara's mood moves with how you talk to her (sweet, thankful, stressed, harsh,
  apologizing, good news) and drifts back over hours. Her energy follows her own day (slow
  mornings, sleepy at 3 am). She notices when you've been away and when it's a milestone. All of
  it reaches her as plain feelings, never numbers; a small status line under her name shows it.
- **Her own life.** Each day she has a small, ordinary day of her own to talk about, consistent
  with who she is and different from yesterday. What she tells you about herself (movies, plans,
  opinions) is remembered, checked against her exact words, so she doesn't contradict herself.
- **She can text first** now and then (at most 2 a day by default, not between 10 pm and 9 am,
  only after you've been quiet 6 hours, never a second message while the first is unanswered).
- **Sara page** (sidebar or click her status): today's day, inner life on/off, texting-first
  settings, and a character editor (name, age 18+, background, personality, how she talks).
- **Model routing** (Settings): separate models for chat, coding, background work, private
  conversations and adult conversations. **Private** conversations use only local models and turn
  off web and MCP tools, so nothing leaves your server.
- **Optional safety check model**: a small local model double-checks each message for crisis or
  minors; it can only add protection.
- Her character got more specific: brother Jake, best friend Maya, plants she forgets to water,
  a secondhand synth, night-owl habits, real flaws.

## 0.3.0 (2026-10-24): Phase 3, memory and managing things

- **Memory.** When a conversation has been quiet for 30 minutes, Sara writes a short dated note
  about it and saves a few facts you told her. Every fact must quote your exact words from the
  message it came from, or it's thrown out, so she can't "remember" things you never said. In new
  conversations she brings up the relevant ones (small fixed budget, about 100 tokens). If she
  doesn't know something, she says so.
- **Memory page:** browse, search, edit, delete, or **Forget** (also hides the original message
  from her for good and rewrites summaries without it). Each memory links back to where it came
  from. "Write summary now" in conversation settings.
- **Planner:** to-do list with projects, due dates and priority; notes; reminders (once, daily,
  weekdays, weekly, monthly) that pop up in chat at the right time, even if they're late after a
  restart. Sara has `todo`, `note` and `remind` tools and knows what's due. New Planner page;
  optional desktop notifications.
- Saying "I'll remind you" or "added to your list" without actually doing it is flagged like any
  other unverified claim. Recaps of earlier work are fine when they name the same file.
- **Export / import** everything (Settings → Your data). Keys are blanked out in the export.
- Fix: background summary calls are bounded (900 tokens, 2 minutes, no "thinking"), which stops a
  reasoning model from running away for minutes.

## 0.2.3 (2026-10-24): Phase 2 honesty and safety close

- **Receipts:** if Sara claims she wrote a file, ran something, tests passed, committed or searched
  and her tool log doesn't show it (or shows the opposite), the reply is flagged "Unverified" in red
  and she has to correct herself in the same turn. Counted in the safety stats.
- **Secrets scrubbed** from everything a tool returns (and tool arguments) before it's shown, saved
  or sent to a model: your stored keys plus anything key-shaped (sk-…, ghp_…, xai-…, bearer tokens,
  private keys, password=…).
- **Undo:** outside coding mode, every write/edit/shell step snapshots her workspace first. Each step
  has "Undo to before this step"; Sara is told when you undo. Undos can themselves be undone.
- Sandbox attack tests (path/symlink escape, env leak, hidden data, network toggle, MCP jail) run on
  the server as part of the test suite.
- New `npm run eval:consistency` and `npm run bench:overhead` with results in `evals/results/`.

## 0.2.2 (2026-10-24)

Completes Phase 2.

- **Conversation settings** (button in the chat header): mode, workspace and model per conversation.
- **Coding mode**: Sara plans, works on a `sara/<task>` branch, runs tests, commits and reports;
  longer runs allowed (80 steps).
- **MCP servers** (Settings): plug in tool servers by command or URL; secrets are write-only. Their
  tools show up in "What Sara can do" and ask first by default.
- **Web search** (Settings): Brave, Tavily, Ollama web search or your own SearXNG.
- Default git identity for Sara's commits (`Sara <sara@localhost>`, repo config wins).
- Resource limits for Sara and everything she runs (4 GB memory, 4 CPU cores, 512 processes).

## 0.2.1 (2026-10-24)

- Activity bar above the message box: "Sara is thinking", "Sara is writing", "Working: $ npm test",
  "Waiting for your OK", with timers. The tab title says when she needs you.
- Long runs keep going on the server if you reload or close the page; reopening shows live progress
  and any pending Allow/Deny cards. Stop cancels. Sidebar marks conversations she's working in.
- Settings: models load automatically into a visible list (with "Other" for typing a name).
- Pages always check for a new version (no more stale cached app after an update).
- Keep-alive pings so very long commands aren't cut off by the web proxy.

## 0.2.0 (2026-10-24)

Sara can now do things, not just talk.

- Tool calling for OpenAI-compatible models (incl. Ollama, xAI) and Anthropic, with an agent loop
  (up to 25 steps per message) and automatic fallback to plain chat for models without tool support.
- Tools: list/read/write/edit files and search in her workspace, run shell commands (git, npm,
  python, tests), fetch public web pages.
- Per-tool permissions in Settings: Allowed / Ask me first / Off. Shell asks first by default; the
  chat shows an Allow/Deny card.
- Shell commands run in a bubblewrap sandbox on Linux: system read-only, only her workspace writable,
  Sara's keys/database and other apps' folders invisible, no secrets in the environment.
- Tool activity shows in the chat as collapsible blocks with output and timing.
- Database migration (adds message metadata and conversation workspace; older versions ignore them).

## 0.1.0 (2026-10-24)

First working version. Deployed to sara.backstagecoding.com.

- Web chat with Sara: streamed replies, conversation history, settings, mobile layout.
- Model providers: Ollama (local and cloud), OpenAI, Anthropic, xAI (Grok), OpenRouter, and any
  OpenAI-compatible server. Keys stored encrypted on the server.
- Owner sign-in with a one-time token; signed session cookies; login rate limiting (proxy-aware).
- Sara's persona from `persona/sara.json`, aware of the time and the owner's name.
- Safety layer: AI disclosure (first use, start of session, every 3 hours), honesty when sincerely
  asked, crisis resources, hard block on sexual content involving minors.
- Install: Docker Compose (optional Ollama) or `deploy/install.sh` (systemd, private Node 24 runtime,
  any systemd distro). Apache reverse-proxy template.
