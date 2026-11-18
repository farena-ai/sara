// U4.25 (docs/EXTENSION.md): Settings → Connections → Devices and sign-in → Browser extension. Two
// switches in the person's own space: the extension may send pages at all, and "Fill this form" may
// propose values from My details. Paired extensions are listed with the other devices (kind
// 'extension'). Saves on change (not the page saver).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
let wired = false;

async function call(method = 'GET', body) {
  const r = await fetch('/api/extension', { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? String(r.status));
  return d;
}

function paint(s) {
  $('#bx-on').checked = s.on !== false;
  $('#bx-forms').checked = s.forms !== false;
  $('#bx-forms').disabled = s.on === false;
  $('#bx-status').textContent = s.paired ? t('{n} paired: see the list below.', { n: s.paired }) : t('None paired yet.');
}

export async function loadBrowserExt() {
  if (!$('#bx-box')) return;
  if (!wired) {
    wired = true;
    for (const [id, key] of [['#bx-on', 'on'], ['#bx-forms', 'forms']]) {
      $(id).addEventListener('change', async (e) => {
        try {
          paint(await call('PUT', { [key]: e.target.checked }));
        } catch (err) {
          $('#bx-status').textContent = t(err.message);
        }
      });
    }
  }
  try {
    paint(await call());
  } catch (err) {
    $('#bx-status').textContent = t(err.message);
  }
}
