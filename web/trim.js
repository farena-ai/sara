// V2.8 (docs/TRIM.md): Money → Maybe cancel. Subscriptions worth a second look (unused, the price
// went up, two of the same kind, a free trial ending) with one-tap "Start a cancel errand" (it waits in
// Errands for Start, and the final confirm asks again), Keep it, and the once-a-month note.
import { t } from './naming.js';
import { handleIt } from './handle-it.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let data = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#trm-status');
  if (s) s.textContent = msg;
};
const loc = () => document.documentElement.lang || undefined;
const cur = (cents) => new Intl.NumberFormat(loc(), { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(loc(), { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const key = (k) => encodeURIComponent(k);

async function call(path, method, body, done) {
  try {
    const r = await ctx.api(path, { method, body });
    if (done) say(typeof done === 'function' ? done(r) : done);
    await loadTrim();
    return r;
  } catch (err) {
    say(err.message);
    return undefined;
  }
}

export function initTrim(c) {
  ctx = c;
  $('#trm-monthly')?.addEventListener('change', (e) => void call('/money/trim/prefs', 'PUT', { monthly: e.target.checked }, t('Saved.')));
}

/** "Not using it" on a Subscriptions row: it joins Maybe cancel. */
export function markUnused(name) {
  return call(`/money/trim/${key(name)}/unused`, 'POST', {}, t('Added to Maybe cancel.'));
}

export async function loadTrim() {
  if (!ctx || !$('#trm-list')) return;
  try {
    data = await ctx.api('/money/trim');
  } catch {
    return;
  }
  render();
}

function why(r) {
  if (r.kind === 'unused') return r.from === 'mail' ? t('Your email says you haven’t used it lately') : t('You said you don’t use it');
  if (r.kind === 'price') return r.fromCents && r.toCents ? t('Price went from {from} to {to}', { from: cur(r.fromCents), to: cur(r.toCents) }) : t('Price went up');
  if (r.kind === 'trial') return t('Free trial ends {day}', { day: dayText(r.day) });
  const list = r.with.join(', ');
  return {
    video: t('Also another video service: {list}', { list }),
    music: t('Also another music service: {list}', { list }),
    storage: t('Also another storage plan: {list}', { list }),
    news: t('Also another news subscription: {list}', { list }),
    fitness: t('Also another fitness app: {list}', { list }),
    books: t('Also another books service: {list}', { list }),
  }[r.group] ?? list;
}

function render() {
  const box = $('#trm-list');
  $('#trm-monthly').checked = Boolean(data.prefs?.monthly);
  const every = { week: t('a week'), month: t('a month'), year: t('a year') };
  const ul = el('ul', 'mn-list');
  for (const r of data.rows) {
    const li = el('li', 'mn-item');
    const top = el('div', 'mn-top');
    top.append(el('strong', '', r.name));
    for (const x of r.reasons) top.append(el('span', `er-chip mn-chip${x.kind === 'duplicate' ? '' : ' mn-warn'}`, why(x)));
    li.append(top);
    const facts = [r.amountCents !== null ? `${cur(r.amountCents)}${r.every ? ` ${every[r.every]}` : ''}` : '', r.yearlyCents ? t('{amount} a year', { amount: cur(r.yearlyCents) }) : '', r.sources.includes('bank') ? t('From your bank export') : t('From your email')].filter(Boolean);
    li.append(el('span', 'muted small', facts.join(' · ')));
    const acts = el('span', 'mn-acts');
    acts.append(
      btn(t('Handle it'), 'small', () => void handleIt('cancel', r.key)),
      btn(r.errandId ? t('Open the cancel errand') : t('Start a cancel errand'), 'small', async () => {
        const res = r.errandId ? { errand: { id: r.errandId } } : await call(`/money/trim/${key(r.key)}/cancel`, 'POST', {}, t('The cancel errand is ready in Errands. Nothing is cancelled until you start it, and the final confirm asks you again.'));
        if (res?.errand) location.hash = '#view=errands';
      }),
      btn(t('Keep it'), 'ghost small', () => void call(`/money/trim/${key(r.key)}/keep`, 'POST', {}, t('Kept. It comes back only if something new turns up.'))),
    );
    if (r.reasons.some((x) => x.kind === 'unused' && x.from === 'you')) acts.append(btn(t('I use it'), 'ghost small', () => void call(`/money/trim/${key(r.key)}/used`, 'POST', {})));
    const a = el('a', 'small', t('How to cancel'));
    a.href = r.cancel;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    acts.append(a);
    li.append(acts);
    ul.append(li);
  }
  const parts = [];
  if (data.rows.length) {
    if (data.yearlyCents) parts.push(el('p', 'small', t('About {amount} a year on this list.', { amount: cur(data.yearlyCents) })));
    parts.push(ul);
  } else parts.push(el('p', 'muted small', t('Nothing to look at right now. Subscriptions you may not need show up here: unused, the price went up, or two of the same kind.')));
  if (data.keptRows?.length) {
    const kept = el('p', 'muted small trm-kept', t('Kept off this list: {list}', { list: data.keptRows.map((k) => k.name).join(', ') }));
    kept.append(' ', btn(t('Show them again'), 'ghost small', async () => {
      for (const k of data.keptRows) await ctx.api(`/money/trim/${key(k.key)}/unkeep`, { method: 'POST', body: {} }).catch(() => undefined);
      await loadTrim();
    }));
    parts.push(kept);
  }
  box.replaceChildren(...parts);
}
