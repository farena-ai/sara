# Learning coach (U4.23)

Sara turns something you want to learn into a **study set** and helps you keep it: flashcards, quizzes,
a summary sheet and spaced repetition, all on your own server.

## Using it

- **Make a set.** Library → **Study…** → *Make a study set*: pick a Library document (and, for a long
  one, a chapter) or paste text, then **Make cards**. Or ask in chat: "make flashcards from chapter 3 of
  my biology book", "quiz me on these notes".
- **What you get.** Flashcards (front/back), fill-in-the-blank (cloze) cards, multiple-choice questions,
  short-answer questions with a rubric, and a **summary sheet** of the key points.
- **Study.** *Study now* (or a set's *Study*) shows one card at a time. Flashcards: *Show the answer*,
  then **Again / Hard / Good / Easy**. Again brings the card back today; Good and Easy space it out
  (SM-2). Multiple choice and short answers are checked for you, with kind feedback.
- **In chat.** "Quiz me": she asks the next due card. A multiple-choice card is a pick-an-answer card
  (the same cards as other choices she offers); for other cards you answer in your own words and she
  tells you how you did.
- **Today and reminders.** The **Study** tile on Today shows how many cards are due, per set (only while
  some are). Once a day at the time you pick she reminds you, only when cards are due.
- **Progress.** Each set shows learned cards, cards due, a progress bar and your streak.
- **Export and import.** *Export for Anki* (tab-separated text Anki imports directly; cloze cards keep
  `{{c1::…}}`) or *Export CSV*. *Import cards* reads either format back.

## Settings

Settings → You → Briefing and reminders → **Study cards**:

| Setting | What it does |
|---|---|
| Remind me when study cards are due | One reminder a day, only on days with cards due (on by default). |
| Time | When the reminder arrives (4:00 PM by default). |
| New cards a day | How many never-seen cards come up each day (20). |
| Cards per new set | The most cards one new set gets (5–60, default 20): the generation cost cap. |

## Kids

For a child in the household (Settings → Household, kid mode):

- Cards and feedback use words for their age group.
- **Hints before answers**: *Show a hint* comes first; the answer only after that. A wrong answer gets a
  hint and "want to try again?" instead of the answer.
- **Homework is coached, never done** (the same rule as "Make it sound human"): when the text is a
  worksheet or an assignment, the cards hold guiding questions and first steps, never the answers, and
  there is no summary sheet.
- **Parent view**: Family → a child → *What they talked about* also lists their study sets with titles
  and counts (learned, due, studied today), never the cards or their answers.

## Privacy and cost

- Everything is stored in your own space (a household member's sets live in theirs; nobody else sees
  them). In private local mode no reminder is pushed.
- Making a set costs **one model call** on at most about 24,000 characters of text; a short answer
  costs one small call. Any model works, local ones too. If the model's reply is not usable (small
  local models), Sara makes the cards herself from the text (fill-in-the-blank and multiple-choice
  cards plus a summary of the first sentences), so a set is always made.

## Design (one page)

- **Engine** `src/study.ts` (`Study`, per space, tables `study_sets`, `study_cards`, `study_log`,
  `study_prefs` in the space's database). `make()` reads a Library document/section (`pagesText`, falling
  back to passages by heading) or pasted text, caps it at `STUDY.maxChars`, asks the background model
  once for JSON (`title`, `summary`, `cards`), cleans every card (`cleanCard`: cloze `{{c1::…}}`, choices
  must contain the answer, short answers keep a rubric) and keeps at most `maxCards`. Unusable replies
  fall back to `localCards()`. Kid detection is `app.member.child()`; homework detection reuses S11's
  `isAssignment()` plus "3+ lines ending in ?".
- **Scheduling**: `sm2()` (ease ≥ 1.3; Again → due today, reps reset; 1 → 6 → interval × ease days);
  `queue()` = seen cards due by today + new cards up to *New cards a day*.
- **Grading**: multiple choice/cloze by folded string match; short answers by the model against the
  rubric (JSON `score` 0–2 + `feedback`), with a local keyword-overlap grader when the model fails.
- **Chat**: tools `study_make`, `study_list`, `study_quiz`, `study_answer` (`src/tools/study.ts`; lean
  family `study`; on the kid allowlist). `study_quiz` hands a multiple-choice card to chat.ts through
  `takeQuizChoice(call.arguments)`, which shows it exactly like an S10 `ask_choice` card.
- **Routes** `/api/study…` (`src/routes/study.ts`, member route group, 404 on the demo). For kids, an
  unseen card's answer is not sent with the card (it comes from `/reveal` after the hint).
- **Today/reminders**: Today part `study` + tile `td-study`; `ReminderScheduler.tick` → `study.due(now)`
  posts once a day to the Reminders feed (where alerts go) and pushes, never in private local mode or
  quiet hours (push only).
- **Parent view**: a kid's `Study` writes titles + counts to the household `FamilyStore` (`kid_study`);
  parents read them with `FamilyStore.study()` (parents only) on the kid detail route.
- **Web**: `web/study.js` (Library → Study view, tile, Settings section loader/saver).

Tests: `test/u4-learn.test.ts`.
