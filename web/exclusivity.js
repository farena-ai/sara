// 2026-11-28: Settings → Sara → Relationship → Romantic and sexual exclusivity. Shown only with Adult
// mode on for the open companion; saved at once (PUT /api/exclusivity). The server decides every
// turn (src/exclusivity.ts); this page only edits her setting. Text only (textContent), never HTML.
import { t } from './naming.js';
import { api, el } from './setup-card.js';

const $ = (s) => document.querySelector(s);
let view = null;
let wired = false;

function status(msg) {
  const p = $('#bd-excl-status');
  if (p) p.textContent = msg;
}

async function save(patch) {
  try {
    view = await api('/exclusivity', { method: 'PUT', body: patch });
    render();
    status(t('Saved.'));
  } catch (err) {
    render();
    status(err.message);
  }
}

function idRows(key) {
  const ul = $(`#bd-excl-${key}`);
  const ids = view.exclusivity[key];
  ul.replaceChildren(
    ...ids.map((id) => {
      const li = el('li', 'excl-id');
      const rm = el('button', 'ghost small', t('Remove'));
      rm.type = 'button';
      rm.addEventListener('click', () => void save({ [key]: ids.filter((x) => x !== id) }));
      li.append(el('code', '', id), document.createTextNode(' '), rm);
      return li;
    }),
  );
  ul.hidden = !ids.length;
}

function render() {
  const box = $('#bd-excl');
  if (!box) return;
  if (!view?.adultOn) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const ex = view.exclusivity;
  for (const r of box.querySelectorAll('input[name="bd-excl-mode"]')) r.checked = r.value === ex.mode;
  $('#bd-excl-lists').hidden = ex.mode !== 'allowed';
  $('#bd-excl-comp-box').hidden = !view.companions.length;
  $('#bd-excl-comps').replaceChildren(
    ...view.companions.map((c) => {
      const row = el('label', 'row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ex.companions.includes(c.id);
      cb.dataset.nodirty = '';
      cb.addEventListener('change', () => void save({ companions: cb.checked ? [...new Set([...ex.companions, c.id])] : ex.companions.filter((x) => x !== c.id) }));
      row.append(cb, el('span', '', c.name));
      return row;
    }),
  );
  idRows('discord');
  idRows('telegram');
  $('#bd-excl-count').textContent = view.declined7d ? t('Declined attempts in the last 7 days: {n}', { n: view.declined7d }) : t('No declined attempts in the last 7 days.');
}

function wire() {
  if (wired) return;
  wired = true;
  for (const r of document.querySelectorAll('#bd-excl input[name="bd-excl-mode"]')) r.addEventListener('change', () => r.checked && void save({ mode: r.value }));
  for (const key of ['discord', 'telegram']) {
    const input = $(`#bd-excl-${key}-new`);
    const add = () => {
      const id = input.value.trim();
      if (!id || !view) return;
      input.value = '';
      void save({ [key]: [...new Set([...view.exclusivity[key], id])] });
    };
    $(`#bd-excl-${key}-add`).addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
  }
}

/** Fills the section on the Relationship page (hidden with Adult mode off, on the demo or on an error). */
export async function loadExclusivity() {
  const box = $('#bd-excl');
  if (!box) return;
  wire();
  status('');
  try {
    view = await api('/exclusivity');
    render();
  } catch {
    view = null;
    box.hidden = true;
  }
}
