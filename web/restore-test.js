// U5.31 (docs/BACKUPS.md): Settings → Privacy & system → Backups → Test restores. The monthly test
// restore's switches, "Test a restore now" and the latest results. The server sends English keys
// with params (src/restore-test.ts); the words are translated here.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

const RESULT = {
  passed: () => t('Passed'),
  failed: () => t('Failed'),
  skipped: () => t('Skipped'),
};
const SOURCE = {
  local: () => t('Backup on this computer'),
  offsite: () => t('Off-server copy'),
};

const secs = (ms) => t('took {n} seconds', { n: (ms / 1000).toFixed(1) });

export function createRestoreTest({ api }) {
  let timer;

  function paint(d) {
    const on = $('#rtst-on');
    if (!on) return;
    on.checked = Boolean(d.on);
    $('#rtst-offsite').checked = Boolean(d.offsite);
    $('#rtst-offsite-row').hidden = !d.offsiteReady;
    $('#rtst-now').disabled = Boolean(d.running);
    const status = $('#rtst-status');
    if (d.running) status.textContent = t('Restoring into a throwaway folder and checking it… (this can take a few minutes)');
    else if (!d.last) status.textContent = d.on ? t('Not tested yet. The first test runs at a quiet hour.') : t('Monthly test restores are off.');
    else status.textContent = d.nextAt && d.on ? t('Next test around {date}.', { date: new Date(d.nextAt).toLocaleDateString() }) : '';
    const list = $('#rtst-list');
    list.replaceChildren();
    for (const r of (d.history ?? []).slice(0, 6)) {
      const li = document.createElement('li');
      li.className = `rtst-row rtst-${r.result}`;
      const head = document.createElement('strong');
      head.textContent = `${r.result === 'passed' ? '✓' : r.result === 'failed' ? '✗' : '–'} ${RESULT[r.result]?.() ?? r.result}`;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = ` · ${new Date(r.at).toLocaleString()} · ${SOURCE[r.source]?.() ?? r.source}${r.durationMs ? ` · ${secs(r.durationMs)}` : ''}`;
      const why = document.createElement('div');
      why.className = 'small';
      why.textContent = t(r.reason, r.params ?? {});
      li.append(head, meta, why);
      list.append(li);
    }
    clearTimeout(timer);
    if (d.running) timer = setTimeout(() => void load(), 3000);
  }

  async function load() {
    try {
      paint(await api('/backups/restore-test'));
    } catch {
      /* not available (members, demo) */
    }
  }

  async function save() {
    try {
      paint(await api('/backups/restore-test', { method: 'PUT', body: { on: $('#rtst-on').checked, offsite: $('#rtst-offsite').checked } }));
    } catch (err) {
      $('#rtst-status').textContent = err.message;
    }
  }

  const wire = () => {
    $('#rtst-on')?.addEventListener('change', () => void save());
    $('#rtst-offsite')?.addEventListener('change', () => void save());
    $('#rtst-now')?.addEventListener('click', async () => {
      $('#rtst-now').disabled = true;
      try {
        paint(await api('/backups/restore-test', { method: 'POST', body: {} }));
      } catch (err) {
        $('#rtst-now').disabled = false;
        $('#rtst-status').textContent = err.message;
      }
    });
  };
  if (globalThis.document) wire();
  return { load };
}
