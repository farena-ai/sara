// S9b (docs/SUPPORT_LINK.md): the support link on the Messages page. In a one-to-one chat:
//   helped side  "Ask <name> for help" → give a help pass (1 hour / 1 day / 7 days), Revoke, and approval
//                cards for each suggested change with the exact before → after; nothing changes without OK.
//   helper side  "Look at <name>'s Sara" → the redacted report and what looks wrong, "Suggest a fix".
// Both sides see the help log. Nothing here runs anything on either computer.
import { t } from './naming.js';
import { initRemoteRepair, loadRemoteRepair, remoteLogText, remoteRows, remoteStrip } from './remote-repair.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, askHer?: (text: string) => void, confirm?: (text: string) => Promise<boolean> } | null} */
let ctx = null;
let state = null;
let reload = async () => {};
let say = (_m) => {};
let panel = (..._n) => {};

const LABELS = () => ({
  defaultProviderId: t('Default model service'),
  defaultModel: t('Default model'),
  defaultFallbacks: t('Backup models'),
  fallbackAfterSec: t('Seconds before a backup model takes over'),
  autoJobs: t('Jobs Auto picks a model for'),
  historyBudgetMode: t('How much of a chat she reads'),
  'memoryTidy.on': t('Overnight memory tidy'),
  'persona.innerLife': t('Inner life'),
});
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shown = (v) => {
  if (v === null || v === undefined || v === '') return t('not set');
  if (v === true) return t('On');
  if (v === false) return t('Off');
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? `${x.providerId} / ${x.model}` : String(x))).join(', ') : t('none');
  return String(v);
};
const label = (path) => LABELS()[path] ?? path;
/** The plain name of an allowlisted setting (also used by remote-repair.js). */
export const settingLabel = (path) => label(path);
/** A provider id as its name (this server's list on the helped side; the report's on the helper side). */
let names = new Map();
const provider = (id) => names.get(id) ?? id;
const value = (path, v) => (path === 'defaultProviderId' && typeof v === 'string' ? provider(v) : path === 'defaultFallbacks' && Array.isArray(v) ? shown(v.map((x) => ({ ...x, providerId: provider(x.providerId) }))) : shown(v));
const finding = (x) => `${x.area ? `${t(x.area)}: ` : ''}${t(x.text, x.params ?? {})}`;

/** Called once by messages.js with its context and helpers. */
export function initSupport(c, helpers) {
  ctx = c;
  reload = helpers.reload;
  say = helpers.say;
  panel = helpers.panel;
  initRemoteRepair(c, helpers); // T5: fix passes live in the same strip (docs/REMOTE_REPAIR.md).
}

/** Loads the support state (passes, proposals, log) with the Messages page. */
export async function loadSupport() {
  if (!ctx) return;
  try {
    await loadRemoteRepair();
    state = await ctx.api('/support');
    names = new Map((state.providers ?? []).map((p) => [p.id, p.label]));
  } catch {
    state = null;
  }
}

const pending = (link) => (state?.proposals ?? []).filter((p) => p.side === 'in' && p.status === 'pending' && (!link || p.link === link));
const given = (link) => (state?.given ?? []).find((p) => p.link === link && p.active);
const held = (link) => (state?.held ?? []).find((p) => p.link === link && p.active);

/** Rows above the chat list: suggestions waiting for the owner's OK (one row per linked server). */
export function supportRows(open) {
  const rows = [];
  const by = new Map();
  for (const p of pending()) by.set(p.link, [...(by.get(p.link) ?? []), p]);
  for (const [link, list] of by) {
    const row = el('div', 'msgs-req');
    row.append(el('span', '', list.length > 1 ? t('{name} suggests {n} changes to your Sara.', { name: list[0].peer, n: list.length }) : t('{name} suggests a change to your Sara.', { name: list[0].peer })));
    row.append(btn(t('Open'), 'small', () => open(link)));
    rows.push(row);
  }
  return [...rows, ...remoteRows(open)];
}

/** The help strip under a one-to-one chat's head (active chats only). */
export function supportStrip(chat) {
  const box = el('div', 'sup-strip');
  const rr = remoteStrip(chat);
  if (rr.childElementCount) box.append(rr);
  if (!state || chat.kind !== 'direct' || chat.status !== 'active' || !chat.linkId) return box;
  rr.remove();
  const link = chat.linkId;
  const name = chat.title;
  const line = el('div', 'sup-line');
  const g = given(link);
  if (g) {
    line.append(el('span', 'small', t('{name} has a help pass until {time}.', { name, time: when(g.expiresAt) })));
    line.append(btn(t('Revoke'), 'ghost small danger-text', async () => {
      try {
        await ctx.api(`/support/passes/${g.id}`, { method: 'DELETE' });
        say(t('Help pass ended.'));
        await reload();
      } catch (err) {
        say(err.message);
      }
    }));
  } else line.append(btn(t('Ask {name} for help', { name }), 'ghost small', () => askForm(link, name)));
  const h = held(link);
  if (h) {
    line.append(el('span', 'small', t('{name} gave you a help pass until {time}.', { name, time: when(h.expiresAt) })));
    line.append(btn(t('Look at {name}’s Sara', { name }), 'small', () => void look(link, name)));
  }
  box.append(line);
  if (h?.note) box.append(el('p', 'small sup-note', t('{name} wrote: {note}', { name, note: h.note })));
  // Setting changes first, plain notes after.
  for (const p of pending(link).sort((x, y) => y.diff.length - x.diff.length)) box.append(card(p));
  if (rr.childElementCount) box.append(rr);
  const log = (state.log ?? []).filter((r) => r.link === link);
  const outs = (state.proposals ?? []).filter((p) => p.link === link && p.side === 'out').slice(0, 5);
  if (log.length || outs.length) {
    const d = el('details', 'sup-log');
    d.append(el('summary', 'small', t('Help log')));
    for (const p of outs) d.append(el('p', 'small', `${when(p.createdAt)} · ${t('You suggested: {what}', { what: p.changes.map((c) => label(c.path)).join(', ') || t('a note') })} · ${statusText(p.status)}`));
    for (const r of log.slice(0, 30)) d.append(el('p', 'small muted', `${when(r.at)} · ${logText(r)}`));
    box.append(d);
  }
  return box;
}

const statusText = (s) => (s === 'approved' ? t('approved') : s === 'denied' ? t('declined') : s === 'pending' ? t('waiting for an answer') : s);
function logText(r) {
  const n = r.peer;
  const mine = r.side === 'helped';
  switch (r.kind) {
    case 'pass':
      return mine ? t('You gave {name} a help pass ({detail}).', { name: n, detail: r.detail }) : t('{name} gave you a help pass.', { name: n });
    case 'revoke':
      return mine ? t('You ended {name}’s help pass.', { name: n }) : t('{name} ended your help pass.', { name: n });
    case 'look':
      return mine ? t('{name} looked at your Sara.', { name: n }) : t('You looked at {name}’s Sara.', { name: n });
    case 'propose':
      return mine ? t('{name} suggested a change.', { name: n }) : t('You suggested a change to {name}.', { name: n });
    case 'approved':
      return mine ? t('You approved {name}’s suggestion.', { name: n }) : t('{name} approved your suggestion.', { name: n });
    case 'denied':
      return mine ? t('You declined {name}’s suggestion.', { name: n }) : t('{name} declined your suggestion.', { name: n });
    default:
      return remoteLogText(r) ?? r.kind;
  }
}

/** An approval card: the exact diff, the note, OK or no. */
function card(p) {
  const c = el('div', 'sup-card');
  c.setAttribute('role', 'group');
  c.setAttribute('aria-label', t('{name} suggests a change to your Sara.', { name: p.peer }));
  c.append(el('strong', '', p.diff.length ? t('{name} suggests:', { name: p.peer }) : t('{name} suggests you do this:', { name: p.peer })));
  if (p.diff.length) {
    const tbl = el('table', 'sup-diff');
    const head = el('tr');
    head.append(el('th', '', t('Setting')), el('th', '', t('Now')), el('th', '', t('After')));
    tbl.append(head);
    for (const d of p.diff) {
      const tr = el('tr');
      tr.append(el('td', '', label(d.path)), el('td', 'sup-before', value(d.path, d.before)), el('td', 'sup-after', value(d.path, d.after)));
      tbl.append(tr);
    }
    c.append(tbl);
  }
  if (p.note) c.append(el('p', 'small sup-note', p.note));
  c.append(el('p', 'small muted', p.diff.length ? t('Nothing changes unless you approve it. You can change it back in Settings at any time.') : t('This is only a note: Sara changes nothing.')));
  const acts = el('div', 'msgs-acts');
  const decide = async (approve) => {
    try {
      await ctx.api(`/support/proposals/${p.id}`, { method: 'POST', body: { approve } });
      say(approve ? (p.diff.length ? t('Changed.') : t('Done.')) : t('Declined.'));
      await reload();
    } catch (err) {
      say(err.message);
    }
  };
  acts.append(btn(p.diff.length ? t('Approve') : t('Done'), 'small', () => void decide(true)), btn(p.diff.length ? t('Decline') : t('Dismiss'), 'ghost small', () => void decide(false)));
  c.append(acts);
  return c;
}

/** "Ask <name> for help": pick how long, add a note, give the pass. */
function askForm(link, name) {
  const fs = el('fieldset', 'sup-hours');
  fs.append(el('legend', 'small', t('How long?')));
  const opts = [
    [1, t('1 hour')],
    [24, t('1 day')],
    [168, t('7 days')],
  ];
  for (const [h, text] of opts) {
    const lab = el('label', 'sup-hour');
    const r = el('input');
    r.type = 'radio';
    r.name = 'sup-hours';
    r.value = String(h);
    r.checked = h === 24;
    lab.append(r, el('span', '', text));
    fs.append(lab);
  }
  const note = el('textarea', 'sup-text');
  note.maxLength = 1000;
  note.rows = 2;
  note.placeholder = t('What’s wrong? (optional)');
  note.setAttribute('aria-label', t('What’s wrong? (optional)'));
  const go = btn(t('Give a help pass'), 'small', async () => {
    const hours = Number(fs.querySelector('input:checked')?.value ?? 24);
    try {
      await ctx.api('/support/passes', { method: 'POST', body: { link, hours, note: note.value } });
      say(t('{name} can look at your Sara until the pass ends. You can revoke it at any time.', { name }));
      document.querySelector('#msgs-panel').hidden = true;
      await reload();
    } catch (err) {
      say(err.message);
    }
  });
  panel(
    el('strong', '', t('Ask {name} for help', { name })),
    el('p', 'small', t('{name}’s Sara can then read your Sara’s health, self-test, versions, recent errors and log lines (secrets, addresses, message text and medical things removed) and your settings without keys. Never your chats, memories, files, mail or messages.', { name })),
    el('p', 'small', t('They can only suggest changes; each one waits for your OK here. No commands, no files, no remote control.')),
    fs,
    note,
    go,
  );
}

/** "Look at <name>'s Sara": the report, what looks wrong, and Suggest a fix. */
async function look(link, name) {
  say(t('Looking…'));
  let r;
  try {
    r = await ctx.api('/support/look', { method: 'POST', body: { link } });
  } catch (err) {
    say(err.message);
    return;
  }
  say('');
  const rep = r.report ?? {};
  names = new Map((rep.settings?.providers ?? []).map((p) => [p.id, p.label]));
  const nodes = [el('strong', '', t('{name}’s Sara', { name }))];
  const ver = rep.version ?? {};
  nodes.push(el('p', 'small muted', t('Version {v} · looked at {time}', { v: ver.server || '?', time: when(rep.at ?? new Date().toISOString()) })));
  const f = el('ul', 'sup-findings');
  for (const x of r.findings ?? []) {
    const li = el('li', x.level === 'problem' ? 'sup-problem' : 'sup-ok', finding(x));
    f.append(li);
  }
  if (!(r.findings ?? []).length) f.append(el('li', 'sup-ok', t('Nothing looks wrong.')));
  nodes.push(f);
  const sec = (title, lines) => {
    const d = el('details', 'sup-sec');
    d.append(el('summary', 'small', title));
    for (const l of lines) d.append(el('p', 'small', l));
    if (!lines.length) d.append(el('p', 'small muted', t('none')));
    return d;
  };
  const m = rep.models ?? {};
  nodes.push(sec(t('Models'), [`${label('defaultModel')}: ${value('defaultProviderId', m.default?.provider)} / ${shown(m.default?.model)}`, `${label('defaultFallbacks')}: ${value('defaultFallbacks', m.fallbacks)}`, `${label('fallbackAfterSec')}: ${shown(m.fallbackAfterSec)}`, ...(rep.settings?.providers ?? []).map((p) => `${p.label} (${p.kind}) · ${p.key ? t('key set') : t('no key')}`)]));
  nodes.push(sec(t('Health'), (rep.health?.checks ?? []).map((c) => `${c.ok ? '✓' : '⚠'} ${t(c.name)}: ${c.detailKey ? t(c.detailKey, c.params ?? {}) : c.detail}`)));
  nodes.push(sec(t('Self-test'), (rep.selfTest ?? []).map((l) => `${l.status === 'ok' ? '✓' : l.status === 'attention' ? '⚠' : '·'} ${t(l.text, l.params ?? {})}`)));
  const errs = rep.errors ?? {};
  nodes.push(sec(t('Recent errors'), [...(errs.turns ?? []).map((e) => `${when(e.at)} · ${e.kind}: ${e.message}`), ...(errs.providers ?? []).map((e) => `${e.service}: ${e.kind}`), ...(errs.tools ?? []).map((e) => `${when(e.at)} · ${e.tool}`)]));
  nodes.push(sec(t('Versions and apps'), [`Node ${ver.node ?? '?'}`, ver.update ? t('Updates: {state}', { state: ver.update.state }) + (ver.update.latest ? ` (${ver.update.latest})` : '') : '', ...(rep.apps ?? []).map((a) => `${a.kind} ${a.version}${a.behind ? ` · ${t('older than the server')}` : ''}`)].filter(Boolean)));
  const logBox = el('details', 'sup-sec');
  logBox.append(el('summary', 'small', t('Log lines (private things removed)')));
  logBox.append(el('pre', 'sup-logtext', (rep.log ?? []).join('\n') || '—'));
  nodes.push(logBox);
  const summary = [t('{name}’s Sara', { name }), ...(r.findings ?? []).map((x) => `- ${finding(x)}`), ...(errs.turns ?? []).slice(0, 5).map((e) => `- ${e.kind}: ${e.message}`)].join('\n');
  const acts = el('div', 'msgs-acts');
  if (ctx.askHer) acts.append(btn(t('Ask Sara to explain'), 'ghost small', () => ctx.askHer(`${t('What’s wrong here, and what should I suggest?')}\n\n${summary}`)));
  acts.append(btn(t('Suggest a fix'), 'small', () => fixForm(link, name, rep)));
  nodes.push(acts);
  panel(...nodes);
}

/** "Suggest a fix": one allowlisted setting with its new value, and/or a plain note. */
function fixForm(link, name, rep) {
  const sel = el('select', 'sup-path');
  sel.setAttribute('aria-label', t('Setting'));
  sel.append(Object.assign(el('option', '', t('Only a note')), { value: '' }));
  for (const p of state?.allow ?? Object.keys(LABELS())) sel.append(Object.assign(el('option', '', label(p)), { value: p }));
  const valBox = el('div', 'sup-val');
  const providers = rep.settings?.providers ?? [];
  let read = () => undefined;
  const paint = () => {
    valBox.replaceChildren();
    const p = sel.value;
    const now = rep.settings?.values?.[p];
    if (!p) return void (read = () => undefined);
    valBox.append(el('span', 'small muted', t('Now: {v}', { v: value(p, now) })));
    if (p === 'memoryTidy.on' || p === 'persona.innerLife') {
      const s = el('select');
      s.append(Object.assign(el('option', '', t('On')), { value: 'true' }), Object.assign(el('option', '', t('Off')), { value: 'false' }));
      s.setAttribute('aria-label', t('New value'));
      valBox.append(s);
      read = () => s.value === 'true';
    } else if (p === 'defaultProviderId' || p === 'defaultFallbacks') {
      const s = el('select');
      s.setAttribute('aria-label', t('Model service'));
      for (const x of providers) s.append(Object.assign(el('option', '', x.label), { value: x.id }));
      valBox.append(s);
      if (p === 'defaultFallbacks') {
        const mi = el('input');
        mi.placeholder = t('Model name');
        mi.setAttribute('aria-label', t('Model name'));
        valBox.append(mi);
        read = () => [{ providerId: s.value, model: mi.value.trim() }];
      } else read = () => s.value;
    } else if (p === 'historyBudgetMode') {
      const s = el('select');
      s.setAttribute('aria-label', t('New value'));
      for (const [v, l] of [['auto', t('Auto')], ['full', t('The whole chat')], ['fixed', t('A fixed amount')]]) s.append(Object.assign(el('option', '', l), { value: v }));
      valBox.append(s);
      read = () => s.value;
    } else if (p === 'autoJobs') {
      const boxes = [];
      for (const [v, l] of [['chat', t('Chat')], ['coding', t('Coding')], ['vision', t('Pictures')], ['research', t('Research')]]) {
        const lab = el('label', 'sup-hour');
        const c = el('input');
        c.type = 'checkbox';
        c.value = v;
        c.checked = Array.isArray(now) && now.includes(v);
        boxes.push(c);
        lab.append(c, el('span', '', l));
        valBox.append(lab);
      }
      read = () => boxes.filter((c) => c.checked).map((c) => c.value);
    } else {
      const i = el('input');
      i.setAttribute('aria-label', t('New value'));
      if (p === 'fallbackAfterSec') {
        i.type = 'number';
        i.min = '10';
        i.max = '600';
        read = () => Number(i.value);
      } else read = () => i.value.trim();
      i.value = now === null || now === undefined ? '' : String(now);
      valBox.append(i);
    }
  };
  sel.addEventListener('change', paint);
  const note = el('textarea', 'sup-text');
  note.maxLength = 1000;
  note.rows = 2;
  note.placeholder = t('Why, or what they should do');
  note.setAttribute('aria-label', t('Why, or what they should do'));
  const go = btn(t('Send suggestion'), 'small', async () => {
    const changes = sel.value ? [{ path: sel.value, value: read() }] : [];
    try {
      await ctx.api('/support/propose', { method: 'POST', body: { link, changes, note: note.value } });
      say(t('Sent. {name} sees it with the exact change and decides.', { name }));
      document.querySelector('#msgs-panel').hidden = true;
      await reload();
    } catch (err) {
      say(err.message);
    }
  });
  panel(el('strong', '', t('Suggest a fix to {name}', { name })), el('p', 'small', t('Only these settings can be suggested, and nothing changes until {name} approves it.', { name })), sel, valBox, note, go);
}
