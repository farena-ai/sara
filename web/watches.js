// E4 (docs/WATCHES.md): Planner → Routines → Watch a file. The owner picks a file in one of his
// workspaces (or Sara's own log), a few words to look for and how often; each watch has Check now,
// Pause / Turn on, Stop and Delete. The chat card for a new matching line has "Ask about this",
// which puts his own question in the message box (and says so first when a cloud model would read
// it). Nothing here runs a command; checking never calls a model.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, ask?: (conversationId: string, text: string) => void, openWatches?: () => void } | null} */
let ctx = null;
let data = null;
let adding = false;
const EVERY = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

export function initWatches(c) {
  ctx = c;
}
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const everyWords = (m) => (m % 60 ? t('every {n} min', { n: m }) : t('every {n} h', { n: m / 60 }));

const STATE_WORDS = {
  restart: () => t('Paused after a restart. Turn it on again when you want.'),
  missing: () => t('Paused: the file was missing or unreadable 3 checks running.'),
  ended: () => t('Ended after 30 days. Add it again to keep watching.'),
};
const ERROR_WORDS = {
  missing: () => t('The file is missing or can’t be read.'),
  link: () => t('It is no longer a plain file, so it isn’t read.'),
  'not-file': () => t('It is no longer a plain file, so it isn’t read.'),
  swapped: () => t('It is no longer a plain file, so it isn’t read.'),
  secret: () => t('That file can’t be watched.'),
  outside: () => t('That file can’t be watched.'),
  rotated: () => t('The log was rotated: reading the new file from the start.'),
  skipped: () => t('Too much at once: the oldest part was skipped.'),
};

export async function loadWatches() {
  const host = $('#rt-watch');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/watches');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can turn this on.') : e.message));
    return;
  }
  const rows = [];
  if (!data.watches.length && !adding) rows.push(el('p', 'muted small', t('No watches yet. Sara only reads the file; she never changes or fixes anything on her own.')));
  for (const w of data.watches) rows.push(await watchRow(w));
  rows.push(adding ? addForm() : btn(t('Watch a file…'), 'ghost', () => {
    adding = true;
    void loadWatches();
  }));
  host.replaceChildren(...rows);
}

async function act(path, method = 'POST') {
  try {
    const r = await ctx.api(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
    await loadWatches();
    return r;
  } catch (e) {
    alert(e.message);
    await loadWatches();
    return null;
  }
}

async function watchRow(w) {
  const row = el('div', `rt-row wt-row${w.state === 'active' ? '' : ' rt-off'}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', w.rootKind === 'log' ? t('Sara’s own log') : `${w.workspace} / ${w.rel}`));
  head.append(el('span', `wt-state wt-${w.state}`, w.state === 'active' ? t('On') : w.state === 'paused' ? t('Paused') : t('Stopped')));
  row.append(head);
  const chips = el('div', 'wt-chips');
  for (const p of w.patterns) chips.append(el('span', 'wt-chip', p));
  if (w.caseIns) chips.append(el('span', 'muted small', t('any case')));
  row.append(chips);
  row.append(el('div', 'rt-when muted small', [everyWords(w.everyMin), t('last checked {time}', { time: hhmm(w.lastCheckAt) }), t('last match {time}', { time: hhmm(w.lastMatchAt) })].join(' · ')));
  const why = (w.state !== 'active' && STATE_WORDS[w.reason]?.()) || ERROR_WORDS[w.lastError]?.();
  if (why) row.append(el('div', 'rt-status small', why));
  if (w.lastMatchAt) {
    const { alerts } = await ctx.api(`/watches/${w.id}/alerts`).catch(() => ({ alerts: [] }));
    for (const a of alerts.slice(0, 3)) row.append(alertLine(a));
  }
  const acts = el('div', 'rt-more-acts');
  if (w.state !== 'stopped') acts.append(btn(t('Check now'), 'ghost small', async () => {
    const r = await act(`/watches/${w.id}/check-now`);
    if (r && !r.result.matched.length) alert(r.preview.length ? t('Nothing new. Earlier lines that match: {n}', { n: r.preview.length }) : t('Nothing new.'));
  }));
  if (w.state === 'active') acts.append(btn(t('Pause'), 'ghost small', () => void act(`/watches/${w.id}/pause`)));
  if (w.state === 'paused') acts.append(btn(t('Turn on'), 'ghost small', () => void act(`/watches/${w.id}/resume`)));
  if (w.state !== 'stopped') acts.append(btn(t('Stop'), 'ghost small', () => void act(`/watches/${w.id}/stop`)));
  acts.append(btn(t('Stop and forget'), 'ghost small danger', () => {
    if (confirm(t('Stop watching this file and delete its alerts?'))) void act(`/watches/${w.id}`, 'DELETE');
  }));
  row.append(acts);
  return row;
}

function alertLine(a) {
  const p = el('div', 'wt-alert small');
  p.append(el('code', 'wt-line', a.line));
  p.append(el('span', 'muted', a.count > 1 ? t('seen {n}× since {time}', { n: a.count, time: hhmm(a.firstAt) }) : hhmm(a.firstAt)));
  p.append(btn(t('Ask about this'), 'ghost small', () => void askAbout(a.id)));
  return p;
}

/** His own question about one line, in the message box; a cloud model reads it only after he agrees. */
export async function askAbout(alertId) {
  let r;
  try {
    r = await ctx.api(`/watches/alerts/${alertId}/ask`, { method: 'POST', body: {} });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (r.cloud && !confirm(t('Your chat model may run in the cloud, so this line would be sent to it when you press Send. Put it in the message box?'))) return;
  ctx.ask?.(r.conversationId, r.text);
}

function addForm() {
  const box = el('div', 'rt-card rt-open wt-add');
  box.append(el('h5', 'rt-card-title', t('Watch a file')));
  const form = el('div', 'rt-form');
  const field = (label, input, help) => {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', label), input, tip(help));
    form.append(lab);
    return input;
  };
  const where = document.createElement('select');
  for (const n of data.roots.workspaces) where.append(Object.assign(document.createElement('option'), { value: `ws:${n}`, textContent: t('Workspace: {name}', { name: n }) }));
  if (data.roots.log) where.append(Object.assign(document.createElement('option'), { value: 'log', textContent: t('Sara’s own log') }));
  field(t('Where'), where, t('Only files inside your workspaces, or Sara’s own log file. Never keys, Sara’s data, links or folders.'));
  const path = document.createElement('input');
  path.type = 'text';
  path.placeholder = 'logs/app.log';
  const pathLab = field(t('File'), path, t('The file’s path inside the workspace, like logs/app.log. Only lines added after you turn it on count.'));
  const sync = () => pathLab.closest('label')?.toggleAttribute('hidden', where.value === 'log');
  where.addEventListener('change', sync);
  // Pattern chips: up to 5 words, each 2-80 characters, matched as plain text.
  const words = [];
  const chips = el('div', 'wt-chips');
  const word = document.createElement('input');
  word.type = 'text';
  word.placeholder = 'ERROR';
  const paint = () => chips.replaceChildren(...words.map((w, i) => {
    const c = el('span', 'wt-chip', w);
    const x = btn('✕', 'wt-chip-x', () => {
      words.splice(i, 1);
      paint();
    });
    x.setAttribute('aria-label', t('Remove {word}', { word: w }));
    c.append(x);
    return c;
  }));
  const addWord = () => {
    const v = word.value.trim();
    if (v.length >= 2 && v.length <= 80 && words.length < 5 && !words.includes(v)) words.push(v);
    word.value = '';
    paint();
  };
  word.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addWord();
    }
  });
  field(t('Words to look for'), word, t('Up to 5 words or phrases, like ERROR or disk full, each 2 to 80 characters. Plain text, not patterns: a dot is just a dot. Press Enter to add each.'));
  form.append(chips);
  const ci = document.createElement('input');
  ci.type = 'checkbox';
  field(t('Ignore upper and lower case'), ci, t('On: error, Error and ERROR all count. Off: only the exact spelling.'));
  const every = document.createElement('input');
  every.type = 'range';
  every.min = '0';
  every.max = String(EVERY.length - 1);
  every.value = '2';
  const everyOut = el('output', 'small', everyWords(EVERY[2]));
  every.addEventListener('input', () => (everyOut.textContent = everyWords(EVERY[Number(every.value)])));
  field(t('How often'), every, t('How often she reads the new lines: every 5 minutes to once a day. Reading costs nothing (no model). Check now looks at once.'));
  form.append(everyOut);
  sync();
  box.append(form);
  const bar = el('div', 'rt-actions');
  bar.append(btn(t('Cancel'), 'ghost', () => {
    adding = false;
    void loadWatches();
  }));
  bar.append(btn(t('Turn on'), 'primary', async () => {
    if (word.value.trim()) addWord();
    const body = { patterns: words, caseIns: ci.checked, everyMin: EVERY[Number(every.value)], ...(where.value === 'log' ? { root: 'log' } : { root: 'workspace', workspace: where.value.slice(3), path: path.value.trim() }) };
    try {
      await ctx.api('/watches', { method: 'POST', body });
      adding = false;
    } catch (e) {
      alert(e.message);
    }
    await loadWatches();
  }));
  box.append(bar, el('p', 'muted small', t('She tells you about new matching lines in a chat card and a notification, at most one every 10 minutes. She never restarts, edits or fixes anything on her own.')));
  return box;
}

/** The in-chat card for a watch notice (a new matching line, or a paused watch). */
export function watchNotice(m) {
  const w = m.meta?.watch ?? {};
  const card = el('div', 'msg notice watch wt-card');
  const head = el('div', 'wt-card-head small');
  head.append(el('strong', '', `👁 ${t('Watch: {file}', { file: w.file ?? '' })}`));
  if (w.more) head.append(' ', el('span', 'muted', t('(+{n} more)', { n: w.more })));
  card.append(head);
  card.append(w.paused ? el('p', 'small', m.content) : el('code', 'wt-line', m.content));
  const acts = el('div', 'rt-more-acts');
  if (w.alertId && !w.paused) acts.append(btn(t('Ask about this'), 'ghost small', () => void askAbout(w.alertId)));
  acts.append(btn(t('Watches'), 'ghost small', () => ctx?.openWatches?.()));
  card.append(acts);
  return card;
}
