// ROADMAP_T T5 (docs/REMOTE_REPAIR.md): remote repair in a one-to-one Messages chat (called from support.js).
//   helped side  "Ask <name> to fix something" → how long + what they may do → Give a fix pass; the active pass
//                chip with Revoke; each incoming plan with per-step (or one plan) approval, live progress,
//                Stop and Undo. A chat request ("can you have Sam fix it") shows here as a card first.
//   helper side  the request with Accept / Decline; "Look and fix <name>'s Sara": problems, plan editor,
//                progress with Stop.
// Nothing here runs anything: the helped server checks and runs every step through its own engines.
import { t } from './naming.js';
import { settingLabel } from './support.js';

let ctx = null;
let state = null;
let reload = async () => {};
let say = (_m) => {};
let panel = (..._n) => {};

const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const SCOPES = () => ({ look: t('Look only'), each: t('Look and fix, with my OK for each step'), pass: t('Look and fix within this pass') });
const STATUS = () => ({ waiting: t('Waiting for OK'), ready: t('Approved'), running: t('Running…'), done: t('Done'), failed: t('Did not work'), declined: t('Declined'), skipped: t('Not run'), refused: t('Refused') });
const PLAN = () => ({ waiting: t('Waiting for OK'), running: t('Running…'), stopping: t('Stopping after this step…'), stopped: t('Stopped'), done: t('Finished'), failed: t('Did not work') });
const scopeText = (s) => SCOPES()[s] ?? s;
// U3.18: a code step's life on the helped server (signed status events), and the report's plain line for it.
const PHASE = () => ({ preparing: t('Being prepared'), prepared: t('Prepared and tested'), 'not-prepared': t('Not prepared'), approved: t('Approved'), applied: t('Applied'), failed: t('Did not work'), rolledback: t('Went back'), undone: t('Undone'), discarded: t('Discarded'), parked: t('Parked') });
const CODE_LINE = () => ({
  preparing: t('Code change #{id} is still being prepared.'),
  prepared: t('Code change #{id} was prepared and tested; it waits for the owner’s OK.'),
  'not-prepared': t('Code change #{id} was not prepared.'),
  approved: t('Code change #{id} was approved and is being applied.'),
  applied: t('Code change #{id} was applied.'),
  failed: t('Code change #{id} did not work.'),
  rolledback: t('Code change #{id} went back: she did not start properly with it.'),
  undone: t('Code change #{id} was undone.'),
  discarded: t('Code change #{id} was discarded.'),
  parked: t('Code change #{id} was parked after an update.'),
});
function codeBox(s) {
  const box = el('div', 'rr-code');
  const head = el('p', 'small');
  head.append(el('span', `rr-badge rr-ph-${s.code.phase}`, PHASE()[s.code.phase] ?? s.code.phase), document.createTextNode(` ${t('Code change #{id}', { id: s.change ?? '?' })}`));
  box.append(head);
  if (s.code.checks?.length) box.append(el('p', 'small muted', `${t('Tests:')} ${s.code.checks.map((c) => `${c.name} ${c.skipped ? t('skipped') : c.ok ? t('passed') : t('failed')}`).join(', ')}`));
  if (s.code.events?.length > 1) box.append(el('p', 'small muted', s.code.events.map((e) => `${PHASE()[e.phase] ?? e.phase} ${when(e.at)}`).join(' → ')));
  return box;
}
const call = (path, o) => ctx.api(`/remote-repair${path}`, o);
const act = (fn, ok) => async () => {
  try {
    await fn();
    if (ok) say(ok);
    await reload();
  } catch (err) {
    say(err.message);
  }
};

export function initRemoteRepair(c, helpers) {
  ctx = c;
  reload = helpers.reload;
  say = helpers.say;
  panel = helpers.panel;
}
export async function loadRemoteRepair() {
  if (!ctx) return;
  try {
    state = await ctx.api('/remote-repair');
  } catch {
    state = null;
  }
}

/** The help log's T5 lines (support.js asks; undefined = not ours). */
export function remoteLogText(r) {
  const n = r.peer;
  const mine = r.side === 'helped';
  switch (r.kind) {
    case 'repair-request':
      return mine ? t('You asked {name} to fix something.', { name: n }) : t('{name} asked you to fix something.', { name: n });
    case 'repair-accept':
      return mine ? t('{name} accepted your fix pass.', { name: n }) : t('You accepted {name}’s fix pass.', { name: n });
    case 'repair-decline':
      return mine ? t('{name} declined your fix pass.', { name: n }) : t('You declined {name}’s fix pass.', { name: n });
    case 'repair-revoke':
      return t('A fix pass with {name} ended.', { name: n });
    case 'repair-look':
      return mine ? t('{name} looked at your Sara.', { name: n }) : t('You looked at {name}’s Sara.', { name: n });
    case 'repair-plan':
      return mine ? t('{name} sent a fix plan.', { name: n }) : t('You sent {name} a fix plan.', { name: n });
    case 'repair-step':
      return t('Fix plan step {detail}', { detail: r.detail });
    case 'repair-stop':
      return t('A fix plan was stopped.');
    case 'repair-undo':
      return t('You undid step {detail}.', { detail: r.detail });
    case 'repair-done':
      return t('A fix plan ended ({detail}).', { detail: r.detail });
    case 'repair-code':
      return t('Code change {detail}', { detail: r.detail });
    case 'repair-recipe':
      return mine ? t('A fix shared by {name}: {detail}', { name: n, detail: r.detail }) : t('A fix you shared with {name}: {detail}', { name: n, detail: r.detail });
    default:
      return undefined;
  }
}

/** Rows above the chat list: a fix request to answer, or a plan step waiting for this owner's OK. */
export function remoteRows(open) {
  const rows = [];
  if (!state) return rows;
  const now = new Date().toISOString();
  const seen = new Set();
  const row = (link, text) => {
    if (seen.has(link)) return;
    seen.add(link);
    const r = el('div', 'msgs-req');
    r.append(el('span', '', text), btn(t('Open'), 'small', () => open(link)));
    rows.push(r);
  };
  for (const p of state.held ?? []) if (p.status === 'asked' && p.expiresAt > now) row(p.link, t('{name} asks you to fix something on their Sara.', { name: p.peer }));
  for (const p of state.plans ?? []) if (p.side === 'in' && p.status === 'waiting') row(p.link, t('{name}’s fix plan is waiting for your OK.', { name: p.peer }));
  return rows;
}

/** The T5 part of a one-to-one chat's strip. */
export function remoteStrip(chat) {
  const box = el('div', 'rr-strip');
  if (!state || chat.kind !== 'direct' || chat.status !== 'active' || !chat.linkId) return box;
  const link = chat.linkId;
  const name = chat.title;
  const given = (state.given ?? []).filter((p) => p.link === link);
  const held = (state.held ?? []).filter((p) => p.link === link);
  const line = el('div', 'sup-line');
  const draft = given.find((p) => p.status === 'draft');
  const asked = given.find((p) => p.status === 'asked' && p.expiresAt > new Date().toISOString());
  const active = given.find((p) => p.active);
  if (active) {
    const chip = el('span', 'rr-chip', t('{name} has a fix pass until {time} · {scope}', { name, time: when(active.expiresAt), scope: scopeText(active.scope) }));
    line.append(chip, btn(t('Revoke'), 'ghost small danger-text', act(() => call(`/passes/${active.id}`, { method: 'DELETE' }), t('Fix pass ended.'))));
  } else if (asked) {
    line.append(el('span', 'small', t('Waiting for {name} to accept your fix pass.', { name })), btn(t('Cancel'), 'ghost small', act(() => call(`/passes/${asked.id}`, { method: 'DELETE' }))));
  } else if (!draft) line.append(btn(t('Ask {name} to fix something', { name }), 'ghost small', () => panel(...askForm(link, name, null))));
  const req = held.find((p) => p.status === 'asked' && p.expiresAt > new Date().toISOString());
  const mine = held.find((p) => p.active);
  if (mine) {
    line.append(el('span', 'rr-chip', t('{name} gave you a fix pass until {time} · {scope}', { name, time: when(mine.expiresAt), scope: scopeText(mine.scope) })));
    line.append(btn(t('Look and fix {name}’s Sara', { name }), 'small', () => void lookPanel(link, name, mine)));
    line.append(btn(t('End'), 'ghost small', act(() => call(`/passes/${mine.id}`, { method: 'DELETE' }), t('Fix pass ended.'))));
  }
  if (line.childElementCount) box.append(line);
  if (draft) box.append(card(t('Let {name} look and fix things on this server?', { name }), askForm(link, name, draft)));
  if (req) box.append(requestCard(req, name));
  const plans = (state.plans ?? []).filter((p) => p.link === link).slice(0, 3);
  for (const p of plans) if (p.side === 'in' ? !['done', 'stopped', 'failed'].includes(p.status) || p === plans[0] : true) box.append(planCard(p, name));
  return box;
}

function card(title, nodes) {
  const c = el('div', 'sup-card rr-card');
  c.setAttribute('role', 'group');
  c.setAttribute('aria-label', title);
  c.append(el('strong', '', title), ...nodes);
  return c;
}
function radios(group, legend, options, pick) {
  const fs = el('fieldset', 'sup-hours');
  fs.append(el('legend', 'small', legend));
  for (const [v, text] of options) {
    const lab = el('label', 'sup-hour');
    const r = el('input');
    r.type = 'radio';
    r.name = group;
    r.value = String(v);
    r.checked = v === pick;
    lab.append(r, el('span', '', text));
    fs.append(lab);
  }
  return fs;
}

/** The approval card on the helped side (a form panel, or the card a chat request left). */
function askForm(link, name, draft) {
  const uid = `rr-${Math.random().toString(36).slice(2, 8)}`;
  const what = el('textarea', 'sup-text');
  what.maxLength = 1000;
  what.rows = 2;
  what.value = draft?.problem ?? '';
  what.placeholder = t('What isn’t working?');
  what.setAttribute('aria-label', t('What isn’t working?'));
  const hours = radios(`${uid}-h`, t('How long?'), [[1, t('1 hour')], [24, t('1 day')], [168, t('7 days')]], 24);
  const scope = radios(`${uid}-s`, t('What may {name}’s Sara do?', { name }), Object.entries(SCOPES()), 'each');
  const go = btn(t('Give a fix pass'), 'small', act(async () => {
    await call('/requests', { method: 'POST', body: { link, problem: what.value, hours: Number(hours.querySelector('input:checked')?.value ?? 24), scope: scope.querySelector('input:checked')?.value ?? 'each', ...(draft ? { draft: draft.id } : {}) } });
    const p = document.querySelector('#msgs-panel');
    if (p && !draft) p.hidden = true;
  }, t('Sent. {name} sees your request and can accept it.', { name })));
  const acts = el('div', 'msgs-acts');
  acts.append(go);
  if (draft) acts.append(btn(t('Not now'), 'ghost small', act(() => call(`/requests/${draft.id}`, { method: 'DELETE' }))));
  const nodes = [
    el('p', 'small', t('{name}’s Sara can then read your Sara’s health and problem list (private things removed) and suggest fixes that your Sara checks and runs herself: fixes from her own list, learning a skill, a few settings, and code changes she writes and tests herself. No commands, files, passwords or remote control.', { name })),
    el('p', 'small muted', t('Code changes always ask you on their own. Stop and Revoke work at any time; each step can be undone here.')),
    what,
    hours,
    scope,
    acts,
  ];
  return draft ? nodes : [el('strong', '', t('Ask {name} to fix something', { name })), ...nodes];
}

function requestCard(p, name) {
  return card(t('{name} asks you to fix something on their Sara', { name }), [
    ...(p.problem ? [el('p', 'small sup-note', p.problem)] : []),
    el('p', 'small muted', t('{scope} · until {time}', { scope: scopeText(p.scope), time: when(p.expiresAt) })),
    (() => {
      const a = el('div', 'msgs-acts');
      a.append(btn(t('Accept'), 'small', act(() => call(`/passes/${p.id}/accept`, { method: 'POST', body: { accept: true } }), t('Accepted. Look and fix {name}’s Sara when you’re ready.', { name }))), btn(t('Decline'), 'ghost small', act(() => call(`/passes/${p.id}/accept`, { method: 'POST', body: { accept: false } }))));
      return a;
    })(),
  ]);
}

const named = (p) => (p && typeof p.setting === 'string' ? { ...p, setting: settingLabel(p.setting) } : (p ?? {}));
const stepText = (s) => t(s.title, named(s.params));
/** A plan with its steps: approvals and Undo on the helped side, progress and Stop on both. */
function planCard(p, name) {
  const helped = p.side === 'in';
  const live = ['waiting', 'running', 'stopping'].includes(p.status);
  const title = helped ? t('{name}’s fix plan', { name }) : t('Your fix plan for {name}', { name });
  const nodes = [];
  nodes.push(el('p', `small rr-status rr-${p.status}`, PLAN()[p.status] ?? p.status));
  if (p.note) nodes.push(el('p', 'small sup-note', p.note));
  const top = el('div', 'msgs-acts');
  if (helped && p.scope === 'pass' && !p.approved && p.status === 'waiting') {
    nodes.push(el('p', 'small muted', t('One OK runs every step except code changes, which ask on their own.')));
    top.append(btn(t('Approve the plan'), 'small', act(() => call(`/plans/${p.id}/approve`, { method: 'POST', body: { approve: true } }))), btn(t('Decline'), 'ghost small', act(() => call(`/plans/${p.id}/approve`, { method: 'POST', body: { approve: false } }))));
  }
  if (live) top.append(btn(t('Stop'), 'ghost small danger-text', act(() => call(`/plans/${p.id}/stop`, { method: 'POST', body: {} }), t('Stopping after the current step. Nothing is undone.'))));
  const ol = el('ol', 'rr-steps');
  for (const s of p.steps) {
    const li = el('li', `rr-step rr-${s.status}`);
    const head = el('div', 'rr-step-head');
    head.append(el('span', 'rr-step-title', stepText(s)), el('span', 'rr-badge', s.undone ? t('Undone') : (STATUS()[s.status] ?? s.status)));
    li.append(head);
    if (s.kind === 'code' && s.code) li.append(codeBox(s));
    else if (s.kind === 'code') li.append(el('p', 'small muted', t('Code change: always asks you on its own; your Sara writes and tests it herself.')));
    if (s.detail && !(s.kind === 'code' && s.code)) li.append(el('p', 'small', t(s.detail, named(s.detailParams))));
    const a = el('div', 'msgs-acts');
    if (helped && s.status === 'waiting' && ['waiting', 'running'].includes(p.status) && (p.scope === 'each' || s.kind === 'code')) a.append(btn(t('Approve'), 'small', act(() => call(`/plans/${p.id}/steps/${s.n}`, { method: 'POST', body: { approve: true } }))), btn(t('Decline'), 'ghost small', act(() => call(`/plans/${p.id}/steps/${s.n}`, { method: 'POST', body: { approve: false } }))));
    if (helped && s.undoable && !s.undone) a.append(btn(t('Undo'), 'ghost small', act(() => call(`/plans/${p.id}/steps/${s.n}/undo`, { method: 'POST', body: {} }), t('Undone.'))));
    if (a.childElementCount) li.append(a);
    ol.append(li);
  }
  nodes.push(ol);
  if (top.childElementCount) nodes.push(top);
  if (!live && p.steps.length) nodes.push(el('p', 'small rr-report', reportLine(p, name)));
  return card(title, nodes);
}
function reportLine(p, name) {
  const n = (st) => p.steps.filter((s) => s.status === st).length;
  const parts = [t('{done} of {all} steps done', { done: n('done'), all: p.steps.length })];
  if (n('failed')) parts.push(t('{n} did not work', { n: n('failed') }));
  if (n('declined')) parts.push(t('{n} declined', { n: n('declined') }));
  if (n('skipped')) parts.push(t('{n} not run', { n: n('skipped') }));
  const tail = p.side === 'in' && p.steps.some((s) => s.undoable && !s.undone) ? ` ${t('You can undo each step above.')}` : '';
  const code = p.steps.filter((s) => s.kind === 'code' && s.code).map((s) => ` ${(CODE_LINE()[s.code.phase] ?? '').replace('{id}', s.change ?? '?')}`).join('');
  return `${p.side === 'in' ? t('{name}’s fix:', { name }) : t('Your fix:')} ${parts.join(', ')}.${code}${tail}`;
}

/** Helper: "Look and fix <name>'s Sara": problems, a plan editor, Send. */
async function lookPanel(link, name, pass) {
  say(t('Looking…'));
  let r;
  try {
    r = await call('/look', { method: 'POST', body: { link } });
  } catch (err) {
    say(err.message);
    return;
  }
  say('');
  const steps = [];
  const list = el('ol', 'rr-steps rr-plan');
  const paint = () => {
    list.replaceChildren();
    for (const [i, s] of steps.entries()) {
      const li = el('li', 'rr-step');
      const head = el('div', 'rr-step-head');
      head.append(el('span', 'rr-step-title', s.label), btn(t('Remove'), 'ghost small', () => (steps.splice(i, 1), paint())));
      li.append(head);
      list.append(li);
    }
    if (!steps.length) list.append(el('li', 'small muted', t('No steps yet: add them from the problems or below.')));
    send.disabled = !steps.length || pass.scope === 'look';
  };
  const add = (step, label) => {
    if (steps.length >= 10) return say(t('A plan has at most {n} steps.', { n: 10 }));
    steps.push({ step, label });
    paint();
  };
  const nodes = [el('strong', '', t('Look and fix {name}’s Sara', { name })), el('p', 'small muted', t('{scope} · until {time}', { scope: scopeText(pass.scope), time: when(pass.expiresAt) }))];
  nodes.push(el('h4', 'rr-h', t('Problems on {name}’s Sara', { name })));
  const probs = el('ul', 'rr-problems');
  for (const p of r.problems ?? []) {
    const li = el('li', `rr-problem ${p.level === 1 && !p.fixable ? 'muted' : ''}`);
    li.append(el('span', '', `${p.area ? `${t(p.area)}: ` : ''}${t(p.text, p.params ?? {})}`));
    if (p.level === 2 || p.fixable) li.append(btn(p.level === 2 ? t('Add: learn a skill') : t('Add: fix it'), 'ghost small', () => add({ kind: 'fix', problem: p.id }, t(p.text, p.params ?? {}))));
    else li.append(el('span', 'small muted', t('only its owner can fix this')));
    probs.append(li);
  }
  if (!(r.problems ?? []).length) probs.append(el('li', 'small muted', t('Nothing on the problem list.')));
  nodes.push(probs);
  const f = r.findings ?? [];
  if (f.length) {
    const d = el('details', 'sup-sec');
    d.append(el('summary', 'small', t('Report findings ({n})', { n: f.length })));
    for (const x of f) d.append(el('p', 'small', `${x.area ? `${t(x.area)}: ` : ''}${t(x.text, x.params ?? {})}`));
    nodes.push(d);
  }
  nodes.push(el('h4', 'rr-h', t('Fix plan')), list);
  // Add a setting, a skill to learn, or a code change request.
  const kind = el('select', 'sup-path');
  kind.setAttribute('aria-label', t('Add a step'));
  for (const [v, l] of [['setting', t('Change a setting')], ['learn', t('Learn a skill')], ...(r.can?.code ? [['code', t('Ask for a code change')]] : [])]) kind.append(Object.assign(el('option', '', l), { value: v }));
  const box = el('div', 'sup-val');
  let read = () => null;
  const paintKind = () => {
    box.replaceChildren();
    if (kind.value === 'setting') {
      const path = el('select');
      path.setAttribute('aria-label', t('Setting'));
      for (const p of r.can?.settings ?? []) path.append(Object.assign(el('option', '', settingLabel(p)), { value: p }));
      const val = el('input');
      val.setAttribute('aria-label', t('New value'));
      val.placeholder = t('New value');
      box.append(path, val);
      read = () => {
        if (!val.value.trim()) return null;
        let v = val.value.trim();
        try {
          v = JSON.parse(v);
        } catch {
          /* plain text */
        }
        return [{ kind: 'setting', path: path.value, value: v }, t('Change “{setting}” to {value}', { setting: settingLabel(path.value), value: JSON.stringify(v) })];
      };
    } else {
      const txt = el('textarea', 'sup-text');
      txt.rows = 2;
      txt.maxLength = kind.value === 'code' ? 2000 : 200;
      const ph = kind.value === 'code' ? t('What should change, in plain words') : t('What she should learn');
      txt.placeholder = ph;
      txt.setAttribute('aria-label', ph);
      box.append(txt);
      read = () => (txt.value.trim() ? (kind.value === 'code' ? [{ kind: 'code', request: txt.value.trim() }, t('Prepare a code change: {request}', { request: txt.value.trim().slice(0, 200) })] : [{ kind: 'learn', what: txt.value.trim() }, t('Learn: {what}', { what: txt.value.trim() })]) : null);
    }
  };
  kind.addEventListener('change', paintKind);
  paintKind();
  const addBtn = btn(t('Add step'), 'ghost small', () => {
    const x = read();
    if (x) add(x[0], x[1]);
  });
  nodes.push(kind, box, addBtn);
  const note = el('textarea', 'sup-text');
  note.rows = 2;
  note.maxLength = 1000;
  note.placeholder = t('Why, in plain words (optional)');
  note.setAttribute('aria-label', t('Why, in plain words (optional)'));
  const send = btn(t('Send plan'), 'small', act(async () => {
    await call('/plans', { method: 'POST', body: { link, note: note.value, steps: steps.map((s) => s.step) } });
    const p = document.querySelector('#msgs-panel');
    if (p) p.hidden = true;
  }, t('Sent. {name}’s Sara checks every step and {name} approves it.', { name })));
  nodes.push(note, el('p', 'small muted', pass.scope === 'look' ? t('This pass is for looking only: {name} can give a new one that allows fixing.', { name }) : t('Only fixes from the list, learning a skill, a few settings and code change requests. {name}’s Sara checks each step again and runs it herself.', { name })), send);
  paint();
  panel(...nodes);
}
