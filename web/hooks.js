// Phase 102 (ST7, docs/design/STAPLES.md §10.8, docs/WEBHOOKS.md): Settings → Connections → Webhooks.
// New webhook is a three-step form (1 where it comes from · 2 when · 3 what she does), then the
// address with Copy, the sender's secret (shown once), where to paste them and what can reach this
// server. Each hook is a card with today's counts, a 7-day sparkline, what it does, Test (a dry run,
// or Run it for real), Send a test (the exact curl), the log and its menu. Deliveries in the chat are
// drawn by hookNotice() with the shared proposal card. Everything a sender sent is set as text.
import { serverText, t } from './naming.js';
import { overflowMenu } from './tidy.js';
import { proposalCard } from './proposal-card.js';
import { sparkline } from './viz.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
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
const enc = encodeURIComponent;
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}
/** A labelled control with its ? tip: <label><span>Text ?</span> control</label>. */
function field(text, tipText, control, cls = '') {
  const l = el('label', cls);
  const s = el('span', '', text);
  s.append(' ', tip(tipText));
  l.append(s, ' ', control);
  return l;
}
function check(id, text, tipText, on = false) {
  const l = el('label', 'row');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.id = id;
  i.checked = on;
  const s = el('span', '', text);
  s.append(' ', tip(tipText));
  l.append(i, ' ', s);
  return l;
}
function select(id, options, value) {
  const s = document.createElement('select');
  s.id = id;
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = label;
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  return s;
}
function input(id, value = '', placeholder = '', max = 300) {
  const i = document.createElement('input');
  i.id = id;
  i.value = value;
  i.maxLength = max;
  i.autocomplete = 'off';
  i.spellcheck = false;
  if (placeholder) i.placeholder = placeholder;
  return i;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

let state = { hooks: [], presets: [], tools: {}, skills: [], plugins: [], boards: [], access: {}, base: '', privateLocal: false, keepDays: 14 };
let helpers = { copyText: async () => {}, openConversation: () => {}, openCard: () => {} };
/** Addresses made this visit (only their hash is on the server), so Send a test can fill them in. */
const fresh = new Map();

function status(text) {
  const s = $('#hk-status');
  if (s) s.textContent = text ?? '';
}

const SENDERS = {
  github: () => t('GitHub'),
  stripe: () => t('Stripe'),
  'home-assistant': () => t('Home Assistant'),
  other: () => t('Something else'),
};
const KINDS = {
  github: () => t('GitHub signature'),
  stripe: () => t('Stripe signature'),
  standard: () => t('Standard Webhooks signature'),
  header: () => t('A token in a header (weaker)'),
  url: () => t('The address only (weaker)'),
};
const ACTIONS = {
  tell: () => t('Tell me'),
  task: () => t('Add a task'),
  skill: () => t('Run a skill'),
  plugin: () => t('Send to a plugin'),
};
const OPS = {
  equals: () => t('equals'),
  not: () => t('is not'),
  'one-of': () => t('is one of'),
  contains: () => t('contains'),
  'starts-with': () => t('starts with'),
  gt: () => '>',
  lt: () => '<',
  exists: () => t('exists'),
  'changed-to': () => t('changed to'),
};
const VERDICTS = {
  accepted: () => t('Accepted'),
  filtered: () => t('Filtered out'),
  'bad-signature': () => t('Bad signature'),
  duplicate: () => t('Duplicate'),
  'rate-limited': () => t('Rate limited'),
  'too-big': () => t('Too big'),
  error: () => t('Error'),
};
const TOOL_WORDS = {
  planner: () => t('To-dos (each use asks you)'),
  web: () => t('Web search'),
  github: () => t('GitHub (comments ask you)'),
  home: () => t('Home Assistant (changes ask you)'),
};
const PRESET_NAMES = {
  'github-issue-opened': () => t('An issue was opened'),
  'github-pr-opened': () => t('A pull request was opened'),
  'github-ci-failed': () => t('CI failed'),
  'github-release': () => t('A release was published'),
  'stripe-payment-failed': () => t('A payment failed'),
  'stripe-dispute': () => t('A dispute was opened'),
  'stripe-payout-paid': () => t('A payout was paid'),
  'ha-state-changed': () => t('A state changed to a value'),
};
const presetName = (p) => PRESET_NAMES[p.id]?.() ?? p.name;

/** What a hook does, in words (built here so it is in the owner's language). */
function doesText(h) {
  const a = h.action;
  if (a.kind === 'tell') return a.important ? t('Tells you, also on Today') : t('Tells you');
  if (a.kind === 'task') {
    let col = '';
    for (const b of state.boards) for (const c of b.columns) if (c.id === a.column) col = `${b.name} → ${c.name}`;
    const base = col ? t('Adds a card to {column}', { column: col }) : t('Adds a card');
    return a.assign ? t('{what}, assigned to her', { what: base }) : base;
  }
  if (a.kind === 'skill') return t('Runs the skill {skill}, then tells you', { skill: a.skill ?? '' });
  return t('Sends it to the plugin {plugin}', { plugin: state.plugins.find((p) => p.id === a.plugin)?.name ?? a.plugin ?? '' });
}

export function initHooks(h) {
  helpers = { ...helpers, ...h };
  $('#hk-new')?.addEventListener('click', () => openForm());
  $('#hk-keep')?.addEventListener('change', async (e) => {
    try {
      await api('/hooks', { method: 'PUT', body: { keepDays: Number(e.currentTarget.value) } });
      status(t('Saved.'));
    } catch (err) {
      status(err.message);
    }
  });
}

export async function loadHooks() {
  const box = $('#hk-list');
  if (!box) return;
  try {
    state = await api('/hooks');
  } catch (err) {
    $('#hk-off').hidden = false;
    $('#hk-off').textContent = err.status === 403 || err.status === 404 ? t('Webhooks are off on this server.') : err.message;
    box.replaceChildren();
    $('#hk-new').hidden = true;
    return;
  }
  $('#hk-off').hidden = true;
  $('#hk-new').hidden = false;
  $('#hk-keep').value = String(state.keepDays);
  renderReach();
  renderList();
}

/** Which senders can reach this server, from how the owner reaches her (sara access). */
function reachText() {
  const m = state.access?.mode;
  if (m === 'local') return t('Only programs on this computer can reach her address, so GitHub and Stripe can\'t send here. Change it with sara access.');
  if (m === 'lan') return t('Senders on your home network (like Home Assistant) can reach her. GitHub and Stripe can\'t: they need an address on the internet.');
  if (m === 'tailscale') return t('Devices on your tailnet (like Home Assistant with Tailscale) can reach her. GitHub and Stripe need Tailscale Funnel or your own web address.');
  if (m === 'domain') return t('Her address is on the internet, so GitHub and Stripe can send here. The secret in each webhook\'s address keeps others out.');
  return t('The sender must be able to reach this server: on your network for Home Assistant, on the internet for GitHub and Stripe.');
}
function renderReach() {
  const p = $('#hk-reach');
  if (!p) return;
  p.replaceChildren(el('span', '', reachText()));
  if (state.privateLocal) p.append(' ', el('span', '', t('Private local mode is on: webhooks still arrive, notifications stay in the app and copies to other addresses are paused.')));
}

function renderList() {
  const box = $('#hk-list');
  if (!state.hooks.length) {
    box.replaceChildren(el('p', 'muted small', t('No webhooks yet. Make one with New webhook.')));
    return;
  }
  box.replaceChildren(...state.hooks.map(hookCard));
}

function chip(text, cls = '') {
  return el('span', `skl-chip${cls ? ` ${cls}` : ''}`, text);
}

function hookCard(h) {
  const card = el('article', 'skl-card hk-card');
  card.dataset.hook = h.id;
  const head = el('div', 'hk-head');
  const title = el('div', 'hk-title');
  title.append(el('strong', '', h.name), el('span', 'skl-desc', doesText(h)));
  const sw = document.createElement('input');
  sw.type = 'checkbox';
  sw.checked = h.enabled;
  sw.className = 'hk-switch';
  sw.setAttribute('aria-label', t('{name} on', { name: h.name }));
  sw.addEventListener('change', async () => {
    try {
      await api(`/hooks/${enc(h.id)}/enable`, { method: 'POST', body: { on: sw.checked } });
      await loadHooks();
    } catch (err) {
      status(err.message);
    }
  });
  const more = el('button', 'ghost skl-more', '⋯');
  more.type = 'button';
  more.dataset.moreId = `hk-${h.id}`;
  more.setAttribute('aria-label', t('More for {name}', { name: h.name }));
  const menu = el('div', 'tidy-items');
  menu.hidden = true;
  menu.append(
    btn(t('Change it'), 'ghost', () => openForm(h)),
    btn(t('New address (rotate)'), 'ghost', () => rotate(h, false)),
    ...(h.verify === 'github' || h.verify === 'standard' || h.verify === 'header' ? [btn(t('New address and secret'), 'ghost', () => rotate(h, true))] : []),
    btn(t('Remove'), 'ghost danger-text', () => remove(h)),
  );
  overflowMenu(more, menu);
  head.append(title, sw, more, menu);
  card.append(head);

  const chips = el('div', 'skl-chips hk-chips');
  chips.append(chip(SENDERS[h.sender]?.() ?? h.sender), chip(KINDS[h.verify]?.() ?? h.verify, h.weaker ? 'warn' : ''));
  if (!h.enabled) chips.append(chip(t('Off'), 'muted'));
  if (h.paused) chips.append(chip(t('Paused for sending too much'), 'warn'));
  if (h.verify !== 'url' && !h.hasSecret) chips.append(chip(t('Paste the sender\'s secret'), 'warn'));
  if (h.forward) chips.append(chip(t('Sends a signed copy on')));
  card.append(chips);

  const stats = el('div', 'hk-stats');
  const nums = el('p', 'small hk-nums', t('Today: accepted {a} · filtered out {f} · refused {r}', { a: h.today.accepted, f: h.today.filtered, r: h.today.rejected }));
  const sp = sparkline(h.spark, { w: 120, h: 28, cls: 'hk-spark' });
  stats.append(nums);
  if (sp) {
    const wrap = el('span', 'hk-spark-wrap');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', t('Deliveries in the last 7 days: {list}', { list: h.spark.join(', ') }));
    wrap.append(sp);
    stats.append(wrap);
  }
  card.append(stats);
  if (h.filterWords.length) {
    const ul = el('ul', 'hk-filters-list small');
    for (const w of h.filterWords) ul.append(el('li', '', w));
    card.append(el('p', 'small hk-when', t('When:')), ul);
  } else card.append(el('p', 'small muted', t('When: every delivery')));
  const addr = el('p', 'small hk-addr');
  addr.append(el('span', 'muted', t('Address:')), ' ', el('code', '', `${state.base}/hook/${h.id}.••••••`));
  card.append(addr);

  const row = el('div', 'hk-actions');
  const panel = el('div', 'hk-panel');
  row.append(
    btn(t('Test'), 'ghost small', () => testPanel(h, panel)),
    btn(t('Send a test'), 'ghost small', () => curlPanel(h, panel)),
    btn(t('Log'), 'ghost small', () => logPanel(h, panel)),
  );
  card.append(row, panel);
  return card;
}

async function rotate(h, sender) {
  if (!confirm(sender ? t('Make a new address and secret for {name}? The old ones stop working at once; paste the new ones into the sender.', { name: h.name }) : t('Make a new address for {name}? The old one stops working at once; paste the new one into the sender.', { name: h.name }))) return;
  try {
    const r = await api(`/hooks/${enc(h.id)}/rotate`, { method: 'POST', body: { sender } });
    fresh.set(h.id, r.url);
    showMade({ hook: h, url: r.url, senderSecret: r.senderSecret });
    await loadHooks();
  } catch (err) {
    status(err.message);
  }
}

async function remove(h) {
  if (!confirm(t('Remove {name}? Its address stops working and its log is deleted.', { name: h.name }))) return;
  try {
    await api(`/hooks/${enc(h.id)}`, { method: 'DELETE' });
    status(t('{name} was removed.', { name: h.name }));
    await loadHooks();
  } catch (err) {
    status(err.message);
  }
}

// ------------------------------------------------------------------------------------------
// the three-step form
// ------------------------------------------------------------------------------------------

let form = null;

function conditionRow(c = { where: 'body', path: '', op: 'equals', value: '' }) {
  const row = el('div', 'hk-cond');
  const where = select('', [['body', t('Body')], ['header', t('Header')], ['text', t('Text')]], c.where);
  where.setAttribute('aria-label', t('Where to look'));
  const path = input('', c.path ?? '', t('e.g. action or data.object.amount'), 200);
  path.setAttribute('aria-label', t('Field'));
  const op = select('', Object.entries(OPS).map(([k, f]) => [k, f()]), c.op);
  op.setAttribute('aria-label', t('Check'));
  const value = input('', c.value ?? '', t('Value'), 500);
  value.setAttribute('aria-label', t('Value'));
  const sync = () => {
    path.hidden = where.value === 'text';
    value.hidden = op.value === 'exists';
  };
  where.addEventListener('change', sync);
  op.addEventListener('change', sync);
  sync();
  const rm = btn('✕', 'ghost small hk-cond-rm', () => row.remove());
  rm.setAttribute('aria-label', t('Remove this condition'));
  where.classList.add('hk-c-where');
  path.classList.add('hk-c-path');
  op.classList.add('hk-c-op');
  value.classList.add('hk-c-value');
  row.append(where, path, op, value, rm);
  row.read = () => ({ where: where.value, path: path.value.trim(), op: op.value, ...(op.value === 'exists' ? {} : { value: value.value }) });
  return row;
}

function openForm(h) {
  const box = $('#hk-form');
  $('#hk-made').hidden = true;
  const editing = Boolean(h);
  const sender = h?.sender ?? 'github';
  form = { editing: h ?? null, sender };
  box.replaceChildren();
  box.hidden = false;

  // 1 Where it comes from
  const s1 = el('div', 'hk-step');
  const h1 = el('h4', '', t('1 · Where it comes from'));
  h1.append(' ', tip(t('Who sends it. This picks how its deliveries are checked and offers ready-made conditions for that sender.')));
  s1.append(h1);
  const picks = el('div', 'pick-cards hk-senders');
  picks.setAttribute('role', 'radiogroup');
  for (const k of Object.keys(SENDERS)) {
    const b = el('button', 'pick-card');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.sender = k;
    b.append(el('strong', '', SENDERS[k]()), el('span', 'muted small', { github: t('Issues, pull requests, CI runs, releases'), stripe: t('Payments, disputes, payouts'), 'home-assistant': t('A sensor or a switch changed'), other: t('Anything that can send a web request') }[k]));
    b.disabled = editing;
    b.addEventListener('click', () => pickSender(k));
    picks.append(b);
  }
  s1.append(picks);
  s1.append(field(t('Name'), t('Shown on its card, in the log and on what she tells you, like "GitHub CI".'), input('hk-name', h?.name ?? '', t('e.g. GitHub CI'), 60)));
  const verify = select('hk-verify', Object.entries(KINDS).map(([k, f]) => [k, f()]), h?.verify ?? 'github');
  verify.disabled = editing;
  s1.append(field(t('How deliveries are checked'), t('A signature proves the sender knows the secret and the body wasn\'t changed. A header token or the address alone are weaker: anyone who has them can send.'), verify));
  const secret = input('hk-secret', '', editing ? t('Leave empty to keep it') : t('Empty: Sara makes one for you to paste'), 500);
  secret.type = 'password';
  s1.append(field(t('The sender\'s secret'), t('For Stripe, paste the endpoint\'s signing secret (whsec_…). For GitHub, Standard Webhooks and a header token, leave it empty and Sara makes one to paste into the sender.'), secret, 'hk-secret-row'));
  box.append(s1);

  // 2 When
  const s2 = el('div', 'hk-step');
  const h2 = el('h4', '', t('2 · When'));
  h2.append(' ', tip(t('Conditions on the headers and the body; all must match. Deliveries that don\'t match are logged as filtered out and do nothing.')));
  s2.append(h2);
  s2.append(field(t('Ready-made'), t('Fills the conditions and the summary for a common event. You can change them after.'), select('hk-preset', [], '')));
  const conds = el('div', 'hk-conds');
  conds.id = 'hk-conds';
  s2.append(conds, btn(t('Add a condition'), 'ghost small', () => conds.append(conditionRow())));
  box.append(s2);

  // 3 What she does
  const s3 = el('div', 'hk-step');
  const h3 = el('h4', '', t('3 · What she does'));
  h3.append(' ', tip(t('What happens with a delivery that passes: a notification, a card on your board, a skill she runs in the background, or one of your plugins.')));
  s3.append(h3);
  s3.append(field(t('She will'), t('Tell me: a notification. Add a task: a card. Run a skill: she works on it with only the tools you tick; changes ask you. Send to a plugin: its webhook hook.'), select('hk-action', Object.entries(ACTIONS).map(([k, f]) => [k, f()]), h?.action.kind ?? 'tell')));
  s3.append(field(t('Summary'), t('Put a field from the body between double curly brackets to use its value, like the example. Empty: her quick model writes one line.'), input('hk-template', h?.action.template ?? '', '{{repository.full_name}}: {{issue.title}}', 300), 'hk-row-tpl'));
  const imp = check('hk-important', t('Also on Today'), t('Important ones also show on Today under From your webhooks until you open them.'), Boolean(h?.action.important));
  imp.classList.add('hk-row-tell');
  s3.append(imp);
  const cols = [];
  for (const b of state.boards) for (const c of b.columns) cols.push([c.id, `${b.name} → ${c.name}`]);
  s3.append(field(t('Column'), t('The board and column the card goes to.'), select('hk-column', cols, h?.action.column ?? cols[0]?.[0] ?? ''), 'hk-row-task'));
  const asg = check('hk-assign', t('Assign it to her'), t('She starts working the card at once, under the board\'s rules. Each one counts against this webhook\'s runs a day.'), Boolean(h?.action.assign));
  asg.classList.add('hk-row-task');
  s3.append(asg);
  s3.append(field(t('Skill'), t('The skill she follows with the delivery as its input. The result comes to you as a notification.'), select('hk-skill', state.skills.map((s) => [s.name, s.name]), h?.action.skill ?? ''), 'hk-row-skill'));
  s3.append(field(t('Plugin'), t('A plugin that asked for webhook events and is switched on.'), select('hk-plugin', state.plugins.map((p) => [p.id, p.name]), h?.action.plugin ?? ''), 'hk-row-plugin'));
  const tools = el('div', 'hk-tools hk-row-skill');
  const th = el('p', 'small', t('Her tools for these runs'));
  th.append(' ', tip(t('Only the tools ticked here. Anything that changes something waits for your OK on a card, even if it usually runs on its own. Always allowed never applies.')));
  tools.append(th);
  for (const k of Object.keys(state.tools)) tools.append(check(`hk-tool-${k}`, TOOL_WORDS[k]?.() ?? k, t('Reading runs on its own; anything that changes something asks you first.'), (h?.tools ?? ['planner']).includes(k)));
  s3.append(tools);
  const mem = check('hk-memory', t('Share notes that aren\'t private'), t('Off: she knows nothing about you in these runs. On: notes other apps may see too. Never private chats, people cards or keys.'), h?.memory === 'shared');
  mem.classList.add('hk-row-skill');
  s3.append(mem);
  const weak = check('hk-allow-runs', t('Let it start her work anyway'), t('A webhook without a signature can be sent by anyone who has its address, so it can only tell you or add a task unless you tick this.'), false);
  weak.classList.add('hk-row-weak');
  s3.append(weak);
  box.append(s3);

  // Limits and the outgoing copy
  const lim = el('details', 'hk-limits');
  lim.append(el('summary', 'small', t('Limits and a signed copy')));
  const L = h?.limits ?? { perMin: 30, perDay: 500, runsPerDay: 20, budget: 50000 };
  lim.append(
    field(t('Deliveries a minute'), t('More than this in a minute: the sender gets "try later" and the webhook pauses for 10 minutes.'), select('hk-permin', [[10, '10'], [30, '30'], [60, '60'], [120, '120']], L.perMin)),
    field(t('Deliveries a day'), t('After this many today, the rest wait until tomorrow.'), select('hk-perday', [[100, '100'], [500, '500'], [2000, '2,000'], [5000, '5,000']], L.perDay)),
    field(t('Her runs a day'), t('Skill runs and cards assigned to her from this webhook. One runs at a time; up to 5 wait.'), select('hk-runs', [[0, '0'], [5, '5'], [20, '20'], [50, '50']], L.runsPerDay)),
    field(t('Tokens a day'), t('How much model use her runs from this webhook may cost a day (tokens are pieces of words).'), select('hk-budget', [[20000, '20,000'], [50000, '50,000'], [200000, '200,000'], [1000000, '1,000,000']], L.budget)),
    field(t('Also send a signed copy to'), t('Optional. After each delivery she sends a short signed note (Standard Webhooks) to this https address. Only public addresses.'), input('hk-forward', h?.forward ?? '', 'https://example.com/hooks/sara', 500)),
  );
  box.append(lim);
  const actions = el('div', 'add-row hk-form-actions');
  actions.append(btn(editing ? t('Save') : t('Make the webhook'), '', (b) => saveForm(b)), btn(t('Cancel'), 'ghost', () => closeForm()));
  box.append(actions);

  $('#hk-action').addEventListener('change', syncAction);
  $('#hk-verify').addEventListener('change', syncAction);
  $('#hk-preset').addEventListener('change', () => applyPreset($('#hk-preset').value));
  if (h) {
    fillPresets(h.sender, h.preset ?? '');
    for (const f of h.filters) conds.append(conditionRow('any' in f ? f.any[0] : f));
    markSender(h.sender);
  } else pickSender(sender);
  syncAction();
  box.scrollIntoView({ block: 'nearest' });
  $('#hk-name').focus();
}

function closeForm() {
  const box = $('#hk-form');
  box.hidden = true;
  box.replaceChildren();
  form = null;
}

function markSender(k) {
  for (const b of document.querySelectorAll('.hk-senders .pick-card')) b.setAttribute('aria-checked', String(b.dataset.sender === k));
}

function fillPresets(sender, value) {
  const s = $('#hk-preset');
  s.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('None (my own conditions)');
  s.append(none);
  for (const p of state.presets.filter((x) => x.sender === sender)) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = presetName(p);
    if (p.id === value) o.selected = true;
    s.append(o);
  }
}

function pickSender(k) {
  form.sender = k;
  markSender(k);
  $('#hk-verify').value = { github: 'github', stripe: 'stripe', 'home-assistant': 'header', other: 'standard' }[k];
  fillPresets(k, '');
  const first = state.presets.find((p) => p.sender === k);
  if (first) {
    $('#hk-preset').value = first.id;
    applyPreset(first.id);
  } else applyPreset('');
  if (!$('#hk-name').value) $('#hk-name').value = '';
  syncAction();
}

function applyPreset(id) {
  const p = state.presets.find((x) => x.id === id);
  const conds = $('#hk-conds');
  conds.replaceChildren();
  if (!p) return;
  for (const f of p.filters) conds.append(conditionRow('any' in f ? f.any[0] : f));
  $('#hk-template').value = p.template;
  if (!$('#hk-name').value.trim()) $('#hk-name').value = `${SENDERS[p.sender]()}: ${presetName(p)}`.slice(0, 60);
}

function syncAction() {
  const kind = $('#hk-action').value;
  const weak = ['url', 'header'].includes($('#hk-verify').value);
  for (const e of document.querySelectorAll('#hk-form .hk-row-tpl')) e.hidden = !(kind === 'tell' || kind === 'task');
  for (const e of document.querySelectorAll('#hk-form .hk-row-tell')) e.hidden = kind !== 'tell';
  for (const e of document.querySelectorAll('#hk-form .hk-row-task')) e.hidden = kind !== 'task';
  for (const e of document.querySelectorAll('#hk-form .hk-row-skill')) e.hidden = kind !== 'skill';
  for (const e of document.querySelectorAll('#hk-form .hk-row-plugin')) e.hidden = kind !== 'plugin';
  for (const e of document.querySelectorAll('#hk-form .hk-row-weak')) e.hidden = !(weak && (kind === 'skill' || kind === 'plugin' || (kind === 'task' && $('#hk-assign').checked)));
  for (const e of document.querySelectorAll('#hk-form .hk-secret-row')) e.hidden = $('#hk-verify').value === 'url';
}

function readForm() {
  const kind = $('#hk-action').value;
  const action = { kind, template: $('#hk-template').value.trim() };
  if (kind === 'tell') action.important = $('#hk-important').checked;
  if (kind === 'task') {
    action.column = Number($('#hk-column').value) || undefined;
    action.assign = $('#hk-assign').checked;
  }
  if (kind === 'skill') action.skill = $('#hk-skill').value;
  if (kind === 'plugin') action.plugin = $('#hk-plugin').value;
  return {
    name: $('#hk-name').value.trim(),
    sender: form.sender,
    verify: $('#hk-verify').value,
    preset: $('#hk-preset').value || undefined,
    filters: [...document.querySelectorAll('#hk-conds .hk-cond')].map((r) => r.read()).filter((c) => c.where === 'text' || c.path),
    action,
    tools: Object.keys(state.tools).filter((k) => $(`#hk-tool-${k}`)?.checked),
    memory: $('#hk-memory').checked ? 'shared' : 'none',
    limits: { perMin: Number($('#hk-permin').value), perDay: Number($('#hk-perday').value), runsPerDay: Number($('#hk-runs').value), budget: Number($('#hk-budget').value) },
    forward: $('#hk-forward').value.trim(),
    allowRuns: $('#hk-allow-runs').checked,
    ...($('#hk-secret').value.trim() ? { secret: $('#hk-secret').value.trim() } : {}),
  };
}

async function saveForm(b) {
  const body = readForm();
  if (!body.name) return status(t('Name the webhook first.'));
  b.disabled = true;
  try {
    if (form.editing) {
      const id = form.editing.id;
      const r = await api(`/hooks/${enc(id)}`, { method: 'PUT', body });
      closeForm();
      if (r.outSecret) showMade({ hook: r.hook, outSecret: r.outSecret });
      status(t('Saved.'));
    } else {
      const r = await api('/hooks', { method: 'POST', body });
      fresh.set(r.hook.id, r.url);
      closeForm();
      showMade(r);
      status(t('{name} is ready. Copy its address now: it is shown only once.', { name: r.hook.name }));
    }
    await loadHooks();
  } catch (err) {
    status(err.message);
  } finally {
    b.disabled = false;
  }
}

/** Where to paste the address and the secret, per sender (menu names from each sender's docs). */
function pasteSteps(sender, verify) {
  if (sender === 'github') return [t('In the repository on GitHub: Settings → Webhooks → Add webhook.'), t('Payload URL: the address above. Content type: application/json. Secret: the secret above.'), t('Pick the events (or "Send me everything") and press Add webhook. GitHub sends a ping first.')];
  if (sender === 'stripe') return [t('In the Stripe Dashboard: Developers → Webhooks → Add endpoint, with the address above and the events you want.'), t('Open the endpoint, reveal its Signing secret (whsec_…) and paste it here under ⋯ → Change it.')];
  if (sender === 'home-assistant') return [t('In Home Assistant, add a rest_command with the address above, method POST, and the header X-Sara-Token set to the token above.'), t('Call it from an automation when the sensor changes. docs/WEBHOOKS.md has a ready example.')];
  return verify === 'standard' ? [t('Sign each delivery the Standard Webhooks way with the secret above (most webhook libraries can), or try the curl from Send a test.')] : [t('Send a POST with JSON to the address above.')];
}

function showMade(r) {
  const box = $('#hk-made');
  box.replaceChildren();
  box.hidden = false;
  const h = r.hook;
  const rows = [];
  if (r.url) {
    const p = el('div', 'hk-made-row');
    const code = el('code', '', r.url);
    code.dataset.raw = '';
    const copy = btn(t('Copy'), 'ghost small', (b) => helpers.copyText(r.url, b));
    p.append(el('p', 'small', t('Its address (shown only now):')), code, ' ', copy);
    rows.push(p);
  }
  if (r.senderSecret) {
    const p = el('div', 'hk-made-row');
    const code = el('code', '', r.senderSecret);
    code.dataset.raw = '';
    p.append(el('p', 'small', h.verify === 'header' ? t('The token for the X-Sara-Token header (shown only now):') : t('The secret to paste into the sender (shown only now):')), code, ' ', btn(t('Copy'), 'ghost small', (b) => helpers.copyText(r.senderSecret, b)));
    rows.push(p);
  }
  if (r.outSecret) {
    const p = el('div', 'hk-made-row');
    const code = el('code', '', r.outSecret);
    code.dataset.raw = '';
    p.append(el('p', 'small', t('The secret that signs the copies she sends on (shown only now):')), code, ' ', btn(t('Copy'), 'ghost small', (b) => helpers.copyText(r.outSecret, b)));
    rows.push(p);
  }
  const steps = r.url ? pasteSteps(h.sender, h.verify) : [];
  const ol = el('ol', 'small hk-steps');
  for (const s of steps) ol.append(el('li', '', s));
  box.append(
    proposalCard({
      title: t('{name} is ready', { name: h.name }),
      source: SENDERS[h.sender]?.() ?? '',
      chips: [{ text: KINDS[h.verify]?.() ?? h.verify, cls: h.weaker ? 'warn' : '' }],
      why: r.url ? [reachText()] : [],
      warn: h.weaker ? [t('Weaker: anyone who has this address can send to it. Keep it to telling you or adding a task.')] : [],
      body: [...rows, ...(steps.length ? [ol] : [])],
      buttons: [{ label: t('Done'), cls: 'ghost', onClick: () => { box.hidden = true; box.replaceChildren(); } }],
    }),
  );
  box.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------------------------------
// test, send a test, log
// ------------------------------------------------------------------------------------------

function testPanel(h, panel) {
  panel.replaceChildren();
  const src = select(`hk-test-src-${h.id}`, [['sample', t('A ready-made sample')], ['last', t('The last delivery')], ['paste', t('Paste a body')]], 'sample');
  const sample = select(`hk-test-sample-${h.id}`, state.presets.filter((p) => p.sender === h.sender || h.sender === 'other').map((p) => [p.id, presetName(p)]), h.preset ?? '');
  const body = document.createElement('textarea');
  body.rows = 5;
  body.placeholder = '{"action": "opened"}';
  body.setAttribute('aria-label', t('Body'));
  const headers = document.createElement('textarea');
  headers.rows = 3;
  headers.placeholder = 'X-GitHub-Event: issues';
  headers.setAttribute('aria-label', t('Headers (one per line, optional)'));
  const pasteBox = el('div', 'hk-paste');
  pasteBox.append(body, headers);
  const sync = () => {
    pasteBox.hidden = src.value !== 'paste';
    sample.closest('label').hidden = src.value !== 'sample';
  };
  const out = el('div', 'hk-test-out');
  const run = async (real, b) => {
    b.disabled = true;
    try {
      const r = await api(`/hooks/${enc(h.id)}/test`, { method: 'POST', body: { source: src.value, sample: sample.value, body: body.value, headers: headers.value, real } });
      out.replaceChildren(testCard(h, r, real));
      if (real) await loadHooks();
    } catch (err) {
      out.replaceChildren(el('p', 'small', err.message));
    } finally {
      b.disabled = false;
    }
  };
  panel.append(
    field(t('Try it with'), t('A dry run changes nothing: it shows the signature check (for a pasted body with headers), which conditions match, the summary and what she would do.'), src),
    field(t('Sample'), t('A recorded delivery in the sender\'s own format.'), sample),
    pasteBox,
    (() => {
      const row = el('div', 'add-row');
      row.append(btn(t('Try it (changes nothing)'), '', (b) => run(false, b)), btn(t('Run it for real'), 'ghost', (b) => {
        if (confirm(t('Do what this webhook does, once, with this delivery?'))) return run(true, b);
      }));
      return row;
    })(),
    out,
  );
  src.addEventListener('change', sync);
  sync();
}

function testCard(h, r, real) {
  const can = r.filters.map((f, i) => ({ id: String(i), text: `${f.matched ? '✓' : '✕'} ${f.text}`, risk: f.matched ? '' : 'high' }));
  const why = [];
  if (r.signature) why.push(r.signature.ok ? t('Signature: checks out') : t('Signature: refused ({why})', { why: r.signature.why ?? '' }));
  why.push(r.matched ? t('The conditions match.') : t('The conditions don\'t match: it would be filtered out.'));
  why.push(t('Summary: {text}', { text: r.summary }));
  why.push(r.matched ? t('She would: {what}', { what: doesText(h) }) : t('She would do nothing.'));
  if (real) why.push(r.ran ? (r.outcome?.error ? t('Ran, with a problem: {why}', { why: r.outcome.error }) : t('Done once for real.')) : t('Nothing ran: the conditions don\'t match.'));
  const buttons = [];
  if (real && r.outcome?.conversationId) buttons.push({ label: t('Open'), cls: 'ghost', onClick: () => helpers.openConversation(r.outcome.conversationId) });
  if (real && r.outcome?.taskId) buttons.push({ label: t('Open the card'), cls: 'ghost', onClick: () => helpers.openCard(r.outcome.taskId) });
  return proposalCard({ title: real ? t('Ran for real') : t('Dry run: nothing changed'), source: h.name, chips: [{ text: r.event || t('no event name') }], why, can, buttons });
}

async function curlPanel(h, panel) {
  panel.replaceChildren();
  try {
    const r = await api(`/hooks/${enc(h.id)}/test`, { method: 'POST', body: { curl: true, ...(fresh.get(h.id) ? { url: fresh.get(h.id) } : {}) } });
    const pre = el('pre', 'hk-curl', r.curl);
    pre.dataset.raw = '';
    panel.append(
      el('p', 'small', fresh.get(h.id) ? t('Run this on another computer to send a signed test the way the sender would. The signature is made now, so run it within 5 minutes.') : t('Run this on another computer to send a signed test. Put the webhook\'s address in place of $HOOK_URL. The signature is made now, so run it within 5 minutes.')),
      pre,
      btn(t('Copy'), 'ghost small', (b) => helpers.copyText(r.curl, b)),
    );
    if (h.verify === 'header') panel.append(el('p', 'muted small', t('Set SARA_TOKEN to the webhook\'s token in that shell first.')));
  } catch (err) {
    panel.append(el('p', 'small', err.message));
  }
}

async function logPanel(h, panel) {
  panel.replaceChildren(el('p', 'muted small', t('Loading…')));
  try {
    const r = await api(`/hooks/${enc(h.id)}/deliveries`);
    panel.replaceChildren();
    if (!r.deliveries.length) return panel.append(el('p', 'muted small', t('No deliveries yet.')));
    const table = el('table', 'hk-log');
    const thead = el('thead');
    const tr0 = el('tr');
    for (const c of [t('Time'), t('Verdict'), t('Event'), t('Size'), t('Result')]) tr0.append(el('th', '', c));
    thead.append(tr0);
    const tbody = el('tbody');
    for (const d of r.deliveries) {
      const tr = el('tr', `hk-v-${d.verdict}`);
      const res = d.result?.error ? d.result.error : d.result?.taskId ? t('Card #{n}', { n: d.result.taskId }) : d.result?.summary ? d.result.summary : '';
      tr.append(el('td', '', when(d.at)), el('td', '', VERDICTS[d.verdict]?.() ?? d.verdict), el('td', '', d.event ?? ''), el('td', '', t('{n} bytes', { n: d.size })), el('td', '', res));
      tr.tabIndex = 0;
      const open = () => void detail(h, d.id, tr);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = el('div', 'hk-log-wrap');
    wrap.append(table);
    panel.append(wrap, el('p', 'muted small', t('Bodies are kept with secrets hidden, cut to 16 KB. Bad signatures keep only their size.')));
  } catch (err) {
    panel.replaceChildren(el('p', 'small', err.message));
  }
}

async function detail(h, id, tr) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains('hk-log-detail')) return next.remove();
  try {
    const { delivery: d } = await api(`/hooks/${enc(h.id)}/deliveries?id=${id}`);
    const row = el('tr', 'hk-log-detail');
    const td = el('td');
    td.colSpan = 5;
    const lines = [`${t('Verdict')}: ${VERDICTS[d.verdict]?.() ?? d.verdict}`, d.sender ? `${t('From')}: ${d.sender}` : '', d.deliveryId ? `${t('Delivery id')}: ${d.deliveryId}` : ''].filter(Boolean);
    for (const l of lines) td.append(el('p', 'small', l));
    if (d.result?.conversationId) td.append(btn(t('Open'), 'ghost small', () => helpers.openConversation(d.result.conversationId)));
    if (d.result?.taskId) td.append(btn(t('Open the card'), 'ghost small', () => helpers.openCard(d.result.taskId)));
    td.append(el('pre', 'hk-body', d.body ?? t('(no body kept)')));
    row.append(td);
    tr.after(row);
  } catch (err) {
    status(err.message);
  }
}

// ------------------------------------------------------------------------------------------
// in the chat
// ------------------------------------------------------------------------------------------

/** A delivery in the hook's conversation: who sent it, what it was, what she did (text only). */
export function hookNotice(m, opts = {}) {
  const k = m.meta?.hook ?? {};
  const chips = [];
  if (k.event) chips.push({ text: k.event });
  if (k.sender) chips.push({ text: SENDERS[k.sender]?.() ?? k.sender });
  if (k.important) chips.push({ text: t('Important'), cls: 'warn' });
  const why = [];
  if (k.limit) why.push(t('Deliveries over its limit get "try later" for 10 minutes. Settings → Webhooks has its log.'));
  else if (k.action === 'skill') why.push(t('She ran the skill for this delivery. Her answer is above.'));
  if (k.result?.error && !k.result?.declined) why.push(t('Problem: {why}', { why: k.result.error }));
  const buttons = [{ label: t('Open the webhook'), cls: 'ghost', onClick: () => opts.openSettings?.('co-hooks') }];
  const title = k.limit ? t('{name} is sending too much: paused for 10 minutes', { name: k.name ?? '' }) : k.result?.declined ? t('You declined her step, so she stopped there.') : m.content.replace(/^hook:/, '') || k.summary || '';
  const card = proposalCard({ title, source: t('From the webhook {name}', { name: k.name ?? '' }), chips, why, buttons });
  card.classList.add('hk-notice');
  const wrap = el('div', 'msg notice hk-msg');
  wrap.append(card);
  return wrap;
}
