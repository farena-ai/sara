// N2 (docs/AUTOMATIONS.md): Settings → You → Automations. "When ___, do ___" in one list: the ones
// she made (by chat or here) and, through their own pages' stores, the triggers, watches, routines
// and repeating reminders set up elsewhere. Make one from plain words or a starter: Preview shows what
// runs, the next three times and the approvals; Try it is a dry run (nothing is done); Turn it on
// makes it. Each row: on/off, History, Edit (name, time), Ask Sara to change it, Delete. Runs that
// wait for an OK show Allow and Decline. Nothing here calls a model.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => void, askSara?: (text: string, conversationId?: string | null) => void, openSettings?: (page: string) => void } | null} */
let ctx = null;
let data = null;
let draft = null;
const open = new Set();

export function initAutomations(c) {
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
const stamp = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const OUTCOMES = () => ({ done: t('done'), failed: t('failed'), waiting: t('waiting for your OK'), declined: t('you said no'), skipped: t('skipped'), test: t('test (nothing done)'), running: t('running') });
const SOURCES = () => ({ automation: t('Automation'), trigger: t('When this happens'), live: t('Watch'), product: t('Product watch'), file: t('File watch'), routine: t('Routine') });
const say = (msg) => {
  const s = $('#atm-status');
  if (s) s.textContent = msg;
};

export async function loadAutomations() {
  const host = $('#atm-list');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/automations');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  const starters = $('#atm-starters');
  if (starters) {
    starters.replaceChildren(...data.starters.map((s) => {
      const b = btn(s.name, 'ghost small', () => void previewDraft({ starter: s.id }));
      b.title = s.pitch;
      return b;
    }));
  }
  void loadGallery();
  const rows = [];
  for (const w of data.waiting) rows.push(waitingRow(w));
  if (!data.items.length) rows.push(el('p', 'muted small', t('Nothing runs on its own yet. Describe one above, or start from a ready-made one.')));
  for (const x of data.items) rows.push(itemRow(x));
  host.replaceChildren(...rows);
}

function waitingRow(w) {
  const row = el('div', 'atm-row atm-waiting');
  row.append(el('strong', 'small', t('Waiting for your OK: {name}', { name: w.name })), el('p', 'small', w.text));
  const acts = el('div', 'row');
  acts.append(
    btn(t('Allow'), 'small', () => void answer(w.runId, 'allow')),
    btn(t('Decline'), 'ghost small', () => void answer(w.runId, 'decline')),
  );
  row.append(acts);
  return row;
}
async function answer(runId, how) {
  try {
    await ctx.api(`/automations/runs/${runId}/${how}`, { method: 'POST', body: {} });
    say(how === 'allow' ? t('Allowed. It goes on now.') : t('Declined. It stopped there.'));
  } catch (e) {
    say(e.message);
  }
  void loadAutomations();
}

function itemRow(x) {
  const row = el('div', `atm-row${x.enabled ? '' : ' atm-off'}`);
  const head = el('div', 'atm-head');
  const sw = document.createElement('input');
  sw.type = 'checkbox';
  sw.checked = x.enabled;
  sw.disabled = !x.canToggle;
  sw.setAttribute('aria-label', t('On'));
  sw.addEventListener('change', async () => {
    try {
      await ctx.api(`/automations/${encodeURIComponent(x.key)}/${sw.checked ? 'on' : 'off'}`, { method: 'POST', body: {} });
    } catch (e) {
      say(e.message);
    }
    void loadAutomations();
  });
  const onLabel = el('label', 'row atm-switch');
  onLabel.append(sw, el('span', 'small', t('On')), tip(t('Turns this one on or off in the place it lives. Off keeps it and its history; nothing runs until you turn it back on.')));
  head.append(el('strong', 'atm-name', x.name), el('span', 'muted small atm-src', SOURCES()[x.source] ?? x.source), onLabel);
  row.append(head, el('p', 'small', `${x.when} → ${x.does}`));
  const facts = [];
  if (x.nextLocal && x.enabled) facts.push(t('Next: {when}', { when: x.nextLocal }));
  if (x.last) facts.push(t('Last: {outcome}, {when}', { outcome: OUTCOMES()[x.last.outcome] ?? x.last.outcome, when: stamp(x.last.at) }));
  if (x.status) facts.push(x.status);
  if (facts.length) row.append(el('p', 'muted small', facts.join(' · ')));
  const acts = el('div', 'row atm-acts');
  acts.append(btn(t('History'), 'ghost small', () => void toggleHistory(x, row)));
  if (x.source === 'automation') {
    acts.append(btn(t('Run now'), 'ghost small', () => void runNow(x)));
    acts.append(btn(t('Try it'), 'ghost small', () => void dryRun(x)));
    acts.append(btn(t('Edit'), 'ghost small', () => editForm(x, row)));
    acts.append(btn(t('Share as a template'), 'ghost small', () => void shareTemplate(x)));
  } else if (x.where) acts.append(btn(t('Where it is set up'), 'ghost small', () => ctx.openSettings?.(x.where)));
  acts.append(btn(t('Ask Sara to change it'), 'ghost small', () => ctx.askSara?.(`${t('Change my automation “{name}”:', { name: x.name })} `, x.conversationId)));
  if (x.conversationId) acts.append(btn(t('Open the chat'), 'ghost small', () => ctx.openConversation?.(x.conversationId)));
  if (x.canDelete) acts.append(btn(t('Delete'), 'ghost small danger', () => void remove(x)));
  row.append(acts);
  if (open.has(x.key)) void toggleHistory(x, row, true);
  return row;
}

async function toggleHistory(x, row, keep) {
  const old = row.querySelector('.atm-history');
  if (old && !keep) {
    old.remove();
    open.delete(x.key);
    return;
  }
  open.add(x.key);
  let runs = [];
  try {
    runs = (await ctx.api(`/automations/${encodeURIComponent(x.key)}/history`)).runs;
  } catch (e) {
    say(e.message);
    return;
  }
  const box = el('div', 'atm-history');
  if (!runs.length) box.append(el('p', 'muted small', t('It has not run yet.')));
  for (const r of runs) {
    const li = el('div', 'atm-run small');
    li.append(el('span', `atm-out atm-out-${r.outcome}`, OUTCOMES()[r.outcome] ?? r.outcome), el('span', 'muted', ` ${stamp(r.at)}${r.trigger ? ` · ${r.trigger}` : ''}`));
    if (r.summary) li.append(el('div', '', r.summary));
    if (r.conversationId) li.append(btn(t('Open the chat'), 'ghost small', () => ctx.openConversation?.(r.conversationId)));
    box.append(li);
  }
  row.querySelector('.atm-history')?.remove();
  row.append(box);
}

async function runNow(x) {
  try {
    await ctx.api(`/automations/${encodeURIComponent(x.key)}/run`, { method: 'POST', body: {} });
    say(t('Started. The result shows in its history.'));
  } catch (e) {
    say(e.message);
  }
  setTimeout(() => void loadAutomations(), 1500);
}
async function dryRun(x) {
  try {
    const r = await ctx.api(`/automations/${encodeURIComponent(x.key)}/dry-run`, { method: 'POST', body: {} });
    say(`${t('Test run (nothing was done):')} ${r.run.steps.map((s) => s.text).join(' · ')}`);
  } catch (e) {
    say(e.message);
  }
  void loadAutomations();
}
async function remove(x) {
  if (!confirm(t('Delete “{name}”?', { name: x.name }))) return;
  try {
    await ctx.api(`/automations/${encodeURIComponent(x.key)}`, { method: 'DELETE' });
  } catch (e) {
    say(e.message);
  }
  void loadAutomations();
}

/** Edit: the name and, for a schedule, the time and days. */
function editForm(x, row) {
  row.querySelector('.atm-edit')?.remove();
  const f = el('div', 'atm-edit');
  const name = Object.assign(document.createElement('input'), { value: x.name, maxLength: 80 });
  const nl = el('label', '', t('Name'));
  nl.append(tip(t('What it is called in this list and in its chat.')), name);
  f.append(nl);
  let time;
  const days = [];
  if (x.trigger?.kind === 'schedule') {
    time = Object.assign(document.createElement('input'), { type: 'time', value: x.trigger.time });
    const tl = el('label', '', t('Time'));
    tl.append(tip(t('The time it runs, in your time zone (Settings → You → About you).')), time);
    f.append(tl);
    if (x.trigger.every === 'week') {
      const dl = el('div', 'row atm-days');
      dl.append(el('span', 'small', t('Days')), tip(t('The days of the week it runs.')));
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d, i) => {
        const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: (x.trigger.days ?? []).includes(i) });
        days.push(c);
        const l = el('label', 'row small', '');
        l.append(c, el('span', '', t(d)));
        dl.append(l);
      });
      f.append(dl);
    }
  }
  f.append(btn(t('Save'), 'small', async () => {
    const body = { name: name.value };
    if (time) body.trigger = { time: time.value, ...(days.length ? { days: days.map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0) } : {}) };
    try {
      await ctx.api(`/automations/${encodeURIComponent(x.key)}`, { method: 'PATCH', body });
      say(t('Saved.'));
    } catch (e) {
      say(e.message);
      return;
    }
    void loadAutomations();
  }), btn(t('Cancel'), 'ghost small', () => f.remove()));
  row.append(f);
}

// ------------------------------------------------ make one

async function previewDraft(body) {
  const box = $('#atm-preview');
  if (!box) return;
  try {
    const p = await ctx.api('/automations/preview', { method: 'POST', body });
    draft = body;
    const card = el('div', 'atm-card');
    card.append(el('strong', '', p.name));
    card.append(el('p', 'small', `${t('When')}: ${p.when}`));
    if (p.next.length) card.append(el('p', 'small', `${t('Next runs')}: ${p.next.map((n) => n.local).join(' · ')}`));
    const ol = el('ol', 'small');
    for (const d of p.does) ol.append(el('li', '', d));
    card.append(el('p', 'small', t('Then')), ol);
    card.append(el('p', 'small', `${t('Approvals')}: ${p.approvals.length ? p.approvals.join(' ') : t('none needed (it only tells you).')}`));
    for (const n of p.notes) card.append(el('p', 'small skl-note', n));
    const acts = el('div', 'row');
    acts.append(
      btn(t('Try it (nothing is done)'), 'ghost small', async () => {
        try {
          const r = await ctx.api('/automations/dry-run', { method: 'POST', body: draft });
          say(`${t('Test run (nothing was done):')} ${r.steps.map((s) => s.text).join(' · ')}`);
        } catch (e) {
          say(e.message);
        }
      }),
      btn(t('Turn it on'), 'small', async () => {
        try {
          await ctx.api('/automations', { method: 'POST', body: draft });
          box.replaceChildren();
          const w = $('#atm-words');
          if (w) w.value = '';
          say(t('It’s on.'));
        } catch (e) {
          say(e.message);
        }
        void loadAutomations();
      }),
      btn(t('Cancel'), 'ghost small', () => box.replaceChildren()),
    );
    card.append(acts);
    box.replaceChildren(card);
  } catch (e) {
    say(e.message);
  }
}

// ------------------------------------------------ R9 templates (share, import, gallery)

let gallery = null;
async function loadGallery() {
  const host = $('#atm-gallery');
  if (!ctx || !host) return;
  try {
    gallery ??= (await ctx.api('/automations/templates')).gallery;
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  host.replaceChildren(...gallery.map((g) => {
    const item = el('div', 'atm-gal-item');
    item.setAttribute('role', 'listitem');
    const b = btn(g.name, 'ghost small', () => showTemplate({ gallery: g.id }, g.name, g.placeholders, g.pitch));
    b.setAttribute('aria-describedby', `atm-gal-${g.id}`);
    const pitch = el('span', 'muted small', g.pitch);
    pitch.id = `atm-gal-${g.id}`;
    item.append(b, pitch);
    return item;
  }));
}

/** Share: the template (no personal data) as a .json download and on the clipboard. */
async function shareTemplate(x) {
  try {
    const { template } = await ctx.api(`/automations/${encodeURIComponent(x.key)}/template`);
    const text = JSON.stringify(template, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `${(template.name || 'automation').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'automation'}.sara-template.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    say(t('Template saved and copied. It has no addresses, ids or keys; whoever imports it fills those in.'));
  } catch (e) {
    say(e.message);
  }
}

async function readTemplate(text) {
  if (!text.trim()) return say(t('Paste a template first, or open its file.'));
  try {
    const r = await ctx.api('/automations/templates/read', { method: 'POST', body: { text } });
    showTemplate({ template: r.template }, r.template.name, r.placeholders, r.template.description);
  } catch (e) {
    say(e.message);
  }
}

/** The template card: its blanks, then the normal preview, then Allow. Nothing is made before Allow. */
function showTemplate(base, name, placeholders, pitch) {
  const box = $('#atm-tpl-preview');
  if (!box) return;
  const card = el('div', 'atm-card');
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', t('Template: {name}', { name }));
  card.append(el('strong', '', name));
  if (pitch) card.append(el('p', 'small', pitch));
  const inputs = [];
  for (const p of placeholders) {
    const id = `atm-ph-${p.key}`;
    const l = el('label', 'atm-ph', p.label);
    l.htmlFor = id;
    const i = Object.assign(document.createElement('input'), { id, type: p.kind === 'email' ? 'email' : 'text', maxLength: 200, autocomplete: 'off' });
    i.dataset.key = p.key;
    i.addEventListener('input', () => out.replaceChildren());
    inputs.push(i);
    card.append(l, i);
  }
  if (!placeholders.length) card.append(el('p', 'muted small', t('Nothing to fill in.')));
  const out = el('div', 'atm-tpl-out');
  out.setAttribute('aria-live', 'polite');
  const values = () => Object.fromEntries(inputs.map((i) => [i.dataset.key, i.value]));
  const acts = el('div', 'row');
  acts.append(
    btn(t('Show the preview'), 'small', async () => {
      try {
        const body = { ...base, values: values() };
        const p = await ctx.api('/automations/preview', { method: 'POST', body });
        const pv = el('div', 'atm-card');
        pv.append(el('p', 'small', `${t('When')}: ${p.when}`));
        if (p.next.length) pv.append(el('p', 'small', `${t('Next runs')}: ${p.next.map((n) => n.local).join(' · ')}`));
        const ol = el('ol', 'small');
        for (const d of p.does) ol.append(el('li', '', d));
        pv.append(el('p', 'small', t('Then')), ol);
        pv.append(el('p', 'small', `${t('Approvals')}: ${p.approvals.length ? p.approvals.join(' ') : t('none needed (it only tells you).')}`));
        for (const n of p.notes) pv.append(el('p', 'small skl-note', n));
        const row = el('div', 'row');
        row.append(
          btn(t('Allow'), 'small', async () => {
            try {
              await ctx.api('/automations', { method: 'POST', body: { ...body, allow: true } });
              box.replaceChildren();
              const ta = $('#atm-tpl-text');
              if (ta) ta.value = '';
              say(t('It’s on.'));
            } catch (e) {
              say(e.message);
            }
            void loadAutomations();
          }),
          btn(t('Decline'), 'ghost small', () => box.replaceChildren()),
        );
        pv.append(row);
        out.replaceChildren(pv);
      } catch (e) {
        out.replaceChildren(el('p', 'small', e.message));
      }
    }),
    btn(t('Cancel'), 'ghost small', () => box.replaceChildren()),
  );
  card.append(acts, out);
  box.replaceChildren(card);
  (inputs[0] ?? card.querySelector('button'))?.focus();
}

export function wireAutomationsForm() {
  $('#atm-tpl-read')?.addEventListener('click', () => void readTemplate($('#atm-tpl-text')?.value ?? ''));
  $('#atm-tpl-open')?.addEventListener('click', () => $('#atm-tpl-file')?.click());
  $('#atm-tpl-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 40000) return say(t('This template is too big.'));
    const text = await f.text();
    const ta = $('#atm-tpl-text');
    if (ta) ta.value = text;
    void readTemplate(text);
  });
  $('#atm-preview-btn')?.addEventListener('click', () => {
    const words = $('#atm-words')?.value.trim();
    if (!words) return say(t('Describe it first, like “every Friday at 3, fill my time sheet”.'));
    void previewDraft({ words });
  });
}

/** Today: a tile only when something failed, waits for an OK, or runs today. */
export function renderAutomationsTile(p, tileHead) {
  const tile = $('#td-automations');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Automations'));
  const list = el('ul', 'td-biz');
  for (const f of p.failing) list.append(el('li', 'small', t('Needs a look: {name} ({why})', { name: f.name, why: f.why })));
  if (p.waiting) list.append(el('li', 'small', t('{n} waiting for your OK', { n: p.waiting })));
  for (const x of p.today) list.append(el('li', 'small', `${x.name} · ${x.local}`));
  const go = btn(t('Open Automations'), 'ghost small', () => ctx?.openSettings?.('you-automations'));
  tile.querySelector('.td-body').replaceChildren(list, go);
}
