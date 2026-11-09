// EC28 (docs/ops/EC1828_DESIGN.md): Settings → Data & health → Readiness and recovery, the top half.
// Is this install ready for real use? The verdict in words, one row per area (ready / needs
// attention / not ready) with its one fix, and Run a restore drill with the last measured result.
// The server sends codes and numbers; the words are here. Safety-backed rows bring their own line.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

export const TITLES = {
  backups: () => t('Backups'),
  drill: () => t('Restore drill'),
  offsite: () => t('Off-computer copy'),
  disk: () => t('Disk space'),
  model: () => t('Model'),
  bridges: () => t('Chat apps'),
  paused: () => t('Paused work'),
  updates: () => t('Updates'),
  https: () => t('HTTPS and who can reach her'),
  signin: () => t('Sign-in'),
  policy: () => t('Policy'),
  monitoring: () => t('Monitoring and audit'),
};

const TIPS = {
  backups: () => t('Ready: a backup on this computer from the last 2 days and automatic backups on. A backup is how you get her back after a broken disk or a bad update.'),
  drill: () => t('Ready: a restore drill passed in the last 30 days. A backup that was never restored is a hope; the drill proves it opens, checks it and starts it.'),
  offsite: () => t('From the safety check-up: a copy of her backups kept off this computer, so a fire, theft or dead disk does not take everything.'),
  disk: () => t('Ready: 5 GB or more free where her data lives. Under 1 GB, backups and uploads start to fail.'),
  model: () => t('Ready: a model is set up and answered when Sara listed its models (free, no chat). Check the model again asks once more.'),
  bridges: () => t('Every chat app you switched on is connected. None switched on is fine.'),
  paused: () => t('Interrupted jobs and teams, and messages whose delivery is uncertain. Nothing restarts or resends by itself: review them in the list below.'),
  updates: () => t('From the safety check-up: only the newest version gets security fixes. Sara never updates by herself.'),
  https: () => t('From the safety check-up: who can reach her, and whether other devices use HTTPS so nobody on the same network can read your chats.'),
  signin: () => t('From the safety check-up: a passkey or two-step sign-in, a recent owner token and no forgotten devices.'),
  policy: () => t('From the safety check-up: settings looser than your admin policy allows. No policy set is fine.'),
  monitoring: () => t('Ready: the audit trail runs and its chain verifies, and metrics are on for your dashboards. One person can leave metrics off.'),
};

const STATUS = {
  ready: () => t('Ready'),
  attention: () => t('Needs attention'),
  'not-ready': () => t('Not ready'),
};
const MARK = { ready: '✓', attention: '◐', 'not-ready': '●' };

/** The words of one area (pure; exported for the tests). */
export function areaLine(a) {
  const p = a.params ?? {};
  if (a.reason === 'safety') return a.line ?? '';
  switch (`${a.id}:${a.reason}`) {
    case 'backups:none': return t('No backup on this computer yet.');
    case 'backups:auto-off': return t('Automatic backups are off. The newest is {hours} h old.', p);
    case 'backups:old': return t('The newest backup is {hours} h old.', p);
    case 'backups:ok': return t('The newest backup is {hours} h old ({n} kept).', p);
    case 'drill:never': return p.offsiteOk ? t('No restore drill yet. The off-computer copy passed its own test restore.') : t('No restore has been proven yet.');
    case 'drill:failed': return t('The last restore drill failed: {error}', p);
    case 'drill:stale': return t('The last restore drill passed {days} days ago.', p);
    case 'drill:ok': return p.lossHours === null || p.lossHours === undefined ? t('Restored and started in {seconds} s, {days} day(s) ago.', p) : t('Restored and started in {seconds} s, {days} day(s) ago. Restoring that backup now would lose {lossHours} h.', p);
    case 'disk:unknown': return t("Free space can't be read here.");
    case 'disk:low': return t('Only {gb} GB free.', p);
    case 'disk:ok': return t('{gb} GB free.', p);
    case 'model:none': return t('No model is set up.');
    case 'model:unprobed': return t('Not checked yet.');
    case 'model:unreachable': return t("The model doesn't answer: {error}", p);
    case 'model:ok': return t('The model answers.');
    case 'bridges:none': return t('No chat apps are switched on.');
    case 'bridges:down': return t('Not connected: {names}.', p);
    case 'bridges:ok': return t('Connected: {names}.', p);
    case 'paused:none': return t('Nothing is paused or uncertain.');
    case 'paused:some': return t('{jobs} job(s), {teams} team(s) and {deliveries} message(s) wait for your review below.', p);
    case 'policy:none': return t('No admin policy is set.');
    case 'monitoring:audit-missing': return t('The audit trail is not running.');
    case 'monitoring:audit-broken': return t("The audit trail's chain does not verify.");
    case 'monitoring:metrics-off': return t('The audit trail is on; metrics are off (fine for one person).');
    case 'monitoring:ok': return t('Audit trail and metrics are on.');
    default: return t("The safety check-up couldn't run.");
  }
}

/** The verdict in one sentence (pure). */
export function verdictLine(r) {
  if (r.verdict === 'ready') return t('Ready for real use.');
  if (r.verdict === 'attention') return t('Ready, with {n} thing(s) to look at.', { n: r.counts.attention });
  return t('Not ready yet: {n} thing(s) to fix first.', { n: r.counts['not-ready'] });
}

/** The last drill in words (pure). */
export function drillLine(d) {
  if (!d) return t('No restore drill has run yet.');
  const when = new Date(d.at).toLocaleString();
  if (!d.ok) return t('Last drill {when}: failed. {error}', { when, error: d.error ?? '' });
  const c = d.counts ?? {};
  return t('Last drill {when}: {backup} restored in {restore} s and started in {boot} s ({total} s in all). {conversations} chats, {messages} messages, {memories} memories, {databases} database(s), {vault} vault entries. Restoring it now would lose {loss} h.', {
    when, backup: d.backup ?? '', restore: ((d.restoreMs ?? 0) / 1000).toFixed(1), boot: ((d.bootMs ?? 0) / 1000).toFixed(1), total: ((d.totalMs ?? 0) / 1000).toFixed(1),
    conversations: c.conversations ?? 0, messages: c.messages ?? 0, memories: c.memories ?? 0, databases: d.databases ?? 0, vault: d.vaultEntries ?? 0, loss: d.dataLossHours ?? 0,
  });
}

export function createReadiness({ api, el, isOwner, openSettings, copyText }) {
  let view = null;
  let timer = null;
  const say = (msg) => ($('#rd-status').textContent = msg);
  const btn = (label, cls, onClick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const tip = (text) => {
    const b = el('button', 'tip', '?');
    b.type = 'button';
    b.dataset.tip = text;
    b.setAttribute('aria-label', t('What is this?'));
    return b;
  };
  const fixOf = (a) => {
    const f = a.fix;
    if (!f || a.status === 'ready' && !('action' in f && f.action === 'probe')) return null;
    if ('open' in f) return btn(`${t('Open')} →`, 'ghost small', () => openSettings(f.open.replace('settings:', '')));
    if ('command' in f) {
      const box = el('span', 'rd-cmd');
      box.append(el('code', 'sc-cmd', f.command), btn(t('Copy'), 'ghost small', () => void copyText(f.command)));
      return box;
    }
    if (f.action === 'drill') return btn(t('Run a restore drill'), 'primary small', () => void drill());
    if (f.action === 'probe') return btn(t('Check the model again'), 'ghost small', () => void probe());
    if (f.action === 'recovery') return btn(t('Review below'), 'ghost small', () => $('#recovery-content')?.scrollIntoView({ block: 'start' }));
    return null;
  };
  const paint = () => {
    const r = view;
    const v = $('#rd-verdict');
    v.dataset.verdict = r.verdict;
    v.replaceChildren(el('p', 'sc-title', `${MARK[r.verdict]} ${verdictLine(r)}`));
    const list = $('#rd-list');
    list.replaceChildren(...r.areas.map((a) => {
      const li = el('li', `rd-row rd-${a.status}`);
      const head = el('p', 'rd-head');
      head.append(el('span', 'rd-mark', MARK[a.status]), el('strong', '', TITLES[a.id]?.() ?? a.id), el('span', 'rd-state muted small', STATUS[a.status]()), tip(TIPS[a.id]?.() ?? ''));
      const line = el('p', 'small', areaLine(a));
      const fix = fixOf(a);
      li.append(head, line);
      if (fix) {
        const row = el('p', 'rd-fix');
        row.append(fix);
        li.append(row);
      }
      return li;
    }));
    const running = r.drill.running;
    $('#rd-drill').disabled = running;
    $('#rd-drill-status').textContent = running ? t('Running a restore drill… This can take a minute.') : '';
    $('#rd-drill-last').textContent = drillLine(r.drill.last);
    clearTimeout(timer);
    if (running) timer = setTimeout(() => void refresh(), 2000);
  };
  async function refresh() {
    const box = $('#rd-box');
    if (!box) return;
    box.hidden = !isOwner();
    if (box.hidden) return;
    if (!view) say(t('Checking…'));
    try {
      view = await api('/readiness');
      say('');
      paint();
    } catch (e) {
      say(e.message);
    }
  }
  async function drill() {
    try {
      await api('/readiness/drill', { method: 'POST', body: {} });
    } catch (e) {
      say(e.message);
    }
    await refresh();
  }
  async function probe() {
    say(t('Checking…'));
    try {
      view = await api('/readiness/probe', { method: 'POST', body: {} });
      say('');
      paint();
    } catch (e) {
      say(e.message);
    }
  }
  $('#rd-again')?.addEventListener('click', () => void refresh());
  $('#rd-drill')?.addEventListener('click', () => void drill());
  return { refresh };
}
