# Tool and routing evals

Sara 3.40.0 · 2026-11-24T07:52:33.498Z · model: qwen3.8:27b-mtp-q4_K_M · tools also picked by meaning (bge-m3)

- **Offer:** the tool for the job was in the list sent to the model in 17 of 17 cases (100%).
- **Route:** the message went to the expected model in 27 of 29 cases (93%).
- **Choice:** the model's first move was right in 27 of 29 (93%); it looked for tools first in 0, called something else in 2, only wrote words in 0, failed in 0.
- **Where it goes wrong:** with the tool in the list the model was right in 17 of 17 (100%); without it, in 0 of 0 (n/a).
- **Held-out cases** (never tuned on): offered in 2 of 2 (100%); routed as expected in 3 of 3.
- **Fresh routing cases:** research asks without the usual words reached the research model in 6 of 8; messages that only sound like research stayed with the talking model in 8 of 8.
- **Size:** 26 tools offered on a typical turn (most: 46); the tool list is about 5,444 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| r-solar | What is the general consensus on home solar panels these days? Check a few place | research_start | went to chat |
| r-school | We are moving to Austin. Could you gather what is out there about the public sch | research_start | went to chat |
| r-not-told | My doctor told me to look into yoga, so I signed up for a class on Thursday. | no tool | model: wrong (recall, recall) |
| route-not-research | My brother does cancer research in Boston, I am so proud of him. | no tool | model: wrong (note) |

## Every case

| Case | Offered | Route | Model |
|---|---|---|---|
| remind-dentist | yes | chat | right (remind) |
| h-fr-research | yes | research | right (research_start) |
| h-research-into | yes | research | right (research_start) |
| h-not-research | - | chat | right |
| r-vacuum | yes | research | right (research_start) |
| r-solar | yes | chat (unexpected) | right (web_search, web_search) |
| r-school | yes | chat (unexpected) | right (research_start, note) |
| r-mattress | yes | research | right (research_start) |
| r-creatine | yes | research | right (research_start) |
| r-es-coche | yes | research | right (research_start) |
| r-de-versicherung | yes | research | right (research_start) |
| r-it-caldaia | yes | research | right (research_start) |
| r-not-told | - | chat | wrong (recall, recall) |
| r-not-compare | - | chat | right |
| r-not-sum | yes | chat | right (recall) |
| r-not-find | yes | chat | right (note) |
| r-not-report | - | chat | right |
| r-not-reviews | - | chat | right |
| r-not-quick | - | chat | right |
| r-not-es | - | chat | right |
| chat-hello | - | chat | right |
| chat-opinion | - | chat | right |
| chat-math | - | chat | right |
| chat-explain | - | chat | right |
| route-research | yes | research | right (research_start) |
| route-lookup | yes | research | right (web_search) |
| route-es-research | yes | research | right (research_start) |
| route-de-research | yes | research | right (research_start) |
| route-not-research | - | chat | wrong (note) |
