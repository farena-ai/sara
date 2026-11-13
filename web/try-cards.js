// E7 (docs/design/EVERYDAY.md "Usable by real people"): one starter card per everyday area on Today
// (and as chips in a new chat), so new features are found without reading a guide. A card shows
// only when its tools exist on this server (keyed by tool name, so cards for parts built on other
// branches appear once those are merged), only for company/both setups (Easy mode), and until it is
// used once or dismissed on this device. Pure data here (test/e7-ready.test.ts); app.js paints them.

export const TRY_DONE_KEY = 'sara.tryDone';

/** The cards' words in the app's language (title, the line under it, the first message). */
function words(t) {
  return {
    form: [t('Fill in a form'), t('Give her a form or template and the details; she fills it in.'), t('Help me fill in a form. I will attach it: ask me for anything you need.')],
    watch: [t('Watch a stock or team'), t('Prices, scores and games: she tells you when something happens.'), t('Watch a stock or a team for me and tell me when something changes. Which one:')],
    near: [t('Find something near me'), t('Stores nearby and online: in stock, price and distance.'), t('Find something for me in a store near me or online:')],
    decide: [t('Help me decide'), t('Options and what matters to you, weighed side by side.'), t('Help me decide between some options. Here they are:')],
    invoice: [t('Make an invoice'), t('From your own template or a clean one, and she tracks paid or unpaid.'), t('Make an invoice. Client, items and amounts:')],
    spending: [t('Check my spending'), t('From a bank export: where the money went, subscriptions and bills due.'), t('Check my spending: I will attach a bank export. Where did the money go, and what subscriptions do I have?')],
  };
}

/**
 * The cards. `tools`: any of these names (or names starting with a `prefix`) on this server.
 * Money and sports tools may come from other branches: their likely names are listed so the
 * cards appear once they are merged.
 */
const DEFS = [
  { id: 'form', icon: 'file-edit', tools: ['fill_document'], prefix: [] },
  { id: 'watch', icon: 'eye', tools: ['watch_add', 'market_quote', 'sports_scores'], prefix: ['sports_follow', 'team_follow', 'follow_team', 'portfolio'] },
  { id: 'near', icon: 'pin', tools: ['find_product', 'stores_near'], prefix: [] },
  { id: 'decide', icon: 'compass', tools: ['decide'], prefix: ['decision_'] },
  { id: 'invoice', icon: 'memo', tools: ['invoice_make'], prefix: [] },
  { id: 'spending', icon: 'gauge', tools: ['spending_summary', 'spending_report'], prefix: ['spending', 'budget_', 'bank_'] },
];
const EN = words((x) => x);
export const TRY_CARDS = DEFS.map((d) => ({ ...d, title: EN[d.id][0], text: EN[d.id][1], message: EN[d.id][2] }));

const hasTool = (names, card) => names.some((n) => card.tools.includes(n) || card.prefix.some((p) => n.startsWith(p)));

/**
 * The cards to show now. `tools`: tool names on this server; `path`: the use choice ('coding' gets
 * none); `done`: the ids used or dismissed on this device; `t`: the app's t().
 */
export function tryCards({ tools = [], path = 'both', done = new Set(), t = (x) => x }) {
  if (path === 'coding') return [];
  const w = words(t);
  return DEFS.filter((c) => hasTool(tools, c) && !done.has(c.id)).map((c) => ({ id: c.id, icon: c.icon, title: w[c.id][0], text: w[c.id][1], message: `${w[c.id][2]} ` }));
}

/** The ids used or dismissed on this device. */
export function triedSet(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(TRY_DONE_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Marks a card used or dismissed (kept on this device). */
export function markTried(storage = globalThis.localStorage, id) {
  const s = triedSet(storage);
  if (s.has(id)) return;
  s.add(id);
  try {
    storage?.setItem(TRY_DONE_KEY, JSON.stringify([...s]));
  } catch {
    /* private mode: shown again next time */
  }
}
