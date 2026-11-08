# Trust report

**Settings → Household → Trust report** (owner only; design: `ops/EC2527_DESIGN.md`). One page that sets
what Sara *said* against what her records show actually *ran*, for a reviewer.

- **Report on:** *A week* (seven days from the day you pick; empty = the last seven days, today
  included), *One run* (a chat turn, job or team task by its number, shown in a reply's run details) or
  *One project* (every chat in that planner project; jobs outside a chat show in a week's report).
- **Claims checked:** reply sentences the receipts check flagged: *no receipt* (she said she did
  something and no tool call backs it) or *a receipt says otherwise* (for example "tests pass" after a
  failing run). Only the flagged sentence is shown, never the rest of the chat.
- **Tool calls** per tool (done, failed, not run), **Failed tools** with their clipped output,
  **Approvals** (ran without asking, allowed or denied by a person, refused), **Policy refusals** (the
  policy, a never-allowed tool or the loop guard) and the audit rows refused in the window,
  **Sandbox** tries, **Sources cited** (pages her web tools read or failed to read, searches, and for a
  week the sources of research runs), and the **Audit trail** rows of the window (names and outcomes,
  never content).
- **Download** as Markdown, PDF or Word: the same report as one English document. Each download is
  one `trust.export` row in the audit trail. Lists are capped at 200 rows with "…and N more".
- Household members and the demo can't open it (it spans everyone's work).

Claims come from the receipts check, which is a careful heuristic: a flagged sentence means "not
backed by a receipt", not "false". Nothing is sent anywhere; the page reads records Sara already keeps.
