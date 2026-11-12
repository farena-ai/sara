// 3.5.x (reach): Settings \u2192 Computer use on the Windows app: "Which folders" under Files. Desktop,
// Documents and Downloads (default), those and folders the person picks, the whole user folder, or all
// drives; always read only. The app keeps the choice and the picked folders (desktop/windows/src/main.cpp
// `handsFilesScope`, `filesAddFolder`); the page only gets the folders' names, never their paths.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

/** The app's prefs: shown only when this app supports more folders (handsFilesScopeSupported). */
export function renderPcFilesPrefs(p) {
  const supported = p?.handsFilesScopeSupported === true;
  $('#cu-files-scope').closest('label').hidden = !supported;
  $('#cu-files-picked').hidden = !supported || p.handsFilesScope !== 'picked';
  if (!supported) return;
  const sel = $('#cu-files-scope');
  sel.value = p.handsFilesScope || 'three';
  sel.dataset.was = sel.value;
  sel.disabled = p.handsOptIn !== true || p.handsFiles !== true;
  $('#cu-files-add').disabled = sel.disabled;
  const list = $('#cu-files-list');
  list.replaceChildren();
  const names = Array.isArray(p.handsFilesFolders) ? p.handsFilesFolders : [];
  names.forEach((name, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = String(name);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost small';
    rm.textContent = t('Remove');
    rm.dataset.index = String(i);
    rm.disabled = sel.disabled;
    li.append(span, ' ', rm);
    list.append(li);
  });
  $('#cu-files-none').hidden = names.length > 0;
}

/** The controls call the app's bridge (handsBridge() in app.js). */
export function initPcFilesSettings(bridge) {
  const status = (s) => ($('#cu-this-status').textContent = s);
  const call = async (kind, args) => {
    const d = bridge();
    if (!d) return { error: t('Only in the Sara app on this computer.') };
    return d.call(kind, args).catch((err) => ({ error: String(err) }));
  };
  $('#cu-files-scope').addEventListener('change', async () => {
    const sel = $('#cu-files-scope');
    const r = await call('setPref', { key: 'handsFilesScope', value: sel.value });
    if (r?.error) sel.value = sel.dataset.was || 'three';
    else renderPcFilesPrefs(r);
    status(r?.error ? r.error : sel.value === 'drives' ? t('She may read files on all drives here now (read only).') : sel.value === 'home' ? t('She may read files in your whole user folder here now (read only).') : sel.value === 'picked' ? t('Add the folders she may read.') : t('Saved'));
  });
  $('#cu-files-add').addEventListener('click', async () => {
    const r = await call('filesAddFolder', {});
    if (r?.cancelled) return;
    if (!r?.error) renderPcFilesPrefs(r);
    status(r?.error ? r.error : t('Saved'));
  });
  $('#cu-files-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-index]');
    if (!b) return;
    const r = await call('filesRemoveFolder', { index: b.dataset.index });
    if (!r?.error) renderPcFilesPrefs(r);
    status(r?.error ? r.error : t('Saved'));
  });
}
