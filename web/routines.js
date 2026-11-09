// Phase 121 part A (docs/design/BEGIN.md §4.3, §4.7, §4.12): Planner → Routines. My routines on the
// left (everything that runs on a schedule, with an On/Off switch on each, including things set up
// elsewhere), the gallery on the right (cards grouped Everyday / Work / Coding / Safety). A card
// opens in place: its questions, then the preview (code only: what Turn on will create, the next
// three runs, the cost line), then Turn on. Nothing is created without the preview first; Off is one
// tap. At 390 px the two halves become a segmented control (My routines | Add).
import { t } from './naming.js';
import { icon } from './icons.js';
import { loadWatches } from './watches.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation: (id: string) => void, openSettings: (page: string) => void } | null} */
let ctx = null;
let data = null;
let open = '';

export function initRoutines(c) {
  ctx = c;
  for (const b of document.querySelectorAll('#rt-seg button')) b.addEventListener('click', () => seg(b.dataset.seg));
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
function seg(which) {
  for (const b of document.querySelectorAll('#rt-seg button')) b.setAttribute('aria-pressed', String(b.dataset.seg === which));
  $('#rt-wrap')?.setAttribute('data-seg', which);
}

/** The ? tips of the routine questions (each ≤ 260 characters). */
const FIELD_TIPS = {
  'rt-time': () => t('The time she does it, in your time zone (Settings → You). Type it like 07:30.'),
  'rt-place': () => t('A town or city for the weather, e.g. Leeds. Leave it empty to keep the place you already set on the Morning briefing page.'),
  'rt-day': () => t('The day of the week the review comes, e.g. Sunday evening to plan the week ahead.'),
  'rt-text': () => t('What the reminder says, in your words. It is sent as it is: no model call.'),
  'rt-repeat': () => t('Weekdays: Monday to Friday. Every day: all seven days.'),
  'rt-mode': () => t('How you usually get there, so she counts the right travel time.'),
  'rt-days': () => t('Routines that use a model always have an end date, so nothing runs forever. A week before, she asks if you want 30 more days.'),
  'rt-url': () => t('A product page, e.g. the shop’s page for that exact model. Works best with a shop’s own product page.'),
  'rt-target': () => t('She tells you when the price is below this, in the page’s currency. Just the number, e.g. 90.'),
  'rt-every': () => t('How often she looks at the page. Every 6 hours is the most; each look is one model turn.'),
  'rt-repo': () => t('The GitHub repository as owner/name, e.g. octo-org/hello. Sara asks GitHub with your token; no model call.'),
  'rt-branch': () => t('The branch whose GitHub Actions runs she watches, usually main.'),
  'rt-label': () => t('Only issues with this label become to-dos, e.g. sara. Empty: every new issue.'),
};

export async function loadRoutines(focus) {
  if (!ctx) return;
  try {
    data = await ctx.api('/routines');
  } catch (e) {
    $('#rt-mine').replaceChildren(el('p', 'error', e.message));
    return;
  }
  if (focus) open = focus;
  paintMine();
  paintGallery();
  void loadWatches();
  if (focus) {
    seg('add');
    document.querySelector(`[data-routine="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

function paintMine() {
  const list = data.mine;
  $('#rt-mine-count').textContent = String(list.length);
  const own = list.filter((x) => !x.elsewhere);
  const other = list.filter((x) => x.elsewhere);
  const rows = [];
  if (!list.length) rows.push(el('p', 'muted small', t('Nothing runs on a schedule yet. Pick a routine to start.')));
  for (const x of own) rows.push(mineRow(x));
  if (other.length) {
    const h = el('h4', 'rt-sub', t('Set up elsewhere'));
    h.append(' ', tip(t('Things that already run on a schedule (from Settings or a chat), shown here so you have one list. Off works the same.')));
    rows.push(h, ...other.map(mineRow));
  }
  $('#rt-mine').replaceChildren(...rows);
}

function mineRow(x) {
  const row = el('div', `rt-row${x.on ? '' : ' rt-off'}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', x.title));
  const sw = el('label', 'rt-switch');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = x.on;
  box.setAttribute('aria-label', t('{title}: on or off', { title: x.title }));
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      if (x.elsewhere) {
        if (!box.checked) await ctx.api(`/routines/elsewhere/${x.kind}/${encodeURIComponent(x.key)}/off`, { method: 'POST', body: {} });
      } else await ctx.api(`/routines/mine/${x.rid}/${box.checked ? 'on' : 'off'}`, { method: 'POST', body: {} });
    } catch (e) {
      // A paid routine that ended needs a new preview: open its card with the same answers.
      if (box.checked && x.routineId) {
        open = x.routineId;
        seg('add');
        paintGallery(x.answers);
      }
      alert(e.message);
    }
    await loadRoutines();
  });
  sw.append(box, el('span', '', box.checked ? t('On') : t('Off')));
  head.append(sw);
  row.append(head, el('div', 'rt-when muted small', [x.when, x.cost].filter(Boolean).join(' · ')));
  if (x.status) row.append(el('div', 'rt-status small', x.status));
  if (!x.elsewhere || x.conversationId) {
    const more = el('details', 'rt-more');
    const sum = el('summary', '', '⋯');
    sum.setAttribute('aria-label', t('More'));
    more.append(sum);
    const acts = el('div', 'rt-more-acts');
    if (x.conversationId) acts.append(btn(t('Open its chat'), 'ghost small', () => ctx.openConversation(x.conversationId)));
    if (!x.elsewhere && ['briefing', 'review', 'loop'].includes(x.engine)) acts.append(btn(t('Run now · 1 model call'), 'ghost small', async () => {
      try {
        await ctx.api(`/routines/mine/${x.rid}/run-now`, { method: 'POST', body: {} });
      } catch (e) {
        alert(e.message);
      }
      await loadRoutines();
    }));
    if (!x.elsewhere && x.routineId) acts.append(btn(t('Change answers'), 'ghost small', () => {
      open = x.routineId;
      seg('add');
      paintGallery(x.answers);
    }));
    if (!x.elsewhere) acts.append(btn(t('Remove'), 'ghost small danger', async () => {
      if (!confirm(t('Remove “{title}”? It stops now.', { title: x.title }))) return;
      await ctx.api(`/routines/mine/${x.rid}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      await loadRoutines();
    }));
    more.append(acts);
    row.append(more);
  }
  return row;
}

// PL2c (N31): line icons for the routines (web/icons.js); emoji stay in her messages.
export const ROUTINE_ICON = { 'backup-check': 'archive', bedtime: 'moon', 'ci-watch': 'flask', 'inbox-triage': 'mail', 'leave-on-time': 'car', 'morning-brief': 'sun', 'new-issues': 'branch', 'price-watch': 'flag', stretch: 'heart', 'weekly-review': 'calendar' };
export function routineIcon(id) {
  const s = icon(ROUTINE_ICON[id] ?? 'sparkle', 'rt-ic');
  return s ?? document.createElement('span');
}
const CATS = [['everyday', () => t('Everyday')], ['work', () => t('Work')], ['coding', () => t('Coding')], ['safety', () => t('Safety')]];
function paintGallery(answers) {
  const out = [];
  for (const [cat, name] of CATS) {
    const cards = data.catalog.filter((r) => r.category === cat);
    if (!cards.length) continue;
    out.push(el('h4', 'rt-cat', name()));
    const grid = el('div', 'rt-grid');
    grid.append(...cards.map((r) => card(r, r.id === open ? answers : undefined)));
    out.push(grid);
  }
  $('#rt-gallery').replaceChildren(...out);
}

function costBox(cost) {
  const p = el('p', `rt-cost${cost.free ? ' rt-free' : ''}`);
  p.append(el('strong', '', t('Costs')), ' ', cost.words, ' ', tip(t('A model call is one request to the AI model she thinks with. Local models cost nothing but your computer’s time; cloud models cost a little per call. “At most” limits are enforced by Sara.')));
  return p;
}

function card(r, answers) {
  const c = el('article', `rt-card${r.id === open ? ' rt-open' : ''}`);
  c.dataset.routine = r.id;
  const h = el('h5', 'rt-card-title');
  const ic = el('span', 'rt-icon');
  ic.append(routineIcon(r.id));
  h.append(ic, ' ', r.title);
  c.append(h, el('p', 'rt-pitch small', r.pitch), el('p', 'rt-when small', r.when));
  const needs = el('ul', 'rt-needs');
  for (const n of r.needs) {
    const li = el('li', n.ok ? 'ok' : n.better ? 'better' : 'missing');
    li.append(el('span', '', `${n.ok ? '✓' : n.better ? '+' : '✗'} ${n.label}${n.better && !n.ok ? ` (${t('makes it better')})` : ''}`));
    if (!n.ok) li.append(' ', btn(t('Set it up'), 'ghost small', () => ctx.openSettings(n.open.replace('settings:', ''))));
    needs.append(li);
  }
  if (r.needs.length) c.append(needs);
  c.append(costBox(r.cost));
  if (r.engine === 'loop') c.append(el('p', 'rt-asks small', t('Tools it uses keep your approval settings: if one is set to Ask, the routine pauses and tells you.')));
  if (r.blocked) {
    c.append(el('p', 'muted small', t('Only the owner of this server can turn this on.')));
    return c;
  }
  const blocked = r.needs.some((n) => !n.ok && !n.better);
  if (r.id !== open) {
    // PL2c (N23): a card that needs setup says Set up first and opens the first missing need.
    const first = r.needs.find((n) => !n.ok && !n.better);
    const go = blocked
      ? btn(t('Set up first'), 'rt-setup-first', () => ctx.openSettings(first.open.replace('settings:', '')))
      : btn(t('Turn on'), 'primary', () => {
          open = r.id;
          paintGallery();
          document.querySelector(`[data-routine="${CSS.escape(r.id)}"] input, [data-routine="${CSS.escape(r.id)}"] select`)?.focus();
        });
    c.append(el('div', 'rt-actions', ''));
    c.lastChild.append(go);
    return c;
  }
  // Open: the questions, the preview, Turn on (in a sticky bar at 390).
  const form = el('div', 'rt-form');
  const inputs = {};
  for (const f of r.fields) {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', f.label));
    let inp;
    if (f.kind === 'pick' || f.kind === 'day') {
      inp = document.createElement('select');
      const choices = f.kind === 'day' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => ({ value: String(i), label: t(d) })) : f.choices;
      for (const ch of choices) inp.append(Object.assign(document.createElement('option'), { value: ch.value, textContent: ch.label }));
    } else {
      inp = document.createElement('input');
      inp.type = f.kind === 'time' ? 'time' : f.kind === 'url' ? 'url' : f.kind === 'number' ? 'number' : 'text';
      if (f.kind === 'repo') inp.placeholder = 'owner/name';
      if (f.kind === 'url') inp.placeholder = 'https://';
    }
    const v = answers?.[f.key] ?? r.defaults?.[f.key] ?? f.default ?? '';
    inp.value = String(v);
    inp.addEventListener('change', () => void preview());
    inputs[f.key] = inp;
    lab.append(inp, tip(FIELD_TIPS[f.tip]?.() ?? f.label));
    form.append(lab);
  }
  const pv = el('div', 'rt-preview');
  pv.setAttribute('role', 'status');
  const bar = el('div', 'rt-actions rt-sticky');
  const turnOn = btn(t('Turn on'), 'primary', () => void doTurnOn());
  turnOn.disabled = true;
  const close = btn('', 'ghost icon rt-x', () => {
    open = '';
    paintGallery();
  });
  // A back arrow on the left: on phones the Planner's own round ✕ sits top-right, so two ✕ would collide.
  close.append('←');
  close.setAttribute('aria-label', t('Back to the gallery'));
  close.title = t('Back to the gallery');
  bar.append(turnOn);
  c.append(form, pv, bar);
  h.prepend(close);
  let sig = '';
  const answersNow = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
  async function preview() {
    turnOn.disabled = true;
    try {
      const p = await ctx.api(`/routines/${encodeURIComponent(r.id)}/preview`, { method: 'POST', body: { answers: answersNow() } });
      sig = p.sig;
      const parts = [el('p', 'rt-creates', `${t('Turn on will:')} ${p.creates.join(' · ')}`), el('p', 'small', `${p.schedule}`)];
      if (p.next.length) parts.push(el('p', 'small muted', `${t('Next:')} ${p.next.join(' · ')}`));
      parts.push(costBox(p.cost));
      if (p.tools) {
        const tl = el('p', 'small');
        tl.append(p.tools, ' ', tip(t('Tools she may use for this routine. They keep your approval settings: a tool set to Ask pauses the routine until you are there; Never stays never.')));
        parts.push(tl);
      }
      if (p.sample) parts.push(el('p', 'small rt-sample', p.sample));
      pv.replaceChildren(...parts);
      turnOn.disabled = !p.ok;
    } catch (e) {
      pv.replaceChildren(el('p', 'error', e.message));
    }
  }
  async function doTurnOn() {
    turnOn.disabled = true;
    try {
      await ctx.api(`/routines/${encodeURIComponent(r.id)}/on`, { method: 'POST', body: { answers: answersNow(), sig } });
      open = '';
      await loadRoutines();
      seg('mine');
    } catch (e) {
      pv.prepend(el('p', 'error', e.message));
      await preview();
    }
  }
  void preview();
  return c;
}

/** Today's empty state: three compact cards (company/both: briefing, stretch, review; coding: CI, issues, review). */
export async function todayRoutineCards(path) {
  if (!ctx) return null;
  let d;
  try {
    d = await ctx.api('/routines');
  } catch {
    return null;
  }
  if (!d.suggest || d.mine.some((x) => x.on)) return null;
  const ids = path === 'coding' ? ['ci-watch', 'new-issues', 'weekly-review'] : ['morning-brief', 'stretch', 'weekly-review'];
  const wrap = el('div', 'rt-today');
  wrap.append(el('h4', 'rt-sub', t('Add a routine')));
  const row = el('div', 'rt-today-row');
  for (const id of ids) {
    const r = d.catalog.find((x) => x.id === id);
    if (!r) continue;
    const b = btn('', 'rt-mini', () => void openRoutinesAt(id));
    const name = el('strong', 'rt-mini-name');
    name.append(routineIcon(r.id), ' ', r.title);
    b.append(name, el('span', 'small', r.pitch), el('span', 'small muted', r.cost.free ? t('Free') : r.cost.words.split('(')[0].trim()));
    row.append(b);
  }
  row.append(btn(t('See all routines'), 'ghost', () => void openRoutinesAt('')));
  wrap.append(row);
  return wrap;
}

let opener = null;
/** The app sets how to open Planner → Routines. */
export function setRoutinesOpener(f) {
  opener = f;
}
export async function openRoutinesAt(id) {
  await opener?.();
  await loadRoutines(id || undefined);
}
