// Phase 79 (harness track M4): budgets on screen. A small meter on a reply's step line and in the
// Run view (how much of the reply's budget was used: tokens, steps, dollars, minutes), and the
// "Budget reached" card under a reply that stopped at its budget: why, what she did to save (the
// quick model, fewer tools, a short summary), what was dropped, what is kept, and the explicit
// "Continue with more" button (a new turn with exactly that much; nothing goes on by itself).
import { locale, t } from './naming.js';
import { icon } from './icons.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const glyph = (name) => {
  const s = el('span', 'budget-icon');
  s.setAttribute('aria-hidden', 'true');
  const svg = icon(name);
  if (svg) s.append(svg);
  return s;
};

const nf = (n, d = 0) => Number(n ?? 0).toLocaleString(locale(), { maximumFractionDigits: d });
/** "200k" / "1.5M" / "800". */
export const shortNum = (n) => (n >= 1_000_000 ? `${nf(n / 1_000_000, 1)}M` : n >= 1000 ? `${nf(n / 1000, n >= 10_000 ? 0 : 1)}k` : nf(n));
const usd = (n) => `$${Number(n ?? 0) < 0.01 && n > 0 ? Number(n).toFixed(4) : Number(n ?? 0).toFixed(2)}`;

/** "200k tokens, 40 steps" for an amount of budget. */
export function amountWords(b) {
  const parts = [];
  if (b?.tokens) parts.push(t('{n} tokens', { n: shortNum(b.tokens) }));
  if (b?.steps) parts.push(t('{n} steps', { n: nf(b.steps) }));
  if (b?.usd) parts.push(usd(b.usd));
  if (b?.minutes) parts.push(t('{n} minutes', { n: nf(b.minutes) }));
  return parts.join(', ');
}

/** Each line of a budget: [label, used, limit, share]. */
function lines(state) {
  const l = state.limits ?? {};
  const u = state.used ?? {};
  const out = [];
  if (l.tokens) out.push([t('Tokens: {used} of {limit}', { used: shortNum(u.tokens), limit: shortNum(l.tokens) }), (u.tokens ?? 0) / l.tokens, 'tokens']);
  if (l.steps) out.push([t('Steps: {used} of {limit}', { used: nf(u.steps), limit: nf(l.steps) }), (u.steps ?? 0) / l.steps, 'steps']);
  if (l.usd) out.push([state.usdIgnored ? t('Spending limit not counted: this model is a subscription or runs on your own computer.') : t('Cost: {used} of {limit}', { used: usd(u.usd), limit: usd(l.usd) }), state.usdIgnored ? 0 : (u.usd ?? 0) / l.usd, 'usd']);
  if (l.minutes) out.push([t('Time: {used} of {limit} min', { used: nf(u.minutes, 1), limit: nf(l.minutes) }), (u.minutes ?? 0) / (l.minutes || 1), 'minutes']);
  return out;
}

/** The small meter: a bar with the largest share used, the lines in its title and in words. */
export function budgetMeter(state, { compact = false } = {}) {
  const box = el('span', `budget-meter${state.stage === 'reached' ? ' reached' : state.frac >= 0.8 ? ' near' : ''}${compact ? ' compact' : ''}`);
  const all = lines(state);
  const frac = Math.max(0, Math.min(1, state.frac ?? 0));
  const bar = el('span', 'budget-bar');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  const fill = el('span', 'budget-fill');
  fill.style.setProperty('--budget-frac', String(frac));
  bar.append(fill);
  const words = t('Budget used: {pct}', { pct: `${nf(Math.round(frac * 100))}%` });
  bar.setAttribute('aria-label', words);
  box.title = [words, ...all.map((x) => x[0])].join('\n');
  box.append(glyph('gauge'), bar, el('span', 'budget-words small', compact ? `${nf(Math.round(frac * 100))}%` : words));
  return box;
}

const REACHED = {
  tokens: (l) => t('She stopped at the token limit ({limit}).', { limit: t('{n} tokens', { n: shortNum(l.tokens) }) }),
  steps: (l) => t('She stopped at the step limit ({limit}).', { limit: t('{n} steps', { n: nf(l.steps) }) }),
  usd: (l) => t('She stopped at the spending limit ({limit}).', { limit: usd(l.usd) }),
  minutes: (l) => t('She stopped at the time limit ({limit}).', { limit: t('{n} minutes', { n: nf(l.minutes) }) }),
};
const RUNG = { 'smaller-model': () => t('switched to the quick model'), 'fewer-tools': () => t('used fewer tools'), 'summarize-stop': () => t('wrapped up with a short summary') };

/**
 * The "Budget reached" card. `onContinue(more)` starts the explicit continuation (a new turn with
 * exactly `more`); without it (an older reply, the demo) the button isn't shown.
 */
export function budgetCard(state, { onContinue } = {}) {
  const card = el('div', 'budget-card');
  card.setAttribute('role', 'note');
  const head = el('p', 'budget-title');
  head.append(glyph('gauge'), el('strong', '', t('Budget reached')));
  card.append(head);
  const why = REACHED[state.reached]?.(state.limits ?? {});
  if (why) card.append(el('p', 'small', why));
  const rungs = (state.rungs ?? []).map((r) => RUNG[r]?.()).filter(Boolean);
  if (rungs.length) card.append(el('p', 'muted small', t('To save budget she: {steps}', { steps: rungs.join(', ') })));
  if (state.dropped?.length) {
    card.append(el('p', 'small budget-label', t('Not done (dropped):')));
    const ul = el('ul', 'budget-list small');
    for (const d of state.dropped.slice(0, 12)) ul.append(el('li', '', d));
    card.append(ul);
  }
  if (state.kept?.length) card.append(el('p', 'small', `${t('Kept:')} ${state.kept.slice(0, 12).join(', ')}`));
  card.append(budgetMeter(state));
  if (state.continued) {
    card.append(el('p', 'muted small', t('You gave it more: {amount}', { amount: amountWords(state.continued.more) })));
  } else if (onContinue && state.more && amountWords(state.more)) {
    const row = el('div', 'row');
    const b = el('button', 'small continue-budget', t('Continue with more: {amount}', { amount: amountWords(state.more) }));
    b.type = 'button';
    b.addEventListener('click', () => {
      b.disabled = true;
      onContinue(state.more, b);
    });
    row.append(b);
    card.append(row);
  }
  return card;
}

/** One line under a reply that ran on extra budget the owner gave (an explicit override). */
export function overrideNote(state) {
  return state?.override ? el('p', 'muted small budget-override', t('This reply ran on extra budget you gave: {amount}', { amount: amountWords(state.override) })) : null;
}

// ---- Settings → Coding → Budgets ----

/** Fills a budget pick-list with its choices (labels in the app language). */
export function fillBudgetSelect(select, kind, choices, value) {
  const label = (n) =>
    kind === 'tokens' ? t('{n} tokens', { n: shortNum(n) })
    : kind === 'steps' ? t('{n} steps', { n: nf(n) })
    : kind === 'usd' ? (n ? usd(n) : t('No spending limit'))
    : n ? t('{n} minutes', { n: nf(n) }) : t('No time limit');
  const list = [...choices];
  // A value saved earlier that isn't in the list is added to it (never silently changed).
  if (value !== undefined && !list.includes(value)) list.push(value);
  list.sort((a, b) => a - b);
  select.replaceChildren(...list.map((n) => new Option(label(n), String(n))));
  select.value = String(value);
}
