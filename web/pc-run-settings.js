// 3.5 (PC tools, docs/design/PC_TOOLS.md): Settings \u2192 Computer use on the desktop app: "Let her run
// commands on this computer" (off by default), its approval choice and the opt-in read-only list.
// The app keeps them (desktop/windows/src/main.cpp `setPref`); the page only shows them.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

/** The app's prefs: shown only when this app can run commands (handsRunSupported). */
export function renderPcRunPrefs(p) {
  const supported = p?.handsRunSupported === true;
  for (const id of ['#cu-run', '#cu-run-level', '#cu-run-readonly']) $(id).closest('label').hidden = !supported;
  if (!supported) return;
  $('#cu-run').checked = p.handsRun === true;
  $('#cu-run').disabled = p.handsOptIn !== true;
  $('#cu-run-level').value = p.handsRunLevel || 'task';
  $('#cu-run-level').dataset.was = p.handsRunLevel || 'task';
  $('#cu-run-level').disabled = p.handsOptIn !== true || p.handsRun !== true;
  $('#cu-run-readonly').checked = p.handsRunReadOnly === true;
  $('#cu-run-readonly').disabled = p.handsOptIn !== true || p.handsRun !== true;
}

/** The three controls call the app's bridge (handsBridge() in app.js). */
export function initPcRunSettings(bridge) {
  const status = (s) => ($('#cu-this-status').textContent = s);
  const set = async (key, value) => {
    const d = bridge();
    if (!d) return { error: t('Only in the Sara app on this computer.') };
    return d.call('setPref', { key, value }).catch((err) => ({ error: String(err) }));
  };
  $('#cu-run').addEventListener('change', async () => {
    const box = $('#cu-run');
    const on = box.checked;
    const r = await set('handsRun', on);
    if (r?.error) box.checked = !on;
    else renderPcRunPrefs(r);
    status(r?.error ? r.error : on ? t('She may ask to run commands here now. Each one is shown on this computer first.') : t('She can\u2019t run commands here now.'));
  });
  $('#cu-run-level').addEventListener('change', async () => {
    const sel = $('#cu-run-level');
    const r = await set('handsRunLevel', sel.value);
    if (r?.error) sel.value = sel.dataset.was || 'task';
    else sel.dataset.was = sel.value;
    status(r?.error ? r.error : t('Saved'));
  });
  $('#cu-run-readonly').addEventListener('change', async () => {
    const box = $('#cu-run-readonly');
    const r = await set('handsRunReadOnly', box.checked);
    if (r?.error) box.checked = !box.checked;
    status(r?.error ? r.error : t('Saved'));
  });
}
