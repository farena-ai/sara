// S5 "Ask your whole life" (docs/ASK_EVERYTHING.md): the ask box. One question across emails,
// files, chats, calendars, notes, lists and contacts (GET /api/find/ask), shown as a short answer
// whose lines cite numbered sources [n], then the hits grouped by source. Each hit opens at the
// spot: a chat at the message, a library document at its page, a workspace file at the line, an
// email in full here with the quote marked, an event's details, the planner, a person's card.
// U3.19: also meetings (at the transcript line), trips (at the booking), documents (templates,
// drafts and clause checklists in the Library), research reports and goals.
import { paintIcons } from './icons.js';
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {null | { api: Function, el: Function, openChat: Function, openFile: Function, openPlanner: Function, showPerson: Function, openLibrary: Function, askInChat: Function }} */
let ctx = null;
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const SOURCES = ['mail', 'files', 'chats', 'calendar', 'notes', 'lists', 'contacts', 'meetings', 'trips', 'documents', 'research', 'goals'];
const LABEL = () => ({ mail: t('Emails'), files: t('Files'), chats: t('Chats'), calendar: t('Calendar'), notes: t('Notes'), lists: t('Lists'), contacts: t('Contacts'), meetings: t('Meetings'), trips: t('Trips'), documents: t('Documents'), research: t('Research'), goals: t('Goals') });
const ICON = { mail: 'mail', files: 'library', chats: 'chat', calendar: 'calendar', notes: 'note', lists: 'check', contacts: 'team', meetings: 'captions', trips: 'compass', documents: 'file', research: 'flask', goals: 'target' };
let last = null;
let seq = 0;

const day = (iso) => {
  if (!iso) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return isNaN(d.getTime()) ? String(iso).slice(0, 16) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

export function initAsk(c) {
  ctx = c;
  const d = $('#ask-all');
  if (!d) return;
  $('#ask-go').addEventListener('click', () => void run());
  $('#ask-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  });
  $('#ask-view-back').addEventListener('click', () => showView(false));
  $('#ask-chat').addEventListener('click', () => {
    const q = $('#ask-q').value.trim();
    if (!q) return;
    d.close();
    void ctx.askInChat(q);
  });
  const box = $('#ask-sources');
  for (const s of SOURCES) {
    const lab = el('label', 'ask-src');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = s;
    lab.append(cb, el('span', '', LABEL()[s]));
    box.append(lab);
  }
}

/** Opens the ask box, optionally with a question (and asks it). */
export function openAsk(q = '') {
  const d = $('#ask-all');
  if (!d) return;
  if (!d.open) d.showModal();
  showView(false);
  if (q) {
    $('#ask-q').value = q;
    void run();
  } else $('#ask-q').focus();
}

function showView(on) {
  $('#ask-view').hidden = !on;
  $('#ask-results').hidden = on;
}

async function run() {
  const q = $('#ask-q').value.trim();
  if (!q) return;
  const mine = ++seq;
  const picked = [...document.querySelectorAll('#ask-sources input:checked')].map((x) => x.value);
  const status = $('#ask-status');
  status.textContent = t('Looking everywhere…');
  showView(false);
  let r;
  try {
    r = await ctx.api(`/find/ask?q=${encodeURIComponent(q)}${picked.length < SOURCES.length ? `&sources=${picked.join(',')}` : ''}`);
  } catch (err) {
    if (mine === seq) status.textContent = err.message;
    return;
  }
  if (mine !== seq) return;
  last = r;
  render(r);
}

function render(r) {
  const labels = LABEL();
  const total = r.groups.reduce((n, g) => n + g.items.length, 0);
  $('#ask-status').textContent = total ? t('{n} found in {sources}', { n: total, sources: r.groups.filter((g) => g.items.length).map((g) => labels[g.source]).join(', ') }) : t('Nothing found. Try other words: a name, a place or a topic.');
  const byCite = new Map(r.groups.flatMap((g) => g.items.map((h) => [h.cite, h])));
  // The cited answer.
  const ans = $('#ask-answer');
  const list = $('#ask-answer-list');
  list.replaceChildren(
    ...r.answer.map((line) => {
      const li = el('li', 'ask-line');
      const h = byCite.get(line.cite);
      li.append(el('span', '', `${h ? answerText(h) : ''} `), citeChip(h));
      return li;
    }),
  );
  ans.hidden = !r.answer.length;
  // The groups.
  const out = $('#ask-groups');
  out.replaceChildren();
  for (const g of r.groups) {
    const sec = el('section', 'ask-group');
    const head = el('h3', 'ask-group-head');
    const ic = el('i', 'ic');
    ic.dataset.icon = ICON[g.source];
    head.append(ic, el('span', '', labels[g.source]), el('small', 'muted', String(g.items.length)));
    sec.append(head);
    if (g.error) sec.append(el('p', 'muted small', t("Couldn't search here: {error}", { error: g.error })));
    for (const h of g.items) sec.append(hitRow(h));
    out.append(sec);
  }
  if (r.skipped.length) out.append(el('p', 'muted small ask-skipped', t('Not searched: {list}', { list: r.skipped.map((s) => labels[s.source]).join(', ') })));
  paintIcons(out);
}

const when = (iso) => {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso.length <= 10) return day(iso);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** One answer line, worded from its hit. */
function answerText(h) {
  const quote = `“${clip(h.quote ?? '', 220)}”`;
  const date = day(h.when);
  switch (h.source) {
    case 'mail':
      return t('{who} wrote ({subject}, {date}): {quote}', { who: (h.where ?? '').split(' · ')[0] || t('Someone'), subject: h.title, date, quote });
    case 'files':
      return `${h.title}${h.where ? ` (${h.where})` : ''}: ${quote}`;
    case 'chats':
      return h.where === 'you' ? t('You said in “{chat}” ({date}): {quote}', { chat: h.title, date, quote }) : t('She said in “{chat}” ({date}): {quote}', { chat: h.title, date, quote });
    case 'calendar':
      return t('On your calendar: {title}, {when}', { title: h.title, when: when(h.when) }) + (h.where ? ` (${h.where})` : '');
    case 'notes':
      return t('Your note “{title}”: {quote}', { title: h.title, quote });
    case 'lists':
      return t('On your list: {title}', { title: h.title }) + (h.where ? ` (${whereText(h)})` : '');
    case 'contacts':
      return `${h.title}${h.where ? `, ${whereText(h)}` : ''}: ${quote}`;
    case 'meetings':
      return h.open.line ? t('In the meeting “{title}”, {where}: {quote}', { title: h.title, where: whereText(h), quote }) : t('The notes of “{title}”: {quote}', { title: h.title, quote });
    case 'trips':
      return t('Your trip “{title}”: {quote}', { title: h.title, quote: h.quote });
    case 'documents':
      return `${h.title} (${whereText(h)}): ${h.quote}`;
    case 'research':
      return t('Your research “{title}”: {quote}', { title: h.title, quote });
    case 'goals':
      return t('Your goal “{title}”: {quote}', { title: h.title, quote: h.quote });
    default:
      return quote;
  }
}

function citeChip(h) {
  const b = btn(h ? `[${h.cite}]` : '[?]', 'ask-cite', () => h && void openHit(h));
  if (h) b.title = `${h.title}${h.where ? ` · ${h.where}` : ''}`;
  return b;
}

/** The server's who/where words that are codes, in the person's language. */
function whereText(h) {
  if (h.source === 'chats') return h.where === 'you' ? t('You') : h.where === 'her' ? t('She') : h.where;
  if (h.source === 'lists') return (h.where ?? '').replace(/^to-do\b/, t('To-do')).replace(/\bdone\b/, t('Done'));
  if (h.source === 'meetings' && h.where === 'notes') return t('Notes');
  if (h.source === 'contacts' || h.source === 'documents' || h.source === 'research' || h.source === 'goals' || h.source === 'trips') return localWhere(h.where ?? '');
  return h.where;
}

/** U3.19: the server's English where-words (promise, due, draft, template…) in the person's language. */
function localWhere(w) {
  const words = { promise: t('promise'), draft: t('draft'), report: t('report'), active: t('active'), paused: t('paused'), done: t('done'), stopped: t('stopped'), flight: t('flight'), hotel: t('hotel'), car: t('car'), train: t('train'), event: t('event') };
  return w
    .split(' · ')
    .map((p) => {
      let m;
      if ((m = /^last contact (\S+)$/.exec(p))) return t('last contact {date}', { date: day(m[1]) });
      if ((m = /^due (\S+)$/.exec(p))) return t('due {date}', { date: day(m[1]) });
      if ((m = /^(\d+) of (\d+) steps done$/.exec(p))) return t('{done} of {n} steps done', { done: m[1], n: m[2] });
      if ((m = /^(\d+) sources$/.exec(p))) return t('{n} sources', { n: m[1] });
      if ((m = /^clause checklist$/.exec(p))) return t('clause checklist');
      return words[p] ?? p;
    })
    .join(' · ');
}

function hitRow(h) {
  const a = el('button', 'ask-hit');
  a.type = 'button';
  const top = el('span', 'ask-hit-top');
  top.append(el('span', 'ask-n', `[${h.cite}]`), el('span', 'ask-hit-title', h.title));
  const meta = [whereText(h), day(h.when)].filter(Boolean).join(' · ');
  if (meta) top.append(el('span', 'muted small ask-hit-meta', meta));
  a.append(top);
  if (h.quote && h.quote !== h.title) a.append(el('span', 'ask-quote', `“${h.quote}”`));
  a.addEventListener('click', () => void openHit(h));
  return a;
}

/** Opens a hit at the spot. */
async function openHit(h) {
  const o = h.open;
  const q = $('#ask-q').value.trim();
  const d = $('#ask-all');
  if (o.kind === 'mail') return void openMail(h);
  if (o.kind === 'event') return void showText(h.title, [day(o.start) + (o.start.length > 10 ? ` ${new Date(o.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''), o.where, h.where].filter(Boolean).join(' · '), h.title, h.quote);
  d.close();
  if (o.kind === 'chat') return void ctx.openChat(o.conversationId, o.messageId);
  if (o.kind === 'library') return void ctx.openLibrary(o.docId, o.page ?? 0);
  if (o.kind === 'file') return void ctx.openFile(o.workspace, o.path, h.quote || q);
  if (o.kind === 'note') return void ctx.openPlanner('notes');
  if (o.kind === 'task') return void ctx.openPlanner('tasks');
  if (o.kind === 'list') return void ctx.openPlanner('board');
  if (o.kind === 'person') return void ctx.showPerson(o.id);
  if (o.kind === 'meeting') return void (await import('./meetings.js')).openMeetingsView(o.id, o.line);
  if (o.kind === 'trip') return void (await import('./trips.js')).openTrips(o.id, o.booking);
  if (o.kind === 'goal') return void (await import('./long-goals.js')).openGoals(o.id);
  if (o.kind === 'research') {
    await ctx.openLibrary();
    return void (await import('./research.js')).openResearch(o.id);
  }
}

async function openMail(h) {
  showText(h.title, h.where ?? '', t('Loading…'), '');
  try {
    const m = await ctx.api(`/find/ask/mail?account=${encodeURIComponent(h.open.account)}&id=${encodeURIComponent(h.open.id)}`);
    showText(m.subject || h.title, [t('From: {from}', { from: m.from }), day(m.date), m.account].filter(Boolean).join(' · '), m.text, h.quote);
  } catch (err) {
    showText(h.title, h.where ?? '', err.message, '');
  }
}

/** The email/event in full, the quote marked and scrolled into view. */
function showText(title, where, text, quote) {
  $('#ask-view-title').textContent = title;
  $('#ask-view-where').textContent = where;
  const pre = $('#ask-view-text');
  pre.replaceChildren();
  const flat = String(text ?? '');
  const needle = String(quote ?? '').replace(/^…|…$/g, '').slice(0, 80);
  const at = needle ? flat.replace(/\s+/g, ' ').indexOf(needle) : -1;
  if (at >= 0) {
    // Map the position in the flattened text back to the original.
    const norm = flat.replace(/\s+/g, ' ');
    const startWord = norm.slice(0, at).split(' ').length - 1;
    const parts = flat.split(/(\s+)/);
    let w = 0;
    let i = 0;
    for (; i < parts.length && w < startWord; i++) if (!/^\s+$/.test(parts[i]) && parts[i] !== '') w++;
    const before = parts.slice(0, i).join('');
    const rest = flat.slice(before.length);
    const len = Math.min(rest.length, Math.max(needle.length, quote.length));
    const mark = el('mark', 'ask-mark', rest.slice(0, len));
    pre.append(document.createTextNode(before), mark, document.createTextNode(rest.slice(len)));
    showView(true);
    mark.scrollIntoView?.({ block: 'center' });
  } else {
    pre.textContent = flat;
    showView(true);
  }
}

/** For tests and the command bar: the last result. */
export const askLast = () => last;
