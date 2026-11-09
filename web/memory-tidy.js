// EC13 (docs/ops/EC1213_DESIGN.md): Memory → Overnight tidy, and its morning card. Off until he
// turns it on; models on this computer unless he picks any model. The card lists what changed
// with Undo for each change, and each possible conflict with Keep the newer / Keep the older /
// Keep both. Nothing is ever deleted.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openMemory?: () => void } | null} */
let ctx = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

export function initMemoryTidy(c) {
  ctx = c;
  $('#mt-on')?.addEventListener('change', () => void save({ on: $('#mt-on').checked }));
  $('#mt-model')?.addEventListener('change', () => void save({ model: $('#mt-model').value }));
  $('#mt-now')?.addEventListener('click', () => void tidyNow());
}

async function save(body) {
  try {
    await ctx.api('/memory-tidy', { method: 'PUT', body });
  } catch (e) {
    alert(e.message);
  }
  await loadMemoryTidy();
}

async function tidyNow() {
  const b = $('#mt-now');
  b.disabled = true;
  $('#mt-status').textContent = t('Tidying…');
  try {
    await ctx.api('/memory-tidy/run', { method: 'POST', body: {} });
  } catch (e) {
    alert(e.message);
  }
  b.disabled = false;
  await loadMemoryTidy();
}

const runLine = (r) => t('{when}: {merged} merged, {proposals} to check, {digests} summed up', { when: new Date(r.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), merged: r.merged, proposals: r.proposals, digests: r.digests });

export async function loadMemoryTidy() {
  if (!ctx || !$('#mt-on')) return;
  let d;
  try {
    d = await ctx.api('/memory-tidy');
  } catch (e) {
    $('#mt-status').textContent = e.message;
    return;
  }
  $('#mt-on').checked = d.settings.on;
  $('#mt-on').disabled = d.pinned === 'off';
  $('#mt-model').value = d.settings.model;
  $('#mt-model').disabled = d.pinned === 'local' || d.pinned === 'off';
  const bits = [];
  if (d.pinned === 'off') bits.push(t('The overnight memory tidy is turned off by your admin.'));
  else if (!d.local && d.settings.model === 'local') bits.push(t('No model on this computer yet: duplicates and conflicts are still found, old threads wait.'));
  if (d.runs[0]) bits.push(runLine(d.runs[0]));
  $('#mt-status').textContent = bits.join(' ');
}

const SAY = {
  merge: () => t('Merged a duplicate'),
  digest: () => t('Summed up an old thread'),
  contradiction: () => t('These may not both be true'),
};

function changeRow(c, redraw) {
  const li = el('li', `mt-change mt-${c.kind}`);
  li.append(el('strong', 'small', SAY[c.kind]?.() ?? c.kind));
  if (c.kind === 'merge') li.append(el('p', 'small', `“${c.a.content}” → “${c.b.content}”`));
  else if (c.kind === 'digest') li.append(el('p', 'small', t('{n} notes → “{text}”', { n: c.count ?? 0, text: c.b.content })));
  else li.append(el('p', 'small', `${c.a.happenedOn}: “${c.a.content}”`), el('p', 'small', `${c.b.happenedOn}: “${c.b.content}”`));
  const acts = el('div', 'rt-more-acts');
  const go = async (path) => {
    try {
      await ctx.api(`/memory-tidy/changes/${c.id}${path}`, { method: 'POST', body: {} });
    } catch (e) {
      alert(e.message);
    }
    await redraw();
  };
  if (c.kind === 'contradiction' && c.state === 'open') {
    acts.append(btn(t('Keep the newer'), 'ghost small', () => void go(`/newer`)), btn(t('Keep the older'), 'ghost small', () => void go(`/older`)), btn(t('Keep both'), 'ghost small', () => void go(`/both`)));
  } else if (c.state === 'undone') acts.append(el('span', 'muted small', t('Undone')));
  else acts.append(el('span', 'muted small', c.state === 'applied' ? t('Done') : t('Answered')), btn(t('Undo'), 'ghost small', () => void go(`/undo`)));
  li.append(acts);
  return li;
}

/** The morning card in his chat: what changed, each with Undo, and the conflicts to answer. */
export function memoryTidyNotice(m) {
  const n = m.meta?.tidy ?? {};
  const card = el('div', 'msg notice mem-tidy wt-card');
  const head = el('div', 'wt-card-head small');
  head.append(el('strong', '', `🧹 ${t('Overnight memory tidy')}`));
  card.append(head, el('p', 'small', m.content));
  if (n.skipped === 'no-local-model') card.append(el('p', 'muted small', t('No model on this computer yet: duplicates and conflicts are still found, old threads wait.')));
  const list = el('ul', 'mt-changes');
  const draw = async () => {
    try {
      const { run } = await ctx.api(`/memory-tidy/runs/${n.runId}`);
      list.replaceChildren(...run.changes.map((c) => changeRow(c, draw)));
    } catch (e) {
      list.replaceChildren(el('li', 'muted small', e.message));
    }
  };
  const more = document.createElement('details');
  more.append(el('summary', 'small', t('What changed')), list);
  more.addEventListener('toggle', () => more.open && void draw(), { once: false });
  card.append(more);
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(t('Memory'), 'ghost small', () => ctx?.openMemory?.()));
  card.append(acts);
  return card;
}
