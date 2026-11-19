// W5.4 (docs/design/W5KIDS.md): kid mode v2 in the browser.
//  - kidProfileForm: the owner's profile editor on Family → Kids (age band with its defaults, tone,
//    content strictness, study buddy, bedtime, time a day, safe search, the tools she may use,
//    transcript view with the notice the kid sees).
//  - kidDashboard: a parent's view of one kid (time today with +15 minutes, requests to approve or
//    decline, flagged moments as counts, a week of topics in plain words, transcript view when on).
//  - initKidBar: the kid's own bar over the message box (time left, Ask for 15 more minutes, and
//    "a parent can read your chats" while transcript view is on).
// Nothing here calls a model.
import { t } from './naming.js';

const BAND = () => ({ 'under-8': t('Under 8'), '8-12': t('8 to 12'), '13-17': t('13 to 17') });
const TONE = () => ({ simple: t('Simple words'), friendly: t('Friendly'), respectful: t('Respectful, for teens') });
const STRICT = () => ({ strict: t('Strict (no scary or gory stories)'), standard: t('Standard') });
const FLAG = () => ({ 'kept off': t('Asked about something kept off'), worry: t('A worry (she gave them help)'), personal: t('Shared personal details') });
const TOPIC = () => ({ homework: t('homework'), math: t('math'), reading: t('reading and writing'), science: t('science'), history: t('history and places'), games: t('games'), 'music and art': t('music and art'), sports: t('sports'), feelings: t('feelings and friends'), 'chores and money': t('chores and money'), other: t('other things'), 'kept off': t('asked about something kept off') });
/** The kid tools in plain groups a parent can turn on or off. */
const GROUPS = () => [
  [t('To-dos and reminders'), ['todo', 'remind']],
  [t('Notes and what she remembers'), ['note', 'recall', 'facts_list', 'fact_forget']],
  [t('Chores and allowance'), ['chore_list', 'chore_done', 'allowance_balance']],
  [t('Family calendar'), ['family_calendar']],
  [t('Family lists and boards'), ['household_lists', 'board_list', 'card_add', 'card_move', 'card_comment']],
  [t('Study sets and quizzes'), ['study_make', 'study_list', 'study_quiz', 'study_answer']],
  [t('Help deciding'), ['decide', 'compare', 'ask_choice', 'settings_guide']],
  [t('Scrapbook and moments'), ['scrapbook', 'moments']],
  [t('Library and documents'), ['library', 'make_document']],
  [t('Safe web search'), ['kid_search']],
  [t('Searching their own things'), ['ask_everything']],
  [t('Rewriting text'), ['humanize_text']],
];
const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The owner's profile editor for one person. `h` lends Family's helpers
 * ({el, btn, tip, input, select, field, run, api}); `opts` is /api/family's options.
 */
export function kidProfileForm(p, prof, opts, h) {
  const wrap = h.el('div', 'kid-form');
  const on = h.input('', { type: 'checkbox', checked: p.child });
  const onL = h.el('label', 'fam-check');
  onL.append(on, h.el('span', '', t('Kid-safe mode')), h.tip(t('For a child: adult content always off, kid-friendly tone, no computer use, shopping, mail or outside apps. Only you can turn it off.')));
  wrap.append(onL);
  const grid = h.el('div', 'fam-grid');
  const bandSel = h.select((opts.bands ?? []).map((b) => [b, BAND()[b] ?? b]), prof?.band ?? '8-12', t('Age band'));
  const tone = h.select(Object.entries(TONE()), prof?.tone ?? 'friendly', t('Her words'));
  const strict = h.select(Object.entries(STRICT()), prof?.strictness ?? 'strict', t('Content'));
  const buddy = h.input('', { type: 'checkbox', checked: prof ? prof.studyBuddy !== false : true });
  const buddyL = h.el('label', 'fam-check');
  buddyL.append(buddy, h.el('span', '', t('Study buddy for homework')), h.tip(t('She asks what they think first, gives one hint at a time and checks with a quick question. Under 13 she never writes essays for them.')));
  const bed = h.input('', { type: 'checkbox', checked: prof ? Boolean(prof.bedtime) : true });
  const bedL = h.el('label', 'fam-check');
  bedL.append(bed, h.el('span', '', t('Bedtime')));
  const from = h.input('', { type: 'time', value: prof?.bedtime?.from ?? '20:30' });
  const to = h.input('', { type: 'time', value: prof?.bedtime?.to ?? '07:00' });
  const minutes = h.select(opts.minutes.map((m) => [String(m), m ? t('{n} minutes', { n: m }) : t('No limit')]), String(prof?.minutesPerDay ?? 60), t('Time a day'));
  const safe = h.input('', { type: 'checkbox', checked: Boolean(prof?.safeSearch) });
  const safeL = h.el('label', 'fam-check');
  safeL.append(safe, h.el('span', '', t('Safe web search')), h.tip(t('Lets her search the web for them in strict safe-search mode (Brave Search or SearXNG only). Shops and grown-up results are left out.')));
  const allow = h.input('', { value: (prof?.shopAllow ?? []).join(', '), placeholder: 'scholastic.com' });
  grid.append(
    h.field(t('Age band'), bandSel, t('Each age starts with its own tools, words, limits and bedtime. Change any of them below.')),
    h.field(t('Her words'), tone, t('Simple for young kids, friendly for 8 to 12, respectful for teens.')),
    h.field(t('Content'), strict, t('Strict also keeps scary and gory stories off. Grown-up content is always off.')),
    h.field(t('Time a day'), minutes, t('Counted in 5-minute blocks with a message. Near the end she helps them wrap up; they can ask you for 15 more minutes.')),
  );
  const bedRow = h.el('div', 'kid-row');
  bedRow.append(bedL, h.field(t('From'), from), h.field(t('To'), to));
  const checks = h.el('div', 'kid-row');
  checks.append(buddyL, safeL);
  wrap.append(grid, bedRow, checks, h.field(t('Shop sites allowed in search'), allow, t('Search leaves out shopping sites except these (comma-separated), e.g. a book club site.')));
  // The tools she may use, in plain groups (a profile from before W5.4 has every kid tool on).
  const have = new Set(prof?.tools ?? opts.kidTools ?? []);
  const tools = h.el('details', 'kid-tools');
  const sum = h.el('summary', '', t('What she may help with'));
  tools.append(sum);
  const boxes = [];
  const tg = h.el('div', 'kid-tool-grid');
  for (const [label, names] of GROUPS()) {
    const live = names.filter((n) => (opts.kidTools ?? []).includes(n));
    if (!live.length) continue;
    const cb = h.input('', { type: 'checkbox', checked: live.some((n) => have.has(n)) });
    const l = h.el('label', 'fam-check');
    l.append(cb, h.el('span', '', label));
    tg.append(l);
    boxes.push([cb, live]);
  }
  tools.append(tg, h.el('p', 'muted small', t('Never for kids, whatever is asked: grown-up content, money, computer use, Always allow, public records.')));
  wrap.append(tools);
  // Transcript view: off by default; the kid sees a notice while it is on.
  const tr = h.input('', { type: 'checkbox', checked: Boolean(prof?.transcripts?.on) });
  const trL = h.el('label', 'fam-check');
  trL.append(tr, h.el('span', '', t('Transcript view: let parents read their chats')), h.tip(t('Off: you see topics and minutes, never their words. On: they see a notice on their screen that a parent can read their chats, and when you last looked.')));
  wrap.append(trL);
  const defaults = h.btn(t('Use this age’s defaults'), 'ghost small', () => {
    const d = opts.bandDefaults?.[bandSel.value];
    if (!d) return;
    tone.value = d.tone;
    strict.value = d.strictness;
    minutes.value = String(d.minutesPerDay);
    bed.checked = true;
    from.value = d.bedtime.from;
    to.value = d.bedtime.to;
    buddy.checked = d.studyBuddy;
    for (const [cb, names] of boxes) cb.checked = names.some((n) => d.tools.includes(n));
  });
  bandSel.addEventListener('change', () => defaults.click());
  const save = h.btn(t('Save'), 'small', () => void h.run(() => h.api(`/family/kids/${p.id}/profile`, { method: 'PUT', body: { child: on.checked ? { band: bandSel.value, tone: tone.value, strictness: strict.value, studyBuddy: buddy.checked, bedtime: bed.checked ? { from: from.value, to: to.value } : null, minutesPerDay: Number(minutes.value), safeSearch: safe.checked, shopAllow: allow.value, tools: boxes.filter(([cb]) => cb.checked).flatMap(([, n]) => n), transcripts: tr.checked } : null } }), t('Saved.')));
  const row = h.el('div', 'kid-actions');
  row.append(save, defaults);
  wrap.append(row);
  return wrap;
}

/** A parent's dashboard for one kid, drawn into `host` (replaces its content). */
export async function kidDashboard(host, p, h) {
  let d;
  try {
    d = await h.api(`/family/kids/${p.id}/dashboard`);
  } catch (err) {
    host.replaceChildren(h.el('p', 'muted small', err.message));
    return;
  }
  const redraw = () => void kidDashboard(host, p, h);
  const act = async (f, ok) => {
    try {
      await f();
      if (ok) h.say(ok);
    } catch (err) {
      h.say(err.message);
    }
    redraw();
  };
  const out = [h.el('h4', 'kid-h', t('Dashboard'))];
  // Time today.
  const tt = d.today;
  const head = h.el('div', 'kid-dash-row');
  const line = tt.limit ? t('Today: {used} of {limit} minutes', { used: tt.used, limit: tt.limit + tt.extra }) : t('Today: {used} minutes (no limit)', { used: tt.used });
  head.append(h.el('strong', '', line));
  if (tt.limit) {
    const m = h.el('meter', 'kid-meter');
    Object.assign(m, { min: 0, max: Math.max(tt.limit + tt.extra, tt.used) || 1, value: tt.used, low: (tt.limit + tt.extra) * 0.7, high: (tt.limit + tt.extra) * 0.9, optimum: 0 });
    m.setAttribute('aria-label', line);
    head.append(m);
    if (tt.extra) head.append(h.el('span', 'muted small', t('{n} extra minutes today', { n: tt.extra })));
  }
  if (tt.inBedtime) head.append(h.el('span', 'muted small', t('Bedtime now')));
  head.append(h.btn(t('+15 minutes'), 'small', () => void act(() => h.api(`/family/kids/${p.id}/extra`, { method: 'POST', body: { minutes: 15 } }), t('{name} has 15 more minutes today.', { name: p.name }))));
  out.push(head);
  // Requests.
  const waiting = d.requests.filter((r) => r.status === 'pending');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const words = (r) => (r.kind === 'time' ? t('15 more minutes today') : r.kind === 'tool' ? `${cap(t(d.toolWords?.[r.tool] ?? r.tool))}${r.what ? `: “${r.what}”` : ''}` : `“${r.what}”`);
  if (waiting.length) {
    out.push(h.el('h4', 'kid-h', t('Asks you')));
    for (const r of waiting) {
      const row = h.el('div', 'kid-req');
      row.append(h.el('span', '', words(r)), h.el('span', 'muted small', when(r.createdAt)));
      row.append(h.btn(t('Approve'), 'small', () => void act(() => h.api(`/family/requests/${r.id}`, { method: 'POST', body: { approve: true } }), t('Approved.'))), h.btn(t('Decline'), 'ghost small', () => void act(() => h.api(`/family/requests/${r.id}`, { method: 'POST', body: { approve: false } }), t('Declined.'))));
      out.push(row);
    }
  }
  const done = d.requests.filter((r) => r.status !== 'pending').slice(0, 3);
  if (done.length) out.push(h.el('p', 'muted small', done.map((r) => `${words(r)} · ${r.status === 'approved' ? t('approved') : t('declined')}`).join(' · ')));
  // Flagged moments.
  out.push(h.el('h4', 'kid-h', t('Flagged moments (2 weeks)')));
  out.push(d.flags.length ? h.el('p', 'small', d.flags.map((f) => `${FLAG()[f.kind] ?? f.kind}: ${f.n}`).join(' · ')) : h.el('p', 'muted small', t('Nothing flagged.')));
  // The week.
  out.push(h.el('h4', 'kid-h', t('This week')));
  const ul = h.el('ul', 'fam-ledger');
  for (const x of d.days.slice().reverse()) {
    if (!x.minutes && !x.topics.length) continue;
    ul.append(h.el('li', 'small', `${day(x.day)} · ${x.limit ? t('{n} of {limit} min', { n: x.minutes, limit: x.limit }) : t('{n} min', { n: x.minutes })} · ${x.topics.map((y) => TOPIC()[y.topic] ?? y.topic).join(', ')}`));
  }
  if (!ul.children.length) ul.append(h.el('li', 'muted small', t('Nothing this week.')));
  out.push(ul);
  // Transcript view.
  if (d.transcripts.on) {
    out.push(h.el('p', 'muted small', t('Transcript view is on since {when}. {name} sees a notice that a parent can read their chats.', { when: when(d.transcripts.since), name: p.name })));
    const box = h.el('div', 'kid-chats');
    box.append(h.btn(t('Read their chats'), 'ghost small', () => void chats(box, p, h)));
    out.push(box);
  } else out.push(h.el('p', 'muted small', t('Topics only, never their words. Transcript view is off.')));
  host.replaceChildren(...out);
}

async function chats(box, p, h, conv) {
  try {
    const r = await h.api(`/family/kids/${p.id}/chats${conv ? `?c=${encodeURIComponent(conv)}` : ''}`);
    const list = h.el('ul', 'fam-ledger');
    for (const c of r.chats) {
      const li = h.el('li', 'small');
      li.append(h.btn(c.title || t('Chat'), 'ghost small', () => void chats(box, p, h, c.id)));
      list.append(li);
    }
    if (!r.chats.length) list.append(h.el('li', 'muted small', t('No chats yet.')));
    const parts = [list];
    if (r.messages) {
      const log = h.el('div', 'kid-log');
      for (const m of r.messages) log.append(h.el('p', `small kid-msg kid-${m.role}`, `${m.role === 'user' ? p.name : t('Her answer')}: ${m.content}`));
      parts.push(log);
    }
    box.replaceChildren(...parts);
  } catch (err) {
    box.replaceChildren(h.el('p', 'muted small', err.message));
  }
}

// ---------------------------------------------------------------- the kid's own bar
let bar = null;
export async function initKidBar(c) {
  bar = c;
  await refreshKidBar();
  window.addEventListener('focus', () => void refreshKidBar());
  const tick = () => setTimeout(() => void refreshKidBar().finally(tick), 60_000);
  tick();
}

export async function refreshKidBar() {
  const host = document.querySelector('#kid-bar');
  if (!host || !bar) return;
  let k;
  try {
    k = (await bar.api('/family/me/kid')).kid;
  } catch {
    return;
  }
  if (!k) {
    host.hidden = true;
    return;
  }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const parts = [];
  if (k.inBedtime) parts.push(el('span', 'kid-bar-time', t('It’s bedtime. Chat again in the morning.')));
  else if (k.left !== null) parts.push(el('span', `kid-bar-time${k.left <= 10 ? ' low' : ''}`, k.left > 0 ? t('{n} minutes left today', { n: k.left }) : t('Time is up for today.')));
  const asked = k.requests.find((r) => r.kind === 'time' && r.status === 'pending');
  const answered = k.requests.find((r) => r.status !== 'pending' && r.decidedAt && Date.now() - Date.parse(r.decidedAt) < 6 * 3600_000);
  if (asked) parts.push(el('span', 'muted small', t('Asked a parent. Waiting for an answer.')));
  else if (k.left !== null && k.left <= 10 && !k.inBedtime) {
    const b = el('button', 'small', t('Ask for 15 more minutes'));
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await bar.api('/family/me/requests', { method: 'POST', body: { kind: 'time' } });
      } catch (err) {
        b.textContent = err.message;
      }
      void refreshKidBar();
    });
    parts.push(b);
  }
  if (answered) parts.push(el('span', 'muted small', answered.status === 'approved' ? t('A parent said yes.') : t('A parent said not this time.')));
  if (k.transcripts.on) parts.push(el('span', 'kid-bar-seen', k.transcripts.lastViewed ? t('A parent can read your chats here (last looked {when}).', { when: when(k.transcripts.lastViewed) }) : t('A parent can read your chats here.')));
  host.replaceChildren(...parts);
  host.hidden = !parts.length;
}
