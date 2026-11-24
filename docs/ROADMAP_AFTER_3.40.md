# Roadmap after 3.40.0

**Closed with 3.42.0 (2026-11-24).** Stages 1 to 5 are built and published; what is left of each is
in docs/BACKLOG.md, and the plan from here is docs/ROADMAP_AFTER_3.42.md.

Written 2026-11-23 by Claude Code at the owner's request ("push 3.4.0 ... then provide a roadmap from
there"). A proposal: the owner decides the order and what ships. Details and evidence for each item
are in docs/BACKLOG.md under the names given here.

## Where things stand

3.37.0 to 3.40.0 (all 2026-11-23) fixed the safety and reliability findings of the X review, the
chat list and pairing, the after-reply freeze and load speed, split the tool executor out of the
turn function, made the newest Claude models work on an API key, and added a way to measure whether
a message reaches the right tool and model (`npm run eval:tools`), with tools now also picked by
meaning. What the measurements say is still weak is the base for this roadmap.

## Stage 1 (3.41): what 3.40.0 started, for everyone

**Built 2026-11-24** (owner: "Start stage 1"), not published. What was measured and what is left:
docs/TOOL_EVALS.md "Third run", docs/handoffs/2026-11-24-s1-meaning-for-all.md. The download offer
(the second half of item 1) is not built; it is in BACKLOG.

Most of 3.40.0's gain needs the Meaning search job, which is off until someone sets it.

1. **Meaning search without setup.** When an embedding model is there (Ollama with
   `nomic-embed-text`), turn the job on in setup, or offer to fetch one. Measure: fresh install,
   `eval:tools` with no flags reaches the 19 of 20 that `--embed` reaches today.
2. **Routing by meaning.** "Look into which air purifiers are worth buying" does not reach the
   research model (held-out routing 1 of 3). The message's vector is already made; compare it with a
   few research asks. Measure: the routing cases.
3. **Other languages.** nomic-embed-text is English. Try a multilingual embedding model (`bge-m3`)
   and recommend it if the non-English cases move.
4. **`find_tools` as the expected move** when nothing in the list fits (one line in her
   instructions). Measure: "only wrote words" against "looked".

BACKLOG: "the short tool list, what is left after Z7".

## Stage 2 (3.42): Claude and model quality

**Partly built 2026-11-24** (owner: "then move to stage 2 - I do not have an API key to test with,
only the subscription to Anthropic for this stage"), not published. Built: item 6 (also for Claude
on a subscription) and the first judge of item 8 (the security review; on Ollama and Claude on a
key). Not built: item 5 (no key), item 7 (needs a key to see), the memory notes of item 8, item 9
(needs the owner's runs). docs/handoffs/2026-11-24-s2-thinking-level.md; BACKLOG "thinking level and
structured answers, what is left after S2".

5. **First real run against the Anthropic API** (owner: a Claude model on an API key as the main and
   the background model). Everything in Z5 follows the published rules and a stand-in server.
6. **A thinking level in Settings** (quick / balanced / thorough), mapped to `reasoning`.
7. **Her words between tool calls on the newest Claude models** (they arrive as thinking blocks with
   no text, so a long job is quiet): `thinking.display: "updates"`.
8. **Judges on structured answers**, one at a time, starting with the security pass and the memory
   notes (`ChatRequest.json` is plumbed and unused).
9. **The clock line for local models** (owner: real-model runs; the code is ready).

BACKLOG: "Claude on the API, what is left after Z5".

## Stage 3 (3.43): speed and structure

**Built 2026-11-24, in 3.41.0:** item 11 (the cause of the broken test was found) and the model
call of item 10. Left: the context assembly of item 10; item 12 still waits for a phone measurement.

10. **The turn function, next two blocks** (context assembly, the model call), by the Z3 method.
11. **The conversation read several times per step** (the cache that broke one browser test for a
    reason not found): find the reason, then keep the cache.
12. **Loading each screen on first open**, only if phone measurements after 3.39.0 show script
    start-up, not the network, is what is slow.

BACKLOG: "debt, the turn function", "debt, the conversation is read several times per model step",
"ux, first load".

## Stage 4: polish

**A first pass 2026-11-24, in 3.41.0** (owner: "things that you see that can be improved on
polish"): the Meaning search row, the backup notice on a new install, "Usage and costs". Looked at
on a new install in a desktop browser only; the Windows app, a phone and the owner's own list (item
13) are still to do.

13. **The owner's list of screens that look unfinished**, the Windows app first.
14. **Her look on engines other than Grok**: edits that keep the face.

## Stage 5: the crisis lines come up too often (owner, 2026-11-24)

**Built 2026-11-24** (owner: "go ahead with stage 5 after the release is published"), on main and
his server, not published. The source was the talking model itself (12 of 22 hard conversations got
a crisis line from `inkling-2-small:cloud`; after, 0, with all 18 danger messages still helped).
docs/CRISIS_EVALS.md; handoff docs/handoffs/2026-11-24-s5-crisis-lines.md.

Owner: "the 'crisis' lines are coming up way too often in the companion chat. Even when having
conversations on a personal level, and they may be difficult conversations but not crisis
conversations, the resort to push the crisis lines seems to happen way too often rather than stay
on topic."

15. **Tell a hard conversation from a crisis.** Grief, a breakup, anger at a boss, loneliness, a bad
    day, talking about someone else's death or a past low point are hard, not a crisis: she stays
    with the person and the subject. The crisis lines are for a person in danger now. The safety
    layer is never switched off; this is about when it speaks.
    - First measure, as with tools: a set of real-shaped messages in six languages, three groups
      (in danger now; hard but not a crisis; only sounds like it: "this job is killing me", song
      lyrics, a film plot, past tense, about someone else), and count how often each check fires
      (the built-in patterns, the optional safety model, and what the instructions tell her to
      add on her own).
    - Then find which of the three is the source, and fix that one: narrower patterns, a second
      look before the lines are added, once per conversation instead of every turn, and words that
      fit into her answer instead of replacing it.
    - Measure: every "in danger now" case still gets the lines; the "hard" and "sounds like"
      groups almost never do.

## Every release from here

- Run `npm run eval:tools` (with `--embed`, and with a local model when there is time) before a
  release and write the numbers into docs/results, so a change that makes tool picking worse shows.
- Add cases as real misses turn up (a message where she reached for the wrong thing is a case).
  Cases for connected accounts (mail, calendar, a computer) are missing: the eval runs a fresh install.

## Waiting on the owner

- A Claude model on an API key, main and background (item 5).
- Reload speed on the phone and in the Windows app (decides item 12).
- A real desktop action and `pc_run` through a connected computer (the paths the Z3 split is least
  covered on).
- Real-model runs for the clock line (item 9).
- The list of screens for the polish pass (item 13).
