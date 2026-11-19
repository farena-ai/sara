// V4.5 Screen companion (docs/desktop.md "Screen companion"): Settings → This computer's switch and
// pause, read and set through the Windows app's bridge (getPrefs / setPref screenCompanion, screenPause).
// The app does the looking, on that computer only; this page never sees what is on the screen.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
let reload = async () => {};

/** Fills the section from the app's prefs. Apps without it (the Mac app, older apps) say so. */
export function fillScreen(p) {
  const box = $('#dk-screen');
  if (!box) return;
  const can = p && typeof p.screenCompanion === 'boolean';
  box.disabled = !can;
  box.checked = Boolean(can && p.screenCompanion);
  const pause = $('#dk-screen-pause');
  const left = Number(p?.screenPausedMin) || 0;
  pause.hidden = !can || !p.screenCompanion;
  pause.textContent = left > 0 ? t('Resume now') : t('Pause for 1 hour');
  $('#dk-screen-note').textContent = !can
    ? (p?.platform === 'mac' ? t('Only in the Windows app for now.') : t('Update the Sara app to use this.'))
    : left > 0 ? t('Paused for {n} more minutes.', { n: left }) : p.screenCompanion ? t('On: looking at the window in front every few seconds, on this computer only.') : '';
}

async function set(key, value) {
  const r = await window.SaraDesktop.call('setPref', { key, value }).catch((err) => ({ error: String(err?.message ?? err) }));
  if (r?.error) $('#dk-screen-note').textContent = r.error;
  else fillScreen(r);
  await reload();
}

/** Wires the switch and the pause button (only inside the desktop app). */
export function initScreen(load) {
  if (!window.SaraDesktop || !$('#dk-screen')) return;
  reload = load;
  $('#dk-screen').addEventListener('change', () => void set('screenCompanion', $('#dk-screen').checked));
  $('#dk-screen-pause').addEventListener('click', async () => {
    const p = await window.SaraDesktop.call('getPrefs').catch(() => null);
    await set('screenPause', Number(p?.screenPausedMin) > 0 ? '0' : '60');
  });
}
