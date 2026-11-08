// EC12 (docs/ops/EC1213_DESIGN.md): Team → Crews. A crew is a few of your helpers with standing
// parts, a brief, a budget and a slot (by hand, every day or every week, or a mail subject). The
// lead hands each member a board card and sends one summary; the deliverable is a file in the
// crew's folder, a card in the crew's chat and, if you like, your Telegram. Stop all stops every
// running crew and pauses them all. Nothing here calls a model by itself.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => Promise<void> } | null} */
let ctx = null;
let data = null;
let editing = null;

export function initCrews(c) {
  ctx = c;
}
const $ = (s) => document.querySelector(s);
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
const DAYS = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];
const STATUS = {
  running: () => t('working'),
  done: () => t('done'),
  failed: () => t('finished with problems'),
  stopped: () => t('stopped'),
  limit: () => t('stopped at its budget'),
  interrupted: () => t('interrupted by a restart'),
};
const when = (s) => (s.kind === 'daily' ? t('Every day at {time}', { time: s.time }) : s.kind === 'weekly' ? t('Every {day} at {time}', { day: DAYS()[s.day], time: s.time }) : t('By hand'));

export async function loadCrews() {
  const host = $('#crews');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/crews');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can use this.') : e.message));
    return;
  }
  const rows = [];
  if (data.pinned) rows.push(el('p', 'muted small', t('Crews are turned off by your admin.')));
  if (!data.crews.length && !editing) rows.push(el('p', 'muted small', t('No crews yet. Start from a template or make your own.')));
  for (const c of data.crews) rows.push(crewRow(c));
  if (editing) rows.push(crewForm(editing));
  else if (!data.pinned) rows.push(addRow());
  if (data.crews.length) {
    const stop = el('div', 'rt-more-acts');
    stop.append(btn(t('Stop all'), 'ghost small danger', () => void stopAll()), tip(t('Stops every crew that is working now and pauses every crew. Nothing starts again until you turn a crew on.')));
    rows.push(stop);
  }
  host.replaceChildren(...rows);
}

async function act(path, method = 'POST', body = {}) {
  try {
    const r = await ctx.api(path, { method, ...(method === 'DELETE' ? {} : { body }) });
    await loadCrews();
    return r;
  } catch (e) {
    alert(e.message);
    await loadCrews();
    return null;
  }
}

async function stopAll() {
  if (!confirm(t('Stop every crew now and pause them all?'))) return;
  const r = await act('/crews/stop-all');
  if (r) alert(t('Stopped {n} and paused {m}.', { n: r.stopped, m: r.paused }));
}

function crewRow(c) {
  const row = el('div', `rt-row crew-row${c.state === 'on' ? '' : ' rt-off'}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', c.name), el('span', `wt-state wt-${c.state === 'on' ? 'active' : 'paused'}`, c.state === 'on' ? t('On') : t('Paused')));
  row.append(head);
  const names = new Map(data.helpers.map((h) => [h.id, `${h.emoji} ${h.name}`]));
  const members = el('ul', 'crew-members small');
  for (const m of c.members) members.append(el('li', '', `${names.get(m.helper) ?? m.helper}: ${m.task}`));
  row.append(members);
  const bits = [when(c.schedule)];
  if (c.mail) bits.push(t('or a mail with “{words}”', { words: c.mail.subject }));
  if (c.nextAt) bits.push(t('next {time}', { time: new Date(c.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }));
  bits.push(t('folder {path}', { path: c.folder }));
  row.append(el('div', 'rt-when muted small', bits.join(' · ')));
  if (c.last) row.append(el('div', 'rt-status small', t('Last run {time}: {status}', { time: new Date(c.last.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), status: STATUS[c.last.status]?.() ?? c.last.status })));
  const acts = el('div', 'rt-more-acts');
  if (!data.pinned && c.last?.status !== 'running') acts.append(btn(t('Run now'), 'ghost small', () => void act(`/crews/${c.id}/run`)));
  acts.append(c.state === 'on' ? btn(t('Pause'), 'ghost small', () => void act(`/crews/${c.id}`, 'PATCH', { state: 'paused' })) : btn(t('Turn on'), 'ghost small', () => void act(`/crews/${c.id}`, 'PATCH', { state: 'on' })));
  if (c.last?.file) acts.append(fileLink(c.last.id));
  acts.append(btn(t('Open the chat'), 'ghost small', () => void openChat(c.conversationId)));
  acts.append(btn(t('Edit'), 'ghost small', () => {
    editing = { ...c };
    void loadCrews();
  }));
  acts.append(btn(t('Delete'), 'ghost small danger', () => {
    if (confirm(t('Delete this crew? Its chat, board and files stay.'))) void act(`/crews/${c.id}`, 'DELETE');
  }));
  row.append(acts);
  return row;
}

function fileLink(runId) {
  const a = el('a', 'ghost small btn-link', t('Open the file'));
  a.href = `/api/crews/runs/${runId}/file`;
  a.download = '';
  return a;
}

async function openChat(id) {
  if ($('#team')?.open) $('#team').close();
  await ctx.openConversation?.(id);
}

function addRow() {
  const box = el('div', 'rt-form crew-add');
  const pick = document.createElement('select');
  pick.append(Object.assign(document.createElement('option'), { value: '', textContent: t('My own crew') }));
  for (const x of data.templates) pick.append(Object.assign(document.createElement('option'), { value: x.id, textContent: x.name }));
  const lab = el('label', 'rt-field');
  lab.append(el('span', '', t('Start from')), pick, tip(t('Research desk: a researcher and a writer, every Friday. Code review crew: a reviewer and a tester, by hand. Weekly planner: your week on Monday morning. You can change everything.')));
  const blurb = el('p', 'muted small', '');
  pick.addEventListener('change', () => (blurb.textContent = data.templates.find((x) => x.id === pick.value)?.blurb ?? ''));
  box.append(lab, blurb, btn(t('Add a crew…'), 'ghost small', () => {
    const tpl = data.templates.find((x) => x.id === pick.value);
    editing = tpl ? { ...tpl.crew } : { name: '', brief: '', members: [{ helper: 'researcher', task: '' }, { helper: 'writer', task: '' }], schedule: { kind: 'manual' } };
    void loadCrews();
  }));
  return box;
}

function crewForm(c) {
  const form = el('div', 'rt-form crew-form');
  const field = (label, input, help) => {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', label), input, tip(help));
    form.append(lab);
    return input;
  };
  const input = (value, max) => Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', maxLength: max });
  const name = field(t('Name'), input(c.name, 60), t('What you call this crew. Its chat and its board are called “Crew: name”.'));
  const brief = document.createElement('textarea');
  brief.rows = 3;
  brief.maxLength = 2000;
  brief.value = c.brief ?? '';
  field(t('What the crew delivers'), brief, t('The brief every member gets with its part, e.g. “A one-page weekly report for me, with sources.”'));
  const list = el('div', 'crew-member-rows');
  const members = (c.members ?? []).map((m) => ({ ...m }));
  const drawMembers = () => {
    list.replaceChildren();
    members.forEach((m, i) => {
      const r = el('div', 'add-row');
      const who = document.createElement('select');
      for (const h of data.helpers) who.append(Object.assign(document.createElement('option'), { value: h.id, textContent: `${h.emoji} ${h.name}`, selected: h.id === m.helper }));
      who.addEventListener('change', () => (m.helper = who.value));
      who.setAttribute('aria-label', t('Helper'));
      const task = input(m.task, 1000);
      task.placeholder = t('Their part, e.g. Find what changed this week');
      task.setAttribute('aria-label', t('Their part'));
      task.addEventListener('input', () => (m.task = task.value));
      r.append(who, task);
      if (members.length > 1) r.append(btn(t('Remove'), 'ghost small', () => (members.splice(i, 1), drawMembers())));
      list.append(r);
    });
    if (members.length < 4) list.append(btn(t('Add a member'), 'ghost small', () => (members.push({ helper: data.helpers[0]?.id ?? 'researcher', task: '' }), drawMembers())));
  };
  drawMembers();
  const memLab = el('div', 'rt-field');
  memLab.append(el('span', '', t('Members')), tip(t('One to four of your helpers (Team → Helpers and limits), each with a standing part. The lead hands each one a board card in this order and checks the work.')));
  form.append(memLab, list);
  const kind = document.createElement('select');
  for (const [v, l] of [['manual', t('By hand')], ['daily', t('Every day')], ['weekly', t('Every week')]]) kind.append(Object.assign(document.createElement('option'), { value: v, textContent: l, selected: (c.schedule?.kind ?? 'manual') === v }));
  field(t('When'), kind, t('By hand: only when you press Run now. Every day or every week: at the time below, in your time zone. A slot missed by more than 6 hours is skipped.'));
  const day = document.createElement('select');
  DAYS().forEach((d, i) => day.append(Object.assign(document.createElement('option'), { value: String(i), textContent: d, selected: (c.schedule?.day ?? 1) === i })));
  field(t('Day'), day, t('The day of the week for a weekly crew.'));
  const time = Object.assign(document.createElement('input'), { type: 'time', value: c.schedule?.time ?? '08:00' });
  field(t('Time'), time, t('The time it starts, in your time zone.'));
  const mail = field(t('Also when a mail says'), input(c.mail?.subject, 80), t('Optional. When you mail Sara’s own mailbox with these words in the subject, the crew starts. Only your own checked mail counts, and the mail’s text never goes to the crew.'));
  const folder = field(t('Folder'), input(c.folder, 120), t('Where each run’s report file goes, inside the crew chat’s workspace. Empty: crews/ and the crew’s name.'));
  const tokens = document.createElement('select');
  for (const [v, l] of [['50000', t('A little (about 40,000 words)')], ['150000', t('Some (about 110,000 words)')], ['400000', t('A lot (about 300,000 words)')]]) tokens.append(Object.assign(document.createElement('option'), { value: v, textContent: l, selected: String(c.limits?.tokens ?? 150000) === v }));
  field(t('Budget for each run'), tokens, t('A run stops at this much reading and writing, at its time limit or after a few helper runs, and says how far it got. Models on your own computer are free.'));
  const minutes = Object.assign(document.createElement('input'), { type: 'number', min: '2', max: '240', value: String(c.limits?.minutes ?? 20) });
  field(t('Time limit (minutes)'), minutes, t('The most one run may take, from 2 to 240 minutes.'));
  const tg = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(c.alsoTo?.includes('telegram')), disabled: !data.telegram });
  field(t('Also send to Telegram'), tg, data.telegram ? t('The summary and the report file also go to your own linked Telegram chat.') : t('Link your Telegram first (Settings → Chat apps).'));
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(c.id ? t('Save') : t('Add the crew'), 'primary small', async () => {
    const body = {
      name: name.value,
      brief: brief.value,
      members,
      schedule: kind.value === 'manual' ? { kind: 'manual' } : kind.value === 'daily' ? { kind: 'daily', time: time.value } : { kind: 'weekly', day: Number(day.value), time: time.value },
      mail: { subject: mail.value },
      folder: folder.value,
      limits: { tokens: Number(tokens.value), minutes: Number(minutes.value) },
      alsoTo: tg.checked ? ['telegram'] : [],
      ...(c.template && !c.id ? { template: c.template } : {}),
    };
    try {
      await ctx.api(c.id ? `/crews/${c.id}` : '/crews', { method: c.id ? 'PATCH' : 'POST', body });
      editing = null;
      await loadCrews();
    } catch (e) {
      alert(e.message);
    }
  }), btn(t('Cancel'), 'ghost small', () => {
    editing = null;
    void loadCrews();
  }));
  form.append(acts);
  return form;
}

/** The crew card in the crew's chat (a notice, labelled as the app's). */
export function crewNotice(m) {
  const c = m.meta?.crew ?? {};
  const card = el('div', 'msg notice crew wt-card');
  const head = el('div', 'wt-card-head small');
  head.append(el('strong', '', `👥 ${t('Crew {name}: {status}', { name: c.name ?? '', status: STATUS[c.status]?.() ?? c.status ?? '' })}`));
  card.append(head);
  card.append(el('p', 'small', t('{cards} board cards, {receipts} receipts', { cards: c.cards ?? 0, receipts: c.receipts ?? 0 })));
  const acts = el('div', 'rt-more-acts');
  if (c.file) acts.append(fileLink(c.runId));
  acts.append(btn(t('Crews'), 'ghost small', () => void ctx?.openTeam?.()));
  card.append(acts);
  return card;
}
