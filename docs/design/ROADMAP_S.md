# Roadmap S: high-end help, and harnesses that work together

Owner, 2026-11-16: "I would like all 8", plus linking harnesses (Sara and Hank), with private messaging
between their people and a way for one harness to look into another's problems. Each item is checked
against what already exists before it is built (GREP FIRST); existing engines are reused:
research, errands, automations, approvals, receipts/verify, the library, inbox helper, A2A, the hub.

Build order: wave S-A (S10, S1, S3, S5, S9a), wave S-B (S2, S4, S6), wave S-C (S7, S8, S9b, S11). Each wave
ships after a 0-fail suite.

| # | Feature | What the person gets |
|---|---|---|
| S1 | Deep research reports | A long research run across the web and their own files, with progress, a source list, and a cited report exported to Word/PDF. Every claim links to its source; a claim without one is marked. |
| S2 | Meeting assistant | Records or joins Zoom/Teams/Meet (desktop audio capture with a spoken or shown consent line, or an uploaded recording); a transcript with speakers, a summary, decisions and action items; drafts of follow-up emails wait for approval. |
| S3 | Long-running goals | A goal she works on over days: a plan, checkpoints, reminders, a progress page and a weekly summary. It reuses errands and automations; anything outside approval rules asks first. |
| S4 | Relationship memory | People they deal with: the last contact on each channel, promises made ("I'll send it Friday"), birthdays, and nudges ("Dan has waited 2 weeks for your reply"). Built from mail, chats and the calendar; the person can edit or forget anyone. |
| S5 | Ask your whole life | One question across mail, files, chats, calendar, notes and lists, answered with citations to each source. Indexed locally, private chats excluded, and household members only see their own data. |
| S6 | Travel assistant | Bookings found in email become one itinerary; flight status, check-in and leave-by alerts, and gate or delay changes; rebooking options are suggested. She never books or pays without the person. |
| S7 | Documents end to end | Contracts, proposals and letters drafted from their templates and past documents, with tracked changes in Word, a clause checklist, and a signature-ready PDF. Information, not legal advice. |
| S8 | Agent teams | A big job split between helpers working in parallel (research, draft, check), each with its own budget and tools, then merged with one approval point and a visible plan. |
| S9 | Linked harnesses | See below. |
| S11 | Write like a person | A "Make it sound human" option for anything she writes (reports, book reports from the Library, summaries, emails, research reports): plain everyday words, varied sentence length, no stock AI phrases ("delve", "tapestry", "in conclusion", rule-of-three lists, em-dash habits), concrete details from the source instead of filler. It can match the person's own voice from a few samples of their writing they choose. Facts, quotes and citations stay exactly as they were, and a side-by-side view shows what changed. A style setting per document and a default in Settings. Not built or sold as a way to dodge AI detectors or school rules: in kid mode it coaches (outline, questions, feedback on their draft) instead of writing the report for them. |
| S10 | Pick-an-answer cards | When she offers options or asks a decision question, the choices appear in the chat as buttons to tap (one or several), always with "Other, type it out" last. Her recommended option is first and marked. A pick is sent as the person's answer. Works on phone, desktop, Telegram (inline buttons) and Discord (buttons), and falls back to a numbered list where buttons can't show. Never used for approvals (those keep their own cards). |

## S9: linked harnesses (Sara and Hank)

Two or more Sara servers can be linked with a one-time code, and unlinked in one click on either side.
A link has two separate parts; each is switched on by its own owner, and each can be turned off on its
own.

**S9a. Private messages between people.**
- Instant messages between the owners of linked harnesses: one-to-one, plus small groups (communities)
  that more harnesses join with an invite code.
- **The agents are not involved.** Messages never go into her memory, her context, the model or any
  tool, and she can't read them unless the person forwards one to her on purpose.
- Sent directly between the two servers over HTTPS, signed with the link's keys. Nothing goes through
  a third party; the hub is used only to find each other when both choose it.
- Typing, read receipts (each can be turned off), pictures and files within limits, editing and
  deleting your own message, plus block, mute and leave.
- Kept for as long as each person chooses: 30 days by default, changeable per person and per chat.
- Private one-to-one chats between any two people who share a link or a community, alongside the
  community chats.
- Communities: anyone with the invite code can join; the creator (and anyone they make a moderator)
  can remove or ban a harness and make a new code. A ban is enforced by the group's own server.
- A Messages page in the app, with notifications on phone and desktop.

**S9b. Harness support link (one helps the other).**
- The other owner grants a time-limited "help me" pass (1 hour to 7 days, revocable at any time).
  Every look is listed for both owners.
- With the pass, Sara can read Hank's health, self-test results, versions, recent errors and logs,
  with secrets, message contents and medical data removed, and his settings with keys hidden. She
  can then explain what's wrong.
- Changes are only proposed: each fix arrives at Hank's owner as an approval card ("Sara suggests:
  switch the backup model to …"), and nothing changes without that owner's OK. No shell access and no
  file access.
- Built on the existing A2A link and agent keys, with a narrow `support` scope.

Safety: links are owner-only (members and kid mode are never part of one), and every link and pass is
in the audit trail. Unlinking deletes the keys on both sides, and the message history is kept or
removed as the person chooses.
