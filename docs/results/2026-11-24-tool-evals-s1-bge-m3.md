# Tool and routing evals

Sara 3.40.0 · 2026-11-24T06:25:56.084Z · no model (offer and route only) · tools also picked by meaning (bge-m3)

- **Offer:** the tool for the job was in the list sent to the model in 109 of 117 cases (93%).
- **Route:** the message went to the expected model in 31 of 33 cases (94%).
- **Held-out cases** (never tuned on): offered in 15 of 18 (83%); routed as expected in 3 of 3.
- **Fresh cases** (written last, run as found): offered in 18 of 20 (90%).
- **Other languages** (a person's own words, five languages): offered in 18 of 20 (90%).
- **Fresh routing cases:** research asks without the usual words reached the research model in 6 of 8; messages that only sound like research stayed with the talking model in 8 of 8.
- **Size:** 31 tools offered on a typical turn (most: 74); the tool list is about 6,374 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| person-note | Remember that my neighbor Luis is allergic to peanuts. | person_note | not offered |
| h-score-beat | Did Arsenal beat Chelsea at the weekend? | sports_scores | not offered |
| h-person-note | Note for later: my boss Karen hates being called before 10. | person_note | not offered |
| h-es-score | ¿Cómo quedó el Barça ayer? | sports_scores | not offered |
| f-unpaid-invoices | Who still owes me money for work I billed? | invoice_list | not offered |
| f-standings | Where are the Celtics in the table right now? | sports_standings | not offered |
| x-de-owed | Wer schuldet mir noch Geld für Arbeit, die ich abgerechnet habe? | invoice_list | not offered |
| x-pt-boss | Guarda isso: minha chefe Carla detesta que liguem para ela antes das 10. | person_note | not offered |
| r-solar | What is the general consensus on home solar panels these days? Check a few place | research_start | went to chat |
| r-school | We are moving to Austin. Could you gather what is out there about the public sch | research_start | went to chat |

## Every case

| Case | Offered | Route | Model |
|---|---|---|---|
| remind-dentist | yes | chat | - |
| remind-indirect | yes | chat | - |
| todo-add | yes | chat | - |
| todo-what | yes | chat | - |
| note-keep | yes | chat | - |
| recall-past | yes | chat | - |
| library-manual | yes | chat | - |
| doc-make | yes | chat | - |
| web-fetch | yes | chat | - |
| web-search | yes | chat | - |
| person-who | yes | chat | - |
| photo-ask | yes | chat | - |
| person-note | NO | chat | - |
| stock-price | yes | chat | - |
| sports-score | yes | chat | - |
| sports-next | yes | chat | - |
| bill-track | yes | chat | - |
| bill-due | yes | chat | - |
| spending | yes | chat | - |
| timer-start | yes | chat | - |
| timer-stop | yes | chat | - |
| invoice | yes | chat | - |
| decide | yes | chat | - |
| compare | yes | chat | - |
| shop-find | yes | chat | - |
| renewal | yes | chat | - |
| upkeep | yes | chat | - |
| price-watch | yes | chat | - |
| team-follow | yes | chat | - |
| tone | yes | chat | - |
| humanize | yes | chat | - |
| forget-fact | yes | chat | - |
| promises | yes | chat | - |
| gift | yes | chat | - |
| meeting | yes | chat | - |
| spreadsheet | yes | chat | - |
| es-remind | yes | chat | - |
| de-stock | yes | chat | - |
| fr-bill | yes | chat | - |
| it-score | yes | chat | - |
| pt-note | yes | chat | - |
| h-score-beat | NO | chat | - |
| h-stock-crypto | yes | chat | - |
| h-timer-track | yes | chat | - |
| h-tone-blunt | yes | chat | - |
| h-humanize-stiff | yes | chat | - |
| h-bill-new | yes | chat | - |
| h-renewal-license | yes | chat | - |
| h-upkeep-oil | yes | chat | - |
| h-watch-flight | yes | chat | - |
| h-decide-job | yes | chat | - |
| h-shop-near | yes | chat | - |
| h-expenses | yes | chat | - |
| h-person-note | NO | chat | - |
| h-recall | yes | chat | - |
| h-es-score | NO | chat | - |
| h-de-bill | yes | chat | - |
| h-fr-research | yes | research | - |
| h-research-into | yes | research | - |
| h-not-research | - | chat | - |
| f-hours-week | yes | chat | - |
| f-new-client | yes | chat | - |
| f-paid-bill | yes | chat | - |
| f-cap-spend | yes | chat | - |
| f-subscriptions | yes | chat | - |
| f-unpaid-invoices | NO | chat | - |
| f-standings | NO | chat | - |
| f-injury | yes | chat | - |
| f-what-you-know | yes | chat | - |
| f-who-waiting | yes | chat | - |
| f-card-text | yes | chat | - |
| f-past-decisions | yes | chat | - |
| f-lease-check | yes | chat | - |
| f-meeting-todos | yes | chat | - |
| f-shared-list | yes | chat | - |
| f-watches | yes | chat | - |
| f-my-address | yes | chat | - |
| f-odds | yes | chat | - |
| f-log-time | yes | chat | - |
| f-quote | yes | chat | - |
| x-es-hours | yes | chat | - |
| x-es-paid | yes | chat | - |
| x-es-standings | yes | chat | - |
| x-es-blunt | yes | chat | - |
| x-fr-client | yes | chat | - |
| x-fr-cap | yes | chat | - |
| x-fr-know | yes | chat | - |
| x-fr-license | yes | chat | - |
| x-de-timer | yes | chat | - |
| x-de-owed | NO | chat | - |
| x-de-oil | yes | chat | - |
| x-de-decide | yes | chat | - |
| x-pt-subs | yes | chat | - |
| x-pt-desk | yes | chat | - |
| x-pt-spent | yes | chat | - |
| x-pt-boss | NO | chat | - |
| x-it-injury | yes | chat | - |
| x-it-store | yes | chat | - |
| x-it-bill | yes | chat | - |
| x-it-stiff | yes | chat | - |
| r-vacuum | yes | research | - |
| r-solar | yes | chat (unexpected) | - |
| r-school | yes | chat (unexpected) | - |
| r-mattress | yes | research | - |
| r-creatine | yes | research | - |
| r-es-coche | yes | research | - |
| r-de-versicherung | yes | research | - |
| r-it-caldaia | yes | research | - |
| r-not-told | - | chat | - |
| r-not-compare | - | chat | - |
| r-not-sum | yes | chat | - |
| r-not-find | yes | chat | - |
| r-not-report | - | chat | - |
| r-not-reviews | - | chat | - |
| r-not-quick | - | chat | - |
| r-not-es | - | chat | - |
| chat-hello | - | chat | - |
| chat-opinion | - | chat | - |
| chat-math | - | chat | - |
| chat-explain | - | chat | - |
| route-research | yes | research | - |
| route-lookup | yes | research | - |
| route-es-research | yes | research | - |
| route-de-research | yes | research | - |
| route-not-research | - | chat | - |
| code-read | yes | coding | - |
| code-tests | yes | coding | - |
| code-find | yes | coding | - |
| code-status | yes | coding | - |
