import { t } from './naming.js';

/** Read-only server measurements. Successful configuration is not an inference or restore probe. */
export function createOperations({ root, api, isOwner }) {
  let generation = 0;
  const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const status = node('p', '', 'operations-status');
  status.setAttribute('role', 'status');
  const content = node('div', '', 'operations-grid');
  const refreshButton = node('button', t('Refresh operations'));
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', refresh);
  const count = (n) => Number.isFinite(n) && n >= 0 ? String(Math.round(n * 100) / 100) : t('Unavailable');
  // Fresh pass: times read as the owner's local date and time, not as raw ISO strings.
  const when = (iso) => { const d = iso ? new Date(iso) : null; return d && Number.isFinite(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : t('Unknown'); };
  const state = (s, configured = false) => ({ ready: configured ? t('Configured') : t('Ready'), not_configured: t('Not configured'), unavailable: t('Unavailable'), unknown: t('Unknown') })[s] ?? t('Unknown');
  function card(title, entries) {
    const box = node('section', '', 'recovery-card'); box.append(node('h3', title));
    const dl = node('dl');
    for (const [label, value] of entries) dl.append(node('dt', label), node('dd', String(value)));
    box.append(dl); content.append(box);
  }
  async function refresh() {
    const restoreFocus = document.activeElement === refreshButton;
    const request = ++generation;
    root.replaceChildren();
    if (!isOwner()) return;
    root.append(refreshButton, status, content);
    refreshButton.disabled = true;
    status.textContent = t('Loading operations…');
    content.replaceChildren();
    try {
      const data = await api('/operations');
      if (request !== generation || !isOwner()) return;
      const r = data.requests ?? {}, p = data.process ?? {}, q = data.queues ?? {}, ready = data.readiness ?? {};
      status.textContent = t('Current server only. HTTP response measurements do not measure model reply latency.');
      card(t('Measurement window'), [[t('Since'), when(data.since)], [t('Sampled at'), when(data.sampledAt)], [t('Completed request samples'), count(r.sampleCount)], [t('Completed requests since start'), count(r.total)]]);
      card(t('HTTP responses'), [[t('Median / p95 / maximum (ms)'), [r.p50Ms,r.p95Ms,r.maxMs].map(count).join(' / ')], [t('In flight / peak'), [r.inFlight,r.peakInFlight].map(count).join(' / ')], [t('Client errors / server errors / aborted'), [r.clientErrors,r.serverErrors,r.aborted].map(count).join(' / ')]]);
      card(t('Readiness evidence'), [[t('Database'),state(ready.database?.status)], [t('Storage'),state(ready.storage?.status)], [t('Model configuration'),state(ready.model?.status,true)], [t('Native bridges'),state(ready.bridges?.status)], [t('Backup evidence'),ready.backup?.status === 'ready' ? t('Recorded evidence') : state(ready.backup?.status)], [t('Last recorded offsite restore'),state(ready.backup?.offsiteRestore?.status) + ' · ' + (ready.backup?.offsiteRestore?.lastTestAt ?? t('Unknown'))]]);
      card(t('Current-space records and active work'), [[t('Queued user inputs'),state(q.pending?.status)+' · '+count(q.pending?.total)], [t('Jobs'),state(q.jobs?.status)+' · '+count(q.jobs?.total)], [t('Teams'),state(q.teams?.status)+' · '+count(q.teams?.total)], [t('Native message deliveries'),state(q.deliveries?.status)+' · '+count(q.deliveries?.total)], [t('Database size (bytes)'),count(q.databaseBytes)]]);
      const stateLabels = { waiting: t('Waiting'), taken: t('Taken'), moved: t('Moved'), dropped: t('Dropped'), stale: t('Stale'), ok: t('Succeeded'), stopped: t('Stopped'), planning: t('Planning'), limit: t('Limit reached'), unknown: t('Unknown'), queued: t('Queued'), running: t('Running'), completed: t('Completed'), failed: t('Failed'), cancelled: t('Cancelled'), interrupted: t('Interrupted'), budget: t('Budget reached'), attempted: t('Attempted'), acknowledged: t('Acknowledged'), outcome_unknown: t('Outcome unknown'), pending: t('Pending'), done: t('Done'), consumed: t('Consumed'), expired: t('Expired'), held: t('Held'), archived: t('Archived') };
      for (const [key, label] of [['pending', t('Queued user inputs')], ['jobs', t('Jobs')], ['teams', t('Teams')], ['deliveries', t('Native message deliveries')]]) {
        const records = q[key];
        if (records?.status !== 'ready') continue;
        card(label + ' · ' + t('State counts'), Object.entries(records.states ?? {}).map(([state, n]) => [stateLabels[state] ?? t('Other'), count(n)]));
      }
      content.append(node('p', t('Record totals include finished history. State counts show queued and running work; delivery records can include archived evidence.')));
      card(t('Process measurements'), [[t('Process memory RSS (bytes)'),count(p.rssBytes)], [t('Event-loop samples'),count(p.eventLoop?.sampleCount)], [t('Event-loop p95 / maximum (ms)'),[p.eventLoop?.p95Ms,p.eventLoop?.maxMs].map(count).join(' / ')]]);
      content.append(node('p',t('A configured model is not proof of a successful reply. A backup does not prove recovery.')),
        node('p',t('RSS and event-loop lag are process-wide, including other spaces and HTTP servers in this process. They are not current-space usage.')),
        node('p',t('Request timings use the last 512 completed responses. Error counts are cumulative since start. Detailed run receipts remain separate.')));
    } catch {
      if (request === generation && isOwner()) status.textContent = t('Operations unavailable. Refresh and try again.');
    } finally { if (request === generation) { refreshButton.disabled = false; if (restoreFocus && isOwner()) refreshButton.focus(); } }
  }
  return { refresh };
}
