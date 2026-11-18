// V1.5 (docs/design/V1COST.md): Cost autopilot in Settings → Models & usage → Which model does
// what (a quality bar per job, Try a cheaper model now, Undo on every move) and the "saved this
// month" line on Usage and costs. The work is src/cost-autopilot.ts (/api/model-jobs/cost).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let timer = 0;

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const name = (m) => m?.label || m?.model || '';

function jobName(job) {
  return { chat: t('Talking'), coding: t('Coding and long tasks'), research: t('Web research') }[job] ?? job;
}

export function initCostAutopilot(c) {
  ctx = c;
  for (const id of ['models-routes', 'dh-usage']) {
    const page = document.querySelector(`.settings-page[data-page="${id}"]`);
    if (page) new MutationObserver(() => !page.hidden && void loadCostAutopilot()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
  }
}

/** The trial's line: running, passed, failed, or nothing to try it on. */
function trialLine(tr) {
  if (!tr) return '';
  if (tr.state === 'running') return t('Trying {model} on your past tasks…', { model: name(tr.to) });
  if (tr.state === 'passed') return t('{model} did as well on {n} past tasks ({date}).', { model: name(tr.to), n: tr.pairs ?? 0, date: day(tr.endedAt ?? tr.at) });
  if (tr.state === 'failed') return t('{model} did worse on {n} of {total} past tasks, so nothing changed ({date}).', { model: name(tr.to), n: tr.losses ?? 0, total: tr.pairs ?? 0, date: day(tr.endedAt ?? tr.at) });
  if (tr.state === 'nothing') return t('Not enough past tasks for this job to try {model} on yet.', { model: name(tr.to) });
  return t('The last try stopped before it finished.');
}

function row(j, view) {
  const { el, api } = ctx;
  const box = el('div', 'cap-row');
  box.dataset.job = j.job;
  const head = el('div', 'cap-head');
  const label = el('label', 'cap-name', jobName(j.job));
  const sel = document.createElement('select');
  sel.id = `cap-bar-${j.job}`;
  sel.setAttribute('aria-label', t('Quality bar for {job}', { job: jobName(j.job) }));
  for (const [v, txt] of [['best', t('Best')], ['good', t('Good enough')]]) sel.append(Object.assign(document.createElement('option'), { value: v, textContent: txt, selected: j.bar === v }));
  sel.addEventListener('change', () => void act('', 'PUT', { job: j.job, bar: sel.value }));
  label.append(' ', sel);
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t('Best: Auto always uses its strongest pick for this job. Good enough: Auto may switch to a cheaper model after it did as well on your past tasks. You can undo any switch.');
  head.append(label, tip);
  box.append(head);
  const lines = el('div', 'cap-lines');
  const line = (text, cls = 'muted small') => lines.append(el('p', cls, text));
  if (j.move) {
    line(t('Moved to {model} on {date} (was {old}).', { model: name(j.move.to), date: day(j.move.at), old: name(j.move.from) }), 'small cap-moved');
    if (j.savedUsd > 0) line(t('Saved {usd} this month.', { usd: usd(j.savedUsd) }), 'small cap-good');
  } else if (j.current) line(t('Auto uses {model}.', { model: name(j.current) }));
  if (j.bar === 'good') {
    if (!j.auto) line(t('Turn on Auto for this job above first.'), 'small cap-warn');
    else if (j.trial?.state === 'passed' && !j.move) line(t('You undid the switch to {model}.', { model: name(j.trial.to) }));
    else if (j.trial) line(trialLine(j.trial));
    if (j.auto && !j.next && !(j.trial?.state === 'running')) line(j.move ? t('Nothing cheaper to try after this one.') : t('Nothing cheaper to try right now.'));
  }
  box.append(lines);
  const acts = el('div', 'cap-acts');
  if (j.bar === 'good' && j.auto && j.next && j.trial?.state !== 'running') {
    const b = el('button', 'ghost', t('Try {model} now', { model: j.next.model }));
    b.type = 'button';
    b.title = t('Runs {n} of your past tasks for this job on both models (inside the eval budget) and switches only when the cheaper one does as well.', { n: view.sample });
    b.addEventListener('click', () => void act('/try', 'POST', { job: j.job }));
    acts.append(b);
  }
  if (j.move) {
    const u = el('button', 'ghost', t('Undo'));
    u.type = 'button';
    u.title = t('Back to {model}; {other} is not tried again for 60 days.', { model: name(j.move.from), other: name(j.move.to) });
    u.addEventListener('click', () => void act('/undo', 'POST', { job: j.job }));
    acts.append(u);
  }
  if (acts.childNodes.length) box.append(acts);
  return box;
  async function act(path, method, body) {
    const status = $('#cap-status');
    try {
      paint(await api(`/model-jobs/cost${path}`, { method, body }));
      if (status) status.textContent = method === 'PUT' ? t('Saved') : path === '/undo' ? t('Undone.') : t('Started. This can take a few minutes.');
    } catch (err) {
      if (status) status.textContent = err?.message ?? String(err);
    }
  }
}

function paint(view) {
  if (!view) return;
  const saved = view.savedUsd > 0 ? t('Cost autopilot saved {usd} this month.', { usd: usd(view.savedUsd) }) : '';
  const s = $('#cap-saved');
  if (s) {
    s.textContent = saved || t('Nothing saved yet this month.');
  }
  const u = $('#cap-usage-saved');
  if (u) {
    u.textContent = saved;
    u.hidden = !saved;
  }
  $('#cap-jobs')?.replaceChildren(...view.jobs.map((j) => row(j, view)));
  clearTimeout(timer);
  if (view.jobs.some((j) => j.trial?.state === 'running')) timer = setTimeout(() => void loadCostAutopilot(), 5000);
}

export async function loadCostAutopilot() {
  if (!ctx) return;
  try {
    paint(await ctx.api('/model-jobs/cost'));
  } catch {
    const box = $('#cap-jobs');
    if (box) box.replaceChildren();
  }
}
