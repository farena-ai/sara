// R1C: "Project now" in the web app. Basis labels for check results (Checks view, goal card) and
// the "Also active on this project" bar under the chat header. Titles, times and paths only;
// a note, never a lock or an approval.
import { t } from './naming.js';

/** Words for a result's basis label from the server ({ state, head, dirty, headFrom, headTo, changed, since }). */
export function basisWords(label) {
  if (!label) return '';
  if (label.state === 'current') return t('ran on {head} + {n} changed files, current', { head: String(label.head ?? '').slice(0, 7), n: label.dirty ?? 0 });
  if (label.state !== 'stale') return t('basis unknown');
  const when = label.since ? t('stale since {time}', { time: new Date(label.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('stale');
  const parts = [];
  if (label.headFrom) parts.push(t('HEAD {from} → {to}', { from: label.headFrom.slice(0, 7), to: String(label.headTo ?? '').slice(0, 7) }));
  const changed = label.changed ?? [];
  if (changed.length) parts.push(t('{n} files changed ({files})', { n: changed.length, files: changed.slice(0, 3).join(', ') + (changed.length > 3 ? ', …' : '') }));
  return parts.length ? `${when}: ${parts.join(', ')}` : when;
}

function ago(min) {
  if (min < 1) return t('just now');
  if (min < 60) return t('{n} min ago', { n: min });
  return t('{n} h ago', { n: Math.floor(min / 60) });
}

/** Fills the bar for one conversation (hidden when there is nothing or the chat isn't eligible). */
export async function projectNowOpen(id, { api, open, current }) {
  const bar = document.getElementById('project-now');
  if (!bar) return;
  bar.hidden = true;
  bar.replaceChildren();
  let r;
  try {
    r = await api(`/conversations/${encodeURIComponent(id)}/project-now`);
  } catch {
    return;
  }
  // Another chat may have opened while this loaded.
  if (!r?.others?.length || current() !== id) return;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  bar.append(el('span', 'pn-lead', t('Also active on this project:')));
  for (const o of r.others) {
    const item = el('span', 'pn-item');
    const link = el('button', 'pn-link ghost small', o.title || t('Untitled'));
    link.type = 'button';
    link.dataset.raw = '';
    link.addEventListener('click', () => open(o.id));
    const meta = `${ago(o.agoMin)}${o.running ? `, ${t('running')}` : ''}`;
    const paths = o.paths.map((p) => `${p.path}${p.both ? '*' : ''}`).join(', ') + (o.more ? `, ${t('+{n} more', { n: o.more })}` : '');
    const files = el('span', 'pn-files muted', ` (${meta})${paths ? `: ${paths}` : ''}`);
    files.dataset.raw = '';
    item.append(link, files);
    bar.append(item);
  }
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t('Your other chats on this project in the last 2 hours, with the files they touched (* = this chat touched it too). A note only: nothing is locked, merged or approved.');
  bar.append(tip);
  bar.hidden = false;
}
