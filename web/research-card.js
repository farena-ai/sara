// 3.1.2 (docs/RESEARCH.md): a research run as a live card. In the chat (research_start, or "Turn
// this into a research run" after many pages in one reply) and in Library → Research: the plan in
// plain words with Start, then progress (what she is doing now, pages read, sites that block
// readers, pages not found, the budget he can raise), Pause / Resume / Write the report now / Stop,
// and when it is done: the report, "Save as a skill" and "Keep it fresh". Polls the run while it
// works; nothing here calls a model or fetches a page itself.
import { serverText, t } from './naming.js';

const POLL_MS = 2000;
const working = (s) => s === 'planning' || s === 'running' || s === 'writing';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** What the run is doing, in plain words. */
export function statusLine(run) {
  const p = run.progress ?? {};
  switch (run.status) {
    case 'planning':
      return t('Drafting a plan…');
    case 'plan':
      return t('Her plan is ready. Nothing is read until you press Start.');
    case 'running':
      if (p.doing === 'searching') return t('Searching: {what}', { what: p.detail });
      if (p.doing === 'reading') return t('Reading {site}', { site: host(p.detail) });
      if (p.doing === 'waiting') return t('The site asked her to slow down: waiting a moment.');
      if (p.doing === 'summarizing') return t('Taking notes from a page…');
      return t('Searching and reading pages…');
    case 'writing':
      return t('Writing the report…');
    case 'paused':
      if (run.pause?.reason === 'model') return t('Paused: the model stopped answering. Press Resume to try again, or write the report with what she has.');
      if (run.pause?.reason === 'restart') return t('Paused by a restart of the server. Press Resume to go on from where it stopped.');
      return t('Paused. Press Resume to go on from where it stopped.');
    case 'done':
      return run.partial ? t('Done, but partial: the run ended before it read everything it planned to.') : t('The report is ready and kept in her Library.');
    case 'stopped':
      return t('Stopped. The report shows what was found and what is missing.');
    default:
      return t('This run could not finish.');
  }
}

/** Pages read, blocked, not found, failed; time and pages against the budget. */
export function progressBits(run) {
  const box = el('div', 'rs-progress');
  const c = run.counts ?? { read: 0, blocked: 0, notFound: 0, failed: 0 };
  const chips = el('div', 'rs-chips');
  chips.append(el('span', 'rs-chip', t('Pages read: {n} of {max}', { n: c.read, max: run.budget?.pages ?? '?' })));
  if (c.blocked) chips.append(el('span', 'rs-chip rs-chip-warn', t('Blocked sites: {n}', { n: c.blocked })));
  if (c.notFound) chips.append(el('span', 'rs-chip', t('Not found: {n}', { n: c.notFound })));
  if (c.failed) chips.append(el('span', 'rs-chip', t('Could not be read: {n}', { n: c.failed })));
  if (run.status !== 'plan' && run.status !== 'planning') chips.append(el('span', 'rs-chip', t('{min} of {max} min', { min: Math.round((run.elapsedMs ?? 0) / 60000), max: run.budget?.minutes ?? '?' })));
  if (run.mode === 'compact') chips.append(el('span', 'rs-chip', t('Short steps (small model)')));
  box.append(chips);
  return box;
}

/** His budget for the run (pages and minutes), which he can raise while it works. */
export function budgetBits(run, limits, onChange) {
  const box = el('div', 'rs-budget');
  const make = (label, help, list, value, key, word) => {
    const id = `rsb-${key}-${run.id}`;
    const l = el('label', 'rs-label', label);
    l.htmlFor = id;
    const s = document.createElement('select');
    s.id = id;
    for (const n of list) s.append(new Option(word(n), String(n), false, n === value));
    s.addEventListener('change', async () => {
      try {
        await api(`/research/${run.id}/budget`, { method: 'PUT', body: { [key]: Number(s.value) } });
      } catch (e) {
        alert(e.message);
      }
      onChange();
    });
    const row = el('div', 'rs-field');
    const head = el('div', 'rs-label-row');
    head.append(l, tip(help));
    row.append(head, s);
    return row;
  };
  box.append(
    make(t('Pages at most'), t('How many pages she may read in this run. Raise it while she works to let her read more.'), limits.budgetPages ?? [4, 8, 12, 20, 30, 40], run.budget.pages, 'pages', (n) => t('up to {n} pages', { n })),
    make(t('Time at most'), t('When the time is up she writes the report with what she has, marked partial.'), limits.budgetMinutes ?? [5, 10, 20, 40, 60], run.budget.minutes, 'minutes', (n) => t('{n} minutes', { n })),
  );
  return box;
}

/** The buttons for the run's state; `act(path)` posts and redraws. */
export function runButtons(run, act, o = {}) {
  const acts = el('div', 'actions-left');
  const id = run.id;
  if (run.status === 'plan' && o.start !== false) acts.append(btn(t('Start'), '', () => void act(`/research/${id}/start`)), btn(t('Change the plan'), 'ghost small', () => void openInLibrary(id)), btn(t('Cancel'), 'ghost', () => void act(`/research/${id}/stop`)));
  if (run.status === 'running') acts.append(btn(t('Pause'), 'ghost', () => void act(`/research/${id}/pause`)), btn(t('Write the report now'), '', () => void act(`/research/${id}/write-now`)), btn(t('Stop'), 'ghost danger-text', () => void act(`/research/${id}/stop`)));
  if (run.status === 'paused') acts.append(btn(t('Resume'), '', () => void act(`/research/${id}/resume`)), btn(t('Write with what she has'), 'ghost', () => void act(`/research/${id}/write-now`)), btn(t('Stop'), 'ghost danger-text', () => void act(`/research/${id}/stop`)));
  if (run.status === 'writing' || run.status === 'planning') acts.append(btn(t('Stop'), 'ghost danger-text', () => void act(`/research/${id}/stop`)));
  if ((run.status === 'done' || run.status === 'stopped') && run.report) {
    if (o.open !== false) acts.append(btn(t('Open the report'), '', () => void openInLibrary(id)));
    if (run.counts?.read) {
      if (!run.topic) acts.append(btn(t('Save as a skill'), 'ghost', () => void act(`/research/${id}/skill`, { refresh: 'never' })), btn(t('Keep it fresh'), 'ghost', () => void act(`/research/${id}/skill`, { refresh: 'weekly' })));
      else if (run.topic.refresh === 'never') acts.append(btn(t('Keep it fresh'), 'ghost', () => void act(`/research/${id}/skill`, { refresh: 'weekly' })));
    }
  }
  return acts;
}

/** The learned topic made from the run (Save as a skill), in a line. */
export function topicLine(run) {
  if (!run.topic) return null;
  const tp = run.topic;
  const what = tp.status === 'ready' ? (tp.refresh === 'never' ? t('Saved as a skill.') : t('Saved as a skill and kept fresh ({how}).', { how: tp.refresh === 'weekly' ? t('every week') : tp.refresh === 'daily' ? t('every day') : t('every month') })) : tp.status === 'failed' ? t('Saving it as a skill failed. Try again from Library → What she has learned.') : t('Saving it as a skill…');
  return el('p', 'small', tp.partial && tp.status === 'ready' ? `${what} ${t('Marked partial.')}` : what);
}

export async function openInLibrary(id) {
  const lib = await import('./library.js');
  await lib.openLibrary();
  await (await import('./research.js')).openResearch(id);
}

/** The plan in plain words (steps and their searches). */
function planWords(run) {
  const ol = el('ol', 'rs-list');
  for (const s of run.plan?.steps ?? []) {
    const li = el('li');
    li.append(el('span', '', s.question), el('span', 'muted small', ` · ${t('searches: {list}', { list: s.searches.join('; ') })}`));
    ol.append(li);
  }
  return ol;
}

/** The chat card for a run (kind 'research'), live until it is done. */
export function researchCard(c) {
  const card = el('div', 'rcard rcard-research');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', t('Research: {question}', { question: c.question }));
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', t('Research: {question}', { question: c.question })));
  const body = el('div', 'rs-card-body');
  const status = el('p', 'small');
  status.setAttribute('role', 'status');
  card.append(head, status, body);
  let timer = null;
  let limits = {};
  let seen = false;
  const draw = async () => {
    clearTimeout(timer);
    // Polling ends when the card leaves the page (the chat redrew or moved on).
    if (card.isConnected) seen = true;
    else if (seen) return;
    let run;
    try {
      run = (await api(`/research/${c.id}`)).run;
    } catch (e) {
      status.textContent = e.status === 404 ? t('This research run was deleted.') : e.message;
      return;
    }
    status.textContent = statusLine(run);
    const act = async (path, bodyIn = {}) => {
      try {
        await api(path, { method: 'POST', body: bodyIn });
      } catch (e) {
        status.textContent = e.message;
        status.classList.add('error');
        return;
      }
      status.classList.remove('error');
      await draw();
    };
    const parts = [];
    if (run.status === 'plan') parts.push(planWords(run));
    if (run.status !== 'planning') parts.push(progressBits(run));
    if (run.status === 'plan' || run.status === 'running' || run.status === 'paused') {
      if (!limits.budgetPages) limits = (await api('/research').catch(() => ({}))).limits ?? {};
      parts.push(budgetBits(run, limits, () => void draw()));
    }
    parts.push(runButtons(run, act));
    const tl = topicLine(run);
    if (tl) parts.push(tl);
    body.replaceChildren(...parts);
    if (working(run.status) || (run.topic && run.topic.status !== 'ready' && run.topic.status !== 'failed')) timer = setTimeout(() => void draw(), POLL_MS);
  };
  void draw();
  return card;
}

/** Many pages in one reply: offer to hand the question to a research run (kind 'research-offer'). */
export function researchOffer(c) {
  const card = el('div', 'rcard rcard-research-offer');
  card.setAttribute('role', 'group');
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', t('This is turning into research')));
  card.append(head, el('p', 'rc-meta', t('She has read many pages in one reply. A research run plans the searches, reads in the background with its own budget, skips sites that block readers and writes a report with sources.')));
  const status = el('p', 'small');
  status.setAttribute('role', 'status');
  const go = btn(t('Turn this into a research run'), '', async () => {
    go.disabled = true;
    try {
      const conv = /(?:^|[#&])c=([^&]+)/.exec(location.hash)?.[1];
      const made = await api('/research', { method: 'POST', body: { question: c.question, ...(conv ? { conversationId: decodeURIComponent(conv) } : {}) } });
      card.replaceWith(researchCard({ id: made.run.id, question: made.run.question }));
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
      go.disabled = false;
    }
  });
  card.append(go, status);
  return card;
}
