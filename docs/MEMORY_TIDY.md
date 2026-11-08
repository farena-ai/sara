# Overnight memory tidy

Off until you turn it on: Memory → **Overnight tidy** → *Tidy her memory at night*. Once a night,
in your quiet hours (Settings → when she may message you), when nobody has written for half an
hour, she tidies her notes about you. **She never deletes anything.**

Design: [ops/EC1213_DESIGN.md](ops/EC1213_DESIGN.md).

## What she does

1. **Merges duplicates.** Two notes that say the same thing become one: the copy is marked as
   replaced by the kept note (pinned first, then the more used, then the older).
2. **Asks about notes that disagree** ("Alex drinks coffee every day" and "Alex no longer drinks
   coffee"). Nothing changes until you answer on the card: *Keep the newer*, *Keep the older* or
   *Keep both*.
3. **Sums up old threads.** Three or more conversation notes from one chat, older than 90 days,
   become one short summary; the old ones are archived (still searchable, no longer brought to
   mind). This step needs a model.

In the morning a card in your most recent chat says what changed. *What changed* lists each change
with **Undo**, and each disagreement with its three answers (an answer can be undone too).
**Tidy now** runs it at once.

## Which model

*Models on this computer only* (the default): your notes never leave it. Without such a model the
duplicates and disagreements are still found (by code) and old threads wait. *Any model*: ordinary
notes may go to your usual model; notes from **private chats** and notes tied to a person's
**health, money, love life or legal trouble** (People) still only go to a model on this computer.

The same notes are never merged with notes from elsewhere: a private chat's notes only with notes
of that chat, and a note tied to a private or sensitive person fact with none.

## Household members

Each member has their own tidy over their own notes (Memory → Overnight tidy in their space).
Nothing crosses from one space to another.

## For admins

Policy pin **Overnight memory tidy**: *Models on this computer only* (nobody may pick *Any
model*) or *Off* (no tidy on the server). Changes to the tidy (settings, Tidy now, Undo, answers)
are audit rows `memory-tidy.*`.
