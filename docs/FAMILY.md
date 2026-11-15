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

## Routes
`/api/family` (member route `family`; audited): overview, chores, marks (approve, reject, photo),
kids (balance, ledger, activity, pay, profile), parents, grocery lists and items, cheapest.
