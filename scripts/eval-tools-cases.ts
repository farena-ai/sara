// Z6: the cases for scripts/eval-tools.ts. Each is one message a person might send, with the tool
// that should do the job (`want`), other tools that would also be a fine first move (`alsoFine`),
// and, where it matters, the model the message should go to (`route`).
//
// Keep them plain and varied: how people really ask, not the tool's own words. A case that wants no
// tool (`want: []`) checks that she does not reach for one when someone is just talking. The cases
// only use tools a fresh Sara has (no connected mailbox, calendar or computer).
import type { RouteName } from './eval-tools.ts';

export interface EvalCase {
  id: string;
  text: string;
  want: string[];
  alsoFine?: string[];
  route?: RouteName;
  /** A coding conversation. */
  coding?: boolean;
}

export const CASES: EvalCase[] = [
  // Everyday: the core list.
  { id: 'remind-dentist', text: 'Remind me to call the dentist tomorrow at 9.', want: ['remind'], route: 'chat' },
  { id: 'remind-indirect', text: "Don't let me forget the bins go out Thursday evening.", want: ['remind'], alsoFine: ['todo'] },
  { id: 'todo-add', text: 'Add "renew the car insurance" to my to-do list, high priority.', want: ['todo'] },
  { id: 'todo-what', text: "What's still on my list for this week?", want: ['todo'], alsoFine: ['remind', 'agenda_list'] },
  { id: 'note-keep', text: 'Write this down: the wifi password at the cabin is on the fridge, and the key is under the blue pot.', want: ['note'] },
  { id: 'recall-past', text: 'What did we decide about the kitchen paint a few weeks ago?', want: ['recall'], alsoFine: ['ask_everything', 'decision_list'] },
  { id: 'library-manual', text: 'Check the dishwasher manual I gave you: what does error E24 mean?', want: ['library'], alsoFine: ['ask_everything'] },
  { id: 'doc-make', text: 'Make me a one-page Word document with a packing list for a week of camping.', want: ['make_document'] },
  { id: 'web-fetch', text: 'Read https://example.com/returns and tell me how long I have to send something back.', want: ['web_fetch'] },
  { id: 'web-search', text: 'When does daylight saving time end this year?', want: ['web_search'], alsoFine: ['web_fetch'] },
  { id: 'person-who', text: "When is my sister Dana's birthday?", want: ['person_lookup'], alsoFine: ['people_list', 'facts_list', 'recall'] },
  { id: 'photo-ask', text: 'Send me a picture of you, I want to see what you are up to.', want: ['share_photo', 'take_photo'] },

  // Named by what the person wants, not by the tool: these depend on the short list picking them up.
  { id: 'person-note', text: 'Remember that my neighbor Luis is allergic to peanuts.', want: ['person_note'], alsoFine: ['note', 'person_lookup'] },
  { id: 'stock-price', text: 'How is Apple stock doing today?', want: ['market_quote'], alsoFine: ['web_search'] },
  { id: 'sports-score', text: 'Did the Packers win last night?', want: ['sports_scores'], alsoFine: ['web_search', 'team_news'] },
  { id: 'sports-next', text: 'When do the Lakers play next?', want: ['sports_schedule'], alsoFine: ['web_search'] },
  { id: 'bill-track', text: 'Keep track of my electric bill: about 120 dollars, due on the 15th of every month.', want: ['bill_add'], alsoFine: ['remind'] },
  { id: 'bill-due', text: 'Which bills are due soon?', want: ['bill_list'] },
  { id: 'spending', text: 'How much did I spend on groceries last month?', want: ['budget_summary'], alsoFine: ['purchases_list', 'expense_report'] },
  { id: 'timer-start', text: 'Start the clock, I am working on the Henderson project now.', want: ['time_start'] },
  { id: 'timer-stop', text: "Okay I'm done for the day, stop the timer.", want: ['time_stop'] },
  { id: 'invoice', text: 'Make an invoice for Acme Co: 6 hours of consulting at 90 dollars an hour.', want: ['invoice_make'], alsoFine: ['time_invoice', 'client_add'] },
  { id: 'decide', text: 'Help me decide between the Honda CR-V and the Toyota RAV4. I care most about reliability, then price.', want: ['decide'], alsoFine: ['compare', 'ask_choice'] },
  { id: 'compare', text: 'Put the Kindle, the Kobo Clara and the Boox Page side by side for me.', want: ['compare'], alsoFine: ['find_product', 'web_search', 'research_start'] },
  { id: 'shop-find', text: 'Where can I buy a 10 mm socket wrench near me today?', want: ['find_product'], alsoFine: ['stores_near', 'web_search'] },
  { id: 'renewal', text: 'My passport expires on March 3, 2028. Keep an eye on that for me.', want: ['renewal_add'], alsoFine: ['remind'] },
  { id: 'upkeep', text: 'I changed the furnace filter today.', want: ['upkeep_log'], alsoFine: ['note'] },
  { id: 'price-watch', text: 'Tell me when Nvidia drops below 100 dollars.', want: ['watch_add'] },
  { id: 'team-follow', text: 'I want to follow the Chicago Cubs this season.', want: ['team_follow'] },
  { id: 'tone', text: 'Can you be a bit less formal with me from now on?', want: ['tune_personality'] },
  { id: 'humanize', text: 'This sounds like a robot wrote it, make it sound like a person: "We are pleased to inform you that your request has been processed successfully."', want: ['humanize_text'], alsoFine: [] },
  { id: 'forget-fact', text: "Forget that I work at the bakery, that's not true anymore.", want: ['fact_forget'], alsoFine: ['facts_list'] },
  { id: 'promises', text: 'What have I promised people that I still owe them?', want: ['promise_list'], alsoFine: ['people_due', 'follow_ups'] },
  { id: 'gift', text: 'Any gift ideas for my dad? His birthday is coming up.', want: ['people_gift_ideas'], alsoFine: ['person_lookup'] },
  { id: 'meeting', text: 'What came out of my last meeting?', want: ['meeting_list', 'meeting_summarize'], alsoFine: ['recall'] },
  { id: 'spreadsheet', text: 'In the sales spreadsheet I uploaded, which month had the highest total?', want: ['analyze_table'], alsoFine: ['library'] },

  // Other languages (the short list knows six).
  { id: 'es-remind', text: 'Recuérdame comprar leche mañana por la mañana.', want: ['remind'], alsoFine: ['todo'] },
  { id: 'de-stock', text: 'Wie steht die Tesla-Aktie heute?', want: ['market_quote'], alsoFine: ['web_search'] },
  { id: 'fr-bill', text: 'Quelles factures dois-je payer bientôt ?', want: ['bill_list'] },
  { id: 'it-score', text: 'Com’è finita la partita della Juventus ieri sera?', want: ['sports_scores'], alsoFine: ['web_search', 'team_news'] },
  { id: 'pt-note', text: 'Anota aí: o código do portão é 4471.', want: ['note'] },

  // Held out: written after the word lists were tuned on the cases above, and not tuned on. Their
  // misses are left as they are found, so the score here is the honest one (ids start with h-).
  { id: 'h-score-beat', text: 'Did Arsenal beat Chelsea at the weekend?', want: ['sports_scores'], alsoFine: ['web_search', 'team_news'] },
  { id: 'h-stock-crypto', text: 'What is Bitcoin trading at right now?', want: ['market_quote'], alsoFine: ['web_search'] },
  { id: 'h-timer-track', text: 'I am starting on the Miller kitchen job, track my time.', want: ['time_start'] },
  { id: 'h-tone-blunt', text: 'Stop sugarcoating things, just be straight with me.', want: ['tune_personality'] },
  { id: 'h-humanize-stiff', text: 'This email reads really stiff, can you loosen it up? "Per my previous message, kindly revert at your earliest convenience."', want: ['humanize_text'] },
  { id: 'h-bill-new', text: 'My internet is 65 a month and comes out on the 3rd, add it to my bills.', want: ['bill_add'] },
  { id: 'h-renewal-license', text: 'My driving license runs out next August, do not let me miss it.', want: ['renewal_add'], alsoFine: ['remind'] },
  { id: 'h-upkeep-oil', text: 'Got the oil changed on the truck this morning, 82,000 miles.', want: ['upkeep_log'], alsoFine: ['note'] },
  { id: 'h-watch-flight', text: 'Let me know if the price of that standing desk goes under 300.', want: ['product_watch_add', 'watch_add'] },
  { id: 'h-decide-job', text: 'I have two job offers and cannot pick. One pays more, the other is closer to home.', want: ['decide'], alsoFine: ['ask_choice', 'compare'] },
  { id: 'h-shop-near', text: 'Is there a hardware store open near me?', want: ['stores_near'], alsoFine: ['find_product', 'web_search'] },
  { id: 'h-expenses', text: 'What did I spend on eating out in October?', want: ['budget_summary'], alsoFine: ['purchases_list', 'expense_report'] },
  { id: 'h-person-note', text: 'Note for later: my boss Karen hates being called before 10.', want: ['person_note'], alsoFine: ['note'] },
  { id: 'h-recall', text: 'Remind me what that restaurant was that you suggested last month?', want: ['recall'], alsoFine: ['ask_everything'] },
  { id: 'h-es-score', text: '¿Cómo quedó el Barça ayer?', want: ['sports_scores'], alsoFine: ['web_search', 'team_news'] },
  { id: 'h-de-bill', text: 'Welche Rechnungen sind diese Woche fällig?', want: ['bill_list'] },
  { id: 'h-fr-research', text: 'Peux-tu te renseigner sur les meilleures pompes à chaleur ?', want: ['research_start'], alsoFine: ['web_search'], route: 'research' },
  { id: 'h-research-into', text: 'I need you to look into which air purifiers are actually worth buying.', want: ['research_start'], alsoFine: ['web_search', 'find_product', 'compare'], route: 'research' },
  { id: 'h-not-research', text: 'I did some research on my family tree over the weekend, it was fun.', want: [], route: 'chat' },
  // Fresh: written after picking by meaning (Z7) was built and its numbers set, run once, never
  // tuned on (ids start with f-). The h- cases above were looked at while setting those numbers.
  { id: 'f-hours-week', text: 'How many hours have I put in this week?', want: ['time_report'] },
  { id: 'f-new-client', text: 'I just landed a new customer, Brightside Dental. Put them in.', want: ['client_add'] },
  { id: 'f-paid-bill', text: 'I paid the water bill this morning.', want: ['bill_paid'], alsoFine: ['bill_list'] },
  { id: 'f-cap-spend', text: 'I want to cap what I spend on takeout at 150 a month.', want: ['budget_limit'] },
  { id: 'f-subscriptions', text: 'What am I paying for every month that I might have forgotten about?', want: ['budget_subscriptions'], alsoFine: ['bill_list', 'budget_summary'] },
  { id: 'f-unpaid-invoices', text: 'Who still owes me money for work I billed?', want: ['invoice_list'], alsoFine: ['clients_pipeline'] },
  { id: 'f-standings', text: 'Where are the Celtics in the table right now?', want: ['sports_standings'], alsoFine: ['web_search', 'team_news'] },
  { id: 'f-injury', text: 'Is anyone on the Yankees hurt at the moment?', want: ['team_news'], alsoFine: ['web_search'] },
  { id: 'f-what-you-know', text: 'What do you actually know about me and my family?', want: ['facts_list'], alsoFine: ['people_list', 'recall', 'my_details_get'] },
  { id: 'f-who-waiting', text: 'Is anyone waiting to hear back from me?', want: ['people_due'], alsoFine: ['follow_ups', 'promise_list'] },
  { id: 'f-card-text', text: 'Write something nice I can put in a birthday card for my aunt Rosa.', want: ['people_gift_card'], alsoFine: ['person_lookup'] },
  { id: 'f-past-decisions', text: 'What big choices have I made lately, and how did they turn out?', want: ['decision_list'], alsoFine: ['recall'] },
  { id: 'f-lease-check', text: 'Can you go through my lease and tell me if anything in it looks off?', want: ['contract_review'], alsoFine: ['library', 'doc_checklist'] },
  { id: 'f-meeting-todos', text: 'Here are my notes from the call. Pull out who has to do what: Sam sends the quote by Friday, I book the venue, Lee checks the budget.', want: ['action_items'], alsoFine: ['todo'] },
  { id: 'f-shared-list', text: 'What is on the family grocery list?', want: ['household_lists'], alsoFine: ['todo'] },
  { id: 'f-watches', text: 'What am I currently being alerted about?', want: ['watch_list'], alsoFine: ['product_watch_list', 'remind'] },
  { id: 'f-my-address', text: 'What shipping address do you have on file for me?', want: ['my_details_get'], alsoFine: ['facts_list'] },
  { id: 'f-odds', text: 'If the line is minus 150, what chance does that imply?', want: ['odds_math'] },
  { id: 'f-log-time', text: 'Put down three and a half hours for yesterday on the Garcia remodel.', want: ['time_add'] },
  { id: 'f-quote', text: 'Send Mrs. Patel an estimate for repainting two bedrooms, 1,400 dollars.', want: ['invoice_make'], alsoFine: ['invoice_send', 'client_add'] },
  // Just talking: no tool.
  { id: 'chat-hello', text: 'Morning! Slept terribly, the neighbors had a party.', want: [], route: 'chat' },
  { id: 'chat-opinion', text: 'Do you think it is rude to leave a party without saying goodbye?', want: [], route: 'chat' },
  { id: 'chat-math', text: 'What is 15 percent of 80?', want: [], route: 'chat' },
  { id: 'chat-explain', text: 'Explain in two sentences why the sky is blue.', want: [], alsoFine: [], route: 'chat' },

  // Which model: research asks go to the research model, a coding chat to the coding model.
  { id: 'route-research', text: 'Research the best budget e-readers and what people are saying about them.', want: ['research_start'], alsoFine: ['web_search'], route: 'research' },
  { id: 'route-lookup', text: 'Look up how much a heat pump costs to run in a cold climate.', want: ['web_search'], alsoFine: ['research_start', 'web_fetch'], route: 'research' },
  { id: 'route-es-research', text: 'Investiga cuáles son los mejores lectores electrónicos baratos.', want: ['research_start'], alsoFine: ['web_search'], route: 'research' },
  { id: 'route-de-research', text: 'Recherchiere bitte, was eine Wärmepumpe im Betrieb kostet.', want: ['research_start'], alsoFine: ['web_search'], route: 'research' },
  { id: 'route-not-research', text: 'My brother does cancer research in Boston, I am so proud of him.', want: [], route: 'chat' },
  { id: 'code-read', text: 'What does the main function in this project do?', want: ['read_file', 'code_find', 'code_map'], alsoFine: ['list_dir', 'search', 'code_refs'], route: 'coding', coding: true },
  { id: 'code-tests', text: 'Run the tests and tell me what fails.', want: ['shell', 'start_job'], alsoFine: ['list_dir', 'read_file'], route: 'coding', coding: true },
  { id: 'code-find', text: 'Where is the function that parses dates defined?', want: ['code_find', 'search'], alsoFine: ['code_refs', 'code_map'], route: 'coding', coding: true },
  { id: 'code-status', text: 'What have I changed since the last commit?', want: ['git'], alsoFine: ['shell'], route: 'coding', coding: true },
];
