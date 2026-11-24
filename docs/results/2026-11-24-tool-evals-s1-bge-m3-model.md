# Tool and routing evals

Sara 3.40.0 · 2026-11-24T06:44:14.099Z · model: qwen3.8:27b-mtp-q4_K_M · tools also picked by meaning (bge-m3)

- **Offer:** the tool for the job was in the list sent to the model in 107 of 117 cases (91%).
- **Route:** the message went to the expected model in 23 of 33 cases (70%).
- **Choice:** the model's first move was right in 103 of 129 (80%); it looked for tools first in 6, called something else in 4, only wrote words in 4, failed in 12.
- **Where it goes wrong:** with the tool in the list the model was right in 91 of 107 (85%); without it, in 4 of 10 (40%).
- **Held-out cases** (never tuned on): offered in 13 of 18 (72%); routed as expected in 1 of 3.
- **Fresh cases** (written last, run as found): offered in 18 of 20 (90%).
- **Other languages** (a person's own words, five languages): offered in 18 of 20 (90%).
- **Fresh routing cases:** research asks without the usual words reached the research model in 0 of 8; messages that only sound like research stayed with the talking model in 8 of 8.
- **Size:** 31 tools offered on a typical turn (most: 74); the tool list is about 6,307 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| web-search | When does daylight saving time end this year? | web_search | model: none |
| person-note | Remember that my neighbor Luis is allergic to peanuts. | person_note | not offered |
| decide | Help me decide between the Honda CR-V and the Toyota RAV4. I care most about rel | decide | model: wrong (web_search, web_search, web_search) |
| h-score-beat | Did Arsenal beat Chelsea at the weekend? | sports_scores | not offered; model: looked (find_tools) |
| h-stock-crypto | What is Bitcoin trading at right now? | market_quote | not offered; model: looked (find_tools) |
| h-timer-track | I am starting on the Miller kitchen job, track my time. | time_start | not offered; model: looked (find_tools) |
| h-renewal-license | My driving license runs out next August, do not let me miss it. | renewal_add | model: none |
| h-watch-flight | Let me know if the price of that standing desk goes under 300. | product_watch_add or watch_add | model: wrong (recall, product_watch_list) |
| h-decide-job | I have two job offers and cannot pick. One pays more, the other is closer to hom | decide | model: none |
| h-person-note | Note for later: my boss Karen hates being called before 10. | person_note | not offered |
| h-es-score | ¿Cómo quedó el Barça ayer? | sports_scores | not offered |
| h-fr-research | Peux-tu te renseigner sur les meilleures pompes à chaleur ? | research_start | went to chat |
| h-research-into | I need you to look into which air purifiers are actually worth buying. | research_start | went to chat |
| f-unpaid-invoices | Who still owes me money for work I billed? | invoice_list | not offered; model: looked (find_tools) |
| f-standings | Where are the Celtics in the table right now? | sports_standings | not offered; model: looked (find_tools) |
| x-de-owed | Wer schuldet mir noch Geld für Arbeit, die ich abgerechnet habe? | invoice_list | not offered; model: looked (find_tools) |
| x-de-oil | Heute Morgen Ölwechsel beim Transporter gemacht, 132.000 Kilometer. | upkeep_log | model: wrong (upkeep_list) |
| x-de-decide | Ich habe zwei Jobangebote und kann mich nicht entscheiden. Eins zahlt mehr, das  | decide | model: none |
| x-pt-desk | Me avisa se o preço daquela mesa ficar abaixo de 300. | product_watch_add or watch_add | model: wrong (product_watch_list, recall) |
| x-pt-boss | Guarda isso: minha chefe Carla detesta que liguem para ela antes das 10. | person_note | not offered |
| r-vacuum | I keep hearing mixed things about robot vacuums. Can you get to the bottom of wh | research_start | went to chat |
| r-solar | What is the general consensus on home solar panels these days? Check a few place | research_start | went to chat |
| r-school | We are moving to Austin. Could you gather what is out there about the public sch | research_start | went to chat |
| r-mattress | I want a proper rundown of the best mattresses for back pain, with where you got | research_start | went to chat |
| r-creatine | Is creatine actually safe long term? Go through the studies and tell me what the | research_start | went to chat |
| r-es-coche | ¿Me puedes informar bien sobre qué coche eléctrico conviene más ahora mismo, con | research_start | went to chat |
| r-de-versicherung | Kannst du dich mal schlau machen, welche Haftpflichtversicherung gerade am beste | research_start | went to chat |
| r-it-caldaia | Mi fai un quadro completo delle migliori caldaie a condensazione, guardando più  | research_start | went to chat |
| chat-opinion | Do you think it is rude to leave a party without saying goodbye? | no tool | error: model server: fetch failed; model: error |
| chat-math | What is 15 percent of 80? | no tool | error: model server: fetch failed; model: error |
| chat-explain | Explain in two sentences why the sky is blue. | no tool | error: model server: fetch failed; model: error |
| route-research | Research the best budget e-readers and what people are saying about them. | research_start | error: model server: fetch failed; model: error |
| route-lookup | Look up how much a heat pump costs to run in a cold climate. | web_search | error: model server: fetch failed; model: error |
| route-es-research | Investiga cuáles son los mejores lectores electrónicos baratos. | research_start | error: model server: fetch failed; model: error |
| route-de-research | Recherchiere bitte, was eine Wärmepumpe im Betrieb kostet. | research_start | error: model server: fetch failed; model: error |
| route-not-research | My brother does cancer research in Boston, I am so proud of him. | no tool | error: model server: fetch failed; model: error |
| code-read | What does the main function in this project do? | read_file or code_find or code_map | error: model server: fetch failed; model: error |
| code-tests | Run the tests and tell me what fails. | shell or start_job | error: model server: fetch failed; model: error |
| code-find | Where is the function that parses dates defined? | code_find or search | error: model server: fetch failed; model: error |
| code-status | What have I changed since the last commit? | git | error: model server: fetch failed; model: error |

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
| person-note | NO | chat | right (note) |
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
| h-tone-blunt | yes | chat | right (tune_personality) |
| h-humanize-stiff | yes | chat | right (humanize_text) |
| h-bill-new | yes | chat | right (bill_add) |
| h-renewal-license | yes | chat | none |
| h-upkeep-oil | yes | chat | right (upkeep_log) |
| h-watch-flight | yes | chat | wrong (recall, product_watch_list) |
| h-decide-job | yes | chat | none |
| h-shop-near | yes | chat | right (stores_near) |
| h-expenses | yes | chat | right (budget_summary) |
| h-person-note | NO | chat | right (note) |
| h-recall | yes | chat | right (recall) |
| h-es-score | NO | chat | right (web_search) |
| h-de-bill | yes | chat | right (invoice_list, bill_list) |
| h-fr-research | yes | chat (unexpected) | right (research_start) |
| h-research-into | yes | chat (unexpected) | right (research_start) |
| h-not-research | - | chat | right |
| f-hours-week | yes | chat | right (time_report) |
| f-new-client | yes | chat | right (client_add) |
| f-paid-bill | yes | chat | right (bill_paid) |
| f-cap-spend | yes | chat | right (budget_limit) |
| f-subscriptions | yes | chat | right (budget_subscriptions, bill_list) |
| f-unpaid-invoices | NO | chat | looked (find_tools) |
| f-standings | NO | chat | looked (find_tools) |
| f-injury | yes | chat | right (team_news) |
| f-what-you-know | yes | chat | right (facts_list) |
| f-who-waiting | yes | chat | right (follow_ups) |
| f-card-text | yes | chat | right (people_gift_card) |
| f-past-decisions | yes | chat | right (decision_list) |
| f-lease-check | yes | chat | right (library) |
| f-meeting-todos | yes | chat | right (action_items) |
| f-shared-list | yes | chat | right (household_lists) |
| f-watches | yes | chat | right (watch_list) |
| f-my-address | yes | chat | right (my_details_get) |
| f-odds | yes | chat | right (odds_math) |
| f-log-time | yes | chat | right (time_add) |
| f-quote | yes | chat | right (invoice_make) |
| x-es-hours | yes | chat | right (time_report) |
| x-es-paid | yes | chat | right (bill_paid) |
| x-es-standings | yes | chat | right (sports_standings) |
| x-es-blunt | yes | chat | right (tune_personality) |
| x-fr-client | yes | chat | right (client_add) |
| x-fr-cap | yes | chat | right (budget_limit) |
| x-fr-know | yes | chat | right (facts_list) |
| x-fr-license | yes | chat | right (renewal_add) |
| x-de-timer | yes | chat | right (time_start) |
| x-de-owed | NO | chat | looked (find_tools) |
| x-de-oil | yes | chat | wrong (upkeep_list) |
| x-de-decide | yes | chat | none |
| x-pt-subs | yes | chat | right (budget_subscriptions, bill_list) |
| x-pt-desk | yes | chat | wrong (product_watch_list, recall) |
| x-pt-spent | yes | chat | right (budget_summary) |
| x-pt-boss | NO | chat | right (note) |
| x-it-injury | yes | chat | right (team_news) |
| x-it-store | yes | chat | right (stores_near) |
| x-it-bill | yes | chat | right (bill_add) |
| x-it-stiff | yes | chat | right (humanize_text) |
| r-vacuum | yes | chat (unexpected) | right (research_start) |
| r-solar | yes | chat (unexpected) | right (web_search, web_search) |
| r-school | yes | chat (unexpected) | right (research_start) |
| r-mattress | yes | chat (unexpected) | right (research_start) |
| r-creatine | yes | chat (unexpected) | right (research_start) |
| r-es-coche | yes | chat (unexpected) | right (research_start) |
| r-de-versicherung | yes | chat (unexpected) | right (research_start) |
| r-it-caldaia | yes | chat (unexpected) | right (research_start) |
| r-not-told | - | chat | right |
| r-not-compare | - | chat | right |
| r-not-sum | yes | chat | right (recall) |
| r-not-find | yes | chat | right (note) |
| r-not-report | - | chat | right |
| r-not-reviews | - | chat | right |
| r-not-quick | - | chat | right |
| r-not-es | - | chat | right |
| chat-hello | - | chat | right |
| chat-opinion | - | chat | error |
| chat-math | - | chat | error |
| chat-explain | - | chat | error |
| route-research | yes | research | error |
| route-lookup | yes | research | error |
| route-es-research | yes | research | error |
| route-de-research | yes | research | error |
| route-not-research | - | chat | error |
| code-read | yes | coding | error |
| code-tests | yes | coding | error |
| code-find | yes | coding | error |
| code-status | yes | coding | error |
