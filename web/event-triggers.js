// C4 (docs/ops/C4_DESIGN.md, docs/TRIGGERS.md): Settings → Connections → Webhooks → "When this
// happens". A trigger listens to one source (a new email, a Slack or Teams message, one of your
// webhooks, a tool server's event), checks its filter and then runs your instruction or one of your
// crews with the event as input. Each has a daily run cap and token budget, a pause switch and a
// list of its last runs (also the ones it skipped and why). Nothing here calls a model by itself.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => void } | null} */
let ctx = null;
let data = null;
let editing = null;

export function initEventTriggers(c) {
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
const opt = (value, label, selected) => Object.assign(document.createElement('option'), { value, textContent: label, selected });
const SOURCES = () => ({ email: t('A new email'), slack: t('A Slack message'), teams: t('A Teams message'), webhook: t('A webhook delivery'), mcp: t('A tool server event') });
const VERDICTS = () => ({
  started: t('working'),
  done: t('done'),
  failed: t('finished with problems'),
  declined: t('you declined a step'),
  duplicate: t('skipped: seen before'),
  capped: t('skipped: runs for today used'),
  budget: t('skipped: budget for today used'),
  loop: t('skipped: her own message'),
  busy: t('skipped: still on the last one'),
});
const TOOLS = () => ({ planner: t('Her to-dos'), web: t('Web search'), github: t('GitHub'), home: t('Home Assistant') });
const stamp = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export async function loadEventTriggers() {
  const host = $('#et');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/triggers');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can use this.') : e.message));
    return;
  }
  const rows = [];
  if (data.pinned) rows.push(el('p', 'skl-note small', t('Event triggers are turned off by your admin.')));
  if (!data.triggers.length && !editing) rows.push(el('p', 'muted small', t('No triggers yet. Add one to start her work when something happens.')));
  for (const x of data.triggers) rows.push(triggerRow(x));
  if (editing) rows.push(triggerForm(editing));
  else if (!data.pinned) {
    const add = el('div', 'add-row');
    add.append(btn(t('Add a trigger…'), 'ghost small', () => {
      editing = { source: 'email', filter: {}, action: { kind: 'prompt', tools: [] } };
      void loadEventTriggers();
    }));
    rows.push(add);
  }
  if (data.runs.length) rows.push(lastRuns(data.runs));
  host.replaceChildren(...rows);
}

function describe(x) {
  const f = x.filter ?? {};
  const bits = [SOURCES()[x.source] ?? x.source];
  if (f.from) bits.push(t('from {who}', { who: f.from }));
  if (f.channel) bits.push(t('in {channel}', { channel: f.channel }));
  if (f.hookId) bits.push(t('from the webhook {name}', { name: data.hooks.find((h) => h.id === f.hookId)?.name ?? f.hookId }));
  if (f.server) bits.push(t('from {server}', { server: f.server }));
  if (f.uri) bits.push(t('about {address}', { address: f.uri }));
  if (f.event) bits.push(t('event {name}', { name: f.event }));
  if (f.words) bits.push(t('with “{words}”', { words: f.words }));
  return bits.join(' · ');
}

function triggerRow(x) {
  const row = el('div', `rt-row et-row${x.state === 'on' ? '' : ' rt-off'}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', x.name), el('span', `wt-state wt-${x.state === 'on' ? 'active' : 'paused'}`, x.state === 'on' ? t('On') : t('Paused')));
  row.append(head);
  row.append(el('div', 'rt-when muted small', `${t('When')}: ${describe(x)}`));
  const what = x.action.kind === 'crew' ? t('Start the crew {name}', { name: data.crews.find((c) => c.id === x.action.crewId)?.name ?? `#${x.action.crewId}` }) : x.action.prompt;
  row.append(el('div', 'small', `${t('Then')}: ${what}`));
  row.append(el('div', 'muted small', t('Today: {runs} of {max} runs, {tokens} of {budget} tokens', { runs: x.today.runs, max: x.limits.runsPerDay, tokens: x.today.tokens.toLocaleString(), budget: x.limits.tokensPerDay.toLocaleString() })));
  if (x.last) row.append(el('div', 'rt-status small', t('Last: {time}, {status}', { time: stamp(x.last.at), status: VERDICTS()[x.last.verdict] ?? x.last.verdict })));
  const acts = el('div', 'rt-more-acts');
  acts.append(x.state === 'on' ? btn(t('Pause'), 'ghost small', () => void act(`/triggers/${x.id}`, 'PATCH', { state: 'paused' })) : btn(t('Turn on'), 'ghost small', () => void act(`/triggers/${x.id}`, 'PATCH', { state: 'on' })));
  if (x.conversationId) acts.append(btn(t('Open the chat'), 'ghost small', () => ctx.openConversation?.(x.conversationId)));
  if (!data.pinned) acts.append(btn(t('Edit'), 'ghost small', () => ((editing = structuredClone(x)), void loadEventTriggers())));
  acts.append(btn(t('Delete'), 'ghost small danger', () => {
    if (confirm(t('Delete this trigger? Its chat stays.'))) void act(`/triggers/${x.id}`, 'DELETE');
  }));
  row.append(acts);
  return row;
}

function lastRuns(runs) {
  const box = el('details', 'jobs-more et-runs');
  box.append(el('summary', '', t('Last runs')));
  const names = new Map(data.triggers.map((x) => [x.id, x.name]));
  const list = el('ul', 'et-run-list small');
  for (const r of runs) {
    const li = el('li', `et-run et-${r.verdict}`);
    li.append(el('span', 'muted', stamp(r.at)), el('strong', '', names.get(r.triggerId) ?? `#${r.triggerId}`), el('span', '', VERDICTS()[r.verdict] ?? r.verdict));
    if (r.summary) li.append(el('span', 'muted', r.summary));
    if (['done', 'failed', 'declined'].includes(r.verdict) && !r.notified) li.append(el('span', 'muted', t('(no notification: quiet hours)')));
    list.append(li);
  }
  box.append(list);
  return box;
}

async function act(path, method = 'POST', body = {}) {
  try {
    await ctx.api(path, { method, ...(method === 'DELETE' ? {} : { body }) });
  } catch (e) {
    alert(e.message);
  }
  await loadEventTriggers();
}

function triggerForm(x) {
  const form = el('div', 'rt-form et-form');
  const field = (label, input, help) => {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', label), input, tip(help));
    form.append(lab);
    return lab;
  };
  const text = (value, max, ph) => Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', maxLength: max, placeholder: ph ?? '' });
  const f = x.filter ?? {};
  const name = text(x.name, 60, t('e.g. Invoices'));
  field(t('Name'), name, t('What you call this trigger. Its runs happen in a chat called “When: name”.'));
  const source = document.createElement('select');
  for (const [v, l] of Object.entries(SOURCES())) source.append(opt(v, l, x.source === v));
  field(t('When'), source, t('Where the event comes from. Email, Slack and Teams need that chat app connected; a webhook needs one of your webhooks above; a tool server event needs a program under Other programs (MCP).'));
  const from = text(f.from, 120, t('e.g. billing@example.com'));
  const fromLab = field(t('From'), from, t('Optional. Part of the sender’s address or id. For email it only matches when the sender check of his provider passed.'));
  const channel = text(f.channel, 120, t('e.g. ops'));
  const channelLab = field(t('Channel'), channel, t('Optional. The channel’s name or id. She must be in it. Empty: any chat or channel she is in.'));
  const hook = document.createElement('select');
  for (const h of data.hooks) hook.append(opt(h.id, h.name, f.hookId === h.id));
  if (!data.hooks.length) hook.append(opt('', t('Make a webhook first'), true));
  const hookLab = field(t('Webhook'), hook, t('Which of your webhooks. Its signature is checked before anything happens; its own action still runs too (pick Tell me for it if you only want this).'));
  const server = document.createElement('select');
  for (const s of data.servers) server.append(opt(s, s, f.server === s));
  if (!data.servers.length) server.append(opt('', t('Add a tool server first'), true));
  const serverLab = field(t('Tool server'), server, t('Which program (MCP). It must send resource updates or events; Sara subscribes to the address below when it offers that.'));
  const uri = text(f.uri, 300, t('e.g. file:///notes/'));
  const uriLab = field(t('Address starts with'), uri, t('Optional. Only updates of resources whose address starts with this. Sara subscribes to it on the tool server.'));
  const event = text(f.event, 120, t('e.g. deployment'));
  const eventLab = field(t('Event name'), event, t('Optional. Only this event (the webhook’s event header or type, or the tool server’s event name).'));
  const words = text(f.words, 120, t('e.g. invoice'));
  field(t('With the words'), words, t('Optional. Every word must appear in the subject or the text, in any case.'));
  const kind = document.createElement('select');
  kind.append(opt('prompt', t('Do what I write'), x.action?.kind !== 'crew'), opt('crew', t('Start a crew'), x.action?.kind === 'crew'));
  field(t('Then'), kind, t('Do what I write: she runs your instruction with the event as information, never as orders. Start a crew: one of your crews (Team → Crews) runs with the event as its input.'));
  const prompt = document.createElement('textarea');
  prompt.rows = 3;
  prompt.maxLength = 2000;
  prompt.value = x.action?.prompt ?? '';
  prompt.placeholder = t('e.g. Add the invoice to my to-dos with its due date');
  const promptLab = field(t('Instruction'), prompt, t('What she does each time. Anything that changes something (a to-do, a comment, a light) waits for your OK, as always.'));
  const toolsBox = el('div', 'add-row et-tools');
  const ticks = {};
  for (const [k, l] of Object.entries(TOOLS())) {
    const lab = el('label', 'inline');
    const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: (x.action?.tools ?? []).includes(k) });
    ticks[k] = c;
    lab.append(c, document.createTextNode(` ${l}`));
    toolsBox.append(lab);
  }
  const toolsLab = el('div', 'rt-field');
  toolsLab.append(el('span', '', t('She may use')), toolsBox, tip(t('The only tools she gets for these runs. Reading is free; changes ask you first. Nothing ticked: she only reads the event and answers.')));
  form.append(toolsLab);
  const crew = document.createElement('select');
  for (const c of data.crews) crew.append(opt(String(c.id), c.name, x.action?.crewId === c.id));
  if (!data.crews.length) crew.append(opt('', t('Make a crew first (Team → Crews)'), true));
  const crewLab = field(t('Crew'), crew, t('The crew that starts. Its own budget, approvals and report file apply.'));
  const runs = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: '100', value: String(x.limits?.runsPerDay ?? 10) });
  field(t('Runs a day at most'), runs, t('After this many runs in a day, more events are skipped (and listed under Last runs) until tomorrow.'));
  const tokens = document.createElement('select');
  for (const [v, l] of [['20000', t('A little (about 15,000 words)')], ['50000', t('Some (about 40,000 words)')], ['150000', t('A lot (about 110,000 words)')]]) tokens.append(opt(v, l, String(x.limits?.tokensPerDay ?? 50000) === v));
  field(t('Budget a day'), tokens, t('The reading and writing all runs of a day may use together. When it is used up, events wait for tomorrow.'));
  const show = () => {
    const s = source.value;
    fromLab.hidden = !['email', 'slack', 'teams'].includes(s);
    channelLab.hidden = !['slack', 'teams'].includes(s);
    hookLab.hidden = s !== 'webhook';
    serverLab.hidden = uriLab.hidden = s !== 'mcp';
    eventLab.hidden = !['webhook', 'mcp'].includes(s);
    promptLab.hidden = toolsLab.hidden = kind.value === 'crew';
    crewLab.hidden = kind.value !== 'crew';
  };
  source.addEventListener('change', show);
  kind.addEventListener('change', show);
  show();
  const msg = el('p', 'muted small', '');
  msg.setAttribute('role', 'status');
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(x.id ? t('Save') : t('Add the trigger'), 'primary small', async () => {
    const s = source.value;
    const filter = { words: words.value, ...(fromLab.hidden ? {} : { from: from.value }), ...(channelLab.hidden ? {} : { channel: channel.value }), ...(s === 'webhook' ? { hookId: hook.value } : {}), ...(s === 'mcp' ? { server: server.value, uri: uri.value } : {}), ...(eventLab.hidden ? {} : { event: event.value }) };
    const action = kind.value === 'crew' ? { kind: 'crew', crewId: Number(crew.value) } : { kind: 'prompt', prompt: prompt.value, tools: Object.keys(ticks).filter((k) => ticks[k].checked) };
    const body = { name: name.value, source: s, filter, action, limits: { runsPerDay: Number(runs.value), tokensPerDay: Number(tokens.value) } };
    try {
      await ctx.api(x.id ? `/triggers/${x.id}` : '/triggers', { method: x.id ? 'PATCH' : 'POST', body });
      editing = null;
      await loadEventTriggers();
    } catch (e) {
      msg.textContent = e.message;
    }
  }), btn(t('Cancel'), 'ghost small', () => ((editing = null), void loadEventTriggers())));
  form.append(acts, msg);
  return form;
}
