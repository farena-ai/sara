// Phase 118 (docs/design/PERSIST.md §4.11, §5.9): keep going until it's done, and repeats.
//
// Above the composer: one chip for this chat's goal (🎯 the goal · a ring for the closest cap · the
// round · Working / Checking… / Paused · Pause or Resume · Stop) and one per repeat (🔁 the prompt ·
// every … · next … · n of max · Pause or Resume · Stop · Check now). The + menu opens the goal card
// (Done when, caps, Start) or the repeat card (every, for, stop when, at night, the estimate, Start).
// Nothing starts until he presses Start. Planner → Repeats lists every repeat; Settings → Abilities
// → Keep going and repeats holds the limits. Every button has a text label; the strip is a status
// region and announces state changes once.
import { t } from './naming.js';
import { icon, paintIcons } from './icons.js';
import { presetSummary, whichPreset } from './persist-presets.js';
import { emptyState } from './tidy.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, state: any, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation: (id: string) => void, openSettings: (page: string) => void } | null} */
let ctx = null;
let goal = null;
let loops = [];
let lastSaid = '';
let timer = 0;

export function initPersist(c) {
  ctx = c;
  $('#persist-goal')?.addEventListener('click', () => void openGoalCard());
  $('#persist-loop')?.addEventListener('click', () => void openLoopCard());
  clearInterval(timer);
  timer = setInterval(paintStrip, 30_000);
}

const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick, aria) => {
  const b = el('button', `ghost small ${cls}`.trim(), label);
  b.type = 'button';
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
};
const fmtN = (n) => Number(n || 0).toLocaleString();
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const everyWords = (m) => (m >= 60 && m % 60 === 0 ? t('every {n} h', { n: m / 60 }) : t('every {n} min', { n: m }));
const conv = () => ctx?.state.currentId;

/** Called when a conversation opens (and on hub events for it). */
export async function persistOpen(id = conv()) {
  if (!ctx || !id) return;
  try {
    const [g, l] = await Promise.all([ctx.api(`/conversations/${id}/goal`), ctx.api(`/conversations/${id}/loops`)]);
    if (id !== conv()) return;
    goal = g.allowed ? g.goal : null;
    loops = (l.loops ?? []).filter((x) => !['done', 'ended', 'stopped', 'draft'].includes(x.state));
    const items = $('#composer-menu');
    for (const b of [$('#persist-goal'), $('#persist-loop')]) if (b) b.hidden = !g.allowed;
    if (items) items.dataset.persist = g.allowed ? '1' : '';
  } catch {
    goal = null;
    loops = [];
    for (const b of [$('#persist-goal'), $('#persist-loop')]) if (b) b.hidden = true;
  }
  paintStrip();
}

/** Hub events: `goal` / `loop` for the open chat repaint the strip; Planner follows. */
export function persistEvent(type, ev) {
  if (ev?.conversationId === conv()) {
    if (type === 'goal') goal = ev.goal;
    else if (ev.loop) {
      loops = loops.filter((x) => x.id !== ev.loop.id);
      if (!['done', 'ended', 'stopped', 'draft'].includes(ev.loop.state)) loops.push(ev.loop);
    }
    paintStrip();
  }
  if ($('#repeats-list') && !$('#repeats-list').closest('[hidden]')) void loadRepeats();
}

function stateWords(g) {
  if (g.state === 'checking') return t('Checking…');
  if (g.state === 'running') return t('Working');
  if (g.state === 'paused') return t('Paused: {why}', { why: reasonWords(g.reason) });
  if (g.state === 'done') return g.reason === 'review' ? t('Done, review it') : t('Done');
  if (g.state === 'stuck') return t('Stuck');
  return t('Stopped');
}
function reasonWords(r) {
  const m = { owner: t('by you'), restart: t('Sara restarted'), budget: t('the reply budget'), approval: t('an OK is waiting'), crisis: t('for now'), 'private-local': t('no local model'), error: t('an error'), 'cap:rounds': t('the round limit'), 'cap:minutes': t('the time limit'), 'cap:tokens': t('the token budget'), 'cap:usd': t('the dollar budget'), 'cap:day': t('today’s budget') };
  return m[r] ?? r ?? '';
}

function ring(frac, label) {
  // The ring's fill is one of eleven classes (no inline styles).
  const r = el('span', `ps-ring ps-ring-${Math.round(Math.max(0, Math.min(1, frac || 0)) * 10)}`);
  r.setAttribute('role', 'img');
  r.setAttribute('aria-label', label);
  return r;
}

function paintStrip() {
  const strip = $('#persist-strip');
  if (!strip || !ctx) return;
  strip.replaceChildren();
  const g = goal && !['draft'].includes(goal.state) && !(['done', 'stuck', 'stopped'].includes(goal.state) && Date.now() - Date.parse(goal.updatedAt) > 10 * 60_000) ? goal : null;
  if (g) {
    const chip = el('div', `ps-chip ps-goal ps-${g.state}${g.reason === 'review' ? ' ps-review' : ''}`);
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', t('This chat’s goal'));
    const used = t('{n} of {max} rounds', { n: g.round, max: g.caps.rounds });
    chip.append(el('span', 'ps-icon', '🎯'), el('span', 'ps-text', g.text), ring(g.frac, `${used}, ${Math.round((g.frac || 0) * 100)}%`), el('span', 'ps-meta muted small', `${t('Round {n} of {max}', { n: g.round, max: g.caps.rounds })} · ${stateWords(g)}`));
    if (g.lastCheck && !g.lastCheck.ok) chip.append(el('span', 'ps-meta muted small', g.lastCheck.failed ? t('{n} failing', { n: g.lastCheck.failed }) : t('not passing yet')));
    const act = (path, body) => () => void ctx.api(`/conversations/${g.conversationId}/goal/${path}`, { method: 'POST', body: body ?? {} }).then((r) => ((goal = r.goal), paintStrip())).catch((e) => alert(e.message));
    if (g.meta?.asking) chip.append(btn(t('Yes, it’s done'), 'ps-yes', act('said', { done: true })), btn(t('Not yet'), 'ps-no', act('said', { done: false })));
    if (g.state === 'running' || g.state === 'checking') chip.append(btn(t('Pause'), 'ps-pause', act('pause')));
    if (g.state === 'paused') {
      const more = g.reason === 'cap:rounds' ? { rounds: 2 } : g.reason === 'cap:minutes' ? { minutes: 30 } : g.reason === 'cap:tokens' ? { tokens: 500000 } : {};
      chip.append(btn(g.reason?.startsWith('cap:') ? t('Resume with more') : t('Resume'), 'ps-resume', act('resume', { more })));
    }
    if (g.state === 'stuck') chip.append(btn(t('Try again'), 'ps-retry', act('retry')));
    if (!['done', 'stuck', 'stopped'].includes(g.state)) chip.append(btn(t('Stop'), 'ps-stop danger', act('stop')));
    chip.append(btn(t('History'), 'ps-history', () => void showRounds(g)));
    strip.append(chip);
  }
  for (const l of loops) {
    const chip = el('div', `ps-chip ps-loop ps-${l.state}`);
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', t('A repeat in this chat'));
    const next = l.state === 'paused' ? t('Paused: {why}', { why: reasonWords(l.reason) }) : l.state === 'ticking' ? t('Checking…') : t('next {time}', { time: hhmm(l.nextAt) });
    chip.append(el('span', 'ps-icon', '🔁'), el('span', 'ps-text', l.prompt), el('span', 'ps-meta muted small', `${everyWords(l.everyMin)} · ${next} · ${t('{n} of {max}', { n: l.ticks, max: l.maxTicks })}`));
    const act = (path, body) => () => void ctx.api(`/loops/${l.id}/${path}`, { method: 'POST', body: body ?? {} }).then((r) => persistEvent('loop', { conversationId: l.conversationId, loop: r.loop })).catch((e) => alert(e.message));
    if (l.state === 'active') chip.append(btn(t('Check now'), 'ps-now', act('run-now')), btn(t('Pause'), 'ps-pause', act('pause')));
    if (l.state === 'paused') chip.append(btn(l.reason === 'approval' ? t('Allow once and resume') : t('Resume'), 'ps-resume', act('resume', l.reason === 'approval' ? { allowOnce: true } : {})));
    chip.append(btn(t('Stop'), 'ps-stop danger', act('stop')));
    strip.append(chip);
  }
  strip.hidden = !strip.childElementCount;
  // Announce a state change once (not every ring tick).
  const said = [g ? `${g.text}: ${stateWords(g)}` : '', ...loops.map((l) => `${l.prompt}: ${l.state}`)].join('; ');
  const live = $('#persist-live');
  if (live && said !== lastSaid) live.textContent = said;
  lastSaid = said;
}

async function showRounds(g) {
  const r = await ctx.api(`/conversations/${g.conversationId}/goal/rounds`).catch(() => ({ rounds: [] }));
  const card = openCard(t('Rounds'));
  const list = el('ol', 'ps-rounds');
  for (const x of r.rounds) {
    const c = x.checks.at(-1);
    const res = c ? (c.ok ? `✅ ${t('passed')}` : `❌ ${c.failed ? t('{n} failing', { n: c.failed }) : t('not passing yet')}`) : '–';
    const li = el('li', '', `${t('Round {n}', { n: x.round })} · ${res} · ${x.files.length ? x.files.slice(0, 4).join(', ') : t('no files changed')} · ${fmtN(x.tokens)} ${t('tokens')}`);
    list.append(li);
  }
  if (!r.rounds.length) list.append(el('li', 'muted', t('No rounds yet.')));
  card.body.append(list);
}

// ------------------------------------------------------------------ the cards

function openCard(title) {
  const host = $('#persist-card');
  host.replaceChildren();
  host.hidden = false;
  const head = el('div', 'ps-card-head');
  const x = el('button', 'ghost icon ps-x');
  x.type = 'button';
  x.setAttribute('aria-label', t('Cancel'));
  x.append(icon('close') ?? '✕');
  x.addEventListener('click', closeCard);
  head.append(el('strong', '', title), x);
  const body = el('div', 'ps-card-body');
  host.append(head, body);
  return { host, body };
}
function closeCard() {
  const host = $('#persist-card');
  if (host) {
    host.hidden = true;
    host.replaceChildren();
  }
}
const field = (label, control, tipText) => {
  const l = el('label', 'ps-field');
  l.append(el('span', '', label));
  if (tipText) l.append(tip(tipText));
  l.append(control);
  return l;
};
const select = (values, current, word) => {
  const s = el('select');
  for (const v of values) {
    const o = el('option', '', word(v));
    o.value = String(v);
    if (Number(v) === Number(current) || v === current) o.selected = true;
    s.append(o);
  }
  return s;
};

export async function openGoalCard(text = $('#input')?.value ?? '') {
  const id = conv();
  if (!id) return;
  const info = await ctx.api(`/conversations/${id}/goal`);
  if (!info.allowed) return alert(info.why || t('Not in this chat.'));
  const card = openCard(`🎯 ${t('Keep going until it’s done')}`);
  card.body.append(el('p', 'muted small', t('She works in rounds. After each one Sara runs the check you picked; she can’t declare it done herself.')));
  const what = el('textarea', 'ps-what');
  what.rows = 2;
  what.maxLength = 2000;
  what.value = text;
  what.setAttribute('aria-label', t('What she should keep going at'));
  card.body.append(field(t('Keep going until'), what, t('She works in rounds. After each one Sara runs the check you picked; if it fails she gets the real error and goes again, until it passes, she’s stuck, or a cap is reached.')));
  const fs = el('fieldset', 'ps-checks');
  const legend = el('legend', '', t('Done when'));
  legend.append(tip(t('What has to pass. Tests and builds are run by Sara, not by her, and their output is the proof. A reviewer model and I’ll say are for work tests can’t check.')));
  fs.append(legend);
  const def = new Set((info.defaultChecks ?? []).map((c) => c.kind));
  const cmd = el('input', 'ps-cmd');
  cmd.placeholder = 'npm test -- test/a.test.js';
  cmd.setAttribute('aria-label', t('A command that has to pass'));
  for (const c of info.checks) {
    const l = el('label', 'ps-radio');
    const r = el('input');
    r.type = 'radio';
    r.name = 'ps-check';
    r.value = c.kind;
    r.checked = def.has(c.kind) || (!def.size && c.kind === 'owner');
    const words = { tests: t('Tests pass'), build: t('It builds'), lint: t('Lint is clean'), command: t('A command…'), reviewer: t('A reviewer model'), owner: t('I’ll say') }[c.kind];
    l.append(r, el('span', '', words));
    if (c.command) l.append(el('code', 'ps-mono', c.command));
    if (c.kind === 'command') l.append(cmd);
    fs.append(l);
  }
  card.body.append(fs);
  const caps = el('div', 'ps-caps');
  const ch = info.choices;
  const rounds = select(ch.rounds.filter((n) => n <= info.caps.rounds), info.caps.rounds, (n) => t('{n} rounds', { n }));
  const minutes = select(ch.minutes.filter((n) => n <= info.caps.minutes), info.caps.minutes, (n) => t('{n} min', { n }));
  const tokens = select(ch.tokens.filter((n) => n <= info.caps.tokens), info.caps.tokens, (n) => `${fmtN(n)} ${t('tokens')}`);
  caps.append(
    field(t('Rounds'), rounds, t('The most replies she gets for this goal. Each round is one reply within your usual budget per reply.')),
    field(t('Time'), minutes, t('Wall time from Start. Time waiting for your OK and paused time don’t count.')),
    field(t('Tokens for this goal'), tokens, t('All rounds together, counted from the run record. She stops before a round that would go past it, and you can add more.')),
  );
  card.body.append(caps);
  const err = el('p', 'ps-err small');
  err.setAttribute('role', 'alert');
  const start = el('button', 'primary', t('Start'));
  start.type = 'button';
  start.addEventListener('click', async () => {
    const kind = fs.querySelector('input[name="ps-check"]:checked')?.value;
    const checks = kind === 'command' ? [{ kind, command: cmd.value }] : kind ? [kind] : [];
    try {
      const body = { text: what.value, checks, caps: { rounds: Number(rounds.value), minutes: Number(minutes.value), tokens: Number(tokens.value) }, start: true };
      let r;
      try {
        r = await ctx.api(`/conversations/${id}/goal`, { method: 'POST', body });
      } catch (e) {
        if (e.status !== 409 || !confirm(t('This chat already has a goal. Replace it?'))) throw e;
        r = await ctx.api(`/conversations/${id}/goal`, { method: 'POST', body: { ...body, replace: true } });
      }
      goal = r.goal;
      if ($('#input')) $('#input').value = '';
      closeCard();
      paintStrip();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const row = el('div', 'ps-actions');
  row.append(start, btn(t('Not now'), '', closeCard));
  card.body.append(err, row);
  what.focus();
}

export async function openLoopCard(text = $('#input')?.value ?? '') {
  const id = conv();
  if (!id) return;
  const info = await ctx.api(`/conversations/${id}/loops`);
  if (!info.allowed) return alert(t('Not in this chat.'));
  const set = info.settings;
  const card = openCard(`🔁 ${t('Repeat in this chat')}`);
  card.body.append(el('p', 'muted small', t('She does it again on a timer, in this chat, with its context. She only tells you when something changes.')));
  const what = el('textarea', 'ps-what');
  what.rows = 2;
  what.maxLength = 1000;
  what.value = text.replace(/^\/loop\s*/i, '');
  what.setAttribute('aria-label', t('What she should do each time'));
  card.body.append(field(t('Each time'), what, t('She does it again on a timer, in this chat, with its context. Each check is one short reply within its own small budget.')));
  const every = select([5, 10, 15, 30, 60, 120, 360].filter((n) => n >= set.minEvery), 10, everyWords);
  const forM = select([60, 120, 240, 480, 1440].filter((n) => n <= set.maxFor * 60), set.defaultFor * 60, (n) => t('for {n} h', { n: n / 60 }));
  const until = el('input', 'ps-until');
  until.placeholder = t('Optional: the PR is merged, or `npm test`');
  const night = select(['pause', 'hold'], set.quiet, (v) => (v === 'pause' ? t('Don’t check') : t('Keep checking, tell me in the morning')));
  card.body.append(
    field(t('Every'), every, t('How often she checks. Shorter means more replies and more cost. The shortest allowed is set in Settings.')),
    field(t('Until'), forM, t('Every repeat has an end. Without one it stops after {hours} hours.', { hours: set.defaultFor })),
    field(t('Stop when'), until, t('Optional. She stops when this is true and she has looked (a tool really ran). A command in back-ticks is run by Sara and must pass.')),
    field(t('At night'), night, t('Your quiet hours from Messages from her. Don’t check costs nothing at night; Keep checking tells you in the morning.')),
  );
  const est = el('p', 'ps-est muted small');
  const estimate = async () => {
    const u = until.value.trim();
    const line = `every ${every.value}m for ${Number(forM.value)}m${u ? ` until ${u}` : ''}: ${what.value || '…'}`;
    try {
      const r = await ctx.api(`/conversations/${id}/loops/parse`, { method: 'POST', body: { text: line } });
      est.textContent = t('About {n} replies, up to {tokens} tokens each. Today’s cap for all repeats: {daily} tokens. Quiet hours {quiet}.', { n: r.card.ticks, tokens: fmtN(r.card.tickTokens), daily: fmtN(r.card.dailyTokens), quiet: r.card.quietHours });
    } catch (e) {
      est.textContent = e.message;
    }
  };
  for (const c of [every, forM, until]) c.addEventListener('change', () => void estimate());
  void estimate();
  const err = el('p', 'ps-err small');
  err.setAttribute('role', 'alert');
  const start = el('button', 'primary', t('Start'));
  start.type = 'button';
  start.addEventListener('click', async () => {
    const u = until.value.trim();
    const cmd = /^`([^`]+)`$/.exec(u)?.[1];
    try {
      const r = await ctx.api(`/conversations/${id}/loops`, { method: 'POST', body: { prompt: what.value, everyMin: Number(every.value), forMin: Number(forM.value), ...(cmd ? { untilCheck: cmd } : u ? { until: u } : {}), quiet: night.value, start: true } });
      persistEvent('loop', { conversationId: id, loop: r.loop });
      if ($('#input')) $('#input').value = '';
      closeCard();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const row = el('div', 'ps-actions');
  row.append(start, btn(t('Not now'), '', closeCard));
  card.body.append(est, err, row);
  what.focus();
}

// ------------------------------------------------------------------ messages

/** A folded `same` tick (one small line, expandable) or a goal/loop line; undefined = the normal bubble. */
export function persistMessage(m) {
  if (m.role === 'notice' && (m.kind === 'goal' || m.kind === 'loop')) return el('div', `ps-line muted small ps-line-${m.kind}`, m.content);
  if (m.role === 'assistant' && m.meta?.folded && m.meta?.loop) {
    const d = el('details', 'ps-fold');
    d.append(el('summary', 'muted small', `🔁 ${hhmm(m.createdAt)} · ${t('no change')}`), el('div', 'ps-fold-body', m.content));
    return d;
  }
  return undefined;
}

// ------------------------------------------------------------------ Planner → Repeats

export async function loadRepeats() {
  const host = $('#repeats-list');
  if (!host || !ctx) return;
  let r;
  try {
    r = await ctx.api('/loops');
  } catch {
    host.replaceChildren(el('p', 'muted small', t('Repeats aren’t available here.')));
    return;
  }
  host.replaceChildren();
  // PL2c (N21): the one empty state (icon, one line, one button), like Reminders.
  if (!r.loops.length) {
    host.append(emptyState({ icon: 'update', text: t('No repeats yet.'), why: t('She can check something on a timer in a chat and tell you when it changes.'), action: { label: t('Repeat something in a chat'), run: () => startRepeatFromPlanner() } }));
  }
  for (const l of r.loops) {
    const row = el('div', `ps-row ps-${l.state}`);
    const main = el('div', 'ps-row-main');
    main.append(el('strong', '', `🔁 ${l.prompt}`), el('span', 'muted small', `${l.conversationTitle ?? ''} · ${everyWords(l.everyMin)} · ${l.state === 'active' ? t('next {time}', { time: hhmm(l.nextAt) }) : l.state === 'paused' ? t('Paused: {why}', { why: reasonWords(l.reason) }) : l.state} · ${t('ends {time}', { time: hhmm(l.endsAt) })} · ${t('{n} of {max}', { n: l.ticks, max: l.maxTicks })} · ${fmtN(l.todayTokens)} ${t('tokens today')}`));
    const acts = el('div', 'ps-row-acts');
    const act = (path, body) => () => void ctx.api(`/loops/${l.id}/${path}`, { method: 'POST', body: body ?? {} }).then(loadRepeats).catch((e) => alert(e.message));
    if (l.state === 'active') acts.append(btn(t('Pause'), '', act('pause')));
    if (l.state === 'paused') acts.append(btn(t('Resume'), '', act('resume')));
    if (!['done', 'ended', 'stopped'].includes(l.state)) acts.append(btn(t('Stop'), 'danger', act('stop')));
    acts.append(btn(t('Open the chat'), '', () => ctx.openConversation(l.conversationId)));
    row.append(main, acts);
    host.append(row);
  }
  const s = $('#repeats-spend');
  if (s) s.textContent = t('Repeats today: {tokens} of {cap} tokens.', { tokens: fmtN(r.today.tokens), cap: fmtN(r.settings.dailyTokens) });
}

/** From Planner → Repeats: back to the chat with /loop typed, so the / menu and the repeat card take over. */
function startRepeatFromPlanner() {
  const d = $('#planner');
  if (d?.open) d.close();
  const box = $('#input');
  if (!box) return;
  box.value = '/loop ';
  box.focus();
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

// ------------------------------------------------------------------ Settings → Abilities → Keep going and repeats

const IDS = {
  'ps-g-on': ['goals', 'on'], 'ps-g-rounds': ['goals', 'rounds'], 'ps-g-minutes': ['goals', 'minutes'], 'ps-g-tokens': ['goals', 'tokens'], 'ps-g-usd': ['goals', 'usd'], 'ps-g-stuck': ['goals', 'stuckAfter'], 'ps-g-check': ['goals', 'checkMinutes'], 'ps-g-reviewer': ['goals', 'reviewer'],
  'ps-l-on': ['loops', 'on'], 'ps-l-min': ['loops', 'minEvery'], 'ps-l-default': ['loops', 'defaultFor'], 'ps-l-max': ['loops', 'maxFor'], 'ps-l-ticks': ['loops', 'maxTicks'], 'ps-l-tick-tokens': ['loops', 'tick', 'tokens'], 'ps-l-tick-steps': ['loops', 'tick', 'steps'], 'ps-l-daily': ['loops', 'dailyTokens'], 'ps-l-usd': ['loops', 'dailyUsd'], 'ps-l-quiet': ['loops', 'quiet'], 'ps-l-stuck': ['loops', 'stuckAfter'], 'ps-l-fail': ['loops', 'failAfter'], 'ps-l-active': ['loops', 'maxActive'],
};
const CHOICE = { 'ps-g-rounds': ['goals', 'rounds'], 'ps-g-minutes': ['goals', 'minutes'], 'ps-g-tokens': ['goals', 'tokens'], 'ps-g-usd': ['goals', 'usd'], 'ps-g-stuck': ['goals', 'stuckAfter'], 'ps-g-check': ['goals', 'checkMinutes'], 'ps-l-min': ['loops', 'minEvery'], 'ps-l-default': ['loops', 'defaultFor'], 'ps-l-max': ['loops', 'maxFor'], 'ps-l-ticks': ['loops', 'maxTicks'], 'ps-l-tick-tokens': ['loops', 'tickTokens'], 'ps-l-tick-steps': ['loops', 'tickSteps'], 'ps-l-daily': ['loops', 'dailyTokens'], 'ps-l-usd': ['loops', 'dailyUsd'], 'ps-l-stuck': ['loops', 'stuckAfter'], 'ps-l-fail': ['loops', 'failAfter'], 'ps-l-active': ['loops', 'maxActive'] };
const get = (o, path) => path.reduce((x, k) => x?.[k], o);
let presets = null;

/** The numbers in the Fine-tune fields, in the settings' shape. */
function fieldNumbers() {
  const out = { goals: {}, loops: { tick: {} } };
  for (const [id, path] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c || c.type === 'checkbox' || c.tagName !== 'SELECT' || /^(ps-g-reviewer|ps-l-quiet)$/.test(id)) continue;
    let o = out;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path.at(-1)] = Number(c.value);
  }
  return out;
}
/** PL2c (N17): ticks the preset card the Fine-tune numbers match (Custom when none does). */
function showPreset() {
  const id = presets ? whichPreset(presets, fieldNumbers()) : 'custom';
  for (const r of document.querySelectorAll('#ps-presets input[name="ps-preset"]')) r.checked = r.value === id;
  for (const l of document.querySelectorAll('#ps-presets .ps-preset')) l.classList.toggle('on', l.dataset.preset === id);
  const custom = document.querySelector('#ps-presets [data-preset="custom"]');
  if (custom) custom.hidden = id !== 'custom';
  return id;
}
/** Puts a preset's numbers into the Fine-tune fields (the page saves them as it saves any change). */
function applyPreset(id) {
  const p = presets?.[id];
  if (!p) return;
  for (const [cid, path] of Object.entries(IDS)) {
    const c = $(`#${cid}`);
    const v = get(p, path);
    if (!c || v === undefined || c.tagName !== 'SELECT') continue;
    c.value = String(v);
  }
}
let presetsWired = false;
function wirePresets() {
  if (presetsWired) return;
  presetsWired = true;
  $('#ps-presets')?.addEventListener('change', (e) => {
    const v = e.target?.value;
    if (v === 'custom') {
      if ($('#ps-fine')) $('#ps-fine').open = true;
      return;
    }
    applyPreset(v);
    showPreset();
  });
  $('#ps-fine')?.addEventListener('change', () => void showPreset());
}

export async function loadPersistSettings() {
  const form = $('#ps-form');
  if (!form || !ctx) return;
  let v;
  try {
    v = await ctx.api('/persist');
  } catch {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  for (const [id, [part, key]] of Object.entries(CHOICE)) {
    const s = $(`#${id}`);
    if (!s || s.options.length) continue;
    for (const n of v.choices[part][key]) {
      const o = el('option', '', /usd/i.test(id) ? (n ? `$${n}` : t('no cap')) : fmtN(n));
      o.value = String(n);
      s.append(o);
    }
  }
  for (const [id, path] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    const val = get(v.settings, path);
    if (c.type === 'checkbox') c.checked = Boolean(val);
    else {
      // A value set outside these choices (settings file, older version) still shows as itself.
      if (c.tagName === 'SELECT' && ![...c.options].some((o) => o.value === String(val))) {
        const o = el('option', '', typeof val === 'number' ? fmtN(val) : String(val));
        o.value = String(val);
        c.append(o);
      }
      c.value = String(val);
    }
  }
  // PL2c (N17): the preset cards say their numbers in words; the raw numbers fold under Fine-tune.
  presets = v.presets ?? null;
  for (const l of document.querySelectorAll('#ps-presets .ps-preset')) {
    const p = presets?.[l.dataset.preset];
    const sum = l.querySelector('.ps-preset-sum');
    if (p && sum) {
      const w = presetSummary(p);
      sum.replaceChildren(el('span', 'ps-sum-line', w.goal), el('span', 'ps-sum-line', w.repeats));
    }
  }
  paintIcons($('#ps-presets') ?? document.createElement('div'));
  wirePresets();
  if (showPreset() === 'custom' && $('#ps-fine')) $('#ps-fine').open = true;
  const sp = $('#ps-spend');
  if (sp) sp.textContent = t('Repeats today: {tokens} of {cap} tokens.', { tokens: fmtN(v.today.loops.tokens), cap: fmtN(v.settings.loops.dailyTokens) });
  form.dataset.loaded = '1';
}

export async function savePersistSettings() {
  const form = $('#ps-form');
  if (!form?.dataset.loaded || !ctx) return;
  const body = { goals: {}, loops: { tick: {} } };
  for (const [id, path] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    const val = c.type === 'checkbox' ? c.checked : /^(reviewing|quick|pause|hold)$/.test(c.value) ? c.value : Number(c.value);
    let o = body;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path.at(-1)] = val;
  }
  await ctx.api('/persist', { method: 'PUT', body });
}
