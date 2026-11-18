# People (people cards)

Phase 101 (ST6, 2.34.0; design: [STAPLES.md §9](design/STAPLES.md)). Sara keeps a card for each person
in your life she hears about: who they are to you (in your words), what she knows about them with
where she learned it, their birthday, and when you last mentioned them. You find it under
**Memory → People**.

## Where cards come from

- **As you talk.** When the memory worker saves a fact or a date about someone else ("my brother Jeff
  got a job at the bakery"), it also says who it is about. Sara matches the name to a card or makes a
  new card marked *to check*. The fact on the card points at the memory it came from. Memories stay
  the source of truth: correct a memory and the card's fact changes with it, forget it and the fact
  goes, and if a newer note replaces it the card shows it under *Replaced by newer notes*.
- **From what she already remembers (the backfill).** On the People page, *Find people in what she
  remembers* reads your existing fact and date notes once, in the background, in batches of 40. It
  uses code alone, or your background model if one is set, within a budget (200k tokens by default).
  Private notes never go to a model. When it's done you get a card: "I found N people in what I
  remember. Check them?"
- **You add one.** *Add a person*, or tell her to note something about someone. Her `person_note`
  tool asks you first.

## Checking proposed people

Nothing about a proposed person is used in her answers until you accept the card, or until you've
mentioned them in three conversations without turning them down. The second way is marked *added on
her own*. In the review each card has its name, who they are, up to three facts with sources, and
four answers:

- **Looks right**
- **Merge with…** (the same person as an existing card)
- **Not a person** (the name is kept only so it isn't suggested again)
- **Forget**

## Two people with the same name

If a name in your message matches several people, she decides in this order:

1. A qualifier in the message wins: "Jeff from work", "my brother", a surname, an alias.
2. Then context: who was just talked about in this conversation; a `-work` channel prefers work
   people; someone mentioned far more often recently.
3. Otherwise she doesn't guess. She is told it could be either and asks you naturally when it
   matters. Your answer becomes an alias on the right card.

Add aliases yourself on the card (*Also called*).

## The card

- Photo or initials
- Who they are and circle (family, partner, friends, work, neighbours, other)
- Birthday (it shows on Today, once a year)
- What she knows, by date. Each fact has its source (your words; the link opens the message) and
  can be corrected, made private, or taken off the card.
- People linked to them ("Lea is Jeff's wife")
- Your own notes, which she reads but never rewrites
- **Merge with…**, **Split…** (move facts that are really about someone else to a new card) and
  **Forget this person**

On a phone the card opens full screen.

## Privacy

- **Your space only.** Cards live in each household member's own space, per companion. Nobody else
  in the household sees your people, and there are no shared people.
- **Private facts.** Facts learned in a private conversation (or ones you mark) carry a lock. They
  are used only in private conversations.
- **Sensitive facts** are health, intimate, money and legal things about someone. They are:
  - folded on the card until you open them;
  - never on Today or in a notification;
  - only brought up when you talk about that person *and* that topic.
- **Never outside.** People cards and facts are never given to:
  - `/v1` (other apps using her as a model)
  - MCP
  - A2A, even with shared notes. An outgoing A2A message that quotes a card is held back.
  - plugins
  - group chats
  - partner conversations (other people talking to her through bridges)
  - webhooks (ST7 must keep this)
- **Forgetting really deletes.** *Forget this person* removes the card, its facts, links, mentions
  and photo, and their search index. Tick the box to also forget the memories they came from (with
  their meaning vectors and search index), which also hides those messages from her.
- **Export.** Export includes your people (proposed and active). Import doesn't bring people in.
  They are rebuilt from memories.

## Keeping in touch

S4 (relationship memory). On top of the cards, Sara keeps track of how you and the people in your
life stay in touch. It is built from what you already connected, and nothing is copied: no message
text is stored, only the sentence of a promise you confirm.

- **Last contact on each channel.** Mail they sent you and mail you sent them (headers of the
  mailboxes in your combined inbox), the chat rooms she keeps up with (Discord, Telegram groups),
  and calendar meetings (past and the next one). Shown on the card and as "in touch 3 days ago"
  on the list.
- **Waiting for your reply.** When their newest mail is newer than anything you sent them and is 3
  or more days old: "Dan has waited 2 weeks for your reply". Lists and newsletters never count.
- **Promises.** "I'll send you the slides by Friday" in your own sent mail, or in your reply to them
  in a chat room, becomes a promise with a due day. It waits as *to confirm* until you answer
  **Yes, I promised** or **Not a promise**. You can add one on the card too, or tell her
  (`person_note` stays for facts). Then: "You promised Ana: send you the slides (by Fri, Nov 20)".
- **Dates.** The birthday on the card, plus anniversaries and other yearly days you add on the card.
  A week ahead.
- **Keep in touch.** Pick how often (every 2 weeks to every year) for people you don't want to lose
  touch with: "You haven't been in touch with Ben for 2 months". **I got in touch** resets it.
- **Email addresses** on the card match mail and meetings. She learns an address by herself when a
  sender uses the card's full name (two words or more).

### Where you see it

- **Memory → People → Needs attention**: everything above, most urgent first (overdue promises,
  long waits, dates, keep in touch), each with its answers (Done, Later for a week, Not needed).
- **Today → People** tile, while someone needs you (birthdays stay on the Dates tile).
- **Ask her**: "who's waiting for my reply?", "what did I promise Ana?" (`people_due`,
  `promise_list`, read-only, run on their own).

### Privacy

- One switch on the People page: **Keep track of contact and promises** (on by default). Off, and
  while you are off the record, nothing is read. Private local mode skips mail and calendars.
- Only chat *rooms* she keeps up with are read, never adult rooms, never your conversations with her
  and never private chats. S9a private messages are never read.
- Private cards stay out of Today and of her answers in normal chats.
- Your space only: each household member's contacts, promises and nudges live in their own space.
- **Forget this person** also deletes their contact rows, promises, dates, addresses and snoozes;
  **Merge** moves them to the card that stays.
- Mail is read on the reminder tick at most every 30 minutes (90 days back the first time), up to
  15 of your sent mails per pass for promises. **Check now** reads at once.

### Design (one page)

| Decision | Why |
| --- | --- |
| Derived rows only (`person_ties`, `person_contact`, `person_promises` in the space's database) | No second copy of mail or chats; forget is one delete |
| Rules, not a model, find promises (English phrasing: "I'll / I will / let me + verb", due words like Friday, tomorrow, next week, Nov 20) | Free, local, predictable; a model pass can come later |
| Every found promise needs a tap | A wrong guess never nags |
| Match by address, learn by full name only | First names alone are ambiguous |
| Rooms: a linked person's lines, and the owner's replies to them | Rooms are where the owner talks to people through Sara's bridges |

Risks: promise rules miss other languages and indirect phrasing (gap); a shared mailbox address can
match the wrong card (edit the addresses). Tests: `test/s4-people.test.ts`.

## Gifts and occasions

Each card has a **Gifts and occasions** part (Memory → People → a person):

- **Next occasions**: the birthday on the card and the yearly dates under Keeping in touch, with how
  many days are left.
- **Budget**: ideas over it are left out. Empty uses the default budget in Settings → You →
  Briefing and reminders → Gifts and occasions.
- **Suggest gift ideas**: up to five ideas with a short reason and a rough price. She uses only what
  she may bring up in a normal chat: never a private card, never a private fact, nothing sensitive
  (health, intimate, money, legal), nothing still unconfirmed and nothing learned in a chat room.
  **Add to shopping list** puts an idea on the Planner's **Gifts** list, due a week before the day.
- **Write a card**: a short card text in your own writing style (Settings → You → About you →
  Writing style), signed with your name. It is a draft you copy; she never sends it.
- **Remind me … days before**: a reminder before each birthday and yearly date (two weeks by
  default). On by default for family and partners and for anyone with a budget or ideas; switch it
  per person here, or for everyone in Settings.

In chat: "gift ideas for Maya under $50" or "write a birthday card for Maya" (tools
`people_gift_ideas`, `people_gift_card`; never in outside apps or group chats). Private cards
answer with a short note and no ideas.

## For developers

| Piece | File |
| --- | --- |
| Store, matching, gate, merge/split/forget | `src/people.ts` |
| Backfill job | `src/people-backfill.ts` |
| Tools `person_lookup`, `people_list` (run on their own), `person_note` (asks) | `src/people-tools.ts` |
| Routes `/api/people…`, `/api/person-facts/:id` | `src/routes/people.ts` |
| Page | `web/people.js`, `web/people.css`, `#memory` in `web/index.html` |
| S4 keeping in touch (contact, promises, dates, nudges, tools `people_due`, `promise_list`) | `src/people-ties.ts`, `src/routes/people-ties.ts`, `web/people-ties.js` |
| Tests | `test/phase101.test.ts`, `test/s4-people.test.ts`, people case in `test/household-isolation.test.ts` |

`PeopleStore.gate()` is the single check every outside path uses. A memory linked to a person, or a
text that names an active person, stays in. New outside paths must call it.
