// R2 (docs/GETTING_STARTED.md): the words of the guided setup, the sample space and the starter
// packs, in the app's language. Pure (the app passes its t() in), so the tests run it in Node.
// The server (src/get-started.ts) keeps only ids, days and flags; every word is here.

export const STEP_IDS = ['model', 'mail', 'calendar', 'phone', 'computer'];
export const PACK_IDS = ['household', 'business', 'sales', 'student'];
export const SAMPLE_IDS = ['bill', 'package', 'watch', 'decision', 'invoice'];

/** One screen of the guide: title, one plain line, the main button, the Settings page it opens. */
export function stepWords(id, t) {
  const w = {
    model: { title: t('Pick a model'), text: t('The AI she thinks with. Auto picks the best one you have connected for each job, and switches if one is slow.'), go: t('Connect a model'), page: 'models-default' },
    mail: { title: t('Connect your mail'), text: t('Gmail, Outlook or another mailbox. She reads and sorts it; sending always asks you first.'), go: t('Connect mail'), page: 'ab-mail' },
    calendar: { title: t('Connect your calendar'), text: t('Google Calendar or Outlook, so your day shows on Today and she can tell you when to leave.'), go: t('Connect a calendar'), page: 'ab-mail' },
    phone: { title: t('Add your phone'), text: t('Scan a code with your phone to get Sara there, with notifications.'), go: t('Show the code'), page: 'co-phone' },
    computer: { title: t('Add your computer'), text: t('The Sara app for Windows or Mac. With your OK she can help on that computer: files, forms and her own browser.'), go: t('Get the app'), page: 'dh-devices' },
  };
  return w[id];
}

/** "Step 2 of 5", the done line, the button labels. */
export function guideWords(t) {
  return {
    title: t('Set up Sara'),
    count: (n, total) => t('Step {n} of {total}', { n, total }),
    done: t('Done: connected.'),
    todo: t('Not connected yet.'),
    skipped: t('Skipped. You can come back any time.'),
    next: t('Next'),
    back: t('Back'),
    skip: t('Skip for now'),
    close: t('Close'),
    useAuto: t('Use Auto'),
    autoOn: t('Auto is on: she picks the model per job from what is connected.'),
    pair: t('Already installed? Sign the app in with a code'),
    endTitle: t('You are set'),
    endText: t('Pick what you mostly use her for. You can change it any time in Settings → You.'),
    examples: t('Show me with examples'),
    examplesTip: t('Adds clearly marked example cards to Today (a bill, a package, a watch, a decision and an invoice) and a short tour of them. They are kept apart from your own data, and one press removes them.'),
    finish: t('Finish'),
    today: (done, total) => t('Finish setting up Sara: {done} of {total} done', { done, total }),
    resume: t('Continue setup'),
    hide: t('Hide'),
    open: t('Guided setup'),
  };
}

/** Starter packs: name and one line. */
export function packWords(id, t) {
  const w = {
    household: { title: t('Household'), text: t('Bills, groceries, family dates, chores and deliveries.') },
    business: { title: t('Small business'), text: t('Clients, quotes, invoices, money in and follow-ups.') },
    sales: { title: t('Sales'), text: t('Leads, meetings, follow-ups and your pipeline.') },
    student: { title: t('Student'), text: t('Classes, assignments, exams and a budget.') },
    none: { title: t('None'), text: t('No pack: everything as it was.') },
  };
  return w[id];
}

/** The routines a pack adds (their names as the server saves them), in the app's language. */
export function routineName(name, t) {
  const known = {
    'Bills due this week': t('Bills due this week'),
    'Weekend plan': t('Weekend plan'),
    'Unpaid invoices': t('Unpaid invoices'),
    'Friday money check': t('Friday money check'),
    'Follow-ups due': t('Follow-ups due'),
    'Pipeline on Monday': t('Pipeline on Monday'),
    'Sunday study plan': t('Sunday study plan'),
    'Due soon': t('Due soon'),
  };
  return known[name] ?? name;
}

/** The pack card's lines after applying: what changed and where. */
export function packResultWords(r, t) {
  if (!r?.pack) return r?.kept?.length ? t('Pack removed. {n} routine you turned on stays yours.', { n: r.kept.length }) : t('Pack removed. Everything is as it was.');
  return t('Added {n} routines, off until you press Allow in Settings → You → Automations. Today and your Try cards follow the pack.', { n: r.added.length });
}

/**
 * The example cards. `day(iso)` formats a day ("Wed, Nov 18"). Invented people and amounts only.
 */
export function sampleWords(card, t, day = (d) => d) {
  const d = day(card.day);
  const w = {
    bill: { title: t('Electric bill: $84.20'), text: t('Due {day}. She reminds you 2 days before.', { day: d }), icon: 'memo' },
    package: { title: t('Package: running shoes'), text: t('Arrives {day} by UPS.', { day: d }), icon: 'pin' },
    watch: { title: t('Watching: Apple stock'), text: t('Up 2.1% today. She tells you when it moves more than 5%.'), icon: 'eye' },
    decision: { title: t('Decision: which laptop?'), text: t('Three options weighed on price, battery and weight.'), icon: 'compass' },
    invoice: { title: t('Invoice #1001 to Acme Studio: $1,250.00'), text: t('Unpaid, sent {day}. She can draft a friendly reminder.', { day: d }), icon: 'file-edit' },
  };
  return w[card.kind];
}

/** The sample section's words and the tour over it. */
export function sampleSectionWords(t) {
  return {
    title: t('Examples'),
    badge: t('Sample data'),
    lead: t('These are examples, not your data. They show what Today looks like once she is connected.'),
    tour: t('Show me around'),
    remove: t('Remove examples'),
    removed: t('Examples removed.'),
  };
}

/** The tour over the example cards: one stop per card, then the remove button. */
export function sampleTour(t) {
  return [
    { sel: '#td-examples [data-sample="bill"]', title: t('Bills'), text: t('Bills from your mail land here with the amount and the due day. She reminds you before they are due.') },
    { sel: '#td-examples [data-sample="package"]', title: t('Packages'), text: t('Shipping emails become one card per package, with the day it arrives.') },
    { sel: '#td-examples [data-sample="watch"]', title: t('Watches'), text: t('Ask her to watch a stock, a price or a team. She tells you when something changes.') },
    { sel: '#td-examples [data-sample="decision"]', title: t('Decisions'), text: t('Give her the options and what matters to you; she weighs them side by side.') },
    { sel: '#td-examples [data-sample="invoice"]', title: t('Invoices'), text: t('Make an invoice in the chat. She tracks paid or unpaid and offers a reminder.') },
    { sel: '#td-examples-remove', title: t('Done looking?'), text: t('This removes every example. Your own data is never touched.') },
  ];
}
