// Phase 121 part B (docs/design/BEGIN.md §5.2, §5.10): Settings → Data & health → Safety check-up.
// The verdict in words on top, then FIX THESE FIRST (red), NEEDS A LOOK (amber), FINE (folded) and
// RECENT FIXES with Undo. A one-click fix turns into an inline confirm that says what changes and
// whether it can be undone; the token fix asks for the current token and shows the new one once.
// Guided fixes only open a page or show the exact command. Nothing runs, costs or changes until he taps.
import { t } from './naming.js';
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openSettings: (page: string) => void } | null} */
let ctx = null;
let last = null;

export function initSafetyCheck(c) {
  ctx = c;
  $('#sc-again')?.addEventListener('click', () => void loadSafetyCheck());
}
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const UNDO = {
  'any-time': () => t('Undo any time'),
  '30-days': () => t('Undo for 30 days'),
  none: () => t("Can't be undone"),
};
const UNDO_TIP = {
  'any-time': () => t("This fix changes a setting. Undo puts your old setting back, as long as you haven't changed it since."),
  '30-days': () => t('The original is kept encrypted for 30 days, so Undo can put it back. After that it is deleted.'),
  none: () => t("This fix signs things out or makes a new token. It's safe, but you'll need to sign those devices in again."),
};

export async function loadSafetyCheck() {
  if (!ctx || !$('#sc-list')) return;
  $('#sc-status').textContent = t('Checking…');
  try {
    last = await ctx.api('/safety-check');
  } catch (e) {
    $('#sc-status').textContent = e.message;
    return;
  }
  $('#sc-status').textContent = '';
  paint();
}

function paint() {
  const r = last;
  const v = $('#sc-verdict');
  v.dataset.verdict = r.verdict;
  const mark = r.verdict === 'safe' ? '✓' : r.verdict === 'tighten' ? '◐' : '●';
  v.replaceChildren(el('p', 'sc-title', `${mark} ${r.title} · ${r.words}`), el('p', 'small muted', t('{fine} of {total} checks fine', { fine: r.fine, total: r.total })));
  const bar = el('div', 'sc-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const c of r.checks.filter((x) => x.status !== 'skip')) bar.append(el('span', `sc-seg sc-${c.accepted ? 'green' : c.status}`));
  v.append(bar);
  const red = r.checks.filter((c) => c.status === 'red');
  const amber = r.checks.filter((c) => c.status === 'amber' && !c.accepted);
  const fine = r.checks.filter((c) => c.status === 'green' || c.status === 'skip' || c.accepted);
  const out = [];
  if (red.length) out.push(el('h4', 'sc-head sc-red-head', t('Fix these first')), ...red.map(row));
  if (amber.length) out.push(el('h4', 'sc-head', t('Needs a look')), ...amber.map(row));
  $('#sc-list').replaceChildren(...out);
  const det = el('details', 'sc-fine');
  det.append(el('summary', '', t('Fine ({n})', { n: r.fine })), ...fine.map((c) => {
    const p = el('p', 'small');
    p.append(el('span', `sc-dot sc-${c.accepted ? 'amber' : c.status}`, c.status === 'skip' ? '–' : '✓'), ` ${c.title} · ${c.line}${c.accepted ? ` (${t('you chose this')})` : ''}`);
    if (c.accepted) p.append(' ', btn(t('Warn me again'), 'ghost small', async () => {
      await ctx.api('/safety-check/accept', { method: 'POST', body: { check: c.id, accept: false } }).catch((e) => alert(e.message));
      await loadSafetyCheck();
    }));
    return p;
  }));
  $('#sc-fine').replaceChildren(det);
  const recent = r.fixes ?? [];
  $('#sc-recent').replaceChildren(...(recent.length ? [el('h4', 'sc-head', t('Recent fixes'))] : []), ...recent.map((f) => {
    const p = el('p', 'small');
    const check = r.checks.find((c) => c.id === f.check);
    p.append(`${new Date(f.at).toLocaleString()} · ${check?.title ?? f.check}${f.undone ? ` · ${t('undone')}` : ''}`);
    if (f.canUndo) p.append(' ', btn(t('Undo'), 'ghost small', async () => {
      if (!confirm(t('Undo this fix? Your earlier setting comes back, which is less safe.'))) return;
      try {
        await ctx.api('/safety-check/undo', { method: 'POST', body: { fixId: f.id } });
      } catch (e) {
        alert(e.message);
      }
      await loadSafetyCheck();
    }));
    return p;
  }));
}

function row(c) {
  const box = el('div', `sc-row sc-${c.status}`);
  const h = el('p', 'sc-row-title');
  h.append(el('span', `sc-dot sc-${c.status}`, '●'), ` ${c.title} `, tip(c.why));
  box.append(h, el('p', 'small', c.line));
  if (c.detail) box.append(el('p', 'small muted', c.detail));
  const acts = el('div', 'sc-acts');
  for (const f of c.fixes) {
    const wrap = el('div', 'sc-fix');
    const undo = el('span', 'small muted', f.kind === 'guided' ? t('Changes nothing here') : UNDO[f.undo]());
    undo.append(' ', tip(f.kind === 'guided' ? t("Sara can't safely change this from here (it could lock you out), so she shows you exactly where or what to type.") : UNDO_TIP[f.undo]()));
    const b = btn(f.kind === 'guided' && f.open ? `${f.label} →` : f.label, f.kind === 'guided' ? 'ghost' : 'primary', () => void doFix(c, f, wrap));
    wrap.append(b, undo);
    if (f.kind === 'guided' && f.command) {
      const pre = el('code', 'sc-cmd', f.command);
      const copy = btn(t('Copy'), 'ghost small', () => void navigator.clipboard?.writeText(f.command));
      wrap.append(pre, copy, btn(t('Check again'), 'ghost small', () => void loadSafetyCheck()));
    }
    acts.append(wrap);
  }
  if (c.status === 'amber') {
    const more = el('details', 'sc-more');
    const sum = el('summary', '', '⋯');
    sum.setAttribute('aria-label', t('More'));
    const a = btn(t("I know, don't warn me"), 'ghost small', async () => {
      await ctx.api('/safety-check/accept', { method: 'POST', body: { check: c.id, accept: true } }).catch((e) => alert(e.message));
      await loadSafetyCheck();
    });
    more.append(sum, a, tip(t('Moves this to Fine with a note that you chose it. Red problems can’t be hidden. You can undo this on the row.')));
    acts.append(more);
  }
  box.append(acts);
  return box;
}

async function doFix(c, f, wrap) {
  if (f.kind === 'guided') {
    if (f.open) ctx.openSettings(f.open.replace('settings:', ''));
    return;
  }
  if (f.needsToken) return void tokenDialog(c, f);
  // The inline confirm: what changes, and whether it can be undone.
  const conf = el('div', 'sc-confirm');
  const items = (f.items ?? []).map((x) => {
    const lab = el('label', 'row');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, value: x.id });
    lab.append(cb, ` ${x.label}`);
    return lab;
  });
  conf.append(el('p', 'small', `${f.changes} ${UNDO[f.undo]()}.`), ...items);
  const go = btn(t('Do it'), 'primary', async () => {
    go.disabled = true;
    try {
      await ctx.api('/safety-check/fix', { method: 'POST', body: { check: c.id, fix: f.id, ...(items.length ? { items: items.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value) } : {}) } });
    } catch (e) {
      alert(e.message);
    }
    await loadSafetyCheck();
  });
  conf.append(el('div', 'sc-acts', ''));
  conf.lastChild.append(go, btn(t('Cancel'), 'ghost', () => conf.remove()));
  wrap.append(conf);
}

function tokenDialog(c, f) {
  const d = $('#sc-token-dlg');
  $('#sc-token-cur').value = '';
  $('#sc-token-new').hidden = true;
  $('#sc-token-form').hidden = false;
  $('#sc-token-why').textContent = f.changes;
  $('#sc-token-err').textContent = '';
  $('#sc-token-go').onclick = async () => {
    try {
      const r = await ctx.api('/safety-check/fix', { method: 'POST', body: { check: c.id, fix: f.id, current: $('#sc-token-cur').value } });
      $('#sc-token-form').hidden = true;
      $('#sc-token-new').hidden = false;
      $('#sc-token-value').textContent = r.token;
    } catch (e) {
      $('#sc-token-err').textContent = e.message;
    }
  };
  $('#sc-token-copy').onclick = () => void navigator.clipboard?.writeText($('#sc-token-value').textContent);
  $('#sc-token-done').onclick = () => location.reload();
  const x = $('#sc-token-x');
  if (x && !x.firstChild) x.append(icon('close') ?? '✕');
  x.onclick = () => d.close();
  d.showModal();
}

/** Today's *Needs you*: one line only when the last run had a red row. */
export async function todaySafetyLine() {
  if (!ctx) return null;
  try {
    return (await ctx.api('/safety-check/today')).line;
  } catch {
    return null;
  }
}
