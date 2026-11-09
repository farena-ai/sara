// C6 (docs/LEARN.md): Library → What she has learned. A form (a topic or a website, how deep, how
// often to refresh, the open web or only that site) and the topics she learned: status, last
// refresh, what changed, the knowledge she keeps (with its sources), Refresh now and Forget. Also
// the monthly learning budget on Settings → Budgets. Polls every 2 s while a topic is learning;
// nothing here fetches a page or calls a model itself.
import { parse, toDom } from './markdown.js';
import { locale, serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 2000;
let topicId = null;
let timer = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
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
function field(label, input, help) {
  const id = `lnt-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const l = el('label', 'rs-label', label);
  l.htmlFor = id;
  const row = el('div', 'rs-field');
  const head = el('div', 'rs-label-row');
  head.append(l, tip(help));
  row.append(head, input);
  return row;
}
function select(options, value) {
  const s = document.createElement('select');
  for (const [v, label] of options) s.append(new Option(label, v, false, v === value));
  return s;
}
// A bare date ("2026-11-08") is that calendar day, not UTC midnight shifted into the browser's zone.
const day = (iso) => (iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const nf = (n) => Number(n ?? 0).toLocaleString(locale());

const STATUS = {
  queued: () => t('Waiting to start'),
  learning: () => t('Learning now…'),
  ready: () => t('Up to date'),
  stale: () => t('Out of date: the last refresh failed'),
  failed: () => t('Could not learn this'),
};
const REFRESH = () => [['never', t('Never')], ['daily', t('Every day')], ['weekly', t('Every week')], ['monthly', t('Every month')]];
const DEPTH = () => [['quick', t('Quick')], ['standard', t('Standard')], ['deep', t('Deep')]];
const busy = (s) => s === 'queued' || s === 'learning';

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

/** Opens What she has learned inside the Library window (optionally one topic). */
export async function openLearned(id = null) {
  $('#lib-home').hidden = true;
  $('#lib-doc').hidden = true;
  $('#lib-topics').hidden = false;
  topicId = id;
  await render();
}
export function closeLearned() {
  stopPolling();
  const s = $('#lib-topics');
  if (s) s.hidden = true;
}

async function render() {
  stopPolling();
  const host = $('#lib-t-body');
  if (!host || $('#lib-topics').hidden) return;
  try {
    if (topicId == null) {
      const r = await api('/learn');
      host.replaceChildren(form(r), list(r.topics), budgetLine(r.budget));
      if (r.topics.some((x) => busy(x.status))) timer = setTimeout(() => void render(), POLL_MS);
      return;
    }
    const r = await api(`/learn/${topicId}`);
    host.replaceChildren(topicView(r.topic, r.skill));
    if (busy(r.topic.status)) timer = setTimeout(() => void render(), POLL_MS);
  } catch (e) {
    host.replaceChildren(el('p', 'small error', e.status === 403 ? t('Only the owner of this server can turn this on.') : e.message));
  }
}

function form(r) {
  const box = el('div', 'rs-ask lnt-form');
  const what = document.createElement('input');
  what.type = 'text';
  what.maxLength = 500;
  what.placeholder = t('A topic, or a web address such as https://docs.example.com');
  box.append(field(t('Topic or website'), what, t('She searches the web for a topic, or reads one public site. She keeps what she learned as a skill with its sources and dates, and answers from it when you ask.')));
  const grid = el('div', 'lnt-grid');
  const depth = select(DEPTH(), 'standard');
  const refresh = select(REFRESH(), 'weekly');
  const scope = select([['web', t('The open web')], ['site', t('Only this site')]], 'web');
  grid.append(
    field(t('How deep'), depth, t('Quick reads about 5 pages (10 on one site), Standard about 12 (40), Deep about 25 (80). Deeper takes longer and uses more of the monthly learning budget.')),
    field(t('Keep it fresh'), refresh, t('She reads it again on this schedule, keeps the old version and notes what changed. Good for news, prices and anything that moves.')),
    field(t('Sources'), scope, t('The open web uses your web search. Only this site reads just the address you typed: same site, robots.txt respected, one page at a time.')),
  );
  box.append(grid);
  const notify = document.createElement('input');
  notify.type = 'checkbox';
  const nl = el('label', 'row small');
  nl.append(notify, document.createTextNode(` ${t('Tell me when something changes')} `), tip(t('One message after a refresh that found something new, never during quiet hours.')));
  box.append(nl);
  if (!r.ready) box.append(el('p', 'small error', serverText({ error: r.siteWhy }, r.siteWhy ?? '')));
  else if (r.why) box.append(el('p', 'small muted', serverText({ error: r.why }, r.why)));
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const go = btn(t('Learn it'), '', async () => {
    const v = what.value.trim();
    const isSite = /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v);
    go.disabled = true;
    try {
      const body = { depth: depth.value, refresh: refresh.value, notify: notify.checked, scope: isSite ? scope.value === 'web' ? 'site' : scope.value : 'web', ...(isSite ? { site: v } : { subject: v }) };
      const made = await api('/learn', { method: 'POST', body });
      topicId = made.topic.id;
      await render();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
      go.disabled = false;
    }
  });
  go.disabled = !r.ready;
  const acts = el('div', 'actions-left');
  acts.append(go);
  box.append(acts, status);
  return box;
}

function list(topics) {
  const box = el('div', 'rs-past lnt-list');
  box.append(el('h3', '', t('What she has learned')));
  if (!topics.length) {
    box.append(el('p', 'muted small', t('Nothing yet. Try a topic you follow, like a team, a product or a hobby.')));
    return box;
  }
  for (const x of topics) {
    const b = btn('', 'rs-past-run lnt-row', () => {
      topicId = x.id;
      void render();
    });
    const meta = [STATUS[x.status]?.() ?? x.status, x.lastGoodAt ? t('learned {date}', { date: day(x.lastGoodAt) }) : '', x.refresh !== 'never' ? REFRESH().find((r) => r[0] === x.refresh)?.[1] : ''].filter(Boolean).join(' · ');
    b.append(el('span', 'rs-past-q', x.subject), el('span', `muted small lnt-status lnt-${x.status}`, meta));
    box.append(b);
  }
  return box;
}

function budgetLine(b) {
  return el('p', 'muted small', t('Learning this month: about {used} of {max} tokens (Settings → Budgets).', { used: nf(b.used), max: nf(b.monthlyTokens) }));
}

function changesView(c) {
  const box = el('div', 'lnt-changes');
  box.append(el('h4', '', t('What changed since {date}', { date: day(c.since) })));
  const ul = el('ul', 'rs-list');
  for (const a of c.added) ul.append(el('li', '', `${t('New')}: ${a.replace(/\s*\[\d+\]\([^)]*\)/g, '')}`));
  for (const r of c.removed) ul.append(el('li', 'muted', `${t('No longer in the sources')}: ${r}`));
  if (!c.added.length && !c.removed.length) ul.append(el('li', 'muted', t('Nothing new in the sources.')));
  box.append(ul);
  return box;
}

function topicView(x, skill) {
  const box = el('div', 'rs-run lnt-topic');
  box.append(el('h3', 'rs-question', x.subject));
  const st = el('p', `small lnt-status lnt-${x.status}`, STATUS[x.status]?.() ?? x.status);
  st.setAttribute('role', 'status');
  box.append(st);
  if (x.error && (x.status === 'stale' || x.status === 'failed')) box.append(el('p', 'small error', serverText({ error: x.error }, x.error)));
  const facts = el('p', 'muted small', [x.site ? new URL(x.site).host : t('The open web'), x.lastGoodAt ? t('learned {date}', { date: day(x.lastGoodAt) }) : '', x.nextDueAt ? t('next refresh {date}', { date: day(x.nextDueAt) }) : ''].filter(Boolean).join(' · '));
  box.append(facts);
  const grid = el('div', 'lnt-grid');
  const refresh = select(REFRESH(), x.refresh);
  refresh.addEventListener('change', () => void api(`/learn/${x.id}`, { method: 'PUT', body: { refresh: refresh.value } }).then(render).catch((e) => alert(e.message)));
  const notify = document.createElement('input');
  notify.type = 'checkbox';
  notify.checked = x.notify;
  notify.addEventListener('change', () => void api(`/learn/${x.id}`, { method: 'PUT', body: { notify: notify.checked } }).catch((e) => alert(e.message)));
  const nl = el('label', 'row small');
  nl.append(notify, document.createTextNode(` ${t('Tell me when something changes')}`));
  grid.append(field(t('Keep it fresh'), refresh, t('She reads it again on this schedule, keeps the old version and notes what changed. Good for news, prices and anything that moves.')), nl);
  box.append(grid);
  const acts = el('div', 'actions-left');
  const again = btn(t('Refresh now'), '', () => void api(`/learn/${x.id}/refresh`, { method: 'POST', body: {} }).then(render).catch((e) => alert(e.message)));
  again.disabled = busy(x.status);
  acts.append(
    again,
    btn(t('Forget this topic'), 'ghost danger-text', async () => {
      if (!confirm(t('Forget {topic}? Her notes, every older version and the sources list are deleted.', { topic: x.subject }))) return;
      await api(`/learn/${x.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      topicId = null;
      await render();
    }),
    btn(t('All topics'), 'ghost', () => {
      topicId = null;
      void render();
    }),
  );
  box.append(acts);
  const last = x.runs.find((r) => r.changes);
  if (last) box.append(changesView(last.changes));
  if (skill) {
    const md = el('div', 'rs-report-text lnt-knowledge');
    // The knowledge as she keeps it; her change note is shown above, in your language.
    md.append(toDom(parse(skill.body.replace(/^## What changed since[\s\S]*?(?=^## )/m, ''))));
    box.append(el('h4', '', t('What she knows')), md);
    if (skill.versions.length) box.append(el('p', 'muted small', t('{n} older versions kept (Settings → Skills → {name}).', { n: skill.versions.length, name: skill.name })));
  }
  if (x.runs.length) {
    box.append(el('h4', '', t('Runs')));
    const ul = el('ul', 'rs-list small');
    for (const r of x.runs) ul.append(el('li', r.outcome === 'ok' ? '' : 'error', `${day(r.at)} · ${t('{n} pages read', { n: r.pages })} · ${t('about {n} tokens', { n: nf(r.tokens) })}${r.error ? ` · ${serverText({ error: r.error }, r.error)}` : ''}`));
    box.append(ul);
  }
  return box;
}

// ---- Settings → Budgets: the monthly learning budget ----
export async function loadLearnBudget() {
  const s = $('#learn-monthly');
  if (!s) return;
  try {
    const r = await api('/learn');
    s.replaceChildren(...r.budget.choices.map((n) => new Option(t('{n} tokens a month', { n: nf(n) }), String(n), false, n === r.budget.monthlyTokens)));
    $('#learn-used').textContent = t('Used this month: about {used} tokens.', { used: nf(r.budget.used) });
    s.dataset.loaded = '1';
  } catch {
    /* not the owner, or learning isn't here */
  }
}
export async function saveLearnBudget() {
  const s = $('#learn-monthly');
  if (!s?.dataset.loaded) return;
  await api('/learn/settings', { method: 'PUT', body: { monthlyTokens: Number(s.value) } });
}

$('#library')?.addEventListener('close', stopPolling);
