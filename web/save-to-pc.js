// Save to my PC (docs/desktop.md → Drop files in, save her documents out). In the desktop app the
// documents and files she made get "Save to…" (the app's own Save window, which remembers the last
// folder) and "Save to Downloads", then Open / Show in folder. An app setting saves each new
// document she makes into a folder of the person's choice. The app downloads the bytes from her
// server into the place picked on this PC; the full path never comes back to the page (a short
// folder name and a token for Open / Show in folder only). In a browser the Download links stay.
import { t } from './naming.js';
import { dragOutData, saveUrlOk } from './drop-files.js';

let prefs;
/** The app's save abilities (null in a browser or an older app). */
async function savePrefs(fresh = false) {
  const d = window.SaraDesktop;
  if (!d?.call) return null;
  if (prefs === undefined || fresh) {
    const p = await d.call('getPrefs').catch(() => null);
    prefs = p?.saveFiles ? p : null;
  }
  return prefs;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const button = (label, fn) => {
  const b = el('button', 'ghost small', label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};

/** Open / Show in folder for a file the app saved (by its token). */
function afterButtons(r) {
  const open = (how) => () => void window.SaraDesktop.call('saveOpen', { token: r.token, how }).catch(() => {});
  return [button(t('Open'), open('open')), button(t('Show in folder'), open('folder'))];
}

/** Saves one file through the app: mode 'ask' (Save window), 'downloads' or 'auto' (her folder). */
export async function saveFile({ url, name }, mode) {
  if (!saveUrlOk(url) || !(await savePrefs())) return null;
  return window.SaraDesktop.call('saveFile', { url, name: String(name ?? ''), mode });
}

function showResult(box, r, name) {
  if (!r || r.cancelled) return false;
  box.replaceChildren(el('span', 'pc-saved', r.ok ? t('Saved {name} to {folder}', { name: r.name ?? name, folder: r.folder ?? '' }) : t("Couldn't save {name}.", { name })));
  if (r.ok) box.append(...afterButtons(r));
  return true;
}

/** Adds "Save to…" and "Save to Downloads" next to a file, in the app only. */
export function addSaveButtons(container, file) {
  if (!window.SaraDesktop?.call || !saveUrlOk(file?.url)) return;
  const box = el('span', 'pc-save');
  box.dataset.url = file.url;
  container.append(box);
  void savePrefs().then((p) => {
    if (!p?.saveFiles) return box.remove();
    const go = (mode) => async () => {
      const keep = [...box.childNodes];
      box.replaceChildren(el('span', 'pc-saved', t('Saving…')));
      try {
        if (!showResult(box, await saveFile(file, mode), file.name)) box.replaceChildren(...keep);
      } catch {
        showResult(box, { ok: false }, file.name);
      }
    };
    box.replaceChildren(button(t('Save to…'), go('ask')), button(t('Save to Downloads'), go('downloads')));
  });
}

let toastTimer = 0;
function toast(r) {
  let box = document.getElementById('pc-toast');
  if (!box) {
    box = el('div');
    box.id = 'pc-toast';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const close = button('×', () => (box.hidden = true));
  close.title = t('Close');
  box.replaceChildren(el('span', 'pc-toast-text', t('Saved {name} to {folder}', { name: r.name, folder: r.folder ?? '' })), ...afterButtons(r), close);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 8000);
}

/** A new document she just made (the live chat, not a reload): into her folder when it's on. */
export async function autoSaveMade(f) {
  const p = await savePrefs();
  if (!p?.docsAuto || !f?.made?.id) return;
  const url = `/api/library/made/${encodeURIComponent(f.made.id)}/file`;
  const r = await saveFile({ url, name: f.name }, 'auto').catch(() => null);
  if (!r?.ok) return;
  toast(r);
  for (const box of document.querySelectorAll(`.pc-save[data-url="${CSS.escape(url)}"]`)) showResult(box, r, f.name);
}

/** Drag a document card out to the desktop or a folder (Chromium's DownloadURL). */
export function dragOut(card, f) {
  if (!saveUrlOk(f?.url)) return;
  card.draggable = true;
  card.title = t('Drag this card to your desktop or a folder to save it.');
  card.addEventListener('dragstart', (e) => {
    if (e.target !== card) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', dragOutData(f, location.origin));
    e.dataTransfer.setData('text/uri-list', `${location.origin}${f.url}`);
  });
}

/** Settings → This computer: "Put her documents in a folder automatically" (the app only). */
export function fillSaveSettings(p) {
  const anchor = document.getElementById('dk-notify')?.closest('label');
  let row = document.getElementById('dk-save-row');
  if (!p?.saveFiles || !anchor) return row?.remove();
  prefs = p;
  if (!row) {
    row = el('div', 'dk-save-row');
    row.id = 'dk-save-row';
    const label = el('label', 'row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'dk-save-auto';
    label.append(box, ` ${t('Put her documents in a folder automatically')} `);
    const tip = el('button', 'tip', '?');
    tip.type = 'button';
    tip.dataset.tip = t('Each new document she makes is saved there too, and a message says where. The folder stays on this computer; her server never learns it.');
    label.append(tip);
    const where = el('span', 'muted small');
    where.id = 'dk-save-where';
    const pick = button(t('Choose folder…'), () => void change({ pick: '1' }));
    row.append(label, where, pick);
    anchor.after(row);
    const change = async (args) => {
      const r = await window.SaraDesktop.call('saveSettings', args).catch(() => null);
      if (r) show({ ...p, ...r });
    };
    box.addEventListener('change', () => void change({ auto: box.checked ? '1' : '0' }));
  }
  const show = (q) => {
    prefs = { ...prefs, ...q };
    document.getElementById('dk-save-auto').checked = Boolean(q.docsAuto);
    document.getElementById('dk-save-where').textContent = q.docsAutoLabel ? `${q.docsAutoLabel}` : '';
  };
  show(p);
}
