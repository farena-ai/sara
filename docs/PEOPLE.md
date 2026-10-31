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

## For developers

| Piece | File |
| --- | --- |
| Store, matching, gate, merge/split/forget | `src/people.ts` |
| Backfill job | `src/people-backfill.ts` |
| Tools `person_lookup`, `people_list` (run on their own), `person_note` (asks) | `src/people-tools.ts` |
| Routes `/api/people…`, `/api/person-facts/:id` | `src/routes/people.ts` |
| Page | `web/people.js`, `web/people.css`, `#memory` in `web/index.html` |
| Tests | `test/phase101.test.ts`, people case in `test/household-isolation.test.ts` |

`PeopleStore.gate()` is the single check every outside path uses. A memory linked to a person, or a
text that names an active person, stays in. New outside paths must call it.
