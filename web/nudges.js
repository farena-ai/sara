// W1.2 (docs/NUDGES.md): the "Why did I get this?" line and "Fewer like this" under each nudge, and
// Settings → You → Automations → Her nudges (daily budget, roundup hour, what she learned).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
let seq = 0;
const hourText = (h) => new Date(2026, 0, 1, h).toLocaleTimeString(document.documentElement.lang || 'en', { hour: 'numeric' });
const whyText = (why) => (why?.key ? t(why.key, { ...why.params, what: why.params?.what ? t(why.params.what) : '' }) : '');

/** Under a message she sent on her own: why it came, and "Fewer like this" for normal nudges. */
export function nudgeLine(nudge, api) {
  const box = el('div', 'ndg-line small');
  const why = el('span', 'ndg-why-text');
  why.textContent = whyText(nudge.why);
  why.hidden = true;
  why.id = `ndg-w${++seq}`;
  const ask = button(t('Why did I get this?'), 'linkish small ndg-why', () => {
    why.hidden = !why.hidden;
    ask.setAttribute('aria-expanded', String(!why.hidden));
  });
  ask.setAttribute('aria-expanded', 'false');
  ask.setAttribute('aria-controls', why.id);
  box.append(ask);
  if (nudge.kind !== 'digest' && String(nudge.why?.key ?? '').includes('{n} of {budget}')) {
    const fewer = button(t('Fewer like this'), 'ghost small ndg-fewer', async () => {
      fewer.disabled = true;
      try {
        await api('/automations/nudges/fewer', { method: 'POST', body: { kind: nudge.kind } });
        const undo = button(t('Undo'), 'linkish small', async () => {
          await api('/automations/nudges/more', { method: 'POST', body: { kind: nudge.kind } }).catch(() => undefined);
          done.replaceWith(fewer);
          fewer.disabled = false;
        });
        const done = el('span', 'ndg-done muted');
        done.append(el('span', '', t('Got it: fewer like this from now on.')), ' ', undo);
        fewer.replaceWith(done);
      } catch (e) {
        fewer.disabled = false;
        fewer.title = e.message;
      }
    });
    box.append(fewer);
  }
  box.append(why);
  return box;
}

let busy = false;
/** Settings → Automations → Her nudges. */
export async function loadNudges(api) {
  const host = $('#ndg-box');
  if (!host || !api || busy) return;
  busy = true;
  let s;
  try {
    s = await api('/automations/nudges');
  } catch (e) {
    $('#ndg-today').textContent = e.message;
    return;
  } finally {
    busy = false;
  }
  draw(s, api);
}

function draw(s, api) {
  const budget = $('#ndg-budget');
  const hour = $('#ndg-hour');
  if (hour && !hour.options.length) for (let h = 0; h < 24; h++) hour.append(new Option(hourText(h), String(h)));
  if (document.activeElement !== budget) budget.value = String(s.prefs.budget);
  hour.value = String(s.prefs.digestHour);
  const save = async () => {
    const n = Number(budget.value);
    if (!Number.isFinite(n) || n < 0 || n > 20) return;
    try {
      draw(await api('/automations/nudges', { method: 'PUT', body: { budget: n, digestHour: Number(hour.value) } }), api);
    } catch (e) {
      $('#ndg-today').textContent = e.message;
    }
  };
  budget.onchange = save;
  hour.onchange = save;
  $('#ndg-today').textContent = [
    t('{n} of {budget} nudges today; {held} saved for the roundup at {hour}.', { n: s.today.sent, budget: s.today.budget, held: s.held.length, hour: hourText(s.prefs.digestHour) }),
    t('Quiet from {start} to {end} (her page, Texting first). Safety alerts and reminders you set still come.', { start: hourText(s.quiet.start), end: hourText(s.quiet.end) }),
  ].join(' ');
  const kinds = $('#ndg-kinds');
  kinds.replaceChildren();
  if (!s.kinds.length) kinds.append(el('p', 'muted small', t('Tap “Fewer like this” under any nudge and she learns what matters less to you.')));
  for (const k of s.kinds) {
    const row = el('div', 'ndg-kind');
    row.append(el('span', '', t('{what}: fewer ({pct}% as often)', { what: t(k.label), pct: Math.round(k.weight * 100) })));
    row.append(button(t('Back to normal'), 'ghost small', async () => draw(await api('/automations/nudges/more', { method: 'POST', body: { kind: k.kind } }), api)));
    kinds.append(row);
  }
  const held = $('#ndg-held');
  held.replaceChildren();
  if (s.held.length) {
    held.append(el('strong', '', t('Waiting for the roundup')));
    const ul = el('ul', 'ndg-list');
    for (const h of s.held.slice(0, 5)) ul.append(el('li', 'small', `${t(h.label)}: ${h.text}`));
    if (s.held.length > 5) ul.append(el('li', 'small muted', t('and {n} more', { n: s.held.length - 5 })));
    held.append(ul);
  }
}
