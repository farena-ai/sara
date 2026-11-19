# W1.1 One memory you can see and steer ("What I know about you")

Roadmap: `docs/design/ROADMAP_W.md` W1.1. One page, no new store.

## What already existed (kept, extended)

- **Settings → You → What Sara knows** (N6, `web/facts.js`, `src/facts.ts`, `/api/facts`): memory facts and dates
  plus facts read in Library documents, grouped (people, home, vehicles, health, work, money, dates, other), each
  with its source, Edit / Delete / Not true; Renewals and paperwork (V2.1), From your documents, Ask your
  documents, the Health log switches.
- **What Sara remembers** (`#memory` dialog, Phase 12/101): every memory kind, People cards, the overnight tidy
  (EC13), how she works with you (C12), memory settings.
- **Action timeline** (V5.1, `src/timeline.ts`) with Undo; **W0.6** ages (`src/time-sense.ts`).

So the "one page" is the existing **What Sara knows** page, made the place to see and steer what she knows. The
Memory dialog stays the place for notes, People cards and memory settings; this page counts and links them.

## The page (top to bottom)

1. Renewals and paperwork (unchanged, stays first).
2. **What she knows** (W1.1): a search box, duplicate suggestions, every fact grouped by topic with its source,
   learned date and age ("yesterday", "3 months ago": W0.6 units, worded by `Intl.RelativeTimeFormat` in the
   page's language), then a strip of what else she keeps.
   - **That's wrong**: edit the words (a memory fact edits the memory itself). Undo on the timeline.
   - **Forget**: removed from what she knows and uses. Undo on the timeline brings the exact row back
     (memories: the whole row with the same id; document facts: active again).
   - **Not true** (N6, unchanged): forgets it for good and never learns it again from the same words.
   - **Why do you think that?**: the message it came from (masked like everywhere: no card or SSN), its time
     and an Open-in-chat link; the document and page for document facts; "you added it yourself". A message
     forgotten earlier is never shown again.
   - **Duplicates**: memory facts in the same topic sharing most words (Jaccard >= 0.7 on stems, at least two
     shared words) are offered as "These look like the same thing". **Merge** keeps the newer one and marks the
     older one replaced (`superseded_by`, so it stays reviewable on the Memory page); Undo on the timeline.
     **Keep both** stops asking about that pair (`memory_kv` `know.keepBoth`).
   - **She also keeps**: counts of People cards, notes from chats, how you like to work, renewals, purchases and
     learned skills, each with Open. The Health log is never counted or shown here: only "Health log: kept
     private" when one exists, opening its own page.
3. From your documents, Ask your documents, Health log switches (unchanged).

## Server

`src/know.ts` on top of `factsFor(app)`; routes ride the existing `facts` family (`src/routes/facts.ts`), so no
new route group, MEMBER_ROUTES or household-isolation churn:

| Route | What |
| --- | --- |
| `GET /api/facts/know?q=` | `{today, total, topics, duplicates, also}` |
| `GET /api/facts/:id/why` | source message / document page |
| `POST /api/facts/:id/forget` | `{timelineId}` |
| `POST /api/facts/:id/wrong {text}` | `{fact, timelineId}` |
| `POST /api/facts/merge {keep, drop}` | `{timelineId}` |
| `POST /api/facts/keep-both {a, b}` | `{ok}` |

Undo is the existing `POST /api/timeline/:id/revert` (reverters `know_forget`, `know_edit`, `know_merge`).

## Household

Everything is per space (each member's own `sara.db`, memory, Library and timeline), and `facts` is already a
member route: a member sees and steers only their own. Tested with two spaces over HTTP.

## Not done / limits

- Forget is the plain delete (exact Undo); hiding the source message too is still Not true / the Memory page's
  Forget. A forgotten memory's meaning vector is dropped and is not rebuilt by Undo until the next embedding pass;
  a People-card link made from it is not restored.
- Duplicates are word-based (no model); document facts are not merged.
