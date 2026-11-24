# Tool and routing evals

Sara 3.39.0 · 2026-11-24T02:03:41.069Z · model: qwen3.8:27b-mtp-q4_K_M · tools also picked by meaning (nomic-embed-text)

- **Offer:** the tool for the job was in the list sent to the model in 82 of 87 cases (94%).
- **Route:** the message went to the expected model in 15 of 17 cases (88%).
- **Choice:** the model's first move was right in 85 of 93 (91%); it looked for tools first in 1, called something else in 3, only wrote words in 3, failed in 1.
- **Where it goes wrong:** with the tool in the list the model was right in 77 of 82 (94%); without it, in 2 of 5 (40%).
- **Held-out cases** (never tuned on): offered in 14 of 18 (78%); routed as expected in 1 of 3.
- **Fresh cases** (written last, run as found): offered in 19 of 20 (95%).
- **Size:** 31 tools offered on a typical turn (most: 74); the tool list is about 6,529 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| web-search | When does daylight saving time end this year? | web_search | model: none |
| decide | Help me decide between the Honda CR-V and the Toyota RAV4. I care most about rel | decide | model: wrong (web_search, web_search, web_search) |
| spreadsheet | In the sales spreadsheet I uploaded, which month had the highest total? | analyze_table | error: model server answered 500: {"error":"XML syntax error on line 5: unexpected EOF"}; model: error |
| h-humanize-stiff | This email reads really stiff, can you loosen it up? "Per my previous message, k | humanize_text | not offered; model: none |
| h-renewal-license | My driving license runs out next August, do not let me miss it. | renewal_add | model: wrong (facts_list, library) |
| h-watch-flight | Let me know if the price of that standing desk goes under 300. | product_watch_add or watch_add | model: wrong (recall) |
| h-decide-job | I have two job offers and cannot pick. One pays more, the other is closer to hom | decide | not offered; model: none |
| h-person-note | Note for later: my boss Karen hates being called before 10. | person_note | not offered |
| h-es-score | ¿Cómo quedó el Barça ayer? | sports_scores | not offered; model: looked (find_tools) |
| h-fr-research | Peux-tu te renseigner sur les meilleures pompes à chaleur ? | research_start | went to chat |
| h-research-into | I need you to look into which air purifiers are actually worth buying. | research_start | went to chat |
| f-injury | Is anyone on the Yankees hurt at the moment? | team_news | not offered |

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
| person-note | yes | chat | right (person_note) |
| stock-price | yes | chat | right (market_quote) |
| sports-score | yes | chat | right (sports_scores) |
| sports-next | yes | chat | right (sports_schedule) |
| bill-track | yes | chat | right (bill_add) |
| bill-due | yes | chat | right (bill_list) |
| spending | yes | chat | right (budget_summary) |
| timer-start | yes | chat | right (time_start) |
| timer-stop | yes | chat | right (time_stop) |
| invoice | yes | chat | right (invoice_make) |
| decide | yes | chat | wrong (web_search, web_search, web_search) |
| compare | yes | chat | right (web_search, web_search, web_search) |
| shop-find | yes | chat | right (find_product) |
| renewal | yes | chat | right (renewal_add) |
| upkeep | yes | chat | right (upkeep_log) |
| price-watch | yes | chat | right (watch_add) |
| team-follow | yes | chat | right (team_follow) |
| tone | yes | chat | right (tune_personality) |
| humanize | yes | chat | right (humanize_text) |
| forget-fact | yes | chat | right (fact_forget) |
| promises | yes | chat | right (promise_list, people_due) |
| gift | yes | chat | right (people_gift_ideas) |
| meeting | yes | chat | right (meeting_list) |
| spreadsheet | yes | chat | error |
| es-remind | yes | chat | right (remind) |
| de-stock | yes | chat | right (market_quote) |
| fr-bill | yes | chat | right (bill_list) |
| it-score | yes | chat | right (sports_scores) |
| pt-note | yes | chat | right (note) |
| h-score-beat | yes | chat | right (sports_scores) |
| h-stock-crypto | yes | chat | right (market_quote) |
| h-timer-track | yes | chat | right (time_start) |
| h-tone-blunt | yes | chat | right (tune_personality) |
| h-humanize-stiff | NO | chat | none |
| h-bill-new | yes | chat | right (bill_add) |
| h-renewal-license | yes | chat | wrong (facts_list, library) |
| h-upkeep-oil | yes | chat | right (upkeep_log) |
| h-watch-flight | yes | chat | wrong (recall) |
| h-decide-job | NO | chat | none |
| h-shop-near | yes | chat | right (stores_near) |
| h-expenses | yes | chat | right (budget_summary) |
| h-person-note | NO | chat | right (note) |
| h-recall | yes | chat | right (recall) |
| h-es-score | NO | chat | looked (find_tools) |
| h-de-bill | yes | chat | right (invoice_list, bill_list) |
| h-fr-research | yes | chat (unexpected) | right (research_start) |
| h-research-into | yes | chat (unexpected) | right (research_start) |
| h-not-research | - | chat | right |
| f-hours-week | yes | chat | right (time_report) |
| f-new-client | yes | chat | right (client_add) |
| f-paid-bill | yes | chat | right (bill_list) |
| f-cap-spend | yes | chat | right (budget_limit) |
| f-subscriptions | yes | chat | right (budget_subscriptions) |
| f-unpaid-invoices | yes | chat | right (invoice_list) |
| f-standings | yes | chat | right (sports_standings) |
| f-injury | NO | chat | right (web_search) |
| f-what-you-know | yes | chat | right (facts_list) |
| f-who-waiting | yes | chat | right (follow_ups) |
| f-card-text | yes | chat | right (person_lookup) |
| f-past-decisions | yes | chat | right (decision_list) |
| f-lease-check | yes | chat | right (library) |
| f-meeting-todos | yes | chat | right (action_items) |
| f-shared-list | yes | chat | right (household_lists) |
| f-watches | yes | chat | right (watch_list) |
| f-my-address | yes | chat | right (my_details_get) |
| f-odds | yes | chat | right (odds_math) |
| f-log-time | yes | chat | right (time_add) |
| f-quote | yes | chat | right (invoice_make) |
| chat-hello | - | chat | right |
| chat-opinion | - | chat | right |
| chat-math | - | chat | right |
| chat-explain | - | chat | right |
| route-research | yes | research | right (research_start) |
| route-lookup | yes | research | right (web_search, web_search) |
| route-es-research | yes | research | right (research_start) |
| route-de-research | yes | research | right (web_search) |
| route-not-research | - | chat | right |
| code-read | yes | coding | right (code_map) |
| code-tests | yes | coding | right (list_dir) |
| code-find | yes | coding | right (code_find, code_find) |
| code-status | yes | coding | right (git, git) |
