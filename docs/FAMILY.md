# Family (R8)

Chores and allowance, school dates from email, kid-safe member mode, and grocery lists that know
stores. One household store, `<data>/shared/family.db` (`src/family.ts`), next to the shared boards;
never on the demo server. Open it from the sidebar (**Family**) or the **Family** tile on Today.

## Chores and allowance
- A parent (the owner, plus grown-up members the owner marks as parents) adds a chore: what, who,
  how often (once, every day, weekdays, every week), when it is first due, and what it is worth
  (points and/or an amount). Ask Sara too: "add a chore for Mia: feed the cat every day, $1".
- The kid taps **I did it** (with a photo when the chore asks for one, up to 4 MB). A repeating chore
  moves on to its next time at once; a one-time chore rests until a parent decides.
- A parent taps **Approve** (or **Not yet**). Only approved chores go into the kid's ledger; nobody
  approves their own chores.
- **Allowance** shows each kid's balance (earned minus paid out), points and the ledger. **Record a
  payout** only writes it down: Sara never moves money (the `allowance_pay` tool asks first and says
  so on its card).
- Parents get a weekly summary on Sunday evening (the owner's time zone), once, on their phones.
- Tools: `chore_add` (parents), `chore_list`, `chore_done`, `allowance_balance`, `allowance_pay`
  (parents; asks). Lean family `family`.

## School dates from email
- The inbox helper (N3, `src/inbox/school.ts`) reads mail from schools, districts, PTAs and teachers
  (and school newsletters) line by line: early release, no school, picture day, field trips, school
  events, and permission slips with their due date. Each date is a suggestion card ("School").
- **Accept** adds it to the person's **School** list (a planner project) at 8 am that day (or the time
  in the mail), with a reminder at 7 pm the evening before. A permission slip becomes a task "Sign and
  return: …" with the attached form kept in the Library (folder School). Undo removes the task, the
  reminder and a newly kept form. "Always for school dates" accepts them on their own.

## Kid-safe member mode
- The owner invites a child from Settings → Household (**This is a child**, an age band, and "I am
  this child's parent or guardian" instead of 18+); the child joins without an age box. The owner can
  also turn it on, change it or turn it off for any member on Family → Kids.
- Enforced on the server, whatever a request says:
  - Routes (`childRouteCheck`, run after the member rules in `memberRouteCheck`): no computer use,
    mail, inbox helper, errands, share links, outside apps, Alexa, Shortcuts or automations; adult
    mode, her character, companions, skills and settings are read-only for a child.
  - Settings: adult mode and other apps' tools are forced off (`MemberSettings`).
  - Tools: a child's companion offers and runs only `KID_TOOLS` (an allowlist, also for tools added
    later; a crafted call to anything else is refused). No shopping links, no purchases, no mail.
  - Safe search: only when the owner allows it per kid, through the owner's search provider in
    strict safe-search mode (Brave `safesearch=strict`, SearXNG `safesearch=2`; other providers
    refuse); shop sites and explicit results are left out unless the parent allows a site.
  - Bedtime and an optional daily time limit (5-minute blocks with a message) stop chatting and every
    model call; reading old chats still works.
  - Her tone: a persona note by age band (warm, simple, never romantic, homework hints rather than
    answers, no personal details, a trusted grown-up for big worries). Off-limits asks (sexual
    content, drugs, weapons, gambling, dating) get a kind "not here" without the model; crisis words
    still get the crisis help.
- Parents see **What they talked about**: topics and minutes per day for a week, never the words.
- Voice and pictures start off for a child's invite.

## Grocery lists with stores
- **Groceries → New grocery list** makes a shared list (N7 shared boards) and invites everyone at
  home. Items group by aisle in store order (produce, bakery, dairy and eggs, meat and fish, frozen,
  pantry, snacks, drinks, household, personal care, baby, pets, other), guessed from the words; change
  the aisle or set a store per item.
- **Cheapest near me** (the owner's space, with the shopping helper): find_product checks a few
  staples (milk, eggs, bread…; at most 4) at stores near you and puts the cheapest store and price on
  each. Nothing is bought.
- **Shopping mode**: big checkboxes at phone width, one aisle after another, filtered by store.

## Home and family planner (U4.21)
Two more tabs on the Family page (**Meals**, **Calendar**), a weekly rota on chores, chore reminders,
and more on the Family tile. Same household store; nothing here calls a model.

**Meals.** A week grid with one dinner a day. A parent picks a saved family recipe or types a dinner.
Add a recipe by pasting its text (title on the first line, then the ingredients; an "Ingredients"
heading helps), a recipe page's address (Sara reads the page's schema.org Recipe: most recipe sites
publish one), or a document already in your Library. **Likes and allergies**: each person fills in
their own; parents see and edit everyone's. A dinner whose title or ingredients hit someone's allergy
shows "Allergy: Mia: peanuts" (allergy groups count: shellfish covers shrimp, gluten covers pasta).
**Add to the grocery list** puts the week's ingredients on your grocery list (the first one, or a new
one shared with everyone): the same thing in the same unit is added up ("2 lb chicken thighs"), each
line lands in its aisle, and lines already on the list are not added twice. Or ask her: "plan dinners
for the week": she reads the plan, everyone's allergies and the recipes (`meal_plan_get`), sets the
dinners (`meal_plan_set`, any allergy clash comes back to her) and can fill the list (`meal_shopping`).

**Chores rota.** On a chore, **Take turns…** picks two or more people: the chore moves to the next one
once a week, on the rota day. Kids see what a chore is worth as stars (★) and their star total.
**Reminders**: at the reminder time, each person with chores left gets one push a day, never during
their own quiet hours (Settings → Proactive; it goes out once quiet hours end, the same day).

**Calendar.** The family week: events, the dinner and chores due per day. A parent imports a school or
activity calendar from pasted text (a letter or email), a PDF in the Library, an .ics file or an iCal
link (`webcal://` too): every dated line becomes an event that **waits for a parent's OK**; tick the
ones to add. Anyone adds an event: a parent's family event shows at once, anyone else's waits for a
parent, and **Only me** keeps it private (nobody else sees it, not even the owner).

**Family Today.** The Family tile also shows tonight's dinner, chores left today and the next family
event (it now shows for anyone with one of those, not only when there are chores).

**Settings → Household → Family planner** (owner): dinner time, reminders on/off and their time, and
the rota day.

### Design (one page)
- Store: `src/family-plan.ts` `FamilyPlan` (`planOf(store)`) adds tables to `family.db`:
  `family_recipes`, `family_meals` (one per day), `family_prefs`, `chore_rota`, `family_events`
  (`who` = `family` or a person id; `status` pending/ok/declined), `family_reminded`; settings in
  `family_meta`. Pure readers: `parseIngredient`, `parseRecipeText`, `recipeFromHtml` (JSON-LD),
  `mergeIngredients` (R8 `aisleOf`), `eventsFromText` (inbox `findDate` + bare `11/30`),
  `eventsFromIcs` (calendar-links `linkEvents`).
- Who may: parents change meals, recipes, the rota, settings and imports, and decide pending events;
  a person edits their own likes/allergies and private events; everyone reads the week. Private events
  are filtered in SQL by person; a kid's companion gets only the read-only `family_calendar` (KID_TOOLS).
- Ticks: `familyTick` (owner space) → `familyPlanTick`: rota turns, then reminders via
  `FamilyAccess.notifyPerson`, skipped while `quietFor(person)` (that person's proactive quiet hours).
- Network: recipe pages and iCal links go through `netFetch` from the route only, refused in private
  local mode ("paste the text instead"); pasted text, files and Library documents never leave.
- Web: `web/family-plan.js` (Meals/Calendar tabs, rota editor, stars, the Settings section, tile lines);
  `web/family.js` dispatches to it. Routes: `src/routes/family-plan.ts` (listed below).

## Routes
`/api/family` (member route `family`; audited): overview, chores, marks (approve, reject, photo),
kids (balance, ledger, activity, pay, profile), parents, grocery lists and items, cheapest; U4.21:
`week`, `meals/:day`, `meals/shopping`, `recipes`, `prefs/:person`, `plan-settings`, `rota/:chore`,
`events`, `events/import`, `events/decide`.
