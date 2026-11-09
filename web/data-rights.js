// EC17 (docs/ops/EC1617_DESIGN.md): Settings → Household → Retention and legal hold. Keep times per
// data kind, the whole-server hold, and per person: hold, download their data, delete their data.
// The server decides and refuses (a hold, a policy pin); this page only shows what it says.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openSettings: (page: string) => void } | null} */
let ctx = null;
let view = null;

export function initDataRights(c) {
  ctx = c;
  for (const kind of ['chats', 'memories', 'files']) $(`#dr-${kind}`)?.addEventListener('change', () => void saveRetention());
  $('#dr-instance')?.addEventListener('change', () => void saveHolds({ instance: $('#dr-instance').checked }));
  $('#dr-audit')?.addEventListener('click', () => ctx.openSettings('dh-audit'));
  const page = document.querySelector('.settings-page[data-page="dh-retention"]');
  if (page) new MutationObserver(() => !page.hidden && void load()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

const status = (text) => {
  const s = $('#dr-status');
  if (s) s.textContent = text;
};

async function load() {
  if (!ctx || !$('#dr-people')) return;
  try {
    view = await ctx.api('/data-rights');
  } catch (e) {
    status(e.message);
    return;
  }
  for (const kind of ['chats', 'memories', 'files']) $(`#dr-${kind}`).value = String(view.retention[kind]);
  $('#dr-instance').checked = view.holds.instance;
  $('#dr-instance').disabled = view.pinned.legalHold;
  $('#dr-pinned').hidden = !view.pinned.legalHold;
  renderPeople();
}

function renderPeople() {
  const list = $('#dr-people');
  list.replaceChildren();
  for (const p of view.people) {
    const row = ctx.el('div', 'sl-row');
    const info = ctx.el('div', 'sl-info');
    info.append(ctx.el('strong', '', p.person === 'owner' ? t('You') : p.name));
    info.append(ctx.el('span', 'muted small', t('{chats} chats, {memories} memories, {files} files', { chats: p.counts.conversations, memories: p.counts.memories, files: p.counts.files })));
    if (p.held) info.append(ctx.el('span', 'small', view.holds.instance ? t('On hold (whole server)') : t('On hold')));
    if (p.edits) info.append(ctx.el('span', 'muted small', t('{n} earlier versions kept under hold', { n: p.edits })));
    const actions = ctx.el('div', 'dr-actions');
    const holdLabel = ctx.el('label', 'row');
    const hold = document.createElement('input');
    hold.type = 'checkbox';
    hold.checked = view.holds.people.includes(p.person);
    hold.addEventListener('change', () => {
      const people = new Set(view.holds.people);
      if (hold.checked) people.add(p.person);
      else people.delete(p.person);
      void saveHolds({ people: [...people] });
    });
    holdLabel.append(hold, document.createTextNode(' ' + t('Hold')));
    const download = ctx.el('button', 'ghost', p.person === 'owner' ? t('Download my data') : t('Download their data'));
    download.type = 'button';
    download.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = `/api/data-rights/export?person=${encodeURIComponent(p.person)}`;
      a.download = '';
      a.click();
      status(t('The download includes only this person’s chats, memories, photos and files.'));
    });
    actions.append(holdLabel, download);
    if (p.edits) {
      const show = ctx.el('button', 'ghost', t('Show edit history'));
      show.type = 'button';
      show.addEventListener('click', () => void showHistory(p));
      actions.append(show);
    }
    if (p.person !== 'owner') {
      const del = ctx.el('button', 'danger', t('Delete their data'));
      del.type = 'button';
      del.disabled = p.held || view.pinned.personDelete;
      if (p.held) del.title = t('A legal hold keeps this person’s data. Release the hold first.');
      else if (view.pinned.personDelete) del.title = t('Set by your admin. Change the policy first.');
      del.addEventListener('click', () => void deletePerson(p));
      actions.append(del);
    }
    row.append(info, actions);
    list.append(row);
  }
}

// EC17: the earlier versions a hold kept (read-only; the server writes one audit row per look).
async function showHistory(p) {
  const box = $('#dr-history');
  let d;
  try {
    d = await ctx.api(`/data-rights/history?person=${encodeURIComponent(p.person)}`);
  } catch (e) {
    status(e.message);
    return;
  }
  const head = ctx.el('p', 'small', t('{name}: {n} earlier versions, newest first.', { name: p.person === 'owner' ? t('You') : p.name, n: d.total }));
  const rows = d.edits.map((e) => {
    const row = ctx.el('div', 'dr-edit');
    row.append(ctx.el('span', 'muted small', `${new Date(e.editedAt).toLocaleString()} · ${e.kind === 'memory' ? t('Memory') : t('Message')}`));
    row.append(ctx.el('div', 'dr-edit-text', e.withheld ? t('Replaced by the safety layer; the blocked text is not kept.') : e.previous ?? ''));
    return row;
  });
  box.replaceChildren(head, ...rows);
  box.scrollIntoView({ block: 'nearest' });
}

async function saveRetention() {
  const body = {};
  for (const kind of ['chats', 'memories', 'files']) body[kind] = Number($(`#dr-${kind}`).value);
  try {
    await ctx.api('/data-rights/retention', { method: 'PUT', body });
    status(t('Saved. Retention runs on the hourly check.'));
  } catch (e) {
    status(e.message);
  }
}

async function saveHolds(body) {
  try {
    await ctx.api('/data-rights/holds', { method: 'PUT', body });
    status(t('Legal hold saved.'));
  } catch (e) {
    status(e.message);
  }
  await load();
}

async function deletePerson(p) {
  if (!confirm(t('Delete all of {name}’s data for good: chats, memories, files and sign-in? This cannot be undone. Download it first if it may be needed.', { name: p.name }))) return;
  try {
    const { receipt } = await ctx.api('/data-rights/delete', { method: 'POST', body: { person: p.person, confirm: true } });
    status(receipt.folderGone && receipt.recordGone ? t('Deleted {chats} chats, {memories} memories and {files} files at {at}. The receipt is in the audit trail.', { chats: receipt.before.conversations, memories: receipt.before.memories, files: receipt.before.files, at: new Date(receipt.deletedAt).toLocaleString() }) : t('Not everything could be deleted. Check the audit trail.'));
  } catch (e) {
    status(e.message);
  }
  await load();
}
