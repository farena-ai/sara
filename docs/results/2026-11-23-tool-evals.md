# Tool and routing evals

Sara 3.39.0 · 2026-11-23T18:30:18.375Z · model: qwen3.8:27b-mtp-q4_K_M

- **Offer:** the tool for the job was in the list sent to the model in 56 of 67 cases (84%).
- **Route:** the message went to the expected model in 15 of 17 cases (88%).
- **Choice:** the model's first move was right in 61 of 73 (84%); it looked for tools first in 5, called something else in 3, only wrote words in 4, failed in 0.
- **Where it goes wrong:** with the tool in the list the model was right in 53 of 56 (95%); without it, in 3 of 11 (27%).
- **Held-out cases** (never tuned on): offered in 8 of 18 (44%); routed as expected in 1 of 3.
- **Size:** 27 tools offered on a typical turn (most: 51); the tool list is about 5,691 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| web-search | When does daylight saving time end this year? | web_search | model: none |
| person-note | Remember that my neighbor Luis is allergic to peanuts. | person_note | not offered; model: looked (find_tools) |
| decide | Help me decide between the Honda CR-V and the Toyota RAV4. I care most about rel | decide | model: wrong (web_search, web_search) |
| h-score-beat | Did Arsenal beat Chelsea at the weekend? | sports_scores | not offered; model: looked (find_tools) |
| h-stock-crypto | What is Bitcoin trading at right now? | market_quote | not offered; model: looked (find_tools) |
| h-timer-track | I am starting on the Miller kitchen job, track my time. | time_start | not offered; model: looked (find_tools) |
| h-tone-blunt | Stop sugarcoating things, just be straight with me. | tune_personality | not offered; model: none |
| h-humanize-stiff | This email reads really stiff, can you loosen it up? "Per my previous message, k | humanize_text | not offered; model: none |
| h-renewal-license | My driving license runs out next August, do not let me miss it. | renewal_add | not offered; model: looked (find_tools) |
| h-upkeep-oil | Got the oil changed on the truck this morning, 82,000 miles. | upkeep_log | not offered |
| h-watch-flight | Let me know if the price of that standing desk goes under 300. | product_watch_add or watch_add | model: wrong (recall, ask_everything) |
| h-decide-job | I have two job offers and cannot pick. One pays more, the other is closer to hom | decide | not offered; model: none |
| h-person-note | Note for later: my boss Karen hates being called before 10. | person_note | not offered |
| h-es-score | ¿Cómo quedó el Barça ayer? | sports_scores | not offered |
| h-fr-research | Peux-tu te renseigner sur les meilleures pompes à chaleur ? | research_start | went to chat |
| h-research-into | I need you to look into which air purifiers are actually worth buying. | research_start | went to chat |
| route-not-research | My brother does cancer research in Boston, I am so proud of him. | no tool | model: wrong (note) |

## Every case

| Case | Offered | Route | Model |
|---|---|---|---|
| remind-dentist | yes | chat | right (remind) |
| remind-indirect | yes | chat | right (remind) |
| todo-add | yes | chat | right (todo) |
| todo-what | yes | chat | right (todo) |
| note-keep | yes | chat | right (note) |
| recall-past | yes | chat | right (recall) |
| library-manual | yes | chat | right (library) |
| doc-make | yes | chat | right (make_document) |
| web-fetch | yes | chat | right (web_fetch) |
| web-search | yes | chat | none |
| person-who | yes | chat | right (person_lookup) |
| photo-ask | yes | chat | right (share_photo) |
| person-note | NO | chat | looked (find_tools) |
| stock-price | yes | chat | right (market_quote) |
| sports-score | yes | chat | right (sports_scores) |
| sports-next | yes | chat | right (sports_schedule) |
| bill-track | yes | chat | right (bill_add) |
| bill-due | yes | chat | right (bill_list) |
| spending | yes | chat | right (budget_summary) |
| timer-start | yes | chat | right (time_start) |
| timer-stop | yes | chat | right (time_stop) |
| invoice | yes | chat | right (invoice_make) |
| decide | yes | chat | wrong (web_search, web_search) |
| compare | yes | chat | right (web_search, web_search, web_search) |
| shop-find | yes | chat | right (find_product) |
| renewal | yes | chat | right (renewal_add) |
| upkeep | yes | chat | right (upkeep_log) |
| price-watch | yes | chat | right (watch_add) |
| team-follow | yes | chat | right (team_follow) |
| tone | yes | chat | right (tune_personality) |
| humanize | yes | chat | right (humanize_text) |
| forget-fact | yes | chat | right (fact_forget) |
| promises | yes | chat | right (promise_list) |
| gift | yes | chat | right (people_gift_ideas) |
| meeting | yes | chat | right (meeting_list) |
| spreadsheet | yes | chat | right (library) |
| es-remind | yes | chat | right (remind) |
| de-stock | yes | chat | right (market_quote) |
| fr-bill | yes | chat | right (bill_list) |
| it-score | yes | chat | right (sports_scores) |
| pt-note | yes | chat | right (note) |
| h-score-beat | NO | chat | looked (find_tools) |
| h-stock-crypto | NO | chat | looked (find_tools) |
| h-timer-track | NO | chat | looked (find_tools) |
| h-tone-blunt | NO | chat | none |
| h-humanize-stiff | NO | chat | none |
| h-bill-new | yes | chat | right (bill_add) |
| h-renewal-license | NO | chat | looked (find_tools) |
| h-upkeep-oil | NO | chat | right (note) |
| h-watch-flight | yes | chat | wrong (recall, ask_everything) |
| h-decide-job | NO | chat | none |
| h-shop-near | yes | chat | right (stores_near) |
| h-expenses | yes | chat | right (budget_summary) |
| h-person-note | NO | chat | right (note) |
| h-recall | yes | chat | right (recall) |
| h-es-score | NO | chat | right (web_search) |
| h-de-bill | yes | chat | right (invoice_list, bill_list) |
| h-fr-research | yes | chat (unexpected) | right (research_start) |
| h-research-into | yes | chat (unexpected) | right (research_start) |
| h-not-research | - | chat | right |
| chat-hello | - | chat | right |
| chat-opinion | - | chat | right |
| chat-math | - | chat | right |
| chat-explain | - | chat | right |
| route-research | yes | research | right (research_start) |
| route-lookup | yes | research | right (research_start) |
| route-es-research | yes | research | right (research_start) |
| route-de-research | yes | research | right (research_start) |
| route-not-research | - | chat | wrong (note) |
| code-read | yes | coding | right (list_dir, code_map) |
| code-tests | yes | coding | right (list_dir, shell) |
| code-find | yes | coding | right (code_find, code_find) |
| code-status | yes | coding | right (git, git) |
