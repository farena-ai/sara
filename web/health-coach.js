// W4.4 (docs/design/W4COACH.md): the health coach card at the top of Health (the week against the
// week before, at most two small goals with Accept / Not now, red flags as "Talk to your doctor"
// only) and the caregiver's copy of a shared weekly summary. Everything is worked out on the server
// in code; no model reads it.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const say = (msg) => {
  const s = $('#hl-status');
  if (s) s.textContent = msg;
};
const num = (v, d = 1) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const LABEL = () => ({ sleep: t('Sleep'), steps: t('Steps'), weight: t('Weight'), mood: t('Mood'), meds: t('Doses marked taken') });
function amount(m, v) {
  if (m.name === 'sleep') return t('{n} h', { n: num(v) });
  if (m.name === 'steps') return t('{n} steps', { n: num(v, 0) });
  if (m.name === 'mood') return `${num(v)}/10`;
  if (m.name === 'meds') return `${num(v, 0)}%`;
  return `${num(v)} ${m.unit}`;
}
const goalText = (g) => t(g.key, { n: g.n, h: num(g.target, 2), steps: num(g.target, 0) });

function metricTile(m) {
  const card = el('div', 'hl-coach-tile');
  card.append(el('div', 'hl-coach-name small', LABEL()[m.name] ?? m.name));
  if (m.flag) {
    card.append(el('div', 'hl-coach-val hl-soon', t('See the note above.')));
    return card;
  }
  card.append(el('div', 'hl-coach-val', amount(m, m.value)));
  const sub = el('div', 'muted small');
  if (typeof m.change === 'number' && (m.name === 'sleep' || m.name === 'steps')) sub.textContent = m.change > 0 ? t('{n}% more than the week before', { n: m.change }) : m.change < 0 ? t('{n}% less than the week before', { n: -m.change }) : t('same as the week before');
  else if (typeof m.prev === 'number') sub.textContent = t('Week before: {v}', { v: amount(m, m.prev) });
  else if (m.name === 'meds') sub.textContent = m.days === 1 ? t('1 dose counted') : t('{n} doses counted', { n: m.days });
  else sub.textContent = m.days === 1 ? t('1 day logged') : t('{n} days logged', { n: m.days });
  card.append(sub);
  return card;
}

async function act(id, action, b) {
  b.disabled = true;
  try {
    const w = await ctx.api(`/health-log/coach/goals/${encodeURIComponent(id)}`, { method: 'POST', body: { action } });
    say(action === 'accept' ? t('Goal added.') : t('Okay, not this week.'));
    draw(w);
  } catch (err) {
    say(err?.message ?? String(err));
    b.disabled = false;
  }
}

function draw(w) {
  const box = $('#hl-coach');
  if (!box) return;
  box.replaceChildren();
  if (w.flags.length) {
    const flags = el('div', 'hl-coach-flags');
    for (const f of w.flags) flags.append(el('p', 'small', t(f.key)));
    box.append(flags);
  }
  if (!w.metrics.length && !w.flags.length) box.append(el('p', 'muted small', t('Nothing logged this week yet. Import a file from your watch or phone, or log sleep or mood, and your week shows here.')));
  if (w.metrics.length) {
    const grid = el('div', 'hl-coach-grid');
    for (const m of w.metrics) grid.append(metricTile(m));
    box.append(grid);
  }
  for (const g of w.goals) {
    const row = el('div', 'hl-row hl-coach-goal');
    const main = el('div', 'hl-row-main');
    main.append(el('span', '', goalText(g)));
    if (g.status === 'accepted') main.append(el('span', 'muted small', ` ${g.until < w.to ? t('Last week: {done} of {of} days', { done: g.done, of: g.of }) : t('{done} of {of} days so far', { done: g.done, of: g.of })}`));
    row.append(main);
    if (g.status === 'proposed') {
      const yes = el('button', 'small', t('Accept'));
      const no = el('button', 'small ghost', t('Not now'));
      for (const b of [yes, no]) b.type = 'button';
      yes.addEventListener('click', () => void act(g.id, 'accept', yes));
      no.addEventListener('click', () => void act(g.id, 'skip', no));
      row.append(yes, no);
    }
    box.append(row);
  }
  box.append(el('p', 'muted small', t(w.notAdvice)));
  const on = $('#hl-coach-on');
  if (on) on.checked = !!w.checkin;
}

/** Health → Your week (called from loadHealth). */
export async function renderCoach(c) {
  ctx = c;
  const box = $('#hl-coach');
  if (!box) return;
  const on = $('#hl-coach-on');
  if (on && !on.dataset.wired) {
    on.dataset.wired = '1';
    on.addEventListener('change', async () => {
      try {
        await ctx.api('/health-log/settings', { method: 'PUT', body: { coach: on.checked } });
        say(on.checked ? t('Weekly check-in on. She tells you on Sunday evening that your week is ready.') : t('Weekly check-in off.'));
      } catch (err) {
        on.checked = !on.checked;
        say(err?.message ?? String(err));
      }
    });
  }
  let w;
  try {
    w = await ctx.api('/health-log/coach');
  } catch {
    // Kids have no coach: hide the whole section.
    for (const x of [$('#hl-coach-h'), box, on?.closest('label')]) if (x) x.hidden = true;
    return;
  }
  draw(w);
}

/** A caregiver's card: the summary the person chose to share (no mood, no numbers behind a red flag). */
export function renderShared(card, s, mk) {
  card.append(mk('strong', 'small', t('Weekly summary')));
  const ul = mk('ul', 'small hl-qs');
  const lab = LABEL();
  for (const m of s.metrics) ul.append(mk('li', '', `${lab[m.name] ?? m.name}: ${amount(m, m.value)}`));
  for (const g of s.goals) ul.append(mk('li', '', `${t(g.key, { n: g.n, h: num(g.target, 2), steps: num(g.target, 0) })} · ${t('{done} of {of} days so far', { done: g.done, of: g.of })}`));
  if (!s.metrics.length && !s.goals.length) ul.append(mk('li', 'muted', t('Nothing logged this week yet.')));
  card.append(ul);
  if (s.doctor) card.append(mk('p', 'small hl-soon', t('Something this week is worth a word with a doctor.')));
}
