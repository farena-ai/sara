# Tool and routing evals

Sara 3.40.0 · 2026-11-24T06:26:47.047Z · model: qwen3.8:27b-mtp-q4_K_M

- **Offer:** the tool for the job was in the list sent to the model in 86 of 117 cases (74%).
- **Route:** the message went to the expected model in 23 of 33 cases (70%).
- **Choice:** the model's first move was right in 95 of 129 (74%); it looked for tools first in 20, called something else in 6, only wrote words in 8, failed in 0.
- **Where it goes wrong:** with the tool in the list the model was right in 80 of 86 (93%); without it, in 4 of 31 (13%).
- **Held-out cases** (never tuned on): offered in 8 of 18 (44%); routed as expected in 1 of 3.
- **Fresh cases** (written last, run as found): offered in 12 of 20 (60%).
- **Other languages** (a person's own words, five languages): offered in 8 of 20 (40%).
- **Fresh routing cases:** research asks without the usual words reached the research model in 0 of 8; messages that only sound like research stayed with the talking model in 8 of 8.
- **Size:** 26 tools offered on a typical turn (most: 70); the tool list is about 5,633 tokens.

## Worth a look

| Case | Message | Wanted | What happened |
|---|---|---|---|
| web-search | When does daylight saving time end this year? | web_search | model: none |
| person-note | Remember that my neighbor Luis is allergic to peanuts. | person_note | not offered |
| decide | Help me decide between the Honda CR-V and the Toyota RAV4. I care most about rel | decide | model: wrong (web_search, web_search, web_search) |
| h-score-beat | Did Arsenal beat Chelsea at the weekend? | sports_scores | not offered; model: looked (find_tools) |
| h-stock-crypto | What is Bitcoin trading at right now? | market_quote | not offered; model: looked (find_tools) |
| h-timer-track | I am starting on the Miller kitchen job, track my time. | time_start | not offered; model: looked (find_tools) |
| h-tone-blunt | Stop sugarcoating things, just be straight with me. | tune_personality | not offered; model: none |
| h-humanize-stiff | This email reads really stiff, can you loosen it up? "Per my previous message, k | humanize_text | not offered; model: none |
| h-renewal-license | My driving license runs out next August, do not let me miss it. | renewal_add | not offered; model: looked (find_tools) |
| h-upkeep-oil | Got the oil changed on the truck this morning, 82,000 miles. | upkeep_log | not offered |
| h-watch-flight | Let me know if the price of that standing desk goes under 300. | product_watch_add or watch_add | model: wrong (recall) |
| h-decide-job | I have two job offers and cannot pick. One pays more, the other is closer to hom | decide | not offered; model: looked (find_tools) |
| h-person-note | Note for later: my boss Karen hates being called before 10. | person_note | not offered |
| h-es-score | ¿Cómo quedó el Barça ayer? | sports_scores | not offered; model: looked (find_tools) |
| h-fr-research | Peux-tu te renseigner sur les meilleures pompes à chaleur ? | research_start | went to chat |
| h-research-into | I need you to look into which air purifiers are actually worth buying. | research_start | went to chat |
| f-subscriptions | What am I paying for every month that I might have forgotten about? | budget_subscriptions | not offered; model: looked (find_tools) |
| f-unpaid-invoices | Who still owes me money for work I billed? | invoice_list | not offered; model: looked (find_tools) |
| f-standings | Where are the Celtics in the table right now? | sports_standings | not offered; model: looked (find_tools) |
| f-injury | Is anyone on the Yankees hurt at the moment? | team_news | not offered; model: looked (find_tools) |
| f-who-waiting | Is anyone waiting to hear back from me? | people_due | not offered; model: looked (find_tools) |
| f-past-decisions | What big choices have I made lately, and how did they turn out? | decision_list | not offered; model: wrong (ask_everything, note) |
| f-watches | What am I currently being alerted about? | watch_list | not offered; model: looked (find_tools) |
| f-my-address | What shipping address do you have on file for me? | my_details_get | not offered; model: looked (find_tools) |
| x-es-paid | Esta mañana pagué el recibo del agua. | bill_paid | not offered; model: none |
| x-es-standings | ¿En qué puesto va el Real Madrid ahora mismo? | sports_standings | not offered; model: looked (find_tools) |
| x-es-blunt | Deja de endulzarme las cosas, háblame claro. | tune_personality | not offered; model: none |
| x-fr-know | Qu’est-ce que tu sais vraiment sur moi et ma famille ? | facts_list | not offered; model: looked (find_tools) |
| x-fr-license | Mon permis de conduire expire en août prochain, ne me laisse pas l’oublier. | renewal_add | model: wrong (facts_list, library) |
| x-de-timer | Ich fange jetzt mit der Küche bei Müllers an, stopp bitte die Zeit mit. | time_start | not offered; model: looked (find_tools) |
| x-de-owed | Wer schuldet mir noch Geld für Arbeit, die ich abgerechnet habe? | invoice_list | not offered; model: looked (find_tools) |
| x-de-decide | Ich habe zwei Jobangebote und kann mich nicht entscheiden. Eins zahlt mehr, das  | decide | model: none |
| x-pt-subs | O que eu pago todo mês e talvez já tenha esquecido? | budget_subscriptions | not offered; model: looked (find_tools) |
| x-pt-desk | Me avisa se o preço daquela mesa ficar abaixo de 300. | product_watch_add or watch_add | not offered; model: wrong (recall) |
| x-pt-boss | Guarda isso: minha chefe Carla detesta que liguem para ela antes das 10. | person_note | not offered; model: looked (find_tools) |
| x-it-injury | C’è qualche infortunato nell’Inter in questo momento? | team_news | not offered |
| x-it-store | C’è una ferramenta aperta qui vicino? | stores_near | not offered; model: looked (find_tools) |
| x-it-stiff | Questa mail suona troppo rigida, la puoi ammorbidire? "Come da mia precedente, r | humanize_text | not offered; model: none |
| r-vacuum | I keep hearing mixed things about robot vacuums. Can you get to the bottom of wh | research_start | went to chat |
| r-solar | What is the general consensus on home solar panels these days? Check a few place | research_start | went to chat |
| r-school | We are moving to Austin. Could you gather what is out there about the public sch | research_start | went to chat |
| r-mattress | I want a proper rundown of the best mattresses for back pain, with where you got | research_start | went to chat |
| r-creatine | Is creatine actually safe long term? Go through the studies and tell me what the | research_start | went to chat |
| r-es-coche | ¿Me puedes informar bien sobre qué coche eléctrico conviene más ahora mismo, con | research_start | went to chat |
| r-de-versicherung | Kannst du dich mal schlau machen, welche Haftpflichtversicherung gerade am beste | research_start | went to chat |
| r-it-caldaia | Mi fai un quadro completo delle migliori caldaie a condensazione, guardando più  | research_start | went to chat |
| r-not-sum | Sum up what we talked about yesterday, please. | recall | model: none |
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
| gift | yes | chat | right (person_lookup) |
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
| h-watch-flight | yes | chat | wrong (recall) |
| h-decide-job | NO | chat | looked (find_tools) |
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
| f-subscriptions | NO | chat | looked (find_tools) |
| f-unpaid-invoices | NO | chat | looked (find_tools) |
| f-standings | NO | chat | looked (find_tools) |
| f-injury | NO | chat | looked (find_tools) |
| f-what-you-know | yes | chat | right (facts_list) |
| f-who-waiting | NO | chat | looked (find_tools) |
| f-card-text | yes | chat | right (people_gift_card) |
| f-past-decisions | NO | chat | wrong (ask_everything, note) |
| f-lease-check | yes | chat | right (library) |
| f-meeting-todos | yes | chat | right (action_items) |
| f-shared-list | yes | chat | right (household_lists) |
| f-watches | NO | chat | looked (find_tools) |
| f-my-address | NO | chat | looked (find_tools) |
| f-odds | yes | chat | right (odds_math) |
| f-log-time | yes | chat | right (time_add) |
| f-quote | yes | chat | right (invoice_make) |
| x-es-hours | yes | chat | right (time_report) |
| x-es-paid | NO | chat | none |
| x-es-standings | NO | chat | looked (find_tools) |
| x-es-blunt | NO | chat | none |
| x-fr-client | yes | chat | right (client_add) |
| x-fr-cap | yes | chat | right (budget_limit) |
| x-fr-know | NO | chat | looked (find_tools) |
| x-fr-license | yes | chat | wrong (facts_list, library) |
| x-de-timer | NO | chat | looked (find_tools) |
| x-de-owed | NO | chat | looked (find_tools) |
| x-de-oil | yes | chat | right (upkeep_log) |
| x-de-decide | yes | chat | none |
| x-pt-subs | NO | chat | looked (find_tools) |
| x-pt-desk | NO | chat | wrong (recall) |
| x-pt-spent | yes | chat | right (budget_summary) |
| x-pt-boss | NO | chat | looked (find_tools) |
| x-it-injury | NO | chat | right (web_search) |
| x-it-store | NO | chat | looked (find_tools) |
| x-it-bill | yes | chat | right (bill_add) |
| x-it-stiff | NO | chat | none |
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
| r-not-sum | yes | chat | none |
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
| code-read | yes | coding | right (code_map) |
| code-tests | yes | coding | right (shell) |
| code-find | yes | coding | right (code_find) |
| code-status | yes | coding | right (git, git) |
