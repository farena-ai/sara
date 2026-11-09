// EC3 (docs/ops/EC3_DESIGN.md §7): Settings → Data & health → Operations → Monitoring. Switches for
// the Prometheus endpoint and OpenTelemetry traces, the scrape token (shown once), the collector's
// headers (write-only), the scrape config to copy, the Grafana dashboard and the last export status.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

/** "Last export: ok, 5 spans, 2 minutes ago" / "failed (timeout)" / "nothing sent yet". */
export function exportLine(last, now = Date.now()) {
  if (!last) return t('Nothing sent yet.');
  const mins = Math.max(0, Math.round((now - Date.parse(last.at)) / 60000));
  const when = mins < 1 ? t('just now') : t('{n} min ago', { n: mins });
  return last.ok ? t('Last export worked: {n} spans, {when}.', { n: last.spans, when }) : t('Last export failed ({why}), {when}.', { why: last.error ?? t('unknown'), when });
}

export function createMonitoring({ api, isOwner, copyText }) {
  let view = null;
  const say = (msg) => ($('#mon-status').textContent = msg);
  const paint = () => {
    const v = view;
    $('#mon-metrics').checked = v.metrics.enabled;
    $('#mon-allow').value = v.metrics.allow.join(', ');
    $('#mon-token-state').textContent = v.metrics.hasToken ? t('A scrape token is set.') : t('No scrape token yet.');
    $('#mon-token-new').textContent = v.metrics.hasToken ? t('Replace the token') : t('Make a scrape token');
    $('#mon-token-del').hidden = !v.metrics.hasToken;
    $('#mon-scrape').textContent = v.scrapeConfig;
    $('#mon-traces').checked = v.traces.enabled;
    $('#mon-endpoint').value = v.traces.endpoint;
    $('#mon-sample').value = String(v.traces.sample);
    $('#mon-sample-val').textContent = `${Math.round(v.traces.sample * 100)} %`;
    $('#mon-headers').placeholder = v.traces.hasHeaders ? t('Saved. Type new ones to replace them.') : t('name: value');
    $('#mon-last').textContent = exportLine(v.traces.last);
  };
  const save = async (path, body, method = 'PUT') => {
    try {
      const r = await api(path, { method, body });
      view = r;
      paint();
      say('');
      return r;
    } catch (e) {
      say(e.message);
      if (view) paint();
      return null;
    }
  };
  async function refresh() {
    const box = $('#mon-box');
    if (!box) return;
    box.hidden = !isOwner();
    if (box.hidden) return;
    try {
      view = await api('/telemetry');
      paint();
    } catch (e) {
      say(e.message);
    }
  }
  const allowList = () => $('#mon-allow').value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  $('#mon-metrics')?.addEventListener('change', (e) => void save('/telemetry', { metrics: { enabled: e.target.checked } }));
  $('#mon-allow')?.addEventListener('change', () => void save('/telemetry', { metrics: { allow: allowList() } }));
  $('#mon-token-new')?.addEventListener('click', async () => {
    const r = await save('/telemetry/token', {}, 'POST');
    if (!r) return;
    $('#mon-token-value').textContent = r.token;
    $('#mon-token-show').hidden = false;
  });
  $('#mon-token-copy')?.addEventListener('click', () => void copyText($('#mon-token-value').textContent, $('#mon-token-copy')));
  $('#mon-token-del')?.addEventListener('click', async () => {
    if (!confirm(t('Remove the scrape token? Prometheus stops reading until you make a new one (allowed addresses still can).'))) return;
    $('#mon-token-show').hidden = true;
    await save('/telemetry/token', undefined, 'DELETE');
  });
  $('#mon-scrape-copy')?.addEventListener('click', () => void copyText($('#mon-scrape').textContent, $('#mon-scrape-copy')));
  $('#mon-traces')?.addEventListener('change', (e) => void save('/telemetry', { traces: { enabled: e.target.checked } }));
  $('#mon-endpoint')?.addEventListener('change', (e) => void save('/telemetry', { traces: { endpoint: e.target.value } }));
  $('#mon-sample')?.addEventListener('input', (e) => ($('#mon-sample-val').textContent = `${Math.round(Number(e.target.value) * 100)} %`));
  $('#mon-sample')?.addEventListener('change', (e) => void save('/telemetry', { traces: { sample: Number(e.target.value) } }));
  $('#mon-headers-save')?.addEventListener('click', async () => {
    if (await save('/telemetry/headers', { headers: $('#mon-headers').value })) $('#mon-headers').value = '';
  });
  $('#mon-test')?.addEventListener('click', async () => {
    $('#mon-last').textContent = t('Sending…');
    await save('/telemetry/test', {}, 'POST');
  });
  return { refresh };
}
